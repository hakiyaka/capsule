"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-singularity-ab-"));
process.env.CAPSULE_STATE = path.join(temporaryRoot, "state");
const core = require("../mcp/core.cjs");
const unified = require("../mcp/unified.cjs");

const contexts = [8_000, 16_000, 32_000, 64_000, 96_000, 128_000, 160_000, 192_000, 220_000, 240_000];

function tokenize(texts) {
  const source = [
    "import importlib.metadata,json,sys,tiktoken",
    "items=json.load(sys.stdin)",
    "enc=tiktoken.get_encoding('o200k_base')",
    "print(json.dumps({'encoding':'o200k_base','version':importlib.metadata.version('tiktoken'),'counts':[len(enc.encode(str(x))) for x in items]}))",
  ].join("\n");
  const child = spawnSync(process.env.PYTHON || "python", ["-c", source], {
    input: JSON.stringify(texts),
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (!child.error && child.status === 0) return { exact: true, ...JSON.parse(child.stdout) };
  return {
    exact: false,
    encoding: "capsule-estimate",
    version: "",
    counts: texts.map(core.estimateTokens),
    error: String(child.error?.message || child.stderr || `python exited ${child.status}`).slice(0, 300),
  };
}

function percent(before, after) {
  return Number((((before - after) / Math.max(1, before)) * 100).toFixed(2));
}

function fixture(root, scenario) {
  fs.mkdirSync(root, { recursive: true });
  const files = ["alpha", "beta", "gamma"].map((name) => {
    const target = path.join(root, `${name}.txt`);
    fs.writeFileSync(target, `SINGULARITY ${scenario} ${name.toUpperCase()}\n`, "utf8");
    return target;
  });
  const steps = [
    { id: "alpha", action: "file", payload: { path: files[0] } },
    { id: "beta", action: "file", payload: { path: files[1] } },
    { id: "gamma", action: "file", payload: { path: files[2] } },
    ...["delta", "epsilon", "zeta"].map((name) => ({
      id: name,
      action: "run",
      payload: {
        command: process.execPath,
        args: ["-e", `console.log('SINGULARITY ${scenario} ${name.toUpperCase()}')`],
        cwd: root,
        idempotent: true,
        passthrough_chars: 0,
        max_chars: 1_200,
        result_future: false,
      },
    })),
  ];
  return { steps };
}

async function main() {
  const artifacts = [];
  for (let scenario = 0; scenario < contexts.length; scenario += 1) {
    const control = fixture(path.join(temporaryRoot, `control-${scenario}`), scenario);
    const treatment = fixture(path.join(temporaryRoot, `treatment-${scenario}`), scenario);
    const controlOutputs = [];
    const controlStarted = Date.now();
    for (const step of control.steps) {
      const operation = await unified.dispatch({ action: step.action, payload: step.payload });
      controlOutputs.push(core.renderOperation(operation));
    }
    const controlMs = Date.now() - controlStarted;
    const treatmentStarted = Date.now();
    const flow = await unified.dispatch({
      action: "flow",
      payload: { steps: treatment.steps, concurrency: 6, max_chars: 8_000 },
    });
    const treatmentMs = Date.now() - treatmentStarted;
    const exact = JSON.parse(core.loadCapsule(flow.response.exact).text);
    const markers = ["ALPHA", "BETA", "GAMMA", "DELTA", "EPSILON", "ZETA"]
      .map((name) => `SINGULARITY ${scenario} ${name}`);
    const controlJoined = controlOutputs.join("\n");
    const exactJoined = exact.results.map((item) => item.rendered || "").join("\n");
    artifacts.push({
      scenario,
      context_tokens: contexts[scenario],
      control_outputs: controlOutputs,
      treatment_output: core.renderOperation(flow),
      control_ms: controlMs,
      treatment_ms: treatmentMs,
      oracle: flow.response.ok === 6 &&
        flow.response.failed === 0 &&
        markers.every((marker) => controlJoined.includes(marker) && exactJoined.includes(marker)),
    });
  }

  const strings = artifacts.flatMap((item) => [...item.control_outputs, item.treatment_output]);
  const tokenized = tokenize(strings);
  let cursor = 0;
  const rows = artifacts.map((item) => {
    const controlTokens = item.control_outputs.map(() => tokenized.counts[cursor++]);
    const treatmentTokens = tokenized.counts[cursor++];
    let cumulative = 0;
    let controlModelInput = 0;
    for (const tokens of controlTokens) {
      cumulative += tokens;
      controlModelInput += item.context_tokens + cumulative;
    }
    const treatmentModelInput = item.context_tokens + treatmentTokens;
    return {
      scenario: item.scenario,
      context_tokens: item.context_tokens,
      oracle: item.oracle,
      control_roundtrips: controlTokens.length,
      treatment_roundtrips: 1,
      control_visible_tokens: controlTokens.reduce((sum, value) => sum + value, 0),
      treatment_visible_tokens: treatmentTokens,
      control_model_input_tokens: controlModelInput,
      treatment_model_input_tokens: treatmentModelInput,
      model_input_savings_percent: percent(controlModelInput, treatmentModelInput),
      control_ms: item.control_ms,
      treatment_ms: item.treatment_ms,
    };
  });
  const sum = (field) => rows.reduce((total, row) => total + row[field], 0);
  const report = {
    benchmark: "roundtrip-singularity-ab",
    generated_at: new Date().toISOString(),
    scenarios: rows.length,
    mixed_steps_per_scenario: 6,
    oracles_passed: `${rows.filter((row) => row.oracle).length}/${rows.length}`,
    tokenizer: {
      exact: tokenized.exact,
      encoding: tokenized.encoding,
      version: tokenized.version,
      ...(tokenized.error ? { fallback_reason: tokenized.error } : {}),
    },
    roundtrip_reduction_percent: 83.33,
    visible_result_savings_percent: percent(
      sum("control_visible_tokens"),
      sum("treatment_visible_tokens")
    ),
    model_input_exposure_savings_percent: percent(
      sum("control_model_input_tokens"),
      sum("treatment_model_input_tokens")
    ),
    control_model_input_tokens: sum("control_model_input_tokens"),
    treatment_model_input_tokens: sum("treatment_model_input_tokens"),
    wall_time_savings_percent: percent(sum("control_ms"), sum("treatment_ms")),
    caveat: "Actual three-file plus three-command flows with exact aggregate recovery and o200k tokenization. Input exposure counts the eliminated serial model re-entries at the listed context sizes; provider cache weighting, hidden reasoning, billing, and network operations are excluded.",
    rows,
  };
  const writeIndex = process.argv.indexOf("--write");
  if (writeIndex >= 0) {
    const target = path.resolve(process.argv[writeIndex + 1] || "bench/roundtrip-singularity-results.json");
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().finally(() => {
  unified.closeSearchDatabase();
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
