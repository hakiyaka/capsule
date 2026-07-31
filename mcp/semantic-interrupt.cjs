"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const core = require("./core.cjs");

function int(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redact(text) {
  return String(text)
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .slice(-800);
}

function commandSnapshot(probe, maxBytes) {
  if (probe.idempotent !== true) {
    throw new Error(`interrupt probe ${probe.id}: command requires idempotent:true`);
  }
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const child = spawn(String(probe.command || ""), Array.isArray(probe.args) ? probe.args.map(String) : [], {
      cwd: probe.cwd || process.cwd(),
      windowsHide: true,
      shell: false,
      env: { ...process.env, ...(probe.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const capture = (bucket) => (chunk) => {
      if (bytes >= maxBytes) return;
      const remaining = maxBytes - bytes;
      const kept = Buffer.from(chunk).subarray(0, remaining);
      bytes += kept.length;
      bucket.push(kept);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      resolve({
        type: "command",
        exit_code: code,
        signal,
        stdout: out,
        stderr: err,
        bytes,
        hash: digest(JSON.stringify({ code, signal, out, err })),
        sample: redact(out || err),
      });
    });
  });
}

function fileSnapshot(probe, maxBytes) {
  const target = String(probe.path || "");
  if (!target) throw new Error(`interrupt probe ${probe.id}: path is required`);
  if (!fs.existsSync(target)) return { type: "file", exists: false, path: target, hash: "missing" };
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error(`interrupt probe ${probe.id}: path is not a file`);
  const content = stat.size <= maxBytes ? fs.readFileSync(target) : Buffer.alloc(0);
  const identity = content.length
    ? digest(content)
    : digest(`${stat.size}:${stat.mtimeMs}`);
  return {
    type: "file",
    exists: true,
    path: target,
    bytes: stat.size,
    mtime_ms: stat.mtimeMs,
    hash: identity,
    sample: content.length ? redact(content.toString("utf8")) : "",
    oversized: stat.size > maxBytes,
  };
}

function processRunning(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function tail(file, maxBytes) {
  if (!file || !fs.existsSync(file)) return "";
  const stat = fs.statSync(file);
  const bytes = Math.min(stat.size, maxBytes);
  const handle = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    fs.readSync(handle, buffer, 0, bytes, stat.size - bytes);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(handle);
  }
}

function jobSnapshot(probe, maxBytes) {
  const running = processRunning(probe.pid);
  const stdout = tail(probe.stdout_path, maxBytes);
  const stderr = tail(probe.stderr_path, maxBytes);
  return {
    type: "job",
    pid: Number(probe.pid),
    running,
    stdout,
    stderr,
    hash: digest(JSON.stringify({ running, stdout, stderr })),
    sample: redact(stdout || stderr),
  };
}

async function urlSnapshot(probe, maxBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), int(probe.request_timeout_ms, 10_000, 500, 30_000));
  try {
    const response = await fetch(String(probe.url || ""), {
      signal: controller.signal,
      headers: { "user-agent": "Capsule/Semantic-Interrupt", ...(probe.headers || {}) },
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const kept = buffer.subarray(0, maxBytes);
    const body = kept.toString("utf8");
    return {
      type: "url",
      url: response.url,
      status: response.status,
      bytes: buffer.length,
      hash: digest(JSON.stringify({ status: response.status, body })),
      sample: redact(body),
      truncated: buffer.length > kept.length,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function snapshot(probe, maxBytes) {
  if (!probe || typeof probe !== "object") throw new Error("interrupt probes must be objects");
  if (!probe.id) throw new Error("interrupt probe id is required");
  switch (probe.type) {
    case "file": return fileSnapshot(probe, maxBytes);
    case "command": return commandSnapshot(probe, maxBytes);
    case "job": return jobSnapshot(probe, maxBytes);
    case "url": return urlSnapshot(probe, maxBytes);
    default: throw new Error(`interrupt probe ${probe.id}: unsupported type ${probe.type}`);
  }
}

function terminal(probe, state) {
  if (probe.until === "success" && state.type === "command") return state.exit_code === 0;
  if (probe.until === "exit" && state.type === "job") return state.running === false;
  if (probe.until === "status" && state.type === "url") return Number(state.status) === Number(probe.status);
  return false;
}

async function semanticInterrupt(args = {}) {
  const probes = Array.isArray(args.probes) ? args.probes : [];
  if (!probes.length || probes.length > 16) throw new Error("interrupt requires between 1 and 16 probes");
  const ids = new Set(probes.map((probe) => String(probe?.id || "")));
  if (ids.size !== probes.length) throw new Error("interrupt probe ids must be unique");
  const intervalMs = int(args.interval_ms, 1_000, 25, 10_000);
  const timeoutMs = int(args.timeout_ms, 30_000, intervalMs, 120_000);
  const maxBytes = int(args.max_bytes, 1_000_000, 1_024, 8_000_000);
  const started = Date.now();
  const baselineStates = await Promise.all(probes.map((probe) => snapshot(probe, maxBytes)));
  let checks = probes.length;
  let capturedChars = baselineStates.reduce((sum, state) => sum + JSON.stringify(state).length, 0);
  const supplied = args.baseline && typeof args.baseline === "object" ? args.baseline : {};
  const baseline = new Map(probes.map((probe, index) => [
    probe.id,
    supplied[probe.id] || baselineStates[index].hash,
  ]));

  while (Date.now() - started < timeoutMs) {
    await sleep(Math.min(intervalMs, Math.max(1, timeoutMs - (Date.now() - started))));
    const states = await Promise.all(probes.map((probe) => snapshot(probe, maxBytes)));
    checks += probes.length;
    capturedChars += states.reduce((sum, state) => sum + JSON.stringify(state).length, 0);
    const changed = probes.flatMap((probe, index) => {
      const state = states[index];
      const isChanged = state.hash !== baseline.get(probe.id);
      return isChanged || terminal(probe, state) ? [{ id: probe.id, ...state }] : [];
    });
    if (changed.length) {
      const exactPayload = JSON.stringify({
        operation: "semantic-interrupt",
        elapsed_ms: Date.now() - started,
        checks,
        baseline: Object.fromEntries(baseline),
        changed,
      });
      const exact = core.saveCapsule({
        kind: "semantic-interrupt",
        source: "capsule:interrupt",
        text: exactPayload,
        maxChars: 1_200,
        details: { probes: probes.length, checks },
      }).response.capsule_id;
      const lines = changed.map((state) => {
        const signals = [
          state.exit_code == null ? "" : `exit=${state.exit_code}`,
          state.running == null ? "" : `running=${state.running}`,
          state.status == null ? "" : `status=${state.status}`,
        ].filter(Boolean);
        const sample = state.sample ? JSON.stringify(state.sample.slice(-240)) : "";
        return `${state.id}>${[...signals, sample].filter(Boolean).join(" ") || state.hash.slice(0, 12)}`;
      });
      return {
        response: {
          operation: "interrupt",
          changed: true,
          timed_out: false,
          elapsed_ms: Date.now() - started,
          checks,
          probes: probes.length,
          exact,
          events: changed.map(({ sample: _sample, stdout: _stdout, stderr: _stderr, ...state }) => state),
        },
        responseText: [`[SI Δ${changed.length}/${probes.length}@${checks} x=${exact}]`, ...lines].join("\n"),
        capturedChars,
        route: "semantic-interrupt",
      };
    }
  }
  return {
    response: {
      operation: "interrupt",
      changed: false,
      timed_out: true,
      elapsed_ms: Date.now() - started,
      checks,
      probes: probes.length,
    },
    responseText: `[SI =@${checks}/${Date.now() - started}ms]`,
    capturedChars,
    route: "semantic-interrupt-quiet",
  };
}

module.exports = { semanticInterrupt };
