"use strict";

// Read-only GitHub visibility snapshot. It uses the authenticated `gh` CLI so
// traffic endpoints stay private to the repository owner and no token is
// written to Capsule state or benchmark artifacts.

const { spawnSync } = require("node:child_process");
const { compareSearchSnapshots, summarizeReleases, summarizeReferrers, summarizeTrafficWindow } = require("./github-visibility-metrics.cjs");
const { collectPaginated, formatError, normalizeRepository } = require("./github-visibility-helpers.cjs");

const argv = process.argv.slice(2);
const valueFlags = new Set(["--repo", "--baseline", "--write"]);
const booleanFlags = new Set(["--search"]);
function validateArgs() {
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (valueFlags.has(flag)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      index += 1;
    } else if (!booleanFlags.has(flag)) {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
}
const repoIndex = argv.indexOf("--repo");
const configuredRepo = repoIndex >= 0 ? String(argv[repoIndex + 1] || "") : (process.env.CAPSULE_GITHUB_REPO || "hakiyaka/capsule");
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
const schemaVersion = 2;
const configuredMaxBuffer = Number(process.env.CAPSULE_GITHUB_MAX_BUFFER_BYTES);
const apiMaxBuffer = Number.isSafeInteger(configuredMaxBuffer) && configuredMaxBuffer >= 64 * 1024
  ? configuredMaxBuffer
  : 16 * 1024 * 1024;
let repo;

function api(endpoint) {
  const result = spawnSync("gh", ["api", endpoint], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: apiMaxBuffer,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || `gh api failed: ${endpoint}`).trim();
    const error = new Error(detail || `gh api failed: ${endpoint}`);
    error.exitCode = result.status;
    throw error;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`gh api returned invalid JSON for ${endpoint}: ${formatError(error)}`);
  }
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
      total_count: Number.isFinite(result.total_count) ? Number(result.total_count) : null,
      incomplete_results: result.incomplete_results === true,
      rank_in_first_100: rank >= 0 ? rank + 1 : null,
      top_repositories: items.slice(0, 10).filter((item) => item?.private !== true).map((item) => String(item?.full_name || "")).filter(Boolean),
    };
  } catch (error) {
    return { query, incomplete_results: null, error: formatError(error) };
  }
}

function optionalApi(endpoint, fallback) {
  try {
    return { value: api(endpoint), available: true, error: null };
  } catch (error) {
    // Keep the actual gh/API diagnostic (usually including HTTP status) so a
    // missing permission is not mistaken for a real zero-traffic result.
    return { value: fallback, available: false, error: formatError(error) };
  }
}

try {
  validateArgs();
  repo = normalizeRepository(configuredRepo);
  const measuredAt = new Date();
  const metadata = api(`repos/${repo}`);
  const viewsResult = optionalApi(`repos/${repo}/traffic/views`, null);
  const clonesResult = optionalApi(`repos/${repo}/traffic/clones`, null);
  const views = viewsResult.value || {};
  const clones = clonesResult.value || {};
  const referrerResult = optionalApi(`repos/${repo}/traffic/popular/referrers`);
  const popularPathResult = optionalApi(`repos/${repo}/traffic/popular/paths`);
  const referrers = referrerResult.value;
  const popularPaths = popularPathResult.value;
  const releasePages = collectPaginated((endpoint) => api(endpoint), `repos/${repo}/releases`);
  const releases = releasePages.items;
  const communityResult = optionalApi(`repos/${repo}/community/profile`, null);
  const pagesResult = optionalApi(`repos/${repo}/pages`, null);
  const community = communityResult.value;
  const pages = pagesResult.value;
  const referrerSummary = summarizeReferrers(referrers);
  const releaseSummary = summarizeReleases(releases);
  const viewsWindow = summarizeTrafficWindow(views.views, measuredAt.getTime());
  const clonesWindow = summarizeTrafficWindow(clones.clones, measuredAt.getTime());
  const current = {
    schema_version: schemaVersion,
    measured_at: new Date().toISOString(),
    repo,
    stars: Number(metadata.stargazers_count) || 0,
    forks: Number(metadata.forks_count) || 0,
    watch_subscribers: Number(metadata.subscribers_count) || 0,
    watchers_count: Number(metadata.watchers_count) || 0,
    open_issues: Number(metadata.open_issues_count) || 0,
    topics: Array.isArray(metadata.topics) ? metadata.topics.length : 0,
    topic_names: Array.isArray(metadata.topics) ? metadata.topics.map((topic) => String(topic)).sort() : [],
    releases: Array.isArray(releases) ? releases.length : 0,
    release_pages: releasePages.pages,
    release_pagination_complete: !releasePages.truncated,
    ...releaseSummary,
    description_chars: String(metadata.description || "").length,
    has_issues: Boolean(metadata.has_issues),
    has_discussions: Boolean(metadata.has_discussions),
    has_pages: Boolean(metadata.has_pages),
    has_wiki: Boolean(metadata.has_wiki),
    community_health: Number.isFinite(Number(community?.health_percentage)) ? Number(community.health_percentage) : null,
    community_available: communityResult.available,
    community_error: communityResult.error,
    views_14d: viewsResult.available ? Number(views.count) || sum(views.views, "count") : null,
    unique_viewers_14d: viewsResult.available ? Number(views.uniques) || sum(views.views, "uniques") : null,
    views_available: viewsResult.available,
    views_error: viewsResult.error,
    views_observed_start: viewsWindow.observed_start,
    views_observed_end: viewsWindow.observed_end,
    views_observed_points: viewsWindow.observed_points,
    views_lag_days: viewsWindow.lag_days,
    clones_14d: clonesResult.available ? Number(clones.count) || sum(clones.clones, "count") : null,
    unique_cloners_14d: clonesResult.available ? Number(clones.uniques) || sum(clones.clones, "uniques") : null,
    clones_available: clonesResult.available,
    clones_error: clonesResult.error,
    clones_observed_start: clonesWindow.observed_start,
    clones_observed_end: clonesWindow.observed_end,
    clones_observed_points: clonesWindow.observed_points,
    clones_lag_days: clonesWindow.lag_days,
    ...referrerSummary,
    referrers_available: referrerResult.available,
    referrers_error: referrerResult.error,
    popular_paths_available: popularPathResult.available,
    popular_paths_error: popularPathResult.error,
    popular_paths_14d: Array.isArray(popularPaths) ? popularPaths.length : 0,
    top_path: Array.isArray(popularPaths) && popularPaths[0] ? String(popularPaths[0].path || "") : "",
    top_path_views_14d: Array.isArray(popularPaths) && popularPaths[0] ? Number(popularPaths[0].count) || 0 : 0,
    homepage: metadata.homepage || "",
    pages_url: pages?.html_url || "",
    pages_build_type: pages?.build_type || "",
    pages_available: pagesResult.available,
    pages_error: pagesResult.error,
  };
  const report = { audit: "github-visibility", schema_version: schemaVersion, current, baseline: null, ratios: null, caveat: "Traffic endpoints cover a rolling 14-day window; referrer uniques are summed per-domain values rather than global uniques; stars, forks, releases, and topics are cumulative or point-in-time metadata. This measures discoverability inputs, not guaranteed search ranking." };
  if (searchEnabled) {
    report.search = {
      schema_version: schemaVersion,
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
    report.baseline_warnings = [];
    if (baseline.schema_version && baseline.schema_version !== schemaVersion) {
      report.baseline_warnings.push(`schema version differs: baseline=${baseline.schema_version}, current=${schemaVersion}`);
    }
    if (baselineCurrent.repo && baselineCurrent.repo.toLowerCase() !== repo.toLowerCase()) {
      report.baseline_warnings.push(`repository differs: baseline=${baselineCurrent.repo}, current=${repo}`);
    }
    report.ratios = Object.fromEntries(["stars", "forks", "topics", "releases", "release_assets", "release_downloads", "views_14d", "unique_viewers_14d", "clones_14d", "unique_cloners_14d", "referrer_views_14d", "referrer_uniques_sum_14d", "top_path_views_14d"].map((key) => [key, ratio(current[key], report.baseline[key])]));
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
