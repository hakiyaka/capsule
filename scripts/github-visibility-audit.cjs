"use strict";

// Read-only GitHub visibility snapshot. It uses the authenticated `gh` CLI so
// traffic endpoints stay private to the repository owner and no token is
// written to Capsule state or benchmark artifacts.

const { spawnSync } = require("node:child_process");
const { compareSearchSnapshots, summarizeReleases, summarizeReferrers } = require("./github-visibility-metrics.cjs");

const argv = process.argv.slice(2);
const repoIndex = argv.indexOf("--repo");
const repo = repoIndex >= 0 ? String(argv[repoIndex + 1] || "") : (process.env.CAPSULE_GITHUB_REPO || "hakiyaka/capsule");
const baselineIndex = argv.indexOf("--baseline");
const baselineFile = baselineIndex >= 0 ? String(argv[baselineIndex + 1] || "") : "";
const writeIndex = argv.indexOf("--write");
const writeFile = writeIndex >= 0 ? String(argv[writeIndex + 1] || "") : "";
const searchEnabled = argv.includes("--search") || process.env.CAPSULE_GITHUB_SEARCH === "1";
const searchQueries = [
  "codex token efficiency",
  "mcp context compression",
  "codex-plugin mcp",
  "token reduction codex",
  "exact recoverable context",
];

function api(endpoint) {
  const result = spawnSync("gh", ["api", endpoint], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || `gh api failed: ${endpoint}`).trim());
  return JSON.parse(result.stdout);
}

function sum(rows, key) {
  return Array.isArray(rows) ? rows.reduce((total, row) => total + (Number(row?.[key]) || 0), 0) : 0;
}

function ratio(current, baseline) {
  if (!Number.isFinite(Number(baseline)) || Number(baseline) <= 0) return null;
  return Number((Number(current) / Number(baseline)).toFixed(2));
}

function searchSnapshot(query) {
  try {
    const result = api(`search/repositories?q=${encodeURIComponent(query)}&per_page=100`);
    const items = Array.isArray(result.items) ? result.items : [];
    const rank = items.findIndex((item) => String(item?.full_name || "").toLowerCase() === repo.toLowerCase());
    return {
      query,
      total_count: Number(result.total_count) || 0,
      rank_in_first_100: rank >= 0 ? rank + 1 : null,
      top_repositories: items.slice(0, 10).map((item) => String(item?.full_name || "")).filter(Boolean),
    };
  } catch (error) {
    return { query, error: String(error?.message || error) };
  }
}

try {
  const metadata = api(`repos/${repo}`);
  const views = api(`repos/${repo}/traffic/views`);
  const clones = api(`repos/${repo}/traffic/clones`);
  const referrers = (() => {
    try { return api(`repos/${repo}/traffic/popular/referrers`); } catch { return []; }
  })();
  const popularPaths = (() => {
    try { return api(`repos/${repo}/traffic/popular/paths`); } catch { return []; }
  })();
  const releases = api(`repos/${repo}/releases?per_page=100`);
  const community = (() => {
    try { return api(`repos/${repo}/community/profile`); } catch { return null; }
  })();
  const pages = (() => {
    try { return api(`repos/${repo}/pages`); } catch { return null; }
  })();
  const referrerSummary = summarizeReferrers(referrers);
  const releaseSummary = summarizeReleases(releases);
  const current = {
    measured_at: new Date().toISOString(),
    repo,
    stars: Number(metadata.stargazers_count) || 0,
    forks: Number(metadata.forks_count) || 0,
    watchers: Number(metadata.subscribers_count ?? metadata.watchers_count) || 0,
    open_issues: Number(metadata.open_issues_count) || 0,
    topics: Array.isArray(metadata.topics) ? metadata.topics.length : 0,
    topic_names: Array.isArray(metadata.topics) ? metadata.topics.map((topic) => String(topic)).sort() : [],
    releases: Array.isArray(releases) ? releases.length : 0,
    ...releaseSummary,
    description_chars: String(metadata.description || "").length,
    has_issues: Boolean(metadata.has_issues),
    has_discussions: Boolean(metadata.has_discussions),
    has_pages: Boolean(metadata.has_pages),
    has_wiki: Boolean(metadata.has_wiki),
    community_health: Number(community?.health_percentage) || null,
    views_14d: Number(views.count) || sum(views.views, "count"),
    unique_viewers_14d: Number(views.uniques) || sum(views.views, "uniques"),
    clones_14d: Number(clones.count) || sum(clones.clones, "count"),
    unique_cloners_14d: Number(clones.uniques) || sum(clones.clones, "uniques"),
    ...referrerSummary,
    popular_paths_14d: Array.isArray(popularPaths) ? popularPaths.length : 0,
    top_path: Array.isArray(popularPaths) && popularPaths[0] ? String(popularPaths[0].path || "") : "",
    top_path_views_14d: Array.isArray(popularPaths) && popularPaths[0] ? Number(popularPaths[0].count) || 0 : 0,
    homepage: metadata.homepage || "",
    pages_url: pages?.html_url || "",
    pages_build_type: pages?.build_type || "",
  };
  const report = { audit: "github-visibility", current, baseline: null, ratios: null, caveat: "Traffic endpoints cover a rolling 14-day window; stars, forks, releases, and topics are cumulative or point-in-time metadata. This measures discoverability inputs, not guaranteed search ranking." };
  if (searchEnabled) {
    report.search = {
      measured_at: new Date().toISOString(),
      queries: searchQueries.map(searchSnapshot),
      caveat: "GitHub repository-search order and totals are volatile snapshots, not search-engine ranking or traffic guarantees.",
    };
  }
  if (baselineFile) {
    const fs = require("node:fs");
    const baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
    const baselineCurrent = baseline.current || baseline;
    report.baseline = baselineCurrent;
    report.ratios = Object.fromEntries(["stars", "forks", "topics", "releases", "release_assets", "release_downloads", "views_14d", "unique_viewers_14d", "clones_14d", "unique_cloners_14d", "referrer_views_14d", "unique_referrers_14d", "top_path_views_14d"].map((key) => [key, ratio(current[key], report.baseline[key])]));
    if (report.search && baseline.search) {
      report.search_deltas = compareSearchSnapshots(report.search, baseline.search);
    }
  }
  if (writeFile) {
    const fs = require("node:fs");
    fs.writeFileSync(writeFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    report.written_to = writeFile;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`github visibility audit failed: ${error.message}\n`);
  process.exitCode = 1;
}
