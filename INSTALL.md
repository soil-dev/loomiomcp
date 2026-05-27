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
