"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-toolchain-jit-ab-"));
const workspace = path.join(root, "workspace");
process.env.CAPSULE_STATE = path.join(root, "state");
fs.mkdirSync(workspace, { recursive: true });
for (let index = 0; index < 24; index += 1) {
  fs.writeFileSync(
    path.join(workspace, `fixture-${String(index).padStart(2, "0")}.txt`),
    `NEEDLE_A scenario-${index}\nNEEDLE_B proof-${index}\n`,
    "utf8"
  );
}

const core = require("../mcp/core.cjs");
const hookCli = require("../scripts/cli.cjs");
const toolchainJit = require("../mcp/toolchain-jit.cjs");

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

function train(common, first, second) {
  const step = (candidate) => {
    const token = toolchainJit.begin({ ...common, ...candidate });
    return toolchainJit.finish(token, 0).prediction;
  };
  step(first);
  step(second);
  step(first);
  step(second);
  return step(first);
}

async function main() {
  const contexts = [8_000, 32_000, 96_000, 160_000, 240_000];
  const first = { command: "rg -n NEEDLE_A .", profile: "search" };
  const second = { command: "rg -n NEEDLE_B .", profile: "search" };
  const artifacts = [];
  for (let index = 0; index < contexts.length; index += 1) {
    const context = contexts[index];
    const controlCommon = {
      cwd: workspace,
      session_id: `toolchain-control-${index}`,
      execution_epoch: 1,
      input_tokens: context,
      max_chars: 1_200,
      passthrough_chars: 500,
    };
    process.env.CAPSULE_TOOLCHAIN_JIT = "0";
    const controlFirst = await hookCli.runPayload({ ...controlCommon, ...first });
    const controlSecond = await hookCli.runPayload({ ...controlCommon, ...second });

    process.env.CAPSULE_TOOLCHAIN_JIT = "1";
    const treatmentCommon = {
      ...controlCommon,
      session_id: `toolchain-treatment-${index}`,
    };
    const learned = train(treatmentCommon, first, second);
    const treatment = await hookCli.runPayload({ ...treatmentCommon, ...first });
    const exact = treatment.proof ? JSON.parse(core.loadCapsule(treatment.proof).text) : null;
    artifacts.push({
      context,
      controlFirst: controlFirst.output,
      controlSecond: controlSecond.output,
      treatment: treatment.output,
      oracle: Boolean(
        learned?.target?.command === second.command &&
        treatment.macro.length === 1 &&
        treatment.output.includes("NEEDLE_A") &&
        treatment.output.includes("NEEDLE_B") &&
        exact?.successors?.[0]?.command === second.command
      ),
    });
  }
  delete process.env.CAPSULE_TOOLCHAIN_JIT;

  const strings = artifacts.flatMap((item) => [
    item.controlFirst,
    item.controlSecond,
    item.treatment,
  ]);
  const tokenized = tokenize(strings);
  let cursor = 0;
  const rows = artifacts.map((item) => {
    const firstTokens = tokenized.counts[cursor++];
    const secondTokens = tokenized.counts[cursor++];
    const treatmentTokens = tokenized.counts[cursor++];
    const controlInput = (item.context + firstTokens) +
      (item.context + firstTokens + secondTokens);
    const treatmentInput = item.context + treatmentTokens;
    return {
      context_tokens: item.context,
      oracle: item.oracle,
      control_model_reentries: 2,
      treatment_model_reentries: 1,
      control_visible_tokens: firstTokens + secondTokens,
      treatment_visible_tokens: treatmentTokens,
      input_exposure_savings_percent: percent(controlInput, treatmentInput),
    };
  });
  const sum = (field) => rows.reduce((total, row) => total + row[field], 0);
  const report = {
    benchmark: "causal-toolchain-jit-ab",
    generated_at: new Date().toISOString(),
    method: {
      task_set: "Five context sizes; a learned rg A -> rg B investigation sequence with real local command execution.",
      arm_a: "Two serial shell-tool results and two model re-entries.",
      arm_b: "The first command plus a locally JIT-executed learned successor and one model re-entry.",
      training: "Two identical safe transitions with 100% dominance; training output is excluded from both arms.",
      tokenizer: tokenized.exact ? "o200k_base" : "estimate",
    },
    scenarios: rows.length,
    oracles_passed: `${rows.filter((row) => row.oracle).length}/${rows.length}`,
    model_reentry_reduction_percent: 50,
    visible_result_change_percent: percent(
      sum("control_visible_tokens"),
      sum("treatment_visible_tokens")
    ),
    average_input_exposure_savings_percent: Number(
      (rows.reduce((total, row) => total + row.input_exposure_savings_percent, 0) / rows.length).toFixed(2)
    ),
    rows,
    caveat: "Measures post-tool model-input exposure for a learned deterministic safe sequence. Provider cache accounting, hidden reasoning, subscription weighting, and cold training turns are excluded; cold and low-context paths emit no JIT payload.",
  };
  const output = JSON.stringify(report, null, 2);
  const writeIndex = process.argv.indexOf("--write");
  if (writeIndex >= 0 && process.argv[writeIndex + 1]) {
    fs.writeFileSync(path.resolve(process.argv[writeIndex + 1]), `${output}\n`, "utf8");
  }
  process.stdout.write(`${output}\n`);
  if (rows.some((row) => !row.oracle)) process.exitCode = 1;
}

main().finally(() => fs.rmSync(root, { recursive: true, force: true }));
