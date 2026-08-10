---
name: map-token-context
description: Compile branching decisions outside model generation, route virtualized specialist skills, and minimize model input/output across tools, files, history, images, subagents, search, and recall. Use for token-heavy or reasoning-heavy work or reversible skill-vault management.
---

# Capsule

Use one `capsule`; put action fields in `payload`.

- With a virtual router, call `skills {operation:"route",query:"English intent"}`; its default is one domain-anchored match. Read only that `skill_file`; request a larger limit only when the task truly needs another specialist.
- Use `cognition` for exact cover, assignment, knapsack, shortest path, DAG scheduling, weighted decisions, information-gain checks, reasoning-governor status, or reusable decision kernels; trust its checksum certificate and reason only about unencoded judgment.
- Use `run|batch` for commands, `file` for files, `index|search|remember` for context, `fetch` for web text, and `execute` for derivation.
- Use progressive `expand|diff` for exact evidence and `stats|gain|insight|doctor` for measurement.
- Treat `[Capsule replay]`, `[Capsule delta]`, `[Capsule poll: exactly unchanged]`, and `[Capsule session transcript projection]` as complete control tags: reuse them directly and call `expand` only when exact bytes are required. The current `exact=` capsule always contains the complete latest result.
- Treat `[Capsule repeated failure]` as proof that the same tool input produced the byte-identical error again. Use its short diagnostic, change input or external state, and call `expand` only if exact bytes are required.
- Treat `[Capsule round-trip tax]` and the sequence fuse as measured prompts to batch independent work or execute the next concrete change. A costly uncached suffix also tightens output/history budgets mechanically. Successful exec control wrappers are removed automatically; oversized read-only output remains exact-capsule recoverable even at normal context pressure.
- For automatic-context-compaction cost, call `insight` with `compaction:true` and the session id/path. It returns aggregates, the latest event, and `context_pressure` with occupancy, predicted runway, locally reported quota pressure, compaction churn, retained-image risk, reasons, and the active policy. Request bounded rows only with `compaction_events:true`. Treat pre/post input as observable exposure because hidden compactor generation is not exposed.
- Treat `gain` as contract-valid local exposure telemetry, not billing. Legacy hook projections are excluded unless `include_unverified:true` is explicitly requested.
- Start `view_image` at `high`; use `original` only for pixel-level evidence.
- Give subagents self-contained messages. Automatic policy uses `none` for independent tasks, a small recent window for deictic continuations, and full history only for explicit whole-conversation dependencies.
- Subagent work is task-bounded: keep the default total to 16 (never above 20), use one agent per UI/i18n/performance/release lane, pause after 10 independent agents for one compact `{decisions,evidence,files,blockers}` summary, and reuse that digest instead of opening another review wave. Return no raw screenshots, base64 media, full diffs, or transcripts; retain exact recovery in Capsule.
- After each grouped mutation and decisive verification, call `stats` once and `gain` once. Treat both as local exposure evidence, not billing; do not rerun exploratory reads just to obtain a measurement.
- Return the smallest complete answer; explicit detail requirements win.
- Never sacrifice accuracy for compression.
- Skill `apply|restore` requires an explicit request and `confirm:true`.
- See [capsule-contract.md](references/capsule-contract.md) for exact behavior and recovery.
