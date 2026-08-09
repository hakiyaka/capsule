"use strict";

// A/B for the frequent plain Get-Content path.
// A = PowerShell envelope followed by the generic terminal projector.
// B = Capsule's verified local file read, evidence selection, and replay.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-get-content-ab-state-"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-get-content-ab-workspace-"));
const previousState = process.env.CAPSULE_STATE;
process.env.CAPSULE_STATE = state;
const core = require("../mcp/core.cjs");
const unified = require("../mcp/unified.cjs");
const getContent = require("../mcp/get-content.cjs");

function percent(before, after) {
  return before > 0 ? Number((((before - after) / before) * 100).toFixed(2)) : 0;
}

try {
  const file = path.join(workspace, "large.txt");
  const lines = Array.from({ length: 2_400 }, (_, index) =>
    `routine source line ${index + 1} remains stable and repeatable`
  );
  lines[1_731] = "ERROR GET-CONTENT-BENCHMARK-NEEDLE exact evidence";
  const text = `${lines.join("\n")}\n`;
  fs.writeFileSync(file, text, "utf8");
  const command = `Get-Content -LiteralPath "${file}"`;
  const common = {
    command,
    cwd: workspace,
    query: "GET-CONTENT-BENCHMARK-NEEDLE",
    max_chars: 1_200,
    passthrough_chars: 600,
  };
  const envelope = `# stdout\n${text}\n# stderr\n`;
  const baseline = unified.compressText(envelope, common);
  const first = getContent.fastPath(common);
  const repeat = getContent.fastPath(common);
  fs.appendFileSync(file, "changed after verified Get-Content replay\n", "utf8");
  const changed = getContent.fastPath(common);
  const report = {
    benchmark: "get-content-ab",
    method: "A=PowerShell stdout envelope + generic projector; B=native file evidence + exact replay",
    raw_chars: text.length,
    raw_tokens: core.estimateTokens(text),
    baseline: {
      route: baseline.route,
      chars: baseline.output.length,
      tokens: core.estimateTokens(baseline.output),
    },
    first: {
      route: first?.operation.route || null,
      chars: first?.output.length || 0,
      tokens: first ? core.estimateTokens(first.output) : 0,
      saving_vs_raw_percent: percent(text.length, first?.output.length || 0),
      saving_vs_baseline_percent: percent(baseline.output.length, first?.output.length || 0),
      exact_recovery: Boolean(first?.capsule_id && core.loadCapsule(first.capsule_id).text === text),
    },
    repeat: {
      route: repeat?.operation.route || null,
      chars: repeat?.output.length || 0,
      tokens: repeat ? core.estimateTokens(repeat.output) : 0,
      saving_vs_raw_percent: percent(text.length, repeat?.output.length || 0),
      saving_vs_baseline_percent: percent(baseline.output.length, repeat?.output.length || 0),
      exact_recovery: Boolean(repeat?.capsule_id && core.loadCapsule(repeat.capsule_id).text === text),
    },
    changed: {
      route: changed?.operation.route || null,
      replay_bypassed: changed?.operation.route !== "file-replay",
      exact_recovery: Boolean(changed?.capsule_id),
    },
    caveat: "Character/token proxies for model-visible context; not provider billing or hidden reasoning telemetry.",
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!first || !repeat || baseline.output.length <= 0 || !report.first.exact_recovery || !report.repeat.exact_recovery || !report.changed.replay_bypassed) {
    process.exitCode = 1;
  }
} finally {
  unified.closeSearchDatabase();
  if (previousState == null) delete process.env.CAPSULE_STATE;
  else process.env.CAPSULE_STATE = previousState;
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(state, { recursive: true, force: true });
}
