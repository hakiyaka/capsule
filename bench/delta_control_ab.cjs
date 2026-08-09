"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-delta-control-ab-"));
process.env.CAPSULE_STATE = state;
process.env.CAPSULE_RECALL_LIMIT = "0";
process.env.CAPSULE_REASONING_GOVERNOR = "0";

const currentHook = require("../scripts/hook.cjs");
const currentCore = require("../mcp/core.cjs");
const currentUnified = require("../mcp/unified.cjs");
const currentVersion = require("../package.json").version;

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
    .filter((name) => compareVersions(name, currentVersion) < 0)
    .sort(compareVersions);
  if (!candidates.length) throw new Error("No older installed Capsule baseline found.");
  return path.join(root, candidates.at(-1));
}

function recentSessions(limit) {
  const root = argument("--sessions-root", path.join(os.homedir(), ".codex", "sessions"));
  const files = [];
  const pending = [root];
  while (pending.length) {
    const folder = pending.pop();
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const stat = fs.statSync(target);
        if (stat.size <= 128 * 1024 * 1024) files.push({ file: target, mtime: stat.mtimeMs });
      }
    }
  }
  return files.sort((left, right) => right.mtime - left.mtime)
    .slice(0, limit)
    .map((item) => item.file);
}

function parsedInput(payload) {
  const value = payload?.arguments ?? payload?.input ?? {};
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || "{}"));
  } catch {
    return {};
  }
}

function textOutput(payload) {
  const value = payload?.output ?? payload?.result ?? payload?.content;
  if (typeof value === "string") return value;
  try {
    return value == null ? "" : JSON.stringify(value);
  } catch {
    return "";
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function collect(files, limit) {
  const samples = [];
  const groups = new Map();
  for (const file of files) {
    const calls = new Map();
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = record?.payload || {};
      if (record?.type === "response_item" &&
          /^(?:function_call|custom_tool_call)$/.test(String(payload.type || ""))) {
        calls.set(payload.call_id, {
          name: [payload.namespace, payload.name].filter(Boolean).join(".") || "workspace.read_output",
          input: parsedInput(payload),
        });
        continue;
      }
      if (record?.type !== "response_item" ||
          !/^(?:function_call_output|custom_tool_call_output)$/.test(String(payload.type || ""))) {
        continue;
      }
      const call = calls.get(payload.call_id);
      const output = textOutput(payload);
      if (!call || output.length < 3_000 || output.length > 500_000 ||
          /data:(?:image|audio|video)\//i.test(output)) {
        continue;
      }
      const sample = {
        session: path.basename(file),
        name: call.name,
        input: call.input,
        output,
      };
      samples.push(sample);
      const key = `${call.name}\0${JSON.stringify(stable(call.input))}`;
      const prior = groups.get(key);
      if (prior && prior.output !== output) {
        groups.set(key, sample);
        sample.before = prior.output;
      } else if (!prior) {
        groups.set(key, sample);
      }
    }
  }
  return {
    singles: samples.sort((left, right) => right.output.length - left.output.length).slice(0, limit),
    pairs: samples.filter((sample) => sample.before)
      .sort((left, right) => right.output.length - left.output.length)
      .slice(0, limit),
  };
}

function visible(result, raw) {
  const hook = result?.hookSpecificOutput || {};
  const primary = hook.updatedMCPToolOutput == null ? raw : String(hook.updatedMCPToolOutput);
  return {
    chars: primary.length + String(hook.additionalContext || "").length,
    primary,
  };
}

function invoke(hook, sample, session, output) {
  const input = {
    tool_name: sample.name,
    tool_input: sample.input,
    tool_output: output,
    cwd: path.resolve(__dirname, ".."),
    session_id: session,
  };
  return visible(hook.handle("posttooluse", input), output);
}

function saving(before, after) {
  return before > 0 ? Number(((before - after) / before * 100).toFixed(2)) : 0;
}

function lineOverlap(before, after) {
  const normalize = (value) => String(value || "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>")
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<time>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|msec|milliseconds?|s|sec|seconds?)\b/gi, "<duration>")
    .replace(/[ \t]+$/g, "");
  const left = before.replace(/\r\n/g, "\n").split("\n").map(normalize);
  const right = after.replace(/\r\n/g, "\n").split("\n").map(normalize);
  const counts = new Map();
  for (const line of left) counts.set(line, Number(counts.get(line) || 0) + 1);
  let intersection = 0;
  for (const line of right) {
    const count = Number(counts.get(line) || 0);
    if (count > 0) {
      intersection += 1;
      counts.set(line, count - 1);
    }
  }
  return Number(((2 * intersection) / Math.max(1, left.length + right.length)).toFixed(4));
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
  };
}

function exactRecovery(primary, raw) {
  if (primary === raw) return true;
  const capsuleId = primary.match(/exact=(cap_[a-f0-9]{16})/i)?.[1];
  if (!capsuleId) return false;
  try {
    return currentCore.loadCapsule(capsuleId).text === raw;
  } catch {
    return false;
  }
}

const baseRoot = baselineRoot();
const baselineHook = require(path.join(baseRoot, "scripts", "hook.cjs"));
const baselineUnified = require(path.join(baseRoot, "mcp", "unified.cjs"));
const files = recentSessions(Math.max(1, Number(argument("--sessions", "40")) || 40));
const dataset = collect(files, Math.max(1, Number(argument("--limit", "30")) || 30));

const exactRows = dataset.singles.map((sample, index) => {
  invoke(baselineHook, sample, `exact-a-${index}`, sample.output);
  invoke(currentHook, sample, `exact-b-${index}`, sample.output);
  const baseline = invoke(baselineHook, sample, `exact-a-${index}`, sample.output);
  const treatment = invoke(currentHook, sample, `exact-b-${index}`, sample.output);
  return {
    raw_chars: sample.output.length,
    baseline_chars: baseline.chars,
    treatment_chars: treatment.chars,
    saved_percent: saving(baseline.chars, treatment.chars),
    exact_recovery: exactRecovery(treatment.primary, sample.output),
  };
});

const deltaRows = dataset.pairs.map((sample, index) => {
  invoke(baselineHook, sample, `delta-a-${index}`, sample.before);
  invoke(currentHook, sample, `delta-b-${index}`, sample.before);
  const baseline = invoke(baselineHook, sample, `delta-a-${index}`, sample.output);
  const treatment = invoke(currentHook, sample, `delta-b-${index}`, sample.output);
  return {
    tool: sample.name,
    raw_chars: sample.output.length,
    line_overlap: lineOverlap(sample.before, sample.output),
    baseline_chars: baseline.chars,
    treatment_chars: treatment.chars,
    saved_percent: saving(baseline.chars, treatment.chars),
    delta_applied: /^\[Capsule delta overlap=/i.test(treatment.primary),
    exact_recovery: exactRecovery(treatment.primary, sample.output),
  };
});

const result = {
  method: {
    dataset: "Non-media tool outputs from the most recently modified local Codex sessions.",
    arm_a: "Installed Capsule baseline.",
    arm_b: "Working-tree Capsule with silent control tags, near-duplicate delta replay, and adaptive reasoning thresholds.",
    exact_replay: "Each real output is replayed byte-identically; accounting includes replacement plus hook-added context.",
    delta_replay: "Actual changed outputs are paired only when the tool name and serialized input are identical.",
    privacy: "The report stores only bounded sample metadata, tool names, sizes, booleans, and aggregates; content and session identifiers are not copied.",
    caveat: "Characters are a model-visible text proxy, not billing. Reasoning thresholds are policy activation points, not a claimed model-token reduction.",
  },
  exact_replay_control_plane: {
    ...summarize(exactRows),
    exact_recovery_pass: exactRows.every((row) => row.exact_recovery),
    rows: exactRows,
  },
  changed_output_delta: {
    ...summarize(deltaRows),
    delta_applied: deltaRows.filter((row) => row.delta_applied).length,
    applied_only: summarize(deltaRows.filter((row) => row.delta_applied)),
    exact_recovery_pass: deltaRows.every((row) => row.exact_recovery),
    rows: deltaRows,
  },
  adaptive_reasoning_thresholds: {
    normal: { warning: 512, brake: 1_536 },
    high: { warning: 384, brake: 1_024 },
    critical: { warning: 256, brake: 640 },
    emergency: { warning: 128, brake: 384 },
  },
};

try {
  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  const write = argument("--write");
  if (write) fs.writeFileSync(path.resolve(write), rendered, "utf8");
  process.stdout.write(process.argv.includes("--summary")
    ? `${JSON.stringify({
      exact_replay_control_plane: { ...result.exact_replay_control_plane, rows: undefined },
      changed_output_delta: { ...result.changed_output_delta, rows: undefined },
      adaptive_reasoning_thresholds: result.adaptive_reasoning_thresholds,
    }, null, 2)}\n`
    : rendered);
  if (!exactRows.length || !result.exact_replay_control_plane.exact_recovery_pass ||
      !result.changed_output_delta.exact_recovery_pass) {
    process.exitCode = 1;
  }
} finally {
  currentUnified.closeSearchDatabase();
  baselineUnified.closeSearchDatabase();
  fs.rmSync(state, { recursive: true, force: true });
}
