"use strict";

const path = require("node:path");
const core = require("./core.cjs");
const compat = require("./compat.cjs");
const storage = require("./storage.cjs");

const MAX_AGE_MS = 60 * 60_000;
const MAX_HASHES = 8192;
const MINIMUM_CHARS = 120;
const MAXIMUM_CHARS = 2_000_000;
const CRITICAL_RE = /\b(?:error|fail(?:ed|ure)?|exception|panic|fatal|warning|warn|denied|conflict|timeout|timed out)\b/i;
const PLACEHOLDER = "cap_0000000000000000";
const STRUCTURAL_ATOM_RE = /https?:\/\/[^\s"'<>]+|[A-Za-z]:[\\/][^\s"'<>|]+|(?:\.{0,2}[\\/])?(?:[\w.@+-]+[\\/])+[\w.@+/-]+|\b\d{4}-\d{2}-\d{2}(?:[T ][0-2]\d:[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b|\b[0-2]\d:[0-5]\d:[0-5]\d(?:\.\d+)?\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b|\b(?:sha(?:1|256|512):)?[0-9a-f]{12,128}\b|\bv?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b|\b\d+(?:\.\d+)?(?:ns|us|µs|ms|s|min|h|d|B|KB|MB|GB|TB|KiB|MiB|GiB)\b|(?<![\w])[-+]?\d+(?:\.\d+)?%?(?![\w])/gi;

function digest(value) {
  return storage.sha256(value);
}

function stateFile(args = {}) {
  const session = String(args.session_id || "").trim();
  if (!session) return "";
  const cwd = path.resolve(args.cwd || process.cwd());
  const scope = process.platform === "win32" ? cwd.toLowerCase() : cwd;
  return path.join(core.stateRoot(), "terminal-genome", digest(session + "\0" + scope).slice(0, 24) + ".json");
}

function readState(file) {
  return storage.readJson(file, { version: 1, seen: {} });
}

function writeState(file, state) {
  return storage.writeJsonAtomic(file, state);
}

function reset(args = {}) {
  const file = stateFile(args);
  if (!file) return false;
  writeState(file, { version: 2, seen: {} });
  return true;
}

function classifyAtom(value) {
  if (/^https?:\/\//i.test(value)) return "url";
  if (/[\\/]/.test(value)) return "path";
  if (/^\d{4}-\d{2}-\d{2}|^[0-2]\d:[0-5]\d:[0-5]\d/.test(value)) return "time";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value)) return "uuid";
  if (/^(?:sha(?:1|256|512):)?[0-9a-f]{12,128}$/i.test(value)) return "id";
  if (/^v?\d+\.\d+\.\d+/i.test(value)) return "ver";
  if (/(?:B|KiB|MiB|GiB)$/i.test(value)) return "size";
  if (/(?:ns|us|µs|ms|s|min|h|d)$/i.test(value)) return "dur";
  if (/%$/.test(value)) return "pct";
  return "n";
}

function structuralLine(value) {
  const counters = {};
  const fields = [];
  const template = String(value || "").replace(STRUCTURAL_ATOM_RE, (atom) => {
    const type = classifyAtom(atom);
    counters[type] = Number(counters[type] || 0) + 1;
    const key = type + counters[type];
    fields.push({ key, type, value: atom });
    return "<" + key + ">";
  });
  return { template, fields };
}

function semanticLine(value) {
  return String(value || "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[ \t]+$/g, "");
}

function shorten(value, limit = 52) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  const left = Math.max(12, Math.floor((limit - 1) * 0.6));
  return text.slice(0, left) + "…" + text.slice(-(limit - left - 1));
}

function comparableMeasurement(value, type) {
  const match = String(value).match(/^([-+]?\d+(?:\.\d+)?)([%A-Za-zµ]+)?$/);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = match[2] || "";
  if (type === "n" && !unit) return amount;
  if (type === "pct" && unit === "%") return amount;
  if (type === "dur") {
    const scale = {
      ns: 1,
      us: 1_000,
      "µs": 1_000,
      ms: 1_000_000,
      s: 1_000_000_000,
      min: 60_000_000_000,
      h: 3_600_000_000_000,
      d: 86_400_000_000_000,
    }[unit];
    return scale ? amount * scale : null;
  }
  if (type === "size") {
    const scale = {
      B: 1,
      KB: 1_000,
      MB: 1_000_000,
      GB: 1_000_000_000,
      TB: 1_000_000_000_000,
      KiB: 1_024,
      MiB: 1_048_576,
      GiB: 1_073_741_824,
    }[unit];
    return scale ? amount * scale : null;
  }
  return null;
}

function summarizeColumn(values, type) {
  const unique = [...new Set(values.map(String))];
  if (unique.length === 1) return shorten(unique[0]);
  if (["n", "pct", "dur", "size"].includes(type)) {
    const numeric = unique.map((value) => ({
      raw: value,
      number: comparableMeasurement(value, type),
    }));
    if (numeric.every((item) => item.number !== null && Number.isFinite(item.number))) {
      numeric.sort((left, right) => left.number - right.number);
      return shorten(numeric[0].raw) + ".." + shorten(numeric.at(-1).raw) +
        " (" + unique.length + " distinct)";
    }
  }
  const samples = unique.length <= 3
    ? unique
    : [unique[0], unique[1], unique.at(-1)];
  return samples.map((value) => shorten(value, 36)).join("|") +
    (unique.length > 3 ? " (" + unique.length + " distinct)" : "");
}

function latticeCandidate(items) {
  const parsed = items.map((item) => ({
    ...item,
    structure: structuralLine(item.semantic),
  }));
  const grouped = new Map();
  for (const item of parsed) {
    if (!item.structure.fields.length || item.structure.template.length < 4) continue;
    if (!grouped.has(item.structure.template)) grouped.set(item.structure.template, []);
    grouped.get(item.structure.template).push(item);
  }
  const groups = [...grouped.entries()]
    .map(([template, rows]) => ({ template, rows }))
    .filter((group) => group.rows.length >= 4)
    .sort((left, right) => right.rows.length - left.rows.length);
  const covered = new Set(groups.flatMap((group) => group.rows.map((row) => row.index)));
  if (covered.size < 8 || covered.size / items.length < 0.45) return null;

  const critical = items.filter((item) => CRITICAL_RE.test(item.raw));
  const criticalChars = critical.reduce((sum, item) => sum + item.raw.length, 0);
  if (critical.length > 16 || criticalChars > 1400) return null;

  const body = [];
  let bodyChars = 0;
  const emittedIndexes = new Set();
  for (const item of critical) {
    const entry = "! " + item.raw;
    body.push(entry);
    bodyChars += entry.length;
    emittedIndexes.add(item.index);
  }
  let shownGroups = 0;
  for (const group of groups.slice(0, 24)) {
    const columns = group.rows[0].structure.fields.slice(0, 6).map((field, index) => {
      const values = group.rows.map((row) => row.structure.fields[index]?.value || "");
      return field.key + "=" + summarizeColumn(values, field.type);
    });
    if (group.rows[0].structure.fields.length > 6) {
      columns.push("+" + (group.rows[0].structure.fields.length - 6) + " fields");
    }
    const entry = "~ " + group.rows.length + "x " + shorten(group.template, 280) +
      "\n  " + columns.join("; ");
    if (bodyChars + entry.length > 2600) break;
    body.push(entry);
    bodyChars += entry.length;
    shownGroups += 1;
  }
  if (!shownGroups) return null;

  const ungrouped = items.filter((item) => !covered.has(item.index));
  const selected = [];
  const selectedIndexes = new Set();
  function add(item) {
    if (!item || selectedIndexes.has(item.index) || emittedIndexes.has(item.index)) return;
    selectedIndexes.add(item.index);
    selected.push(item);
  }
  for (const item of ungrouped.slice(0, 16)) add(item);
  for (const item of ungrouped.slice(-8)) add(item);
  selected.sort((left, right) => left.index - right.index);
  for (const item of selected) {
    const entry = "+ " + item.raw;
    if (bodyChars + entry.length > 3200) break;
    body.push(entry);
    bodyChars += entry.length;
    emittedIndexes.add(item.index);
  }
  const hiddenUnique = ungrouped.filter((item) => !emittedIndexes.has(item.index)).length;
  if (hiddenUnique) body.push("+ … " + hiddenUnique + " other unique lines in exact capsule");
  const coverage = ((covered.size / items.length) * 100).toFixed(1);
  return {
    mode: "lattice",
    projection: "[Capsule terminal lattice; structured=" + covered.size + "/" + items.length +
      " (" + coverage + "%); groups=" + groups.length + "; shown=" + shownGroups +
      "; unique=" + ungrouped.length + "; exact=" + PLACEHOLDER + "]\n" + body.join("\n"),
    structured: covered.size,
    groups: groups.length,
    novel: ungrouped.length,
    reused: 0,
  };
}

function emitBest(candidates, args, text, exactText) {
  const viable = candidates.filter(Boolean).filter((candidate) =>
    candidate.projection.length + 80 < text.length &&
    core.estimateTokens(candidate.projection) + 24 < core.estimateTokens(text)
  ).sort((left, right) => {
    const tokenDelta = core.estimateTokens(left.projection) - core.estimateTokens(right.projection);
    return tokenDelta || left.projection.length - right.projection.length;
  });
  if (!viable.length) return null;
  const chosen = viable[0];
  const capsuleId = String(args.capsule_id || "") || core.saveCapsule({
    kind: "terminal-" + chosen.mode,
    source: "terminal:" + digest(args.command || "shell").slice(0, 20),
    text: exactText,
    question: "",
    maxChars: 1200,
    details: {
      command_hash: digest(args.command || "shell").slice(0, 20),
      session_id: String(args.session_id || ""),
      project_dir: String(args.cwd || ""),
      projection: chosen.mode,
    },
  }).response.capsule_id;
  const output = chosen.projection.replace(PLACEHOLDER, capsuleId);
  return {
    ...chosen,
    projection: undefined,
    output,
    capsule_id: capsuleId,
    raw_chars: text.length,
    emitted_chars: output.length,
  };
}

function project(args = {}) {
  if (process.env.CAPSULE_TERMINAL_GENOME === "0" ||
      args.success === false ||
      args.require_literal === true) return null;
  const file = stateFile(args);
  const text = String(args.text || "");
  const exactText = String(args.exact_text || text);
  if (text.length < MINIMUM_CHARS || text.length > MAXIMUM_CHARS || /^\s*\[Capsule\b/.test(text)) return null;
  const redacted = compat.redact(text).replace(/\r\n?/g, "\n");
  const rawLines = redacted.split("\n");
  if (rawLines.length > 30000) return null;
  const now = Date.now();
  const state = file ? readState(file) : { version: 2, seen: {} };
  const prior = Object.fromEntries(
    Object.entries(state.seen || {})
      .filter(([, at]) => now - Number(at || 0) <= MAX_AGE_MS)
      .sort((left, right) => Number(right[1]) - Number(left[1]))
      .slice(0, MAX_HASHES)
  );
  const priorHashes = new Set(Object.keys(prior));
  const items = rawLines.map((raw, index) => {
    const semantic = semanticLine(raw);
    return {
      index,
      raw,
      semantic,
      hash: semantic.trim() ? digest(semantic).slice(0, 20) : "",
    };
  }).filter((item) => item.semantic.trim());
  if (!items.length) return null;
  const reusedItems = items.filter((item) => priorHashes.has(item.hash));
  const novelItems = items.filter((item) => !priorHashes.has(item.hash));
  const updated = { ...prior };
  for (const item of items) updated[item.hash] = now;
  const trimmed = Object.fromEntries(
    Object.entries(updated)
      .sort((left, right) => Number(right[1]) - Number(left[1]))
      .slice(0, MAX_HASHES)
  );
  if (file) writeState(file, { version: 2, seen: trimmed });
  const lattice = process.env.CAPSULE_TERMINAL_LATTICE === "0"
    ? null
    : latticeCandidate(items);
  if (!priorHashes.size || reusedItems.length < 3 || reusedItems.length / items.length < 0.35) {
    return emitBest([lattice], args, text, exactText);
  }

  const selected = [];
  const selectedIndexes = new Set();
  function add(item) {
    if (!item || selectedIndexes.has(item.index)) return;
    selectedIndexes.add(item.index);
    selected.push(item);
  }
  const critical = items.filter((item) => CRITICAL_RE.test(item.raw));
  const criticalChars = critical.reduce((sum, item) => sum + item.raw.length, 0);
  if (critical.length > 16 || criticalChars > 1200) {
    return emitBest([lattice], args, text, exactText);
  }
  for (const item of critical) add(item);
  for (const item of novelItems.slice(0, 24)) add(item);
  for (const item of novelItems.slice(-12)) add(item);
  selected.sort((left, right) => left.index - right.index);
  const body = [];
  let bodyChars = 0;
  const emittedIndexes = new Set();
  for (const item of selected) {
    if (bodyChars + item.raw.length + 2 > 1800) break;
    body.push("+ " + item.raw);
    bodyChars += item.raw.length + 2;
    emittedIndexes.add(item.index);
  }
  if (!body.length) body.push("~ no new semantic lines");
  const shownNovel = novelItems.filter((item) => emittedIndexes.has(item.index)).length;
  const coverage = ((reusedItems.length / items.length) * 100).toFixed(1);
  const header = "[Capsule terminal genome; reused=" + reusedItems.length + "/" + items.length +
    " (" + coverage + "%); novel=" + novelItems.length + "; shown=" + shownNovel +
    "; exact=" + PLACEHOLDER + "]";
  const candidate = header + "\n" + body.join("\n");
  const genome = {
    mode: "genome",
    projection: candidate,
    reused: reusedItems.length,
    novel: novelItems.length,
  };
  return emitBest([genome, lattice], args, text, exactText);
}

module.exports = {
  comparableMeasurement,
  latticeCandidate,
  project,
  reset,
  semanticLine,
  stateFile,
  structuralLine,
};
