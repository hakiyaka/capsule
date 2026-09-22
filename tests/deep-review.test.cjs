"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-deep-review-"));
process.env.CAPSULE_STATE = path.join(root, "state");
const core = require("../mcp/core.cjs");
const unified = require("../mcp/unified.cjs");
const runtime = require("../mcp/runtime.cjs");
const project = require("../mcp/project.cjs");
const edit = require("../mcp/edit.cjs");
const storage = require("../mcp/storage.cjs");

test.after(() => {
  unified.closeSearchDatabase();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function markerStep(id, marker, extra = {}) {
  return { id, action: "run", payload: { command: process.execPath,
    args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'done')`],
    idempotent: true, refresh: true }, ...extra };
}

test("short failing output retains its exit status on the actual MCP wire", () => {
  const operation = unified.attachArchive({ route: "passthrough", profile: "generic", output: "", raw_chars: 0 },
    "cap_0123456789abcdef", { exit_code: 7 });
  assert.equal(JSON.parse(core.renderOperation(operation)).exit_code, 7);
});

test("execute reports timeout explicitly instead of a successful-looking empty response", async () => {
  const result = await unified.dispatch({ action: "execute", payload: {
    language: "javascript", code: "setInterval(() => {}, 1000)", timeout_ms: 100,
  } });
  const wire = JSON.parse(core.renderOperation(result));
  assert.equal(wire.exit_code, 124);
  assert.equal(wire.timed_out, true);
});

test("invalid execution language cleans the scratch directory", async () => {
  const original = fs.mkdtempSync;
  let scratch;
  fs.mkdtempSync = (...args) => { scratch = original(...args); return scratch; };
  try {
    await assert.rejects(runtime.executeCode({ language: "unsupported-language", code: "" }), /unsupported language/);
    assert.equal(fs.existsSync(scratch), false);
  } finally {
    fs.mkdtempSync = original;
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("batch preserves successful siblings when one executable cannot launch", async () => {
  const operation = await unified.batchCommands({ index_output: false, commands: [
    { command: path.join(root, "missing-executable") },
    { command: process.execPath, args: ["-e", "console.log('sibling completed')"] },
  ] });
  assert.equal(operation.response.results.length, 2);
  assert.equal(operation.response.results[0].exit_code, null);
  assert.match(operation.response.results[0].error, /ENOENT/);
  assert.equal(operation.response.results[1].exit_code, 0);
  assert.match(operation.response.results[1].output, /sibling completed/);
});

test("batch validates every command before starting any of them", async () => {
  const marker = path.join(root, "invalid-batch-marker");
  const command = markerStep("write", marker).payload;
  await assert.rejects(unified.batchCommands({ commands: [command, { command: "node", args: [3] }] }), /args/);
  // Wait beyond the short marker process lifetime to detect work launched before validation.
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(fs.existsSync(marker), false);
});

test("batch applies the shared output byte limit", async () => {
  const operation = await unified.batchCommands({ index_output: false, max_output_bytes: 4096,
    commands: [{ command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(12000))"] }] });
  assert.match(operation.response.results[0].error, /max_output_bytes/);
});

test("flow blocks dependent work after a failed command inside a batch", async () => {
  const marker = path.join(root, "failed-flow-marker");
  await unified.runFlow({ steps: [
    { id: "checks", action: "batch", payload: { index_output: false,
      commands: [{ command: process.execPath, args: ["-e", "process.exit(9)"] }] } },
    markerStep("dependent", marker, { depends_on: ["checks"] }),
  ] });
  assert.equal(fs.existsSync(marker), false);
});

test("flow rejects a cycle before executing unrelated steps", async () => {
  const marker = path.join(root, "cycle-marker");
  await assert.rejects(unified.runFlow({ steps: [
    markerStep("independent", marker),
    { id: "a", action: "stats", depends_on: ["b"] },
    { id: "b", action: "stats", depends_on: ["a"] },
  ] }), /cycle/);
  assert.equal(fs.existsSync(marker), false);
});

test("flow validates condition regex syntax before executing any step", async () => {
  const marker = path.join(root, "regex-marker");
  await assert.rejects(unified.runFlow({ steps: [
    markerStep("first", marker),
    { id: "second", action: "stats", when: { step: "first", field: "output", op: "matches", value: "[" } },
  ] }), /regex|regular expression/i);
  assert.equal(fs.existsSync(marker), false);
});

test("project fast cache notices a same-size edit with unchanged mtime", () => {
  const directory = path.join(root, "project");
  fs.mkdirSync(directory);
  const file = path.join(directory, "sample.cjs");
  fs.writeFileSync(file, "function before() { return 1; }\n");
  const original = fs.statSync;
  let clock = 1000;
  fs.statSync = (target, ...args) => {
    const value = original(target, ...args);
    if (path.resolve(String(target)) === file) {
      value.mtimeMs = 123456;
      value.ctimeMs = clock;
    }
    return value;
  };
  try {
    project.scanProject({ root: directory });
    const replacement = "function after_() { return 2; }\n";
    fs.writeFileSync(file, replacement);
    clock += 1;
    const second = project.scanProject({ root: directory });
    assert.equal(second.response.changed, 1);
    assert.equal(project.loadIndex(directory).files["sample.cjs"].hash,
      crypto.createHash("sha256").update(replacement).digest("hex"));
  } finally { fs.statSync = original; }
});

test("case-sensitive project directories have distinct cache identities", { skip: process.platform === "win32" }, (context) => {
  const upper = path.join(root, "CaseProject");
  const lower = path.join(root, "caseproject");
  fs.mkdirSync(upper);
  fs.mkdirSync(lower, { recursive: true });
  if (fs.statSync(upper).ino === fs.statSync(lower).ino) return context.skip("case-insensitive filesystem");
  fs.writeFileSync(path.join(upper, "a.js"), "const upper = 1;");
  fs.writeFileSync(path.join(lower, "a.js"), "const lower = 2;");
  assert.notEqual(project.scanProject({ root: upper }).response.project_id,
    project.scanProject({ root: lower }).response.project_id);
});

test("atomic state replacements preserve restrictive POSIX modes", { skip: process.platform === "win32" }, () => {
  const file = path.join(root, "private-state");
  fs.writeFileSync(file, "{}", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  storage.writeJsonAtomic(file, { value: 1 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  storage.writeTextAtomic(file, "updated");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("edit refuses invalid UTF-8 without replacing original bytes", () => {
  const file = path.join(root, "invalid-utf8.txt");
  const bytes = Buffer.from([0xff, 0x61]);
  fs.writeFileSync(file, bytes);
  assert.throws(() => edit.edit({ cwd: root, path: file, edits: [["r", "a", "b"]] }), /UTF-8/);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test("edit persists its recovery manifest before changing targets", () => {
  const file = path.join(root, "manifest-failure.txt");
  fs.writeFileSync(file, "before");
  const original = fs.writeFileSync;
  fs.writeFileSync = (target, ...args) => {
    if (String(target).endsWith("transaction.json")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return original(target, ...args);
  };
  try {
    assert.throws(() => edit.edit({ cwd: root, path: file, edits: [["r", "before", "after"]] }), /disk full/);
    assert.equal(fs.readFileSync(file, "utf8"), "before");
  } finally { fs.writeFileSync = original; }
});

test("undo verifies every backup before restoring any target", () => {
  const first = path.join(root, "undo-first.txt");
  const second = path.join(root, "undo-second.txt");
  fs.writeFileSync(first, "before");
  fs.writeFileSync(second, "before");
  const result = edit.edit({ cwd: root, files: [first, second].map(file => ({ path: file, edits: [["r", "before", "after"]] })) });
  const id = result.response.transaction_id;
  fs.writeFileSync(path.join(core.stateRoot(), "edit-transactions", id, "1.before"), "corrupted backup");
  assert.throws(() => edit.edit({ operation: "undo", transaction_id: id, confirm: true }), /backup.*(?:corrupt|hash|integrity)/i);
  assert.equal(fs.readFileSync(first, "utf8"), "after");
  assert.equal(fs.readFileSync(second, "utf8"), "after");
});

test("source lock tolerates a transient Windows deletion race", () => {
  const mkdir = fs.mkdirSync;
  const readdir = fs.readdirSync;
  const lock = path.join(core.stateRoot(), "capsule-sources.lock");
  let contended = false;
  let raced = false;
  fs.mkdirSync = (target, options) => {
    if (String(target) === lock && !contended) {
      contended = true;
      throw Object.assign(new Error("already exists"), { code: "EEXIST" });
    }
    return mkdir(target, options);
  };
  fs.readdirSync = (target, ...args) => {
    if (String(target) === lock && !raced) {
      raced = true;
      throw Object.assign(new Error("delete pending"), { code: "EPERM" });
    }
    return readdir(target, ...args);
  };
  try {
    assert.ok(core.saveCapsule({ kind: "test", source: "deep-review-lock", text: "evidence" }).response.capsule_id);
    assert.equal(raced, true);
  } finally { fs.mkdirSync = mkdir; fs.readdirSync = readdir; }
});

function rpc(messages, env = {}) {
  const child = spawnSync(process.execPath, [path.join(__dirname, "..", "mcp", "server.cjs")], {
    input: messages.map(message => JSON.stringify(message)).join("\n") + "\n",
    encoding: "utf8", timeout: 10000,
    env: { ...process.env, CAPSULE_STATE: fs.mkdtempSync(path.join(root, "rpc-state-")), ...env },
  });
  assert.equal(child.status, 0, child.stderr || String(child.error));
  return child.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

test("MCP negotiates a supported version instead of echoing unknown versions", () => {
  const [result] = rpc([{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01" } }]);
  assert.equal(result.result.protocolVersion, "2025-03-26");
});

test("MCP sends no response to notifications", () => {
  const result = rpc([{ jsonrpc: "2.0", method: "unknown-notification" },
    { jsonrpc: "2.0", method: "ping" }, { jsonrpc: "2.0", id: 0, method: "ping" }]);
  assert.deepEqual(result.map(item => item.id), [0]);
});

test("MCP drains an in-flight asynchronous call after input EOF", () => {
  const result = rpc([{ jsonrpc: "2.0", id: 9, method: "tools/call", params: {
    name: "capsule", arguments: { action: "execute", payload: {
      language: "javascript", code: "setTimeout(() => console.log('completed before shutdown'), 50)",
    } },
  } }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 9);
  assert.equal(result[0].result.isError, false);
  assert.match(result[0].result.content[0].text, /completed before shutdown/);
});

test("MCP rejects malformed request identifiers and scalar params", () => {
  const result = rpc([{ jsonrpc: "2.0", id: {}, method: "ping" },
    { jsonrpc: "2.0", id: 2, method: "ping", params: false }]);
  assert.equal(result[0].id, null);
  assert.equal(result[0].error.code, -32600);
  assert.equal(result[1].id, 2);
  assert.equal(result[1].error.code, -32602);
});

test("MCP bounds oversized frames and resumes at the next complete request", () => {
  const result = rpc([{ jsonrpc: "2.0", id: 1, method: "x".repeat(2048) },
    { jsonrpc: "2.0", id: 2, method: "ping" }], { CAPSULE_MCP_MAX_MESSAGE_BYTES: "1024" });
  assert.equal(result[0].error.code, -32600);
  assert.deepEqual(result[1], { jsonrpc: "2.0", id: 2, result: {} });
});
