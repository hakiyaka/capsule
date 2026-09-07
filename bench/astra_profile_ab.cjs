"use strict";

// Deterministic policy A/B. No provider request, inferred reasoning savings,
// subscription billing claim, or invented Astra tokenization/pricing.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const advisor = require("../mcp/advisor.cjs");
const cognition = require("../mcp/cognition.cjs");
const profile = require("../mcp/model-profile.cjs");

function measure() {
  const prompt = "Implement the cache fix and run tests.";
  const baseline = advisor.plan({ prompt, model: "gpt-5.6-sol" }).response;
  const astra = advisor.plan({ prompt, model: "gpt-6-astra" }).response;
  const before = cognition.planEscrow({ prompt, model: "gpt-5.6-sol" }).response;
  const after = cognition.planEscrow({ prompt, model: "gpt-6-astra" }).response;
  assert.ok(astra.max_output_chars < baseline.max_output_chars);
  assert.ok(after.word_budget < before.word_budget);
  assert.equal(profile.outputScale("future-model"), 1);
  return {
    method: "deterministic default-budget A/B; no model execution",
    model: "gpt-6-astra",
    advisor_output_char_budget: { baseline: baseline.max_output_chars, astra: astra.max_output_chars },
    final_word_budget: { baseline: before.word_budget, astra: after.word_budget },
    automatic_budget_reduction_percent: 25,
    caveat: "Budget reduction is not measured provider token usage or a billing saving. Exact/failure preservation is covered by npm test.",
  };
}

if (require.main === module) {
  const result = measure();
  const index = process.argv.indexOf("--write");
  if (index >= 0) {
    if (!process.argv[index + 1]) throw new Error("--write needs a path");
    fs.writeFileSync(path.resolve(process.argv[index + 1]), `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

module.exports = { measure };
