/**
 * `LOOMIO_MCP_GROUP_IDS` — the operator's allow-list of Loomio groups the
 * connector serves (security review F-17).
 *
 * WHY. Without it the connector's exposure is exactly "the API user's
 * memberships", and any group coordinator changes that unilaterally:
 * adding the bot to a private group (even as a pending invitation),
 * promoting it, or starting a private thread in a bot group publishes
 * that content to every caller — on an open-DCR deployment, to the
 * internet. Operators could narrow exposure only by changing Loomio
 * memberships. The allow-list puts the decision back with the operator:
 * a group the bot joins is NOT served until the operator lists it.
 *
 * Semantics when set (comma-separated positive integers; unset or empty
 * = no allow-list, v0.0.16 behaviour):
 *
 *   - Every tool input naming a group (`group_id`, `group_ids`) outside
 *     the list is refused BEFORE any upstream call, with the fixed
 *     classified `GroupScopeError`.
 *   - Reads of one record (discussion, poll, thread, group show) check the
 *     record's group and refuse when it is outside the list — or when the
 *     record has no group at all (a direct thread, which no group id can
 *     allow). Where the group is knowable before the content is fetched
 *     (thread items, the Markdown export) the check runs first.
 *   - Collections that span groups (list_groups, check_connection,
 *     list_threads, search_content, the participation reports,
 *     get_user_activity's samples) are FILTERED to the list.
 *   - The b3 instance-admin tools are unaffected: they are an operator's
 *     own tools behind a different secret and do not ride the bot's
 *     memberships.
 *
 * The list does not widen anything: a listed group the bot cannot see is
 * still invisible. Parsed at call time (like every env read here), and
 * validated once at startup by both entry points (`groupAllowlistError`).
 */

import { isOpenDcr } from "../deployment.js";
import type { GroupsIndexResponse } from "./types.js";

export const GROUP_ALLOWLIST_ENV = "LOOMIO_MCP_GROUP_IDS";

/** Parse the variable's value: `[]` for unset/empty, the ids, or an error string. Never quotes more than the bad token. */
export function parseGroupIds(raw: string | undefined): number[] | { error: string } {
  if (raw === undefined || raw.trim() === "") return [];
  const ids: number[] = [];
  for (const token of raw.split(",")) {
    const t = token.trim();
    if (t === "") continue;
    if (!/^\d{1,15}$/.test(t) || Number(t) < 1) {
      return {
        error:
          `${GROUP_ALLOWLIST_ENV} must be a comma-separated list of positive integer group ids ` +
          `(e.g. "101,102"); got a token ${JSON.stringify(t.slice(0, 20))}.`,
      };
    }
    ids.push(Number(t));
  }
  return ids;
}

/** Startup validation for both entry points: the fixed error, or undefined. */
export function groupAllowlistError(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const parsed = parseGroupIds(env[GROUP_ALLOWLIST_ENV]);
  return Array.isArray(parsed) ? undefined : parsed.error;
}

/**
 * The allow-list in force, or `null` when none is configured. A value
 * that does not parse fails CLOSED (an empty set: nothing is served)
 * rather than open — the startup check makes that unreachable in a
 * deployment that started, but an env changed under a running process
 * must not silently widen exposure.
 */
export function groupAllowlist(): ReadonlySet<number> | null {
  const parsed = parseGroupIds(process.env[GROUP_ALLOWLIST_ENV]);
  if (!Array.isArray(parsed)) return new Set();
  return parsed.length > 0 ? new Set(parsed) : null;
}

/** True when `groupId` may be served: no allow-list, or listed. A null id passes only without a list. */
export function isGroupAllowed(groupId: number | null | undefined): boolean {
  const list = groupAllowlist();
  if (!list) return true;
  return typeof groupId === "number" && list.has(groupId);
}

/**
 * The connector refuses to serve a group (or a record in one) the
 * operator has not allow-listed. Not a LoomioApiError: no upstream call
 * was made for an input refusal, and nothing Loomio said is involved.
 */
export class GroupScopeError extends Error {
  readonly kind = "group_not_allowed" as const;
  constructor(message: string) {
    super(message);
    this.name = "GroupScopeError";
  }
}

const LIST_HINT =
  "This connector serves only the groups its operator listed in LOOMIO_MCP_GROUP_IDS; " +
  "list_groups shows them.";

/** Refuse every input group id outside the allow-list (before any upstream call). */
export function assertGroupsAllowed(groupIds: readonly number[]): void {
  const list = groupAllowlist();
  if (!list) return;
  const outside = groupIds.filter((id) => !list.has(id));
  if (outside.length === 0) return;
  throw new GroupScopeError(
    `Group ${outside.length === 1 ? "id" : "ids"} ${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} ` +
      `outside this connector's group allow-list. ${LIST_HINT}`,
  );
}

/** Single-id form of `assertGroupsAllowed`. */
export function assertGroupAllowed(groupId: number): void {
  assertGroupsAllowed([groupId]);
}

/**
 * Refuse a record whose group is outside the allow-list, or that has no
 * group. In open-DCR mode the message is the same one a missing or hidden
 * record gets (nit 19), so an anonymous caller cannot tell "exists in an
 * unlisted group" from "does not exist".
 */
export function assertRecordGroupAllowed(
  groupId: number | null | undefined,
  what: "group" | "discussion" | "poll" | "thread",
  ref: string | number,
): void {
  if (isGroupAllowed(groupId)) return;
  if (isOpenDcr()) throw new GroupScopeError(notVisibleMessage(what, ref));
  throw new GroupScopeError(
    groupId == null
      ? `This ${what} (${ref}) belongs to no group (a direct thread), so the connector's group ` +
          `allow-list cannot admit it. ${LIST_HINT}`
      : what === "group"
        ? `Group ${ref} is outside this connector's group allow-list. ${LIST_HINT}`
        : `This ${what} (${ref}) is in a group outside this connector's group allow-list. ${LIST_HINT}`,
  );
}

/**
 * The single "absent or hidden" wording of open-DCR mode, shared by the
 * allow-list refusal and the 403/404 collapse (src/tools/_common.ts
 * `collapseNotVisible`), so all three cases read identically.
 */
export function notVisibleMessage(
  what: "group" | "discussion" | "poll" | "thread",
  ref: string | number,
): string {
  return (
    `No ${what} "${ref}" is visible to this connector: it does not exist, or it is not served ` +
    "here (hidden from the connector's user, or outside the groups this deployment exposes)."
  );
}

/**
 * A groups-index body (GET /b2/groups, one page or a merged walk) cut
 * down to the allow-list: `groups`, `parent_groups` and the own
 * `memberships` rows of unlisted groups are removed and `meta.total`
 * becomes the number of listed member groups the body holds, so
 * list_groups and check_connection report the world as if only the
 * listed groups existed. Without an allow-list the body is returned
 * untouched (the same object). Never mutates its input — the health
 * cache keeps what the probe received.
 *
 * `meta.total` is exact when the body holds every member group; on a
 * capped walk it is a lower bound, as the unfiltered `partial` flag
 * already says.
 */
export function filterGroupsIndex(body: GroupsIndexResponse): GroupsIndexResponse {
  const list = groupAllowlist();
  if (!list) return body;
  const groups = (Array.isArray(body.groups) ? body.groups : []).filter((g) => list.has(g.id));
  const parents = (Array.isArray(body.parent_groups) ? body.parent_groups : []).filter((g) =>
    list.has(g.id),
  );
  const memberships = (Array.isArray(body.memberships) ? body.memberships : []).filter((m) =>
    list.has(m.group_id),
  );
  return {
    ...body,
    groups,
    parent_groups: parents,
    memberships,
    meta: { ...(body.meta ?? {}), total: groups.length },
  };
}

/** True when an allow-list is configured (used to add a note, never to widen anything). */
export function hasGroupAllowlist(): boolean {
  return groupAllowlist() !== null;
}
