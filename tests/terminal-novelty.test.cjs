"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const core = require("../mcp/core.cjs");
const novelty = require("../mcp/terminal-novelty.cjs");

function save(text, source) {
  return core.saveCapsule({ kind: "terminal-novelty-test", source, text, maxChars: 1_200 }).response.capsule_id;
}

test("terminal novelty covers changed failing-test output and keeps exact recovery", () => {
  const session = `terminal-failure-${process.pid}-${Date.now()}`;
  const stable = Array.from({ length: 180 }, (_, index) => `spec ${index}: passed in ${index + 10}ms`);
  const before = `# stdout\n${stable.join("\n")}\nFAIL auth: expected 200 got 500\n# stderr\n`;
  const after = `# stdout\n${stable.join("\n")}\nFAIL auth: expected 200 got 401\n# stderr\n`;
  const first = novelty.terminalNovelty({
    session_id: session, cwd: process.cwd(), command: "npm test",
    text: before, capsule_id: save(before, "npm test"), baseline_output: before,
  });
  assert.equal(first, null);
  const afterId = save(after, "npm test");
  const second = novelty.terminalNovelty({
    session_id: session, cwd: process.cwd(), command: "npm test",
    text: after, capsule_id: afterId, baseline_output: after,
  });
  assert.match(second.output, /Capsule terminal novelty test/);
  assert.match(second.output, /got 401/);
  assert.doesNotMatch(second.output, /spec 100/);
  assert.equal(core.loadCapsule(afterId).text, after);
  assert.ok(second.output.length < after.length * 0.15);
});

test("terminal novelty is task-isolated and limited to frequent command families", () => {
  const nonce = `${process.pid}-${Date.now()}-${Math.random()}`;
  const taskOne = `task-one-${nonce}`;
  const taskTwo = `task-two-${nonce}`;
  const text = `${Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n")}\n`;
  const firstId = save(text, "npm test");
  novelty.terminalNovelty({
    session_id: taskOne, cwd: process.cwd(), command: "npm test",
    text, capsule_id: firstId, baseline_output: text,
  });
  assert.equal(novelty.terminalNovelty({
    session_id: taskTwo, cwd: process.cwd(), command: "npm test",
    text, capsule_id: save(text, "npm test"), baseline_output: text,
  }), null);
  assert.equal(novelty.terminalNovelty({
    session_id: taskOne, cwd: process.cwd(), command: "Write-Output hello",
    text, capsule_id: save(text, "other"), baseline_output: text,
  }), null);
});
