"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const core = require("./core.cjs");

const SAFE_PROFILES = new Set(["file-list", "search", "git-status", "git-diff"]);
const MAX_AGE_MS = 20 * 60_000;
const MIN_OBSERVATIONS = 2;
const MIN_CONFIDENCE = 0.8;

function digest(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
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

function normalizedCommand(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizedProfile(profile, command) {
  const requested = String(profile || "").toLowerCase();
  const value = String(command || "").toLowerCase();
  if (/\bgit\s+status\b/.test(value)) return "git-status";
  if (/\bgit\s+(?:diff|show|log)\b/.test(value)) return "git-diff";
  if (/(?:^|[|;&]\s*)(?:rg|grep|findstr|select-string)\b/.test(value)) return "search";
  if (/(?:^|[|;&]\s*)(?:ls|dir|tree|find|get-childitem|gci)\b/.test(value)) return "file-list";
  if (requested === "grep") return "search";
  if (requested === "listing") return "file-list";
  return requested;
}

function descriptor(args = {}) {
  const command = normalizedCommand(args.command);
  const profile = normalizedProfile(args.profile, command);
  const cwd = path.resolve(args.cwd || process.cwd());
  const epoch = Math.max(0, Number(args.execution_epoch || 0));
  return {
    command,
    profile,
    cwd,
    epoch,
    signature: digest(JSON.stringify({ command, profile, cwd })).slice(0, 24),
  };
}

function safe(candidate) {
  if (!candidate || !SAFE_PROFILES.has(candidate.profile)) return false;
  if (!candidate.command || candidate.command.length > 2_000) return false;
  if (/[\r\n;&|><`]|\$\(/.test(candidate.command)) return false;
  return true;
}

function stateFile(args = {}) {
  const cwd = path.resolve(args.cwd || process.cwd());
  const session = String(args.session_id || "unknown");
  const key = digest(`${cwd}\0${session}`).slice(0, 24);
  return path.join(core.stateRoot(), "toolchain-jit", `${key}.json`);
}

function freshState() {
  return { version: 1, last: null, edges: {} };
}

function trimState(state) {
  const edges = Object.fromEntries(
    Object.entries(state.edges || {})
      .sort((left, right) => Number(right[1].at || 0) - Number(left[1].at || 0))
      .slice(0, 128)
      .map(([key, edge]) => [
        key,
        {
          ...edge,
          candidates: Object.fromEntries(
            Object.entries(edge.candidates || {})
              .sort((left, right) => Number(right[1].count || 0) - Number(left[1].count || 0))
              .slice(0, 4)
          ),
        },
      ])
  );
  return { version: 1, last: state.last || null, edges };
}

function edgeKey(candidate, outcome) {
  return `${candidate.signature}:${outcome}`;
}

function outcome(exitCode) {
  return Number(exitCode) === 0 ? "ok" : "error";
}

function choose(edge) {
  if (!edge || Number(edge.total || 0) < MIN_OBSERVATIONS) return null;
  const ranked = Object.values(edge.candidates || {})
    .sort((left, right) => Number(right.count || 0) - Number(left.count || 0));
  const winner = ranked[0];
  if (!winner || Number(winner.count || 0) < MIN_OBSERVATIONS) return null;
  const confidence = Number(winner.count || 0) / Math.max(1, Number(edge.total || 0));
  if (confidence < MIN_CONFIDENCE || !safe(winner.target)) return null;
  return {
    target: winner.target,
    observations: Number(winner.count || 0),
    total: Number(edge.total || 0),
    confidence: Number(confidence.toFixed(3)),
  };
}

function begin(args = {}) {
  if (process.env.CAPSULE_TOOLCHAIN_JIT === "0") return { enabled: false };
  const current = descriptor(args);
  if (!safe(current)) return { enabled: false };
  const file = stateFile(args);
  const state = readJson(file, freshState());
  const previous = state.last;
  const now = Date.now();
  if (
    safe(previous) &&
    previous.signature !== current.signature &&
    previous.epoch === current.epoch &&
    now - Number(previous.at || 0) <= MAX_AGE_MS
  ) {
    const key = edgeKey(previous, previous.outcome);
    const edge = state.edges[key] || { total: 0, candidates: {}, at: now };
    const candidate = edge.candidates[current.signature] || {
      count: 0,
      target: current,
    };
    candidate.count += 1;
    candidate.target = current;
    edge.candidates[current.signature] = candidate;
    edge.total += 1;
    edge.at = now;
    state.edges[key] = edge;
  }
  state.last = null;
  writeJsonAtomic(file, trimState(state));
  return { enabled: true, file, current };
}

function finish(token, exitCode) {
  if (!token?.enabled) return { prediction: null };
  const state = readJson(token.file, freshState());
  const currentOutcome = outcome(exitCode);
  const prediction = choose(state.edges[edgeKey(token.current, currentOutcome)]);
  state.last = {
    ...token.current,
    outcome: currentOutcome,
    at: Date.now(),
  };
  writeJsonAtomic(token.file, trimState(state));
  return { prediction, outcome: currentOutcome };
}

function predict(args = {}, exitCode = 0) {
  const current = descriptor(args);
  if (!safe(current)) return null;
  const state = readJson(stateFile(args), freshState());
  return choose(state.edges[edgeKey(current, outcome(exitCode))]);
}

function setLast(args = {}, exitCode = 0) {
  const current = descriptor(args);
  if (!safe(current)) return false;
  const file = stateFile(args);
  const state = readJson(file, freshState());
  state.last = {
    ...current,
    outcome: outcome(exitCode),
    at: Date.now(),
  };
  writeJsonAtomic(file, trimState(state));
  return true;
}

module.exports = {
  SAFE_PROFILES,
  begin,
  descriptor,
  finish,
  predict,
  safe,
  setLast,
};
