"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-loop-runway-ab-"));
process.env.CAPSULE_STATE = state;
process.env.CAPSULE_RECALL_LIMIT = "0";
process.env.CAPSULE_REASONING_GOVERNOR = "0";

const currentHook = require("../scripts/hook.cjs");
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

function findBaselineRoot() {
  const explicit = argument("--baseline");
  if (explicit) return path.resolve(explicit);
  const root = path.join(os.homedir(), ".codex", "plugins", "cache", "personal", "capsule");
  const candidates = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(root, name, "scripts", "hook.cjs")))
    .sort(compareVersions);
  const older = candidates.filter((name) => compareVersions(name, currentVersion) < 0);
  if (!older.length) throw new Error("No older installed Capsule baseline found; pass --baseline.");
  return path.join(root, older.at(-1));
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
        files.push({ file: target, mtime: fs.statSync(target).mtimeMs });
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

function boundedTail(file, maxBytes = 32 * 1024 * 1024) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const read = fs.readSync(descriptor, buffer, offset, length - offset, start + offset);
      if (!read) break;
      offset += read;
    }
    let text = buffer.subarray(0, offset).toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline >= 0 ? text.slice(newline + 1) : "";
    }
    return text;
  } finally {
    fs.closeSync(descriptor);
  }
}

function collect(files) {
  const waits = [];
  const reads = [];
  for (const file of files) {
    const calls = new Map();
    for (const line of boundedTail(file).split(/\r?\n/)) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = record?.payload || {};
      if (record?.type === "response_item" &&
          /^(?:function_call|custom_tool_call)$/.test(String(payload.type || ""))) {
        const name = [payload.namespace, payload.name].filter(Boolean).join(".");
        const input = parsedInput(payload);
        calls.set(payload.call_id, { name, input });
        if (/(?:^|[._-])(?:wait|wait_agent)(?:$|[._-])/i.test(name) &&
            (Object.hasOwn(input, "yield_time_ms") || Object.hasOwn(input, "timeout_ms"))) {
          waits.push({ name, input });
        }
        continue;
      }
      if (record?.type !== "response_item" ||
          !/^(?:function_call_output|custom_tool_call_output)$/.test(String(payload.type || ""))) {
        continue;
      }
      const call = calls.get(payload.call_id);
      const output = textOutput(payload);
      if (!call || output.length < 3_000 || output.length >= 5_000) continue;
      if (!/(?:read|view|list|search|find|get|open)/i.test(call.name) ||
          /(?:write|edit|delete|remove|create|update|apply|execute|shell|command)/i.test(call.name)) {
        continue;
      }
      if (/data:(?:image|audio|video)\//i.test(output)) continue;
      reads.push({ name: call.name, input: call.input, output });
    }
  }
  return { waits: waits.slice(0, 100), reads: reads.slice(0, 20) };
}

function visible(result, raw) {
  const hook = result?.hookSpecificOutput || {};
  const primary = hook.updatedMCPToolOutput == null ? raw : String(hook.updatedMCPToolOutput);
  return {
    chars: primary.length + String(hook.additionalContext || "").length,
    primary,
  };
}

function replayArm(hook, sample, arm, index) {
  const session = `loop-runway-${arm}-${index}`;
  const input = {
    tool_name: sample.name,
    tool_input: sample.input,
    tool_output: sample.output,
    cwd: path.resolve(__dirname, ".."),
    session_id: session,
  };
  hook.handle("posttooluse", input);
  const compact = hook.handle("precompact", {
    summary: "Compact the task.",
    cwd: input.cwd,
    session_id: session,
  });
  const repeated = visible(hook.handle("posttooluse", input), sample.output);
  return {
    chars: repeated.chars + String(compact?.hookSpecificOutput?.additionalContext || "").length,
    primary: repeated.primary,
  };
}

function saving(before, after) {
  return before > 0 ? Number(((before - after) / before * 100).toFixed(2)) : 0;
}

const baselineRoot = findBaselineRoot();
const baselineHook = require(path.join(baselineRoot, "scripts", "hook.cjs"));
const baselineUnified = require(path.join(baselineRoot, "mcp", "unified.cjs"));
const files = recentSessions(Math.max(1, Number(argument("--limit", "12")) || 12));
const dataset = collect(files);

const replayRows = dataset.reads.map((sample, index) => {
  const baseline = replayArm(baselineHook, sample, "a", index);
  const treatment = replayArm(currentHook, sample, "b", index);
  return {
    raw_chars: sample.output.length,
    baseline_chars: baseline.chars,
    treatment_chars: treatment.chars,
    saved_percent: saving(baseline.chars, treatment.chars),
    exact_recovery: /exact=cap_[a-f0-9]{16}/i.test(treatment.primary),
  };
});
const replayBefore = replayRows.reduce((sum, row) => sum + row.baseline_chars, 0);
const replayAfter = replayRows.reduce((sum, row) => sum + row.treatment_chars, 0);

const waitRows = dataset.waits.map((sample, index) => {
  const before = Number(sample.input.yield_time_ms || sample.input.timeout_ms || 0);
  const result = currentHook.handle("pretooluse", {
    tool_name: sample.name,
    tool_input: sample.input,
    cwd: path.resolve(__dirname, ".."),
    session_id: `poll-ab-${index}`,
  });
  const updated = result?.hookSpecificOutput?.updatedInput || sample.input;
  const after = Number(updated.yield_time_ms || updated.timeout_ms || before);
  return { before_ms: before, after_ms: after };
});
const beforeCadence = waitRows.reduce((sum, row) => sum + (row.before_ms ? 1 / row.before_ms : 0), 0);
const afterCadence = waitRows.reduce((sum, row) => sum + (row.after_ms ? 1 / row.after_ms : 0), 0);

const result = {
  method: {
    dataset: "Bounded 3,000-4,999-character non-media read fixtures; local session identifiers are omitted.",
    replay_accounting: "Model-visible characters on an exact reread after compaction; treatment includes its PreCompact capsule dictionary.",
    poll_accounting: "Counterfactual polling cadence from the recorded timeout/yield values after applying the 60-second floor.",
    privacy: "No prompt or tool content is copied into the report.",
    caveat: "Replay characters are an input-context proxy. Poll cadence is not a billing or token claim; event-driven wakeups can return before the timeout.",
  },
  compaction_replay: {
    samples: replayRows.length,
    baseline_chars: replayBefore,
    treatment_chars: replayAfter,
    avoided_chars: replayBefore - replayAfter,
    avoided_approx_text_tokens: Math.max(0, Math.ceil((replayBefore - replayAfter) / 4)),
    saving_percent: saving(replayBefore, replayAfter),
    exact_recovery_pass: replayRows.every((row) => row.exact_recovery),
    rows: replayRows,
  },
  poll_cadence: {
    samples: waitRows.length,
    waits_tightened: waitRows.filter((row) => row.after_ms > row.before_ms).length,
    minimum_after_ms: waitRows.length ? Math.min(...waitRows.map((row) => row.after_ms)) : 0,
    modeled_poll_rate_reduction_percent: saving(beforeCadence, afterCadence),
  },
};

try {
  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  const write = argument("--write");
  if (write) fs.writeFileSync(path.resolve(write), rendered, "utf8");
  process.stdout.write(process.argv.includes("--summary")
    ? `${JSON.stringify({
      compaction_replay: { ...result.compaction_replay, rows: undefined },
      poll_cadence: result.poll_cadence,
    }, null, 2)}\n`
    : rendered);
  if (!replayRows.length || !result.compaction_replay.exact_recovery_pass) process.exitCode = 1;
} finally {
  currentUnified.closeSearchDatabase();
  baselineUnified.closeSearchDatabase();
  fs.rmSync(state, { recursive: true, force: true });
}
