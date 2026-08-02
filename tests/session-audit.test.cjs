"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { scanHistory, valueMeasure } = require("../mcp/session-audit.cjs");
const { insight } = require("../mcp/unified.cjs");

function writeJsonLines(file, records, tail = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    records.map((record) => JSON.stringify(record)).join("\n") + (tail ? "\n" + tail : "\n"),
    "utf8"
  );
}

test("deep session audit scans every line without returning transcript text", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-session-audit-"));
  const repeated = "REPEATED-TOOL-EVIDENCE-DO-NOT-RETURN";
  const records = [
    {
      type: "session_meta",
      payload: { id: "root", parent_thread_id: "", source: "cli" },
    },
    {
      type: "response_item",
      payload: { type: "function_call", name: "read_file", arguments: "{\"path\":\"a.txt\"}" },
    },
    {
      type: "response_item",
      payload: { type: "function_call_output", output: repeated },
    },
    {
      type: "response_item",
      payload: { type: "function_call", name: "read_file", arguments: "{\"path\":\"a.txt\"}" },
    },
    {
      type: "response_item",
      payload: { type: "function_call_output", output: repeated },
    },
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 120,
            cached_input_tokens: 80,
            output_tokens: 40,
            reasoning_output_tokens: 10,
            total_tokens: 160,
          },
          model_context_window: 200_000,
        },
      },
    },
    {
      type: "event_msg",
      payload: { type: "mcp_tool_call_end", isError: true, result: "ERROR timeout" },
    },
    {
      type: "event_msg",
      payload: { type: "mcp_tool_call_end", result: { Err: { message: "failed" } } },
    },
    {
      type: "compacted",
      payload: { replacement_history: [{ role: "user", content: "checkpoint" }] },
    },
    {
      type: "event_msg",
      payload: { type: "context_compacted" },
    },
  ];
  writeJsonLines(
    path.join(home, "sessions", "2026", "08", "root.jsonl"),
    records,
    "{\"broken\":"
  );
  writeJsonLines(path.join(home, "archived_sessions", "child.jsonl"), [
    {
      type: "session_meta",
      payload: { id: "child", parent_thread_id: "root", source: { kind: "subagent" } },
    },
    { type: "response_item", payload: { type: "message", role: "assistant", content: "safe" } },
  ]);

  try {
    const result = scanHistory({ codex_home: home });
    assert.equal(result.mode, "deep-line-scan");
    assert.equal(result.line_scan.every_line, true);
    assert.equal(result.line_scan.complete, true);
    assert.equal(result.sessions.total, 2);
    assert.equal(result.sessions.root, 1);
    assert.equal(result.sessions.subagent, 1);
    assert.equal(result.records.invalid, 1);
    assert.equal(result.records.partial_final, 1);
    assert.equal(result.repeats.repeated_calls, 1);
    assert.equal(result.repeats.duplicate_tool_outputs, 1);
    assert.equal(result.token_usage.input_tokens, 120);
    assert.equal(result.errors.mcp_failures, 2);
    assert.equal(result.compaction.events, 1);
    assert.equal(result.compaction.compacted_records, 1);
    assert.equal(result.compaction.context_markers, 1);
    assert.equal(result.hotspots.parent_fanout[0].children, 1);
    assert.ok(result.recommendations.some((item) => item.code === "exact-output-replay"));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(repeated));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("deep session audit hashes typed values and does not claim a bounded scan is complete", () => {
  assert.notEqual(
    valueMeasure({ line: 1 }).hash,
    valueMeasure({ line: 2 }).hash,
    "different numeric tool arguments must not become a false repeat"
  );
  assert.notEqual(
    valueMeasure("A".repeat(9_000) + "x").hash,
    valueMeasure("A".repeat(9_000) + "y").hash,
    "large outputs with equal length must still have distinct bounded hashes"
  );
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-session-audit-bound-"));
  try {
    writeJsonLines(path.join(home, "sessions", "one.jsonl"), [
      { type: "session_meta", payload: { id: "one", source: "cli" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: "x" } },
    ]);
    writeJsonLines(path.join(home, "sessions", "two.jsonl"), [
      { type: "session_meta", payload: { id: "two", source: "cli" } },
    ]);
    const result = scanHistory({ codex_home: home, max_bytes: 1 });
    assert.equal(result.line_scan.complete, false);
    assert.ok(result.line_scan.files_scanned < result.line_scan.files_discovered);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("insight exposes the exhaustive audit without changing its compact default", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-session-insight-"));
  try {
    writeJsonLines(path.join(home, "sessions", "one.jsonl"), [
      { type: "session_meta", payload: { id: "one", source: "cli" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: "ok" } },
    ]);
    const result = insight({ history: true, deep: true, codex_home: home });
    assert.equal(result.response.history.mode, "deep-line-scan");
    assert.equal(result.response.history.line_scan.complete, true);
    assert.equal(result.response.history.sessions.total, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
