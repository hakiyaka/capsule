"use strict";

// Pure helpers for the authenticated GitHub visibility audit. Keeping the
// aggregation separate makes the private API response easy to fixture-test
// without making network calls or writing credentials to benchmark artifacts.

function summarizeReferrers(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    referrer_domains_14d: list.length,
    referrer_views_14d: list.reduce((total, row) => total + (Number(row?.count) || 0), 0),
    unique_referrers_14d: list.reduce((total, row) => total + (Number(row?.uniques) || 0), 0),
    top_referrer: list[0] ? String(list[0].referrer || "") : "",
  };
}

function summarizeReleases(releases) {
  const list = Array.isArray(releases) ? releases : [];
  const assets = list.flatMap((release) => Array.isArray(release?.assets) ? release.assets : []);
  return {
    release_assets: assets.length,
    release_downloads: assets.reduce((total, asset) => total + (Number(asset?.download_count) || 0), 0),
    release_asset_names: assets.map((asset) => String(asset?.name || "")).filter(Boolean).sort(),
  };
}

function compareSearchSnapshots(current, baseline) {
  const currentQueries = Array.isArray(current?.queries) ? current.queries : [];
  const baselineByQuery = new Map(
    (Array.isArray(baseline?.queries) ? baseline.queries : [])
      .filter((entry) => entry && typeof entry.query === "string")
      .map((entry) => [entry.query, entry]),
  );
  return currentQueries.map((entry) => {
    const previous = baselineByQuery.get(entry.query);
    const currentRank = Number.isInteger(entry.rank_in_first_100) ? entry.rank_in_first_100 : null;
    const previousRank = Number.isInteger(previous?.rank_in_first_100) ? previous.rank_in_first_100 : null;
    const currentPresent = currentRank !== null;
    const previousPresent = previousRank !== null;
    const currentTotal = Number.isFinite(Number(entry.total_count)) ? Number(entry.total_count) : null;
    const previousTotal = Number.isFinite(Number(previous?.total_count)) ? Number(previous.total_count) : null;
    return {
      query: entry.query,
      rank_delta: currentRank !== null && previousRank !== null ? previousRank - currentRank : null,
      present_in_first_100_delta: Number(currentPresent) - Number(previousPresent),
      total_count_delta: currentTotal !== null && previousTotal !== null ? currentTotal - previousTotal : null,
    };
  });
}

module.exports = { compareSearchSnapshots, summarizeReleases, summarizeReferrers };
