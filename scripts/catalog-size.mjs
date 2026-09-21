#!/usr/bin/env node
/**
 * Measure the tool catalogue a client pays for at session start.
 *
 * Every MCP session begins with `initialize` (which carries the server
 * `instructions`) and `tools/list` (every name, description and input
 * schema). Claude.ai and Claude Code put all of it in the model's
 * context before the first question, so its size is a fixed per-session
 * tax: the first 0.0.12 draft weighed ~83 KB (~20k tokens) for 24 tools,
 * more than most answers. This script spawns the BUILT server over
 * stdio (what a real client sees, not the zod source), runs the two
 * requests and prints the total plus a per-tool breakdown, so a trim can
 * be measured instead of guessed and tests/server.test.ts can pin the
 * ceiling with a number that came from the wire.
 *
 * Run (after `npm run build`):
 *   LOOMIO_API_KEY=x LOOMIO_API_BASE_URL=https://example.org/api \
 *     node scripts/catalog-size.mjs [--b3] [--json]
 *
 * The server needs a key to boot and probes the base URL once at start;
 * both default to placeholders (a closed local port) so that running the
 * script bare never reaches a real Loomio host. `--b3` also registers
 * the LOOMIO_B3_API_KEY admin tools (28 tools instead of 24); `--json`
 * prints the same numbers as one JSON object for scripting.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "dist", "index.js");
const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const withB3 = args.has("--b3");

if (!existsSync(ENTRY)) {
  console.error("dist/index.js not found: run `npm run build` first.");
  process.exit(1);
}

// Rough token estimate for a JSON catalogue: ~4 bytes per token is the
// usual planning figure for English prose and JSON on current
// tokenisers. Only for the human-readable line; the byte count is the
// number tests pin.
const tokens = (bytes) => Math.round(bytes / 4);

const env = {
  ...process.env,
  LOOMIO_API_KEY: process.env.LOOMIO_API_KEY ?? "catalog-size-placeholder",
  LOOMIO_API_BASE_URL: process.env.LOOMIO_API_BASE_URL ?? "http://127.0.0.1:9/api",
};
if (withB3) env.LOOMIO_B3_API_KEY = process.env.LOOMIO_B3_API_KEY ?? "catalog-size-b3-placeholder";
else delete env.LOOMIO_B3_API_KEY;

const child = spawn(process.execPath, [ENTRY], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });

// stderr carries the server's boot log (including the expected "could
// not verify the Loomio API key" line for the placeholder URL); keep it
// out of the report unless the server fails to answer.
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const pending = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      } catch {
        // Not a JSON-RPC line (should not happen on stdout); ignore.
      }
    }
    newline = buffer.indexOf("\n");
  }
});

function request(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method}: no reply within 15s\n${stderr}`));
    }, 15_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
      else resolve(message.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

try {
  const init = await request(1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "catalog-size", version: "0" },
  });
  notify("notifications/initialized", {});
  const { tools } = await request(2, "tools/list", {});

  const instructions = init.instructions ?? "";
  const rows = tools
    .map((tool) => {
      const description = Buffer.byteLength(tool.description ?? "", "utf8");
      const schema = Buffer.byteLength(JSON.stringify(tool.inputSchema ?? {}), "utf8");
      return { name: tool.name, description, schema, total: description + schema };
    })
    .sort((a, b) => b.total - a.total);

  const report = {
    mode: withB3 ? "b3" : "full",
    tools: tools.length,
    tools_list_bytes: Buffer.byteLength(JSON.stringify(tools), "utf8"),
    descriptions_bytes: rows.reduce((sum, row) => sum + row.description, 0),
    schemas_bytes: rows.reduce((sum, row) => sum + row.schema, 0),
    instructions_chars: instructions.length,
    initialize_bytes: Buffer.byteLength(JSON.stringify(init), "utf8"),
    per_tool: rows,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `tools/list: ${report.tools} tools, ${report.tools_list_bytes} bytes (~${tokens(report.tools_list_bytes)} tokens)` +
        ` = descriptions ${report.descriptions_bytes} + input schemas ${report.schemas_bytes} + names/annotations`,
    );
    console.log(
      `initialize: ${report.initialize_bytes} bytes, instructions ${report.instructions_chars} chars (~${tokens(report.instructions_chars)} tokens)`,
    );
    console.log("");
    console.log(`${"total".padStart(6)} ${"desc".padStart(5)} ${"schema".padStart(6)}  tool`);
    for (const row of rows) {
      console.log(
        `${String(row.total).padStart(6)} ${String(row.description).padStart(5)} ${String(row.schema).padStart(6)}  ${row.name}`,
      );
    }
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  child.kill();
}
