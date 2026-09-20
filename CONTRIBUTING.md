# Contributing

## Dev loop

```
npm install
npm run build:icon
npm run typecheck
npm test
npm run check          # biome lint + format
```

`npm run dev` runs `tsup --watch` for hot rebuilds.

## Layout

- `src/index.ts` — stdio entrypoint (probes key health once; warns on stderr, never exits for it)
- `src/http.ts` — HTTP entrypoint (Cloud Run)
- `src/version.ts` — `VERSION` (pinned to `package.json` by `tests/version.test.ts`) and `TESTED_LOOMIO_VERSION`
- `src/server.ts` — MCP server factory; tool registrations
- `src/loomio/client.ts` — undici HTTP client; injects `Authorization: Bearer …` (b2 key, or the b3 secret); `User-Agent: loomiomcp/<version>`; `classifyForbidden` (403 body catalogue) and 429 mapping
- `src/loomio/health.ts` + `health-cache.ts` — key-health probe (`GET /b2/groups` + public `GET /v1/boot/version`), 60 s cache, forced `loomio.auth` / `loomio.version_drift` events
- `src/tools/_common.ts` — shared zod helpers (positiveId, idOrKey, PollTypeEnum)
- `src/tools/{discussions,polls,memberships,groups,events,comments,admin}.ts` — tool schemas + handlers
- `src/auth/` — OAuth provider and HMAC token signing
- `src/http/` — Express app, OAuth routes, MCP transport wiring, `health.ts` (`GET /health`), `rate-limit.ts` (per-IP limiter shared by `/mcp` and `/health`)
- `src/server/register-tool.ts` — `registerTool` helper + `inferAnnotations`
- `src/log.ts` — structured event emission; see OPTIMIZATIONS.md

## Releasing

Bump `version` in `package.json` (and `package-lock.json`) **and**
`VERSION` in `src/version.ts` together — `npm test` fails if they
differ. When a release has been re-verified against a newer Loomio,
update `TESTED_LOOMIO_VERSION` there too; the health probe warns on
`major.minor` drift from it. Facts about Loomio's API belong in
NOTES-ON-LOOMIO-API.md with the Loomio tag they were checked against.

`scripts/live-test.mjs` is gitignored — copy-paste your own when you
need to drive the connector against a real Loomio instance from a
local shell.

## Adding a new tool

1. Add a Zod schema + async handler in `src/tools/<area>.ts`.
2. Import and register it in `src/server.ts`, inside the `!readOnly`
   block if it's a write.
3. Add a focused test in `tests/<area>.test.ts` using the
   `vi.mock("undici", …)` + `mockFetch` pattern.
4. Update docs in this order so the catalog stays single-sourced:
   - `README.md` tool list (canonical)
   - `NOTES-ON-LOOMIO-API.md` endpoint table + "Verified live" row when
     you exercise it against a real instance
   - `HOWTO.md` recipe if there's a natural example use case
   - `CHANGELOG.md` entry under the current unreleased version

   Don't duplicate the tool list in DEPLOY.md, SECURITY.md, or
   DESIGN.md — link back to README.md.

## Style

biome handles lint + format. CI runs `npm run check`.
