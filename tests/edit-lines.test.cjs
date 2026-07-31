"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const core = require("../mcp/core.cjs");
const edit = require("../mcp/edit.cjs");

function sha(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fixture(text, name = "sample.txt") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-edit-lines-"));
  const target = path.join(directory, name);
  const bytes = Buffer.from(text, "utf8");
  fs.writeFileSync(target, bytes);
  const capsule = core.saveCapsule({ kind: "file", source: target, text, maxChars: 200 });
  const capsuleId = capsule.response.capsule_id;
  assert.equal(core.loadCapsule(capsuleId).metadata.sha256, sha(bytes));
  return { directory, target, capsuleId };
}

function remove(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

test("line edits use a baseline capsule without repeating old text and apply immutable ranges", () => {
  const item = fixture("one\ntwo\nthree\nfour\n");
  try {
    edit.edit({ path: item.target, root: item.directory, baseline_capsule_id: item.capsuleId, edits: [
      ["l", 4, 4, "FOUR"],
      { op: "lines", start_line: 2, end_line: 2, text: "TWO" },
    ] });
    assert.equal(fs.readFileSync(item.target, "utf8"), "one\nTWO\nthree\nFOUR\n");
  } finally { remove(item.directory); }
});

test("stale, wrong-file, overlap, and mixed line operations fail before writing", () => {
  const item = fixture("one\ntwo\nthree\n");
  const other = fixture("different\ncontent\n", "other.txt");
  const original = fs.readFileSync(item.target, "utf8");
  try {
    fs.appendFileSync(item.target, "changed\n");
    assert.throws(() => edit.edit({ path: item.target, root: item.directory, baseline_capsule_id: item.capsuleId, edits: [["l", 1, 1, "ONE"]] }), /stale/);
    fs.writeFileSync(item.target, original);
    assert.throws(() => edit.edit({ path: item.target, root: item.directory, baseline_capsule_id: other.capsuleId, edits: [["l", 1, 1, "ONE"]] }), /source does not match/);
    assert.throws(() => edit.edit({ path: item.target, root: item.directory, baseline_capsule_id: item.capsuleId, edits: [["l", 1, 2, "A"], ["l", 2, 3, "B"]] }), /overlap/);
    assert.throws(() => edit.edit({ path: item.target, root: item.directory, baseline_capsule_id: item.capsuleId, edits: [["l", 1, 1, "A"], ["r", "two", "B"]] }), /cannot mix/);
    assert.equal(fs.readFileSync(item.target, "utf8"), original);
  } finally {
    remove(item.directory);
    remove(other.directory);
  }
});

test("line edits preserve BOM and CRLF bytes", () => {
  const item = fixture("\uFEFFone\r\ntwo\r\n");
  try {
    edit.edit({ path: item.target, root: item.directory, expected_capsule_id: item.capsuleId, edits: [["l", 2, 2, "TWO"]] });
    assert.deepEqual(fs.readFileSync(item.target), Buffer.from("\uFEFFone\r\nTWO\r\n", "utf8"));
  } finally { remove(item.directory); }
});

test("line payload is materially smaller than a legacy replacement for a large function", () => {
  const body = Array.from({ length: 180 }, (_, index) => `  const value${index} = compute(${index});`).join("\n");
  const legacy = JSON.stringify({ ops: [["r", body, body.replace("value90", "result90")]] }).length;
  const lines = JSON.stringify({ baseline_capsule_id: "cap_0123456789abcdef", ops: [["l", 91, 91, "  const result90 = compute(90);"]] }).length;
  assert.ok(lines < legacy * 0.6, `expected >40% saving, got ${lines}/${legacy}`);
});


test("edit containment follows directory symlinks and junctions before authorizing a target", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-edit-root-escape-"));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  const alias = path.join(root, "alias");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  const victim = path.join(outside, "victim.txt");
  fs.writeFileSync(victim, "outside\n", "utf8");
  try {
    try {
      fs.symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip(`symlink/junction creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(() => edit.edit({
      operation: "preview",
      root,
      path: path.join(alias, "victim.txt"),
      edits: [["r", "outside", "changed"]],
    }), /resolves outside root/);
    assert.equal(fs.readFileSync(victim, "utf8"), "outside\n");
  } finally {
    remove(base);
  }
});

test("verification cwd containment follows directory symlinks and junctions", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-verify-root-escape-"));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  const alias = path.join(root, "alias");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  try {
    try {
      fs.symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip(`symlink/junction creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(() => edit.verificationSpecs({
      verify: [{ command: process.execPath, profile: "test", cwd: alias }],
    }, root), /verification cwd resolves outside root/);
  } finally {
    remove(base);
  }
});

test("duplicate canonical edit targets are rejected before writes and preserve undo safety", () => {
  const item = fixture("one\ntwo\n");
  try {
    assert.throws(() => edit.edit({
      operation: "preview",
      root: item.directory,
      files: [
        { path: item.target, edits: [["r", "one", "ONE"]] },
        { path: item.target, edits: [["r", "two", "TWO"]] },
      ],
    }), /duplicate canonical edit target/);
    assert.equal(fs.readFileSync(item.target, "utf8"), "one\ntwo\n");
  } finally {
    remove(item.directory);
  }
});
