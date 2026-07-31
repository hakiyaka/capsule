# Capsule contract

Call one MCP tool named `capsule`. Select `action` and place all action-specific fields in `payload`.

| Action | Main payload fields | Result |
|---|---|---|
| `run` | `command`, `args`, optional `cwd`, `query`, `profile` | One execution, adaptive compact output, exact archive |
| `batch` | `commands[]`, optional `queries[]`, `concurrency` (1-8) | Parallel captures, auto-index, inline searches |
| `file` | `path`; optional `operation`, `query`, `baseline_capsule_id`, edits, limits | Compact evidence, immutable-baseline edit, exact archive |
| `project` | `operation: scan|query|impact|status|gc`; `root`, optional query/target, depth and cache limits | Incremental semantic index, task-conditioned impact cone, token-profit gate, exact proof, quota/LRU maintenance |
| `index` | `path` or `content`; optional globs, gitignore, symlinks, chunk bounds | Persistent bounded file/content catalog |
| `search` | `query` or `queries[]`; optional filters, timeline | Porter + trigram RRF, proximity, typo correction, staleness |
| `remember` | `content`; optional `tag`, `title`, `source` | Persistent searchable memory |
| `fetch` | `url` or `requests[]`; optional TTL, concurrency, limits | Cached fetch, HTML/JSON normalization, chunked index |
| `execute` | `language`, `code`; optional `path`, `intent`, `background` | Multi-language scratch execution, compact/indexed result |
| `cognition` | `operation: compile|cover|assign|knapsack|path|dag|decide|hypotheses|governor|remember|recall|stats`; operation-specific data | Deterministic reasoning offload, closed-loop token control, proof certificate, or reusable decision kernel |
| `jobs` | `operation`; optional `job_id`, `confirm` | List, inspect, log, stop, or remove background jobs |
| `rewrite` | `command`; optional `cwd`, `force` | Decide whether and how to wrap a large-output command |
| `filters` | `operation`; filter definition or project path | Add/test/remove custom filters and trust project filters |
| `gain` | optional time window; `include_unverified:true` only for legacy audit | Contract-valid local savings history by command profile |
| `discover` | optional history roots and bounds | Find missed large-output commands |
| `learn` | optional history roots, confidence/occurrence bounds; `write:true,confirm:true` for rules | Detect local fail-then-correct CLI pairs without persisting raw outputs |
| `telemetry` | `operation: status|forget` | Confirm local-only accounting or erase compatibility history |
| `pipe` | `content`; optional profile/query/limits | Compact already-captured text |
| `insight` | optional time window; `history:true`, `compaction:true`, and bounded limits | Local savings and environment analysis; optional metadata-only task audit plus adaptive context-pressure report |
| `skills` | `operation: route|plan|status|apply|restore`; query or `confirm:true` | Compact specialist routing and reversible direct-catalog virtualization |
| `purge` | `scope: index|projects|capsules|cache|jobs|history|hooks|all`, `confirm:true` | Irreversibly purge selected state |
| `expand` | `capsule_id`; `anchor_id` or line bounds; optional `max_chars` | Exact progressive page; defaults to 2,400 characters with continuation |
| `diff` | `before_id`, `after_id`; optional context limits | Exact bounded before/after change |
| `list` | optional `scope: "index"`, `limit` | Recent capsules or indexed documents |
| `stats` | optional `recent` | Captured/emitted/avoided exposure and index totals |
| `doctor` | none | State, runtime, hooks, platform, and non-mutating skill-catalog checks |

Legacy `command` and `ledger` actions map to `run` and `stats`.

## Adaptive command profiles

`profile:auto` infers diff, git, test, diagnostic, build, listing, grep, log, environment, network/JSON, table, dependency, count, or generic output. It launches one executable with an explicit string `args` array and `shell:false`, rejects incomplete overflow captures, redacts common secret assignments, preserves failures and summaries, deduplicates noise, and bypasses compression when it would regress. Exact content-addressed gzip output stays expandable.

On Windows, executable resolution follows `PATH` and `PATHEXT`. `.cmd`, `.bat`, and `.ps1` targets receive a non-interactive PowerShell launch plan with JSON-carried arguments; the Node child-process invocation remains `shell:false`.

The caller must still avoid mutating commands unless the task authorizes them.

## Exact change summaries and line edits

A valid unified diff under the `diff` profile becomes a bounded `[Capsule change-summary v1]` manifest with file status, addition/deletion totals, and retained old/new hunk ranges. The complete diff stays in its exact capsule for `expand`. Malformed or non-unified input uses the conservative signal-line fallback.

To edit without repeating a large old/new block, first obtain an exact file capsule, then call `file` with `operation:"edit"`, its real `baseline_capsule_id`, and compact one-based inclusive tuples such as `["l",91,91,"replacement"]`. Every range is resolved against that immutable baseline. Capsule refuses the whole transaction before writing when the capsule is not a file baseline, its source path differs, the current file SHA is stale, line ranges overlap, or line and legacy text operations are mixed. Successful edits preserve the source BOM and CRLF line endings.

## Persistent index and memory

The bounded walker skips generated/vendor folders and follows symlinks only when explicitly enabled, with cycle protection. It supports include/exclude globs, `.gitignore`, extension and recursion limits, content chunking, and file-staleness metadata.

Search is local and deterministic. SQLite FTS5 runs Porter stemming and, where available, trigram substring matching. Reciprocal Rank Fusion, proximity reranking, typo correction, source/kind/tag/content filters, chronological sorting, and file staleness flags are applied. A catalog scan remains available if SQLite acceleration is unavailable.

SQLite uses WAL plus a bounded busy timeout so short-lived writers from hooks, searches, and indexing can coexist across processes. Environment diagnostics are advisory: Capsule never moves or restores skills without an explicit `skills apply|restore` request and `confirm:true`. `insight {history:true}` reads only the first session metadata record and file size from bounded Codex session catalogs; it does not parse prompts or tool outputs.

## Virtual skill router

`skills {operation:"route", query:"compact English task intent"}` uses rare-term and domain-phrase weighting plus a multi-term relevance floor and returns at most three short matches. It returns no match instead of a weak unrelated specialist. Read only the selected `skill_file`; its folder, scripts, references, and assets remain intact.

`skills {operation:"plan"}` measures the direct specialist catalog without changing it. `apply` moves only non-hidden top-level skill roots into `<CODEX_HOME>/capsule-skill-vault/snapshots/...`; `.system`, plugin-provided skills, and symlinks remain live. The move is same-volume and rollback-protected. `status` reports the active vault and avoided metadata estimate. `restore` refuses destination conflicts and returns every root intact. Apply and restore both require `confirm:true` and a Codex restart.

If the MCP transport is unavailable, resolve `scripts/skill-router.cjs` from the plugin root and run `node skill-router.cjs route "<intent>"`. This fallback uses the same dispatch implementation.

## Cognitive compiler

`cognition` moves finite branching work outside model generation. `cover` returns an exact minimum-cost requirement cover; `assign` computes an exact minimum-cost one-to-one task assignment; `knapsack` returns the exact maximum-value subset under an integer budget; `path` returns a deterministic non-negative shortest path; `dag` returns earliest parallel batches, cycle evidence, and a weighted critical path; `decide` min-max normalizes weighted criteria; `hypotheses` ranks binary checks by expected Shannon information gain per cost. Every solver returns an input SHA-256 certificate. Treat a complete certificate as settled computation and reason only about facts or judgment not encoded in its input.

`compile` safely pre-solves bounded arithmetic and structured cognitive packets embedded in a prompt. The `UserPromptSubmit` hook adds no context for trivial or unrecognized work, emits a short offload hint for branch-heavy work, and injects a compact verified result when a packet is solvable. Set `CAPSULE_COGNITION=0` to disable compilation and decision replay.

`governor {mode:"status"}` reports provider-recorded token counters for a session when its Codex JSONL is available. At prompt submission it snapshots cumulative reasoning usage; pre/post-tool hooks then emit at most one warning and one brake. Unless explicitly configured, thresholds adapt to context/quota pressure: normal 512/1,536, high 384/1,024, critical 256/640, and emergency 128/384 reasoning tokens. The governor reads only `token_count` records, not prompts, responses, reasoning content, or tool content. Override with `CAPSULE_REASONING_WARNING` and `CAPSULE_REASONING_BRAKE`, or disable it with `CAPSULE_REASONING_GOVERNOR=0`.

`remember` and `recall` reuse prior decision kernels. Automatic turn fingerprints contain only locally HMAC-hashed lexical terms, never the raw user prompt; a replay requires high similarity inside the same project and carries a stale-state guard. Assistant finals remain bounded and secret-redacted. If MCP is unavailable, use `scripts/cognition.cjs compile "<prompt>"` or pass structured JSON through `--payload`/`--file`.

## Execution and automatic hooks

`execute` supports JavaScript, TypeScript, Python, shell, Ruby, PHP, Perl, R, Elixir, Go, Rust, and C# when the matching local runtime exists. It runs in a temporary scratch directory; this is isolation for generated files, not an OS security sandbox.

The plugin ships `hooks/hooks.json` for Codex-native discovery through the current `features.hooks` flag. That bundle is the default. `scripts/install-hooks.cjs install` automatically removes its global fallback when native hooks are enabled; otherwise it installs an idempotent global fallback that resolves the current user and `CODEX_HOME`, preserves unrelated hooks, and replaces prior token-efficiency hooks. Never keep both sources active because Codex runs matching hooks from every source. Both paths provide pre/post-tool capture, session resume, pre-compact handoff, and stop memory. Automatic recall is project-scoped, sanitized, and defaults to one unique snippet; set `CAPSULE_RECALL_LIMIT=0..3` to change it. Raw prompt persistence is disabled unless `CAPSULE_CAPTURE_PROMPTS=1`. Migrated-context auto-injection is disabled unless `CAPSULE_INCLUDE_MIGRATED=1`.

Codex sends the completed tool result as `tool_response`. Capsule replaces eligible model-visible results with the supported `continue:false` plus `reason` contract; it never relies on `updatedMCPToolOutput` or `suppressOutput`. A `PreToolUse` `updatedInput` is emitted only together with `permissionDecision:"allow"` and only for narrow known-safe rewrites. Shell wrapping requires a single observational command from a strict allowlist and rejects mutation flags, redirection, pipelines, command substitution, and control syntax.

Media payloads are never copied into text capsules. Within one task, an exact repeated text result from a read, test, diagnostic, or observational shell/exec call becomes a compact reference across user prompts and tool identities. Results of at least 3,000 characters receive a content-addressed exact capsule even when their first appearance is below the normal compression threshold; this lets a byte-identical reread after compaction become a short expandable reference.

When the same serialized tool request later returns changed text, a multiset line-overlap gate can emit only bounded removed/added/error evidence plus `before=` and current `exact=` capsule IDs. The default minimum is 3,000 characters and the default overlap is 0.78; configure them with `CAPSULE_DELTA_CHARS` and `CAPSULE_DELTA_SIMILARITY`. Timestamp and duration fields are normalized only for the overlap decision. The complete current bytes always live in the current exact capsule. Low-overlap output, errors, and commands containing mutation, send, install, publish, deploy, commit, or push verbs remain on the ordinary full/compact path.

Set `CAPSULE_REPLAY_CAPSULE_CHARS` to 512-20,000 to change the capsule boundary. A normal new session clears the dictionary. Set `CAPSULE_TEXT_DEDUPE=0` to disable exact and delta replay. Mechanical replacements use short self-describing `[Capsule replay]`, `[Capsule delta]`, and `[Capsule exact]` tags without duplicating their explanation in added model context. The prompt hook may emit a cognitive certificate or replay, but raw prompt persistence remains disabled unless `CAPSULE_CAPTURE_PROMPTS=1`.

Explicit tool failures and structured nonzero/failed results have a separate ten-minute request-local fuse. The first failure and every changed error remain visible and receive an exact local capsule when large enough. Only a byte-identical error from the same serialized tool input is replaced by `[Capsule repeated failure]`, a bounded diagnostic, and its `exact=` capsule. A different argument, changed error, successful retry, or output without an explicit/structured failure signal bypasses suppression. Set `CAPSULE_FAILURE_FUSE=0` to disable it.

Successful shell/exec results drop redundant control fields such as zero exit code, wall time, chunk ID, original-token count, and repeated `session_command` while preserving the complete command body. Failures, live-job markers, and benchmark/performance/timing intents remain intact. Set `CAPSULE_CONTROL_ENVELOPE=0` to disable this transform.

Tool-output and `read_thread` budgets follow context, quota, and cache pressure. The runway predictor takes the median of recent positive input-growth observations and escalates before the next observation is projected to cross 90%. Locally reported primary/secondary quota use escalates at 70%, 85%, and 95% without claiming provider billing equivalence. An elevated uncached suffix raises the mechanical policy to high or critical before another large tool result is admitted. Normal mode keeps the former 5,000-character tool trigger and eight-turn/800-character history page. High, critical, and emergency modes progressively lower those limits to 3,000/4/400, 1,400/2/240, and 900/2/160.

Structured web-tool JSON results use a bounded recursive projection only when it is smaller. The projection remains valid JSON, retains identity/navigation fields plus embedded URLs and web reference IDs, and archives the complete result for exact recovery. If the navigation inventory cannot fit without loss, Capsule passes the result through. Generic JSON command output likewise remains parseable and exact-recoverable; invalid, small, or token-negative JSON passes through.

Direct `file` reads of canonical `.codex/sessions/*.jsonl` paths are protected by default: they return bounded provider/compaction telemetry without returning the raw transcript or creating a raw capsule. The default audit ceiling is 256 MiB; larger logs return metadata without being opened or archived. Literal access requires explicit `mode:"full"` or `require_full:true`. Session logs can contain prompts, tool data, and secrets, so literal access is security-sensitive; this guard is not a general secret detector.

Read-only `.codex/sessions` or `archived_sessions` JSONL output has a specialized projection when at least 85% of candidate lines parse as records. It reports bounded record/payload type counts, time range, largest-record hashes, and query-matched evidence, then stores the complete raw text in an exact SHA-addressed capsule. Ordinary JSONL paths, malformed mixtures, explicit full-output requests, failures, and small results use the ordinary path. Disable this layer with `CAPSULE_SESSION_QUERY=0` or the broader transcript shield with `CAPSULE_TRANSCRIPT_SHIELD=0`.

If ordinary compaction cannot safely shrink a payload, the pressure circuit emits a bounded secret-redacted evidence envelope with raw size, SHA-256, and exact capsule ID instead of allowing one tool result to overflow the thread. It applies at critical/emergency pressure, at high pressure above twice the active maximum, and at normal pressure for eligible read-only output above 32,000 characters. Exact evidence stays expandable, pagination remains available, and `includeOutputs:true` bypasses both thread preflight bounding and projection. Configure the normal cap with `CAPSULE_ABSOLUTE_OUTPUT_CHARS=16000..1000000`; set `CAPSULE_ABSOLUTE_OUTPUT=0`, `CAPSULE_THREAD_PREFLIGHT=0`, or `CAPSULE_THREAD_PROJECTION=0` for independent opt-outs.

## Poll and progress governor

Short `wait`/`wait_agent` calls are raised to a 60-second floor while still returning early for new output, completion, attention, or user input. A byte-identical quiet second result for the same serialized poll request becomes `[Capsule poll: exactly unchanged]`; changed output, another target, completion, failure, attention, user input, or a replacement that is not shorter stays full. Disable only this replay with `CAPSULE_POLL_REPLAY=0`. Consecutive poll/status calls receive bounded warnings at 2, 4, and 8. Four, eight, or sixteen read-only calls without a successful mutation trigger a no-progress warning that asks for reuse, a decisive diff/check, an executable change, or an explicit blocker. A repeated two-to-four-step mixed read/plan sequence triggers a separate sequence fuse; successful mutation clears its epoch. Set `CAPSULE_SEQUENCE_FUSE=0` to disable only that detector.

Planning and goal bookkeeping do not advance the implementation mutation epoch. A byte-identical second plan, or three/six planning calls without a real mutation, receives a bounded execute-or-block warning; one successful mutation resets the plan counters. The hook stores only a compact per-session execution ledger: recent inspected paths/counts, changed paths, test pass/fail markers, plan counts, last tool, and a mutation epoch. It never stores tool output in this ledger. The ledger is injected into the next compaction map as `P:` so mid-work progress can survive even when no assistant final checkpoint exists.

Virtualized skill routing defaults to one result. Phrase overlap alone cannot clear the relevance floor, adjacent phrases never bridge removed stopwords, security specialists require security-task intent, and token/context control-plane queries cannot accidentally load a specialist unless it is explicitly named. Pass a larger `limit` only when multiple specialists are genuinely required.

## Compaction flight recorder

The `PreCompact` hook reads only a bounded tail of the local Codex JSONL. It measures latest input/context counters, predicted runway, local quota percentage, 30-minute compaction churn, post-compaction occupancy, and retained inline-image risk, then selects one of four policies: normal 1,200 characters/600 summary tokens; high 1,000/500; critical 850/400; or emergency 720/280. Goal, state, a bounded prior-phase checkpoint, execution progress, changed files, and exact capsule IDs receive independent budgets, so long prose cannot evict later evidence. The compactor is instructed to perform a mechanical copy without analysis or re-derivation and to omit repeated logs, tool arguments, superseded exploration, inline/base64 media, and active system/developer/AGENTS/skill/memory/app-context packets that Codex reinjects.

Assistant finals are stored as secret-redacted 800-character phase checkpoints. Starting with the second compaction, only the latest checkpoint is allowed into the continuation map, capped at 420 characters. This rolling handoff targets progressive amnesia without repeatedly growing the summary. Raw prompts are not added to persistent Capsule storage by this feature.

Call `insight` with `compaction:true` plus `session` or `session_file` to audit observable transitions and receive `context_pressure`. The compact default reports aggregates and only the latest event; pass `compaction_events:true` and optional `compaction_event_limit` when exact bounded rows are needed. Codex currently does not expose the compactor model's own generation usage in session telemetry, so a zero adjacent delta is reported as unexposed, never as proof that compaction was free. These figures are context exposure, not billing claims.

When local `token_count` telemetry shows a costly uncached suffix, `UserPromptSubmit` emits one short `[Capsule round-trip tax]` hint per distinct usage sample with the uncached count and cache-hit percentage. The observer can classify a `post-compaction-cache-miss`, `request-input-shrank`, mid-loop cache dropout, or large uncached request. These are heuristic timing/counter correlations from session counters and cannot prove a provider-side cause or prompt-prefix mutation: Capsule cannot set Codex's wire-level `prompt_cache_key` or cache breakpoints, nor control host compaction and retry behavior. This is local exposure telemetry, not a provider billing or direct-savings claim. Set `CAPSULE_ROUNDTRIP_TAX=0` to disable it.

Self-contained subagent tasks are automatically changed from an omitted or `all` fork to `none`. Multilingual deictic continuations use a three-turn recent window; explicit multilingual requests for the whole conversation preserve full history with a measured warning. Explicit `none` or windows up to five turns remain untouched. Spawn-count checkpoints are included in no-progress guidance. Set `CAPSULE_FORK_POLICY=observe` for warnings only or `off` to disable the policy. The first Codex restart may request trust for the new local commands.

Hook capabilities end at Codex hook boundaries: they can rewrite allowed tool input, replace a completed tool result, and add bounded context, but cannot remove the base system/developer/user prompt, change provider cache keys or billing, expose hidden compactor generation, make waits event-driven, or retract an answer after generation. The skill therefore asks the model for the smallest complete answer while honoring explicit detail requirements.

`gain` defaults to events marked effective under a current delivery contract or returned directly by the MCP. Historical hook rows without such a marker are retained but excluded; pass `include_unverified:true` only to audit them. Every gain remains a local model-exposure estimate, not end-to-end host delivery proof or a provider billing statement.

The local filter pipeline supports ANSI stripping, regex replacement, output short-circuiting, line removal/retention, truncation, tail/head limits, and empty-output summaries. Project `.capsule-filters.json` files use a content-hash trust gate. `learn` scans bounded local Codex session files for fail-then-correct command pairs; writing a project rule file requires `write:true,confirm:true`.

## Visual replay policy

Use `detail:"high"` for ordinary `view_image` inspection. Escalate to `detail:"original"` for pixel-exact details, tiny text, OCR, measurement, or forensics.

The hook always passes the first visual result in a user turn. It also passes changed pixels, changed accompanying text, a different detail level, the first result after a new prompt, and the first result after session start or compaction. Within the same user turn and detail level, only a byte-identical complete media result is replaced by a compact reference; identical results can be recognized across different file paths. The local replay cache stores hashes, sizes, timestamps, and request hashes—not image bytes or paths—and keeps at most 32 recent entries per session. Set `CAPSULE_MEDIA_DEDUPE=0` to disable this behavior.

Run `npm run benchmark:media` for the deterministic media-envelope A/B check. It measures serialized context characters, not provider image tokens or billing.

## Storage and limits

Default state, including HMAC-fingerprinted decision kernels:

- Windows: `%LOCALAPPDATA%\Capsule`
- XDG: `$XDG_STATE_HOME/capsule`
- fallback: `~/.local/state/capsule`

Override with `CAPSULE_STATE`. Captures and indexing write only under that state root. A strict no-write task must not invoke capture or indexing.

`stats` estimates text-equivalent tokens at four characters each. Media and compaction-safe replay accounting records avoided serialized characters; it does not claim provider image-token or billing equivalence. The compaction audit uses provider-recorded input counters where available but cannot observe hidden compactor generation. Generated answers, provider caching, latency, and billing remain excluded.
