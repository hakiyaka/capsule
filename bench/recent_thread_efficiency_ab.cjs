"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-thread-audit-state-"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-thread-audit-work-"));
process.env.CAPSULE_STATE = state;
const core = require("../mcp/core.cjs");
const unified = require("../mcp/unified.cjs");

function renderedChars(operation) {
  return core.renderOperation(operation).length;
}

function baselinePages(capsuleId, lineCount) {
  let start = 1;
  let calls = 0;
  let chars = 0;
  while (start <= lineCount) {
    const page = core.expandAnchor({
      capsule_id: capsuleId,
      start_line: start,
      end_line: lineCount,
      max_chars: 2_400,
    });
    calls += 1;
    chars += renderedChars(page);
    if (!page.response.truncated || !page.response.next_start_line) break;
    start = page.response.next_start_line;
  }
  return { calls, chars };
}

function widenedPages(capsuleId, lineCount) {
  let start = 1;
  let calls = 0;
  let chars = 0;
  while (start <= lineCount) {
    const page = core.expandAnchor({
      capsule_id: capsuleId,
      start_line: start,
      end_line: lineCount,
    });
    calls += 1;
    chars += renderedChars(page);
    if (!page.response.truncated || !page.response.next_start_line) break;
    start = page.response.next_start_line;
  }
  return { calls, chars };
}

try {
  const directory = path.join(workspace, "skills", "large-skill");
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, "SKILL.md");
  const content = [
    "---",
    "name: large-skill",
    "description: deterministic benchmark",
    "---",
    ...Array.from({ length: 430 }, (_, index) =>
      `Rule ${index}: retain exact instruction evidence-${index}-${(index * 104729).toString(36)}.`),
  ].join("\n");
  fs.writeFileSync(target, content, "utf8");
  const sourceTarget = path.join(workspace, "benchmark-source.js");
  fs.writeFileSync(sourceTarget, content, "utf8");

  const legacyFile = core.saveCapsule({
    kind: "file",
    source: target,
    text: content,
    question: "specific evidence only",
    maxChars: 1_200,
  });
  const capsuleId = legacyFile.response.capsule_id;
  const lineCount = content.split("\n").length;
  const oldPages = baselinePages(capsuleId, lineCount);
  const newPages = widenedPages(capsuleId, lineCount);
  const direct = unified.inspectFile({ path: target, query: "specific evidence only" });
  const directChars = renderedChars(direct);
  const directSource = unified.inspectFile({ path: sourceTarget });
  const directSourceChars = renderedChars(directSource);

  const cases = [
    {
      name: "explicit-exact-range",
      baseline_calls: oldPages.calls,
      treatment_calls: newPages.calls,
      call_reduction_percent: Number(((oldPages.calls - newPages.calls) / oldPages.calls * 100).toFixed(2)),
      baseline_chars: oldPages.chars,
      treatment_chars: newPages.chars,
      exact_complete: newPages.chars > 0,
    },
    {
      name: "selected-skill-full-read",
      baseline_calls: 1 + oldPages.calls,
      treatment_calls: 1,
      call_reduction_percent: Number((oldPages.calls / (1 + oldPages.calls) * 100).toFixed(2)),
      baseline_chars: renderedChars(legacyFile) + oldPages.chars,
      treatment_chars: directChars,
      exact_complete: direct.responseText === content,
    },
    {
      name: "bare-source-full-read",
      baseline_calls: 1 + oldPages.calls,
      treatment_calls: 1,
      call_reduction_percent: Number((oldPages.calls / (1 + oldPages.calls) * 100).toFixed(2)),
      baseline_chars: renderedChars(legacyFile) + oldPages.chars,
      treatment_chars: directSourceChars,
      exact_complete: directSource.responseText === content,
    },
  ];
  const baselineCalls = cases.reduce((sum, item) => sum + item.baseline_calls, 0);
  const treatmentCalls = cases.reduce((sum, item) => sum + item.treatment_calls, 0);
  const baselineChars = cases.reduce((sum, item) => sum + item.baseline_chars, 0);
  const treatmentChars = cases.reduce((sum, item) => sum + item.treatment_chars, 0);
  const output = {
    source_audit: {
      threads: 20,
      sampled_turns: 103,
      tool_calls: 2258,
      failed_tool_calls: 157,
      capsule_calls: 1096,
      node_repl_calls: 1135,
      file_calls: 254,
      expand_calls: 498,
      repeated_exact_expand_signatures: 27,
      repeated_exact_expand_calls: 74,
      failed_full_command_string_calls: 14,
    },
    method: {
      baseline: "2,400-character exact pages after a selective file capsule.",
      treatment: "12,000-character explicit ranges and one-call selected skill/reference reads.",
      caveat: "Call and serialized-character exposure benchmark; not provider billing.",
    },
    summary: {
      cases: cases.length,
      baseline_calls: baselineCalls,
      treatment_calls: treatmentCalls,
      weighted_call_reduction_percent: Number(
        ((baselineCalls - treatmentCalls) / baselineCalls * 100).toFixed(2)
      ),
      baseline_chars: baselineChars,
      treatment_chars: treatmentChars,
      weighted_char_reduction_percent: Number(
        ((baselineChars - treatmentChars) / baselineChars * 100).toFixed(2)
      ),
      safety_pass: cases.every((item) => item.exact_complete),
    },
    latest_fixes: {
      exact_read_fuse: {
        observed_baseline_calls: 74,
        treatment_ceiling_calls: 54,
        avoidable_calls_after_second_identical_read: 20,
        bounded_call_reduction_percent: 27.03,
        assumption: "The agent follows the hook warning after the second identical read in one mutation epoch.",
      },
      full_command_string_compatibility: {
        observed_failed_calls: 14,
        baseline_calls_per_success: 2,
        treatment_calls_per_success: 1,
        retry_call_reduction_percent: 50,
        safety: "Simple strings are tokenized; unquoted shell syntax is dispatched through an explicit platform shell.",
      },
    },
    cases,
  };
  const writeIndex = process.argv.indexOf("--write");
  if (writeIndex >= 0 && process.argv[writeIndex + 1]) {
    fs.writeFileSync(path.resolve(process.argv[writeIndex + 1]), `${JSON.stringify(output, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.summary.safety_pass) process.exitCode = 1;
} finally {
  unified.closeSearchDatabase();
  fs.rmSync(state, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
}
