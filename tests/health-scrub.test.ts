/**
 * F-02 layer 3 on the key-health probe's `detail` (round-2 finding). The
 * detail reaches the startup log (src/http.ts prints it on an
 * `unreachable` verdict) and check_connection's diagnosis. Layers 1 and
 * 2 already replace every message the CLIENT builds, so only the
 * `scrubSecrets` calls in src/loomio/health.ts stand between a key a
 * WAF or proxy echoes back (or an error that embeds it) and the log —
 * and replacing either with `String(` left the whole suite green.
 *
 * The client module is wrapped so one case can make `loomioGetRaw`
 * reject with a message of its choosing (the catch path is otherwise
 * unreachable with a key layer 1 accepts).
 */

import { fetch } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockFetchRoutes, setupLoomioTest } from "./test-helpers.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));

const override = vi.hoisted(() => ({ rawError: undefined as Error | undefined }));
vi.mock("../src/loomio/client.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/loomio/client.js")>();
  return {
    ...mod,
    loomioGetRaw: (...args: Parameters<typeof mod.loomioGetRaw>) =>
      override.rawError ? Promise.reject(override.rawError) : mod.loomioGetRaw(...args),
  };
});

setupLoomioTest();

const KEY = "SCRUBME-0123456789";
const VERSION_OK = { status: 200, body: { version: "3.13.1" } };
let stderr: string[] = [];

beforeEach(async () => {
  const { resetHealthForTests } = await import("../src/loomio/health.js");
  resetHealthForTests();
  process.env["LOOMIO_API_KEY"] = KEY;
  override.rawError = undefined;
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fetch).mockReset();
});

describe("the probe's detail never carries the configured key (F-02 layer 3)", () => {
  it("unrecognised 403 path: a JSON body echoing the bearer is redacted in detail", async () => {
    // JSON, neither Cloudflare-typed nor CanCan's generic text: the only
    // body that reaches the `text.slice(0, 200)` branch (a non-JSON 403
    // is filed as `waf` with fixed text).
    mockFetchRoutes({
      "/b2/groups": { status: 403, body: { error: `denied Bearer ${KEY}` } },
      "/v1/boot/version": VERSION_OK,
    });
    const { checkLoomioHealth } = await import("../src/loomio/health.js");
    const h = await checkLoomioHealth({ force: true });
    expect(h.reason).toBe("unrecognised_403");
    expect(h.detail).toContain("denied Bearer [redacted]");
    expect(h.detail).not.toContain(KEY);
    expect(stderr.join("")).not.toContain(KEY);
  });

  it("catch path: an error message that embeds the key is redacted in detail", async () => {
    override.rawError = new Error(`upstream socket said: Authorization: Bearer ${KEY}`);
    mockFetchRoutes({ "/v1/boot/version": VERSION_OK });
    const { checkLoomioHealth } = await import("../src/loomio/health.js");
    const h = await checkLoomioHealth({ force: true });
    expect(h.key_status).toBe("unreachable");
    expect(h.detail).toContain("Bearer [redacted]");
    expect(h.detail).not.toContain(KEY);
    expect(stderr.join("")).not.toContain(KEY);
  });
});
