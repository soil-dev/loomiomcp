# Deploying loomiomcp

Two supported deployment shapes: local stdio (read-write, for one user)
and Cloud Run HTTP (typically read-only, multi-user via OAuth).

## Local stdio

Wire it into your MCP host (Claude Desktop, Claude Code, etc.) as a
stdio server — command `loomiomcp` (or `npx -y loomiomcp`) with
`LOOMIO_API_KEY` in the server entry's `env` block (INSTALL.md). The host
launches the process; the API key stays in the host's config on your
machine. From a shell, `read -rs LOOMIO_API_KEY && export
LOOMIO_API_KEY` first, then run `loomiomcp` — never `LOOMIO_API_KEY=<key>
loomiomcp`, which leaves the key in shell history and process listings.

To run in read-only mode: also set `LOOMIO_MCP_READONLY=1`. Only the
14 read tools are registered; the 10 write tools and the 9 b3 tools are
not even visible to the MCP host. See [README.md](README.md) for the
full tool catalog and which tools are reads vs writes.

## Cloud Run (HTTP)

The HTTP entry exposes the same MCP server over OAuth 2.1 (RFC 7591)
so Claude.ai's Custom Connector can reach it.

Open-DCR client registrations, access/refresh tokens and (since
v0.0.17) authorization codes are stateless: they are signed with
`MCP_OAUTH_SIGNING_KEY`, so clients survive restarts, scale-to-zero,
redeploys, and multi-instance routing, and the `/authorize` and `/token`
legs of the handshake may land on different instances. Single use of a
code is enforced per instance; a replay that reaches another instance
within the 5-minute TTL needs the same client credentials and PKCE
verifier, so it only re-issues tokens to their holder.

Required env in any HTTP deployment:

| Variable | What it is |
|---|---|
| `LOOMIO_API_KEY` | Loomio API key. Shared by every authenticated MCP caller hitting this deployment. |
| `LOOMIO_API_BASE_URL` | Loomio API root. Defaults to `https://www.loomio.com/api`. Set to e.g. `https://loomio.example.org/api` for a self-hosted instance. Override is gated to `https://` or loopback `http://` so the API key (sent as a bearer header) can't leak to a plaintext host. The same value minus `/api` is the base of every `url` the tools return. |
| `PUBLIC_BASE_URL` | Public origin of the service, e.g. a custom domain `https://mcp.example.org` or the raw `https://loomiomcp-xyz.run.app`. Must match the URL clients fetch — it's the OAuth metadata issuer (RFC 8414). |
| `MCP_OAUTH_SIGNING_KEY` | HMAC key behind every OAuth token, client registration and authorization code (≥32 chars, stable across instances; e.g. `node -p "require('node:crypto').randomBytes(32).toString('hex')"`). A 16–31-character key (v0.0.16's floor) still starts, with a startup WARNING, until 2027-01-31 00:00 UTC and is refused at the first start after that; under 16 is refused always. Replacing the key makes every user authorize once more, so rotate a short one at a convenient time before the sunset. |

OAuth mode (pick one):

- **Open DCR (anyone who can reach the URL can register a client).**
  Set `MCP_OAUTH_INSECURE_AUTO_APPROVE=1`. The server refuses to start
  in this mode on a non-loopback `PUBLIC_BASE_URL` (or with a
  non-loopback `MCP_HTTP_BIND`) unless you also set
  `MCP_OAUTH_I_KNOW_WHAT_IM_DOING=yes`. A self-registered client may
  redirect only to Anthropic's callbacks, loopback addresses, app
  schemes and the https hosts in `MCP_OAUTH_REDIRECT_HOSTS`. Use this when the upstream
  identity is intentionally public — e.g. a read-only bot scoped to
  open community discussions. This is the recommended mode for a public,
  read-only community connector (see [Reference deployment](#reference-deployment)).
  The per-IP rate limit (below) bounds request rate in this mode and the
  daily quotas bound volume, so keep both set (all per process); set
  `LOOMIO_MCP_GROUP_IDS` so that only the groups you mean to publish are
  served, whatever group coordinators do. Read SECURITY.md first: with Loomio ≥ 3.8 the shared user can
  list and search every public group's public content on the instance,
  and the participation report exposes per-member activity counts for
  every group it is in.
- **Static client (lock-down alternative).** Set both
  `MCP_OAUTH_CLIENT_ID` and `MCP_OAUTH_CLIENT_SECRET` (≥ 16 characters;
  a shorter one is refused at startup). DCR is disabled;
  the client_secret is the real auth boundary, so only people you hand
  the secret to can connect. Optionally set `MCP_OAUTH_REDIRECT_URIS`
  (comma-separated); defaults to Anthropic's known callback URIs. Use
  this when the upstream identity (`LOOMIO_API_KEY`) sees data you
  wouldn't want an anonymous caller to see.

For either mode, set `LOOMIO_MCP_READONLY=1` on any public deployment.
Writes (especially `manage_memberships` and the `delete_*` tools) using
a shared API key across many unrelated callers are hard to audit — Loomio
attributes every write to the connector's user, whoever asked for it.
The reference deployment combines open-DCR + readonly to make "available
to anyone, can't write anything" explicit.

Other env:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port (Cloud Run injects). |
| `MCP_HTTP_BIND` | see purpose | Listen address. Unset: the loopback host of a loopback `PUBLIC_BASE_URL` (`http://127.0.0.1:…` listens on 127.0.0.1 only; `localhost` on the address the OS resolves it to first, often `::1`), every interface otherwise (Cloud Run). Set it (e.g. `0.0.0.0`) when the server runs in a container behind `-p`. A non-loopback bind counts as public: open DCR then needs `MCP_OAUTH_I_KNOW_WHAT_IM_DOING=yes` and the b3 secret is refused, whatever `PUBLIC_BASE_URL` says. The bound address is logged at startup. |
| `MCP_HTTP_JSON_LIMIT` | `256kb` | Body cap for `POST /mcp` (`b`/`kb`/`mb` or bytes; a typo is refused at startup), applied by the JSON parser and the MCP transport alike; an over-cap body is answered 413 in JSON-RPC shape. Was `1mb` before v0.0.17. Every read input fits easily; a **write-enabled** deployment whose users post long non-Latin text sets `1mb` — the largest legal write input, a 100 000-character body, is up to ~300 KB of UTF-8 in CJK text (~600 KB when a client `\u`-escapes it). |
| `MCP_HTTP_TRUST_PROXY` | `0` | Proxy hops whose `X-Forwarded-For` entry is trusted as the client address (rate limits, daily quotas). **Set `1` on Cloud Run** (one appending front end) — the default was `1` before v0.0.17; with `0` there, every caller shares the front end's bucket (the server warns when `K_SERVICE` is set). `0` is right whenever clients connect directly (`docker run`, a bare host), where trusting the header lets any caller pick its own bucket. A forwarded value that is not an IP address is ignored in favour of the TCP peer. The effective value is logged at startup. |
| `MCP_HTTP_UPSTREAM_BUDGET` | `120` | Loomio requests one `POST /mcp` may start for its tool calls (a JSON-RPC batch shares one budget); past it each further call fails with a tool error naming this knob. The largest single tool call (`get_user_activity` over 50 groups) needs 51. The health probe is not charged: it runs at most once per 10 s per process even when `check_connection` asks for it. `0` = no cap. |
| `MCP_HTTP_UPSTREAM_CONCURRENCY` | `16` | Loomio requests in flight per process; up to 32 × this many wait in a queue, beyond that a call fails fast ("retry shortly"). Fair across source addresses: the queue is served round-robin per source, one source holds at most ¾ of the slots and queues at most 8 per slot. |
| `MCP_HTTP_UPSTREAM_PER_5MIN` | `900` | Loomio requests per process in any 5 minutes (HTTP tool traffic; the health probe is counted, never refused); one source address at most half; past it a call fails fast with a tool error naming this knob. 900 is Loomio's own per-address throttle (`rack_attack.rb`), which applies to every request from the connector's address — when N instances reach Loomio through ONE egress address set 900 ÷ N; raise it only if your Loomio safelists the connector (`TRUSTED_INGRESS_IPS`) or runs a larger `RATE_MULTIPLIER`. `0` = off (the v0.0.16 behaviour). |
| `MCP_DAILY_TOOL_CALLS` | `5000` | Open-DCR mode only: tool calls one source IP (IPv6 /56) may make per UTC day; `0` = off. **Per process** — N instances allow N × this, and a restart resets it. **One source is one address, not one user:** every hosted-Claude user (claude.ai, Desktop, mobile) connects from Anthropic's egress range `160.79.104.0/21`, so without `MCP_SHARED_EGRESS_CIDRS` they share this quota per egress address and instance (one of them spends it in ~17 minutes at the rate limit). With the range listed there, each client on it gets this quota and the address as a whole 20 × this. |
| `MCP_DAILY_RESULT_BYTES` | `500000000` | Open-DCR mode only: bytes of tool results one source IP may receive per UTC day (the call that crosses it completes; the next is refused); `0` = off. Per process and per address, like the call quota (per client, under a 20 × aggregate, inside `MCP_SHARED_EGRESS_CIDRS`). |
| `MCP_SHARED_EGRESS_CIDRS` | unset | Comma-separated CIDR ranges (IPv4 / IPv6, ≤ 64; a malformed entry is refused at startup) that many unrelated users reach the connector from — on an open-DCR deployment serving hosted Claude, Anthropic's published egress range (`160.79.104.0/21`). An address inside one is keyed per OAuth client as well: each client gets its own daily quotas (the address as a whole 20 ×), a quarter of the address's half of `MCP_HTTP_UPSTREAM_PER_5MIN` (the address as a whole still the half), and its own turn in the upstream queue — so one hosted-Claude user can no longer spend those for every other. The `/mcp` request-rate limiter stays per address (it runs before the bearer check). Outside these ranges the key stays the address alone: a client_id is free to mint. Logged at startup. |
| `MCP_ALLOWED_ORIGINS` | unset | Extra browser origins (comma-separated, `https://` or loopback `http://`) allowed alongside `PUBLIC_BASE_URL`'s origin and `https://claude.ai`. Only needed for a browser-based MCP client on another origin. |
| `MCP_OAUTH_REDIRECT_HOSTS` | unset | Open-DCR only. A self-registered client may redirect only to Anthropic's callback URIs, loopback `http(s)://127.0.0.1`, `[::1]` or `localhost` (any port and path) and private-use app schemes (`com.example.app:/cb`, never a deny-listed launcher such as `ms-*`, `search-ms:`, `mailto:`, `web+*`); Anthropic's callbacks include `https://claude.com/api/mcp/auth_callback`, which Anthropic announced it may switch to; list further **https** hosts here as exact, comma-separated hostnames (e.g. `vscode.dev,chatgpt.com`). `*` allows any https host, which re-opens the open redirect on this domain (security review F-09) — avoid it. Every client: ≤ 10 URIs of ≤ 512 chars, no fragment, no userinfo. Checked at `/register` and again whenever a client_id is used, so narrowing the list cuts off clients registered under the wider one. Static-client mode ignores it (use `MCP_OAUTH_REDIRECT_URIS`). |
| `MCP_HTTP_RATE_LIMIT_MAX` | `600` | Request cap per window, keyed on the **source IP** (not the OAuth client_id — under open DCR a caller can mint unlimited client_ids, so IP is the only sound key). Every `/mcp` request counts, authenticated or not (the limiter runs first). **Per process**: every limiter keeps its counts in memory, so with N instances the effective per-source ceiling is up to N × this value, and it resets on every cold start. Tighten on open-DCR deployments; the reference deployment uses 300. The rate is bounded here, the volume by the daily quotas above. Per-call upstream cost is bounded separately: every read is one Loomio call except `list_threads` under `LOOMIO_MCP_GROUP_IDS` (≤ 10 walk calls of 100 rows), `get_user_activity` (one report call per requested group, ≤ 50, 4 in flight, plus one search) and, because Loomio ≥ 3.11.1 pages its groups index and thread items, `list_groups` (1 per 500 member groups, ≤ 20), `check_connection` (+1 per 500 groups beyond the first 50, ≤ 20), `list_thread_items` (≤ 2 item calls, ≤ 10 with `kinds`, +1 by `discussion_id` / `poll_id`), `get_discussion` with `include_items` (2, +1 per further 500 embedded items, ≤ 3) and `get_thread_markdown` (2, +1 per 500 items, ≤ 10, when its vote-visibility guard scans the thread — any thread with replies; on Loomio 3.8 / 3.9 the guard is skipped: 2, or 4 when it first re-runs a health probe older than a minute); SECURITY.md "Upstream cost bounds" has the detail; per HTTP request, `MCP_HTTP_UPSTREAM_BUDGET` caps the total. The same config applies to `GET /health`, in a separate bucket. `/register` (20 per hour), `/authorize` (100 per 15 min) and `/token` (50 per 15 min) have fixed per-IP budgets of their own, also per process. |
| `MCP_HTTP_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window. |
| `MCP_HTTP_RATE_LIMIT_DISABLED` | unset | Set to `1` to disable the `/mcp` and `/health` rate limiters (local dev, or a front proxy that limits instead). The fixed `/register`, `/authorize` and `/token` limits stay on, as in v0.0.16. |
| `MCP_HTTP_DEBUG` | unset | **Local diagnosis only — never set it on a shared deployment.** `1` adds the error message (one line, configured credentials scrubbed, clipped to 200 characters) to the `[loomiomcp] /mcp error:` stderr line, which otherwise names only the error class and status; that message can quote upstream text. |
| `MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL` | unset | Read by the MCP SDK, not by the connector: lets the SDK accept a plain-http OAuth issuer. **Keep it unset.** The connector refuses a non-loopback `http://` `PUBLIC_BASE_URL` before the SDK sees it, so the variable cannot weaken a deployment — it has no use here at all. |
| `LOOMIO_MCP_GROUP_IDS` | unset | Group allow-list (comma-separated positive group ids, e.g. `101,102`; a malformed value is refused at startup). When set, the connector serves ONLY these groups, whatever the API user's memberships: tools naming another group refuse before any upstream call, record reads (discussion, poll, thread, group by key) refuse a record in another group or in none (direct threads), and `list_groups`, `check_connection`, `list_threads`, `search_content`, the participation reports and `get_user_activity`'s samples are filtered to it. Writes addressed by a record cost one read first; comment edits/deletes and replies to a comment, vote or outcome are refused (no b2 read can name their group). The b3 tools are not affected. Unset: everything the API user can see, as before v0.0.17 — and every group a coordinator adds the user to becomes visible to every caller. Recommended on every open-DCR deployment. |
| `LOOMIO_MCP_LOG_VERBOSE` | unset | When `1`, emits structured JSON events to stderr (Cloud Run auto-parses). See OPTIMIZATIONS.md. The key-health events `loomio.auth` and `loomio.version_drift` are **forced** — they are emitted regardless of this flag, and so are `loomio.groups_changed` (the health probe saw the API user's group set, an own admin flag or a group's privacy change since its previous probe in this process; ids and counts only) and `loomio.admin_scope` (the API user holds a group-admin membership: Loomio then sends member e-mails on those rosters). Alert on both. |
| `LOOMIO_MCP_HEALTH_PATH` | `/health` | Where the health page is served. Change it only if the hosting front-end reserves `/health` too (Cloud Run's frontend is known to reserve `/healthz`, which is why the default is `/health`; see the health-check section below); point the uptime check at the same path. Must be an absolute path with no query string. |
| `LOOMIO_B3_API_KEY` | unset | Server-instance admin secret. When set (and the server is not read-only), registers the nine b3 tools: `deactivate_user`, `reactivate_user`, `get_user`, `list_users` and, for Loomio 3.13+, `list_instance_groups`, `list_instance_memberships`, `add_group_members`, `update_membership_roles`, `revoke_membership`. They return **email addresses** for every account and every group roster on the instance, and `add_group_members` sends Loomio's **invitation emails** to any address it is given. **Do not set on a multi-user or open-DCR deployment** — see SECURITY.md. The HTTP server refuses to start when it is set with `MCP_OAUTH_INSECURE_AUTO_APPROVE` on a non-localhost `PUBLIC_BASE_URL` (or a non-loopback `MCP_HTTP_BIND`) and read-only mode off (every self-registered client would get the b3 tools), and warns on a local-only server. |

Tool count per mode: read-only 14, full 24, full + b3 33. The
`tools/list` a client receives is pinned per mode by
`tests/readonly.test.ts`.

Build and deploy (open-DCR + read-only, matching the reference deployment):

```
docker build -t loomiomcp .
gcloud run deploy loomiomcp --image … \
  --set-secrets LOOMIO_API_KEY=loomio-api-key:latest,MCP_OAUTH_SIGNING_KEY=mcp-signing-key:latest \
  --set-env-vars PUBLIC_BASE_URL=https://mcp.example.org,\
MCP_OAUTH_INSECURE_AUTO_APPROVE=1,MCP_OAUTH_I_KNOW_WHAT_IM_DOING=yes,\
MCP_HTTP_TRUST_PROXY=1,MCP_HTTP_RATE_LIMIT_MAX=300,LOOMIO_MCP_READONLY=1,LOOMIO_MCP_LOG_VERBOSE=1,\
MCP_SHARED_EGRESS_CIDRS=160.79.104.0/21
```

`MCP_HTTP_TRUST_PROXY=1` is required on Cloud Run since v0.0.17 (the
default became `0`); add `LOOMIO_MCP_GROUP_IDS=…` to serve only the
groups you mean to publish. The two secrets come from Secret Manager
(create them first; `--set-env-vars` would put the values on a command
line, in shell history and process listings). `MCP_SHARED_EGRESS_CIDRS`
is Anthropic's published egress range for hosted Claude: callers from it
get per-client quotas (SECURITY.md "One source is one address"). To try the image locally, publish the port on
loopback only and let the server listen beyond the container's own
loopback — which makes it a non-loopback bind, so open DCR needs the
acknowledgement even here:

```
# loomiomcp.env (mode 0600, outside the repository):
#   LOOMIO_API_KEY=…
#   MCP_OAUTH_SIGNING_KEY=…   (64 random hex characters, e.g. from
#     node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')
docker run --rm -p 127.0.0.1:8080:8080 --env-file loomiomcp.env -e MCP_HTTP_BIND=0.0.0.0 \
  -e PUBLIC_BASE_URL=http://localhost:8080 \
  -e MCP_OAUTH_INSECURE_AUTO_APPROVE=1 -e MCP_OAUTH_I_KNOW_WHAT_IM_DOING=yes \
  -e LOOMIO_MCP_READONLY=1 loomiomcp
```

`--env-file` keeps the secrets off the command line (`-e KEY=value`
puts them in shell history and process listings); `--rm` deletes the
container — and the environment Docker stores with it — on exit.

For static-client mode instead, drop the three `MCP_OAUTH_INSECURE_*` /
`_I_KNOW_*` vars and set `MCP_OAUTH_CLIENT_ID` + `MCP_OAUTH_CLIENT_SECRET`.
The production stack is managed by Pulumi, not this raw command — see
[Reference deployment](#reference-deployment).

## Upgrading to v0.0.17

v0.0.17 is the security-review release (CHANGELOG.md has every
change). Before rolling it out:

1. **Cloud Run (or any single appending proxy): set
   `MCP_HTTP_TRUST_PROXY=1`.** The default changed from `1` to `0`;
   without it every caller shares the front end's rate-limit and quota
   bucket (the server warns at startup when it sees `K_SERVICE`). Set it
   explicitly BEFORE upgrading so the switch is a no-op.
2. **`MCP_OAUTH_SIGNING_KEY` should be at least 32 characters** (was
   16). A 16–31-character key keeps working, with a startup WARNING,
   until 2027-01-31 00:00 UTC, so the upgrade logs nobody out; the first
   start after that refuses it. Replacing a key logs every user out once,
   so rotate a short one at a quiet moment before the sunset
   (64 random hex characters). Static-client mode: `MCP_OAUTH_CLIENT_SECRET`
   at least 16 characters.
3. **Existing users stay signed in.** Tokens and open-DCR registrations
   issued by v0.0.16 keep working until 2027-01-31 00:00 UTC — unless a
   registration's redirect_uri falls outside the new open-DCR redirect
   policy, which refuses it at once. Claude's callbacks (claude.ai's and
   the announced `https://claude.com/api/mcp/auth_callback`), loopback
   addresses and app schemes (except launcher schemes such as `ms-*`,
   `search-ms:`, `mailto:`) are allowed; list any other https callback
   host your users' clients need in `MCP_OAUTH_REDIRECT_HOSTS`. A user
   refused this way re-adds the connector.
4. **A JSON-RPC batch is refused (400) from clients that declare MCP
   2025-06-18 or later** — that revision removed batching, so a
   conforming client never sends one; older clients keep batches under
   one shared upstream budget.
5. **Bodies over 256 KB are refused** (`MCP_HTTP_JSON_LIMIT`, was 1 MB,
   with a JSON-RPC 413 the client can show), and requests must arrive
   within 10 s (headers) / 30 s (whole). Read-only deployments never
   come near it. **Write-enabled deployments whose users post long
   non-Latin text: set `MCP_HTTP_JSON_LIMIT=1mb`** — a 100 000-character
   comment or description in CJK script is ~300 KB (~600 KB when the
   client `\u`-escapes it) and was accepted by v0.0.16.
6. **Running the image yourself:** a loopback `PUBLIC_BASE_URL` now
   listens on loopback only. In a container, publish on loopback
   (`-p 127.0.0.1:8080:8080`) and set `MCP_HTTP_BIND=0.0.0.0` — which
   counts as a public bind, so open DCR needs the acknowledgement and the
   b3 secret is refused.
7. **New knobs worth setting:** `LOOMIO_MCP_GROUP_IDS` (serve only the
   listed groups), and alerts on the forced `loomio.groups_changed` and
   `loomio.admin_scope` events. The daily quotas, the upstream budget,
   the concurrency cap and the upstream rate window
   (`MCP_HTTP_UPSTREAM_PER_5MIN`, 900 per process per 5 minutes) are on
   by default in the modes they apply to. **Several instances behind one
   egress address:** set `MCP_HTTP_UPSTREAM_PER_5MIN` to 900 ÷ max
   instances, or they can still exceed Loomio's per-address throttle
   together.
8. **Hosted-Claude users share one source address.** claude.ai,
   Claude Desktop and mobile reach the connector from Anthropic's egress
   range (`160.79.104.0/21`), so the per-IP rate limit, the daily quotas
   (new in v0.0.17) and the upstream rate share apply to all of them
   together, per egress address and instance: one user who spends the
   daily quota locks the others on that address out until 00:00 UTC.
   **Set `MCP_SHARED_EGRESS_CIDRS=160.79.104.0/21`** on a deployment
   that serves hosted Claude: callers from that range are then keyed per
   client as well (their own daily quotas and upstream share under an
   address-wide cap). Without it, size `MCP_DAILY_TOOL_CALLS` /
   `MCP_DAILY_RESULT_BYTES` from your busiest address's daily use before
   upgrading.
9. **Read-only deployments no longer return member e-mails** on any
   roster, and an open-DCR deployment answers "hidden" and "not found"
   alike — both by design.
10. **`MCP_HTTP_RATE_LIMIT_DISABLED=1` still leaves the OAuth routes
   throttled** (`/register` 20 per hour, `/authorize` 100 and `/token` 50
   per 15 minutes per address), as in v0.0.16.
11. **Startup is stricter.** `LOOMIO_API_KEY` and `LOOMIO_B3_API_KEY`
   must be printable ASCII without INTERIOR whitespace — a two-line
   secret file or a key with a space inside now stops the server with a
   message that never quotes the value, instead of leaking it through
   every error. Leading and trailing spaces, tabs, CRs and newlines are
   trimmed, exactly as v0.0.16's HTTP client trimmed them on the wire,
   so every key v0.0.16 could use still starts. A malformed `MCP_HTTP_JSON_LIMIT`,
   `MCP_HTTP_TRUST_PROXY`, `MCP_HTTP_BIND`, upstream or quota number,
   `MCP_OAUTH_REDIRECT_HOSTS`, `MCP_SHARED_EGRESS_CIDRS` or
   `LOOMIO_MCP_GROUP_IDS` is a FATAL line too, not a silent default.
12. **`list_threads` under `LOOMIO_MCP_GROUP_IDS` pages differently.**
   It walks Loomio's index itself (≤ 10 calls of 100 rows) and
   `limit` / `offset` count listed-group threads only; `total` is null
   unless the walk reached the end, `scope.page_size` is null, and
   `scope.next_offset` (new in every mode) says where to continue.

## Health check: `GET /health`

Besides the OAuth endpoints and `POST /mcp`, the HTTP server serves an
**unauthenticated** `GET /health` that answers one question: does
Loomio still accept the connector's API key?

```json
{
  "status": "ok",
  "connector_version": "0.0.17",
  "key_status": "valid",
  "loomio_version": "3.13.1",
  "checked_at": "2026-10-24T10:00:00.000Z"
}
```

- **HTTP 200** iff `key_status` is `valid`; **503** with
  `status: "degraded"` for `rejected` (Loomio answered the probe 403
  with its unauthenticated body — the key is dead) and `unreachable`
  (network error, timeout, 5xx, or a CDN/WAF 403 that never reached
  Loomio — the key's state is unknown). 503 for both so a checker rule
  of "HTTP 200 and body contains `"key_status":"valid"`" is the whole
  alert.
- `Cache-Control: no-store` — a cached 200 would defeat the point.
- The probe behind it (`GET /api/b2/groups` with the key, plus the
  public `GET /api/v1/boot/version`) is **cached for 60 s** and shared
  between concurrent callers, so a flood of `/health` hits costs Loomio
  at most one request pair per minute. The endpoint is also under the
  per-IP rate limiter (same `MCP_HTTP_RATE_LIMIT_*` config as `/mcp`,
  separate bucket, per process). `check_connection` uses the same probe but
  wants one at most 10 s old: it reuses a fresher cached probe (and its
  groups body) and otherwise runs a new pair — at most one pair per 10 s
  per process, so a repeated call costs no Loomio request at all.
- Each probe request runs under an **8 s deadline**
  (`HEALTH_PROBE_TIMEOUT_MS`), not the 60 s every tool call keeps.
  Uptime checkers give up after ~10 s, and a hosting platform's own
  request timeout is often 60 s too, so a 60 s probe could never report
  `unreachable` in time: on 2026-10-01 Loomio hung for ~2 minutes,
  `/health` hung with it, the platform answered the checker **504** at
  its own limit and the forced `loomio.auth` event fired a minute late.
  With 8 s the page itself answers **503** `unreachable` (reason
  `timeout`) promptly. Give the checker a request timeout of at least
  10 s so it sees that 503 rather than its own timeout.
- It exposes exactly the five fields above: no key material, no error
  detail (which could quote the base URL), no Loomio hostname, none of
  the groups the probe learned. `loomio_version` stays on purpose:
  Loomio serves the same string to anyone, without a credential, at
  `/api/v1/boot/version`, so it tells a caller nothing new while letting
  a dashboard show what the instance runs; the hostname, which would
  identify the instance, is what is withheld.
- The same probe runs once at startup (after `listen`) and logs
  `[loomiomcp] Loomio key_status=… loomio_version=…`, with a WARNING
  paragraph when the key is rejected. The server keeps serving either
  way — a crash-looping container tells you nothing; a live one with a
  red `/health` and classified 403s tells you everything.
- **Verify the path reaches the container before trusting an alert.**
  Some hosting front-ends reserve `/healthz` (Cloud Run's does) and answer it with their
  own 404 before the request reaches the container (this has been
  observed on Cloud Run's `*.run.app` URL). An uptime check against such
  a path fails closed forever — 404 is not 200 and has no content match
  — and the one thing the check exists to detect stays undetected while
  the alert trains everyone to ignore it. After deploying, `curl -si
  https://<PUBLIC_BASE_URL>/health` and confirm the body is the
  connector's JSON (`connector_version`, `key_status`), not an HTML
  page. If it is the platform's 404, set `LOOMIO_MCP_HEALTH_PATH` (e.g.
  `/-/health`) on the deployment and point the checker at that path;
  the default page is then no longer served.

**Recommended monitoring.** Create an uptime check (Cloud Monitoring, or
any external checker) against `https://<PUBLIC_BASE_URL>/health` every
**5 minutes**, protocol HTTPS, a request timeout of **10 s** (the probe
answers within 8 s even when Loomio hangs), expecting **HTTP 200** *and*
a content match on `"key_status":"valid"`, with an alert policy that
notifies a channel someone reads. Connector traffic is often too sparse for a
log-based error-rate alert to ever have enough samples; the active probe
is what turns a silent 403 outage into an alert within minutes. As a
second signal, alert on the forced log event `loomio.auth` with
`key_status != "valid"` (it fires on every status change), and note
`loomio.version_drift` — it means the instance moved to a Loomio
`major.minor` this connector has not been verified against. Alert as
well on the forced `loomio.groups_changed` (the API user joined or left
a group, gained or lost an admin role, or a group's privacy changed —
exposure changed without the operator) and `loomio.admin_scope` (the
API user is a group admin, so Loomio sends member e-mails on those
rosters). Both are per process and compare with that process's
previous probe: the uptime check above is what makes the probe run.

## API key lifecycle (runbook)

The Loomio API key is not a permanent credential. Loomio regenerates a
user's key:

- **whenever that user's password changes** (Loomio ≥ 3.1.0;
  `UserService.rotate_credentials_after_password_change` also rotates the
  user's other tokens and signs out other sessions) — the API access page
  in Loomio says so;
- **once for every user, on the upgrade to Loomio 3.3.1** (August 2026;
  migration `RotateExposedUserApiKeys`, because group data exports had
  contained keys);
- when the account is redacted, and — for authentication purposes —
  when the user is deactivated (`User.active` no longer matches).

**Symptom.** Every call fails with
`403 {"error":"You are not authorized to access this page."}` — the
same body for every endpoint, because `authenticate_api_key!` runs before
anything else. Nothing else is wrong; the process is up. The connector
recognises this body and says "key rejected, probably rotated" with the
steps below; on the HTTP transport `/health` goes 503 with
`key_status: "rejected"`, the startup log / stderr carries the same
warning, and `check_connection` reports it to the AI caller with the
remediation in `notes`.

**Check.** `GET /health` on the connector, or directly
`GET https://<loomio>/api/b2/groups` with
`Authorization: Bearer <key>` — 200 means the key is valid (even for a
user with no groups), 403 means it is not.

**Fix.**

1. Sign in to Loomio **as the connector's user** and open the **API
   access** page (`/profile/api_access`). It shows the current key. No
   API can read another user's key — the b3 Server API's user payload
   does not include it, and the User API only ever authenticates with
   the caller's own — so this step needs that user's login (or an
   instance admin's "sign in as" if the instance offers it).
2. Put the new value in the deployment's secret (`LOOMIO_API_KEY`) and
   redeploy / restart. Outstanding OAuth tokens stay valid — they prove
   caller identity to the connector, not to Loomio.
3. Confirm `/health` returns 200 with `"key_status":"valid"`.

**Avoid the next one.** Do not change the connector user's password
casually — pair any password change with the secret rotation above in
one change. Read Loomio's release notes before the instance upgrades
(the 3.3.1 notes announced the rotation; Loomio has no other
compatibility policy). Keep the uptime check above in place so a
rotation you did not cause is noticed in minutes, not weeks.

**Rotate on suspicion, not only on failure.** A leaked key keeps
working and nothing reports it: Loomio has no API-key usage log, and
`/health` only notices a key that stopped working. Whoever holds the key
acts as the connector's user directly on Loomio — unredacted reads,
writes wherever its role allows — bypassing read-only mode and every
other connector-side control (SECURITY.md "API key handling"). Rotate
it by changing the connector user's password (step 1 above then shows
the new key) whenever it may have been exposed — a log, a screenshot, a
chat or AI-agent transcript, an agent's or editor's permission
allow-list, a shared or synced copy of an MCP host's config, a shell
history, a CI log — after any incident on a machine or account
that held it, when someone with access leaves, and on a schedule. Then
look at what the user authored recently (`search_content` with
`author_id` = the user's id from `check_connection`): a read-only
deployment authors nothing, so anything there is foreign. **With
`LOOMIO_MCP_GROUP_IDS` set that search hides items in unlisted groups
and direct threads** — exactly where a leaked key can post unseen — so
ask Loomio directly instead: `GET /api/b2/search?author_id=<id>` with
`Authorization: Bearer` read from a 0600 file (`curl -H @header-file`),
or run a local connector without the allow-list. Never type
the key into a command line (`VAR=key ./script`, `curl -H "…: Bearer
key"`): it lands in shell history and process listings — read it from a
file or stdin.

To invalidate every outstanding OAuth token at once, rotate
`MCP_OAUTH_SIGNING_KEY` — every issued token, open-DCR client
registration and pending authorization code becomes unverifiable. There
is no per-token revocation and refresh tokens are not rotated on use (a
stateless server has nowhere to record reuse), so a stolen refresh token
works until it expires; since v0.0.17 every refresh chain ends 90 days
after the user last completed `/authorize`, after which the user
authorizes again. In static-client mode every refresh also presents
`MCP_OAUTH_CLIENT_SECRET`, so rotating that secret is an immediate
cut-off as well.

**Legacy OAuth artefacts.** v0.0.17 signs with a separate derived key
per artefact kind (wire format `v2.…`). Tokens and open-DCR client
registrations issued by v0.0.16 and earlier keep working, unchanged,
until **2027-01-31 00:00 UTC** and are refused from then on: the MCP
client re-registers and each user authorizes once more. A v0.0.16
registration whose redirect_uri the new policy refuses (see
`MCP_OAUTH_REDIRECT_HOSTS`) stops working immediately.

## Loomio behind a CDN / WAF

Every outbound request carries `User-Agent: loomiomcp/<version>`. If the
Loomio instance sits behind Cloudflare or another WAF that blocks
non-browser user-agents, allow that one. The connector tells a WAF 403
apart from a Loomio 403 (Loomio's are always JSON; Cloudflare's problem
body names cloudflare) and reports it as "blocked in front of Loomio —
check WAF rules", with `/health` showing `unreachable` rather than
`rejected`.

## Reference deployment

The connector is designed for Cloud Run (or any container host) behind
its own OAuth-at-the-edge layer, with `LOOMIO_API_KEY` and
`MCP_OAUTH_SIGNING_KEY` held in a secret manager and injected as env
vars. A production-grade setup wires that up with an IaC tool (e.g.
Pulumi): KMS-backed secrets, bootstrap scripts for the API key /
signing key / OAuth client, an uptime check on `/health` with an alert
policy (see above), and a smoke test that walks the full OAuth dance
against the deployed endpoint **and** makes one round-trip to Loomio
through a tool call. `check_connection` is the natural smoke call —
it throws or reports `key_status` explicitly and costs one request pair
— or a shape-only assertion on `list_discussions` for a known group.
None of that is connector-specific beyond the env vars documented above.

## Image build

A `Dockerfile` ships in this repo for a direct `docker build`. For
local stdio use no container is needed at all — `npx loomiomcp` runs
the published package (published with npm provenance; SECURITY.md
"Supply chain").

The base image is pinned by digest (`node:22-slim@sha256:…`), so a
build of a given commit uses the same base until the pin is bumped
(Dependabot proposes it weekly). Label the image with its source commit
and deploy it by digest:

```
docker build --build-arg VCS_REF="$(git rev-parse HEAD)" -t loomiomcp:v0.0.17 .
```

Build from a release tag or a full commit SHA rather than a branch,
and record the resulting image digest in reviewed deployment
configuration: a mutable tag such as `:latest` lets whoever can push it
change what the next deploy runs, with no record of the commit.
