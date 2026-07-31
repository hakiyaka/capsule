"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const cognition = require("../mcp/cognition.cjs");

const codexScript = process.platform === "win32" && process.env.APPDATA
  ? path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
  : "";
const executable = fs.existsSync(codexScript) ? process.execPath : "codex";
const executablePrefix = fs.existsSync(codexScript) ? [codexScript] : [];

function compact(value) {
  return JSON.stringify(value);
}

const tasks = [
  {
    name: "exact-cover",
    operation: {
      operation: "cover",
      requirements: ["auth", "billing", "export", "profile", "audit", "alerts"],
      candidates: [
        { id: "a", covers: ["auth", "profile"], cost: 2 },
        { id: "b", covers: ["billing", "audit"], cost: 3 },
        { id: "c", covers: ["export", "alerts"], cost: 2 },
        { id: "d", covers: ["auth", "billing", "export"], cost: 5 },
        { id: "e", covers: ["profile", "audit", "alerts"], cost: 5 },
        { id: "f", covers: ["auth", "billing", "export", "profile", "audit", "alerts"], cost: 12 },
        { id: "g", covers: ["auth"], cost: 1 },
        { id: "h", covers: ["profile"], cost: 1 },
        { id: "i", covers: ["billing"], cost: 1 },
      ],
    },
    expected: "selected=a,b,c;cost=7",
    prompt(operation) {
      return `Find the exact minimum-cost candidate set covering every requirement. Data=${compact(operation)}. ` +
        `Do not use tools. Return exactly one line as selected=<sorted ids>;cost=<number>.`;
    },
    answer(result) {
      return `selected=${result.selected.join(",")};cost=${result.total_cost}`;
    },
  },
  {
    name: "parallel-dag",
    operation: {
      operation: "dag",
      tasks: [
        { id: "inspect", cost: 2 },
        { id: "schema", after: ["inspect"], cost: 3 },
        { id: "api", after: ["schema"], cost: 5 },
        { id: "ui", after: ["schema"], cost: 4 },
        { id: "security", after: ["api"], cost: 3 },
        { id: "unit", after: ["api"], cost: 2 },
        { id: "e2e", after: ["api", "ui"], cost: 6 },
        { id: "docs", after: ["ui"], cost: 2 },
        { id: "pack", after: ["security", "unit", "e2e", "docs"], cost: 2 },
      ],
    },
    expected: "batches=inspect|schema|api,ui|docs,e2e,security,unit|pack;critical=inspect,schema,api,e2e,pack",
    prompt(operation) {
      return `Topologically schedule these tasks into the earliest parallel batches and find the maximum-cost critical path. Data=${compact(operation)}. ` +
        `Do not use tools. Return exactly: batches=<sorted batch ids joined by |>;critical=<ids>.`;
    },
    answer(result) {
      return `batches=${result.batches.map((batch) => batch.join(",")).join("|")};critical=${result.critical_path.join(",")}`;
    },
  },
  {
    name: "weighted-decision",
    operation: {
      operation: "decide",
      criteria: [
        { id: "quality", weight: 5, direction: "max" },
        { id: "latency", weight: 3, direction: "min" },
        { id: "cost", weight: 2, direction: "min" },
        { id: "portability", weight: 4, direction: "max" },
      ],
      options: [
        { id: "alpha", scores: { quality: 9, latency: 7, cost: 8, portability: 5 } },
        { id: "beta", scores: { quality: 8, latency: 3, cost: 5, portability: 9 } },
        { id: "gamma", scores: { quality: 7, latency: 2, cost: 3, portability: 7 } },
        { id: "delta", scores: { quality: 5, latency: 1, cost: 1, portability: 4 } },
        { id: "epsilon", scores: { quality: 6, latency: 5, cost: 4, portability: 8 } },
      ],
    },
    expected: "winner=beta",
    prompt(operation) {
      return `Min-max normalize every criterion, apply weights, and choose the highest weighted score. Data=${compact(operation)}. ` +
        `Do not use tools. Return exactly one line: winner=<id>.`;
    },
    answer(result) {
      return `winner=${result.winner}`;
    },
  },
  {
    name: "information-gain",
    operation: {
      operation: "hypotheses",
      hypotheses: [
        { id: "cache", prior: 0.35 },
        { id: "database", prior: 0.25 },
        { id: "network", prior: 0.2 },
        { id: "lock", prior: 0.15 },
        { id: "memory", prior: 0.05 },
      ],
      checks: [
        { id: "cache-bypass", cost: 1, positive: { cache: 0.95, database: 0.08, network: 0.1, lock: 0.05, memory: 0.1 } },
        { id: "query-plan", cost: 3, positive: { cache: 0.1, database: 0.9, network: 0.1, lock: 0.3, memory: 0.1 } },
        { id: "packet-trace", cost: 5, positive: { cache: 0.1, database: 0.2, network: 0.9, lock: 0.1, memory: 0.1 } },
        { id: "lock-dump", cost: 4, positive: { cache: 0.05, database: 0.2, network: 0.05, lock: 0.95, memory: 0.1 } },
        { id: "heap-profile", cost: 7, positive: { cache: 0.1, database: 0.1, network: 0.05, lock: 0.1, memory: 0.95 } },
      ],
    },
    expected: "next=cache-bypass",
    prompt(operation) {
      return `For each binary check, compute expected Shannon information gain divided by cost and choose the maximum. Data=${compact(operation)}. ` +
        `Do not use tools. Return exactly one line: next=<check id>.`;
    },
    answer(result) {
      return `next=${result.next_check}`;
    },
  },
  {
    name: "exact-assignment",
    operation: {
      operation: "assign",
      agents: ["ada", "grace", "linus", "margaret", "donald"],
      tasks: ["api", "docs", "ops", "security", "tests"],
      costs: {
        ada: { api: 2, docs: 8, ops: 7, security: 6, tests: 4 },
        grace: { api: 6, docs: 2, ops: 8, security: 5, tests: 7 },
        linus: { api: 5, docs: 7, ops: 1, security: 8, tests: 6 },
        margaret: { api: 7, docs: 5, ops: 6, security: 2, tests: 8 },
        donald: { api: 8, docs: 6, ops: 5, security: 7, tests: 1 },
      },
    },
    expected: "assignment=api:ada,docs:grace,ops:linus,security:margaret,tests:donald;cost=8",
    prompt(operation) {
      return `Find the exact minimum-cost one-to-one assignment. Data=${compact(operation)}. ` +
        "Do not use tools. Return exactly: assignment=<tasks alphabetically as task:agent comma-separated>;cost=<number>.";
    },
    answer(result) {
      return `assignment=${result.assignments.map((item) => `${item.task}:${item.agent}`).join(",")};cost=${result.total_cost}`;
    },
  },
  {
    name: "exact-knapsack",
    operation: {
      operation: "knapsack",
      budget: 17,
      items: [
        { id: "a", cost: 9, value: 18 },
        { id: "b", cost: 8, value: 17 },
        { id: "c", cost: 7, value: 15 },
        { id: "d", cost: 6, value: 13 },
        { id: "e", cost: 5, value: 11 },
        { id: "f", cost: 4, value: 8 },
        { id: "g", cost: 3, value: 6 },
        { id: "h", cost: 2, value: 3 },
      ],
    },
    expected: "selected=b,d,g;cost=17;value=36",
    prompt(operation) {
      return `Find the exact maximum-value 0/1 subset within the budget. Data=${compact(operation)}. ` +
        "Do not use tools. Return exactly: selected=<sorted ids>;cost=<number>;value=<number>.";
    },
    answer(result) {
      return `selected=${result.selected.join(",")};cost=${result.total_cost};value=${result.total_value}`;
    },
  },
  {
    name: "shortest-path",
    operation: {
      operation: "path",
      source: "a",
      target: "h",
      directed: true,
      edges: [
        { from: "a", to: "b", cost: 4 },
        { from: "a", to: "c", cost: 1 },
        { from: "c", to: "b", cost: 1 },
        { from: "b", to: "d", cost: 2 },
        { from: "c", to: "e", cost: 3 },
        { from: "d", to: "f", cost: 2 },
        { from: "e", to: "f", cost: 5 },
        { from: "f", to: "g", cost: 1 },
        { from: "g", to: "h", cost: 1 },
        { from: "d", to: "h", cost: 9 },
      ],
    },
    expected: "path=a,c,b,d,f,g,h;cost=8",
    prompt(operation) {
      return `Find the exact minimum-cost directed path. Data=${compact(operation)}. ` +
        "Do not use tools. Return exactly: path=<ids>;cost=<number>.";
    },
    answer(result) {
      return `path=${result.path.join(",")};cost=${result.total_cost}`;
    },
  },
];

function run(prompt) {
  const operation = spawnSync(executable, [...executablePrefix,
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "-s", "read-only",
    "--json",
    prompt,
  ], {
    cwd: path.resolve(__dirname, "..", "..", "..", "work"),
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (operation.error) throw operation.error;
  if (operation.status !== 0) {
    throw new Error(`codex exec failed (${operation.status}): ${String(operation.stderr).slice(-1200)}`);
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
  return {
    answer: answer.trim(),
    usage,
    stderr_tail: String(operation.stderr || "").trim().split(/\r?\n/).slice(-3),
  };
}

function normalized(value) {
  return String(value).toLowerCase().replace(/\s+/g, "");
}

const rows = [];
for (let index = 0; index < tasks.length; index += 1) {
  const task = tasks[index];
  const solved = cognition.solve(task.operation).response;
  const certificateAnswer = task.answer(solved);
  if (normalized(certificateAnswer) !== normalized(task.expected)) {
    throw new Error(`fixture drift for ${task.name}: ${certificateAnswer}`);
  }
  const baselinePrompt = task.prompt(task.operation);
  const treatmentPrompt = `${baselinePrompt}\n` +
    `An external deterministic solver already proved the answer. ` +
    `Certificate=${solved.certificate.input_sha256}; verified_result=${certificateAnswer}. ` +
    `Do not recompute or explore alternatives; copy the verified result in the required format.`;
  const order = index % 2 === 0 ? ["baseline", "treatment"] : ["treatment", "baseline"];
  const measured = {};
  for (const arm of order) measured[arm] = run(arm === "baseline" ? baselinePrompt : treatmentPrompt);
  for (const arm of ["baseline", "treatment"]) {
    const item = measured[arm];
    rows.push({
      task: task.name,
      arm,
      correct: normalized(item.answer) === normalized(task.expected),
      answer: item.answer,
      input_tokens: item.usage.input_tokens,
      cached_input_tokens: item.usage.cached_input_tokens,
      output_tokens: item.usage.output_tokens,
      reasoning_output_tokens: item.usage.reasoning_output_tokens,
    });
  }
}

function total(arm, field) {
  return rows.filter((row) => row.arm === arm).reduce((sum, row) => sum + Number(row[field] || 0), 0);
}

const baselineReasoning = total("baseline", "reasoning_output_tokens");
const treatmentReasoning = total("treatment", "reasoning_output_tokens");
const saving = baselineReasoning
  ? Number(((baselineReasoning - treatmentReasoning) / baselineReasoning * 100).toFixed(2))
  : null;
const result = {
  method: {
    runner: "codex exec --ignore-user-config --ephemeral --sandbox read-only --json",
    design: "Same seven symbolic tasks. Treatment receives a deterministic certificate and is told not to recompute.",
    order: "Alternating AB/BA to reduce order bias.",
    repetitions: 1,
    caveat: "Small real-model sample; reasoning tokens are provider telemetry for these runs, not a universal guarantee.",
  },
  summary: {
    tasks: tasks.length,
    baseline_reasoning_output_tokens: baselineReasoning,
    treatment_reasoning_output_tokens: treatmentReasoning,
    reasoning_saving_percent: saving,
    baseline_correct: rows.filter((row) => row.arm === "baseline" && row.correct).length,
    treatment_correct: rows.filter((row) => row.arm === "treatment" && row.correct).length,
    baseline_output_tokens: total("baseline", "output_tokens"),
    treatment_output_tokens: total("treatment", "output_tokens"),
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
if (result.summary.baseline_correct !== tasks.length ||
    result.summary.treatment_correct !== tasks.length) {
  process.exitCode = 1;
}
