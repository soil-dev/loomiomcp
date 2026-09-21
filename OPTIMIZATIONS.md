# Optimisations & observability

Running record of performance / observability work on loomiomcp. The
companion of CHANGELOG (per-version changes) and DESIGN (load-bearing
architecture choices).

---

## 1. Upstream cost per tool *(0.0.12)*

The rule: one Loomio request when one suffices, never a fan-out where
Loomio offers an aggregate, and bytes trimmed upstream (`exclude_types`
/ `compact=1`) before they are trimmed here (slimming, truncation).
Every collection surfaces Loomio's exact `meta.total` so "how many"
never needs a second page. Verified against Loomio 3.8.1.

| Tool | Loomio requests | Read profile sent | Bytes controls |
|---|---|---|---|
| `check_connection` | the health probe (1 authenticated `GET /b2/groups` + 1 public `GET /v1/boot/version`); its groups body is reused | `exclude_types=tag translation` | fixed-size summary |
| `list_groups` | 1 (`GET /b2/groups`) | `exclude_types=tag translation` | slim group rows |
| `get_group` | 1 | `exclude_types=tag translation` | attachments / cover urls dropped |
| `list_discussions` | 1 | `exclude_types=group parent membership reaction translation` (keeps `topics` — with their `tags` field, which excluding `tag` would strip) | `description_max_chars` (default 1500; an HTML body over the cap loses its tag attributes first — `rel` / `target` / heading `id` — so the cap carries content), slim users |
| `get_discussion` | 1 (2 with `include_items`; the second excludes `discussion`, so the opening post is not sent twice) | `exclude_types=parent membership reaction translation` (keeps `topics`, `groups`) | full text |
| `list_polls` | 1 | list profile | `description_max_chars` (caps `details`), results gated; rows drop `results[]` / `stv_results` (per-voter ids and scores, 30–40 % of a visible poll) and null type knobs — `stance_counts` + `total_score` stay |
| `get_poll` | 1 | show profile | full text, results gated, full `results[]` |
| `list_threads` | 1 (`GET /b2/threads`) | `exclude_types=topic group parent membership reaction translation` (compact minus `tag`) | `limit` ≤ 100; no bodies |
| `list_thread_items` | 1 with `topic_id`, 2 with `discussion_id` / `poll_id` | `compact=1` for a bare `topic_id`; compact plus `discussion` when the thread's record is already known; compact minus `reaction` with `include_reactions` | whole thread fetched once (Loomio has no paging); `limit` / `offset` slice here under a `max_total_chars` reply budget (default 120000 shaped characters — `limit` × `body_max_chars` alone would allow ~900 KB; `truncated_by_budget` + `next_offset` continue); `body_max_chars` (default 4000); side-loads narrowed to the returned items; polls carry `poll_options[]` so `option_scores` are readable without a `get_poll` |
| `get_thread_markdown` | 1 with `topic_id`, 2 otherwise | — | `max_chars` (default 60000) |
| `search_content` | 1 | `compact=1` | Loomio's 20-result cap; snippets ≤ 400 chars; the `polls` side-load is read only to gate Stance snippets, never relayed |
| `get_participation_report` | 1 for the whole group set | — (plain hash) | `country` dropped; rows sorted |
| `get_user_activity` | N + 1 for N groups (≤ 50; 4 in flight) | — | `sample_events` ≤ 20 |
| `list_memberships` | 1 | `compact=1` | slim rows and users |
| every write | 1 (`create_poll`: 2 with `discussion_id`, or with `topic_id` + `group_id`; `update_poll`: 2 with `options` — the current names are read so Loomio's replace-the-set PATCH adds instead of deleting) | none — writes never carry a profile (`update_poll`'s lookup is `compact=1`) | the echoed record, shaped like its `get_*` |
| b3 tools | 1 | — | `list_users` is Loomio's whole unpaginated user table |

Before → after, for the two tools that used to dominate Loomio's per-IP
budget (900 requests / 5 minutes):

| Question | 0.0.11 | 0.0.12 |
|---|---|---|
| "Which groups can you see?" | `list_groups` probed `GET /b2/polls?group_id=N` per candidate id: **50–500 requests**, blind to groups without polls | **1 request** |
| "How active was user X in these groups?" | `get_user_activity` listed every discussion in every group, then fetched each one's event stream: **~200 requests** (and 0 useful ones on Loomio ≥ 3.4) | **N + 1 requests** on Loomio's participation report |
| "Who is most engaged?" | not answerable without polls × memberships reconstruction | **1 request** (`get_participation_report`) |
| "Read this thread" | `list_events` per discussion, paginated, full bodies, anonymous read (public threads only) | **1 request** (`get_thread_markdown`, or `list_thread_items` by `topic_id`), as the key's user |

Payload before → after, from the live captures the fixtures follow: a
two-row discussion list went from ~28 KB (groups, memberships,
parent_groups, reactions, tags side-loaded; full HTML bodies) to ~15 KB
with the list profile alone, and smaller again after slimming and the
1500-character body cap; the groups index dropped ~16 % with
`compact=1` — which is NOT sent there, because compact also drops the
`memberships` root that carries the user's admin flag, so the index
sends `exclude_types=tag translation` instead.

**Bytes to the model.** Every tool result is serialised as compact JSON
(`serializeToolResult` in `src/server/register-tool.ts`). Measured over
the shaped 3.8.1 fixtures, the indented form the server used to send
added 37 % to `list_groups` (5.1 → 7.0 KB), 29 % to a `list_polls` row,
23 % to a two-row `list_discussions` and still 10 % with both bodies at
the 1500-character cap (a 50-row page ≈ 113 KB compact vs ≈ 124 KB
indented). `LOOMIO_MCP_PRETTY_JSON=1` restores indentation for a human
reading a stdio session; nothing else changes.

**Markup inside the cap.** Description text is ~2/3 of a capped list
page, and Loomio stores it with the attributes `HasRichText` adds on
save — `target="_blank" rel="nofollow ugc noreferrer noopener"` on every
link, an `id` duplicating the text on every heading, `class` /
`data-mention-id` on mentions. Measured over Loomio-shaped bodies cut at
1500 characters, that markup is 5 % of plain prose, 17 % of a typical
formatted body, 36 % with a link every other paragraph and over half of
a heading-and-link-dense guide. `truncateBody` therefore compacts an
HTML body that exceeds its cap (attributes stripped except `href` /
`alt`, no whitespace between tags) before applying it, so the 1500
characters carry words; bodies that fit and every `get_*` are returned
as stored. The saving is 10–25 KB of a 113 KB page for typical prose
and more for guide-like bodies — not a change of the default cap.

**The catalogue itself.** `tools/list` for the 24 full-mode tools is
35 946 bytes (7.7 KB descriptions, 23.4 KB input schemas) plus 1 800
chars of server instructions — about 9 000 tokens, a fixed per-session
cost paid before the first call; the 28-tool b3 set is 39.4 KB. The
first 0.0.12 draft weighed 82 892 bytes (37 KB descriptions, 41 KB
schemas) plus 3.2 KB of instructions, ~20 700 tokens, more than most
answers, and was trimmed to a fixed shape: each description says what
the tool returns and costs, which sibling to prefer and the one caveat
that changes behaviour (≤ 700 chars; ≤ 350 for `delete_*` /
`update_comment`), each field `.describe()` carries meaning, unit,
default and range (≤ 120 chars; self-naming fields carry none), and the
long form moved to HOWTO.md "Tool reference". What remains is mostly
structural: 16.4 KB of the schema bytes are the JSON Schema the SDK
derives from zod (`$schema` on every tool, `"maximum":
9007199254740991` on all 63 integer fields, the email pattern on five
tools, the id-or-key `anyOf`), 4.9 KB are names and the four
annotations; create_poll (4.9 KB) and update_poll (4.0 KB) share 20
poll-setting fields emitted twice. `scripts/catalog-size.mjs` prints
these numbers from the built server (`--b3`, `--json`) and
`tests/server.test.ts` pins the ceilings — 24 tools ≤ 36 000 bytes, 28
≤ 40 000, instructions ≤ 1 800 chars — so growth is a decision, not
drift. Next candidates if it must shrink further: emitting the schema
without the safe-integer bounds and `$schema` (needs an SDK hook; ~3 KB)
and the twice-emitted poll settings.

---

## 2. Structured event logging *(landed)*

### What

Three per-call event types that give visibility into runtime
behaviour, emitted as single-line JSON to stderr and gated on
`LOOMIO_MCP_LOG_VERBOSE=1` — plus two **forced** key-health events that
bypass the gate, because a rotated Loomio key is exactly the failure an
operator needs to see without having turned verbose logging on.

| Event | Fires | Fields |
|---|---|---|
| `tool.call` | Once per tool invocation | `tool`, `clientId?`, `argFields` (field names only — never values), `durationMs`, `outcome` (`success` / `error`) |
| `loomio.request` | Once per outbound Loomio API call | `method`, `path` (redacted: numeric IDs, string keys, handles and identity uids → placeholders, query stripped), `status`, `durationMs`, `responseBytes` (from `Content-Length`; 0 when the response was chunked) |
| `tool.chain` | Once per `/mcp` POST request (HTTP transport only) | `clientId?`, `tools` (sequence of tool names), `toolCount`, `loomioCalls`, `durationMs` |
| `loomio.auth` (**forced**) | On every change of the key-health verdict, including the first probe (startup, `/health`, `check_connection`, or a tool consulting it) | `key_status` (`valid` / `rejected` / `unreachable`), `loomio_version`, `reason?` — a closed vocabulary: `unauthenticated_body`, `waf`, `unrecognised_403`, `http_<status>`, `timeout`, `network_error`, `config_error`. Never the key, never the probe's free-text `detail` (that may quote an upstream body or error message and goes only to the startup stderr warning) |
| `loomio.version_drift` (**forced**, once per process) | When the instance's Loomio `major.minor` differs from `TESTED_LOOMIO_VERSION` | `level: "warning"`, `loomio_version`, `tested_loomio_version`, `message` |

All of them are wired through `src/log.ts`; the key-health pair comes
from `src/loomio/health.ts`. Alert on `loomio.auth` with
`key_status != "valid"` as a second signal next to the `/health` uptime
check (DEPLOY.md). The aggregate `tool.chain`
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
  options, discussion bodies, comment text, search queries, member
  emails stay out of operator logs.
- **Loomio API paths are redacted**: `/b2/discussions/254022621` →
  `/b2/discussions/:id`, `/b2/groups/my-handle` → `/b2/groups/:id`,
  `/b2/threads/77/items` → `/b2/threads/:id/items`,
  `/b3/users/identity/saml/someone@example.org` →
  `/b3/users/identity/:type/:uid`. Query strings are dropped entirely —
  `/b2/search?query=budget` logs as `/b2/search`, `/b2/reports?group_ids=…`
  as `/b2/reports`. The API key travels in the `Authorization` header
  (never in a URL since 0.0.9) and headers are never logged.
- **No request / response bodies, ever.** Verbose mode unlocks
  per-call shape and timing, not Loomio data. The forced events obey
  this too: `loomio.auth` carries a `reason` code, not the probe's
  `detail` text, and nothing logged is built from the configured
  Loomio URL.

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

## 3. Usage-analysis queries (Cloud Run)

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
(e.g. does anyone use `get_participation_report`, or is everyone
reconstructing participation from `list_polls` despite the
descriptions?).

### Top Loomio endpoints by call count

```sh
gcloud logging read \
  'jsonPayload.event="loomio.request"' \
  --project=<your-gcp-project> --freshness=7d \
  --format='value(jsonPayload.method, jsonPayload.path)' \
  | sort | uniq -c | sort -rn | head -20
```

The redaction means duplicates at `/b2/discussions/:id` collapse
together, so this is a true endpoint histogram. `GET /b2/groups` will
show the health probe's once-a-minute ceiling plus `check_connection`
and `list_groups` calls.

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
endpoints that are slow *and* called often. `/b2/threads/:id/items`
(unpaginated) and `/b2/threads/:id/markdown` are the ones expected to
scale with thread size; `/b2/reports` with the size of the group set.

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
API (e.g. a Loomio response shape change — `loomio.version_drift` in
the same logs is the first thing to check), or being driven by an LLM
that's hallucinating arguments. The argument-field histogram below
helps disambiguate. Note that a thread tool's 404 for an invisible
thread and `search_content`'s empty result are successes, not errors.

### Argument-field shapes per tool

```sh
gcloud logging read \
  'jsonPayload.event="tool.call" AND jsonPayload.tool="list_thread_items"' \
  --project=<your-gcp-project> --freshness=7d \
  --format='value(jsonPayload.argFields)' \
  | sort | uniq -c | sort -rn | head -10
```

Replace the tool name with any tool. Shows the distribution of *which
fields* callers populate. If most `list_thread_items` calls pass
`discussion_id` rather than `topic_id`, the model is paying the
resolution call although every record it already holds carries the
`topic_id` — a description problem worth fixing. If nobody sets
`description_max_chars`, the default cap is doing all the work.

### Chain depth — how many tools per /mcp request

```sh
gcloud logging read \
  'jsonPayload.event="tool.chain"' \
  --project=<your-gcp-project> --freshness=7d \
  --format='value(jsonPayload.toolCount)' \
  | sort -n | uniq -c
```

Most chains for typical Loomio flows are 1–3 tools (`search_content` →
`get_thread_markdown`; `list_groups` → `get_participation_report`).
Long tails (15+ tools in a single request) usually mean the LLM is
hunting for context — possibly a sign that a new aggregate tool would
help, or that the server instructions are not routing it.

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

If `get_discussion x10+` shows up often, the case for a batch tool is
empirical, not hypothetical — though first check whether
`list_threads` or `list_discussions` (which return the counters and
capped bodies for many threads at once) would have answered. Since
0.0.12 no tool fans out by design except `get_user_activity` (one
report call per group, visible as repeated `GET /b2/reports` in
`loomioCalls`, not as repeated tool calls); a chain of
`get_user_activity` × many users is the expected shape of "compare
these members" and is what `get_participation_report` exists to
replace with one call.

### Read vs write traffic mix

```sh
gcloud logging read \
  'jsonPayload.event="tool.call"' \
  --project=<your-gcp-project> --freshness=7d \
  --format='value(jsonPayload.tool)' \
  | awk '/^(get_|list_|search_|check_)/ {r++}
         /^(create_|update_|delete_|manage_|deactivate_|reactivate_)/ {w++}
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

## 4. Local / stdio analysis

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

For a one-shot measurement without a host, the gitignored
`scripts/live-test.mjs` drives the built server over stdio against a
real instance and prints, per tool, the reply size in bytes and the
wall time — the quickest way to see what a tool costs the model's
context (HOWTO.md → "Drive the connector against a real Loomio").

---

## 5. Planned candidates *(not yet landed)*

### a. Per-tool latency histograms in `tool.call`

Currently we emit `durationMs` per call. To get histogram buckets
without server-side aggregation we'd need either (a) a sampled
bucket-id field, or (b) Cloud Logging metric extraction. Option (b)
is operator-side, not a code change — left to the deployment.

### b. Reply size in `tool.call`

`loomio.request.responseBytes` measures what Loomio sent (and only
when it set `Content-Length`); nothing measures what the tool handed
the client after slimming and truncation, which is the number that
matters for the model's context. A `resultBytes` field on `tool.call`
(the length of the serialised result) would make the shaping layer's
effect visible in production rather than only in the live harness.

### c. Retry-on-429 instrumentation

If Loomio starts rate-limiting (none observed so far), add a
`retriedAfter429: true` field on `loomio.request` so the queries
above can quantify retry traffic. Not needed until 429s show up in
the logs; with the 0.0.12 fan-outs gone, the only tool that can
approach the budget on its own is `get_user_activity` over many
groups.

### d. Batch fan-out helper

If a future `batch_manage_memberships` (across groups) lands, the
capsulemcp sibling's `src/capsule/batch.ts` is the reference shape:
concurrency-capped `Promise.allSettled` plus an always-on
`batch.complete` event with per-item success/failure counts.
`mapWithConcurrency` in `src/tools/reports.ts` (4 lanes over the
report calls) is the minimal ancestor.

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
