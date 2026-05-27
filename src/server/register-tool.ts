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

function isDestructive(name: string): boolean {
  // `manage_memberships` can remove members when remove_absent=true.
  // `deactivate_user` disables a user account instance-wide (b3 admin).
  // Surface a destructiveHint so clients can prompt before invocation.
  return name.startsWith("delete_") || name === "manage_memberships" || name === "deactivate_user";
}

export function inferAnnotations(name: string): ToolAnnotations | undefined {
  if (READ_PREFIXES.some((p) => name.startsWith(p))) {
    return { readOnlyHint: true };
  }
  if (isDestructive(name)) {
    return { destructiveHint: true };
  }
  return undefined;
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

  const annotations = inferAnnotations(name);
  registerWithSchema(
    name,
    { description, inputSchema: schema, ...(annotations ? { annotations } : {}) },
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
