/**
 * Process-wide facts about HOW the connector is deployed that tool code
 * needs but cannot derive from its own inputs.
 *
 * Today one fact: whether the HTTP entry runs in open-DCR mode
 * (`MCP_OAUTH_INSECURE_AUTO_APPROVE`), i.e. whether a tool caller is
 * anyone on the internet. The HTTP entry sets it once at startup
 * (`buildHttpRuntime`, src/http/runtime.ts — pinned by
 * tests/http-runtime.test.ts); stdio and static-client mode leave it
 * false. Read by:
 *
 *   - the "hidden vs not found" collapse (security review nit 19): in
 *     open-DCR mode a 403 "Not authorized to show …" and a 404 for a
 *     group, discussion, poll or thread read are reported with ONE
 *     message, so anonymous callers cannot walk sequential ids to map
 *     which hidden records exist (`collapseNotVisible` in
 *     src/tools/_common.ts);
 *   - the per-IP daily quotas (F-16), which apply in open-DCR mode only;
 *   - the same collapse on the group-keyed lists (list_discussions,
 *     list_polls, list_memberships; review round 2).
 */

let openDcr = false;

/** Called once by `buildHttpRuntime` after every startup check passed. */
export function setOpenDcrMode(value: boolean): void {
  openDcr = value;
}

/** True when tool callers are anonymous self-registered OAuth clients. */
export function isOpenDcr(): boolean {
  return openDcr;
}
