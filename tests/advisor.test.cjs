"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const advisor = require("../mcp/advisor.cjs");

test("advisor creates bounded integration lanes without persisting the prompt", () => {
  const prompt = "Add Firebase auth, Stripe paywall, Figma button fixes, localization, and screenshots.";
  const result = advisor.plan({ prompt }).response;
  assert.deepEqual(result.integrations, ["firebase", "stripe", "figma", "localization", "media"]);
  assert.ok(result.max_tool_calls <= 32);
  assert.ok(result.max_read_calls < result.max_tool_calls);
  assert.equal(result.worktree, "off-by-default");
  assert.equal(result.subagents, "off by default");
  assert.doesNotMatch(result.context, /Firebase auth/);
  assert.equal(result.privacy.includes("raw prompt"), true);
});

test("advisor marks a genuinely new goal as a task boundary", () => {
  const first = advisor.plan({ prompt: "Inspect the checkout screen and fix its button." }).response;
  const same = advisor.plan({
    prompt: "Fix the checkout button and verify the screen.",
    previous_task: { fingerprint: first.task_fingerprint, term_hashes: first.term_hashes },
  }).response;
  const different = advisor.plan({
    prompt: "New unrelated task: audit the database migration.",
    previous_task: { fingerprint: first.task_fingerprint, term_hashes: first.term_hashes },
  }).response;
  assert.equal(same.task_boundary, false);
  assert.equal(different.task_boundary, true);
});

test("advisor keeps short continuation messages in the current task", () => {
  const first = advisor.plan({ prompt: "Inspect the project and fix the checkout flow." }).response;
  for (const prompt of ["devam et", "yaptım", "yeniden başlattım", "continue"]) {
    const next = advisor.plan({
      prompt,
      previous_task: { fingerprint: first.task_fingerprint, term_hashes: first.term_hashes },
    }).response;
    assert.equal(next.task_boundary, false, prompt);
  }
});

test("advisor action is available through the single Capsule surface", async () => {
  const unified = require("../mcp/unified.cjs");
  const result = await unified.dispatch({
    action: "advisor",
    payload: { operation: "plan", prompt: "Group the three file edits and run one test." },
  });
  assert.equal(result.response.operation, "plan");
  assert.match(result.responseText, /Capsule advisor/);
});

test("advisor exposes activation/measurement escape hatches and can be disabled", () => {
  const previous = process.env.CAPSULE_ADVISOR;
  const previousVisible = process.env.CAPSULE_ADVISOR_VISIBLE;
  try {
    delete process.env.CAPSULE_ADVISOR;
    delete process.env.CAPSULE_ADVISOR_VISIBLE;
    const enabled = advisor.plan({ prompt: "Group the file edits and verify once." }).response;
    assert.equal(enabled.advisor_enabled, true);
    assert.match(enabled.activation, /doctor/);
    assert.match(enabled.observability, /gain/);
    assert.equal(enabled.escape_hatch, "capsule_force=true");
    process.env.CAPSULE_ADVISOR = "0";
    const disabled = advisor.plan({ prompt: "Group the file edits and verify once." }).response;
    assert.equal(disabled.advisor_enabled, false);
    assert.equal(disabled.context, "");
    delete process.env.CAPSULE_ADVISOR;
    process.env.CAPSULE_ADVISOR_VISIBLE = "0";
    const silent = advisor.plan({ prompt: "Group the file edits and verify once." }).response;
    assert.equal(silent.advisor_enabled, true);
    assert.equal(silent.advisor_visible, false);
    assert.equal(silent.context, "");
  } finally {
    if (previous == null) delete process.env.CAPSULE_ADVISOR;
    else process.env.CAPSULE_ADVISOR = previous;
    if (previousVisible == null) delete process.env.CAPSULE_ADVISOR_VISIBLE;
    else process.env.CAPSULE_ADVISOR_VISIBLE = previousVisible;
  }
});

test("advisor opt-out does not inherit a previous task budget", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-advisor-optout-"));
  const previousState = process.env.CAPSULE_STATE;
  const previousBudget = process.env.CAPSULE_TOOL_CALL_BUDGET;
  const previousAdvisor = process.env.CAPSULE_ADVISOR;
  process.env.CAPSULE_STATE = state;
  process.env.CAPSULE_TOOL_CALL_BUDGET = "1";
  delete process.env.CAPSULE_ADVISOR;
  const hook = require("../scripts/hook.cjs");
  const input = { session_id: "advisor-optout-test", cwd: state };
  try {
    hook.handle("userpromptsubmit", { ...input, prompt: "Inspect and group the project changes." });
    hook.handle("pretooluse", {
      ...input,
      tool_name: "functions.read_file",
      tool_input: { path: "a" },
    });
    process.env.CAPSULE_ADVISOR = "0";
    const allowed = hook.handle("pretooluse", {
      ...input,
      tool_name: "functions.read_file",
      tool_input: { path: "b" },
    });
    assert.notEqual(allowed.hookSpecificOutput?.permissionDecision, "deny");
  } finally {
    if (previousState == null) delete process.env.CAPSULE_STATE;
    else process.env.CAPSULE_STATE = previousState;
    if (previousBudget == null) delete process.env.CAPSULE_TOOL_CALL_BUDGET;
    else process.env.CAPSULE_TOOL_CALL_BUDGET = previousBudget;
    if (previousAdvisor == null) delete process.env.CAPSULE_ADVISOR;
    else process.env.CAPSULE_ADVISOR = previousAdvisor;
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("hook resets task evidence when the workspace changes", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-advisor-project-"));
  const previousState = process.env.CAPSULE_STATE;
  const previousBudget = process.env.CAPSULE_TOOL_CALL_BUDGET;
  process.env.CAPSULE_STATE = state;
  process.env.CAPSULE_TOOL_CALL_BUDGET = "1";
  const hook = require("../scripts/hook.cjs");
  const first = { session_id: "advisor-project-test", cwd: path.join(state, "one") };
  const second = { session_id: "advisor-project-test", cwd: path.join(state, "two") };
  try {
    hook.handle("userpromptsubmit", { ...first, prompt: "Inspect and group the project changes." });
    hook.handle("pretooluse", { ...first, tool_name: "functions.read_file", tool_input: { path: "a" } });
    hook.handle("userpromptsubmit", { ...second, prompt: "Inspect and group the project changes." });
    const allowed = hook.handle("pretooluse", {
      ...second,
      tool_name: "functions.read_file",
      tool_input: { path: "b" },
    });
    assert.notEqual(allowed.hookSpecificOutput?.permissionDecision, "deny");
  } finally {
    if (previousState == null) delete process.env.CAPSULE_STATE;
    else process.env.CAPSULE_STATE = previousState;
    if (previousBudget == null) delete process.env.CAPSULE_TOOL_CALL_BUDGET;
    else process.env.CAPSULE_TOOL_CALL_BUDGET = previousBudget;
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("hook starts a task budget and withholds a read after the cap", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-advisor-hook-"));
  const previousState = process.env.CAPSULE_STATE;
  const previousBudget = process.env.CAPSULE_TOOL_CALL_BUDGET;
  process.env.CAPSULE_STATE = state;
  process.env.CAPSULE_TOOL_CALL_BUDGET = "2";
  const hook = require("../scripts/hook.cjs");
  const input = { session_id: "advisor-budget-test", cwd: state };
  try {
    const start = hook.handle("userpromptsubmit", {
      ...input,
      prompt: "Inspect Firebase configuration and group the required changes.",
    });
    assert.match(start.hookSpecificOutput.additionalContext, /Capsule advisor/);
    hook.handle("pretooluse", { ...input, tool_name: "functions.read_file", tool_input: { path: "a" } });
    hook.handle("pretooluse", { ...input, tool_name: "functions.read_file", tool_input: { path: "b" } });
    const blocked = hook.handle("pretooluse", {
      ...input,
      tool_name: "functions.read_file",
      tool_input: { path: "c" },
    });
    assert.equal(blocked.hookSpecificOutput.permissionDecision, "deny");
    assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /tool budget/);
  } finally {
    if (previousState == null) delete process.env.CAPSULE_STATE;
    else process.env.CAPSULE_STATE = previousState;
    if (previousBudget == null) delete process.env.CAPSULE_TOOL_CALL_BUDGET;
    else process.env.CAPSULE_TOOL_CALL_BUDGET = previousBudget;
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("task budget also covers observational shell reads", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-advisor-shell-"));
  const previousState = process.env.CAPSULE_STATE;
  const previousBudget = process.env.CAPSULE_TOOL_CALL_BUDGET;
  process.env.CAPSULE_STATE = state;
  process.env.CAPSULE_TOOL_CALL_BUDGET = "1";
  const hook = require("../scripts/hook.cjs");
  const input = { session_id: "advisor-shell-budget-test", cwd: state };
  try {
    hook.handle("userpromptsubmit", { ...input, prompt: "Inspect the repository structure." });
    hook.handle("pretooluse", {
      ...input,
      tool_name: "functions.exec_command",
      tool_input: { command: "Get-Content package.json" },
    });
    const blocked = hook.handle("pretooluse", {
      ...input,
      tool_name: "functions.exec_command",
      tool_input: { command: "rg -n export src" },
    });
    assert.equal(blocked.hookSpecificOutput.permissionDecision, "deny");
    assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /tool budget/);
  } finally {
    if (previousState == null) delete process.env.CAPSULE_STATE;
    else process.env.CAPSULE_STATE = previousState;
    if (previousBudget == null) delete process.env.CAPSULE_TOOL_CALL_BUDGET;
    else process.env.CAPSULE_TOOL_CALL_BUDGET = previousBudget;
    fs.rmSync(state, { recursive: true, force: true });
  }
});
