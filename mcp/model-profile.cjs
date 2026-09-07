"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// These are Capsule's output preferences, not provider context limits, pricing,
// tokenizer claims, or overrides of the user's model/reasoning selection.
const ASTRA_SCALE = 0.75;
let configCache = null;
let sessionCache = null;

function normalizeModel(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/^gpt-6[ -]astra$/, "gpt-6-astra");
}

function configuredModel() {
  const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
  try {
    const stat = fs.statSync(file);
    if (stat.size > 1024 * 1024) return "";
    const key = `${file}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}`;
    if (configCache?.key === key) return configCache.model;
    // Only a top-level model setting is relevant. Never parse, return or log
    // credentials or project/profile settings from the rest of the config.
    const topLevel = fs.readFileSync(file, "utf8").split(/^\s*\[/m, 1)[0];
    const match = /^\s*model\s*=\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)')\s*(?:#.*)?$/m.exec(topLevel);
    const model = normalizeModel(match?.[1] || match?.[2]);
    configCache = { key, model };
    return model;
  } catch {
    configCache = null;
    return "";
  }
}

function resolveModel(args = {}, options = {}) {
  const explicit = normalizeModel(args.model) || normalizeModel(args.model_slug) ||
    normalizeModel(args.turn_context?.model);
  const sessionFile = args.session_file || args.sessionFile || args.transcript_path ||
    args.transcriptPath || args.rollout_path || args.rolloutPath;
  return explicit || sessionModel(sessionFile) ||
    normalizeModel(process.env.CAPSULE_MODEL) ||
    (options.config === true && !sessionFile ? configuredModel() : "");
}

function sessionModel(file) {
  if (typeof file !== "string" || !file) return "";
  let fd;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return "";
    const key = `${path.resolve(file)}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}`;
    if (sessionCache?.key === key) return sessionCache.model;
    // Resolve the current task's model before falling back to the host default.
    // A bounded tail avoids loading the full conversation or persisting prompts.
    const start = Math.max(0, stat.size - 64 * 1024);
    const buffer = Buffer.alloc(stat.size - start);
    fd = fs.openSync(file, "r");
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytes).toString("utf8").split(/\r?\n/);
    if (start > 0) lines.shift();
    let model = "";
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].includes('"turn_context"')) continue;
      try {
        const record = JSON.parse(lines[i]);
        if (record.type === "turn_context") {
          model = normalizeModel(record.payload?.model);
          break;
        }
      } catch { /* A partially written record does not establish model identity. */ }
    }
    sessionCache = { key, model };
    return model;
  } catch {
    sessionCache = null;
    return "";
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function outputScale(model) {
  return process.env.CAPSULE_MODEL_PROFILE !== "0" && normalizeModel(model) === "gpt-6-astra"
    ? ASTRA_SCALE : 1;
}

function outputPolicy(model, policy) {
  const scale = outputScale(model);
  if (scale === 1) return policy;
  const result = { ...policy };
  for (const [key, floor] of [
    ["tool_max_chars", 900], ["tool_passthrough_chars", 220],
    ["tool_trigger_chars", 1200], ["thread_item_chars", 120],
  ]) {
    const value = policy[key];
    if (Number.isFinite(value) && value >= 0) {
      result[key] = Math.min(value, Math.max(floor, Math.floor(value * scale)));
    }
  }
  return result;
}

module.exports = { configuredModel, normalizeModel, outputPolicy, outputScale, resolveModel, sessionModel };
