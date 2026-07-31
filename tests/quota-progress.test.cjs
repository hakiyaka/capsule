"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-quota-progress-"));
process.env.CAPSULE_STATE = stateRoot;
const progress = require("../mcp/quota-progress.cjs");

function session(label) {
  return label + "-" + process.pid + "-" + Date.now() + "-" + Math.random();
}

test("high-credit no-progress work triggers a compact dominant-component brake", () => {
  const id = session("brake");
  assert.deepEqual(progress.begin({
    session_id: id,
    project: "private-project-name",
    prompt_fingerprint: ["diagnose", "quota", "path"],
    epoch: 4,
  }), { context: "" });
  progress.noteTool({ session_id: id, tool_name: "shell_command", epoch: 4 });
  const receipt = progress.finish({
    session_id: id,
    credit_weighted_delta: 2400,
    reasoning_delta: 1800,
    last: { progress_delta: 0, input_delta: 300 },
    epoch: 4,
    final_message: "A raw final that must never be persisted",
  });
  assert.equal(receipt.expensive, true);
  assert.equal(receipt.low_progress, true);
  assert.equal(receipt.dominant_component, "reasoning");
  const attributed = Object.values(receipt.attribution).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(attributed - 2400) < 0.01);

  const next = progress.begin({
    session_id: id,
    project: "private-project-name",
    prompt_fingerprint: ["try", "another", "path"],
    epoch: 4,
  });
  assert.match(next.context, /quota-progress brake/);
  assert.match(next.context, /dominant=reasoning/);
  assert.equal(next.receipt.policy, "low-progress-brake");
  assert.ok(next.context.length <= 240);
  assert.match(progress.checkpoint(id), /dominant=reasoning/);
  assert.ok(progress.checkpoint(id).length <= 240);
});

test("efficient mutation is neutral and does not install a brake", () => {
  const id = session("mutation");
  progress.begin({
    session_id: id,
    prompt_fingerprint: ["edit", "small", "module"],
    epoch: 1,
  });
  const receipt = progress.finish({
    session_id: id,
    credit_weighted_delta: 120,
    reasoning_delta: 20,
    last: { mutation: true, changed_files: 1 },
    epoch: 1,
    final_message: "done",
  });
  assert.equal(receipt.progress_score, 0.8);
  assert.equal(receipt.low_progress, false);
  const next = progress.begin({
    session_id: id,
    prompt_fingerprint: ["test", "small", "module"],
    epoch: 1,
  });
  assert.equal(next.context, "");
  assert.equal(next.receipt, undefined);
});

test("verified near-repeat creates anti-memory only at an unchanged epoch", () => {
  const id = session("anti-memory");
  progress.begin({
    session_id: id,
    project: "alpha",
    prompt_fingerprint: ["auth", "handler", "regression"],
    epoch: 7,
  });
  progress.finish({
    session_id: id,
    credit_weighted_delta: 300,
    reasoning_delta: 80,
    last: { verified: true },
    epoch: 7,
    final_message: "verified details remain private",
  });
  const repeated = progress.begin({
    session_id: id,
    project: "alpha",
    prompt_fingerprint: ["auth", "handler", "regression", "again"],
    epoch: 7,
  });
  assert.match(repeated.context, /Capsule anti-memory/);
  assert.match(repeated.context, /near repeat already verified/);
  assert.equal(repeated.receipt.repeat, "near");
  assert.equal(progress.tombstones(id).length, 1);

  const changedEpoch = progress.begin({
    session_id: id,
    project: "alpha",
    prompt_fingerprint: ["auth", "handler", "regression"],
    epoch: 8,
  });
  assert.equal(changedEpoch.context, "");
});

test("explicit detail bypasses an otherwise applicable policy", () => {
  const id = session("detail");
  progress.begin({ session_id: id, prompt_fingerprint: ["investigate"], epoch: 2 });
  progress.finish({
    session_id: id,
    credit_weighted_delta: 2000,
    reasoning_delta: 1500,
    last: { progress_delta: 0 },
    epoch: 2,
    final_message: "no progress",
  });
  const detailed = progress.begin({
    session_id: id,
    prompt_fingerprint: ["another", "investigation"],
    epoch: 2,
    explicit_detail: true,
  });
  assert.deepEqual(detailed, { context: "" });
});

test("state stores hashes rather than raw prompts, projects, tool names, or finals", () => {
  const id = session("privacy");
  const secrets = [
    "raw-prompt-secret-87423",
    "raw-project-secret-91582",
    "raw-final-secret-65491",
    "raw-tool-secret-72531",
  ];
  progress.begin({
    session_id: id,
    project: secrets[1],
    prompt_fingerprint: [secrets[0]],
    epoch: 3,
  });
  progress.noteTool({ session_id: id, tool_name: secrets[3], epoch: 3 });
  const receipt = progress.finish({
    session_id: id,
    credit_weighted_delta: 90,
    reasoning_delta: 10,
    last: { resolved: true },
    epoch: 3,
    final_message: secrets[2],
  });
  assert.equal(receipt.final_hash.length, 24);
  const persisted = fs.readdirSync(path.join(stateRoot, "quota-progress"))
    .map((name) => fs.readFileSync(path.join(stateRoot, "quota-progress", name), "utf8"))
    .join("\n");
  for (const secret of secrets) assert.doesNotMatch(persisted, new RegExp(secret));
  assert.doesNotMatch(persisted, new RegExp(id));
});

test("anti-memory tombstones are bounded and status aggregates receipts", () => {
  const id = session("bounded");
  for (let index = 0; index < 40; index += 1) {
    progress.begin({
      session_id: id,
      prompt_fingerprint: ["verified-task-" + index, "proof-" + index],
      epoch: index,
    });
    progress.finish({
      session_id: id,
      credit_weighted_delta: 10,
      reasoning_delta: 2,
      last: { status: index % 3 === 0 ? "verified" : index % 3 === 1 ? "completed" : "resolved" },
      epoch: index,
      final_message: "final-" + index,
    });
  }
  const stones = progress.tombstones(id);
  assert.equal(stones.length, 24);
  assert.ok(stones.every((item) => ["verified", "completed", "resolved"].includes(item.state)));
  const aggregate = progress.status();
  assert.ok(aggregate.sessions >= 1);
  assert.ok(aggregate.turns >= 32);
  assert.ok(aggregate.tombstones >= 24);
  assert.ok(aggregate.credit_weighted_delta > 0);
});
