"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-qpx-hook-"));
process.env.CAPSULE_STATE = root;
const hook = require("../scripts/hook.cjs");
const quotaProgress = require("../mcp/quota-progress.cjs");
const unified = require("../mcp/unified.cjs");

function tokenRecord(total, last, usedPercent) {
  return {
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: total,
        last_token_usage: last,
        model_context_window: 200_000,
      },
      rate_limits: {
        primary: {
          used_percent: usedPercent,
          window_minutes: 300,
          resets_at: 1_900_000_000,
        },
      },
    },
  };
}

function append(file, record) {
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}

test.after(() => {
  unified.closeSearchDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

test("native hook exchanges weighted quota for progress and compacts verified anti-memory", () => {
  const session = `qpx-hook-${process.pid}-${Date.now()}`;
  const file = path.join(root, "session.jsonl");
  const prompt = "Implement the cache fix, run tests, and verify the package.";
  append(file, tokenRecord(
    { input_tokens: 1_000, cached_input_tokens: 400, output_tokens: 40, reasoning_output_tokens: 10, total_tokens: 1_050 },
    { input_tokens: 1_000, cached_input_tokens: 400, output_tokens: 40, reasoning_output_tokens: 10, total_tokens: 1_050 },
    10
  ));
  const common = { session_id: session, cwd: root, session_file: file };
  const first = hook.handle("userpromptsubmit", { ...common, prompt });
  assert.doesNotMatch(first.hookSpecificOutput?.additionalContext || "", /anti-memory/);

  hook.handle("posttooluse", {
    ...common,
    tool_name: "apply_patch",
    tool_input: { patch: "bounded test patch" },
    tool_output: "Success",
  });
  append(file, tokenRecord(
    { input_tokens: 8_000, cached_input_tokens: 5_000, output_tokens: 650, reasoning_output_tokens: 220, total_tokens: 8_870 },
    { input_tokens: 7_000, cached_input_tokens: 4_600, output_tokens: 610, reasoning_output_tokens: 210, total_tokens: 7_820 },
    11
  ));
  hook.handle("stop", {
    ...common,
    last_assistant_message: "Implemented the cache fix. All 12 tests passed; installation verified.",
  });

  const exchange = quotaProgress.status();
  assert.equal(exchange.turns, 1);
  assert.equal(exchange.tombstones, 1);
  assert.ok(exchange.credit_weighted_delta > 0);

  const repeat = hook.handle("userpromptsubmit", { ...common, prompt });
  const repeatContext = repeat.hookSpecificOutput?.additionalContext || "";
  assert.match(repeatContext, /Capsule anti-memory/);
  assert.match(repeatContext, /receipt=/);

  const compact = hook.handle("precompact", common);
  const compactContext = compact.hookSpecificOutput?.additionalContext || "";
  assert.match(compactContext, /T:/);
  assert.match(compactContext, /¬verified@/);

  const persisted = fs.readdirSync(path.join(root, "quota-progress"))
    .map((name) => fs.readFileSync(path.join(root, "quota-progress", name), "utf8"))
    .join("\n");
  assert.doesNotMatch(persisted, /Implemented the cache fix/);
});
