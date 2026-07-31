"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-qpx-ab-"));
process.env.CAPSULE_STATE = state;
const core = require("../mcp/core.cjs");
const qpx = require("../mcp/quota-progress.cjs");

const scenarios = [
  ["code-edit", ["cache", "fix", "tests"], "The cache invalidation fix is installed and every focused and full test passes."],
  ["bug-diagnosis", ["auth", "root", "cause"], "The authentication fault was resolved and the regression proof is verified."],
  ["browser-check", ["browser", "checkout", "verify"], "The checkout state was verified in the browser with no console or network failures."],
  ["terminal-build", ["terminal", "build", "package"], "The package build completed and its generated artifact hash was verified."],
  ["web-research", ["research", "sources", "current"], "The current-source comparison is complete and all retained claims have evidence."],
  ["file-edit", ["config", "edit", "validate"], "The configuration edit is complete and the parser validation passed."],
  ["installation", ["plugin", "install", "hooks"], "The plugin is installed, enabled, hash-matched, and all hooks are ready."],
  ["data-check", ["dataset", "derive", "verify"], "The derived dataset was checked against its invariants and verified."],
  ["document-work", ["document", "change", "review"], "The requested document change is complete and the output was reviewed."],
  ["status-repeat", ["restart", "active", "status"], "The restarted service is active and its health check passed."],
];

const rows = [];
for (const [label, fingerprint, fact] of scenarios) {
  const session = `qpx-ab-${label}-${process.pid}-${Date.now()}-${Math.random()}`;
  qpx.begin({ session_id: session, project: "benchmark", prompt_fingerprint: fingerprint, epoch: 3 });
  qpx.noteTool({ session_id: session, tool_name: "shell_command", epoch: 3 });
  qpx.finish({
    session_id: session,
    credit_weighted_delta: 2_400,
    reasoning_delta: 320,
    last: { verified: true, changed_files: 1 },
    epoch: 3,
    final_message: fact,
  });
  const repeated = qpx.begin({
    session_id: session,
    project: "benchmark",
    prompt_fingerprint: [...fingerprint, "again"],
    epoch: 3,
  });
  const legacy = `[Legacy resumed verified state]\n${`${fact} Evidence and implementation details remain unchanged. `.repeat(18)}` +
    "\nRe-read the prior work and decide whether it must be executed again.";
  const treatment = `${repeated.context}\n${qpx.checkpoint(session)}`;
  const unrelated = qpx.begin({
    session_id: session,
    project: "benchmark",
    prompt_fingerprint: ["unrelated", label, "new"],
    epoch: 4,
  });
  rows.push({
    scenario: label,
    repeat_policy: repeated.receipt?.policy || "",
    repeat_kind: repeated.receipt?.repeat || "",
    control_tokens: core.estimateTokens(legacy),
    treatment_tokens: core.estimateTokens(treatment),
    exact_state_receipt: /receipt=/.test(repeated.context),
    changed_epoch_neutral_chars: unrelated.context.length,
    treatment_chars: treatment.length,
  });
}

const controlTokens = rows.reduce((sum, row) => sum + row.control_tokens, 0);
const treatmentTokens = rows.reduce((sum, row) => sum + row.treatment_tokens, 0);
const result = {
  benchmark: "quota-to-progress-exchange-ab",
  generated_at: new Date().toISOString(),
  task_set: "Ten synthetic, frequently repeated verified-state continuations plus changed-epoch neutral controls.",
  arm_a: "Re-expose the verbose verified continuation and invite re-evaluation.",
  arm_b: "Expose a bounded anti-memory receipt and quota-progress checkpoint.",
  eligible_scenarios: rows.length,
  policy_oracles_passed: rows.filter((row) =>
    row.repeat_policy === "anti-memory" &&
    row.repeat_kind === "near" &&
    row.exact_state_receipt
  ).length,
  neutral_controls_passed: rows.filter((row) => row.changed_epoch_neutral_chars === 0).length,
  control_tokens: controlTokens,
  treatment_tokens: treatmentTokens,
  saved_tokens: controlTokens - treatmentTokens,
  eligible_context_savings_percent: Number(
    (((controlTokens - treatmentTokens) / Math.max(1, controlTokens)) * 100).toFixed(2)
  ),
  max_treatment_chars: Math.max(...rows.map((row) => row.treatment_chars)),
  caveat: "Synthetic repeated-state context exposure only. It does not measure hidden reasoning, provider billing, cache effects, or the frequency of verified repeats. Low-progress brakes add a bounded instruction and are not counted as direct savings.",
  rows,
};

const writeIndex = process.argv.indexOf("--write");
if (writeIndex >= 0) {
  const target = path.resolve(process.argv[writeIndex + 1] || "bench/quota-progress-exchange-results.json");
  fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}
fs.rmSync(state, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
