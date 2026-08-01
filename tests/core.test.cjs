"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-state-"));
process.env.CAPSULE_STATE = state;
const core = require("../mcp/core.cjs");

test.after(() => {
  fs.rmSync(state, { recursive: true, force: true });
});

test("survey_file returns exact ranked evidence and immutable expansion", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-work-"));
  const file = path.join(workspace, "large.log");
  const lines = Array.from({ length: 500 }, (_, index) => `routine line ${index + 1}`);
  lines[311] = "FATAL capsule needle: database timeout";
  fs.writeFileSync(file, lines.join("\n"), "utf8");

  const first = core.surveyFile({ path: file, question: "capsule timeout", max_chars: 2400 });
  assert.match(first.response.capsule_id, /^cap_[a-f0-9]{16}$/);
  assert.equal(first.response.coverage, 1);
  assert.match(JSON.stringify(first.response.evidence_islands), /FATAL capsule needle/);
  assert.ok(core.approxTokens(first.capturedChars) > 1000);

  const anchor = first.response.evidence_islands.find((entry) => /capsule/.test(entry.excerpt));
  const expanded = core.expandAnchor({
    capsule_id: first.response.capsule_id,
    anchor_id: anchor.anchor_id,
    max_chars: 4000,
  });
  assert.match(expanded.response.excerpt, /312 \| FATAL capsule needle: database timeout/);

  lines[312] = "ERROR new differential signal";
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  const second = core.surveyFile({ path: file, question: "differential signal", max_chars: 2400 });
  assert.equal(second.response.previous_capsule_id, first.response.capsule_id);
  assert.equal(second.response.changed_region.identical, false);

  const diff = core.diffCapsules({
    before_id: first.response.capsule_id,
    after_id: second.response.capsule_id,
    max_chars: 3000,
  });
  assert.match(diff.response.after.excerpt, /ERROR new differential signal/);

  fs.rmSync(workspace, { recursive: true, force: true });
});

test("expand keeps explicit small pages but widens an exact requested range", () => {
  const text = Array.from(
    { length: 500 },
    (_, index) => `progressive evidence line ${index + 1} ${"x".repeat(40)}`
  ).join("\n");
  const saved = core.saveCapsule({
    kind: "progressive-test",
    source: "fixture",
    text,
    maxChars: 1200,
  });
  const paged = core.expandAnchor({
    capsule_id: saved.response.capsule_id,
    start_line: 1,
    end_line: 500,
    max_chars: 2400,
  });
  assert.equal(paged.response.truncated, true);
  assert.ok(paged.response.excerpt.length <= 2_400);
  assert.ok(paged.response.next_start_line > 1);
  assert.equal(paged.response.next_end_line, 500);
  assert.match(paged.response.excerpt, /^ {0,2}1 \| progressive evidence line 1/m);

  const widened = core.expandAnchor({
    capsule_id: saved.response.capsule_id,
    start_line: 1,
    end_line: 500,
  });
  assert.ok(widened.response.excerpt.length > paged.response.excerpt.length * 3);
  assert.ok(widened.response.excerpt.length <= 12_000);
  assert.ok(widened.response.next_start_line > paged.response.next_start_line);
});

test("survey_command executes without a shell and archives both streams", () => {
  const capture = core.surveyCommand({
    command: process.execPath,
    args: ["-e", "console.log('out needle'); console.error('warning needle')"],
    question: "needle warning",
    max_chars: 2400,
  });
  assert.equal(capture.response.execution.exit_code, 0);
  assert.match(JSON.stringify(capture.response.evidence_islands), /out needle/);
  assert.match(JSON.stringify(capture.response.evidence_islands), /warning needle/);
});

test("survey_command accepts a quoted executable command string without a failed retry", () => {
  const capture = core.surveyCommand({
    command: `"${process.execPath}" -e "console.log('command string compatibility')"`,
    max_chars: 2400,
  });
  const archived = core.loadCapsule(capture.response.capsule_id);
  assert.equal(capture.response.execution.exit_code, 0);
  assert.equal(archived.metadata.details.command, process.execPath);
  assert.deepEqual(archived.metadata.details.args, ["-e", "console.log('command string compatibility')"]);
  assert.equal(archived.metadata.details.command_string_compat, true);
  assert.match(archived.text, /command string compatibility/);
});

test("survey_command dispatches an intentional shell command string explicitly", () => {
  const command = process.platform === "win32"
    ? "Write-Output 'shell string compatibility'; Write-Output done"
    : "printf '%s\\n' 'shell string compatibility'; printf '%s\\n' done";
  const capture = core.surveyCommand({ command, max_chars: 2400 });
  const archived = core.loadCapsule(capture.response.capsule_id);
  assert.equal(capture.response.execution.exit_code, 0);
  assert.equal(archived.metadata.details.command_string_compat, true);
  assert.equal(archived.metadata.details.command_string_shell, true);
  assert.match(archived.text, /shell string compatibility/);
  assert.match(archived.text, /done/);
});

test("survey_command rejects incomplete spawn captures", () => {
  assert.throws(
    () => core.surveyCommand({ command: `definitely-missing-${Date.now()}` }),
    /complete archive/
  );
});

test("smart_file passes small and full-required content through byte-for-byte", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-smart-small-"));
  const file = path.join(workspace, "small.txt");
  const text = "alpha\nbeta\n";
  fs.writeFileSync(file, text, "utf8");

  const automatic = core.smartFile({ path: file, question: "alpha" });
  assert.equal(automatic.route, "passthrough");
  assert.equal(core.renderOperation(automatic), text);

  const unique = Array.from({ length: 100 }, (_, index) => `unique whole file line ${index}\n`).join("");
  fs.writeFileSync(file, unique, "utf8");
  const complete = core.smartFile({ path: file, mode: "full", question: "rewrite everything" });
  assert.equal(complete.route, "passthrough");
  assert.equal(core.renderOperation(complete), unique);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("smart_file uses a reversible lossless dictionary for repetitive full content", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-lossless-"));
  const file = path.join(workspace, "repeated.txt");
  const text = `${"repeat this exact line\n".repeat(2000)}tail\n`;
  fs.writeFileSync(file, text, "utf8");
  const operation = core.smartFile({ path: file, mode: "full" });
  assert.equal(operation.route, "lossless");
  assert.equal(core.decodeLineDictionary(core.renderOperation(operation)), text);
  assert.ok(core.renderOperation(operation).length < text.length * 0.1);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("smart_file capsules large evidence and keeps a far-right single-line match visible", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-smart-longline-"));
  const file = path.join(workspace, "minified.json");
  const text = `{"padding":"${"x".repeat(30000)}","target":"NEEDLE-MINIFIED-RIGHT-EDGE"}`;
  fs.writeFileSync(file, text, "utf8");

  const operation = core.smartFile({
    path: file,
    question: "NEEDLE-MINIFIED-RIGHT-EDGE",
    max_chars: 2200,
  });
  const rendered = core.renderOperation(operation);
  assert.equal(operation.route, "capsule");
  assert.match(rendered, /NEEDLE-MINIFIED-RIGHT-EDGE/);
  assert.ok(rendered.length < text.length * 0.2);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("smart_file bypasses low-token-density text when capsule overhead would regress", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-token-gate-"));
  const file = path.join(workspace, "ordinary.txt");
  const marker = "LOW-DENSITY-NEEDLE";
  const text = `${"ordinary prose remains cheap to tokenize ".repeat(45)}${marker}\n`;
  fs.writeFileSync(file, text, "utf8");

  const operation = core.smartFile({
    path: file,
    question: marker,
    passthrough_chars: 1536,
    max_chars: 800,
  });
  assert.equal(operation.route, "passthrough");
  assert.equal(core.renderOperation(operation), text);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("smart_file replays unchanged large reads from a verified content hash", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-file-replay-"));
  const file = path.join(workspace, "stable.log");
  const lines = Array.from({ length: 700 }, (_, index) => `routine source line ${index + 1} remains stable`);
  lines[511] = "FATAL FILE-REPLAY-NEEDLE: exact evidence";
  const text = lines.join("\n");
  fs.writeFileSync(file, text, "utf8");

  const first = core.smartFile({ path: file, question: "FILE-REPLAY-NEEDLE", max_chars: 1_800 });
  assert.equal(first.route, "capsule");
  const second = core.smartFile({ path: file, question: "FILE-REPLAY-NEEDLE", max_chars: 1_800 });
  assert.equal(second.route, "file-replay");
  assert.equal(second.capturedChars, 0);
  assert.match(second.response.capsule_id, /^cap_[a-f0-9]{16}$/);
  assert.ok(core.renderOperation(second).length < core.renderOperation(first).length * 0.2);
  assert.equal(core.loadCapsule(second.response.capsule_id).text, text);

  const refreshed = core.smartFile({
    path: file,
    question: "FILE-REPLAY-NEEDLE",
    max_chars: 1_800,
    force_refresh: true,
  });
  assert.notEqual(refreshed.route, "file-replay");
  fs.appendFileSync(file, "\nchanged after the verified replay", "utf8");
  const changed = core.smartFile({ path: file, question: "FILE-REPLAY-NEEDLE", max_chars: 1_800 });
  assert.notEqual(changed.route, "file-replay");
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("read_file_range returns a bounded exact page and replays it unchanged", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-file-range-"));
  const file = path.join(workspace, "source.txt");
  const text = Array.from({ length: 500 }, (_, index) => `source line ${index + 1}`).join("\n");
  fs.writeFileSync(file, text, "utf8");

  const first = core.readFileRange({ path: file, start_line: 200, end_line: 260 });
  assert.equal(first.route, "file-range");
  assert.match(first.response.excerpt, /200 \| source line 200/);
  assert.match(first.response.excerpt, /260 \| source line 260/);
  assert.doesNotMatch(first.response.excerpt, /1 \| source line 1/);
  assert.match(first.response.exact_capsule_id, /^cap_[a-f0-9]{16}$/);

  const second = core.readFileRange({ path: file, start_line: 200, end_line: 260 });
  assert.equal(second.route, "file-replay");
  assert.equal(second.response.capsule_id, first.response.exact_capsule_id);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("smart_file covers three distant evidence terms", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-three-lines-"));
  const file = path.join(workspace, "distant.log");
  const lines = Array.from({ length: 9000 }, (_, index) => `routine line ${index}`);
  lines[1000] = "ERROR EV-A first failure";
  lines[4500] = "ERROR EV-B second failure";
  lines[8000] = "ERROR EV-C third failure";
  const text = lines.join("\n");
  fs.writeFileSync(file, text, "utf8");

  const operation = core.smartFile({
    path: file,
    question: "EV-A EV-B EV-C",
    max_chars: 1200,
  });
  const rendered = core.renderOperation(operation);
  assert.equal(operation.route, "capsule");
  assert.match(rendered, /EV-A/);
  assert.match(rendered, /EV-B/);
  assert.match(rendered, /EV-C/);
  assert.equal(operation.response.coverage, 1);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("smart_file covers distant terms on one long line without false coverage", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-three-columns-"));
  const file = path.join(workspace, "single-line.txt");
  const text = `${"a".repeat(12000)}ONE-A${"b".repeat(12000)}TWO-B${"c".repeat(12000)}THREE-C`;
  fs.writeFileSync(file, text, "utf8");

  const operation = core.smartFile({
    path: file,
    question: "ONE-A TWO-B THREE-C",
    max_chars: 1200,
  });
  const rendered = core.renderOperation(operation);
  assert.equal(operation.route, "capsule");
  assert.match(rendered, /ONE-A/);
  assert.match(rendered, /TWO-B/);
  assert.match(rendered, /THREE-C/);
  assert.equal(operation.response.coverage, 1);
  assert.deepEqual(operation.response.missing_terms, []);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("smart_file bypasses a low-confidence semantic query instead of hiding evidence", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-low-confidence-"));
  const file = path.join(workspace, "privileges.ini");
  const lines = Array.from({ length: 5000 }, (_, index) => `routine setting ${index}=off`);
  lines[117] = "WARNING unrelated cache pressure";
  lines[2300] = "permit_root_delete = true";
  lines[4117] = "ERROR unrelated telemetry timeout";
  const text = lines.join("\n");
  fs.writeFileSync(file, text, "utf8");

  const operation = core.smartFile({
    path: file,
    question: "Which config enables privileged deletion?",
    max_chars: 800,
  });
  assert.equal(operation.route, "passthrough");
  assert.match(core.renderOperation(operation), /permit_root_delete = true/);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("smart_command passes small output through and capsules large output", () => {
  const small = core.smartCommand({
    command: process.execPath,
    args: ["-e", "console.log('tiny command')"],
    question: "tiny",
  });
  assert.equal(small.route, "passthrough");
  assert.match(core.renderOperation(small), /tiny command/);

  const large = core.smartCommand({
    command: process.execPath,
    args: ["-e", "for(let i=0;i<5000;i++) console.log(i===4321?'FATAL COMMAND NEEDLE':'routine '+i)"],
    question: "FATAL COMMAND NEEDLE",
    max_chars: 2200,
  });
  assert.equal(large.route, "capsule");
  assert.match(core.renderOperation(large), /FATAL COMMAND NEEDLE/);
  assert.ok(core.renderOperation(large).length < large.baselineText.length);
});

test("smart_command reuses a verified result future and invalidates it on workspace change", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-future-"));
  const testFile = path.join(workspace, "sample.test.cjs");
  fs.writeFileSync(
    testFile,
    "const test=require('node:test'); test('future',()=>{for(let i=0;i<2000;i++)console.log('future evidence '+i)});\n",
    "utf8"
  );
  const command = {
    command: process.execPath,
    args: ["--test", "sample.test.cjs"],
    cwd: workspace,
    result_future_ttl_ms: 60000,
    result_future_min_reuse_chars: 0,
  };

  const first = core.smartCommand(command);
  assert.notEqual(first.route, "result-future");
  assert.equal(first.response?.execution?.exit_code ?? first.details?.exit_code, 0);
  const second = core.smartCommand(command);
  assert.equal(
    second.response?.result_future?.profile ?? second.details?.result_future_profile,
    "test"
  );
  assert.ok(
    (second.response?.result_future?.saved_elapsed_ms ?? second.details?.saved_elapsed_ms) >= 0
  );
  assert.ok(core.renderOperation(second).length <= second.baselineText.length);

  fs.appendFileSync(testFile, "// dependency changed\n", "utf8");
  const third = core.smartCommand(command);
  assert.notEqual(third.route, "result-future");
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("result futures never enlarge small model-visible command output", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-future-small-"));
  fs.writeFileSync(
    path.join(workspace, "sample.test.cjs"),
    "require('node:test')('small',()=>{});\n",
    "utf8"
  );
  const command = {
    command: process.execPath,
    args: ["--test", "sample.test.cjs"],
    cwd: workspace,
    result_future_ttl_ms: 60000,
  };
  const first = core.smartCommand(command);
  const second = core.smartCommand(command);
  assert.notEqual(second.route, "result-future");
  assert.ok(core.renderOperation(second).length <= second.baselineText.length);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("result futures classify ten frequent workloop operations", () => {
  const cases = [
    [process.execPath, ["--test", "x.test.cjs"], "test"],
    ["eslint", ["."], "lint"],
    ["tsc", ["--noEmit"], "typecheck"],
    ["cargo", ["check"], "check"],
    ["npm", ["run", "build"], "build"],
    ["prettier", ["--check", "."], "format-check"],
    ["rg", ["needle", "."], "search"],
    ["rg", ["--files"], "file-list"],
    ["git", ["status", "--short"], "git-status"],
    ["git", ["diff", "--stat"], "git-diff"],
  ];
  for (const [command, args, profile] of cases) {
    assert.equal(core.resultFutureCommand({ command, args }).profile, profile);
  }
});

test("changedRegion detects identical and bounded changes", () => {
  assert.equal(core.changedRegion("a\nb", "a\nb").identical, true);
  assert.deepEqual(core.changedRegion("a\nold\nz", "a\nnew\nz"), {
    identical: false,
    before_start_line: 2,
    before_end_line: 2,
    after_start_line: 2,
    after_end_line: 2,
    common_prefix_lines: 1,
    common_suffix_lines: 1,
  });
});

test("repeat capture reports an identical predecessor", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-identical-"));
  const file = path.join(workspace, "same.log");
  fs.writeFileSync(file, `${"stable line\n".repeat(1000)}IDENTICAL-NEEDLE\n`, "utf8");
  const first = core.surveyFile({ path: file, question: "IDENTICAL-NEEDLE" });
  const second = core.surveyFile({ path: file, question: "IDENTICAL-NEEDLE" });
  assert.equal(second.response.previous_capsule_id, first.response.capsule_id);
  assert.equal(second.response.changed_region.identical, true);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("commandSpawnPlan handles adversarial Windows resolution and argument fidelity", () => {
  const env = {
    Path: '  "/quoted tools" ; /other  ',
    Pathext: ".EXE;.CMD;.BAT;.PS1",
    systemroot: "/windows",
    KEEP_ME: "yes",
  };
  const files = new Set([
    "/workspace/local.cmd",
    "/workspace/relative.cmd",
    "/workspace/native.exe",
    "/quoted tools/npm.cmd",
    "/other/task.ps1",
  ]);
  const bundledPowerShell = "/windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  const options = {
    platform: "win32",
    cwd: "/workspace",
    env,
    path: path.posix,
    pathDelimiter: ";",
    statSync(candidate) {
      if (files.has(candidate)) return { isFile: () => true };
      throw new Error("not found");
    },
    existsSync: (candidate) => candidate === bundledPowerShell,
  };
  const faithfulArgs = ["", "two words", 'say "hello"', "C:\\path\\tail\\", "Istanbul-İ", "line1\nline2"];
  const npm = core.commandSpawnPlan("npm", faithfulArgs, options);
  assert.equal(npm.command, bundledPowerShell);
  assert.equal(npm.env.CAPSULE_COMMAND, "/quoted tools/npm.cmd");
  assert.deepEqual(JSON.parse(npm.env.CAPSULE_COMMAND_ARGS), faithfulArgs);
  assert.equal(npm.env.KEEP_ME, "yes");
  assert.match(npm.args.at(-1), /Remove-Item Env:CAPSULE_COMMAND,Env:CAPSULE_COMMAND_ARGS/);

  const explicit = core.commandSpawnPlan("npm.cmd", undefined, options);
  assert.equal(explicit.command, bundledPowerShell);
  assert.equal(explicit.env.CAPSULE_COMMAND, "/quoted tools/npm.cmd");
  assert.deepEqual(JSON.parse(explicit.env.CAPSULE_COMMAND_ARGS), []);

  const local = core.commandSpawnPlan("local", [], options);
  assert.equal(local.env.CAPSULE_COMMAND, "/workspace/local.cmd");
  const relative = core.commandSpawnPlan("./relative.cmd", [], options);
  assert.equal(relative.env.CAPSULE_COMMAND, "/workspace/relative.cmd");
  const script = core.commandSpawnPlan("task.ps1", [], options);
  assert.equal(script.env.CAPSULE_COMMAND, "/other/task.ps1");

  const native = core.commandSpawnPlan("native", [], options);
  assert.equal(native.command, "/workspace/native.exe");
  assert.deepEqual(native.args, []);
  assert.equal(native.env, env);

  assert.throws(() => core.commandSpawnPlan("npm", ["ok", 1], options), /array of strings/);
  const direct = core.commandSpawnPlan("node", ["--version"], { platform: "linux", env: { PATH: "/bin" } });
  assert.equal(direct.command, "node");
  assert.deepEqual(direct.args, ["--version"]);
});
