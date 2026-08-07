"use strict";

const fs = require("node:fs");
const path = require("node:path");
const core = require("./core.cjs");
const compat = require("./compat.cjs");
const terminal = require("./terminal-novelty.cjs");
const storage = require("./storage.cjs");

const LIFETIME_MS = 2 * 60 * 60_000;
const MAX_ENTRIES = 24;
const MAX_TEXT_CHARS = 2_000_000;

function stateFile(sessionId) {
  if (!sessionId) return "";
  const root = path.join(core.stateRoot(), "reasoning-residual");
  fs.mkdirSync(root, { recursive: true });
  const digest = storage.sha256(sessionId).slice(0, 24);
  return path.join(root, `${digest}.json`);
}

function writeState(file, state) {
  return storage.writeJsonAtomic(file, state);
}

function identity(cwd, command) {
  const resolved = path.resolve(String(cwd || process.cwd()));
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return storage.sha256(`${normalized}\0${terminal.canonicalCommand(command)}`).slice(0, 24);
}

function normalizeDiagnostic(line) {
  return terminal.normalizeLine(line)
    .replace(/\b(?:line\s+)?\d+:\d+\b/gi, "<position>")
    .replace(/\((?:[^()\r\n]{0,160}):\d+:\d+\)/g, "(<position>)")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function diagnosticLines(text) {
  const clean = compat.redact(String(text || "")).replace(/\r\n/g, "\n");
  const lines = clean.split("\n")
    .map((line) => normalizeDiagnostic(line))
    .filter(Boolean);
  const signal = lines.filter((line) =>
    /\b(?:error|fail(?:ed|ure)?|exception|panic|fatal|assert(?:ion)?|expected|actual|received|mismatch|undefined|traceback|cannot|could not|not found|denied)\b/i.test(line) ||
    /(?:^|\s)(?:✗|×|x)\s/i.test(line)
  );
  return [...new Set(signal.length ? signal : lines.slice(-24))].slice(0, 48);
}

function diagnostic(text) {
  const lines = diagnosticLines(text);
  const joined = lines.join("\n");
  const signature = storage.sha256(joined).slice(0, 12);
  const headline = (lines.find((line) =>
    /\b(?:error|fail(?:ed|ure)?|exception|panic|fatal|assert(?:ion)?|expected|actual|received)\b/i.test(line)
  ) || lines[0] || "non-zero validation result").slice(0, 180);
  return { signature, headline, lines: lines.slice(0, 8) };
}

function compactState(state, now) {
  return Object.fromEntries(
    Object.entries(state?.entries || {})
      .filter(([, item]) => now - Number(item.at || 0) <= LIFETIME_MS)
      .sort((left, right) => Number(right[1].at || 0) - Number(left[1].at || 0))
      .slice(0, MAX_ENTRIES)
  );
}

function reasoningResidual(args = {}) {
  if (process.env.CAPSULE_REASONING_RESIDUAL === "0") return null;
  const sessionId = String(args.session_id || "");
  const profile = terminal.commandProfile(args.command);
  const capsuleId = String(args.capsule_id || "");
  const text = String(args.text || "");
  const file = stateFile(sessionId);
  if (!file || !capsuleId || !["test", "lint", "typecheck", "build", "format-check"].includes(profile) ||
      text.length > MAX_TEXT_CHARS) return null;

  const now = Date.now();
  let state = { entries: {} };
  state = storage.readJson(file, { entries: {} });
  const entries = compactState(state, now);
  const key = identity(args.cwd, args.command);
  const prior = entries[key];
  const epoch = Math.max(0, Number(args.execution_epoch || 0));
  const failed = Number(args.exit_code || 0) !== 0;

  if (failed) {
    const current = diagnostic(text);
    const attempts = prior ? Number(prior.attempts || 0) + 1 : 1;
    entries[key] = {
      profile,
      command: terminal.canonicalCommand(args.command).slice(0, 180),
      failed: true,
      signature: current.signature,
      headline: current.headline,
      capsule_id: capsuleId,
      epoch,
      attempts,
      at: now,
    };
    writeState(file, { entries });
    if (!prior?.failed) return null;

    const mutation = epoch > Number(prior.epoch || 0);
    const unchanged = prior.signature === current.signature;
    const epochTransition = `${Number(prior.epoch || 0)}→${epoch}`;
    const output = unchanged
      ? `[Capsule fixpoint ${profile}; e${epochTransition}; same=${current.signature}; attempts=${attempts}; ` +
        `${mutation ? "last-edit-missed-failing-path" : "no-new-evidence"}; do-not-rediagnose; exact=${capsuleId}]\n` +
        current.headline
      : `[Capsule residual ${profile}; e${epochTransition}; ${prior.signature}→${current.signature}; attempts=${attempts}; ` +
        `${mutation ? "continue-new-fault" : "environment-changed"}; exact=${capsuleId}]\n${current.headline}`;
    const baseline = String(args.baseline_output || text);
    if (output.length + 20 >= baseline.length) return null;
    return {
      output,
      profile,
      status: unchanged ? "persistent-failure" : "changed-failure",
      attempts,
      signature: current.signature,
      emitted_chars: output.length,
      raw_chars: text.length,
    };
  }

  if (!prior?.failed) {
    entries[key] = {
      profile,
      command: terminal.canonicalCommand(args.command).slice(0, 180),
      failed: false,
      capsule_id: capsuleId,
      epoch,
      attempts: 1,
      at: now,
    };
    writeState(file, { entries });
    return null;
  }

  const attempts = Number(prior.attempts || 0) + 1;
  entries[key] = {
    profile,
    command: terminal.canonicalCommand(args.command).slice(0, 180),
    failed: false,
    resolved_signature: prior.signature,
    capsule_id: capsuleId,
    epoch,
    attempts,
    at: now,
  };
  writeState(file, { entries });
  const output = `[Capsule resolved ${profile}; fault=${prior.signature}; e${epoch}; attempts=${attempts}; ` +
    `stop=verified; exact=${capsuleId}]`;
  const baseline = String(args.baseline_output || text);
  if (output.length + 20 >= baseline.length) return null;
  return {
    output,
    profile,
    status: "resolved",
    attempts,
    signature: prior.signature,
    emitted_chars: output.length,
    raw_chars: text.length,
  };
}

function checkpoint(sessionId) {
  const file = stateFile(String(sessionId || ""));
  if (!file) return "";
  let state;
  state = storage.readJson(file, null);
  if (!state || typeof state !== "object") return "";
  const latest = Object.values(compactState(state, Date.now()))
    .sort((left, right) => Number(right.at || 0) - Number(left.at || 0))[0];
  if (!latest) return "";
  if (latest.failed) {
    return `validation=${latest.profile}:fail(${latest.signature}); epoch=${Number(latest.epoch || 0)}; ` +
      `attempts=${Number(latest.attempts || 1)}; next=change hypothesis/path,not restart; exact=${latest.capsule_id}`;
  }
  if (latest.resolved_signature) {
    return `validation=${latest.profile}:pass; resolved=${latest.resolved_signature}; ` +
      `epoch=${Number(latest.epoch || 0)}; stop=verified; exact=${latest.capsule_id}`;
  }
  return `validation=${latest.profile}:pass; epoch=${Number(latest.epoch || 0)}; exact=${latest.capsule_id}`;
}

module.exports = {
  checkpoint,
  diagnostic,
  diagnosticLines,
  normalizeDiagnostic,
  reasoningResidual,
};
