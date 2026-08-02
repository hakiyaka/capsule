# Capsule

Capsule is a portable Codex plugin and MCP server for reducing avoidable model
I/O while keeping exact evidence recoverable. It compresses only when the
model-visible result becomes smaller, stores the original result in immutable
capsules, and lets the model expand exact ranges when proof is required.

The npm/plugin installation identifier is `capsule`; the MCP
identifier and user-facing product name are **Capsule**.

## Versioning

Capsule's public stable version line starts at **1.0.0**. The changelog begins
with this first stable release, and benchmark commands are named by capability
rather than by development iteration. Codex plugin manifests append
`+codex.<build>` as
SemVer build metadata for cache identity; the public version is the `1.0.0`
portion before `+`.

## What it provides

- Exact-recoverable command and file output capsules
- Skill routing with abstention instead of speculative matches
- Search, indexing, bounded memory, and explicit remember operations
- Task-conditioned project compilation with incremental semantic reuse, impact
  cones, token-profit gating, and exact proof packets
- Structural unified-diff change summaries with exact expansion
- Immutable-baseline line edits that avoid repeating large old/new file regions
- Batched commands, derivations, fetch normalization, and evidence expansion
- Context-pressure, compaction, polling, and reasoning-budget controls
- Native Codex lifecycle hooks with a reversible global-policy fallback
- Extensible local command profiles and user-defined filters
- Local state and privacy-preserving prompt fingerprints by default

Capsule does not promise savings for every request. Small results and explicit
raw, benchmark, exact, full, or verbatim requests pass through when compression
would be neutral, unsafe, or larger.

## Requirements

- Node.js 18 or later
- Codex with local plugin/MCP support
- Windows, macOS, or Linux
- Python 3 for the optional Python benchmark suite

## Development setup

```sh
git clone <repository-url> capsule
cd capsule
npm test
npm run audit:source
npm run audit:public
```

Load the repository root as a local Codex plugin, enable it in Codex, trust its
six lifecycle hooks, and restart Codex. Exact installation UI may vary by Codex
version.

Verify the installation by calling the `capsule` tool:

```json
{"action":"doctor","payload":{}}
```

## Core actions

| Need | Action |
| --- | --- |
| Bound a task and its integration lanes | `advisor` |
| Route an installed skill | `skills` |
| Run or batch commands | `run`, `batch`, `flow` |
| Read or edit files with evidence | `file` |
| Understand a project with minimum evidence | `project` |
| Index, search, or explicitly remember | `index`, `search`, `remember` |
| Fetch web text from a real URL | `fetch` |
| Derive structured data | `execute` |
| Recover exact evidence | `expand`, `diff` |
| Measure behavior | `stats`, `gain`, `insight`, `doctor` |

`fetch` requires `payload.url` or `payload.requests`. `expand` and `diff`
require a real `payload.capsule_id` returned by an earlier Capsule result.

`file` keeps literal access safe while avoiding repeated context transfer. A
bounded `start_line`/`end_line` request returns one exact `file-range` page with
an expandable capsule; an unchanged repeat of a large automatic, bare, or
range read returns only a compact `file-replay` reference after a fresh
SHA-256 check. Use `force_refresh:true` or explicit `mode:"full"` when a
deliberate literal reread is required.

`advisor` creates a compact task contract before expensive work: a cumulative
tool-call/read budget, explicitly requested integration lanes, batching and
verification steps, and a default of no worktree or subagent fan-out. The
`UserPromptSubmit` hook starts this contract automatically, resets local
execution evidence when the prompt is a new task, and suppresses old decision
replay at that boundary. It stores only a fingerprint and term hashes, never
the raw prompt. Read-only or planning calls past the task budget are withheld
unless `capsule_force=true` is explicit; mutations and decisive verification
remain available. The same budget covers observational terminal reads such as
`rg`, `git status`, and `Get-Content`. Short continuation messages such as
`devam et` or `yeniden başlattım` stay in the active task; after the first
successful mutation, the hook requests one grouped transaction/patch and one
decisive verification. Set `CAPSULE_ADVISOR=0` for a deliberate global
opt-out; `capsule_force=true` is the narrower escape hatch for one indispensable
read. Set `CAPSULE_ADVISOR_VISIBLE=0` to keep the guardrails active without
injecting the compact advisor line. Use `doctor` to answer “is Capsule loaded?”
and `stats|gain|insight` to measure behavior rather than assuming a fixed saving
percentage.

Advisor task state is scoped to the workspace and expires after six hours by
default, preventing a later folder switch or an overnight continuation from
reusing stale evidence. Override the lease only when needed with
`CAPSULE_ADVISOR_TASK_TTL_MS` (bounded to one minute through seven days).

`project` supports `operation: scan|query|impact|status|gc`. A query incrementally
compiles symbols and resolved dependencies, selects a bounded task-specific
impact cone, and returns exact-expandable evidence. If that packet would be
larger than the selected raw files, Capsule passes the smaller raw evidence
through instead. For `scan`, `query`, `impact`, and `status`, `payload.root`
selects the codebase and responses expose its canonical form. Because `gc` is
global, it rejects a root selector.

Project indexes are maintained with a 64-project, 256 MiB, 90-day LRU/TTL
policy. Exact capsules use content-addressed gzip storage plus a
reference-aware 512 MiB, 10,000-entry, 180-day garbage collector that preserves
the newest 256 proofs and one predecessor. Maintenance runs periodically and
uses stale-recovering cross-process locks. Configure it with
`CAPSULE_PROJECT_CACHE_MAX_PROJECTS`, `CAPSULE_PROJECT_CACHE_MAX_BYTES`,
`CAPSULE_PROJECT_CACHE_TTL_DAYS`, `CAPSULE_CACHE_MAX_BYTES`,
`CAPSULE_CACHE_MAX_ENTRIES`, `CAPSULE_CACHE_TTL_DAYS`, and
`CAPSULE_CACHE_MIN_RECENT`; set `CAPSULE_CACHE_GC=0` to disable automatic exact
capsule collection. Targeted `purge` scopes include `projects`, `capsules`, and
`cache`, and still require `confirm:true`.

## Exact change maps and baseline edits

For a valid unified diff, the `diff` command profile emits a bounded
`[Capsule change-summary v1]` manifest containing file status, addition/deletion
totals, and old/new line ranges for each retained hunk. The complete diff is
stored in its exact capsule and can be recovered with `expand`; malformed or
non-unified input falls back to the conservative signal-line filter.

Line edits can refer to a previously returned exact file capsule instead of
repeating a large old block and replacement block. Pass its real
`baseline_capsule_id` with one-based inclusive tuples:

```json
{
  "action": "file",
  "payload": {
    "operation": "edit",
    "path": "src/example.js",
    "baseline_capsule_id": "cap_0123456789abcdef",
    "ops": [["l", 91, 91, "  return updatedValue;"]]
  }
}
```

All line ranges are resolved against the immutable baseline. Capsule refuses
the entire transaction before writing if the baseline is stale, belongs to
another path, is not a file capsule, overlaps another line range, or is mixed
with legacy text operations. Successful edits retain the source BOM and CRLF
line endings.

On Windows, command capture resolves executables through `PATH`/`PATHEXT`.
`.cmd`, `.bat`, and `.ps1` targets use a non-interactive PowerShell launch plan
with JSON-carried arguments while the Node child-process call remains
`shell:false`. This is an execution-compatibility guarantee, not a direct token
savings claim.

## Privacy and state

Automatic decision replay stores bounded counters and keyed fingerprints, not
raw prompts. Explicit `index` and `remember` operations may store the content
the caller supplies. Never index secrets. Local state is stored in the
platform-appropriate user data directory and can be purged with the supported
Capsule operations.

Set `CAPSULE_STATE` to an absolute directory to override the state location.
Project filter files use `.capsule-filters.json`.

### Complete local Codex session audit

The optional deep history audit reads every discovered `.jsonl` line locally,
including archived sessions, without placing transcript text in the model
context or writing it into Capsule state. It reports record/line integrity,
token counters exposed by Codex, tool-output pressure, repeated calls,
duplicate outputs, compaction markers, and hash-only hotspots:

```sh
npm run audit:sessions -- --max-files 100000 --max-bytes 549755813888 \
  --output capsule-session-audit.json
```

The MCP equivalent is `insight` with `history:true, deep:true` (or
`line_scan:true`). The result is diagnostic, not a billing claim: provider
cache behavior, hidden compactor generation, and generated-answer tokens are
not observable locally. Damaged tail lines are counted and skipped; no repair
is performed on the original session files. Use `--no-archived` only when a
bounded active-session audit is intentional.
`--output` writes UTF-8 directly and avoids PowerShell's legacy redirected
stdout encoding.

## Verification

```sh
npm test
npm run audit:source
npm run audit:public
npm run benchmark
npm run benchmark:project
```

Benchmarks report workload-specific measurements, not a universal savings
guarantee. See [BENCHMARK.md](BENCHMARK.md).

Every non-failed tool result also has a default 1,000,000-character universal
hard cap. An incompressible giant result becomes a short, redacted evidence
envelope with an exact local capsule, even when the tool's mutation semantics
are unknown. Change the bound with `CAPSULE_UNIVERSAL_HARD_CAP_CHARS` or
disable it only with the explicit `CAPSULE_UNIVERSAL_HARD_CAP=0` opt-out.

### Prompt-budget overhead audit

The prompt controller uses one compact budget ABI instead of independently
injecting output, reasoning, batching, and answer-shape prose. On the ordinary
action fixture, the model-visible controller text is 205 characters instead of
502 characters, a 59.16% reduction. Its telemetry is recomputed from the final
emitted ABI rather than the pre-merge fragment.

This closes a gap found while comparing context-window and terminal-output
reduction approaches, including
[TokenPilot](https://github.com/rish-e/tokenpilot) and
[PATK](https://github.com/Dante7771/patk-mcp): data-plane compression can be
undermined by verbose control-plane instructions. The percentage applies only
to this injected controller text, not to whole-task usage or billing.

The MCP surface also uses a deferred action catalog inspired by
[mcp-compressor](https://github.com/atlassian-labs/mcp-compressor) and
[TSCG](https://github.com/SKZL-AI/tscg). Common actions remain visible, while
the complete catalog is requested through `discover` instead of being repeated
inside every `tools/list` schema. Local validation retains the complete action
set without serializing it to the model.

The context-pressure recorder labels observable counter patterns as a
`post-compaction-cache-miss`, `request-input-shrank`, mid-loop cache dropout, or
large uncached request. These are heuristic timing/counter correlations from
Codex session telemetry; they cannot prove a provider-side cause or prompt-prefix
mutation. Capsule cannot set Codex's wire-level `prompt_cache_key` or cache
breakpoints, nor control host compaction and retry behavior, so the classifier
is not itself counted as token or billing savings.

Project queries combine lexical IDF with dependency-graph PageRank. The graph
cone is ranked before the visible file budget is applied, so a low-value
neighbor cannot exclude a highly connected architectural hub merely because it
appeared first in an import list. This follows the repository-map pattern used
by [Aider](https://github.com/Aider-AI/aider),
[code-review-graph](https://github.com/tirth8205/code-review-graph), and
[jCodeMunch](https://github.com/jgravelle/jcodemunch-mcp), while retaining
Capsule's exact proof packets and token-profit gate.

Matched symbols carry bounded structural end lines, and project queries return
the complete function, class, or section body when it fits the symbol budget.
Large bodies use a head/tail projection with exact capsule recovery. This
removes the routine second file read caused by signature-only or fixed
three-line windows, following the symbol-level retrieval pattern in
[Probe](https://github.com/buger/probe),
[Serena](https://github.com/oraios/serena),
[mcp-language-server](https://github.com/isaacphi/mcp-language-server), and
[jCodeMunch](https://github.com/jgravelle/jcodemunch-mcp).

Visible project proof packets are globally packed under both token and character
budgets. A coverage pass gives each ranked file one bounded evidence atom;
remaining atoms are selected by deterministic utility per token. Footer,
uncertainty, omission counts, and exact recovery are reserved before evidence
is packed, so a long early function cannot silently cut off later files. This
replaces final-string truncation with the explicit budget-processing pattern
seen in [SWE-agent](https://github.com/SWE-agent/SWE-agent) history processors
and ranked repository context systems such as Aider.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report
security issues according to [SECURITY.md](SECURITY.md), not in a public issue.

Capsule is released under the [MIT License](LICENSE).
