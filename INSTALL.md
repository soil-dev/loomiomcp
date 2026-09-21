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
| `LOOMIO_API_KEY` | yes | Per-user Loomio API key (the user's API access page, `/profile/api_access`). Sent as `Authorization: Bearer …` on every outbound call. **Loomio regenerates it when that user's password changes** (and did so for every user in Loomio 3.3.1); the connector detects a rejected key at startup and says so on stderr, and `check_connection` tells the AI caller. |
| `LOOMIO_API_BASE_URL` | no | Loomio API root. Defaults to `https://www.loomio.com/api`; override for self-hosted instances, e.g. `https://loomio.example.org/api`. Override is gated to `https://` or loopback `http://`. The same value minus `/api` is the base of every `url` the tools return. |
| `LOOMIO_MCP_READONLY` | no | Set to `1` to register only the 14 read tools: every `create_*` / `update_*` / `delete_*` / `manage_*` tool and every b3 tool is skipped, and the client refuses a write before any request is made. |
| `LOOMIO_B3_API_KEY` | no | Opt-in for Loomio instance operators only. Enables `deactivate_user`, `reactivate_user`, `get_user` and `list_users` (the last two return **email addresses** for any account on the instance — single-tenant deployments only). Not registered in read-only mode. See [DEPLOY.md](DEPLOY.md) and [SECURITY.md](SECURITY.md) before setting on any shared deployment. |
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

## First call

Ask the model to "check the Loomio connection" — it calls
`check_connection`, which reports the key verdict, the account the key
belongs to, its groups and any problem in fixed wording. If that tool
answers, everything else will.

## Troubleshooting

The connector reads Loomio's error bodies and puts the diagnosis in the
error message itself (Loomio ≥ 3.1.1 answers 403 with a body that says
why). Read the message first; this table is the short version.

| Symptom | Most likely cause |
|---|---|
| Startup line `[loomiomcp] WARNING: Loomio rejected the connector's API key …` on stderr | The key was **rotated** — Loomio regenerates a user's key when that user's password changes (and rotated every key once in 3.3.1). Copy the current key from the user's API access page (`/profile/api_access`) into `LOOMIO_API_KEY` and restart. The server keeps running so every tool call fails with the same explanation, and `check_connection` reports `key_status: "rejected"`. |
| Every b2 tool call: `403 … "You are not authorized to access this page." … UNAUTHENTICATED` | Same as above: no active Loomio user owns this key. Check with `GET /api/b2/groups` using the key (200 = valid). (The b3 tools keep working — they authenticate with a different secret; see the next row.) |
| b3 tools only (`deactivate_user`, `reactivate_user`, `get_user`, `list_users`): `403 … Loomio's b3 Server API rejected the bearer secret` | `LOOMIO_B3_API_KEY` does not equal `ENV['B3_API_KEY']` on the Loomio server, or that variable is unset / 16 characters or shorter there. Unrelated to `LOOMIO_API_KEY`, password rotation and `/health` (which probes the b2 key); compare the two values with the instance operator and fix the deployment secret. |
| One `list_discussions` / `list_polls` call: the same generic 403, but other calls work | Those two `?group_id=` lists return the generic body when the **group is not visible** to the connector's user (a private group it is not a member of). Check the id and the user's memberships (`check_connection` lists them). No other endpoint does this: `list_memberships` answers a non-member `200 []`, record reads answer `"Not authorized to …"`, and the threads / search / reports / groups endpoints filter or 404 — the generic body anywhere else means the key was rejected. |
| `403 … "Not authorized to show Group."` from `get_group` | The key is fine and the group exists, but it is hidden from the connector's user (not publicly visible, user not a member). An unknown id / key / handle answers 404 instead, so this is a permissions gap, not a typo. |
| `403 … "Not authorized to <action> <Model>."` | Key is fine; the connector's user lacks permission for that record or action (reading a private discussion in a group it is not in; editing a thread it did not author; editing a closed poll). |
| `403 … "User is not an admin"` (`manage_memberships`) | The connector's user is not an **admin (coordinator) of that group**. Parent-group admin and instance admin do not count. |
| `403 … answered by a CDN/WAF in front of Loomio` | Cloudflare or another WAF blocked the request before Loomio saw it. Allow `User-Agent: loomiomcp/<version>` in its rules; the key was never evaluated. |
| `HTTP 401` on a `/b2/` or `/b3/` path | Not from Loomio — its b2/b3 API answers every authentication failure with 403. Something in front (a proxy, CDN or basic-auth gate) wants its own credentials; check `LOOMIO_API_BASE_URL`. |
| `HTTP 401` on the `/v1/boot/version` path | The connector's only v1 call is that public version lookup, which carries no session guard — so a 401 there is a proxy or basic-auth gate in front of Loomio. It only affects `loomio_version` (null); the key verdict is unaffected. |
| `404 … thread not found or not visible to the connector's user` from `list_thread_items` / `get_thread_markdown` | Either no thread has that `topic_id`, or it is a private thread in a group the user is not in — Loomio answers 404 for both. Check that you passed the THREAD id (`topic_id` on the discussion / poll record), not the discussion's or poll's own id. |
| `list_memberships` returns an empty list with `scope.note` | The connector's user is **not a member** of that group (or the group is hidden from it). Loomio answers 200 with an empty list in that case, not 403. A real group always has at least its creator. |
| `list_groups` returns `groups: []` with a valid key | The user is in no group. `check_connection` says so explicitly. Publicly visible groups remain readable by id (`get_group`, `list_discussions`, `list_polls`) and their threads appear in `list_threads` / `search_content`. |
| `get_participation_report` / `get_user_activity`: a requested group appears in `groups_not_visible` | Loomio's report silently drops groups the connector's user is not a member of and echoes the effective set; the counts exclude those groups. Add the user to the group, or drop the id. |
| `get_user_activity` throws "could not read Loomio's participation report for any of the requested groups" | Every report call failed (network / 5xx, or a rotated key — the message quotes the last error). The tool never returns zeros for a scan that counted nothing. |
| `search_content` returns exactly 20 results with `capped: true` | Loomio's hard cap (`SearchQuery::RESULT_LIMIT`); there is no paging or total. Narrow the query, `types`, `group_id` or `author_id`. |
| `create_discussion` / `create_poll` throws "Loomio created … not the requested group" | The misdirected-write guard: Loomio's echo disagreed with the request on where the record went. The record exists — review it with `get_discussion` / `get_poll` and discard it with `delete_*` if misplaced — and report the case; it means the write body was not read as intended by this Loomio version. |
| `create_poll` refused at the schema: "needs at least N options" | Loomio has no default options through the API — a proposal without `options` would be saved unusable. Pass Loomio's option keys (`agree`, `abstain`, `disagree`, `block`, …). |
| `422 … must be public` / `must be private` on `create_discussion` / `update_discussion` | The `private` value contradicts the group's `discussion_privacy_options`. Omit `private` to take the group's default. |
| `400 {"error":400}` on a write | A parameter Loomio's `PermittedParams` does not list reached the request. The tools send only permitted keys, so this indicates a Loomio version whose permitted set differs from 3.8.1 — check `check_connection`'s version note. |
| `404 Not Found` elsewhere | No such group / discussion / poll / comment / user with the given id (Loomio hides nothing behind 404 except missing records — and, on the thread routes, invisible ones, see above). |
| `429` (`Loomio rate limit hit …`) | Loomio's Rack::Attack throttle: 900 requests per 5 minutes per client IP by default. Rapid tool chains, or `get_user_activity` over many groups (one report call per group), are the usual cause; wait for the `Retry-After` (if given) or a few minutes. |
| `504` | Loomio API slow or hung; the connector aborts the outbound request after 60s. Retry after a short wait. |
| Absent `stance_counts` / `results` on a poll | Not an error: `results_visible: false` with `results_hidden_reason` `until_vote` or `until_closed` means Loomio hides the tallies from a user who has not voted (or until the poll closes) and the connector stripped them. Absent means hidden, not zero. |
