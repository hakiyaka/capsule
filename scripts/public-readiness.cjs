"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const requiredFiles = [
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "CHANGELOG.md",
  ".gitignore",
  ".github/workflows/ci.yml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/pull_request_template.md",
];
const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(root, file)));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const plugin = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin", "plugin.json"), "utf8"));
const mcp = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
const failures = [];

if (missing.length) failures.push(`missing public files: ${missing.join(", ")}`);
if (plugin.interface?.displayName !== "Capsule") failures.push("plugin displayName must be Capsule");
if (packageJson.name !== "capsule") failures.push("package installation id must be capsule");
if (!mcp.mcpServers?.capsule) failures.push("MCP server id must be capsule");
if (!String(plugin.version).startsWith(`${packageJson.version}+`)) {
  failures.push("package and plugin versions differ");
}
if (packageJson.private !== true) {
  failures.push("package must remain private until a repository URL and release owner are chosen");
}
if (!packageJson.scripts?.test || !packageJson.scripts?.["audit:source"]) {
  failures.push("required verification scripts are missing");
}

const distributedRoots = [
  ".codex-plugin",
  "hooks",
  "mcp",
  "optional-skills",
  "scripts",
  "skills",
];
const textExtensions = new Set([".cjs", ".js", ".json", ".md", ".toml", ".yaml", ".yml"]);
const machinePaths = [
  /[A-Za-z]:\\Users\\[^\\\s]+/g,
  /\/Users\/[^/\s]+/g,
  /\/home\/[^/\s]+/g,
];
const secretValues = [
  /\b(?:sk|ghp|github_pat|xox[baprs])-[A-Za-z0-9_-]{12,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

function walk(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) =>
    walk(path.join(target, entry.name))
  );
}

const inspected = [];
for (const relative of distributedRoots) {
  const target = path.join(root, relative);
  if (!fs.existsSync(target)) continue;
  for (const file of walk(target)) {
    if (!textExtensions.has(path.extname(file).toLowerCase())) continue;
    inspected.push(file);
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of machinePaths) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) failures.push(`machine-specific path: ${path.relative(root, file)}`);
    }
    for (const pattern of secretValues) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) failures.push(`possible secret: ${path.relative(root, file)}`);
    }
  }
}

const result = {
  audit: "public-readiness",
  passed: failures.length === 0,
  display_name: plugin.interface?.displayName,
  package_version: packageJson.version,
  plugin_version: plugin.version,
  installation_ids: ["capsule", "capsule@personal"],
  mcp_id: "capsule",
  inspected_files: inspected.length,
  failures: [...new Set(failures)],
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.passed) process.exitCode = 1;
