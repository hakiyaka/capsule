"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-microprogram-ab-"));
process.env.CAPSULE_STATE = path.join(root, "state");
const core = require("../mcp/core.cjs");
const unified = require("../mcp/unified.cjs");

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

async function main() {
  const contexts = [8_000, 32_000, 96_000, 160_000, 240_000];
  const artifacts = [];
  for (let scenario = 0; scenario < contexts.length; scenario += 1) {
    const control = [];
    const selected = [];
    for (let stage = 0; stage < 4; stage += 1) {
      const route = (scenario + stage) % 2 ? "BLUE" : "RED";
      const probe = await unified.dispatch({
        action: "run",
        payload: {
          command: process.execPath,
          args: ["-e", `console.log('ROUTE ${route}')`],
          idempotent: true,
          result_future: false,
        },
      });
      control.push(core.renderOperation(probe));
      const branch = await unified.dispatch({
        action: "run",
        payload: {
          command: process.execPath,
          args: ["-e", `console.log('STAGE ${stage} ${route}')`],
          idempotent: true,
          result_future: false,
        },
      });
      control.push(core.renderOperation(branch));
      selected.push(`STAGE ${stage} ${route}`);
    }
    const steps = [];
    for (let stage = 0; stage < 4; stage += 1) {
      const route = (scenario + stage) % 2 ? "BLUE" : "RED";
      steps.push({
        id: `probe-${stage}`,
        action: "run",
        payload: {
          command: process.execPath,
          args: ["-e", `console.log('ROUTE ${route}')`],
          idempotent: true,
          result_future: false,
        },
      });
      for (const branch of ["RED", "BLUE"]) {
        steps.push({
          id: `${branch.toLowerCase()}-${stage}`,
          action: "run",
          when: { step: `probe-${stage}`, field: "output", op: "contains", value: branch },
          payload: {
            command: process.execPath,
            args: ["-e", `console.log('STAGE ${stage} ${branch}')`],
            idempotent: true,
            result_future: false,
          },
        });
      }
    }
    const treatment = await unified.dispatch({
      action: "flow",
      payload: { steps, concurrency: 8, max_chars: 8_000 },
    });
    const exact = core.loadCapsule(treatment.response.exact).text;
    artifacts.push({
      context: contexts[scenario],
      control,
      treatment: core.renderOperation(treatment),
      oracle: treatment.response.ok === 8 &&
        treatment.response.conditional_skipped === 4 &&
        selected.every((marker) => exact.includes(marker)),
    });
  }
  const strings = artifacts.flatMap((item) => [...item.control, item.treatment]);
  const tokenized = tokenize(strings);
  let cursor = 0;
  const rows = artifacts.map((item) => {
    const controlTokens = item.control.map(() => tokenized.counts[cursor++]);
    const treatmentTokens = tokenized.counts[cursor++];
    let cumulative = 0;
    const controlInput = controlTokens.reduce((sum, tokens) => {
      cumulative += tokens;
      return sum + item.context + cumulative;
    }, 0);
    const treatmentInput = item.context + treatmentTokens;
    return {
      context_tokens: item.context,
      oracle: item.oracle,
      control_roundtrips: 8,
      treatment_roundtrips: 1,
      control_visible_tokens: controlTokens.reduce((a, b) => a + b, 0),
      treatment_visible_tokens: treatmentTokens,
      input_exposure_savings_percent: percent(controlInput, treatmentInput),
    };
  });
  const sum = (field) => rows.reduce((total, row) => total + row[field], 0);
  const report = {
    benchmark: "adaptive-microprogram-ab",
    generated_at: new Date().toISOString(),
    scenarios: rows.length,
    adaptive_stages: 4,
    oracles_passed: `${rows.filter((row) => row.oracle).length}/${rows.length}`,
    tokenizer: tokenized.exact ? "o200k_base" : "estimate",
    roundtrip_reduction_percent: 87.5,
    visible_result_savings_percent: percent(sum("control_visible_tokens"), sum("treatment_visible_tokens")),
    average_input_exposure_savings_percent: Number(
      (rows.reduce((sumValue, row) => sumValue + row.input_exposure_savings_percent, 0) / rows.length).toFixed(2)
    ),
    caveat: "Four binary adaptive stages compiled before execution. Provider caching, hidden reasoning, billing, and model planning cost are excluded.",
    rows,
  };
  const output = JSON.stringify(report, null, 2);
  const writeIndex = process.argv.indexOf("--write");
  if (writeIndex >= 0) fs.writeFileSync(path.resolve(process.argv[writeIndex + 1]), `${output}\n`, "utf8");
  process.stdout.write(`${output}\n`);
}

main().finally(() => fs.rmSync(root, { recursive: true, force: true }));
