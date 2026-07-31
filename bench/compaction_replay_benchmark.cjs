"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-compaction-bench-"));
process.env.CAPSULE_STATE = state;

const hook = require("../scripts/hook.cjs");
const unified = require("../mcp/unified.cjs");

function evidence(targetChars) {
  const lines = [];
  let length = 0;
  for (let index = 0; length < targetChars; index += 1) {
    const digest = crypto.createHash("sha256").update(`record-${targetChars}-${index}`).digest("hex");
    const line = JSON.stringify({
      index,
      digest,
      status: index % 11 === 0 ? "warning" : "ok",
      detail: `unique deterministic diagnostic record ${index}`,
    });
    lines.push(line);
    length += line.length + (lines.length > 1 ? 1 : 0);
  }
  return lines.join("\n").slice(0, targetChars);
}

function visibleChars(result, rawOutput) {
  const hookOutput = result?.hookSpecificOutput || {};
  const primary = hookOutput.updatedMCPToolOutput == null
    ? String(rawOutput)
    : String(hookOutput.updatedMCPToolOutput);
  return primary.length + String(hookOutput.additionalContext || "").length;
}

function runCase(rawChars) {
  const output = evidence(rawChars);
  const baselineSession = `compaction-a-${rawChars}`;
  const baselineInput = {
    tool_name: "workspace.read_file",
    tool_input: { path: path.join(os.tmpdir(), `evidence-${rawChars}.jsonl`) },
    tool_output: output,
    cwd: process.cwd(),
    session_id: baselineSession,
  };
  const baselineResult = hook.handle("posttooluse", baselineInput);
  const baselineVisible = visibleChars(baselineResult, output);

  const treatmentSession = `compaction-b-${rawChars}`;
  const treatmentInput = { ...baselineInput, session_id: treatmentSession };
  hook.handle("posttooluse", treatmentInput);
  const precompact = hook.handle("precompact", {
    summary: "Compact this task.",
    cwd: process.cwd(),
    session_id: treatmentSession,
  });
  hook.handle("sessionstart", {
    source: "compact",
    cwd: process.cwd(),
    session_id: treatmentSession,
  });
  const treatmentResult = hook.handle("posttooluse", treatmentInput);
  const treatmentVisible = visibleChars(treatmentResult, output) +
    String(precompact?.hookSpecificOutput?.additionalContext || "").length;
  const replacement = String(treatmentResult?.hookSpecificOutput?.updatedMCPToolOutput || "");
  return {
    raw_chars: rawChars,
    a_baseline_post_compaction_chars: baselineVisible,
    b_capsule_dictionary_chars: treatmentVisible,
    saving_percent: Number(((baselineVisible - treatmentVisible) / baselineVisible * 100).toFixed(2)),
    exact_capsule_reference: /\btc_[a-f0-9]{16}\b/i.test(replacement),
    marked_after_compaction: /after compaction/i.test(replacement),
  };
}

function safetyChecks() {
  const session = "compaction-bench-safety";
  const large = evidence(32 * 1024);
  const base = {
    tool_name: "workspace.read_file",
    tool_input: { path: path.join(os.tmpdir(), "safety-evidence.jsonl") },
    tool_output: large,
    cwd: process.cwd(),
    session_id: session,
  };
  hook.handle("posttooluse", base);
  hook.handle("precompact", { cwd: process.cwd(), session_id: session });
  const exact = hook.handle("posttooluse", base);
  const changed = hook.handle("posttooluse", { ...base, tool_output: `${large}\nCHANGED` });

  const smallSession = "compaction-bench-small";
  const small = { ...base, session_id: smallSession, tool_output: "small immutable evidence ".repeat(80) };
  hook.handle("posttooluse", small);
  hook.handle("precompact", { cwd: process.cwd(), session_id: smallSession });
  const smallAgain = hook.handle("posttooluse", small);
  return {
    exact_large_replay_compact: /after compaction/i.test(
      String(exact?.hookSpecificOutput?.updatedMCPToolOutput || "")
    ),
    changed_large_evidence_not_replay: !/tool replay/i.test(
      String(changed?.hookSpecificOutput?.updatedMCPToolOutput || "")
    ),
    uncapsuled_small_evidence_not_replay: !/tool replay/i.test(
      String(smallAgain?.hookSpecificOutput?.updatedMCPToolOutput || "")
    ),
  };
}

try {
  const cases = [64 * 1024, 256 * 1024, 1024 * 1024].map(runCase);
  const safety = safetyChecks();
  const aTotal = cases.reduce((sum, item) => sum + item.a_baseline_post_compaction_chars, 0);
  const bTotal = cases.reduce((sum, item) => sum + item.b_capsule_dictionary_chars, 0);
  const output = {
    method: {
      scope: "Model-visible characters when identical large read-only evidence is requested after compaction.",
      arm_a: "v0.13 behavior: replay state is cleared, then ordinary large-output compaction runs.",
      arm_b: "Compaction-safe exact capsule dictionary plus a bounded replay reference.",
      accounting: "B conservatively includes PreCompact dictionary characters and the post-compaction replay reference.",
      exclusion: "Character exposure is not provider billing, cache behavior, latency, or the hidden compaction model cost.",
    },
    summary: {
      cases: cases.length,
      safety_pass: Object.values(safety).every(Boolean),
      a_total_chars: aTotal,
      b_total_chars: bTotal,
      weighted_saving_percent: Number(((aTotal - bTotal) / aTotal * 100).toFixed(2)),
    },
    safety,
    cases,
  };
  const writeIndex = process.argv.indexOf("--write");
  if (writeIndex >= 0 && process.argv[writeIndex + 1]) {
    fs.writeFileSync(path.resolve(process.argv[writeIndex + 1]), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.summary.safety_pass ||
      cases.some((item) => !item.exact_capsule_reference || !item.marked_after_compaction)) {
    process.exitCode = 1;
  }
} finally {
  unified.closeSearchDatabase();
  fs.rmSync(state, { recursive: true, force: true });
}
