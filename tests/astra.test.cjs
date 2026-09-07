"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-astra-"));
process.env.CAPSULE_STATE = path.join(root, "state");
process.env.CODEX_HOME = path.join(root, "codex");
delete process.env.CAPSULE_MODEL;
delete process.env.CAPSULE_MODEL_PROFILE;
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
const profile = require("../mcp/model-profile.cjs");
const core = require("../mcp/core.cjs");
const advisor = require("../mcp/advisor.cjs");
const cognition = require("../mcp/cognition.cjs");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("Astra and unknown models never inherit a different model's API price", () => {
  for (const model of ["gpt-6-astra", "future-model"]) {
    const result = core.estimateInputSavingsUsd(1000000, { model });
    assert.equal(result.model, model);
    assert.equal(result.avoided_input_tokens, 1000000);
    assert.equal(result.estimated_saved_usd, null);
    assert.equal(result.price_usd_per_million, null);
    assert.equal(result.source, null);
  }
  assert.equal(core.estimateInputSavingsUsd(1000000, { model: "gpt-5.6-sol", cached_share: 0 }).estimated_saved_usd, 5);
  assert.equal(core.estimateInputSavingsUsd(10, { model: "GPT-6 Astra" }).model, "gpt-6-astra");
});

test("model selection uses explicit metadata first and refreshes bounded config fallback", () => {
  const file = path.join(process.env.CODEX_HOME, "config.toml");
  fs.writeFileSync(file, 'model = "gpt-6-astra"\nmodel_reasoning_effort = "max"\n[profiles.other]\nmodel = "gpt-5.6-sol"\n');
  const original = fs.readFileSync(file, "utf8");
  assert.equal(profile.resolveModel({}, { config: true }), "gpt-6-astra");
  assert.equal(profile.resolveModel({ model: "gpt-5.6-sol" }, { config: true }), "gpt-5.6-sol");
  assert.equal(profile.resolveModel({ turn_context: { model: "gpt-6-astra" } }), "gpt-6-astra");
  assert.equal(profile.resolveModel({}), "");
  assert.equal(fs.readFileSync(file, "utf8"), original);
  const sessionFile = path.join(root, "session.jsonl");
  fs.writeFileSync(sessionFile, JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }) + "\n");
  assert.equal(profile.resolveModel({ session_file: sessionFile }, { config: true }), "gpt-5.6-sol");
  fs.appendFileSync(sessionFile, JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-astra" } }) + "\n");
  assert.equal(profile.resolveModel({ session_file: sessionFile }), "gpt-6-astra");
  fs.appendFileSync(sessionFile, JSON.stringify({ type: "user", payload: "x".repeat(70000) }) + "\n");
  assert.equal(profile.resolveModel({ session_file: sessionFile }, { config: true }), "");
  fs.writeFileSync(file, '# no top-level model\n[profiles.astra]\nmodel = "gpt-6-astra"\n');
  assert.equal(profile.configuredModel(), "");
  fs.unlinkSync(file);
  assert.equal(profile.configuredModel(), "");
});

test("Astra reduces automatic budgets while explicit detail and tighter limits survive", () => {
  const prompt = "Implement the cache fix and run tests.";
  const baseline = advisor.plan({ prompt, model: "gpt-5.6-sol" }).response;
  const astra = advisor.plan({ prompt, model: "gpt-6-astra" }).response;
  assert.ok(astra.max_output_chars < baseline.max_output_chars);
  assert.equal(astra.max_tool_calls, baseline.max_tool_calls);
  assert.ok(cognition.planEscrow({ prompt, model: "gpt-6-astra" }).response.word_budget <
    cognition.planEscrow({ prompt, model: "gpt-5.6-sol" }).response.word_budget);
  const detailed = "Explain in detail with a comprehensive step-by-step explanation.";
  const before = cognition.planEscrow({ prompt: detailed, model: "gpt-5.6-sol" }).response;
  const after = cognition.planEscrow({ prompt: detailed, model: "gpt-6-astra" }).response;
  assert.equal(before.explicit_detail, true);
  assert.equal(after.word_budget, before.word_budget);
  const policy = { tool_max_chars: 100, tool_passthrough_chars: 50, thread_item_chars: 20 };
  assert.deepEqual(profile.outputPolicy("gpt-6-astra", policy), policy);
  process.env.CAPSULE_MODEL_PROFILE = "0";
  try {
    assert.equal(advisor.plan({ prompt, model: "gpt-6-astra" }).response.max_output_chars, baseline.max_output_chars);
  } finally {
    delete process.env.CAPSULE_MODEL_PROFILE;
  }
});

test("real hook bounds Astra history while the explicit full-output escape remains available", () => {
  function invoke(model, toolInput = {}) {
    const input = {
      hook_event_name: "PreToolUse", model, session_id: `astra-${model}-${Boolean(toolInput.includeOutputs)}`,
      cwd: root, tool_name: "mcp__codex_app__read_thread", tool_input: { threadId: "fixture", ...toolInput },
    };
    return JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "../scripts/hook.cjs"), "PreToolUse"], {
      input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, CAPSULE_HOOKS: "1" }, windowsHide: true,
    }) || "{}");
  }
  const sol = invoke("gpt-5.6-sol").hookSpecificOutput.updatedInput;
  const astra = invoke("gpt-6-astra").hookSpecificOutput.updatedInput;
  assert.ok(astra.maxOutputCharsPerItem < sol.maxOutputCharsPerItem);
  assert.equal(astra.turnLimit, sol.turnLimit);
  assert.equal(invoke("gpt-6-astra", { includeOutputs: true }).hookSpecificOutput?.updatedInput, undefined);
});
