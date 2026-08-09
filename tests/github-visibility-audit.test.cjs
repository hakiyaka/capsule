"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { compareSearchSnapshots, summarizeReleases, summarizeReferrers } = require("../scripts/github-visibility-metrics.cjs");

test("summarizes GitHub popular referrer rows", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "github-traffic-referrers.json"), "utf8"));
  assert.deepEqual(summarizeReferrers(fixture), {
    referrer_domains_14d: 2,
    referrer_views_14d: 46,
    unique_referrers_14d: 4,
    top_referrer: "github.com",
  });
});

test("summarizes release assets and downloads", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "github-releases.json"), "utf8"));
  assert.deepEqual(summarizeReleases(fixture), {
    release_assets: 2,
    release_downloads: 9,
    release_asset_names: ["capsule-1.0.0-source.zip", "capsule-1.0.0-source.zip.sha256"],
  });
});

test("uses the GitHub popular referrers endpoint", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "github-visibility-audit.cjs"), "utf8");
  assert.match(source, /traffic\/popular\/referrers/);
  assert.doesNotMatch(source, /traffic\/referrers/);
});

test("compares repository-search snapshots without inventing missing ranks", () => {
  const current = { queries: [
    {query: "codex token efficiency", rank_in_first_100: 12, total_count: 40},
    {query: "mcp context compression", rank_in_first_100: null, total_count: 118},
  ]};
  const baseline = { queries: [
    {query: "codex token efficiency", rank_in_first_100: 20, total_count: 34},
    {query: "mcp context compression", rank_in_first_100: 99, total_count: 117},
  ]};
  assert.deepEqual(compareSearchSnapshots(current, baseline), [
    {query: "codex token efficiency", rank_delta: 8, present_in_first_100_delta: 0, total_count_delta: 6},
    {query: "mcp context compression", rank_delta: null, present_in_first_100_delta: -1, total_count_delta: 1},
  ]);
});
