"use strict";

// Shared, dependency-free primitives for local Capsule state.
//
// Keeping these operations in one module prevents the MCP actions from
// drifting apart on malformed JSON, integer bounds, or atomic-write cleanup.
// This module intentionally has no dependency on Capsule actions, so it can
// be used by every stateful lane without creating a require cycle.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : String(value ?? "");
  return crypto.createHash("sha256").update(input).digest("hex");
}

function clampNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
}

/**
 * Read JSON with an explicit malformed-file policy.
 * `onError:"all"` is the safe default for optional caches; use
 * `onError:"missing"` when a corrupt file must remain visible to the caller.
 */
function readJson(file, fallback, options = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (options.onError === "missing" && error?.code !== "ENOENT") throw error;
    return fallback;
  }
}

function temporaryPath(file) {
  return `${file}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
}

/**
 * Write JSON through a same-directory temporary file and clean it on every
 * failure path. The caller can opt into pretty output for human-maintained
 * state; compact output remains the default for token-efficient caches.
 */
function writeJsonAtomic(file, value, options = {}) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const indent = options.pretty === true ? 2 : 0;
  const payload = `${JSON.stringify(value, null, indent)}\n`;
  const temporary = temporaryPath(target);
  try {
    fs.writeFileSync(temporary, payload, { encoding: "utf8", flag: "wx" });
    if (options.mode != null && process.platform !== "win32") {
      fs.chmodSync(temporary, options.mode);
    }
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return target;
}

function writeTextAtomic(file, text, options = {}) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = temporaryPath(target);
  try {
    fs.writeFileSync(temporary, String(text ?? ""), { encoding: "utf8", flag: "wx" });
    if (options.mode != null && process.platform !== "win32") {
      fs.chmodSync(temporary, options.mode);
    }
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return target;
}

module.exports = {
  boundedInteger,
  clampNumber,
  readJson,
  sha256,
  writeJsonAtomic,
  writeTextAtomic,
};
