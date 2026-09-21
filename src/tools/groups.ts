import { z } from "zod";
import {
  hasB3ApiKey,
  isReadOnly,
  LoomioApiError,
  loomioGet,
  readParams,
} from "../loomio/client.js";
import {
  checkLoomioHealth,
  getCachedGroupsIndex,
  keyRejectedWarning,
  type LoomioHealth,
} from "../loomio/health.js";
import {
  groupUrl,
  indexById,
  omit,
  pick,
  type SlimGroup,
  slimGroup,
  slimUser,
  type SlimUser,
} from "../loomio/shape.js";
import type { GroupsIndexResponse, LoomioGroup, LoomioMembership } from "../loomio/types.js";
import { TESTED_LOOMIO_VERSION, VERSION } from "../version.js";
import { encodePathSegment, idOrKeyOrHandle } from "./_common.js";

// ── GET /b2/groups — what the index is and is not ──────────────────────────
//
// Loomio 3.8.1's `Api::B2::GroupsController#index` answers
// `current_user.groups` (User `has_many :groups, through: :memberships`
// where `memberships` is the ACTIVE scope: revoked_at IS NULL, kept
// groups only). So the list is exactly the groups the key's user holds
// an un-revoked membership in — INCLUDING invitations it has not
// accepted yet (`accepted_at: null`) — and nothing else:
//
//   - a publicly visible group the user has not joined is NOT listed,
//     although Loomio ≥ 3.8 lets any authenticated user read its public
//     threads (`can?(:show, group)` → get_group / list_discussions with
//     the id work fine);
//   - instance `is_admin` widens nothing — an instance admin sees the
//     groups it belongs to, like anyone else;
//   - there is no pagination and no filter; `meta.total` is the count.
//
// Side-loads (GroupSerializer): `parent_groups` (each subgroup's parent,
// serialised WITHOUT a visibility check on it — so a parent may appear
// here that the user is not a member of and possibly cannot read),
// `memberships` (only the user's OWN rows, via `current_user_membership`
// — the admin/delegate flags and `accepted_at` per group) and `users`
// (the user itself plus inviters). `exclude_types=tag translation` drops
// the two roots nothing here reads; `compact=1` would also drop the
// memberships root, which is where the admin flag lives, so it is not
// used on this endpoint.
//
// Visibility never 403s here: `authenticate_api_key!` is the only guard,
// so a 403 on this path means the key (see `classifyForbidden`, which
// says so). 0.0.11's probe — one `b2/polls?group_id=N` per id over a
// range, 50–500 calls, blind to poll-less groups — is gone; its three
// inputs survive as accepted no-ops so an older client's call still
// parses.

/**
 * The group fields worth dropping even from a "full" record: binary
 * attachment metadata, link-preview cards (image urls, hostnames,
 * copied descriptions), cover/logo image urls, `tag_ids` (dangling once
 * the `tags` root is excluded), and the billing block. GroupSerializer
 * emits `subscription` {plan, state, active, max_members, max_threads,
 * allow_subgroups, renews_at, expires_at, members_count} whenever the
 * API user holds an active membership in the group's organisation
 * (`include_subscription?`) — it is a serializer ATTRIBUTE, so no
 * `exclude_types` profile can drop it. That is the organisation's Loomio
 * plan, seat caps and renewal dates: nothing a caller asks a group for,
 * and on an open-DCR deployment it would reach every anonymous caller
 * for every member group. `enabled` (kept) already says whether the
 * subscription is active. `new_host` (a migration hint from `info`) and
 * `discarded_by` (a user id on a discarded group) are noise too.
 */
const GROUP_SHOW_DROP = [
  "attachments",
  "link_previews",
  "cover_url",
  "logo_url",
  "has_custom_cover_photo",
  "tag_ids",
  "token",
  "subscription",
  "new_host",
  "discarded_by",
] as const;

export interface GroupMembership {
  /** False while the invitation is pending (`accepted_at` null). */
  accepted: boolean;
  admin: boolean;
  delegate: boolean;
  title: string | null;
}

/** The API user's own membership row for a group, reduced to what a caller acts on. */
function membershipSummary(m: LoomioMembership): GroupMembership {
  return {
    accepted: Boolean(m.accepted_at),
    admin: Boolean(m.admin),
    delegate: Boolean(m.delegate),
    title: m.title ?? null,
  };
}

/**
 * Index the user's own membership rows by group. The groups index and
 * show side-load only `current_user_membership`, so every row in the
 * root is the API user's; `group.current_user_membership_id` points at
 * the same row and is used as a fallback when a row's `group_id` is
 * missing.
 */
function ownMembershipsByGroup(
  groups: readonly LoomioGroup[],
  memberships: readonly LoomioMembership[] | undefined,
): Map<number, LoomioMembership> {
  const byId = indexById(memberships);
  const byGroup = new Map<number, LoomioMembership>();
  for (const m of memberships ?? []) byGroup.set(m.group_id, m);
  for (const g of groups) {
    if (!byGroup.has(g.id) && g.current_user_membership_id != null) {
      const m = byId.get(g.current_user_membership_id);
      if (m) byGroup.set(g.id, m);
    }
  }
  return byGroup;
}

// ── list_groups ─────────────────────────────────────────────────────────────

// No inputs. The 0.0.11 id-probe knobs (start_id / end_id /
// stop_after_consecutive_misses) are not advertised any more: they did
// nothing since the native index replaced the probe, and their three
// optional properties cost ~340 bytes of tools/list in every session.
// An older client that still sends them is not rejected — z.object()
// strips unknown keys (no .strict() anywhere in src/tools) — it just
// gets the same one-call result without a note about them.
export const listGroupsSchema = z.object({});

export interface GroupRow extends SlimGroup {
  /** True for a group the connector's user holds a membership in (accepted or pending). */
  member: boolean;
  /** Present only when `member` is true. */
  membership?: GroupMembership;
  url?: string;
}

export interface ListGroupsResult {
  groups: GroupRow[];
  /** Loomio's `meta.total`: the number of MEMBER groups (parents flagged `member: false` are extra). */
  total: number;
  returned: number;
  scope: {
    member_groups: number;
    /** Parent groups listed for navigation that the user is NOT a member of. */
    non_member_parents: number;
    note: string;
  };
}

const LIST_SCOPE_NOTE =
  "Member groups of the connector's user (Loomio's GET /b2/groups = current_user.groups, pending " +
  "invitations included), plus each subgroup's parent for navigation — a parent the user has not " +
  "joined is flagged member:false and may or may not be readable. Publicly visible groups the user " +
  "has not joined are NOT listed here but are readable by id: use get_group, list_discussions or " +
  "list_polls with the id. Instance is_admin widens nothing.";

/**
 * Turn a groups-index body into the tool's rows: member groups first
 * (with the user's own membership summary), then parents that are not
 * themselves member groups, deduped by id and sorted by `full_name` so
 * a subgroup follows its parent.
 */
export function shapeGroupsIndex(body: GroupsIndexResponse): ListGroupsResult {
  const groups = Array.isArray(body.groups) ? body.groups : [];
  const parents = Array.isArray(body.parent_groups) ? body.parent_groups : [];
  const memberships = ownMembershipsByGroup(groups, body.memberships);

  const rows = new Map<number, GroupRow>();
  for (const g of groups) {
    if (rows.has(g.id)) continue;
    const m = memberships.get(g.id);
    rows.set(g.id, {
      ...slimGroup(g),
      member: true,
      ...(m ? { membership: membershipSummary(m) } : {}),
      ...urlOf(g),
    });
  }
  let nonMemberParents = 0;
  for (const p of parents) {
    if (rows.has(p.id)) continue;
    nonMemberParents++;
    rows.set(p.id, { ...slimGroup(p), member: false, ...urlOf(p) });
  }

  const sorted = [...rows.values()].sort((a, b) =>
    (a.full_name ?? a.name ?? "").localeCompare(b.full_name ?? b.name ?? "", undefined, {
      sensitivity: "base",
    }),
  );
  const total = typeof body.meta?.total === "number" ? body.meta.total : groups.length;
  return {
    groups: sorted,
    total,
    returned: sorted.length,
    scope: {
      member_groups: groups.length,
      non_member_parents: nonMemberParents,
      note: LIST_SCOPE_NOTE,
    },
  };
}

function urlOf(group: LoomioGroup): { url?: string } {
  const url = groupUrl(group);
  return url ? { url } : {};
}

export async function listGroups(
  _input: z.infer<typeof listGroupsSchema> = {},
): Promise<ListGroupsResult> {
  const body = await loomioGet<GroupsIndexResponse>("/b2/groups", readParams("groups"));
  return shapeGroupsIndex(body);
}

// ── get_group ───────────────────────────────────────────────────────────────
//
// `GET /b2/groups/{id|key|handle}` → `load_and_authorize(:group)`:
// ModelLocator tries the numeric id, then the short key, then the
// handle (Loomio 3.8.1 app/models/model_locator.rb), and
// `can?(:show, group)` (app/models/ability/group.rb) admits the group
// when it is kept AND visible to the public, OR the user is a member,
// OR it is shown to parent-group members and the user is one. A refusal
// is 403 "Not authorized to show Group." — which the HTTP client turns
// into a "hidden group" explanation — and an unknown identifier is 404.
// The show side-loads the same `parent_groups` / `memberships` (own
// row) / `users` roots as the index, plus `tags` unless excluded.

export const getGroupSchema = z.object({
  id_or_key_or_handle: idOrKeyOrHandle.describe("Group numeric id, short key or URL handle."),
});

export interface GetGroupResult {
  group: Partial<LoomioGroup> & Record<string, unknown>;
  member: boolean;
  membership: GroupMembership | null;
  parent: { id: number; name: string | null; handle: string | null } | null;
  subgroups_count: number | null;
  url?: string;
}

export async function getGroup(input: z.infer<typeof getGroupSchema>): Promise<GetGroupResult> {
  const segment = encodePathSegment(input.id_or_key_or_handle);
  let body: GroupsIndexResponse;
  try {
    body = await loomioGet<GroupsIndexResponse>(`/b2/groups/${segment}`, readParams("groups"));
  } catch (err) {
    if (err instanceof LoomioApiError && err.status === 404) {
      throw new LoomioApiError(
        404,
        `Loomio has no group with id, key or handle "${input.id_or_key_or_handle}" (HTTP 404). A group ` +
          "that exists but is hidden from the connector's user answers 403 instead, so this identifier " +
          "is wrong rather than restricted; list_groups shows the ids and handles of the member groups.",
      );
    }
    throw err;
  }
  const group = body.groups?.[0];
  if (!group) {
    throw new LoomioApiError(
      502,
      `Loomio answered GET /b2/groups/${input.id_or_key_or_handle} without a group record; the ` +
        "response shape is not the one Loomio 3.8.1 produces.",
    );
  }
  const membership = ownMembershipsByGroup([group], body.memberships).get(group.id);
  const parent =
    group.parent_id != null ? indexById(body.parent_groups).get(group.parent_id) : undefined;
  return {
    group: omit(group, GROUP_SHOW_DROP),
    member: Boolean(membership),
    membership: membership ? membershipSummary(membership) : null,
    parent: parent
      ? { id: parent.id, name: parent.name ?? null, handle: parent.handle ?? null }
      : group.parent_id != null
        ? { id: group.parent_id, name: null, handle: null }
        : null,
    subgroups_count: typeof group.subgroups_count === "number" ? group.subgroups_count : null,
    ...urlOf(group),
  };
}

// ── check_connection ────────────────────────────────────────────────────────
//
// "Does the connector work, and what can it see?" in one tool call and
// at most one request pair. `checkLoomioHealth({ force: true })` runs
// the key probe (an authenticated GET /b2/groups) and the public
// version probe; the probe keeps the parsed groups body beside its
// verdict (`getCachedGroupsIndex`), so the user's identity (the
// membership rows' `user_id` resolved through `users[]`) and group list
// come from the request the probe already paid for. A second GET is
// issued only if the probe said `valid` but its body did not parse.
//
// Nothing operator-facing leaks into the result: the probe's `detail`
// (built from upstream error text) stays out, as it stays out of
// `/health`. The notes are fixed strings keyed on `key_status`.

export const checkConnectionSchema = z.object({});

export type MemberState = "member" | "pending" | "parent";

export interface ConnectionGroup {
  id: number;
  name: string | null;
  handle: string | null;
  /** `member` = accepted membership; `pending` = invited, not accepted; `parent` = a subgroup's parent the user has not joined. */
  member_state: MemberState;
  admin: boolean;
}

export interface CheckConnectionResult {
  connector_version: string;
  tested_loomio_version: string;
  loomio_version: string | null;
  key_status: LoomioHealth["key_status"];
  checked_at: string;
  readonly: boolean;
  /** True iff the four b3 tools are registered: LOOMIO_B3_API_KEY set AND not read-only. */
  b3_enabled: boolean;
  user: SlimUser | null;
  groups: ConnectionGroup[];
  groups_total: number;
  notes: string[];
}

const UNREACHABLE_NOTE =
  'The key-health probe could not reach Loomio (key_status "unreachable"): network error, timeout, ' +
  "a 5xx, a CDN/WAF 403 that never reached Loomio, or a configuration error. This says nothing about " +
  "the API key either way. See GET /health on the connector (HTTP transport) or its logs for the " +
  "cause, and retry once Loomio is reachable.";

function majorMinor(version: string): string | undefined {
  const m = /^v?(\d+)\.(\d+)/.exec(version.trim());
  return m ? `${m[1]}.${m[2]}` : undefined;
}

/** Shape the groups-index body into the connection summary's group list and user. */
export function shapeConnectionGroups(body: GroupsIndexResponse): {
  user: SlimUser | null;
  groups: ConnectionGroup[];
  groups_total: number;
} {
  const groups = Array.isArray(body.groups) ? body.groups : [];
  const parents = Array.isArray(body.parent_groups) ? body.parent_groups : [];
  const memberships = ownMembershipsByGroup(groups, body.memberships);
  const users = indexById(body.users);

  // Every membership row here is the API user's own, so any row names it.
  const ownUserId = (body.memberships ?? []).find((m) => typeof m.user_id === "number")?.user_id;
  const ownUser = ownUserId !== undefined ? users.get(ownUserId) : undefined;
  const user: SlimUser | null = ownUser
    ? slimUser(ownUser)
    : ownUserId !== undefined
      ? { id: ownUserId, name: null, username: null }
      : null;

  const rows = new Map<number, ConnectionGroup>();
  for (const g of groups) {
    const m = memberships.get(g.id);
    rows.set(g.id, {
      ...pick(g, ["id"]),
      name: g.name ?? null,
      handle: g.handle ?? null,
      member_state: m && !m.accepted_at ? "pending" : "member",
      admin: Boolean(m?.admin),
    });
  }
  for (const p of parents) {
    if (rows.has(p.id)) continue;
    rows.set(p.id, {
      id: p.id,
      name: p.name ?? null,
      handle: p.handle ?? null,
      member_state: "parent",
      admin: false,
    });
  }
  const sorted = [...rows.values()].sort((a, b) =>
    (a.name ?? "").localeCompare(b.name ?? "", undefined, { sensitivity: "base" }),
  );
  return {
    user,
    groups: sorted,
    groups_total: typeof body.meta?.total === "number" ? body.meta.total : groups.length,
  };
}

export async function checkConnection(
  _input: z.infer<typeof checkConnectionSchema> = {},
): Promise<CheckConnectionResult> {
  const health = await checkLoomioHealth({ force: true });
  const notes: string[] = [];
  let index: GroupsIndexResponse | undefined;

  if (health.key_status === "valid") {
    index = getCachedGroupsIndex();
    if (!index) {
      // The probe proved the key but its body did not parse as JSON —
      // pay for one more request rather than report an empty world.
      index = await loomioGet<GroupsIndexResponse>("/b2/groups", readParams("groups"));
    }
  } else if (health.key_status === "rejected") {
    notes.push(keyRejectedWarning());
  } else {
    notes.push(UNREACHABLE_NOTE);
  }

  const shaped = index
    ? shapeConnectionGroups(index)
    : { user: null, groups: [] as ConnectionGroup[], groups_total: 0 };

  if (health.key_status === "valid") {
    if (shaped.groups_total === 0) {
      notes.push(
        "The API key is valid but the connector's user belongs to no group, so every group-scoped " +
          "tool will answer empty or 403 until a group admin adds the user. Publicly visible groups " +
          "remain readable by id (get_group, list_discussions, list_polls, list_threads, search_content).",
      );
    }
    if (!shaped.user) {
      notes.push(
        "The connector's user could not be identified from the groups index: Loomio names the API " +
          "user only through its membership rows, and there are none.",
      );
    }
    const pending = shaped.groups.filter((g) => g.member_state === "pending").length;
    if (pending > 0) {
      notes.push(
        `${pending} group invitation(s) are pending (member_state "pending"): the user was invited but ` +
          "has not accepted, and Loomio treats it as a member for visibility already.",
      );
    }
    const parents = shaped.groups.filter((g) => g.member_state === "parent").length;
    if (parents > 0) {
      notes.push(
        `${parents} parent group(s) are listed for navigation only (member_state "parent"): the user is ` +
          "not a member; they are readable only if publicly visible.",
      );
    }
  }
  if (health.loomio_version) {
    const seen = majorMinor(health.loomio_version);
    if (seen && seen !== majorMinor(TESTED_LOOMIO_VERSION)) {
      notes.push(
        `The Loomio instance reports version ${health.loomio_version}; this connector was verified ` +
          `against ${TESTED_LOOMIO_VERSION}. Loomio publishes no API compatibility policy, so treat ` +
          "unexpected results with suspicion and re-verify.",
      );
    }
  } else {
    notes.push(
      "The instance's Loomio version is unknown: the public GET /v1/boot/version probe did not " +
        "answer 200 with a version. This does not affect the key verdict.",
    );
  }
  const readonly = isReadOnly();
  // `b3_enabled` means "the four b3 tools are in tools/list", which
  // createLoomioMcpServer gates on the secret AND writable mode — the
  // two b3 reads return emails, so they share the writes' gate. A
  // secret configured on a read-only deployment registers nothing.
  const b3Configured = hasB3ApiKey();
  const b3 = b3Configured && !readonly;
  if (readonly) {
    notes.push(
      "LOOMIO_MCP_READONLY is set: no create_*/update_*/delete_*/manage_* tools are registered and " +
        "every write is refused before any request is made.",
    );
  }
  if (b3) {
    notes.push(
      "LOOMIO_B3_API_KEY is set: Loomio's b3 Server API tools (user administration, emails included) " +
        "are registered. That secret is validated by the Loomio server, not by this probe; a wrong b3 " +
        "secret surfaces as a 403 on the first b3 call.",
    );
  } else if (b3Configured) {
    notes.push(
      "LOOMIO_B3_API_KEY is set but LOOMIO_MCP_READONLY is also set: NO b3 tools are registered " +
        "(deactivate_user / reactivate_user write, and get_user / list_users return emails, so all " +
        "four share the writes' gate). b3_enabled is therefore false.",
    );
  }

  return {
    connector_version: VERSION,
    tested_loomio_version: TESTED_LOOMIO_VERSION,
    loomio_version: health.loomio_version,
    key_status: health.key_status,
    checked_at: health.checked_at,
    readonly,
    b3_enabled: b3,
    user: shaped.user,
    groups: shaped.groups,
    groups_total: shaped.groups_total,
    notes,
  };
}
