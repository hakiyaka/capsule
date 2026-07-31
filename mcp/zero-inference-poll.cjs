"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const core = require("./core.cjs");

const MAX_AGE_MS = 20 * 60_000;
const MAX_ENTRIES = 64;
const CONTROL_RE = /[\r\n;&|><`]|\$\(|\$\{/;
const MUTATION_RE = /\b(?:--delete|--remove|--write|--replace|--in-place|remove-item|set-content|add-content|out-file|rm|del|erase|mv|move|cp|copy|git\s+(?:add|commit|push|reset|checkout))\b/i;
const STATUS_COMMANDS = [
  ["git-status", /^git\s+status(?:\s|$)/i, "filesystem-event"],
  ["github-status", /^gh\s+(?:run\s+(?:view|list)|pr\s+(?:checks|view|status)|workflow\s+view)(?:\s|$)/i, "interval"],
  ["cluster-status", /^(?:kubectl|oc)\s+(?:get|describe)(?:\s|$)/i, "interval"],
  ["container-status", /^docker(?:\s+compose)?\s+(?:ps|inspect|logs)(?:\s|$)/i, "interval"],
  ["service-status", /^(?:systemctl\s+(?:status|is-active|is-failed|show)|sc(?:\.exe)?\s+query|get-service)(?:\s|$)/i, "interval"],
  ["process-status", /^(?:get-process|get-job|tasklist|ps)(?:\s|$)/i, "interval"],
  ["path-status", /^(?:test-path|get-item)(?:\s|$)/i, "filesystem-event"],
  ["log-tail", /^(?:tail(?:\s|$)|get-content\b.*\s-tail(?:\s|$))/i, "filesystem-event"],
];

function clamp(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function normalizedCommand(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function classifyCommand(value) {
  const command = normalizedCommand(value);
  if (!command || command.length > 2_000 || CONTROL_RE.test(command) || MUTATION_RE.test(command)) {
    return null;
  }
  const match = STATUS_COMMANDS.find(([, pattern]) => pattern.test(command));
  if (!match) return null;
  return { command, profile: match[0], transport: match[2] };
}

function descriptor(args = {}) {
  const classified = classifyCommand(args.command);
  if (!classified) return null;
  const cwd = path.resolve(args.cwd || process.cwd());
  const epoch = Math.max(0, Number(args.execution_epoch || 0));
  return {
    ...classified,
    cwd,
    epoch,
    signature: digest(JSON.stringify({
      command: classified.command.toLowerCase(),
      cwd: process.platform === "win32" ? cwd.toLowerCase() : cwd,
    })).slice(0, 24),
  };
}

function safeCommand(command) {
  return Boolean(classifyCommand(command));
}

function normalizeOutput(value) {
  return String(value || "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\b\d{4}-\d\d-\d\d[T ][\d:.+-]+Z?\b/g, "<time>")
    .replace(/\b\d\d:\d\d:\d\d(?:\.\d+)?\b/g, "<time>")
    .replace(/\b(?:pid|process)\s*[:=#]?\s*\d+\b/gi, "pid=<pid>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|msec|milliseconds?|secs?|seconds?)\b/gi, "<duration>")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

function semanticHash(execution = {}) {
  return digest(`${Number(execution.exit_code || 0)}\0${normalizeOutput(execution.text)}`);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function stateFile(args = {}) {
  const session = String(args.session_id || "").trim();
  if (!session || session === "unknown") return "";
  const cwd = path.resolve(args.cwd || process.cwd());
  const key = digest(`${session}\0${process.platform === "win32" ? cwd.toLowerCase() : cwd}`).slice(0, 24);
  return path.join(core.stateRoot(), "zero-inference-poll", `${key}.json`);
}

function contextMinimum() {
  return clamp(process.env.CAPSULE_ZERO_POLL_MIN_CONTEXT, 2_000, 0, 1_000_000);
}

function repeatThreshold() {
  return clamp(process.env.CAPSULE_ZERO_POLL_REPEATS, 2, 2, 8);
}

function observe(args = {}, execution = {}) {
  if (process.env.CAPSULE_ZERO_POLL === "0") return { enabled: false };
  const candidate = descriptor(args);
  const file = stateFile(args);
  const contextTokens = Math.max(0, Number(args.input_tokens || 0));
  if (!candidate || !file || contextTokens < contextMinimum() || Number(execution.exit_code || 0) !== 0) {
    return { enabled: false, candidate };
  }
  const now = Date.now();
  const state = readJson(file, { version: 1, entries: {} });
  const entries = Object.fromEntries(
    Object.entries(state.entries || {})
      .filter(([, item]) => now - Number(item.at || 0) <= MAX_AGE_MS)
      .sort((left, right) => Number(right[1].at || 0) - Number(left[1].at || 0))
      .slice(0, MAX_ENTRIES - 1)
  );
  const currentHash = semanticHash(execution);
  const prior = entries[candidate.signature];
  const repeated = Boolean(
    prior &&
    Number(prior.epoch || 0) === candidate.epoch &&
    prior.semantic_hash === currentHash
  );
  const explicitCount = repeated ? Number(prior.explicit_count || 1) + 1 : 1;
  entries[candidate.signature] = {
    epoch: candidate.epoch,
    semantic_hash: currentHash,
    explicit_count: explicitCount,
    capsule_id: execution.capsule_id || "",
    at: now,
  };
  writeJsonAtomic(file, { version: 1, entries });
  return {
    enabled: true,
    activate: explicitCount >= repeatThreshold(),
    candidate,
    context_tokens: contextTokens,
    explicit_count: explicitCount,
    file,
    semantic_hash: currentHash,
  };
}

function recordLocal(observation, execution = {}) {
  if (!observation?.enabled || !observation.file || !observation.candidate) return false;
  const state = readJson(observation.file, { version: 1, entries: {} });
  const currentHash = semanticHash(execution);
  const changed = currentHash !== observation.semantic_hash ||
    Number(execution.exit_code || 0) !== 0;
  state.entries[observation.candidate.signature] = {
    epoch: observation.candidate.epoch,
    semantic_hash: currentHash,
    explicit_count: changed ? 1 : observation.explicit_count,
    capsule_id: execution.capsule_id || "",
    at: Date.now(),
  };
  writeJsonAtomic(observation.file, state);
  return changed;
}

function plan(args = {}, candidate = descriptor(args)) {
  const contextTokens = Math.max(0, Number(args.input_tokens || 0));
  const defaultWindow = contextTokens >= 128_000 ? 45_000
    : contextTokens >= 64_000 ? 30_000
    : contextTokens >= 16_000 ? 18_000
    : 10_000;
  const windowMs = clamp(
    process.env.CAPSULE_ZERO_POLL_WINDOW_MS,
    defaultWindow,
    1_000,
    55_000
  );
  const defaultInterval = candidate?.profile === "process-status" ? 2_000
    : candidate?.profile === "git-status" || candidate?.transport === "filesystem-event" ? 3_000
    : 5_000;
  const intervalMs = Math.min(windowMs, clamp(
    process.env.CAPSULE_ZERO_POLL_INTERVAL_MS,
    defaultInterval,
    250,
    15_000
  ));
  return {
    window_ms: windowMs,
    interval_ms: intervalMs,
    max_probes: Math.min(24, Math.max(1, Math.ceil(windowMs / intervalMs))),
    transport: candidate?.transport || "interval",
  };
}

module.exports = {
  classifyCommand,
  descriptor,
  normalizeOutput,
  observe,
  plan,
  recordLocal,
  safeCommand,
  semanticHash,
};
