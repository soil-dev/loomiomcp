# Contributing

## Dev loop

```
npm install
npm run build:icon
npm run typecheck
npm test
npm run check          # biome lint + format
```

`npm run dev` runs `tsup --watch` for hot rebuilds. `npm run format`
rewrites `src`, `tests` and `scripts` in place before a commit.

## Layout

- `src/index.ts` — stdio entrypoint (probes key health once; warns on stderr, never exits for it)
- `src/http.ts` — HTTP entrypoint (Cloud Run)
- `src/version.ts` — `VERSION` (pinned to `package.json` by `tests/version.test.ts`) and `TESTED_LOOMIO_VERSION`
- `src/server.ts` — MCP server factory; `SERVER_INSTRUCTIONS` (the routing guide clients receive at `initialize`); every tool registration with its description, in discovery order
- `src/server/register-tool.ts` — `registerTool` helper + `inferAnnotations` (all four ToolAnnotations hints by naming convention)
- `src/loomio/client.ts` — undici HTTP client; injects `Authorization: Bearer …` (b2 key, or the b3 secret); `User-Agent: loomiomcp/<version>`; `loomioGet` / `loomioPost` / `loomioPatch` / `loomioDelete` / `loomioGetB3` / `loomioPostB3` / `loomioPatchB3` / `loomioDeleteB3`; the paged-read helpers (`B2_PAGE_MAX`, `loomioPager`, `loomioGetAllPages`, `mergePageBodies`) for the collections Loomio ≥ 3.11.1 pages; the read profiles (`EXCLUDE_TYPES`, `readParams`); `nestedBody` / `flatBody`; `classifyForbidden` (403 body catalogue, path- and method-aware) and 401 / 429 mapping
- `src/loomio/types.ts` — wire shapes of Loomio's serializers, 3.8.1 through 3.13.1 (everything optional; Loomio hides fields conditionally, and fields removed or added since are marked with their version)
- `src/loomio/shape.ts` — pure response shaping: `joinTopics`, `slimUser` / `slimGroup`, `truncateText` / `truncateField`, `highlightToMarkdown`, the canonical URL builders
- `src/loomio/visibility.ts` — poll result gating (Loomio's `results_visible?(voted:)` applied client-side) and `VisibilityRefusalError`, which `get_thread_markdown` throws where Loomio's export would ignore the rule
- `src/loomio/health.ts` + `health-cache.ts` — key-health probe (`GET /b2/groups` + public `GET /v1/boot/version`), 60 s cache, the parsed groups body kept beside the verdict, forced `loomio.auth` / `loomio.version_drift` events
- `src/tools/_common.ts` — shared zod helpers (`positiveId`, `idOrKey`, `isoTimestamp`, `PollTypeEnum` + `POLL_TYPE_RULES`, `maxCharsSchema`)
- `src/tools/{groups,discussions,polls,threads,search,reports,memberships,comments,admin,server-admin}.ts` — tool schemas + handlers (groups also holds `check_connection`; threads holds `resolveThread`, shared by `create_poll`, and `get_thread_markdown`'s vote-visibility guard; admin holds the four b3 user tools, server-admin the five Loomio 3.13 b3 provisioning tools)
- `src/auth/` — OAuth provider and HMAC token signing
- `src/http/` — Express app, OAuth routes, MCP transport wiring, `health.ts` (`GET /health`), `rate-limit.ts` (per-IP limiter shared by `/mcp` and `/health`)
- `src/log.ts` — structured event emission and `redactPath`; see OPTIMIZATIONS.md
- `tests/fixtures.ts` — anonymised response builders every tool test shares (3.8.1 shapes, updated to 3.13.1); `tests/test-helpers.ts` — the undici mock (`mockFetch`, `mockFetchRoutes`, `mockFetchPaged` — which emulates Loomio's bounded pages and the pre-3.11.1 whole-collection reply —, `expectBearerAuth`)

## Public-repo hygiene

This is a general-purpose connector: nothing in the tree may name a
deployment — no instance hostname, organisation, bot account name, real
group or user id, or person. `tests/server.test.ts` checks the generic
signals in everything a client reads (no email address, no hostname
other than `example.org` / `loomio.com`), but the list of concrete
tokens to grep for belongs to the operator, not the repository: keep it
in a gitignored `*.local.*` file (or an environment variable) and run

```
git grep -n -i -E "$(paste -sd'|' hygiene-tokens.local.txt)" -- ':!package-lock.json'
```

before tagging — it must print nothing. A committed negative-assertion
test would put the very tokens it guards against into the tree.

## Releasing

Bump `version` in `package.json` (and `package-lock.json`, both
fields) **and** `VERSION` in `src/version.ts` together — `npm test`
fails if they differ. When a release has been re-verified against a
newer Loomio, update `TESTED_LOOMIO_VERSION` there too; the health
probe warns on `major.minor` drift from it and `check_connection`
repeats the warning. Facts about Loomio's API belong in
NOTES-ON-LOOMIO-API.md with the Loomio tag they were checked against;
mark superseded facts **historical** rather than deleting them.

`scripts/live-test.mjs` is gitignored — it drives the built
`dist/index.js` over stdio against a real Loomio instance, reading
credentials and group ids from the environment only (HOWTO.md has the
invocation). Keep it generic: no instance names or ids in the code.
Run its READ mode against a real instance before tagging; run its
WRITE mode only against a sandbox group.

## Adding a new tool

1. Add a Zod schema (rich `.describe()` on every field) + async handler
   in `src/tools/<area>.ts`. Reads take a read profile from
   `readParams(...)` — never `compact=1` where the `topics` join is
   needed; writes carry no profile. Shape the response through
   `src/loomio/shape.ts` (join, slim, truncate, link) and surface
   Loomio's `meta.total` as `total` plus a `scope` block.
2. Import and register it in `src/server.ts`, inside the `!readOnly`
   block if it's a write (or the b3 block if it needs the b3 secret).
   Name it with a read prefix (`get_` / `list_` / `search_` / `check_`)
   or a write prefix (`create_` / `update_` / `delete_` / `manage_`)
   so `inferAnnotations` produces the right hints; `tests/server.test.ts`
   checks them. Write the description for an AI caller in three
   sentences: what it returns and costs in upstream calls, when to use
   it vs its siblings, the one caveat that changes behaviour — at most
   700 chars (350 for `delete_*` / `update_comment`), every zod
   `.describe()` at most 120 chars (meaning, unit, default, range; none
   on a self-naming field). The catalogue is paid by every session
   before its first question: `npm run build && node
   scripts/catalog-size.mjs` prints the bytes per tool, and
   `tests/server.test.ts` fails above 36 000 bytes for the 24 full-mode
   tools (17 000 for the 14 read-only tools — prefix
   `LOOMIO_MCP_READONLY=1` to measure them —, 44 500 for the 33 with
   b3; instructions ≤ 1 800 chars). Field-by-field
   outputs, permission rules and the exact 403 / 404 texts go into
   HOWTO.md "Tool reference", one subsection per tool.
3. Add a focused test in `tests/<area>.test.ts` using the
   `vi.mock("undici", …)` + `mockFetch` / `mockFetchRoutes` pattern and
   the builders in `tests/fixtures.ts`: assert the request shape (path,
   query, method, body nesting) AND the response shaping. Add the name
   to the read / write / b3 sets in `tests/readonly.test.ts`.
4. Update docs in this order so the catalog stays single-sourced:
   - `README.md` tool table (canonical; include the upstream call count)
   - `glama.json` `tools` list (names + one line each, matching `server.ts`)
   - `SERVER_INSTRUCTIONS` in `src/server.ts` if the tool answers a new
     KIND of question
   - `NOTES-ON-LOOMIO-API.md` endpoint table + the "Verified live" row
     when you exercise it against a real instance
   - `HOWTO.md`: a "Tool reference" subsection (inputs, outputs, cost,
     caveats, exact error texts) and a recipe if there's a natural
     example use case
   - `OPTIMIZATIONS.md` cost table
   - `CHANGELOG.md` entry under the current unreleased version

   Don't duplicate the tool list in DEPLOY.md, SECURITY.md, or
   DESIGN.md — link back to README.md.

## Style

biome handles lint + format. CI runs `npm run check`. Comments say WHY
(which Loomio controller / serializer / test the behaviour follows, and
what goes wrong without it), not what. The repo is general-purpose:
never write an instance's name, host, group ids or people into it — use
`example.org` and illustrative ids.
