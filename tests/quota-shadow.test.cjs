"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { compileQuotaShadow, promptText } = require("../mcp/quota-shadow.cjs");

test("Semantic Answer Genome compiles repeat/status work to a delta ABI", () => {
  const plan = compileQuotaShadow("I restarted; is it active now and how much savings are there?", {
    allocated_output_tokens: 900
  });
  assert.equal(plan.active, true);
  assert.equal(plan.mode, "semantic-delta");
  assert.equal(plan.shadow_output_cap, 220);
  assert.match(plan.context, /zero-delta=1 sentence/i);
});

test("Semantic Answer Genome compiles ordinary action work to semantic IR", () => {
  const plan = compileQuotaShadow("Research current complaints, implement a safe fix, test it, and report evidence.", {
    allocated_output_tokens: 1200
  });
  assert.equal(plan.active, true);
  assert.equal(plan.mode, "semantic-ir");
  assert.equal(plan.shadow_output_cap, 620);
  assert.ok(plan.max_new_facts >= 7);
});

test("explicit detail is preserved instead of forcibly compressed", () => {
  const plan = compileQuotaShadow("Give me a complete line-by-line exhaustive report.");
  assert.equal(plan.active, false);
  assert.equal(plan.reason, "explicit_detail_preserved");
});

test("object-shaped prompts are normalized deterministically", () => {
  assert.equal(promptText({ userPrompt: "measure this" }), "measure this");
  const a = compileQuotaShadow({ prompt: "Confirm the same active state" });
  const b = compileQuotaShadow("Confirm the same active state");
  assert.equal(a.prompt_hash, b.prompt_hash);
});

test("cognition keeps the escrow planner export after wrapping", () => {
  const cognition = require("../mcp/cognition.cjs");
  assert.equal(typeof cognition.planEscrow, "function");
  const action = cognition.planEscrow({
    prompt: "Implement the fix, run tests, and verify the package.",
    pressure_mode: "normal"
  }).response;
  assert.match(action.context, /Capsule budget v2/);
  assert.ok(action.context.length < 240);
  assert.equal(action.injected_context_tokens, Math.ceil(action.context.length / 4));
  assert.equal(
    action.predicted_net_tokens_avoided,
    action.predicted_output_tokens_without_escrow
      - action.allocated_output_tokens
      - action.injected_context_tokens
  );

  const detailed = cognition.planEscrow({
    prompt: "Write an exhaustive line-by-line implementation report with full detail.",
    pressure_mode: "normal"
  }).response;
  assert.doesNotMatch(detailed.context, /Capsule budget v2/);
});
