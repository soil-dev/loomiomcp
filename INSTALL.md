# Install

## Prerequisites

- Node.js ≥ 22
- A Loomio API key (profile → API keys)

## From npm (recommended)

```
npx loomiomcp
```

Set `LOOMIO_API_KEY` in the environment your MCP host uses to launch
the binary.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `LOOMIO_API_KEY` | yes | Per-user Loomio API key (profile → API keys). Passed as `?api_key=…` on every outbound call. |
| `LOOMIO_API_BASE_URL` | no | Loomio API root. Defaults to `https://www.loomio.com/api`; override for self-hosted instances like `https://openssl-communities.org/api`. Override is gated to `https://` or loopback `http://`. |
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

| Symptom | Most likely cause |
|---|---|
| `401 Unauthorized` | Bad or revoked `LOOMIO_API_KEY`. Regenerate in Loomio under profile → API keys. |
| `403 Forbidden` | API key is valid but the user isn't a member (or for `list_memberships` / `manage_memberships`: isn't a group admin). |
| `404 Not Found` | No such group / discussion / poll with the given id, or the user can't see it. |
| `504` | Loomio API slow or hung; the connector aborts the outbound request after 60s. Retry after a short wait. |
