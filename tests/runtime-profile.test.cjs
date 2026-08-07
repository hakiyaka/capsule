"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const runtime = require("../mcp/runtime.cjs");
const hook = require("../scripts/hook.cjs");

test("environment leases compact Windows setup discovery and cache probes", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-runtime-profile-"));
  const previousState = process.env.CAPSULE_STATE;
  process.env.CAPSULE_STATE = state;
  let probes = 0;
  try {
    const first = runtime.environmentProfile({
      cwd: state,
      platform: "win32",
      env: { PATH: "C:\\Windows;C:\\Tools", PATHEXT: ".EXE;.CMD" },
      probe: () => {
        probes += 1;
        return true;
      },
    });
    const second = runtime.environmentProfile({
      cwd: state,
      platform: "win32",
      env: { PATH: "C:\\Windows;C:\\Tools", PATHEXT: ".EXE;.CMD" },
      probe: () => {
        probes += 1;
        throw new Error("cached environment should not probe again");
      },
    });
    assert.equal(first.response.cache_hit, false);
    assert.equal(second.response.cache_hit, true);
    assert.equal(second.response.savings.repeated_probe_calls_avoided, first.response.probe_count);
    assert.equal(probes, first.response.probe_count);
    assert.equal(second.responseText.includes("C:\\Windows"), false);
    assert.match(second.response.python.command, /py -3|python/);
    assert.equal(second.response.path.entries, 2);
  } finally {
    if (previousState == null) delete process.env.CAPSULE_STATE;
    else process.env.CAPSULE_STATE = previousState;
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("environment lease invalidates when the PATH fingerprint changes", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-runtime-profile-change-"));
  const previousState = process.env.CAPSULE_STATE;
  process.env.CAPSULE_STATE = state;
  try {
    const first = runtime.environmentProfile({
      cwd: state,
      env: { PATH: "one", PATHEXT: ".EXE" },
      probe: () => true,
    });
    const changed = runtime.environmentProfile({
      cwd: state,
      env: { PATH: "one;two", PATHEXT: ".EXE" },
      probe: () => true,
    });
    assert.notEqual(first.response.lease_id, changed.response.lease_id);
    assert.equal(changed.response.cache_hit, false);
  } finally {
    if (previousState == null) delete process.env.CAPSULE_STATE;
    else process.env.CAPSULE_STATE = previousState;
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("Windows setup prompts receive one environment lease instead of repeated discovery guidance", { skip: process.platform !== "win32" }, () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-runtime-hook-"));
  const previousState = process.env.CAPSULE_STATE;
  process.env.CAPSULE_STATE = state;
  try {
    const input = {
      session_id: `runtime-hook-${Date.now()}`,
      cwd: state,
      prompt: "Set up the Python venv and fix the PowerShell PATH issue.",
    };
    const first = hook.handle("userpromptsubmit", input);
    const second = hook.handle("userpromptsubmit", input);
    const firstText = first.hookSpecificOutput?.additionalContext || "";
    const secondText = second.hookSpecificOutput?.additionalContext || "";
    assert.match(firstText, /Environment lease/);
    assert.doesNotMatch(secondText, /Environment lease/);
  } finally {
    if (previousState == null) delete process.env.CAPSULE_STATE;
    else process.env.CAPSULE_STATE = previousState;
    fs.rmSync(state, { recursive: true, force: true });
  }
});
