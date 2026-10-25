/**
 * Change detection on what the API user can see (security review F-17,
 * F-04): forced log events an operator can alert on.
 *
 * The connector's exposure follows the API user's Loomio memberships,
 * which group coordinators change without telling the operator. The
 * health probe already fetches the groups index (first page, ≤ 50
 * groups) every minute it is asked; this module diffs what it saw
 * against the previous probe IN THIS PROCESS and emits:
 *
 *   loomio.groups_changed (forced) — the member-group id set, the total,
 *     any own admin flag, or any member group's privacy
 *     (`group_privacy` / `is_visible_to_public`) changed. Fields are ids
 *     and counts only — never names, never text.
 *   loomio.admin_scope (forced) — the API user holds group-admin
 *     memberships. Loomio then serialises `user_email` on those groups'
 *     rosters (membership_serializer.rb:25-30); the connector strips them
 *     in read-only mode and on the own row (src/tools/memberships.ts),
 *     but an admin bot is a posture the operator must know about. Emitted
 *     when the admin set first becomes non-empty in a process and every
 *     time it changes — not on every probe, so a repeated
 *     check_connection cannot be used to flood the log. Two observers
 *     feed it with DIFFERENT views — the probe (first groups page only)
 *     and check_connection (the complete index) — so each keeps its own
 *     dedupe key: with one shared key, a bot whose admin rows sit past
 *     the first page made every check_connection flip the key
 *     (first-page set → complete set) and force one or two lines per
 *     call, an anonymous log-volume lever (review round 1).
 *
 * The first probe of a process is the baseline: no `groups_changed`
 * (there is nothing to compare with), but `admin_scope` fires if the bot
 * is already an admin, so a fresh instance reports the posture once.
 * Both are per process; with several instances each reports on its own.
 */

import { logEvent } from "../log.js";
import type { GroupsIndexResponse } from "./types.js";

export interface GroupSnapshot {
  total: number | null;
  ids: number[];
  admin: number[];
  privacy: Map<number, string>;
}

export interface GroupsChange {
  at: string;
  added: number[];
  removed: number[];
  admin_gained: number[];
  admin_lost: number[];
  privacy_changed: number[];
  total_before: number | null;
  total_after: number | null;
}

let previous: GroupSnapshot | undefined;
let lastChange: GroupsChange | undefined;
/** The last admin set each observer SAW (see the module note), and the last one emitted. */
const lastAdminKey: Record<AdminView, string | undefined> = {
  probe: undefined,
  complete: undefined,
};
let lastEmittedAdminKey: string | undefined;

/** Which view of the groups index an admin set came from. */
export type AdminView = "probe" | "complete";

function sortedIds(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** The comparable facts of one groups-index body (member groups on the page, own admin rows). */
export function snapshotOf(body: GroupsIndexResponse): GroupSnapshot {
  const groups = Array.isArray(body.groups) ? body.groups : [];
  const privacy = new Map<number, string>();
  for (const g of groups) {
    if (typeof g.id !== "number") continue;
    privacy.set(g.id, `${g.group_privacy ?? "?"}|${String(g.is_visible_to_public ?? "?")}`);
  }
  return {
    total: typeof body.meta?.total === "number" ? body.meta.total : null,
    ids: sortedIds(groups.map((g) => g.id).filter((id) => typeof id === "number")),
    admin: adminGroupIds(body),
    privacy,
  };
}

/** Group ids where one of the API user's own membership rows has `admin: true`. */
export function adminGroupIds(body: GroupsIndexResponse): number[] {
  const rows = Array.isArray(body.memberships) ? body.memberships : [];
  return sortedIds(
    rows.filter((m) => m.admin === true && typeof m.group_id === "number").map((m) => m.group_id),
  );
}

/** The difference between two snapshots, or undefined when nothing that matters changed. */
export function diffSnapshots(
  before: GroupSnapshot,
  after: GroupSnapshot,
  at: string,
): GroupsChange | undefined {
  const b = new Set(before.ids);
  const a = new Set(after.ids);
  const ba = new Set(before.admin);
  const aa = new Set(after.admin);
  const change: GroupsChange = {
    at,
    added: after.ids.filter((id) => !b.has(id)),
    removed: before.ids.filter((id) => !a.has(id)),
    admin_gained: after.admin.filter((id) => !ba.has(id)),
    admin_lost: before.admin.filter((id) => !aa.has(id)),
    privacy_changed: after.ids.filter(
      (id) => before.privacy.has(id) && before.privacy.get(id) !== after.privacy.get(id),
    ),
    total_before: before.total,
    total_after: after.total,
  };
  const changed =
    change.added.length > 0 ||
    change.removed.length > 0 ||
    change.admin_gained.length > 0 ||
    change.admin_lost.length > 0 ||
    change.privacy_changed.length > 0 ||
    before.total !== after.total;
  return changed ? change : undefined;
}

/**
 * Record what one successful probe saw; emit `loomio.groups_changed`
 * against the previous probe and `loomio.admin_scope` when the admin set
 * is non-empty and new.
 */
export function observeGroupsIndex(body: GroupsIndexResponse, at: string): void {
  const next = snapshotOf(body);
  if (previous) {
    const change = diffSnapshots(previous, next, at);
    if (change) {
      lastChange = change;
      const { at: _at, ...fields } = change;
      logEvent("loomio.groups_changed", fields, { force: true });
    }
  }
  previous = next;
  noteAdminScope(next.admin, "probe");
}

/**
 * Emit `loomio.admin_scope` for a non-empty admin set this VIEW has not
 * seen yet and that is not the set last reported: `"probe"` from the
 * health probe's first page, `"complete"` from check_connection's whole
 * index. Each view dedupes on its own, so alternating calls can never
 * re-trigger the event.
 */
export function noteAdminScope(adminIds: readonly number[], view: AdminView): void {
  const ids = sortedIds(adminIds);
  const key = ids.join(",");
  if (ids.length === 0) {
    lastAdminKey[view] = key;
    return;
  }
  // Emit only when THIS view's set changed (so the two views can never
  // re-trigger each other) and it is not what was just reported (so two
  // views agreeing on one set log it once).
  if (key === lastAdminKey[view]) return;
  lastAdminKey[view] = key;
  if (key === lastEmittedAdminKey) return;
  lastEmittedAdminKey = key;
  logEvent(
    "loomio.admin_scope",
    {
      level: "warning",
      admin_group_ids: ids,
      message:
        "The connector's Loomio user holds group-admin memberships: Loomio serialises member e-mail " +
        "addresses and admin-only fields for those groups. Keep the bot a plain member unless the " +
        "deployment needs admin rights.",
    },
    { force: true },
  );
}

/** The most recent change any probe in this process detected, for check_connection's notes. */
export function lastGroupsChange(): GroupsChange | undefined {
  return lastChange;
}

/** Test hook. */
export function resetGroupWatchForTests(): void {
  previous = undefined;
  lastChange = undefined;
  lastAdminKey.probe = undefined;
  lastAdminKey.complete = undefined;
  lastEmittedAdminKey = undefined;
}
