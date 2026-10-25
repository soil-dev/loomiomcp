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
 * 3.13.1 (since 0.0.16): the b2 routes, serializers and the paged
 * indexes were checked against the source, the upstream tests and
 * sanitized live captures from a 3.13.1 instance. The five b3
 * provisioning tools (src/tools/server-admin.ts) were verified ONLY
 * through Loomio's source, integration tests and server-API docs — no
 * live b3 capture exists, because the reference deployment holds no b3
 * secret.
 */
export const VERSION = "0.0.17";

export const TESTED_LOOMIO_VERSION = "3.13.1";
