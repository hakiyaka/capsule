#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const unified = require("../mcp/unified.cjs");

const HISTORICAL_FALSE_POSITIVES = [
  {
    query: "Passively audit every currently live virtual football match and all betting markets for data, timing, score, odds, identifier, and network anomalies without placing bets or mutating the service.",
    before: "artifact-template-market-trends-report",
  },
  {
    query: "Build a fast retrospective Goaloo scraper and anomaly detector for Crown bookmaker early market closures in FT/HT 1X2 and over-under odds.",
    before: "artifact-template-market-trends-report",
  },
  {
    query: "Find evidence-based internal pricing or state anomalies across already captured live virtual football matches using score-dependent market validity, monotonic odds lines, and cross-market probability consistency; do not invent suspicion.",
    before: "artifact-template-market-trends-report",
  },
  {
    query: "Persist the confirmed stale last_event anomaly and conduct an extended passive longitudinal audit of all live virtual football matches across multiple rounds, tracking score, time, events, odds, and market consistency.",
    before: "artifact-template-market-trends-report",
  },
  {
    query: "Invent a radically new architecture for reducing model reasoning and output tokens before generation while preserving correctness.",
    before: "improve-codebase-architecture",
  },
  {
    query: "Passively investigate a public live virtual football event for anomalies using browser, API, WebSocket, network traffic, and client-side evidence without mutating the service.",
    before: "thick-client",
  },
  {
    query: "Explain and verify how Capsule reduces model-generated output tokens before and during generation.",
    before: "capsule-router",
  },
  {
    query: "What is the current status?",
    before: "gmail-inbox-triage",
  },
];

const POSITIVE_GUARDS = [
  {
    query: "Create the Market Trends Report template",
    expected: "artifact-template-market-trends-report",
  },
  {
    query: "Review this repository codebase architecture and refactor its modules",
    expected: "improve-codebase-architecture",
  },
  {
    query: "Perform authorized security testing of a desktop thick client",
    expected: "thick-client",
  },
  {
    query: "Investigate why the Capsule skill router selects irrelevant skills",
    expected: "capsule-router",
  },
  {
    query: "Triage my Gmail inbox and rank messages needing replies",
    expected: "gmail-inbox-triage",
  },
];

function outputPath() {
  const index = process.argv.indexOf("--write");
  return index >= 0 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]) : "";
}

async function route(query) {
  const result = await unified.dispatch({
    action: "skills",
    payload: { operation: "route", query },
  });
  return result.response.matches[0]?.name || null;
}

async function main() {
  const negative = [];
  for (const item of HISTORICAL_FALSE_POSITIVES) {
    const after = await route(item.query);
    negative.push({
      ...item,
      after,
      pass: after === null,
    });
  }
  const positive = [];
  for (const item of POSITIVE_GUARDS) {
    const after = await route(item.query);
    positive.push({
      ...item,
      after,
      pass: after === item.expected,
    });
  }
  const output = {
    method: "Replay exact historical false-positive intents against the current real capability catalog, then verify explicit modality positives.",
    summary: {
      historical_cases: negative.length,
      before_false_positives: negative.length,
      after_false_positives: negative.filter((item) => !item.pass).length,
      negative_passes: negative.filter((item) => item.pass).length,
      positive_cases: positive.length,
      positive_passes: positive.filter((item) => item.pass).length,
    },
    historical_replay: negative,
    positive_guards: positive,
  };
  const rendered = `${JSON.stringify(output, null, 2)}\n`;
  const target = outputPath();
  if (target) fs.writeFileSync(target, rendered, "utf8");
  process.stdout.write(rendered);
  if (output.summary.after_false_positives ||
      output.summary.positive_passes !== output.summary.positive_cases) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}).finally(() => {
  unified.closeSearchDatabase();
});
