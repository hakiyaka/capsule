"use strict";

const fs = require("node:fs");
const path = require("node:path");
const core = require("../mcp/core.cjs");
const unified = require("../mcp/unified.cjs");
const novelty = require("../mcp/terminal-novelty.cjs");
const residual = require("../mcp/reasoning-residual.cjs");

const scenarios = [
  ["node-test", "npm test"],
  ["python-test", "pytest -q"],
  ["rust-test", "cargo test"],
  ["go-test", "go test ./..."],
  ["dotnet-test", "dotnet test"],
  ["javascript-lint", "npm run lint"],
  ["typescript-check", "tsc --noEmit"],
  ["frontend-build", "npm run build"],
  ["maven-test", "mvn test"],
  ["gradle-test", "./gradlew test"],
];

function text(label, fault, passed = false, run = 0) {
  const stable = Array.from({ length: 220 }, (_, index) =>
    `${label} case ${String(index).padStart(3, "0")}: PASS in ${12 + index + run}ms`
  ).join("\n");
  if (passed) {
    return `# stdout\n${stable}\nPASS ${label}: 221 passed in ${2 + run}.4s\n# stderr\n`;
  }
  return `# stdout\n${stable}\nFAIL ${label}/auth: ${fault}\nAssertionError: ${fault}\n` +
    `Tests: 1 failed, 220 passed in ${2 + run}.4s\n# stderr\n`;
}

function save(value, source) {
  return core.saveCapsule({
    kind: "reasoning-residual-benchmark",
    source,
    text: value,
    maxChars: 1_200,
  }).response.capsule_id;
}

const rows = [];
for (const [label, command] of scenarios) {
  const session = `rr-bench-${label}-${process.pid}-${Date.now()}-${Math.random()}`;
  const iterations = [
    { epoch: 0, code: 1, text: text(label, "expected 200 received 500", false, 0) },
    { epoch: 1, code: 1, text: text(label, "expected 200 received 500", false, 1) },
    { epoch: 2, code: 1, text: text(label, "expected 200 received 401", false, 2) },
    { epoch: 3, code: 0, text: text(label, "", true, 3) },
  ];
  let controlTokens = 0;
  let treatmentTokens = 0;
  const transitions = [];
  for (const [index, item] of iterations.entries()) {
    const capsuleId = save(item.text, `${label}-${index}`);
    const compressed = unified.compressText(item.text, {
      command,
      cwd: process.cwd(),
      profile: novelty.commandProfile(command),
      max_chars: 1_200,
      passthrough_chars: 1_200,
    });
    const compressedOutput = compressed.route === "compressed"
      ? `${compressed.output}\n\n[Capsule exact capsule: ${capsuleId}]`
      : item.text;
    const current = novelty.terminalNovelty({
      session_id: session,
      cwd: process.cwd(),
      command,
      text: item.text,
      capsule_id: capsuleId,
      baseline_output: compressedOutput,
    });
    const currentOutput = current?.output || compressedOutput;
    const next = residual.reasoningResidual({
      session_id: session,
      cwd: process.cwd(),
      command,
      text: item.text,
      capsule_id: capsuleId,
      baseline_output: currentOutput,
      execution_epoch: item.epoch,
      exit_code: item.code,
    });
    const nextOutput = next?.output || currentOutput;
    controlTokens += core.estimateTokens(currentOutput);
    treatmentTokens += core.estimateTokens(nextOutput);
    transitions.push(next?.status || (index === 0 ? "baseline" : "terminal-novelty"));
  }
  rows.push({
    scenario: label,
    command,
    iterations: iterations.length,
    control_tokens: controlTokens,
    treatment_tokens: treatmentTokens,
    saved_tokens: controlTokens - treatmentTokens,
    savings_percent: Number((((controlTokens - treatmentTokens) / controlTokens) * 100).toFixed(2)),
    transitions,
  });
}

const control = rows.reduce((sum, row) => sum + row.control_tokens, 0);
const treatment = rows.reduce((sum, row) => sum + row.treatment_tokens, 0);
const result = {
  benchmark: "reasoning-residual-ab",
  generated_at: new Date().toISOString(),
  scope: "10 common four-step edit-validation loops; control already includes Terminal Novelty Ledger",
  scenarios: rows.length,
  iterations: rows.reduce((sum, row) => sum + row.iterations, 0),
  control_tokens: control,
  treatment_tokens: treatment,
  saved_tokens: control - treatment,
  savings_percent: Number((((control - treatment) / control) * 100).toFixed(2)),
  measurement: "Capsule tokenizer estimate over actually emitted control/treatment strings",
  reasoning_claim: "The control tags preserve causal state and instruct against re-diagnosis; hidden model reasoning-token savings are not directly observable and are not included.",
  rows,
};

const writeIndex = process.argv.indexOf("--write");
if (writeIndex >= 0) {
  const target = path.resolve(process.argv[writeIndex + 1] || "bench/reasoning-residual-results.json");
  fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
