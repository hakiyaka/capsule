"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-terminal-fuzz-"));
process.env.CAPSULE_STATE = stateRoot;
const core = require("../mcp/core.cjs");
const terminal = require("../mcp/terminal-genome.cjs");

let seed = 0x5eeda11;
function random() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 0x1_0000_0000;
}

function pick(values) {
  return values[Math.floor(random() * values.length)];
}

const durations = ["1ms", "75ms", "900ms", "2s", "3min"];
const sizes = ["1KB", "900KB", "2MB", "3MiB", "1GB"];
const words = [
  "golf", "hotel", "india", "juliet", "kilo", "lima", "mango", "november",
  "oscar", "papa", "quebec", "romeo", "sierra", "tango", "uniform", "victor",
  "whiskey", "xray", "yankee", "zulu",
];

function structured(caseId, unicode = false) {
  const prefix = unicode ? "operation item" : "task artifact";
  return Array.from({ length: 80 + Math.floor(random() * 80) }, (_, index) =>
    prefix + " " + index +
    " file src/module-" + String(index).padStart(4, "0") + ".js" +
    " size " + pick(sizes) +
    " duration " + pick(durations) +
    " url https://example.test/build/" + caseId + "/" + index
  ).join("\n") + "\nUNIQUE PROOF " + caseId;
}

function unstructured() {
  return Array.from({ length: 60 }, (_, index) => {
    const offset = index % words.length;
    return Array.from({ length: 8 }, (__, wordIndex) =>
      words[(offset + wordIndex) % words.length]
    ).join(" ");
  }).join("\n");
}

function criticalSafe(caseId) {
  const base = structured(caseId);
  const warnings = Array.from({ length: 5 }, (_, index) =>
    "warning: retained diagnostic " + caseId + "-" + index
  );
  return base + "\n" + warnings.join("\n");
}

function criticalHeavy(caseId) {
  return Array.from({ length: 40 }, (_, index) =>
    "warning: case " + caseId + " artifact src/module-" + index + ".js"
  ).join("\n");
}

const cases = [];
for (let index = 0; index < 40; index += 1) {
  cases.push({ category: "structured", text: structured("s" + index), expect_activation: true });
  cases.push({ category: "unicode-structured", text: structured("u" + index, true), expect_activation: true });
  cases.push({ category: "critical-safe", text: criticalSafe("c" + index), expect_activation: true });
  cases.push({ category: "unstructured", text: unstructured(), expect_bypass: true });
  cases.push({ category: "critical-heavy", text: criticalHeavy("h" + index), expect_bypass: true });
  cases.push({
    category: "failed",
    text: structured("f" + index),
    success: false,
    expect_bypass: true,
  });
  cases.push({
    category: "literal",
    text: structured("l" + index),
    require_literal: true,
    expect_bypass: true,
  });
}

for (let index = 0; index < 40; index += 1) {
  const session = "warm-change-" + index;
  const before = Array.from({ length: 100 }, (_, row) =>
    "worker " + row + " latency 100ms at 2026-07-28T10:00:00Z"
  ).join("\n");
  const after = Array.from({ length: 100 }, (_, row) =>
    "worker " + row + " latency 9s at 2026-07-28T11:00:00Z"
  ).join("\n");
  terminal.project({
    session_id: session,
    cwd: stateRoot,
    command: "warm before",
    text: before,
    success: true,
  });
  cases.push({
    category: "warm-semantic-change",
    session,
    text: after,
    expect_activation: true,
    required_visible: ["9s", "2026-07-28T11:00:00Z"],
  });
}

const observations = cases.map((item, index) => {
  const result = terminal.project({
    session_id: item.session || "fuzz-" + index,
    cwd: stateRoot,
    command: item.require_literal ? "benchmark full output" : "ordinary operation",
    text: item.text,
    exact_text: item.text,
    success: item.success !== false,
    require_literal: item.require_literal === true,
  });
  const treatment = result ? result.output : item.text;
  const critical = item.text.split(/\r?\n/).filter((line) =>
    /\b(?:error|fail(?:ed|ure)?|exception|panic|fatal|warning|warn|denied|conflict|timeout|timed out)\b/i.test(line)
  );
  let exactRecovery = !result;
  if (result) {
    try {
      exactRecovery = core.loadCapsule(result.capsule_id).text === item.text;
    } catch {
      exactRecovery = false;
    }
  }
  return {
    category: item.category,
    control: item.text,
    treatment,
    activated: Boolean(result),
    expected_activation: item.expect_activation === true,
    expected_bypass: item.expect_bypass === true,
    exact_recovery: exactRecovery,
    critical_visible: !result || critical.every((line) => treatment.includes(line)),
    required_visible: (item.required_visible || []).every((value) => treatment.includes(value)),
    char_pareto: !result || treatment.length < item.text.length,
  };
});

function tokenize(values) {
  const code = [
    "import json,sys,tiktoken",
    "values=json.load(sys.stdin)",
    "enc=tiktoken.get_encoding('o200k_base')",
    "print(json.dumps([len(enc.encode(str(value))) for value in values]))",
  ].join("\n");
  const child = spawnSync(process.env.PYTHON || "python", ["-c", code], {
    input: JSON.stringify(values),
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  if (child.status === 0) return { exact: true, counts: JSON.parse(child.stdout) };
  return { exact: false, counts: values.map(core.estimateTokens) };
}

const tokenized = tokenize([
  ...observations.map((item) => item.control),
  ...observations.map((item) => item.treatment),
]);
for (let index = 0; index < observations.length; index += 1) {
  const item = observations[index];
  item.control_tokens = tokenized.counts[index];
  item.treatment_tokens = tokenized.counts[index + observations.length];
  item.token_pareto = !item.activated || item.treatment_tokens < item.control_tokens;
  item.activation_valid =
    (!item.expected_activation || item.activated) &&
    (!item.expected_bypass || !item.activated);
  item.oracle = item.exact_recovery &&
    item.critical_visible &&
    item.required_visible &&
    item.char_pareto &&
    item.token_pareto &&
    item.activation_valid;
}

const categories = [...new Set(observations.map((item) => item.category))].sort().map((category) => {
  const rows = observations.filter((item) => item.category === category);
  const controlTokens = rows.reduce((sum, item) => sum + item.control_tokens, 0);
  const treatmentTokens = rows.reduce((sum, item) => sum + item.treatment_tokens, 0);
  return {
    category,
    cases: rows.length,
    activations: rows.filter((item) => item.activated).length,
    oracles: rows.filter((item) => item.oracle).length + "/" + rows.length,
    control_tokens: controlTokens,
    treatment_tokens: treatmentTokens,
    savings_percent: Number(
      (((controlTokens - treatmentTokens) / Math.max(1, controlTokens)) * 100).toFixed(2)
    ),
  };
});
const activated = observations.filter((item) => item.activated);
const activatedControl = activated.reduce((sum, item) => sum + item.control_tokens, 0);
const activatedTreatment = activated.reduce((sum, item) => sum + item.treatment_tokens, 0);
const failures = observations.filter((item) => !item.oracle);
const report = {
  benchmark: "terminal-pareto-fuzz",
  generated_at: new Date().toISOString(),
  seed: "0x5eeda11",
  cases: observations.length,
  activations: activated.length,
  oracles_passed: observations.filter((item) => item.oracle).length + "/" + observations.length,
  tokenizer: tokenized.exact ? "o200k_base" : "estimate",
  activated_control_tokens: activatedControl,
  activated_treatment_tokens: activatedTreatment,
  activated_savings_percent: Number(
    (((activatedControl - activatedTreatment) / Math.max(1, activatedControl)) * 100).toFixed(2)
  ),
  token_regressions: observations.filter((item) => !item.token_pareto).length,
  false_activations: observations.filter((item) => item.expected_bypass && item.activated).length,
  missed_expected_activations: observations.filter((item) => item.expected_activation && !item.activated).length,
  categories,
  failures: failures.slice(0, 20).map((item) => ({
    category: item.category,
    activated: item.activated,
    exact_recovery: item.exact_recovery,
    critical_visible: item.critical_visible,
    required_visible: item.required_visible,
    char_pareto: item.char_pareto,
    token_pareto: item.token_pareto,
    activation_valid: item.activation_valid,
  })),
};
const output = JSON.stringify(report, null, 2);
const writeIndex = process.argv.indexOf("--write");
if (writeIndex >= 0 && process.argv[writeIndex + 1]) {
  fs.writeFileSync(path.resolve(process.argv[writeIndex + 1]), output + "\n", "utf8");
}
process.stdout.write(output + "\n");
if (failures.length) process.exitCode = 1;
process.on("exit", () => fs.rmSync(stateRoot, { recursive: true, force: true }));
