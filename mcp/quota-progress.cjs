"use strict";

const fs = require("node:fs");
const path = require("node:path");
const core = require("./core.cjs");
const storage = require("./storage.cjs");

const VERSION = 1;
const TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_TURNS = 32;
const MAX_TOMBSTONES = 24;
const MAX_FINGERPRINTS = 64;
const MAX_TOOLS = 48;
const MAX_STATE_FILES = 128;
const EXPENSIVE_CREDITS = 800;
const EXPENSIVE_REASONING = 500;
const LOW_PROGRESS = 0.2;
const NEAR_REPEAT = 0.75;
const COMPONENT_ORDER = ["reasoning", "input", "output", "tools", "compaction", "other"];

function enabled() {
  return process.env.CAPSULE_QUOTA_PROGRESS !== "0";
}

function digest(value) {
  return storage.sha256(value);
}

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nonnegative(value) {
  return Math.max(0, finite(value));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, finite(value)));
}

function sessionKey(sessionId) {
  const value = String(sessionId || "").trim();
  return value && value !== "unknown" ? digest("session\0" + value).slice(0, 24) : "";
}

function stateDirectory(create = false) {
  const directory = path.join(core.stateRoot(), "quota-progress");
  if (create) fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function stateFile(sessionId, create = false) {
  const key = sessionKey(sessionId);
  if (!key) return "";
  return path.join(stateDirectory(create), key + ".json");
}

function emptyState() {
  return {
    version: VERSION,
    active: null,
    turns: [],
    tombstones: [],
    policy_counts: { brake: 0, anti_memory: 0 },
    updated_at: 0,
  };
}

function readState(file) {
  if (!file) return emptyState();
  const parsed = storage.readJson(file, null);
  return parsed && typeof parsed === "object" ? parsed : emptyState();
}

function atomicWrite(file, state) {
  storage.writeJsonAtomic(file, state);
  pruneStateFiles(file);
}

function pruneStateFiles(keepFile, now = Date.now()) {
  const directory = path.dirname(keepFile);
  let entries;
  try {
    entries = fs.readdirSync(directory)
      .filter((name) => /^[a-f0-9]{24}\.json$/.test(name))
      .map((name) => {
        const file = path.join(directory, name);
        return { file, modified: fs.statSync(file).mtimeMs };
      })
      .sort((left, right) => right.modified - left.modified);
  } catch {
    return;
  }
  const removals = entries.filter((entry, index) =>
    entry.file !== keepFile && (now - entry.modified > TTL_MS || index >= MAX_STATE_FILES)
  );
  for (const entry of removals) {
    try {
      fs.unlinkSync(entry.file);
    } catch {
      // Another process may have concurrently refreshed or removed this bounded cache entry.
    }
  }
}

function boundedByAge(items, maximum, now = Date.now()) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && now - nonnegative(item.at) <= TTL_MS)
    .sort((left, right) => nonnegative(right.at) - nonnegative(left.at))
    .slice(0, maximum);
}

function compactState(state, now = Date.now()) {
  const next = state && typeof state === "object" ? state : emptyState();
  next.version = VERSION;
  next.turns = boundedByAge(next.turns, MAX_TURNS, now);
  next.tombstones = boundedByAge(next.tombstones, MAX_TOMBSTONES, now);
  next.policy_counts = {
    brake: nonnegative(next.policy_counts?.brake),
    anti_memory: nonnegative(next.policy_counts?.anti_memory),
  };
  if (next.active && now - nonnegative(next.active.at) > TTL_MS) next.active = null;
  return next;
}

function promptHashes(fingerprint) {
  if (!Array.isArray(fingerprint)) return [];
  return [...new Set(fingerprint
    .slice(0, MAX_FINGERPRINTS)
    .map((item) => digest("prompt-fingerprint\0" + String(item)).slice(0, 20)))]
    .sort();
}

function promptDigest(hashes) {
  return hashes.length ? digest("prompt-set\0" + hashes.join("\0")).slice(0, 24) : "";
}

function projectHash(project) {
  const value = String(project || "").trim();
  return value ? digest("project\0" + value).slice(0, 20) : "";
}

function similarity(left, right) {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  const intersection = left.reduce((total, item) => total + Number(rightSet.has(item)), 0);
  return intersection / Math.max(left.length, right.length);
}

function repeatKind(current, tombstone) {
  if (!current.length || !Array.isArray(tombstone.prompt_hashes)) return "";
  const score = similarity(current, tombstone.prompt_hashes);
  if (score === 1 && current.length === tombstone.prompt_hashes.length) return "exact";
  if (score >= NEAR_REPEAT) return "near";
  return "";
}

function completedState(last) {
  if (!last || typeof last !== "object") return "";
  const status = String(last.status || last.state || "").trim().toLowerCase();
  if (last.verified === true || ["verified", "passed", "pass"].includes(status)) return "verified";
  if (last.completed === true || ["completed", "complete", "done"].includes(status)) return "completed";
  if (last.resolved === true || ["resolved", "fixed", "closed"].includes(status)) return "resolved";
  return "";
}

function inferredCompletedState(finalMessage) {
  const value = String(finalMessage || "").toLowerCase();
  if (!value || /\b(?:failed|failure|blocked|incomplete|pending|not\s+(?:complete|verified|fixed|resolved))\b/.test(value)) return "";
  if (/\b(?:verified|tests?\s+passed|all\s+\d+\s+tests?\s+pass)\b/u.test(value)) {
    return "verified";
  }
  if (/\b(?:fixed|resolved)\b/u.test(value)) return "resolved";
  if (/\b(?:implemented|installed|completed|deployed|applied)\b/u.test(value)) {
    return "completed";
  }
  return "";
}

function normalizeUsage(value) {
  const usage = value && typeof value === "object" ? value : {};
  return {
    input_tokens: nonnegative(usage.input_tokens),
    cached_input_tokens: nonnegative(usage.cached_input_tokens),
    output_tokens: nonnegative(usage.output_tokens),
    reasoning_output_tokens: nonnegative(usage.reasoning_output_tokens),
    total_tokens: nonnegative(usage.total_tokens),
  };
}

function usageDelta(beforeValue, afterValue) {
  const before = normalizeUsage(beforeValue);
  const after = normalizeUsage(afterValue);
  const delta = {};
  for (const key of Object.keys(after)) delta[key] = Math.max(0, after[key] - before[key]);
  const cached = Math.min(delta.input_tokens, delta.cached_input_tokens);
  const uncached = Math.max(0, delta.input_tokens - cached);
  const generated = Math.max(
    0,
    delta.total_tokens - delta.input_tokens,
    delta.output_tokens + delta.reasoning_output_tokens
  );
  const reasoning = Math.min(generated, delta.reasoning_output_tokens);
  const visibleOutput = Math.max(0, generated - reasoning);
  return {
    ...delta,
    cached,
    uncached,
    generated,
    reasoning,
    visible_output: visibleOutput,
    input_credit: uncached + cached * 0.1,
    reasoning_credit: reasoning * 6,
    output_credit: visibleOutput * 6,
  };
}

function quotaUsed(value) {
  if (!value || typeof value !== "object") return 0;
  return nonnegative(
    value.used_percent
    ?? value.primary?.used_percent
    ?? value.secondary?.used_percent
    ?? 0
  );
}

function metric(source, names) {
  if (!source || typeof source !== "object") return 0;
  for (const name of names) {
    if (Number.isFinite(Number(source[name]))) return nonnegative(source[name]);
  }
  return 0;
}

function mutationCount(last) {
  if (!last || typeof last !== "object") return 0;
  if (Array.isArray(last.changed_files)) return last.changed_files.length;
  return metric(last, ["changed_files", "mutations", "mutation_count", "files_changed"]);
}

function progressScore(last, terminalState, mutationDelta = 0) {
  if (terminalState) return 1;
  if (!last || typeof last !== "object") return 0;
  for (const name of ["progress_delta", "progress", "progress_score"]) {
    if (Number.isFinite(Number(last[name]))) return clamp(last[name], 0, 1);
  }
  if (
    mutationDelta > 0 ||
    last.mutation === true ||
    last.mutated === true ||
    last.state_changed === true ||
    mutationCount(last) > 0
  ) return 0.8;
  if (last.result_changed === true || last.new_evidence === true) return 0.6;
  return 0;
}

function toolCategory(toolName) {
  const value = String(toolName || "").toLowerCase();
  if (/browser|chrome|playwright|web/.test(value)) return "browser";
  if (/shell|terminal|command|exec|powershell/.test(value)) return "shell";
  if (/file|patch|edit|write/.test(value)) return "file";
  if (/search|index|read|fetch/.test(value)) return "retrieval";
  return "other";
}

function attribution(totalCredits, reasoningDelta, last, active) {
  const total = nonnegative(totalCredits);
  const raw = {
    reasoning: metric(last, ["reasoning_credit_delta"]) || nonnegative(reasoningDelta) * 6,
    input: metric(last, ["input_credit_delta", "input_delta", "input_tokens_delta"]),
    output: metric(last, ["output_credit_delta", "output_delta", "output_tokens_delta"]),
    tools: metric(last, ["tool_credit_delta", "tools_delta"]) ||
      nonnegative(active?.tools?.total) * 24,
    compaction: metric(last, ["compaction_credit_delta", "compaction_delta"]),
    other: 0,
  };
  const known = COMPONENT_ORDER.slice(0, -1).reduce((sum, name) => sum + raw[name], 0);
  raw.other = Math.max(0, total - known);
  const rawTotal = COMPONENT_ORDER.reduce((sum, name) => sum + raw[name], 0);
  const scale = rawTotal > total && rawTotal > 0 ? total / rawTotal : 1;
  const weighted = {};
  for (const name of COMPONENT_ORDER) weighted[name] = Number((raw[name] * scale).toFixed(3));
  const assigned = COMPONENT_ORDER.reduce((sum, name) => sum + weighted[name], 0);
  if (total > assigned) weighted.other = Number((weighted.other + total - assigned).toFixed(3));
  let dominant = "other";
  for (const name of COMPONENT_ORDER) {
    if (weighted[name] > weighted[dominant]) dominant = name;
  }
  return { weighted, dominant };
}

function contextText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function begin(args = {}) {
  if (!enabled()) return { context: "" };
  const file = stateFile(args.session_id, true);
  if (!file) return { context: "" };
  const now = Date.now();
  const state = compactState(readState(file), now);
  const hashes = promptHashes(args.prompt_fingerprint);
  const epoch = Math.max(0, Math.trunc(nonnegative(args.epoch)));
  const currentProject = projectHash(args.project);
  const explicitDetail = args.explicit_detail === true || args.bypass === true;
  let context = "";
  let receipt;

  if (!explicitDetail) {
    const tombstone = state.tombstones.find((item) => {
      const sameEpoch = Math.max(0, Math.trunc(nonnegative(item.epoch))) === epoch;
      const sameProject = !currentProject || !item.project_hash || item.project_hash === currentProject;
      return sameEpoch && sameProject && repeatKind(hashes, item);
    });
    if (tombstone) {
      const kind = repeatKind(hashes, tombstone);
      context = contextText(
        "[Capsule anti-memory: " + kind + " repeat already " + tombstone.state +
        " at unchanged epoch=" + epoch +
        "; receipt=" + String(tombstone.receipt_id || "").slice(0, 12) +
        "; do not resurrect/re-run stale work; return receipt or evidence delta only.]"
      );
      receipt = { policy: "anti-memory", repeat: kind, tombstone_id: tombstone.id, epoch };
      state.policy_counts.anti_memory += 1;
    } else {
      const prior = state.turns[0];
      if (prior?.expensive === true && prior?.low_progress === true) {
        const directive = {
          reasoning: "run one discriminating check; no branch fan-out",
          input: "reuse capsules/live roots; no unchanged rereads",
          output: "emit semantic delta only",
          tools: "batch one proof-producing call",
          compaction: "use live roots and T tombstones",
          other: "take one evidence-backed action",
        }[prior.dominant_component] || "take one evidence-backed action";
        context = contextText(
          "[Capsule quota-progress brake: prior turn was expensive with low progress; streak=" +
          nonnegative(prior.low_progress_streak) + "; dominant=" + prior.dominant_component +
          "; " + directive + "; require mutation/verification before another costly branch.]"
        );
        receipt = {
          policy: "low-progress-brake",
          dominant_component: prior.dominant_component,
          low_progress_streak: nonnegative(prior.low_progress_streak),
          epoch,
        };
        state.policy_counts.brake += 1;
      }
    }
  }

  state.active = {
    at: now,
    epoch,
    project_hash: currentProject,
    prompt_hashes: hashes,
    prompt_digest: promptDigest(hashes),
    explicit_detail: explicitDetail,
    usage: normalizeUsage(args.usage),
    quota_used: quotaUsed(args.quota),
    tools: { total: 0, categories: {} },
  };
  state.updated_at = now;
  atomicWrite(file, state);
  return receipt ? { context, receipt } : { context };
}

function noteTool(args = {}) {
  if (!enabled()) return { recorded: false, reason: "disabled" };
  const file = stateFile(args.session_id, true);
  if (!file) return { recorded: false };
  const now = Date.now();
  const state = compactState(readState(file), now);
  const epoch = Math.max(0, Math.trunc(nonnegative(args.epoch)));
  if (!state.active || epoch < state.active.epoch) return { recorded: false, reason: "epoch_mismatch" };
  state.active.latest_epoch = epoch;
  const category = toolCategory(args.tool_name);
  state.active.tools = state.active.tools || { total: 0, categories: {} };
  state.active.tools.total = Math.min(MAX_TOOLS, nonnegative(state.active.tools.total) + 1);
  state.active.tools.categories = state.active.tools.categories || {};
  state.active.tools.categories[category] = Math.min(
    MAX_TOOLS,
    nonnegative(state.active.tools.categories[category]) + 1
  );
  state.updated_at = now;
  atomicWrite(file, state);
  return { recorded: true, category, count: state.active.tools.total };
}

function finish(args = {}) {
  if (!enabled()) return { id: "", disabled: true, reason: "disabled" };
  const file = stateFile(args.session_id, true);
  if (!file) return { id: "", disabled: true, reason: "invalid_session" };
  const now = Date.now();
  const state = compactState(readState(file), now);
  const active = state.active || {
    epoch: Math.max(0, Math.trunc(nonnegative(args.epoch))),
    project_hash: "",
    prompt_hashes: [],
    prompt_digest: "",
    tools: { total: 0, categories: {} },
  };
  const epoch = Math.max(0, Math.trunc(nonnegative(args.epoch)));
  const components = usageDelta(active.usage, args.usage);
  const computedCredits = components.input_credit + components.reasoning_credit + components.output_credit;
  const credits = nonnegative(args.credit_weighted_delta) || computedCredits;
  const reasoning = nonnegative(args.reasoning_delta) || components.reasoning;
  const terminalState = completedState(args.last) || inferredCompletedState(args.final_message);
  const mutationDelta = Math.max(0, epoch - Math.max(0, Math.trunc(nonnegative(active.epoch))));
  const progress = progressScore(args.last, terminalState, mutationDelta);
  const quotaDelta = Math.max(0, quotaUsed(args.quota) - nonnegative(active.quota_used));
  const expensive = credits >= EXPENSIVE_CREDITS || reasoning >= EXPENSIVE_REASONING || quotaDelta >= 0.5;
  const lowProgress = expensive && progress <= LOW_PROGRESS;
  const priorStreak = nonnegative(state.turns[0]?.low_progress_streak);
  const lowProgressStreak = lowProgress ? priorStreak + 1 : 0;
  const attributionMetrics = {
    ...(args.last && typeof args.last === "object" ? args.last : {}),
  };
  if (components.input_credit > 0) attributionMetrics.input_credit_delta = components.input_credit;
  if (components.reasoning_credit > 0) attributionMetrics.reasoning_credit_delta = components.reasoning_credit;
  if (components.output_credit > 0) attributionMetrics.output_credit_delta = components.output_credit;
  const share = attribution(credits, reasoning, attributionMetrics, active);
  const finalHash = args.final_message == null
    ? ""
    : digest("final-message\0" + String(args.final_message)).slice(0, 24);
  const id = digest([
    "receipt",
    sessionKey(args.session_id),
    active.prompt_digest,
    epoch,
    credits,
    reasoning,
    progress,
    terminalState,
  ].join("\0")).slice(0, 24);
  const receipt = {
    id,
    epoch,
    credit_weighted_delta: Number(credits.toFixed(3)),
    reasoning_delta: Number(reasoning.toFixed(3)),
    quota_used_delta: Number(quotaDelta.toFixed(3)),
    mutation_delta: mutationDelta,
    attribution: share.weighted,
    dominant_component: share.dominant,
    progress_score: Number(progress.toFixed(3)),
    expensive,
    low_progress: lowProgress,
    low_progress_streak: lowProgressStreak,
    terminal_state: terminalState || "",
    tool_count: nonnegative(active.tools?.total),
    final_hash: finalHash,
  };
  state.turns.unshift({ ...receipt, at: now });
  state.turns = boundedByAge(state.turns, MAX_TURNS, now);

  if (terminalState && active.prompt_hashes.length) {
    const tombstone = {
      id: digest([
        "tombstone",
        active.project_hash,
        active.prompt_digest,
        epoch,
        terminalState,
      ].join("\0")).slice(0, 24),
      epoch,
      project_hash: active.project_hash,
      prompt_hashes: active.prompt_hashes,
      prompt_digest: active.prompt_digest,
      state: terminalState,
      receipt_id: id,
      at: now,
    };
    state.tombstones = [
      tombstone,
      ...state.tombstones.filter((item) => item.id !== tombstone.id),
    ];
    state.tombstones = boundedByAge(state.tombstones, MAX_TOMBSTONES, now);
  }
  state.active = null;
  state.updated_at = now;
  atomicWrite(file, state);
  return receipt;
}

function checkpoint(sessionId) {
  if (!enabled()) return "";
  const file = stateFile(sessionId, false);
  if (!file) return "";
  const state = compactState(readState(file));
  const latest = state.turns[0];
  if (!latest) return "";
  return contextText(
    "qp:" + String(latest.id || "").slice(0, 12) + ":e" + latest.epoch +
    " credits=" + latest.credit_weighted_delta +
    " reasoning=" + latest.reasoning_delta +
    " dominant=" + latest.dominant_component +
    " progress=" + latest.progress_score +
    " low=" + latest.low_progress_streak +
    " terminal=" + (latest.terminal_state || "no") +
    " tools=" + latest.tool_count
  );
}

function tombstones(sessionId) {
  if (!enabled()) return [];
  const file = stateFile(sessionId, false);
  if (!file) return [];
  return compactState(readState(file)).tombstones.map((item) => ({ ...item }));
}

function status() {
  const directory = stateDirectory(false);
  const aggregate = {
    sessions: 0,
    turns: 0,
    receipts: 0,
    credit_weighted_delta: 0,
    reasoning_delta: 0,
    low_progress_turns: 0,
    tombstones: 0,
    policy_counts: { brake: 0, anti_memory: 0 },
    dominant_components: {},
  };
  let files = [];
  try {
    files = fs.readdirSync(directory)
      .filter((name) => /^[a-f0-9]{24}\.json$/.test(name))
      .sort();
  } catch {
    return aggregate;
  }
  for (const name of files) {
    const state = compactState(readState(path.join(directory, name)));
    if (!state.turns.length && !state.tombstones.length && !state.active) continue;
    aggregate.sessions += 1;
    aggregate.turns += state.turns.length;
    aggregate.tombstones += state.tombstones.length;
    aggregate.policy_counts.brake += nonnegative(state.policy_counts.brake);
    aggregate.policy_counts.anti_memory += nonnegative(state.policy_counts.anti_memory);
    for (const turn of state.turns) {
      aggregate.credit_weighted_delta += nonnegative(turn.credit_weighted_delta);
      aggregate.reasoning_delta += nonnegative(turn.reasoning_delta);
      aggregate.low_progress_turns += Number(turn.low_progress === true);
      const component = String(turn.dominant_component || "other");
      aggregate.dominant_components[component] =
        nonnegative(aggregate.dominant_components[component]) + 1;
    }
  }
  aggregate.credit_weighted_delta = Number(aggregate.credit_weighted_delta.toFixed(3));
  aggregate.reasoning_delta = Number(aggregate.reasoning_delta.toFixed(3));
  aggregate.receipts = aggregate.turns;
  return aggregate;
}

module.exports = {
  begin,
  checkpoint,
  finish,
  noteTool,
  status,
  tombstones,
};
