/**
 * The Loomio-client and tool-layer fixes of the 2026-10-25 security
 * review (v0.0.17, stage "tools"). Each block names the finding and pins
 * behaviour that FAILS on v0.0.16:
 *
 *   F-02    a credential a bearer header cannot carry never reaches a
 *           caller, a log line or the probe's detail
 *   F-04    member e-mails: dropped in read-only mode and on the API
 *           user's own row; an admin membership is noted and logged
 *   F-17    LOOMIO_MCP_GROUP_IDS allow-list on every group-scoped tool;
 *           forced loomio.groups_changed on a membership/admin/privacy
 *           change
 *   nit 9   b3 identity route segments
 *   nit 10  Retry-After echoed only when well-formed
 *   nit 11  4 MB tool reply / 64 MB upstream body ceilings
 *   nit 12  show shapes are allow-lists
 *   nit 16  length caps on free text
 *   nit 19  hidden vs not-found collapsed in open-DCR mode
 *
 * F-03 (search oracle), F-15 (Markdown guard) and nit 8 (missing
 * hide_results) live beside their tools' tests: tests/search.test.ts,
 * tests/threads.test.ts, tests/visibility.test.ts.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fetch } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADA,
  BOARD,
  commentRow,
  EXAMPLE_ORG,
  FINANCE,
  discussionRow,
  discussionShowBody,
  discussionsListBody,
  groupRow,
  groupShowBody,
  groupsIndexBody,
  LINUS,
  membershipRow,
  membershipsListBody,
  pollRow,
  pollShowBody,
  pollsListBody,
  reportsUsersBody,
  SEARCH_ROWS,
  searchBody,
  searchResultRow,
  threadShowBody,
  threadsIndexBody,
  topicRow,
  VOLUNTEERS,
} from "./fixtures.js";
import {
  fetchCallsTo,
  mockFetch,
  mockFetchPaged,
  mockFetchRoutes,
  setupLoomioTest,
} from "./test-helpers.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

let stderrLines: string[] = [];

beforeEach(async () => {
  const { resetHealthForTests } = await import("../src/loomio/health.js");
  resetHealthForTests();
  stderrLines = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderrLines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const k of [
    "LOOMIO_MCP_GROUP_IDS",
    "LOOMIO_MCP_READONLY",
    "LOOMIO_B3_API_KEY",
    "LOOMIO_API_BASE_URL",
  ]) {
    delete process.env[k];
  }
  const { setOpenDcrMode } = await import("../src/deployment.js");
  setOpenDcrMode(false);
});

function stderrEvents(): Array<Record<string, unknown>> {
  return stderrLines
    .flatMap((chunk) => chunk.split("\n"))
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

type Call = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ isError: boolean; text: string }>;

/** A real MCP client over the SDK's in-memory transport: what a caller sees, error texts included. */
async function withClient<T>(fn: (call: Call, tools: string[]) => Promise<T>): Promise<T> {
  const { createLoomioMcpServer } = await import("../src/server.js");
  const server = createLoomioMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "tools-hardening", version: "0" });
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    const call: Call = async (name, args) => {
      const r = await client.callTool({ name, arguments: args });
      const content = (r.content ?? []) as Array<{ type: string; text?: string }>;
      return { isError: r.isError === true, text: content.map((c) => c.text ?? "").join("\n") };
    };
    return await fn(
      call,
      tools.map((t) => t.name),
    );
  } finally {
    await client.close();
    await server.close();
  }
}

/** One valid call per tool, so a sweep reaches every handler (a new tool must be added here). */
const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  check_connection: {},
  list_groups: {},
  get_group: { id_or_key_or_handle: 7 },
  get_discussion: { id_or_key: 601 },
  list_discussions: { group_id: 7 },
  create_discussion: { title: "t", group_id: 7 },
  update_discussion: { id_or_key: 601, title: "t" },
  delete_discussion: { id_or_key: 601 },
  get_poll: { id_or_key: 301 },
  list_polls: { group_id: 7 },
  create_poll: {
    title: "t",
    poll_type: "question",
    group_id: 7,
    closing_at: "2099-01-01T00:00:00Z",
  },
  update_poll: { id_or_key: 301, title: "t" },
  delete_poll: { id_or_key: 301 },
  list_threads: {},
  list_thread_items: { topic_id: 701 },
  get_thread_markdown: { topic_id: 701 },
  search_content: { query: "budget" },
  get_participation_report: { group_ids: [7] },
  get_user_activity: { user_id: 503, group_ids: [7, 12] },
  list_memberships: { group_id: 7 },
  manage_memberships: { group_id: 7, emails: ["a@example.org"] },
  create_comment: { discussion_id: 601, body: "b" },
  update_comment: { id: 1701, body: "b" },
  delete_comment: { id: 1701 },
  deactivate_user: { id: 503 },
  reactivate_user: { id: 503 },
  get_user: { id: 503 },
  list_users: {},
  list_instance_groups: {},
  list_instance_memberships: { group_id: 7 },
  add_group_members: { group_id: 7, emails: ["a@example.org"] },
  update_membership_roles: { id: 61, admin: true },
  revoke_membership: { id: 61 },
};

// ── F-02 ────────────────────────────────────────────────────────────────────

describe("F-02: credentials a bearer header cannot carry never leave the process", () => {
  const B2 = "DUMMY-PART-A\r\nDUMMY-PART-B";
  const B3 = "B3SECRET-PART-ONE\nB3SECRET-PART-TWO";
  const LEAKS = /DUMMY-PART|B3SECRET-PART/;

  it("every tool, every error path: no reply, log line or probe detail quotes either two-line secret (v0.0.16 echoed both)", async () => {
    process.env["LOOMIO_API_KEY"] = B2;
    process.env["LOOMIO_B3_API_KEY"] = B3;
    // What undici would say if a request were ever built with these values.
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
      if (auth !== undefined) {
        throw new TypeError(`Headers.append: "${auth}" is an invalid header value.`);
      }
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/v1/boot/version")) {
        return {
          status: 200,
          ok: true,
          headers: new Headers(),
          text: async () => JSON.stringify({ version: "3.13.1" }),
        } as Awaited<ReturnType<typeof fetch>>;
      }
      throw new Error(`unexpected ${path}`);
    });
    const replies = await withClient(async (call, tools) => {
      expect(tools.length).toBe(33);
      const out: Array<{ tool: string; isError: boolean; text: string }> = [];
      for (const tool of tools) {
        const args = MINIMAL_ARGS[tool];
        expect(args, `MINIMAL_ARGS lacks ${tool}`).toBeDefined();
        out.push({ tool, ...(await call(tool, args!)) });
      }
      return out;
    });
    for (const r of replies) expect(r.text, r.tool).not.toMatch(LEAKS);
    expect(stderrLines.join("")).not.toMatch(LEAKS);
    // Refused at the credential read with the FIXED message — no request
    // carrying a header was ever attempted.
    const listGroups = replies.find((r) => r.tool === "list_groups")!;
    expect(listGroups.isError).toBe(true);
    expect(listGroups.text).toMatch(
      /LOOMIO_API_KEY contains characters a bearer credential cannot carry/,
    );
    const getUser = replies.find((r) => r.tool === "get_user")!;
    expect(getUser.text).toMatch(/LOOMIO_B3_API_KEY contains characters/);
    for (const [, init] of vi.mocked(fetch).mock.calls) {
      expect(
        (init?.headers as Record<string, string> | undefined)?.["Authorization"],
      ).toBeUndefined();
    }
    // check_connection reports the probe as a CONFIGURATION error, not a
    // transient network problem (v0.0.16: network_error).
    const auth = stderrEvents().find((e) => e["event"] === "loomio.auth");
    expect(auth).toMatchObject({ key_status: "unreachable", reason: "config_error" });
  });

  it("the probe's operator-facing detail is fixed text too", async () => {
    process.env["LOOMIO_API_KEY"] = B2;
    mockFetchRoutes({ "/v1/boot/version": { status: 200, body: { version: "3.13.1" } } });
    const { checkLoomioHealth } = await import("../src/loomio/health.js");
    const h = await checkLoomioHealth({ force: true });
    expect(h.reason).toBe("config_error");
    expect(h.detail).toMatch(/LOOMIO_API_KEY contains characters/);
    expect(h.detail).not.toMatch(LEAKS);
  });

  it("one trailing newline (`echo key > file`) is normalised, not refused", async () => {
    process.env["LOOMIO_API_KEY"] = "test-key-123\n";
    mockFetch(200, groupsIndexBody());
    const { listGroups } = await import("../src/tools/groups.js");
    await listGroups();
    const init = vi.mocked(fetch).mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers["Authorization"]).toBe("Bearer test-key-123");
  });

  it("secretConfigError (both entry points' startup check) refuses without quoting the value", async () => {
    const { secretConfigError } = await import("../src/loomio/secrets.js");
    expect(secretConfigError({ LOOMIO_API_KEY: "ok-key" })).toBeUndefined();
    expect(secretConfigError({ LOOMIO_API_KEY: "ok-key\n" })).toBeUndefined();
    for (const bad of [
      B2,
      "SPCSECRET XYZSECRET",
      "TABSECRET\tQQQSECRET",
      "UNICODE-SECRET-é",
      "\n",
    ]) {
      const msg = secretConfigError({ LOOMIO_API_KEY: bad });
      expect(msg, JSON.stringify(bad)).toMatch(/LOOMIO_API_KEY (is empty|contains characters)/);
      for (const part of bad.split(/\s+/).filter((p) => p.length >= 3)) {
        expect(msg).not.toContain(part);
      }
    }
    expect(secretConfigError({ LOOMIO_API_KEY: "ok", LOOMIO_B3_API_KEY: B3 })).toMatch(
      /^LOOMIO_B3_API_KEY contains characters/,
    );
  });

  it("leading/trailing spaces, tabs, CRs and extra newlines are trimmed, as v0.0.16's undici Headers did (compat: no new FATAL)", async () => {
    // v0.0.16 sent each of these as exactly `Bearer abc12345key` (WHATWG
    // header-value normalisation), so v0.0.17 must start and send the same.
    const { secretConfigError } = await import("../src/loomio/secrets.js");
    const { listGroups } = await import("../src/tools/groups.js");
    for (const padded of [
      "abc12345key ",
      "abc12345key\t",
      "abc12345key\n\n",
      "abc12345key\r",
      " abc12345key",
      "abc12345key\r\n",
    ]) {
      expect(secretConfigError({ LOOMIO_API_KEY: padded }), JSON.stringify(padded)).toBeUndefined();
      process.env["LOOMIO_API_KEY"] = padded;
      vi.mocked(fetch).mockClear();
      mockFetch(200, groupsIndexBody());
      await listGroups();
      const init = vi.mocked(fetch).mock.calls[0]![1] as { headers: Record<string, string> };
      expect(init.headers["Authorization"], JSON.stringify(padded)).toBe("Bearer abc12345key");
    }
    // Trimming the ENDS never rescues an interior break or space (F-02).
    expect(secretConfigError({ LOOMIO_API_KEY: " abc\n12345key " })).toMatch(/contains characters/);
    expect(secretConfigError({ LOOMIO_API_KEY: "abc 12345key\n" })).toMatch(/contains characters/);
    expect(secretConfigError({ LOOMIO_API_KEY: " \t\r\n" })).toMatch(/is empty/);
  });

  it("scrubSecrets also redacts the trimmed form of a padded secret", async () => {
    process.env["LOOMIO_API_KEY"] = "  padded-SECRET-777\t\n";
    const { scrubSecrets } = await import("../src/loomio/secrets.js");
    expect(scrubSecrets("echo: Bearer padded-SECRET-777 rejected")).toBe(
      "echo: Bearer [redacted] rejected",
    );
  });

  it("an undici TypeError that quotes the request is mapped to a fixed transport error (class only), logged without its message", async () => {
    process.env["LOOMIO_API_KEY"] = "test-key-SECRET-1234";
    vi.mocked(fetch).mockRejectedValue(
      new TypeError('Headers.append: "Bearer test-key-SECRET-1234" is an invalid header value.'),
    );
    const { listGroups } = await import("../src/tools/groups.js");
    const { LoomioTransportError } = await import("../src/loomio/client.js");
    const err = await listGroups().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoomioTransportError);
    expect((err as InstanceType<typeof LoomioTransportError>).status).toBe(502);
    expect((err as InstanceType<typeof LoomioTransportError>).kind).toBe("config");
    expect((err as Error).message).toMatch(/^Transport error while calling Loomio \(TypeError\)/);
    expect((err as Error).message).not.toContain("SECRET-1234");
    const event = stderrEvents().find((e) => e["event"] === "upstream.transport_error");
    expect(event).toMatchObject({ name: "TypeError", kind: "config" });
    expect(JSON.stringify(stderrEvents())).not.toContain("SECRET-1234");
  });

  it("a DNS / connect failure names the error code only, as a network error", async () => {
    const dns = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND loomio.internal.example"), {
        code: "ENOTFOUND",
      }),
    });
    vi.mocked(fetch).mockRejectedValue(dns);
    const { listGroups } = await import("../src/tools/groups.js");
    const err = (await listGroups().catch((e: unknown) => e)) as Error & { kind?: string };
    expect(err.message).toMatch(/Transport error while calling Loomio \(TypeError ENOTFOUND\)/);
    expect(err.message).not.toContain("loomio.internal.example");
    expect(err.kind).toBe("network");
  });

  it("registerTool scrubs a configured secret out of any tool error (here: an upstream 500 echoing the bearer)", async () => {
    process.env["LOOMIO_API_KEY"] = "test-key-SECRET-1234";
    mockFetch(500, "upstream proxy says: Authorization: Bearer test-key-SECRET-1234 rejected");
    const r = await withClient((call) => call("list_discussions", { group_id: 7 }));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("[redacted]");
    expect(r.text).not.toContain("SECRET-1234");
  });

  it("get_user_activity's relayed search error is scrubbed too (it travels in the RESULT, not as a tool error)", async () => {
    process.env["LOOMIO_API_KEY"] = "test-key-SECRET-1234";
    mockFetchRoutes({
      "/b2/reports": { status: 200, body: reportsUsersBody() },
      "/b2/search": { status: 500, body: "echo: Bearer test-key-SECRET-1234" },
    });
    const { getUserActivity } = await import("../src/tools/reports.js");
    const r = await getUserActivity({ user_id: 503, group_ids: [7] });
    expect(r.scope.samples.error).toContain("[redacted]");
    expect(JSON.stringify(r)).not.toContain("SECRET-1234");
  });

  it("scrubSecrets replaces the whole value, a multi-line value's lines, and its JSON-escaped form", async () => {
    process.env["LOOMIO_API_KEY"] = "line-one-AAAAAA\nline-two-BBBBBB";
    const { scrubSecrets } = await import("../src/loomio/secrets.js");
    expect(scrubSecrets('x "line-one-AAAAAA\\nline-two-BBBBBB" y')).toBe('x "[redacted]" y');
    expect(scrubSecrets("a line-two-BBBBBB b")).toBe("a [redacted] b");
    expect(scrubSecrets("nothing here")).toBe("nothing here");
  });
});

// ── F-04 ────────────────────────────────────────────────────────────────────

describe("F-04: member e-mails", () => {
  /** A roster where Loomio sent user_email on every row (an admin group), the own row included. */
  function adminRoster() {
    const body = membershipsListBody({
      users: [ADA, LINUS],
      memberships: [
        membershipRow({ id: 1, user_id: 501, admin: true, user_email: "ada@example.org" }),
        membershipRow({ id: 2, user_id: 503, user_email: "linus@example.org" }),
      ],
    });
    return body;
  }

  it("read-only mode: user_email is dropped from EVERY row (v0.0.16 relayed them to any caller)", async () => {
    process.env["LOOMIO_MCP_READONLY"] = "1";
    mockFetch(200, adminRoster());
    const { listMemberships } = await import("../src/tools/memberships.js");
    const r = await listMemberships({ group_id: 7 });
    expect(r.memberships).toHaveLength(2);
    for (const m of r.memberships) expect(m).not.toHaveProperty("user_email");
    expect(JSON.stringify(r)).not.toMatch(/@example\.org/);
  });

  it("writable mode: the API user's OWN row loses user_email (recognised by its users[].email), other rows keep it", async () => {
    mockFetch(200, adminRoster());
    const { listMemberships } = await import("../src/tools/memberships.js");
    const r = await listMemberships({ group_id: 7 });
    expect(r.memberships.find((m) => m.user_id === 501)).not.toHaveProperty("user_email");
    expect(r.memberships.find((m) => m.user_id === 503)?.user_email).toBe("linus@example.org");
    expect(JSON.stringify(r)).not.toContain("ada@example.org");
  });

  it("…and by the health probe's cached identity when users[] carries no e-mail", async () => {
    const { setCachedHealth } = await import("../src/loomio/health-cache.js");
    setCachedHealth(
      { key_status: "valid", loomio_version: "3.13.1", checked_at: new Date().toISOString() },
      Date.now(),
      groupsIndexBody(),
    );
    const body = adminRoster();
    body.users = [{ ...ADA, email: undefined }, LINUS];
    mockFetch(200, body);
    const { listMemberships } = await import("../src/tools/memberships.js");
    const r = await listMemberships({ group_id: 7 });
    expect(r.memberships.find((m) => m.user_id === 501)).not.toHaveProperty("user_email");
  });

  it("check_connection notes an admin membership and the probe logs a FORCED loomio.admin_scope once", async () => {
    mockFetchRoutes({
      "/b2/groups": { status: 200, body: groupsIndexBody() },
      "/v1/boot/version": { status: 200, body: { version: "3.13.1" } },
    });
    const { checkConnection } = await import("../src/tools/groups.js");
    const first = await checkConnection();
    expect(first.groups.find((g) => g.id === 12)?.admin).toBe(true);
    expect(first.notes.some((n) => /group ADMIN in 1 group/.test(n))).toBe(true);
    await checkConnection();
    const events = stderrEvents().filter((e) => e["event"] === "loomio.admin_scope");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ admin_group_ids: [12] });
  });

  it("admin rows past the probe's first page: repeated check_connection forces ONE admin_scope line, not one per call (round 1)", async () => {
    const { manyGroups, manyGroupsSideLoads } = await import("./fixtures.js");
    const { mockFetchPaged } = await import("./test-helpers.js");
    const adminOn = (ids: number[]) => (rows: ReadonlyArray<Record<string, unknown>>) => {
      const side = manyGroupsSideLoads(rows) as { memberships: Array<Record<string, unknown>> };
      for (const m of side.memberships) m["admin"] = ids.includes(m["group_id"] as number);
      return side;
    };
    const run = async (ids: number[]) => {
      stderrLines = [];
      const { resetHealthForTests } = await import("../src/loomio/health.js");
      resetHealthForTests();
      mockFetchPaged({
        "/b2/groups": {
          root: "groups",
          rows: manyGroups(60),
          sideLoads: adminOn(ids),
          mode: "bounded",
        },
        "/v1/boot/version": { status: 200, body: { version: "3.13.1" } },
      });
      const { checkConnection } = await import("../src/tools/groups.js");
      for (let n = 0; n < 3; n++) await checkConnection();
      return stderrEvents()
        .filter((e) => e["event"] === "loomio.admin_scope")
        .map((e) => e["admin_group_ids"]);
    };
    // Admin only on page 2: the probe sees none, the complete index one.
    // One shared dedupe key flipped [] ↔ [1060] on every call: 3 events.
    expect(await run([1060])).toEqual([[1060]]);
    // Admin on page 1 and page 2: each view reports its set once (2 lines
    // in all), never again — was [1001], [1001,1060] on every call: 6.
    expect(await run([1001, 1060])).toEqual([[1001], [1001, 1060]]);
  });

  it("no admin row: no note, no event", async () => {
    mockFetchRoutes({
      "/b2/groups": {
        status: 200,
        body: groupsIndexBody({
          memberships: [membershipRow(), membershipRow({ id: 9012, group_id: 12 })],
        }),
      },
      "/v1/boot/version": { status: 200, body: { version: "3.13.1" } },
    });
    const { checkConnection } = await import("../src/tools/groups.js");
    const r = await checkConnection();
    expect(r.notes.some((n) => /ADMIN/.test(n))).toBe(false);
    expect(stderrEvents().some((e) => e["event"] === "loomio.admin_scope")).toBe(false);
  });
});

// ── F-17 ────────────────────────────────────────────────────────────────────

describe("F-17: LOOMIO_MCP_GROUP_IDS allow-list", () => {
  beforeEach(() => {
    process.env["LOOMIO_MCP_GROUP_IDS"] = "7, 12";
  });

  it("startup refuses a malformed list; an unparseable value at run time fails CLOSED", async () => {
    const { groupAllowlistError, groupAllowlist } = await import("../src/loomio/group-scope.js");
    expect(groupAllowlistError({ LOOMIO_MCP_GROUP_IDS: "7,12" })).toBeUndefined();
    expect(groupAllowlistError({ LOOMIO_MCP_GROUP_IDS: "" })).toBeUndefined();
    expect(groupAllowlistError({ LOOMIO_MCP_GROUP_IDS: "7,abc" })).toMatch(/positive integer/);
    expect(groupAllowlistError({ LOOMIO_MCP_GROUP_IDS: "0" })).toMatch(/positive integer/);
    process.env["LOOMIO_MCP_GROUP_IDS"] = "7,-1";
    expect(groupAllowlist()?.size).toBe(0);
  });

  it("list_groups shows only listed groups, total included (v0.0.16 ignored every such variable)", async () => {
    mockFetch(200, groupsIndexBody());
    const { listGroups } = await import("../src/tools/groups.js");
    const r = await listGroups();
    expect(r.groups.map((g) => g.id).sort((a, b) => a - b)).toEqual([7, 12]);
    expect(r.total).toBe(2);
    expect(r.scope.note).toMatch(/LOOMIO_MCP_GROUP_IDS/);
    expect(JSON.stringify(r)).not.toContain(VOLUNTEERS.name!);
  });

  it("check_connection lists only listed groups but still names the API user", async () => {
    mockFetchRoutes({
      "/b2/groups": { status: 200, body: groupsIndexBody() },
      "/v1/boot/version": { status: 200, body: { version: "3.13.1" } },
    });
    const { checkConnection } = await import("../src/tools/groups.js");
    const r = await checkConnection();
    expect(r.groups.map((g) => g.id).sort((a, b) => a - b)).toEqual([7, 12]);
    expect(r.groups_total).toBe(2);
    expect(r.user?.id).toBe(501);
    expect(r.notes.some((n) => /LOOMIO_MCP_GROUP_IDS/.test(n))).toBe(true);
  });

  it("every tool naming an unlisted group refuses it BEFORE any upstream call", async () => {
    const { GroupScopeError } = await import("../src/loomio/group-scope.js");
    const calls: Array<() => Promise<unknown>> = [
      async () => (await import("../src/tools/groups.js")).getGroup({ id_or_key_or_handle: 15 }),
      async () => (await import("../src/tools/discussions.js")).listDiscussions({ group_id: 15 }),
      async () => (await import("../src/tools/polls.js")).listPolls({ group_id: 15 }),
      async () => (await import("../src/tools/memberships.js")).listMemberships({ group_id: 15 }),
      async () =>
        (await import("../src/tools/search.js")).searchContent({ query: "x", group_id: 15 }),
      async () => (await import("../src/tools/threads.js")).listThreads({ group_id: 15 }),
      async () =>
        (await import("../src/tools/reports.js")).getUserActivity({
          user_id: 503,
          group_ids: [7, 15],
        }),
      async () =>
        (await import("../src/tools/reports.js")).getParticipationReport({ group_ids: [15] }),
      async () =>
        (await import("../src/tools/discussions.js")).createDiscussion({
          title: "t",
          group_id: 15,
        }),
      async () =>
        (await import("../src/tools/polls.js")).createPoll({
          title: "t",
          poll_type: "question",
          group_id: 15,
        }),
      async () =>
        (await import("../src/tools/memberships.js")).manageMemberships({
          group_id: 15,
          emails: ["a@example.org"],
        }),
    ];
    for (const run of calls) {
      const err = await run().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GroupScopeError);
      expect((err as Error).message).toMatch(/15 is outside this connector's group allow-list/);
    }
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("record reads check the record's group: unlisted refused, a direct thread (no group) refused", async () => {
    const { GroupScopeError } = await import("../src/loomio/group-scope.js");
    const { getDiscussion } = await import("../src/tools/discussions.js");
    const { getPoll } = await import("../src/tools/polls.js");
    mockFetch(200, discussionShowBody({ discussions: [discussionRow({ group_id: 15 })] }));
    await expect(getDiscussion({ id_or_key: 601 })).rejects.toBeInstanceOf(GroupScopeError);
    mockFetch(200, discussionShowBody({ discussions: [discussionRow({ group_id: null })] }));
    await expect(getDiscussion({ id_or_key: 601 })).rejects.toThrow(/belongs to no group/);
    mockFetch(200, pollShowBody({ polls: [pollRow({ group_id: 15 })] }));
    await expect(getPoll({ id_or_key: 301 })).rejects.toBeInstanceOf(GroupScopeError);
    // A listed group passes.
    mockFetch(200, discussionShowBody());
    await expect(getDiscussion({ id_or_key: 601 })).resolves.toBeDefined();
  });

  it("get_group by key/handle is judged on the record it reads", async () => {
    mockFetch(200, groupShowBody(VOLUNTEERS));
    const { getGroup } = await import("../src/tools/groups.js");
    await expect(getGroup({ id_or_key_or_handle: "example-org-volunteers" })).rejects.toThrow(
      /Group example-org-volunteers is outside/,
    );
  });

  it("thread tools learn the group BEFORE reading content: a bare topic_id costs one thread-row GET, then refusal", async () => {
    mockFetchRoutes({
      "/b2/threads/701": {
        status: 200,
        body: threadShowBody({ threads: [topicRow({ group_id: 15 })] }),
      },
    });
    const { listThreadItems, getThreadMarkdown } = await import("../src/tools/threads.js");
    await expect(listThreadItems({ topic_id: 701 })).rejects.toThrow(
      /outside this connector's group allow-list/,
    );
    await expect(getThreadMarkdown({ topic_id: 701 })).rejects.toThrow(/allow-list/);
    expect(fetchCallsTo("/items")).toHaveLength(0);
    expect(fetchCallsTo("/markdown")).toHaveLength(0);
  });

  it("list_threads under an allow-list counts nothing it withheld: no meta.total, no page size, no limit-1 position oracle", async () => {
    // Round 2: total was Loomio's unfiltered meta.total and page_size the
    // unfiltered page length, and a limit=1 walk answered returned=0 at
    // each withheld thread's position. Rows: listed 101, unlisted 999,
    // a direct thread (no group), unlisted 998, listed 101.
    const at = (h: number) => `2026-08-15T${String(h).padStart(2, "0")}:00:00.000Z`;
    const rows = [
      topicRow({ id: 1, group_id: 101, topicable_id: 11, last_activity_at: at(20) }),
      topicRow({ id: 2, group_id: 999, topicable_id: 12, last_activity_at: at(19) }),
      topicRow({ id: 3, group_id: null, topicable_id: 13, last_activity_at: at(18) }),
      topicRow({ id: 4, group_id: 998, topicable_id: 14, last_activity_at: at(17) }),
      topicRow({ id: 5, group_id: 101, topicable_id: 15, last_activity_at: at(16) }),
    ];
    const calls = mockFetchPaged({
      "/b2/threads": { root: "threads", rows, mode: "bounded" },
    });
    process.env["LOOMIO_MCP_GROUP_IDS"] = "101";
    const { listThreads } = await import("../src/tools/threads.js");

    const all = await listThreads({});
    expect(all.threads.map((t) => t.topic_id)).toEqual([1, 5]);
    expect(all.total).toBe(2); // v0.0.17 round 1: 5 (Loomio's meta.total)
    expect(all.scope.page_size).toBeNull(); // round 1: 5
    expect(all.scope.next_offset).toBeNull();

    // The limit=1 walk: every offset is in MATCHING rows, so withheld
    // threads leave no gap — returned is 1, 1, then 0 at the true end.
    const walk = [];
    for (const offset of [0, 1, 2]) {
      const r = await listThreads({ limit: 1, offset });
      walk.push({
        ids: r.threads.map((t) => t.topic_id),
        total: r.total,
        next: r.scope.next_offset,
      });
      expect(r.scope.page_size).toBeNull();
      expect(JSON.stringify(r)).not.toMatch(/"(total|page_size|returned)":[345]\b/);
    }
    expect(walk).toEqual([
      { ids: [1], total: null, next: 1 },
      { ids: [5], total: 2, next: null },
      { ids: [], total: 2, next: null },
    ]);
    // Upstream is read from the top in walk pages, never at the caller's offset.
    expect(calls.every((c) => c.offset === "0" && c.limit === "100")).toBe(true);

    // `since` dates only listed rows: the withheld rows' times bound nothing.
    const recent = await listThreads({ since: at(17) });
    expect(recent.threads.map((t) => t.topic_id)).toEqual([1]);
    expect(recent.scope.exhausted).toBe(true);
    expect(recent.total).toBe(1);
  });

  it("list_threads without an allow-list keeps Loomio's total and page size and adds next_offset", async () => {
    const rows = Array.from({ length: 5 }, (_, n) =>
      topicRow({ id: n + 1, group_id: 7, topicable_id: 600 + n }),
    );
    mockFetchPaged({ "/b2/threads": { root: "threads", rows, mode: "bounded" } });
    delete process.env["LOOMIO_MCP_GROUP_IDS"];
    const { listThreads } = await import("../src/tools/threads.js");
    const first = await listThreads({ limit: 2 });
    expect([first.total, first.scope.page_size, first.scope.next_offset]).toEqual([5, 2, 2]);
    const last = await listThreads({ limit: 2, offset: 4 });
    expect([last.returned, last.scope.page_size, last.scope.next_offset]).toEqual([1, 1, null]);
  });

  it("list_threads under an allow-list reports scan_capped instead of guessing past its page limit", async () => {
    const { THREADS_WALK_MAX_PAGES, THREADS_WALK_PAGE, listThreads } = await import(
      "../src/tools/threads.js"
    );
    const rows = Array.from({ length: THREADS_WALK_MAX_PAGES * THREADS_WALK_PAGE + 1 }, (_, n) =>
      topicRow({ id: n + 1, group_id: 999, topicable_id: 10_000 + n }),
    );
    const calls = mockFetchPaged({ "/b2/threads": { root: "threads", rows, mode: "bounded" } });
    process.env["LOOMIO_MCP_GROUP_IDS"] = "101";
    const r = await listThreads({});
    expect(r.returned).toBe(0);
    expect(r.total).toBeNull();
    expect(r.scope.scan_capped).toBe(true);
    expect(r.scope.next_offset).toBeNull();
    expect(calls).toHaveLength(THREADS_WALK_MAX_PAGES);
  });

  it("list_threads and search_content filter the page silently — no count of what was removed", async () => {
    const body = threadsIndexBody();
    const groupsOnPage = new Set((body.threads ?? []).map((t) => t.group_id));
    mockFetch(200, body);
    const { listThreads } = await import("../src/tools/threads.js");
    process.env["LOOMIO_MCP_GROUP_IDS"] = "7";
    const t = await listThreads({});
    for (const row of t.threads) expect(row.group_id).toBe(7);
    expect(groupsOnPage.size).toBeGreaterThan(1);
    expect(t.scope.note).toMatch(/LOOMIO_MCP_GROUP_IDS/);

    mockFetch(
      200,
      searchBody({
        search_results: [
          ...SEARCH_ROWS,
          searchResultRow({
            id: 999,
            searchable_id: 9999,
            group_id: 15,
            searchable_type: "Discussion",
          }),
        ],
      }),
    );
    const { searchContent } = await import("../src/tools/search.js");
    const s = await searchContent({ query: "budget" });
    for (const hit of s.results) expect(hit.group?.id).toBe(7);
    expect(s.returned).toBe(s.results.length);
    expect(s.scope.note).toMatch(/only its listed groups/);
    expect(JSON.stringify(s)).not.toMatch(/dropped|filtered_out/);
  });

  it("get_participation_report with group_scope 'my' is sent as custom over the allow-list", async () => {
    mockFetch(200, reportsUsersBody({ group_ids: [7, 12] }));
    const { getParticipationReport } = await import("../src/tools/reports.js");
    await getParticipationReport({ group_scope: "my" });
    const url = new URL(String(vi.mocked(fetch).mock.calls[0]![0]));
    expect(url.searchParams.get("group_scope")).toBe("custom");
    expect(url.searchParams.get("group_ids")).toBe("7,12");
  });

  it("writes addressed by record are checked BEFORE anything is written; comment writes that cannot be placed fail closed", async () => {
    const { GroupScopeError } = await import("../src/loomio/group-scope.js");
    const { updateDiscussion, deleteDiscussion } = await import("../src/tools/discussions.js");
    const { deletePoll, updatePoll } = await import("../src/tools/polls.js");
    const { createComment, updateComment, deleteComment } = await import(
      "../src/tools/comments.js"
    );
    const writes = () =>
      vi.mocked(fetch).mock.calls.filter(([, init]) => (init?.method ?? "GET") !== "GET");

    mockFetch(200, discussionShowBody({ discussions: [discussionRow({ group_id: 15 })] }));
    await expect(updateDiscussion({ id_or_key: 601, title: "x" })).rejects.toBeInstanceOf(
      GroupScopeError,
    );
    mockFetch(200, discussionShowBody({ discussions: [discussionRow({ group_id: 15 })] }));
    await expect(deleteDiscussion({ id_or_key: 601 })).rejects.toBeInstanceOf(GroupScopeError);
    mockFetch(200, pollShowBody({ polls: [pollRow({ group_id: 15 })] }));
    await expect(updatePoll({ id_or_key: 301, title: "x" })).rejects.toBeInstanceOf(
      GroupScopeError,
    );
    mockFetch(200, pollShowBody({ polls: [pollRow({ group_id: 15 })] }));
    await expect(deletePoll({ id_or_key: 301 })).rejects.toBeInstanceOf(GroupScopeError);
    mockFetch(200, discussionShowBody({ discussions: [discussionRow({ group_id: 15 })] }));
    await expect(createComment({ discussion_id: 601, body: "b" })).rejects.toBeInstanceOf(
      GroupScopeError,
    );
    await expect(
      createComment({ parent_id: 1701, parent_type: "Comment", body: "b" }),
    ).rejects.toThrow(/cannot be checked against this connector's group allow-list/);
    await expect(updateComment({ id: 1701, body: "b" })).rejects.toBeInstanceOf(GroupScopeError);
    await expect(deleteComment({ id: 1701 })).rejects.toBeInstanceOf(GroupScopeError);
    expect(writes()).toHaveLength(0);
  });

  it("create_comment on a LISTED discussion by key reads it once (the check doubles as the key lookup), then posts", async () => {
    mockFetch(200, discussionShowBody());
    mockFetch(200, { comments: [commentRow()], users: [] });
    const { createComment } = await import("../src/tools/comments.js");
    await createComment({ discussion_id: "dscKEY01", body: "b" });
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![1]?.method).toBe("POST");
    expect(JSON.parse(String(calls[1]![1]?.body))).toMatchObject({ discussion_id: 601 });
  });

  it("b3 tools are unaffected (an operator's own instance-wide tools)", async () => {
    process.env["LOOMIO_B3_API_KEY"] = "long-enough-admin-secret-12345";
    mockFetch(200, { groups: [groupRow({ id: 99 })], meta: { total: 1 } });
    const { listInstanceGroups } = await import("../src/tools/server-admin.js");
    const r = (await listInstanceGroups({})) as { groups: Array<{ id: number }> };
    expect(r.groups.map((g) => g.id)).toEqual([99]);
  });

  it("in open-DCR mode the record refusal reads exactly like 'absent or hidden' (nit 19)", async () => {
    const { setOpenDcrMode } = await import("../src/deployment.js");
    setOpenDcrMode(true);
    mockFetch(200, discussionShowBody({ discussions: [discussionRow({ group_id: 15 })] }));
    const { getDiscussion } = await import("../src/tools/discussions.js");
    const { notVisibleMessage } = await import("../src/loomio/group-scope.js");
    await expect(getDiscussion({ id_or_key: 601 })).rejects.toThrow(
      notVisibleMessage("discussion", 601),
    );
  });
});

describe("F-17: each groups_changed trigger fires on its own (round 1)", () => {
  // The scenario test below changes several things at once, which left
  // every single trigger deletable with the suite green. One transition
  // per trigger here: exactly one forced event, only that field set.
  const AT = "2026-10-25T00:00:00Z";
  const base = () =>
    groupsIndexBody({
      groups: [FINANCE, EXAMPLE_ORG],
      memberships: [
        membershipRow({ id: 1, group_id: 7 }),
        membershipRow({ id: 2, group_id: 12, admin: true }),
      ],
      meta: { root: "groups", total: 2 },
    });
  const EMPTY = {
    added: [],
    removed: [],
    admin_gained: [],
    admin_lost: [],
    privacy_changed: [],
  };

  async function transition(after: ReturnType<typeof groupsIndexBody>) {
    const { observeGroupsIndex, resetGroupWatchForTests } = await import(
      "../src/loomio/group-watch.js"
    );
    resetGroupWatchForTests();
    observeGroupsIndex(base(), AT);
    stderrLines = [];
    observeGroupsIndex(after, AT);
    return stderrEvents().filter((e) => e["event"] === "loomio.groups_changed");
  }

  it.each([
    [
      "group_privacy only",
      () => ({ ...base(), groups: [{ ...FINANCE, group_privacy: "secret" }, EXAMPLE_ORG] }),
      { privacy_changed: [12] },
    ],
    [
      "is_visible_to_public only",
      () => ({
        ...base(),
        groups: [{ ...FINANCE, is_visible_to_public: !FINANCE.is_visible_to_public }, EXAMPLE_ORG],
      }),
      { privacy_changed: [12] },
    ],
    [
      "a group removed (total kept)",
      () => ({ ...base(), groups: [EXAMPLE_ORG] }),
      { removed: [12] },
    ],
    [
      "a group added (total kept)",
      () => ({ ...base(), groups: [FINANCE, EXAMPLE_ORG, BOARD] }),
      { added: [16] },
    ],
    [
      "admin gained",
      () => ({
        ...base(),
        memberships: [
          membershipRow({ id: 1, group_id: 7, admin: true }),
          membershipRow({ id: 2, group_id: 12, admin: true }),
        ],
      }),
      { admin_gained: [7] },
    ],
    [
      "admin lost",
      () => ({
        ...base(),
        memberships: [
          membershipRow({ id: 1, group_id: 7 }),
          membershipRow({ id: 2, group_id: 12 }),
        ],
      }),
      { admin_lost: [12] },
    ],
    [
      "total only",
      () => ({ ...base(), meta: { root: "groups", total: 3 } }),
      { total_before: 2, total_after: 3 },
    ],
  ] as const)("%s", async (_name, after, only) => {
    const events = await transition(after() as ReturnType<typeof groupsIndexBody>);
    expect(events).toHaveLength(1);
    const { event: _e, ts: _t, level: _l, ...fields } = events[0] as Record<string, unknown>;
    const total = "total_after" in only ? {} : { total_before: 2, total_after: 2 };
    expect(fields).toMatchObject({ ...EMPTY, ...total, ...only });
  });

  it("an identical probe emits nothing", async () => {
    expect(await transition(base())).toHaveLength(0);
  });
});

describe("F-17: forced loomio.groups_changed when the probe sees exposure change", () => {
  it("fires on a new group, a lost/gained admin flag or a privacy change; check_connection notes it without ids", async () => {
    const { checkLoomioHealth } = await import("../src/loomio/health.js");
    const routes = (body: ReturnType<typeof groupsIndexBody>) =>
      mockFetchRoutes({
        "/b2/groups": { status: 200, body },
        "/v1/boot/version": { status: 200, body: { version: "3.13.1" } },
      });
    routes(groupsIndexBody());
    await checkLoomioHealth({ force: true });
    expect(stderrEvents().some((e) => e["event"] === "loomio.groups_changed")).toBe(false);

    // A coordinator adds the bot to the Board and makes Finance public-only.
    routes(
      groupsIndexBody({
        groups: [{ ...FINANCE, group_privacy: "secret" }, EXAMPLE_ORG, VOLUNTEERS, BOARD],
        meta: { root: "groups", total: 4 },
      }),
    );
    await checkLoomioHealth({ force: true });
    const changed = stderrEvents().filter((e) => e["event"] === "loomio.groups_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ added: [16], privacy_changed: [12], total_after: 4 });

    const { checkConnection } = await import("../src/tools/groups.js");
    const r = await checkConnection();
    const note = r.notes.find((n) => /groups change/.test(n));
    expect(note).toBeDefined();
    expect(note).not.toMatch(/\b16\b/);
  });
});

// ── nit 9 ───────────────────────────────────────────────────────────────────

describe("nit 9: b3 identity route segments", () => {
  it("refuses '.', '..', '/', '?', '%' and non-ASCII uids before any request; encodes the rest", async () => {
    process.env["LOOMIO_B3_API_KEY"] = "long-enough-admin-secret-12345";
    const { getUserSchema, getUser } = await import("../src/tools/admin.js");
    for (const uid of ["..", "a.b", "a/b", "x?y", "%2e%2e", "é", "x".repeat(129)]) {
      expect(getUserSchema.safeParse({ identity_type: "saml", uid }).success, uid).toBe(false);
    }
    expect(getUserSchema.safeParse({ identity_type: "../x", uid: "abc" }).success).toBe(false);
    mockFetch(200, { user: { id: 503 } });
    await getUser(getUserSchema.parse({ identity_type: "saml", uid: "user@example" }));
    expect(new URL(String(vi.mocked(fetch).mock.calls[0]![0])).pathname).toBe(
      "/api/b3/users/identity/saml/user%40example",
    );
  });
});

// ── nit 10 ──────────────────────────────────────────────────────────────────

describe("nit 10: Retry-After is echoed only when well-formed", () => {
  it("delta-seconds and an HTTP-date pass; a 6 KB header is omitted (v0.0.16 echoed it whole)", async () => {
    const { listDiscussions } = await import("../src/tools/discussions.js");
    mockFetch(429, "Retry later", { "retry-after": "120" });
    await expect(listDiscussions({ group_id: 7 })).rejects.toThrow(/Retry after 120 seconds/);
    mockFetch(429, "Retry later", { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" });
    await expect(listDiscussions({ group_id: 7 })).rejects.toThrow(
      /Retry after Wed, 21 Oct 2026 07:28:00 GMT \(/,
    );
    mockFetch(429, "Retry later", { "retry-after": "A".repeat(6000) });
    const err = (await listDiscussions({ group_id: 7 }).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/No usable Retry-After header/);
    expect(err.message.length).toBeLessThan(1000);
    mockFetch(429, "Retry later", { "retry-after": "1234567" });
    await expect(listDiscussions({ group_id: 7 })).rejects.toThrow(/No usable Retry-After/);
  });
});

// ── nit 11 ──────────────────────────────────────────────────────────────────

describe("nit 11: absolute size ceilings", () => {
  it("a tool reply over 4 MB is an error, not a 4 MB+ message", async () => {
    const huge = groupsIndexBody({
      groups: Array.from({ length: 3 }, (_, i) =>
        groupRow({ id: 100 + i, name: "x".repeat(2 * 1024 * 1024) }),
      ),
      memberships: [],
      parent_groups: [],
      meta: { root: "groups", total: 3 },
    });
    mockFetch(200, huge);
    const r = await withClient((call) => call("list_groups", {}));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/over the connector's 4 MB ceiling on one tool reply/);
    expect(r.text.length).toBeLessThan(2000);
  });

  it("an upstream body declared over 64 MB is refused unread", async () => {
    let read = false;
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: new Headers({ "content-length": String(65 * 1024 * 1024) }),
      text: async () => {
        read = true;
        return "{}";
      },
    } as Awaited<ReturnType<typeof fetch>>);
    const { listGroups } = await import("../src/tools/groups.js");
    await expect(listGroups()).rejects.toThrow(/exceeded the connector's 64 MB ceiling/);
    expect(read).toBe(false);
  });

  it("a streamed upstream body is cut as soon as it passes 64 MB", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    let pulled = 0;
    let cancelled = false;
    const body = {
      getReader: () => ({
        read: async () => {
          pulled += 1;
          return { done: false, value: chunk };
        },
        cancel: async () => {
          cancelled = true;
        },
        releaseLock: () => {},
      }),
    };
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: new Headers(),
      body,
      text: async () => "{}",
    } as unknown as Awaited<ReturnType<typeof fetch>>);
    const { listGroups } = await import("../src/tools/groups.js");
    await expect(listGroups()).rejects.toThrow(/64 MB ceiling/);
    expect(pulled).toBe(65);
    expect(cancelled).toBe(true);
  });
});

// ── nit 12 ──────────────────────────────────────────────────────────────────

describe("nit 12: show shapes are allow-lists — a new upstream field does not pass through", () => {
  const NEW = { info: "a field Loomio added later", secret_flag: true };

  it("get_group: the fixture's fields minus the documented drops, and nothing new", async () => {
    const group = { ...FINANCE, ...NEW };
    mockFetch(200, groupShowBody(group as typeof FINANCE));
    const { getGroup, GROUP_SHOW_FIELDS } = await import("../src/tools/groups.js");
    const r = await getGroup({ id_or_key_or_handle: 12 });
    const keys = Object.keys(r.group).sort();
    const dropped = [
      "attachments",
      "link_previews",
      "cover_url",
      "logo_url",
      "has_custom_cover_photo",
      "tag_ids",
      "subscription",
      "new_host",
      "discarded_by",
    ];
    const expected = Object.keys(FINANCE)
      .filter((k) => !dropped.includes(k))
      .sort();
    // Exactly v0.0.16's output for a real record…
    expect(keys).toEqual(expected);
    // …and the list is the source of truth for anything else.
    for (const k of keys) expect(GROUP_SHOW_FIELDS as readonly string[]).toContain(k);
    expect(r.group).not.toHaveProperty("info");
    expect(r.group).not.toHaveProperty("secret_flag");
  });

  it("get_discussion and get_poll drop an unknown field and keep every documented one", async () => {
    mockFetch(200, discussionShowBody({ discussions: [{ ...discussionRow(), ...NEW }] }));
    const { getDiscussion } = await import("../src/tools/discussions.js");
    const d = await getDiscussion({ id_or_key: 601 });
    expect(d.discussion).not.toHaveProperty("info");
    expect(d.discussion).toMatchObject({ id: 601, key: "dscKEY01", group_id: 7 });
    expect(d.discussion).toHaveProperty("items_count");

    mockFetch(200, pollShowBody({ polls: [{ ...pollRow(), ...NEW }] }));
    const { getPoll } = await import("../src/tools/polls.js");
    const p = await getPoll({ id_or_key: 301 });
    expect(p.poll).not.toHaveProperty("info");
    expect(p.poll).not.toHaveProperty("secret_flag");
    expect(p.poll).toMatchObject({ id: 301, results_visible: expect.any(Boolean) });
  });

  // Round 1: the two tests above let 32 of POLL_FIELDS' entries (and four
  // of DISCUSSION_FIELDS') be deleted with every test green. These pin the
  // EXACT key set of each shape for a record carrying every documented
  // field (the fixture plus the 3.13.1 attributes Loomio sends only
  // sometimes, the ≤ 3.10 topic counters and the 3.8 / 3.9 voting_system),
  // so dropping an allow-list entry — or letting a new one through — fails.
  const FULL_TOPIC_EXTRAS = {
    members_count: 5,
    closed_polls_count: 1,
    has_tagged_replies: true,
    locked_at: "2026-01-01T00:00:00Z",
  };
  const fullPoll = () =>
    pollRow({
      anonymous_voter_eligible: true,
      anonymous_ballot_submitted: false,
      voting_system: "simple",
      my_stance_id: 1,
      stv_results: [],
      reaction_ids: [4],
      quorum_pct: 50,
      weighted_voting: true,
      agree_target: 3,
      opening_at: "2026-09-01T12:00:00Z",
      meeting_duration: 30,
      stv_seats: 1,
      stv_method: "scottish",
      stv_quota: "droop",
      poll_template_id: 9,
      poll_template_key: "tpl",
      reason_prompt: "why",
      discarded_by: 2,
      ...NEW,
    } as Parameters<typeof pollRow>[0]);

  it("get_poll / list_polls: the exact key set of a poll carrying every documented field", async () => {
    const { POLL_TOPIC } = await import("./fixtures.js");
    const topics = [{ ...POLL_TOPIC, ...FULL_TOPIC_EXTRAS }];
    mockFetch(200, pollShowBody({ polls: [fullPoll()], topics }));
    const { getPoll, listPolls, POLL_FIELDS } = await import("../src/tools/polls.js");
    const show = (await getPoll({ id_or_key: 301 })).poll;
    expect(Object.keys(show).sort()).toEqual([
      "active_polls_count",
      "agree_target",
      "anonymous",
      "anonymous_ballot_submitted",
      "anonymous_voter_eligible",
      "attachments_count",
      "author_id",
      "can_respond_maybe",
      "cast_stances_pct",
      "closed_at",
      "closed_polls_count",
      "closing_at",
      "created_at",
      "current_outcome",
      "current_outcome_id",
      "decided_voters_count",
      "details",
      "details_format",
      "discarded_at",
      "discarded_by",
      "dots_per_person",
      "group_id",
      "has_tagged_replies",
      "hide_results",
      "id",
      "items_count",
      "key",
      "last_activity_at",
      "locked_at",
      "max_score",
      "maximum_stance_choices",
      "meeting_duration",
      "members_count",
      "min_score",
      "minimum_stance_choices",
      "my_stance",
      "my_stance_id",
      "notify_on_closing_soon",
      "notify_on_open",
      "opened_at",
      "opening_at",
      "pinned_at",
      "poll_option_ids",
      "poll_option_names",
      "poll_options",
      "poll_template_id",
      "poll_template_key",
      "poll_type",
      "quorum_count",
      "quorum_pct",
      "quorum_reached",
      "quorum_votes_required",
      "reaction_ids",
      "reason_prompt",
      "replies_count",
      "result_heading_keys",
      "results",
      "results_visible",
      "seen_by_count",
      "show_none_of_the_above",
      "shuffle_options",
      "specified_voters_only",
      "stance_counts",
      "stance_reason_required",
      "stv_method",
      "stv_quota",
      "stv_results",
      "stv_seats",
      "tags",
      "title",
      "topic_id",
      "total_score",
      "undecided_voters_count",
      "url",
      "versions_count",
      "voters_count",
      "voting_system",
      "weighted_voting",
    ]);
    mockFetch(200, pollsListBody({ polls: [fullPoll()], topics }));
    const row = (await listPolls({ group_id: 7 })).polls[0] as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual([
      "active_polls_count",
      "agree_target",
      "anonymous",
      "anonymous_ballot_submitted",
      "anonymous_voter_eligible",
      "attachments_count",
      "author_id",
      "can_respond_maybe",
      "cast_stances_pct",
      "closed_at",
      "closed_polls_count",
      "closing_at",
      "created_at",
      "current_outcome",
      "current_outcome_id",
      "decided_voters_count",
      "details",
      "details_format",
      "discarded_at",
      "discarded_by",
      "dots_per_person",
      "group_id",
      "has_tagged_replies",
      "hide_results",
      "id",
      "items_count",
      "key",
      "last_activity_at",
      "locked_at",
      "max_score",
      "maximum_stance_choices",
      "meeting_duration",
      "members_count",
      "min_score",
      "minimum_stance_choices",
      "my_stance",
      "my_stance_id",
      "notify_on_closing_soon",
      "notify_on_open",
      "opened_at",
      "opening_at",
      "pinned_at",
      "poll_option_ids",
      "poll_options",
      "poll_template_id",
      "poll_template_key",
      "poll_type",
      "quorum_count",
      "quorum_pct",
      "quorum_reached",
      "quorum_votes_required",
      "reaction_ids",
      "reason_prompt",
      "replies_count",
      "result_heading_keys",
      "results_visible",
      "seen_by_count",
      "show_none_of_the_above",
      "shuffle_options",
      "specified_voters_only",
      "stance_counts",
      "stance_reason_required",
      "stv_method",
      "stv_quota",
      "stv_seats",
      "tags",
      "title",
      "topic_id",
      "total_score",
      "undecided_voters_count",
      "url",
      "versions_count",
      "voters_count",
      "voting_system",
      "weighted_voting",
    ]);
    // Every relayed record field is on the allow-list (the rest are derived).
    const derived = ["attachments_count", "current_outcome", "my_stance", "poll_options", "url"];
    for (const k of Object.keys(show)) {
      if (!derived.includes(k)) expect(POLL_FIELDS as readonly string[], k).toContain(k);
    }
    // The gate's reason appears when results are hidden.
    mockFetch(
      200,
      pollShowBody({ polls: [pollRow({ hide_results: "until_closed", closed_at: null })] }),
    );
    expect((await getPoll({ id_or_key: 301 })).poll).toHaveProperty("results_hidden_reason");
  });

  it("get_discussion / list_discussions: the exact key set of a discussion carrying every documented field", async () => {
    const topics = [{ ...topicRow(), ...FULL_TOPIC_EXTRAS }];
    const full = {
      ...discussionRow({ reaction_ids: [1] } as Parameters<typeof discussionRow>[0]),
      ...NEW,
    };
    mockFetch(200, discussionShowBody({ discussions: [full], topics }));
    const { getDiscussion, listDiscussions, DISCUSSION_FIELDS } = await import(
      "../src/tools/discussions.js"
    );
    const show = (await getDiscussion({ id_or_key: 601 })).discussion;
    expect(Object.keys(show).sort()).toEqual([
      "active_polls_count",
      "attachments_count",
      "author_id",
      "closed_polls_count",
      "created_at",
      "description",
      "description_format",
      "discarded_at",
      "discussion_template_id",
      "group_id",
      "has_tagged_replies",
      "id",
      "items_count",
      "key",
      "last_activity_at",
      "locked_at",
      "members_count",
      "pinned_at",
      "reaction_ids",
      "replies_count",
      "seen_by_count",
      "tags",
      "title",
      "topic_id",
      "updated_at",
      "url",
      "versions_count",
    ]);
    mockFetch(200, discussionsListBody({ discussions: [full], topics }));
    const row = (await listDiscussions({ group_id: 7 })).discussions[0] as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual([
      "active_polls_count",
      "attachments_count",
      "author_id",
      "closed_polls_count",
      "created_at",
      "description",
      "description_chars",
      "description_format",
      "description_truncated",
      "discarded_at",
      "discussion_template_id",
      "group_id",
      "has_tagged_replies",
      "id",
      "items_count",
      "key",
      "last_activity_at",
      "locked_at",
      "members_count",
      "pinned_at",
      "reaction_ids",
      "replies_count",
      "seen_by_count",
      "tags",
      "title",
      "topic_id",
      "updated_at",
      "url",
      "versions_count",
    ]);
    const derived = ["attachments_count", "url", "description_chars", "description_truncated"];
    for (const k of Object.keys(row)) {
      if (!derived.includes(k)) expect(DISCUSSION_FIELDS as readonly string[], k).toContain(k);
    }
  });

  it("get_group keeps the Loomio ≤ 3.10 counters HOWTO.md promises (round 1)", async () => {
    const legacy = {
      ...FINANCE,
      closed_polls_count: 4,
      delegates_count: 0,
      discussion_templates_count: 2,
      org_discussions_count: 9,
    };
    mockFetch(200, groupShowBody(legacy as typeof FINANCE));
    const { getGroup } = await import("../src/tools/groups.js");
    const r = await getGroup({ id_or_key_or_handle: 12 });
    expect(r.group).toMatchObject({
      closed_polls_count: 4,
      delegates_count: 0,
      discussion_templates_count: 2,
      org_discussions_count: 9,
    });
  });
});

// ── nit 16 ──────────────────────────────────────────────────────────────────

describe("nit 16: length caps on free text", () => {
  it("refuses oversized keys, queries, tags, kinds and bodies at the schema (v0.0.16 sent them upstream)", async () => {
    const { getDiscussionSchema, createDiscussionSchema } = await import(
      "../src/tools/discussions.js"
    );
    const { searchContentSchema } = await import("../src/tools/search.js");
    const { listThreadItemsSchema, listThreadsSchema } = await import("../src/tools/threads.js");
    const { createCommentSchema } = await import("../src/tools/comments.js");
    const { manageMembershipsSchema } = await import("../src/tools/memberships.js");
    const ok = (s: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
      s.safeParse(v).success;
    expect(ok(getDiscussionSchema, { id_or_key: "k".repeat(128) })).toBe(true);
    expect(ok(getDiscussionSchema, { id_or_key: "k".repeat(129) })).toBe(false);
    expect(ok(searchContentSchema, { query: "q".repeat(512) })).toBe(true);
    expect(ok(searchContentSchema, { query: "q".repeat(513) })).toBe(false);
    expect(ok(searchContentSchema, { query: "q", tag: "t".repeat(129) })).toBe(false);
    expect(ok(listThreadItemsSchema, { topic_id: 1, kinds: ["k".repeat(65)] })).toBe(false);
    expect(
      ok(listThreadItemsSchema, {
        topic_id: 1,
        kinds: Array.from({ length: 33 }, (_, i) => `k${i}`),
      }),
    ).toBe(false);
    expect(ok(listThreadsSchema, { since: `2026-01-01${" ".repeat(60)}` })).toBe(false);
    expect(ok(createDiscussionSchema, { title: "t".repeat(501), group_id: 7 })).toBe(false);
    expect(
      ok(createDiscussionSchema, { title: "t", group_id: 7, description: "d".repeat(100_001) }),
    ).toBe(false);
    expect(ok(createDiscussionSchema, { title: "t", group_id: 7, tags: ["x".repeat(129)] })).toBe(
      false,
    );
    expect(ok(createCommentSchema, { discussion_id: 1, body: "b".repeat(100_001) })).toBe(false);
    expect(
      ok(manageMembershipsSchema, { group_id: 7, emails: [`${"a".repeat(250)}@example.org`] }),
    ).toBe(false);
  });
});

// ── nit 19 ──────────────────────────────────────────────────────────────────

describe("nit 19: hidden vs not-found", () => {
  const HIDDEN = { error: "Not authorized to show Group." };

  it("open-DCR: a hidden group (403) and an unknown one (404) read identically", async () => {
    const { setOpenDcrMode } = await import("../src/deployment.js");
    setOpenDcrMode(true);
    const { getGroup } = await import("../src/tools/groups.js");
    mockFetch(403, HIDDEN);
    const hidden = (await getGroup({ id_or_key_or_handle: "a" }).catch((e: unknown) => e)) as Error;
    mockFetch(404, { error: "not found" });
    const missing = (await getGroup({ id_or_key_or_handle: "a" }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(hidden.message).toBe(missing.message);
    expect(hidden.message).toMatch(/does not exist, or it is not served here/);

    const { getDiscussion } = await import("../src/tools/discussions.js");
    mockFetch(403, { error: "Not authorized to show Discussion." });
    const dh = (await getDiscussion({ id_or_key: "k" }).catch((e: unknown) => e)) as Error;
    mockFetch(404, { error: "not found" });
    const dm = (await getDiscussion({ id_or_key: "k" }).catch((e: unknown) => e)) as Error;
    expect(dh.message).toBe(dm.message);

    const { listThreadItems } = await import("../src/tools/threads.js");
    mockFetch(403, { error: "Not authorized to show Poll." });
    const ph = (await listThreadItems({ poll_id: "k" }).catch((e: unknown) => e)) as Error;
    mockFetch(404, { error: "not found" });
    const pm = (await listThreadItems({ poll_id: "k" }).catch((e: unknown) => e)) as Error;
    expect(ph.message).toBe(pm.message);
  });

  it("open-DCR + allow-list: thread tools answer an unknown, an unlisted and a direct record byte-identically, per ref kind, never naming a topic_id the caller did not pass (round 1)", async () => {
    const { setOpenDcrMode } = await import("../src/deployment.js");
    setOpenDcrMode(true);
    process.env["LOOMIO_MCP_GROUP_IDS"] = "7";
    const { POLL_TOPIC } = await import("./fixtures.js");
    const thread = (id: number, group_id: number | null) =>
      threadShowBody({ threads: [topicRow({ id, group_id, topicable_id: id - 100 })] });
    const discussion = (id: number, topic_id: number, group_id: number | null) =>
      discussionShowBody({
        discussions: [discussionRow({ id, topic_id, group_id })],
        topics: [topicRow({ id: topic_id, group_id, topicable_id: id })],
      });
    const poll = (id: number, topic_id: number, group_id: number | null) =>
      pollShowBody({
        polls: [pollRow({ id, topic_id, group_id })],
        topics: [{ ...POLL_TOPIC, id: topic_id, group_id, topicable_id: id }],
      });
    const missing = { status: 404, body: { error: "not found" } };
    mockFetchRoutes({
      "/b2/threads/999": missing,
      "/b2/threads/702": { status: 200, body: thread(702, 15) },
      "/b2/threads/703": { status: 200, body: thread(703, null) },
      "/b2/discussions/999": missing,
      "/b2/discussions/602": { status: 200, body: discussion(602, 702, 15) },
      "/b2/discussions/603": { status: 200, body: discussion(603, 703, null) },
      "/b2/polls/999": missing,
      "/b2/polls/302": { status: 200, body: poll(302, 712, 15) },
      "/b2/polls/303": { status: 200, body: poll(303, 713, null) },
    });
    const { listThreadItems, getThreadMarkdown } = await import("../src/tools/threads.js");
    const text = async (p: Promise<unknown>) =>
      (
        (await p.then(
          () => new Error("resolved"),
          (e: unknown) => e,
        )) as Error
      ).message;
    // v0.0.17's first cut: topic 999 → "thread not found…", 702 / 703 →
    // "No thread …"; discussion 602 → "No thread \"702\"" (a disclosed
    // topic_id) against "No discussion \"999\"" for a missing one.
    for (const tool of [listThreadItems, getThreadMarkdown] as const) {
      for (const [kind, ids] of [
        ["topic_id", [999, 702, 703]],
        ["discussion_id", [999, 602, 603]],
        ["poll_id", [999, 302, 303]],
      ] as const) {
        const what = kind === "topic_id" ? "thread" : kind.replace("_id", "");
        const texts = await Promise.all(
          ids.map((id) => text(tool({ [kind]: id } as Parameters<typeof tool>[0]))),
        );
        // Same text modulo the caller's own id, and it is the caller's id.
        const norm = texts.map((t, i) => t.replace(`"${ids[i]}"`, '"ID"'));
        expect(new Set(norm).size, `${tool.name} ${kind}: ${texts.join(" | ")}`).toBe(1);
        expect(texts[1]).toContain(`No ${what} "${ids[1]}" is visible`);
        for (const topic of [702, 703, 712, 713]) {
          if (kind !== "topic_id") expect(texts.join(" ")).not.toContain(String(topic));
        }
      }
    }
    expect(fetchCallsTo("/items")).toHaveLength(0);
    expect(fetchCallsTo("/markdown")).toHaveLength(0);
  });

  // Round 2: Loomio 3.13.1's records_visible_in_group answers an unknown
  // group 404 and a hidden one the GENERIC 403; b2 memberships#index an
  // unknown one 404 and a hidden one an empty 200. Walked over ids, that
  // was the oracle get_group no longer gives.
  const GENERIC_403 = { error: "You are not authorized to access this page." };
  const probeRoutes = (keyStatus: "valid" | "rejected") => ({
    "/v1/boot/version": { status: 200, body: { version: "3.13.1" } },
    "/b2/groups":
      keyStatus === "valid"
        ? { status: 200, body: groupsIndexBody() }
        : { status: 403, body: GENERIC_403 },
  });
  const errText = async (p: Promise<unknown>) =>
    (
      (await p.then(
        () => new Error("resolved"),
        (e: unknown) => e,
      )) as Error
    ).message;

  for (const [tool, path, load] of [
    [
      "list_discussions",
      "/b2/discussions",
      async () => (await import("../src/tools/discussions.js")).listDiscussions,
    ],
    ["list_polls", "/b2/polls", async () => (await import("../src/tools/polls.js")).listPolls],
  ] as const) {
    it(`open-DCR: ${tool} answers a hidden group (generic 403) and an unknown one (404) alike`, async () => {
      const { setOpenDcrMode } = await import("../src/deployment.js");
      setOpenDcrMode(true);
      const list = await load();
      mockFetchRoutes({ ...probeRoutes("valid"), [path]: { status: 403, body: GENERIC_403 } });
      const hidden = await errText(list({ group_id: 555 }));
      mockFetchRoutes({ ...probeRoutes("valid"), [path]: { status: 404, body: { error: "x" } } });
      const missing = await errText(list({ group_id: 555 }));
      expect(hidden).toBe(missing); // round 1: "Loomio returned 403 … UNAUTHENTICATED" vs "404: not found"
      expect(hidden).toMatch(/^No group "555" is visible to this connector/);
    });

    it(`open-DCR: ${tool} keeps a REJECTED key's own diagnosis (same text for every id: no oracle)`, async () => {
      const { setOpenDcrMode } = await import("../src/deployment.js");
      setOpenDcrMode(true);
      const list = await load();
      mockFetchRoutes({ ...probeRoutes("rejected"), [path]: { status: 403, body: GENERIC_403 } });
      expect(await errText(list({ group_id: 555 }))).not.toMatch(/is visible to this connector/);
    });
  }

  it("open-DCR: list_memberships answers an unknown group (404) with the hidden group's empty roster", async () => {
    const { setOpenDcrMode } = await import("../src/deployment.js");
    setOpenDcrMode(true);
    const { listMemberships } = await import("../src/tools/memberships.js");
    mockFetch(200, { memberships: [], users: [], meta: { root: "memberships", total: 0 } });
    const hidden = await listMemberships({ group_id: 555 });
    mockFetch(404, { error: "not found" });
    const missing = await listMemberships({ group_id: 556 });
    expect(missing).toEqual(hidden); // round 1: "Loomio API error 404: not found"
    expect(hidden.scope?.note).toMatch(/or no such group exists/);
  });

  it("static-client: list_memberships still reports an unknown group as 404", async () => {
    const { listMemberships } = await import("../src/tools/memberships.js");
    mockFetch(404, { error: "not found" });
    await expect(listMemberships({ group_id: 556 })).rejects.toThrow(/404/);
  });

  it("static-client / stdio keep the precise wording (the better diagnostic for a known client)", async () => {
    const { getGroup } = await import("../src/tools/groups.js");
    mockFetch(403, HIDDEN);
    await expect(getGroup({ id_or_key_or_handle: "a" })).rejects.toThrow(
      /HIDDEN from the connector's user/,
    );
    mockFetch(404, { error: "not found" });
    await expect(getGroup({ id_or_key_or_handle: "a" })).rejects.toThrow(/Loomio has no group/);
  });

  it("a key problem is NOT collapsed: the generic 403 says the same for every id", async () => {
    const { setOpenDcrMode } = await import("../src/deployment.js");
    setOpenDcrMode(true);
    mockFetch(403, { error: "You are not authorized to access this page." });
    const { getGroup } = await import("../src/tools/groups.js");
    await expect(getGroup({ id_or_key_or_handle: "a" })).rejects.toThrow(
      /UNAUTHENTICATED|rejected/,
    );
  });
});
