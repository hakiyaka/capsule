# Changelog

All notable user-visible changes are recorded here.

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
  results, covering unknown tool semantics at 1,000,000 characters by default.
- Added native Codex lifecycle hooks, a reversible capability airlock, and
  native-editor preference for bounded text changes.
- Added the automatic Advisor contract: bounded cumulative tool/read budgets,
  explicit integration lanes, task-boundary memory isolation, short-command
  continuation handling, observational-shell budgeting, grouped-edit guidance,
  and worktree/subagent fan-out disabled by default. Added a documented global
  `CAPSULE_ADVISOR=0` opt-out plus direct activation, measurement, and escape
  hatch hints in advisor responses, and a silent-visible mode that preserves
  guardrails without adding the advisor line to the prompt. Task state now
  isolates workspace switches, expires stale leases, and hashes missing-session
  fallbacks instead of sharing one global `unknown` state.
- Added platform-native state handling for Windows, macOS, Linux, and XDG,
  plus public contribution, security, CI, and readiness checks.
- Published with the `capsule` npm/plugin installation identifier
  and the `capsule` MCP identifier.
