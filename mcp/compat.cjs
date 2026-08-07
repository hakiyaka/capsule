"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const changeMap = require("./change-map.cjs");
const providerTelemetry = require("./provider-telemetry.cjs");
const core = require("./core.cjs");
const zeroInferencePoll = require("./zero-inference-poll.cjs");
const storage = require("./storage.cjs");

const SECRET_RE = /\b(api[_-]?(?:key|token)|access[_-]?token|auth[_-]?token|authorization|cookie|credential|password|passwd|private[_-]?key|secret|token)\s*([:=])\s*(?:bearer\s+)?[^\s,;]+|\bbearer\s+[a-z0-9._~+/=-]+/ig;
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const SIGNAL_RE = /\b(error|exception|fatal|fail(?:ed|ure)?|panic|security|timeout|traceback|warn(?:ing)?|denied)\b/i;
const SUMMARY_RE = /\b(pass(?:ed)?|fail(?:ed)?|tests?|suites?|errors?|warnings?|finished|completed|duration|time|total|summary|success)\b/i;
// Verification runners repeat one line per test/file even when the only
// actionable fact is the final aggregate. Keep failure context, but collapse
// a successful run to its bounded summary. This mirrors the useful part of
// WrongStack's result serializer without assuming a provider-side cache or a
// particular runner implementation.
const TEST_FAILURE_RE = /(?:^|[\s:])(?:FAIL(?:ED)?\b|✕|×|✗|ERROR\b|Error:|TypeError:|AssertionError:|Exception:|panic:)|\b(?:[1-9]\d*|one)\s+(?:failed|failing|error|errors)\b/i;
const TEST_SUMMARY_RE = /^\s*(?:test\s+suites?|tests?|specs?|checks?|snapshots?|time|duration|ran\b|total|passed|failed|warnings?|errors?)\s*[:=]/i;
const TEST_PASS_LINE_RE = /^\s*(?:PASS\b|ok\b|[✓✔])\s*/i;
const TEST_WARNING_RE = /^\s*(?:warn(?:ing)?\b|⚠)\s*[:：]?/i;
const INTERACTIVE_RE = /\b(vim|nvim|nano|less|more|top|htop|ssh|ftp|telnet|python|node|pwsh|powershell|cmd)\s*$/i;
const LARGE_OUTPUT_RE = /\b(diff|find|grep|rg|tree|log|test|build|lint|list|describe|scan|audit|status|show|history|ps|inspect)\b/i;
const HOOK_READ_ONLY_RE = /^(?:rg|grep|findstr|fd|tree|cat|type|jq|Get-ChildItem|Get-Content|Select-String|git\s+(?:status|diff|log|show|branch|tag|remote)|docker\s+(?:ps|logs|inspect)|kubectl\s+(?:get|describe|logs)|npm\s+(?:list|ls|outdated)|pip\s+(?:list|show)|dotnet\s+(?:list|--info)|cargo\s+(?:tree|metadata)|go\s+(?:list|env))\b/i;
const HOOK_SHELL_CONTROL_RE = /(?:[\r\n;&|<>`]|\$\(|\$\{|>\s*\S)/;
const HOOK_MUTATION_FLAG_RE = /\b(?:--delete|-delete|-exec|--exec|--remove|--write|--output|--replace|--in-place)\b/i;
const COMMAND_FAMILIES = [
  "ls", "tree", "read", "smart", "git", "gh", "glab", "aws", "psql", "pnpm", "err",
  "test", "json", "deps", "env", "find", "diff", "log", "dotnet", "docker", "kubectl",
  "oc", "summary", "grep", "rg", "init", "wget", "wc", "gain", "cc-economics",
  "config", "jest", "vitest", "prisma", "tsc", "next", "lint", "prettier", "format",
  "playwright", "cargo", "npm", "npx", "curl", "discover", "session", "telemetry",
  "learn", "run", "proxy", "pipe", "trust", "untrust", "verify", "ruff", "pytest",
  "mypy", "php", "phpunit", "phpstan", "pest", "paratest", "ecs", "pint", "rake",
  "rubocop", "rspec", "pip", "uv", "go", "sbt", "gt", "golangci-lint", "gradlew",
  "mvn", "hook-audit", "rewrite", "hook",
];
const BUILTIN_FILTERS = [];
const PROFILE_COMMANDS = {
  test: /^(?:jest|vitest|pytest|phpunit|pest|paratest|rspec|playwright|cargo-test|go-test|dotnet-test|mvn-test|gradlew-test|sbt-test)$/,
  diagnostic: /^(?:tsc|lint|eslint|biome|ruff|mypy|phpstan|ecs|pint|rubocop|golangci-lint|prettier|format|shellcheck|yamllint|hadolint|markdownlint|oxlint|basedpyright|ty|pre-commit)$/,
  listing: /^(?:ls|tree|read|smart|find|grep|rg|wc|env|deps|df|du|ps|stat|jq)$/,
  network: /^(?:curl|wget)$/,
  table: /^(?:aws|psql|docker|kubectl|oc|gcloud|terraform|tofu|helm|pulumi|ansible-playbook|systemctl-status|iptables|fail2ban-client|jira|jj|yadm)$/,
  build: /^(?:cargo|npm|npx|pnpm|yarn|pip|uv|dotnet|go|gradle|gradlew|mvn|sbt|make|next|prisma|php|rake|bundle-install|composer-install|poetry-install|uv-sync|swift-build|xcodebuild|trunk-build|turbo|nx|pio-run|mix-compile|quarto-render|spring-boot)$/,
};

function int(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function sha256(value) {
  return storage.sha256(value);
}

function statePaths() {
  const root = path.join(core.stateRoot(), "compat");
  return {
    root,
    history: path.join(root, "history.json"),
    filters: path.join(root, "filters.json"),
    trust: path.join(root, "trusted-projects.json"),
  };
}

function ensureState() {
  const state = statePaths();
  fs.mkdirSync(state.root, { recursive: true });
  return state;
}

function readJson(file, fallback) {
  return storage.readJson(file, fallback, { onError: "missing" });
}

function writeJson(file, value) {
  return storage.writeJsonAtomic(file, value, { pretty: true });
}

function redact(text) {
  return String(text).replace(SECRET_RE, (match, name, separator) => {
    if (name) return `${name}${separator}[REDACTED]`;
    return `${match.slice(0, match.search(/\s/))} [REDACTED]`;
  });
}

function unique(lines) {
  const seen = new Map();
  const result = [];
  for (const raw of lines) {
    const line = String(raw).replace(/\s+$/g, "");
    const normalized = line
      .replace(/\b\d{4}-\d\d-\d\d[T ][\d:.+-]+Z?\b/g, "<time>")
      .replace(/\b(?:0x)?[a-f0-9]{8,}\b/ig, "<id>")
      .replace(/\b\d+(?:\.\d+)?(?:ms|s|m|h)?\b/g, "#");
    const previous = seen.get(normalized);
    if (previous) previous.count += 1;
    else {
      const item = { line, count: 1 };
      seen.set(normalized, item);
      result.push(item);
    }
  }
  return result.map((item) => item.count > 1 ? `${item.line}  [x${item.count}]` : item.line);
}

function inferProfile(command, args = [], requested = "auto") {
  if (requested && requested !== "auto") return String(requested).toLowerCase();
  const executable = path.basename(String(command || "")).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
  const joined = `${executable} ${(args || []).join(" ")}`.toLowerCase();
  const firstTwo = joined.trim().split(/\s+/).slice(0, 2).join("-");
  const first = joined.trim().split(/\s+/)[0] || executable;
  if (/\b(git|gh|glab)\b/.test(executable) && /\b(diff|show)\b/.test(joined)) return "diff";
  if (/\bgit\b/.test(executable) && /\b(log|reflog)\b/.test(joined)) return "git-log";
  if (/\b(git|gh|glab|gt)\b/.test(executable)) return "git";
  if (/\b(jest|vitest|pytest|rspec|rake|playwright|cargo test|go test|dotnet test|mvn test|gradlew test)\b/.test(joined)) return "test";
  if (/\b(tsc|eslint|lint|mypy|ruff|rubocop|golangci|prettier|format)\b/.test(joined)) return "diagnostic";
  if (/\b(find|fd|tree|dir|ls|get-childitem)\b/.test(joined)) return "listing";
  if (/\b(grep|rg|select-string)\b/.test(joined)) return "grep";
  if (/\b(logs?|journalctl)\b/.test(joined)) return "log";
  if (/\b(env|set)\b/.test(joined)) return "env";
  if (/\b(curl|wget|invoke-webrequest)\b/.test(joined)) return "network";
  if (/\b(aws|kubectl|docker|psql)\b/.test(executable)) return "table";
  if (/\b(npm|pnpm|yarn|cargo|go|dotnet|gradle|gradlew|mvn|make|next|prisma|pip)\b/.test(joined)) return "build";
  if (/\b(package\.json|cargo\.toml|requirements\.txt|go\.mod)\b/.test(joined)) return "deps";
  if (/\bwc\b/.test(executable)) return "count";
  for (const [profile, matcher] of Object.entries(PROFILE_COMMANDS)) {
    if (matcher.test(firstTwo) || matcher.test(first)) return profile;
  }
  return "generic";
}

function aroundSignals(lines, matcher, radius = 2) {
  const keep = new Set();
  lines.forEach((line, index) => {
    if (!matcher.test(line)) return;
    for (let cursor = Math.max(0, index - radius); cursor <= Math.min(lines.length - 1, index + radius); cursor += 1) {
      keep.add(cursor);
    }
  });
  return [...keep].sort((a, b) => a - b).map((index) => lines[index]);
}

function jsonShape(value, prefix = "$", depth = 0, rows = []) {
  if (depth > 4 || rows.length >= 120) return rows;
  if (Array.isArray(value)) {
    rows.push(`${prefix}: array(${value.length})`);
    if (value.length) jsonShape(value[0], `${prefix}[]`, depth + 1, rows);
    return rows;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    rows.push(`${prefix}: object(${keys.length})`);
    for (const key of keys.slice(0, 50)) jsonShape(value[key], `${prefix}.${key}`, depth + 1, rows);
    return rows;
  }
  rows.push(`${prefix}: ${value === null ? "null" : typeof value}`);
  return rows;
}

function compactTable(lines) {
  return unique(lines
    .map((line) => line.replace(/^[\s|+─━┌┐└┘├┤┬┴┼-]+|[\s|+─━┌┐└┘├┤┬┴┼-]+$/g, ""))
    .map((line) => line.replace(/\s{2,}/g, "\t"))
    .filter(Boolean));
}

function compactGrep(lines) {
  const groups = new Map();
  for (const line of lines) {
    const match = line.match(/^(.+?):(\d+)(?::\d+)?:\s*(.*)$/);
    const file = match ? match[1] : "(matches)";
    const item = match ? `${match[2]}: ${match[3]}` : line.trim();
    if (!groups.has(file)) groups.set(file, []);
    if (groups.get(file).length < 20) groups.get(file).push(item);
  }
  return [...groups].flatMap(([file, matches]) => [`# ${file} (${matches.length} shown)`, ...matches]);
}

function compactDiagnostics(lines) {
  const selected = aroundSignals(lines, new RegExp(`${SIGNAL_RE.source}|${SUMMARY_RE.source}`, "i"), 2);
  const counts = new Map();
  const ordered = [];
  for (const line of selected) {
    const key = line
      .replace(/^[A-Za-z]:[\\/].*?[:(]\d+(?::\d+|\d+,\d+)?[):]?\s*/, "<location>: ")
      .replace(/\b\d+\b/g, "#");
    if (counts.has(key)) counts.set(key, counts.get(key) + 1);
    else {
      counts.set(key, 1);
      ordered.push({ key, line });
    }
  }
  return ordered.map(({ key, line }) => counts.get(key) > 1 ? `${line}  [x${counts.get(key)}]` : line);
}

function compactTestOutput(lines) {
  const nonempty = lines.map((line) => String(line).trimEnd()).filter((line) => line.trim());
  if (!nonempty.length) return [];

  const failures = nonempty.filter((line) => TEST_FAILURE_RE.test(line));
  const summaries = nonempty.filter((line) => TEST_SUMMARY_RE.test(line));
  const warnings = nonempty.filter((line) => TEST_WARNING_RE.test(line));

  // A green run is the common case. Emit only runner aggregates and a small
  // warning tail; every omitted line remains available through the exact
  // Capsule created by the caller.
  if (!failures.length) {
    if (summaries.length) {
      return unique([
        ...warnings.slice(-4),
        ...summaries.slice(-16),
      ]).slice(-20);
    }
    const passLines = nonempty.filter((line) => TEST_PASS_LINE_RE.test(line));
    if (passLines.length) {
      return [
        `[Capsule test summary] status=passed; checks=${passLines.length}; repetitive runner output omitted`,
      ];
    }
    // Unknown successful-looking output is kept on the conservative path.
    return compactDiagnostics(nonempty);
  }

  // On a failing run, retain the failure neighborhood and aggregate lines,
  // while deliberately excluding the hundreds of unrelated PASS rows.
  const selected = aroundSignals(
    nonempty,
    new RegExp(`${TEST_FAILURE_RE.source}|${TEST_SUMMARY_RE.source}|${TEST_WARNING_RE.source}`, "i"),
    2,
  );
  const fallback = selected.length ? selected : compactDiagnostics(nonempty);
  return unique([
    ...nonempty.slice(0, 3).filter((line) => !TEST_PASS_LINE_RE.test(line)),
    ...fallback,
    ...nonempty.slice(-4),
  ]);
}

function compileRegex(value, flags = "i") {
  if (!value) return null;
  return new RegExp(String(value), flags);
}

function compileFilterRegex(value, filter, flags = "") {
  let source = String(value || "");
  const inline = source.match(/^\(\?([ims]+)\)/);
  let selected = filter && filter.builtin === true ? flags : `${flags}i`;
  if (inline) {
    source = source.slice(inline[0].length);
    selected += inline[1];
  }
  selected = [...new Set(selected)].join("");
  return new RegExp(source, selected);
}

function stripTomlComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote === "\"") {
      escaped = true;
      continue;
    }
    if ((character === "\"" || character === "'") && (!quote || quote === character)) {
      quote = quote ? null : character;
      continue;
    }
    if (character === "#" && !quote) return line.slice(0, index);
  }
  return line;
}

function splitToml(value, separator = ",") {
  const parts = [];
  let current = "";
  let quote = null;
  let escaped = false;
  let square = 0;
  let curly = 0;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote === "\"") {
      current += character;
      escaped = true;
      continue;
    }
    if ((character === "\"" || character === "'") && (!quote || quote === character)) {
      quote = quote ? null : character;
      current += character;
      continue;
    }
    if (!quote) {
      if (character === "[") square += 1;
      else if (character === "]") square -= 1;
      else if (character === "{") curly += 1;
      else if (character === "}") curly -= 1;
      if (character === separator && square === 0 && curly === 0) {
        if (current.trim()) parts.push(current.trim());
        current = "";
        continue;
      }
    }
    current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseTomlValue(source) {
  const value = String(source).trim();
  if (value.startsWith("\"")) return JSON.parse(value);
  if (value.startsWith("'")) return value.slice(1, -1);
  if (value === "true" || value === "false") return value === "true";
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitToml(value.slice(1, -1)).map(parseTomlValue);
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    const result = {};
    for (const field of splitToml(value.slice(1, -1))) {
      const equal = field.indexOf("=");
      if (equal < 1) throw new Error(`invalid TOML inline field: ${field}`);
      result[field.slice(0, equal).trim()] = parseTomlValue(field.slice(equal + 1));
    }
    return result;
  }
  throw new Error(`unsupported filter TOML value: ${value.slice(0, 80)}`);
}

function parseFilterToml(text) {
  const filters = {};
  let active = null;
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    let line = stripTomlComment(lines[index]).trim();
    if (!line) continue;
    const section = line.match(/^\[filters\.([a-z0-9][a-z0-9-]{0,63})\]$/);
    if (section) {
      active = section[1];
      filters[active] ||= { name: active };
      continue;
    }
    if (/^\[\[tests\./.test(line)) {
      active = null;
      continue;
    }
    if (!active) continue;
    const equal = line.indexOf("=");
    if (equal < 1) continue;
    const key = line.slice(0, equal).trim();
    let value = line.slice(equal + 1).trim();
    let square = 0;
    let curly = 0;
    const countBalance = (part) => {
      const clean = stripTomlComment(part);
      square += (clean.match(/\[/g) || []).length - (clean.match(/\]/g) || []).length;
      curly += (clean.match(/\{/g) || []).length - (clean.match(/\}/g) || []).length;
    };
    countBalance(value);
    while ((square > 0 || curly > 0) && index + 1 < lines.length) {
      index += 1;
      const next = stripTomlComment(lines[index]).trim();
      value += `\n${next}`;
      countBalance(next);
    }
    filters[active][key] = parseTomlValue(value);
  }
  return Object.values(filters).map(validateFilter);
}

function projectFilterFiles(project) {
  const file = path.join(project, ".capsule-filters.json");
  return fs.existsSync(file) ? [file] : [];
}

function filterFilesDigest(files) {
  return sha256(files.map((file) => `${path.resolve(file)}\0${sha256(fs.readFileSync(file))}`).join("\0"));
}

function loadFilters(cwd) {
  const state = ensureState();
  const global = (readJson(state.filters, { version: 2, filters: [] }).filters || []).map(validateFilter);
  if (!cwd) return [...global, ...BUILTIN_FILTERS.map(validateFilter)];
  const project = path.resolve(cwd);
  const files = projectFilterFiles(project);
  const trust = readJson(state.trust, { projects: {} });
  let local = [];
  if (files.length && trust.projects[project] === filterFilesDigest(files)) {
    for (const file of files) {
      if (/\.toml$/i.test(file)) local.push(...parseFilterToml(fs.readFileSync(file, "utf8")));
      else local.push(...(readJson(file, { filters: [] }).filters || []).map(validateFilter));
    }
  }
  return [...local, ...global, ...BUILTIN_FILTERS.map(validateFilter)];
}

function applyFilterPipeline(text, filter) {
  let value = String(text).replace(/\r\n?/g, "\n");
  const hadTrailingNewline = value.endsWith("\n");
  if (filter.strip_ansi) value = value.replace(ANSI_RE, "");
  for (const replacement of filter.replace || []) {
    const expression = compileFilterRegex(replacement.pattern, filter, replacement.flags || "g");
    value = value.replace(expression, replacement.replacement ?? replacement.with ?? "");
  }
  for (const rule of filter.match_output || []) {
    const matches = compileFilterRegex(rule.pattern, filter, rule.flags || "m").test(value);
    const excluded = rule.unless && compileFilterRegex(rule.unless, filter, "m").test(value);
    if (matches && !excluded) {
      return String(rule.message ?? "");
    }
  }
  let lines = value.split("\n");
  const strip = (filter.strip_lines_matching || []).map((pattern) => compileFilterRegex(pattern, filter));
  const keep = (filter.keep_lines_matching || []).map((pattern) => compileFilterRegex(pattern, filter));
  if (strip.length) lines = lines.filter((line) => !strip.some((expression) => expression.test(line)));
  if (keep.length) lines = lines.filter((line) => keep.some((expression) => expression.test(line)));
  if (filter.include) {
    const include = compileRegex(filter.include);
    lines = lines.filter((line) => include.test(line));
  }
  if (filter.exclude) {
    const exclude = compileRegex(filter.exclude);
    lines = lines.filter((line) => !exclude.test(line));
  }
  if (filter.truncate_lines_at) {
    const width = int(filter.truncate_lines_at, 0, 1, 100_000);
    lines = lines.map((line) => line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line);
  }
  if (filter.tail_lines) lines = lines.slice(-int(filter.tail_lines, 1, 1, 100_000));
  if (filter.max_lines) lines = lines.slice(0, int(filter.max_lines, 200, 1, 100_000));
  if (filter.builtin !== true && filter.preserve_duplicates !== true) lines = unique(lines);
  const output = lines.join("\n").replace(/\n+$/g, "");
  if (!output) return String(filter.on_empty || "");
  return filter.preserve_trailing_newline === true && hadTrailingNewline ? `${output}\n` : output;
}

function applyCustomFilter(text, options = {}) {
  const commandText = `${options.command || ""} ${(options.args || []).join(" ")}`;
  for (const filter of loadFilters(options.cwd)) {
    const match = compileRegex(filter.match_command || filter.match);
    if (match && !match.test(commandText) && !match.test(options.profile || "")) continue;
    return { name: filter.name, output: applyFilterPipeline(text, filter), builtin: filter.builtin === true };
  }
  return null;
}

function filterText(text, options = {}) {
  const raw = redact(text);
  const lines = String(raw).replace(/\r\n?/g, "\n").split("\n");
  const profile = inferProfile(options.command, options.args, options.profile);
  const custom = applyCustomFilter(raw, { ...options, profile });
  if (custom) return { profile: `custom:${custom.name}`, lines: custom.output.split("\n") };

  if (profile === "diff") {
    const manifest = changeMap.renderUnifiedDiffManifest(raw);
    if (manifest) return { profile, lines: manifest };
    return { profile, lines: lines.filter((line) => /^(?:diff --git|index |@@|[+-]{3} |[+-](?![+-]))/.test(line)) };
  }
  if (profile === "test") return { profile, lines: compactTestOutput(lines) };
  if (["diagnostic", "build"].includes(profile)) {
    return { profile, lines: compactDiagnostics(lines) };
  }
  if (profile === "log") return { profile, lines: unique(lines.filter((line) => line.trim())) };
  if (profile === "grep") return { profile, lines: compactGrep(lines.filter(Boolean)) };
  if (["table", "git", "git-log"].includes(profile)) return { profile, lines: compactTable(lines) };
  if (profile === "listing") {
    const nonempty = lines.map((line) => line.trim()).filter(Boolean);
    const common = commonPathPrefix(nonempty);
    return { profile, lines: unique(nonempty.map((line) => common ? line.slice(common.length).replace(/^[\\/]/, "") : line)) };
  }
  if (profile === "env") return { profile, lines: lines.filter((line) => line.includes("=")).map(redact) };
  if (profile === "count") return { profile, lines: compactTable(lines) };
  if (["network", "deps"].includes(profile)) {
    const candidate = raw.replace(/^# stdout\s*/i, "").split(/\n# stderr\s*/i, 1)[0].trim();
    try {
      const value = JSON.parse(candidate);
      return { profile, lines: jsonShape(value) };
    } catch {
      return { profile, lines: compactTable(lines) };
    }
  }
  return {
    profile,
    lines: unique([
      ...aroundSignals(lines, new RegExp(`${SIGNAL_RE.source}|${SUMMARY_RE.source}`, "i"), 1),
      ...lines.slice(0, 12),
      ...lines.slice(-8),
    ]),
  };
}

function commonPathPrefix(lines) {
  if (!lines.length || !lines.every((line) => /[\\/]/.test(line))) return "";
  let prefix = lines[0];
  for (const line of lines.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < line.length && prefix[index].toLowerCase() === line[index].toLowerCase()) {
      index += 1;
    }
    prefix = prefix.slice(0, index);
    if (!prefix) return "";
  }
  const separator = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
  return separator >= 0 ? prefix.slice(0, separator + 1) : "";
}

function validateFilter(filter) {
  if (!filter || typeof filter !== "object") throw new Error("filter is required");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(filter.name || ""))) {
    throw new Error("filter.name must be lowercase hyphen-case");
  }
  for (const field of ["match", "match_command", "include", "exclude"]) {
    if (filter[field]) compileRegex(filter[field]);
  }
  for (const field of ["strip_lines_matching", "keep_lines_matching"]) {
    if (filter[field] != null && !Array.isArray(filter[field])) throw new Error(`${field} must be an array`);
    for (const pattern of filter[field] || []) compileRegex(pattern);
  }
  for (const replacement of filter.replace || []) new RegExp(replacement.pattern, replacement.flags || "g");
  for (const rule of filter.match_output || []) new RegExp(rule.pattern, rule.flags || "m");
  return {
    name: filter.name,
    description: filter.description || null,
    match: filter.match || filter.match_command || ".*",
    match_command: filter.match_command || filter.match || ".*",
    strip_ansi: filter.strip_ansi === true,
    filter_stderr: filter.filter_stderr === true,
    strip_lines_matching: filter.strip_lines_matching || [],
    keep_lines_matching: filter.keep_lines_matching || [],
    include: filter.include || null,
    exclude: filter.exclude || null,
    replace: filter.replace || [],
    match_output: filter.match_output || [],
    truncate_lines_at: filter.truncate_lines_at == null
      ? null
      : int(filter.truncate_lines_at, 120, 1, 100_000),
    max_lines: int(filter.max_lines, 200, 1, 5_000),
    tail_lines: filter.tail_lines == null ? null : int(filter.tail_lines, 20, 1, 100_000),
    on_empty: filter.on_empty || "",
    preserve_trailing_newline: filter.preserve_trailing_newline === true,
    preserve_duplicates: filter.preserve_duplicates === true || filter.builtin === true,
    builtin: filter.builtin === true,
    tests: Array.isArray(filter.tests) ? filter.tests : [],
  };
}

function testOneFilter(filter) {
  const normalized = validateFilter(filter);
  const failures = [];
  for (const [index, test] of normalized.tests.entries()) {
    const output = applyFilterPipeline(test.input || "", normalized);
    if (typeof test.expected === "string" && test.expected !== output) {
      failures.push({ test: index + 1, expected: test.expected, actual: output });
      continue;
    }
    const expectedNeedles = Array.isArray(test.expected) ? test.expected : [];
    const absentNeedles = Array.isArray(test.absent) ? test.absent : [];
    const missing = expectedNeedles.filter((needle) => !output.includes(needle));
    const present = absentNeedles.filter((needle) => output.includes(needle));
    if (missing.length || present.length) failures.push({ test: index + 1, missing, unexpectedly_present: present });
  }
  return { name: normalized.name, tests: normalized.tests.length, failures, ok: failures.length === 0 };
}

function manageFilters(args = {}) {
  const operation = args.operation || "list";
  const state = ensureState();
  const config = readJson(state.filters, { version: 1, filters: [] });
  if (operation === "list") {
    return {
      response: {
        filters: config.filters || [],
        builtin_filters: BUILTIN_FILTERS.length,
        trusted_projects: readJson(state.trust, { projects: {} }).projects,
      },
      capturedChars: 0,
    };
  }
  if (operation === "add") {
    const filter = validateFilter(args.filter);
    const test = testOneFilter(filter);
    if (!test.ok) throw new Error(`filter inline tests failed: ${JSON.stringify(test.failures)}`);
    config.filters = (config.filters || []).filter((item) => item.name !== filter.name);
    config.filters.push(filter);
    writeJson(state.filters, config);
    return { response: { added: filter.name, test }, capturedChars: 0 };
  }
  if (operation === "remove") {
    if (!args.name) throw new Error("name is required");
    const before = (config.filters || []).length;
    config.filters = (config.filters || []).filter((item) => item.name !== args.name);
    writeJson(state.filters, config);
    return { response: { removed: before - config.filters.length }, capturedChars: 0 };
  }
  if (operation === "test") {
    const selected = args.name ? (config.filters || []).filter((item) => item.name === args.name) : (config.filters || []);
    const results = selected.map(testOneFilter);
    return { response: { ok: results.every((item) => item.ok), results }, capturedChars: 0 };
  }
  if (operation === "trust") {
    const project = path.resolve(args.project || process.cwd());
    const files = projectFilterFiles(project);
    if (!files.length) throw new Error(`project filter file not found under: ${project}`);
    const trust = readJson(state.trust, { projects: {} });
    trust.projects[project] = filterFilesDigest(files);
    writeJson(state.trust, trust);
    return {
      response: {
        trusted: project,
        files,
        sha256: trust.projects[project],
      },
      capturedChars: 0,
    };
  }
  if (operation === "untrust") {
    const project = path.resolve(args.project || process.cwd());
    const trust = readJson(state.trust, { projects: {} });
    const existed = Object.hasOwn(trust.projects, project);
    delete trust.projects[project];
    writeJson(state.trust, trust);
    return { response: { untrusted: project, existed }, capturedChars: 0 };
  }
  throw new Error(`unknown filters operation: ${operation}`);
}

function recordHistory(event = {}) {
  const state = ensureState();
  const history = readJson(state.history, { version: 1, events: [] });
  const rawChars = Math.max(0, Number(event.raw_chars || 0));
  const emittedChars = Math.max(0, Number(event.emitted_chars || 0));
  const source = event.source || "mcp";
  const hookSource = String(source).startsWith("hook");
  const effective = event.effective === true || (!hookSource && event.effective !== false);
  history.events.push({
    at: new Date().toISOString(),
    command: event.command || null,
    args: event.args || [],
    cwd: event.cwd || null,
    profile: event.profile || "generic",
    route: event.route || "unknown",
    raw_chars: rawChars,
    emitted_chars: emittedChars,
    avoided_chars: Math.max(0, rawChars - emittedChars),
    exit_code: event.exit_code ?? null,
    elapsed_ms: Math.max(0, Number(event.elapsed_ms || 0)),
    session_id: event.session_id || null,
    source,
    effective,
    delivery_contract: event.delivery_contract || (hookSource ? "legacy-unverified" : "direct-mcp-response"),
  });
  if (history.events.length > 50_000) history.events = history.events.slice(-50_000);
  writeJson(state.history, history);
}

function gain(args = {}) {
  const events = readJson(ensureState().history, { events: [] }).events || [];
  const sinceDays = int(args.since_days, 0, 0, 3650);
  const cutoff = sinceDays ? Date.now() - sinceDays * 86_400_000 : 0;
  const project = args.project ? path.resolve(args.project) : null;
  const scoped = events.filter((event) =>
    Date.parse(event.at) >= cutoff && (!project || String(event.cwd || "").toLowerCase().startsWith(project.toLowerCase()))
  );
  const isEffective = (event) => event.effective === true ||
    (event.effective == null && !String(event.source || "mcp").startsWith("hook"));
  const unverified = scoped.filter((event) => !isEffective(event));
  const selected = args.include_unverified === true
    ? scoped
    : scoped.filter(isEffective);
  const raw = selected.reduce((sum, event) => sum + event.raw_chars, 0);
  const emitted = selected.reduce((sum, event) => sum + event.emitted_chars, 0);
  const avoidedChars = Math.max(0, raw - emitted);
  const avoidedTokens = core.approxTokens(avoidedChars);
  const byProfile = {};
  const byCommand = {};
  const byDay = {};
  for (const event of selected) {
    const profile = byProfile[event.profile] ||= { calls: 0, raw_chars: 0, emitted_chars: 0 };
    profile.calls += 1;
    profile.raw_chars += event.raw_chars;
    profile.emitted_chars += event.emitted_chars;
    const commandName = String(event.command || "(unknown)").trim().split(/\s+/)[0] || "(unknown)";
    const command = byCommand[commandName] ||= {
      calls: 0,
      raw_chars: 0,
      emitted_chars: 0,
      avoided_chars: 0,
      total_time_ms: 0,
    };
    command.calls += 1;
    command.raw_chars += event.raw_chars;
    command.emitted_chars += event.emitted_chars;
    command.avoided_chars += event.avoided_chars;
    command.total_time_ms += Number(event.elapsed_ms || 0);
    const day = event.at.slice(0, 10);
    const daily = byDay[day] ||= { calls: 0, avoided_chars: 0 };
    daily.calls += 1;
    daily.avoided_chars += event.avoided_chars;
  }
  return {
    response: {
      calls: selected.length,
      raw: { chars: raw, approx_tokens: core.approxTokens(raw) },
      emitted: { chars: emitted, approx_tokens: core.approxTokens(emitted) },
      avoided: {
        chars: avoidedChars,
        approx_tokens: avoidedTokens,
        ratio: raw ? Number(((raw - emitted) / raw).toFixed(4)) : 0,
      },
      dollar_estimate: core.estimateInputSavingsUsd(avoidedTokens, args),
      by_profile: byProfile,
      by_command: Object.fromEntries(Object.entries(byCommand).map(([name, command]) => [name, {
        ...command,
        ratio: command.raw_chars
          ? Number((command.avoided_chars / command.raw_chars).toFixed(4))
          : 0,
        avg_time_ms: command.calls ? Math.round(command.total_time_ms / command.calls) : 0,
      }])),
      by_day: byDay,
      quality: {
        passthrough_calls: selected.filter((event) => event.route === "passthrough").length,
        zero_reduction_calls: selected.filter((event) => event.raw_chars <= event.emitted_chars).length,
        low_reduction_calls: selected.filter((event) =>
          event.raw_chars > 0 && (event.raw_chars - event.emitted_chars) / event.raw_chars < 0.3
        ).length,
        failed_commands: selected.filter((event) => Number(event.exit_code || 0) !== 0).length,
      },
      verification: {
        mode: args.include_unverified === true ? "all-local-projections" : "contract-valid-only",
        excluded_unverified_calls: args.include_unverified === true ? 0 : unverified.length,
        excluded_unverified_raw_chars: args.include_unverified === true
          ? 0
          : unverified.reduce((sum, event) => sum + Number(event.raw_chars || 0), 0),
        legacy_hook_events_are_unverified: true,
      },
      history: args.history ? selected.slice(-int(args.limit, 30, 1, 500)) : undefined,
      failures: args.failures ? selected.filter((event) => event.route === "passthrough" && event.raw_chars > 2_000).slice(-100) : undefined,
      caveat: "Contract-valid local context-exposure estimates; no end-to-end host delivery proof, external telemetry, or provider billing.",
    },
    capturedChars: 0,
  };
}

function rewriteCommand(args = {}) {
  const command = String(args.command || "").trim();
  if (!command) throw new Error("command is required");
  const profile = inferProfile(command, [], args.profile);
  const interactive = INTERACTIVE_RE.test(command);
  const alreadyWrapped = /capsule|capsule/i.test(command);
  const zeroPollSafe = zeroInferencePoll.safeCommand(command);
  const hookSafe = args.hook !== true || (
    (HOOK_READ_ONLY_RE.test(command) || zeroPollSafe) &&
    !HOOK_SHELL_CONTROL_RE.test(command) &&
    !HOOK_MUTATION_FLAG_RE.test(command)
  );
  const shouldWrap = hookSafe && !interactive && !alreadyWrapped &&
    (LARGE_OUTPUT_RE.test(command) || zeroPollSafe || args.force === true);
  return {
    response: {
      command,
      profile,
      should_wrap: shouldWrap,
      reason: alreadyWrapped
        ? "already token-aware"
        : interactive
          ? "interactive command"
          : !hookSafe
            ? "hook rewrite restricted to an observational single command"
            : shouldWrap
              ? zeroPollSafe
                ? "safe repeated-status candidate"
                : "large-output signature"
              : "known-small or uncertain",
      hook_wrapper: shouldWrap,
      capsule_call: shouldWrap
        ? { action: "run", note: "Pass the executable as command and its arguments as args; the Codex hook handles full shell command strings." }
        : null,
    },
    capturedChars: 0,
  };
}

function scanFiles(root, limit = 200) {
  const result = [];
  function visit(directory) {
    if (result.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (result.length >= limit) break;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && /\.(jsonl|json|md)$/i.test(entry.name)) result.push(target);
    }
  }
  visit(root);
  return result;
}

function discover(args = {}) {
  const root = path.resolve(args.path || path.join(os.homedir(), ".codex", "sessions"));
  const maxFiles = int(args.max_files, 100, 1, 1_000);
  const maxBytes = int(args.max_bytes, 64 * 1024 * 1024, 10_000, 512 * 1024 * 1024);
  const files = fs.existsSync(root) ? scanFiles(root, maxFiles) : [];
  const candidates = new Map();
  let scanned = 0;
  for (const file of files) {
    if (scanned >= maxBytes) break;
    const size = fs.statSync(file).size;
    if (size > 16 * 1024 * 1024 || scanned + size > maxBytes) continue;
    const text = fs.readFileSync(file, "utf8");
    scanned += size;
    for (const match of text.matchAll(/"(?:command|cmd)"\s*:\s*"((?:\\.|[^"\\])+)"/g)) {
      let command;
      try {
        command = JSON.parse(`"${match[1]}"`);
      } catch {
        continue;
      }
      if (!LARGE_OUTPUT_RE.test(command) || /capsule|capsule/i.test(command)) continue;
      const key = command.replace(/\b\d+\b/g, "#").slice(0, 500);
      const entry = candidates.get(key) || { example: command.slice(0, 800), count: 0, profile: inferProfile(command) };
      entry.count += 1;
      candidates.set(key, entry);
    }
  }
  const opportunities = [...candidates.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, int(args.limit, 30, 1, 200));
  return {
    response: { root, files_scanned: files.length, bytes_scanned: scanned, opportunities },
    capturedChars: scanned,
  };
}

function commandBase(command) {
  return String(command || "")
    .trim()
    .replace(/^(?:sudo\s+|[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*/g, "")
    .split(/\s+/)[0]
    .replace(/^.*[\\/]/, "")
    .toLowerCase();
}

function classifyCorrectionError(text) {
  if (/\b(?:unknown|unrecognized|invalid)\s+(?:option|flag)\b/i.test(text)) return "unknown-flag";
  if (/\b(?:command not found|is not recognized)\b/i.test(text)) return "command-not-found";
  if (/\b(?:no such file|cannot find|not found)\b/i.test(text)) return "wrong-path";
  if (/\b(?:missing|required).*(?:argument|operand|parameter)\b/i.test(text)) return "missing-argument";
  if (/\b(?:permission denied|access is denied)\b/i.test(text)) return "permission-denied";
  if (/\b(?:usage:|syntax error|unexpected argument)\b/i.test(text)) return "wrong-syntax";
  return "other";
}

function learn(args = {}) {
  const root = path.resolve(args.path || path.join(os.homedir(), ".codex", "sessions"));
  const files = fs.existsSync(root) ? scanFiles(root, int(args.max_files, 100, 1, 1_000)) : [];
  const maxBytes = int(args.max_bytes, 64 * 1024 * 1024, 10_000, 512 * 1024 * 1024);
  const pairs = new Map();
  let scanned = 0;
  for (const file of files) {
    const size = fs.statSync(file).size;
    if (size > 16 * 1024 * 1024 || scanned + size > maxBytes) continue;
    const text = fs.readFileSync(file, "utf8");
    scanned += size;
    const commands = [];
    for (const match of text.matchAll(/"(?:command|cmd)"\s*:\s*"((?:\\.|[^"\\])+)"/g)) {
      try {
        commands.push({
          command: JSON.parse(`"${match[1]}"`),
          start: match.index,
          end: match.index + match[0].length,
        });
      } catch {
        // Ignore malformed session fragments without hiding later candidates.
      }
    }
    for (let index = 0; index + 1 < commands.length; index += 1) {
      const before = commands[index];
      const after = commands[index + 1];
      if (before.command === after.command || commandBase(before.command) !== commandBase(after.command)) continue;
      const evidence = text.slice(before.end, Math.min(after.start, before.end + 20_000));
      if (!SIGNAL_RE.test(evidence) && !/\b(?:usage:|not found|invalid|unknown|denied)\b/i.test(evidence)) continue;
      const errorType = classifyCorrectionError(evidence);
      const key = `${before.command}\0${after.command}\0${errorType}`;
      const entry = pairs.get(key) || {
        wrong: before.command.slice(0, 1_000),
        right: after.command.slice(0, 1_000),
        base_command: commandBase(before.command),
        error_type: errorType,
        occurrences: 0,
        confidence: 0,
      };
      entry.occurrences += 1;
      const shared = before.command.split(/\s+/).filter((part) => after.command.includes(part)).length;
      entry.confidence = Number(Math.min(
        0.99,
        0.55 + Math.min(0.2, shared * 0.04) + Math.min(0.2, entry.occurrences * 0.05)
      ).toFixed(2));
      pairs.set(key, entry);
    }
  }
  const minimumConfidence = Number(args.min_confidence ?? 0.65);
  const minimumOccurrences = int(args.min_occurrences, 1, 1, 1_000);
  const corrections = [...pairs.values()]
    .filter((entry) => entry.confidence >= minimumConfidence && entry.occurrences >= minimumOccurrences)
    .sort((left, right) => right.occurrences - left.occurrences || right.confidence - left.confidence)
    .slice(0, int(args.limit, 50, 1, 500));
  let written = null;
  if (args.write === true) {
    if (args.confirm !== true) throw new Error("confirm:true is required to write correction rules");
    const project = path.resolve(args.project || process.cwd());
    const target = path.resolve(args.output || path.join(project, ".codex", "rules", "capsule-cli-corrections.md"));
    const relative = path.relative(project, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("correction output must stay inside the project");
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const body = [
      "# Capsule CLI corrections",
      "",
      "Generated from local fail-then-correct command pairs. Re-run learning after toolchain changes.",
      "",
      ...corrections.flatMap((entry) => [
        `- When \`${entry.wrong.replace(/`/g, "\\`")}\` fails (${entry.error_type}), prefer \`${entry.right.replace(/`/g, "\\`")}\`.`,
        `  Evidence: ${entry.occurrences} occurrence(s), confidence ${entry.confidence}.`,
      ]),
      "",
    ].join("\n");
    fs.writeFileSync(target, body, "utf8");
    written = target;
  }
  return {
    response: {
      root,
      files_scanned: files.length,
      bytes_scanned: scanned,
      corrections,
      written,
      privacy: "Local session scan; raw outputs are not persisted by the learner.",
    },
    capturedChars: scanned,
  };
}

function surfaceStatus() {
  return {
    response: {
      command_families: COMMAND_FAMILIES.length,
      builtin_filters: BUILTIN_FILTERS.length,
      pipeline: [
        "strip_ansi", "replace", "match_output", "strip_lines_matching",
        "keep_lines_matching", "truncate_lines_at", "tail_lines", "max_lines", "on_empty",
      ],
      operations: {
        proxy: "run",
        pipe: "pipe",
        gain: "gain",
        discover: "discover",
        learn: "learn",
        trust_untrust: "filters",
        verify_hook_audit: "doctor",
        session_economics: "insight",
        failure_tee: "exact capsules",
      },
    },
    capturedChars: 0,
  };
}

function telemetry(args = {}) {
  const operation = args.operation || "status";
  if (operation === "provider") return providerTelemetry.snapshot(args);
  if (operation === "status") {
    return {
      response: {
        external_telemetry: false,
        provider_telemetry: true,
        provider_operation: "provider",
        local_history: true,
        privacy: "Provider counters are read locally from the Codex session; no metrics are uploaded.",
      },
      capturedChars: 0,
    };
  }
  if (operation === "forget") {
    if (args.confirm !== true) throw new Error("confirm:true is required");
    const state = ensureState();
    const existed = fs.existsSync(state.history);
    if (existed) fs.unlinkSync(state.history);
    return { response: { forgotten_local_history: existed }, capturedChars: 0 };
  }
  if (["enable", "disable"].includes(operation)) {
    return { response: { external_telemetry: false, requested: operation, note: "External telemetry is intentionally unavailable." }, capturedChars: 0 };
  }
  throw new Error(`unknown telemetry operation: ${operation}`);
}

module.exports = {
  applyCustomFilter,
  applyFilterPipeline,
  compactTestOutput,
  discover,
  filterText,
  gain,
  inferProfile,
  learn,
  manageFilters,
  parseFilterToml,
  recordHistory,
  redact,
  rewriteCommand,
  surfaceStatus,
  telemetry,
  testOneFilter,
};
