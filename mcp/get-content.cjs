"use strict";

// Safe fast path for the common, read-only PowerShell command:
//   Get-Content [-LiteralPath] <one-file>
//
// It deliberately refuses pipelines, wildcards, variables, waits, ranges,
// encodings it cannot prove, and unknown switches. Refused commands continue
// through the normal shell so this optimization cannot change their meaning.

const fs = require("node:fs");
const path = require("node:path");
const core = require("./core.cjs");

const COMMAND_RE = /^(?:get-content|gc)$/i;
const UTF8_ENCODINGS = new Set(["utf8", "utf-8", "utf8bom", "utf8nobom"]);

function tokens(text) {
  const result = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) {
        quote = "";
      } else if (quote === '"' && character === "`" && index + 1 < text.length) {
        current += text[++index];
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        result.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (quote || current && /[`$]/.test(current)) return null;
  if (current) result.push(current);
  return result;
}

function parse(command, cwd = process.cwd()) {
  const text = String(command || "").trim();
  if (!text || /[\r\n;&|<>]/.test(text) || /[`$(){}]/.test(text)) return null;
  const parts = tokens(text);
  if (!parts?.length || !COMMAND_RE.test(parts[0])) return null;
  let target = "";
  let encoding = "utf8";
  let raw = false;
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index];
    const lower = part.toLowerCase();
    if (lower === "-raw") {
      raw = true;
      continue;
    }
    if (lower === "-force") continue;
    if (lower === "-literalpath" || lower === "-path") {
      if (target || !parts[index + 1] || parts[index + 1].startsWith("-")) return null;
      target = parts[++index];
      continue;
    }
    if (lower === "-encoding") {
      const value = String(parts[++index] || "").toLowerCase();
      if (!UTF8_ENCODINGS.has(value)) return null;
      encoding = value;
      continue;
    }
    if (part.startsWith("-")) return null;
    if (target) return null;
    target = part;
  }
  if (!target || /[*?]/.test(target)) return null;
  const absolute = path.resolve(cwd || process.cwd(), target);
  return { command: text, path: absolute, raw, encoding };
}

function queryTerms(value) {
  return [...new Set(String(value || "").toLowerCase().match(/[\p{L}\p{N}_$.-]{2,}/gu) || [])];
}

function queryProjection(text, query, capsuleId, maxChars) {
  const terms = queryTerms(query);
  if (!terms.length || !capsuleId) return "";
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    const lower = lines[index].toLowerCase();
    if (terms.some((term) => lower.includes(term))) matches.push(`${index + 1} | ${lines[index]}`);
    if (matches.length >= 8) break;
  }
  if (!matches.length) return "";
  const marker = `[Capsule Get-Content; exact=${capsuleId}]`;
  const budget = Math.max(96, Number(maxChars) || 1_200);
  const visible = [];
  let used = marker.length + 1;
  for (const line of matches) {
    if (used + line.length + 1 > budget) break;
    visible.push(line);
    used += line.length + 1;
  }
  return visible.length ? `${visible.join("\n")}\n${marker}` : marker;
}

function compactVisible(operation, plan, exactText, query, maxChars) {
  if (operation.route === "file-replay") {
    return `[Capsule Get-Content replay; exact=${operation.response.capsule_id}]`;
  }
  if (operation.route === "passthrough" || operation.route === "lossless") {
    return core.renderOperation(operation);
  }
  const focused = queryProjection(exactText, query, operation.response?.capsule_id, maxChars);
  if (focused) return focused;
  const islands = Array.isArray(operation.response?.evidence_islands)
    ? operation.response.evidence_islands.map((item) => item.excerpt).filter(Boolean)
    : [];
  const exact = operation.response?.capsule_id;
  if (islands.length && exact) {
    return `${islands.join("\n…\n")}\n[Capsule Get-Content; exact=${exact}]`;
  }
  return core.renderOperation(operation);
}

function fastPath(args = {}) {
  const plan = parse(args.command, args.cwd);
  if (!plan || args.require_full === true || args.require_literal === true || args.literal === true || args.raw === true || args.exact === true || args.mode === "full") {
    return null;
  }
  let stat;
  let buffer;
  try {
    stat = fs.statSync(plan.path);
    if (!stat.isFile() || stat.size > 256 * 1024 * 1024) return null;
    buffer = fs.readFileSync(plan.path);
    if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) return null;
  } catch {
    return null;
  }
  const started = Date.now();
  let operation;
  try {
    operation = core.smartFile({
      path: plan.path,
      question: args.query || args.question || "",
      max_chars: args.max_chars,
      passthrough_chars: args.passthrough_chars,
      replay_unchanged: true,
    });
  } catch {
    return null;
  }
  const exactText = operation.baselineText || buffer.toString("utf8");
  const output = compactVisible(operation, plan, exactText, args.query || args.question || "", args.max_chars);
  // Keep the optimization monotonic: if the existing generic stdout
  // projector is shorter for an irregular/small file, delegate to it.
  try {
    const generic = require("./unified.cjs").compressText(
      `# stdout\n${exactText}\n# stderr\n`,
      args
    );
    if (generic?.output && generic.output.length < output.length) return null;
  } catch {
    // A failed comparison never disables the safe native read.
  }
  return {
    plan,
    path: plan.path,
    profile: "get-content",
    operation,
    output,
    exactText,
    capsule_id: operation.response?.capsule_id || "",
    elapsed_ms: Date.now() - started,
    source_bytes: buffer.length,
    source_lines: String(exactText).replace(/\r\n?/g, "\n").split("\n").length,
    encoding: plan.encoding,
  };
}

module.exports = { fastPath, parse, tokens };
