"use strict";

// Read-only GitHub visibility snapshot. It uses the authenticated `gh` CLI so
// traffic endpoints stay private to the repository owner and no token is
// written to Capsule state or benchmark artifacts.

const { spawnSync } = require("node:child_process");
const { compareSearchSnapshots, ratio, summarizeReleases, summarizeReferrers, summarizeTrafficWindow } = require("./github-visibility-metrics.cjs");
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
// Bump this when the meaning of an existing metric changes without changing
// the outer report shape. Older artifacts remain readable, but are not used
// for ratios or search deltas until a like-for-like snapshot exists.
const metricsSemanticsVersion = 3;
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

function graphql(query, variables = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    args.push("-F", `${name}=${value}`);
  }
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: apiMaxBuffer,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "gh api graphql failed").trim();
    const error = new Error(detail || "gh api graphql failed");
    error.exitCode = result.status;
    throw error;
  }
  try {
    const response = JSON.parse(result.stdout);
    if (Array.isArray(response?.errors) && response.errors.length) {
      const detail = response.errors
        .map((entry) => String(entry?.message || "GraphQL error"))
        .join("; ");
      throw new Error(detail);
    }
    return response;
  } catch (error) {
    if (error instanceof Error && !/Unexpected token|JSON/.test(error.message)) throw error;
    throw new Error(`gh api graphql returned invalid JSON: ${formatError(error)}`);
  }
}

function sum(rows, key) {
  return Array.isArray(rows) ? rows.reduce((total, row) => total + (Number(row?.[key]) || 0), 0) : 0;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function searchSnapshot(query) {
  try {
    const result = api(`search/repositories?q=${encodeURIComponent(`${query} is:public`)}&per_page=100`);
    const items = Array.isArray(result.items) ? result.items : [];
    const rank = items.findIndex((item) => String(item?.full_name || "").toLowerCase() === repo.toLowerCase());
    return {
      query,
      search_scope: "public repositories",
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

function optionalGraphql(query, variables, fallback = null) {
  try {
    return { value: graphql(query, variables), available: true, error: null };
  } catch (error) {
    return { value: fallback, available: false, error: formatError(error) };
  }
}

try {
  validateArgs();
  repo = normalizeRepository(configuredRepo);
  const measuredAt = new Date();
  const metadata = api(`repos/${repo}`);
  const [repoOwner, repoName] = repo.split("/");
  const socialPreviewResult = optionalGraphql(
    "query($owner:String!, $name:String!) { repository(owner:$owner, name:$name) { usesCustomOpenGraphImage openGraphImageUrl } }",
    { owner: repoOwner, name: repoName },
  );
  const socialPreview = socialPreviewResult.value?.data?.repository;
  const socialPreviewShapeValid = isRecord(socialPreview)
    && typeof socialPreview.usesCustomOpenGraphImage === "boolean";
  const viewsResult = optionalApi(`repos/${repo}/traffic/views`, null);
  const clonesResult = optionalApi(`repos/${repo}/traffic/clones`, null);
  const views = viewsResult.value || {};
  const clones = clonesResult.value || {};
  const viewsShapeValid = viewsResult.available && isRecord(views) && Array.isArray(views.views);
  const clonesShapeValid = clonesResult.available && isRecord(clones) && Array.isArray(clones.clones);
  const referrerResult = optionalApi(`repos/${repo}/traffic/popular/referrers`);
  const popularPathResult = optionalApi(`repos/${repo}/traffic/popular/paths`);
  const referrers = referrerResult.value;
  const popularPaths = popularPathResult.value;
  const releasePages = collectPaginated((endpoint) => api(endpoint), `repos/${repo}/releases`);
  const allReleases = releasePages.items;
  const releases = allReleases.filter((release) => release?.draft !== true);
  const draftReleasesOmitted = allReleases.length - releases.length;
  const communityResult = optionalApi(`repos/${repo}/community/profile`, null);
  const pagesResult = optionalApi(`repos/${repo}/pages`, null);
  const community = communityResult.value;
  const pages = pagesResult.value;
  const referrersShapeValid = referrerResult.available && Array.isArray(referrers);
  const referrerSummary = referrersShapeValid
    ? summarizeReferrers(referrers)
    : {
        referrer_domains_14d: null,
        referrer_views_14d: null,
        referrer_uniques_sum_14d: null,
        top_referrer: null,
      };
  const releaseSummary = summarizeReleases(releases);
  const viewsWindow = summarizeTrafficWindow(viewsShapeValid ? views.views : [], measuredAt.getTime());
  const clonesWindow = summarizeTrafficWindow(clonesShapeValid ? clones.clones : [], measuredAt.getTime());
  const pathsShapeValid = popularPathResult.available && Array.isArray(popularPaths);
  const pathSummary = pathsShapeValid
    ? {
        popular_paths_14d: Array.isArray(popularPaths) ? popularPaths.length : 0,
        top_path: Array.isArray(popularPaths) && popularPaths[0] ? String(popularPaths[0].path || "") : "",
        top_path_views_14d: Array.isArray(popularPaths) && popularPaths[0] ? Number(popularPaths[0].count) || 0 : 0,
      }
    : {
        popular_paths_14d: null,
        top_path: null,
        top_path_views_14d: null,
      };
  const current = {
    schema_version: schemaVersion,
    metrics_semantics_version: metricsSemanticsVersion,
    measured_at: new Date().toISOString(),
    repo,
    stars: Number(metadata.stargazers_count) || 0,
    forks: Number(metadata.forks_count) || 0,
    watch_subscribers: Number(metadata.subscribers_count) || 0,
    // GitHub's REST API keeps watchers_count as a legacy alias for stars.
    // Actual watch subscriptions are reported separately above.
    watchers_count: Number(metadata.watchers_count) || 0,
    watchers_count_semantics: "REST legacy alias for stargazers_count; not active watcher subscriptions",
    open_issues: Number(metadata.open_issues_count) || 0,
    topics: Array.isArray(metadata.topics) ? metadata.topics.length : 0,
    topic_names: Array.isArray(metadata.topics) ? metadata.topics.map((topic) => String(topic)).sort() : [],
    releases: Array.isArray(releases) ? releases.length : 0,
    draft_releases_omitted: draftReleasesOmitted,
    release_pages: releasePages.pages,
    release_pagination_complete: !releasePages.truncated,
    ...releaseSummary,
    description_chars: String(metadata.description || "").length,
    social_preview_custom: socialPreviewShapeValid ? socialPreview.usesCustomOpenGraphImage : null,
    social_preview_url: socialPreviewShapeValid
      ? (typeof socialPreview.openGraphImageUrl === "string" ? socialPreview.openGraphImageUrl : null)
      : (typeof metadata.open_graph_image_url === "string" ? metadata.open_graph_image_url : null),
    social_preview_available: socialPreviewShapeValid,
    social_preview_error: socialPreviewResult.error || (socialPreviewResult.available && !socialPreviewShapeValid ? "malformed social preview response" : null),
    has_issues: Boolean(metadata.has_issues),
    has_discussions: Boolean(metadata.has_discussions),
    has_pages: Boolean(metadata.has_pages),
    has_wiki: Boolean(metadata.has_wiki),
    community_health: finiteNumber(community?.health_percentage),
    community_available: communityResult.available,
    community_error: communityResult.error,
    views_14d: viewsShapeValid ? Number(views.count) || sum(views.views, "count") : null,
    // GitHub's top-level uniques is already the endpoint's aggregate. If it is
    // omitted, summing daily uniques would double-count people across days.
    unique_viewers_14d: viewsShapeValid ? finiteNumber(views.uniques) : null,
    views_available: viewsShapeValid,
    views_error: viewsResult.error || (viewsResult.available && !viewsShapeValid ? "malformed traffic views response" : null),
    views_observed_start: viewsWindow.observed_start,
    views_observed_end: viewsWindow.observed_end,
    views_observed_points: viewsWindow.observed_points,
    views_lag_days: viewsWindow.lag_days,
    clones_14d: clonesShapeValid ? Number(clones.count) || sum(clones.clones, "count") : null,
    unique_cloners_14d: clonesShapeValid ? finiteNumber(clones.uniques) : null,
    clones_available: clonesShapeValid,
    clones_error: clonesResult.error || (clonesResult.available && !clonesShapeValid ? "malformed traffic clones response" : null),
    clones_observed_start: clonesWindow.observed_start,
    clones_observed_end: clonesWindow.observed_end,
    clones_observed_points: clonesWindow.observed_points,
    clones_lag_days: clonesWindow.lag_days,
    ...referrerSummary,
    referrers_available: referrersShapeValid,
    referrers_error: referrerResult.error || (referrerResult.available && !referrersShapeValid ? "malformed popular referrers response" : null),
    popular_paths_available: pathsShapeValid,
    popular_paths_error: popularPathResult.error || (popularPathResult.available && !pathsShapeValid ? "malformed popular paths response" : null),
    ...pathSummary,
    homepage: metadata.homepage || "",
    pages_url: pages?.html_url || "",
    pages_build_type: pages?.build_type || "",
    pages_available: pagesResult.available,
    pages_error: pagesResult.error,
  };
  const report = { audit: "github-visibility", schema_version: schemaVersion, current, baseline: null, ratios: null, caveat: "Traffic endpoints cover a rolling 14-day window; API aggregate uniques are preserved and missing aggregates remain unknown; referrer uniques are summed per-domain values rather than global uniques; REST watchers_count is a legacy stars alias; stars, forks, releases, and topics are cumulative or point-in-time metadata. This measures discoverability inputs, not guaranteed search ranking." };
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
    const metricsComparable = baselineCurrent.metrics_semantics_version === metricsSemanticsVersion;
    if (!metricsComparable) {
      report.baseline_warnings.push(`metric semantics differ: baseline=${baselineCurrent.metrics_semantics_version ?? "missing"}, current=${metricsSemanticsVersion}`);
    }
    for (const prefix of ["views", "clones"]) {
      const currentStart = current[`${prefix}_observed_start`];
      const currentEnd = current[`${prefix}_observed_end`];
      const baselineStart = report.baseline[`${prefix}_observed_start`];
      const baselineEnd = report.baseline[`${prefix}_observed_end`];
      if (currentStart && currentEnd && baselineStart && baselineEnd && (currentStart !== baselineStart || currentEnd !== baselineEnd)) {
        report.baseline_warnings.push(`${prefix} traffic windows differ: baseline=${baselineStart}..${baselineEnd}, current=${currentStart}..${currentEnd}`);
      }
      const currentLag = finiteNumber(current[`${prefix}_lag_days`]);
      const baselineLag = finiteNumber(report.baseline[`${prefix}_lag_days`]);
      if ((currentLag !== null && currentLag > 0) || (baselineLag !== null && baselineLag > 0)) {
        report.baseline_warnings.push(`${prefix} traffic API is lagging: baseline_lag_days=${baselineLag}, current_lag_days=${currentLag}`);
      }
    }
    const releaseTotalsComparable = current.release_pagination_complete === true && report.baseline.release_pagination_complete === true;
    if (metricsComparable) {
      const ratioKeys = ["stars", "forks", "topics", "releases", "release_assets", "release_downloads", "views_14d", "unique_viewers_14d", "clones_14d", "unique_cloners_14d", "referrer_views_14d", "referrer_uniques_sum_14d", "top_path_views_14d"];
      report.ratios = Object.fromEntries(ratioKeys.map((key) => [
        key,
        ["releases", "release_assets", "release_downloads"].includes(key) && !releaseTotalsComparable
          ? null
          : ratio(current[key], report.baseline[key]),
      ]));
    } else {
      report.ratios = null;
    }
    if (report.search && baseline.search && metricsComparable) {
      report.search_deltas = compareSearchSnapshots(report.search, baseline.search);
    } else if (report.search && baseline.search) {
      report.search_deltas = null;
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
