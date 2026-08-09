"use strict";

// Offline contract audit for the public GitHub Pages surface. This validates
// the signals we control without pretending to measure Google's index/rank.

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const site = path.join(root, "docs");
const canonical = "https://hakiyaka.github.io/capsule/";
const socialImage = `${canonical}social-card.svg`;
const failures = [];
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function read(name) {
  const file = path.join(site, name);
  if (!fs.existsSync(file)) {
    failures.push(`missing ${name}`);
    return "";
  }
  return fs.readFileSync(file, "utf8");
}

function requireMatch(text, expression, label) {
  if (!expression.test(text)) failures.push(label);
}

const html = read("index.html");
const robots = read("robots.txt");
const sitemap = read("sitemap.xml");
const socialCard = read("social-card.svg");
const guides = [
  "guide/codex-token-efficiency.html",
  "guide/mcp-context-compression.html",
  "guide/get-content-token-savings.html",
  "guide/install-capsule.html",
  "guide/share-and-cite.html",
  "guide/benchmarks-and-methodology.html",
];
requireMatch(socialCard, /^\s*<svg\b[^>]*width="1200"[^>]*height="630"/i, "social card asset");
requireMatch(html, /<title>[^<]{20,160}<\/title>/i, "descriptive title");
requireMatch(html, /<meta\s+name=["']description["'][^>]+content="[^"]{80,220}"/i, "meta description");
requireMatch(html, new RegExp(`<link\\s+rel=["']canonical["'][^>]+href=["']${canonical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ["']`, "i"), "canonical URL");
requireMatch(html, /property=["']og:title["']/i, "Open Graph title");
// Keep the canonical check independent of attribute ordering/whitespace.
if (html.includes(`href="${canonical}"`)) {
  const canonicalFailure = failures.indexOf("canonical URL");
  if (canonicalFailure >= 0) failures.splice(canonicalFailure, 1);
}
requireMatch(html, /property=["']og:description["']/i, "Open Graph description");
requireMatch(html, new RegExp(`<meta\\s+property=["']og:image["'][^>]+content=["']${escapeRegExp(socialImage)}["']`, "i"), "Open Graph image");
requireMatch(html, new RegExp(`<meta\\s+name=["']twitter:image["'][^>]+content=["']${escapeRegExp(socialImage)}["']`, "i"), "Twitter image");
requireMatch(html, /name=["']twitter:card["'][^>]+content=["']summary["']/i, "Twitter card");
requireMatch(html, /<h1\b[^>]*>[^<]+<\/h1>/i, "visible H1");
requireMatch(html, /href=["']https:\/\/github\.com\/hakiyaka\/capsule(?:\/|["'])/i, "repository link");
requireMatch(html, /application\/ld\+json/i, "JSON-LD block");
requireMatch(robots, /User-agent:\s*\*/i, "robots user agent");
requireMatch(robots, /Allow:\s*\//i, "robots allow");
requireMatch(robots, new RegExp(`Sitemap:\\s*${canonical}sitemap\\.xml`, "i"), "robots sitemap");
requireMatch(sitemap, new RegExp(`<loc>${canonical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<\\/loc>`, "i"), "sitemap canonical URL");
requireMatch(sitemap, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/i, "sitemap lastmod");
if (/localhost|127\.0\.0\.1|example\.com/i.test(`${html}\n${robots}\n${sitemap}`)) failures.push("placeholder host");

let jsonLdBlocks = 0;
for (const block of html.matchAll(/<script\s+type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/gi)) {
  try {
    const parsed = JSON.parse(block[1]);
    const graph = parsed?.["@graph"] || parsed;
    const types = Array.isArray(graph) ? graph.map((item) => item?.["@type"]) : [graph?.["@type"]];
    if (!types.flat().some((type) => ["WebSite", "SoftwareSourceCode"].includes(type))) failures.push("JSON-LD type");
    jsonLdBlocks += 1;
  } catch {
    failures.push("invalid JSON-LD");
  }
}
if (jsonLdBlocks === 0) failures.push("missing parseable JSON-LD");

for (const relative of guides) {
  const page = read(relative);
  const expected = canonical + relative;
  requireMatch(page, /<title>[^<]{20,180}<\/title>/i, `${relative}: title`);
  requireMatch(page, /<meta\s+name=["']description["'][^>]+content="[^"]{80,240}"/i, `${relative}: meta description`);
  if (!page.includes(`href="${expected}"`)) failures.push(`${relative}: canonical URL`);
  requireMatch(page, /property=["']og:title["']/i, `${relative}: Open Graph title`);
  requireMatch(page, /property=["']og:description["']/i, `${relative}: Open Graph description`);
  requireMatch(page, new RegExp(`<meta\\s+property=["']og:image["'][^>]+content=["']${escapeRegExp(socialImage)}["']`, "i"), `${relative}: Open Graph image`);
  requireMatch(page, new RegExp(`<meta\\s+name=["']twitter:image["'][^>]+content=["']${escapeRegExp(socialImage)}["']`, "i"), `${relative}: Twitter image`);
  requireMatch(page, /name=["']twitter:card["'][^>]+content=["']summary["']/i, `${relative}: Twitter card`);
  requireMatch(page, /<h1\b[^>]*>[^<]+<\/h1>/i, `${relative}: visible H1`);
  requireMatch(page, /application\/ld\+json/i, `${relative}: JSON-LD block`);
  if (!/"@type"\s*:\s*"(?:WebPage|HowTo)"/i.test(page)) failures.push(`${relative}: JSON-LD type`);
  if (!sitemap.includes(`<loc>${expected}</loc>`)) failures.push(`${relative}: sitemap URL`);
  const sitemapBlock = new RegExp(`<url>[\\s\\S]*?<loc>${escapeRegExp(expected)}</loc>[\\s\\S]*?<lastmod>\\d{4}-\\d{2}-\\d{2}</lastmod>[\\s\\S]*?</url>`, "i");
  if (!sitemapBlock.test(sitemap)) failures.push(`${relative}: sitemap lastmod`);
}

const report = {
  audit: "seo",
  canonical,
  files: ["docs/index.html", ...guides.map((file) => `docs/${file}`), "docs/robots.txt", "docs/sitemap.xml"],
  json_ld_blocks: jsonLdBlocks,
  failures,
  passed: failures.length === 0,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failures.length) process.exitCode = 1;
