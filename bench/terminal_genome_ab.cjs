"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-terminal-genome-ab-"));
process.env.CAPSULE_STATE = path.join(root, "state");
const core = require("../mcp/core.cjs");
const genome = require("../mcp/terminal-genome.cjs");

const families = ["git", "npm", "pytest", "docker", "kubectl", "cargo", "dotnet", "go", "powershell", "generic"];

function tokenize(values) {
  const code = "import json,sys,tiktoken\nx=json.load(sys.stdin)\ne=tiktoken.get_encoding('o200k_base')\nprint(json.dumps([len(e.encode(str(v))) for v in x]))";
  const child = spawnSync(process.env.PYTHON || "python", ["-c", code], {
    input: JSON.stringify(values),
    encoding: "utf8",
    timeout: 120000,
    windowsHide: true,
  });
  return child.status === 0
    ? { exact: true, counts: JSON.parse(child.stdout) }
    : { exact: false, counts: values.map(core.estimateTokens) };
}

const rows = [];
for (const family of families) {
  const shared = Array.from({ length: 180 }, (_, index) =>
    "shared runtime phase " + String(index).padStart(3, "0") + " dependency-ready"
  ).join("\n");
  const control = [];
  const treatment = [];
  let oracle = true;
  for (let index = 0; index < 4; index += 1) {
    const unique = family + " command " + index + " terminal-proof-" + index;
    const output = shared + "\n" + unique;
    control.push(output);
    const projected = genome.project({
      session_id: "genome-" + family,
      cwd: root,
      command: family + " operation-" + index,
      text: output,
      exact_text: output,
      success: true,
    });
    treatment.push(projected ? projected.output : output);
    if (projected && core.loadCapsule(projected.capsule_id).text !== output) oracle = false;
    if (index > 0 && (!projected || !projected.output.includes(unique))) oracle = false;
  }
  const tokenized = tokenize([...control, ...treatment]);
  const controlTokens = tokenized.counts.slice(0, 4).reduce((sum, value) => sum + value, 0);
  const treatmentTokens = tokenized.counts.slice(4).reduce((sum, value) => sum + value, 0);
  rows.push({
    family,
    oracle,
    control_tokens: controlTokens,
    treatment_tokens: treatmentTokens,
    savings_percent: Number((((controlTokens - treatmentTokens) / controlTokens) * 100).toFixed(2)),
    tokenizer: tokenized.exact ? "o200k_base" : "estimate",
  });
}
const controlTokens = rows.reduce((sum, row) => sum + row.control_tokens, 0);
const treatmentTokens = rows.reduce((sum, row) => sum + row.treatment_tokens, 0);
const report = {
  benchmark: "terminal-genome-ab",
  generated_at: new Date().toISOString(),
  task_set: "Ten shell families, four different successful commands each, with cross-command shared boilerplate and unique terminal evidence.",
  scenarios: rows.length,
  oracles_passed: rows.filter((row) => row.oracle).length + "/" + rows.length,
  control_tokens: controlTokens,
  treatment_tokens: treatmentTokens,
  savings_percent: Number((((controlTokens - treatmentTokens) / controlTokens) * 100).toFixed(2)),
  rows,
  caveat: "Feature-activation benchmark for cross-command repeated boilerplate; unique, small, failed, unsafe, and token-negative outputs pass through.",
};
const output = JSON.stringify(report, null, 2);
const writeIndex = process.argv.indexOf("--write");
if (writeIndex >= 0 && process.argv[writeIndex + 1]) {
  fs.writeFileSync(path.resolve(process.argv[writeIndex + 1]), output + "\n", "utf8");
}
process.stdout.write(output + "\n");
if (rows.some((row) => !row.oracle)) process.exitCode = 1;
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
