"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { compareSearchSnapshots, summarizeReleases, summarizeReferrers } = require("../scripts/github-visibility-metrics.cjs");
const { collectPaginated, formatError, normalizeRepository } = require("../scripts/github-visibility-helpers.cjs");

test("normalizes repository overrides and rejects API-path injection", () => {
  assert.equal(normalizeRepository("  octo-org/example.repo  "), "octo-org/example.repo");
  assert.equal(normalizeRepository(""), "hakiyaka/capsule");
  assert.throws(() => normalizeRepository("octo-org/example?admin=true"), /owner\/name syntax/);
  assert.throws(() => normalizeRepository("../other/repo"), /owner\/name syntax/);
});

test("collects every release page and marks an exact full-page boundary as truncated", () => {
  const requests = [];
  const result = collectPaginated((endpoint) => {
    requests.push(endpoint);
    const page = Number(endpoint.match(/page=(\d+)$/)?.[1]);
    return [{id: page * 2 - 1}, {id: page * 2}];
  }, "repos/octo-org/example/releases", {pageSize: 2, maxPages: 4});
  assert.deepEqual(result, {
    items: [{id: 1}, {id: 2}, {id: 3}, {id: 4}, {id: 5}, {id: 6}, {id: 7}, {id: 8}],
    pages: 4,
    truncated: true,
  });
  assert.deepEqual(requests, [
    "repos/octo-org/example/releases?per_page=2&page=1",
    "repos/octo-org/example/releases?per_page=2&page=2",
    "repos/octo-org/example/releases?per_page=2&page=3",
    "repos/octo-org/example/releases?per_page=2&page=4",
  ]);
  const complete = collectPaginated((endpoint) => endpoint.endsWith("page=1") ? [{id: 1}] : [], "repos/o/r?state=all", {pageSize: 2});
  assert.deepEqual(complete, {items: [{id: 1}], pages: 1, truncated: false});
});

test("bounds optional API diagnostics without discarding the cause", () => {
  const error = new Error(`HTTP 403 ${"x".repeat(900)}`);
  const formatted = formatError(error);
  assert.match(formatted, /^HTTP 403/);
  assert.equal(formatted.length, 500);
});

test("summarizes GitHub popular referrer rows", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "github-traffic-referrers.json"), "utf8"));
  assert.deepEqual(summarizeReferrers(fixture), {
    referrer_domains_14d: 2,
    referrer_views_14d: 46,
    referrer_uniques_sum_14d: 4,
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
  assert.match(source, /maxBuffer: apiMaxBuffer/);
  assert.match(source, /collectPaginated/);
  assert.match(source, /community_error/);
  assert.match(source, /pages_error/);
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
    {query: "codex token efficiency", rank_improvement: 8, present_in_first_100_delta: 0, total_count_delta: 6},
    {query: "mcp context compression", rank_improvement: null, present_in_first_100_delta: -1, total_count_delta: 1},
  ]);
});

test("does not convert errored or incomplete search snapshots into rank loss", () => {
  assert.deepEqual(compareSearchSnapshots(
    {queries: [{query: "codex", error: "rate limit"}]},
    {queries: [{query: "codex", rank_in_first_100: 4, total_count: 8}]},
  ), [{query: "codex", rank_improvement: null, present_in_first_100_delta: null, total_count_delta: null}]);
  assert.deepEqual(compareSearchSnapshots(
    {queries: [{query: "codex", rank_in_first_100: 4, total_count: null, incomplete_results: true}]},
    {queries: [{query: "codex", rank_in_first_100: 7, total_count: 8}]},
  ), [{query: "codex", rank_improvement: null, present_in_first_100_delta: null, total_count_delta: null}]);
});

test("keeps Windows-safe search snapshot helpers and rejects unknown flags", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.equal(packageJson.scripts["audit:github-visibility:search:write"], "node scripts/github-visibility-audit.cjs --search --write");
  assert.equal(packageJson.scripts["audit:github-visibility:search:baseline"], "node scripts/github-visibility-audit.cjs --search --baseline");
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "github-visibility-audit.cjs"), "--unknown"], {encoding: "utf8"});
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /Unknown argument/);
});
