"use strict";

const fs = require("node:fs");
const path = require("node:path");
const core = require("./core.cjs");
const storage = require("./storage.cjs");

function nonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
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

function normalizeLimit(value) {
  const limit = value && typeof value === "object" ? value : {};
  return {
    used_percent: nonnegative(limit.used_percent),
    window_minutes: nonnegative(limit.window_minutes),
    resets_at: nonnegative(limit.resets_at),
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
      const lines = `${carry}${buffer.toString("utf8", 0, bytes)}`.split(/\r?\n/);
      carry = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          callback(JSON.parse(line));
        } catch {
          // Ignore a damaged record without hiding later provider samples.
        }
      }
    }
    if (carry.trim()) {
      try {
        callback(JSON.parse(carry));
      } catch {
        // The active Codex process may still be appending the final record.
      }
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function resolveSessionArgs(args) {
  if (args.session_file || args.sessionFile || args.transcript_path || args.transcriptPath || args.session) {
    return { args, selection: "explicit" };
  }
  try {
    const pointerFile = path.join(core.stateRoot(), "hooks", "provider-telemetry-current.json");
    const pointer = storage.readJson(pointerFile, null);
    if (pointer?.session_file && fs.existsSync(pointer.session_file)) {
      return {
        args: {
          ...args,
          session: String(pointer.session_id || ""),
          session_file: pointer.session_file,
        },
        selection: "latest-hook",
        pointer_timestamp: String(pointer.timestamp || ""),
      };
    }
  } catch {
    // Fall through to the normal session resolver.
  }
  return { args, selection: "resolver" };
}

function snapshot(args = {}) {
  // Load lazily because cognition uses compatibility redaction during startup.
  const cognition = require("./cognition.cjs");
  const resolved = resolveSessionArgs(args);
  const file = cognition.locateSessionFile(resolved.args);
  if (!file) {
    return {
      response: {
        available: false,
        source: "Codex provider token_count events",
        caveat: "No readable Codex session file was found.",
      },
      capturedChars: 0,
    };
  }

  const maxSamples = Math.min(256, Math.max(1, Number(args.max_samples || 32)));
  const samples = [];
  eachJsonLine(file, (record) => {
    if (record?.type !== "event_msg" || record?.payload?.type !== "token_count") return;
    const info = record.payload.info || {};
    const last = normalizeUsage(info.last_token_usage);
    const total = normalizeUsage(info.total_token_usage);
    const limits = record.payload.rate_limits || {};
    samples.push({
      timestamp: record.timestamp || "",
      last,
      total,
      context_window: nonnegative(info.model_context_window),
      rate_limits: {
        primary: normalizeLimit(limits.primary),
        secondary: normalizeLimit(limits.secondary),
        reached_type: String(limits.rate_limit_reached_type || ""),
        spend_control_reached: Boolean(limits.spend_control_reached),
      },
    });
  });

  const latest = samples.at(-1);
  if (!latest) {
    return {
      response: {
        available: false,
        source: "Codex provider token_count events",
        session_file: path.resolve(file),
        caveat: "The session is readable but contains no provider token_count event.",
      },
      capturedChars: 0,
    };
  }

  const input = latest.last.input_tokens;
  const cached = Math.min(input, latest.last.cached_input_tokens);
  return {
    response: {
      available: true,
      exact_provider_counters: true,
      source: "Codex provider token_count and rate_limits events",
      session_selection: resolved.selection,
      pointer_timestamp: resolved.pointer_timestamp || null,
      session_id: String(resolved.args.session || ""),
      session_file: path.resolve(file),
      samples: samples.length,
      latest_timestamp: latest.timestamp,
      cumulative: latest.total,
      last_request: {
        ...latest.last,
        uncached_input_tokens: Math.max(0, input - cached),
        cache_hit_percent: input > 0 ? Number((cached / input * 100).toFixed(2)) : 0,
      },
      context: {
        input_tokens: input,
        window_tokens: latest.context_window,
        used_percent: latest.context_window > 0
          ? Number((input / latest.context_window * 100).toFixed(2))
          : 0,
        remaining_tokens: Math.max(0, latest.context_window - input),
      },
      limits: latest.rate_limits,
      timeline: samples.slice(-maxSamples),
      caveat: "These are provider-reported counters exposed by Codex, not estimates. " +
        "They measure observed session usage and limit windows; Codex does not expose billing attribution " +
        "or a counterfactual run without Capsule.",
    },
    capturedChars: 0,
  };
}

module.exports = { normalizeUsage, snapshot };
