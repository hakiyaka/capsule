"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const ignoredDirectories = new Set([".git", "node_modules"]);
const textExtensions = new Set(["", ".cjs", ".js", ".json", ".md", ".py", ".txt", ".yaml", ".yml"]);

function walk(directory, result = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target, result);
    else result.push(target);
  }
  return result;
}

function relative(file, base = root) {
  return path.relative(base, file).replaceAll("\\", "/");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileMap(base) {
  const map = new Map();
  for (const file of walk(base)) {
    const name = relative(file, base);
    map.set(name, sha256(fs.readFileSync(file)));
  }
  return map;
}

function compareTrees(left, right) {
  const leftMap = fileMap(left);
  const rightMap = fileMap(right);
  const names = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort();
  const mismatches = names.filter((name) =>
    !leftMap.has(name) || !rightMap.has(name) || leftMap.get(name) !== rightMap.get(name)
  );
  return {
    root: right,
    files: rightMap.size,
    mismatches: mismatches.length,
    examples: mismatches.slice(0, 20),
  };
}

const files = walk(root).sort();
const failures = [];
const warnings = [];
const stats = {
  files: files.length,
  bytes: 0,
  lines: 0,
  by_extension: {},
};
const pythonFiles = [];

for (const file of files) {
  const data = fs.readFileSync(file);
  const extension = path.extname(file).toLowerCase();
  const bucket = extension || "<none>";
  stats.bytes += data.length;
  stats.by_extension[bucket] ||= { files: 0, bytes: 0, lines: 0 };
  stats.by_extension[bucket].files += 1;
  stats.by_extension[bucket].bytes += data.length;
  if (!textExtensions.has(extension)) {
    warnings.push({ type: "unscanned-binary", file: relative(file) });
    continue;
  }
  const text = data.toString("utf8");
  const lines = text ? text.split(/\r?\n/).length : 0;
  stats.lines += lines;
  stats.by_extension[bucket].lines += lines;
  if (!Buffer.from(text, "utf8").equals(data)) {
    failures.push({ type: "invalid-utf8", file: relative(file) });
  }
  if (text.includes("\0")) failures.push({ type: "nul-byte", file: relative(file) });
  if (/\uFFFD|\u00C3.|\u00C2.|\u00E2(?:\u20AC|\u2026|\u2122|\u0153|\u009D)|\u00F0\u0178|\u00EF\u00BF\u00BD/u.test(text)) {
    failures.push({ type: "mojibake", file: relative(file) });
  }
  if (extension === ".cjs" || extension === ".js") {
    try {
      new vm.Script(text.replace(/^#![^\n]*\n/, "\n"), { filename: file });
    } catch (error) {
      failures.push({ type: "javascript-syntax", file: relative(file), error: error.message });
    }
    for (const match of text.matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
      try {
        require.resolve(path.resolve(path.dirname(file), match[1]));
      } catch {
        failures.push({ type: "missing-local-require", file: relative(file), target: match[1] });
      }
    }
  } else if (extension === ".json") {
    try {
      JSON.parse(text);
    } catch (error) {
      failures.push({ type: "json-syntax", file: relative(file), error: error.message });
    }
  } else if (extension === ".py") {
    pythonFiles.push(file);
  }
}

if (pythonFiles.length) {
  const source = [
    "import ast,json,sys",
    "files=json.load(sys.stdin)",
    "errors=[]",
    "for file in files:",
    "  try:",
    "    ast.parse(open(file,encoding='utf-8').read(),filename=file)",
    "  except Exception as exc:",
    "    errors.append({'file':file,'error':str(exc)})",
    "print(json.dumps(errors))",
  ].join("\n");
  const parsed = spawnSync(process.env.PYTHON || "python", ["-c", source], {
    input: JSON.stringify(pythonFiles),
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (parsed.status !== 0) {
    failures.push({ type: "python-auditor", error: (parsed.stderr || "").trim() });
  } else {
    for (const error of JSON.parse(parsed.stdout || "[]")) {
      failures.push({ type: "python-syntax", file: relative(error.file), error: error.error });
    }
  }
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const pluginJson = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin", "plugin.json"), "utf8"));
if (!String(pluginJson.version).startsWith(packageJson.version + "+")) {
  failures.push({
    type: "version-mismatch",
    package: packageJson.version,
    plugin: pluginJson.version,
  });
}
for (const [name, command] of Object.entries(packageJson.scripts || {})) {
  const match = String(command).match(/^(?:node|python)\s+([^\s]+)/);
  if (!match || match[1].startsWith("-")) continue;
  if (!fs.existsSync(path.join(root, match[1]))) {
    failures.push({ type: "missing-script-target", script: name, target: match[1] });
  }
}

const mcpConfig = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
for (const [name, server] of Object.entries(mcpConfig.mcpServers || {})) {
  for (const argument of server.args || []) {
    if (!String(argument).startsWith("./")) continue;
    if (!fs.existsSync(path.resolve(root, argument))) {
      failures.push({ type: "missing-mcp-target", server: name, target: argument });
    }
  }
}

const hookConfig = JSON.parse(fs.readFileSync(path.join(root, "hooks", "hooks.json"), "utf8"));
const requiredEvents = ["PreToolUse", "PostToolUse", "SessionStart", "PreCompact", "UserPromptSubmit", "Stop"];
for (const event of requiredEvents) {
  if (!Array.isArray(hookConfig.hooks?.[event]) || !hookConfig.hooks[event].length) {
    failures.push({ type: "missing-hook-event", event });
  }
}
const preToolMatchers = (hookConfig.hooks?.PreToolUse || [])
  .map((entry) => String(entry.matcher || "").toLowerCase())
  .join("|");
for (const matcher of [
  "local_shell", "shell_command", "exec_command", "terminal", "bash", "sh",
  "zsh", "fish", "powershell", "pwsh", "cmd", "write_stdin",
]) {
  if (!preToolMatchers.split("|").includes(matcher)) {
    failures.push({ type: "missing-shell-hook-matcher", matcher });
  }
}

for (const file of files.filter((item) =>
  path.dirname(item) === path.join(root, "bench") && /-results(?:-v\d+)?\.json$/.test(item)
)) {
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  if (![report.control_tokens, report.treatment_tokens, report.savings_percent].every(Number.isFinite)) continue;
  const expected = Number(
    (((report.control_tokens - report.treatment_tokens) / Math.max(1, report.control_tokens)) * 100).toFixed(2)
  );
  if (Math.abs(expected - report.savings_percent) > 0.02) {
    failures.push({
      type: "benchmark-math",
      file: relative(file),
      expected,
      actual: report.savings_percent,
    });
  }
}

const treeMaterial = files.map((file) => relative(file) + "\0" + sha256(fs.readFileSync(file))).join("\n");
const compareRoots = [];
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] !== "--compare" || !process.argv[index + 1]) continue;
  const target = path.resolve(process.argv[index + 1]);
  index += 1;
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    failures.push({ type: "missing-compare-root", root: target });
    continue;
  }
  const comparison = compareTrees(root, target);
  compareRoots.push(comparison);
  if (comparison.mismatches) failures.push({ type: "tree-mismatch", ...comparison });
}

const report = {
  audit: "source-integrity",
  root,
  source_tree_sha256: sha256(treeMaterial),
  stats,
  checks: {
    utf8_roundtrip: true,
    javascript_parse: true,
    python_ast_parse: true,
    json_parse: true,
    local_require_resolution: true,
    package_script_targets: true,
    package_plugin_version: true,
    mcp_targets: true,
    lifecycle_hooks: requiredEvents.length,
    shell_hook_matchers: 12,
    benchmark_top_level_math: true,
  },
  comparisons: compareRoots,
  failures,
  warnings,
  passed: failures.length === 0,
};
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
if (failures.length) process.exitCode = 1;
