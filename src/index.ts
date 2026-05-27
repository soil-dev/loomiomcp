import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isReadOnly } from "./loomio/client.js";
import { createLoomioMcpServer } from "./server.js";

// Fail fast on missing LOOMIO_API_KEY. Without this the server would
// boot, register tools, and only error out on the first tool invocation
// — a confusing UX in MCP-host UIs where the failure surfaces as "tool
// errored" rather than "server failed to start." Matches the HTTP
// entry's fail-fast pattern in src/http.ts.
if (!process.env["LOOMIO_API_KEY"]) {
  console.error(
    "[loomiomcp] LOOMIO_API_KEY environment variable is not set. " +
      "Generate one in Loomio under your profile → API keys.",
  );
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
