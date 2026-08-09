"use strict";

// Pure helpers for the authenticated GitHub visibility audit. Keeping the
// aggregation separate makes the private API response easy to fixture-test
// without making network calls or writing credentials to benchmark artifacts.

function summarizeReferrers(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    referrer_domains_14d: list.length,
    referrer_views_14d: list.reduce((total, row) => total + (Number(row?.count) || 0), 0),
    // GitHub reports uniques per referrer domain. Summing them is useful as a
    // directional signal, but is not a global unique-user count.
    referrer_uniques_sum_14d: list.reduce((total, row) => total + (Number(row?.uniques) || 0), 0),
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
    const query = typeof entry?.query === "string" ? entry.query : "";
    const previous = baselineByQuery.get(query);
    const currentValid = entry && !entry.error && entry.incomplete_results !== true;
    const previousValid = previous && !previous.error && previous.incomplete_results !== true;
    const currentRank = currentValid && Number.isInteger(entry.rank_in_first_100) ? entry.rank_in_first_100 : null;
    const previousRank = previousValid && Number.isInteger(previous.rank_in_first_100) ? previous.rank_in_first_100 : null;
    const currentPresent = currentRank !== null;
    const previousPresent = previousRank !== null;
    const currentTotal = currentValid && Number.isFinite(entry?.total_count) ? Number(entry.total_count) : null;
    const previousTotal = previousValid && Number.isFinite(previous?.total_count) ? Number(previous.total_count) : null;
    return {
      query,
      // Positive means the repository moved toward rank 1.
      rank_improvement: currentRank !== null && previousRank !== null ? previousRank - currentRank : null,
      present_in_first_100_delta: currentValid && previousValid ? Number(currentPresent) - Number(previousPresent) : null,
      total_count_delta: currentTotal !== null && previousTotal !== null ? currentTotal - previousTotal : null,
    };
  });
}

module.exports = { compareSearchSnapshots, summarizeReleases, summarizeReferrers };
