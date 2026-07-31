"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-proofpatch-ab-"));
process.env.CAPSULE_STATE = path.join(temporaryRoot, "state");
const core = require("../mcp/core.cjs");
const unified = require("../mcp/unified.cjs");

const contexts = [8_000, 16_000, 32_000, 64_000, 96_000, 128_000, 160_000, 192_000, 220_000, 240_000];

function writeFixture(root, label, shouldPass) {
  fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, "value.txt");
  const verifier = path.join(root, "verify.cjs");
  fs.writeFileSync(target, "before\n", "utf8");
  fs.writeFileSync(verifier, [
    '"use strict";',
    'const fs = require("node:fs");',
    'const value = fs.readFileSync(process.argv[2], "utf8").trim();',
    `for (let index = 0; index < 220; index += 1) console.log("${label} case " + index + ": passed");`,
    shouldPass
      ? 'if (value !== "after") { console.error(`FAIL expected after received ${value}`); process.exit(3); }'
      : 'console.error(`FAIL expected green received ${value}`); process.exit(4);',
    'console.log("PASS verification complete");',
  ].join("\n"), "utf8");
  return { target, verifier };
}

function tokenize(texts) {
  const program = [
    "import importlib.metadata,json,sys,tiktoken",
    "payload=json.load(sys.stdin)",
    "enc=tiktoken.get_encoding('o200k_base')",
    "print(json.dumps({'encoding':'o200k_base','version':importlib.metadata.version('tiktoken'),'counts':[len(enc.encode(str(x))) for x in payload]}))",
  ].join("\n");
  const child = spawnSync(process.env.PYTHON || "python", ["-c", program], {
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

async function main() {
  const artifacts = [];
  for (let index = 0; index < contexts.length; index += 1) {
    const pass = index < 8;
    const controlRoot = path.join(temporaryRoot, `control-${index}`);
    const treatmentRoot = path.join(temporaryRoot, `treatment-${index}`);
    const control = writeFixture(controlRoot, `scenario-${index}`, pass);
    const treatment = writeFixture(treatmentRoot, `scenario-${index}`, pass);

    const editControl = await unified.dispatch({
      action: "file",
      payload: {
        operation: "edit",
        root: controlRoot,
        path: control.target,
        ops: [["r", "before", "after"]],
      },
    });
    const verifyControl = await unified.dispatch({
      action: "run",
      payload: {
        command: process.execPath,
        args: [control.verifier, control.target],
        cwd: controlRoot,
        profile: "test",
        passthrough_chars: 0,
        max_chars: 1_200,
        result_future: false,
      },
    });
    const fused = await unified.dispatch({
      action: "file",
      payload: {
        operation: "edit",
        root: treatmentRoot,
        path: treatment.target,
        ops: [["r", "before", "after"]],
        verify: {
          command: process.execPath,
          args: [treatment.verifier, treatment.target],
          profile: "test",
        },
      },
    });
    const controlExit = verifyControl.response?.exit_code ??
      verifyControl.response?.execution?.exit_code ??
      verifyControl.details?.exit_code;
    const fusedExit = fused.response.proofpatch.results[0].exit_code;
    if (Number(controlExit) !== Number(fusedExit)) {
      throw new Error(`oracle mismatch in scenario ${index}: ${controlExit} != ${fusedExit}`);
    }
    artifacts.push({
      scenario: index,
      context_tokens: contexts[index],
      expected_pass: pass,
      control_edit: core.renderOperation(editControl),
      control_verify: core.renderOperation(verifyControl),
      treatment_fused: core.renderOperation(fused),
      oracle: Number(controlExit) === Number(fusedExit) &&
        fs.readFileSync(control.target, "utf8") === fs.readFileSync(treatment.target, "utf8"),
    });
  }

  const strings = artifacts.flatMap((item) =>
    [item.control_edit, item.control_verify, item.treatment_fused]
  );
  const tokenized = tokenize(strings);
  const rows = artifacts.map((item, index) => {
    const editTokens = tokenized.counts[index * 3];
    const verifyTokens = tokenized.counts[index * 3 + 1];
    const fusedTokens = tokenized.counts[index * 3 + 2];
    const controlVisible = editTokens + verifyTokens;
    const treatmentVisible = fusedTokens;
    const controlModelInput = (item.context_tokens + editTokens) +
      (item.context_tokens + editTokens + verifyTokens);
    const treatmentModelInput = item.context_tokens + fusedTokens;
    return {
      scenario: item.scenario,
      context_tokens: item.context_tokens,
      expected_pass: item.expected_pass,
      oracle: item.oracle,
      control_roundtrips: 2,
      treatment_roundtrips: 1,
      control_visible_tokens: controlVisible,
      treatment_visible_tokens: treatmentVisible,
      visible_savings_percent: percent(controlVisible, treatmentVisible),
      control_model_input_tokens: controlModelInput,
      treatment_model_input_tokens: treatmentModelInput,
      model_input_savings_percent: percent(controlModelInput, treatmentModelInput),
    };
  });
  const sum = (field) => rows.reduce((total, row) => total + row[field], 0);
  const report = {
    benchmark: "proofpatch-reactor-ab",
    generated_at: new Date().toISOString(),
    scenarios: rows.length,
    passing_scenarios: rows.filter((row) => row.expected_pass).length,
    failing_scenarios: rows.filter((row) => !row.expected_pass).length,
    oracles_passed: `${rows.filter((row) => row.oracle).length}/${rows.length}`,
    tokenizer: {
      exact: tokenized.exact,
      encoding: tokenized.encoding,
      version: tokenized.version,
      ...(tokenized.error ? { fallback_reason: tokenized.error } : {}),
    },
    roundtrip_reduction_percent: 50,
    visible_tool_result_savings_percent: percent(
      sum("control_visible_tokens"),
      sum("treatment_visible_tokens")
    ),
    model_input_exposure_savings_percent: percent(
      sum("control_model_input_tokens"),
      sum("treatment_model_input_tokens")
    ),
    control_model_input_tokens: sum("control_model_input_tokens"),
    treatment_model_input_tokens: sum("treatment_model_input_tokens"),
    caveat: "Actual edit and verifier processes plus exact model-visible receipts. Model-input exposure uses the listed context sizes to count the eliminated intermediate model turn; hidden reasoning, provider caching, billing, and latency are excluded.",
    rows,
  };
  const writeIndex = process.argv.indexOf("--write");
  if (writeIndex >= 0) {
    const target = path.resolve(process.argv[writeIndex + 1] || "bench/proofpatch-results.json");
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
