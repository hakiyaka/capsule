"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_MAX_FILES = 100_000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024 * 1024;
const MAX_TOP_ENTRIES = 32;
const MAX_TRACKED_HASHES_PER_SESSION = 50_000;
const HASH_SAMPLE_CHARS = 4_096;
const UNIVERSAL_HARD_CAP_CHARS = 1_000_000;
const SIGNAL_RE = /\b(error|exception|fatal|fail(?:ed|ure)?|panic|security|timeout|traceback|warn(?:ing)?)\b/ig;
const TOOL_RE = /[\\/]/;

function integer(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function addCount(map, key, amount = 1, limit = MAX_TOP_ENTRIES) {
  const normalized = String(key || "unknown").slice(0, 120);
  if (!map.has(normalized) && map.size >= limit) return;
  map.set(normalized, (map.get(normalized) || 0) + amount);
}

function mapObject(map, limit = MAX_TOP_ENTRIES) {
  return Object.fromEntries(
    [...map.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, limit)
  );
}

function pushTop(array, item, limit = MAX_TOP_ENTRIES) {
  array.push(item);
  array.sort((left, right) => right.chars - left.chars || right.bytes - left.bytes);
  if (array.length > limit) array.length = limit;
}

function codexHome(args = {}) {
  return path.resolve(
    args.codex_home ||
    process.env.CODEX_HOME ||
    path.join(os.homedir(), ".codex")
  );
}

function discoverSessionFiles(args = {}) {
  const home = codexHome(args);
  const roots = [
    { kind: "sessions", root: path.join(home, "sessions") },
    ...((args.include_archived ?? args.history_include_archived) === false
      ? []
      : [{ kind: "archived_sessions", root: path.join(home, "archived_sessions") }]),
  ];
  const maxFiles = integer(
    args.max_files ?? args.history_max_files,
    DEFAULT_MAX_FILES,
    1,
    1_000_000
  );
  const stack = roots.filter((entry) => fs.existsSync(entry.root));
  const files = [];
  const visited = new Set();
  while (stack.length && files.length < maxFiles) {
    const current = stack.pop();
    let real;
    try {
      real = fs.realpathSync(current.root || current);
    } catch {
      continue;
    }
    if (visited.has(real)) continue;
    visited.add(real);
    let entries;
    try {
      entries = fs.readdirSync(real, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(real, entry.name);
      if (entry.isDirectory()) {
        stack.push({ kind: current.kind, root: target });
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        files.push({ path: target, kind: current.kind });
      }
      if (files.length >= maxFiles) break;
    }
  }
  return { home, roots, files };
}

function valueMeasure(value, options = {}) {
  const hash = crypto.createHash("sha256");
  const maxChars = options.max_chars || 8 * 1024 * 1024;
  const seen = new Set();
  let chars = 0;
  let signal = false;
  let signalHits = 0;
  let truncated = false;
  const visit = (current, depth = 0) => {
    if (depth > 10 || chars >= maxChars) {
      truncated = true;
      return;
    }
    if (typeof current === "string") {
      const text = current;
      chars += text.length;
      const sample = text.length <= HASH_SAMPLE_CHARS * 2
        ? text
        : `${text.slice(0, HASH_SAMPLE_CHARS)}\0${text.slice(-HASH_SAMPLE_CHARS)}`;
      hash.update("s:").update(String(text.length)).update(":").update(sample).update("\0");
      const matches = text.match(SIGNAL_RE);
      if (matches?.length) {
        signal = true;
        signalHits += matches.length;
      }
      if (chars > maxChars) truncated = true;
      return;
    }
    if (current == null) {
      hash.update("null\0");
      return;
    }
    if (typeof current !== "object") {
      hash.update(`${typeof current}:${String(current)}\0`);
      return;
    }
    if (seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      hash.update(`array:${current.length}\0`);
      for (const item of current.slice(0, 2_000)) visit(item, depth + 1);
      return;
    }
    hash.update(`object:${Object.keys(current).length}\0`);
    for (const [key, item] of Object.entries(current).slice(0, 2_000)) {
      hash.update(`key:${key.length}:`).update(key).update("\0");
      visit(item, depth + 1);
    }
  };
  visit(value);
  return {
    chars,
    hash: hash.digest("hex"),
    signal,
    signal_hits: signalHits,
    truncated,
  };
}

function toolName(payload = {}) {
  const candidates = [
    payload.name,
    payload.tool_name,
    payload.tool,
    payload.invocation?.name,
    payload.invocation?.tool_name,
    payload.command,
    payload.executable,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const clean = candidate.trim().split(TOOL_RE).at(-1);
    return clean.slice(0, 120);
  }
  return "unknown";
}

function outputValue(record) {
  const payload = record?.payload || {};
  if (record.type === "response_item" && payload.type === "function_call_output") {
    return payload.output ?? payload.content ?? payload.result;
  }
  if (record.type === "event_msg" && /tool_call_end|command_output|exec_output/i.test(String(payload.type || ""))) {
    return payload.result ?? payload.output ?? payload.content;
  }
  return undefined;
}

function callValue(record) {
  const payload = record?.payload || {};
  if (record.type === "response_item" && payload.type === "function_call") {
    return payload.arguments ?? payload.input ?? "";
  }
  if (record.type === "event_msg" && /tool_call_begin|mcp_tool_call_begin/i.test(String(payload.type || ""))) {
    return payload.invocation ?? payload.arguments ?? payload.input ?? "";
  }
  return undefined;
}

function usageValue(record) {
  if (record?.type !== "event_msg" || record?.payload?.type !== "token_count") return null;
  const info = record.payload.info || {};
  const last = info.last_token_usage || {};
  return {
    input: Number(last.input_tokens || 0),
    cached_input: Number(last.cached_input_tokens || 0),
    output: Number(last.output_tokens || 0),
    reasoning: Number(last.reasoning_output_tokens || 0),
    total: Number(last.total_tokens || 0),
    context_window: Number(info.model_context_window || 0),
  };
}

function failureMarker(value, depth = 0) {
  if (depth > 4 || value == null) return false;
  if (Array.isArray(value)) return value.some((item) => failureMarker(item, depth + 1));
  if (typeof value !== "object") return false;
  if (value.isError === true || value.is_error === true || value.failed === true ||
      (Object.prototype.hasOwnProperty.call(value, "Err") && value.Err != null) ||
      (Object.prototype.hasOwnProperty.call(value, "error") && value.error != null && value.error !== false)) return true;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:error|err|failure|failed|iserror|is_error)$/i.test(key) &&
        (child === true || (typeof child === "string" && child.trim()) ||
         (child && typeof child === "object"))) return true;
  }
  return false;
}

function emptyAggregate() {
  return {
    files: 0,
    bytes: 0,
    lines: 0,
    blank_lines: 0,
    valid_records: 0,
    invalid_lines: 0,
    partial_final_lines: 0,
    record_types: new Map(),
    payload_types: new Map(),
    tool_names: new Map(),
    errors_by_kind: new Map(),
    signal_records: 0,
    signal_hits: 0,
    user_chars: 0,
    assistant_chars: 0,
    reasoning_summary_chars: 0,
    reasoning_encrypted_chars: 0,
    function_call_chars: 0,
    function_call_count: 0,
    function_output_count: 0,
    tool_output_chars: 0,
    tool_output_records: 0,
    large_output_records: 0,
    huge_output_records: 0,
    hard_cap_candidate_chars: 0,
    duplicate_output_records: 0,
    duplicate_output_chars: 0,
    cross_session_duplicate_output_chars: 0,
    repeated_call_count: 0,
    repeated_call_input_chars: 0,
    token_samples: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
    peak_context_window: 0,
    replacement_history_chars: 0,
    mcp_failures: 0,
    compacted_records: 0,
    context_compaction_markers: 0,
    unreadable_files: 0,
    skipped_files: 0,
    changed_files: 0,
    root_sessions: 0,
    subagent_sessions: 0,
    root_bytes: 0,
    subagent_bytes: 0,
    parent_fanout: new Map(),
    top_sessions: [],
    top_outputs: [],
  };
}

function scanHistory(args = {}) {
  const discovered = discoverSessionFiles(args);
  const aggregate = emptyAggregate();
  const configuredMaxBytes = args.max_bytes ?? args.history_max_bytes;
  const maxBytes = Number.isFinite(Number(configuredMaxBytes))
    ? Math.max(1, Number(configuredMaxBytes))
    : DEFAULT_MAX_BYTES;
  const outputHashes = new Map();
  let scannedBytes = 0;
  let lastProgressAt = Date.now();

  const reportProgress = (item) => {
    if (typeof args.on_progress !== "function") return;
    const now = Date.now();
    if (now - lastProgressAt < 1_000 && item.index < discovered.files.length) return;
    lastProgressAt = now;
    args.on_progress(item);
  };

  for (let index = 0; index < discovered.files.length; index += 1) {
    const entry = discovered.files[index];
    let stat;
    try {
      stat = fs.statSync(entry.path);
    } catch {
      aggregate.unreadable_files += 1;
      continue;
    }
    if (scannedBytes + stat.size > maxBytes) {
      aggregate.skipped_files += 1;
      continue;
    }
    scannedBytes += stat.size;
    const session = {
      bytes: stat.size,
      lines: 0,
      valid_records: 0,
      invalid_lines: 0,
      partial_final_lines: 0,
      output_chars: 0,
      repeated_calls: 0,
      duplicate_output_chars: 0,
      signal_records: 0,
      parent: "",
      metadata: null,
    };
    const callHashes = new Map();
    const sessionOutputHashes = new Map();
    let descriptor = null;
    let carry = "";
    const processLine = (line, partial = false) => {
      session.lines += 1;
      aggregate.lines += 1;
      if (!line.trim()) {
        aggregate.blank_lines += 1;
        return;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        aggregate.invalid_lines += 1;
        session.invalid_lines += 1;
        if (partial) {
          aggregate.partial_final_lines += 1;
          session.partial_final_lines += 1;
        }
        return;
      }
      aggregate.valid_records += 1;
      session.valid_records += 1;
      addCount(aggregate.record_types, record.type, 1, 256);
      const payload = record.payload && typeof record.payload === "object" ? record.payload : {};
      addCount(aggregate.payload_types, payload.type, 1, 256);
      if (!session.metadata && record.type === "session_meta") {
        session.metadata = payload;
        session.parent = typeof payload.parent_thread_id === "string" ? payload.parent_thread_id : "";
      }
      const usage = usageValue(record);
      if (usage) {
        aggregate.token_samples += 1;
        aggregate.input_tokens += usage.input;
        aggregate.cached_input_tokens += usage.cached_input;
        aggregate.output_tokens += usage.output;
        aggregate.reasoning_tokens += usage.reasoning;
        aggregate.total_tokens += usage.total;
        aggregate.peak_context_window = Math.max(aggregate.peak_context_window, usage.context_window);
      }
      if (record.type === "compacted") {
        aggregate.compacted_records += 1;
        aggregate.replacement_history_chars += JSON.stringify(payload.replacement_history || []).length;
      } else if (payload.type === "context_compacted") {
        aggregate.context_compaction_markers += 1;
      }
      if (record.type === "response_item" && payload.type === "message") {
        const message = valueMeasure(payload.content);
        if (payload.role === "user") aggregate.user_chars += message.chars;
        if (payload.role === "assistant") aggregate.assistant_chars += message.chars;
      }
      if (record.type === "response_item" && payload.type === "reasoning") {
        aggregate.reasoning_summary_chars += valueMeasure(payload.summary).chars;
        aggregate.reasoning_encrypted_chars += valueMeasure(payload.encrypted_content).chars;
      }
      const call = callValue(record);
      if (call !== undefined) {
        const name = toolName(payload);
        const measured = valueMeasure(call, { max_chars: 2 * 1024 * 1024 });
        const callHash = digest(name + "\0" + measured.hash);
        aggregate.function_call_count += 1;
        aggregate.function_call_chars += measured.chars + name.length;
        addCount(aggregate.tool_names, name, 1, 256);
        const previous = callHashes.get(callHash);
        if (previous) {
          aggregate.repeated_call_count += 1;
          aggregate.repeated_call_input_chars += measured.chars + name.length;
          session.repeated_calls += 1;
        } else if (callHashes.size < MAX_TRACKED_HASHES_PER_SESSION) {
          callHashes.set(callHash, true);
        }
      }
      const output = outputValue(record);
      if (output !== undefined) {
        const measured = valueMeasure(output);
        aggregate.function_output_count += 1;
        aggregate.tool_output_records += 1;
        aggregate.tool_output_chars += measured.chars;
        session.output_chars += measured.chars;
        if (measured.chars >= 32_000) aggregate.large_output_records += 1;
        if (measured.chars >= 1_000_000) aggregate.huge_output_records += 1;
        if (measured.chars > UNIVERSAL_HARD_CAP_CHARS) {
          aggregate.hard_cap_candidate_chars += measured.chars - UNIVERSAL_HARD_CAP_CHARS;
        }
        if (measured.signal) {
          aggregate.signal_records += 1;
          aggregate.signal_hits += measured.signal_hits;
          session.signal_records += 1;
          addCount(aggregate.errors_by_kind, String(payload.type || record.type), 1, 256);
        }
        const outputHash = measured.hash;
        const prior = sessionOutputHashes.get(outputHash);
        if (prior) {
          aggregate.duplicate_output_records += 1;
          aggregate.duplicate_output_chars += measured.chars;
          session.duplicate_output_chars += measured.chars;
        } else if (sessionOutputHashes.size < MAX_TRACKED_HASHES_PER_SESSION) {
          sessionOutputHashes.set(outputHash, measured.chars);
        }
        const globalPrior = outputHashes.get(outputHash);
        if (globalPrior) {
          aggregate.cross_session_duplicate_output_chars += measured.chars;
          globalPrior.count += 1;
        } else if (outputHashes.size < 100_000) {
          outputHashes.set(outputHash, { count: 1, chars: measured.chars });
        }
        pushTop(aggregate.top_outputs, {
          chars: measured.chars,
          kind: String(payload.type || record.type),
          session_hash: digest(entry.path).slice(0, 12),
          line: session.lines,
        });
      }
      const typeText = String(record.type || "") + ":" + String(payload.type || "");
      if (payload.isError === true || payload.is_error === true ||
          failureMarker(payload.result) || failureMarker(payload.error) ||
          /\berror\b/i.test(typeText)) {
        aggregate.mcp_failures += 1;
        addCount(aggregate.errors_by_kind, typeText, 1, 256);
      }
    };
    try {
      descriptor = fs.openSync(entry.path, "r");
      const buffer = Buffer.alloc(1 * 1024 * 1024);
      while (true) {
        const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
        if (!bytes) break;
        const parts = (carry + buffer.toString("utf8", 0, bytes)).split(/\r?\n/);
        carry = parts.pop() || "";
        for (const line of parts) processLine(line);
      }
      if (carry) processLine(carry, true);
    } catch {
      aggregate.unreadable_files += 1;
    } finally {
      if (descriptor != null) {
        try { fs.closeSync(descriptor); } catch {}
      }
    }
    try {
      if (fs.statSync(entry.path).size !== stat.size) aggregate.changed_files += 1;
    } catch {
      aggregate.changed_files += 1;
    }
    aggregate.files += 1;
    aggregate.bytes += stat.size;
    const isSubagent = Boolean(session.parent) ||
      Boolean(session.metadata?.source && typeof session.metadata.source === "object");
    if (isSubagent) {
      aggregate.subagent_sessions += 1;
      aggregate.subagent_bytes += stat.size;
      if (session.parent) {
        const parentHash = digest(session.parent).slice(0, 12);
        const current = aggregate.parent_fanout.get(parentHash) || {
          parent_hash: parentHash,
          children: 0,
          child_bytes: 0,
        };
        current.children += 1;
        current.child_bytes += stat.size;
        aggregate.parent_fanout.set(parentHash, current);
      }
    } else {
      aggregate.root_sessions += 1;
      aggregate.root_bytes += stat.size;
    }
    pushTop(aggregate.top_sessions, {
      session_hash: digest(entry.path).slice(0, 12),
      kind: entry.kind,
      bytes: stat.size,
      lines: session.lines,
      output_chars: session.output_chars,
      repeated_calls: session.repeated_calls,
      invalid_lines: session.invalid_lines,
      signal_records: session.signal_records,
    });
    reportProgress({ index: index + 1, files: discovered.files.length, bytes: scannedBytes });
  }

  const avoidedChars = Math.min(
    aggregate.tool_output_chars + aggregate.function_call_chars,
    aggregate.duplicate_output_chars +
      aggregate.cross_session_duplicate_output_chars +
      aggregate.repeated_call_input_chars
  );
  const totalFiles = discovered.files.length;
  const lineScanComplete = aggregate.files === totalFiles &&
    aggregate.skipped_files === 0 &&
    aggregate.unreadable_files === 0 &&
    aggregate.changed_files === 0 &&
    aggregate.bytes === scannedBytes;
  const subagentRatio = aggregate.bytes
    ? Number((aggregate.subagent_bytes / aggregate.bytes).toFixed(4))
    : 0;
  const recommendations = [];
  if (aggregate.duplicate_output_chars > 0 || aggregate.cross_session_duplicate_output_chars > 0) {
    recommendations.push({
      code: "exact-output-replay",
      estimated_chars: aggregate.duplicate_output_chars + aggregate.cross_session_duplicate_output_chars,
      action: "Keep immutable exact capsules for repeated tool/file results and emit only references.",
    });
  }
  if (aggregate.repeated_call_count > 0) {
    recommendations.push({
      code: "repeat-call-firewall",
      estimated_chars: aggregate.repeated_call_input_chars,
      action: "Batch independent reads and block unchanged local rereads unless force_refresh is explicit.",
    });
  }
  if (aggregate.large_output_records > 0) {
    recommendations.push({
      code: "large-output-pressure",
      estimated_chars: aggregate.tool_output_chars,
      action: "Apply a measured output gate before large tool results enter the next model turn.",
    });
  }
  if (aggregate.hard_cap_candidate_chars > 0) {
    recommendations.push({
      code: "universal-hard-cap",
      estimated_chars: aggregate.hard_cap_candidate_chars,
      action: "Envelope every giant non-failed tool result with an exact capsule before it reaches the next model turn.",
    });
  }
  if (subagentRatio >= 0.25) {
    recommendations.push({
      code: "subagent-fanout",
      estimated_chars: aggregate.subagent_bytes,
      action: "Prefer self-contained subagent context and bounded dependency windows over full-history fan-out.",
    });
  }
  if (aggregate.invalid_lines > 0 || aggregate.partial_final_lines > 0) {
    recommendations.push({
      code: "tolerant-tail",
      estimated_chars: 0,
      action: "Ignore only damaged/partial tail records while preserving the remaining line-by-line telemetry.",
    });
  }
  return {
    version: 1,
    mode: "deep-line-scan",
    line_scan: {
      every_line: true,
      complete: lineScanComplete,
      files_discovered: totalFiles,
      files_scanned: aggregate.files,
      bytes_scanned: scannedBytes,
      max_bytes: maxBytes,
      include_archived: (args.include_archived ?? args.history_include_archived) !== false,
      changed_files: aggregate.changed_files,
    },
    sessions: {
      total: aggregate.root_sessions + aggregate.subagent_sessions,
      root: aggregate.root_sessions,
      subagent: aggregate.subagent_sessions,
      subagent_ratio: subagentRatio,
      unreadable: aggregate.unreadable_files,
      skipped: aggregate.skipped_files,
      changed: aggregate.changed_files,
    },
    records: {
      lines: aggregate.lines,
      blank_lines: aggregate.blank_lines,
      valid: aggregate.valid_records,
      invalid: aggregate.invalid_lines,
      partial_final: aggregate.partial_final_lines,
      by_type: mapObject(aggregate.record_types),
      by_payload_type: mapObject(aggregate.payload_types),
    },
    bytes: {
      total: aggregate.bytes,
      root: aggregate.root_bytes,
      subagent: aggregate.subagent_bytes,
    },
    token_usage: {
      samples: aggregate.token_samples,
      input_tokens: aggregate.input_tokens,
      cached_input_tokens: aggregate.cached_input_tokens,
      uncached_input_tokens: Math.max(0, aggregate.input_tokens - aggregate.cached_input_tokens),
      output_tokens: aggregate.output_tokens,
      reasoning_tokens: aggregate.reasoning_tokens,
      total_tokens: aggregate.total_tokens,
      peak_context_window: aggregate.peak_context_window,
    },
    model_visible: {
      user_chars: aggregate.user_chars,
      assistant_chars: aggregate.assistant_chars,
      reasoning_summary_chars: aggregate.reasoning_summary_chars,
      reasoning_encrypted_chars: aggregate.reasoning_encrypted_chars,
      function_call_chars: aggregate.function_call_chars,
      function_call_count: aggregate.function_call_count,
      tool_output_chars: aggregate.tool_output_chars,
      tool_output_records: aggregate.tool_output_records,
      large_output_records: aggregate.large_output_records,
      huge_output_records: aggregate.huge_output_records,
      hard_cap_candidate_chars: aggregate.hard_cap_candidate_chars,
      approx_tool_output_tokens: Math.ceil(aggregate.tool_output_chars / 4),
    },
    errors: {
      signal_records: aggregate.signal_records,
      signal_hits: aggregate.signal_hits,
      mcp_failures: aggregate.mcp_failures,
      malformed_json_lines: aggregate.invalid_lines,
      by_kind: mapObject(aggregate.errors_by_kind),
    },
    repeats: {
      repeated_calls: aggregate.repeated_call_count,
      repeated_call_input_chars: aggregate.repeated_call_input_chars,
      duplicate_tool_outputs: aggregate.duplicate_output_records,
      duplicate_output_chars: aggregate.duplicate_output_chars,
      cross_session_duplicate_output_chars: aggregate.cross_session_duplicate_output_chars,
      conservative_avoided_chars: avoidedChars,
      conservative_avoided_approx_tokens: Math.ceil(avoidedChars / 4),
    },
    compaction: {
      // Codex writes a `compacted` record and a nearby `context_compacted`
      // event for one logical compaction.  Count the larger side so the pair
      // is not reported as two separate compactions.
      events: Math.max(aggregate.compacted_records, aggregate.context_compaction_markers),
      compacted_records: aggregate.compacted_records,
      context_markers: aggregate.context_compaction_markers,
      replacement_history_chars: aggregate.replacement_history_chars,
    },
    tools: mapObject(aggregate.tool_names),
    hotspots: {
      largest_sessions: aggregate.top_sessions,
      largest_outputs: aggregate.top_outputs,
      parent_fanout: [...aggregate.parent_fanout.values()]
        .sort((left, right) => right.child_bytes - left.child_bytes || right.children - left.children)
        .slice(0, MAX_TOP_ENTRIES),
    },
    recommendations,
    privacy: "Only counts, categories, sizes, and one-way hashes are returned; prompt, reasoning, tool argument, and output text are not persisted.",
    automatic_changes: false,
  };
}

module.exports = { discoverSessionFiles, scanHistory, valueMeasure };
