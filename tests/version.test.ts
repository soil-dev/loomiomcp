/**
 * The connector's version is declared in three places that must agree:
 * package.json (what npm publishes), package-lock.json (what CI
 * installs), and src/version.ts (what the McpServer descriptor, the
 * User-Agent and /health report). v0.0.9 shipped with the McpServer
 * literal one release behind package.json, and the lockfile has lagged
 * too; this test makes that a CI failure instead of a surprise.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TESTED_LOOMIO_VERSION, VERSION } from "../src/version.js";

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../${relative}`, import.meta.url), "utf8"));
}

describe("VERSION", () => {
  it("matches package.json", () => {
    expect(readJson("package.json")["version"]).toBe(VERSION);
  });

  it("matches both version fields in package-lock.json", () => {
    const lock = readJson("package-lock.json");
    expect(lock["version"]).toBe(VERSION);
    const root = (lock["packages"] as Record<string, { version?: string }>)[""];
    expect(root?.version).toBe(VERSION);
  });

  it("is a plain semver triple (it is embedded in the User-Agent)", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("TESTED_LOOMIO_VERSION", () => {
  it("is a semver triple so major.minor drift comparison is well-defined", () => {
    expect(TESTED_LOOMIO_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
