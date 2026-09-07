# GPT-6 Astra

Capsule recognizes `gpt-6-astra` without changing the selected Codex model or
reasoning effort. Hooks prefer explicit model metadata, then the current task's
latest complete `turn_context` record in a bounded 64 KiB transcript tail, then
`CAPSULE_MODEL`. When no transcript path is supplied, the top-level model in
`$CODEX_HOME/config.toml` (or `~/.codex/config.toml`) provides a fallback. File
lookups are cached by metadata. An unreadable or inconclusive transcript never
borrows another task's configured model. If the host omits model metadata, set
`CAPSULE_MODEL` for its Capsule process. Unknown models retain the existing policy.

The Astra preset reduces automatic text budgets by 25%, with lower bounds for
usable evidence. Existing context-pressure policies still use provider telemetry;
Capsule does not guess Astra's context window. Explicit detail requests keep their
answer budget, and exact-output requests and recovery remain supported. Set
`CAPSULE_MODEL_PROFILE=0` to disable this preset. This switch does not disable
Capsule's existing compression or change the host model.

For direct MCP requests, pass `model: "gpt-6-astra"` in advisor/cognition payloads,
or set `CAPSULE_MODEL=gpt-6-astra` in the server environment. For gain/stats, pass
`pricing_model: "gpt-6-astra"` or set `CAPSULE_PRICING_MODEL=gpt-6-astra`.
Unverified model prices return null dollar estimates while preserving token
measurements and the requested model identity. A Codex model's availability is
not evidence of its API price. Calls without any model still retain the legacy
Sol pricing default for compatibility.

Verify with `npm run verify`; test workers use temporary Capsule state and Codex
configuration, independent of the operator's installation. Reproduce the budget comparison with
`npm run benchmark:astra`; this measures configured budgets, not actual
provider token consumption, hidden reasoning, or subscription charges.
