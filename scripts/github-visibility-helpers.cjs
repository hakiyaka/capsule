"use strict";

// Small, side-effect-free helpers used by the authenticated GitHub visibility
// audit. Keeping pagination and input validation here makes the edge cases
// directly testable without making network calls or requiring gh credentials.

const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;

function normalizeRepository(value, fallback = "hakiyaka/capsule") {
  const repo = String(value || fallback).trim();
  if (!REPOSITORY_PATTERN.test(repo)) {
    throw new Error(`repository must use owner/name syntax: ${repo || "(empty)"}`);
  }
  return repo;
}

function formatError(error, limit = 500) {
  const raw = String(error?.message || error || "unknown error").replace(/\s+/g, " ").trim();
  return raw.slice(0, limit) || "unknown error";
}

function collectPaginated(fetchPage, endpoint, options = {}) {
  if (typeof fetchPage !== "function") throw new TypeError("fetchPage must be a function");
  const pageSize = Number(options.pageSize ?? 100);
  const maxPages = Number(options.maxPages ?? 100);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new RangeError("pageSize must be an integer between 1 and 100");
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new RangeError("maxPages must be a positive integer");
  }
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = String(endpoint).includes("?") ? "&" : "?";
    const response = fetchPage(`${endpoint}${separator}per_page=${pageSize}&page=${page}`);
    if (!Array.isArray(response)) throw new TypeError(`expected an array response for ${endpoint}, page ${page}`);
    items.push(...response);
    if (response.length < pageSize) return { items, pages: page, truncated: false };
  }
  // A full final page is ambiguous without another request. Mark it explicitly
  // so a report can never silently claim a complete release count.
  return { items, pages: maxPages, truncated: true };
}

module.exports = { collectPaginated, formatError, normalizeRepository };
