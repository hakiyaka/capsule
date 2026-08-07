# GitHub 100-project research ledger

Generated: 2026-08-05

## Scope and confidence

This ledger records the first 100 unique GitHub repositories in the current
directory [Awesome CLI Coding Agents](https://github.com/bradagi/awesome-cli-coding-agents).
That directory was updated on 2026-08-03. The 100 entries were scanned for
active context, memory, tool-schema, terminal, retrieval, orchestration, and
verification patterns. A smaller focus set was then inspected in more detail;
claims below are labelled as reported design, not assumed provider telemetry.

## Patterns that survived the review

| Pattern | Focus projects | Capsule decision |
| --- | --- | --- |
| Progressive disclosure | Token Savior, ReMe, DCP, Keen Code, Zap | **Implemented:** `memory index` returns IDs/previews; `memory get` recovers one exact record. |
| Exact local recovery | Token Savior, DCP, Memori | Already present in Capsule web/media/file capsules; no evidence is discarded. |
| Command-family projection | Token Savior, caveman, and related terminal tools | Already present in `compat` profiles; keep conservative pass-through for unknown output. |
| Symbol and graph retrieval | jcode, Probe, jCodeMunch, Serena, Aider | Already present in the project compiler and impact cone; expand only exact proof. |
| Deferred tool/schema surface | token-optimizer-mcp, mcp-compressor, TSCG | Already present as one compact `capsule` tool plus deferred action discovery. |
| Memory as editable local artifacts | ReMe, LycheeMemory, Memori, Letta Code | Capsule keeps explicit local layers; new index/get lane avoids full memory replay. |
| Verification gates | tsbench, SWE-agent, h5i, Aider, Moltis | Keep A/B benchmarks, contract tests, and exact-recovery assertions together. |
| Stable task/session boundaries | DCP, Waveloom, Grinta, GitClaw | Existing advisor/ledger/task fencing retained; no stale replay across tasks. |

## Implemented change

The new progressive memory lane is opt-in and backward-compatible:

```json
{"action":"memory","payload":{"operation":"index","query":"focused verification","max_chars":420}}
{"action":"memory","payload":{"operation":"get","id":"mem_..."}}
```

`index` emits only bounded IDs, layer markers, previews, and scores. `get`
returns exactly one selected record and marks whether the recovery was exact.
The existing `recall` operation is unchanged, so users who need the current
loadout behavior do not pay a compatibility cost.

## Evidence from the focused pass

- [Token Savior](https://github.com/Mibayy/token-savior): progressive memory
  layers, pure command compactors, a pre-tool rewrite lane, and a real-task
  benchmark are useful patterns; its reported percentages are not treated as
  Capsule measurements.
- [ReMe](https://github.com/agentscope-ai/ReMe): memory-as-files, hybrid
  retrieval, and editable provenance support an ID-first memory index.
- [Dynamic Context Pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning):
  selective compression with placeholders preserves recoverability and avoids
  rewriting the underlying session.
- [Memori](https://github.com/GibsonAI/memori): structured memory and
  benchmark-first reporting reinforce the separation between local exposure
  savings and provider billing claims.
- [LycheeMemory](https://github.com/LycheeMem/LycheeMem): summary anchors plus
  recent raw turns motivate Capsule's layered, query-conditioned loadout.
- [Waveloom](https://github.com/Menfre01/waveloom): tiered compaction and
  explicit modes reinforce pressure-aware, reversible behavior.

## 100 repositories scanned

1. [Hermes Agent](https://github.com/NousResearch/hermes-agent)
2. [Claw Code](https://github.com/ultraworkers/claw-code)
3. [OpenCode](https://github.com/anomalyco/opencode)
4. [Gemini CLI](https://github.com/google-gemini/gemini-cli)
5. [Codex CLI](https://github.com/openai/codex)
6. [OpenHands](https://github.com/All-Hands-AI/OpenHands)
7. [Pi](https://github.com/badlogic/pi-mono)
8. [Open Interpreter](https://github.com/OpenInterpreter/open-interpreter)
9. [Cline CLI](https://github.com/cline/cline)
10. [Goose](https://github.com/aaif-goose/goose)
11. [Aider](https://github.com/Aider-AI/aider)
12. [Continue CLI](https://github.com/continuedev/continue)
13. [Deep Agents Code](https://github.com/langchain-ai/deepagents)
14. [Crush](https://github.com/charmbracelet/crush)
15. [Kilo Code CLI](https://github.com/Kilo-Org/kilocode)
16. [Qwen Code](https://github.com/QwenLM/qwen-code)
17. [Roo Code CLI](https://github.com/RooCodeInc/Roo-Code)
18. [Grok Build](https://github.com/xai-org/grok-build)
19. [OH-MY-PI](https://github.com/can1357/oh-my-pi)
20. [SWE-agent](https://github.com/SWE-agent/SWE-agent)
21. [Plandex](https://github.com/plandex-ai/plandex)
22. [jcode](https://github.com/1jehuang/jcode)
23. [MiMo Code](https://github.com/XiaomiMiMo/MiMo-Code)
24. [Smol Developer](https://github.com/smol-ai/developer)
25. [Trae Agent](https://github.com/bytedance/trae-agent)
26. [Claude Engineer](https://github.com/Doriandarko/claude-engineer)
27. [Kimi CLI](https://github.com/MoonshotAI/kimi-cli)
28. [Claurst](https://github.com/Kuberwastaken/claurst)
29. [Free Code](https://github.com/paoloanzn/free-code)
30. [Codebuff](https://github.com/CodebuffAI/codebuff)
31. [ForgeCode](https://github.com/antinomyhq/forge)
32. [OpenSquilla](https://github.com/opensquilla/opensquilla)
33. [Kode CLI](https://github.com/shareAI-lab/Kode-cli)
34. [Mistral Vibe](https://github.com/mistralai/mistral-vibe)
35. [gptme](https://github.com/gptme/gptme)
36. [Every Code](https://github.com/just-every/code)
37. [Devon](https://github.com/entropy-research/Devon)
38. [Grok CLI](https://github.com/superagent-ai/grok-cli)
39. [AutoCodeRover](https://github.com/AutoCodeRoverSG/auto-code-rover)
40. [Letta Code](https://github.com/letta-ai/letta-code)
41. [CodeMachine-CLI](https://github.com/moazbuilds/CodeMachine-CLI)
42. [Codel](https://github.com/semanser/codel)
43. [open-codex](https://github.com/ymichael/open-codex)
44. [Nanocoder](https://github.com/Nano-Collective/nanocoder)
45. [RA.Aid](https://github.com/ai-christianson/RA.Aid)
46. [Agentless](https://github.com/OpenAutoCoder/Agentless)
47. [Amazon Q Developer CLI](https://github.com/aws/amazon-q-developer-cli)
48. [Neovate Code](https://github.com/neovateai/neovate-code)
49. [VT Code](https://github.com/vinhnx/vtcode)
50. [Groq Code CLI](https://github.com/build-with-groq/groq-code-cli)
51. [Dexto](https://github.com/truffle-ai/dexto)
52. [claw-code-agent](https://github.com/HarnessLab/claw-code-agent)
53. [g3](https://github.com/dhanji/g3)
54. [agentty](https://github.com/1ay1/agentty)
55. [Coro Code](https://github.com/Blushyes/coro-code)
56. [LettaBot](https://github.com/letta-ai/lettabot)
57. [Mini-Kode](https://github.com/minmaxflow/mini-kode)
58. [zot](https://github.com/patriceckhart/zot)
59. [nori-cli](https://github.com/tilework-tech/nori-cli)
60. [cursor-agent](https://github.com/civai-technologies/cursor-agent)
61. [Waveloom](https://github.com/Menfre01/waveloom)
62. [VibePod](https://github.com/VibePod/vibepod-cli)
63. [DvalinCode](https://github.com/arthurpanhku/dvalincode)
64. [openHarness](https://github.com/zhijiewong/openharness)
65. [Octomind](https://github.com/Muvon/octomind)
66. [Codex Infinity](https://github.com/lee101/codex-infinity)
67. [San](https://github.com/genai-io/san)
68. [picocode](https://github.com/jondot/picocode)
69. [QQCode](https://github.com/qnguyen3/qqcode)
70. [Keen Code](https://github.com/mochow13/keen-code)
71. [Smelt](https://github.com/leonardcser/smelt)
72. [Grinta](https://github.com/josephsenior/Grinta-Coding-Agent)
73. [Zap](https://github.com/zap-coding-agent/zap-coding-agent)
74. [Binharic](https://github.com/CogitatorTech/binharic-cli)
75. [Darce](https://github.com/AmerSarhan/darce-cli)
76. [CLAII](https://github.com/agencyswarm/CLAII)
77. [OpenClaw](https://github.com/openclaw/openclaw)
78. [nanobot](https://github.com/HKUDS/nanobot)
79. [ZeroClaw](https://github.com/zeroclaw-labs/zeroclaw)
80. [NanoClaw](https://github.com/gavrielc/nanoclaw)
81. [PicoClaw](https://github.com/sipeed/picoclaw)
82. [IronClaw](https://github.com/nearai/ironclaw)
83. [NullClaw](https://github.com/nullclaw/nullclaw)
84. [Clawith](https://github.com/dataelement/Clawith)
85. [claw0](https://github.com/shareAI-lab/claw0)
86. [Moltis](https://github.com/moltis-org/moltis)
87. [GitClaw](https://github.com/open-gitagent/gitclaw)
88. [LionClaw](https://github.com/moshthepitt/lionclaw)
89. [Claude Code](https://github.com/anthropics/claude-code)
90. [Warp](https://github.com/warpdotdev/Warp)
91. [GitHub Copilot in the CLI](https://github.com/github/copilot-cli)
92. [Command Code](https://github.com/CommandCodeAI/command-code)
93. [Ante](https://github.com/AntigmaLabs/ante-preview)
94. [pool](https://github.com/poolsideai/pool)
95. [FetchCoder](https://github.com/fetchai/fetchcoder-releases)
96. [Droid](https://github.com/Factory-AI/factory)
97. [vibe-kanban](https://github.com/BloopAI/vibe-kanban)
98. [cmux](https://github.com/manaflow-ai/cmux)
99. [herdr](https://github.com/herdrdev/herdr)
100. [Superset](https://github.com/superset-sh/superset)

## Verification

The implemented lane is covered by `tests/memory-layers.test.cjs` and the
existing full test suite. The deterministic benchmark reports both index
reduction and exact recovery; no external data is uploaded by this report.

For reproducibility:

```sh
npm test
npm run benchmark:memory
npm run audit:source
npm run audit:public
```

This file is a research ledger, not a claim that every listed project was
copied or that every README percentage is independently validated.
