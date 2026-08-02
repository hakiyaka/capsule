"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const cognition = require("./cognition.cjs");
const core = require("./core.cjs");

const SECRET_RE = /\b(api[_-]?key|authorization|cookie|credential|password|passwd|private[_-]?key|secret|token)\s*[:=]\s*[^\s,;]+|\bbearer\s+[a-z0-9._~-]+/ig;
const CAPSULE_RE = /\bcap_[a-f0-9]{16}\b/ig;

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(Number(value || 0) * scale) / scale;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length : 0;
}

function summarize(values) {
  if (!values.length) return { average: 0, minimum: 0, maximum: 0 };
  return {
    average: round(average(values)),
    minimum: Math.min(...values),
    maximum: Math.max(...values),
  };
}

function eachJsonLine(file, callback) {
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.alloc(256 * 1024);
  let carry = "";
  try {
    while (true) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytes) break;
      const parts = `${carry}${buffer.toString("utf8", 0, bytes)}`.split(/\r?\n/);
      carry = parts.pop() || "";
      for (const line of parts) {
        if (!line.trim()) continue;
        try {
          callback(JSON.parse(line));
        } catch {
          // A damaged record must not hide the remaining observable telemetry.
        }
      }
    }
    if (carry.trim()) {
      try {
        callback(JSON.parse(carry));
      } catch {
        // Ignore a partial final record while Codex is still appending the session.
      }
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function sessionFile(args = {}) {
  return cognition.locateSessionFile(args);
}

function tokenUsage(record) {
  if (record?.type !== "event_msg" || record?.payload?.type !== "token_count") return null;
  const info = record.payload.info || {};
  return {
    last: info.last_token_usage || {},
    total: info.total_token_usage || {},
    context_window: Number(info.model_context_window || 0),
    rate_limits: record.payload.rate_limits || null,
  };
}

function totalTokens(usage) {
  return Number(usage?.total?.total_tokens || 0);
}

function inputTokens(usage) {
  return Number(usage?.last?.input_tokens || 0);
}

function auditSession(args = {}) {
  const file = sessionFile(args);
  if (!file) {
    return {
      response: {
        available: false,
        compactions: 0,
        caveat: "No readable Codex session file was found.",
      },
      capturedChars: 0,
    };
  }

  let previousNonzero = null;
  let active = null;
  const events = [];
  eachJsonLine(file, (record) => {
    const usage = tokenUsage(record);
    if (usage) {
      if (active && !active.reset_seen) {
        if (inputTokens(usage) === 0) {
          active.reported_delta = Math.max(0, totalTokens(usage) - active.total_at_compaction);
        }
        active.reset_seen = true;
      }
      if (active && !active.post && inputTokens(usage) > 0) {
        active.post = usage;
        active = null;
      }
      if (inputTokens(usage) > 0) previousNonzero = usage;
      return;
    }
    if (record?.type !== "compacted") return;
    const replacement = Array.isArray(record.payload?.replacement_history)
      ? record.payload.replacement_history
      : [];
    active = {
      timestamp: record.timestamp || "",
      window: Number(record.payload?.window_number || events.length + 1),
      pre: previousNonzero,
      post: null,
      total_at_compaction: totalTokens(previousNonzero),
      reported_delta: null,
      reset_seen: false,
      replacement_history_items: replacement.length,
      replacement_history_chars: JSON.stringify(replacement).length,
    };
    events.push(active);
  });

  const complete = events.filter((event) => event.pre && event.post);
  const pre = complete.map((event) => inputTokens(event.pre));
  const post = complete.map((event) => inputTokens(event.post));
  const cached = complete.map((event) => Number(event.post.last.cached_input_tokens || 0));
  const uncached = complete.map((event, index) => Math.max(0, post[index] - cached[index]));
  const reported = events
    .map((event) => event.reported_delta)
    .filter((value) => Number.isFinite(value));
  const reduction = pre.length && average(pre) > 0
    ? (1 - average(post) / average(pre)) * 100
    : 0;

  return {
    response: {
      available: true,
      session_file: path.resolve(file),
      compactions: events.length,
      measured_transitions: complete.length,
      direct_compaction_tokens: {
        reported_delta: reported.reduce((sum, value) => sum + value, 0),
        adjacent_counter_observations: reported.length,
        exposed_by_telemetry: reported.some((value) => value > 0),
      },
      observable_context: {
        pre_input_tokens: summarize(pre),
        post_input_tokens: summarize(post),
        post_cached_input_tokens: summarize(cached),
        post_uncached_input_tokens: summarize(uncached),
        reduction_percent: round(reduction),
      },
      replacement_history_chars: summarize(
        events.map((event) => event.replacement_history_chars)
      ),
      events: events.map((event) => ({
        timestamp: event.timestamp,
        window: event.window,
        pre_input_tokens: inputTokens(event.pre),
        post_input_tokens: inputTokens(event.post),
        post_cached_input_tokens: Number(event.post?.last?.cached_input_tokens || 0),
        reported_direct_delta: event.reported_delta,
        replacement_history_items: event.replacement_history_items,
        replacement_history_chars: event.replacement_history_chars,
      })),
      caveat: "Codex session telemetry does not expose the compaction model's own generation tokens; " +
        "reported_delta measures only changes visible in the cumulative counter. Post-compaction input is " +
        "observable context exposure, not a provider billing claim.",
    },
    capturedChars: 0,
  };
}

function clean(value, limit = 480) {
  const text = String(value || "")
    .replace(/<app-context\b[^>]*>[\s\S]*?<\/app-context>/gi, " ")
    .replace(/<environment_context\b[^>]*>[\s\S]*?<\/environment_context>/gi, " ")
    .replace(SECRET_RE, (match) => `${match.split(/[:=\s]/, 1)[0]}=[REDACTED]`)
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 17)).trim()} …[truncated]`;
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function readJson(file, fallback = null) {
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

function uniqueSorted(values) {
  return [...new Set((values || []).filter(Boolean))].sort();
}

function fitContext(header, directive, fields, maxChars) {
  const present = fields.filter((field) => field.value);
  const newlineChars = present.length + 1;
  const fieldBudget = Math.max(0, maxChars - header.length - directive.length - newlineChars);
  const totalWeight = present.reduce((sum, field) => sum + field.weight, 0);
  let assigned = 0;
  const fieldLines = present.map((field, index) => {
    const budget = index === present.length - 1
      ? fieldBudget - assigned
      : Math.floor(fieldBudget * field.weight / totalWeight);
    assigned += budget;
    if (budget <= field.prefix.length) return field.prefix.slice(0, Math.max(0, budget));
    return `${field.prefix}${clean(field.value, budget - field.prefix.length)}`;
  });
  return [header, ...fieldLines, directive].join("\n");
}

function prefixLayout(directive) {
  const prefix = String(directive || "");
  return {
    version: 1,
    context: prefix,
    prefix_hash: digest(prefix),
    prefix_chars: prefix.length,
    stable_blocks: ["instructions", "pointer-schema"],
    volatile_blocks: ["generation", "roots", "sets", "progress", "tombstones"],
  };
}

function buildGenerationalSeed(args, snapshot) {
  const generationFile = path.resolve(args.generation_file);
  const prior = readJson(generationFile, {});
  const previousRoots = prior?.roots || {};
  const previousSets = prior?.sets || {};
  const generation = Math.max(0, Number(prior?.generation || 0)) + 1;
  const rootValues = {
    G: snapshot.goal,
    S: snapshot.state,
    H: snapshot.history,
    P: snapshot.progress,
  };
  const roots = Object.fromEntries(
    Object.entries(rootValues)
      .filter(([, value]) => value)
      .map(([key, value]) => [key, { hash: digest(value), value }])
  );
  const rootTombstones = Object.entries(previousRoots)
    .filter(([key, item]) => item?.hash && item.hash !== roots[key]?.hash)
    .map(([key, item]) => `g${String(generation).padStart(6, "0")}:${key}¬@${String(item.hash).slice(0, 12)}`);
  const sets = {
    F: uniqueSorted(snapshot.files),
    X: uniqueSorted(snapshot.capsules),
    T: uniqueSorted([
      ...(previousSets.T || []),
      ...(snapshot.tombstones || []),
      ...rootTombstones,
    ]).slice(-12),
  };
  const exactGraph = {
    version: 1,
    roots: rootValues,
    sets,
  };
  const sourceKey = digest(generationFile).slice(0, 20);
  const exact = core.saveCapsule({
    kind: "proof-carrying-context-gc",
    source: `precompact-gc://${sourceKey}`,
    text: JSON.stringify(exactGraph),
    question: "Recover the live goal, state, progress, files, and exact evidence after compaction.",
    maxChars: 1_200,
    details: {
      generation,
      live_roots: Object.keys(roots),
      live_set_items: sets.F.length + sets.X.length,
    },
  }).response.capsule_id;
  let swept = 0;
  for (const key of ["G", "S", "H", "P"]) {
    if (previousRoots[key] && previousRoots[key].hash !== roots[key]?.hash) swept += 1;
  }
  for (const key of ["F", "X", "T"]) {
    const current = new Set(sets[key]);
    swept += (previousSets[key] || []).filter((value) => !current.has(value)).length;
  }
  const firstGeneration = !prior?.version;
  const fields = [];
  for (const key of ["G", "S", "H", "P"]) {
    const current = roots[key];
    if (!current) continue;
    const unchanged = previousRoots[key]?.hash === current.hash;
    fields.push({
      prefix: `${key}: `,
      value: !firstGeneration && unchanged
        ? `=@${current.hash.slice(0, 12)}`
        : current.value,
      weight: key === "G" || key === "P" ? 4 : 2,
    });
  }
  for (const key of ["F", "X", "T"]) {
    if (!sets[key].length && !(previousSets[key] || []).length) continue;
    const previous = new Set(previousSets[key] || []);
    const current = new Set(sets[key]);
    const added = sets[key].filter((value) => !previous.has(value));
    const removed = [...previous].filter((value) => !current.has(value));
    let value;
    if (firstGeneration) {
      value = sets[key].join(", ");
    } else if (!added.length && !removed.length) {
      value = `=@${digest(JSON.stringify(sets[key])).slice(0, 12)}`;
    } else {
      value = [
        added.length ? `+${added.join(",")}` : "",
        removed.length ? `-${removed.join(",")}` : "",
      ].filter(Boolean).join(" ");
    }
    fields.push({ prefix: `${key}: `, value, weight: 2 });
  }
  const liveNodes = Object.keys(roots).length + sets.F.length + sets.X.length + sets.T.length;
  const header = `[Capsule context-gc g=${generation}; summary<=${snapshot.summaryTokens}; live=${liveNodes}; swept=${swept}; x=${exact}]`;
  const directive = "Unchanged =@ roots and +/- sets resolve from the prior seed; T tombstones invalidate older state. If absent expand x. Never reread swept evidence.";
  // Preserve the established budget exactly: this only moves the existing
  // directive from the tail to the leading edge of the injected context.
  const generationalTail = fitContext(header, directive, fields, snapshot.maxChars);
  const generationalBody = generationalTail.slice(0, -directive.length - 1);
  const legacyHeader = `[Capsule compact map; direct summary<=${snapshot.summaryTokens} tokens; no re-derivation]`;
  const legacyDirective = "Copy only G/S/H/P/F/X/T into the continuation; T invalidates superseded state. Do not analyze or re-derive. Keep constraints, unresolved work, tests and metrics; omit logs, tool args, superseded exploration, inline media, and active system/developer/AGENTS/skills/memory/app-context packets that Codex reinjects.";
  const legacyTail = fitContext(legacyHeader, legacyDirective, [
    { prefix: "G: ", value: rootValues.G, weight: 4 },
    { prefix: "S: ", value: rootValues.S, weight: 4 },
    { prefix: "H: ", value: rootValues.H, weight: 2 },
    { prefix: "P: ", value: rootValues.P, weight: 3 },
    { prefix: "F: ", value: snapshot.files.join(", "), weight: 2 },
    { prefix: "X: ", value: snapshot.capsules.join(", "), weight: 2 },
    { prefix: "T: ", value: sets.T.join(", "), weight: 2 },
  ], snapshot.maxChars);
  const legacyBody = legacyTail.slice(0, -legacyDirective.length - 1);
  const emitGeneration = !firstGeneration && generationalTail.length < legacyTail.length;
  const selectedDirective = emitGeneration ? directive : legacyDirective;
  const layout = prefixLayout(selectedDirective);
  const context = `${layout.context}\n${emitGeneration ? generationalBody : legacyBody}`;
  writeJsonAtomic(generationFile, {
    version: 1,
    generation,
    capsule_id: exact,
    roots,
    sets,
  });
  return {
    response: {
      available: true,
      context,
      chars: context.length,
      source_records: snapshot.sourceRecords,
      files: sets.F.length,
      capsules: [...sets.X, exact],
      summary_tokens: snapshot.summaryTokens,
      context_gc: {
        generation,
        exact,
        base: prior?.capsule_id || null,
        live_nodes: liveNodes,
        swept_nodes: swept,
        tombstones: sets.T.length,
        emission: emitGeneration ? "generation-delta" : firstGeneration ? "legacy-bootstrap" : "legacy-pareto-fallback",
        unchanged_roots: Object.keys(roots)
          .filter((key) => previousRoots[key]?.hash === roots[key].hash),
      },
      context_layout: {
        ...layout,
        cache_attribution: {
          available: false,
          caveat: "The layout controls PreCompact additionalContext only; provider cache telemetry is observed later by contextPressure.",
        },
      },
    },
    capturedChars: 0,
  };
}

function compactPath(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(-3).join("/");
}

function tailRecords(file, maxBytes = 4 * 1024 * 1024) {
  const descriptor = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(descriptor).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(descriptor, buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (start > 0) text = text.slice(Math.max(0, text.indexOf("\n") + 1));
    return text.split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

function median(values) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : Math.round((ordered[middle - 1] + ordered[middle]) / 2);
}

function policyForMode(mode) {
  const policies = {
    normal: {
      summary_tokens: 600,
      seed_chars: 1_200,
      tool_trigger_chars: 5_000,
      tool_max_chars: 8_000,
      tool_passthrough_chars: 1_400,
      thread_turns: 8,
      thread_item_chars: 800,
    },
    high: {
      summary_tokens: 500,
      seed_chars: 1_000,
      tool_trigger_chars: 3_000,
      tool_max_chars: 3_600,
      tool_passthrough_chars: 1_000,
      thread_turns: 4,
      thread_item_chars: 400,
    },
    critical: {
      summary_tokens: 400,
      seed_chars: 850,
      tool_trigger_chars: 1_400,
      tool_max_chars: 2_200,
      tool_passthrough_chars: 700,
      thread_turns: 2,
      thread_item_chars: 240,
    },
    emergency: {
      summary_tokens: 280,
      seed_chars: 720,
      tool_trigger_chars: 900,
      tool_max_chars: 1_400,
      tool_passthrough_chars: 500,
      thread_turns: 2,
      thread_item_chars: 160,
    },
  };
  return policies[mode] || policies.normal;
}

function contextPressure(args = {}) {
  const file = sessionFile(args);
  if (!file) {
    return {
      response: {
        available: false,
        mode: "normal",
        policy: policyForMode("normal"),
        caveat: "No readable Codex session file was found.",
      },
      capturedChars: 0,
    };
  }
  const records = tailRecords(file, Number(args.max_bytes || 1024 * 1024));
  let latest = null;
  let activeCompaction = false;
  let lastPostCompactionPercent = 0;
  let recentCompactions = 0;
  const compactionTimes = [];
  let retainedImageItems = 0;
  let retainedImageSerializedChars = 0;
  let latestReplacementHistoryChars = 0;
  let latestReplacementHistoryItems = 0;
  let recentReplacementHistoryChars = 0;
  let usageSamples = [];
  let cacheSamples = [];
  for (const record of records) {
    const usage = tokenUsage(record);
    if (usage) {
      if (inputTokens(usage) > 0) {
        latest = usage;
        const currentInput = inputTokens(usage);
        const currentHasCache = Object.prototype.hasOwnProperty.call(usage.last || {}, "cached_input_tokens");
        const currentCached = currentHasCache
          ? Math.min(currentInput, Math.max(0, Number(usage.last.cached_input_tokens || 0)))
          : 0;
        cacheSamples.push({
          input_tokens: currentInput,
          cached_input_tokens: currentCached,
          cache_hit_percent: currentHasCache && currentInput > 0 ? round(currentCached / currentInput * 100) : null,
          after_compaction: activeCompaction,
          timestamp: String(record.timestamp || ""),
        });
        cacheSamples = cacheSamples.slice(-8);
        const previousInput = usageSamples.at(-1);
        if (previousInput && currentInput < previousInput * 0.7) usageSamples = [];
        if (usageSamples.at(-1) !== currentInput) usageSamples.push(currentInput);
        usageSamples = usageSamples.slice(-8);
        if (activeCompaction && usage.context_window > 0) {
          lastPostCompactionPercent = round(inputTokens(usage) / usage.context_window * 100);
          activeCompaction = false;
        }
      }
      continue;
    }
    if (record?.type !== "compacted") continue;
    recentCompactions += 1;
    const at = Date.parse(record.timestamp || "");
    if (Number.isFinite(at)) compactionTimes.push(at);
    activeCompaction = true;
    const replacement = Array.isArray(record.payload?.replacement_history)
      ? record.payload.replacement_history
      : [];
    const serialized = JSON.stringify(replacement);
    latestReplacementHistoryChars = serialized.length;
    latestReplacementHistoryItems = replacement.length;
    recentReplacementHistoryChars += serialized.length;
    const typedImages = (serialized.match(/"type"\s*:\s*"input_image"/g) || []).length;
    const dataImages = serialized.match(/data:image\/[^"\\\s]+/gi) || [];
    retainedImageItems = Math.max(typedImages, dataImages.length);
    retainedImageSerializedChars = dataImages.reduce((sum, item) => sum + item.length, 0);
  }
  const contextWindow = Number(latest?.context_window || 0);
  const input = inputTokens(latest);
  const usedPercent = contextWindow > 0 ? round(input / contextWindow * 100) : 0;
  const positiveGrowth = usageSamples.slice(1)
    .map((value, index) => value - usageSamples[index])
    .filter((value) => value > 0);
  const growthTokens = median(positiveGrowth);
  const projectedNextPercent = contextWindow > 0
    ? round(Math.min(contextWindow, input + growthTokens) / contextWindow * 100)
    : 0;
  const observationsTo90 = contextWindow > 0 && growthTokens > 0 && input < contextWindow * 0.9
    ? Math.ceil((contextWindow * 0.9 - input) / growthTokens)
    : null;
  const latestTimestamp = records.reduce((value, record) => {
    const candidate = Date.parse(record.timestamp || "");
    return Number.isFinite(candidate) ? Math.max(value, candidate) : value;
  }, 0) || Date.now();
  const compactionsLast30m = compactionTimes.filter((at) => latestTimestamp - at <= 30 * 60_000).length;
  const primaryLimit = latest?.rate_limits?.primary || {};
  const secondaryLimit = latest?.rate_limits?.secondary || {};
  const quotaUsed = Math.max(
    Number(primaryLimit.used_percent || 0),
    Number(secondaryLimit.used_percent || 0)
  );
  const quotaReached = Boolean(
    latest?.rate_limits?.rate_limit_reached_type ||
    latest?.rate_limits?.spend_control_reached
  );
  const quota = {
    available: Boolean(latest?.rate_limits),
    used_percent: round(quotaUsed),
    window_minutes: Number(primaryLimit.window_minutes || secondaryLimit.window_minutes || 0),
    resets_at: Number(primaryLimit.resets_at || secondaryLimit.resets_at || 0),
    reached: quotaReached,
  };
  const cacheTelemetryAvailable = Boolean(
    latest?.last && Object.prototype.hasOwnProperty.call(latest.last, "cached_input_tokens")
  );
  const cachedInput = cacheTelemetryAvailable
    ? Math.min(input, Math.max(0, Number(latest?.last?.cached_input_tokens || 0)))
    : 0;
  const uncachedInput = cacheTelemetryAvailable ? Math.max(0, input - cachedInput) : 0;
  const cacheHitPercent = cacheTelemetryAvailable && input > 0
    ? round(cachedInput / input * 100)
    : 0;
  const latestCacheSample = cacheSamples.at(-1) || null;
  const previousCacheSample = cacheSamples.at(-2) || null;
  const requestInputShrank = Boolean(
    previousCacheSample && input < Number(previousCacheSample.input_tokens || 0)
  );
  const abruptCacheDrop = Boolean(
    previousCacheSample &&
    Number(previousCacheSample.cache_hit_percent || 0) >= 90 &&
    cacheTelemetryAvailable &&
    cacheHitPercent < 50 &&
    uncachedInput >= 12_000
  );
  const postCompactionMiss = Boolean(
    latestCacheSample &&
    latestCacheSample.after_compaction &&
    cacheTelemetryAvailable &&
    cacheHitPercent < 70 &&
    uncachedInput >= 6_000
  );
  const cacheIncidentKind = postCompactionMiss
    ? "post-compaction-cache-miss"
    : requestInputShrank && cacheTelemetryAvailable && cacheHitPercent < 70
    ? "request-input-shrank"
    : abruptCacheDrop
    ? "mid-loop-cache-dropout"
    : cacheTelemetryAvailable && uncachedInput >= 12_000 && cacheHitPercent < 70
    ? "large-uncached-request"
    : "";
  const cacheIncident = {
    detected: Boolean(cacheIncidentKind),
    classification: cacheIncidentKind || null,
    previous_input_tokens: Number(previousCacheSample?.input_tokens || 0),
    previous_cache_hit_percent: Number(previousCacheSample?.cache_hit_percent || 0),
    input_delta: previousCacheSample ? input - Number(previousCacheSample.input_tokens || 0) : 0,
  };
  const roundtripTax = {
    input_tokens: input,
    cached_input_tokens: cachedInput,
    uncached_input_tokens: uncachedInput,
    cache_hit_percent: cacheHitPercent,
    telemetry_available: cacheTelemetryAvailable,
    cache_incident: cacheIncident,
    elevated: Boolean(
      cacheTelemetryAvailable &&
      input >= 20_000 &&
      (uncachedInput >= 12_000 || (uncachedInput >= 6_000 && cacheHitPercent < 94))
    ),
  };
  const severity = { normal: 0, high: 1, critical: 2, emergency: 3 };
  let mode = "normal";
  const reasons = [];
  function escalate(target, reason) {
    if (severity[target] > severity[mode]) mode = target;
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  if (roundtripTax.elevated) {
    escalate(
      uncachedInput >= 24_000 || cacheHitPercent < 70 ? "critical" : "high",
      cacheIncident.detected
        ? `elevated uncached round-trip suffix (${cacheIncident.classification})`
        : "elevated uncached round-trip suffix"
    );
  }
  if (retainedImageItems > 0) escalate("emergency", "retained-image payload");
  if (latestReplacementHistoryChars >= 512_000) {
    escalate("critical", "large compaction replacement history");
  } else if (latestReplacementHistoryChars >= 128_000) {
    escalate("high", "large compaction replacement history");
  }
  if (recentReplacementHistoryChars >= 1_000_000) {
    escalate("critical", "compaction replacement churn");
  } else if (recentReplacementHistoryChars >= 256_000) {
    escalate("high", "compaction replacement churn");
  }
  if (lastPostCompactionPercent >= 65) escalate("emergency", "high post-compaction occupancy");
  if (compactionsLast30m >= 2) escalate("emergency", "compaction thrash within 30 minutes");
  if (usedPercent >= 80) escalate("critical", "context occupancy >=80%");
  else if (usedPercent >= 60) escalate("high", "context occupancy >=60%");
  if (usedPercent >= 40 && projectedNextPercent >= 90) {
    escalate("critical", "projected next observation reaches context runway");
  } else if (usedPercent >= 40 && observationsTo90 != null && observationsTo90 <= 3) {
    escalate("high", "three or fewer observations remain to 90% context");
  }
  if (quotaReached || quotaUsed >= 95) escalate("emergency", "quota >=95% or reached");
  else if (quotaUsed >= 85) escalate("critical", "quota >=85%");
  else if (quotaUsed >= 70) escalate("high", "quota >=70%");
  if (!reasons.length) reasons.push("normal headroom");
  return {
    response: {
      available: Boolean(latest),
      session_file: path.resolve(file),
      input_tokens: input,
      cached_input_tokens: cachedInput,
      uncached_input_tokens: uncachedInput,
      cache_hit_percent: cacheHitPercent,
      roundtrip_tax: roundtripTax,
      context_window: contextWindow,
      remaining_tokens: Math.max(0, contextWindow - input),
      used_percent: usedPercent,
      recent_compactions: recentCompactions,
      compactions_last_30m: compactionsLast30m,
      last_post_compaction_percent: lastPostCompactionPercent,
      latest_replacement_history_chars: latestReplacementHistoryChars,
      latest_replacement_history_items: latestReplacementHistoryItems,
      recent_replacement_history_chars: recentReplacementHistoryChars,
      retained_image_items: retainedImageItems,
      retained_image_serialized_chars: retainedImageSerializedChars,
      growth_tokens_per_observation: growthTokens,
      projected_next_percent: projectedNextPercent,
      observations_to_90_percent: observationsTo90,
      quota,
      mode,
      reasons,
      policy: policyForMode(mode),
      caveat: "Pressure uses the latest provider-reported input/context counters in a bounded session tail. " +
        "Runway is a median of recent positive input observations; quota uses locally reported limit percentages. " +
        "Retained-image detection covers readable recent compacted records. Cache incident labels are heuristic timing/counter correlations; they cannot prove a provider-side cause or prompt-prefix mutation. None is a provider billing estimate.",
    },
    capturedChars: 0,
  };
}

function buildSeed(args = {}) {
  const file = sessionFile(args);
  if (!file) return { response: { available: false, context: "", chars: 0 }, capturedChars: 0 };
  const maxChars = Math.min(2_400, Math.max(480, Number(args.max_chars || 1_200)));
  const summaryTokens = Math.min(900, Math.max(200, Number(args.summary_tokens || 600)));
  const historical = clean(args.historical, 420);
  const progress = clean(args.progress, 360);
  const tombstones = Array.isArray(args.tombstones)
    ? uniqueSorted(args.tombstones.map((value) => clean(value, 180)).filter(Boolean)).slice(-10)
    : [];
  const records = tailRecords(file, Number(args.max_bytes || 4 * 1024 * 1024));
  let users = [];
  let agents = [];
  let files = [];
  let capsules = [];
  for (const record of records) {
    if (record?.type === "event_msg" && record?.payload?.type === "task_started") {
      users = [];
      agents = [];
      files = [];
      capsules = [];
      continue;
    }
    const type = record?.payload?.type;
    let text = "";
    let rawText = "";
    if (record?.type === "event_msg" && type === "user_message") {
      rawText = String(record.payload.message || "");
      text = clean(rawText, 600);
      if (text) users.push(text);
    } else if (record?.type === "event_msg" && type === "agent_message") {
      rawText = String(record.payload.message || "");
      text = clean(rawText, 520);
      if (text) agents.push(text);
    } else if (record?.type === "event_msg" && type === "patch_apply_end") {
      for (const changed of Object.keys(record.payload.changes || {})) files.push(compactPath(changed));
    } else if (record?.type === "event_msg" && type === "task_complete") {
      rawText = String(record.payload.last_agent_message || "");
      text = clean(rawText, 520);
      if (text) agents.push(text);
    }
    for (const capsule of String(rawText || text).match(CAPSULE_RE) || []) capsules.push(capsule.toLowerCase());
  }

  users = [...new Set(users)].slice(-2).reverse();
  agents = [...new Set(agents)].slice(-2).reverse();
  files = [...new Set(files)].slice(-8);
  capsules = [...new Set(capsules)].slice(-12);
  if (!users.length && !agents.length && !files.length && !capsules.length && !historical && !progress && !tombstones.length) {
    return { response: { available: false, context: "", chars: 0 }, capturedChars: 0 };
  }

  if (args.generation_file) {
    return buildGenerationalSeed(args, {
      goal: users.join(" | "),
      state: agents.join(" | "),
      history: historical,
      progress,
      files,
      capsules,
      tombstones,
      maxChars,
      summaryTokens,
      sourceRecords: records.length,
    });
  }

  const header = `[Capsule compact map; direct summary<=${summaryTokens} tokens; no re-derivation]`;
  const directive = "Copy only G/S/H/P/F/X/T into the continuation; T invalidates superseded state. Do not analyze or re-derive. Keep constraints, unresolved work, tests and metrics; omit logs, tool args, superseded exploration, inline media, and active system/developer/AGENTS/skills/memory/app-context packets that Codex reinjects.";
  const fields = [
    { prefix: "G: ", value: users.join(" | "), weight: 4 },
    { prefix: "S: ", value: agents.join(" | "), weight: 4 },
    { prefix: "H: ", value: historical, weight: 2 },
    { prefix: "P: ", value: progress, weight: 3 },
    { prefix: "F: ", value: files.join(", "), weight: 2 },
    { prefix: "X: ", value: capsules.join(", "), weight: 2 },
    { prefix: "T: ", value: tombstones.join(", "), weight: 2 },
  ];
  const context = fitContext(header, directive, fields, maxChars);
  return {
    response: {
      available: true,
      context,
      chars: context.length,
      source_records: records.length,
      files: files.length,
      capsules,
      summary_tokens: summaryTokens,
    },
    capturedChars: 0,
  };
}

module.exports = { auditSession, buildSeed, contextPressure, policyForMode };
