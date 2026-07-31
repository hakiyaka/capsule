"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const core = require("./core.cjs");
const compat = require("./compat.cjs");

const MINIMUM_CHARS = 600;
const MAXIMUM_CHARS = 2_000_000;
const LIFETIME_MS = 60 * 60_000;

function commandProfile(command) {
  const value = String(command || "").trim().toLowerCase();
  if (!value) return "";
  const profiles = [
    ["test", /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:pytest|jest|vitest|mocha|cargo\s+test|go\s+test|dotnet\s+test|mvn(?:w)?\s+test|gradle(?:w)?\s+test)\b/],
    ["lint", /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b|\b(?:eslint|ruff|flake8|pylint|clippy|golangci-lint)\b/],
    ["typecheck", /\b(?:tsc|mypy|pyright|typecheck|type-check|cargo\s+check)\b/],
    ["build", /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\b(?:cargo|dotnet|go|mvn|mvnw|gradle|gradlew)\s+build\b|\b(?:make|cmake|msbuild)\b/],
    ["format-check", /\b(?:prettier|black|ruff\s+format|gofmt|rustfmt)\b.*(?:--check|check)\b/],
    ["git-status", /\bgit\s+status\b/],
    ["git-diff", /\bgit\s+(?:diff|show|log)\b/],
    ["search", /(?:^|[|;&]\s*)(?:rg|grep|findstr|select-string)\b/],
    ["file-list", /(?:^|[|;&]\s*)(?:ls|dir|tree|find|get-childitem|gci)\b/],
    ["dependency", /\b(?:npm|pnpm|yarn|bun)\s+(?:install|audit|outdated)\b|\b(?:pip|uv)\s+(?:install|list|check)\b/],
  ];
  return profiles.find(([, pattern]) => pattern.test(value))?.[0] || "";
}

function canonicalCommand(command) {
  return String(command || "")
    .replace(/\s+/g, " ")
    .replace(/\s+(?:--watch|--watchall|--color(?:=\S+)?|--no-color)\b/gi, "")
    .trim()
    .toLowerCase();
}

function normalizeLine(value) {
  return String(value || "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>")
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<time>")
    .replace(/\b(?:pid|process)\s*[:=#]?\s*\d+\b/gi, "pid=<pid>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|msec|milliseconds?|s|sec|seconds?)\b/gi, "<duration>")
    .replace(/\b(?:seed|random seed)\s*[:=#]?\s*\d+\b/gi, "seed=<seed>")
    .replace(/[ \t]+$/g, "");
}

function countLines(lines) {
  const counts = new Map();
  for (const line of lines) counts.set(line, Number(counts.get(line) || 0) + 1);
  return counts;
}

function subtractLines(source, otherCounts) {
  const remaining = new Map(otherCounts);
  const result = [];
  for (const item of source) {
    const count = Number(remaining.get(item.normalized) || 0);
    if (count > 0) remaining.set(item.normalized, count - 1);
    else result.push(item.raw);
  }
  return result;
}

function selectSignalLines(lines, limit = 12) {
  const unique = [...new Set(lines.map((line) => String(line).trim()).filter(Boolean))];
  const signal = unique.filter((line) =>
    /\b(?:error|fail(?:ed|ure)?|exception|panic|fatal|warning|warn|pass(?:ed)?|success|changed|added|removed|modified|deleted|created|skipped|todo|found|not found)\b/i.test(line) ||
    /(?:^|\s)(?:[+-]\d+|[1-9]\d*\s+(?:errors?|failures?|warnings?))(?:\s|$)/i.test(line)
  );
  return [...signal, ...unique]
    .filter((line, index, all) => all.indexOf(line) === index)
    .slice(0, limit);
}

function stateFile(sessionId) {
  if (!sessionId) return "";
  const root = path.join(core.stateRoot(), "terminal-novelty");
  fs.mkdirSync(root, { recursive: true });
  const digest = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  return path.join(root, `${digest}.json`);
}

function writeState(file, state) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function terminalNovelty(args = {}) {
  if (process.env.CAPSULE_TERMINAL_NOVELTY === "0") return null;
  const profile = commandProfile(args.command);
  const file = stateFile(String(args.session_id || ""));
  const text = String(args.text || "");
  const capsuleId = String(args.capsule_id || "");
  if (!profile || !file || !capsuleId || text.length < MINIMUM_CHARS || text.length > MAXIMUM_CHARS) {
    return null;
  }

  const cwd = path.resolve(String(args.cwd || process.cwd()));
  const identity = crypto.createHash("sha256")
    .update(`${process.platform === "win32" ? cwd.toLowerCase() : cwd}\0${canonicalCommand(args.command)}`)
    .digest("hex")
    .slice(0, 24);
  const now = Date.now();
  let state = { entries: {} };
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    state = { entries: {} };
  }
  const entries = Object.fromEntries(
    Object.entries(state?.entries || {})
      .filter(([, item]) => now - Number(item.at || 0) <= LIFETIME_MS)
      .sort((left, right) => Number(right[1].at || 0) - Number(left[1].at || 0))
      .slice(0, 31)
  );
  const prior = entries[identity];
  entries[identity] = { capsule_id: capsuleId, at: now, profile, raw_chars: text.length };
  writeState(file, { entries });
  if (!prior?.capsule_id || now - Number(prior.at || 0) > LIFETIME_MS) return null;

  let before;
  try {
    before = core.loadCapsule(prior.capsule_id).text;
  } catch {
    return null;
  }
  if (before.length < MINIMUM_CHARS || before.length > MAXIMUM_CHARS) return null;

  const beforeLines = compat.redact(before).replace(/\r\n/g, "\n").split("\n")
    .map((raw) => ({ raw, normalized: normalizeLine(raw) }));
  const afterLines = compat.redact(text).replace(/\r\n/g, "\n").split("\n")
    .map((raw) => ({ raw, normalized: normalizeLine(raw) }));
  if (beforeLines.length > 30_000 || afterLines.length > 30_000) return null;
  const beforeCounts = countLines(beforeLines.map((item) => item.normalized));
  const afterCounts = countLines(afterLines.map((item) => item.normalized));
  let intersection = 0;
  for (const [line, count] of beforeCounts) {
    intersection += Math.min(count, Number(afterCounts.get(line) || 0));
  }
  const overlap = (2 * intersection) / Math.max(1, beforeLines.length + afterLines.length);
  const threshold = ["test", "lint", "typecheck", "build", "dependency"].includes(profile) ? 0.55 : 0.68;
  if (overlap < threshold) return null;

  const added = subtractLines(afterLines, beforeCounts);
  const removed = subtractLines(beforeLines, afterCounts);
  const stable = Math.max(0, intersection);
  const body = [
    ...selectSignalLines(removed).map((line) => `- ${line}`),
    ...selectSignalLines(added).map((line) => `+ ${line}`),
  ];
  if (!body.length) body.push("~ semantic state unchanged; volatile timing/timestamp/PID noise omitted");
  const header = `[Capsule terminal novelty ${profile}; stable=${(overlap * 100).toFixed(1)}%; ` +
    `+${added.length}/-${removed.length}; reused=${stable}; exact=${capsuleId}]`;
  const output = `${header}\n${body.join("\n")}`.slice(0, 2_000);
  const baseline = String(args.baseline_output || text);
  if (output.length + 100 >= baseline.length) return null;
  return {
    output,
    profile,
    overlap: Number(overlap.toFixed(4)),
    added: added.length,
    removed: removed.length,
    raw_chars: text.length,
    emitted_chars: output.length,
  };
}

module.exports = { canonicalCommand, commandProfile, normalizeLine, terminalNovelty };
