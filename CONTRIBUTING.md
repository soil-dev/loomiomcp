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

- `src/index.ts` — stdio entrypoint
- `src/http.ts` — HTTP entrypoint (Cloud Run)
- `src/server.ts` — MCP server factory; tool registrations
- `src/loomio/client.ts` — undici HTTP client; injects `?api_key=…` (or `?b3_api_key=…`)
- `src/tools/_common.ts` — shared zod helpers (positiveId, idOrKey, PollTypeEnum)
- `src/tools/{discussions,polls,memberships,comments,admin}.ts` — tool schemas + handlers
- `src/auth/` — OAuth provider and HMAC token signing
- `src/http/` — Express app, OAuth routes, MCP transport wiring
- `src/server/register-tool.ts` — `registerTool` helper
- `src/log.ts` — structured event emission; see OPTIMIZATIONS.md

## Adding a new tool

1. Add a Zod schema + async handler in `src/tools/<area>.ts`.
2. Import and register it in `src/server.ts`, inside the `!readOnly`
   block if it's a write.
3. Add a focused test in `tests/<area>.test.ts` using the
   `vi.mock("undici", …)` + `mockFetch` pattern.

## Style

biome handles lint + format. CI runs `npm run check`.
