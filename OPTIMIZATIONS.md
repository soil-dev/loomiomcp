# Optimisations & observability

Running record of performance / observability work on loomiomcp. The
companion of CHANGELOG (per-version changes) and DESIGN (load-bearing
architecture choices).

---

## 1. Structured event logging *(landed)*

### What

Three event types that give per-call visibility into runtime
behaviour, emitted as single-line JSON to stderr and gated on
`LOOMIO_MCP_LOG_VERBOSE=1`.

| Event | Fires | Fields |
|---|---|---|
| `tool.call` | Once per tool invocation | `tool`, `clientId?`, `argFields` (field names only — never values), `durationMs`, `outcome` (`success` / `error`) |
| `loomio.request` | Once per outbound Loomio API call | `method`, `path` (redacted: numeric IDs → `:id`, query stripped), `status`, `durationMs`, `responseBytes` |
| `tool.chain` | Once per `/mcp` POST request (HTTP transport only) | `clientId?`, `tools` (sequence of tool names), `toolCount`, `loomioCalls`, `durationMs` |

All three are wired through `src/log.ts`. The aggregate `tool.chain`
event uses an `AsyncLocalStorage` request context (set up by
`withRequestContext` in `src/http/transport.ts`) so the same `/mcp`
request's tool calls and outbound API calls land in one summary line.

**Edge case: fetch-level failures.** When the outbound `fetch` itself
throws (DNS failure, refused connection, timeout before headers),
`loomio.request` doesn't fire — we only emit when we have a response
status to log. `tool.call` still fires with `outcome: "error"`, so the
*tool* failure is always visible. Mostly it doesn't matter; in the
rare case where you need to distinguish "Loomio returned 5xx" from
"we couldn't reach Loomio at all", check the surrounding stderr for
the unstructured error message.

### Privacy invariants (load-bearing)

- **Tool arguments are never logged** — only the field NAMES that
  were present (`argFields: ["group_id", "status", "limit"]`). Poll
  options, discussion bodies, comment text, member emails stay out
  of operator logs.
- **Loomio API paths are redacted**: `/b2/discussions/254022621` →
  `/b2/discussions/:id`. Query strings (which include the api_key)
  are dropped entirely.
- **No request / response bodies, ever.** Verbose mode unlocks
  per-call shape and timing, not Loomio data.

### Why opt-in

At default-off, zero cost. At verbose-on, each `/mcp` request emits
~3–6 events × ~200 bytes = ~1 KB. A busy day (~1000 requests) adds
about 1 MB to log ingest — fractions of a cent on Cloud Logging
pricing. The reason it's off by default is hygiene, not cost:
production logs shouldn't carry per-call detail unless someone is
actively investigating.

The intended pattern: flip `LOOMIO_MCP_LOG_VERBOSE=1` on a Cloud Run
revision for a few hours of real traffic, gather data, flip back.
Cloud Logging retains the events well past the verbose-on window so
queries keep working for weeks.

### Enabling

**Cloud Run.** Set the env var on the service:

```sh
gcloud run services update loomiomcp \
  --update-env-vars=LOOMIO_MCP_LOG_VERBOSE=1 \
  --project=<your-gcp-project> --region=<your-region>
```

To disable: `--remove-env-vars=LOOMIO_MCP_LOG_VERBOSE`.

**Local stdio.** Set in the parent process (Claude Desktop config,
shell, etc.). Events land on stderr and don't collide with MCP
JSON-RPC traffic on stdout:

```jsonc
{
  "mcpServers": {
    "loomiomcp": {
      "command": "npx",
      "args": ["loomiomcp"],
      "env": {
        "LOOMIO_API_KEY": "…",
        "LOOMIO_MCP_LOG_VERBOSE": "1"
      }
    }
  }
}
```

Pipe stderr to a file if you want to query it (Claude Desktop writes
MCP server stderr to its own logs; check the app's log directory).

---

## 2. Usage-analysis queries (Cloud Run)

All examples assume Cloud Run; substitute `<your-gcp-project>` and
`<your-region>`.

### Top tools by invocation count (last 7 days)

```sh
gcloud logging read \
  'jsonPayload.event="tool.call"' \
  --project=<your-gcp-project> --freshness=7d \
  --format='value(jsonPayload.tool)' \
  | sort | uniq -c | sort -rn | head -20
```

Cross-checks against your intuition about which surfaces matter
(e.g. is `manage_memberships` actually being used, or is everyone
just listing?).

### Top Loomio endpoints by call count

```sh
gcloud logging read \
  'jsonPayload.event="loomio.request"' \
  --project=<your-gcp-project> --freshness=7d \
  --format='value(jsonPayload.method, jsonPayload.path)' \
  | sort | uniq -c | sort -rn | head -20
```

The redaction means duplicates at `/b2/discussions/:id` collapse
together, so this is a true endpoint histogram.

### p50 / p95 latency per Loomio endpoint (last 24h)

```sh
gcloud logging read \
  'jsonPayload.event="loomio.request"' \
  --project=<your-gcp-project> --freshness=24h \
  --format='value(jsonPayload.path, jsonPayload.durationMs)' \
  | python3 -c "
import sys, statistics
from collections import defaultdict
by_path = defaultdict(list)
for line in sys.stdin:
    parts = line.strip().split()
    if len(parts) != 2: continue
    path, ms = parts[0], int(parts[1])
    by_path[path].append(ms)
for path, samples in sorted(by_path.items()):
    p50 = statistics.median(samples)
    p95 = statistics.quantiles(samples, n=20)[18] if len(samples) > 5 else max(samples)
    print(f'{path:40s} n={len(samples):5d} p50={p50:5.0f}ms p95={p95:5.0f}ms')
"
```

Useful for spotting (a) slow endpoints in absolute terms and (b)
endpoints that are slow *and* called often.

### Error rate per tool

```sh
gcloud logging read \
  'jsonPayload.event="tool.call"' \
  --project=<your-gcp-project> --freshness=7d \
  --format='value(jsonPayload.tool, jsonPayload.outcome)' \
  | python3 -c "
import sys
from collections import Counter, defaultdict
counts = defaultdict(lambda: Counter())
for line in sys.stdin:
    parts = line.strip().split()
    if len(parts) != 2: continue
    counts[parts[0]][parts[1]] += 1
for tool in sorted(counts):
    s, e = counts[tool]['success'], counts[tool]['error']
    n = s + e
    rate = e / n if n else 0
    print(f'{tool:30s} n={n:5d} errors={e:4d} rate={rate:.1%}')
"
```

A tool with consistently high error rate is either misdocumented in
its schema (callers send the wrong shape), broken against the live
API (e.g. a Loomio response shape change), or being driven by an LLM
that's hallucinating arguments. The argument-field histogram below
helps disambiguate.

### Argument-field shapes per tool

```sh
gcloud logging read \
  'jsonPayload.event="tool.call" AND jsonPayload.tool="list_polls"' \
  --project=<your-gcp-project> --freshness=7d \
  --format='value(jsonPayload.argFields)' \
  | sort | uniq -c | sort -rn | head -10
```

Replace `"list_polls"` with any tool name. Shows the distribution of
*which fields* callers populate. If 95% of `list_polls` calls don't
supply `limit`, the default-50 behaviour is doing most of the work
and pagination is rare. If 80% supply `status`, the default isn't
matching expectations.

### Chain depth — how many tools per /mcp request

```sh
gcloud logging read \
  'jsonPayload.event="tool.chain"' \
  --project=<your-gcp-project> --freshness=7d \
  --format='value(jsonPayload.toolCount)' \
  | sort -n | uniq -c
```

Most chains for typical Loomio flows are 1–3 tools. Long tails
(15+ tools in a single request) usually mean the LLM is hunting
for context — possibly a sign that a new aggregate tool would help.

### N+1 detector — repeated same-tool calls within one chain

A `tool.chain` showing `tools: ["get_discussion", "get_discussion", "get_discussion", …]`
is the pattern that should be a list/batch tool instead. There's no
batch tool in loomiomcp today, but this query identifies whether
adding one would pay off:

```sh
gcloud logging read \
  'jsonPayload.event="tool.chain"' \
  --project=<your-gcp-project> --freshness=7d \
  --format='value(jsonPayload.tools)' \
  | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        tools = json.loads(line.strip())
    except Exception:
        continue
    if not tools: continue
    runs = []
    cur, n = tools[0], 1
    for t in tools[1:]:
        if t == cur: n += 1
        else:
            if n > 3: runs.append((cur, n))
            cur, n = t, 1
    if n > 3: runs.append((cur, n))
    for tool, length in runs:
        print(f'{tool} x{length}')
" | sort | uniq -c | sort -rn | head -20
```

If `get_discussion x10+` shows up often, the case for a `get_discussions`
batch tool is empirical, not hypothetical.

Note that `list_groups` legitimately fans out 50–200 outbound calls
per invocation by design; that's not an N+1, it's the documented
workaround for Loomio's missing groups index endpoint. See
NOTES-ON-LOOMIO-API.md → "Gotcha 4".

### Read vs write traffic mix

```sh
gcloud logging read \
  'jsonPayload.event="tool.call"' \
  --project=<your-gcp-project> --freshness=7d \
  --format='value(jsonPayload.tool)' \
  | awk '/^(get_|list_)/ {r++} /^(create_|manage_|deactivate_|reactivate_)/ {w++}
         END {print "reads:", r, "writes:", w, "ratio:", w/(r+w)}'
```

Informs whether the connector is mostly read traffic (then Cloud Run
in readonly is sufficient for most users) or whether writes are
common enough that the readonly remote is a real limitation.

### Active clientId distribution (HTTP transport)

```sh
gcloud logging read \
  'jsonPayload.event="tool.chain"' \
  --project=<your-gcp-project> --freshness=7d \
  --format='value(jsonPayload.clientId)' \
  | sort | uniq -c | sort -rn | head -20
```

OAuth clientIds are stable per registered MCP client, so this is
"who's using the connector this week". Useful for capacity planning
and for spotting a single misbehaving client driving anomalous load.

---

## 3. Local / stdio analysis

The same events fire on stdio when `LOOMIO_MCP_LOG_VERBOSE=1`, but
without `tool.chain` (stdio is a long-lived connection, not a series
of discrete `/mcp` requests). The other two events are sufficient
for local investigation:

```sh
# Tail and pretty-print events from a stdio session.
tail -f ~/Library/Logs/Claude/mcp-server-loomiomcp.log \
  | grep '^{' \
  | jq -c 'select(.event)'
```

Path may vary per host (Claude Desktop on macOS, Claude Code's stderr
redirect, etc.). The discriminator is `^{` (lines that start as JSON)
to skip non-event log noise.

---

## 4. Planned candidates *(not yet landed)*

### a. Per-tool latency histograms in `tool.call`

Currently we emit `durationMs` per call. To get histogram buckets
without server-side aggregation we'd need either (a) a sampled
bucket-id field, or (b) Cloud Logging metric extraction. Option (b)
is operator-side, not a code change — left to the deployment.

### b. Retry-on-429 instrumentation

If Loomio starts rate-limiting (none observed so far), add a
`retriedAfter429: true` field on `loomio.request` so the queries
above can quantify retry traffic. Not needed until 429s show up in
the logs. See NOTES-ON-LOOMIO-API.md → "Things we don't know yet"
for the current state of rate-limit-header knowledge.

### c. Batch fan-out helper

If a future `batch_manage_memberships` (across groups) lands, the
capsulemcp sibling's `src/capsule/batch.ts` is the reference shape:
concurrency-capped `Promise.allSettled` plus an always-on
`batch.complete` event with per-item success/failure counts.

---

## Methodology

Two rules to keep the data trustworthy:

1. **Measure end-to-end, not internal.** Cloud Run's
   `httpRequest.latency` is what the OAuth-authenticated MCP client
   actually experiences. The `loomio.request.durationMs` field
   captures just the outbound Loomio call — useful for diagnosing
   "is Loomio slow or are we slow" but not a substitute for the
   transport metric.

2. **Verbose-on for hours, not days.** The events are designed for
   investigation windows. Permanent verbose-on conflates noisy
   per-call detail with the operational signal you usually want
   (errors, restarts, cold starts) and bloats Cloud Logging.
