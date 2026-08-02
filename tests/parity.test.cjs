"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  // node:sqlite is not available on the supported Node 18 baseline.  The
  // production search path already falls back to its portable implementation;
  // only the SQLite-lock contention probe must be skipped on that runtime.
  DatabaseSync = null;
}

const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-parity-state-"));
process.env.CAPSULE_STATE = state;
const compat = require("../mcp/compat.cjs");
const compaction = require("../mcp/compaction.cjs");
const compactionLedger = require("../mcp/compaction-ledger.cjs");
const core = require("../mcp/core.cjs");
const hook = require("../scripts/hook.cjs");
const hookCli = require("../scripts/cli.cjs");
const hookInstaller = require("../scripts/install-hooks.cjs");
const schema = require("../mcp/schema.cjs");
const toolchainJit = require("../mcp/toolchain-jit.cjs");
const unified = require("../mcp/unified.cjs");
const zeroInferencePoll = require("../mcp/zero-inference-poll.cjs");
const terminalGenome = require("../mcp/terminal-genome.cjs");

function replacementText(result) {
  return result?.continue === false && typeof result.reason === "string"
    ? result.reason
    : undefined;
}

function writePressureSession(file, {
  input = 20_000,
  cached = Math.floor(input * 0.8),
  contextWindow = 100_000,
  compactions = 0,
  postInput = 20_000,
} = {}) {
  const tokenRecord = (inputTokens, cachedTokens = Math.min(inputTokens, cached)) => ({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        model_context_window: contextWindow,
        last_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: cachedTokens,
          output_tokens: 100,
          reasoning_output_tokens: 20,
          total_tokens: inputTokens + 100,
        },
        total_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: 0,
          output_tokens: 100,
          reasoning_output_tokens: 20,
          total_tokens: inputTokens + 100,
        },
      },
    },
  });
  const records = [];
  for (let index = 0; index < compactions; index += 1) {
    records.push(tokenRecord(Math.min(contextWindow, input)));
    records.push({
      timestamp: new Date().toISOString(),
      type: "compacted",
      payload: { window_number: index + 1, replacement_history: [] },
    });
    records.push(tokenRecord(postInput));
  }
  records.push(tokenRecord(input));
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

test.after(() => {
  unified.closeSearchDatabase();
  fs.rmSync(state, { recursive: true, force: true });
});

test("profiles, custom filters, and gain accounting work locally", () => {
  assert.equal(compat.inferProfile("git", ["diff"]), "diff");
  assert.equal(compat.inferProfile("pytest", ["-q"]), "test");
  assert.equal(compat.inferProfile("kubectl", ["get", "pods"]), "table");
  assert.equal(compat.inferProfile("rg", ["needle", "."]), "grep");

  const added = compat.manageFilters({
    operation: "add",
    filter: {
      name: "keep-alerts",
      match: "custom-command",
      include: "ALERT|SUMMARY",
      tests: [{ input: "noise\nALERT one\nSUMMARY ok", expected: ["ALERT", "SUMMARY"], absent: ["noise"] }],
    },
  });
  assert.equal(added.response.test.ok, true);
  const filtered = compat.filterText("noise\nALERT one\nSUMMARY ok", {
    command: "custom-command",
    profile: "generic",
  });
  assert.doesNotMatch(filtered.lines.join("\n"), /noise/);
  assert.match(filtered.lines.join("\n"), /ALERT one/);

  compat.recordHistory({
    command: "pytest",
    profile: "test",
    route: "compressed",
    raw_chars: 10_000,
    emitted_chars: 1_000,
    exit_code: 0,
    source: "test",
  });
  const gain = compat.gain().response;
  assert.ok(gain.avoided.chars >= 9_000);
  assert.equal(gain.dollar_estimate.model, "gpt-5.6-sol");
  assert.ok(gain.dollar_estimate.estimated_saved_usd > 0);
  assert.equal(gain.verification.mode, "contract-valid-only");
  assert.equal(compat.telemetry().response.external_telemetry, false);
});

test("gain excludes legacy hook projections unless explicitly requested", () => {
  compat.recordHistory({
    command: "legacy-hook",
    profile: "generic",
    route: "compressed",
    raw_chars: 100_000,
    emitted_chars: 1,
    source: "hook-contract",
  });
  const verified = compat.gain().response;
  const inclusive = compat.gain({ include_unverified: true }).response;
  assert.ok(verified.verification.excluded_unverified_calls >= 1);
  assert.ok(inclusive.raw.chars >= verified.raw.chars + 100_000);
  assert.equal(inclusive.verification.mode, "all-local-projections");
});

test("advanced search supports stemming, substrings, typo correction, filters, and staleness", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-parity-search-"));
  const file = path.join(workspace, "strategy.md");
  fs.writeFileSync(file, "# Deployment\nCaching strategies use CAPSULE-SEARCH-NEEDLE.", "utf8");
  await unified.dispatch({ action: "index", payload: { path: file, tags: ["parity-search"] } });

  const stemmed = await unified.dispatch({
    action: "search",
    payload: { query: "cached strategy", tags: ["parity-search"] },
  });
  assert.ok(stemmed.response.searches[0].results.length >= 1);

  const substring = await unified.dispatch({
    action: "search",
    payload: { query: "SULE-SEARCH", tags: ["parity-search"] },
  });
  assert.ok(substring.response.searches[0].results.length >= 1);

  const typo = await unified.dispatch({
    action: "search",
    payload: { query: "deploymentt", tags: ["parity-search"] },
  });
  assert.equal(typo.response.searches[0].corrected_query, "deployment");
  assert.ok(typo.response.searches[0].results.length >= 1);

  fs.appendFileSync(file, "\nchanged after indexing", "utf8");
  const stale = await unified.dispatch({
    action: "search",
    payload: { query: "deployment", tags: ["parity-search"] },
  });
  assert.equal(stale.response.searches[0].results[0].stale, true);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("public index writes wait for a short competing SQLite writer", { skip: !DatabaseSync }, async () => {
  await unified.dispatch({
    action: "remember",
    payload: { content: "SQLITE-CONTENTION-SEED", tag: "contention" },
  });
  const databasePath = path.join(state, "index", "search.sqlite");
  const holderCode = [
    "const { DatabaseSync } = require('node:sqlite');",
    "const database = new DatabaseSync(process.argv[1]);",
    "database.exec('BEGIN IMMEDIATE');",
    "process.stdout.write('locked\\n');",
    "setTimeout(() => { database.exec('COMMIT'); database.close(); }, 350);",
  ].join("");
  const holder = spawn(process.execPath, ["--no-warnings", "-e", holderCode, databasePath], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    holder.once("error", reject);
    holder.stderr.on("data", (chunk) => reject(new Error(String(chunk))));
    holder.stdout.once("data", resolve);
  });

  await unified.dispatch({
    action: "remember",
    payload: { content: "SQLITE-CONTENTION-RECOVERED", tag: "contention" },
  });
  await new Promise((resolve, reject) => {
    holder.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`holder exited ${code}`)));
  });
  const searched = await unified.dispatch({
    action: "search",
    payload: { query: "SQLITE CONTENTION RECOVERED", kind: "memory" },
  });
  assert.match(searched.response.searches[0].results[0].snippet, /SQLITE-CONTENTION-RECOVERED/);
});

test("session continuity injects a bounded set of unique memories", async () => {
  for (const term of ["decision", "error", "blocker", "plan", "user prompt"]) {
    for (let index = 0; index < 2; index += 1) {
      hook.handle("stop", {
        last_assistant_message: `${term.toUpperCase()}-${index} ${(`${term} evidence `).repeat(80)}`,
        cwd: process.cwd(),
        session_id: `budget-${term.replace(" ", "-")}-${index}`,
      });
    }
  }
  const resumed = hook.handle("sessionstart", {
    cwd: process.cwd(),
    session_id: "bounded-session",
  });
  const context = resumed.hookSpecificOutput.additionalContext;
  assert.ok(context.length <= 600, `session context was ${context.length} chars`);
  assert.ok((context.match(/^- /gm) || []).length <= 1);
});

test("session continuity never injects one project's memory into another project", () => {
  const projectA = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-project-a-"));
  const projectB = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-project-b-"));
  const needle = `PROJECT-SCOPED-DECISION-${process.pid}-${Date.now()}`;
  try {
    hook.handle("stop", {
      last_assistant_message: `Decision: retain ${needle} for the next session.`,
      cwd: projectA,
      session_id: "project-a-session",
    });
    const foreign = hook.handle("sessionstart", {
      cwd: projectB,
      session_id: "project-b-session",
    });
    assert.doesNotMatch(foreign.hookSpecificOutput?.additionalContext || "", new RegExp(needle));

    const local = hook.handle("sessionstart", {
      cwd: projectA,
      session_id: "project-a-next-session",
    });
    assert.match(local.hookSpecificOutput.additionalContext, new RegExp(needle));
  } finally {
    fs.rmSync(projectA, { recursive: true, force: true });
    fs.rmSync(projectB, { recursive: true, force: true });
  }
});

test("post-tool hook gives one bounded batching hint after repeated tool round trips", () => {
  const session = `roundtrip-${process.pid}-${Date.now()}`;
  let result = {};
  for (let index = 0; index < 4; index += 1) {
    result = hook.handle("posttooluse", {
      tool_name: "node_repl.js",
      tool_output: `small result ${index}`,
      cwd: process.cwd(),
      session_id: session,
    });
  }
  assert.equal(result.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(result.hookSpecificOutput.additionalContext, /batch/i);
  assert.match(result.hookSpecificOutput.additionalContext, /independent|read-only/i);
  assert.equal("updatedMCPToolOutput" in result.hookSpecificOutput, false);
});

test("context-interest exchange redirects singleton reads before compaction thrash", () => {
  const file = path.join(state, `interest-pressure-${Date.now()}.jsonl`);
  writePressureSession(file, {
    input: 95_000,
    cached: 70_000,
    contextWindow: 100_000,
    compactions: 2,
    postInput: 72_000,
  });
  const base = {
    tool_name: "workspace.read_file",
    cwd: process.cwd(),
    session_id: `interest-gate-${process.pid}-${Date.now()}`,
    session_file: file,
  };
  let gated = {};
  for (let index = 0; index < 3; index += 1) {
    gated = hook.handle("pretooluse", {
      ...base,
      tool_input: { path: path.join(os.tmpdir(), `interest-${index}.txt`) },
    });
  }
  assert.equal(gated.hookSpecificOutput.permissionDecision, "deny");
  assert.match(gated.hookSpecificOutput.permissionDecisionReason, /context-interest exchange/i);
  assert.match(gated.hookSpecificOutput.permissionDecisionReason, /batch|mutation/i);

  const forced = hook.handle("pretooluse", {
    ...base,
    tool_input: {
      path: path.join(os.tmpdir(), "interest-forced.txt"),
      capsule_force: true,
    },
  });
  assert.notEqual(forced.hookSpecificOutput?.permissionDecision, "deny");
});

test("user-prompt hook reports a cache-aware round-trip tax once per usage sample", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-roundtrip-tax-"));
  const taxedFile = path.join(root, "taxed.jsonl");
  const healthyFile = path.join(root, "healthy.jsonl");
  const previous = process.env.CAPSULE_COGNITION;
  process.env.CAPSULE_COGNITION = "0";
  writePressureSession(taxedFile, { input: 80_000, cached: 55_000, contextWindow: 120_000 });
  writePressureSession(healthyFile, { input: 80_000, cached: 77_000, contextWindow: 120_000 });
  try {
    const input = {
      prompt: "Implement the next concrete change.",
      session_file: taxedFile,
      session_id: `roundtrip-tax-${process.pid}-${Date.now()}`,
      cwd: process.cwd(),
    };
    const first = hook.handle("userpromptsubmit", input);
    assert.match(first.hookSpecificOutput.additionalContext, /Capsule tax/i);
    assert.match(first.hookSpecificOutput.additionalContext, /uncached=25000t/i);
    assert.match(first.hookSpecificOutput.additionalContext, /cache=68\.75%/i);
    assert.deepEqual(hook.handle("userpromptsubmit", input), {});

    const healthy = hook.handle("userpromptsubmit", {
      ...input,
      session_file: healthyFile,
      session_id: `${input.session_id}-healthy`,
    });
    assert.deepEqual(healthy, {});
  } finally {
    if (previous == null) delete process.env.CAPSULE_COGNITION;
    else process.env.CAPSULE_COGNITION = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pre-tool sequence fuse detects read-plan cycles and resets after a successful mutation", () => {
  const session = `sequence-fuse-${process.pid}-${Date.now()}`;
  const read = (target) => hook.handle("pretooluse", {
    tool_name: "workspace.read_file",
    tool_input: { path: target },
    session_id: session,
    cwd: process.cwd(),
  });
  read("alpha.txt");
  read("beta.txt");
  read("alpha.txt");
  const repeated = read("beta.txt");
  assert.match(repeated.hookSpecificOutput.additionalContext, /sequence fuse/i);
  assert.match(repeated.hookSpecificOutput.additionalContext, /2-step/i);

  hook.handle("posttooluse", {
    tool_name: "apply_patch",
    tool_input: { patch: "*** Begin Patch\n*** End Patch" },
    tool_output: "Done!",
    session_id: session,
    cwd: process.cwd(),
  });
  read("alpha.txt");
  const afterMutation = read("beta.txt");
  assert.doesNotMatch(afterMutation.hookSpecificOutput?.additionalContext || "", /sequence fuse/i);
});

test("information-gain firewall blocks only cryptographically unchanged local rereads", () => {
  const target = path.join(state, "firewall-proof.txt");
  fs.writeFileSync(target, "stable evidence\n", "utf8");
  const input = {
    cwd: state,
    session_id: "information-gain-firewall",
    tool_name: "read_file",
    tool_input: { path: target },
  };
  const first = hook.handle("pretooluse", input);
  assert.notEqual(first.hookSpecificOutput?.permissionDecision, "deny");
  hook.handle("posttooluse", {
    ...input,
    tool_output: "stable evidence\n",
    is_error: false,
  });
  const repeated = hook.handle("pretooluse", input);
  assert.equal(repeated.hookSpecificOutput.permissionDecision, "deny");
  assert.match(repeated.hookSpecificOutput.permissionDecisionReason, /information-gain firewall/i);

  const forced = hook.handle("pretooluse", {
    ...input,
    tool_input: { path: target, force_refresh: true },
  });
  assert.notEqual(forced.hookSpecificOutput?.permissionDecision, "deny");

  fs.writeFileSync(target, "changed evidence\n", "utf8");
  const changed = hook.handle("pretooluse", input);
  assert.notEqual(changed.hookSpecificOutput?.permissionDecision, "deny");
});

test("context pressure tightens history pages and compresses medium tool output only when needed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-pressure-hook-"));
  const criticalFile = path.join(root, "critical.jsonl");
  const normalFile = path.join(root, "normal.jsonl");
  writePressureSession(criticalFile, { input: 85_000 });
  writePressureSession(normalFile, { input: 20_000 });
  const output = [
    ...Array.from({ length: 260 }, (_, index) => `routine row ${index}`),
    "ERROR PRESSURE-NEEDLE expected 2 received 1",
    "Tests: 1 failed, 259 passed, 260 total",
  ].join("\n");
  try {
    const criticalHistory = hook.handle("pretooluse", {
      tool_name: "read_thread",
      tool_input: { turnLimit: 8, maxOutputCharsPerItem: 800 },
      session_file: criticalFile,
      session_id: "pressure-critical-history",
      cwd: process.cwd(),
    });
    assert.equal(criticalHistory.hookSpecificOutput.updatedInput.turnLimit, 2);
    assert.equal(criticalHistory.hookSpecificOutput.updatedInput.maxOutputCharsPerItem, 240);

    const critical = hook.handle("posttooluse", {
      tool_name: "workspace.search",
      tool_input: { query: "PRESSURE-NEEDLE" },
      tool_output: output,
      session_file: criticalFile,
      session_id: "pressure-critical-output",
      cwd: process.cwd(),
      query: "PRESSURE-NEEDLE",
    });
    const replacement = replacementText(critical);
    assert.ok(replacement.length < output.length * 0.7);
    assert.match(replacement, /PRESSURE-NEEDLE/);
    assert.match(replacement, /1 failed/);
    assert.match(replacement, /Capsule exact=cap_[a-f0-9]{16}/i);
    assert.equal(critical.hookSpecificOutput.additionalContext, undefined);

    const normal = hook.handle("posttooluse", {
      tool_name: "workspace.search",
      tool_input: { query: "PRESSURE-NEEDLE normal" },
      tool_output: output,
      session_file: normalFile,
      session_id: "pressure-normal-output",
      cwd: process.cwd(),
      query: "PRESSURE-NEEDLE",
    });
    assert.equal(replacementText(normal), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("critical pressure capsules incompressible output instead of letting one tool call overflow context", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-pressure-circuit-"));
  const criticalFile = path.join(root, "critical.jsonl");
  const normalFile = path.join(root, "normal.jsonl");
  writePressureSession(criticalFile, { input: 85_000 });
  writePressureSession(normalFile, { input: 20_000 });
  const output = Array.from({ length: 12_000 }, (_, index) =>
    String.fromCodePoint(0x4e00 + (index * 7919) % 20_000)
  ).join("");
  try {
    const critical = hook.handle("posttooluse", {
      tool_name: "workspace.read_file",
      tool_input: { path: "high-entropy-evidence.bin.txt" },
      tool_output: output,
      session_file: criticalFile,
      session_id: "pressure-circuit-critical",
      cwd: process.cwd(),
    });
    const replacement = replacementText(critical);
    assert.ok(replacement.length < 2_200);
    assert.match(replacement, /pressure circuit/i);
    assert.match(replacement, /sha256=[a-f0-9]{64}/i);
    assert.match(replacement, /exact=cap_[a-f0-9]{16}/i);

    const normal = hook.handle("posttooluse", {
      tool_name: "workspace.read_file",
      tool_input: { path: "high-entropy-evidence-normal.bin.txt" },
      tool_output: output,
      session_file: normalFile,
      session_id: "pressure-circuit-normal",
      cwd: process.cwd(),
    });
    assert.equal(replacementText(normal), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("normal pressure still capsules oversized incompressible read output with exact recovery", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-absolute-output-"));
  const normalFile = path.join(root, "normal.jsonl");
  writePressureSession(normalFile, { input: 20_000, cached: 19_000 });
  const output = Array.from({ length: 48_000 }, (_, index) =>
    String.fromCodePoint(0x4e00 + (index * 7919) % 20_000)
  ).join("");
  try {
    const result = hook.handle("posttooluse", {
      tool_name: "workspace.read_file",
      tool_input: { path: "absolute-high-entropy-evidence.txt" },
      tool_output: output,
      session_file: normalFile,
      session_id: `absolute-output-${process.pid}-${Date.now()}`,
      cwd: process.cwd(),
    });
    const replacement = replacementText(result);
    assert.ok(replacement.length < 2_200);
    assert.match(replacement, /absolute-cap/i);
    const capsuleId = replacement.match(/exact=(cap_[a-f0-9]{16})/i)?.[1];
    assert.ok(capsuleId);
    assert.equal(core.loadCapsule(capsuleId).text, output);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("universal hard cap envelopes giant unknown-tool output with exact recovery", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-universal-hard-cap-"));
  const sessionFile = path.join(root, "normal.jsonl");
  writePressureSession(sessionFile, { input: 20_000, cached: 19_000 });
  const output = Array.from({ length: 600_000 }, (_, index) =>
    String.fromCodePoint(0x4e00 + (index * 7919) % 20_000)
  ).join("");
  try {
    const result = hook.handle("posttooluse", {
      tool_name: "vendor.unknown_mutating_tool",
      tool_input: { operation: "inspect" },
      tool_output: output,
      session_file: sessionFile,
      session_id: `universal-hard-cap-${process.pid}-${Date.now()}`,
      cwd: process.cwd(),
    });
    const replacement = replacementText(result);
    assert.ok(replacement.length < 2_200);
    assert.match(replacement, /universal-hard-cap/i);
    const capsuleId = replacement.match(/exact=(cap_[a-f0-9]{16})/i)?.[1];
    assert.ok(capsuleId);
    assert.equal(core.loadCapsule(capsuleId).text, output);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("successful exec control envelopes shrink while failures and live jobs remain intact", () => {
  const session = `control-envelope-${process.pid}-${Date.now()}`;
  const successOutput = "Exit code: 0\nWall time: 0.2 seconds\nOutput:\nalpha\n";
  const success = hook.handle("posttooluse", {
    tool_name: "functions.shell_command",
    tool_input: { command: "Write-Output alpha" },
    tool_output: successOutput,
    session_id: session,
    cwd: process.cwd(),
  });
  assert.equal(replacementText(success), "alpha");

  const timed = hook.handle("posttooluse", {
    tool_name: "functions.shell_command",
    tool_input: { command: "npm run benchmark" },
    tool_output: successOutput,
    session_id: `${session}-timed`,
    cwd: process.cwd(),
  });
  assert.equal(replacementText(timed), undefined);

  const failureOutput = "Exit code: 1\nWall time: 0.2 seconds\nOutput:\nERROR alpha\n";
  const failure = hook.handle("posttooluse", {
    tool_name: "functions.shell_command",
    tool_input: { command: "exit 1" },
    tool_output: failureOutput,
    is_error: true,
    session_id: `${session}-failure`,
    cwd: process.cwd(),
  });
  assert.equal(replacementText(failure), undefined);

  const liveOutput = "Script running with cell ID 1234";
  const live = hook.handle("posttooluse", {
    tool_name: "functions.shell_command",
    tool_input: { command: "npm test" },
    tool_output: liveOutput,
    session_id: `${session}-live`,
    cwd: process.cwd(),
  });
  assert.equal(replacementText(live), undefined);

  const pollOutput = JSON.stringify({
    session_command: "Get-Content -Wait ".repeat(20),
    status: "running",
    new_output: "",
  });
  const poll = hook.handle("posttooluse", {
    tool_name: "write_stdin",
    tool_input: { cell_id: "1234" },
    tool_output: pollOutput,
    session_id: `${session}-poll`,
    cwd: process.cwd(),
  });
  assert.doesNotMatch(replacementText(poll), /session_command/);
  assert.match(replacementText(poll), /running/);
});

test("poll governor lengthens short waits and flags repeated no-progress reads", () => {
  const session = `poll-progress-${process.pid}-${Date.now()}`;
  const firstWait = hook.handle("pretooluse", {
    tool_name: "wait",
    tool_input: { cell_id: "cell-1", yield_time_ms: 10_000 },
    session_id: session,
    cwd: process.cwd(),
  });
  assert.equal(firstWait.hookSpecificOutput.updatedInput.yield_time_ms, 60_000);

  const secondWait = hook.handle("pretooluse", {
    tool_name: "wait",
    tool_input: { cell_id: "cell-1", yield_time_ms: 10_000 },
    session_id: session,
    cwd: process.cwd(),
  });
  assert.match(secondWait.hookSpecificOutput.additionalContext, /poll|quota|unchanged|wait/i);

  let repeated = {};
  for (let index = 0; index < 4; index += 1) {
    repeated = hook.handle("pretooluse", {
      tool_name: "workspace.read_file",
      tool_input: { path: "src/repeated-service.ts" },
      session_id: session,
      cwd: process.cwd(),
    });
  }
  assert.match(repeated.hookSpecificOutput.additionalContext, /no-progress loop|exact-read fuse/i);
  assert.match(repeated.hookSpecificOutput.additionalContext, /change|blocker|capsule|diff/i);
});

test("Codex hook wire format reads tool_response and emits only supported replacement fields", () => {
  const result = hook.handle("posttooluse", {
    tool_name: "workspace.read_file",
    tool_input: { path: "large-wire-fixture.txt" },
    tool_response: `${"wire-contract evidence\n".repeat(2_000)}WIRE-CONTRACT-TAIL`,
    session_id: `wire-contract-${process.pid}-${Date.now()}`,
    cwd: process.cwd(),
  });
  assert.equal(result.continue, false);
  assert.equal(typeof result.reason, "string");
  assert.match(result.stopReason, /compact exact-recoverable/i);
  assert.equal(result.decision, undefined);
  assert.equal("updatedMCPToolOutput" in result.hookSpecificOutput, false);
  assert.doesNotMatch(JSON.stringify(result), /updatedMCPToolOutput|suppressOutput/);
  assert.ok(result.reason.length < 8_000);
});

test("session transcript reads receive a tighter exact-recoverable model budget", () => {
  let seed = 0x51a2b3c4;
  let output = "";
  for (let index = 0; index < 48_000; index += 1) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    output += String.fromCharCode(33 + (seed >>> 0) % 90);
  }
  const result = hook.handle("posttooluse", {
    tool_name: "workspace.read_file",
    tool_input: { path: "C:\\Users\\sample\\.codex\\sessions\\2026\\07\\task\\rollout-fixture.jsonl" },
    tool_response: output,
    session_id: `session-shield-${process.pid}-${Date.now()}`,
    cwd: process.cwd(),
  });
  const compact = replacementText(result);
  assert.ok(compact);
  assert.ok(compact.length < 2_600);
  const capsuleId = compact.match(/exact=(cap_[a-f0-9]{16})/i)?.[1];
  assert.ok(capsuleId);
  assert.equal(core.loadCapsule(capsuleId).text, output);
});

test("session transcript JSONL becomes a queryable aggregate with exact recovery", () => {
  const records = [];
  for (let index = 0; index < 80; index += 1) {
    records.push(JSON.stringify({
      timestamp: `2026-07-28T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
      type: index % 3 === 0 ? "event_msg" : "response_item",
      payload: {
        type: index % 5 === 0 ? "function_call_output" : "message",
        text: `deployment checkpoint ${index} ${"evidence ".repeat(10)}`,
      },
    }));
  }
  const output = records.join("\n");
  const result = hook.handle("posttooluse", {
    tool_name: "shell_command",
    tool_input: {
      command: "Select-String -Path C:\\Users\\sample\\.codex\\sessions\\rollout-fixture.jsonl -Pattern deployment",
    },
    tool_response: output,
    session_id: `session-query-${process.pid}-${Date.now()}`,
    cwd: process.cwd(),
  });
  const compact = replacementText(result);
  assert.match(compact, /session transcript projection/i);
  assert.match(compact, /records=80/);
  assert.match(compact, /record_types=/);
  assert.match(compact, /sha256=[a-f0-9]{64}/);
  assert.ok(compact.length < 2_200);
  const capsuleId = compact.match(/exact=(cap_[a-f0-9]{16})/i)?.[1];
  assert.ok(capsuleId);
  assert.equal(core.loadCapsule(capsuleId).text, output);

  const ordinary = hook.handle("posttooluse", {
    tool_name: "workspace.read_file",
    tool_input: { path: "fixtures/ordinary.jsonl" },
    tool_response: output,
    session_id: `ordinary-jsonl-${process.pid}-${Date.now()}`,
    cwd: process.cwd(),
  });
  assert.doesNotMatch(replacementText(ordinary) || "", /session transcript projection/i);
});

test("small poll replay hides only an exact quiet repeat for the same request", () => {
  const session = `small-poll-${process.pid}-${Date.now()}`;
  const base = {
    tool_name: "wait_agent",
    tool_input: { target: "agent-a", timeout_ms: 60_000 },
    session_id: session,
    cwd: process.cwd(),
  };
  const quiet = JSON.stringify({
    status: "running",
    activity: "no new output",
    detail: "worker remains active and no attention is required",
  });
  assert.equal(replacementText(hook.handle("posttooluse", { ...base, tool_response: quiet })), undefined);
  assert.match(replacementText(hook.handle("posttooluse", { ...base, tool_response: quiet })), /poll: exactly unchanged/i);

  const otherTarget = hook.handle("posttooluse", {
    ...base,
    tool_input: { target: "agent-b", timeout_ms: 60_000 },
    tool_response: quiet,
  });
  assert.equal(replacementText(otherTarget), undefined);

  const changed = hook.handle("posttooluse", {
    ...base,
    tool_response: quiet.replace("no new output", "new progress available"),
  });
  assert.equal(replacementText(changed), undefined);

  const completed = JSON.stringify({ status: "completed", final: "all checks passed and artifacts are ready" });
  hook.handle("posttooluse", { ...base, tool_response: completed });
  assert.equal(replacementText(hook.handle("posttooluse", { ...base, tool_response: completed })), undefined);
});

test("PreToolUse rewrites are schema-valid and shell wrapping stays observational", () => {
  const read = hook.handle("pretooluse", {
    tool_name: "read_thread",
    tool_input: { threadId: "thread-1" },
    session_id: "pretool-contract-read",
    cwd: process.cwd(),
  });
  assert.equal(read.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(read.hookSpecificOutput.updatedInput.includeOutputs, false);

  const unsafe = hook.handle("pretooluse", {
    tool_name: "shell_command",
    tool_input: { command: "rg needle .; Remove-Item important.txt" },
    session_id: "pretool-contract-unsafe",
    cwd: process.cwd(),
  });
  assert.equal(unsafe.hookSpecificOutput?.updatedInput, undefined);
  assert.equal(unsafe.hookSpecificOutput?.permissionDecision, undefined);
});

test("plugin bundles all six lifecycle hooks instead of relying only on user hooks.json", () => {
  const file = path.join(__dirname, "..", "hooks", "hooks.json");
  const bundled = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(
    Object.keys(bundled.hooks).sort(),
    ["PostToolUse", "PreCompact", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"].sort()
  );
  assert.ok(bundled.hooks.SessionStart[0].hooks[0].timeout >= 30);
  for (const groups of Object.values(bundled.hooks)) {
    for (const group of groups) {
      for (const handler of group.hooks) {
        assert.match(handler.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/hook\.cjs/);
      }
    }
  }
});

test("plan governor does not mistake repeated planning for implementation progress", () => {
  const session = `plan-progress-${process.pid}-${Date.now()}`;
  const plan = {
    tool_name: "functions.update_plan",
    tool_input: {
      plan: [
        { step: "Inspect the failing module", status: "completed" },
        { step: "Apply the implementation fix", status: "in_progress" },
      ],
    },
    session_id: session,
    cwd: process.cwd(),
  };
  hook.handle("pretooluse", plan);
  hook.handle("posttooluse", { ...plan, tool_output: "Plan updated" });
  const repeated = hook.handle("pretooluse", plan);
  assert.match(repeated.hookSpecificOutput.additionalContext, /same plan|plan fuse/i);
  assert.match(repeated.hookSpecificOutput.additionalContext, /execute|concrete|blocker/i);

  const mutation = {
    tool_name: "functions.apply_patch",
    tool_input: { patch: "*** Update File: src/service.js\n+fixed\n" },
    tool_output: "Done",
    session_id: session,
    cwd: process.cwd(),
  };
  hook.handle("pretooluse", mutation);
  hook.handle("posttooluse", mutation);
  const afterMutation = hook.handle("pretooluse", plan);
  assert.doesNotMatch(afterMutation.hookSpecificOutput?.additionalContext || "", /same plan|plan-only loop/i);
});

test("failure fuse compacts only an unchanged repeated error and preserves changed evidence", () => {
  const session = `failure-fuse-${process.pid}-${Date.now()}`;
  const base = {
    tool_name: "functions.shell_command",
    tool_input: { command: "npm test -- --runInBand" },
    cwd: process.cwd(),
    session_id: session,
    is_error: true,
  };
  const firstError = `Error: build cache is locked\n${"diagnostic frame\n".repeat(140)}FIRST-ERROR-TAIL`;
  const first = hook.handle("posttooluse", { ...base, tool_output: firstError });
  assert.doesNotMatch(replacementText(first) || "", /repeated failure/i);

  const retry = hook.handle("pretooluse", base);
  assert.match(retry.hookSpecificOutput.additionalContext, /retry fuse|already failed/i);
  const repeated = hook.handle("posttooluse", { ...base, tool_output: firstError });
  const replacement = replacementText(repeated);
  assert.match(replacement, /repeated failure x2/i);
  assert.match(replacement, /exact=cap_[a-f0-9]{16}/i);
  assert.ok(replacement.length < firstError.length * 0.25);

  const changedError = `Error: permission denied NEW-FAILURE-EVIDENCE\n${"different frame\n".repeat(120)}`;
  const changed = hook.handle("posttooluse", { ...base, tool_output: changedError });
  assert.doesNotMatch(replacementText(changed) || "", /repeated failure/i);

  const changedInput = hook.handle("posttooluse", {
    ...base,
    tool_input: { command: "npm test -- --runInBand --no-cache" },
    tool_output: firstError,
  });
  assert.doesNotMatch(replacementText(changedInput) || "", /repeated failure/i);

  const structured = {
    tool_name: "functions.shell_command",
    tool_input: { command: "npm run build" },
    tool_output: `Exit code: 1\nError: compiler failed\n${"compiler frame\n".repeat(120)}`,
    cwd: process.cwd(),
    session_id: `${session}-structured`,
  };
  hook.handle("posttooluse", structured);
  const inferred = hook.handle("posttooluse", structured);
  assert.match(replacementText(inferred), /repeated failure x2/i);
});

test("repeated compaction carries a sanitized prior phase checkpoint", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-phase-checkpoint-"));
  const file = path.join(root, "session.jsonl");
  const session = `phase-checkpoint-${process.pid}-${Date.now()}`;
  writePressureSession(file, { input: 85_000, compactions: 1, postInput: 20_000 });
  try {
    hook.handle("stop", {
      last_assistant_message: "Completed PHASE-CHECKPOINT-71. Decision: retain the content-hash cache key. Tests 11/11 pass.",
      session_file: file,
      session_id: session,
      cwd: process.cwd(),
    });
    const compact = hook.handle("precompact", {
      summary: "Compact the current implementation phase.",
      session_file: file,
      session_id: session,
      cwd: process.cwd(),
    });
    const context = compact.hookSpecificOutput.additionalContext;
    assert.match(context, /summary<=400/);
    assert.match(context, /PHASE-CHECKPOINT-71/);
    assert.match(context, /content-hash cache key/);
    assert.match(context, /11\/11/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("PreCompact seed moves its existing directive without increasing context size", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-layout-prefix-"));
  try {
    const sessionFile = path.join(root, "session.jsonl");
    fs.writeFileSync(sessionFile, `${JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: "LAYOUT-GOAL-1" },
    })}\n`, "utf8");
    const args = {
      session_file: sessionFile,
      generation_file: path.join(root, "generation.json"),
      max_chars: 2_400,
      summary_tokens: 400,
      progress: "LAYOUT-PROGRESS-1",
    };
    const first = compaction.buildSeed(args).response;
    const second = compaction.buildSeed(args).response;
    const third = compaction.buildSeed(args).response;
    const oldOrder = (seed) => `${seed.context.slice(seed.context_layout.prefix_chars + 1)}\n${seed.context_layout.context}`;
    assert.equal(second.context_layout.prefix_hash, third.context_layout.prefix_hash);
    assert.equal(first.context_layout.cache_attribution.available, false);
    assert.equal(first.chars, oldOrder(first).length);
    assert.equal(second.chars, oldOrder(second).length);
    assert.equal(third.chars, oldOrder(third).length);
    assert.ok(first.chars <= args.max_chars);
    assert.ok(second.chars <= args.max_chars);
    assert.ok(third.chars <= args.max_chars);
    assert.match(second.context, /context-gc g=2/);
    assert.match(third.context, /context-gc g=3/);
    assert.match(oldOrder(second), /G: =@|G: LAYOUT-GOAL-1/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("post-compaction memory ledger restores state and probes the first mutation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-memory-ledger-"));
  const file = path.join(root, "session.jsonl");
  const session = `memory-ledger-${process.pid}-${Date.now()}`;
  writePressureSession(file, { input: 85_000, compactions: 1, postInput: 20_000 });
  const base = { session_file: file, session_id: session, cwd: root };
  try {
    hook.handle("stop", {
      ...base,
      last_assistant_message: "Decision: retain the content-hash cache key. Tests 11/11 pass. Next: verify restart.",
    });
    const compact = hook.handle("precompact", {
      ...base,
      summary: "Compact the current implementation phase.",
    });
    assert.match(compact.hookSpecificOutput.additionalContext, /memory ledger/i);
    const resumed = hook.handle("sessionstart", { ...base, source: "compact" });
    assert.match(resumed.hookSpecificOutput.additionalContext, /memory ledger/i);
    assert.match(resumed.hookSpecificOutput.additionalContext, /probe=required/i);
    assert.match(resumed.hookSpecificOutput.additionalContext, /content-hash cache key/i);

    const firstMutation = hook.handle("pretooluse", {
      ...base,
      tool_name: "functions.apply_patch",
      tool_input: { patch: "*** Begin Patch\n*** Update File: marker.txt\n@@\n-old\n+new\n*** End Patch" },
    });
    assert.match(firstMutation.hookSpecificOutput.additionalContext, /memory ledger|probe/i);
    hook.handle("posttooluse", {
      ...base,
      tool_name: "functions.apply_patch",
      tool_input: { patch: "applied" },
      tool_output: "applied",
    });
    const afterProbe = hook.handle("pretooluse", {
      ...base,
      tool_name: "functions.apply_patch",
      tool_input: { patch: "another patch" },
    });
    assert.doesNotMatch(afterProbe.hookSpecificOutput?.additionalContext || "", /memory ledger v1|Capsule probe/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("memory ledger redacts secrets and starts a fresh epoch on task change", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-memory-ledger-boundary-"));
  const file = path.join(root, "ledger.json");
  try {
    compactionLedger.update({
      file,
      epoch: 2,
      task_hash: "task-a",
      decisions: ["Keep the cache key; token=super-secret"],
      progress: "changed=src/a.js",
      capsules: ["cap_0123456789abcdef"],
      probe_required: true,
    });
    const probe = compactionLedger.emitProbe({ file, is_mutation: true });
    assert.match(probe, /probe|required/i);
    assert.doesNotMatch(JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))), /super-secret/);
    compactionLedger.update({
      file,
      epoch: 0,
      task_hash: "task-b",
      decisions: ["New task"],
      progress: "changed=src/b.js",
    });
    const resumed = compactionLedger.context({ file });
    assert.match(resumed, /New task/);
    assert.doesNotMatch(resumed, /cache key|src\/a\.js|0123456789abcdef/);
    assert.match(resumed, /epoch=0/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Proof-Carrying Generational Context GC carries live roots and deltas without rereading", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-context-gc-"));
  const file = path.join(root, "session.jsonl");
  const generationFile = path.join(root, "generation.json");
  const records = [
    {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: `GOAL-GC-91 preserve the implementation objective and constraints ${"goal detail ".repeat(50)}`,
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: `STATE-GC-92 investigation complete; next edit is compaction.cjs ${"state evidence ".repeat(45)}`,
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        changes: {
          [path.join(root, "mcp", "compaction.cjs")]: { type: "update" },
          [path.join(root, "tests", "parity.test.cjs")]: { type: "update" },
        },
      },
    },
  ];
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  try {
    const args = {
      session_file: file,
      generation_file: generationFile,
      max_chars: 1_200,
      summary_tokens: 400,
      historical: "HISTORY-GC-93 prior decision remains valid.",
      progress: "PROGRESS-GC-94 tests remain to run.",
      tombstones: ["done@qpx-proof-95:e0"],
    };
    const first = compaction.buildSeed(args).response;
    const second = compaction.buildSeed(args).response;
    assert.match(first.context, /compact map/);
    assert.equal(first.context_gc.emission, "legacy-bootstrap");
    assert.match(second.context, /context-gc g=2/);
    assert.equal(second.context_gc.emission, "generation-delta");
    assert.match(second.context, /G: =@[a-f0-9]{12}/);
    assert.match(second.context, /P: =@[a-f0-9]{12}/);
    assert.match(second.context, /S: =@[a-f0-9]{12}/);
    assert.match(second.context, /F: =@[a-f0-9]{12}/);
    assert.ok(second.chars < first.chars);
    assert.equal(second.context_gc.swept_nodes, 0);
    assert.match(second.context_gc.exact, /^cap_[a-f0-9]{16}$/);
    const exact = JSON.parse(core.loadCapsule(second.context_gc.exact).text);
    assert.match(exact.roots.G, /GOAL-GC-91/);
    assert.match(exact.roots.P, /PROGRESS-GC-94/);
    assert.equal(exact.sets.F.length, 2);
    assert.deepEqual(exact.sets.T, ["done@qpx-proof-95:e0"]);
    assert.ok(exact.sets.F.some((value) => value.endsWith("mcp/compaction.cjs")));
    assert.ok(exact.sets.F.some((value) => value.endsWith("tests/parity.test.cjs")));

    const third = compaction.buildSeed({
      ...args,
      progress: "PROGRESS-GC-96 full validation is now complete.",
    }).response;
    const thirdExact = JSON.parse(core.loadCapsule(third.context_gc.exact).text);
    assert.ok(thirdExact.sets.T.some((value) => value.includes(":P¬@")));
    assert.ok(third.context_gc.tombstones >= 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Causal Toolchain JIT learns a dominant safe transition and collapses its model turn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-toolchain-jit-"));
  const common = {
    cwd: root,
    session_id: `toolchain-jit-${process.pid}-${Date.now()}`,
    execution_epoch: 4,
  };
  const search = { ...common, command: "rg NEEDLE .", profile: "search" };
  const status = { ...common, command: "git status --short", profile: "git-status" };
  const step = (candidate) => {
    const token = toolchainJit.begin(candidate);
    return toolchainJit.finish(token, 0).prediction;
  };
  try {
    assert.equal(step(search), null);
    assert.equal(step(status), null);
    assert.equal(step(search), null);
    assert.equal(step(status), null);
    const learned = step(search);
    assert.equal(learned.target.command, status.command);
    assert.equal(learned.confidence, 1);
    assert.equal(learned.observations, 2);

    const result = await hookCli.runPayload({
      ...search,
      input_tokens: 64_000,
      max_chars: 1_200,
      passthrough_chars: 500,
    }, async (command) => ({
      exit_code: 0,
      signal: null,
      stdout: command === search.command ? "NEEDLE src/value.cjs\n" : " M src/value.cjs\n",
      stderr: "",
    }));
    assert.equal(result.macro.length, 1);
    assert.match(result.output, /\[Capsule JIT\+1/);
    assert.match(result.output, /git status --short/);
    assert.match(result.proof, /^cap_[a-f0-9]{16}$/);
    const proof = JSON.parse(core.loadCapsule(result.proof).text);
    assert.equal(proof.successors[0].command, status.command);
    assert.equal(proof.successors[0].exit_code, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Causal Toolchain JIT rejects mutation-capable and shell-composed successors", () => {
  assert.equal(toolchainJit.safe(toolchainJit.descriptor({
    command: "npm run build",
    profile: "build",
    cwd: process.cwd(),
  })), false);
  assert.equal(toolchainJit.safe(toolchainJit.descriptor({
    command: "git status --short; Remove-Item important.txt",
    profile: "git-status",
    cwd: process.cwd(),
  })), false);
});

test("Causal Toolchain JIT normalizes native hook profiles before learning", () => {
  assert.equal(toolchainJit.descriptor({
    command: "rg NEEDLE .",
    profile: "grep",
    cwd: process.cwd(),
  }).profile, "search");
  assert.equal(toolchainJit.descriptor({
    command: "git status --short",
    profile: "git",
    cwd: process.cwd(),
  }).profile, "git-status");
});

test("Zero-Inference Poll Reactor coalesces repeated status checks until semantic change", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-zero-poll-"));
  const common = {
    cwd: root,
    session_id: `zero-poll-${process.pid}-${Date.now()}`,
    execution_epoch: 7,
    input_tokens: 64_000,
    command: "gh run view 123",
    profile: "git",
    max_chars: 1_200,
    passthrough_chars: 500,
  };
  const result = (status) => ({
    exit_code: 0,
    signal: null,
    stdout: `status=${status}\n`,
    stderr: "",
  });
  try {
    const cold = await hookCli.runPayload(common, async () => result("pending"));
    assert.equal(cold.output, "status=pending\n");
    let calls = 0;
    const fused = await hookCli.runPayload(common, async () => {
      calls += 1;
      return result(calls >= 5 ? "success" : "pending");
    }, {
      sleep: async () => {},
    });
    assert.equal(fused.poll.activated, true);
    assert.equal(fused.poll.changed, true);
    assert.equal(fused.poll.local_observations, 4);
    assert.equal(calls, 5);
    assert.match(fused.output, /zero-inference reactor; changed/);
    assert.match(fused.output, /status=success/);
    const proof = JSON.parse(core.loadCapsule(fused.proof).text);
    assert.equal(proof.probes.length, 4);
    assert.equal(proof.probes.at(-1).changed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Zero-Inference Poll Reactor waits on filesystem events and rejects composed commands", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-zero-poll-event-"));
  const common = {
    cwd: root,
    session_id: `zero-poll-event-${process.pid}-${Date.now()}`,
    execution_epoch: 2,
    input_tokens: 32_000,
    command: "git status --short",
    profile: "git",
  };
  const unchanged = async () => ({
    exit_code: 0,
    signal: null,
    stdout: " M src/value.cjs\n",
    stderr: "",
  });
  try {
    await hookCli.runPayload(common, unchanged);
    const fused = await hookCli.runPayload(common, unchanged, {
      waitForSignal: async () => ({ kind: "timeout" }),
    });
    assert.equal(fused.poll.activated, true);
    assert.equal(fused.poll.changed, false);
    assert.equal(fused.poll.transport, "filesystem-event");
    assert.equal(fused.poll.local_observations, 0);
    assert.match(fused.output, /zero-inference reactor; quiet/);
    assert.equal(zeroInferencePoll.safeCommand("git status --short; git push"), false);
    assert.equal(zeroInferencePoll.safeCommand("Remove-Item important.txt"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native hook wrapping recognizes compact safe status commands", () => {
  const rewrite = compat.rewriteCommand({
    command: "gh pr checks 123",
    cwd: process.cwd(),
    hook: true,
  }).response;
  assert.equal(rewrite.should_wrap, true);
  assert.equal(rewrite.reason, "safe repeated-status candidate");
});

test("Terminal Genome reuses boilerplate across different shell commands with exact recovery", () => {
  const session = "terminal-genome-" + process.pid + "-" + Date.now();
  const shared = Array.from({ length: 180 }, (_, index) => "shared toolchain phase " + index).join("\n");
  const firstText = shared + "\nalpha-only evidence";
  const secondText = shared + "\nbeta-only evidence";
  const common = { session_id: session, cwd: process.cwd(), success: true };
  const first = terminalGenome.project({ ...common, command: "tool-a inspect", text: firstText });
  const second = terminalGenome.project({ ...common, command: "tool-b verify", text: secondText });
  assert.ok(first);
  assert.match(first.output, /terminal lattice/);
  assert.ok(second);
  assert.match(second.output, /terminal genome/);
  assert.match(second.output, /beta-only evidence/);
  assert.doesNotMatch(second.output, /shared toolchain phase 100/);
  assert.equal(core.loadCapsule(second.capsule_id).text, secondText);
  assert.ok(second.output.length < secondText.length * 0.2);
});

test("Terminal Genome covers successful mutation shells but Pareto-bypasses small output", () => {
  const session = "terminal-genome-hook-" + process.pid + "-" + Date.now();
  const shared = Array.from({ length: 160 }, (_, index) => "installer boilerplate phase " + index).join("\n");
  const base = {
    tool_name: "shell_command",
    cwd: process.cwd(),
    session_id: session,
  };
  hook.handle("posttooluse", {
    ...base,
    tool_input: { command: "npm install package-a" },
    tool_output: shared + "\npackage-a complete",
  });
  const second = hook.handle("posttooluse", {
    ...base,
    tool_input: { command: "npm install package-b" },
    tool_output: shared + "\npackage-b complete",
  });
  assert.match(replacementText(second) || "", /terminal genome/);
  const smallSession = session + "-small";
  terminalGenome.project({
    session_id: smallSession,
    cwd: process.cwd(),
    command: "one",
    text: "small stable output ".repeat(8),
    success: true,
  });
  const small = terminalGenome.project({
    session_id: smallSession,
    cwd: process.cwd(),
    command: "two",
    text: "small stable output ".repeat(8),
    success: true,
  });
  assert.equal(small, null);
});

test("Terminal Lattice compresses first-seen structured shell output with exact recovery", () => {
  const session = "terminal-lattice-" + process.pid + "-" + Date.now();
  const rows = Array.from({ length: 140 }, (_, index) =>
    "compiled src/module-" + String(index).padStart(4, "0") + ".js in " + (index + 1) + "ms"
  );
  const text = rows.join("\n") + "\nwarning: retained unique diagnostic\nUNIQUE TERMINAL PROOF";
  const result = terminalGenome.project({
    session_id: session,
    cwd: process.cwd(),
    command: "unknown-tool --build",
    text,
    exact_text: text,
    success: true,
  });
  assert.ok(result);
  assert.equal(result.mode, "lattice");
  assert.match(result.output, /terminal lattice/);
  assert.match(result.output, /<path1>/);
  assert.match(result.output, /warning: retained unique diagnostic/);
  assert.match(result.output, /UNIQUE TERMINAL PROOF/);
  assert.equal(core.loadCapsule(result.capsule_id).text, text);
  assert.ok(result.output.length < text.length * 0.3);
});

test("Terminal Lattice Pareto-bypasses unstructured novel prose", () => {
  const text = Array.from({ length: 30 }, (_, index) =>
    String.fromCharCode(65 + (index % 26)).repeat(40 + index)
  ).join("\n");
  const result = terminalGenome.project({
    session_id: "terminal-lattice-prose-" + process.pid + "-" + Date.now(),
    cwd: process.cwd(),
    command: "custom prose emitter",
    text,
    success: true,
  });
  assert.equal(result, null);
});

test("Terminal Genome never erases changed durations or timestamps", () => {
  const session = "terminal-semantic-change-" + process.pid + "-" + Date.now();
  const before = Array.from({ length: 120 }, (_, index) =>
    "worker " + index + " latency 100ms at 2026-07-28T10:00:00Z"
  ).join("\n");
  const after = Array.from({ length: 120 }, (_, index) =>
    "worker " + index + " latency 10s at 2026-07-28T11:00:00Z"
  ).join("\n");
  const common = { session_id: session, cwd: process.cwd(), success: true };
  terminalGenome.project({ ...common, command: "probe before", text: before });
  const result = terminalGenome.project({ ...common, command: "probe after", text: after });
  assert.ok(result);
  assert.match(result.output, /10s/);
  assert.match(result.output, /2026-07-28T11:00:00Z/);
  assert.doesNotMatch(result.output, /no new semantic lines/);
  assert.equal(core.loadCapsule(result.capsule_id).text, after);
});

test("Terminal Lattice orders mixed duration and size units by their real magnitude", () => {
  assert.ok(
    terminalGenome.comparableMeasurement("2MB", "size") >
    terminalGenome.comparableMeasurement("900KB", "size")
  );
  assert.ok(
    terminalGenome.comparableMeasurement("2s", "dur") >
    terminalGenome.comparableMeasurement("900ms", "dur")
  );
  const text = Array.from({ length: 80 }, (_, index) =>
    "asset " + index + " copied " + (index % 2 ? "900KB" : "2MB") +
    " in " + (index % 2 ? "900ms" : "2s")
  ).join("\n");
  const result = terminalGenome.project({
    session_id: "terminal-units-" + process.pid + "-" + Date.now(),
    cwd: process.cwd(),
    command: "copy audit",
    text,
    success: true,
  });
  assert.ok(result);
  assert.match(result.output, /size1=900KB\.\.2MB/);
  assert.match(result.output, /dur1=900ms\.\.2s/);
});

test("Terminal Lattice reports only actually hidden unique lines", () => {
  const structured = Array.from({ length: 100 }, (_, index) =>
    "built dist/module-" + String(index).padStart(4, "0") + ".js"
  );
  const unique = Array.from({ length: 40 }, (_, index) =>
    String.fromCharCode(71 + (index % 20)).repeat(36 + index)
  );
  const result = terminalGenome.project({
    session_id: "terminal-hidden-count-" + process.pid + "-" + Date.now(),
    cwd: process.cwd(),
    command: "build",
    text: [...structured, ...unique].join("\n"),
    success: true,
  });
  assert.ok(result);
  assert.match(result.output, /\+ … 16 other unique lines in exact capsule/);
});

test("native terminal hook preserves literal benchmark evidence and failed output", () => {
  const structured = Array.from({ length: 100 }, (_, index) =>
    "sample " + index + " latency " + (index + 1) + "ms"
  ).join("\n");
  const base = {
    tool_name: "shell_command",
    cwd: process.cwd(),
    session_id: "terminal-literal-" + process.pid + "-" + Date.now(),
    tool_input: { command: "benchmark latency --full-output" },
  };
  const literal = hook.handle("posttooluse", { ...base, tool_output: structured });
  assert.equal(replacementText(literal), undefined);
  const failed = hook.handle("posttooluse", {
    ...base,
    tool_input: { command: "ordinary command" },
    tool_output: "Exit code: 2\n" + structured,
  });
  assert.equal(replacementText(failed), undefined);
});

test("native terminal hook recognizes PowerShell, pwsh, cmd, zsh, fish, and sh aliases", () => {
  const text = Array.from({ length: 100 }, (_, index) =>
    "listed src/module-" + String(index).padStart(4, "0") + ".js size " + (index + 1) + "KB"
  ).join("\n");
  for (const toolName of ["powershell", "pwsh", "cmd", "zsh", "fish", "sh"]) {
    const result = hook.handle("posttooluse", {
      tool_name: toolName,
      cwd: process.cwd(),
      session_id: "terminal-alias-" + toolName + "-" + process.pid + "-" + Date.now(),
      tool_input: { command: "list artifacts" },
      tool_output: text,
    });
    const replacement = replacementText(result) || "";
    assert.match(replacement, /terminal lattice/);
    const capsuleId = replacement.match(/exact=(cap_[0-9a-f]+)/)?.[1];
    assert.ok(capsuleId);
    assert.equal(core.loadCapsule(capsuleId).text, text);
  }
});

test("Terminal codec guardrail matrix covers literal, state, atom, and budget edges", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-guardrail-"));
  const structured = Array.from({ length: 80 }, (_, index) =>
    "built src/module-" + String(index).padStart(4, "0") + ".js in " + (index + 1) + "ms"
  ).join("\n");
  try {
    assert.equal(terminalGenome.stateFile({}), "");
    assert.equal(terminalGenome.reset({}), false);
    assert.equal(terminalGenome.project({ text: structured, success: false }), null);
    assert.equal(terminalGenome.project({ text: structured, success: true, require_literal: true }), null);
    assert.equal(terminalGenome.project({ text: "small", success: true }), null);
    assert.equal(terminalGenome.project({ text: "[Capsule already compact] " + "x".repeat(200), success: true }), null);
    assert.equal(terminalGenome.project({ text: "\n".repeat(30_001), success: true }), null);
    assert.equal(terminalGenome.project({ text: "x".repeat(2_000_001), success: true }), null);

    const noSession = terminalGenome.project({
      cwd: root,
      command: "build",
      text: structured,
      success: true,
    });
    assert.equal(noSession.mode, "lattice");

    const stateArgs = { session_id: "guardrail-state", cwd: root };
    const stateFile = terminalGenome.stateFile(stateArgs);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, "{not-json", "utf8");
    const recovered = terminalGenome.project({
      ...stateArgs,
      command: "build",
      text: structured,
      success: true,
    });
    assert.equal(recovered.mode, "lattice");
    assert.equal(terminalGenome.reset(stateArgs), true);

    const priorGenome = process.env.CAPSULE_TERMINAL_GENOME;
    const priorLattice = process.env.CAPSULE_TERMINAL_LATTICE;
    try {
      process.env.CAPSULE_TERMINAL_GENOME = "0";
      assert.equal(terminalGenome.project({ text: structured, success: true }), null);
      delete process.env.CAPSULE_TERMINAL_GENOME;
      process.env.CAPSULE_TERMINAL_LATTICE = "0";
      assert.equal(terminalGenome.project({
        session_id: "lattice-off",
        cwd: root,
        text: structured,
        success: true,
      }), null);
    } finally {
      if (priorGenome === undefined) delete process.env.CAPSULE_TERMINAL_GENOME;
      else process.env.CAPSULE_TERMINAL_GENOME = priorGenome;
      if (priorLattice === undefined) delete process.env.CAPSULE_TERMINAL_LATTICE;
      else process.env.CAPSULE_TERMINAL_LATTICE = priorLattice;
    }

    const atoms = terminalGenome.structuralLine(
      "https://example.test/a C:\\tmp\\a.txt 2026-07-28T10:00:00Z " +
      "123e4567-e89b-12d3-a456-426614174000 abcdef123456 v1.2.3 9ms 2MiB 50% 7"
    );
    assert.deepEqual(
      atoms.fields.map((field) => field.type),
      ["url", "path", "time", "uuid", "id", "ver", "dur", "size", "pct", "n"]
    );
    assert.equal(terminalGenome.semanticLine("\u001b[31mred\u001b[0m   "), "red");
    assert.equal(terminalGenome.comparableMeasurement("not-a-size", "size"), null);
    assert.equal(terminalGenome.comparableMeasurement("1q", "size"), null);
    assert.equal(terminalGenome.comparableMeasurement("2", "unknown"), null);
    assert.equal(terminalGenome.comparableMeasurement("50%", "pct"), 50);
    assert.equal(terminalGenome.comparableMeasurement("2", "n"), 2);
    assert.equal(terminalGenome.comparableMeasurement("1KiB", "size"), 1024);

    const longLiteral = "long-template-segment ".repeat(18);
    const manyFields = Array.from({ length: 60 }, (_, index) =>
      longLiteral + " a " + index + " b " + (index + 1) + " c " + (index + 2) +
      " d " + (index + 3) + " e " + (index + 4) + " f " + (index + 5) +
      " g " + (index + 6)
    ).join("\n");
    const longResult = terminalGenome.project({
      session_id: "long-fields",
      cwd: root,
      command: "long output",
      text: manyFields,
      success: true,
    });
    assert.ok(longResult);
    assert.match(longResult.output, /…/);
    assert.match(longResult.output, /\+1 fields/);

    const shared = Array.from({ length: 100 }, (_, index) =>
      "stable shared row " + index
    ).join("\n");
    const warm = { session_id: "critical-heavy-warm", cwd: root, success: true };
    terminalGenome.project({ ...warm, command: "first", text: shared });
    const warnings = Array.from({ length: 17 }, (_, index) =>
      "warning: distinct retained issue " + index
    ).join("\n");
    assert.equal(
      terminalGenome.project({ ...warm, command: "second", text: shared + "\n" + warnings }),
      null
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("thread reads keep decisions while projecting away tool arguments and outputs", () => {
  const hiddenArgument = `THREAD-ARGUMENT-MUST-STAY-OUT-${"x".repeat(120_000)}`;
  const threadOutput = JSON.stringify({
    schemaVersion: 1,
    thread: {
      id: "thread-projection-example",
      kind: "codex",
      title: "Checkout audit",
      status: { type: "idle" },
    },
    page: { order: "newest_first", limit: 5, nextCursor: "older-page", hasMore: true },
    turns: [{
      id: "turn-1",
      status: "completed",
      durationMs: 1234,
      items: [
        { type: "userMessage", content: [{ type: "text", text: "Audit the checkout flow." }] },
        { type: "reasoning", summary: ["Inspect payment state transitions"] },
        {
          type: "mcpToolCall",
          server: "node_repl",
          tool: "js",
          status: "completed",
          arguments: { code: hiddenArgument },
          output: hiddenArgument,
        },
        { type: "agentMessage", phase: "final_answer", text: "Found three reproducible defects." },
      ],
    }],
  });
  const result = hook.handle("posttooluse", {
    tool_name: "codex_app.read_thread",
    tool_input: { threadId: "thread-projection-example", includeOutputs: false },
    tool_output: threadOutput,
    cwd: process.cwd(),
    session_id: `thread-projection-${process.pid}-${Date.now()}`,
  });
  const projected = replacementText(result);
  assert.match(projected, /thread projection/i);
  assert.match(projected, /Audit the checkout flow/);
  assert.match(projected, /Found three reproducible defects/);
  assert.match(projected, /node_repl\.js/);
  assert.doesNotMatch(projected, /THREAD-ARGUMENT-MUST-STAY-OUT/);
  assert.ok(projected.length < 5_000);
});

test("thread reads are page-bounded before execution unless exact outputs are requested", () => {
  const original = {
    threadId: "thread-preflight-example",
    turnLimit: 200,
    maxOutputCharsPerItem: 100_000,
  };
  const bounded = hook.handle("pretooluse", {
    tool_name: "codex_app.read_thread",
    tool_input: original,
    cwd: process.cwd(),
    session_id: "thread-preflight",
  });
  assert.deepEqual(bounded.hookSpecificOutput.updatedInput, {
    threadId: "thread-preflight-example",
    turnLimit: 8,
    maxOutputCharsPerItem: 800,
    includeOutputs: false,
  });
  assert.equal(original.turnLimit, 200);

  const exact = hook.handle("pretooluse", {
    tool_name: "codex_app.read_thread",
    tool_input: { ...original, includeOutputs: true },
    cwd: process.cwd(),
    session_id: "thread-preflight",
  });
  assert.deepEqual(exact, {});
});

test("task-history projection also finds thread results nested inside an orchestrator response", () => {
  const hidden = `NESTED-TOOL-ARG-${"z".repeat(50_000)}`;
  const thread = {
    thread: { id: "nested-thread", title: "Nested history", status: { type: "idle" } },
    page: { hasMore: false },
    turns: [{
      id: "nested-turn",
      status: "completed",
      items: [
        { type: "userMessage", text: "Keep the nested decision." },
        { type: "mcpToolCall", server: "functions", tool: "exec", arguments: { code: hidden }, output: hidden },
        { type: "agentMessage", phase: "final_answer", text: "Nested decision retained." },
      ],
    }],
  };
  const nested = hook.handle("posttooluse", {
    tool_name: "functions.exec",
    tool_input: { code: "read several tasks" },
    tool_output: { result: JSON.stringify(thread) },
    cwd: process.cwd(),
    session_id: `nested-thread-${process.pid}-${Date.now()}`,
  });
  const projected = replacementText(nested);
  assert.match(projected, /Keep the nested decision/);
  assert.match(projected, /Nested decision retained/);
  assert.doesNotMatch(projected, /NESTED-TOOL-ARG/);
});

test("read-only tools replace an exact repeated text result with a compact reference", () => {
  const session = `text-replay-${process.pid}-${Date.now()}`;
  const input = {
    tool_name: "workspace.read_file",
    tool_input: { path: path.join(os.tmpdir(), "large-evidence.txt") },
    tool_output: `${"stable evidence line\n".repeat(4_000)}TEXT-REPLAY-TAIL`,
    cwd: process.cwd(),
    session_id: session,
  };
  hook.handle("posttooluse", input);
  const repeated = hook.handle("posttooluse", input);
  const replacement = replacementText(repeated);
  assert.match(replacement, /Capsule replay|tool replay|exact duplicate read-only/i);
  assert.doesNotMatch(replacement, /TEXT-REPLAY-TAIL/);
  assert.ok(replacement.length < 500);
});

test("tool replay never hides changed evidence or mutating tool results", () => {
  const session = `text-replay-safety-${process.pid}-${Date.now()}`;
  const base = {
    tool_name: "workspace.read_file",
    tool_input: { path: path.join(os.tmpdir(), "changing-evidence.txt") },
    cwd: process.cwd(),
    session_id: session,
  };
  hook.handle("posttooluse", { ...base, tool_output: `${"A".repeat(6_000)}-V1` });
  const changed = hook.handle("posttooluse", { ...base, tool_output: `${"A".repeat(6_000)}-V2` });
  assert.doesNotMatch(replacementText(changed) || "", /tool replay/i);

  const mutation = {
    ...base,
    tool_name: "workspace.write_file",
    tool_input: { path: path.join(os.tmpdir(), "write-target.txt") },
    tool_output: `${"write completed ".repeat(600)}MUTATION-EVIDENCE`,
  };
  hook.handle("posttooluse", mutation);
  const repeatedMutation = hook.handle("posttooluse", mutation);
  assert.doesNotMatch(replacementText(repeatedMutation) || "", /tool replay/i);
});

test("a new user prompt keeps exact text replay available inside the same task", () => {
  const session = `text-replay-reset-${process.pid}-${Date.now()}`;
  const input = {
    tool_name: "workspace.read_file",
    tool_input: { path: path.join(os.tmpdir(), "cross-turn-evidence.txt") },
    tool_output: `${"cross-turn evidence\n".repeat(500)}TAIL`,
    cwd: process.cwd(),
    session_id: session,
  };
  hook.handle("posttooluse", input);
  hook.handle("userpromptsubmit", {
    prompt: "Read it again because this is a new user turn.",
    cwd: process.cwd(),
    session_id: session,
  });
  const nextTurn = hook.handle("posttooluse", input);
  assert.match(replacementText(nextTurn) || "", /Capsule replay/i);
});

test("identical evidence is reused across different read-only tool identities", () => {
  const session = `cross-tool-replay-${process.pid}-${Date.now()}`;
  const output = `${"shared immutable evidence\n".repeat(600)}CROSS-TOOL-TAIL`;
  hook.handle("posttooluse", {
    tool_name: "workspace.read_file",
    tool_input: { path: path.join(os.tmpdir(), "cross-tool.txt") },
    tool_output: output,
    cwd: process.cwd(),
    session_id: session,
  });
  const repeated = hook.handle("posttooluse", {
    tool_name: "repository.get_file",
    tool_input: { path: "cross-tool.txt" },
    tool_output: output,
    cwd: process.cwd(),
    session_id: session,
  });
  assert.match(replacementText(repeated) || "", /Capsule replay/i);
});

test("near-identical read output becomes an exact delta instead of another full payload", () => {
  const session = `delta-replay-${process.pid}-${Date.now()}`;
  const base = {
    tool_name: "workspace.read_file",
    tool_input: { path: path.join(os.tmpdir(), "delta-evidence.txt") },
    cwd: process.cwd(),
    session_id: session,
  };
  const stable = Array.from({ length: 420 }, (_, index) => `stable source line ${index}`);
  const before = [...stable, "Tests: 419 passed, 1 skipped"].join("\n");
  const after = [...stable, "Tests: 420 passed, 0 skipped"].join("\n");
  hook.handle("posttooluse", { ...base, tool_output: before });
  const changed = hook.handle("posttooluse", { ...base, tool_output: after });
  const replacement = replacementText(changed) || "";
  assert.match(replacement, /^\[Capsule delta overlap=/);
  assert.match(replacement, /420 passed/);
  assert.doesNotMatch(replacement, /stable source line 200/);
  assert.ok(replacement.length < after.length * 0.1);
  const exactId = replacement.match(/exact=(cap_[a-f0-9]{16})/i)?.[1];
  assert.ok(exactId);
  assert.equal(core.loadCapsule(exactId).text, after);
});

test("delta replay refuses low-overlap and error results", () => {
  const session = `delta-safety-${process.pid}-${Date.now()}`;
  const base = {
    tool_name: "workspace.read_file",
    tool_input: { path: path.join(os.tmpdir(), "delta-safety.txt") },
    cwd: process.cwd(),
    session_id: session,
  };
  const before = Array.from({ length: 300 }, (_, index) => `alpha evidence ${index}`).join("\n");
  const unrelated = Array.from({ length: 300 }, (_, index) => `omega replacement ${index}`).join("\n");
  hook.handle("posttooluse", { ...base, tool_output: before });
  const lowOverlap = hook.handle("posttooluse", { ...base, tool_output: unrelated });
  assert.doesNotMatch(replacementText(lowOverlap) || "", /Capsule delta/i);

  const mostlySame = `${unrelated}\nnew failure`;
  const errored = hook.handle("posttooluse", {
    ...base,
    tool_output: mostlySame,
    is_error: true,
  });
  assert.doesNotMatch(replacementText(errored) || "", /Capsule delta/i);
});

test("delta replay accepts observational shell output but excludes mutation commands", () => {
  const stable = Array.from({ length: 360 }, (_, index) => `test file ${index}: passed`);
  const before = [...stable, "Tests: 360 passed, 1 skipped"].join("\n");
  const after = [...stable, "Tests: 361 passed, 0 skipped"].join("\n");
  const observational = {
    tool_name: "shell_command",
    tool_input: { command: "npm test" },
    cwd: process.cwd(),
    session_id: `delta-shell-${process.pid}-${Date.now()}`,
  };
  hook.handle("posttooluse", { ...observational, tool_output: before });
  const delta = hook.handle("posttooluse", { ...observational, tool_output: after });
  assert.match(replacementText(delta) || "", /Capsule delta/i);

  const mutation = {
    ...observational,
    tool_input: { command: "Remove-Item -LiteralPath target.txt" },
    session_id: `delta-mutation-${process.pid}-${Date.now()}`,
  };
  hook.handle("posttooluse", { ...mutation, tool_output: before });
  const full = hook.handle("posttooluse", { ...mutation, tool_output: after });
  assert.doesNotMatch(replacementText(full) || "", /Capsule delta/i);
});

test("compaction retains only capsule-backed exact text replay", () => {
  const session = `compaction-replay-${process.pid}-${Date.now()}`;
  const input = {
    tool_name: "workspace.read_file",
    tool_input: { path: path.join(os.tmpdir(), "compacted-evidence.txt") },
    tool_output: `${"compaction evidence\n".repeat(600)}COMPACTION-TAIL`,
    cwd: process.cwd(),
    session_id: session,
  };
  hook.handle("posttooluse", input);
  hook.handle("precompact", {
    summary: "Compact the task.",
    cwd: process.cwd(),
    session_id: session,
  });
  hook.handle("sessionstart", {
    source: "compact",
    cwd: process.cwd(),
    session_id: session,
  });
  const afterCompaction = hook.handle("posttooluse", input);
  const replacement = replacementText(afterCompaction) || "";
  assert.match(replacement, /Capsule replay|tool replay|exact duplicate read-only/i);
  assert.match(replacement, /after compaction/i);
  assert.match(replacement, /cap_[a-f0-9]{16}/i);
  assert.doesNotMatch(replacement, /COMPACTION-TAIL/);
});

test("compaction does not suppress small evidence that has no exact capsule", () => {
  const session = `compaction-small-replay-${process.pid}-${Date.now()}`;
  const input = {
    tool_name: "workspace.read_file",
    tool_input: { path: path.join(os.tmpdir(), "small-compacted-evidence.txt") },
    tool_output: `${"small evidence ".repeat(100)}SMALL-TAIL`,
    cwd: process.cwd(),
    session_id: session,
  };
  hook.handle("posttooluse", input);
  hook.handle("precompact", {
    summary: "Compact the task.",
    cwd: process.cwd(),
    session_id: session,
  });
  const afterCompaction = hook.handle("posttooluse", input);
  assert.doesNotMatch(replacementText(afterCompaction) || "", /tool replay/i);
});

test("medium read evidence survives compaction as an exact replay capsule", () => {
  const session = `compaction-medium-replay-${process.pid}-${Date.now()}`;
  const input = {
    tool_name: "workspace.read_file",
    tool_input: { path: path.join(os.tmpdir(), "medium-compacted-evidence.txt") },
    tool_output: `${"medium execution evidence ".repeat(170)}MEDIUM-TAIL`,
    cwd: process.cwd(),
    session_id: session,
  };
  assert.ok(input.tool_output.length >= 3_000 && input.tool_output.length < 5_000);
  const first = hook.handle("posttooluse", input);
  assert.equal(replacementText(first), undefined);
  hook.handle("precompact", {
    summary: "Compact the task.",
    cwd: process.cwd(),
    session_id: session,
  });
  const afterCompaction = hook.handle("posttooluse", input);
  const replacement = replacementText(afterCompaction) || "";
  assert.match(replacement, /after compaction/i);
  assert.match(replacement, /cap_[a-f0-9]{16}/i);
  assert.doesNotMatch(replacement, /MEDIUM-TAIL/);
});

test("post-tool hook preserves media payloads instead of treating base64 as text", () => {
  const result = hook.handle("posttooluse", {
    tool_name: "view_image",
    tool_input: { path: path.join(os.tmpdir(), "portable-image.png") },
    tool_output: {
      content: [{
        type: "image",
        image_url: `data:image/png;base64,${Buffer.alloc(8_000, 0xab).toString("base64")}`,
      }],
    },
    cwd: process.cwd(),
    session_id: "media-preservation",
  });
  assert.deepEqual(result, {});
});

test("post-tool hook also preserves serialized media payloads", async () => {
  const before = await unified.dispatch({ action: "list", payload: { limit: 100 } });
  const beforeIds = new Set(before.response.capsules.map((item) => item.capsule_id));
  const media = JSON.stringify({
    content: [{
      type: "image",
      image_url: `data:image/png;base64,${Buffer.alloc(8_000, 0xcd).toString("base64")}`,
    }],
  });
  const result = hook.handle("posttooluse", {
    tool_name: "view_image",
    tool_input: { path: path.join(os.tmpdir(), "serialized-image.png") },
    tool_output: media,
    cwd: process.cwd(),
    session_id: "serialized-media-preservation",
  });
  assert.deepEqual(result, {});
  const after = await unified.dispatch({ action: "list", payload: { limit: 100 } });
  const newCapsules = after.response.capsules.filter((item) => !beforeIds.has(item.capsule_id));
  assert.equal(newCapsules.some((item) => item.source === "view_image"), false);
});

test("structured web hook preserves navigation through bounded projection", () => {
  const result = hook.handle("posttooluse", {
    tool_name: "web.run",
    tool_input: { search_query: [{ q: "codex token context savings" }] },
    tool_output: {
      content: Array.from({ length: 16 }, (_, index) => ({
        type: "input_text",
        ref_id: "turn0search" + index,
        url: "https://example.test/research/" + index,
        text: "search evidence " + String(index) + " ".repeat(600),
      })),
    },
    cwd: process.cwd(),
    session_id: "structured-web-" + process.pid + "-" + Date.now(),
  });
  assert.equal(result.continue, false);
  const parsed = JSON.parse(result.reason);
  assert.deepEqual(parsed.result.content.map((item) => item.ref_id),
    Array.from({ length: 16 }, (_, index) => "turn0search" + index));
  assert.deepEqual(parsed.result.content.map((item) => item.url),
    Array.from({ length: 16 }, (_, index) => "https://example.test/research/" + index));
  assert.ok(parsed.capsule_web_projection.exact);
  assert.ok(result.reason.length <= 12_000);
});

test("post-tool hook omits an exact duplicate image payload within the same user turn", () => {
  const session = `duplicate-read-${process.pid}-${Date.now()}`;
  const input = {
    tool_name: "view_image",
    tool_input: { path: path.join(os.tmpdir(), "same-image.png"), detail: "high" },
    tool_output: {
      content: [{ type: "image", image_url: "data:image/png;base64,AAAA" }],
    },
    cwd: process.cwd(),
    session_id: session,
  };
  assert.deepEqual(hook.handle("posttooluse", input), {});
  const repeated = hook.handle("posttooluse", input);
  assert.equal(repeated.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(repeated.hookSpecificOutput.additionalContext, /same|identical/i);
  assert.match(replacementText(repeated), /exact duplicate|identical/i);
  assert.doesNotMatch(replacementText(repeated), /data:image/i);
});

test("duplicate image suppression contributes conservative local gain accounting", () => {
  const session = `duplicate-gain-${process.pid}-${Date.now()}`;
  const before = compat.gain().response.avoided.chars;
  const input = {
    tool_name: "view_image",
    tool_input: { path: path.join(os.tmpdir(), "gain-image.png"), detail: "high" },
    tool_output: {
      content: [{
        type: "image",
        image_url: `data:image/png;base64,${Buffer.alloc(8_000, 0xef).toString("base64")}`,
      }],
    },
    cwd: process.cwd(),
    session_id: session,
  };
  assert.deepEqual(hook.handle("posttooluse", input), {});
  hook.handle("posttooluse", input);
  const after = compat.gain().response.avoided.chars;
  assert.ok(after - before >= 10_000);
});

test("multi-image output remains complete when any image bytes change", () => {
  const session = `multi-image-change-${process.pid}-${Date.now()}`;
  const base = {
    tool_name: "view_image",
    tool_input: { path: path.join(os.tmpdir(), "contact-sheet.png"), detail: "high" },
    cwd: process.cwd(),
    session_id: session,
  };
  const first = {
    content: [
      { type: "image", mimeType: "image/png", data: Buffer.alloc(128, 0x11).toString("base64") },
      { type: "image", mimeType: "image/png", data: Buffer.alloc(128, 0x22).toString("base64") },
    ],
  };
  const changed = {
    content: [
      { type: "image", mimeType: "image/png", data: Buffer.alloc(128, 0x11).toString("base64") },
      { type: "image", mimeType: "image/png", data: Buffer.alloc(128, 0x33).toString("base64") },
    ],
  };
  assert.deepEqual(hook.handle("posttooluse", { ...base, tool_output: first }), {});
  const result = hook.handle("posttooluse", { ...base, tool_output: changed });
  assert.equal("updatedMCPToolOutput" in result.hookSpecificOutput, false);
});

test("image output remains complete when accompanying text changes", () => {
  const session = `image-caption-change-${process.pid}-${Date.now()}`;
  const base = {
    tool_name: "view_image",
    tool_input: { path: path.join(os.tmpdir(), "captioned-image.png"), detail: "high" },
    cwd: process.cwd(),
    session_id: session,
  };
  const imageUrl = `data:image/png;base64,${Buffer.alloc(256, 0x77).toString("base64")}`;
  assert.deepEqual(hook.handle("posttooluse", {
    ...base,
    tool_output: { caption: "first reading", content: [{ type: "image", image_url: imageUrl }] },
  }), {});
  const result = hook.handle("posttooluse", {
    ...base,
    tool_output: { caption: "updated reading", content: [{ type: "image", image_url: imageUrl }] },
  });
  assert.equal("updatedMCPToolOutput" in result.hookSpecificOutput, false);
});

test("byte-identical image output is reused across different view requests in one turn", () => {
  const session = `cross-request-image-${process.pid}-${Date.now()}`;
  const toolOutput = {
    content: [{
      type: "image",
      image_url: `data:image/png;base64,${Buffer.alloc(1_024, 0x45).toString("base64")}`,
    }],
  };
  assert.deepEqual(hook.handle("posttooluse", {
    tool_name: "view_image",
    tool_input: { path: path.join(os.tmpdir(), "copy-a.png"), detail: "high" },
    tool_output: toolOutput,
    cwd: process.cwd(),
    session_id: session,
  }), {});
  const reused = hook.handle("posttooluse", {
    tool_name: "view_image",
    tool_input: { path: path.join(os.tmpdir(), "copy-b.png"), detail: "high" },
    tool_output: toolOutput,
    cwd: process.cwd(),
    session_id: session,
  });
  assert.match(replacementText(reused), /duplicate|identical/i);
});

test("escalating view_image from high to original remains a full visual result", () => {
  const session = `detail-escalation-${process.pid}-${Date.now()}`;
  const toolOutput = {
    content: [{
      type: "image",
      image_url: `data:image/png;base64,${Buffer.alloc(1_024, 0x61).toString("base64")}`,
    }],
  };
  const base = {
    tool_name: "view_image",
    tool_output: toolOutput,
    cwd: process.cwd(),
    session_id: session,
  };
  assert.deepEqual(hook.handle("posttooluse", {
    ...base,
    tool_input: { path: path.join(os.tmpdir(), "detail.png"), detail: "high" },
  }), {});
  const original = hook.handle("posttooluse", {
    ...base,
    tool_input: { path: path.join(os.tmpdir(), "detail.png"), detail: "original" },
  });
  assert.equal(replacementText(original), undefined);
});

test("a new user prompt resets visual reuse so the image is delivered again", () => {
  const session = `new-turn-image-${process.pid}-${Date.now()}`;
  const input = {
    tool_name: "view_image",
    tool_input: { path: path.join(os.tmpdir(), "next-turn.png"), detail: "high" },
    tool_output: {
      content: [{
        type: "image",
        image_url: `data:image/png;base64,${Buffer.alloc(1_024, 0x71).toString("base64")}`,
      }],
    },
    cwd: process.cwd(),
    session_id: session,
  };
  assert.deepEqual(hook.handle("posttooluse", input), {});
  assert.ok(replacementText(hook.handle("posttooluse", input)));
  hook.handle("userpromptsubmit", {
    prompt: "Inspect the image again.",
    cwd: process.cwd(),
    session_id: session,
  });
  const nextTurn = hook.handle("posttooluse", input);
  assert.equal(replacementText(nextTurn), undefined);
});

test("media replay suppression can be disabled without affecting image delivery", () => {
  const previous = process.env.CAPSULE_MEDIA_DEDUPE;
  process.env.CAPSULE_MEDIA_DEDUPE = "0";
  try {
    const input = {
      tool_name: "view_image",
      tool_input: { path: path.join(os.tmpdir(), "dedupe-disabled.png"), detail: "high" },
      tool_output: {
        content: [{
          type: "image",
          image_url: `data:image/png;base64,${Buffer.alloc(1_024, 0x72).toString("base64")}`,
        }],
      },
      cwd: process.cwd(),
      session_id: `dedupe-disabled-${process.pid}-${Date.now()}`,
    };
    hook.handle("posttooluse", input);
    const repeated = hook.handle("posttooluse", input);
    assert.equal(replacementText(repeated), undefined);
  } finally {
    if (previous == null) delete process.env.CAPSULE_MEDIA_DEDUPE;
    else process.env.CAPSULE_MEDIA_DEDUPE = previous;
  }
});

test("browser accessibility trees become compact exact-recoverable state projections", () => {
  const session = `browser-state-${process.pid}-${Date.now()}`;
  const rows = Array.from({ length: 900 }, (_, index) =>
    `  - generic "catalog row ${index}" description="repeated merchandising detail ${index}"`
  );
  const output = [
    'url: "https://shop.example.test/cart"',
    'title: "Cart"',
    '- heading "Your cart" level=1',
    '- textbox "Search products" ref=search value="" focused=true',
    '- button "Checkout" ref=checkout disabled=false',
    '- dialog "Shipping warning" ref=shipping-alert',
    'console error: inventory request status=503 failed',
    ...rows,
  ].join("\n");
  const result = hook.handle("posttooluse", {
    tool_name: "chrome.browser_snapshot",
    tool_input: { tab_id: "tab-1" },
    tool_output: output,
    cwd: process.cwd(),
    session_id: session,
  });
  const replacement = replacementText(result) || "";
  assert.match(replacement, /^\[Capsule browser-state /);
  assert.match(replacement, /https:\/\/shop\.example\.test\/cart/);
  assert.match(replacement, /Checkout/);
  assert.match(replacement, /focused=true/);
  assert.match(replacement, /status=503 failed/);
  assert.doesNotMatch(replacement, /catalog row 700/);
  assert.ok(replacement.length < output.length * 0.15);
  const exactId = replacement.match(/exact=(cap_[a-f0-9]{16})/i)?.[1];
  assert.ok(exactId);
  assert.equal(core.loadCapsule(exactId).text, output);
});

test("browser state changes use exact delta replay before projection", () => {
  const session = `browser-delta-${process.pid}-${Date.now()}`;
  const base = {
    tool_name: "browser.get_accessibility_tree",
    tool_input: { tab_id: "tab-2" },
    cwd: process.cwd(),
    session_id: session,
  };
  const stable = Array.from({ length: 420 }, (_, index) => `- link "Product ${index}" ref=p${index}`);
  const before = ['url: "https://example.test/products"', ...stable, '- button "Add" ref=add disabled=true'].join("\n");
  const after = ['url: "https://example.test/products"', ...stable, '- button "Add" ref=add disabled=false'].join("\n");
  hook.handle("posttooluse", { ...base, tool_output: before });
  const changed = replacementText(hook.handle("posttooluse", { ...base, tool_output: after })) || "";
  assert.match(changed, /^\[Capsule delta overlap=/);
  assert.match(changed, /disabled=false/);
  const exactId = changed.match(/exact=(cap_[a-f0-9]{16})/i)?.[1];
  assert.equal(core.loadCapsule(exactId).text, after);
});

test("Chrome screenshot replay omits only byte-identical complete outputs", () => {
  const session = `chrome-screenshot-${process.pid}-${Date.now()}`;
  const base = {
    tool_name: "chrome.capture_page",
    tool_input: { tab_id: "tab-3" },
    cwd: process.cwd(),
    session_id: session,
  };
  const first = {
    caption: "checkout ready",
    content: [{ type: "image", image_url: "data:image/png;base64,QUJDREVGRw==" }],
  };
  assert.deepEqual(hook.handle("posttooluse", { ...base, tool_output: first }), {});
  assert.match(
    replacementText(hook.handle("posttooluse", { ...base, tool_output: first })) || "",
    /exact duplicate/i
  );
  const changed = {
    caption: "checkout blocked",
    content: [{ type: "image", image_url: "data:image/png;base64,QUJDREVGR0g=" }],
  };
  assert.equal(replacementText(hook.handle("posttooluse", { ...base, tool_output: changed })), undefined);
});

test("browser projection preserves large minified HTML navigation evidence", () => {
  const session = `browser-html-${process.pid}-${Date.now()}`;
  const filler = "<div class=\"tile\">description</div>".repeat(1_000);
  const output = `<html><head><title>Account</title></head><body>${filler}` +
    '<a href="/billing">Billing</a><button aria-label="Save changes">Save</button></body></html>';
  const result = hook.handle("posttooluse", {
    tool_name: "playwright.get_dom",
    tool_input: { page: "account" },
    tool_output: output,
    cwd: process.cwd(),
    session_id: session,
  });
  const replacement = replacementText(result) || "";
  assert.match(replacement, /Capsule browser-state/);
  assert.match(replacement, /Billing|billing/);
  assert.match(replacement, /Save changes|Save/);
  assert.ok(replacement.length < output.length * 0.2);
});

test("browser observation budget batches read-only Node REPL calls and resets after interaction", () => {
  const session = `browser-observation-budget-${process.pid}-${Date.now()}`;
  const observation = {
    tool_name: "mcp__node_repl__js",
    tool_input: {
      code: 'var page = (await browser.pages())[0]; var title = await page.locator("h1").innerText(); nodeRepl.write(title);',
    },
    cwd: process.cwd(),
    session_id: session,
  };
  let fourth;
  for (let index = 0; index < 4; index += 1) {
    fourth = hook.handle("pretooluse", observation);
    hook.handle("posttooluse", { ...observation, tool_output: `title-${index}` });
  }
  assert.match(
    fourth.hookSpecificOutput?.additionalContext || "",
    /browser observation budget|combine independent DOM|exact-read fuse/i
  );

  const interaction = {
    ...observation,
    tool_input: { code: 'await page.locator("button").click(); nodeRepl.write("clicked");' },
  };
  hook.handle("pretooluse", interaction);
  hook.handle("posttooluse", { ...interaction, tool_output: "clicked" });
  const afterReset = hook.handle("pretooluse", observation);
  assert.doesNotMatch(
    afterReset.hookSpecificOutput?.additionalContext || "",
    /browser observation budget/i
  );
});

test("exact-read fuse warns on an identical read before long no-progress thresholds", () => {
  const session = `exact-read-fuse-${process.pid}-${Date.now()}`;
  const input = {
    tool_name: "mcp__capsule__capsule",
    tool_input: {
      action: "expand",
      payload: { capsule_id: "cap_fixture", start_line: 1, end_line: 60 },
    },
    cwd: process.cwd(),
    session_id: session,
  };
  hook.handle("pretooluse", input);
  const duplicate = hook.handle("pretooluse", input);
  assert.match(
    duplicate.hookSpecificOutput?.additionalContext || "",
    /exact-read fuse|identical read/i
  );
});

test("pre-tool hook bounds self-contained subagent context while preserving dependent forks", () => {
  const toolInput = {
    task_name: "bounded_audit",
    message: "Independently inspect C:\\work\\artifact.json for duplicate identifiers, invalid timestamps, " +
      "and missing required fields. Return a compact JSON object with counts, affected identifiers, and " +
      "the exact validation rule for every finding. Do not modify files and do not perform network calls. " +
      "This message contains the complete task, inputs, constraints, and requested output format.",
    fork_turns: "all",
  };
  const guided = hook.handle("pretooluse", {
    tool_name: "collaboration.spawn_agent",
    tool_input: toolInput,
    session_id: "fork-guidance",
  });
  assert.equal(guided.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(guided.hookSpecificOutput.updatedInput.fork_turns, "none");
  assert.equal(guided.hookSpecificOutput.updatedInput.model, "gpt-5.6-luna");
  assert.match(guided.hookSpecificOutput.additionalContext, /bounded/i);
  assert.equal(toolInput.fork_turns, "all");

  const dependent = hook.handle("pretooluse", {
    tool_name: "collaboration.spawn_agent",
    tool_input: {
      task_name: "continue_analysis",
      message: "Continue the analysis from our earlier discussion and use every decision above.",
      fork_turns: "all",
    },
    session_id: "fork-guidance",
  });
  assert.equal(dependent.hookSpecificOutput.updatedInput.model, "gpt-5.6-terra");
  assert.match(dependent.hookSpecificOutput.additionalContext, /history-dependent full subagent fork/i);

  const selfContained = hook.handle("pretooluse", {
    tool_name: "collaboration.spawn_agent",
    tool_input: {
      task_name: "run_tests",
      message: "Run npm test and report the failing test names.",
    },
    session_id: "fork-guidance",
  });
  assert.equal(selfContained.hookSpecificOutput.updatedInput.fork_turns, "none");
  assert.equal(selfContained.hookSpecificOutput.updatedInput.model, "gpt-5.6-luna");

  const recent = hook.handle("pretooluse", {
    tool_name: "collaboration.spawn_agent",
    tool_input: {
      task_name: "continue_task",
      message: "Continue this task from the previous decision.",
    },
    session_id: "fork-guidance",
  });
  assert.equal(recent.hookSpecificOutput.updatedInput.fork_turns, "3");
  assert.equal(recent.hookSpecificOutput.updatedInput.model, "gpt-5.6-luna");

  const englishIndependent = hook.handle("pretooluse", {
    tool_name: "collaboration.spawn_agent",
    tool_input: {
      task_name: "find_failed_tests",
      message: "Find the failed tests and return their names.",
      fork_turns: "all",
    },
    session_id: "fork-guidance",
  });
  assert.equal(englishIndependent.hookSpecificOutput.updatedInput.fork_turns, "none");
  assert.equal(englishIndependent.hookSpecificOutput.updatedInput.model, "gpt-5.6-luna");

  const englishFull = hook.handle("pretooluse", {
    tool_name: "collaboration.spawn_agent",
    tool_input: {
      task_name: "continue_full_history",
      message: "Use the full conversation and all previous decisions.",
      fork_turns: "all",
    },
    session_id: "fork-guidance",
  });
  assert.equal(englishFull.hookSpecificOutput.updatedInput.model, "gpt-5.6-terra");

  const explicit = hook.handle("pretooluse", {
    tool_name: "collaboration.spawn_agent",
    tool_input: { ...toolInput, fork_turns: "none" },
    session_id: "fork-guidance",
  });
  assert.equal(explicit.hookSpecificOutput.updatedInput.model, "gpt-5.6-luna");

  const alreadyBounded = hook.handle("pretooluse", {
    tool_name: "collaboration.spawn_agent",
    tool_input: {
      task_name: "already_bounded",
      message: "Run the isolated check and return its result.",
      model: "gpt-5.6-luna",
      fork_turns: "none",
    },
    session_id: "fork-guidance",
  });
  assert.equal(alreadyBounded.hookSpecificOutput?.updatedInput, undefined);
  assert.doesNotMatch(
    alreadyBounded.hookSpecificOutput?.additionalContext || "",
    /subagent model|bounded_fork|history-dependent/i
  );
});

test("automatic hooks do not persist raw user prompts without explicit opt-in", async () => {
  const previous = process.env.CAPSULE_CAPTURE_PROMPTS;
  delete process.env.CAPSULE_CAPTURE_PROMPTS;
  const secret = `PROMPT-PRIVACY-NEEDLE-${process.pid}-${Date.now()}`;
  try {
    const result = hook.handle("userpromptsubmit", {
      prompt: `Deploy the service with confidential value ${secret}`,
      cwd: process.cwd(),
      session_id: "prompt-privacy",
    });
    assert.deepEqual(result, {});
    const searched = await unified.dispatch({
      action: "search",
      payload: { query: secret, kind: "memory" },
    });
    assert.equal(
      searched.response.searches[0].results.some((item) => item.snippet.includes(secret)),
      false
    );
  } finally {
    if (previous == null) delete process.env.CAPSULE_CAPTURE_PROMPTS;
    else process.env.CAPSULE_CAPTURE_PROMPTS = previous;
  }
});

test("automatic session memories redact echoed credentials before indexing", async () => {
  const marker = `SANITIZED-MEMORY-DECISION-${process.pid}-${Date.now()}`;
  const password = "test-fixture-passphrase-91!";
  hook.handle("stop", {
    last_assistant_message: `Decision ${marker}: Capsule limits reasoning-token growth; connect to 203.0.113.42 root ${password} with api_key=SyntheticApiKey778899.`,
    cwd: process.cwd(),
    session_id: "sanitized-memory",
  });
  const searched = await unified.dispatch({
    action: "search",
    payload: { query: marker, kind: "memory", snippet_chars: 1_000 },
  });
  const rendered = JSON.stringify(searched.response.searches[0].results);
  assert.doesNotMatch(rendered, new RegExp(password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(rendered, /SyntheticApiKey778899/);
  assert.match(rendered, /\[REDACTED\]/);
  assert.match(rendered, /Capsule limits reasoning-token growth/);
});

test("doctor adapts to a user's skill catalog without changing it", async () => {
  const temporaryCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-portable-home-"));
  for (const [name, description] of [
    ["alpha-skill", "Handle alpha workflows when alpha files are provided."],
    ["beta-skill", "Handle beta workflows when beta services are requested."],
  ]) {
    const folder = path.join(temporaryCodexHome, "skills", name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "SKILL.md"), [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "---",
      "",
      `# ${name}`,
      "",
    ].join("\n"), "utf8");
  }
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = temporaryCodexHome;
  try {
    const operation = await unified.dispatch({ action: "doctor" });
    const catalog = operation.response.environment.skill_catalog;
    assert.equal(catalog.entries, 2);
    assert.ok(catalog.approx_tokens > 0);
    assert.equal(catalog.automatic_changes, false);
    assert.equal(fs.existsSync(path.join(temporaryCodexHome, "skills", "alpha-skill", "SKILL.md")), true);
  } finally {
    if (previous == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    fs.rmSync(temporaryCodexHome, { recursive: true, force: true });
  }
});

test("insight audits Codex session fan-out without reading prompt content", async () => {
  const temporaryCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-history-home-"));
  const sessions = path.join(temporaryCodexHome, "sessions", "2026", "07", "27");
  const archived = path.join(temporaryCodexHome, "archived_sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(archived, { recursive: true });
  const sessionLine = (id, parent = null) => JSON.stringify({
    timestamp: "2026-07-27T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id,
      source: parent ? { subagent: { thread_spawn: {} } } : "vscode",
      parent_thread_id: parent,
    },
  });
  fs.writeFileSync(
    path.join(sessions, "root.jsonl"),
    `${sessionLine("root-session")}\n{"secret":"HISTORY-PROMPT-MUST-NOT-BE-READ"}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(sessions, "child-a.jsonl"),
    `${sessionLine("child-a", "root-session")}\n${"A".repeat(2_000)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(archived, "child-b.jsonl"),
    `${sessionLine("child-b", "root-session")}\n${"B".repeat(3_000)}\n`,
    "utf8"
  );
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = temporaryCodexHome;
  try {
    const operation = await unified.dispatch({ action: "insight", payload: { history: true } });
    const history = operation.response.history;
    assert.equal(history.sessions.total, 3);
    assert.equal(history.sessions.root, 1);
    assert.equal(history.sessions.subagent, 2);
    assert.ok(history.bytes.subagent > history.bytes.root);
    assert.equal(history.parent_fanout[0].children, 2);
    assert.equal(history.content_read, false);
    assert.doesNotMatch(JSON.stringify(history), /HISTORY-PROMPT-MUST-NOT-BE-READ/);
  } finally {
    if (previous == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    fs.rmSync(temporaryCodexHome, { recursive: true, force: true });
  }
});

test("run executes Windows command shims without interpolating arguments into shell text", {
  skip: process.platform !== "win32",
}, async () => {
  const shimRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-windows-shim-"));
  fs.writeFileSync(
    path.join(shimRoot, "portable-tool.cmd"),
    "@ECHO OFF\r\nECHO PORTABLE-CMD:%~1\r\n",
    "utf8"
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${shimRoot}${path.delimiter}${previousPath || ""}`;
  try {
    const operation = await unified.dispatch({
      action: "run",
      payload: {
        command: "portable-tool",
        args: ["hello world"],
        query: "PORTABLE CMD",
      },
    });
    assert.match(operation.response.output, /PORTABLE-CMD:hello world/);
    assert.equal(operation.response.exit_code, 0);
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(shimRoot, { recursive: true, force: true });
  }
});

test("run prefers PATHEXT shims over same-name extensionless Windows files", {
  skip: process.platform !== "win32",
}, async () => {
  const shimRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-windows-pathext-"));
  fs.writeFileSync(path.join(shimRoot, "portable-priority"), "not directly executable", "utf8");
  fs.writeFileSync(
    path.join(shimRoot, "portable-priority.cmd"),
    "@ECHO OFF\r\nECHO PATHEXT-PRIORITY\r\n",
    "utf8"
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${shimRoot}${path.delimiter}${previousPath || ""}`;
  try {
    const operation = await unified.dispatch({
      action: "run",
      payload: {
        command: "portable-priority",
        query: "PATHEXT PRIORITY",
      },
    });
    assert.match(operation.response.output, /PATHEXT-PRIORITY/);
    assert.equal(operation.response.exit_code, 0);
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(shimRoot, { recursive: true, force: true });
  }
});

test("batch auto-indexes output and answers inline queries", async () => {
  const operation = await unified.dispatch({
    action: "batch",
    payload: {
      commands: [{
        label: "inline answer",
        command: process.execPath,
        args: ["-e", "console.log('BATCH-INLINE-SEARCH-NEEDLE')"],
      }],
      queries: ["BATCH INLINE SEARCH NEEDLE"],
    },
  });
  assert.equal(operation.response.searches.length, 1);
  assert.match(operation.response.searches[0].results[0].snippet, /BATCH-INLINE-SEARCH-NEEDLE/);
});

test("execute derives from code and files while preserving exact output", async () => {
  const direct = await unified.dispatch({
    action: "execute",
    payload: { language: "javascript", code: "console.log('EXECUTE-DIRECT-NEEDLE')" },
  });
  assert.match(direct.responseText || direct.response.output, /EXECUTE-DIRECT-NEEDLE/);

  const file = path.join(os.tmpdir(), `capsule-execute-${process.pid}.txt`);
  fs.writeFileSync(file, "alpha\nFILE-DERIVATION-NEEDLE\nomega", "utf8");
  const derived = await unified.dispatch({
    action: "execute",
    payload: {
      language: "javascript",
      path: file,
      code: "console.log(FILE_CONTENT.split(/\\r?\\n/).filter(line => line.includes('NEEDLE')).join('\\n'))",
    },
  });
  assert.match(derived.responseText || derived.response.output, /FILE-DERIVATION-NEEDLE/);
  fs.unlinkSync(file);
});

test("fetch batches requests, normalizes HTML, and honors the TTL cache", async () => {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<html><body><h1>Cached heading</h1><p>FETCH-CACHE-NEEDLE</p></body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/page`;
  try {
    const first = await unified.dispatch({ action: "fetch", payload: { url, ttl_ms: 60_000 } });
    const second = await unified.dispatch({ action: "fetch", payload: { url, ttl_ms: 60_000 } });
    assert.equal(first.response.results[0].cached, false);
    assert.equal(second.response.results[0].cached, true);
    assert.equal(requests, 1);
    const searched = await unified.dispatch({ action: "search", payload: { query: "FETCH CACHE NEEDLE", kind: "fetch" } });
    assert.match(searched.response.searches[0].results[0].snippet, /FETCH-CACHE-NEEDLE/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("automatic hooks wrap large shell commands and preserve unrelated hooks on install", () => {
  hook.handle("stop", {
    last_assistant_message: "Decision: use the HOOK-SESSION-SAPPHIRE-LANE.",
    cwd: process.cwd(),
    session_id: "parity-session",
  });
  const resumed = hook.handle("sessionstart", {
    cwd: process.cwd(),
    session_id: "parity-session-next",
  });
  assert.equal(resumed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(resumed.hookSpecificOutput.additionalContext, /HOOK-SESSION-SAPPHIRE-LANE/);

  const pre = hook.handle("pretooluse", {
    tool_name: "shell_command",
    tool_input: { command: "git diff" },
    cwd: process.cwd(),
    session_id: "parity-session",
  });
  assert.equal(pre.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(pre.hookSpecificOutput.updatedInput.command, /scripts[\\/]cli\.cjs/);

  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-codex-home-"));
  fs.writeFileSync(path.join(temporaryHome, "hooks.json"), JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: "x", hooks: [{ type: "command", command: "keep-me" }] },
      ],
    },
  }), "utf8");
  const previous = process.env.CODEX_HOME;
  const previousPluginHooksFeature = process.env.CAPSULE_PLUGIN_HOOKS_FEATURE;
  process.env.CODEX_HOME = temporaryHome;
  process.env.CAPSULE_PLUGIN_HOOKS_FEATURE = "0";
  try {
    hookInstaller.install();
    const installed = JSON.parse(fs.readFileSync(path.join(temporaryHome, "hooks.json"), "utf8"));
    const commands = Object.values(installed.hooks).flatMap((entries) =>
      entries.flatMap((entry) => entry.hooks.map((item) => item.command))
    );
    assert.ok(commands.includes("keep-me"));
    assert.equal(commands.filter((command) => /capsule-hook\.cjs/.test(command)).length, 6);
    const launcherPath = path.join(temporaryHome, "capsule-hook.cjs");
    const pointerPath = path.join(temporaryHome, "capsule-hook-target.json");
    assert.equal(fs.existsSync(launcherPath), true);
    assert.equal(fs.existsSync(pointerPath), true);
    const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
    assert.match(pointer.script, /scripts[\\/]hook\.cjs/);
    assert.match(fs.readFileSync(launcherPath, "utf8"), /hook\.main\(\)/);
    const launched = spawnSync(process.execPath, [launcherPath, "userpromptsubmit"], {
      input: JSON.stringify({
        prompt: "stable launcher canary",
        cwd: process.cwd(),
        session_id: `stable-launcher-${process.pid}`,
      }),
      encoding: "utf8",
      env: { ...process.env, CAPSULE_COGNITION: "0" },
      windowsHide: true,
    });
    assert.equal(launched.status, 0);
    assert.doesNotThrow(() => JSON.parse(launched.stdout));
    const preToolMatchers = installed.hooks.PreToolUse.map((entry) => entry.matcher).join("|");
    assert.match(preToolMatchers, /spawn_agent|collaboration/i);
    const duplicated = hookInstaller.status();
    assert.equal(duplicated.plugin_hooks_feature.enabled, false);
    assert.equal(duplicated.duplicate_event_sources.length, 0);
    assert.equal(Object.values(duplicated.configured_events).every(Boolean), true);
    assert.equal(typeof duplicated.observed_events.PostToolUse, "boolean");
    assert.equal(Object.entries(duplicated.events).every(
      ([name, value]) => value === (duplicated.configured_events[name] && duplicated.observed_events[name])
    ), true);
    const removed = hookInstaller.removeGlobal();
    assert.equal(removed.removed_entries, 6);
    const cleaned = JSON.parse(fs.readFileSync(path.join(temporaryHome, "hooks.json"), "utf8"));
    const remainingCommands = Object.values(cleaned.hooks).flatMap((entries) =>
      entries.flatMap((entry) => entry.hooks.map((item) => item.command))
    );
    assert.deepEqual(remainingCommands, ["keep-me"]);
    const bundledOnly = hookInstaller.status();
    assert.equal(bundledOnly.duplicate_event_sources.length, 0);
    assert.equal(Object.values(bundledOnly.events).every(Boolean), false);
    process.env.CAPSULE_PLUGIN_HOOKS_FEATURE = "1";
    const supportedBundle = hookInstaller.status();
    assert.equal(Object.values(supportedBundle.configured_events).every(Boolean), true);
    assert.equal(Object.entries(supportedBundle.events).every(
      ([name, value]) => value === (supportedBundle.configured_events[name] && supportedBundle.observed_events[name])
    ), true);
  } finally {
    if (previous == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    if (previousPluginHooksFeature == null) delete process.env.CAPSULE_PLUGIN_HOOKS_FEATURE;
    else process.env.CAPSULE_PLUGIN_HOOKS_FEATURE = previousPluginHooksFeature;
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  }
});

test("MCP schema is compact, discoverable, and object-only", () => {
  assert.equal(schema.length, 1);
  assert.equal(schema[0].inputSchema.properties.payload.type, "object");
  assert.ok(
    JSON.stringify({ tools: schema, instructions: schema.instructions }).length < 500,
    "the deferred always-visible MCP contract should stay below 500 characters"
  );
  for (const action of ["project", "execute", "cognition", "jobs", "gain", "discover", "insight", "skills", "purge"]) {
    assert.ok(schema.actions.includes(action));
  }
  assert.equal(schema[0].inputSchema.properties.action.enum, undefined);
});

test("structured web projection preserves navigation identities and archives exact results", () => {
  const long = (label) => [
    `${label} head`,
    "The query-relevant needle appears in this result.",
    "x".repeat(5_200),
    `${label} tail`,
  ].join("\n");
  const raw = {
    content: [
      {
        type: "search_result",
        title: "First result",
        source: "primary",
        url: "https://example.test/first",
        ref_id: "turn-web-1",
        text: long("first"),
      },
      {
        type: "search_result",
        title: "Second result",
        source: "primary",
        url: "https://example.test/second",
        reference_id: "turn-web-2",
        text: long("second"),
      },
    ],
  };
  const exact = JSON.stringify(raw, null, 2);
  const replacement = hook.structuredWebProjection(raw, { query: "needle" }, "web.run");
  assert.ok(replacement.length < exact.length * 0.5, "projection should materially reduce the result");
  const parsed = JSON.parse(replacement);
  assert.equal(parsed.result.content.length, 2);
  assert.deepEqual(parsed.result.content.map((item) => item.type), ["search_result", "search_result"]);
  assert.deepEqual(parsed.result.content.map((item) => item.url), [
    "https://example.test/first",
    "https://example.test/second",
  ]);
  assert.equal(parsed.result.content[0].ref_id, "turn-web-1");
  assert.equal(parsed.result.content[1].reference_id, "turn-web-2");
  assert.deepEqual(parsed.result.content.map((item) => item.title), ["First result", "Second result"]);
  assert.deepEqual(parsed.result.content.map((item) => item.source), ["primary", "primary"]);
  assert.match(parsed.result.content[0].text, /needle/);
  assert.ok(parsed.capsule_web_projection.truncated_fields >= 2);
  assert.ok(parsed.capsule_web_projection.omitted_chars > 0);
  assert.match(parsed.capsule_web_projection.exact, /^cap_/);
  assert.equal(core.loadCapsule(parsed.capsule_web_projection.exact).text, exact);
});




test("structured web projection finds nested query terms and preserves buried navigation", () => {
  const buriedUrl = "https://example.test/deep/evidence?item=42";
  const buriedRef = "turn7search42";
  const buriedRedditRef = "turn7reddit43";
  const raw = {
    content: [{
      type: "search_result",
      id: 73,
      title: "Deep evidence",
      source: "primary",
      text: [
        "prefix",
        "a".repeat(4_000),
        "Deep Nested Needle is the query-relevant evidence.",
        `buried navigation ${buriedUrl}, ${buriedRef}, and ${buriedRedditRef}`,
        "z".repeat(4_000),
      ].join("\n"),
    }],
  };
  const exact = JSON.stringify(raw, null, 2);
  const replacement = hook.structuredWebProjection(raw, {
    tool_input: { requests: [{ search_query: [{ q: "deep nested needle" }] }] },
  }, "web.run");
  assert.ok(replacement, "nested query projection should activate");
  assert.ok(replacement.length <= 12_000, "projection must remain globally bounded");
  const parsed = JSON.parse(replacement);
  assert.equal(parsed.result.content[0].id, 73);
  assert.equal(parsed.result.content[0].title, "Deep evidence");
  assert.match(parsed.result.content[0].text, /Deep Nested Needle/);
  assert.deepEqual(
    parsed.capsule_web_projection.navigation.sort(),
    [buriedRef, buriedRedditRef, buriedUrl].sort()
  );
  assert.match(parsed.capsule_web_projection.exact, /^cap_/);
  assert.equal(core.loadCapsule(parsed.capsule_web_projection.exact).text, exact);
});

test("structured web projection safely passes through an excessive navigation inventory", () => {
  const raw = {
    content: [{
      type: "search_result",
      title: "Excessive navigation",
      text: Array.from({ length: 257 }, (_, index) =>
        `https://example.test/navigation/${index}`).join(" ") + "x".repeat(5_000),
    }],
  };
  assert.equal(hook.structuredWebProjection(raw, {
    tool_input: { search_query: [{ q: "navigation" }] },
  }, "web.run"), "");
});

test("structured web projection permits bounded minification-only savings", () => {
  const raw = {
    content: Array.from({ length: 72 }, (_, index) => ({
      type: "search_result",
      id: index,
      title: `Result ${index}`,
      source: "primary",
      text: `short stable evidence ${index}`,
    })),
  };
  const exact = JSON.stringify(raw, null, 2);
  const replacement = hook.structuredWebProjection(raw, {
    tool_input: { search_query: [{ q: "stable evidence" }] },
  }, "web.run");
  assert.ok(replacement, "safe minification-only savings should activate");
  assert.ok(replacement.length <= 12_000);
  assert.ok(replacement.length + Math.max(512, Math.ceil(exact.length * 0.05)) <= exact.length);
  const parsed = JSON.parse(replacement);
  assert.equal(parsed.capsule_web_projection.truncated_fields, 0);
  assert.equal(parsed.result.content.length, 72);
  assert.deepEqual(parsed.result.content.map((item) => item.id),
    Array.from({ length: 72 }, (_, index) => index));
});


test("structured web projection tightens the leaf budget for very large results", () => {
  const raw = {
    content: [{
      type: "search_result",
      title: "Very large result",
      text: `head\n${"x".repeat(100_000)}\ntail`,
    }],
  };
  const replacement = hook.structuredWebProjection(raw, {
    tool_input: { search_query: [{ q: "large result" }] },
  }, "web.run");
  assert.ok(replacement);
  assert.ok(replacement.length <= 12_000);
  const parsed = JSON.parse(replacement);
  assert.equal(parsed.capsule_web_projection.leaf_chars, 220);
  assert.match(parsed.result.content[0].text, /\[Capsule web text truncated;/);
});


test("structured web projection treats __proto__ as data and preserves its navigation fidelity", () => {
  delete Object.prototype.polluted;
  const raw = Object.create(null);
  raw.__proto__ = {
    url: "https://lost.test/navigation",
    ref_id: "turn42reddit7",
    polluted: true,
    body: "x".repeat(5_000),
  };
  raw.content = "y".repeat(5_000);
  const replacement = hook.structuredWebProjection(raw, {
    tool_input: { search_query: [{ q: "navigation" }] },
    session_id: `web-proto-${process.pid}-${Date.now()}`,
    cwd: process.cwd(),
  }, "web.run");
  assert.ok(replacement);
  const projected = JSON.parse(replacement);
  assert.equal(Object.prototype.polluted, undefined);
  assert.ok(Object.hasOwn(projected.result, "__proto__"));
  assert.equal(projected.result.__proto__.url, "https://lost.test/navigation");
  assert.equal(projected.result.__proto__.ref_id, "turn42reddit7");
  assert.match(replacement, /https:\/\/lost\.test\/navigation/);
  assert.match(replacement, /turn42reddit7/);
  const capsuleId = projected.capsule_web_projection.exact;
  assert.match(capsuleId, /^cap_[a-f0-9]{16}$/);
  const exact = core.loadCapsule(capsuleId).text;
  assert.match(exact, /https:\/\/lost\.test\/navigation/);
  assert.match(exact, /turn42reddit7/);
});
