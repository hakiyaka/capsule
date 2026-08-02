"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CAPSULE_RE = /\bcap_[a-f0-9]{16}\b/ig;
const SECRET_RE = /\b(api[_-]?key|authorization|cookie|credential|password|passwd|private[_-]?key|secret|token)\s*[:=]\s*[^\s,;]+|\bbearer\s+[a-z0-9._~-]+/ig;

function digest(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function clean(value, limit = 420) {
  const text = String(value || "")
    .replace(/<app-context\b[^>]*>[\s\S]*?<\/app-context>/gi, " ")
    .replace(/<environment_context\b[^>]*>[\s\S]*?<\/environment_context>/gi, " ")
    .replace(SECRET_RE, (match) => `${match.split(/[:=\s]/, 1)[0]}=[REDACTED]`)
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 17)).trim()} …[truncated]`;
}

function read(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function unique(values, limit) {
  return [...new Set((values || []).map((value) => clean(value, 240)).filter(Boolean))].slice(-limit);
}

function capsuleIds(values) {
  return unique(
    (values || []).flatMap((value) => String(value || "").match(CAPSULE_RE) || []),
    16
  ).map((value) => value.toLowerCase());
}

function update(args = {}) {
  const requestedFile = String(args.file || "").trim();
  if (!requestedFile) return { available: false, state: {} };
  const file = path.resolve(requestedFile);
  const previous = read(file);
  const boundary = Boolean(
    args.task_hash && previous.task_hash && args.task_hash !== previous.task_hash
  );
  const base = boundary ? {} : previous;
  const decisions = unique(
    [...(base.decisions || []), ...(args.decisions || [])],
    4
  );
  const open = unique(
    [...(base.open || []), ...(args.open || [])],
    4
  );
  const next = {
    version: 1,
    epoch: Number(args.epoch ?? base.epoch ?? 0),
    task_hash: String(args.task_hash || base.task_hash || "").slice(0, 96),
    project_hash: String(args.project_hash || base.project_hash || "").slice(0, 96),
    decisions,
    open,
    progress: clean(args.progress || base.progress, 360),
    files: unique([...(base.files || []), ...(args.files || [])], 8),
    tests: unique([...(base.tests || []), ...(args.tests || [])], 4),
    capsules: capsuleIds([...(base.capsules || []), ...(args.capsules || [])]),
    probe_required: args.probe_required ?? Boolean(base.probe_required),
    probe_emitted: args.probe_emitted ?? Boolean(base.probe_emitted),
    updated_at: Date.now(),
  };
  write(file, next);
  return { available: true, state: next };
}

function arm(file) {
  const state = read(file);
  return update({
    file,
    ...state,
    probe_required: true,
    probe_emitted: false,
  });
}

function emitProbe(args = {}) {
  if (!args.is_mutation) return "";
  const state = read(args.file);
  if (!state.probe_required || state.probe_emitted) return "";
  update({ file: args.file, ...state, probe_emitted: true });
  return context({ file: args.file, max_chars: args.max_chars || 760, probe: true });
}

function clearProbe(file) {
  const state = read(file);
  if (!state.probe_required && !state.probe_emitted) return state;
  return update({ file, ...state, probe_required: false, probe_emitted: false });
}

function context(args = {}) {
  const state = read(args.file);
  if (!state.updated_at) return "";
  const maxChars = Math.min(1_200, Math.max(260, Number(args.max_chars || 900)));
  const lines = [
    `[Capsule memory ledger v1; epoch=${Number(state.epoch || 0)}; ` +
      `probe=${state.probe_required ? "required" : "clear"}]`,
    state.task_hash ? `G: task=${state.task_hash}` : "",
    state.decisions?.length ? `D: ${state.decisions.slice(-2).join(" | ")}` : "",
    state.open?.length ? `O: ${state.open.slice(-2).join(" | ")}` : "",
    state.progress ? `P: ${state.progress}` : "",
    state.files?.length ? `F: ${state.files.join(", ")}` : "",
    state.tests?.length ? `V: ${state.tests.join(", ")}` : "",
    state.capsules?.length ? `X: ${state.capsules.join(", ")}` : "",
    args.probe
      ? "[Capsule probe: preserve D/O/F/V; expand X on conflict before editing; do not reread full history.]"
      : "[Capsule ledger: treat D/O/F/V as current; expand X only for exact evidence.]",
  ].filter(Boolean).join("\n");
  return lines.slice(0, maxChars);
}

module.exports = { capsuleIds, clearProbe, context, emitProbe, update, arm };
