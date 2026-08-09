"use strict";

// Auth-free smoke audit for the public discovery surface. This is intentionally
// separate from the offline SEO contract so a local pass cannot masquerade as
// proof that GitHub Pages served the latest files.

const base = (process.env.CAPSULE_SITE_URL || "https://hakiyaka.github.io/capsule/").replace(/\/$/, "");
const timeoutMs = Math.max(1000, Number(process.env.CAPSULE_LIVE_TIMEOUT_MS) || 15000);
const attempts = Math.max(1, Number(process.env.CAPSULE_LIVE_ATTEMPTS) || 3);
const paths = [
  "/",
  "/guide/faq.html",
  "/guide/benchmarks-and-methodology.html",
  "/guide/github-discoverability.html",
  "/guide/web-search-token-savings.html",
  "/guide/terminal-output-token-savings.html",
  "/feed.xml",
  "/llms.txt",
  "/robots.txt",
  "/sitemap.xml",
  "/social-card.png",
];
const guidePaths = [
  "codex-token-efficiency.html",
  "mcp-context-compression.html",
  "get-content-token-savings.html",
  "install-capsule.html",
  "share-and-cite.html",
  "benchmarks-and-methodology.html",
  "github-discoverability.html",
  "web-search-token-savings.html",
  "terminal-output-token-savings.html",
  "faq.html",
].map((name) => `/guide/${name}`);
const failures = [];

async function get(pathname) {
  const url = `${base}${pathname}`;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { redirect: "follow", signal: controller.signal, headers: { "user-agent": "capsule-live-surface-audit/1.0" } });
      const bytes = Buffer.from(await response.arrayBuffer());
      return { pathname, url, status: response.status, content_type: response.headers.get("content-type") || "", bytes };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * attempt, 3000)));
    } finally {
      clearTimeout(timer);
    }
  }
  return { pathname, url, error: String(lastError?.message || lastError || "request failed") };
}

function text(result) {
  return result?.bytes?.toString("utf8") || "";
}

function check(result, predicate, label) {
  if (!predicate(result)) failures.push(`${result.pathname}: ${label}`);
}

function checkPng(result) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  check(result, (value) => value.status === 200, "HTTP 200");
  check(result, (value) => /^image\/png\b/i.test(value.content_type), "PNG content type");
  check(result, (value) => value.bytes?.subarray(0, 8).equals(signature), "PNG signature");
  check(result, (value) => value.bytes?.length >= 24 && value.bytes.readUInt32BE(16) === 1200 && value.bytes.readUInt32BE(20) === 630, "1200x630 dimensions");
}

async function main() {
  const results = await Promise.all(paths.map(get));
  for (const result of results) {
    if (result.error) {
      failures.push(`${result.pathname}: ${result.error}`);
      continue;
    }
    if (result.pathname === "/social-card.png") {
      checkPng(result);
      continue;
    }
    check(result, (value) => value.status === 200, "HTTP 200");
    check(result, (value) => value.bytes.length > 0, "non-empty body");
  }
  const byPath = Object.fromEntries(results.map((result) => [result.pathname, result]));
  const home = text(byPath["/"]); const faq = text(byPath["/guide/faq.html"]); const discoverability = text(byPath["/guide/github-discoverability.html"]);
  const sitemap = text(byPath["/sitemap.xml"]); const robots = text(byPath["/robots.txt"]);
  const feed = text(byPath["/feed.xml"]); const llms = text(byPath["/llms.txt"]);
  check(byPath["/"], (value) => /<link\s+rel=["']canonical["']\s+href=["']https:\/\/hakiyaka\.github\.io\/capsule\/["']/i.test(text(value)), "canonical home");
  check(byPath["/"], () => /social-card\.png/i.test(home) && /summary_large_image/i.test(home), "PNG social metadata");
  check(byPath["/guide/faq.html"], () => /FAQPage/i.test(faq) && /social-card\.png/i.test(faq), "FAQ structured metadata");
  check(byPath["/guide/github-discoverability.html"], () => /GitHub Discoverability/i.test(discoverability) && /social-card\.png/i.test(discoverability), "discoverability guide metadata");
  check(byPath["/sitemap.xml"], () => /guide\/faq\.html/i.test(sitemap) && /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/i.test(sitemap), "FAQ and lastmod");
  check(byPath["/robots.txt"], () => /Sitemap:\s*https:\/\/hakiyaka\.github\.io\/capsule\/sitemap\.xml/i.test(robots), "sitemap directive");
  check(byPath["/feed.xml"], () => /guide\/faq\.html/i.test(feed), "FAQ RSS item");
  check(byPath["/feed.xml"], () => /releases\/tag\/v1\.0\.0/i.test(feed), "release RSS item");
  check(byPath["/llms.txt"], () => /guide\/faq\.html/i.test(llms), "FAQ machine-readable link");
  check(byPath["/llms.txt"], () => /releases\/download\/v1\.0\.0\/capsule-1\.0\.0-source\.zip/i.test(llms), "release archive machine-readable link");
  check(byPath["/llms.txt"], () => /releases\/download\/v1\.0\.0\/capsule-1\.0\.0-source\.zip\.sha256/i.test(llms), "release checksum machine-readable link");
  for (const guidePath of guidePaths) {
    const escaped = guidePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    check(byPath["/sitemap.xml"], () => new RegExp(`<loc>https:\/\/hakiyaka\\.github\\.io\/capsule${escaped}<\\/loc>`, "i").test(sitemap), `${guidePath}: live sitemap URL`);
    check(byPath["/feed.xml"], () => new RegExp(`<guid\\s+isPermaLink="true">https:\/\/hakiyaka\\.github\\.io\/capsule${escaped}<\\/guid>`, "i").test(feed), `${guidePath}: live RSS URL`);
  }
  if (/example\.com|localhost|127\.0\.0\.1/i.test(results.map(text).join("\n"))) failures.push("placeholder host");
  const report = {
    audit: "live-surface-smoke",
    base,
    measured_at: new Date().toISOString(),
    attempts,
    timeout_ms: timeoutMs,
    results: results.map((result) => ({ pathname: result.pathname, status: result.status ?? null, content_type: result.content_type ?? null, bytes: result.bytes?.length ?? 0, error: result.error ?? null })),
    failures,
    passed: failures.length === 0,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`live surface smoke failed: ${error.message}\n`);
  process.exitCode = 1;
});
