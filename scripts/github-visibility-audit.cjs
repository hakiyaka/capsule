"use strict";

// Read-only GitHub visibility snapshot. It uses the authenticated `gh` CLI so
// traffic endpoints stay private to the repository owner and no token is
// written to Capsule state or benchmark artifacts.

const { spawnSync } = require("node:child_process");

const argv = process.argv.slice(2);
const repoIndex = argv.indexOf("--repo");
const repo = repoIndex >= 0 ? String(argv[repoIndex + 1] || "") : (process.env.CAPSULE_GITHUB_REPO || "hakiyaka/capsule");
const baselineIndex = argv.indexOf("--baseline");
const baselineFile = baselineIndex >= 0 ? String(argv[baselineIndex + 1] || "") : "";
const writeIndex = argv.indexOf("--write");
const writeFile = writeIndex >= 0 ? String(argv[writeIndex + 1] || "") : "";

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

try {
  const metadata = api(`repos/${repo}`);
  const views = api(`repos/${repo}/traffic/views`);
  const clones = api(`repos/${repo}/traffic/clones`);
  const releases = api(`repos/${repo}/releases?per_page=100`);
  const pages = (() => {
    try { return api(`repos/${repo}/pages`); } catch { return null; }
  })();
  const current = {
    measured_at: new Date().toISOString(),
    repo,
    stars: Number(metadata.stargazers_count) || 0,
    forks: Number(metadata.forks_count) || 0,
    watchers: Number(metadata.subscribers_count ?? metadata.watchers_count) || 0,
    open_issues: Number(metadata.open_issues_count) || 0,
    topics: Array.isArray(metadata.topics) ? metadata.topics.length : 0,
    releases: Array.isArray(releases) ? releases.length : 0,
    views_14d: Number(views.count) || sum(views.views, "count"),
    unique_viewers_14d: Number(views.uniques) || sum(views.views, "uniques"),
    clones_14d: Number(clones.count) || sum(clones.clones, "count"),
    unique_cloners_14d: Number(clones.uniques) || sum(clones.clones, "uniques"),
    homepage: metadata.homepage || "",
    pages_url: pages?.html_url || "",
    pages_build_type: pages?.build_type || "",
  };
  const report = { audit: "github-visibility", current, baseline: null, ratios: null, caveat: "Traffic endpoints cover a rolling 14-day window; stars, forks, and releases are cumulative. This measures discoverability inputs, not guaranteed search ranking." };
  if (baselineFile) {
    const fs = require("node:fs");
    const baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
    report.baseline = baseline.current || baseline;
    report.ratios = Object.fromEntries(["stars", "forks", "views_14d", "unique_viewers_14d", "clones_14d", "unique_cloners_14d"].map((key) => [key, ratio(current[key], report.baseline[key])]));
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
