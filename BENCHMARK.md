# Capsule benchmark record

Capsule's public release line begins at **1.0.0**. Benchmark commands and result
files below use capability-based names and do not encode product releases.

## Structural change and edit payload A/B

A real unified-diff fixture from `openai/codex`
(`main~1...main.patch`) contained **6,735 characters and 1,983 estimated
tokens**. The structural change-summary contained **269 characters and 97
estimated tokens**, a **96.01% character reduction** and **95.11% estimated
token reduction**. All five old/new hunk ranges were preserved, and the
complete patch remained recoverable from its exact capsule.

This row measures one valid unified-diff projection. It is scenario-specific:
it is not an all-task, provider-cache, hidden-reasoning, subscription-limit, or
billing saving. Small, malformed, explicitly verbatim, or token-negative
results can take another path or pass through.

A synthetic edit-payload fixture replaced one region in a generated 180-line
function. Serializing the legacy old-plus-new replacement required **11,818
characters**; referencing an existing exact file capsule with
`["l",start,end,text]` required **99 characters**, a **99.16% payload-character
reduction**. This measures only the serialized edit instruction. It excludes
the baseline read/capsule creation, tool envelopes, model reasoning, provider
input, and the frequency with which such edits occur.

The line-edit path refuses stale or wrong-path baselines, overlapping ranges,
and mixed line/text operations before any file write, and preserves BOM/CRLF.
Windows `.cmd`, `.bat`, and `.ps1` execution planning and cache-incident
classification are correctness/diagnostic changes; no direct savings are
attributed to them here. The labels `post-compaction-cache-miss` and
`request-input-shrank` describe heuristic timing/counter correlations only;
they cannot prove a provider-side cause or prompt-prefix mutation.

## Additional bounded-projection A/B rows

A captured structured-web result fell from **34,287 to 3,578 characters
(89.56%)** while remaining valid JSON; all **62/62** URL and web-reference tokens
were retained, and the full result was archived for exact recovery. Two generic
JSON fixtures fell from **5,597 to 1,342 characters (76.02%)** and from **6,068
to 1,330 (78.08%)**. These are result- and budget-specific output projections,
not whole-task or universal savings rates.

The protected session-log path was tested with a synthetic self-ingestion case:
model-visible exposure fell from **441,299 characters / about 73,880 estimated
tokens** to **1,891 / about 686**, reductions of **99.571%** and **99.071%** on
that fixture. No raw transcript marker leaked and no raw capsule was created.
The default protected audit ceiling is **256 MiB**; a larger session log returns
bounded metadata without opening or archiving the log. Session logs can contain
prompts, tool data, and secrets, so explicit literal access must be treated as a
security-sensitive action; the guard is not a general secret detector.

The capability-airlock plan estimated **20,568 characters / about 5,142 tokens**
of static skill metadata avoided per request and a **1,319-character / about
330-token** dynamic anchor, for a net estimate of about **4,812 tokens per
request**. This is a configuration-size estimator, not provider telemetry or a
billing measurement. Refresh also prevented an exact duplicate **163-character /
about 41-token** block from being re-added; that is duplicate prevention against
a measured baseline, not a current realized saving.

## Quota-to-Progress Exchange and Context Antimatter

Fifty-four current searches (18 GitHub, 16 Reddit/X, and 20 official OpenAI searches) converged on a gap that raw compression cannot solve: credits can be dominated by generated output/reasoning, long threads can repeatedly re-read state after compaction, and stale resolved state can re-enter the continuation. User reports are treated as reports; only official or maintainer statements are used as product facts.

The Quota-to-Progress Exchange prices each turn with provider-reported uncached input, discounted cached input, and six-times-weighted generated tokens, then relates that cost to mutation, verification, tool, and completion receipts. It stores no raw prompt or final response. An expensive low-progress turn causes one bounded next-turn policy targeted at its dominant component; efficient verified work remains silent.

Context Antimatter makes invalidation first-class. Verified/resolved prompt fingerprints and superseded generational roots become bounded tombstones in the PreCompact live graph. A matching unchanged-epoch repeat receives a compact anti-memory receipt instead of silently reopening finished exploration. Tombstones are exact-recoverable with the generation capsule and cannot delete current positive state.

`npm run benchmark:qpx:write` exercises ten synthetic frequent verified-repeat continuations and ten changed-epoch neutral controls. Policy and neutral oracles pass **10/10 + 10/10**. On the eligible repeated-state context only, exposure falls from **5,146 to 770 estimated tokens: 85.04%**. This is a synthetic activation measurement, not a workload frequency, hidden-reasoning, cache, limit, or billing percentage. Low-progress brakes add a bounded instruction and are deliberately excluded from the direct-savings row.

No universal provider-billing percentage is claimed. The controller changes future behavior, so executable safety/activation tests and post-install live receipts are reported separately from deterministic context-exposure benchmarks. Full rows are in `bench/quota-progress-exchange-results.json`.

## Intent-evidence routing and historical false-positive replay

A retrospective audit of 80 route events from 30 recent Codex session files found that the production capability catalog had outgrown the router's original evidence rule. Four betting-market tasks were sent to the `artifact-template-market-trends-report` presentation skill, a model-output design request was sent to `improve-codebase-architecture`, a web-traffic investigation was sent to desktop-only `thick-client`, and a Capsule output-token question unnecessarily loaded the meta-router. The same sample contained 22 route-schema errors caused by missing canonical `query` fields.

The root cause was not semantic model judgment: a bag-of-words IDF shortcut allowed one rare name term to anchor an arbitrarily long query. As the airlock began routing the combined vault and installed-plugin catalog, words such as `market`, `architecture`, and `client` became rare enough to receive scores above 100 even when the requested deliverable or modality contradicted the skill. Template descriptions such as “use when the user selects or names…” and internal prerequisites such as “use only after…” were indexed as ordinary positive words. The benchmark contained only positive cases and small synthetic catalogs, so abstention quality was not measured.

The intent-evidence router removes the multi-term single-word shortcut; recognizes explicit template titles, internal downstream prerequisites, codebase/desktop/CTF modality, router ownership, and exact one-term file-type names; and accepts the canonical `query` field. The generated airlock instruction requires a conservative literal paraphrase instead of an embellished inferred intent.

`npm run benchmark:router-quality:write` now replays eight exact historical false positives against the current real catalog, including the twice-observed live failure where `What is the current status?` matched Gmail inbox triage through the description boilerplate words `what` and `the`. False positives fall from **8/8 to 0/8**. Five explicit positive controls for Market Trends Report, codebase architecture, desktop thick-client testing, the Capsule router, and Gmail inbox triage remain **5/5**. The independent 163-skill positive benchmark remains **15/15 (100%)** while exposing an average **152.53 route tokens** instead of **26,391 catalog-metadata tokens per task**, a **99.42% marginal metadata reduction**. Reports are in `bench/router-quality-results.json` and `bench/skill-router-results.json`.

## Audited semantic-exact terminal wire

The semantic-exact terminal audit found and fixed two correctness defects in the preceding implementation: Terminal Genome normalized timestamps and durations before cross-command hashing, so a material change such as `100ms -> 10s` could disappear from the visible projection; and mixed size/duration columns were ordered by their bare number, so `2MB..900KB` could be reported backwards. It also corrected hidden-line counters, reserved visible budget for critical/new evidence, added literal bypass for benchmark/performance/raw/full/verbatim shell requests, and unified native matching for shell, Bash/sh/zsh/fish, PowerShell/pwsh, cmd, terminal, exec, local-shell, and write-stdin tool names.

`npm run benchmark:terminal-real:write` executes read-only commands against this actual checkout and feeds their complete shell envelopes through the real `node scripts/hook.cjs posttooluse` stdin/stdout process. It includes first-seen listings and hashes, a warm partial-overlap pair, source search, focused and full tests, hook/plugin status, runtime/npm output, a real failed command, and literal performance/verbatim negative controls. All **15/15** wire, exact-recovery, critical-evidence, and passthrough oracles pass. In the recorded 2026-07-28 run, the Terminal Lattice/Genome layer activates on four cases and reduces exact `o200k_base` model-visible output from **2,712 to 545 tokens: 79.90%**. The complete existing shell pipeline, including non-Terminal exact compressors and control-envelope removal, reduces **16,713 to 4,415 tokens: 73.58%** across all fifteen cases. The latter is not attributable to Terminal Lattice/Genome alone; small run-to-run token variation is possible because real wall times and content-addressed capsule IDs are part of the wire payload.

`npm run benchmark:terminal-fuzz:write` runs 320 deterministic property cases covering structured, Unicode, critical-safe, critical-heavy, unstructured, failed, literal, and warm semantic-change outputs. All **320/320** pass; 160 activate; exact `o200k_base` token regressions, false activations, and missed expected activations are all **0**. Activated synthetic stress output falls from **566,744 to 28,117 tokens: 95.04%**. This is a robustness result, not a real-usage percentage.

The original activation fixtures remain useful only as upper-bound feature tests. Re-measured under the semantic-exact implementation, first-seen synthetic output falls from **34,694 to 1,358 tokens: 96.09%**, and the synthetic four-command chain falls from **57,932 to 2,188: 96.22%**. Full reports are in `bench/terminal-real-wire-results.json`, `bench/terminal-pareto-fuzz-results.json`, `bench/terminal-lattice-results.json`, and `bench/terminal-genome-results.json`.

These measurements cover model-visible local hook output, not hidden prompts, hidden reasoning, provider caching, subscription quota accounting, or billing. Short, unstructured, failed, literal-evidence, critical-heavy, and token-negative results intentionally pass through.

## Terminal Lattice and Universal Terminal Genome synthetic activation A/B

The original Terminal Lattice fixture repeats one generated line grammar under ten shell-family labels; it is synthetic activation evidence, not ten independently captured shell formats. Under the corrected implementation, all **10/10** cases activate and pass, and exact `o200k_base` output falls from **34,694 to 1,358 tokens: 96.09% saved**.

The Terminal Genome fixture likewise uses generated shared boilerplate. Across ten labels and four commands each, all **10/10** family oracles pass and output falls from **57,932 to 2,188 tokens: 96.22% saved**. These are synthetic upper-bound feature results.

## Universal Terminal Genome A/B

The Terminal Genome benchmark runs ten shell families with four different successful commands per family. It preserves the first output, then removes task-visible semantic lines already carried by earlier commands while retaining every new line and an exact capsule. The selector is command-name independent and Pareto-bypasses small, unique, failed, or token-negative output. Full measured results are in bench/terminal-genome-results.json.

## Zero-Inference Poll Reactor A/B

`npm run benchmark:zero-poll:write` measures 15 warm-state status-wait scenarios: GitHub Actions, Kubernetes, and a Git worktree at 8K, 32K, 96K, 160K, and 240K context sizes. Arm A returns five successive status observations through five model re-entries. Arm B recognizes the second unchanged observation, coalesces four bounded local observations in the native shell wrapper, and returns only when the semantic state changes.

All terminal-state oracles pass (**15/15**) and every local observation remains exactly capsule-recoverable. Model re-entries fall from 5 to 1 (**80%**) and exact `o200k_base` post-tool input exposure falls **79.99% on average**. The aggregate result payload itself falls **14.70%**. A cold status call is byte-preserving; the benchmark uses deterministic command executors so that both arms see the same state sequence.

This is a warm repeated-poll result, not an all-task or billing percentage. Cold calls, non-status commands, contexts below the activation floor, mutations, composed shell commands, failures, cache pricing, hidden reasoning, and the probability that polling would continue for the full horizon are excluded. In production, the horizon is context-priced from 10 to 45 seconds, capped at 55 seconds; local Git/path/tail candidates use filesystem events where the platform supports recursive watching and interval fallback elsewhere.

## Real Codex hook-wire A/B

`npm run benchmark:hook-contract:write` runs isolated A/B workers from the same hook-contract fixture, with a deterministic seed (`549519342`), separate state roots, 30 eligible plus 30 negative controls per family, and one exact `tiktoken 0.12.0` `o200k_base` batch over 360 model-visible strings. The treatment uses Codex's supported `PostToolUse` replacement shape (`continue:false` plus `reason`); the control returns the original tool result.

Across 90 eligible cases, model-visible payloads fell from **394,080 to 13,731 tokens: 96.52% saved**. Across all 180 cases, including 90 deliberately untouched controls, they fell from **434,596 to 54,247: 87.52% saved**. The three eligible-family results are **99.65%** for large hook-contract outputs, **78.68%** for exact quiet poll repeats, and **55.62% incremental** for structured `.codex/sessions` projection compared with the existing generic transcript shield. All 90 negative controls have **0 token change and 0 false positives**; all 180 treatment quality oracles pass. Full results are in `bench/hook-contract-results.json`.

These are feature-activation task-set results, not a universal usage percentage. Fixed prompts, hidden reasoning, provider cache/billing, host compaction envelopes, short novel outputs, failures, terminal polls, and explicit full-output requests are excluded or intentionally pass through. Local live telemetry is therefore reported separately and is expected to be lower.

### Correction to the historical simulated figures

The legacy simulated benchmark below measured a compressor candidate exposed through `updatedMCPToolOutput`. Current Codex parses that field but does not support it as a `PostToolUse` replacement, so **97.76% eligible and 56.95% mixed were simulation/projection figures, not verified real Codex delivery**. The contract-valid benchmark retains those rows only as historical compressor tests, excludes legacy hook events from default `gain`, and uses the verified A/B above for its shipped claim.

## Historical simulated round-trip A/B

`npm run benchmark:roundtrip-contract:write` compares two isolated arms of the same code fixture: A disables the five policies with environment switches; B enables them. The deterministic seed is `549519342`. Exact model-visible payload counts use one batched `tiktoken 0.12.0` `o200k_base` pass over 481 strings rather than a character approximation.

The direct corpus has 90 eligible and 90 negative-control tasks, with 30+30 cases each for successful exec control envelopes, normal-pressure oversized-output circuits, and subagent fork exposure. On the 90 activated cases, exact input-token exposure fell from **4,363,296 to 97,541: 97.76% saved**. On the mixed 180-case corpus—including all deliberately untouched failures, live/timing outputs, bounded/history-dependent forks, and below-threshold payloads—exposure fell from **7,489,644 to 3,224,084: 56.95% saved**.

Per eligible family, exact-token savings are **52.56%** for redundant successful exec envelopes, **97.82%** for oversized high-entropy output, and **94.67%** for self-contained subagent fork exposure. Oversized-output exact recovery is **100%**. All 90 negative controls are byte-preserving passthroughs, with **0 false positives**.

The read/plan sequence fuse and cache-aware round-trip tax use 30 positive and 30 negative detection cases each. Detection is **100%**, false positives are **0**, and cache-tax duplicate suppression plus changed-sample re-detection are **100%**. These warnings are not counted as direct savings because a warning alone does not prove that a future model/tool call was avoided. The cache-tax signal also tightens output/history budgets mechanically; provider caching, billing, hidden prompts, output tokens, latency, and image tokens remain outside this benchmark.

The historical suite passed **107/107** tests. Full rows and gates are in `bench/roundtrip-contract-results.json`; they do not prove host delivery.

## Wrong-route, repeated-failure, and plan-loop A/B

`npm run benchmark:guardrails:write` compares the installed baseline with the guarded treatment. The routing set contains nine local task intents: two Capsule control-plane negatives, two domain/name-collision negatives, two tasks already served by direct skills, and three positive security controls. Accuracy rose from **55.56% to 100%**. The set includes the exact live false positive that sent this release task to `hunt-session`; the treatment returns no specialist for that request while keeping the session, SQL-injection, and OAuth security routes correct. Across wrong routes, avoided mandatory skill reads total **38,396 characters**, approximately **9,599 text-token equivalents**.

For a deterministic byte-identical 27,319-character tool error, the second failure plus retry guidance fell from **1,312 to 331 model-visible characters: 74.77%**. The first error, a changed error, and the same error after changed input remain unsuppressed; both arms retain exact recovery. The plan control detects the second identical plan under treatment, does not detect it under baseline, and produces no warning after a successful implementation mutation.

Across only the measured waste events (wrong skill bodies plus the repeated error), model-visible characters fell from **39,708 to 331: 99.17%**, approximately **9,845 text-token equivalents**. This deliberately excludes the plan-loop turn because assigning it a provider-token value would be speculative. It is a targeted waste-event A/B, not an all-task billing percentage; normal tasks with no matching waste pattern remain silent.

The complete executable regression suite passes **102/102** tests.

## Delta replay and self-overhead A/B

Measured on 2026-07-28 against the preceding installed baseline.

`node bench/delta_control_ab.cjs --sessions 120 --limit 100 --write bench/delta-control-results.json --summary` used non-media outputs from the 120 most recently modified readable local Codex sessions. For an exact second replay of 100 real outputs, baseline exposed 1,533,978 characters while treatment exposed 6,926: **99.55%**, approximately **381,763 text-token equivalents**, with **100/100 exact recovery**. This row measures a counterfactual duplicate replay of real outputs; it is not a claim that every task repeats them.

The changed-output arm paired only actual outputs whose tool name and serialized input were identical. Across 100 pairs, the conservative selector activated delta replay on 8 high-overlap pairs. Those activated pairs fell from 60,884 to 2,748 characters: **95.49%**, with **8/8 exact current-output capsules**. Across all 100 changed pairs—including 92 safe passthroughs—the weighted reduction was **1.62%** and exact recovery was **100/100**. Errors, low-overlap results, and commands containing mutation/send/install/deploy verbs do not use delta replay.

Control notices are now self-describing compact tags, so a transformed result no longer repeats its capsule explanation in `additionalContext`. Reasoning-governor thresholds adapt from 512/1,536 in normal mode to 384/1,024 high, 256/640 critical, and 128/384 emergency. These are deterministic activation thresholds, not a standalone claim about model reasoning tokens saved.

The full executable suite passes **99/99** tests.

## Predictive runway and loop A/B

Measured on 2026-07-28 against the preceding installed baseline.

`npm run benchmark:adaptive:write -- --summary` replayed 46 non-media outputs from the 12 most recently modified local Codex sessions. Treatment reduced model-visible characters from **498,095 to 388,292: 22.04%** overall. All 34 normal-pressure samples were byte-for-byte neutral. The 12 samples placed in critical mode by occupancy/runway/churn fell from **118,089 to 8,286 characters: 92.98%**, with **12/12 exact SHA-256 + capsule recovery paths**.

`npm run benchmark:loop:write` replayed 20 real 3,000-4,999-character read results after a simulated compaction. Baseline re-exposed 80,290 characters; treatment exposed 3,700 including its capsule dictionary: **95.39%**, approximately **19,148 text-token equivalents**, with **20/20 exact recovery**.

The same benchmark inspected 100 recorded wait calls from recent local sessions without copying prompts or outputs. Treatment raised 99 short waits to a 60-second floor. Under a periodic-poll counterfactual, this reduces possible polling cadence **85.75%**. This is a scheduling-rate model, not a token, credit, latency, or billing claim; event-driven completion can return earlier.

The full executable suite passes **96/96** tests. These additions target abrupt tool-output overflow, rate-limit-aware conservation, repeated post-compaction rereads, quiet polling, and no-progress analysis loops. They do not claim positive savings when normal passthrough is safer.

## Adaptive context-pressure A/B

Measured on 2026-07-28 against the preceding installed baseline.

`npm run benchmark:adaptive:write -- --summary` replayed 46 non-media tool outputs drawn from the 12 most recently modified local Codex session logs. The report stores only session basenames, output sizes, pressure modes, and recovery booleans; it does not copy tool content. Normal-pressure cases were unchanged: **0% saving and 0% regression across 34 samples**. Critical-pressure cases fell from **65,621 to 48,461 visible characters: 26.15%**. Retained-image emergency cases fell from **76,218 to 68,808: 9.72%**. Across all modes the weighted saving was **4.71%**, or approximately **6,143 text-token equivalents**, and every transformed sample retained an exact capsule recovery path.

The adopted critical compaction policy uses an <=850-character field map and <=400-token summary target. A real-model AB/BA run retained **16/16 critical facts in both arms**. Provider-reported output fell from **1,253 to 707 tokens: 43.58%**, and local prompt-plus-output fell **2.05%**. The whole-call counter worsened 1.72% because cache exposure differed, and reasoning output rose from 106 to 233; therefore this run is evidence for shorter visible continuation output, not a claim of reasoning-token or billing savings. The deterministic cognition benchmarks remain the evidence for reasoning offload.

These workload-specific results are not universal. The selector deliberately returns exact passthrough under normal pressure or when safe compaction cannot beat the source.

## Recent-task and real-model A/B

Measured on 2026-07-27 with `tiktoken==0.12.0` and GPT-5's `o200k_base` encoding.

### Recent-task control-plane savings

`npm run benchmark:recent:write` compared the preceding installed baseline with treatment on the five most recent local Codex task logs without reading their prompt content into the model. Two generic Capsule self-management queries previously routed to unrelated security specialists. Counting the route response plus the `SKILL.md` reads required by those positive matches, exposure fell from **42,032 to 585 characters: 98.61%** (approximately **10,362 text tokens avoided**). The direct route-response reduction alone is smaller; the 98.61% figure includes prevented follow-on skill reads.

Across four recent tasks containing 86 automatic compactions, default serialized `insight {compaction:true}` output fell from **23,681 to 4,968 characters: 79.02%** by retaining aggregates and the latest event instead of replaying every row. Exact bounded rows remain available with `compaction_events:true`. Across five recent task tails, the field-budgeted `PreCompact` map fell from **5,581 to 3,992 characters: 28.47%** while protecting goal, state, file, and capsule fields from one another.

The adopted real-model AB/BA run used two noisy continuation tasks. Both arms retained **16/16 critical facts**. The direct <=600-token/no-re-derivation map reduced output from **1,559 to 604 tokens: 61.26%**, reasoning output from **218 to 93: 57.34%**, and local prompt-plus-output from **11,965 to 11,327 tokens: 5.33%**. The provider's whole-call counter fell **28.44%** in this run, but cache exposure differed substantially, so the output, reasoning, and local incremental comparisons are the stronger evidence. An earlier formulation was rejected because it raised reasoning from 133 to 159 and worsened the whole-call counter by 0.58%, despite reducing visible output.

Assigned credentials and bearer values remain redacted, but ordinary prose such as `Capsule` and `reasoning-token growth` is no longer corrupted. The new tests cover emitted output, automatic memory, and reusable cognition kernels.

These are workload-specific A/B results, not universal provider-billing claims. Image tokens, latency, provider caching, and hidden automatic-compactor generation are excluded from local character estimates.

### Historical automatic compaction flight recorder

The current real Codex task contained ten automatic compactions. Immediately before compaction, provider-recorded input averaged **222,460 tokens**; the first nonzero call after compaction averaged **25,558.7**, of which **15,104** was cached and **10,454.7** uncached. The observable context reduction was **88.51%** (range of post-compaction inputs: 22,620–28,183).

The cumulative token counter changed by **0** at all ten adjacent compaction-reset records. This does **not** mean compaction was free: Codex session telemetry does not expose the compactor model's own generation usage. `insight {compaction:true}` now reports that distinction, the pre/post distributions, replacement-history size, and event rows instead of inventing a hidden cost.

The new `PreCompact` flight recorder emits a secret-redacted continuation map capped at 1,600 characters, retains the latest task objective even when an earlier compaction occurred mid-turn, and requests a summary of at most 900 tokens. A real-model AB/BA benchmark used two noisy continuation transcripts. Both arms retained every tested critical fact (**2/2 tasks; 16/16 facts**). Summary output fell from **1,666 to 899 tokens: 46.04%**. Reasoning output fell from **245 to 134 tokens**. After adding the treatment map's exact local `o200k_base` prompt cost, prompt-plus-output fell from **12,072 to 11,596 tokens: 3.94%**; the provider's complete input-plus-output counter, including shared Codex context and caching, improved **0.44%** in this small run.

Large read-only evidence now survives compaction only when an exact content-addressed capsule exists. Against the preceding ordinary post-compaction reprocessing behavior, three 64 KiB/256 KiB/1 MiB cases fell from **1,739 to 555 model-visible characters: 68.09%**. Treatment accounting includes both the `PreCompact` capsule dictionary and later replay reference. Changed large evidence and uncapsuled small evidence remained full; all safety controls passed.

The 46.04%, 3.94%, 0.44%, and 68.09% figures apply to these explicit compaction microbenchmarks, not every task. The dominant live 25.6K post-compaction context includes base system/developer/user material that a plugin hook cannot remove. The next real compaction after installation is required to measure how much the shorter continuation summary reduces that live tail.

| Deployment simulation | A tokens | B tokens | Weighted saving | Regressions |
|---|---:|---:|---:|---:|
| Selective unified engine | 2,738,787 | 185,734 | **93.22%** | **0 / 48** |
| Selective engine plus implicit skill body | 2,738,787 | 194,444 | **92.90%** | **0 / 48** |
| Tool schema forcibly charged on every task | 2,738,787 | 189,210 | 93.09% | 22 / 48 |
| Schema and skill forcibly charged on every task | 2,738,787 | 205,290 | 92.50% | 22 / 48 |

The deployed selector saved tokens on 26 tasks and routed 22 tiny, non-applicable, or unsafe-to-compress tasks unchanged. That produced **100% task-level non-regression** and zero deterministic evidence failures. Positive-task savings ranged from 50.60% to 99.92%; transformed tasks saved **99.69%** in aggregate.

## Virtual skill-catalog A/B

`npm run benchmark:skills` measured this machine's 163 non-system direct skills with `o200k_base` after live virtualization. Arm A exposed all metadata on every task: **26,391 tokens per task**. Arm B exposed one compact route result: **377.33 tokens on average**. Across 15 APK, binary, SQLi, IDOR, OAuth, reporting, browser, PDF, diagnosis, Web3, AD, firmware, .NET, cloud-IAM, and pwn tasks, the expected specialist appeared in the top three **15/15 times**.

The marginal weighted saving was **98.57%**. A multi-term relevance floor also returns no match when only a weak ambiguous term overlaps, preventing irrelevant skill text from entering context. Selected `SKILL.md` bodies cancel from both arms; `.system` and plugin skills are excluded and remain directly available. Apply/restore is explicit, same-volume, conflict-safe, rollback-protected, and retains whole skill folders in a reversible vault.

## Real-model reasoning A/B

`npm run benchmark:reasoning:model` ran seven symbolic tasks through separate ephemeral, read-only `codex exec` sessions. Arm A solved exact cover, DAG scheduling, weighted choice, diagnostic information gain, exact assignment, exact knapsack, and shortest path inside model generation. Arm B received the deterministic result plus its input SHA-256 certificate and was told not to recompute. AB/BA order alternated.

Both arms were correct on **7/7** tasks. Provider-reported `reasoning_output_tokens` fell from **1,037 to 8: 99.23%**. Total output fell from **1,179 to 140 tokens**. The assignment baseline already used zero reasoning tokens, so that task was neutral rather than a claimed win. This is a small real-model sample with one repetition, not a universal rate; raw rows are retained in `bench/reasoning-model-results.json`.

The deterministic companion benchmark moved **626,404 symbolic search states** outside generation across seven fixtures, returned 2,732 model-visible characters, passed **7/7** known optima, added zero hook context to **10/10** trivial prompts, and detected **7/7** branch-heavy prompts. Search states are not equated to provider tokens.

## Closed-loop reasoning governor

At each user prompt, the governor snapshots the cumulative provider-recorded reasoning counter for that Codex session. Pre/post-tool boundaries read only later `token_count` records and emit at most one warning at 512 reasoning tokens and one brake at 1,536 by default. The brake asks the model to finish the minimum verified path instead of opening new branches. Tests cover exact baseline/delta parsing, warning and brake transitions, duplicate suppression, hook delivery, and status reporting.

The governor does not inspect prompts, responses, hidden reasoning, or tool content. It cannot retract reasoning already spent before the first tool boundary, so no standalone percentage is attributed to it. Its value is closed-loop control across multi-step tool-using turns; the 99.23% figure above belongs specifically to deterministic cognitive certificates, not to the governor.

## Corpus

The 48 deterministic tasks cover:

- tiny reasoning, writing, media, and structured artifacts where the engine must stay out;
- threshold boundaries, low-token-density counterexamples, high entropy, Unicode, minified data, JSON, logs, source, HTML snapshots, and command output;
- test/build failures, multi-island evidence, semantic distractors, complete-file edits, changed and unchanged reruns;
- persistent first/repeat search, fetch-and-index retrieval, and durable session-memory recall.
- a synthetic root-plus-12-child Codex history where the metadata-only fan-out audit saved **99.51%** while proving that prompt/tool content stayed unread.

Each task retains expected literal evidence. Complete-content routes are decoded and compared byte-for-byte. Full task rows and source hashes are in `bench/unified-results.json`. The executable suite separately validates Porter/trigram search, typo correction, staleness, batch inline queries, TTL fetch caching, multi-language execution, local filters/gain, hooks, and MCP discovery.

## Visual replay A/B

`npm run benchmark:media` sends five byte-identical `view_image` results at each of three serialized payload sizes: 64 KiB, 256 KiB, and 1 MiB. A sends all five full media envelopes; B sends the first full envelope and four compact references.

The weighted five-view sequence saving was **79.95% of serialized media-envelope characters**. The second-and-later duplicates individually saved **99.59% to 99.97%**. All safety checks passed: the first view, a changed result, a new user turn, and a `high`-to-`original` detail escalation remained full.

This microbenchmark does not estimate provider image tokens, billing, latency, or visual quality. Its percentage applies only when an exact replay occurs; a task with no byte-identical visual replay receives **0% from this feature**.

## Model-I/O boundary A/B

`npm run benchmark:io` exercises eight deterministic hook/schema scenarios. Five identical read-only results saved **99.51% to 99.97%** of exposed characters across 64 KiB, 256 KiB, and 1 MiB payloads. Reloading identical 256 KiB evidence across two user turns and different read-only tools saved **99.93%**. Progressive exact expansion saved **59.35%** against the former 6,000-character default while returning a continuation cursor.

A task-history fixture containing a 480,553-character tool argument/result saved **99.93%** while retaining the user request and final decision. A synthetic 20-turn self-contained subagent fork saved **84.18%** by retaining three turns. The MCP contract is **742 characters** with all 27 actions.

The history and repeated-read rows measure actual hook replacements. The subagent row is a controlled context fixture, not provider telemetry. Changed evidence, mutating tools, new user turns, explicit task-output requests, and history-dependent forks are safety controls.

## What the percentage means

A is the prompt plus full raw evidence. B is the same prompt plus the selected Capsule result and measured MCP schema/server-instruction cost when a transform is emitted.

This is input-context exposure, not provider billing or end-to-end answer quality. It excludes generated-answer tokens, model correctness, tool-call envelope fields, provider caching, latency, CPU, and storage I/O. Persistent-search cases compare reloading a corpus with querying a previously built local index.

The forced-eager rows are sensitivity tests, not the deployment policy: repeatedly charging a nonzero schema against every tiny task creates local regressions. The installed selector avoids that route and returns exact passthrough for those cases.

## Refactor proof packet A/B

`npm run benchmark:refactor` compares the ordinary project evidence packet with
the delta-first `operation:refactor` path. The latter exposes symbol spans,
hashes, dependency/importer edges, impacted tests, and one exact manifest rather
than repeating selected file bodies; its warm scan reuses unchanged mtime/size
metadata and reports `hashed=0`. The result is target-specific input exposure,
not a universal provider-token or billing claim.

## Historical workload audit

A deep sample of 60 recent local root tasks contained 487 turns, 14,735 tool calls, 164.23 million tool-output characters, and 87 compactions. Tool output dominated assistant text by roughly 142:1. Its 28 `view_image` outputs occupied 24.44 million recorded session characters, and 156 of 190 sampled subagent spawns requested full-history forks.

These byte and call counts are workload diagnostics, not provider-token or billing claims. They motivated bounded history retrieval/projection, exact read and visual replay suppression, automatic fork bounding, and one-snippet project recall.

## Reproduce

```powershell
python bench/ab_benchmark.py --cases unified_cases.cjs --write bench/unified-results.json --summary
node bench/io_surface_benchmark.cjs --write bench/io-surface-results.json
python bench/skill_router_benchmark.py --write bench/skill-router-results.json
node bench/cognition_benchmark.cjs --write bench/cognition-results.json
node bench/reasoning_model_ab.cjs --write bench/reasoning-model-results.json
node bench/compaction_replay_benchmark.cjs --write bench/compaction-replay-results.json
node bench/compaction_model_ab.cjs --write bench/compaction-model-results-v2.json
node bench/recent_task_ab.cjs --write bench/recent-task-results.json
node bench/adaptive_pressure_ab.cjs --write bench/adaptive-pressure-results-v2.json --summary
node bench/loop_runway_ab.cjs --write bench/loop-runway-results.json --summary
```
