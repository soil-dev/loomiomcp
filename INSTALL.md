# Install

## Prerequisites

- Node.js ≥ 22
- A Loomio API key — copy it from the user's **API access** page in
  Loomio (`/profile/api_access`)

## From npm (recommended)

```
npx loomiomcp
```

Set `LOOMIO_API_KEY` in the environment your MCP host uses to launch
the binary.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `LOOMIO_API_KEY` | yes | Per-user Loomio API key (the user's API access page, `/profile/api_access`). Sent as `Authorization: Bearer …` on every outbound call. **Loomio regenerates it when that user's password changes** (and did so for every user in Loomio 3.3.1); the connector detects a rejected key at startup and says so on stderr. |
| `LOOMIO_API_BASE_URL` | no | Loomio API root. Defaults to `https://www.loomio.com/api`; override for self-hosted instances, e.g. `https://loomio.example.org/api`. Override is gated to `https://` or loopback `http://`. |
| `LOOMIO_MCP_READONLY` | no | Set to `1` to skip every write tool at registration. |
| `LOOMIO_B3_API_KEY` | no | Opt-in for Loomio instance operators only. Enables `deactivate_user` / `reactivate_user`. See [DEPLOY.md](DEPLOY.md) and [SECURITY.md](SECURITY.md) before setting on any shared deployment. |
| `LOOMIO_MCP_LOG_VERBOSE` | no | Set to `1` to emit structured per-call JSON events to stderr. See [OPTIMIZATIONS.md](OPTIMIZATIONS.md). |

## Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "loomio": {
      "command": "npx",
      "args": ["-y", "loomiomcp"],
      "env": {
        "LOOMIO_API_KEY": "…"
      }
    }
  }
}
```

For read-only mode add `"LOOMIO_MCP_READONLY": "1"`.

## Claude Code

```
claude mcp add loomio -- npx -y loomiomcp
```

Set `LOOMIO_API_KEY` in your shell environment, or pass `-e
LOOMIO_API_KEY=…`.

## From source

```
git clone https://github.com/soil-dev/loomiomcp
cd loomiomcp
npm install
npm run build
LOOMIO_API_KEY=… node dist/index.js
```

## Remote (Cloud Run)

See DEPLOY.md.

## Troubleshooting

The connector reads Loomio's error bodies and puts the diagnosis in the
error message itself (Loomio ≥ 3.1.1 answers 403 with a body that says
why). Read the message first; this table is the short version.

| Symptom | Most likely cause |
|---|---|
| Startup line `[loomiomcp] WARNING: Loomio rejected the connector's API key …` on stderr | The key was **rotated** — Loomio regenerates a user's key when that user's password changes (and rotated every key once in 3.3.1). Copy the current key from the user's API access page (`/profile/api_access`) into `LOOMIO_API_KEY` and restart. The server keeps running so every tool call fails with the same explanation. |
| Every b2 tool call: `403 … "You are not authorized to access this page." … UNAUTHENTICATED` | Same as above: no active Loomio user owns this key. Check with `GET /api/b2/groups` using the key (200 = valid). (`deactivate_user` / `reactivate_user` keep working — they authenticate with a different secret; see the next row.) |
| `deactivate_user` / `reactivate_user` only: `403 … Loomio's b3 Server API rejected the bearer secret` | `LOOMIO_B3_API_KEY` does not equal `ENV['B3_API_KEY']` on the Loomio server, or that variable is unset / 16 characters or shorter there. Unrelated to `LOOMIO_API_KEY`, password rotation and `/health` (which probes the b2 key); compare the two values with the instance operator and fix the deployment secret. |
| One `list_discussions` / `list_polls` call: the same generic 403, but other calls work | Those two `?group_id=` lists return the generic body when the **group is not visible** to the connector's user (a private group it is not a member of). Check the id and the user's memberships. No other endpoint does this: `list_memberships` answers a non-member `200 []`, and record reads answer `"Not authorized to …"` — the generic body anywhere else means the key was rejected. |
| `403 … "Not authorized to <action> <Model>."` | Key is fine; the connector's user lacks permission for that record or action (e.g. reading a private discussion in a group it is not a member of). |
| `403 … "User is not an admin"` (`manage_memberships`) | The connector's user is not an **admin (coordinator) of that group**. Parent-group admin and instance admin do not count. |
| `403 … answered by a CDN/WAF in front of Loomio` | Cloudflare or another WAF blocked the request before Loomio saw it. Allow `User-Agent: loomiomcp/<version>` in its rules; the key was never evaluated. |
| `HTTP 401` on a `/b2/` or `/b3/` path | Not from Loomio — its b2/b3 API answers every authentication failure with 403. Something in front (a proxy, CDN or basic-auth gate) wants its own credentials; check `LOOMIO_API_BASE_URL`. |
| `HTTP 401` on a `/v1/` path | Loomio's v1 (browser) API can answer 401 itself — `"you gotta be signed in"` — for endpoints that need a browser session; the API key is not a v1 credential. The connector's current v1 calls (`/v1/groups/{id}`, `/v1/boot/version`) do not carry that guard, so check the proxy first, but the message names both possibilities. |
| `list_memberships` returns an empty list with `scope.note` | The connector's user is **not a member** of that group (or the group is hidden from it). Loomio answers 200 with an empty list in that case, not 403. A real group always has at least its creator. |
| `list_events` / `get_user_activity`: "Loomio removed the v1/events endpoint (Loomio ≥ 3.4.0) …" | Known limitation: those two tools read an endpoint Loomio ≥ 3.4.0 no longer has. They fail loudly rather than return empty data; the port to `GET /api/b2/threads/{topic_id}/items` is planned for 0.0.12. |
| `list_groups` returns nothing, with `scanned.note` | Either no group in the scanned range is visible to the user, or the visible ones have **no polls** (the probe only sees groups through their polls). If the key were rejected the tool throws instead. |
| `404 Not Found` | No such group / discussion / poll with the given id (Loomio hides nothing behind 404 except missing records). |
| `429` (`Loomio rate limit hit …`) | Loomio's Rack::Attack throttle: 900 requests per 5 minutes per client IP by default. The fan-out tools (`list_groups`, `get_user_activity`) are the usual cause; wait for the `Retry-After` (if given) or a few minutes. |
| `504` | Loomio API slow or hung; the connector aborts the outbound request after 60s. Retry after a short wait. |
