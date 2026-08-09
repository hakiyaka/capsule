"use strict";

// Public documentation is part of the release surface. This audit checks the
// files users are likely to read, local Markdown links, UTF-8 integrity, and
// removed internal product names before a release is published.

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const roots = [
  "README.md",
  "BENCHMARK.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "PRIVACY.md",
  "docs",
  "skills",
  "optional-skills",
  ".github",
];
const extensions = new Set([".md", ".txt", ".html"]);
const forbidden = [
  { pattern: /token[- ]cartographer/i, label: "retired Token Cartographer name" },
  { pattern: /context mode/i, label: "retired Context Mode name" },
];

function relative(file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function walk(target, output = []) {
  if (!fs.existsSync(target)) return output;
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (extensions.has(path.extname(target).toLowerCase())) output.push(target);
    return output;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    walk(path.join(target, entry.name), output);
  }
  return output;
}

function localLinks(text) {
  return [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1].trim().replace(/^<|>$/g, ""))
    .filter((target) => target && !/^(?:[a-z]+:|#|\/\/)/i.test(target));
}

function htmlAnchors(text) {
  return [...text.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((match) => ({
    target: (match[1].match(/\bhref=["']([^"']+)["']/i) || [])[1] || "",
    label: match[2].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(),
  }));
}

function githubSourceLinks(text) {
  return [...text.matchAll(/https:\/\/github\.com\/hakiyaka\/capsule\/(?:blob|tree)\/main\/([^"'<>?#\s]+)/gi)]
    .map((match) => decodeURIComponent(match[1]));
}

const files = [...new Set(roots.flatMap((entry) => walk(path.join(root, entry))))].sort();
const failures = [];
for (const file of files) {
  const bytes = fs.readFileSync(file);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) failures.push({ file: relative(file), issue: "invalid UTF-8" });
  if (text.includes("\0") || text.includes("\uFFFD")) failures.push({ file: relative(file), issue: "replacement or NUL character" });
  for (const rule of forbidden) {
    if (rule.pattern.test(text)) failures.push({ file: relative(file), issue: rule.label });
  }
  for (const target of localLinks(text)) {
    const cleanTarget = target.split("#", 1)[0].split("?", 1)[0];
    if (!cleanTarget) continue;
    const resolved = path.resolve(path.dirname(file), cleanTarget);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      failures.push({ file: relative(file), issue: `link escapes repository: ${target}` });
    } else if (!fs.existsSync(resolved)) {
      failures.push({ file: relative(file), issue: `broken local link: ${target}` });
    }
  }
  for (const target of githubSourceLinks(text)) {
    const resolved = path.resolve(root, target);
    if (!resolved.startsWith(root + path.sep) || !fs.existsSync(resolved)) {
      failures.push({ file: relative(file), issue: `broken GitHub source link: ${target}` });
    }
  }
}

const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
if (!readme.includes("npm run verify")) failures.push({ file: "README.md", issue: "missing verify command" });

const guideRoot = path.join(root, "docs", "guide");
const guideFiles = walk(guideRoot).filter((file) => path.extname(file).toLowerCase() === ".html");
const guideHub = path.join(guideRoot, "index.html");
const leafGuides = guideFiles.filter((file) => path.resolve(file) !== path.resolve(guideHub));
let guideHubLinks = 0;
for (const file of leafGuides) {
  const anchors = htmlAnchors(fs.readFileSync(file, "utf8"));
  const hasHubLink = anchors.some(({ target, label }) => {
    if (!target || /^(?:[a-z]+:|#|\/\/)/i.test(target)) return false;
    const cleanTarget = target.split("#", 1)[0].split("?", 1)[0];
    const resolved = path.resolve(path.dirname(file), cleanTarget);
    return resolved === path.resolve(guideHub) && /^all guides$/i.test(label);
  });
  if (hasHubLink) {
    guideHubLinks += 1;
  } else {
    failures.push({ file: relative(file), issue: "guide page missing visible All guides link" });
  }
}

const report = {
  audit: "docs",
  passed: failures.length === 0,
  inspected_files: files.length,
  leaf_guides: leafGuides.length,
  guide_hub_links: guideHubLinks,
  failures,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
