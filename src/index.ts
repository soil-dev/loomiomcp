import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isReadOnly } from "./loomio/client.js";
import { groupAllowlistError } from "./loomio/group-scope.js";
import { checkLoomioHealth, keyRejectedWarning } from "./loomio/health.js";
import { secretConfigError } from "./loomio/secrets.js";
import { createLoomioMcpServer } from "./server.js";

// Fail fast on missing LOOMIO_API_KEY. Without this the server would
// boot, register tools, and only error out on the first tool invocation
// — a confusing UX in MCP-host UIs where the failure surfaces as "tool
// errored" rather than "server failed to start." Matches the HTTP
// entry's fail-fast pattern (src/http/runtime.ts).
if (!process.env["LOOMIO_API_KEY"]) {
  console.error(
    "[loomiomcp] LOOMIO_API_KEY environment variable is not set. " +
      "Generate one in Loomio under your profile → API keys.",
  );
  process.exit(1);
}

// Same startup refusals as the HTTP entry: a credential a bearer header
// cannot carry (F-02; the message never quotes it) and a malformed group
// allow-list (F-17).
const startupProblem = secretConfigError() ?? groupAllowlistError();
if (startupProblem) {
  console.error(`[loomiomcp] ${startupProblem}`);
  process.exit(1);
}

const server = createLoomioMcpServer();
const transport = new StdioServerTransport();

if (isReadOnly()) {
  // Stdout is reserved for MCP protocol traffic — log boot info to stderr.
  console.error("[loomiomcp] read-only mode: write tools are not registered");
}

try {
  await server.connect(transport);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[loomiomcp] Failed to start: ${message}`);
  process.exit(1);
}

// Probe the Loomio key once, after the transport is up. A rotated key
// is the most common way this server breaks silently — every tool call
// would 403 while the process looks healthy — so say so on stderr where
// MCP hosts surface server logs. Deliberately NOT fatal: a transient
// network error at launch must not kill the server, and even with a
// rejected key the tools stay registered and fail with a clear,
// classified 403 per call, which is more useful to the human than a
// process that vanished. Stderr only; stdout is the MCP channel.
checkLoomioHealth()
  .then((health) => {
    if (health.key_status === "rejected") {
      console.error(`[loomiomcp] WARNING: ${keyRejectedWarning()}`);
    } else if (health.key_status === "unreachable") {
      console.error(
        `[loomiomcp] could not verify the Loomio API key at startup: ${health.detail ?? "unknown error"}. Continuing.`,
      );
    }
  })
  .catch(() => {
    // checkLoomioHealth never rejects by design; nothing to do if it somehow does.
  });
