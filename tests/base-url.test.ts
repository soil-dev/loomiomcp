import { describe, it, expect, vi } from "vitest";
import { mockFetch, setupLoomioTest } from "./test-helpers.js";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest();

describe("LOOMIO_API_BASE_URL validation", () => {
  it("accepts the default (no override)", async () => {
    delete process.env["LOOMIO_API_BASE_URL"];
    mockFetch(200, {});
    const { getDiscussion } = await import("../src/tools/discussions.js");
    await getDiscussion({ id_or_key: 1 });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url as string).toMatch(/^https:\/\/www\.loomio\.com\/api\/b2\/discussions\/1\?/);
    delete process.env["LOOMIO_API_BASE_URL"];
  });

  it("accepts https:// overrides", async () => {
    process.env["LOOMIO_API_BASE_URL"] = "https://loomio.example.org/api";
    mockFetch(200, {});
    const { getDiscussion } = await import("../src/tools/discussions.js");
    await getDiscussion({ id_or_key: 1 });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url as string).toContain("https://loomio.example.org/api/b2/discussions/1");
    delete process.env["LOOMIO_API_BASE_URL"];
  });

  it("accepts http://localhost overrides (for tests / dev)", async () => {
    process.env["LOOMIO_API_BASE_URL"] = "http://localhost:3000/api";
    mockFetch(200, {});
    const { getDiscussion } = await import("../src/tools/discussions.js");
    await getDiscussion({ id_or_key: 1 });
    expect(vi.mocked(fetch).mock.calls[0]![0] as string).toContain("http://localhost:3000/");
    delete process.env["LOOMIO_API_BASE_URL"];
  });

  it("accepts http://127.0.0.1 and http://[::1] loopback overrides", async () => {
    for (const host of ["http://127.0.0.1:3000/api", "http://[::1]/api"]) {
      process.env["LOOMIO_API_BASE_URL"] = host;
      mockFetch(200, {});
      const { getDiscussion } = await import("../src/tools/discussions.js");
      await getDiscussion({ id_or_key: 1 });
    }
    delete process.env["LOOMIO_API_BASE_URL"];
  });

  it("rejects http:// pointed at non-loopback hosts (the key would leak)", async () => {
    process.env["LOOMIO_API_BASE_URL"] = "http://loomio.example.org/api";
    const { getDiscussion } = await import("../src/tools/discussions.js");
    await expect(getDiscussion({ id_or_key: 1 })).rejects.toThrow(/must be https/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    delete process.env["LOOMIO_API_BASE_URL"];
  });

  it("rejects unparseable URLs", async () => {
    process.env["LOOMIO_API_BASE_URL"] = "not a url";
    const { getDiscussion } = await import("../src/tools/discussions.js");
    await expect(getDiscussion({ id_or_key: 1 })).rejects.toThrow(/not a valid URL/);
    delete process.env["LOOMIO_API_BASE_URL"];
  });

  it("rejects non-http(s) protocols", async () => {
    process.env["LOOMIO_API_BASE_URL"] = "ftp://loomio.example.org/api";
    const { getDiscussion } = await import("../src/tools/discussions.js");
    await expect(getDiscussion({ id_or_key: 1 })).rejects.toThrow(/must be https/);
    delete process.env["LOOMIO_API_BASE_URL"];
  });
});
