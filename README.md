# Capsule

[![CI](https://github.com/hakiyaka/capsule/actions/workflows/ci.yml/badge.svg)](https://github.com/hakiyaka/capsule/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Lossless context compression for Codex.**
>
> Capsule shows the model the smallest safe piece of evidence and keeps the
> complete result locally recoverable.

Codex does not need to reread the same terminal output, whole files, project
neighbours, web pages, or tool catalogues on every turn. Capsule turns that
repetition into compact, exact-recoverable evidence.

## Why Capsule?

| Without Capsule | With Capsule |
| --- | --- |
| Repeated output fills the context window | Replays become a compact exact handle |
| Large files are reread from line 1 | Task-specific ranges are selected first |
| A project is explored file by file | Symbols and dependency impact are compiled once |
| Web results arrive as a giant page | Text, URLs, and reference IDs stay recoverable on demand |
| Every tool exposes its full catalogue | Common actions stay small; the rest is discoverable |

The core rule is simple:

`request -> classify -> compact view
                    \-> exact local evidence -> expand on demand`

Capsule is local-first, deterministic, and conservative. If a projection would
be larger, lossy, unsafe, or explicitly disallowed, it passes the original
result through.

## What it covers

- **Terminal:** `run`, `batch`, and `flow` projections remove repeated,
  low-value stdout/stderr while preserving failures and critical lines.
- **Files:** bounded reads, replay detection, immutable-baseline edits, and
  exact range expansion.
- **Projects:** incremental symbol/dependency indexing, impact cones, and
  proof packets for query and refactor work.
- **Web:** bounded structured results plus an opt-in, lossless web lease for
  exact text, URLs, and `ref_id` recovery.
- **Context:** compaction ledgers, memory loadouts, polling receipts, and
  pressure-aware summaries.
- **Skills and tools:** abstaining skill routing, deferred action discovery,
  local filters, and batched execution.
- **Measurement:** workload-specific A/B benchmarks and local gain telemetry.
- **Release quality:** shared atomic state primitives, portable verification,
  and a documentation/link audit for public installations.

Capsule does not claim to control hidden provider-side reasoning, cache, or
billing counters. Its measurements describe the observable model-facing
payload and local exact-recovery path.

## A measured first web call

For a first real web search (local measurement):

| | Size |
| --- | ---: |
| Raw result | 25,877 characters |
| Capsule lease | 519 characters |
| Model-facing reduction | **97.99%** |
| Recovery | **byte-exact** |

This is one workload, not a universal percentage. Run the benchmarks on your
own tasks before drawing billing conclusions.

## Install

### Requirements

- Node.js 18 or newer
- Codex with local plugin/MCP support
- Windows, macOS, or Linux
- Python 3 only for the optional Python benchmarks

### Local plugin

```sh
git clone https://github.com/hakiyaka/capsule.git
cd capsule
npm test
```

Add the repository root as a local Codex plugin. The bundled
`.codex-plugin/plugin.json` and `.mcp.json` register the `capsule` MCP server
and its lifecycle hooks. Trust the hooks when Codex asks, then restart Codex.

Verify that the server is loaded:

```json
{"action":"doctor","payload":{}}
```

For a deliberate global-hook installation or removal:

```sh
npm run hooks:install
npm run hooks:status
npm run hooks:restore
```

## The action surface

| Goal | Capsule action |
| --- | --- |
| Plan a bounded task | `advisor` |
| Route an installed skill | `skills` |
| Run commands | `run`, `batch`, `flow` |
| Read or edit a file | `file` |
| Understand a codebase | `project` |
| Index or recall durable facts | `index`, `search`, `remember`, `memory` |
| Fetch a real URL | `fetch` |
| Derive structured data | `execute` |
| Recover exact evidence | `expand`, `diff` |
| Measure behavior | `stats`, `gain`, `insight`, `doctor` |

Examples:

```json
{"action":"run","payload":{"command":"npm test"}}
{"action":"project","payload":{"operation":"query","root":"."}}
{"action":"memory","payload":{"operation":"recall","query":"current task","max_chars":900}}
```

For large memory stores, use progressive disclosure: `index` returns compact
IDs and previews; `get` recovers one selected record exactly.

For multi-project or multi-agent stores, add a deterministic `loadout` (or
`binding`) to pre-filter the candidate set before ranking. It accepts `tags`,
`sources`, `layers`/`asset_types`, and `scope`; `strict_scope:true` prevents
unscoped records from crossing a project or team boundary. This is local
selection, not a replacement for a provider or server-side ACL. Set
`strategy:"bootstrap"` to prefer L3/L2 profile and scenario records first,
falling back to L1/L0 only when no high-level match exists.

```json
{"action":"memory","payload":{"operation":"index","query":"current task","max_chars":420}}
{"action":"memory","payload":{"operation":"get","id":"mem_..."}}
{"action":"memory","payload":{"operation":"recall","query":"release check","loadout":{"tags":["release"],"scope":{"project":"demo"},"strict_scope":true,"strategy":"bootstrap"},"max_chars":900}}
```

`fetch` requires a real `payload.url` or `payload.requests`.
`expand` and `diff` require a real `payload.capsule_id` returned by an earlier
Capsule call. Capsule never invents recovery IDs.

## Lossless web mode

Web zero-copy is intentionally opt-in because it replaces the visible response
with a local lease. The complete response remains on disk, addressed by its
SHA-256 hash; no text, URL, or reference ID is discarded.

```powershell
$env:CAPSULE_WEB_ZERO_COPY="1"
```

Or enable one call with `capsule_web_zero_copy: true`. Measure it with:

```sh
npm run benchmark:web:zero-copy
```

The same exact-recovery principle is available for media with:

```sh
npm run benchmark:media:zero-copy
```

## Safety contract

Capsule follows four rules:

1. **Exact first:** the original result is stored before a compact view is
   emitted.
2. **No token-negative compression:** small, literal, failed-to-classify,
   `raw`, `full`, `exact`, `benchmark`, or `verbatim` requests pass through.
3. **Proof on demand:** every compact view identifies how to recover the
   complete evidence.
4. **Local and bounded:** state is local, caches have finite limits, and
   fingerprints are preferred over raw prompts.

For web and media leases, the exact file is content-addressed and verified
with SHA-256. For file edits, stale or overlapping baselines reject the whole
transaction before writing.

## Benchmarks and verification

Run the fast confidence set:

```sh
npm run verify
npm run benchmark:web:zero-copy
npm run benchmark:project
npm run benchmark:refactor
```

`npm run verify` runs the complete Node test suite, source-integrity audit,
public-readiness audit, and documentation audit. Run the broader suites with
`npm run benchmark:full`. All benchmark results
are workload-specific; they are not a promise of a fixed saving on every
prompt or a substitute for provider billing telemetry.

See [BENCHMARK.md](BENCHMARK.md) for methodology and [CHANGELOG.md](CHANGELOG.md)
for release history. The 100-project research ledger is in
[GITHUB-100-RESEARCH.md](GITHUB-100-RESEARCH.md).

## Repository map

```text
capsule/
|-- mcp/             MCP server and core actions
|   `-- storage.cjs   shared atomic JSON, bounds, and hashing primitives
|-- scripts/         lifecycle hook, installers, and audits
|-- hooks/           bundled Codex hook entry points
|-- bench/           reproducible A/B benchmarks
|-- tests/           contract and parity tests
|-- skills/          optional skill packages
`-- .codex-plugin/  Codex plugin manifest
```

## Privacy

Automatic decisions store bounded counters and keyed fingerprints, not raw
prompts. Explicit `index`, `remember`, and `memory capture` operations store
only the content requested by the caller. State lives in the platform-appropriate
local data directory.

Set `CAPSULE_STATE` to an absolute directory to choose a different local state
root. Use the supported `purge` operation to remove cached projects or
capsules.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report
security issues using [SECURITY.md](SECURITY.md). Capsule is released under
the [MIT License](LICENSE).
