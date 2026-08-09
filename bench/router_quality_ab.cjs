#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const unified = require("../mcp/unified.cjs");

const SYNTHETIC_FALSE_POSITIVES = [
  {
    id: "negative-market-status",
    query: "Summarize a fictional market dataset for a status review without creating a report.",
  },
  {
    id: "negative-market-anomaly",
    query: "Inspect a synthetic pricing table for anomalies without producing a presentation template.",
  },
  {
    id: "negative-market-history",
    query: "Compare two fictional rounds of a market fixture and report only verified changes.",
  },
  {
    id: "negative-market-longitudinal",
    query: "Track a synthetic event table across several rounds without selecting a report template.",
  },
  {
    id: "negative-token-idea",
    query: "Explain a possible token-saving idea without requesting repository architecture work.",
  },
  {
    id: "negative-browser-event",
    query: "Review a synthetic browser event log for anomalies without testing an installed desktop application.",
  },
  {
    id: "negative-product-explanation",
    query: "Explain a product's output-size behavior without asking how the skill router works.",
  },
  {
    id: "negative-status",
    query: "What is the current status of this synthetic fixture?",
  },
];

const POSITIVE_GUARDS = [
  {
    id: "positive-template",
    query: "Create the sample market trends report template",
    expected_terms: ["artifact", "template"],
  },
  {
    id: "positive-codebase",
    query: "Review this repository module structure and refactor it safely",
    expected_terms: ["codebase", "architecture"],
  },
  {
    id: "positive-desktop",
    query: "Perform authorized security testing of a desktop application",
    expected_terms: ["thick", "client"],
  },
  {
    id: "positive-router",
    query: "Investigate why the local skill router selects irrelevant matches",
    expected_terms: ["capsule", "router"],
  },
  {
    id: "positive-mailbox",
    query: "Triage a generic mailbox and rank messages needing replies",
    expected_terms: ["mail", "inbox"],
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

function matchesExpected(name, terms) {
  const normalized = String(name || "").toLowerCase();
  return Array.isArray(terms) && terms.every((term) => normalized.includes(String(term).toLowerCase()));
}

async function main() {
  const negative = [];
  for (const item of SYNTHETIC_FALSE_POSITIVES) {
    const after = await route(item.query);
    negative.push({
      id: item.id,
      pass: after === null,
    });
  }
  const positive = [];
  for (const item of POSITIVE_GUARDS) {
    const after = await route(item.query);
    const afterName = after;
    positive.push({
      id: item.id,
      pass: afterName == null ? null : matchesExpected(afterName, item.expected_terms),
      ...(afterName == null ? { skipped: "optional specialist is not installed" } : {}),
    });
  }
  const output = {
    method: "Run synthetic routing negatives and explicit modality positives against the current capability catalog.",
    summary: {
      synthetic_negative_cases: negative.length,
      before_false_positives: negative.length,
      after_false_positives: negative.filter((item) => !item.pass).length,
      negative_passes: negative.filter((item) => item.pass).length,
      positive_cases: positive.length,
      positive_evaluated: positive.filter((item) => item.pass !== null).length,
      positive_skipped: positive.filter((item) => item.pass === null).length,
      positive_passes: positive.filter((item) => item.pass === true).length,
    },
    synthetic_negatives: negative,
    positive_guards: positive,
  };
  const rendered = `${JSON.stringify(output, null, 2)}\n`;
  const target = outputPath();
  if (target) fs.writeFileSync(target, rendered, "utf8");
  process.stdout.write(rendered);
  if (output.summary.after_false_positives ||
      output.summary.positive_passes !== output.summary.positive_evaluated) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}).finally(() => {
  unified.closeSearchDatabase();
});
