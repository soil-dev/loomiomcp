/**
 * The tool set `createLoomioMcpServer` advertises in each of its three
 * modes, observed through a real MCP client over the SDK's in-memory
 * transport — the same `tools/list` a Claude client sees:
 *
 *   read-only      LOOMIO_MCP_READONLY=1          reads only
 *   full           (default)                      reads + the b2 writes
 *   b3             LOOMIO_B3_API_KEY set, writable reads + writes + b3
 *
 * plus the ToolAnnotations each class carries, because clients decide
 * whether to prompt from those four flags. The READ set is asserted by
 * property (every tool in read-only mode is readOnlyHint) rather than by
 * name, so adding a read tool does not touch this file; the write and
 * b3 sets are pinned by name because their presence IS the contract.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("undici", () => ({ fetch: vi.fn() }));

afterEach(() => {
  delete process.env["LOOMIO_MCP_READONLY"];
  delete process.env["LOOMIO_B3_API_KEY"];
});

/** What a client learns at `initialize` + `tools/list`: the tool table (in registration order) and the server instructions. */
async function handshake(): Promise<{
  tools: Map<string, Tool>;
  order: string[];
  instructions: string | undefined;
}> {
  const { createLoomioMcpServer } = await import("../src/server.js");
  const server = createLoomioMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "server.test", version: "0" });
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return {
      tools: new Map(tools.map((t) => [t.name, t])),
      order: tools.map((t) => t.name),
      instructions: client.getInstructions(),
    };
  } finally {
    await client.close();
    await server.close();
  }
}

async function advertisedTools(): Promise<Map<string, Tool>> {
  return (await handshake()).tools;
}

const WRITES = [
  "create_discussion",
  "update_discussion",
  "delete_discussion",
  "create_poll",
  "update_poll",
  "delete_poll",
  "create_comment",
  "update_comment",
  "delete_comment",
  "manage_memberships",
] as const;

const B3 = ["deactivate_user", "reactivate_user", "get_user", "list_users"] as const;

describe("createLoomioMcpServer — tool sets per mode", () => {
  it("read-only mode advertises only readOnlyHint tools, and none of the writes or b3 tools", async () => {
    process.env["LOOMIO_MCP_READONLY"] = "1";
    process.env["LOOMIO_B3_API_KEY"] = "long-enough-admin-secret-12345";
    const tools = await advertisedTools();
    expect(tools.size).toBeGreaterThan(0);
    for (const [name, tool] of tools) {
      expect(tool.annotations?.readOnlyHint, `${name} should be read-only`).toBe(true);
      expect(tool.annotations?.destructiveHint, `${name} should not be destructive`).toBe(false);
    }
    for (const name of [...WRITES, ...B3, "list_events"]) expect(tools.has(name)).toBe(false);
  });

  it("full mode = the read set plus exactly the ten b2 writes", async () => {
    process.env["LOOMIO_MCP_READONLY"] = "1";
    const reads = await advertisedTools();
    delete process.env["LOOMIO_MCP_READONLY"];
    const full = await advertisedTools();

    for (const name of reads.keys())
      expect(full.has(name), `${name} missing in full mode`).toBe(true);
    const added = [...full.keys()].filter((n) => !reads.has(n)).sort();
    expect(added).toEqual([...WRITES].sort());
    for (const name of B3) expect(full.has(name)).toBe(false);
  });

  it("b3 mode adds exactly the four b3 tools, and only when writable", async () => {
    process.env["LOOMIO_B3_API_KEY"] = "long-enough-admin-secret-12345";
    const b3 = await advertisedTools();
    for (const name of [...WRITES, ...B3]) expect(b3.has(name), `${name} missing`).toBe(true);

    delete process.env["LOOMIO_B3_API_KEY"];
    const full = await advertisedTools();
    const added = [...b3.keys()].filter((n) => !full.has(n)).sort();
    expect(added).toEqual([...B3].sort());
  });

  it("list_events is gone (Loomio 3.4 removed the v1 events endpoint; list_thread_items replaces it)", async () => {
    const tools = await advertisedTools();
    expect(tools.has("list_events")).toBe(false);
    expect(tools.has("list_thread_items")).toBe(true);
  });
});

describe("createLoomioMcpServer — annotations", () => {
  it("every tool carries all four hints explicitly (the MCP defaults would read a bare readOnlyHint as 'may be destructive')", async () => {
    process.env["LOOMIO_B3_API_KEY"] = "long-enough-admin-secret-12345";
    const tools = await advertisedTools();
    for (const [name, tool] of tools) {
      const a = tool.annotations ?? {};
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        expect(typeof (a as Record<string, unknown>)[hint], `${name}.${hint}`).toBe("boolean");
      }
      expect(a.openWorldHint).toBe(true);
    }
  });

  it("delete_* AND update_* are destructive (they discard / overwrite — MCP defines destructiveHint:false as additive-only) and idempotent; create_* neither", async () => {
    const tools = await advertisedTools();
    const hints = (name: string) => {
      const t = tools.get(name);
      expect(t, `${name} registered`).toBeDefined();
      return t!.annotations!;
    };
    for (const name of ["delete_discussion", "delete_poll", "delete_comment"]) {
      expect(hints(name)).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      });
    }
    for (const name of ["update_discussion", "update_poll", "update_comment"]) {
      expect(hints(name)).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      });
    }
    for (const name of ["create_discussion", "create_poll", "create_comment"]) {
      expect(hints(name)).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      });
    }
    expect(hints("manage_memberships")).toMatchObject({
      destructiveHint: true,
      idempotentHint: false,
    });
  });

  it("b3: deactivate_user is destructive; get_user / list_users are plain reads (gated by registration, not by hint)", async () => {
    process.env["LOOMIO_B3_API_KEY"] = "long-enough-admin-secret-12345";
    const tools = await advertisedTools();
    expect(tools.get("deactivate_user")!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(tools.get("reactivate_user")!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    for (const name of ["get_user", "list_users"]) {
      expect(tools.get(name)!.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
      expect(tools.get(name)!.description).toMatch(/single-tenant/);
      expect(tools.get(name)!.description).toMatch(/EMAIL/);
    }
  });

  it("every write description says what happens on Loomio's side (soft delete named as such)", async () => {
    const tools = await advertisedTools();
    for (const name of ["delete_discussion", "delete_poll", "delete_comment"]) {
      expect(tools.get(name)!.description).toMatch(/SOFT delete/);
      expect(tools.get(name)!.description).toMatch(/nothing is permanently erased/i);
    }
    expect(tools.get("create_poll")!.description).toMatch(/NO default options/);
    expect(tools.get("create_comment")!.description).toMatch(/parent_id/);
  });

  it("create_poll tells the caller what its most common call really does: closing_at effectively required, notify_on_open announces by default", async () => {
    const tools = await advertisedTools();
    const d = tools.get("create_poll")!.description!;
    expect(d).toMatch(/`closing_at` .*effectively REQUIRED/);
    expect(d).toMatch(/saves the poll UNOPENED/);
    expect(d).toMatch(/`opened: false` and a `warning`/);
    expect(d).toMatch(/`notify_on_open` defaults to TRUE/);
    expect(d).toMatch(/notify_on_open: false/);
    expect(d).not.toMatch(/nobody is notified/);
    const u = tools.get("update_poll")!.description!;
    expect(u).toMatch(/never removes an option it saw/);
    expect(u).toMatch(/not atomic/);
    expect(u).not.toMatch(/options cannot be removed here/);
    const c = tools.get("create_comment")!.description!;
    expect(c).toMatch(/short key/);
    expect(c).toMatch(/stores an omitted format as Markdown/);
  });

  it("the write schemas' *_format fields name Loomio's real default (md) — no 'group default', no 'defaults to html'", async () => {
    const tools = await advertisedTools();
    const formatDescriptions: string[] = [];
    for (const [name, tool] of tools) {
      const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> })
        .properties;
      for (const [field, prop] of Object.entries(props ?? {})) {
        if (field.endsWith("_format"))
          formatDescriptions.push(`${name}.${field}: ${prop.description}`);
      }
    }
    expect(formatDescriptions.length).toBeGreaterThanOrEqual(6);
    for (const text of formatDescriptions) {
      expect(text).not.toMatch(/group default/i);
      expect(text).not.toMatch(/defaults to html/i);
      expect(text).toMatch(/'md'|STORED format/);
    }
  });

  it("check_connection is a read (readOnly + idempotent, not destructive) although its name has no get_/list_ prefix", async () => {
    process.env["LOOMIO_MCP_READONLY"] = "1";
    const tools = await advertisedTools();
    expect(tools.get("check_connection")!.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    // No input: the schema must still be an object so clients can call it with `{}`.
    expect(tools.get("check_connection")!.inputSchema.type).toBe("object");
  });
});

describe("createLoomioMcpServer — instructions and discovery order", () => {
  it("delivers a routing guide as MCP instructions naming the tool for each kind of question", async () => {
    const { instructions } = await handshake();
    expect(instructions).toBeDefined();
    const text = instructions!;
    // Ten numbered lines: one decision each, no per-tool detail.
    expect(text.match(/^\d+\. /gm)).toHaveLength(10);
    expect(text).toMatch(/check_connection first/);
    expect(text).toMatch(/list_threads/);
    expect(text).toMatch(/get_thread_markdown/);
    expect(text).toMatch(/search_content/);
    expect(text).toMatch(/get_participation_report/);
    expect(text).toMatch(/get_user_activity/);
    expect(text).toMatch(/Never infer who voted what on an anonymous poll/);
    expect(text).not.toMatch(/list_events/);
  });

  it("routes 'what's new since …' through list_threads' since / exhausted", async () => {
    const { instructions } = await handshake();
    expect(instructions).toMatch(/pass `since` and page with offset until scope\.exhausted/);
    expect(instructions).toMatch(/notify_on_open: false/);
    expect(instructions).toMatch(/`\*_format: 'html'`/);
    expect(instructions).toMatch(/end voting set `closing_at` to the next full hour/);
  });

  // The catalogue is a per-session fixed cost paid before the first call:
  // the first 0.0.12 draft weighed ~83 KB (~20k tokens) for the 24 full-mode
  // tools; the trim landed at 36 KB. These ceilings stop it creeping back:
  // raise them deliberately, with the reason in CHANGELOG, not by accident.
  // `scripts/catalog-size.mjs` prints the same numbers from the built server.
  it("the tools/list catalogue stays under its byte ceiling (24 full-mode tools <= 36 KB, 28 with b3 <= 40 KB)", async () => {
    const full = await handshake();
    expect(full.tools.size).toBe(24);
    expect(Buffer.byteLength(JSON.stringify([...full.tools.values()]), "utf8")).toBeLessThanOrEqual(
      36_000,
    );
    expect((full.instructions ?? "").length).toBeLessThanOrEqual(1_800);
    for (const tool of full.tools.values()) {
      const cap = tool.name.startsWith("delete_") || tool.name === "update_comment" ? 350 : 700;
      expect((tool.description ?? "").length, tool.name).toBeLessThanOrEqual(cap);
    }

    process.env["LOOMIO_B3_API_KEY"] = "long-enough-admin-secret-12345";
    const b3 = await handshake();
    expect(b3.tools.size).toBe(28);
    expect(Buffer.byteLength(JSON.stringify([...b3.tools.values()]), "utf8")).toBeLessThanOrEqual(
      40_000,
    );
  });

  it("lists check_connection first, so the tool that explains the rest is the first one a client reads", async () => {
    const { order } = await handshake();
    expect(order[0]).toBe("check_connection");
    expect(order.indexOf("list_groups")).toBeLessThan(order.indexOf("list_discussions"));
  });

  it("list_groups describes the native one-call index, not the 0.0.11 id probe", async () => {
    const tools = await advertisedTools();
    const d = tools.get("list_groups")!.description!;
    expect(d).toMatch(/1 call, no input/);
    expect(d).toMatch(/get_group/);
    expect(d).not.toMatch(/probing a group_id range/);
    expect(d).not.toMatch(/O\(end_id - start_id\)/);
    // The retired probe knobs are neither described nor advertised.
    expect(d).not.toMatch(/start_id|IGNORED/);
    expect(Object.keys(tools.get("list_groups")!.inputSchema.properties ?? {})).toEqual([]);
  });

  it("'close this poll' routes to update_poll's closing_at at the next full hour (no close route), and update_poll's closing_at never says REQUIRED", async () => {
    const tools = await advertisedTools();
    expect(tools.get("delete_poll")!.description).toMatch(/next full hour with update_poll/);
    expect(tools.get("delete_poll")!.description).toMatch(/no immediate close exists/);
    const field = (name: string, prop: string): string =>
      (tools.get(name)!.inputSchema.properties?.[prop] as { description?: string }).description ??
      "";
    // The shared poll fields are described per tool where the rule differs.
    expect(field("create_poll", "closing_at")).toMatch(/Effectively REQUIRED/);
    expect(field("update_poll", "closing_at")).not.toMatch(/REQUIRED|draft/);
    expect(field("update_poll", "closing_at")).toMatch(/omitted = unchanged/);
    expect(field("update_poll", "hide_results")).toMatch(/Cannot leave 'until_closed'/);
  });

  it("the read descriptions name the payload controls and gates a caller must know about", async () => {
    const tools = await advertisedTools();
    expect(tools.get("list_threads")!.description).toMatch(/pass `since`/);
    expect(tools.get("list_threads")!.description).toMatch(/scope\.exhausted/);
    expect(tools.get("list_thread_items")!.description).toMatch(/max_total_chars/);
    expect(tools.get("list_thread_items")!.description).toMatch(/next_offset/);
    expect(tools.get("get_discussion")!.description).toMatch(/items_limit/);
    expect(tools.get("get_group")!.description).toMatch(/`subscription`/);
    expect(tools.get("search_content")!.description).toMatch(/DROPPED from a `query` search/);
    expect(tools.get("search_content")!.description).toMatch(/never use search to probe/i);
    for (const name of ["get_participation_report", "get_user_activity"]) {
      expect(tools.get(name)!.description).toMatch(/counted stance row was created/);
      expect(tools.get(name)!.description).not.toMatch(/ISSUED \(poll opened\), not cast/);
    }
    expect(tools.get("list_discussions")!.description).toMatch(/description_max_chars/);
    expect(tools.get("list_discussions")!.description).toMatch(/description_truncated/);
    expect(tools.get("list_polls")!.description).toMatch(/results_visible/);
    expect(tools.get("get_poll")!.description).toMatch(/results_hidden_reason/);
    expect(tools.get("get_discussion")!.description).toMatch(/include_items/);
    expect(tools.get("get_group")!.description).toMatch(/Not authorized to show Group/);
    expect(tools.get("search_content")!.description).toMatch(/at most 20 results/);
  });

  it("no advertised description or the server instructions carry deployment specifics: no email address, no hostname beyond the documented generic ones", async () => {
    process.env["LOOMIO_B3_API_KEY"] = "long-enough-admin-secret-12345";
    const { tools, instructions } = await handshake();
    const corpus = [
      instructions ?? "",
      ...[...tools.values()].map((t) => t.description ?? ""),
    ].join("\n");
    // The repo is general-purpose: nothing a client reads may name a
    // deployment. The instance-name token list itself lives OUTSIDE the
    // repository (CONTRIBUTING.md: the release grep), so this test checks
    // the generic signals — an address, a host — rather than any name.
    expect(corpus).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    const hosts = new Set(
      (corpus.match(/\b(?:[a-z0-9-]+\.)+(?:org|com|net|io|dev|app)\b/gi) ?? []).map((h) =>
        h.toLowerCase(),
      ),
    );
    for (const host of hosts) {
      expect(["example.org", "loomio.com"], `hostname in a description: ${host}`).toContain(host);
    }
  });
});

// ── Refinements at runtime, through the real server ─────────────────────────
//
// Every cross-field rule (exactly one of discussion_id / poll_id /
// topic_id, per-type option minimums, query XOR author_id, …) lives in a
// zod superRefine. The unit tests exercise them with schema.safeParse;
// this block proves the SDK actually runs them on tools/call — a future
// SDK that re-wrapped the ZodObject's shape would silently drop every
// refinement and let create_poll save an option-less poll. SDK 1.29
// catches the InvalidParams McpError inside the CallTool handler and
// RESOLVES with `{ isError: true }`, so that is what is asserted, plus
// that no upstream request was attempted.

async function callToolRaw(name: string, args: Record<string, unknown>) {
  const { createLoomioMcpServer } = await import("../src/server.js");
  const server = createLoomioMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "server.test", version: "0" });
  await client.connect(clientTransport);
  try {
    return (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
  } finally {
    await client.close();
    await server.close();
  }
}

describe("createLoomioMcpServer — schema refinements run on tools/call", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["list_thread_items", {}, /exactly one of discussion_id, poll_id or topic_id/],
    ["list_thread_items", { topic_id: 1, poll_id: 2 }, /exactly one of/],
    ["get_thread_markdown", { topic_id: 1, max_chars: 0 }, /0 would return nothing/],
    ["search_content", {}, /Pass `query`, `author_id`, or both/],
    ["create_poll", { title: "P", poll_type: "proposal", group_id: 1 }, /needs at least 1 option/],
    [
      "create_poll",
      { title: "P", poll_type: "poll", options: ["A"] },
      /Pass group_id .* or discussion_id/,
    ],
    [
      "create_poll",
      { title: "P", poll_type: "poll", options: ["A"], discussion_id: 1, topic_id: 2 },
      /not both/,
    ],
    ["update_poll", { id_or_key: 1 }, /Nothing to update/],
    ["update_poll", { id_or_key: 1, options: [] }, /options/],
  ];

  it.each(
    cases,
  )("%s %j is refused with isError before any upstream request", async (name, args, message) => {
    process.env["LOOMIO_API_KEY"] = "test-key";
    try {
      const { fetch } = await import("undici");
      vi.mocked(fetch).mockReset();
      const result = await callToolRaw(name, args);
      expect(result.isError).toBe(true);
      const text = result.content.map((c) => c.text ?? "").join("\n");
      expect(text).toMatch(/Input validation error/);
      expect(text).toMatch(message);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    } finally {
      delete process.env["LOOMIO_API_KEY"];
    }
  });

  it("a valid input reaches the handler (positive control: the mocked fetch is called)", async () => {
    process.env["LOOMIO_API_KEY"] = "test-key";
    try {
      const { fetch } = await import("undici");
      vi.mocked(fetch).mockReset();
      vi.mocked(fetch).mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Headers(),
        json: async () => ({ items: [], meta: { root: "items", total: 0 } }),
        text: async () => "{}",
        statusText: "200",
      } as Awaited<ReturnType<typeof fetch>>);
      const result = await callToolRaw("list_thread_items", { topic_id: 1 });
      expect(result.isError).toBeFalsy();
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      // Compact JSON by default: no indentation reaches the model.
      const text = result.content[0]!.text ?? "";
      expect(text.startsWith('{"topic_id":1,')).toBe(true);
      expect(text).not.toContain("\n  ");
    } finally {
      delete process.env["LOOMIO_API_KEY"];
    }
  });
});
