"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-edit-bench-state-"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-edit-bench-work-"));
process.env.CAPSULE_STATE = state;
const unified = require("../mcp/unified.cjs");

function patchFor(file, edits) {
  return [
    "*** Begin Patch",
    `*** Update File: ${file}`,
    ...edits.flatMap(([oldText, newText]) => [
      "@@",
      `-${oldText}`,
      `+${newText}`,
    ]),
    "*** End Patch",
  ].join("\n");
}

async function runCase(name, fileCount, fillerLines) {
  const files = [];
  const patches = [];
  for (let index = 0; index < fileCount; index += 1) {
    const target = path.join(workspace, `${name}-${index}.txt`);
    const content = [
      `mode=legacy-${index}`,
      ...Array.from({ length: fillerLines }, (_, line) => `stable setting ${index}-${line}=enabled`),
      `timeout=${10 + index}`,
      `footer=${index}`,
    ].join("\n");
    fs.writeFileSync(target, content, "utf8");
    files.push({
      path: target,
      ops: [
        ["r", `mode=legacy-${index}`, `mode=modern-${index}`],
        ["r", `timeout=${10 + index}`, `timeout=${30 + index}`],
      ],
    });
    patches.push(patchFor(target, [
      [`mode=legacy-${index}`, `mode=modern-${index}`],
      [`timeout=${10 + index}`, `timeout=${30 + index}`],
    ]));
  }

  const transactionPayload = {
    action: "file",
    payload: { operation: "edit", root: workspace, files },
  };
  const result = await unified.dispatch(transactionPayload);
  const verificationChars = files.reduce(
    (sum, item) => sum + fs.readFileSync(item.path, "utf8").length,
    0
  );
  const baselineChars =
    JSON.stringify({ tool: "apply_patch", input: patches.join("\n") }).length +
    "Done!".length +
    verificationChars;
  const treatmentChars = JSON.stringify(transactionPayload).length + JSON.stringify(result.response).length;
  return {
    name,
    files: fileCount,
    baseline_patch_plus_full_verification_chars: baselineChars,
    transaction_request_plus_receipt_chars: treatmentChars,
    saving_percent: Number(((baselineChars - treatmentChars) / baselineChars * 100).toFixed(2)),
    committed: result.response.committed === true,
    exact_capsules: result.response.files.every((item) =>
      /^cap_[a-f0-9]{16}$/.test(item.exact_before) && /^cap_[a-f0-9]{16}$/.test(item.exact_after)),
  };
}

try {
  Promise.all([
    runCase("single-medium", 1, 500),
    runCase("multi-file", 5, 300),
    runCase("single-large", 1, 4_000),
  ]).then((cases) => {
    const baseline = cases.reduce(
      (sum, item) => sum + item.baseline_patch_plus_full_verification_chars,
      0
    );
    const treatment = cases.reduce(
      (sum, item) => sum + item.transaction_request_plus_receipt_chars,
      0
    );
    const output = {
      method: {
        baseline: "Traditional patch request, tiny success output, then one full-file verification read.",
        treatment: "Compact atomic edit tuples plus checksum/exact-capsule receipt; no redundant full reread.",
        scope: "Serialized model-visible characters, not provider billing or cached-input accounting.",
      },
      summary: {
        cases: cases.length,
        baseline_chars: baseline,
        treatment_chars: treatment,
        weighted_saving_percent: Number(((baseline - treatment) / baseline * 100).toFixed(2)),
        safety_pass: cases.every((item) => item.committed && item.exact_capsules),
      },
      cases,
    };
    const writeIndex = process.argv.indexOf("--write");
    if (writeIndex >= 0 && process.argv[writeIndex + 1]) {
      fs.writeFileSync(path.resolve(process.argv[writeIndex + 1]), `${JSON.stringify(output, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (!output.summary.safety_pass) process.exitCode = 1;
  }).finally(() => {
    unified.closeSearchDatabase();
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });
} catch (error) {
  unified.closeSearchDatabase();
  fs.rmSync(state, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
  throw error;
}
