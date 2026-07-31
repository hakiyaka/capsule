"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const residual = require("../mcp/reasoning-residual.cjs");

function capsule(source) {
  return `cap_test_${source}_${process.pid}_${Date.now()}`;
}

function noisy(fault) {
  const passed = Array.from({ length: 180 }, (_, index) =>
    `spec ${index}: passed (${20 + index}ms)`
  ).join("\n");
  return `# stdout\n${passed}\nFAIL auth.test.ts: ${fault}\nTests: 1 failed, 180 passed\n# stderr\n`;
}

test("reasoning residual carries causal validation state across edit epochs", () => {
  const session = `reasoning-residual-${process.pid}-${Date.now()}-${Math.random()}`;
  const firstText = noisy("expected 200 received 500");
  const first = residual.reasoningResidual({
    session_id: session,
    cwd: process.cwd(),
    command: "npm test",
    text: firstText,
    capsule_id: capsule("first"),
    baseline_output: firstText,
    execution_epoch: 0,
    exit_code: 1,
  });
  assert.equal(first, null);

  const sameText = noisy("expected 200 received 500");
  const sameId = capsule("same");
  const same = residual.reasoningResidual({
    session_id: session,
    cwd: process.cwd(),
    command: "npm test",
    text: sameText,
    capsule_id: sameId,
    baseline_output: sameText,
    execution_epoch: 1,
    exit_code: 1,
  });
  assert.equal(same.status, "persistent-failure");
  assert.match(same.output, /Capsule fixpoint test/);
  assert.match(same.output, /last-edit-missed-failing-path/);
  assert.match(same.output, new RegExp(sameId));

  const changedText = noisy("expected 200 received 401");
  const changed = residual.reasoningResidual({
    session_id: session,
    cwd: process.cwd(),
    command: "npm test",
    text: changedText,
    capsule_id: capsule("changed"),
    baseline_output: changedText,
    execution_epoch: 2,
    exit_code: 1,
  });
  assert.equal(changed.status, "changed-failure");
  assert.match(changed.output, /continue-new-fault/);
  assert.match(changed.output, /received 401/);

  const passedText = `${Array.from({ length: 180 }, (_, index) => `spec ${index}: passed`).join("\n")}\n181 passed\n`;
  const passId = capsule("pass");
  const passed = residual.reasoningResidual({
    session_id: session,
    cwd: process.cwd(),
    command: "npm test",
    text: passedText,
    capsule_id: passId,
    baseline_output: passedText,
    execution_epoch: 3,
    exit_code: 0,
  });
  assert.equal(passed.status, "resolved");
  assert.match(passed.output, /stop=verified/);
  assert.match(residual.checkpoint(session), /validation=test:pass/);
});

test("reasoning residual ignores unrelated commands and is task-isolated", () => {
  const text = noisy("expected true received false");
  assert.equal(residual.reasoningResidual({
    session_id: `unrelated-${Date.now()}`,
    command: "Write-Output hello",
    text,
    capsule_id: capsule("unrelated"),
    baseline_output: text,
    exit_code: 1,
  }), null);
  assert.equal(residual.checkpoint(`missing-${Date.now()}-${Math.random()}`), "");
});
