"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-unified-state-"));
process.env.CAPSULE_STATE = state;
const unified = require("../mcp/unified.cjs");
const core = require("../mcp/core.cjs");

function writeSessionLog(file, userSecret, assistantSecret, repetitions = 1) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const repeatedUser = userSecret.repeat(repetitions);
  const repeatedAssistant = assistantSecret.repeat(repetitions);
  const usage = (input, cached, totalInput) => ({
    timestamp: "2026-07-31T10:00:01.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: 300,
          reasoning_output_tokens: 120,
          total_tokens: input + 420,
        },
        total_token_usage: {
          input_tokens: totalInput,
          cached_input_tokens: cached,
          output_tokens: 800,
          reasoning_output_tokens: 300,
          total_tokens: totalInput + 1_100,
        },
        model_context_window: 200_000,
      },
      rate_limits: {
        primary: { used_percent: 20, window_minutes: 300, resets_at: 1234 },
        secondary: { used_percent: 5, window_minutes: 10_080, resets_at: 5678 },
      },
    },
  });
  const records = [
    {
      timestamp: "2026-07-31T10:00:00.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: repeatedUser }] },
    },
    {
      timestamp: "2026-07-31T10:00:00.500Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: repeatedAssistant }] },
    },
    usage(80_000, 72_000, 150_000),
    {
      timestamp: "2026-07-31T10:00:02.000Z",
      type: "compacted",
      payload: {
        window_number: 1,
        replacement_history: [
          { role: "user", content: repeatedUser },
          { role: "assistant", content: repeatedAssistant },
        ],
      },
    },
    { ...usage(28_000, 20_000, 178_000), timestamp: "2026-07-31T10:00:03.000Z" },
  ];
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

test.after(() => {
  unified.closeSearchDatabase();
  fs.rmSync(state, { recursive: true, force: true });
});

test("batch executes a normal executable without shell", async () => {
  const batch = await unified.batchCommands({
    commands: [{ command: process.execPath, args: ["-e", "process.stdout.write('batch-normal-ok')"] }],
  });
  assert.equal(batch.response.results[0].exit_code, 0);
  assert.match(batch.response.results[0].output, /batch-normal-ok/);
});

test("batch executes a temporary cmd file on Windows", { skip: process.platform !== "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-batch-cmd-"));
  try {
    const command = path.join(workspace, "batch-test.cmd");
    fs.writeFileSync(command, [
      "@echo off",
      "if defined CAPSULE_COMMAND exit /b 91",
      "if defined CAPSULE_COMMAND_ARGS exit /b 92",
      "echo batch-cmd-ok",
      "",
    ].join("\r\n"), "utf8");
    const batch = await unified.batchCommands({ commands: [{ command, args: [] }], index_output: false });
    assert.equal(batch.response.results[0].exit_code, 0);
    assert.match(batch.response.results[0].output, /batch-cmd-ok/);
    const metadata = core.loadCapsule(batch.response.results[0].capsule_id).metadata;
    assert.equal(metadata.details.command, command);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("diff compression preserves distinct manifest hunk ranges", () => {
  const raw = [
    "diff --git a/mcp/example.cjs b/mcp/example.cjs",
    "@@ old:153..160 new:153..161 @@",
    "+first manifest hunk",
    "@@ old:204..211 new:205..212 @@",
    "+second manifest hunk",
  ].join("\n");
  const compact = unified.compressText(raw, { profile: "diff", max_chars: 2_000 });
  assert.match(compact.output, /old:153\.\.160/);
  assert.match(compact.output, /old:204\.\.211/);
});

test("file defaults to a bounded telemetry audit for Codex session JSONL", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-session-log-guard-"));
  const sessionFile = path.join(workspace, ".codex", "sessions", "2026", "07", "31", "rollout.jsonl");
  const userSecret = "RAW-USER-TRANSCRIPT-MUST-NOT-LEAK-849217";
  const assistantSecret = "RAW-ASSISTANT-TRANSCRIPT-MUST-NOT-LEAK-315908";
  writeSessionLog(sessionFile, userSecret, assistantSecret, 4_000);
  try {
    const raw = fs.readFileSync(sessionFile, "utf8");
    const capsulesBefore = core.listCapsules({ limit: 10_000 }).response.capsules.length;
    const operation = await unified.dispatch({
      action: "file",
      payload: { path: sessionFile },
    });
    const rendered = core.renderOperation(operation);
    const capsulesAfter = core.listCapsules({ limit: 10_000 }).response.capsules.length;
    const ab = {
      raw_chars: raw.length,
      summary_chars: rendered.length,
      raw_approx_tokens: core.estimateTokens(raw),
      summary_approx_tokens: core.estimateTokens(rendered),
    };

    assert.equal(operation.route, "session-log-audit");
    assert.equal(operation.response.kind, "codex-session-log-audit");
    assert.equal(operation.response.protected_default, true);
    assert.equal(operation.response.raw_transcript_included, false);
    assert.equal(operation.response.raw_capsule_created, false);
    assert.equal(operation.response.provider_telemetry.available, true);
    assert.equal(operation.response.provider_telemetry.last_request.input_tokens, 28_000);
    assert.equal(operation.response.compaction_audit.compactions, 1);
    assert.equal(capsulesAfter, capsulesBefore, "the guard must not archive the raw session again");
    assert.match(operation.response.exact_access_hint, /mode=\"full\".*require_full=true/);
    assert.ok(rendered.length < 4_096, `audit output must stay bounded, received ${rendered.length} chars`);
    assert.ok(ab.summary_chars < ab.raw_chars * 0.02, `scenario A/B was ${JSON.stringify(ab)}`);
    assert.ok(ab.summary_approx_tokens < ab.raw_approx_tokens * 0.02, `scenario A/B was ${JSON.stringify(ab)}`);
    assert.doesNotMatch(rendered, new RegExp(userSecret));
    assert.doesNotMatch(rendered, new RegExp(assistantSecret));
    assert.equal(operation.capturedChars, fs.statSync(sessionFile).size);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("session guard follows symlink or junction targets before classification", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-session-log-link-"));
  const sessionDirectory = path.join(workspace, "protected", ".codex", "sessions");
  const sessionFile = path.join(sessionDirectory, "rollout.jsonl");
  const aliasDirectory = path.join(workspace, "ordinary-looking-alias");
  const aliasFile = path.join(aliasDirectory, "rollout.jsonl");
  const secret = "SYMLINKED-SESSION-TRANSCRIPT-MUST-NOT-LEAK-642915";
  writeSessionLog(sessionFile, secret, "assistant-safe-marker", 200);
  try {
    try {
      fs.symlinkSync(sessionDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(error?.code)) {
        t.skip(`symlink/junction creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.equal(aliasFile.includes(`${path.sep}.codex${path.sep}sessions${path.sep}`), false);
    const capsulesBefore = core.listCapsules({ limit: 10_000 }).response.capsules.length;
    const operation = await unified.dispatch({ action: "file", payload: { path: aliasFile } });
    const capsulesAfter = core.listCapsules({ limit: 10_000 }).response.capsules.length;
    const rendered = core.renderOperation(operation);
    assert.equal(operation.route, "session-log-audit");
    assert.equal(operation.response.protected_default, true);
    assert.equal(operation.response.raw_transcript_included, false);
    assert.equal(operation.response.raw_capsule_created, false);
    assert.equal(capsulesAfter, capsulesBefore);
    assert.doesNotMatch(rendered, new RegExp(secret));
    assert.match(operation.response.session_file.replace(/\\/g, "/"), /\/\.codex\/sessions\/rollout\.jsonl$/i);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("oversized session guard returns metadata without opening or archiving the log", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-session-log-oversize-"));
  const sessionFile = path.join(workspace, ".codex", "sessions", "rollout.jsonl");
  const secret = "OVERSIZED-SESSION-TRANSCRIPT-MUST-NOT-LEAK-730214";
  const auditLimit = 64 * 1024;
  const previousLimit = process.env.CAPSULE_SESSION_AUDIT_MAX_BYTES;
  writeSessionLog(sessionFile, secret, "assistant-safe-marker");
  fs.truncateSync(sessionFile, auditLimit + 1);
  process.env.CAPSULE_SESSION_AUDIT_MAX_BYTES = String(auditLimit);
  const capsulesBefore = core.listCapsules({ limit: 10_000 }).response.capsules.length;
  const originalOpenSync = fs.openSync;
  const originalReadFileSync = fs.readFileSync;
  const blockedPath = path.resolve(sessionFile);
  const isBlocked = (candidate) => typeof candidate === "string" && path.resolve(candidate) === blockedPath;
  fs.openSync = function guardedOpen(candidate, ...args) {
    if (isBlocked(candidate)) throw new Error("oversized protected log must not be opened");
    return originalOpenSync.call(this, candidate, ...args);
  };
  fs.readFileSync = function guardedRead(candidate, ...args) {
    if (isBlocked(candidate)) throw new Error("oversized protected log must not be read");
    return originalReadFileSync.call(this, candidate, ...args);
  };
  let operation;
  try {
    operation = await unified.dispatch({ action: "file", payload: { path: sessionFile } });
  } finally {
    fs.openSync = originalOpenSync;
    fs.readFileSync = originalReadFileSync;
    if (previousLimit == null) delete process.env.CAPSULE_SESSION_AUDIT_MAX_BYTES;
    else process.env.CAPSULE_SESSION_AUDIT_MAX_BYTES = previousLimit;
  }
  try {
    const rendered = core.renderOperation(operation);
    const capsulesAfter = core.listCapsules({ limit: 10_000 }).response.capsules.length;
    assert.equal(operation.route, "session-log-audit");
    assert.equal(operation.response.scan_skipped, true);
    assert.equal(operation.response.skip_reason, "file-exceeds-session-audit-limit");
    assert.equal(operation.response.audit_max_bytes, auditLimit);
    assert.equal(operation.response.file_bytes, auditLimit + 1);
    assert.equal(operation.response.provider_telemetry.scan_skipped, true);
    assert.equal(operation.response.compaction_audit.scan_skipped, true);
    assert.equal(operation.response.raw_transcript_included, false);
    assert.equal(operation.response.raw_capsule_created, false);
    assert.equal(operation.capturedChars, 0);
    assert.equal(capsulesAfter, capsulesBefore);
    assert.doesNotMatch(rendered, new RegExp(secret));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("explicit full mode keeps literal Codex session-log access available", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-session-log-full-"));
  const sessionFile = path.join(workspace, ".codex", "sessions", "rollout.jsonl");
  const userSecret = "EXPLICIT-FULL-USER-EVIDENCE-163502";
  const assistantSecret = "EXPLICIT-FULL-ASSISTANT-EVIDENCE-407286";
  writeSessionLog(sessionFile, userSecret, assistantSecret);
  try {
    for (const literalRequest of [
      { mode: "full" },
      { require_full: true },
      { require_literal: true },
    ]) {
      const operation = await unified.dispatch({
        action: "file",
        payload: { path: sessionFile, ...literalRequest },
      });
      const literal = operation.baselineText || operation.responseText;
      assert.notEqual(operation.route, "session-log-audit");
      assert.match(literal, new RegExp(userSecret));
      assert.match(literal, new RegExp(assistantSecret));
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("ordinary project JSONL remains an unprotected file read", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-project-jsonl-"));
  const projectFile = path.join(workspace, "fixtures", "events.jsonl");
  const projectEvidence = "ORDINARY-PROJECT-JSONL-EVIDENCE-752184";
  fs.mkdirSync(path.dirname(projectFile), { recursive: true });
  fs.writeFileSync(projectFile, `${JSON.stringify({ event: projectEvidence })}\n`, "utf8");
  try {
    const operation = await unified.dispatch({
      action: "file",
      payload: { path: projectFile },
    });
    assert.notEqual(operation.route, "session-log-audit");
    assert.match(operation.baselineText || operation.responseText, new RegExp(projectEvidence));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("compact file edit tuples commit multiple files atomically and undo exactly", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-edit-"));
  const first = path.join(workspace, "first.txt");
  const second = path.join(workspace, "second.txt");
  fs.writeFileSync(first, "alpha\nanchor\nomega\n", "utf8");
  fs.writeFileSync(second, "one two three\n", "utf8");
  try {
    const edited = await unified.dispatch({
      action: "file",
      payload: {
        operation: "edit",
        root: workspace,
        files: [
          { path: first, ops: [["r", "alpha", "ALPHA"], ["a", "anchor", "\ninserted"]] },
          { path: second, ops: [["d", "two "], ["e", "tail\n"]] },
        ],
      },
    });
    assert.equal(edited.response.committed, true);
    assert.equal(edited.response.files.length, 2);
    assert.equal(fs.readFileSync(first, "utf8"), "ALPHA\nanchor\ninserted\nomega\n");
    assert.equal(fs.readFileSync(second, "utf8"), "one three\ntail\n");
    assert.match(edited.response.files[0].exact_before, /^cap_[a-f0-9]{16}$/);
    assert.match(edited.response.files[0].exact_after, /^cap_[a-f0-9]{16}$/);

    const undone = await unified.dispatch({
      action: "file",
      payload: {
        operation: "undo",
        transaction_id: edited.response.transaction_id,
        confirm: true,
      },
    });
    assert.equal(undone.response.restored.length, 2);
    assert.equal(fs.readFileSync(first, "utf8"), "alpha\nanchor\nomega\n");
    assert.equal(fs.readFileSync(second, "utf8"), "one two three\n");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("ProofPatch Reactor fuses an atomic edit and bounded verification proof", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-proofpatch-"));
  const target = path.join(workspace, "value.txt");
  const verifier = path.join(workspace, "verify.cjs");
  fs.writeFileSync(target, "before\n", "utf8");
  fs.writeFileSync(verifier, [
    '"use strict";',
    'const fs = require("node:fs");',
    'const value = fs.readFileSync(process.argv[2], "utf8").trim();',
    'for (let index = 0; index < 180; index += 1) console.log(`case ${index}: passed`);',
    'if (value !== "after") { console.error(`FAIL expected after received ${value}`); process.exit(3); }',
    'console.log("PASS proofpatch verification complete");',
  ].join("\n"), "utf8");
  try {
    const operation = await unified.dispatch({
      action: "file",
      payload: {
        operation: "edit",
        root: workspace,
        path: target,
        ops: [["r", "before", "after"]],
        verify: {
          command: process.execPath,
          args: [verifier, target],
          profile: "test",
        },
      },
    });
    assert.equal(operation.response.committed, true);
    assert.equal(operation.response.proofpatch.status, "passed");
    assert.equal(operation.response.proofpatch.run, 1);
    assert.equal(operation.response.proofpatch.results[0].exit_code, 0);
    assert.match(operation.response.proofpatch.results[0].proof, /PASS proofpatch/);
    const exact = operation.response.proofpatch.results[0].exact;
    assert.match(exact, /^cap_[a-f0-9]{16}$/);
    assert.match(core.loadCapsule(exact).text, /case 100: passed/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("ProofPatch Reactor preserves a failed edit receipt and stops the verification ladder", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-proofpatch-fail-"));
  const target = path.join(workspace, "value.txt");
  const verifier = path.join(workspace, "verify.cjs");
  fs.writeFileSync(target, "before\n", "utf8");
  fs.writeFileSync(verifier, 'console.error("FAIL expected green received red"); process.exit(4);', "utf8");
  try {
    const operation = await unified.dispatch({
      action: "file",
      payload: {
        operation: "edit",
        root: workspace,
        path: target,
        ops: [["r", "before", "after"]],
        verify: [
          { command: process.execPath, args: [verifier], profile: "test" },
          { command: process.execPath, args: ["-e", "console.log('should not run')"], profile: "test" },
        ],
      },
    });
    assert.equal(operation.response.committed, true);
    assert.equal(operation.response.proofpatch.status, "failed");
    assert.equal(operation.response.proofpatch.stopped_early, true);
    assert.equal(operation.response.proofpatch.run, 1);
    assert.equal(operation.response.proofpatch.results[0].exit_code, 4);
    assert.match(operation.response.proofpatch.results[0].proof, /FAIL expected green/);
    assert.equal(fs.readFileSync(target, "utf8"), "after\n");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("file edit transaction validates every anchor before writing any file", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-edit-atomic-"));
  const first = path.join(workspace, "first.txt");
  const second = path.join(workspace, "second.txt");
  fs.writeFileSync(first, "keep-first\n", "utf8");
  fs.writeFileSync(second, "keep-second\n", "utf8");
  try {
    await assert.rejects(
      unified.dispatch({
        action: "file",
        payload: {
          operation: "edit",
          root: workspace,
          files: [
            { path: first, ops: [["r", "keep", "changed"]] },
            { path: second, ops: [["r", "missing-anchor", "changed"]] },
          ],
        },
      }),
      /not found/
    );
    assert.equal(fs.readFileSync(first, "utf8"), "keep-first\n");
    assert.equal(fs.readFileSync(second, "utf8"), "keep-second\n");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("file edit sha preconditions and undo protect against stale overwrites", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-edit-sha-"));
  const target = path.join(workspace, "target.txt");
  fs.writeFileSync(target, "before\n", "utf8");
  try {
    await assert.rejects(
      unified.dispatch({
        action: "file",
        payload: {
          operation: "edit",
          root: workspace,
          path: target,
          expected_sha256: "0".repeat(64),
          ops: [["r", "before", "after"]],
        },
      }),
      /sha256 precondition failed/
    );
    const edited = await unified.dispatch({
      action: "file",
      payload: {
        operation: "edit",
        root: workspace,
        path: target,
        ops: [["r", "before", "after"]],
      },
    });
    fs.writeFileSync(target, "later-change\n", "utf8");
    await assert.rejects(
      unified.dispatch({
        action: "file",
        payload: {
          operation: "undo",
          transaction_id: edited.response.transaction_id,
          confirm: true,
        },
      }),
      /changed after transaction/
    );
    assert.equal(fs.readFileSync(target, "utf8"), "later-change\n");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("selected skill instructions bypass expand pagination in one file call", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-instruction-full-"));
  const directory = path.join(workspace, "skills", "sample");
  const target = path.join(directory, "SKILL.md");
  fs.mkdirSync(directory, { recursive: true });
  const content = [
    "---",
    "name: sample",
    "description: sample instructions",
    "---",
    ...Array.from({ length: 260 }, (_, index) =>
      `Instruction ${index}: preserve exact evidence token-${index}-${(index * 7919).toString(36)}.`),
  ].join("\n");
  fs.writeFileSync(target, content, "utf8");
  try {
    const result = await unified.dispatch({
      action: "file",
      payload: { path: target, query: "only one term" },
    });
    assert.equal(result.route, "passthrough");
    assert.equal(result.responseText, content);
    assert.equal(result.response, null);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("bare source reads return files up to 32 KiB whole instead of forcing expand paging", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-bare-source-full-"));
  const target = path.join(workspace, "service.js");
  const content = Array.from({ length: 360 }, (_, index) =>
    `export const value${index} = "exact-source-${index}-${(index * 104729).toString(36)}";`
  ).join("\n");
  assert.ok(Buffer.byteLength(content) > 12_000);
  assert.ok(Buffer.byteLength(content) <= 32 * 1024);
  fs.writeFileSync(target, content, "utf8");
  try {
    const result = await unified.dispatch({
      action: "file",
      payload: { path: target },
    });
    assert.equal(result.route, "passthrough");
    assert.equal(result.responseText, content);
    assert.equal(result.response, null);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("compressText profiles tests, deduplicates logs, and redacts secrets", () => {
  const testOutput = [
    ...Array.from({ length: 2_000 }, (_, index) => `ok routine case ${index}`),
    "FAIL checkout preserves transaction",
    "Error: expected 2 received 1",
    "Tests: 1 failed, 1999 passed, 2000 total",
  ].join("\n");
  const compact = unified.compressText(testOutput, { profile: "test", query: "checkout" });
  assert.equal(compact.route, "compressed");
  assert.match(compact.output, /FAIL checkout/);
  assert.match(compact.output, /1 failed/);
  assert.ok(compact.output.length < testOutput.length * 0.1);

  const logs = `${"2026-01-01 INFO polling worker 7\n".repeat(1_000)}API_TOKEN=super-secret\n`;
  const deduped = unified.compressText(logs, { profile: "log" });
  assert.equal(deduped.route, "compressed");
  assert.match(deduped.output, /\[x1000\]/);
  assert.doesNotMatch(deduped.output, /super-secret/);
});

test("redaction preserves ordinary token prose while removing assigned credentials", () => {
  const prose = "Capsule reduces reasoning-token growth and token savings vary by workload.";
  const unchanged = unified.compressText(prose, { profile: "generic" });
  assert.equal(unchanged.output, prose);

  const credentials = [
    "API_TOKEN=super-secret",
    "token: second-secret",
    "Authorization: Bearer third-secret",
    "Bearer fourth-secret",
  ].join("\n");
  const redacted = unified.compressText(credentials, { profile: "env" });
  assert.doesNotMatch(redacted.output, /super-secret|second-secret|third-secret|fourth-secret/);
  assert.match(redacted.output, /\[REDACTED\]/);
});

test("run executes once, archives exact output, and returns compact diagnostics", async () => {
  const operation = await unified.dispatch({
    action: "run",
    payload: {
      command: process.execPath,
      args: ["-e", "for(let i=0;i<3000;i++) console.log(i===1777?'FATAL UNIFIED NEEDLE':'routine '+i)"],
      query: "FATAL UNIFIED NEEDLE",
      profile: "diagnostic",
    },
  });
  assert.equal(operation.response.exit_code, 0);
  assert.equal(operation.response.route, "compressed");
  assert.match(operation.response.output, /FATAL UNIFIED NEEDLE/);
  assert.match(operation.response.capsule_id, /^cap_[a-f0-9]{16}$/);
});

test("index and search provide persistent exact snippets without full-file output", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-index-work-"));
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "alpha.js"), [
    "export function alpha() {",
    "  return 'CAPSULE-SEARCH-NEEDLE';",
    "}",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(workspace, "src", "beta.md"), "# unrelated\nquiet", "utf8");
  fs.writeFileSync(path.join(workspace, "node_modules", "ignored.js"), "CAPSULE-SEARCH-NEEDLE", "utf8");

  const indexed = await unified.dispatch({
    action: "index",
    payload: { path: workspace, max_files: 10 },
  });
  assert.equal(indexed.response.indexed, 2);

  const searched = await unified.dispatch({
    action: "search",
    payload: { query: "CAPSULE SEARCH NEEDLE", limit: 3 },
  });
  const results = searched.response.searches[0].results;
  assert.equal(results.length, 1);
  assert.match(results[0].source, /alpha\.js$/);
  assert.match(results[0].snippet, /CAPSULE-SEARCH-NEEDLE/);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("remember is searchable and stats report standalone operation", async () => {
  const remembered = await unified.dispatch({
    action: "remember",
    payload: {
      tag: "decision",
      content: "Use the cobalt deployment lane after verification.",
    },
  });
  assert.equal(remembered.response.indexed, 1);

  const searched = await unified.dispatch({
    action: "search",
    payload: { query: "cobalt deployment lane", kind: "memory" },
  });
  assert.match(searched.response.searches[0].results[0].snippet, /cobalt deployment lane/);

  const stats = await unified.dispatch({ action: "stats" });
  assert.ok(stats.response.index.documents >= 1);
});

test("skills route selects the matching live specialist without moving the catalog", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-skill-route-"));
  const security = path.join(codexHome, "skills", "api-guardian");
  const sheets = path.join(codexHome, "skills", "sheet-helper");
  fs.mkdirSync(security, { recursive: true });
  fs.mkdirSync(sheets, { recursive: true });
  fs.writeFileSync(path.join(security, "SKILL.md"), [
    "---",
    "name: api-guardian",
    "description: Audit REST and GraphQL APIs for authorization, injection, and rate-limit defects.",
    "---",
    "",
    "# API Guardian",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(sheets, "SKILL.md"), [
    "---",
    "name: sheet-helper",
    "description: Build and analyze spreadsheet formulas, tables, and financial workbooks.",
    "---",
    "",
    "# Sheet Helper",
  ].join("\n"), "utf8");
  process.env.CODEX_HOME = codexHome;
  try {
    const routed = await unified.dispatch({
      action: "skills",
      payload: { operation: "route", query: "audit an API authorization bypass" },
    });
    assert.equal(routed.response.matches[0].name, "api-guardian");
    assert.equal(routed.response.virtualized, false);
    assert.equal(routed.response.matches[0].skill_file, path.join(security, "SKILL.md"));
    assert.equal(fs.existsSync(path.join(security, "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(sheets, "SKILL.md")), true);
  } finally {
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("skills route never re-injects a specialist's large metadata catalog", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-skill-route-budget-"));
  const skill = path.join(codexHome, "skills", "large-router-target");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), [
    "---",
    "name: large-router-target",
    `description: ROUTER-NEEDLE ${"large specialist metadata ".repeat(500)}`,
    "---",
  ].join("\n"), "utf8");
  process.env.CODEX_HOME = codexHome;
  try {
    const routed = await unified.dispatch({
      action: "skills",
      payload: { operation: "route", query: "ROUTER-NEEDLE" },
    });
    assert.equal(routed.response.matches[0].name, "large-router-target");
    assert.ok(routed.response.matches[0].description.length <= 240);
    assert.ok(JSON.stringify(routed.response).length < 1_000);
  } finally {
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("skills route favors rare domain phrases over generic security vocabulary", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-skill-idf-"));
  const fixtures = [
    ["api-generic", "Audit security controls for APIs and applications."],
    ["cloud-generic", "Audit cloud security configurations and APIs."],
    ["windows-identity", "Assess Active Directory, Kerberos, and Windows domain identity."],
  ];
  for (const [name, description] of fixtures) {
    const folder = path.join(codexHome, "skills", name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "SKILL.md"), [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "---",
    ].join("\n"), "utf8");
  }
  process.env.CODEX_HOME = codexHome;
  try {
    const routed = await unified.dispatch({
      action: "skills",
      payload: { operation: "route", query: "audit Active Directory security" },
    });
    assert.equal(routed.response.matches[0].name, "windows-identity");
  } finally {
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("skills route returns no match instead of injecting an unrelated low-overlap specialist", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-skill-floor-"));
  const fixtures = [
    ["security-token-audit", "Inspect bearer token authorization and API security."],
    ["ctf-helper", "Solve security capture-the-flag challenges."],
    ["improve-codebase-architecture", "Review and improve a codebase architecture."],
  ];
  for (const [name, description] of fixtures) {
    const folder = path.join(codexHome, "skills", name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "SKILL.md"), [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "---",
    ].join("\n"), "utf8");
  }
  process.env.CODEX_HOME = codexHome;
  try {
    const routed = await unified.dispatch({
      action: "skills",
      payload: {
        operation: "route",
        query: "Capsule reasoning governor architecture",
      },
    });
    assert.deepEqual(routed.response.matches, []);
    assert.match(routed.response.reason, /no relevant/i);
  } finally {
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("skills route does not treat generic status language as Gmail intent", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-skill-generic-status-"));
  const folder = path.join(codexHome, "skills", "gmail-inbox-triage");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "SKILL.md"), [
    "---",
    "name: gmail-inbox-triage",
    "description: Triage a Gmail inbox into actionable buckets such as urgent, needs reply soon, waiting, and FYI using connected Gmail data. Use when the user asks to triage the inbox, rank what needs attention, find what still needs a reply, or separate important mail from noise.",
    "---",
  ].join("\n"), "utf8");
  process.env.CODEX_HOME = codexHome;
  try {
    for (const query of [
      "What is the current status?",
      "What should I do now?",
      "Please continue from where you left off",
      "Tell me the latest progress",
    ]) {
      const routed = await unified.dispatch({
        action: "skills",
        payload: { operation: "route", query },
      });
      assert.deepEqual(routed.response.matches, [], query);
    }

    const explicitEmail = await unified.dispatch({
      action: "skills",
      payload: { operation: "route", query: "Triage my Gmail inbox and rank messages needing replies" },
    });
    assert.equal(explicitEmail.response.matches[0].name, "gmail-inbox-triage");
  } finally {
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("skills route abstains from historical presentation, architecture, and desktop modality collisions", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-skill-modality-"));
  const fixtures = [
    [
      "artifact-template-market-trends-report",
      "Create a presentation using the Market Trends Report template. Use when the user selects or names Market Trends Report.",
    ],
    [
      "improve-codebase-architecture",
      "Scan a codebase for architecture deepening opportunities and present an HTML report.",
    ],
    [
      "thick-client",
      "Use for authorized security testing of desktop thick clients including local storage, IPC, traffic, and client-side trust boundaries.",
    ],
    [
      "competition-web-runtime",
      "Internal downstream skill for ctf-sandbox-orchestrator. Use only after the parent orchestrator has established sandbox assumptions.",
    ],
    [
      "hunt-sqli",
      "Find and verify SQL injection vulnerabilities in web APIs.",
    ],
    [
      "ctf-sandbox-orchestrator",
      "Orchestrate CTF sandbox challenges across web, Active Directory, binary, and cloud categories.",
    ],
    [
      "windows-ad",
      "Assess Active Directory, Kerberos, and Windows domain security.",
    ],
    [
      "pdf",
      "Inspect, edit, and verify PDF files.",
    ],
  ];
  for (const [name, description] of fixtures) {
    const folder = path.join(codexHome, "skills", name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "SKILL.md"), [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "---",
    ].join("\n"), "utf8");
  }
  process.env.CODEX_HOME = codexHome;
  try {
    for (const query of [
      "Passively audit every currently live virtual football match and all betting markets for data, timing, score, odds, identifier, and network anomalies without placing bets or mutating the service.",
      "Build a fast retrospective Goaloo scraper and anomaly detector for Crown bookmaker early market closures in FT/HT 1X2 and over-under odds.",
      "Find evidence-based internal pricing or state anomalies across already captured live virtual football matches using score-dependent market validity, monotonic odds lines, and cross-market probability consistency; do not invent suspicion.",
      "Persist the confirmed stale last_event anomaly and conduct an extended passive longitudinal audit of all live virtual football matches across multiple rounds, tracking score, time, events, odds, and market consistency.",
      "Invent a radically new architecture for reducing model reasoning and output tokens before generation while preserving correctness.",
      "Passively investigate a public live virtual football event for anomalies using browser, API, WebSocket, network traffic, and client-side evidence without mutating the service.",
    ]) {
      const routed = await unified.dispatch({
        action: "skills",
        payload: { operation: "route", query },
      });
      assert.deepEqual(routed.response.matches, [], query);
    }

    const explicitTemplate = await unified.dispatch({
      action: "skills",
      payload: { operation: "route", query: "Create the Market Trends Report template" },
    });
    assert.equal(explicitTemplate.response.matches[0].name, "artifact-template-market-trends-report");

    const explicitArchitecture = await unified.dispatch({
      action: "skills",
      payload: { operation: "route", query: "Review this repository codebase architecture and refactor its modules" },
    });
    assert.equal(explicitArchitecture.response.matches[0].name, "improve-codebase-architecture");

    const explicitDesktop = await unified.dispatch({
      action: "skills",
      payload: { operation: "route", query: "Perform authorized security testing of a desktop thick client" },
    });
    assert.equal(explicitDesktop.response.matches[0].name, "thick-client");

    const directSqli = await unified.dispatch({
      action: "skills",
      payload: { operation: "route", query: "Find SQL injection in a web API" },
    });
    assert.equal(directSqli.response.matches[0].name, "hunt-sqli");

    const directWindows = await unified.dispatch({
      action: "skills",
      payload: { operation: "route", query: "Assess Active Directory security" },
    });
    assert.equal(directWindows.response.matches[0].name, "windows-ad");

    const explicitCtf = await unified.dispatch({
      action: "skills",
      payload: { operation: "route", query: "Solve a CTF sandbox Active Directory challenge" },
    });
    assert.equal(explicitCtf.response.matches[0].name, "ctf-sandbox-orchestrator");

    const directPdf = await unified.dispatch({
      action: "skills",
      payload: { operation: "route", query: "Inspect and verify a PDF" },
    });
    assert.equal(directPdf.response.matches[0].name, "pdf");
  } finally {
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("skills route requires the public query field", async () => {
  await assert.rejects(
    unified.dispatch({ action: "skills", payload: { operation: "route" } }),
    /query is required/,
  );
});

test("skills route rejects generic Capsule control-plane queries", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-skill-control-plane-"));
  const fixtures = [
    ["codex-bughunter", "Verify Codex automation behavior and diagnose task failures."],
    ["hunt-session", "Inspect a security hunt session and preserve investigation context."],
    ["context-helper", "Manage context for agent workflows and token-heavy tools."],
  ];
  for (const [name, description] of fixtures) {
    const folder = path.join(codexHome, "skills", name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "SKILL.md"), [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "---",
    ].join("\n"), "utf8");
  }
  process.env.CODEX_HOME = codexHome;
  try {
    const queries = [
      "verify Capsule activation after Codex restart and automatic compaction savings telemetry",
      "measure automatic context compaction token savings in another Codex thread using session telemetry",
      "improve universal Codex token and quota efficiency after v0.18 by researching user pain, detecting wasted model turns, implementing safe automatic controls, benchmarking real sessions, and reinstalling the plugin",
    ];
    for (const query of queries) {
      const routed = await unified.dispatch({
        action: "skills",
        payload: { operation: "route", query },
      });
      assert.deepEqual(routed.response.matches, []);
    }

    const securityTask = await unified.dispatch({
      action: "skills",
      payload: {
        operation: "route",
        query: "hunt session management vulnerabilities and session fixation",
      },
    });
    assert.equal(securityTask.response.matches[0].name, "hunt-session");
    assert.equal(securityTask.response.matches.length, 1);
  } finally {
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("skills route requires security intent before loading security specialists", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-skill-domain-gate-"));
  const fixtures = [
    ["code-audit", "Authorized source-code security review and SAST workflow."],
    ["triage-validation", "Validate bug bounty findings before report submission."],
  ];
  for (const [name, description] of fixtures) {
    const folder = path.join(codexHome, "skills", name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "SKILL.md"), [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "---",
    ].join("\n"), "utf8");
  }
  process.env.CODEX_HOME = codexHome;
  try {
    for (const query of [
      "clone a live website into responsive frontend code",
      "manage Gmail inbox triage",
    ]) {
      const routed = await unified.dispatch({
        action: "skills",
        payload: { operation: "route", query },
      });
      assert.deepEqual(routed.response.matches, []);
    }

    const securityTask = await unified.dispatch({
      action: "skills",
      payload: { operation: "route", query: "audit source code security with SAST" },
    });
    assert.equal(securityTask.response.matches[0].name, "code-audit");
  } finally {
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("insight keeps compaction events compact by default and expands them only on request", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-insight-compaction-"));
  const file = path.join(root, "rollout.jsonl");
  const records = [];
  for (let index = 1; index <= 4; index += 1) {
    records.push({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          model_context_window: 120_000,
          last_token_usage: {
            input_tokens: 100_000,
            cached_input_tokens: 80_000,
            output_tokens: 100,
            reasoning_output_tokens: 20,
            total_tokens: 100_100,
          },
          total_token_usage: {
            input_tokens: index * 100_000,
            cached_input_tokens: 0,
            output_tokens: index * 100,
            reasoning_output_tokens: index * 20,
            total_tokens: index * 100_100,
          },
        },
      },
    });
    records.push({
      timestamp: new Date().toISOString(),
      type: "compacted",
      payload: {
        window_number: index,
        replacement_history: [{ type: "compaction", encrypted_content: "x".repeat(index * 100) }],
      },
    });
    records.push({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          model_context_window: 120_000,
          last_token_usage: {
            input_tokens: 15_000,
            cached_input_tokens: 10_000,
            output_tokens: 80,
            reasoning_output_tokens: 10,
            total_tokens: 15_080,
          },
          total_token_usage: {
            input_tokens: index * 100_000 + 15_000,
            cached_input_tokens: 0,
            output_tokens: index * 100 + 80,
            reasoning_output_tokens: index * 20 + 10,
            total_tokens: index * 100_100 + 15_080,
          },
        },
      },
    });
  }
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  try {
    const report = unified.insight({ compaction: true, session_file: file }).response;
    const compact = report.compaction;
    assert.equal(compact.compactions, 4);
    assert.equal(Object.hasOwn(compact, "events"), false);
    assert.equal(compact.latest_event.window, 4);
    assert.equal(report.context_pressure.context_window, 120_000);
    assert.equal(report.context_pressure.compactions_last_30m, 4);
    assert.equal(report.context_pressure.mode, "emergency");
    assert.match(report.context_pressure.reasons.join(" "), /thrash/i);

    const expanded = unified.insight({
      compaction: true,
      compaction_events: true,
      compaction_event_limit: 2,
      session_file: file,
    }).response.compaction;
    assert.equal(expanded.events.length, 2);
    assert.deepEqual(expanded.events.map((event) => event.window), [3, 4]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skills plan reports a reversible catalog reduction without changing files", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-skill-plan-"));
  const specialist = path.join(codexHome, "skills", "large-specialist");
  const systemSkill = path.join(codexHome, "skills", ".system", "must-stay-live");
  fs.mkdirSync(specialist, { recursive: true });
  fs.mkdirSync(systemSkill, { recursive: true });
  fs.writeFileSync(path.join(specialist, "SKILL.md"), [
    "---",
    "name: large-specialist",
    `description: ${"Specialized workflow metadata ".repeat(80)}`,
    "---",
    "",
    "# Large specialist",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(systemSkill, "SKILL.md"), [
    "---",
    "name: must-stay-live",
    "description: System skill excluded from virtualization.",
    "---",
  ].join("\n"), "utf8");
  process.env.CODEX_HOME = codexHome;
  try {
    const planned = await unified.dispatch({
      action: "skills",
      payload: { operation: "plan" },
    });
    assert.equal(planned.response.operation, "plan");
    assert.equal(planned.response.active, false);
    assert.equal(planned.response.root_entries, 1);
    assert.equal(planned.response.skills, 1);
    assert.ok(planned.response.potential_metadata_tokens_avoided >= 400);
    assert.equal(planned.response.changes_made, false);
    assert.equal(fs.existsSync(path.join(specialist, "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(systemSkill, "SKILL.md")), true);
  } finally {
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("capability airlock removes static skill injection and still routes plugin skills", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-airlock-"));
  const pluginSkill = path.join(codexHome, "plugins", "cache", "market", "docs", "1.0.0", "skills", "write-docs");
  fs.mkdirSync(pluginSkill, { recursive: true });
  fs.writeFileSync(path.join(pluginSkill, "SKILL.md"), [
    "---",
    "name: write-docs",
    "description: Create and revise professional Word documents with tracked changes.",
    "---",
  ].join("\n"), "utf8");
  const beforeConfig = "model = \"gpt-5.6-sol\"\n";
  const projectRule = "- Proje veya klasor kod tabanini anlamada `action=project`, `operation=query|impact|scan|status|gc` kullan; ham dosyalari ancak exact kanit gerektiginde genislet.";
  const beforeAgents = `# Existing rules\n\n- Preserve me.\n\n${projectRule}\n`;
  fs.writeFileSync(path.join(codexHome, "config.toml"), beforeConfig, "utf8");
  fs.writeFileSync(path.join(codexHome, "AGENTS.md"), beforeAgents, "utf8");
  process.env.CODEX_HOME = codexHome;
  try {
    const plan = await unified.dispatch({
      action: "skills",
      payload: { operation: "airlock-plan" },
    });
    assert.equal(plan.response.active, false);
    assert.equal(plan.response.skills, 1);

    const applied = await unified.dispatch({
      action: "skills",
      payload: { operation: "airlock-apply", confirm: true },
    });
    assert.equal(applied.response.active, true);
    assert.equal(applied.response.requires_restart, true);
    assert.match(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), /\[skills\][\s\S]*include_instructions = false/);
    const activeAgents = fs.readFileSync(path.join(codexHome, "AGENTS.md"), "utf8");
    assert.match(activeAgents, /capability-airlock:start/);
    assert.equal(activeAgents.split(projectRule).length - 1, 1);
    const managedStart = activeAgents.indexOf("<!-- capsule-capability-airlock:start -->");
    const managedEnd = activeAgents.indexOf("<!-- capsule-capability-airlock:end -->") +
      "<!-- capsule-capability-airlock:end -->".length;
    const managedBlock = activeAgents.slice(managedStart, managedEnd);
    assert.doesNotMatch(managedBlock, /action=project/);
    assert.equal(plan.response.airlock_anchor_chars, managedBlock.length);
    assert.equal(plan.response.estimated_airlock_anchor_tokens_per_request, Math.ceil(managedBlock.length / 4));
    assert.equal(applied.response.airlock_anchor_chars, managedBlock.length);
    assert.match(activeAgents, /onceki tur hatasini tasima/);
    assert.match(activeAgents, /denemeden `erisilemedi` deme/);
    assert.match(activeAgents, /gercek `payload\.url\|requests`/);
    assert.match(activeAgents, /kimlik uydurma/);

    const routed = await unified.dispatch({
      action: "skills",
      payload: { operation: "route", query: "revise a Word document with tracked changes" },
    });
    assert.equal(routed.response.capability_airlock, true);
    assert.equal(routed.response.matches[0].name, "write-docs");

    const restored = await unified.dispatch({
      action: "skills",
      payload: { operation: "airlock-restore", confirm: true },
    });
    assert.equal(restored.response.restored, true);
    assert.equal(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), beforeConfig);
    assert.equal(fs.readFileSync(path.join(codexHome, "AGENTS.md"), "utf8"), beforeAgents);
  } finally {
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("capability airlock refresh preserves external AGENTS and config changes while renewing its managed block", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-airlock-refresh-"));
  const projectRule = "- Proje veya klasor kod tabanini anlamada `action=project`, `operation=query|impact|scan|status|gc` kullan; ham dosyalari ancak exact kanit gerektiginde genislet.";
  fs.writeFileSync(path.join(codexHome, "config.toml"), "model = \"gpt-5.6-sol\"\n", "utf8");
  fs.writeFileSync(path.join(codexHome, "AGENTS.md"), "# Existing rules\n\n- Preserve me.\n", "utf8");
  process.env.CODEX_HOME = codexHome;
  try {
    await unified.dispatch({
      action: "skills",
      payload: { operation: "airlock-apply", confirm: true },
    });
    const freshAgents = fs.readFileSync(path.join(codexHome, "AGENTS.md"), "utf8");
    assert.equal(freshAgents.split(projectRule).length - 1, 1);
    fs.appendFileSync(path.join(codexHome, "config.toml"), "\n[custom]\nkeep = true\n", "utf8");
    fs.appendFileSync(
      path.join(codexHome, "AGENTS.md"),
      `\n# Later user rule\n\n- Keep this too.\n\n${projectRule}\n`,
      "utf8"
    );
    const refreshPlan = await unified.dispatch({
      action: "skills",
      payload: { operation: "airlock-plan" },
    });

    await assert.rejects(
      unified.dispatch({ action: "skills", payload: { operation: "airlock-refresh" } }),
      /confirm:true/
    );
    const refreshed = await unified.dispatch({
      action: "skills",
      payload: { operation: "airlock-refresh", confirm: true },
    });
    assert.equal(refreshed.response.preserved_external_changes, true);
    const activeConfig = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    const activeAgents = fs.readFileSync(path.join(codexHome, "AGENTS.md"), "utf8");
    assert.match(activeConfig, /\[custom\][\s\S]*keep = true/);
    assert.match(activeAgents, /Later user rule/);
    assert.match(activeAgents, /literal istegini koruyan/);
    assert.match(activeAgents, /bir kez yeniden dene/);
    assert.equal(activeAgents.split(projectRule).length - 1, 1);
    const managedStart = activeAgents.indexOf("<!-- capsule-capability-airlock:start -->");
    const managedEnd = activeAgents.indexOf("<!-- capsule-capability-airlock:end -->") +
      "<!-- capsule-capability-airlock:end -->".length;
    const managedBlock = activeAgents.slice(managedStart, managedEnd);
    assert.doesNotMatch(managedBlock, /action=project/);
    assert.equal(refreshPlan.response.airlock_anchor_chars, managedBlock.length);
    assert.equal(
      refreshPlan.response.estimated_airlock_anchor_tokens_per_request,
      Math.ceil(managedBlock.length / 4)
    );

    const restored = await unified.dispatch({
      action: "skills",
      payload: { operation: "airlock-restore", confirm: true },
    });
    assert.equal(restored.response.restored, true);
    const restoredConfig = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    const restoredAgents = fs.readFileSync(path.join(codexHome, "AGENTS.md"), "utf8");
    assert.match(restoredConfig, /\[custom\][\s\S]*keep = true/);
    assert.doesNotMatch(restoredConfig, /include_instructions/);
    assert.match(restoredAgents, /Later user rule/);
    assert.equal(restoredAgents.split(projectRule).length - 1, 1);
    assert.doesNotMatch(restoredAgents, /capability-airlock:start/);
  } finally {
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("skills apply requires confirmation and routes from a reversible vault", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-skill-apply-"));
  const api = path.join(codexHome, "skills", "api-specialist");
  const cloud = path.join(codexHome, "skills", "cloud-specialist");
  const systemSkill = path.join(codexHome, "skills", ".system", "core-skill");
  for (const folder of [api, cloud, systemSkill]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(api, "SKILL.md"), [
    "---",
    "name: api-specialist",
    "description: Diagnose API authorization and object access vulnerabilities.",
    "---",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(cloud, "SKILL.md"), [
    "---",
    "name: cloud-specialist",
    "description: Review cloud IAM roles and Kubernetes policy.",
    "---",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(systemSkill, "SKILL.md"), [
    "---",
    "name: core-skill",
    "description: Must remain directly available.",
    "---",
  ].join("\n"), "utf8");
  process.env.CODEX_HOME = codexHome;
  try {
    await assert.rejects(
      unified.dispatch({ action: "skills", payload: { operation: "apply" } }),
      /confirm:true/
    );
    const applied = await unified.dispatch({
      action: "skills",
      payload: { operation: "apply", confirm: true },
    });
    assert.equal(applied.response.active, true);
    assert.equal(applied.response.root_entries, 2);
    assert.equal(applied.response.skills, 2);
    assert.equal(applied.response.requires_restart, true);
    assert.equal(fs.existsSync(api), false);
    assert.equal(fs.existsSync(cloud), false);
    assert.equal(fs.existsSync(path.join(systemSkill, "SKILL.md")), true);
    const generatedRouter = path.join(
      codexHome,
      "skills",
      "capsule-router",
      "SKILL.md"
    );
    assert.equal(fs.existsSync(generatedRouter), true);
    assert.match(fs.readFileSync(generatedRouter, "utf8"), /managed-by-capsule/);

    const status = await unified.dispatch({
      action: "skills",
      payload: { operation: "status" },
    });
    assert.equal(status.response.active, true);
    assert.equal(status.response.root_entries, 2);
    assert.equal(status.response.skills, 2);
    assert.ok(status.response.metadata_tokens_avoided > 0);

    const diagnosed = unified.doctor();
    assert.equal(diagnosed.response.environment.skill_catalog.virtualization_active, true);
    assert.equal(diagnosed.response.environment.skill_catalog.virtualized_skills, 2);
    const escrowCheck = diagnosed.response.checks.find((item) => item.check === "pre_spend_token_escrow");
    assert.equal(escrowCheck.enabled, true);
    assert.match(escrowCheck.value, /budgeted turns/i);

    const routed = await unified.dispatch({
      action: "skills",
      payload: { operation: "route", query: "API object authorization bug" },
    });
    assert.equal(routed.response.virtualized, true);
    assert.equal(routed.response.matches[0].name, "api-specialist");
    assert.match(routed.response.matches[0].skill_file, /capsule-skill-vault/);
    assert.equal(fs.existsSync(routed.response.matches[0].skill_file), true);
  } finally {
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("skills restore returns every vaulted root entry", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-skill-restore-"));
  const specialist = path.join(codexHome, "skills", "restore-specialist");
  fs.mkdirSync(specialist, { recursive: true });
  fs.writeFileSync(path.join(specialist, "SKILL.md"), [
    "---",
    "name: restore-specialist",
    "description: Restore reversible specialist routing.",
    "---",
  ].join("\n"), "utf8");
  process.env.CODEX_HOME = codexHome;
  try {
    await unified.dispatch({
      action: "skills",
      payload: { operation: "apply", confirm: true },
    });
    await assert.rejects(
      unified.dispatch({ action: "skills", payload: { operation: "restore" } }),
      /confirm:true/
    );
    const restored = await unified.dispatch({
      action: "skills",
      payload: { operation: "restore", confirm: true },
    });
    assert.equal(restored.response.active, false);
    assert.equal(restored.response.root_entries, 1);
    assert.equal(restored.response.requires_restart, true);
    assert.equal(fs.existsSync(path.join(specialist, "SKILL.md")), true);
    assert.equal(
      fs.existsSync(path.join(codexHome, "skills", "capsule-router")),
      false
    );

    const routed = await unified.dispatch({
      action: "skills",
      payload: { operation: "route", query: "reversible specialist routing" },
    });
    assert.equal(routed.response.virtualized, false);
    assert.equal(routed.response.matches[0].skill_file, path.join(specialist, "SKILL.md"));
  } finally {
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("batch runs bounded concurrent commands and preserves input order", async () => {
  const operation = await unified.dispatch({
    action: "batch",
    payload: {
      concurrency: 2,
      commands: [
        {
          label: "first",
          command: process.execPath,
          args: ["-e", "console.log('FIRST BATCH NEEDLE')"],
          query: "FIRST BATCH NEEDLE",
        },
        {
          label: "second",
          command: process.execPath,
          args: ["-e", "console.error('SECOND BATCH WARNING')"],
          query: "SECOND BATCH WARNING",
        },
      ],
    },
  });
  assert.equal(operation.response.results[0].label, "first");
  assert.equal(operation.response.results[1].label, "second");
  assert.match(operation.response.results[0].output, /FIRST BATCH NEEDLE/);
  assert.match(operation.response.results[1].output, /SECOND BATCH WARNING/);
});

test("Roundtrip Singularity executes mixed independent operations in one bounded exact flow", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-flow-"));
  const first = path.join(workspace, "first.txt");
  const second = path.join(workspace, "second.txt");
  fs.writeFileSync(first, "FLOW FILE ALPHA\n", "utf8");
  fs.writeFileSync(second, "FLOW FILE BETA\n", "utf8");
  try {
    const operation = await unified.dispatch({
      action: "flow",
      payload: {
        concurrency: 4,
        steps: [
          { id: "alpha", action: "file", payload: { path: first } },
          { id: "beta", action: "file", payload: { path: second } },
          {
            id: "gamma",
            action: "run",
            payload: {
              command: process.execPath,
              args: ["-e", "console.log('FLOW COMMAND GAMMA')"],
              idempotent: true,
            },
          },
          { id: "metrics", action: "stats", payload: { recent: 1 } },
        ],
      },
    });
    assert.equal(operation.response.operation, "flow");
    assert.equal(operation.response.steps, 4);
    assert.equal(operation.response.frontiers, 1);
    assert.equal(operation.response.ok, 4);
    assert.equal(operation.response.failed, 0);
    assert.match(operation.response.results.find((item) => item.id === "alpha").output, /FLOW FILE ALPHA/);
    assert.match(operation.response.results.find((item) => item.id === "gamma").output, /FLOW COMMAND GAMMA/);
    assert.match(operation.response.exact, /^cap_[a-f0-9]{16}$/);
    const exact = core.loadCapsule(operation.response.exact).text;
    assert.match(exact, /FLOW FILE BETA/);
    assert.match(exact, /FLOW COMMAND GAMMA/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("Roundtrip Singularity factors a repeated cross-result prefix once", async () => {
  const operation = await unified.dispatch({
    action: "flow",
    payload: {
      steps: ["ALPHA", "BETA", "GAMMA"].map((suffix, index) => ({
        id: `prefix-${index}`,
        action: "run",
        payload: {
          command: process.execPath,
          args: ["-e", `console.log('REPEATED FLOW PREFIX THAT IS DELIBERATELY LONG ENOUGH FOR PARETO ${suffix}')`],
          idempotent: true,
        },
      })),
    },
  });
  assert.match(operation.responseText, /\^="REPEATED FLOW PREFIX THAT IS DELIBERATELY LONG ENOUGH FOR PARETO "/);
  assert.match(operation.responseText, /1>\^ALPHA/);
  assert.equal((operation.responseText.match(/REPEATED FLOW PREFIX/g) || []).length, 1);
  const exact = core.loadCapsule(operation.response.exact).text;
  assert.match(exact, /REPEATED FLOW PREFIX THAT IS DELIBERATELY LONG ENOUGH FOR PARETO ALPHA/);
  assert.match(exact, /REPEATED FLOW PREFIX THAT IS DELIBERATELY LONG ENOUGH FOR PARETO GAMMA/);
});

test("Pareto Receipt Compiler chooses no larger visible encoding", async () => {
  const operation = await unified.dispatch({
    action: "flow",
    payload: {
      steps: ["ONE", "TWO", "THREE"].map((suffix, index) => ({
        id: `pareto-${index}`,
        action: "run",
        payload: {
          command: process.execPath,
          args: ["-e", `console.log('UNRELATED ${suffix} ${index}')`],
          idempotent: true,
        },
      })),
    },
  });
  const plain = operation.response.results.map((item) => item.output).join("\n");
  assert.ok(core.estimateTokens(operation.responseText) <= core.estimateTokens(plain));
  assert.equal(operation.response.receipt_estimated_tokens, core.estimateTokens(operation.responseText));
  assert.match(operation.response.exact, /^cap_[a-f0-9]{16}$/);
});

test("Semantic Interrupt Bus waits locally and emits only on file change", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-interrupt-"));
  const watched = path.join(workspace, "state.txt");
  fs.writeFileSync(watched, "before\n", "utf8");
  try {
    const timer = setTimeout(() => fs.writeFileSync(watched, "after\n", "utf8"), 80);
    const operation = await unified.dispatch({
      action: "interrupt",
      payload: {
        interval_ms: 20,
        timeout_ms: 1_000,
        probes: [{ id: "state", type: "file", path: watched }],
      },
    });
    clearTimeout(timer);
    assert.equal(operation.response.changed, true);
    assert.equal(operation.response.timed_out, false);
    assert.ok(operation.response.checks >= 2);
    assert.match(operation.responseText, /SI Δ/);
    assert.match(core.loadCapsule(operation.response.exact).text, /after/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("Semantic Interrupt Bus collapses unchanged local polls into one quiet receipt", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-interrupt-quiet-"));
  const watched = path.join(workspace, "state.txt");
  fs.writeFileSync(watched, "stable\n", "utf8");
  try {
    const operation = await unified.dispatch({
      action: "interrupt",
      payload: {
        interval_ms: 20,
        timeout_ms: 80,
        probes: [{ id: "state", type: "file", path: watched }],
      },
    });
    assert.equal(operation.response.changed, false);
    assert.equal(operation.response.timed_out, true);
    assert.ok(operation.response.checks >= 3);
    assert.match(operation.responseText, /SI =/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("Adaptive Microprogram Fabric evaluates a branch without model re-entry", async () => {
  const operation = await unified.dispatch({
    action: "flow",
    payload: {
      steps: [
        {
          id: "probe",
          action: "run",
          payload: {
            command: process.execPath,
            args: ["-e", "console.log('ROUTE RED')"],
            idempotent: true,
          },
        },
        {
          id: "red",
          action: "run",
          when: { step: "probe", field: "output", op: "contains", value: "RED" },
          payload: {
            command: process.execPath,
            args: ["-e", "console.log('SELECTED RED BRANCH')"],
            idempotent: true,
          },
        },
        {
          id: "blue",
          action: "run",
          when: { step: "probe", field: "output", op: "contains", value: "BLUE" },
          payload: {
            command: process.execPath,
            args: ["-e", "console.log('UNSELECTED BLUE BRANCH')"],
            idempotent: true,
          },
        },
      ],
    },
  });
  assert.equal(operation.response.ok, 2);
  assert.equal(operation.response.conditional_skipped, 1);
  assert.equal(operation.response.frontiers, 2);
  assert.match(operation.responseText, /SELECTED RED BRANCH/);
  assert.doesNotMatch(operation.responseText, /UNSELECTED BLUE BRANCH/);
  const exact = core.loadCapsule(operation.response.exact).text;
  assert.match(exact, /condition-false/);
});

test("Adaptive Microprogram Fabric rejects unsafe or unbounded conditions", async () => {
  await assert.rejects(
    unified.dispatch({
      action: "flow",
      payload: {
        steps: [{
          id: "bad",
          action: "stats",
          when: { step: "missing", field: "output", op: "contains", value: "x" },
          payload: {},
        }],
      },
    }),
    /invalid when step/
  );
});

test("Roundtrip Singularity skips failed dependencies and rejects unsafe implicit mutations", async () => {
  const operation = await unified.dispatch({
    action: "flow",
    payload: {
      steps: [
        {
          id: "failing",
          action: "run",
          payload: {
            command: process.execPath,
            args: ["-e", "console.error('FLOW EXPECTED FAILURE'); process.exit(2)"],
            idempotent: true,
          },
        },
        {
          id: "dependent",
          action: "stats",
          depends_on: ["failing"],
          payload: {},
        },
      ],
    },
  });
  assert.equal(operation.response.failed, 1);
  assert.equal(operation.response.skipped, 1);
  assert.equal(operation.response.results.find((item) => item.id === "dependent").status, "skipped");

  await assert.rejects(
    unified.dispatch({
      action: "flow",
      payload: {
        steps: [{
          id: "unsafe",
          action: "file",
          payload: { operation: "edit", path: "x", ops: [["e", "x"]] },
        }],
      },
    }),
    /mutating file operations/
  );
});

test("doctor verifies writable standalone state", async () => {
  const operation = await unified.dispatch({ action: "doctor" });
  assert.equal(operation.response.ok, true);
  assert.ok(operation.response.checks.every((item) => item.ok));
});


test("capability airlock deduplicates every exact managed rule but retains near matches", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-airlock-dedup-"));
  const configFile = path.join(codexHome, "config.toml");
  const agentsFile = path.join(codexHome, "AGENTS.md");
  const beforeConfig = "model = \"gpt-5.6-sol\"\n";
  const managedRuleLines = (text) => {
    const startMarker = "<!-- capsule-capability-airlock:start -->";
    const endMarker = "<!-- capsule-capability-airlock:end -->";
    const start = text.indexOf(startMarker);
    const end = text.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0 && end > start, "expected one intact managed block");
    return text.slice(start + startMarker.length, end)
      .split("\n")
      .filter((line) => line.startsWith("- "));
  };
  fs.writeFileSync(configFile, beforeConfig, "utf8");
  fs.writeFileSync(agentsFile, "", "utf8");
  process.env.CODEX_HOME = codexHome;
  try {
    await unified.dispatch({
      action: "skills",
      payload: { operation: "airlock-apply", confirm: true },
    });
    const generated = fs.readFileSync(agentsFile, "utf8");
    const allRules = managedRuleLines(generated);
    assert.equal(allRules.length, 5);
    assert.ok(allRules.some((rule) => /native `apply_patch\|Write\|Edit\|Update`/.test(rule)));
    await unified.dispatch({
      action: "skills",
      payload: { operation: "airlock-restore", confirm: true },
    });
    assert.equal(fs.readFileSync(agentsFile, "utf8"), "");
    assert.equal(fs.readFileSync(configFile, "utf8"), beforeConfig);

    const exactBeforeAgents = `# External exact rules\n\n${allRules.join("\n")}\n`;
    fs.writeFileSync(agentsFile, exactBeforeAgents, "utf8");
    await unified.dispatch({
      action: "skills",
      payload: { operation: "airlock-apply", confirm: true },
    });
    const deduplicated = fs.readFileSync(agentsFile, "utf8");
    assert.deepEqual(managedRuleLines(deduplicated), []);
    const deduplicatedLines = deduplicated.split("\n");
    for (const rule of allRules) {
      assert.equal(deduplicatedLines.filter((line) => line === rule).length, 1);
    }
    await unified.dispatch({
      action: "skills",
      payload: { operation: "airlock-restore", confirm: true },
    });
    assert.equal(fs.readFileSync(agentsFile, "utf8"), exactBeforeAgents);
    assert.equal(fs.readFileSync(configFile, "utf8"), beforeConfig);

    const nearMatch = `${allRules[1].slice(0, -1)}!`;
    const nearBeforeAgents = `# External near match\n\n${nearMatch}\n`;
    fs.writeFileSync(agentsFile, nearBeforeAgents, "utf8");
    await unified.dispatch({
      action: "skills",
      payload: { operation: "airlock-apply", confirm: true },
    });
    const nearActive = fs.readFileSync(agentsFile, "utf8");
    assert.deepEqual(managedRuleLines(nearActive), allRules);
    assert.equal(nearActive.split("\n").filter((line) => line === nearMatch).length, 1);
    assert.equal(nearActive.split("\n").filter((line) => line === allRules[1]).length, 1);
    await unified.dispatch({
      action: "skills",
      payload: { operation: "airlock-restore", confirm: true },
    });
    assert.equal(fs.readFileSync(agentsFile, "utf8"), nearBeforeAgents);
    assert.equal(fs.readFileSync(configFile, "utf8"), beforeConfig);
  } finally {
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});
