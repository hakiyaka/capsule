"use strict";

const fs = require("node:fs");
const path = require("node:path");
const cognition = require("../mcp/cognition.cjs");
const hook = require("../scripts/hook.cjs");

function factorial(number) {
  let value = 1;
  for (let index = 2; index <= number; index += 1) value *= index;
  return value;
}

const cases = [
  {
    name: "minimum-evidence-cover",
    args: {
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
    expected: (result) =>
      JSON.stringify(result.selected) === JSON.stringify(["a", "b", "c"]) &&
      result.total_cost === 7,
    states: (result) => result.certificate.search_space,
  },
  {
    name: "parallel-dag",
    args: {
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
    expected: (result) =>
      result.certificate.acyclic &&
      result.batches.length === 5 &&
      result.critical_path.join(",") === "inspect,schema,api,e2e,pack",
    states: (_result, args) => factorial(args.tasks.length),
  },
  {
    name: "weighted-decision",
    args: {
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
    expected: (result) => result.winner === "beta" && result.certificate.complete,
    states: (_result, args) => args.criteria.length * args.options.length,
  },
  {
    name: "diagnostic-information-gain",
    args: {
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
    expected: (result) => result.next_check === "cache-bypass",
    states: (_result, args) => args.hypotheses.length * args.checks.length * 2,
  },
  {
    name: "exact-assignment",
    args: {
      operation: "assign",
      agents: ["a", "b", "c", "d", "e", "f"],
      tasks: ["api", "docs", "ops", "qa", "security", "ui"],
      costs: {
        a: { api: 1, docs: 9, ops: 9, qa: 9, security: 9, ui: 9 },
        b: { api: 9, docs: 1, ops: 9, qa: 9, security: 9, ui: 9 },
        c: { api: 9, docs: 9, ops: 1, qa: 9, security: 9, ui: 9 },
        d: { api: 9, docs: 9, ops: 9, qa: 1, security: 9, ui: 9 },
        e: { api: 9, docs: 9, ops: 9, qa: 9, security: 1, ui: 9 },
        f: { api: 9, docs: 9, ops: 9, qa: 9, security: 9, ui: 1 },
      },
    },
    expected: (result) => result.total_cost === 6 && result.certificate.complete,
    states: (_result, args) => factorial(args.tasks.length),
  },
  {
    name: "exact-knapsack",
    args: {
      operation: "knapsack",
      budget: 9,
      items: Array.from({ length: 18 }, (_unused, index) => ({
        id: `i${String(index + 1).padStart(2, "0")}`,
        cost: 1,
        value: 1,
      })),
    },
    expected: (result) =>
      result.total_cost === 9 &&
      result.total_value === 9 &&
      result.selected.join(",") === "i01,i02,i03,i04,i05,i06,i07,i08,i09",
    states: (_result, args) => (2 ** args.items.length) - 1,
  },
  {
    name: "shortest-path",
    args: {
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
    expected: (result) =>
      result.total_cost === 8 &&
      result.path.join(",") === "a,c,b,d,f,g,h",
    states: (_result, args) => args.edges.length * 8,
  },
];

const evaluated = cases.map((item) => {
  const result = cognition.solve(item.args).response;
  return {
    name: item.name,
    quality_pass: item.expected(result),
    symbolic_states_externalized: item.states(result, item.args),
    model_visible_chars: JSON.stringify(result).length,
    result,
  };
});

const trivialPrompts = [
  "merhaba",
  "thanks",
  "dosyayı oku",
  "explain this",
  "status?",
  "devam et",
  "evet",
  "hayır",
  "show it",
  "neden?",
];
const trivialOutputs = trivialPrompts.map((prompt, index) =>
  hook.handle("userpromptsubmit", {
    cwd: process.cwd(),
    session_id: `cognition-benchmark-trivial-${process.pid}-${index}`,
    prompt,
  })
);
const offloadPrompts = [
  "Compare five options against security, latency, cost, and portability, then choose one.",
  "Order these dependent tasks into parallel batches and identify the critical path.",
  "Find the minimum evidence set that covers all requirements.",
  "Rank the next diagnostic checks by information gain per cost.",
  "Assign each engineer to one task with the exact minimum total cost.",
  "Choose the maximum-value subset within the fixed budget using exact knapsack optimization.",
  "Find the shortest path and cheapest route through this weighted graph.",
];
const offloadOutputs = offloadPrompts.map((prompt, index) =>
  hook.handle("userpromptsubmit", {
    cwd: process.cwd(),
    session_id: `cognition-benchmark-offload-${process.pid}-${index}`,
    prompt,
  })
);

const result = {
  method: {
    scope: "Deterministic search moved outside model generation plus automatic hook input overhead.",
    measurement: "Exact solver states and serialized model-visible characters; not a claim that one state equals one provider reasoning token.",
    quality: "Known optima, schedules, rankings, and next-check choices are asserted.",
  },
  summary: {
    cases: evaluated.length,
    quality_passes: evaluated.filter((item) => item.quality_pass).length,
    symbolic_states_externalized: evaluated.reduce((sum, item) => sum + item.symbolic_states_externalized, 0),
    model_visible_chars: evaluated.reduce((sum, item) => sum + item.model_visible_chars, 0),
    trivial_prompts_with_zero_added_context: trivialOutputs.filter((item) => !item.hookSpecificOutput).length,
    trivial_prompts: trivialPrompts.length,
    offload_prompts_detected: offloadOutputs.filter((item) => item.hookSpecificOutput).length,
    offload_prompts: offloadPrompts.length,
    average_offload_context_chars: Number((
      offloadOutputs.reduce((sum, item) =>
        sum + String(item.hookSpecificOutput?.additionalContext || "").length, 0
      ) / offloadOutputs.length
    ).toFixed(1)),
  },
  cases: evaluated,
};

const writeIndex = process.argv.indexOf("--write");
if (writeIndex >= 0) {
  const target = process.argv[writeIndex + 1];
  if (!target) throw new Error("--write requires a path");
  fs.writeFileSync(path.resolve(target), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.summary.quality_passes !== result.summary.cases ||
    result.summary.trivial_prompts_with_zero_added_context !== result.summary.trivial_prompts ||
    result.summary.offload_prompts_detected !== result.summary.offload_prompts) {
  process.exitCode = 1;
}
