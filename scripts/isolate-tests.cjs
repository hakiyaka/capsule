"use strict";

// Preloaded in the Node test runner and each test worker. Tests must never
// inherit the operator's live Capsule database or Codex model configuration.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-test-worker-"));
process.env.CAPSULE_STATE = path.join(root, "state");
process.env.CODEX_HOME = path.join(root, "codex");
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
delete process.env.CAPSULE_MODEL;
delete process.env.CAPSULE_MODEL_PROFILE;
delete process.env.CAPSULE_PRICING_MODEL;
process.on("exit", () => {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // A Windows file lock may defer cleanup; all remaining files are temporary.
  }
});
