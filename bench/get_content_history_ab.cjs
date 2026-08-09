"use strict";

// Replay-safe A/B audit for real historical Codex tool calls.  The scanner
// never prints session text: it extracts only command metadata, re-reads files
// that still exist, and reports aggregate character/token deltas.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const sessionRoot = path.resolve(process.env.CAPSULE_SESSION_ROOT || path.join(os.homedir(), ".codex", "sessions"));
const maxBytes = Number.isFinite(Number(process.env.CAPSULE_HISTORY_MAX_BYTES))
  ? Math.max(1, Number(process.env.CAPSULE_HISTORY_MAX_BYTES))
  : 2 * 1024 * 1024 * 1024;
const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-get-content-history-state-"));
const previousState = process.env.CAPSULE_STATE;
process.env.CAPSULE_STATE = state;

const core = require("../mcp/core.cjs");
const unified = require("../mcp/unified.cjs");
const getContent = require("../mcp/get-content.cjs");

const COMMAND_KEYS = new Set([
  "command", "cmd", "shell_command", "shellCommand", "tool_input", "toolInput", "input", "arguments", "args",
]);
const CWD_KEYS = new Set(["cwd", "working_directory", "workingDirectory", "workdir", "directory"]);
const QUERY_KEYS = new Set(["query", "question", "search", "needle"]);

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function percent(before, after) {
  return before > 0 ? Number((((before - after) / before) * 100).toFixed(2)) : 0;
}

function filesUnder(root) {
  const result = [];
  const visit = (directory) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) result.push(target);
    }
  };
  visit(root);
  return result.sort();
}

function firstKey(value, keys, seen = new Set(), depth = 0) {
  if (depth > 8 || value == null || typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) { const found = firstKey(item, keys, seen, depth + 1); if (found) return found; }
    return "";
  }
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key) && typeof item === "string" && item.trim()) return item.trim();
  }
  for (const item of Object.values(value)) {
    const found = firstKey(item, keys, seen, depth + 1);
    if (found) return found;
  }
  return "";
}

function commandCandidate(value) {
  if (typeof value !== "string" || !/\b(?:get-content|gc)\b/i.test(value)) return "";
  const text = value.trim();
  const match = text.match(/\b(?:get-content|gc)\b[\s\S]*/i);
  if (!match) return "";
  const candidate = match[0].trim().replace(/[\r\n]+/g, " ");
  return /^(?:get-content|gc)\b/i.test(candidate) ? candidate : "";
}

function scanValue(value, context, found, seen = new Set(), depth = 0) {
  if (depth > 10 || value == null) return;
  if (typeof value === "string") {
    const candidate = commandCandidate(value);
    if (candidate) found.push({ command: candidate, cwd: context.cwd, query: context.query });
    if (value.trim().startsWith("{") || value.trim().startsWith("[")) {
      try { scanValue(JSON.parse(value), context, found, seen, depth + 1); } catch { /* not a JSON argument */ }
    }
    return;
  }
  if (typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const next = { ...context };
  for (const [key, item] of Object.entries(value)) {
    if (CWD_KEYS.has(key) && typeof item === "string" && item.trim()) next.cwd = item.trim();
    if (QUERY_KEYS.has(key) && typeof item === "string" && item.trim() && item.length <= 1_000) next.query = item.trim();
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && !COMMAND_KEYS.has(key)) continue;
    if (COMMAND_KEYS.has(key) || typeof item === "object") scanValue(item, next, found, seen, depth + 1);
  }
}

async function scanHistory() {
  const result = {
    benchmark: "get-content-history-ab",
    method: "historical safe Get-Content calls; A=generic stdout projector, B=native file evidence/replay",
    session_root: "local Codex session directory (redacted)",
    sessions_scanned: 0,
    session_bytes_scanned: 0,
    session_lines_scanned: 0,
    command_events: 0,
    unique_command_events: 0,
    safe_events: 0,
    replayable_events: 0,
    unsupported_events: 0,
    missing_files: 0,
    unreadable_files: 0,
    exact_recoveries: 0,
    first_events: 0,
    repeat_events: 0,
    passthrough_events: 0,
    fallback_events: 0,
    regressions: 0,
    control_chars: 0,
    treatment_chars: 0,
    control_tokens: 0,
    treatment_tokens: 0,
    raw_chars: 0,
    raw_tokens: 0,
    first_control_chars: 0,
    first_treatment_chars: 0,
    first_control_tokens: 0,
    first_treatment_tokens: 0,
    repeat_control_chars: 0,
    repeat_treatment_chars: 0,
    repeat_control_tokens: 0,
    repeat_treatment_tokens: 0,
    route_counts: {},
    regression_samples: [],
    session_hits: 0,
    notes: [],
  };
  const seenEvents = new Set();
  let scannedBytes = 0;
  const sessionFiles = filesUnder(sessionRoot);
  for (const sessionFile of sessionFiles) {
    if (scannedBytes >= maxBytes) break;
    let stat;
    try { stat = fs.statSync(sessionFile); } catch { continue; }
    const allowed = Math.min(stat.size, maxBytes - scannedBytes);
    if (allowed < stat.size) result.notes.push(`byte limit reached at ${Math.round(maxBytes / 1e6)} MB`);
    result.sessions_scanned += 1;
    result.session_bytes_scanned += allowed;
    scannedBytes += allowed;
    let stream;
    try { stream = fs.createReadStream(sessionFile, { encoding: "utf8", start: 0, end: Math.max(0, allowed - 1) }); } catch { continue; }
    const input = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    let fileHadHit = false;
    for await (const line of input) {
      lineNumber += 1;
      result.session_lines_scanned += 1;
      if (!/get-content/i.test(line)) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const candidates = [];
      scanValue(record, { cwd: firstKey(record, CWD_KEYS), query: firstKey(record, QUERY_KEYS) }, candidates);
      for (const item of candidates) {
        const id = `${sessionFile}:${lineNumber}:${hash(item.command)}`;
        if (seenEvents.has(id)) continue;
        seenEvents.add(id);
        result.command_events += 1;
        fileHadHit = true;
        const plan = getContent.parse(item.command, item.cwd || process.cwd());
        if (!plan) { result.unsupported_events += 1; continue; }
        result.safe_events += 1;
        let statFile;
        let source;
        try {
          statFile = fs.statSync(plan.path);
          if (!statFile.isFile() || statFile.size > 256 * 1024 * 1024) throw new Error("unsupported file");
          source = fs.readFileSync(plan.path);
          if (source.subarray(0, Math.min(source.length, 8192)).includes(0)) throw new Error("binary file");
        } catch (error) {
          if (String(error?.message).includes("binary") || String(error?.message).includes("unsupported")) result.unreadable_files += 1;
          else result.missing_files += 1;
          continue;
        }
        const textValue = source.toString("utf8");
        const common = { command: item.command, cwd: item.cwd || process.cwd(), query: item.query || "", max_chars: 1_200, passthrough_chars: 600 };
        let treatment;
        try { treatment = getContent.fastPath(common); } catch { treatment = null; }
        const envelope = `# stdout\n${textValue}\n# stderr\n`;
        const control = unified.compressText(envelope, common);
        if (!treatment) {
          result.fallback_events += 1;
          result.first_events += 1;
          result.control_chars += control.output.length;
          result.treatment_chars += control.output.length;
          result.control_tokens += core.estimateTokens(control.output);
          result.treatment_tokens += core.estimateTokens(control.output);
          result.first_control_chars += control.output.length;
          result.first_treatment_chars += control.output.length;
          result.first_control_tokens += core.estimateTokens(control.output);
          result.first_treatment_tokens += core.estimateTokens(control.output);
          result.route_counts.fallback = (result.route_counts.fallback || 0) + 1;
          continue;
        }
        result.replayable_events += 1;
        result.raw_chars += textValue.length;
        result.raw_tokens += core.estimateTokens(textValue);
        result.control_chars += control.output.length;
        result.treatment_chars += treatment.output.length;
        result.control_tokens += core.estimateTokens(control.output);
        result.treatment_tokens += core.estimateTokens(treatment.output);
        const route = treatment.operation?.route || "unknown";
        result.route_counts[route] = (result.route_counts[route] || 0) + 1;
        const repeat = route === "file-replay";
        if (repeat) {
          result.repeat_events += 1;
          result.repeat_control_chars += control.output.length;
          result.repeat_treatment_chars += treatment.output.length;
          result.repeat_control_tokens += core.estimateTokens(control.output);
          result.repeat_treatment_tokens += core.estimateTokens(treatment.output);
        } else {
          result.first_events += 1;
          result.first_control_chars += control.output.length;
          result.first_treatment_chars += treatment.output.length;
          result.first_control_tokens += core.estimateTokens(control.output);
          result.first_treatment_tokens += core.estimateTokens(treatment.output);
        }
        if (["passthrough", "lossless"].includes(route)) result.passthrough_events += 1;
        const exact = treatment.capsule_id
          ? core.loadCapsule(treatment.capsule_id).text === textValue
          : ["passthrough", "lossless"].includes(route) && treatment.exactText === textValue;
        if (exact) result.exact_recoveries += 1;
        if (treatment.output.length > control.output.length) {
          result.regressions += 1;
          if (result.regression_samples.length < 12) {
            result.regression_samples.push({
              path_hash: hash(plan.path),
              source_chars: textValue.length,
              control_chars: control.output.length,
              treatment_chars: treatment.output.length,
              route,
              has_query: Boolean(item.query),
            });
          }
        }
      }
    }
    if (fileHadHit) result.session_hits += 1;
  }
  result.unique_command_events = seenEvents.size;
  result.saving_vs_raw_percent = percent(result.raw_chars, result.treatment_chars);
  result.saving_vs_control_percent = percent(result.control_chars, result.treatment_chars);
  result.token_saving_vs_raw_percent = percent(result.raw_tokens, result.treatment_tokens);
  result.token_saving_vs_control_percent = percent(result.control_tokens, result.treatment_tokens);
  result.first = {
    events: result.first_events,
    control_chars: result.first_control_chars,
    treatment_chars: result.first_treatment_chars,
    control_tokens: result.first_control_tokens,
    treatment_tokens: result.first_treatment_tokens,
    saving_vs_control_percent: percent(result.first_control_chars, result.first_treatment_chars),
    token_saving_vs_control_percent: percent(result.first_control_tokens, result.first_treatment_tokens),
  };
  result.repeat = {
    events: result.repeat_events,
    control_chars: result.repeat_control_chars,
    treatment_chars: result.repeat_treatment_chars,
    control_tokens: result.repeat_control_tokens,
    treatment_tokens: result.repeat_treatment_tokens,
    saving_vs_control_percent: percent(result.repeat_control_chars, result.repeat_treatment_chars),
    token_saving_vs_control_percent: percent(result.repeat_control_tokens, result.repeat_treatment_tokens),
  };
  // The global aggregates are exact; first/repeat split is retained as event
  // counts because the generic projector's per-event state is intentionally
  // independent from Capsule's replay cache.
  result.exact_recovery_percent = result.replayable_events
    ? Number(((result.exact_recoveries / result.replayable_events) * 100).toFixed(2)) : 0;
  result.caveat = "Historical replay proxy: it measures model-visible characters and Capsule's tokenizer estimate on files that still exist. It cannot observe provider billing, hidden reasoning, or files changed/deleted since the session.";
  return result;
}

(async () => {
  try {
    const report = await scanHistory();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.regressions > 0) process.exitCode = 2;
  } finally {
    unified.closeSearchDatabase();
    if (previousState == null) delete process.env.CAPSULE_STATE;
    else process.env.CAPSULE_STATE = previousState;
    fs.rmSync(state, { recursive: true, force: true });
  }
})();
