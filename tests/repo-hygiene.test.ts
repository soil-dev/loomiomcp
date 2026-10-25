/**
 * Repository-level security posture that no unit test of `src/` sees:
 * how CI, the release and the container image are built, and whether
 * every knob the code reads is documented for operators.
 *
 * WHY each check exists (security review of v0.0.16):
 *   - nit 13 / F-07: GitHub Actions were pinned by movable major tags, no
 *     dependency-update automation existed, and npm releases carried no
 *     provenance — whoever could move a tag or publish from a laptop
 *     changed what users install, with no record of the commit.
 *   - nit 14: the Dockerfile copied all of `scripts/` and `.dockerignore`
 *     let gitignored operator-local files (`scripts/live-test*.mjs`,
 *     `*.local.*`, `.env.*`) into the builder layer; the base image was a
 *     tag that is re-pointed upstream every few days.
 *   - F-17 / nit 15: an operator cannot set what is not documented — the
 *     review had to grep the source for the knobs that exist.
 * Each assertion fails on the v0.0.16 tree.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

function workflows(): Array<{ name: string; text: string }> {
  const dir = join(ROOT, ".github", "workflows");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => ({ name: f, text: readFileSync(join(dir, f), "utf8") }));
}

describe("CI and release supply chain (nit 13)", () => {
  it("pins every third-party action by full commit SHA, never by tag", () => {
    const flows = workflows();
    expect(flows.length).toBeGreaterThanOrEqual(2);
    for (const { name, text } of flows) {
      const uses = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1] as string);
      expect(uses.length, name).toBeGreaterThan(0);
      for (const ref of uses) {
        // Local actions (./…) carry no version; everything else must be owner/repo@<40 hex>.
        if (ref.startsWith("./")) continue;
        expect(ref, `${name}: ${ref}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      }
    }
  });

  it("keeps workflow permissions read-only by default", () => {
    for (const { name, text } of workflows()) {
      expect(text, name).toMatch(/^permissions:\n\s+contents: read$/m);
    }
  });

  it("lets Dependabot propose npm, GitHub Actions and Docker updates", () => {
    const config = read(".github/dependabot.yml");
    for (const ecosystem of ["npm", "github-actions", "docker"]) {
      expect(config).toMatch(new RegExp(`package-ecosystem:\\s*${ecosystem}\\b`));
    }
  });

  it("publishes to npm only from CI, with provenance via trusted publishing, and attaches an SBOM", () => {
    const publish = read(".github/workflows/publish.yml");
    expect(publish).toMatch(/release:\s*\n\s+types:\s*\[published\]/);
    expect(publish).toMatch(/id-token:\s*write/);
    expect(publish).toMatch(/npm publish "\.\/\$\{TARBALL\}" --provenance --access public/);
    expect(publish).toMatch(/npm sbom --sbom-format cyclonedx/);
    // No long-lived npm token: trusted publishing (OIDC) only.
    expect(publish).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN:/);
    // The release tag reaches shell only through env:, never spliced into a script.
    expect(publish).not.toMatch(/run:.*\$\{\{\s*github\.event/);
  });

  it("keeps the publish credential away from dependency code (round 1)", () => {
    // A job with `id-token: write` exposes the OIDC request token to every
    // step: the job that can mint it must run no dependency or repo code.
    const publish = read(".github/workflows/publish.yml");
    const jobs = publish.slice(publish.indexOf("\njobs:"));
    const job = (name: string) => {
      const start = jobs.indexOf(`\n  ${name}:`);
      const next = jobs.slice(start + 1).search(/\n {2}[a-z][\w-]*:\s*\n/);
      return next < 0 ? jobs.slice(start) : jobs.slice(start, start + 1 + next);
    };
    const verify = job("verify");
    const pub = job("publish");
    expect(verify).toMatch(/npm ci --ignore-scripts/);
    expect(verify).toMatch(/npm test/);
    expect(verify).not.toMatch(/id-token/);
    expect(pub).toMatch(/id-token:\s*write/);
    expect(pub).toMatch(/needs:\s*verify/);
    for (const forbidden of [/actions\/checkout/, /npm ci\b/, /npm run\b/, /npm test\b/, /npx\b/]) {
      expect(pub).not.toMatch(forbidden);
    }
    expect((jobs.match(/id-token:\s*write/g) ?? []).length).toBe(1);
  });
});

describe("container image (nit 13 / nit 14)", () => {
  const dockerfile = read("Dockerfile");

  it("pins every base image by digest", () => {
    const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1] as string);
    expect(froms.length).toBeGreaterThanOrEqual(2);
    for (const image of froms) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("copies only the build script out of scripts/, never the whole directory", () => {
    expect(dockerfile).not.toMatch(/^COPY\s+scripts\s/m);
    expect(dockerfile).toMatch(/^COPY\s+scripts\/build-icon\.mjs\s/m);
  });

  it("keeps secrets and operator-local files out of the build context", () => {
    const ignored = read(".dockerignore")
      .split("\n")
      .map((l) => l.trim());
    for (const pattern of [
      ".env",
      ".env.*",
      ".npmrc",
      "*.local.*",
      "scripts/live-test*",
      ".claude",
    ]) {
      expect(ignored, pattern).toContain(pattern);
    }
  });
});

describe("operator documentation of every knob (F-17, nit 15)", () => {
  /** Every LOOMIO_* / MCP_* name the source mentions as a string literal. */
  function knobsInSource(): string[] {
    const names = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts")) {
          for (const m of readFileSync(path, "utf8").matchAll(/"((?:LOOMIO|MCP)_[A-Z0-9_]+)"/g)) {
            names.add(m[1] as string);
          }
        }
      }
    };
    walk(join(ROOT, "src"));
    return [...names].sort();
  }

  it("documents every environment variable the code reads in DEPLOY.md or INSTALL.md", () => {
    const docs = read("DEPLOY.md") + read("INSTALL.md");
    const knobs = knobsInSource();
    expect(knobs).toContain("LOOMIO_MCP_GROUP_IDS");
    for (const knob of knobs) expect(docs, knob).toContain(`\`${knob}`);
  });

  it("tells operators to keep the SDK's insecure-issuer escape hatch unset", () => {
    const row = read("DEPLOY.md")
      .split("\n")
      .find((l) => l.startsWith("| `MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL`"));
    expect(row).toBeDefined();
    expect(row).toMatch(/Keep it unset/);
  });
});
