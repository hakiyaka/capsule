"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { compareSearchSnapshots, ratio, summarizeReleases, summarizeReferrers, summarizeTrafficWindow, validSearchEntry } = require("../scripts/github-visibility-metrics.cjs");
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

test("records the observed traffic window and reports API lag explicitly", () => {
  const summary = summarizeTrafficWindow([
    {timestamp: "2026-08-01T00:00:00Z", count: 2},
    {timestamp: "2026-08-07T00:00:00Z", count: 3},
  ], Date.parse("2026-08-09T12:00:00Z"));
  assert.deepEqual(summary, {
    observed_start: "2026-08-01T00:00:00.000Z",
    observed_end: "2026-08-07T00:00:00.000Z",
    observed_points: 2,
    lag_days: 2.5,
  });
  assert.deepEqual(summarizeTrafficWindow([], Date.now()), {
    observed_start: null,
    observed_end: null,
    observed_points: 0,
    lag_days: null,
  });
});

test("keeps unavailable or missing aggregate values unknown", () => {
  assert.equal(ratio(null, 10), null);
  assert.equal(ratio(10, null), null);
  assert.equal(ratio(20, 10), 2);
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "github-visibility-audit.cjs"), "utf8");
  assert.match(source, /unique_viewers_14d: viewsShapeValid \? finiteNumber\(views\.uniques\) : null/);
  assert.match(source, /unique_cloners_14d: clonesShapeValid \? finiteNumber\(clones\.uniques\) : null/);
  assert.match(source, /referrer_domains_14d: null/);
  assert.match(source, /popular_paths_14d: null/);
  assert.match(source, /malformed traffic views response/);
  assert.match(source, /draft_releases_omitted/);
  assert.match(source, /releaseTotalsComparable/);
  assert.match(source, /metrics_semantics_version/);
  assert.match(source, /is:public/);
  assert.match(source, /metric semantics differ/);
  assert.match(source, /report\.search_deltas = null/);
  assert.match(source, /traffic windows differ/);
});

test("uses the GitHub popular referrers endpoint", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "github-visibility-audit.cjs"), "utf8");
  assert.match(source, /traffic\/popular\/referrers/);
  assert.doesNotMatch(source, /traffic\/referrers/);
  assert.match(source, /maxBuffer: apiMaxBuffer/);
  assert.match(source, /collectPaginated/);
  assert.match(source, /community_error/);
  assert.match(source, /pages_error/);
  assert.match(source, /views_available/);
  assert.match(source, /clones_available/);
  assert.match(source, /usesCustomOpenGraphImage/);
  assert.match(source, /gh api graphql/);
  assert.match(source, /social_preview_error/);
  assert.match(source, /social_preview_custom/);
  assert.match(source, /social_preview_available/);
});

test("compares repository-search snapshots without inventing missing ranks", () => {
  const current = { queries: [
    {query: "codex token efficiency", rank_in_first_100: 12, total_count: 40, incomplete_results: false},
    {query: "mcp context compression", rank_in_first_100: null, total_count: 118, incomplete_results: false},
  ]};
  const baseline = { queries: [
    {query: "codex token efficiency", rank_in_first_100: 20, total_count: 34, incomplete_results: false},
    {query: "mcp context compression", rank_in_first_100: 99, total_count: 117, incomplete_results: false},
  ]};
  assert.deepEqual(compareSearchSnapshots(current, baseline), [
    {query: "codex token efficiency", rank_improvement: 8, present_in_first_100_delta: 0, total_count_delta: 6},
    {query: "mcp context compression", rank_improvement: null, present_in_first_100_delta: -1, total_count_delta: 1},
  ]);
});

test("does not convert errored or incomplete search snapshots into rank loss", () => {
  assert.deepEqual(compareSearchSnapshots(
    {queries: [{query: "codex", error: "rate limit"}]},
    {queries: [{query: "codex", rank_in_first_100: 4, total_count: 8, incomplete_results: false}]},
  ), [{query: "codex", rank_improvement: null, present_in_first_100_delta: null, total_count_delta: null}]);
  assert.deepEqual(compareSearchSnapshots(
    {queries: [{query: "codex", rank_in_first_100: 4, total_count: null, incomplete_results: true}]},
    {queries: [{query: "codex", rank_in_first_100: 7, total_count: 8}]},
  ), [{query: "codex", rank_improvement: null, present_in_first_100_delta: null, total_count_delta: null}]);
  assert.equal(validSearchEntry({ query: "codex", rank_in_first_100: 2, total_count: 8 }), false);
});

test("rejects impossible repository-search ranks", () => {
  assert.deepEqual(compareSearchSnapshots(
    {queries: [{query: "codex", rank_in_first_100: 0, total_count: 8, incomplete_results: false}]},
    {queries: [{query: "codex", rank_in_first_100: 101, total_count: 8, incomplete_results: false}]},
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

test("visibility workflow compares against the previous retained artifact", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "visibility.yml"), "utf8");
  assert.match(workflow, /actions:\s*read/);
  assert.match(workflow, /gh run list --workflow visibility\.yml/);
  assert.match(workflow, /gh run download/);
  assert.doesNotMatch(workflow, /gh run list[\s\S]*\|\| true/);
  assert.match(workflow, /gh api .*actions\/runs/);
  assert.match(workflow, /incompatible audit schema/);
  assert.match(workflow, /--baseline previous\/visibility\.json/);
  assert.match(workflow, /--search --baseline previous\/visibility-search\.json/);
  assert.match(workflow, /visibility-provenance\.json/);
  assert.match(workflow, /overwrite:\s*true/);
  assert.match(workflow, /exact recoverable context/);
  assert.match(workflow, /incompatible provenance/);
  assert.match(workflow, /github-visibility-\$\{\{ github\.run_id \}\}/);
});
