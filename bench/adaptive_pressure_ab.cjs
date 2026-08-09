"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-adaptive-pressure-ab-"));
process.env.CAPSULE_STATE = state;

const currentVersion = require("../package.json").version;
const currentHook = require("../scripts/hook.cjs");
const currentCompaction = require("../mcp/compaction.cjs");
const currentUnified = require("../mcp/unified.cjs");

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function versionTuple(value) {
  return String(value).split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(left, right) {
  const a = versionTuple(left);
  const b = versionTuple(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return String(left).localeCompare(String(right));
}

function baselineRoot() {
  const explicit = argument("--baseline");
  if (explicit) return path.resolve(explicit);
  const root = path.join(os.homedir(), ".codex", "plugins", "cache", "personal", "capsule");
  const candidates = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(root, name, "scripts", "hook.cjs")))
    .sort(compareVersions);
  if (!candidates.length) throw new Error("No installed Capsule baseline found.");
  const older = candidates.filter((name) => compareVersions(name, currentVersion) < 0);
  return path.join(root, (older.length ? older : candidates).at(-1));
}

function recentSessions(limit) {
  const explicit = argument("--session");
  if (explicit) return [path.resolve(explicit)];
  const root = argument("--sessions-root", path.join(os.homedir(), ".codex", "sessions"));
  const files = [];
  const pending = [root];
  while (pending.length) {
    const folder = pending.pop();
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push({ file: target, mtime: fs.statSync(target).mtimeMs });
      }
    }
  }
  return files.sort((left, right) => right.mtime - left.mtime)
    .slice(0, limit)
    .map((item) => item.file);
}

function textOutput(payload) {
  const value = payload?.output ?? payload?.result ?? payload?.content;
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function samples(file, limit) {
  const candidates = [];
  const calls = new Map();
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type === "response_item" &&
        /^(?:function_call|custom_tool_call)$/.test(String(record.payload?.type || ""))) {
      calls.set(record.payload.call_id, [record.payload.namespace, record.payload.name].filter(Boolean).join("."));
      continue;
    }
    if (record?.type !== "response_item" ||
        !/^(?:function_call_output|custom_tool_call_output)$/.test(String(record.payload?.type || ""))) {
      continue;
    }
    const output = textOutput(record.payload);
    if (output.length < 900 || output.length > 600_000 || /data:(?:image|audio|video)\//i.test(output)) continue;
    candidates.push({
      output,
      name: calls.get(record.payload.call_id) || "workspace.read_output",
    });
  }
  const ordered = candidates.sort((left, right) => right.output.length - left.output.length);
  const mediumLimit = Math.max(1, Math.floor(limit / 2));
  const medium = ordered.filter((item) => item.output.length < 5_000).slice(0, mediumLimit);
  const large = ordered.filter((item) => item.output.length >= 5_000).slice(0, limit - medium.length);
  return [...medium, ...large].slice(0, limit);
}

function visible(result, raw) {
  const hook = result?.hookSpecificOutput || {};
  const primary = hook.updatedMCPToolOutput == null ? raw : String(hook.updatedMCPToolOutput);
  return {
    chars: primary.length + String(hook.additionalContext || "").length,
    primary,
  };
}

function saving(before, after) {
  return before > 0 ? Number(((before - after) / before * 100).toFixed(2)) : 0;
}

function runArm(hook, sample, sessionFile, sessionId) {
  const input = {
    tool_name: sample.name,
    tool_input: { source: "recent-session-replay" },
    tool_output: sample.output,
    session_file: sessionFile,
    session_id: sessionId,
    cwd: path.resolve(__dirname, ".."),
  };
  return visible(hook.handle("posttooluse", input), sample.output);
}

function summarize(rows) {
  const before = rows.reduce((sum, row) => sum + row.baseline_chars, 0);
  const after = rows.reduce((sum, row) => sum + row.treatment_chars, 0);
  return {
    samples: rows.length,
    baseline_chars: before,
    treatment_chars: after,
    avoided_chars: before - after,
    avoided_approx_text_tokens: Math.max(0, Math.ceil((before - after) / 4)),
    saving_percent: saving(before, after),
    exact_recovery_pass: rows.every((row) => row.exact_recovery),
  };
}

const baseRoot = baselineRoot();
const baselineHook = require(path.join(baseRoot, "scripts", "hook.cjs"));
const baselineUnified = require(path.join(baseRoot, "mcp", "unified.cjs"));
const files = recentSessions(Math.max(1, Number(argument("--limit", "12")) || 12));
const rows = [];
for (const [fileIndex, file] of files.entries()) {
  const pressure = currentCompaction.contextPressure({ session_file: file }).response;
  for (const [sampleIndex, sample] of samples(file, 4).entries()) {
    const baseline = runArm(baselineHook, sample, file, `ab-a-${fileIndex}-${sampleIndex}`);
    const treatment = runArm(currentHook, sample, file, `ab-b-${fileIndex}-${sampleIndex}`);
    const changed = treatment.primary !== sample.output;
    rows.push({
      sample: sampleIndex + 1,
      mode: pressure.mode,
      used_percent: pressure.used_percent,
      tool: sample.name,
      raw_chars: sample.output.length,
      baseline_chars: baseline.chars,
      treatment_chars: treatment.chars,
      saved_percent: saving(baseline.chars, treatment.chars),
      exact_recovery: !changed ||
        /(?:\[exact capsule:\s*|exact=)cap_[a-f0-9]{16}/i.test(treatment.primary),
    });
  }
}

const byMode = {};
for (const mode of ["normal", "high", "critical", "emergency"]) {
  const selected = rows.filter((row) => row.mode === mode);
  if (selected.length) byMode[mode] = summarize(selected);
}
const result = {
  method: {
    dataset: "Bounded non-media tool-output fixtures; local session identifiers are omitted.",
    arm_a: "Installed Capsule baseline.",
    arm_b: "Candidate adaptive context-pressure policies.",
    accounting: "Model-visible serialized characters after PostToolUse, including hook guidance.",
    privacy: "The report stores only bounded sample metadata, sizes, modes, and booleans; tool content and session identifiers are not copied.",
    caveat: "Approximate text tokens use four characters per token. This excludes image tokens, caching, hidden model work, billing, and outputs outside this bounded fixture set.",
  },
  summary: summarize(rows),
  by_mode: byMode,
  rows,
};

try {
  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  const write = argument("--write");
  if (write) fs.writeFileSync(path.resolve(write), rendered, "utf8");
  process.stdout.write(process.argv.includes("--summary")
    ? `${JSON.stringify({ summary: result.summary, by_mode: result.by_mode }, null, 2)}\n`
    : rendered);
  if (!rows.length || !result.summary.exact_recovery_pass) process.exitCode = 1;
} finally {
  currentUnified.closeSearchDatabase();
  baselineUnified.closeSearchDatabase();
  fs.rmSync(state, { recursive: true, force: true });
}
