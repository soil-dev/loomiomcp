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
 */
export const VERSION = "0.0.12";

export const TESTED_LOOMIO_VERSION = "3.8.1";
