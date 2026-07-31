"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-context-gc-ab-"));
process.env.CAPSULE_STATE = path.join(root, "state");
const compaction = require("../mcp/compaction.cjs");
const core = require("../mcp/core.cjs");

function tokenize(items) {
  const code = [
    "import json,sys,tiktoken",
    "x=json.load(sys.stdin)",
    "e=tiktoken.get_encoding('o200k_base')",
    "print(json.dumps([len(e.encode(str(v))) for v in x]))",
  ].join("\n");
  const child = spawnSync(process.env.PYTHON || "python", ["-c", code], {
    input: JSON.stringify(items),
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  if (child.status === 0) return { exact: true, counts: JSON.parse(child.stdout) };
  return { exact: false, counts: items.map(core.estimateTokens) };
}

function percent(before, after) {
  return Number((((before - after) / Math.max(1, before)) * 100).toFixed(2));
}

try {
  const sessionFile = path.join(root, "session.jsonl");
  const generationFile = path.join(root, "generation.json");
  const capsuleIds = Array.from({ length: 12 }, (_, index) => `cap_${index.toString(16).padStart(16, "0")}`);
  const records = [
    {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: `Implement a universal local token-efficiency engine while preserving correctness. ${"Keep exact recovery and cross-platform behavior. ".repeat(24)}`,
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: `Do not lose the unresolved objective after automatic compaction. ${"Measure with an A/B task set. ".repeat(24)}`,
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: `Research is complete and implementation is active. ${"The next edit and stopping condition are known. ".repeat(22)}`,
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: `Current decision: use content-addressed live roots and generation deltas. ${"Tests and installation remain. ".repeat(22)} ${capsuleIds.join(" ")}`,
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        changes: Object.fromEntries(
          Array.from({ length: 8 }, (_, index) => [
            path.join(root, index % 2 ? "tests" : "mcp", `changed-${index}.cjs`),
            { type: "update" },
          ])
        ),
      },
    },
  ];
  fs.writeFileSync(sessionFile, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

  const control = [];
  const treatment = [];
  const oracle = [];
  for (let generation = 1; generation <= 8; generation += 1) {
    const progress = generation < 6
      ? `Implementation complete; validation and installation remain. ${"Preserve verified decisions. ".repeat(18)}`
      : `Implementation and focused validation complete; full validation and installation remain. ${"Preserve verified decisions. ".repeat(14)}`;
    const common = {
      session_file: sessionFile,
      max_chars: 1_200,
      summary_tokens: 400,
      historical: `Prior checkpoint: source evidence selected and architecture fixed. ${"No need to repeat discovery. ".repeat(18)}`,
      progress,
    };
    control.push(compaction.buildSeed(common).response.context);
    const generated = compaction.buildSeed({ ...common, generation_file: generationFile }).response;
    treatment.push(generated.context);
    const exact = JSON.parse(core.loadCapsule(generated.context_gc.exact).text);
    oracle.push(
      exact.roots.G.includes("universal local token-efficiency engine") &&
      exact.roots.P.includes(generation < 6 ? "validation and installation" : "full validation") &&
      exact.sets.F.length === 8 &&
      exact.sets.X.length === 12
    );
  }

  const tokenized = tokenize([...control, ...treatment]);
  const controlTokens = tokenized.counts.slice(0, control.length);
  const treatmentTokens = tokenized.counts.slice(control.length);
  const sum = (values) => values.reduce((total, value) => total + value, 0);
  const report = {
    benchmark: "proof-carrying-generational-context-gc-ab",
    generated_at: new Date().toISOString(),
    method: {
      task_set: "Eight consecutive PreCompact seeds; progress changes once at generation six.",
      arm_a: "Existing bounded prose map emitted independently on every compaction.",
      arm_b: "Legacy bootstrap, then the smaller of the legacy seed or live roots, content-addressed unchanged roots, set deltas, and an exact recovery capsule.",
      tokenizer: tokenized.exact ? "o200k_base" : "estimate",
    },
    generations: 8,
    oracles_passed: `${oracle.filter(Boolean).length}/${oracle.length}`,
    control_visible_tokens: sum(controlTokens),
    treatment_visible_tokens: sum(treatmentTokens),
    total_visible_seed_savings_percent: percent(sum(controlTokens), sum(treatmentTokens)),
    warm_generation_visible_seed_savings_percent: percent(
      sum(controlTokens.slice(1)),
      sum(treatmentTokens.slice(1))
    ),
    rows: controlTokens.map((tokens, index) => ({
      generation: index + 1,
      oracle: oracle[index],
      control_tokens: tokens,
      treatment_tokens: treatmentTokens[index],
      savings_percent: percent(tokens, treatmentTokens[index]),
    })),
    caveat: "This measures model-visible continuation seeds, not the provider's hidden compactor request, cache behavior, reasoning tokens, subscription quota, or billing.",
  };
  const output = JSON.stringify(report, null, 2);
  const writeIndex = process.argv.indexOf("--write");
  if (writeIndex >= 0 && process.argv[writeIndex + 1]) {
    fs.writeFileSync(path.resolve(process.argv[writeIndex + 1]), `${output}\n`, "utf8");
  }
  process.stdout.write(`${output}\n`);
  if (oracle.some((value) => !value)) process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
