"use strict";

// Layered memory loadouts for Capsule.
//
// This is deliberately a local, deterministic compiler rather than a second
// model. It keeps durable facts, task episodes, stable constraints, and
// optional raw traces in separate lanes, then emits only the smallest useful
// packet for the current query. The design is inspired by layered memory
// systems, but the storage format and scoring policy are Capsule-specific.

const fs = require("node:fs");
const path = require("node:path");
const core = require("./core.cjs");
const storage = require("./storage.cjs");

const LAYERS = Object.freeze({
  trace: Object.freeze({ code: "L0", weight: 0.35, share: 0.05, defaultImportance: 10 }),
  fact: Object.freeze({ code: "L1", weight: 0.85, share: 0.30, defaultImportance: 55 }),
  scenario: Object.freeze({ code: "L2", weight: 1.00, share: 0.40, defaultImportance: 70 }),
  profile: Object.freeze({ code: "L3", weight: 1.15, share: 0.25, defaultImportance: 85 }),
});

const LAYER_ALIASES = Object.freeze({
  l0: "trace", raw: "trace", trace: "trace", transcript: "trace",
  l1: "fact", fact: "fact", atom: "fact", atomic: "fact",
  l2: "scenario", scenario: "scenario", episode: "scenario", task: "scenario",
  l3: "profile", profile: "profile", persona: "profile", durable: "profile",
});

const DEFAULT_MAX_CHARS = 2_400;
const DEFAULT_MAX_RECORDS = 10_000;
const MAX_ITEM_CHARS = 16_000;
const MAX_PREVIEW_CHARS = 180;
const MAX_INDEX_PREVIEW_CHARS = 96;
const MAX_TAGS = 12;
const MAX_SOURCE_CHARS = 180;
const DAY_MS = 86_400_000;

const SECRET_RE = /\b(api[_-]?(?:key|token)|access[_-]?token|auth[_-]?token|authorization|cookie|credential|password|passwd|private[_-]?key|secret|token)\s*([:=])\s*(?:bearer\s+)?[^\s,;]+|\bbearer\s+[a-z0-9._~+/=-]+/ig;

function clamp(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function int(value, fallback, min, max) {
  return Math.trunc(clamp(value, fallback, min, max));
}

function hash(value) {
  return storage.sha256(value);
}

function tokenize(value) {
  return [...String(value || "").toLowerCase().matchAll(/[\p{L}\p{N}_$.-]{2,}/gu)]
    .map((match) => match[0]);
}

function redact(value) {
  return String(value || "")
    .replace(SECRET_RE, (match, name, separator) => name ? `${name}${separator}[REDACTED]` : "bearer [REDACTED]")
    .replace(/\b(?:sk|pk|ghp|github_pat)_[A-Za-z0-9_=-]{12,}\b/g, "[REDACTED_TOKEN]");
}

function compactText(value, maxChars = MAX_ITEM_CHARS) {
  const text = redact(String(value || "").replace(/\r\n?/g, "\n")).trim();
  if (text.length <= maxChars) return text;
  const head = Math.max(80, Math.floor(maxChars * 0.68));
  const tail = Math.max(40, maxChars - head - 32);
  return `${text.slice(0, head)}\n…[${text.length - head - tail} chars omitted]…\n${text.slice(-tail)}`;
}

function normalizeLayer(value, fallback = "fact") {
  const key = String(value || "").trim().toLowerCase();
  return LAYER_ALIASES[key] || fallback;
}

function normalizeScope(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const key of ["project", "task", "session", "user", "agent", "team"]) {
    if (typeof value[key] === "string" && value[key].trim()) out[key] = value[key].trim().slice(0, 180);
  }
  return out;
}

function scopeKey(scope = {}) {
  return ["team", "user", "agent", "project", "task", "session"]
    .map((key) => `${key}=${scope[key] || "*"}`)
    .join("|");
}

function scopeMatches(recordScope, requestedScope) {
  const requested = normalizeScope(requestedScope);
  for (const [key, value] of Object.entries(requested)) {
    if (recordScope[key] && recordScope[key] !== value) return false;
  }
  return true;
}

function memoryPaths() {
  const root = path.join(core.stateRoot(), "memory");
  return { root, store: path.join(root, "layers.json") };
}

function readStore() {
  const target = memoryPaths().store;
  try {
    const parsed = storage.readJson(target, null);
    if (parsed && Array.isArray(parsed.records)) {
      return {
        version: Number(parsed.version || 1),
        records: parsed.records.filter((item) => item && typeof item === "object"),
        metrics: parsed.metrics && typeof parsed.metrics === "object" ? parsed.metrics : {},
      };
    }
  } catch {
    // A malformed optional memory store is a cold start, not a reason to make
    // every other Capsule action fail. The shared reader handles missing and
    // malformed files; this catch protects future validation changes.
  }
  return { version: 1, records: [], metrics: {} };
}

function writeStore(store) {
  const state = memoryPaths();
  fs.mkdirSync(state.root, { recursive: true });
  storage.writeJsonAtomic(state.store, store, { pretty: true });
}

function nowIso() {
  return new Date().toISOString();
}

function timestamp(value, fallback = Date.now()) {
  const n = typeof value === "number" ? value : Date.parse(String(value || ""));
  return Number.isFinite(n) ? n : fallback;
}

function layerBudgets(maxChars, requested = {}) {
  const result = {};
  let remaining = maxChars;
  const keys = ["profile", "scenario", "fact", "trace"];
  for (const key of keys) {
    const supplied = Number(requested[key]);
    const share = LAYERS[key].share;
    const value = Number.isFinite(supplied) ? Math.max(0, Math.trunc(supplied)) : Math.floor(maxChars * share);
    result[key] = value;
    remaining -= value;
  }
  // Rounding should never make a caller's hard budget smaller than necessary.
  if (remaining > 0) result.scenario += remaining;
  return result;
}

function recordText(record) {
  return typeof record.text === "string" && record.text ? record.text : String(record.preview || "");
}

function ageDays(record, now = Date.now()) {
  return Math.max(0, (now - timestamp(record.updated_at || record.created_at)) / DAY_MS);
}

function expired(record, now = Date.now()) {
  return record.expires_at != null && timestamp(record.expires_at, 0) <= now;
}

function utility(record, now = Date.now()) {
  const layer = LAYERS[normalizeLayer(record.layer)];
  const freshness = Math.max(0.08, Math.exp(-ageDays(record, now) / (record.layer === "profile" ? 180 : 45)));
  const useBoost = Math.min(0.18, Number(record.uses || 0) * 0.01);
  return (layer?.weight || 0.8) * (0.45 + clamp(record.confidence, 0.8, 0, 1) * 0.35 + clamp(record.importance, 50, 0, 100) / 100 * 0.2) * freshness + useBoost;
}

function inferLayer(input) {
  if (input.layer != null) return normalizeLayer(input.layer);
  const kind = String(input.kind || input.type || "").toLowerCase();
  if (/profile|persona|preference|constraint|policy/.test(kind)) return "profile";
  if (/scenario|episode|task|decision|milestone/.test(kind)) return "scenario";
  if (/trace|raw|transcript|log/.test(kind)) return "trace";
  return "fact";
}

function normalizedTags(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(list.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, MAX_TAGS);
}

// A loadout is a small, deterministic binding for retrieval.  It is the
// local equivalent of selecting only the team/agent assets needed for a turn:
// a caller can constrain layers, tags, sources, and scope before ranking.
// Nothing is fetched remotely and no provider-specific schema is required.
function normalizeLoadout(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      applied: false,
      layers: new Set(),
      tags: new Set(),
      sources: new Set(),
      scope: {},
      tagMode: "any",
      strictScope: false,
      strategy: "all",
    };
  }
  const layerValues = Array.isArray(value.layers)
    ? value.layers
    : Array.isArray(value.asset_types) ? value.asset_types : [];
  const sourceValues = Array.isArray(value.sources)
    ? value.sources
    : typeof value.source === "string" ? [value.source] : [];
  const layers = new Set(layerValues.map((item) => normalizeLayer(item)).filter(Boolean));
  const tags = new Set(normalizedTags(value.tags || value.labels));
  const sources = new Set(sourceValues.map((item) => String(item).trim().toLowerCase()).filter(Boolean));
  const scope = normalizeScope(value.scope);
  const tagMode = String(value.tag_mode || value.tagMode || "any").toLowerCase() === "all" ? "all" : "any";
  const strictScope = value.strict_scope === true || value.require_scope === true;
  const strategy = String(value.strategy || value.retrieval || "all").toLowerCase() === "bootstrap" ? "bootstrap" : "all";
  return {
    applied: layers.size > 0 || tags.size > 0 || sources.size > 0 || Object.keys(scope).length > 0 || strictScope || strategy !== "all",
    layers,
    tags,
    sources,
    scope,
    tagMode,
    strictScope,
    strategy,
  };
}

function loadoutMatches(record, loadout) {
  if (!loadout.applied) return true;
  const layer = normalizeLayer(record.layer);
  if (loadout.layers.size && !loadout.layers.has(layer)) return false;
  if (loadout.tags.size) {
    const recordTags = new Set(normalizedTags(record.tags));
    const matches = loadout.tagMode === "all"
      ? [...loadout.tags].every((tag) => recordTags.has(tag))
      : [...loadout.tags].some((tag) => recordTags.has(tag));
    if (!matches) return false;
  }
  if (loadout.sources.size && !loadout.sources.has(String(record.source || "").trim().toLowerCase())) return false;
  const recordScope = normalizeScope(record.scope);
  for (const [key, value] of Object.entries(loadout.scope)) {
    if (loadout.strictScope ? recordScope[key] !== value : (recordScope[key] && recordScope[key] !== value)) return false;
  }
  return true;
}

function loadoutSummary(loadout) {
  return {
    applied: loadout.applied,
    layers: [...loadout.layers],
    tags: [...loadout.tags],
    sources: [...loadout.sources],
    scope: loadout.scope,
    tag_mode: loadout.tagMode,
    strict_scope: loadout.strictScope,
    strategy: loadout.strategy,
    policy: "deterministic pre-ranking binding; only matching memory assets enter the candidate set",
  };
}

function applyRetrievalStrategy(candidates, loadout) {
  if (loadout.strategy !== "bootstrap") return { candidates, filtered: 0, stage: "all" };
  const highLevel = candidates.filter((item) => {
    const layer = normalizeLayer(item.record.layer);
    return layer === "profile" || layer === "scenario";
  });
  if (highLevel.length) {
    return { candidates: highLevel, filtered: candidates.length - highLevel.length, stage: "profile-scenario" };
  }
  return { candidates, filtered: 0, stage: "fallback-all" };
}

function makeRecord(input, options = {}, existing = null) {
  const layer = inferLayer(input);
  const rawText = compactText(input.content ?? input.text ?? input.summary, int(input.max_chars, MAX_ITEM_CHARS, 120, MAX_ITEM_CHARS));
  if (!rawText) throw new Error("memory item content is required");
  const scope = normalizeScope(input.scope || options.scope);
  const retainRaw = options.retain_raw === true || input.retain_raw === true;
  const isTrace = layer === "trace";
  const contentHash = hash(`${scopeKey(scope)}\0${layer}\0${rawText}`);
  const created = existing?.created_at || nowIso();
  const record = {
    id: existing?.id || `mem_${contentHash.slice(0, 20)}`,
    layer,
    text: isTrace && !retainRaw ? null : rawText,
    preview: isTrace && !retainRaw ? rawText.slice(0, MAX_PREVIEW_CHARS) : undefined,
    content_hash: contentHash,
    source: String(input.source || options.source || "explicit").slice(0, MAX_SOURCE_CHARS),
    tags: normalizedTags(input.tags || options.tags),
    scope,
    confidence: Number(clamp(input.confidence, 0.8, 0, 1).toFixed(4)),
    importance: Number(clamp(input.importance, LAYERS[layer].defaultImportance, 0, 100).toFixed(2)),
    created_at: created,
    updated_at: nowIso(),
    expires_at: input.expires_at || options.expires_at || null,
    uses: Number(existing?.uses || 0),
    last_used_at: existing?.last_used_at || null,
    status: "active",
  };
  if (record.preview === undefined) delete record.preview;
  return record;
}

function capture(args = {}) {
  const inputs = Array.isArray(args.items)
    ? args.items
    : args.content != null || args.text != null || args.summary != null ? [args] : [];
  if (!inputs.length) throw new Error("content or items is required");
  const store = readStore();
  const touched = [];
  let capturedChars = 0;
  for (const input of inputs) {
    if (!input || typeof input !== "object") continue;
    const raw = String(input.content ?? input.text ?? input.summary ?? "");
    capturedChars += raw.length;
    const layer = inferLayer(input);
    const scope = normalizeScope(input.scope || args.scope);
    const provisional = compactText(raw, int(input.max_chars, MAX_ITEM_CHARS, 120, MAX_ITEM_CHARS));
    if (!provisional) continue;
    const contentHash = hash(`${scopeKey(scope)}\0${layer}\0${provisional}`);
    const existingIndex = store.records.findIndex((item) => item.content_hash === contentHash && item.status !== "deleted");
    const existing = existingIndex >= 0 ? store.records[existingIndex] : null;
    const record = makeRecord({ ...input, content: provisional, layer }, args, existing);
    if (existingIndex >= 0) store.records[existingIndex] = record;
    else store.records.push(record);
    touched.push({ id: record.id, layer: record.layer, deduplicated: Boolean(existing), chars: recordText(record).length });
  }
  const limit = int(args.max_records, DEFAULT_MAX_RECORDS, 100, 50_000);
  if (store.records.length > limit) {
    store.records = store.records
      .filter((record) => !expired(record))
      .sort((left, right) => utility(right) - utility(left))
      .slice(0, limit);
  }
  store.metrics.captures = Number(store.metrics.captures || 0) + inputs.length;
  store.metrics.deduplicated = Number(store.metrics.deduplicated || 0) + touched.filter((item) => item.deduplicated).length;
  writeStore(store);
  return {
    response: {
      operation: "capture",
      route: "memory-layer-capture",
      stored: touched.length,
      items: touched,
      layers: touched.reduce((out, item) => { out[item.layer] = (out[item.layer] || 0) + 1; return out; }, {}),
      raw_retained: touched.some((item) => item.layer === "trace" && Boolean(store.records.find((record) => record.id === item.id)?.text)),
      privacy: "explicit-content-only; secrets redacted; trace text is digest/preview unless retain_raw=true",
    },
    capturedChars,
  };
}

function lexicalScore(record, queryTerms, queryPhrase, requestedScope, now) {
  const text = recordText(record).toLowerCase();
  if (!text) return 0;
  const matched = queryTerms.filter((term) => text.includes(term));
  const coverage = queryTerms.length ? matched.length / queryTerms.length : 0.35;
  const phrase = queryPhrase && text.includes(queryPhrase) ? 0.35 : 0;
  const scopeBoost = Object.keys(normalizeScope(requestedScope)).filter((key) => record.scope?.[key] === requestedScope[key]).length * 0.08;
  const freshness = Math.max(0.08, Math.exp(-ageDays(record, now) / (record.layer === "profile" ? 180 : 45)));
  const confidence = clamp(record.confidence, 0.8, 0, 1);
  const importance = clamp(record.importance, 50, 0, 100) / 100;
  return (coverage * 0.62 + phrase + scopeBoost + freshness * 0.16 + confidence * 0.12 + importance * 0.10) * LAYERS[record.layer].weight;
}

function overlap(left, right) {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / Math.max(a.size, b.size);
}

function renderItem(record, score, maxChars = Number.POSITIVE_INFINITY) {
  const code = LAYERS[record.layer].code;
  // Keep provenance in the structured `items` field. The model-visible packet
  // carries only the layer marker and memory text so metadata cannot erase the
  // savings for short facts.
  const prefix = `[${code}] `;
  const text = recordText(record).replace(/\s+/g, " ").trim();
  const room = Math.max(0, Math.floor(maxChars - prefix.length));
  if (!Number.isFinite(maxChars) || text.length <= room) return `${prefix}${text}`;
  if (room <= 1) return prefix.slice(0, Math.max(0, Math.floor(maxChars)));
  if (room < 32) return `${prefix}${text.slice(0, Math.max(1, room - 1))}…`.slice(0, maxChars);
  return `${prefix}${compactText(text, room)}`;
}

function recall(args = {}) {
  const query = String(args.query ?? args.question ?? "").trim();
  const queryTerms = [...new Set(tokenize(query))];
  const queryPhrase = query.toLowerCase();
  const maxChars = int(args.max_chars, DEFAULT_MAX_CHARS, 240, 24_000);
  const budgets = layerBudgets(maxChars, args.layer_budgets || args.layerBudgets);
  const wantedLayers = Array.isArray(args.layers) && args.layers.length
    ? new Set(args.layers.map((item) => normalizeLayer(item)))
    : new Set(Object.keys(LAYERS));
  const requestedScope = normalizeScope(args.scope);
  const loadout = normalizeLoadout(args.loadout || args.binding);
  const store = readStore();
  const now = Date.now();
  let candidates = [];
  let expiredCount = 0;
  let hiddenTraceCount = 0;
  let loadoutFilteredCount = 0;
  for (const record of store.records) {
    if (!record || record.status === "deleted" || !wantedLayers.has(normalizeLayer(record.layer))) continue;
    if (!loadoutMatches(record, loadout)) { loadoutFilteredCount += 1; continue; }
    if (!scopeMatches(record.scope || {}, requestedScope)) continue;
    if (expired(record, now)) { expiredCount += 1; continue; }
    if (normalizeLayer(record.layer) === "trace" && !record.text) hiddenTraceCount += 1;
    const text = recordText(record);
    if (!text) continue;
    if (queryTerms.length && !queryTerms.some((term) => text.toLowerCase().includes(term))) continue;
    const score = queryTerms.length ? lexicalScore(record, queryTerms, queryPhrase, requestedScope, now) : utility(record, now);
    if (queryTerms.length && score < clamp(args.min_score, 0, 0, 2)) continue;
    candidates.push({ record, score });
  }
  const retrieval = applyRetrievalStrategy(candidates, loadout);
  candidates = retrieval.candidates;
  candidates.sort((left, right) => right.score - left.score || timestamp(right.record.updated_at) - timestamp(left.record.updated_at));

  const selected = [];
  const usedChars = Object.fromEntries(Object.keys(LAYERS).map((key) => [key, 0]));
  for (const candidate of candidates) {
    if (selected.length >= int(args.max_items, 24, 1, 100)) break;
    const layer = normalizeLayer(candidate.record.layer);
    const available = budgets[layer] - usedChars[layer];
    if (available < 24) continue;
    const line = renderItem(candidate.record, candidate.score, available);
    const lineChars = line.length + (selected.length ? 1 : 0);
    if (usedChars[layer] + lineChars > budgets[layer]) continue;
    if (selected.some((item) => overlap(recordText(item.record), recordText(candidate.record)) >= 0.92)) continue;
    selected.push(candidate);
    usedChars[layer] += lineChars;
  }
  // If a small budget made every lane empty, keep one highest-value item. This
  // prevents a useful profile fact from disappearing due to integer rounding.
  if (!selected.length && candidates.length) {
    const fallback = candidates[0];
    selected.push(fallback);
    usedChars[fallback.record.layer] = Math.min(budgets[fallback.record.layer], renderItem(fallback.record, fallback.score).length);
  }

  const lines = selected.map((item) => renderItem(item.record, item.score));
  let packet = lines.join("\n");
  if (packet.length > maxChars) packet = packet.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
  const rawChars = candidates.reduce((sum, item) => sum + recordText(item.record).length, 0);
  const avoidedTokens = Math.max(0, Math.ceil((rawChars - packet.length) / 4));
  for (const item of selected) {
    item.record.uses = Number(item.record.uses || 0) + 1;
    item.record.last_used_at = nowIso();
  }
  if (selected.length) writeStore(store);
  return {
    response: {
      operation: "recall",
      route: "memory-layer-loadout",
      query,
      packet,
      items: selected.map((item) => ({
        id: item.record.id,
        layer: item.record.layer,
        score: Number(item.score.toFixed(5)),
        chars: recordText(item.record).length,
        source: item.record.source,
        tags: item.record.tags,
        updated_at: item.record.updated_at,
      })),
      budget: {
        max_chars: maxChars,
        emitted_chars: packet.length,
        layer_chars: usedChars,
        candidate_chars: rawChars,
        estimated_avoided_tokens: avoidedTokens,
      },
      loadout: loadoutSummary(loadout),
      retrieval: { strategy: loadout.strategy, stage: retrieval.stage },
      omitted: {
        candidates: Math.max(0, candidates.length - selected.length),
        expired: expiredCount,
        hidden_trace_without_retain_raw: hiddenTraceCount,
        loadout_filtered: loadoutFilteredCount,
        bootstrap_filtered: retrieval.filtered,
      },
      policy: "query-conditioned; pre-ranked loadout binding; optional L2/L3 bootstrap with L1/L0 fallback; per-layer budget; freshness/importance/confidence; duplicate suppression; bounded output",
    },
    capturedChars: rawChars,
    responseText: packet,
    route: "memory-layer-loadout",
  };
}

// Progressive disclosure lane: return only compact IDs/previews first, then
// let the caller request one exact memory record with operation=get. This
// keeps broad memory searches cheap without changing the existing recall
// contract or deleting any stored evidence.
function index(args = {}) {
  const query = String(args.query ?? args.question ?? "").trim();
  const queryTerms = [...new Set(tokenize(query))];
  const queryPhrase = query.toLowerCase();
  const maxChars = int(args.max_chars, 900, 240, 12_000);
  const maxItems = int(args.max_items, 24, 1, 100);
  const wantedLayers = Array.isArray(args.layers) && args.layers.length
    ? new Set(args.layers.map((item) => normalizeLayer(item)))
    : new Set(Object.keys(LAYERS));
  const requestedScope = normalizeScope(args.scope);
  const loadout = normalizeLoadout(args.loadout || args.binding);
  const store = readStore();
  const now = Date.now();
  let candidates = [];
  let expiredCount = 0;
  let hiddenTraceCount = 0;
  let loadoutFilteredCount = 0;
  for (const record of store.records) {
    if (!record || record.status === "deleted" || !wantedLayers.has(normalizeLayer(record.layer))) continue;
    if (!loadoutMatches(record, loadout)) { loadoutFilteredCount += 1; continue; }
    if (!scopeMatches(record.scope || {}, requestedScope)) continue;
    if (expired(record, now)) { expiredCount += 1; continue; }
    if (normalizeLayer(record.layer) === "trace" && !record.text) hiddenTraceCount += 1;
    const text = recordText(record);
    if (!text) continue;
    if (queryTerms.length && !queryTerms.some((term) => text.toLowerCase().includes(term))) continue;
    const score = queryTerms.length ? lexicalScore(record, queryTerms, queryPhrase, requestedScope, now) : utility(record, now);
    if (queryTerms.length && score < clamp(args.min_score, 0, 0, 2)) continue;
    candidates.push({ record, score });
  }
  const retrieval = applyRetrievalStrategy(candidates, loadout);
  candidates = retrieval.candidates;
  candidates.sort((left, right) => right.score - left.score || timestamp(right.record.updated_at) - timestamp(left.record.updated_at));

  const selected = [];
  let emittedChars = 0;
  for (const candidate of candidates) {
    if (selected.length >= maxItems) break;
    const record = candidate.record;
    const layer = normalizeLayer(record.layer);
    const preview = recordText(record).replace(/\s+/g, " ").trim().slice(0, MAX_INDEX_PREVIEW_CHARS);
    const line = `${record.id} [${LAYERS[layer].code}] ${preview}`;
    const lineChars = line.length + (selected.length ? 1 : 0);
    if (emittedChars + lineChars > maxChars) continue;
    selected.push({
      id: record.id,
      layer,
      score: Number(candidate.score.toFixed(5)),
      preview,
      chars: recordText(record).length,
      source: record.source,
      tags: record.tags,
      updated_at: record.updated_at,
    });
    emittedChars += lineChars;
  }
  const packet = selected.map((item) => `${item.id} [${LAYERS[item.layer].code}] ${item.preview}`).join("\n");
  const rawChars = candidates.reduce((sum, item) => sum + recordText(item.record).length, 0);
  return {
    response: {
      operation: "index",
      route: "memory-layer-index",
      query,
      packet,
      items: selected,
      budget: {
        max_chars: maxChars,
        emitted_chars: packet.length,
        candidate_chars: rawChars,
        estimated_avoided_tokens: Math.max(0, Math.ceil((rawChars - packet.length) / 4)),
      },
      loadout: loadoutSummary(loadout),
      retrieval: { strategy: loadout.strategy, stage: retrieval.stage },
      omitted: {
        candidates: Math.max(0, candidates.length - selected.length),
        expired: expiredCount,
        hidden_trace_without_retain_raw: hiddenTraceCount,
        loadout_filtered: loadoutFilteredCount,
        bootstrap_filtered: retrieval.filtered,
      },
      next: "Call action=memory with operation=get and one returned id for exact text.",
      policy: "progressive disclosure; pre-ranked loadout binding; optional L2/L3 bootstrap with L1/L0 fallback; compact index first; exact memory on demand",
    },
    responseText: packet,
    capturedChars: 0,
    route: "memory-layer-index",
  };
}

function get(args = {}) {
  const id = String(args.id || args.memory_id || "").trim();
  if (!id) throw new Error("id is required");
  const store = readStore();
  const record = store.records.find((item) => item && item.id === id && item.status !== "deleted");
  if (!record || expired(record)) throw new Error(`memory record not found: ${id}`);
  const original = recordText(record);
  const maxChars = int(args.max_chars, MAX_ITEM_CHARS, 120, MAX_ITEM_CHARS);
  const text = original.length <= maxChars ? original : compactText(original, maxChars);
  record.uses = Number(record.uses || 0) + 1;
  record.last_used_at = nowIso();
  writeStore(store);
  return {
    response: {
      operation: "get",
      route: "memory-layer-get",
      id: record.id,
      layer: normalizeLayer(record.layer),
      text,
      exact: text === original,
      chars: original.length,
      source: record.source,
      tags: record.tags,
      updated_at: record.updated_at,
      policy: "one-record exact recovery after progressive index selection",
    },
    responseText: text,
    capturedChars: original.length,
    route: "memory-layer-get",
  };
}

function promote(args = {}) {
  const id = String(args.id || "").trim();
  if (!id) throw new Error("id is required");
  const target = normalizeLayer(args.layer || args.to, "profile");
  const store = readStore();
  const record = store.records.find((item) => item.id === id);
  if (!record) throw new Error(`memory record not found: ${id}`);
  const before = record.layer;
  record.layer = target;
  record.content_hash = hash(`${scopeKey(record.scope || {})}\0${target}\0${recordText(record)}`);
  record.importance = Math.max(Number(record.importance || 0), LAYERS[target].defaultImportance);
  record.updated_at = nowIso();
  writeStore(store);
  return { response: { operation: "promote", route: "memory-layer-promotion", id, from: before, to: target } };
}

function prune(args = {}) {
  const store = readStore();
  const beforeCount = store.records.length;
  const now = Date.now();
  const maxRecords = int(args.max_records, DEFAULT_MAX_RECORDS, 100, 50_000);
  const expiredItems = store.records.filter((record) => expired(record, now));
  let survivors = store.records.filter((record) => !expired(record, now) && record.status !== "deleted");
  if (survivors.length > maxRecords) survivors = survivors.sort((left, right) => utility(right, now) - utility(left, now)).slice(0, maxRecords);
  const removed = store.records.length - survivors.length;
  if (args.dry_run !== true) {
    store.records = survivors;
    store.metrics.pruned = Number(store.metrics.pruned || 0) + removed;
    writeStore(store);
  }
  return {
    response: {
      operation: "prune",
      route: "memory-layer-gc",
      dry_run: args.dry_run === true,
      before: beforeCount,
      after: survivors.length,
      removed,
      expired: expiredItems.length,
      reason: "expired records and lowest-utility overflow are eligible; no live record is deleted in dry-run mode",
    },
  };
}

function status() {
  const store = readStore();
  const counts = Object.fromEntries(Object.keys(LAYERS).map((key) => [key, 0]));
  let chars = 0;
  let hiddenTraces = 0;
  let expiredCount = 0;
  for (const record of store.records) {
    const layer = normalizeLayer(record.layer);
    counts[layer] += 1;
    chars += recordText(record).length;
    if (layer === "trace" && !record.text) hiddenTraces += 1;
    if (expired(record)) expiredCount += 1;
  }
  return {
    response: {
      operation: "status",
      route: "memory-layer-status",
      records: store.records.length,
      counts,
      stored_chars: chars,
      estimated_stored_tokens: Math.ceil(chars / 4),
      hidden_trace_digests: hiddenTraces,
      expired: expiredCount,
      metrics: store.metrics,
      persistence: memoryPaths().store,
      policy: "local-only; explicit capture; trace raw retention is opt-in",
    },
  };
}

function dispatch(args = {}) {
  const operation = String(args.operation || args.op || "recall").toLowerCase();
  if (operation === "capture" || operation === "remember" || operation === "add") return capture(args);
  if (operation === "index" || operation === "list") return index(args);
  if (operation === "get" || operation === "retrieve") return get(args);
  if (operation === "recall" || operation === "loadout" || operation === "search") return recall(args);
  if (operation === "promote") return promote(args);
  if (operation === "prune" || operation === "gc") return prune(args);
  if (operation === "status") return status();
  throw new Error("memory operation must be capture, index, get, recall, promote, prune, or status");
}

module.exports = {
  LAYERS,
  capture,
  dispatch,
  get,
  index,
  memoryPaths,
  promote,
  prune,
  recall,
  status,
};
