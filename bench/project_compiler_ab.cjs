#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const temporaryState = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-project-bench-state-"));
process.env.CAPSULE_STATE = temporaryState;
const project = require("../mcp/project.cjs");

const DEFAULT_CASES = [
  {
    id: "mcp-dispatch",
    query: "How does Capsule dispatch MCP actions and preserve exact evidence?",
    expected_groups: [["mcp/server.cjs"], ["mcp/unified.cjs"]],
  },
  {
    id: "project-profit",
    query: "How does project scanning, semantic cache reuse, impact selection, and the token profit gate work?",
    expected_groups: [["mcp/project.cjs"]],
  },
  {
    id: "lifecycle-compaction",
    query: "How do lifecycle hooks preserve session continuity across context compaction?",
    expected_groups: [["scripts/hook.cjs"], ["mcp/compaction.cjs"]],
  },
  {
    id: "atomic-edit",
    query: "How are multi-file edits validated, verified, and rolled back atomically?",
    expected_groups: [["mcp/edit.cjs"]],
  },
  {
    id: "skill-routing",
    query: "How does skill routing select a relevant specialist and abstain from unrelated matches?",
    expected_groups: [["mcp/unified.cjs"]],
  },
  {
    id: "terminal-reuse",
    query: "How are repeated terminal results reduced while preserving exact changed evidence?",
    expected_groups: [["mcp/terminal-novelty.cjs", "mcp/terminal-genome.cjs", "mcp/terminal-lattice.cjs"]],
  },
];

function parseArgs(argv) {
  const result = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") result.root = argv[++index];
    else if (argument === "--query") result.query = argv[++index];
    else if (argument === "--write") result.write = argv[++index];
    else positional.push(argument);
  }
  if (!result.root && positional.length) result.root = positional.shift();
  if (!result.query && positional.length) result.query = positional.join(" ");
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root || path.join(__dirname, ".."));
  const cases = args.query
    ? [{ id: "custom", query: args.query, expected_groups: [] }]
    : DEFAULT_CASES;
  try {
    const results = [];
    for (const benchmarkCase of cases) {
      fs.rmSync(path.join(temporaryState, "projects"), { recursive: true, force: true });
      const coldStarted = process.hrtime.bigint();
      const cold = project.queryProject({
        root,
        query: benchmarkCase.query,
        depth: 2,
        max_files: 18,
      });
      const coldMs = Number(process.hrtime.bigint() - coldStarted) / 1_000_000;
      const warmStarted = process.hrtime.bigint();
      const warm = project.queryProject({
        root,
        query: benchmarkCase.query,
        depth: 2,
        max_files: 18,
      });
      const warmMs = Number(process.hrtime.bigint() - warmStarted) / 1_000_000;
      const selectedPaths = warm.response.selected_files.map((file) => file.path);
      const missingGroups = benchmarkCase.expected_groups.filter((group) =>
        !group.some((expected) => selectedPaths.includes(expected))
      );
      results.push({
        id: benchmarkCase.id,
        query: benchmarkCase.query,
        baseline_tokens: cold.response.profit_gate.baseline_tokens,
        cold: {
          elapsed_ms: Number(coldMs.toFixed(2)),
          cache_mode: cold.response.cache_mode,
          emitted_tokens: cold.response.profit_gate.emitted_tokens,
          avoided_tokens: cold.response.profit_gate.avoided_tokens,
          avoided_ratio: cold.response.profit_gate.avoided_ratio,
        },
        warm: {
          elapsed_ms: Number(warmMs.toFixed(2)),
          cache_mode: warm.response.cache_mode,
          emitted_tokens: warm.response.profit_gate.emitted_tokens,
          avoided_tokens: warm.response.profit_gate.avoided_tokens,
          avoided_ratio: warm.response.profit_gate.avoided_ratio,
        },
        selected_paths: warm.response.selected_files.map((file) => ({
          path: file.path,
          score: Number(file.score.toFixed(2)),
          via: file.via,
        })),
        quality: {
          passed: missingGroups.length === 0,
          expected_groups: benchmarkCase.expected_groups,
          missing_groups: missingGroups,
        },
        exact: warm.response.exact,
      });
    }
    const baselineTokens = results.reduce((total, item) => total + item.baseline_tokens, 0);
    const coldEmitted = results.reduce((total, item) => total + item.cold.emitted_tokens, 0);
    const warmEmitted = results.reduce((total, item) => total + item.warm.emitted_tokens, 0);
    const result = {
      benchmark: "project-compiler-ab",
      root: "repository",
      cases: results,
      aggregate: {
        cases: results.length,
        quality_passed: results.filter((item) => item.quality.passed).length,
        baseline_tokens: baselineTokens,
        cold_emitted_tokens: coldEmitted,
        cold_avoided_tokens: Math.max(0, baselineTokens - coldEmitted),
        cold_avoided_ratio: baselineTokens
          ? Number(((baselineTokens - coldEmitted) / baselineTokens).toFixed(4))
          : 0,
        warm_emitted_tokens: warmEmitted,
        warm_avoided_tokens: Math.max(0, baselineTokens - warmEmitted),
        warm_avoided_ratio: baselineTokens
          ? Number(((baselineTokens - warmEmitted) / baselineTokens).toFixed(4))
          : 0,
      },
      caveat: "Token comparison is against the raw selected-file evidence for the same query, not provider billing.",
    };
    if (args.write) fs.writeFileSync(path.resolve(args.write), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    fs.rmSync(temporaryState, { recursive: true, force: true });
  }
}

main();
