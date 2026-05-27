import { describe, it, expect, vi } from "vitest";
import { mockFetch, setupLoomioTest } from "./test-helpers.js";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));
setupLoomioTest({ LOOMIO_B3_API_KEY: "long-enough-admin-secret-12345" });

describe("deactivateUser (b3 admin)", () => {
  it("POSTs /b3/users/deactivate with id and b3_api_key in URL", async () => {
    mockFetch(200, { success: "ok" });
    const { deactivateUser } = await import("../src/tools/admin.js");
    await deactivateUser({ id: 42 });

    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/b3/users/deactivate?");
    expect(url).toContain("id=42");
    expect(url).toContain("b3_api_key=long-enough-admin-secret-12345");
    expect(url).not.toContain("api_key=user-key");
    expect((opts as RequestInit).method).toBe("POST");
  });

  it("throws if LOOMIO_B3_API_KEY missing", async () => {
    delete process.env["LOOMIO_B3_API_KEY"];
    const { deactivateUser } = await import("../src/tools/admin.js");
    await expect(deactivateUser({ id: 1 })).rejects.toThrow(/LOOMIO_B3_API_KEY/);
  });
});

describe("reactivateUser (b3 admin)", () => {
  it("POSTs /b3/users/reactivate with id and b3_api_key in URL", async () => {
    mockFetch(200, { success: "ok" });
    const { reactivateUser } = await import("../src/tools/admin.js");
    await reactivateUser({ id: 7 });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/b3/users/reactivate?");
    expect(url).toContain("id=7");
    expect(url).toContain("b3_api_key=long-enough-admin-secret-12345");
  });
});
