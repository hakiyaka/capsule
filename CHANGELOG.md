# Changelog

All notable user-visible changes are recorded here.

## 1.0.2 - 2026-08-09

- Hardened the GitHub visibility audit with paginated release collection,
  bounded API diagnostics, configurable output buffering, and safe repository
  overrides so incomplete or unavailable signals are not reported as zeros.
- Derived release smoke and SEO checks from `package.json` and documented the
  repository social-preview, Search Console, Bing, and portable repository
  selection steps for maintainers.
- Added regression coverage for pagination, API errors, repository validation,
  and the Windows-safe visibility workflow.

## 1.0.1 - 2026-08-09

- Added a public GitHub discoverability guide and repeatable visibility audit
  for repository metadata, rolling views/clones, popular referrers, release
  assets, and volatile repository-search snapshots with null-safe baseline
  deltas; no ranking, billing, or quota guarantee is inferred.
- Added a crawlable RSS/llms/sitemap link for the discoverability guide and the
  checksummed v1.0.1 source archive, with local SEO and live HTTPS smoke checks
  enforcing parity across those surfaces.
- Centralized local state hashing, bounded-number parsing, JSON validation, and
  collision-resistant atomic writes in `mcp/storage.cjs`; migrated the core,
  project, memory, polling, compaction, runtime, compatibility, terminal, and
  quota lanes without changing their public action contracts.
- Added `npm run verify`, combining tests, source integrity, public readiness,
  and documentation/link audits for release and CI use.
- Added storage-helper and documentation-audit regression tests, including
  malformed-cache behavior, temporary-file cleanup, local-link checks, and
  retired internal-name checks.
- Added deterministic memory loadout bindings inspired by TencentDB-Agent-
  Memory's query-conditioned, bounded asset retrieval: optional tags, sources,
  layers/asset types, and strict scope are applied before ranking in both
  `recall` and progressive `index`, while exact `get` recovery remains intact.
- Added an opt-in two-stage memory strategy: `strategy:"bootstrap"` prefers
  profile/scenario context and falls back to fact/trace retrieval only when
  the high-level stage has no match, keeping the lower-level evidence on
  demand rather than injecting it into every turn.
- Added a guarded native `Get-Content` fast path for one-file UTF-8 reads:
  query-focused evidence and content-hash replay avoid the PowerShell stdout
  envelope, while pipelines, wildcards, waits, non-UTF-8 encodings, and
  unknown flags retain the normal shell path.
- Documented the refactor boundary and verification evidence. Hidden provider
  reasoning, cache, billing, and subscription counters remain outside local
  benchmark claims.

## 1.0.0 - 2026-08-01

- First stable public release of Capsule.
- Added exact-recoverable compression for command, file, diff, browser, and
  structured outputs, with token-negative and literal-evidence passthroughs.
- Added conservative skill routing with abstention, domain-evidence gates, and
  historical false-positive replay tests.
- Added project compilation, persistent indexing and search, bounded memory,
  batch execution, and exact evidence expansion.
- Added context-pressure, compaction, polling, reasoning-budget, and
  quota-to-progress controls with explicit measurement caveats.
- Added an opt-in exhaustive local Codex JSONL audit: every active and
  archived session line is streamed into hash-only integrity, token, error,
  repeat, duplicate-output, compaction, and fan-out telemetry without
  persisting transcript text or modifying session files.
- Added a universal exact-recoverable hard cap for giant non-failed tool
  results, covering unknown tool semantics at 512,000 characters by default.
- Added replacement-history pressure detection: large compaction handoffs now
  tighten the next-turn policy before output and subagent fan-out can multiply
  the same context again.
- Added a bounded post-compaction memory ledger and one-shot forgetting probe;
  typed decisions, open work, verification, changed files, and exact Capsule
  IDs survive compaction without persisting raw prompts.
- Added a refactor proof packet: warm scans reuse mtime/size metadata without
  rereading unchanged bodies, while refactors receive only symbol spans,
  hashes, dependency/importer cones, impacted tests, and an exact manifest.
- Added native Codex lifecycle hooks, a reversible capability airlock, and
  native-editor preference for bounded text changes.
- Fixed lazy browser-runtime discovery: an empty pre-bootstrap `globalThis`
  inventory no longer produces a false missing-browser/Chrome/computer-use
  report; the runtime is initialized first and only a failed setup or tool
  call is treated as unavailable.
- Added the automatic Advisor contract: bounded cumulative tool/read budgets,
  explicit integration lanes, task-boundary memory isolation, short-command
  continuation handling, observational-shell budgeting, grouped-edit guidance,
  and worktree/subagent fan-out disabled by default. Added a documented global
  `CAPSULE_ADVISOR=0` opt-out plus direct activation, measurement, and escape
  hatch hints in advisor responses, and a silent-visible mode that preserves
  guardrails without adding the advisor line to the prompt. Task state now
  isolates workspace switches, expires stale leases, and hashes missing-session
  fallbacks instead of sharing one global `unknown` state.
- Added a task-scoped subagent fan-out fuse and automatic full-history fork
  bound. The safeguard is based on recent telemetry showing one parent with 31
  children consuming 18.43 GiB of session history; limits tighten under context
  pressure and reset only after a real implementation mutation.
- Added Sol-inspired failed-lane retry blocking and fresh-review isolation:
  unchanged failed delegation packets are withheld until corrected, while
  explicit fresh/read-only reviews use `fork_turns:none` and inspect only their
  supplied evidence.
- Added the optional layered memory loadout action: explicit L0 trace, L1 fact,
  L2 scenario, and L3 profile lanes with scope isolation, secret redaction,
  idempotent deduplication, per-lane budgets, freshness/importance scoring,
  duplicate suppression, expiry, and auditable pruning. Raw trace retention is
  opt-in; no transcript is captured implicitly.
- Added compact environment leases for cross-platform setup friction: one
  fingerprinted, fifteen-minute snapshot resolves Windows Python launchers,
  workspace virtual environments, shells, and package managers without
  emitting raw PATH values; changed PATH, virtual-environment, or workspace
  state invalidates the lease automatically. Setup-oriented Windows prompts
  receive the lease once per task/session instead of repeating discovery advice.
- Added a verifier-output serializer inspired by WrongStack: successful test
  runs now emit aggregate suites/tests/time lines instead of replaying every
  `PASS` row, while failed runs retain failure neighborhoods and summaries and
  omit unrelated passing rows. Exact raw output remains recoverable from its
  Capsule; small, literal, or ambiguous output still passes through.
- Added platform-native state handling for Windows, macOS, Linux, and XDG,
  plus public contribution, security, CI, and readiness checks.
- Published with the `capsule` npm/plugin installation identifier
  and the `capsule` MCP identifier.
