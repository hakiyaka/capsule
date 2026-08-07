"use strict";

// Experimental, opt-in web lease benchmark. Search text and navigation remain
// exact on disk; only the model-visible web envelope is replaced by a handle.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const previousState = process.env.CAPSULE_STATE;
const previousMode = process.env.CAPSULE_WEB_ZERO_COPY;
const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-web-zero-copy-"));
process.env.CAPSULE_STATE = state;
process.env.CAPSULE_WEB_ZERO_COPY = "1";

const hook = require("../scripts/hook.cjs");

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function percent(before, after) {
  return Number(((before - after) / before * 100).toFixed(2));
}

function runCase(name, suffix = "stable", repetitions = name === "repeat" ? 3 : 1) {
  const output = {
    content: Array.from({ length: 24 }, (_, index) => ({
      type: "search_result",
      title: `${name} result ${index}`,
      url: `https://example.test/${name}/${index}?q=exact`,
      ref_id: `turn-web-${name}-${index}`,
      text: `Exact searchable evidence ${suffix} ${index}. ${"context ".repeat(480)}`,
    })),
    query: "exact searchable evidence",
  };
  const raw = JSON.stringify(output);
  const results = Array.from({ length: repetitions }, (_, index) => hook.handle("posttooluse", {
    tool_name: "web.run",
    tool_input: { search_query: [{ q: "exact searchable evidence" }], capsule_web_zero_copy: true },
    tool_output: output,
    cwd: process.cwd(),
    session_id: `web-zero-copy-${name}-${index}`,
  }));
  const after = results.reduce((total, result) => {
    assert.equal(result.continue, false, `${name} did not use a web lease`);
    const reference = JSON.parse(result.reason);
    assert.equal(reference.visual_fidelity, "exact-text-and-navigation");
    assert.equal(fs.readFileSync(reference.exact_path, "utf8"), raw);
    assert.equal(reference.exact_sha256, sha256(raw));
    assert.doesNotMatch(result.reason, /Exact searchable evidence/);
    return total + result.reason.length + String(result.hookSpecificOutput?.additionalContext || "").length;
  }, 0);
  return { name, repetitions, before_chars: raw.length * repetitions, after_chars: after, saving_percent: percent(raw.length * repetitions, after), exact_recovery: true };
}

try {
  const cases = [runCase("first"), runCase("last"), runCase("repeat"), runCase("new-turn"), runCase("changed", "changed result evidence")];
  const output = {
    benchmark: "web-zero-copy-lossless",
    method: "Exact local web lease; text, URLs, and reference ids are recoverable byte-for-byte.",
    caveat: "Not a provider search-token, freshness, or billing measurement.",
    safety_pass: cases.every((item) => item.exact_recovery && item.saving_percent > 0),
    cases,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.safety_pass) process.exitCode = 1;
} finally {
  if (previousState == null) delete process.env.CAPSULE_STATE;
  else process.env.CAPSULE_STATE = previousState;
  if (previousMode == null) delete process.env.CAPSULE_WEB_ZERO_COPY;
  else process.env.CAPSULE_WEB_ZERO_COPY = previousMode;
  fs.rmSync(state, { recursive: true, force: true });
}
