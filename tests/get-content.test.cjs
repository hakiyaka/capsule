"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const previousState = process.env.CAPSULE_STATE;
const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-get-content-state-"));
process.env.CAPSULE_STATE = state;

const core = require("../mcp/core.cjs");
const getContent = require("../mcp/get-content.cjs");
const unified = require("../mcp/unified.cjs");
const hookCli = require("../scripts/cli.cjs");

test.after(() => {
  unified.closeSearchDatabase();
  if (previousState == null) delete process.env.CAPSULE_STATE;
  else process.env.CAPSULE_STATE = previousState;
  fs.rmSync(state, { recursive: true, force: true });
});

test("Get-Content parser accepts one safe UTF-8 file and rejects semantic escapes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-get-content-parse-"));
  const file = path.join(root, "notes with spaces.txt");
  try {
    const parsed = getContent.parse(`Get-Content -LiteralPath "${file}" -Raw`, root);
    assert.equal(parsed.path, file);
    assert.equal(parsed.raw, true);
    assert.equal(getContent.parse(`Get-Content "${file}" | Select-Object -First 2`, root), null);
    assert.equal(getContent.parse("Get-Content *.txt", root), null);
    assert.equal(getContent.parse("Get-Content -Wait notes.txt", root), null);
    assert.equal(getContent.parse("Get-Content $env:NOTE", root), null);
    assert.equal(getContent.parse("Get-Content -Encoding Unicode notes.txt", root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Get-Content fast path saves large reads, replays unchanged files, and preserves exact recovery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-get-content-fast-"));
  const file = path.join(root, "stable.txt");
  const lines = Array.from({ length: 900 }, (_, index) => `routine source line ${index + 1} remains stable`);
  lines[611] = "ERROR GET-CONTENT-NEEDLE exact evidence";
  const text = `${lines.join("\n")}\n`;
  fs.writeFileSync(file, text, "utf8");
  try {
    const first = getContent.fastPath({
      command: `Get-Content -LiteralPath "${file}"`,
      cwd: root,
      query: "GET-CONTENT-NEEDLE",
      max_chars: 1_200,
    });
    assert.ok(first);
    assert.equal(first.profile, "get-content");
    assert.match(first.output, /GET-CONTENT-NEEDLE/);
    assert.match(first.output, /exact=cap_[a-f0-9]{16}/);
    assert.equal(core.loadCapsule(first.capsule_id).text, text);
    assert.ok(first.output.length < text.length * 0.2);

    const second = getContent.fastPath({
      command: `Get-Content "${file}"`,
      cwd: root,
      query: "GET-CONTENT-NEEDLE",
      max_chars: 1_200,
    });
    assert.equal(second.operation.route, "file-replay");
    assert.ok(second.output.length < first.output.length);

    fs.appendFileSync(file, "\nchanged after verified Get-Content replay", "utf8");
    const changed = getContent.fastPath({
      command: `gc "${file}"`,
      cwd: root,
      query: "GET-CONTENT-NEEDLE",
      max_chars: 1_200,
    });
    assert.notEqual(changed.operation.route, "file-replay");

    const direct = unified.runCommand({
      command: `Get-Content "${file}"`,
      cwd: root,
      query: "GET-CONTENT-NEEDLE",
      max_chars: 1_200,
    });
    assert.equal(direct.response.fast_path, "get-content-native-file-read");
    assert.equal(direct.response.exit_code, 0);

    let executed = false;
    const wrapped = await hookCli.runPayload({
      command: `Get-Content "${file}"`,
      cwd: root,
      query: "GET-CONTENT-NEEDLE",
      max_chars: 1_200,
      session_id: "get-content-fast-test",
    }, async () => {
      executed = true;
      return { exit_code: 99, signal: null, stdout: "shell should not run", stderr: "" };
    });
    assert.equal(executed, false);
    assert.match(wrapped.output, /GET-CONTENT-NEEDLE|replay/);
    assert.equal(wrapped.exit_code, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("small Get-Content fast path never grows the literal output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-get-content-small-"));
  const file = path.join(root, "small.txt");
  const text = "alpha\nbeta\n";
  fs.writeFileSync(file, text, "utf8");
  try {
    const result = getContent.fastPath({ command: `Get-Content "${file}"`, cwd: root });
    assert.equal(result.operation.route, "passthrough");
    assert.equal(result.output, text);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Get-Content native selection is monotonic against the generic projector", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-get-content-monotonic-"));
  const file = path.join(root, "repetitive.txt");
  const text = `${Array.from({ length: 220 }, (_, index) => `stable repeated record ${index + 1} with routine context`).join("\n")}\n`;
  const common = { command: `Get-Content "${file}"`, cwd: root, max_chars: 1_200, passthrough_chars: 600 };
  fs.writeFileSync(file, text, "utf8");
  try {
    const generic = unified.compressText(`# stdout\n${text}\n# stderr\n`, common);
    const native = getContent.fastPath(common);
    assert.ok(!native || native.output.length <= generic.output.length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
