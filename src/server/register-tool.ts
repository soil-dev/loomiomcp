/**
 * Helper to register an MCP tool whose handler returns any value and
 * needs to be wrapped in the standard JSON-stringify-into-text MCP
 * response shape.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z, ZodRawShape } from "zod";
import { getRequestContext, logEvent } from "../log.js";

/**
 * Prefixes that identify a tool as read-only by naming convention.
 */
const READ_PREFIXES = ["search_", "filter_", "get_", "list_", "show_", "run_"];

function isReadOnlyByName(name: string): boolean {
  return READ_PREFIXES.some((p) => name.startsWith(p));
}

function isDestructive(name: string): boolean {
  // `manage_memberships` can remove members when remove_absent=true.
  // `deactivate_user` disables a user account instance-wide (b3 admin).
  // Surface a destructiveHint so clients can prompt before invocation.
  return name.startsWith("delete_") || name === "manage_memberships" || name === "deactivate_user";
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
 *   destructiveHint — true only for tools that may delete/overwrite
 *                     (manage_memberships with remove_absent;
 *                     deactivate_user; any future `delete_…`)
 *   idempotentHint  — reads are idempotent (no side effects). Writes
 *                     vary; we conservatively report false for them
 *                     (`create_…` always creates a new row).
 *   openWorldHint   — true for every tool here; this connector exists
 *                     to call out to the Loomio API.
 */
export function inferAnnotations(name: string): ToolAnnotations {
  const readOnly = isReadOnlyByName(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: isDestructive(name),
    idempotentHint: readOnly,
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

function wrapAsText(result: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
