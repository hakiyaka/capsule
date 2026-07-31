"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-terminal-lattice-ab-"));
process.env.CAPSULE_STATE = path.join(root, "state");
const core = require("../mcp/core.cjs");
const terminal = require("../mcp/terminal-genome.cjs");

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

const controls = [];
const treatments = [];
const rows = [];
for (const family of families) {
  const output = Array.from({ length: 180 }, (_, index) =>
    family + " phase " + String(index).padStart(4, "0") +
    " artifact build/" + family + "/module-" + String(index).padStart(4, "0") +
    ".bin duration " + (index + 1) + "ms"
  ).join("\n") + "\nwarning: retained-" + family + "-diagnostic\nFINAL " + family.toUpperCase() + " PROOF";
  const projected = terminal.project({
    session_id: "lattice-" + family,
    cwd: root,
    command: family + " first-seen-operation",
    text: output,
    exact_text: output,
    success: true,
  });
  controls.push(output);
  treatments.push(projected ? projected.output : output);
  rows.push({
    family,
    activated: projected?.mode === "lattice",
    oracle: Boolean(
      projected &&
      projected.mode === "lattice" &&
      projected.output.includes("retained-" + family + "-diagnostic") &&
      projected.output.includes("FINAL " + family.toUpperCase() + " PROOF") &&
      core.loadCapsule(projected.capsule_id).text === output
    ),
  });
}

const tokenized = tokenize([...controls, ...treatments]);
for (let index = 0; index < rows.length; index += 1) {
  rows[index].control_tokens = tokenized.counts[index];
  rows[index].treatment_tokens = tokenized.counts[index + rows.length];
  rows[index].savings_percent = Number(
    (((rows[index].control_tokens - rows[index].treatment_tokens) /
      rows[index].control_tokens) * 100).toFixed(2)
  );
  rows[index].tokenizer = tokenized.exact ? "o200k_base" : "estimate";
}
const controlTokens = rows.reduce((sum, row) => sum + row.control_tokens, 0);
const treatmentTokens = rows.reduce((sum, row) => sum + row.treatment_tokens, 0);
const report = {
  benchmark: "terminal-lattice-ab",
  generated_at: new Date().toISOString(),
  task_set: "Ten first-seen successful shell families with 180 structured rows, one warning, and one unique proof each.",
  scenarios: rows.length,
  activations: rows.filter((row) => row.activated).length + "/" + rows.length,
  oracles_passed: rows.filter((row) => row.oracle).length + "/" + rows.length,
  control_tokens: controlTokens,
  treatment_tokens: treatmentTokens,
  savings_percent: Number((((controlTokens - treatmentTokens) / controlTokens) * 100).toFixed(2)),
  rows,
  caveat: "Feature-activation benchmark, not an all-shell or billing percentage. Unstructured, short, failed, critical-heavy, and token-negative output deliberately passes through.",
};
const result = JSON.stringify(report, null, 2);
const writeIndex = process.argv.indexOf("--write");
if (writeIndex >= 0 && process.argv[writeIndex + 1]) {
  fs.writeFileSync(path.resolve(process.argv[writeIndex + 1]), result + "\n", "utf8");
}
process.stdout.write(result + "\n");
if (rows.some((row) => !row.oracle)) process.exitCode = 1;
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
