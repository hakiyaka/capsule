"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-native-edit-guard-"));
process.env.CAPSULE_STATE = state;
const hook = require("../scripts/hook.cjs");

function shell(command, overrides = {}) {
  return hook.handle("pretooluse", {
    tool_name: "functions.shell_command",
    tool_input: { command },
    cwd: state,
    session_id: `native-edit-${process.pid}-${Math.random()}`,
    available_tools: ["functions.apply_patch"],
    ...overrides,
  });
}

function denied(result) {
  return result.hookSpecificOutput?.permissionDecision === "deny";
}

test("blocks high-confidence inline interpreter text edits when a native edit tool is advertised", () => {
  const cases = [
    "python -c \"from pathlib import Path; p=Path('note.txt'); p.write_text(p.read_text().replace('old','new'))\"",
    "node -e \"const fs=require('fs'); fs.writeFileSync('note.txt',fs.readFileSync('note.txt','utf8').replace('old','new'))\"",
    "pwsh -Command \"(Get-Content note.txt) -replace 'old','new' | Set-Content note.txt\"",
    "Set-Content -LiteralPath note.txt -Value 'new'",
    "@'\nfrom pathlib import Path\np = Path('note.txt')\ncurrent = p.read_text()\nupdated = current.replace('old', 'new')\np.write_text(updated)\n'@ | python -",
  ];
  for (const command of cases) {
    const result = shell(command);
    assert.equal(denied(result), true, command);
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /Capsule native-edit guard/i);
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /functions\.apply_patch/i);
    assert.ok(result.hookSpecificOutput.permissionDecisionReason.length <= 620);
  }
});

test("does not infer native edit availability from command text", () => {
  const result = shell(
    "python -c \"from pathlib import Path; Path('apply_patch.txt').write_text('safe')\"",
    { available_tools: undefined }
  );
  assert.equal(denied(result), false);
});

test("fails open for outside-root, dynamic targets, serialization, and helper-generated content", () => {
  const cases = [
    "python -c \"from pathlib import Path; Path('../outside.txt').write_text('new')\"",
    "python -c \"from pathlib import Path; Path(target).write_text('new')\"",
    "node -e \"const fs=require('fs'); fs.writeFileSync('package.json',JSON.stringify(data))\"",
    "node -e \"const fs=require('fs'); fs.writeFileSync('note.txt',renderTemplate())\"",
    "python -c \"from pathlib import Path; Path('note.txt').write_text(render())\"",
  ];
  for (const command of cases) assert.equal(denied(shell(command)), false, command);
});

test("fails open when a workspace path resolves through a link outside the root", (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-native-edit-outside-"));
  const link = path.join(state, `outside-link-${Date.now()}`);
  try {
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    fs.rmSync(outside, { recursive: true, force: true });
    if (error?.code === "EPERM" || error?.code === "EACCES") return t.skip("link creation is unavailable");
    throw error;
  }
  try {
    const relative = `${path.basename(link)}/note.txt`.replaceAll("\\", "/");
    const command = `python -c \"from pathlib import Path; Path('${relative}').write_text('new')\"`;
    assert.equal(denied(shell(command)), false);
  } finally {
    fs.rmSync(link, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("learns a native edit tool only inside the same explicit session", () => {
  const session = `learn-native-${process.pid}-${Date.now()}`;
  hook.handle("pretooluse", {
    tool_name: "functions.apply_patch",
    tool_input: { patch: "*** Begin Patch\n*** End Patch" },
    cwd: state,
    session_id: session,
  });
  const learned = shell(
    "python -c \"from pathlib import Path; Path('note.txt').write_text('new')\"",
    { session_id: session, available_tools: undefined }
  );
  assert.equal(denied(learned), true);

  const foreign = shell(
    "python -c \"from pathlib import Path; Path('note.txt').write_text('new')\"",
    { session_id: `${session}-other`, available_tools: undefined }
  );
  assert.equal(denied(foreign), false);
});

test("allows legitimate execution, generators, formatters, migrations, bulk rewrites, and binary/media work", () => {
  const cases = [
    ["python -c \"print(2 + 2)\"", {}],
    ["python scripts/update_snapshots.py", {}],
    ["python -c \"from pathlib import Path; Path('client.js').write_text(source)\"", { intent: "generate API client" }],
    ["node ./node_modules/prettier/bin/prettier.cjs --write src", {}],
    ["python manage.py migrate", {}],
    ["python -c \"from pathlib import Path; [p.write_text(p.read_text().replace('a','b')) for p in Path('.').glob('*.txt')]\"", {}],
    ["python -c \"from pathlib import Path; Path('image.png').write_bytes(payload)\"", {}],
    ["node -e \"require('fs').writeFileSync('movie.mp4', Buffer.from(payload,'base64'))\"", {}],
  ];
  for (const [command, extra] of cases) {
    assert.equal(denied(shell(command, extra)), false, command);
  }
});

test("explicit exception and guard disable remain fail-open", () => {
  const command = "python -c \"from pathlib import Path; Path('note.txt').write_text('new')\"";
  const forced = shell(command, { tool_input: { command, native_edit_force: true } });
  assert.equal(denied(forced), false);

  process.env.CAPSULE_NATIVE_EDIT_GUARD = "0";
  try {
    assert.equal(denied(shell(command)), false);
  } finally {
    delete process.env.CAPSULE_NATIVE_EDIT_GUARD;
  }
});

test.after(() => {
  fs.rmSync(state, { recursive: true, force: true });
});
