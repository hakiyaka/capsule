"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const core = require("../mcp/core.cjs");

test("GPT-5.6 dollar counter prices avoided input context with an explicit cache range", () => {
  const sol = core.estimateInputSavingsUsd(19_465_523, {
    pricing_model: "gpt-5.6-sol",
    context_tier: "short",
    cached_share: 0.5,
  });
  assert.equal(sol.model, "gpt-5.6-sol");
  assert.equal(sol.estimated_saved_usd, 53.530188);
  assert.deepEqual(sol.range_usd, {
    all_cached: 9.732762,
    all_uncached: 97.327615,
  });
  assert.deepEqual(sol.price_usd_per_million, {
    input: 5,
    cached_input: 0.5,
  });
  assert.match(sol.scope, /not a ChatGPT\/Codex subscription bill/i);

  const terraLong = core.estimateInputSavingsUsd(1_000_000, {
    pricing_model: "gpt-5.6-terra",
    context_tier: "long",
    cached_share: 0.25,
  });
  assert.equal(terraLong.estimated_saved_usd, 3.875);
  assert.deepEqual(terraLong.range_usd, {
    all_cached: 0.5,
    all_uncached: 5,
  });

  const generic = core.estimateInputSavingsUsd(1_000_000, {
    pricing_model: "gpt-5.6",
    cached_share: 0,
  });
  assert.equal(generic.model, "gpt-5.6-sol");
  assert.equal(generic.estimated_saved_usd, 5);
});
