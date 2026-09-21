import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockFetch, setupLoomioTest } from "./test-helpers.js";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();
// readonly tests toggle LOOMIO_MCP_READONLY / LOOMIO_B3_API_KEY per-test;
// the shared helper covers LOOMIO_API_KEY but doesn't know about these.
afterEach(() => {
  delete process.env["LOOMIO_MCP_READONLY"];
  delete process.env["LOOMIO_B3_API_KEY"];
});

// ── The tool set per mode, pinned by NAME ───────────────────────────────────
//
// tests/server.test.ts checks the sets by property (every read-only tool
// is readOnlyHint, the writes add exactly WRITES, …). This block pins the
// read set by name as well, because the READ inventory is the release's
// public contract: a read that silently fails to register (a typo in
// server.ts, a tool file that stopped exporting its schema) would still
// pass a by-property test. Sorted comparison so registration order —
// asserted separately — does not couple the two files.

/** The 14 reads 0.0.12 advertises in EVERY mode, read-only included. */
const READS = [
  "check_connection",
  "list_groups",
  "get_group",
  "get_discussion",
  "list_discussions",
  "get_poll",
  "list_polls",
  "list_threads",
  "list_thread_items",
  "get_thread_markdown",
  "search_content",
  "get_participation_report",
  "get_user_activity",
  "list_memberships",
] as const;

/** The 10 b2 writes, absent under LOOMIO_MCP_READONLY. */
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

/** The 4 b3 tools, present only with LOOMIO_B3_API_KEY AND not read-only. */
const B3 = ["deactivate_user", "reactivate_user", "get_user", "list_users"] as const;

async function toolNames(): Promise<string[]> {
  const { createLoomioMcpServer } = await import("../src/server.js");
  const server = createLoomioMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "readonly.test", version: "0" });
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name).sort();
  } finally {
    await client.close();
    await server.close();
  }
}

const sorted = (...sets: readonly (readonly string[])[]) => sets.flat().sort();

describe("tool set per mode (by name)", () => {
  it("read-only: exactly the 14 reads — even with a b3 secret configured", async () => {
    process.env["LOOMIO_MCP_READONLY"] = "1";
    process.env["LOOMIO_B3_API_KEY"] = "long-enough-admin-secret-12345";
    expect(await toolNames()).toEqual(sorted(READS));
  });

  it("full (default): the 14 reads plus the 10 b2 writes, no b3", async () => {
    expect(await toolNames()).toEqual(sorted(READS, WRITES));
  });

  it("b3 (LOOMIO_B3_API_KEY set, writable): reads + writes + the 4 b3 tools", async () => {
    process.env["LOOMIO_B3_API_KEY"] = "long-enough-admin-secret-12345";
    expect(await toolNames()).toEqual(sorted(READS, WRITES, B3));
  });

  it("list_events is not registered in any mode", async () => {
    process.env["LOOMIO_B3_API_KEY"] = "long-enough-admin-secret-12345";
    expect(await toolNames()).not.toContain("list_events");
  });

  it("inferAnnotations treats check_connection as a read (the check_ prefix), so read-only mode can advertise it", async () => {
    const { inferAnnotations } = await import("../src/server/register-tool.js");
    expect(inferAnnotations("check_connection")).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });
});

describe("isReadOnly", () => {
  it.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["yes", true],
    ["YES", true],
    ["on", true],
    ["ON", true],
    ["0", false],
    ["false", false],
    ["no", false],
    ["", false],
    [undefined, false],
  ])("LOOMIO_MCP_READONLY=%j → %s", async (value, expected) => {
    if (value === undefined) {
      delete process.env["LOOMIO_MCP_READONLY"];
    } else {
      process.env["LOOMIO_MCP_READONLY"] = value;
    }
    const { isReadOnly } = await import("../src/loomio/client.js");
    expect(isReadOnly()).toBe(expected);
  });
});

describe("read-only client guard", () => {
  beforeEach(() => {
    process.env["LOOMIO_MCP_READONLY"] = "1";
  });

  it("blocks create_discussion without making any HTTP call", async () => {
    const { createDiscussion } = await import("../src/tools/discussions.js");
    await expect(createDiscussion({ title: "T", group_id: 1, private: false })).rejects.toThrow(
      /read-only mode/,
    );
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("blocks create_discussion with `private` omitted too (no pre-flight lookup exists any more)", async () => {
    const { createDiscussion } = await import("../src/tools/discussions.js");
    await expect(createDiscussion({ title: "T", group_id: 1 })).rejects.toThrow(/read-only mode/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("blocks create_poll without making any HTTP call", async () => {
    const { createPoll } = await import("../src/tools/polls.js");
    await expect(createPoll({ title: "T", poll_type: "proposal", group_id: 1 })).rejects.toThrow(
      /read-only mode/,
    );
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("blocks manage_memberships without making any HTTP call", async () => {
    const { manageMemberships } = await import("../src/tools/memberships.js");
    await expect(manageMemberships({ group_id: 1, emails: ["a@x.test"] })).rejects.toThrow(
      /read-only mode/,
    );
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it.each([
    [
      "update_discussion",
      async () =>
        (await import("../src/tools/discussions.js")).updateDiscussion({
          id_or_key: 1,
          title: "T",
        }),
    ],
    [
      "delete_discussion",
      async () => (await import("../src/tools/discussions.js")).deleteDiscussion({ id_or_key: 1 }),
    ],
    [
      "create_poll (discussion_id — the resolution GET must not happen either)",
      async () =>
        (await import("../src/tools/polls.js")).createPoll({
          title: "T",
          poll_type: "poll",
          discussion_id: 1,
          options: ["A"],
        }),
    ],
    [
      "update_poll",
      async () => (await import("../src/tools/polls.js")).updatePoll({ id_or_key: 1, title: "T" }),
    ],
    [
      "delete_poll",
      async () => (await import("../src/tools/polls.js")).deletePoll({ id_or_key: 1 }),
    ],
    [
      "create_comment",
      async () =>
        (await import("../src/tools/comments.js")).createComment({ discussion_id: 1, body: "x" }),
    ],
    [
      "update_comment",
      async () => (await import("../src/tools/comments.js")).updateComment({ id: 1, body: "x" }),
    ],
    [
      "delete_comment",
      async () => (await import("../src/tools/comments.js")).deleteComment({ id: 1 }),
    ],
  ])("blocks %s without making any HTTP call", async (_name, call) => {
    await expect(call()).rejects.toThrow(/read-only mode/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("still allows GET", async () => {
    mockFetch(200, { discussions: [{ id: 1, key: "abcDEF12", title: "T", topic_id: 5 }] });
    const { getDiscussion } = await import("../src/tools/discussions.js");
    const result = await getDiscussion({ id_or_key: 1 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(result.discussion.id).toBe(1);
  });
});
