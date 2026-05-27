import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockFetch, setupLoomioTest } from "./test-helpers.js";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();
// readonly tests toggle LOOMIO_MCP_READONLY per-test; the shared helper
// covers LOOMIO_API_KEY but doesn't know about this one.
afterEach(() => delete process.env["LOOMIO_MCP_READONLY"]);

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
    // Pass `private` explicitly so the readonly gate fires before the
    // auto-resolve group fetch would.
    await expect(createDiscussion({ title: "T", group_id: 1, private: false })).rejects.toThrow(
      /read-only mode/,
    );
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("blocks create_discussion before the private auto-resolve fetch", async () => {
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

  it("still allows GET", async () => {
    mockFetch(200, { discussions: [] });
    const { getDiscussion } = await import("../src/tools/discussions.js");
    const result = await getDiscussion({ id_or_key: 1 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
  });
});
