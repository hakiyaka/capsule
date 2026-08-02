#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-refactor-bench-"));
process.env.CAPSULE_STATE = state;
const project = require("../mcp/project.cjs");

const root = path.resolve(__dirname, "..");
const options = {
  root,
  target: "queryProject",
  depth: 2,
  max_files: 14,
  max_chars: 6_000,
};

try {
  const baseline = project.queryProject({
    root,
    query: "How does queryProject select an impact cone and pack exact evidence?",
    depth: 2,
    max_files: 14,
    max_chars: 12_000,
  });
  fs.rmSync(path.join(state, "projects"), { recursive: true, force: true });
  const cold = project.refactorProject(options);
  const warm = project.refactorProject(options);
  const baselineTokens = baseline.response.profit_gate.emitted_tokens;
  const refactorTokens = warm.response.profit_gate.emitted_tokens;
  const result = {
    benchmark: "refactor-proof-packet-ab",
    target: options.target,
    baseline: {
      route: baseline.route,
      emitted_tokens: baselineTokens,
      selected_files: baseline.response.selected_files.length,
    },
    refactor: {
      route: warm.route,
      emitted_tokens: refactorTokens,
      selected_files: warm.response.selected_files.length,
      cold_hashed: cold.response.hashed,
      warm_metadata_reused: warm.response.metadata_reused,
      warm_hashed: warm.response.hashed,
      exact: warm.response.exact,
      proof: /proof=hash\+span\+dependency-cone/.test(warm.responseText),
    },
    saving_percent: baselineTokens
      ? Number(((baselineTokens - refactorTokens) / baselineTokens * 100).toFixed(2))
      : 0,
    caveat: "Compares model-visible project evidence for this refactor target; not provider billing or generated-answer tokens.",
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (warm.route !== "project-refactor-proof" || !result.refactor.proof || warm.response.hashed !== 0) {
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(state, { recursive: true, force: true });
}
