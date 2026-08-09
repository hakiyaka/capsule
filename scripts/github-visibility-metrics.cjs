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

function summarizeTrafficWindow(rows, measuredAt = Date.now()) {
  const timestamps = (Array.isArray(rows) ? rows : [])
    .map((row) => Date.parse(String(row?.timestamp || "")))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!timestamps.length) {
    return {
      observed_start: null,
      observed_end: null,
      observed_points: 0,
      lag_days: null,
    };
  }
  const end = timestamps[timestamps.length - 1];
  const lag = Number(measuredAt) - end;
  return {
    observed_start: new Date(timestamps[0]).toISOString(),
    observed_end: new Date(end).toISOString(),
    observed_points: timestamps.length,
    lag_days: Number.isFinite(lag) ? Number((Math.max(0, lag) / 86_400_000).toFixed(2)) : null,
  };
}

function ratio(current, baseline) {
  // A missing endpoint value is unknown, not zero. Do not let Number(null)
  // manufacture a false 0x ratio in a baseline comparison.
  if (current === null || current === undefined || baseline === null || baseline === undefined) return null;
  const currentNumber = Number(current);
  const baselineNumber = Number(baseline);
  if (!Number.isFinite(currentNumber) || !Number.isFinite(baselineNumber) || baselineNumber <= 0) return null;
  return Number((currentNumber / baselineNumber).toFixed(2));
}

function validSearchEntry(entry) {
  if (!entry || typeof entry.query !== "string" || entry.error || entry.incomplete_results !== false) return false;
  if (entry.rank_in_first_100 !== null && (!Number.isInteger(entry.rank_in_first_100) || entry.rank_in_first_100 < 1 || entry.rank_in_first_100 > 100)) return false;
  if (entry.total_count !== null && (!Number.isInteger(entry.total_count) || entry.total_count < 0)) return false;
  return true;
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
    const currentValid = validSearchEntry(entry);
    const previousValid = validSearchEntry(previous);
    const currentRank = currentValid && entry.rank_in_first_100 !== null ? entry.rank_in_first_100 : null;
    const previousRank = previousValid && previous.rank_in_first_100 !== null ? previous.rank_in_first_100 : null;
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

module.exports = { compareSearchSnapshots, ratio, summarizeReleases, summarizeReferrers, summarizeTrafficWindow, validSearchEntry };
