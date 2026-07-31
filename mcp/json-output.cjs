"use strict";

const crypto = require("node:crypto");

const SECRET_KEY_RE = /^(?:api[_-]?(?:key|token)|access[_-]?token|auth[_-]?token|authorization|cookie|credential|password|passwd|private[_-]?key|secret|token)$/i;
const SECRET_KEY_COMPACT = new Set([
  "apikey", "apitoken", "accesstoken", "authtoken", "authorization", "cookie",
  "credential", "password", "passwd", "privatekey", "secret", "token",
]);
const IDENTITY_KEY_RE = /^(?:id|.*_id|url|uri|href|ref|ref_id|name|title|path|file|filename|source|type|kind|key|slug|html_url)$/i;
const STATUS_KEY_RE = /^(?:status|state|success|ok|passed|failed|exit_code|code|result|total|count)$/i;
const ERROR_KEY_RE = /^(?:error|errors|message|reason|warning|warnings|diagnostic|diagnostics|stderr|exception|traceback)$/i;
const SIGNAL_VALUE_RE = /\b(?:error|exception|fatal|fail(?:ed|ure)?|panic|timeout|traceback|warn(?:ing)?)\b/i;
const MAX_QUERY_TERMS = 32;
const MAX_INVENTORY_NODES = 20_000;
const MAX_INVENTORY_CHARS = 4_000_000;

function isSecretKey(value) {
  const key = String(value || "");
  const compact = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return SECRET_KEY_RE.test(key) ||
    SECRET_KEY_COMPACT.has(compact) ||
    /(?:apikey|apitoken|accesstoken|authtoken|authorization|credential|password|passwd|privatekey|secret|token)$/.test(compact);
}

function tokenize(value) {
  return [...new Set(
    [...String(value || "").toLowerCase().matchAll(/[\p{L}\p{N}_$.-]{2,}/gu)]
      .map((match) => match[0])
  )].slice(0, MAX_QUERY_TERMS);
}

function parseJsonOutput(text) {
  const source = String(text || "").replace(/\r\n?/g, "\n");
  const trimmed = source.trim();
  if (!trimmed) return null;
  if (!/^# stdout(?:\n|$)/i.test(trimmed)) {
    try {
      return { value: JSON.parse(trimmed), envelope: false, stderr: "", source };
    } catch {
      return null;
    }
  }

  const body = trimmed.replace(/^# stdout[ \t]*(?:\n|$)/i, "");
  const marker = body.search(/\n# stderr[ \t]*(?:\n|$)/i);
  const stdout = (marker >= 0 ? body.slice(0, marker) : body).trim();
  const stderr = marker >= 0
    ? body.slice(marker).replace(/^\n# stderr[ \t]*(?:\n|$)/i, "").trim()
    : "";
  try {
    return { value: JSON.parse(stdout), envelope: true, stderr, source };
  } catch {
    return null;
  }
}

function sanitizedScalar(value, options, key, stats) {
  if (isSecretKey(key)) {
    stats.redactions += 1;
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    const safe = options.redactString ? String(options.redactString(value)) : value;
    if (safe !== value) stats.redactions += 1;
    return safe;
  }
  return value;
}

function sanitizeJson(value, options, key = "", stats = { redactions: 0 }) {
  const root = sanitizedScalar(value, options, key, stats);
  if (!root || typeof root !== "object") return root;

  const output = Array.isArray(root) ? [] : Object.create(null);
  const seen = new WeakSet([root]);
  const stack = [{
    input: root,
    output,
    entries: Array.isArray(root)
      ? root.map((child, index) => [index, child, ""])
      : Object.entries(root).map(([childKey, child]) => [childKey, child, childKey]),
    index: 0,
  }];
  while (stack.length) {
    const frame = stack.at(-1);
    if (frame.index >= frame.entries.length) {
      stack.pop();
      seen.delete(frame.input);
      continue;
    }
    const [outputKey, child, childKey] = frame.entries[frame.index++];
    const safeChild = sanitizedScalar(child, options, childKey, stats);
    if (!safeChild || typeof safeChild !== "object") {
      frame.output[outputKey] = safeChild;
      continue;
    }
    if (seen.has(safeChild)) throw new TypeError("Converting circular structure to JSON");
    seen.add(safeChild);
    const safeOutput = Array.isArray(safeChild) ? [] : Object.create(null);
    frame.output[outputKey] = safeOutput;
    stack.push({
      input: safeChild,
      output: safeOutput,
      entries: Array.isArray(safeChild)
        ? safeChild.map((nested, index) => [index, nested, ""])
        : Object.entries(safeChild).map(([nestedKey, nested]) => [nestedKey, nested, nestedKey]),
      index: 0,
    });
  }
  return output;
}

function inventory(value, queryTerms) {
  const state = {
    nodes: 0,
    chars: 0,
    depth: 0,
    exceeded: false,
    matchedTerms: new Set(),
  };
  const stack = [{ item: value, key: "", depth: 0 }];
  while (stack.length && !state.exceeded) {
    const { item, key, depth } = stack.pop();
    state.nodes += 1;
    state.depth = Math.max(state.depth, depth);
    if (state.nodes > MAX_INVENTORY_NODES || depth > 128) {
      state.exceeded = true;
      break;
    }
    if (key) {
      state.chars += key.length;
      const lowerKey = key.toLowerCase();
      for (const term of queryTerms) {
        if (lowerKey.includes(term)) state.matchedTerms.add(term);
      }
    }
    if (typeof item === "string") {
      state.chars += item.length;
      const lower = item.toLowerCase();
      for (const term of queryTerms) {
        if (lower.includes(term)) state.matchedTerms.add(term);
      }
    } else if (Array.isArray(item)) {
      for (let index = item.length - 1; index >= 0; index -= 1) {
        stack.push({ item: item[index], key: "", depth: depth + 1 });
      }
    } else if (item && typeof item === "object") {
      const entries = Object.entries(item);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [childKey, child] = entries[index];
        stack.push({ item: child, key: childKey, depth: depth + 1 });
      }
    }
    if (state.chars > MAX_INVENTORY_CHARS) state.exceeded = true;
  }
  return state;
}

function stringifyJsonIterative(value) {
  const output = [];
  const stack = [{ type: "value", value, arrayValue: false }];
  while (stack.length) {
    const item = stack.pop();
    if (item.type === "text") {
      output.push(item.value);
      continue;
    }
    const current = item.value;
    if (current === null) {
      output.push("null");
    } else if (typeof current === "string") {
      output.push(JSON.stringify(current));
    } else if (typeof current === "number") {
      output.push(Number.isFinite(current) ? String(current) : "null");
    } else if (typeof current === "boolean") {
      output.push(current ? "true" : "false");
    } else if (Array.isArray(current)) {
      stack.push({ type: "text", value: "]" });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        if (index < current.length - 1) stack.push({ type: "text", value: "," });
        stack.push({ type: "value", value: current[index], arrayValue: true });
      }
      stack.push({ type: "text", value: "[" });
    } else if (current && typeof current === "object") {
      const entries = Object.entries(current)
        .filter(([, child]) => !["undefined", "function", "symbol"].includes(typeof child));
      stack.push({ type: "text", value: "}" });
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [childKey, child] = entries[index];
        if (index < entries.length - 1) stack.push({ type: "text", value: "," });
        stack.push({ type: "value", value: child, arrayValue: false });
        stack.push({ type: "text", value: ":" });
        stack.push({ type: "text", value: JSON.stringify(childKey) });
      }
      stack.push({ type: "text", value: "{" });
    } else {
      output.push(item.arrayValue ? "null" : "null");
    }
  }
  return output.join("");
}

function matchedTerms(value, queryTerms) {
  if (!queryTerms.length) return [];
  let serialized;
  try {
    serialized = JSON.stringify(value).toLowerCase();
  } catch {
    return [];
  }
  return queryTerms.filter((term) => serialized.includes(term));
}

function signalScore(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return typeof value === "string" && SIGNAL_VALUE_RE.test(value) ? 1 : 0;
  }
  let score = 0;
  for (const [key, child] of Object.entries(value)) {
    if (ERROR_KEY_RE.test(key)) score += 4;
    else if (STATUS_KEY_RE.test(key)) score += 2;
    if (typeof child === "string" && SIGNAL_VALUE_RE.test(child)) score += 1;
  }
  return score;
}

function querySnippet(value, queryTerms, limit) {
  const text = String(value);
  if (text.length <= limit) return text;
  const lower = text.toLowerCase();
  let index = -1;
  for (const term of queryTerms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (index < 0 || found < index)) index = found;
  }
  if (index < 0) index = 0;
  const room = Math.max(24, limit - 2);
  const start = Math.max(0, Math.min(index - Math.floor(room / 3), text.length - room));
  const end = Math.min(text.length, start + room);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function projectedString(value, queryTerms, limit, identity) {
  const hardLimit = identity ? Math.max(limit, 1_024) : limit;
  if (value.length <= hardLimit) return value;
  const preview = querySnippet(value, queryTerms, hardLimit);
  return {
    _capsule_text_preview: preview,
    _capsule_chars: value.length,
    _capsule_omitted_chars: Math.max(0, value.length - preview.length),
    _capsule_sha256: crypto.createHash("sha256").update(value).digest("hex").slice(0, 16),
  };
}

function fieldPriority(key, value, queryTerms) {
  const lowerKey = key.toLowerCase();
  const hits = matchedTerms({ [key]: value }, queryTerms).length;
  if (hits) return 1_000 + hits * 50;
  if (ERROR_KEY_RE.test(key)) return 800;
  if (IDENTITY_KEY_RE.test(key)) return 700;
  if (STATUS_KEY_RE.test(key)) return 600;
  if (["matches", "items", "results", "data"].includes(lowerKey)) return 500;
  return 100;
}

function projectionConfig(level) {
  return [
    { maxFields: 14, stringLimit: 512, arrayItems: 5, depth: 3 },
    { maxFields: 9, stringLimit: 256, arrayItems: 3, depth: 2 },
    { maxFields: 6, stringLimit: 144, arrayItems: 2, depth: 2 },
    { maxFields: 4, stringLimit: 96, arrayItems: 1, depth: 1 },
  ][Math.max(0, Math.min(3, level))];
}

function selectArrayEntries(values, queryTerms, limit) {
  return values
    .map((value, index) => ({
      value,
      index,
      hits: matchedTerms(value, queryTerms),
      signal: signalScore(value),
    }))
    .sort((a, b) => b.hits.length - a.hits.length || b.signal - a.signal || a.index - b.index)
    .slice(0, limit);
}

function projectTerminalObject(value, queryTerms, config) {
  const entries = Object.entries(value)
    .map(([key, child], index) => ({ key, child, index, priority: fieldPriority(key, child, queryTerms) }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index);
  const chosen = entries.slice(0, Math.min(4, config.maxFields));
  const result = Object.create(null);
  for (const entry of chosen) {
    if (typeof entry.child === "string") {
      result[entry.key] = projectedString(
        entry.child,
        queryTerms,
        config.stringLimit,
        IDENTITY_KEY_RE.test(entry.key)
      );
    } else if (entry.child == null || typeof entry.child !== "object") {
      result[entry.key] = entry.child;
    } else {
      const serialized = JSON.stringify(entry.child);
      result[entry.key] = {
        _capsule_value_type: Array.isArray(entry.child) ? "array" : "object",
        _capsule_preview: querySnippet(serialized, queryTerms, config.stringLimit),
        _capsule_chars: serialized.length,
      };
    }
  }
  if (entries.length > chosen.length) result._capsule_omitted_fields = entries.length - chosen.length;
  return result;
}

function projectValue(value, queryTerms, config, depth = 0) {
  if (typeof value === "string") {
    return projectedString(value, queryTerms, config.stringLimit, false);
  }
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const itemLimit = depth >= config.depth ? 1 : config.arrayItems;
    const chosen = selectArrayEntries(value, queryTerms, itemLimit);
    return {
      _capsule_array: {
        total_items: value.length,
        shown_items: chosen.length,
        omitted_items: Math.max(0, value.length - chosen.length),
        query_matches_total: value.filter((item) => matchedTerms(item, queryTerms).length).length,
        query_matches_shown: chosen.filter((entry) => entry.hits.length).length,
      },
      items: chosen.map((entry) => {
        const projected = depth >= config.depth && entry.value && typeof entry.value === "object" && !Array.isArray(entry.value)
          ? projectTerminalObject(entry.value, queryTerms, config)
          : projectValue(entry.value, queryTerms, config, depth + 1);
        if (projected && typeof projected === "object" && !Array.isArray(projected)) {
          return { ...projected, _capsule_source_index: entry.index };
        }
        return { _capsule_source_index: entry.index, value: projected };
      }),
    };
  }
  if (depth >= config.depth) return projectTerminalObject(value, queryTerms, config);

  const entries = Object.entries(value)
    .map(([key, child], index) => ({ key, child, index, priority: fieldPriority(key, child, queryTerms) }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index);
  const chosen = entries.slice(0, config.maxFields);
  const result = Object.create(null);
  for (const entry of chosen) {
    if (typeof entry.child === "string") {
      result[entry.key] = projectedString(
        entry.child,
        queryTerms,
        config.stringLimit,
        IDENTITY_KEY_RE.test(entry.key)
      );
    } else {
      result[entry.key] = projectValue(entry.child, queryTerms, config, depth + 1);
    }
  }
  if (entries.length > chosen.length) result._capsule_omitted_fields = entries.length - chosen.length;
  return result;
}

function projectionMetadata(rootType, totalItems, shownItems, queryMatches, queryShown, redactions) {
  return {
    version: 1,
    lossless: false,
    root_type: rootType,
    total_items: totalItems,
    shown_items: shownItems,
    omitted_items: Math.max(0, totalItems - shownItems),
    query_matches_total: queryMatches,
    query_matches_shown: queryShown,
    secret_redactions: redactions,
  };
}

function renderArrayProjection(value, queryTerms, matchedQueryTerms, maxChars, redactions) {
  const ranked = selectArrayEntries(value, queryTerms, value.length);
  const required = [];
  const covered = new Set();
  for (const entry of ranked) {
    const adds = entry.hits.some((term) => matchedQueryTerms.includes(term) && !covered.has(term));
    if (!adds) continue;
    required.push(entry.index);
    for (const term of entry.hits) covered.add(term);
    if (matchedQueryTerms.every((term) => covered.has(term))) break;
  }
  const requiredSet = new Set(required);
  const ordered = [
    ...ranked.filter((entry) => requiredSet.has(entry.index)),
    ...ranked.filter((entry) => !requiredSet.has(entry.index)),
  ];
  const queryMatches = ranked.filter((entry) => entry.hits.length).length;
  const items = [];
  for (const entry of ordered) {
    let accepted = null;
    for (let level = 0; level <= 3; level += 1) {
      const projected = projectValue(entry.value, queryTerms, projectionConfig(level), 0);
      const item = projected && typeof projected === "object" && !Array.isArray(projected)
        ? { ...projected, _capsule_source_index: entry.index }
        : { value: projected, _capsule_source_index: entry.index };
      const candidateItems = [...items, item];
      const queryShown = candidateItems.filter((candidate) => matchedTerms(candidate, queryTerms).length).length;
      const wrapper = {
        capsule_json_projection: projectionMetadata(
          "array",
          value.length,
          candidateItems.length,
          queryMatches,
          queryShown,
          redactions
        ),
        items: candidateItems,
      };
      const output = JSON.stringify(wrapper);
      if (output.length <= maxChars) {
        accepted = { item, output };
        break;
      }
    }
    if (!accepted) {
      if (requiredSet.has(entry.index)) return null;
      continue;
    }
    items.push(accepted.item);
  }
  if (!items.length && value.length) return null;
  const queryShown = items.filter((item) => matchedTerms(item, queryTerms).length).length;
  const wrapper = {
    capsule_json_projection: projectionMetadata(
      "array",
      value.length,
      items.length,
      queryMatches,
      queryShown,
      redactions
    ),
    items,
  };
  const output = JSON.stringify(wrapper);
  const itemText = JSON.stringify(items).toLowerCase();
  if (matchedQueryTerms.some((term) => !itemText.includes(term))) return null;
  return output.length <= maxChars ? output : null;
}

function renderObjectProjection(value, queryTerms, matchedQueryTerms, maxChars, redactions) {
  for (let level = 0; level <= 3; level += 1) {
    const projected = projectValue(value, queryTerms, projectionConfig(level), 0);
    const wrapper = {
      capsule_json_projection: projectionMetadata(
        "object",
        1,
        1,
        matchedQueryTerms.length ? 1 : 0,
        matchedQueryTerms.length ? 1 : 0,
        redactions
      ),
      value: projected,
    };
    const output = JSON.stringify(wrapper);
    const valueText = JSON.stringify(projected).toLowerCase();
    if (output.length <= maxChars && matchedQueryTerms.every((term) => valueText.includes(term))) return output;
  }
  return null;
}

function renderScalarProjection(value, queryTerms, matchedQueryTerms, maxChars, redactions) {
  const projected = projectValue(value, queryTerms, projectionConfig(3), 0);
  const wrapper = {
    capsule_json_projection: projectionMetadata(
      "scalar",
      1,
      1,
      matchedQueryTerms.length ? 1 : 0,
      matchedQueryTerms.length ? 1 : 0,
      redactions
    ),
    value: projected,
  };
  const output = JSON.stringify(wrapper);
  const valueText = JSON.stringify(projected).toLowerCase();
  return output.length <= maxChars && matchedQueryTerms.every((term) => valueText.includes(term)) ? output : null;
}

function projectJsonOutput(text, options = {}) {
  const parsed = parseJsonOutput(text);
  if (!parsed) return null;
  const raw = String(text || "");
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 4_000;
  const queryTerms = tokenize(options.query);
  const stats = { redactions: 0 };
  const safeValue = sanitizeJson(parsed.value, options, "", stats);
  const safeStderr = options.redactString ? String(options.redactString(parsed.stderr)) : parsed.stderr;
  if (safeStderr !== parsed.stderr) stats.redactions += 1;
  const semanticValue = parsed.stderr
    ? {
        capsule_json_envelope: { version: 1, stdout_json: true },
        stdout: safeValue,
        stderr: safeStderr,
      }
    : safeValue;
  const projectionValue = parsed.stderr ? semanticValue : safeValue;
  const scan = inventory(projectionValue, queryTerms);
  const minified = scan.depth > 128
    ? stringifyJsonIterative(semanticValue)
    : JSON.stringify(semanticValue);
  const matchedQueryTerms = [...scan.matchedTerms];
  const securityChanged = stats.redactions > 0;
  const modePrefix = securityChanged ? "redacted" : "lossless";
  const safePassthrough = () => ({
    route: "passthrough",
    output: minified.length <= raw.length || securityChanged ? minified : raw,
    raw_chars: raw.length,
    query_coverage: 1,
    json_mode: `${modePrefix}-passthrough`,
    secret_redactions: stats.redactions,
    ...(securityChanged ? { security_reason: "secret-redaction" } : {}),
  });

  if (minified.length <= maxChars) {
    if (minified.length >= raw.length) return safePassthrough();
    return {
      route: "compressed",
      output: minified,
      raw_chars: raw.length,
      query_coverage: 1,
      json_mode: `${modePrefix}-minified`,
      secret_redactions: stats.redactions,
      ...(securityChanged ? { security_reason: "secret-redaction" } : {}),
    };
  }

  if (scan.exceeded) return safePassthrough();

  let projected;
  if (Array.isArray(projectionValue)) {
    projected = renderArrayProjection(projectionValue, queryTerms, matchedQueryTerms, maxChars, stats.redactions);
  } else if (projectionValue && typeof projectionValue === "object") {
    projected = renderObjectProjection(projectionValue, queryTerms, matchedQueryTerms, maxChars, stats.redactions);
  } else {
    projected = renderScalarProjection(projectionValue, queryTerms, matchedQueryTerms, maxChars, stats.redactions);
  }

  if (
    !projected ||
    projected.length >= minified.length ||
    (projected.length >= raw.length && !securityChanged)
  ) return safePassthrough();
  return {
    route: "compressed",
    output: projected,
    raw_chars: raw.length,
    query_coverage: matchedQueryTerms.length
      ? matchedQueryTerms.filter((term) => projected.toLowerCase().includes(term)).length / matchedQueryTerms.length
      : 1,
    json_mode: "structured-projection",
    secret_redactions: stats.redactions,
  };
}

module.exports = { parseJsonOutput, projectJsonOutput, sanitizeJson, tokenize };
