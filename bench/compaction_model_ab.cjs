"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const compaction = require("../mcp/compaction.cjs");

const codexScript = process.platform === "win32" && process.env.APPDATA
  ? path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
  : "";
const executable = fs.existsSync(codexScript) ? process.execPath : "codex";
const executablePrefix = fs.existsSync(codexScript) ? [codexScript] : [];

const tasks = [
  {
    name: "plugin-upgrade",
    goal: "Continue NEBULA-417. Use only Capsule, do not browse, and preserve compatibility.",
    agent: "Implemented mcp/compaction.cjs and scripts/hook.cjs. Tests 40/40 pass. " +
      "Observed direct compaction delta 0 because telemetry does not expose generation cost; " +
      "post-compaction input average is 25558.7. Remaining work: install, restart, and verify. " +
      "Exact evidence capsule cap_0123456789abcdef.",
    files: ["mcp/compaction.cjs", "scripts/hook.cjs"],
    checks: [
      /NEBULA-417/i,
      /do not browse|no web/i,
      /mcp[\\/]compaction\.cjs/i,
      /scripts[\\/]hook\.cjs/i,
      /40\/40/i,
      /25[,.]?558/i,
      /cap_0123456789abcdef/i,
      /restart/i,
    ],
  },
  {
    name: "cross-platform-cache-fix",
    goal: "Continue ORBIT-9. Support Windows, Linux, and macOS; preserve rollback and never delete user data.",
    agent: "Root cause is stale cache invalidation. Changed src/router.ts and tests/cache.test.ts. " +
      "npm test is 73/73. Decision: key cache entries by content hash. " +
      "Remaining blocker: run the fuzz suite, then package only if green. Capsule cap_fedcba9876543210.",
    files: ["src/router.ts", "tests/cache.test.ts"],
    checks: [
      /ORBIT-9/i,
      /Windows/i,
      /Linux/i,
      /macOS/i,
      /src[\\/]router\.ts/i,
      /73\/73/i,
      /fuzz/i,
      /cap_fedcba9876543210/i,
    ],
  },
];

function noisyTranscript(task) {
  const chunks = [
    `USER: ${task.goal}`,
    "AGENT: I will inspect the implementation and keep the user informed.",
  ];
  for (let index = 0; index < 120; index += 1) {
    chunks.push(
      `TOOL LOG ${index}: worker=${index % 7} elapsed=${100 + index}ms ` +
      `status=${index % 19 === 0 ? "warning" : "ok"} ${"routine diagnostic output ".repeat(8)}`
    );
    if (index === 18) chunks.push(`USER REMINDER: ${task.goal}`);
    if (index === 51) chunks.push(`AGENT DECISION: ${task.agent}`);
    if (index === 84) chunks.push("AGENT: Explored three superseded approaches; none should survive compaction.");
  }
  chunks.push(`CURRENT STATE: ${task.agent}`);
  return chunks.join("\n");
}

function seedFor(task) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-compaction-model-seed-"));
  const file = path.join(root, "rollout.jsonl");
  try {
    const records = [
      { type: "compacted", payload: { window_number: 1, replacement_history: [] } },
      { type: "event_msg", payload: { type: "user_message", message: task.goal } },
      {
        type: "event_msg",
        payload: {
          type: "patch_apply_end",
          success: true,
          changes: Object.fromEntries(task.files.map((item) => [item, { type: "update" }])),
        },
      },
      { type: "event_msg", payload: { type: "agent_message", message: task.agent, phase: "commentary" } },
    ];
    fs.writeFileSync(file, `${records.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
    return compaction.buildSeed({
      session_file: file,
      max_chars: 850,
      summary_tokens: 400,
    }).response.context;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function run(prompt) {
  const operation = spawnSync(executable, [...executablePrefix,
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "-s", "read-only",
    "--json",
    "-",
  ], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    input: prompt,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (operation.error) throw operation.error;
  if (operation.status !== 0) {
    throw new Error(`codex exec failed (${operation.status}): ${String(operation.stderr).slice(-1600)}`);
  }
  let usage = null;
  let answer = "";
  for (const line of String(operation.stdout).split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      answer = String(event.item.text || "");
    }
    if (event.type === "turn.completed") usage = event.usage;
  }
  if (!usage) throw new Error("codex exec did not emit turn.completed usage");
  return { answer: answer.trim(), usage };
}

function promptFor(task, arm) {
  const transcript = noisyTranscript(task);
  const common = "You are compacting a long Codex task for a future agent. Preserve the current objective, " +
    "explicit constraints, decisions, changed files, verified test/metric evidence, exact capsule IDs, " +
    "and unresolved next actions. Never invent facts.";
  if (arm === "baseline") {
    return `${common}\nProduce a comprehensive detailed continuation summary, including any potentially useful operational detail.\n` +
      `TRANSCRIPT:\n${transcript}`;
  }
  return `${common}\nPRECOMPACT DICTIONARY:\n${seedFor(task)}\nTRANSCRIPT:\n${transcript}`;
}

function localPromptTokens(prompts) {
  const code = "import json,sys,tiktoken\n" +
    "enc=tiktoken.get_encoding('o200k_base')\n" +
    "print(json.dumps([len(enc.encode(x)) for x in json.load(sys.stdin)]))\n";
  const operation = spawnSync("python", ["-c", code], {
    input: JSON.stringify(prompts),
    encoding: "utf8",
    windowsHide: true,
  });
  if (operation.status !== 0) return prompts.map(() => null);
  try {
    return JSON.parse(operation.stdout);
  } catch {
    return prompts.map(() => null);
  }
}

const taskPrompts = tasks.map((task) => ({
  baseline: promptFor(task, "baseline"),
  treatment: promptFor(task, "treatment"),
}));
const flatPrompts = taskPrompts.flatMap((item) => [item.baseline, item.treatment]);
const flatPromptTokens = localPromptTokens(flatPrompts);

const rows = [];
for (let index = 0; index < tasks.length; index += 1) {
  const task = tasks[index];
  const order = index % 2 === 0 ? ["baseline", "treatment"] : ["treatment", "baseline"];
  const measured = {};
  for (const arm of order) {
    process.stderr.write(`[${rows.length + Object.keys(measured).length + 1}/${tasks.length * 2}] ${task.name} ${arm}\n`);
    measured[arm] = run(taskPrompts[index][arm]);
  }
  for (const arm of ["baseline", "treatment"]) {
    const result = measured[arm];
    const passed = task.checks.filter((pattern) => pattern.test(result.answer)).length;
    rows.push({
      task: task.name,
      arm,
      facts_passed: passed,
      facts_total: task.checks.length,
      quality_pass: passed === task.checks.length,
      answer_chars: result.answer.length,
      local_prompt_tokens: flatPromptTokens[index * 2 + (arm === "treatment" ? 1 : 0)],
      input_tokens: Number(result.usage.input_tokens || 0),
      cached_input_tokens: Number(result.usage.cached_input_tokens || 0),
      output_tokens: Number(result.usage.output_tokens || 0),
      reasoning_output_tokens: Number(result.usage.reasoning_output_tokens || 0),
    });
  }
}

function total(arm, field) {
  return rows.filter((row) => row.arm === arm).reduce((sum, row) => sum + Number(row[field] || 0), 0);
}

function saving(before, after) {
  return before ? Number(((before - after) / before * 100).toFixed(2)) : null;
}

const baselineOutput = total("baseline", "output_tokens");
const treatmentOutput = total("treatment", "output_tokens");
const baselineTotal = total("baseline", "input_tokens") + baselineOutput;
const treatmentTotal = total("treatment", "input_tokens") + treatmentOutput;
const localTokensAvailable = rows.every((row) => Number.isFinite(row.local_prompt_tokens));
const baselineIncremental = localTokensAvailable
  ? total("baseline", "local_prompt_tokens") + baselineOutput
  : null;
const treatmentIncremental = localTokensAvailable
  ? total("treatment", "local_prompt_tokens") + treatmentOutput
  : null;
const result = {
  method: {
    runner: "codex exec --ignore-user-config --ephemeral --sandbox read-only --json",
    design: "Same two noisy continuation transcripts. Treatment adds the deterministic <=850-character " +
      "critical-pressure dictionary used by the PreCompact hook and caps the summary at 400 tokens.",
    order: "Alternating AB/BA; one repetition.",
    incremental_accounting: "Local prompt tokens use tiktoken o200k_base when installed, then add " +
      "provider-reported output tokens; this removes unrelated shared Codex system/tool context.",
    caveat: "Small synthetic real-model sample. It measures these explicit summarization calls, not Codex's " +
      "hidden automatic compaction model or provider billing.",
  },
  summary: {
    tasks: tasks.length,
    baseline_quality_pass: rows.filter((row) => row.arm === "baseline" && row.quality_pass).length,
    treatment_quality_pass: rows.filter((row) => row.arm === "treatment" && row.quality_pass).length,
    baseline_output_tokens: baselineOutput,
    treatment_output_tokens: treatmentOutput,
    output_saving_percent: saving(baselineOutput, treatmentOutput),
    baseline_input_plus_output_tokens: baselineTotal,
    treatment_input_plus_output_tokens: treatmentTotal,
    full_call_saving_percent: saving(baselineTotal, treatmentTotal),
    baseline_local_prompt_plus_output_tokens: baselineIncremental,
    treatment_local_prompt_plus_output_tokens: treatmentIncremental,
    incremental_saving_percent: saving(baselineIncremental, treatmentIncremental),
    baseline_reasoning_output_tokens: total("baseline", "reasoning_output_tokens"),
    treatment_reasoning_output_tokens: total("treatment", "reasoning_output_tokens"),
  },
  rows,
};

const writeIndex = process.argv.indexOf("--write");
if (writeIndex >= 0) {
  const target = process.argv[writeIndex + 1];
  if (!target) throw new Error("--write requires a path");
  fs.writeFileSync(path.resolve(target), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.summary.baseline_quality_pass !== tasks.length ||
    result.summary.treatment_quality_pass !== tasks.length) {
  process.exitCode = 1;
}
