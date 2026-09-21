/**
 * Helper to register an MCP tool whose handler returns any value and
 * needs to be wrapped in the standard JSON-stringify-into-text MCP
 * response shape.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z, ZodRawShape } from "zod";
import { readBool } from "../env.js";
import { getRequestContext, logEvent } from "../log.js";

/**
 * Prefixes that identify a tool as read-only by naming convention.
 * `check_` is here for `check_connection`: it runs the key-health
 * probe (two GETs) and reads the cached groups body — nothing on
 * Loomio changes — so it must be advertised as a read, or a client
 * would prompt before the very call meant to tell it what works.
 */
const READ_PREFIXES = ["search_", "filter_", "get_", "list_", "show_", "run_", "check_"];

function isReadOnlyByName(name: string): boolean {
  return READ_PREFIXES.some((p) => name.startsWith(p));
}

function isDestructive(name: string): boolean {
  // The MCP spec defines `destructiveHint: false` as "the tool performs
  // ONLY ADDITIVE updates". Everything that removes or overwrites is
  // therefore true:
  //   - `delete_*`: Loomio's soft discard (restorable by an admin, not
  //     by this connector).
  //   - `update_*`: a PATCH REPLACES the title / body / details it is
  //     given (Loomio keeps versions, but the live text is gone), can
  //     shorten a poll's `closing_at`, tighten `hide_results`
  //     irreversibly, flip a discussion's `private`. Idempotent, yes;
  //     additive, no.
  //   - `manage_memberships` removes members when remove_absent=true.
  //   - `deactivate_user` disables a user account instance-wide (b3).
  // Surface the hint so clients can prompt before invocation.
  return (
    name.startsWith("delete_") ||
    name.startsWith("update_") ||
    name === "manage_memberships" ||
    name === "deactivate_user"
  );
}

/**
 * Compute the full ToolAnnotations record for a tool by name.
 *
 * Loud explicitness matters here: per MCP spec
 * (https://modelcontextprotocol.io/specification/2025-03-26/server/tools),
 * `destructiveHint` defaults to TRUE when unset, and `readOnlyHint`
 * defaults to FALSE. So a tool that only advertises
 * `{readOnlyHint: true}` is read by spec-compliant clients as
 * "read-only, but may also be destructive" — contradictory, and
 * conservative clients (Claude.ai included) treat the absent
 * `destructiveHint: false` as "ask the user before each call".
 *
 * Returning all four flags on every tool removes that ambiguity and
 * lets MCP clients (Claude.ai's Custom Connector flow specifically)
 * auto-approve reads without per-call prompts. Values:
 *
 *   readOnlyHint   — true for `get_…` / `list_…` / etc. by naming
 *                     convention
 *   destructiveHint — true for every tool that may delete OR overwrite
 *                     (`delete_…`, `update_…`, manage_memberships with
 *                     remove_absent, deactivate_user); false only for
 *                     reads and the purely additive `create_…` /
 *                     reactivate_user. See `isDestructive`.
 *   idempotentHint  — reads are idempotent (no side effects), and so
 *                     are `update_…` (a PATCH with the same fields
 *                     twice leaves the same record) and `delete_…`
 *                     (Loomio's soft discard of an already discarded
 *                     record changes nothing). `create_…` always adds
 *                     a row and `manage_memberships` / `deactivate_…`
 *                     have per-call side effects, so they report false.
 *   openWorldHint   — true for every tool here; this connector exists
 *                     to call out to the Loomio API.
 */
export function inferAnnotations(name: string): ToolAnnotations {
  const readOnly = isReadOnlyByName(name);
  const idempotentWrite = name.startsWith("update_") || name.startsWith("delete_");
  return {
    readOnlyHint: readOnly,
    destructiveHint: isDestructive(name),
    idempotentHint: readOnly || idempotentWrite,
    openWorldHint: true,
  };
}

function argFieldNames(input: unknown): string[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return [];
  return Object.keys(input as Record<string, unknown>);
}

function emitToolCall(opts: {
  tool: string;
  clientId?: string;
  argFields: string[];
  startedAt: number;
  outcome: "success" | "error";
}): void {
  logEvent("tool.call", {
    tool: opts.tool,
    ...(opts.clientId ? { clientId: opts.clientId } : {}),
    argFields: opts.argFields,
    durationMs: Date.now() - opts.startedAt,
    outcome: opts.outcome,
  });
}

/**
 * Serialise a tool result for the model. COMPACT by default: the
 * indentation and newlines of a pretty-printed document are pure
 * overhead for a reader that parses JSON, and measured over the shaped
 * 3.8.1 fixtures they added 10–37 % to every reply (a 50-row discussion
 * list ≈ 113 KB compact vs ≈ 124 KB indented). `LOOMIO_MCP_PRETTY_JSON=1`
 * restores the indented form for a human reading a stdio session.
 */
export function serializeToolResult(result: unknown): string {
  return readBool("LOOMIO_MCP_PRETTY_JSON")
    ? JSON.stringify(result, null, 2)
    : JSON.stringify(result);
}

function wrapAsText(result: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text", text: serializeToolResult(result) }],
  };
}

export function registerTool<Schema extends z.ZodObject<ZodRawShape>>(
  server: McpServer,
  name: string,
  description: string,
  schema: Schema,
  handler: (input: z.infer<Schema>) => Promise<unknown>,
): void {
  const registerWithSchema = server.registerTool.bind(server) as (
    toolName: string,
    config: {
      description: string;
      inputSchema: Schema;
      annotations?: ToolAnnotations;
    },
    callback: (input: z.infer<Schema>) => Promise<CallToolResult>,
  ) => void;

  registerWithSchema(
    name,
    { description, inputSchema: schema, annotations: inferAnnotations(name) },
    async (input) => {
      const startedAt = Date.now();
      const argFields = argFieldNames(input);
      const clientId = getRequestContext()?.clientId;
      try {
        const result = await handler(input);
        emitToolCall({ tool: name, clientId, argFields, startedAt, outcome: "success" });
        return wrapAsText(result);
      } catch (err) {
        emitToolCall({ tool: name, clientId, argFields, startedAt, outcome: "error" });
        throw err;
      }
    },
  );
}
