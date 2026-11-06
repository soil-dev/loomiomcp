/**
 * Single source of truth for the connector's own version and the
 * Loomio release it was last verified against.
 *
 * `VERSION` is what `package.json` says — `tests/version.test.ts` pins
 * the two together because v0.0.9 shipped with the McpServer literal
 * lagging `package.json`, so MCP clients reported a stale version while
 * the registry showed the new one. Every place that needs the version
 * (the McpServer descriptor, the outbound `User-Agent`, `/health`)
 * imports it from here.
 *
 * `TESTED_LOOMIO_VERSION` is the Loomio release whose controllers,
 * serializers and routes this connector was checked against. Loomio
 * publishes no API compatibility or deprecation policy and ships tags
 * frequently, so the health probe compares the instance's reported
 * `major.minor` to this and logs a one-time `loomio.version_drift`
 * warning when they differ — a prompt to re-verify, not an error.
 *
 * 3.15.0 (since 0.0.18): Loomio versioned its APIs in 3.14.0 (`/user0`
 * and `/server0` beside the `/b2` / `/b3` compatibility paths, which
 * "will be removed in a later release") and renamed the poll
 * participation / scoring fields and the `polls_one_at_a_time` thread
 * setting; the connector follows the instance's version
 * (src/loomio/api-dialect.ts, src/loomio/poll-fields.ts). The user-API
 * routes, serializers and permitted params were checked against Loomio's
 * source at the commit the reference instance ran (5cde393b9, "3.15.0"
 * on master — Loomio had tagged v3.14.1 but not v3.15.0 at the time)
 * and live against that instance in a sandbox group (reads, writes, the
 * Markdown guard). The server-API provisioning tools
 * (src/tools/server-admin.ts) remain verified through Loomio's source,
 * integration tests and server-API docs only — the reference deployment
 * holds no server secret.
 */
export const VERSION = "0.0.18";

export const TESTED_LOOMIO_VERSION = "3.15.0";
