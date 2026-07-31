"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-media-bench-"));
process.env.CAPSULE_STATE = state;

const hook = require("../scripts/hook.cjs");
const unified = require("../mcp/unified.cjs");

function visibleChars(result) {
  const output = result?.hookSpecificOutput || {};
  return String(output.updatedMCPToolOutput || "").length +
    String(output.additionalContext || "").length;
}

function hasReplacement(result) {
  return Boolean(result?.hookSpecificOutput?.updatedMCPToolOutput);
}

function runCase(rawBytes) {
  const session = `media-bench-${rawBytes}`;
  const toolOutput = {
    content: [{
      type: "image",
      image_url: `data:image/png;base64,${Buffer.alloc(rawBytes, rawBytes % 251).toString("base64")}`,
    }],
  };
  const input = {
    tool_name: "view_image",
    tool_input: { path: path.join(os.tmpdir(), `visual-${rawBytes}.png`), detail: "high" },
    tool_output: toolOutput,
    cwd: process.cwd(),
    session_id: session,
  };
  hook.handle("userpromptsubmit", { cwd: process.cwd(), session_id: session });
  const results = Array.from({ length: 5 }, () => hook.handle("posttooluse", input));
  const payloadChars = JSON.stringify(toolOutput).length;
  const baselineChars = payloadChars * results.length;
  const treatmentChars = payloadChars + results.slice(1).reduce(
    (total, result) => total + visibleChars(result),
    0
  );
  const duplicateBaselineChars = payloadChars * (results.length - 1);
  const duplicateTreatmentChars = results.slice(1).reduce(
    (total, result) => total + visibleChars(result),
    0
  );
  return {
    raw_bytes: rawBytes,
    views: results.length,
    first_view_full: !hasReplacement(results[0]),
    later_views_compact: results.slice(1).every(hasReplacement),
    a_full_replay_chars: baselineChars,
    b_first_full_then_references_chars: treatmentChars,
    sequence_saving_percent: Number(
      ((baselineChars - treatmentChars) / baselineChars * 100).toFixed(2)
    ),
    duplicate_only_saving_percent: Number(
      ((duplicateBaselineChars - duplicateTreatmentChars) / duplicateBaselineChars * 100).toFixed(2)
    ),
  };
}

function safetyChecks() {
  const session = "media-bench-safety";
  const baseOutput = {
    content: [{
      type: "image",
      image_url: `data:image/png;base64,${Buffer.alloc(8_192, 0x51).toString("base64")}`,
    }],
  };
  const base = {
    tool_name: "view_image",
    tool_input: { path: path.join(os.tmpdir(), "safety.png"), detail: "high" },
    tool_output: baseOutput,
    cwd: process.cwd(),
    session_id: session,
  };
  hook.handle("userpromptsubmit", { cwd: process.cwd(), session_id: session });
  hook.handle("posttooluse", base);
  const duplicate = hook.handle("posttooluse", base);
  hook.handle("userpromptsubmit", { cwd: process.cwd(), session_id: session });
  const afterNewTurn = hook.handle("posttooluse", base);
  const changed = hook.handle("posttooluse", {
    ...base,
    tool_output: {
      ...baseOutput,
      caption: "new evidence",
    },
  });
  const originalDetail = hook.handle("posttooluse", {
    ...base,
    tool_input: { ...base.tool_input, detail: "original" },
  });
  return {
    exact_repeat_compacted: hasReplacement(duplicate),
    new_user_turn_full: !hasReplacement(afterNewTurn),
    changed_output_full: !hasReplacement(changed),
    different_detail_full: !hasReplacement(originalDetail),
  };
}

try {
  const cases = [64 * 1024, 256 * 1024, 1024 * 1024].map(runCase);
  const safety = safetyChecks();
  const aTotal = cases.reduce((total, item) => total + item.a_full_replay_chars, 0);
  const bTotal = cases.reduce(
    (total, item) => total + item.b_first_full_then_references_chars,
    0
  );
  const output = {
    method: {
      scope: "Serialized media-envelope characters exposed at the PostToolUse boundary.",
      exclusion: "This does not estimate provider image tokens, billing, latency, or visual quality.",
      sequence: "Five byte-identical view_image results: A sends all five; B sends one full result and four compact references.",
    },
    summary: {
      cases: cases.length,
      safety_pass: Object.values(safety).every(Boolean),
      a_total_chars: aTotal,
      b_total_chars: bTotal,
      weighted_sequence_saving_percent: Number(((aTotal - bTotal) / aTotal * 100).toFixed(2)),
    },
    safety,
    cases,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.summary.safety_pass || cases.some((item) => !item.first_view_full || !item.later_views_compact)) {
    process.exitCode = 1;
  }
} finally {
  unified.closeSearchDatabase();
  fs.rmSync(state, { recursive: true, force: true });
}
