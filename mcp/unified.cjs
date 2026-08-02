"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn, spawnSync } = require("node:child_process");
const core = require("./core.cjs");
const compat = require("./compat.cjs");
const cognition = require("./cognition.cjs");
const advisor = require("./advisor.cjs");
const compaction = require("./compaction.cjs");
const providerTelemetry = require("./provider-telemetry.cjs");
const quotaProgress = require("./quota-progress.cjs");
const runtime = require("./runtime.cjs");
const semanticInterrupt = require("./semantic-interrupt.cjs");
const editTransaction = require("./edit.cjs");
const terminalNovelty = require("./terminal-novelty.cjs");
const projectCompiler = require("./project.cjs");
const jsonOutput = require("./json-output.cjs");
const sessionAudit = require("./session-audit.cjs");
const packageMetadata = require("../package.json");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}
let searchDatabase = null;
let trigramAvailable = false;

const DEFAULT_EXCLUDES = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "build", ".next",
  "coverage", ".venv", "venv", "__pycache__", ".idea", ".vscode",
]);
const DEFAULT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".csv", ".go", ".h", ".hpp",
  ".html", ".java", ".js", ".json", ".jsx", ".kt", ".md", ".mdx",
  ".php", ".ps1", ".py", ".rb", ".rs", ".sh", ".sql", ".swift", ".toml",
  ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);
const SECRET_RE = /\b(api[_-]?(?:key|token)|access[_-]?token|auth[_-]?token|authorization|cookie|credential|password|passwd|private[_-]?key|secret|token)\s*([:=])\s*(?:bearer\s+)?[^\s,;]+|\bbearer\s+[a-z0-9._~+/=-]+/ig;
const SIGNAL_RE = /\b(error|exception|fatal|fail(?:ed|ure)?|panic|security|timeout|traceback|warn(?:ing)?)\b/i;
const SUMMARY_RE = /\b(pass(?:ed)?|fail(?:ed)?|tests?|suites?|errors?|warnings?|finished|completed|duration|time|total|summary)\b/i;
const DIFF_RE = /^(?:diff --git|index |@@|[+-]{3} |[+-](?![+-]))/;
const MAX_TOOL_OUTPUT = 14_000;

function int(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function unpack(args = {}) {
  let payload = args.payload;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch (error) {
      throw new Error(`payload must be valid JSON: ${error.message}`);
    }
  }
  if (payload == null) payload = {};
  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("payload must be an object or a JSON object string");
  }
  const { payload: _payload, ...legacy } = args;
  return { ...legacy, ...payload, action: args.action };
}

function tokenize(value) {
  return [...String(value).toLowerCase().matchAll(/[\p{L}\p{N}_$.-]{2,}/gu)]
    .map((match) => match[0]);
}

function uniqueLines(lines, options = {}) {
  const seen = new Map();
  const ordered = [];
  for (const raw of lines) {
    const line = String(raw).replace(/\s+$/g, "");
    const key = options.preserveNumbers
      ? line
      : line.replace(/\b\d+(?:\.\d+)?(?:ms|s|m|h)?\b/g, "#");
    const previous = seen.get(key);
    if (previous) {
      previous.count += 1;
    } else {
      const item = { line, count: 1 };
      seen.set(key, item);
      ordered.push(item);
    }
  }
  return ordered.map((item) => item.count > 1 ? `${item.line}  [x${item.count}]` : item.line);
}

function redact(text) {
  return String(text).replace(SECRET_RE, (match, name, separator) => {
    if (name) return `${name}${separator}[REDACTED]`;
    return `${match.slice(0, match.search(/\s/))} [REDACTED]`;
  });
}

function inferProfile(command, args = [], requested = "auto") {
  return compat.inferProfile(command, args, requested);
}

function bounded(lines, maxChars) {
  const output = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + 1;
    if (used + cost > maxChars) break;
    output.push(line);
    used += cost;
  }
  return output.join("\n");
}

function questionLines(lines, query) {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];
  return lines
    .map((line, index) => {
      const lower = line.toLowerCase();
      const matches = terms.filter((term) => lower.includes(term));
      return { line, index, score: matches.length, exact: lower.includes(String(query).toLowerCase()) };
    })
    .filter((item) => item.score)
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score || a.index - b.index)
    .slice(0, 24)
    .map((item) => item.line);
}

function compressText(rawText, options = {}) {
  const source = String(rawText);
  const maxChars = int(options.max_chars, 4_000, 600, MAX_TOOL_OUTPUT);
  const passthrough = int(options.passthrough_chars, 1_400, 0, 1_000_000);
  let profile = inferProfile(options.command, options.args || [], options.profile);
  const structured = jsonOutput.projectJsonOutput(source, {
    maxChars,
    query: options.query || options.question || "",
    redactString: redact,
  });
  if (structured) {
    const profitable = structured.route !== "compressed" ||
      structured.secret_redactions > 0 ||
      core.tokenSafe(source, structured.output, 0.98, 16);
    if (!profitable) {
      return {
        route: "passthrough",
        profile,
        output: source,
        raw_chars: source.length,
        query_coverage: 1,
      };
    }
    return { ...structured, profile };
  }
  const raw = redact(source);
  if (raw.length <= passthrough) {
    return { route: "passthrough", profile, output: raw, raw_chars: raw.length };
  }

  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const queryHits = questionLines(lines, options.query || options.question || "");
  const filtered = compat.filterText(raw, {
    command: options.command,
    args: options.args || [],
    cwd: options.cwd,
    profile,
  });
  profile = filtered.profile;
  let selected = filtered.lines;

  selected = uniqueLines([...queryHits, ...selected], { preserveNumbers: profile === "diff" });
  if (!selected.length) {
    selected = uniqueLines([
      ...lines.slice(0, 16),
      ...(lines.length > 24 ? [`… ${lines.length - 24} lines archived …`] : []),
      ...lines.slice(-8),
    ], { preserveNumbers: profile === "diff" });
  }
  const output = bounded(selected, maxChars);
  const queryTerms = [...new Set(tokenize(options.query || options.question || ""))];
  const outputLower = output.toLowerCase();
  const coverage = queryTerms.length
    ? queryTerms.filter((term) => outputLower.includes(term)).length / queryTerms.length
    : 1;
  const safe = output && coverage >= 0.5 && core.tokenSafe(raw, output, 0.88, 72);
  return safe
    ? { route: "compressed", profile, output, raw_chars: raw.length, query_coverage: coverage }
    : { route: "passthrough", profile, output: raw, raw_chars: raw.length, query_coverage: coverage };
}

function attachArchive(compact, capsuleId, details = {}) {
  const operation = {
    response: {
      route: compact.route,
      profile: compact.profile,
      capsule_id: capsuleId,
      exact_expand: true,
      original_chars: compact.raw_chars,
      ...(compact.json_mode ? {
        json_mode: compact.json_mode,
        secret_redactions: compact.secret_redactions || 0,
        ...(compact.security_reason ? { security_reason: compact.security_reason } : {}),
      } : {}),
      output: compact.output,
      ...details,
    },
    route: compact.route,
    capturedChars: compact.raw_chars,
  };
  if (compact.route === "passthrough") operation.responseText = compact.output;
  return operation;
}

function runCommand(args = {}) {
  if (!args.command || typeof args.command !== "string") throw new Error("command is required");
  const capture = core.surveyCommand(args);
  const capsuleId = capture.response.capsule_id;
  const archived = core.loadCapsule(capsuleId);
  const executedCommand = archived.metadata.details.command;
  const executedArgs = archived.metadata.details.args || [];
  const compact = compressText(archived.text, {
    command: executedCommand,
    args: executedArgs,
    cwd: archived.metadata.details.cwd,
    profile: args.profile,
    query: args.query || args.question,
    max_chars: args.max_chars,
    passthrough_chars: args.passthrough_chars,
  });
  const operation = attachArchive(compact, capsuleId, {
    exit_code: archived.metadata.details.exit_code,
    elapsed_ms: archived.metadata.details.elapsed_ms,
  });
  compat.recordHistory({
    command: executedCommand,
    args: executedArgs,
    cwd: archived.metadata.details.cwd,
    profile: compact.profile,
    route: compact.route,
    raw_chars: compact.raw_chars,
    emitted_chars: core.renderOperation(operation).length,
    exit_code: archived.metadata.details.exit_code,
    source: "mcp",
  });
  return operation;
}

const DEFAULT_SESSION_LOG_AUDIT_MAX_BYTES = 256 * 1024 * 1024;

function canonicalExistingPath(resolvedPath) {
  const lexical = path.resolve(resolvedPath);
  try {
    const realpath = typeof fs.realpathSync.native === "function"
      ? fs.realpathSync.native
      : fs.realpathSync;
    return realpath(lexical);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return lexical;
    throw error;
  }
}

function isCodexSessionLogPath(resolvedPath) {
  const normalized = path.resolve(resolvedPath).replace(/\\/g, "/");
  return /(?:^|\/)\.codex\/sessions(?:\/|$)/i.test(normalized) &&
    /\.jsonl$/i.test(normalized);
}

function sessionLogAuditMaxBytes() {
  return int(
    process.env.CAPSULE_SESSION_AUDIT_MAX_BYTES,
    DEFAULT_SESSION_LOG_AUDIT_MAX_BYTES,
    64 * 1024,
    2 * 1024 * 1024 * 1024
  );
}

function explicitLiteralFileRead(args = {}) {
  return args.mode === "full" ||
    args.require_full === true ||
    args.require_literal === true ||
    args.literal === true ||
    args.verbatim === true ||
    args.raw === true ||
    args.exact === true;
}

function boundedTelemetryText(value, limit = 96) {
  const text = String(value || "").replace(/[\r\n\t]+/g, " ");
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(1, limit - 1))}…`;
}

function telemetryNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function projectedUsage(value = {}) {
  return {
    input_tokens: telemetryNumber(value.input_tokens),
    cached_input_tokens: telemetryNumber(value.cached_input_tokens),
    output_tokens: telemetryNumber(value.output_tokens),
    reasoning_output_tokens: telemetryNumber(value.reasoning_output_tokens),
    total_tokens: telemetryNumber(value.total_tokens),
  };
}

function projectedLimit(value = {}) {
  return {
    used_percent: telemetryNumber(value.used_percent),
    window_minutes: telemetryNumber(value.window_minutes),
    resets_at: telemetryNumber(value.resets_at),
  };
}

function projectedSummary(value = {}) {
  return {
    average: telemetryNumber(value.average),
    minimum: telemetryNumber(value.minimum),
    maximum: telemetryNumber(value.maximum),
  };
}

function sessionLogAuditSummary(resolvedPath) {
  const fileBytes = fs.statSync(resolvedPath).size;
  const auditMaxBytes = sessionLogAuditMaxBytes();
  if (fileBytes > auditMaxBytes) {
    return {
      response: {
        kind: "codex-session-log-audit",
        protected_default: true,
        session_file: boundedTelemetryText(path.resolve(resolvedPath), 512),
        file_bytes: fileBytes,
        audit_max_bytes: auditMaxBytes,
        scan_skipped: true,
        skip_reason: "file-exceeds-session-audit-limit",
        raw_transcript_included: false,
        raw_capsule_created: false,
        provider_telemetry: { available: false, scan_skipped: true },
        compaction_audit: { available: false, scan_skipped: true },
        exact_access_hint: "Repeat action=file with payload.mode=\"full\" or payload.require_full=true for literal access.",
      },
      route: "session-log-audit",
      capturedChars: 0,
    };
  }
  const audit = compaction.auditSession({ session_file: resolvedPath }).response || {};
  const provider = providerTelemetry.snapshot({
    session_file: resolvedPath,
    max_samples: 1,
  }).response || {};
  const lastRequest = provider.last_request || {};
  const limits = provider.limits || {};
  const direct = audit.direct_compaction_tokens || {};
  const observable = audit.observable_context || {};
  const recentEvents = Array.isArray(audit.events) ? audit.events.slice(-3) : [];

  return {
    response: {
      kind: "codex-session-log-audit",
      protected_default: true,
      session_file: boundedTelemetryText(path.resolve(resolvedPath), 512),
      file_bytes: fileBytes,
      audit_max_bytes: auditMaxBytes,
      scan_skipped: false,
      raw_transcript_included: false,
      raw_capsule_created: false,
      provider_telemetry: {
        available: provider.available === true,
        exact_provider_counters: provider.exact_provider_counters === true,
        samples: telemetryNumber(provider.samples),
        cumulative: projectedUsage(provider.cumulative),
        last_request: {
          ...projectedUsage(lastRequest),
          uncached_input_tokens: telemetryNumber(lastRequest.uncached_input_tokens),
          cache_hit_percent: telemetryNumber(lastRequest.cache_hit_percent),
        },
        context: {
          input_tokens: telemetryNumber(provider.context?.input_tokens),
          window_tokens: telemetryNumber(provider.context?.window_tokens),
          used_percent: telemetryNumber(provider.context?.used_percent),
          remaining_tokens: telemetryNumber(provider.context?.remaining_tokens),
        },
        limits: {
          primary: projectedLimit(limits.primary),
          secondary: projectedLimit(limits.secondary),
          rate_limit_reached: Boolean(limits.reached_type),
          spend_control_reached: limits.spend_control_reached === true,
        },
      },
      compaction_audit: {
        available: audit.available === true,
        compactions: telemetryNumber(audit.compactions),
        measured_transitions: telemetryNumber(audit.measured_transitions),
        direct_compaction_tokens: {
          reported_delta: telemetryNumber(direct.reported_delta),
          adjacent_counter_observations: telemetryNumber(direct.adjacent_counter_observations),
          exposed_by_telemetry: direct.exposed_by_telemetry === true,
        },
        observable_context: {
          pre_input_tokens: projectedSummary(observable.pre_input_tokens),
          post_input_tokens: projectedSummary(observable.post_input_tokens),
          post_cached_input_tokens: projectedSummary(observable.post_cached_input_tokens),
          post_uncached_input_tokens: projectedSummary(observable.post_uncached_input_tokens),
          reduction_percent: telemetryNumber(observable.reduction_percent),
        },
        replacement_history_chars: projectedSummary(audit.replacement_history_chars),
        recent_events: recentEvents.map((event) => ({
          window: telemetryNumber(event.window),
          pre_input_tokens: telemetryNumber(event.pre_input_tokens),
          post_input_tokens: telemetryNumber(event.post_input_tokens),
          post_cached_input_tokens: telemetryNumber(event.post_cached_input_tokens),
          reported_direct_delta: event.reported_direct_delta == null
            ? null
            : telemetryNumber(event.reported_direct_delta),
          replacement_history_items: telemetryNumber(event.replacement_history_items),
          replacement_history_chars: telemetryNumber(event.replacement_history_chars),
        })),
      },
      exact_access_hint: "Repeat action=file with payload.mode=\"full\" or payload.require_full=true for literal access.",
    },
    route: "session-log-audit",
    capturedChars: fileBytes,
  };
}

function inspectFile(args = {}) {
  if (["edit", "preview", "undo"].includes(args.operation)) return editTransaction.edit(args);
  if (!args.path || typeof args.path !== "string") throw new Error("path is required");
  const resolvedPath = path.resolve(args.path);
  const canonicalPath = canonicalExistingPath(resolvedPath);
  const normalizedPath = resolvedPath.replace(/\\/g, "/");
  if (isCodexSessionLogPath(resolvedPath) || isCodexSessionLogPath(canonicalPath)) {
    if (!explicitLiteralFileRead(args)) return sessionLogAuditSummary(canonicalPath);
    return core.smartFile({ ...args, path: canonicalPath, question: args.query || args.question, mode: "full" });
  }
  const selectedInstruction = /\/SKILL\.md$/i.test(normalizedPath) ||
    (/\/skills\//i.test(normalizedPath) && /\/references\/[^/]+\.md$/i.test(normalizedPath));
  const instructionLimit = int(
    process.env.CAPSULE_INSTRUCTION_FULL_BYTES,
    64 * 1024,
    4 * 1024,
    256 * 1024
  );
  if (args.instruction_full !== false && selectedInstruction) {
    try {
      if (fs.statSync(resolvedPath).size <= instructionLimit) {
        return core.smartFile({ ...args, path: resolvedPath, question: "", mode: "full" });
      }
    } catch {
      // Preserve the normal file error and recovery path below.
    }
  }
  const bareFileRead = !String(args.query || args.question || "").trim() &&
    !args.mode &&
    !args.require_full &&
    args.start_line == null &&
    args.end_line == null;
  const bareFileLimit = int(
    process.env.CAPSULE_BARE_FILE_FULL_BYTES,
    32 * 1024,
    4 * 1024,
    256 * 1024
  );
  if (bareFileRead) {
    try {
      if (fs.statSync(resolvedPath).size <= bareFileLimit) {
        return core.smartFile({
          ...args,
          path: resolvedPath,
          question: "",
          mode: "full",
          replay_unchanged: true,
        });
      }
    } catch {
      // Preserve the normal file error and recovery path below.
    }
  }
  const explicitRange = args.start_line != null || args.end_line != null;
  if (explicitRange && !args.require_full && args.mode !== "full") {
    return core.readFileRange({
      ...args,
      question: args.query || args.question,
    });
  }
  if (args.require_full || args.mode === "full") {
    return core.smartFile({ ...args, question: args.query || args.question, mode: "full" });
  }
  const evidence = core.smartFile({
    ...args,
    question: args.query || args.question,
    mode: "auto",
  });
  if (evidence.route !== "passthrough") return evidence;
  const text = evidence.baselineText || evidence.responseText;
  const compact = compressText(text, {
    profile: args.profile || "generic",
    query: args.query || args.question,
    max_chars: args.max_chars,
    passthrough_chars: args.passthrough_chars,
  });
  if (compact.route === "passthrough") return evidence;
  const saved = core.saveCapsule({
    kind: "file",
    source: path.resolve(args.path),
    text,
    question: args.query || args.question,
    maxChars: args.max_chars || 1_200,
  });
  return attachArchive(compact, saved.response.capsule_id, {
    path: path.resolve(args.path),
    lines: String(text).replace(/\r\n?/g, "\n").split("\n").length,
  });
}

function indexPaths() {
  const root = path.join(core.stateRoot(), "index");
  return {
    root,
    catalog: path.join(root, "catalog.json"),
    database: path.join(root, "search.sqlite"),
  };
}

function getSearchDatabase() {
  if (!DatabaseSync) return null;
  if (searchDatabase) return searchDatabase;
  const state = indexPaths();
  fs.mkdirSync(state.root, { recursive: true });
  searchDatabase = new DatabaseSync(state.database);
  const busyTimeout = process.env.CAPSULE_HOOK_PROCESS === "1" ? 50 : 15000;
  searchDatabase.exec(`
    PRAGMA busy_timeout=${busyTimeout};
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      document_id UNINDEXED,
      title,
      source,
      content,
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_porter_fts USING fts5(
      document_id UNINDEXED,
      title,
      source,
      content,
      tokenize='porter unicode61 remove_diacritics 2'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_vocab USING fts5vocab(documents_fts, 'row');
  `);
  try {
    searchDatabase.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_trigram_fts USING fts5(
        document_id UNINDEXED,
        title,
        source,
        content,
        tokenize='trigram'
      );
    `);
    trigramAvailable = true;
  } catch {
    trigramAvailable = false;
  }
  return searchDatabase;
}

function upsertSearchDocument(document, content) {
  upsertSearchDocuments([{ document, content }]);
}

function upsertSearchDocuments(entries) {
  if (!entries.length) return;
  const database = getSearchDatabase();
  if (!database) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    const tables = ["documents_fts", "documents_porter_fts"];
    if (trigramAvailable) tables.push("documents_trigram_fts");
    for (const { document, content } of entries) {
      for (const table of tables) {
        database.prepare(`DELETE FROM ${table} WHERE document_id = ?`).run(document.document_id);
        database.prepare(
          `INSERT INTO ${table}(document_id, title, source, content) VALUES (?, ?, ?, ?)`
        ).run(document.document_id, document.title, document.source, content);
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function closeSearchDatabase() {
  if (!searchDatabase) return;
  searchDatabase.close();
  searchDatabase = null;
}

function readCatalog() {
  const state = indexPaths();
  fs.mkdirSync(state.root, { recursive: true });
  try {
    return JSON.parse(fs.readFileSync(state.catalog, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, documents: {} };
    throw error;
  }
}

function writeCatalog(catalog) {
  const state = indexPaths();
  fs.mkdirSync(state.root, { recursive: true });
  const temp = `${state.catalog}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  fs.renameSync(temp, state.catalog);
}

function withCatalogLock(callback, timeoutMs = 10_000) {
  const state = indexPaths();
  fs.mkdirSync(state.root, { recursive: true });
  const lock = `${state.catalog}.lock`;
  const started = Date.now();
  let descriptor;
  while (descriptor == null) {
    try {
      descriptor = fs.openSync(lock, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) fs.unlinkSync(lock);
      } catch {
        // Another process may have released the lock.
      }
      if (Date.now() - started >= timeoutMs) throw new Error("timed out waiting for index catalog lock");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return callback();
  } finally {
    try {
      fs.closeSync(descriptor);
    } finally {
      try {
        fs.unlinkSync(lock);
      } catch {
        // A stale-lock cleanup may already have removed it.
      }
    }
  }
}

function contentTypeFor(source, content, requested) {
  if (requested) return requested;
  const extension = path.extname(String(source)).toLowerCase();
  if ([".js", ".jsx", ".ts", ".tsx", ".py", ".rb", ".rs", ".go", ".java", ".cs", ".cpp", ".c", ".h", ".sh", ".ps1", ".php", ".sql"].includes(extension)) return "code";
  if (/^\s*(?:const|let|var|function|class|def|import|export|package|using)\b/m.test(String(content))) return "code";
  return "prose";
}

function removeIndexedDocument(database, documentId) {
  if (!database) return;
  const tables = ["documents_fts", "documents_porter_fts"];
  if (trigramAvailable) tables.push("documents_trigram_fts");
  for (const table of tables) database.prepare(`DELETE FROM ${table} WHERE document_id = ?`).run(documentId);
}

function stageDocument({
  source,
  title,
  content,
  kind = "document",
  tags = [],
  content_type,
  original_path,
  file_sha256,
  file_mtime_ms,
  file_size,
}, catalog, database) {
  const text = String(content);
  const saved = core.saveCapsule({
    kind: `index:${kind}`,
    source,
    text,
    question: title || source,
    maxChars: 1_200,
    details: { title, tags },
  });
  const documentId = `doc_${hash(`${source}\0${saved.response.capsule_id}`).slice(0, 16)}`;
  for (const [existingId, existing] of Object.entries(catalog.documents)) {
    if (existing.source === source && existingId !== documentId) {
      removeIndexedDocument(database, existingId);
      delete catalog.documents[existingId];
    }
  }
  catalog.documents[documentId] = {
    document_id: documentId,
    capsule_id: saved.response.capsule_id,
    source,
    title: title || path.basename(source) || source,
    kind,
    tags,
    content_type: contentTypeFor(source, text, content_type),
    sha256: hash(text),
    original_path: original_path || null,
    file_sha256: file_sha256 || null,
    file_mtime_ms: file_mtime_ms ?? null,
    file_size: file_size ?? null,
    chars: text.length,
    indexed_at: new Date().toISOString(),
  };
  return { document: catalog.documents[documentId], content: text };
}

function addDocument(spec) {
  let staged;
  withCatalogLock(() => {
    const catalog = readCatalog();
    staged = stageDocument(spec, catalog, getSearchDatabase());
    writeCatalog(catalog);
  });
  upsertSearchDocuments([staged]);
  return staged.document;
}

function walkDirectory(root, options = {}) {
  const maxDepth = int(options.max_depth, 5, 0, 20);
  const maxFiles = int(options.max_files, 200, 1, 5_000);
  const extensions = new Set(
    (options.extensions || [...DEFAULT_EXTENSIONS]).map((item) =>
      String(item).startsWith(".") ? String(item).toLowerCase() : `.${String(item).toLowerCase()}`
    )
  );
  const files = [];
  const includePatterns = (options.include || []).map(globToRegExp);
  const excludePatterns = (options.exclude || []).map(globToRegExp);
  const gitignorePatterns = options.respect_gitignore === false || options.respectGitignore === false
    ? []
    : loadGitignore(root).map(globToRegExp);
  const visited = new Set();
  function visit(directory, depth) {
    if (files.length >= maxFiles || depth > maxDepth) return;
    let realDirectory;
    try {
      realDirectory = fs.realpathSync(directory);
    } catch {
      return;
    }
    if (visited.has(realDirectory)) return;
    visited.add(realDirectory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= maxFiles) break;
      if (DEFAULT_EXCLUDES.has(entry.name)) continue;
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target).replaceAll("\\", "/");
      if (excludePatterns.some((pattern) => pattern.test(relative)) ||
          gitignorePatterns.some((pattern) => pattern.test(relative))) continue;
      if (entry.isSymbolicLink()) {
        if (options.follow_symlinks === true || options.followSymlinks === true) {
          const linked = fs.statSync(target);
          if (linked.isDirectory()) visit(target, depth + 1);
          else if (linked.isFile() && extensions.has(path.extname(entry.name).toLowerCase()) &&
                   (!includePatterns.length || includePatterns.some((pattern) => pattern.test(relative)))) files.push(target);
        }
        continue;
      }
      if (entry.isDirectory()) visit(target, depth + 1);
      else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase()) &&
               (!includePatterns.length || includePatterns.some((pattern) => pattern.test(relative)))) files.push(target);
    }
  }
  visit(root, 0);
  return files;
}

function globToRegExp(pattern) {
  let value = String(pattern).replaceAll("\\", "/").replace(/^\.?\//, "");
  let expression = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "*" && value[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
  }
  return new RegExp(`(?:^|/)${expression}(?:$|/)`, "i");
}

function loadGitignore(root) {
  const file = path.join(root, ".gitignore");
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"));
  } catch {
    return [];
  }
}

function splitContent(content, chunkChars) {
  const text = String(content);
  if (text.length <= chunkChars) return [text];
  const chunks = [];
  let current = "";
  for (const block of text.split(/(?=^#{1,6}\s)|(?=^```)/m)) {
    if (current && current.length + block.length > chunkChars) {
      chunks.push(current);
      current = "";
    }
    if (block.length > chunkChars) {
      for (let offset = 0; offset < block.length; offset += chunkChars) chunks.push(block.slice(offset, offset + chunkChars));
    } else current += block;
  }
  if (current) chunks.push(current);
  return chunks;
}

function addChunkedDocuments(spec, chunkChars) {
  const chunks = splitContent(spec.content, chunkChars);
  return chunks.map((content, index) => addDocument({
    ...spec,
    content,
    source: chunks.length === 1 ? spec.source : `${spec.source}#chunk-${index + 1}`,
    title: chunks.length === 1 ? spec.title : `${spec.title} [${index + 1}/${chunks.length}]`,
  }));
}

function indexContent(args = {}) {
  const maxBytes = int(args.max_bytes_per_file, 8 * 1024 * 1024, 1_024, 64 * 1024 * 1024);
  const chunkChars = int(args.chunk_chars, 128_000, 8_000, 1_000_000);
  if (typeof args.content === "string") {
    const source = args.source || `memory://${hash(args.content).slice(0, 12)}`;
    const documents = addChunkedDocuments({
      source,
      title: args.title || source,
      content: args.content,
      kind: args.kind || "document",
      tags: args.tags || [],
      content_type: args.content_type || args.contentType,
    }, chunkChars);
    return { response: { indexed: documents.length, documents }, capturedChars: args.content.length };
  }
  if (!args.path) throw new Error("path or content is required");
  const target = path.resolve(args.path);
  const stat = fs.statSync(target);
  const files = stat.isDirectory() ? walkDirectory(target, args) : [target];
  const documents = [];
  let captured = 0;
  const skipped = [];
  for (const file of files) {
    const fileStat = fs.statSync(file);
    if (fileStat.size > maxBytes) {
      skipped.push({ path: file, reason: "max_bytes_per_file" });
      continue;
    }
    const content = fs.readFileSync(file, "utf8");
    captured += content.length;
    const digest = hash(content);
    documents.push(...addChunkedDocuments({
      source: file,
      title: path.relative(stat.isDirectory() ? target : path.dirname(target), file) || path.basename(file),
      content,
      kind: args.kind || "file",
      tags: args.tags || [],
      content_type: args.content_type || args.contentType,
      original_path: file,
      file_sha256: digest,
      file_mtime_ms: fileStat.mtimeMs,
      file_size: fileStat.size,
    }, chunkChars));
  }
  return {
    response: {
      root: target,
      indexed: documents.length,
      skipped: skipped.length,
      documents: documents.slice(0, 50),
      skipped_details: skipped.slice(0, 20),
    },
    capturedChars: captured,
  };
}

function snippetFor(text, terms, maxChars = 900) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  let best = { index: 0, score: 0 };
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
    if (score > best.score) best = { index, score };
  });
  const start = Math.max(0, best.index - 2);
  const end = Math.min(lines.length, best.index + 4);
  return bounded(lines.slice(start, end).map((line, offset) => `${start + offset + 1}: ${line}`), maxChars);
}

function editDistance(left, right) {
  const a = String(left);
  const b = String(right);
  const row = Array.from({ length: b.length + 1 }, (_value, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + Number(a[i - 1] !== b[j - 1]));
      diagonal = previous;
    }
  }
  return row[b.length];
}

// Keep the no-SQLite catalog scan behavior close to the FTS5 porter tokenizer.
// This is intentionally small and deterministic: it covers the common English
// inflections that matter for local search without adding a dependency or
// pretending to be a full linguistic stemmer.
function stemSearchTerm(value) {
  let term = String(value).toLowerCase();
  if (term.length > 5 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 5 && term.endsWith("ing")) term = term.slice(0, -3);
  if (term.length > 4 && term.endsWith("ed")) term = term.slice(0, -2);
  if (term.length > 4 && term.endsWith("es")) term = term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s")) term = term.slice(0, -1);
  return term;
}

function fallbackSearchTokens(text) {
  return tokenize(text).flatMap((token) => token.split(/[-_.]+/u).filter(Boolean));
}

function fallbackContentMatches(text, terms) {
  const counts = new Map();
  for (const token of fallbackSearchTokens(text)) {
    const stem = stemSearchTerm(token);
    counts.set(stem, (counts.get(stem) || 0) + 1);
  }
  return terms.reduce((sum, term) => sum + (counts.get(stemSearchTerm(term)) || 0), 0);
}

function correctedTermsFromVocabulary(terms, vocabulary) {
  const candidates = [...new Set(vocabulary.map((term) => String(term).toLowerCase()))];
  return terms.map((term) => {
    if (term.length < 4 || candidates.includes(term)) return term;
    let best = term;
    let distance = term.length >= 8 ? 2 : 1;
    for (const candidate of candidates) {
      if (Math.abs(candidate.length - term.length) > distance) continue;
      const score = editDistance(term, candidate);
      if (score < distance) {
        best = candidate;
        distance = score;
        if (score === 1) break;
      }
    }
    return best;
  });
}

function correctedTerms(database, terms) {
  if (!database || !terms.length) return terms;
  let vocabulary = [];
  try {
    vocabulary = database.prepare(
      "SELECT term FROM documents_vocab WHERE length(term) >= 3 ORDER BY doc DESC LIMIT 4000"
    ).all().map((row) => String(row.term));
  } catch {
    return terms;
  }
  return terms.map((term) => {
    if (vocabulary.includes(term) || term.length < 4) return term;
    let best = term;
    let distance = term.length >= 8 ? 2 : 1;
    for (const candidate of vocabulary) {
      if (Math.abs(candidate.length - term.length) > distance) continue;
      const score = editDistance(term, candidate);
      if (score < distance) {
        best = candidate;
        distance = score;
        if (score === 1) break;
      }
    }
    return best;
  });
}

function documentMatchesFilters(document, args) {
  if (args.kind && document.kind !== args.kind) return false;
  const requestedType = args.content_type || args.contentType;
  if (requestedType && document.content_type !== requestedType) return false;
  if (args.source && !String(document.source).toLowerCase().includes(String(args.source).toLowerCase())) return false;
  const tags = Array.isArray(args.tags) ? args.tags : args.tag ? [args.tag] : [];
  if (tags.length && !tags.every((tag) => (document.tags || []).includes(tag))) return false;
  return true;
}

function staleState(document) {
  if (!document.original_path) return false;
  try {
    const stat = fs.statSync(document.original_path);
    if (document.file_size !== stat.size || Math.abs(Number(document.file_mtime_ms) - stat.mtimeMs) > 1) return true;
    return false;
  } catch {
    return true;
  }
}

function proximityBoost(text, terms) {
  if (terms.length < 2) return 0;
  const lower = String(text).toLowerCase();
  const positions = terms.map((term) => lower.indexOf(term));
  if (positions.some((position) => position < 0)) return 0;
  const span = Math.max(...positions) - Math.min(...positions);
  return Math.max(0, 8 - Math.log2(span + 2));
}

function ftsRows(database, table, expression, limit) {
  try {
    return database.prepare(
      `SELECT document_id, bm25(${table}, 0.0, 3.0, 1.5, 1.0) AS rank ` +
      `FROM ${table} WHERE ${table} MATCH ? ORDER BY rank LIMIT ?`
    ).all(expression, limit);
  } catch {
    return [];
  }
}

function searchIndex(args = {}) {
  const queries = Array.isArray(args.queries) ? args.queries : [args.query];
  if (!queries[0] || queries.some((query) => typeof query !== "string")) {
    throw new Error("query or queries is required");
  }
  const limit = int(args.limit, 5, 1, 20);
  const catalog = readCatalog();
  const documents = Object.values(catalog.documents);
  const response = queries.map((query) => {
    let terms = [...new Set(tokenize(query))];
    const database = getSearchDatabase();
    if (database) {
      const tables = ["documents_fts", "documents_porter_fts"];
      if (trigramAvailable) tables.push("documents_trigram_fts");
      for (const table of tables) {
        const count = Number(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
        if (count < documents.length) {
          const present = new Set(
            database.prepare(`SELECT document_id FROM ${table}`).all().map((row) => row.document_id)
          );
          for (const document of documents) {
            if (!present.has(document.document_id)) {
              upsertSearchDocument(document, core.loadCapsule(document.capsule_id).text);
            }
          }
        }
      }
    }
    const ranked = new Map();
    if (database && terms.length) {
      const candidateLimit = Math.min(300, limit * 20);
      const quotedTerms = terms.map((term) => `"${term.replaceAll("\"", "\"\"")}"`).join(" AND ");
      const matchers = [
        ftsRows(database, "documents_fts", quotedTerms, candidateLimit),
        ftsRows(database, "documents_porter_fts", quotedTerms, candidateLimit),
      ];
      if (trigramAvailable && String(query).trim().length >= 3) {
        matchers.push(ftsRows(
          database,
          "documents_trigram_fts",
          `"${String(query).replaceAll("\"", "\"\"")}"`,
          candidateLimit
        ));
      }
      if (matchers.every((rows) => rows.length === 0)) {
        const corrected = correctedTerms(database, terms);
        if (corrected.some((term, index) => term !== terms[index])) {
          terms = corrected;
          const expression = corrected.map((term) => `"${term.replaceAll("\"", "\"\"")}"`).join(" AND ");
          matchers.push(ftsRows(database, "documents_porter_fts", expression, candidateLimit));
        }
      }
      matchers.forEach((rows) => rows.forEach((row, rankIndex) => {
        const item = ranked.get(row.document_id) || { score: 0, strategies: 0 };
        item.score += 1 / (60 + rankIndex + 1);
        item.strategies += 1;
        ranked.set(row.document_id, item);
      }));
    }

    if (!database && terms.length) {
      // The portable catalog scan has no FTS vocabulary table.  Only attempt
      // typo correction when the original query has no evidence at all, so a
      // real substring or stem match is never rewritten speculatively.
      const originalMatch = documents.some((document) => {
        if (!documentMatchesFilters(document, args)) return false;
        const archived = core.loadCapsule(document.capsule_id);
        const lower = String(archived.text).toLowerCase();
        return lower.includes(String(query).toLowerCase()) ||
          fallbackContentMatches(archived.text, terms) > 0;
      });
      if (!originalMatch) {
        const vocabulary = documents.flatMap((document) => {
          const archived = core.loadCapsule(document.capsule_id);
          return fallbackSearchTokens(`${document.title} ${archived.text}`);
        });
        const corrected = correctedTermsFromVocabulary(terms, vocabulary);
        if (corrected.some((term, index) => term !== terms[index])) terms = corrected;
      }
    }

    const scored = [];
    const candidates = ranked.size ? [...ranked.keys()] : documents.map((document) => document.document_id);
    for (const documentId of candidates) {
      const document = catalog.documents[documentId];
      if (!document || !documentMatchesFilters(document, args)) continue;
      const archived = core.loadCapsule(document.capsule_id);
      const lower = archived.text.toLowerCase();
      const exact = lower.includes(String(query).toLowerCase());
      const contentMatches = database
        ? terms.reduce((sum, term) => sum + Math.min(20, lower.split(term).length - 1), 0)
        : fallbackContentMatches(archived.text, terms);
      if (!ranked.size && !exact && !contentMatches) continue;
      const fused = ranked.get(documentId);
      const score = (fused ? fused.score * 1_000 : contentMatches) +
        (exact ? 12 : 0) +
        proximityBoost(archived.text, terms) +
        (String(document.title).toLowerCase().includes(String(query).toLowerCase()) ? 4 : 0);
      scored.push({
        document_id: document.document_id,
        capsule_id: document.capsule_id,
        source: document.source,
        title: document.title,
        kind: document.kind,
        content_type: document.content_type,
        tags: document.tags,
        indexed_at: document.indexed_at,
        stale: staleState(document),
        strategies: fused ? fused.strategies : 1,
        score: Number(score.toFixed(6)),
        snippet: snippetFor(archived.text, terms, int(args.snippet_chars, 900, 200, 2_000)),
      });
    }
    if (args.sort === "timeline") {
      scored.sort((a, b) => String(b.indexed_at).localeCompare(String(a.indexed_at)));
    } else {
      scored.sort((a, b) => b.score - a.score || a.source.localeCompare(b.source));
    }
    return {
      query,
      corrected_query: terms.join(" ") === tokenize(query).join(" ") ? null : terms.join(" "),
      results: scored.slice(0, limit),
    };
  });
  return { response: { searches: response, indexed_documents: documents.length }, capturedChars: 0 };
}

function remember(args = {}) {
  if (!args.content || typeof args.content !== "string") throw new Error("content is required");
  const tag = args.tag || "note";
  return indexContent({
    ...args,
    kind: "memory",
    source: args.source || `memory://${tag}/${new Date().toISOString()}`,
    title: args.title || tag,
  });
}

function spawnCapture(spec, defaults = {}) {
  return new Promise((resolve, reject) => {
    if (!spec.command || typeof spec.command !== "string") {
      reject(new Error("batch command is required"));
      return;
    }
    const commandArgs = spec.args || [];
    if (!Array.isArray(commandArgs) || commandArgs.some((item) => typeof item !== "string")) {
      reject(new Error("batch args must be an array of strings"));
      return;
    }
    const cwd = path.resolve(spec.cwd || defaults.cwd || process.cwd());
    const timeout = int(spec.timeout_ms, int(defaults.timeout_ms, 30_000, 100, 300_000), 100, 300_000);
    const maxBytes = int(spec.max_output_bytes, 32 * 1024 * 1024, 4_096, 128 * 1024 * 1024);
    const started = Date.now();
    const plan = core.commandSpawnPlan(spec.command, commandArgs, { cwd });
    const child = spawn(plan.command, plan.args, { cwd, env: plan.env, shell: false, windowsHide: true });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let overflow = false;
    const timer = setTimeout(() => child.kill(), timeout);
    const collect = (bucket, chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        overflow = true;
        child.kill();
      } else {
        bucket.push(chunk);
      }
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (overflow) {
        reject(new Error(`command output exceeded max_output_bytes (${maxBytes})`));
        return;
      }
      resolve({
        command: spec.command,
        args: commandArgs,
        cwd,
        exit_code: code,
        signal,
        elapsed_ms: Date.now() - started,
        text: `# stdout\n${Buffer.concat(stdout).toString("utf8")}\n# stderr\n${Buffer.concat(stderr).toString("utf8")}`,
      });
    });
  });
}

async function batchCommands(args = {}) {
  if (!Array.isArray(args.commands) || !args.commands.length) throw new Error("commands is required");
  const concurrency = int(args.concurrency, 4, 1, 8);
  const batchId = `batch_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
  const results = new Array(args.commands.length);
  let cursor = 0;
  async function worker() {
    while (cursor < args.commands.length) {
      const index = cursor++;
      const spec = args.commands[index];
      const captured = await spawnCapture(spec, args);
      const saved = core.saveCapsule({
        kind: "command",
        source: JSON.stringify({ command: captured.command, args: captured.args, cwd: captured.cwd }),
        text: captured.text,
        question: spec.query || spec.question || args.query,
        maxChars: spec.max_chars || args.max_chars || 1_200,
        details: captured,
      });
      const compact = compressText(captured.text, {
        command: captured.command,
        args: captured.args,
        cwd: captured.cwd,
        profile: spec.profile,
        query: spec.query || spec.question || args.query,
        max_chars: spec.max_chars || args.max_chars,
        passthrough_chars: spec.passthrough_chars || args.passthrough_chars,
      });
      const operation = attachArchive(compact, saved.response.capsule_id, {
        label: spec.label || `command-${index + 1}`,
        exit_code: captured.exit_code,
        elapsed_ms: captured.elapsed_ms,
      });
      results[index] = operation.response;
      if (args.index_output !== false && spec.index_output !== false) {
        addDocument({
          source: `batch://${batchId}/${index + 1}`,
          title: spec.label || `command-${index + 1}`,
          content: captured.text,
          kind: "batch-output",
          tags: ["batch", batchId, compact.profile],
          content_type: "prose",
        });
      }
      compat.recordHistory({
        command: captured.command,
        args: captured.args,
        cwd: captured.cwd,
        profile: compact.profile,
        route: compact.route,
        raw_chars: compact.raw_chars,
        emitted_chars: core.renderOperation(operation).length,
        exit_code: captured.exit_code,
        source: "batch",
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, args.commands.length) }, worker));
  const capturedChars = results.reduce((sum, item) => sum + item.original_chars, 0);
  const queries = Array.isArray(args.queries) ? args.queries : args.query ? [args.query] : [];
  const searched = queries.length
    ? searchIndex({ queries, kind: "batch-output", tags: [batchId], limit: args.limit }).response.searches
    : [];
  return { response: { batch_id: batchId, concurrency, results, searches: searched }, capturedChars };
}

function fetchCachePath() {
  return path.join(indexPaths().root, "fetch-cache.json");
}

function readFetchCache() {
  try {
    return JSON.parse(fs.readFileSync(fetchCachePath(), "utf8"));
  } catch {
    return { version: 1, entries: {} };
  }
}

function writeFetchCache(cache) {
  fs.mkdirSync(indexPaths().root, { recursive: true });
  const target = fetchCachePath();
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
}

function decodeHtmlEntities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return String(value).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_all, entity) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] || _all;
    const number = entity[1].toLowerCase() === "x"
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(number) ? String.fromCodePoint(number) : _all;
  });
}

function htmlToMarkdown(html) {
  return decodeHtmlEntities(String(html)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|svg|noscript)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_all, level, text) => `\n${"#".repeat(Number(level))} ${text}\n`)
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<(?:p|div|section|article|header|footer|main|aside|nav|ul|ol|li|pre|blockquote|br)\b[^>]*>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|header|footer|main|aside|nav|ul|ol|li|pre|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim());
}

function normalizeFetchedContent(buffer, contentType) {
  const text = buffer.toString("utf8");
  if (/json/i.test(contentType)) {
    try {
      return { content: JSON.stringify(JSON.parse(text), null, 2), content_type: "code" };
    } catch {
      return { content: text, content_type: "prose" };
    }
  }
  if (/html|xhtml/i.test(contentType) || /<html[\s>]/i.test(text.slice(0, 2_000))) {
    return { content: htmlToMarkdown(text), content_type: "prose" };
  }
  return { content: text, content_type: /\bjavascript|typescript|xml\b/i.test(contentType) ? "code" : "prose" };
}

async function fetchOne(spec, defaults, cache) {
  if (!spec.url || typeof spec.url !== "string") throw new Error("url is required");
  const timeout = int(spec.timeout_ms, int(defaults.timeout_ms, 30_000, 500, 120_000), 500, 120_000);
  const maxBytes = int(spec.max_bytes, int(defaults.max_bytes, 8 * 1024 * 1024, 1_024, 32 * 1024 * 1024), 1_024, 32 * 1024 * 1024);
  const ttlMs = int(spec.ttl_ms, int(defaults.ttl_ms, 24 * 60 * 60 * 1_000, 0, 30 * 24 * 60 * 60 * 1_000), 0, 30 * 24 * 60 * 60 * 1_000);
  const cacheKey = hash(JSON.stringify({ url: spec.url, headers: spec.headers || defaults.headers || {} }));
  const cached = cache.entries[cacheKey];
  if (!spec.refresh && cached && Date.now() - cached.fetched_at_ms <= ttlMs) {
    return { ...cached.response, cached: true };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(spec.url, {
      signal: controller.signal,
      headers: {
        "user-agent": `Capsule/${packageMetadata.version}`,
        ...(defaults.headers || {}),
        ...(spec.headers || {}),
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`response exceeded max_bytes (${maxBytes})`);
    const normalized = normalizeFetchedContent(buffer, response.headers.get("content-type") || "");
    const indexed = indexContent({
      content: normalized.content,
      source: spec.source || spec.url,
      title: spec.title || spec.url,
      kind: "fetch",
      tags: spec.tags || defaults.tags || [],
      content_type: normalized.content_type,
      chunk_chars: spec.chunk_chars || defaults.chunk_chars,
    });
    const result = {
      url: spec.url,
      final_url: response.url,
      status: response.status,
      bytes: buffer.length,
      content_type: response.headers.get("content-type") || "",
      cached: false,
      ...indexed.response,
    };
    cache.entries[cacheKey] = { fetched_at_ms: Date.now(), response: result };
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAndIndex(args = {}) {
  const requests = Array.isArray(args.requests) ? args.requests : args.url ? [{ ...args, url: args.url }] : [];
  if (!requests.length) {
    throw new Error("fetch requires payload.url or payload.requests=[{url:...}]; copy the real URL from the task and retry");
  }
  const cache = readFetchCache();
  const results = new Array(requests.length);
  const concurrency = int(args.concurrency, 4, 1, 8);
  let cursor = 0;
  async function worker() {
    while (cursor < requests.length) {
      const index = cursor++;
      results[index] = await fetchOne(requests[index], args, cache);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, worker));
  const oldest = Date.now() - 30 * 24 * 60 * 60 * 1_000;
  for (const [key, entry] of Object.entries(cache.entries)) {
    if (entry.fetched_at_ms < oldest) delete cache.entries[key];
  }
  writeFetchCache(cache);
  return {
    response: { concurrency, results },
    capturedChars: results.reduce((sum, item) => sum + Number(item.bytes || 0), 0),
  };
}

function stats(args = {}) {
  const ledger = core.exposureLedger(args).response;
  const catalog = readCatalog();
  const documents = Object.values(catalog.documents);
  const state = indexPaths();
  return {
    response: {
      ...ledger,
      state_root: core.stateRoot(),
      index: {
        documents: documents.length,
        chars_archived: documents.reduce((sum, item) => sum + item.chars, 0),
        memories: documents.filter((item) => item.kind === "memory").length,
        sqlite_fts5: Boolean(DatabaseSync),
        database_bytes: fs.existsSync(state.database) ? fs.statSync(state.database).size : 0,
      },
      standalone: { node: process.version },
      compatibility: compat.gain(args).response,
    },
    capturedChars: 0,
  };
}

function codexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function firstSessionMetadata(file, maxBytes = 2 * 1024 * 1024) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    const chunks = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (total < maxBytes) {
      const requested = Math.min(buffer.length, maxBytes - total);
      const read = fs.readSync(descriptor, buffer, 0, requested, null);
      if (!read) break;
      const newline = buffer.subarray(0, read).indexOf(0x0a);
      const visible = newline >= 0 ? newline : read;
      chunks.push(Buffer.from(buffer.subarray(0, visible)));
      total += read;
      if (newline >= 0) {
        const record = JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/\r$/, ""));
        return record && record.type === "session_meta" ? record.payload || {} : null;
      }
    }
  } catch {
    return null;
  } finally {
    if (descriptor != null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // A diagnostics-only file may disappear during a concurrent Codex write.
      }
    }
  }
  return null;
}

function historyAudit(args = {}) {
  if (args.deep === true || args.line_scan === true) {
    return sessionAudit.scanHistory(args);
  }
  const roots = [
    path.join(codexHome(), "sessions"),
    path.join(codexHome(), "archived_sessions"),
  ];
  const maxFiles = int(args.history_max_files, 10_000, 1, 100_000);
  const existingRoots = roots.filter((root) => fs.existsSync(root));
  const stack = [...existingRoots];
  const files = [];
  const visited = new Set();
  while (stack.length && files.length < maxFiles) {
    const current = stack.pop();
    let real;
    try {
      real = fs.realpathSync(current);
    } catch {
      continue;
    }
    if (visited.has(real)) continue;
    visited.add(real);
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) files.push(target);
      if (files.length >= maxFiles) break;
    }
  }

  let rootSessions = 0;
  let subagentSessions = 0;
  let unreadable = 0;
  let rootBytes = 0;
  let subagentBytes = 0;
  const parents = new Map();
  for (const file of files) {
    let bytes = 0;
    try {
      bytes = fs.statSync(file).size;
    } catch {
      unreadable += 1;
      continue;
    }
    const metadata = firstSessionMetadata(file);
    if (!metadata) {
      unreadable += 1;
      continue;
    }
    const parent = typeof metadata.parent_thread_id === "string" ? metadata.parent_thread_id : "";
    const subagent = Boolean(parent) || (metadata.source && typeof metadata.source === "object");
    if (!subagent) {
      rootSessions += 1;
      rootBytes += bytes;
      continue;
    }
    subagentSessions += 1;
    subagentBytes += bytes;
    if (!parent) continue;
    const key = crypto.createHash("sha256").update(parent).digest("hex").slice(0, 12);
    const current = parents.get(key) || { parent_hash: key, children: 0, child_bytes: 0 };
    current.children += 1;
    current.child_bytes += bytes;
    parents.set(key, current);
  }
  const totalBytes = rootBytes + subagentBytes;
  const parentFanout = [...parents.values()]
    .sort((left, right) => right.child_bytes - left.child_bytes || right.children - left.children)
    .slice(0, int(args.history_parent_limit, 10, 1, 100));
  const subagentRatio = totalBytes ? Number((subagentBytes / totalBytes).toFixed(4)) : 0;
  return {
    roots_scanned: existingRoots.length,
    sessions: {
      total: rootSessions + subagentSessions + unreadable,
      root: rootSessions,
      subagent: subagentSessions,
      unreadable,
      reached_file_limit: files.length >= maxFiles,
    },
    bytes: {
      total: totalBytes,
      root: rootBytes,
      subagent: subagentBytes,
      subagent_ratio: subagentRatio,
    },
    parent_fanout: parentFanout,
    content_read: false,
    automatic_changes: false,
    guidance: subagentRatio >= 0.25 || parentFanout.some((item) => item.children >= 8)
      ? "High full-history fan-out detected. Use fork_turns:none for self-contained work, a small numeric window for bounded dependencies, and all only when the child truly needs the complete conversation."
      : "No high full-history fan-out was detected in the bounded metadata audit.",
  };
}

function skillCatalogAudit() {
  const root = path.join(codexHome(), "skills");
  const stack = [{ directory: root, depth: 0 }];
  const visited = new Set();
  let entries = 0;
  let metadataChars = 0;
  while (stack.length && entries < 2_000) {
    const { directory, depth } = stack.pop();
    let real;
    try {
      real = fs.realpathSync(directory);
    } catch {
      continue;
    }
    if (visited.has(real)) continue;
    visited.add(real);
    let children;
    try {
      children = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      const target = path.join(directory, child.name);
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory() && depth < 6) {
        stack.push({ directory: target, depth: depth + 1 });
        continue;
      }
      if (!child.isFile() || child.name.toLowerCase() !== "skill.md") continue;
      try {
        const head = fs.readFileSync(target, "utf8").slice(0, 64_000);
        const frontmatter = head.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
        if (!frontmatter) continue;
        entries += 1;
        metadataChars += frontmatter[1].length + path.relative(root, target).length + 16;
      } catch {
        // An unreadable optional skill should not fail diagnostics.
      }
    }
  }
  const approxTokens = Math.ceil(metadataChars / 4);
  const vault = readSkillVault();
  const virtualizationActive = Boolean(vault?.active);
  const virtualizedSkills = virtualizationActive ? Number(vault.skills || 0) : 0;
  const metadataTokensAvoided = virtualizationActive
    ? Math.ceil(Number(vault.metadata_chars || 0) / 4)
    : 0;
  return {
    root,
    entries,
    metadata_chars: metadataChars,
    approx_tokens: approxTokens,
    virtualization_recommended: !virtualizationActive && approxTokens >= 1_000,
    virtualization_active: virtualizationActive,
    virtualized_skills: virtualizedSkills,
    metadata_tokens_avoided: metadataTokensAvoided,
    automatic_changes: false,
    guidance: virtualizationActive
      ? `${virtualizedSkills} specialist skills are routed from the reversible vault; approximately ${metadataTokensAvoided} direct metadata tokens are avoided per model request.`
      : approxTokens >= 1_000
      ? "A large direct skill catalog was detected. Keep specialist skills available, but virtualize them only through an explicit, reversible user-approved workflow."
      : "Direct skill metadata is within the conservative budget.",
  };
}

function frontmatterField(frontmatter, name) {
  const match = String(frontmatter).match(new RegExp(`^${name}:\\s*(.+)$`, "mi"));
  if (!match) return "";
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

function scanRoutableSkills(root = path.join(codexHome(), "skills"), options = {}) {
  const skills = [];
  const stack = [];
  const ignoredDirectory = (name) =>
    /^plugin-backup-/i.test(String(name || "")) ||
    [".remote-plugin-install-staging", ".plugin-appserver"].includes(String(name || "").toLowerCase());
  let topEntries = [];
  try {
    topEntries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const entry of topEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() ||
        ignoredDirectory(entry.name) ||
        (!options.include_hidden && entry.name.startsWith("."))) continue;
    stack.push({ directory: path.join(root, entry.name), root_entry: entry.name, depth: 0 });
  }
  const visited = new Set();
  while (stack.length && skills.length < 2_000) {
    const current = stack.pop();
    let real;
    try {
      real = fs.realpathSync(current.directory);
    } catch {
      continue;
    }
    if (visited.has(real)) continue;
    visited.add(real);
    let children;
    try {
      children = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      const target = path.join(current.directory, child.name);
      if (child.isDirectory() && !child.isSymbolicLink() && current.depth < 8) {
        if (ignoredDirectory(child.name)) continue;
        stack.push({ directory: target, root_entry: current.root_entry, depth: current.depth + 1 });
        continue;
      }
      if (!child.isFile() || child.name.toLowerCase() !== "skill.md") continue;
      try {
        const text = fs.readFileSync(target, "utf8").slice(0, 64_000);
        const matched = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
        if (!matched) continue;
        const name = frontmatterField(matched[1], "name") || path.basename(path.dirname(target));
        const description = frontmatterField(matched[1], "description");
        skills.push({
          name,
          description,
          skill_file: target,
          root_entry: current.root_entry,
          metadata_chars: matched[1].length + path.relative(root, target).length + 16,
          mtime_ms: Number(fs.statSync(target).mtimeMs || 0),
        });
      } catch {
        // An unreadable optional skill should not prevent routing other skills.
      }
    }
  }
  return skills;
}

function capabilityAirlockFile() {
  const digest = crypto.createHash("sha256").update(codexHome()).digest("hex").slice(0, 16);
  return path.join(core.stateRoot(), `capability-airlock-${digest}.json`);
}

function readCapabilityAirlock() {
  try {
    const parsed = JSON.parse(fs.readFileSync(capabilityAirlockFile(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeCapabilityAirlock(state) {
  const file = capabilityAirlockFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex");
}

function installedPluginSkillRoots(home) {
  try {
    const listed = spawnSync("codex", ["plugin", "list", "--json"], {
      cwd: home,
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      env: process.env,
    });
    if (listed.status !== 0 || !listed.stdout) return [];
    const parsed = JSON.parse(listed.stdout);
    return (parsed.installed || []).filter((item) => item.installed && item.enabled !== false)
      .flatMap((item) => {
        const roots = [];
        const cached = path.join(
          home,
          "plugins",
          "cache",
          String(item.marketplaceName || ""),
          String(item.name || ""),
          String(item.version || "")
        );
        if (fs.existsSync(cached)) roots.push(cached);
        const source = String(item.source?.path || "");
        if (source && fs.existsSync(source)) roots.push(source);
        return roots;
      });
  } catch {
    return [];
  }
}

function capabilitySkills(options = {}) {
  const home = codexHome();
  const vault = readSkillVault();
  const installedRoots = installedPluginSkillRoots(home);
  const roots = [
    options.include_vault !== false && vault?.active && vault.snapshot_root
      ? path.join(vault.snapshot_root, "entries")
      : "",
    path.join(home, "skills"),
    path.join(home, "skills", ".system"),
    ...(installedRoots.length ? installedRoots : [path.join(home, "plugins", "cache")]),
  ].filter(Boolean);
  const candidates = roots.flatMap((root) =>
    scanRoutableSkills(root, { include_hidden: root.endsWith(`${path.sep}.system`) })
  );
  const byName = new Map();
  for (const skill of candidates) {
    const key = String(skill.name || "").trim().toLowerCase();
    const prior = byName.get(key);
    if (!prior || Number(skill.mtime_ms || 0) > Number(prior.mtime_ms || 0)) byName.set(key, skill);
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function setStaticSkillInstructions(text, enabled) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  const value = enabled ? "true" : "false";
  const section = source.match(/^\[skills\]\s*$/m);
  if (!section) return `${source.trimEnd()}\n\n[skills]\ninclude_instructions = ${value}\n`;
  const start = section.index + section[0].length;
  const rest = source.slice(start);
  const nextSection = rest.search(/^\[[^\]\r\n]+\]\s*$/m);
  const end = nextSection < 0 ? source.length : start + nextSection;
  const body = source.slice(start, end);
  if (/^\s*include_instructions\s*=/m.test(body)) {
    return source.slice(0, start) +
      body.replace(/^\s*include_instructions\s*=.*$/m, `\ninclude_instructions = ${value}`) +
      source.slice(end);
  }
  return `${source.slice(0, start)}\ninclude_instructions = ${value}${source.slice(start)}`;
}

const AIRLOCK_START = "<!-- capsule-capability-airlock:start -->";
const AIRLOCK_END = "<!-- capsule-capability-airlock:end -->";
const AIRLOCK_PROJECT_RULE_LEGACY =
  "- Proje veya klasor kod tabanini anlamada `action=project`, `operation=query|impact|scan|status|gc` kullan; ham dosyalari ancak exact kanit gerektiginde genislet.";
const AIRLOCK_PROJECT_RULE =
  "- Proje veya klasor kod tabanini anlamada `action=project`, `operation=query|refactor|impact|scan|status|gc` kullan; refactor icin sembol-hash etki konisini tercih et; ham dosyalari ancak exact kanit gerektiginde genislet.";
const AIRLOCK_AGENTS_RULES = [
  AIRLOCK_PROJECT_RULE,
  "- Sinirli metin duzenlemede mevcutsa native `apply_patch|Write|Edit|Update` kullan; gecici Python/PowerShell/Node scripti kullanma. Bulk/uretim/formatter/migration/binary/medya veya native arac yoksa shell serbesttir. Codex'i yalniz kullanici bu tur acikca isterse yeniden baslat.",
  "- Her gorev basinda Capsule action=skills, payload.operation=route bicimini ve literal istegini koruyan kisa Ingilizce sorguyu kullan; istenmeyen alan/teknoloji/cikti turu ekleme ve yalniz ilk `skill_file`i oku. Eslesme yoksa yerel calis. Capsule gorunmez veya bu turda hata verirse kesfet ve bir kez yeniden dene; denemeden `erisilemedi` deme; onceki tur hatasini tasima. Yalniz guncel `mcp__capsule__capsule` cagri sonucu `isError:true` veya `Unknown action` gorulurse arac yoklugunu bildir; tahmin etme; dahili ad veya genel urun iddiasi kullanma. `fetch` icin gercek `payload.url|requests`; `expand|diff` onceki gercek `payload.capsule_id` ister; kimlik uydurma.",
  "- Ana gorevin modelini alt ajan yonlendirmesi icin degistirme; kullanicinin model secimini aynen koru.",
  "- Rutin alt gorevleri Capsule `action=cognition`, `operation=delegate` ile gercek `gpt-5.6-luna` uzerinde calistir; karmasik veya yuksek riskli islerde `model=gpt-5.6-terra` kullan. `collaboration.spawn_agent` Luna'yi acik model olarak desteklemediginden Luna gerektiren islerde onu kullanma.",
];

function canonicalizeAirlockProjectRule(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line === AIRLOCK_PROJECT_RULE_LEGACY ? AIRLOCK_PROJECT_RULE : line)
    .join("\n");
}

function airlockAgentsBlock(text) {
  const source = canonicalizeAirlockProjectRule(text);
  const start = source.indexOf(AIRLOCK_START);
  const end = source.indexOf(AIRLOCK_END, start);
  const external = start >= 0 && end >= start
    ? source.slice(0, start) + source.slice(end + AIRLOCK_END.length)
    : source;
  const externalLines = new Set(external.split("\n"));
  const rules = AIRLOCK_AGENTS_RULES.filter((rule) => !externalLines.has(rule));
  return [AIRLOCK_START, ...rules, AIRLOCK_END].join("\n");
}

function addAirlockAgentsBlock(text) {
  const source = canonicalizeAirlockProjectRule(text);
  const block = airlockAgentsBlock(source);
  if (source.includes(AIRLOCK_START)) {
    const start = source.indexOf(AIRLOCK_START);
    const end = source.indexOf(AIRLOCK_END, start);
    if (end >= 0) return source.slice(0, start) + block + source.slice(end + AIRLOCK_END.length);
  }
  return `${source.trimEnd()}\n\n${block}\n`;
}

function removeAirlockAgentsBlock(text) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  const start = source.indexOf(AIRLOCK_START);
  const end = source.indexOf(AIRLOCK_END, start);
  if (start < 0 || end < start ||
      source.indexOf(AIRLOCK_START, start + AIRLOCK_START.length) >= 0 ||
      source.indexOf(AIRLOCK_END, end + AIRLOCK_END.length) >= 0) {
    throw new Error("capability airlock refresh requires exactly one intact managed AGENTS.md block");
  }
  return source.slice(0, start) + source.slice(end + AIRLOCK_END.length);
}

function removeStaticSkillInstruction(text, removeEmptySection = false) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  const section = source.match(/^\[skills\]\s*$/m);
  if (!section) return source;
  const start = section.index + section[0].length;
  const rest = source.slice(start);
  const nextSection = rest.search(/^\[[^\]\r\n]+\]\s*$/m);
  const end = nextSection < 0 ? source.length : start + nextSection;
  const body = source.slice(start, end);
  const updated = body.replace(/^[ \t]*include_instructions[ \t]*=.*(?:\n|$)/m, "\n");
  if (removeEmptySection && !updated.trim()) {
    return `${source.slice(0, section.index).trimEnd()}\n${source.slice(end).replace(/^\n+/, "")}`;
  }
  return source.slice(0, start) + updated + source.slice(end);
}

function restoreStaticSkillInstruction(current, originalBaseline) {
  const baseline = String(originalBaseline || "").replace(/\r\n/g, "\n");
  const prior = baseline.match(/^[ \t]*include_instructions[ \t]*=[ \t]*(true|false)[ \t]*$/m);
  if (prior) return setStaticSkillInstructions(current, prior[1] === "true");
  return removeStaticSkillInstruction(current, !/^\[skills\]\s*$/m.test(baseline));
}

function capabilityAirlockPlan() {
  const home = codexHome();
  const configFile = path.join(home, "config.toml");
  const agentsFile = path.join(home, "AGENTS.md");
  const config = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : "";
  const agents = fs.existsSync(agentsFile) ? fs.readFileSync(agentsFile, "utf8") : "";
  const injectedAgentsBlock = airlockAgentsBlock(agents);
  const skills = capabilitySkills({ include_vault: false });
  const metadataChars = skills.reduce((sum, skill) => sum + Number(skill.metadata_chars || 0), 0);
  const active = Boolean(readCapabilityAirlock()?.active) &&
    /^\s*include_instructions\s*=\s*false\s*$/m.test(config);
  return {
    response: {
      operation: "airlock-plan",
      active,
      skills: skills.length,
      metadata_chars: metadataChars,
      estimated_static_metadata_tokens_per_request: Math.ceil(metadataChars / 4),
      airlock_anchor_chars: injectedAgentsBlock.length,
      estimated_airlock_anchor_tokens_per_request: Math.ceil(injectedAgentsBlock.length / 4),
      config_file: configFile,
      agents_file: agentsFile,
      changes_made: false,
      reversible: true,
    },
    capturedChars: 0,
  };
}

function applyCapabilityAirlock(args = {}) {
  if (args.confirm !== true) throw new Error("confirm:true is required for skills airlock-apply");
  const prior = readCapabilityAirlock();
  if (prior?.active) throw new Error("capability airlock is already active");
  const home = codexHome();
  const configFile = path.join(home, "config.toml");
  const agentsFile = path.join(home, "AGENTS.md");
  fs.mkdirSync(home, { recursive: true });
  const beforeConfig = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : "";
  const beforeAgents = fs.existsSync(agentsFile) ? fs.readFileSync(agentsFile, "utf8") : "";
  const afterConfig = setStaticSkillInstructions(beforeConfig, false);
  const afterAgents = addAirlockAgentsBlock(beforeAgents);
  const temporaryConfig = `${configFile}.${process.pid}.${Date.now()}.tmp`;
  const temporaryAgents = `${agentsFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryConfig, afterConfig, "utf8");
  fs.writeFileSync(temporaryAgents, afterAgents, "utf8");
  fs.renameSync(temporaryConfig, configFile);
  fs.renameSync(temporaryAgents, agentsFile);
  const plan = capabilityAirlockPlan().response;
  writeCapabilityAirlock({
    version: 1,
    active: true,
    created_at: new Date().toISOString(),
    config_file: configFile,
    agents_file: agentsFile,
    before_config: beforeConfig,
    before_agents: beforeAgents,
    after_config_sha256: sha256Text(afterConfig),
    after_agents_sha256: sha256Text(afterAgents),
    skills: plan.skills,
    metadata_chars: plan.metadata_chars,
  });
  return {
    response: {
      ...plan,
      operation: "airlock-apply",
      active: true,
      changes_made: true,
      requires_restart: true,
    },
    capturedChars: 0,
  };
}

function refreshCapabilityAirlock(args = {}) {
  if (args.confirm !== true) throw new Error("confirm:true is required for skills airlock-refresh");
  const state = readCapabilityAirlock();
  if (!state?.active) throw new Error("capability airlock is not active");
  const currentConfig = fs.existsSync(state.config_file) ? fs.readFileSync(state.config_file, "utf8") : "";
  const currentAgents = fs.existsSync(state.agents_file) ? fs.readFileSync(state.agents_file, "utf8") : "";
  if (!/^[ \t]*include_instructions[ \t]*=[ \t]*false[ \t]*$/m.test(currentConfig)) {
    throw new Error("capability airlock refresh refused because static skill injection is no longer disabled");
  }
  const beforeConfig = restoreStaticSkillInstruction(currentConfig, state.before_config);
  const beforeAgents = removeAirlockAgentsBlock(currentAgents);
  const afterConfig = setStaticSkillInstructions(currentConfig, false);
  const afterAgents = addAirlockAgentsBlock(beforeAgents);
  const temporaryConfig = `${state.config_file}.${process.pid}.${Date.now()}.tmp`;
  const temporaryAgents = `${state.agents_file}.${process.pid}.${Date.now()}.tmp`;
  let configReplaced = false;
  let agentsReplaced = false;
  try {
    fs.writeFileSync(temporaryConfig, afterConfig, "utf8");
    fs.writeFileSync(temporaryAgents, afterAgents, "utf8");
    fs.renameSync(temporaryConfig, state.config_file);
    configReplaced = true;
    fs.renameSync(temporaryAgents, state.agents_file);
    agentsReplaced = true;
    writeCapabilityAirlock({
      ...state,
      before_config: beforeConfig,
      before_agents: beforeAgents,
      after_config_sha256: sha256Text(afterConfig),
      after_agents_sha256: sha256Text(afterAgents),
      refreshed_at: new Date().toISOString(),
    });
  } catch (error) {
    if (agentsReplaced) fs.writeFileSync(state.agents_file, currentAgents, "utf8");
    if (configReplaced) fs.writeFileSync(state.config_file, currentConfig, "utf8");
    throw error;
  } finally {
    if (fs.existsSync(temporaryConfig)) fs.rmSync(temporaryConfig, { force: true });
    if (fs.existsSync(temporaryAgents)) fs.rmSync(temporaryAgents, { force: true });
  }
  return {
    response: {
      operation: "airlock-refresh",
      active: true,
      refreshed: true,
      preserved_external_changes: true,
      requires_restart: true,
      reversible: true,
    },
    capturedChars: 0,
  };
}

function restoreCapabilityAirlock(args = {}) {
  if (args.confirm !== true) throw new Error("confirm:true is required for skills airlock-restore");
  const state = readCapabilityAirlock();
  if (!state?.active) throw new Error("capability airlock is not active");
  const currentConfig = fs.existsSync(state.config_file) ? fs.readFileSync(state.config_file, "utf8") : "";
  const currentAgents = fs.existsSync(state.agents_file) ? fs.readFileSync(state.agents_file, "utf8") : "";
  if (sha256Text(currentConfig) !== state.after_config_sha256 ||
      sha256Text(currentAgents) !== state.after_agents_sha256) {
    throw new Error("capability airlock restore refused because config or AGENTS.md changed after apply");
  }
  fs.writeFileSync(state.config_file, state.before_config, "utf8");
  fs.writeFileSync(state.agents_file, state.before_agents, "utf8");
  writeCapabilityAirlock({ ...state, active: false, restored_at: new Date().toISOString() });
  return {
    response: {
      operation: "airlock-restore",
      active: false,
      restored: true,
      requires_restart: true,
      reversible: true,
    },
    capturedChars: 0,
  };
}

function skillVaultPaths() {
  const root = path.join(codexHome(), "capsule-skill-vault");
  return {
    root,
    manifest: path.join(root, "manifest.json"),
    snapshots: path.join(root, "snapshots"),
  };
}

function readSkillVault() {
  const state = skillVaultPaths();
  try {
    const manifest = JSON.parse(fs.readFileSync(state.manifest, "utf8"));
    return manifest && typeof manifest === "object" ? manifest : null;
  } catch {
    return null;
  }
}

function writeSkillVault(manifest) {
  const state = skillVaultPaths();
  fs.mkdirSync(state.root, { recursive: true });
  const temporary = `${state.manifest}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, state.manifest);
}

function routeSkills(args = {}) {
  const query = String(args.query || "").trim();
  if (!query) throw new Error("query is required for skills route");
  const routeStopwords = new Set([
    "a", "about", "after", "all", "am", "an", "and", "another", "are", "as", "at",
    "automatic", "automatically", "analyze", "assess", "audit", "automate", "be", "been",
    "being", "benchmark", "benchmarking", "build", "but", "by", "can", "clone", "could",
    "codex", "create",
    "compaction", "context", "controls", "current", "detect", "detecting", "diagnose",
    "did", "do", "does", "done", "edit", "efficiency", "everything", "execute", "find",
    "for", "from", "give", "had", "has", "have", "help", "here", "how", "implement",
    "implementing", "improve", "in", "inspect", "is", "it", "its", "just", "latest",
    "make", "manage", "may", "me", "measure", "mcp", "might", "model", "models", "more",
    "most", "must", "my", "need", "new", "next", "now", "of", "on", "optimize", "or",
    "our", "out", "pain", "please", "progress",
    "plugin", "plugins", "quota", "quotas", "real", "recent", "reinstall", "reinstalling",
    "read", "research", "researching", "restart", "review", "run", "safe", "savings",
    "scan", "should", "so", "some", "state", "status", "still", "task", "tasks", "telemetry",
    "tell", "test", "testing", "than", "that", "the", "their", "them", "there", "these",
    "they", "this", "those", "thread", "threads", "to", "token", "tokens", "tool", "tools",
    "turn", "turns", "universal", "up", "update", "using", "use", "user", "users", "verify",
    "want", "was", "wasted", "we", "were", "what", "when", "where", "which", "who", "why",
    "will", "with", "would", "write", "you", "your",
  ]);
  const ambiguousNameTerms = new Set([
    "agent", "assistant", "context", "data", "helper", "manager", "plugin", "skill",
    "token", "tool", "workflow", "hunt", "security", "vulnerability", "vulnerabilities",
  ]);
  const normalizeRouteTerm = (term) => {
    const value = String(term || "").toLowerCase();
    if (value.length > 4 && value.endsWith("ies")) return `${value.slice(0, -3)}y`;
    if (value.length > 4 && value.endsWith("s") && !/(?:ss|us|is)$/.test(value)) return value.slice(0, -1);
    return value;
  };
  const routeTokenize = (value) => tokenize(
    String(value || "").replace(/[^\p{L}\p{N}]+/gu, " ")
  ).map(normalizeRouteTerm);
  const normalizedRouteStopwords = new Set([...routeStopwords].map(normalizeRouteTerm));
  const normalizedAmbiguousNameTerms = new Set([...ambiguousNameTerms].map(normalizeRouteTerm));
  const orderedTerms = routeTokenize(query);
  const allTerms = [...new Set(orderedTerms)];
  const terms = allTerms.filter((term) => !normalizedRouteStopwords.has(term));
  const securityMetaIntent =
    /\b(?:router|routing|skill|plugin|token|context)\b/i.test(query) &&
    /\b(?:false positive|match|route|improve|benchmark|install|reinstall)\b/i.test(query);
  const controlPlaneIntent =
    /\b(?:token|quota|context window|compaction)\b/i.test(query) &&
    /\b(?:saving|savings|efficiency|improve|measure|benchmark|restart|install|reinstall|optimize)\b/i.test(query);
  const specificSecurityIntent =
    /\b(?:xss|sqli|sql injection|ssrf|rce|csrf|xxe|ssti|nosql|oauth|saml|jwt|kerberos|ntlm|session fixation|auth(?:entication|orization)? bypass|privilege escalation|pentest|red[ -]?team|bug bounty|exploit|ctf|capture[ -]the[ -]flag)\b/i.test(query);
  const broadSecurityIntent =
    /\b(?:security|vulnerabilit(?:y|ies)|attack|injection|authorization|authentication)\b/i.test(query) &&
    /\b(?:audit|assess|hunt|scan|test|find|review|exploit|attack|pentest|bug|defect|issue|failure|broken)\b/i.test(query);
  const securityIntent = !securityMetaIntent && (specificSecurityIntent || broadSecurityIntent);
  const routeAliases = [
    ["sql injection", "sqli"],
    ["nosql injection", "nosqli"],
    ["cross site scripting", "xss"],
    ["server side request forgery", "ssrf"],
    ["remote code execution", "rce"],
    ["cross site request forgery", "csrf"],
    ["server side template injection", "ssti"],
    ["xml external entity", "xxe"],
    ["insecure direct object reference", "idor"],
    ["multi factor authentication", "mfa"],
    ["two factor authentication", "2fa"],
  ];
  const vault = readSkillVault();
  const virtualized = Boolean(vault?.active && vault.snapshot_root);
  const airlock = readCapabilityAirlock();
  const skills = airlock?.active
    ? capabilitySkills()
    : scanRoutableSkills(virtualized
      ? path.join(vault.snapshot_root, "entries")
      : path.join(codexHome(), "skills"));
  const searchable = skills.map((skill) => ({
    skill,
    name: routeTokenize(skill.name).join(" "),
    description: routeTokenize(skill.description).join(" "),
    nameTerms: new Set(routeTokenize(skill.name)),
    descriptionTerms: new Set(routeTokenize(skill.description)),
  }));
  const documentFrequency = new Map(terms.map((term) => [
    term,
    searchable.filter((item) => item.nameTerms.has(term) || item.descriptionTerms.has(term)).length,
  ]));
  const phrases = orderedTerms.slice(0, -1)
    .map((term, index) => [term, orderedTerms[index + 1]])
    .filter(([left, right]) => !normalizedRouteStopwords.has(left) && !normalizedRouteStopwords.has(right))
    .map(([left, right]) => `${left} ${right}`);
  const matches = skills.map((skill) => {
    const nameTerms = routeTokenize(skill.name);
    const descriptionTerms = routeTokenize(skill.description);
    const nameSet = new Set(nameTerms);
    const descriptionSet = new Set(descriptionTerms);
    const name = nameTerms.join(" ");
    const description = descriptionTerms.join(" ");
    const normalizedQuery = orderedTerms.join(" ");
    const exactName = name === normalizedQuery;
    const fullNameMention = name.split(/\s+/).length >= 2 && normalizedQuery.includes(name);
    const coreNameTerms = nameTerms.filter((term) =>
      !normalizedRouteStopwords.has(term) && !["artifact", "template"].includes(term)
    );
    const coreName = coreNameTerms.join(" ");
    const coreNameMention = coreNameTerms.length >= 2 && normalizedQuery.includes(coreName);
    const singleCoreNameMention =
      terms.length === 1 && coreNameTerms.length === 1 && terms[0] === coreNameTerms[0];
    const explicitTitleTerms = nameTerms.filter((term) => !["artifact", "template"].includes(term));
    const explicitTitle = explicitTitleTerms.join(" ");
    const explicitTitleMention = explicitTitleTerms.length >= 2 && normalizedQuery.includes(explicitTitle);
    const explicitInvocationSkill =
      name.startsWith("artifact template ") ||
      /\buse when (?:the )?user (?:selects|names|chooses|requests)\b/i.test(skill.description);
    const internalDownstreamSkill =
      /\binternal downstream skill\b|\buse only after\b|\bdo not invoke (?:this )?directly\b/i.test(skill.description);
    const codebaseArchitectureSkill =
      name.includes("codebase architecture") ||
      /\bcodebase architecture\b/i.test(skill.description);
    const codebaseArchitectureIntent =
      /\b(?:codebase|repository|repo|module|refactor|source tree|project structure)\b/i.test(query);
    const thickClientSkill =
      name.includes("thick client") ||
      /\bdesktop thick clients?\b/i.test(skill.description);
    const thickClientIntent =
      /\b(?:desktop|thick[ -]?client|electron|qt|winforms|wpf|native app|installed (?:app|application|client)|local (?:app|application)|\.exe)\b/i.test(query);
    const routerSkill = name === "capsule router";
    const routerIntent =
      /\b(?:skill router|skill routing|route skills?|routing skills?|capability airlock|skill catalog|cognition router)\b/i.test(query);
    const explicitRouterProductMention =
      /\b(?:capsule|capsule)\b/i.test(query) && routerIntent;
    const reverseRouterSkill = name === "reverse skill router";
    const reverseRouterIntent =
      /\b(?:reverse engineering|reverse|binary|apk|malware|firmware|exploit|pentest|penetration test|ctf|pwn)\b/i.test(query);
    const ctfSpecificSkill =
      nameSet.has("ctf") || /\bctf[ -]sandbox\b/i.test(`${skill.name} ${skill.description}`);
    const ctfIntent =
      /\b(?:ctf|capture[ -]the[ -]flag|sandbox|security competition|ctf challenge)\b/i.test(query);
    const productDesignAuditSkill =
      name === "audit" &&
      /\b(?:product flow|product experience)\b/i.test(skill.description) &&
      /\bux\b/i.test(skill.description);
    const productDesignAuditIntent =
      /\b(?:ui|ux|user interface|front[ -]?end|screen|page|product experience)\b/i.test(query) &&
      /\b(?:audit|review|critique|inspect|assess|analyze|evaluate|improve|fix)\b/i.test(query);
    const securitySkill =
      /^(?:hunt|competition|ctf|triage validation|code audit|security|redteam|pwn|exploit|pentest|src hunter)(?: |$)|\b(?:vulnerabilit(?:y|ies)|penetration test|pentest|red[ -]?team|bug bounty|capture[ -]the[ -]flag|ctf|security review|sast|exploit|attack surface|injection|bypass)\b/i.test(
        `${name} ${description}`
      );
    const aliasMatched = routeAliases.some(([phrase, alias]) =>
      normalizedQuery.includes(phrase) && (nameSet.has(alias) || descriptionSet.has(alias))
    );
    const productDesignAuditMatched = productDesignAuditSkill && productDesignAuditIntent;
    let score = exactName ? 100 : fullNameMention ? 50 : 0;
    if (aliasMatched) score += 96;
    if (productDesignAuditMatched) score += 96;
    let matchedTerms = 0;
    let strongNameTerm = false;
    let strongNameRarity = 0;
    let strongDescriptionTerm = false;
    for (const term of terms) {
      const frequency = Number(documentFrequency.get(term) || 0);
      const rarity = 1 + Math.log((skills.length + 1) / (frequency + 1));
      const inName = nameSet.has(term);
      const inDescription = descriptionSet.has(term);
      if (inName || inDescription) matchedTerms += 1;
      if (inName && term.length >= 4 && !normalizedAmbiguousNameTerms.has(term)) {
        strongNameTerm = true;
        strongNameRarity = Math.max(strongNameRarity, rarity);
      }
      if (inDescription && term.length >= 4 && !normalizedAmbiguousNameTerms.has(term) &&
          frequency <= Math.max(3, Math.ceil(skills.length * 0.08))) {
        strongDescriptionTerm = true;
      }
      if (inName) score += 24 * rarity;
      if (inDescription) score += 3 * rarity;
    }
    let phraseMatched = false;
    for (const phrase of phrases) {
      if (name.includes(phrase) || description.includes(phrase)) {
        score += 12;
        phraseMatched = true;
      }
    }
    if (/\bactive directory\b/i.test(query) && /\b(?:windows[ -]?ad|identity[ -]?windows)\b/.test(name)) {
      score += 30;
      phraseMatched = true;
    }
    const coverage = terms.length ? matchedTerms / terms.length : 0;
    const relevant =
      (!securitySkill || securityIntent) &&
      (!controlPlaneIntent || exactName || fullNameMention) &&
      (!explicitInvocationSkill || exactName || fullNameMention || coreNameMention || explicitTitleMention) &&
      (!internalDownstreamSkill || exactName || fullNameMention || coreNameMention) &&
      (!codebaseArchitectureSkill || exactName || fullNameMention || coreNameMention || codebaseArchitectureIntent) &&
      (!thickClientSkill || exactName || fullNameMention || coreNameMention || thickClientIntent) &&
      (!routerSkill || exactName || fullNameMention || routerIntent) &&
      (!reverseRouterSkill || exactName || fullNameMention || reverseRouterIntent) &&
      (!ctfSpecificSkill || exactName || fullNameMention || coreNameMention || ctfIntent) &&
      (!explicitRouterProductMention || routerSkill);
    const anchored = score > 0 && (
      exactName || fullNameMention || coreNameMention || singleCoreNameMention || explicitTitleMention ||
      explicitRouterProductMention || aliasMatched || productDesignAuditMatched ||
      (terms.length === 1 && matchedTerms === 1 && strongNameTerm) ||
      (matchedTerms >= 2 && coverage >= 0.5 && (strongNameTerm || strongDescriptionTerm)) ||
      (phraseMatched && matchedTerms >= 2 && coverage >= 0.35 &&
        (strongNameTerm || strongDescriptionTerm)) ||
      (terms.length <= 2 && strongNameTerm && strongNameRarity >= 2.4)
    );
    return { ...skill, score, relevant: relevant && anchored };
  }).filter((skill) => skill.relevant)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, int(args.limit, 1, 1, 8))
    .map((skill) => ({
      name: skill.name,
      description: skill.description.length > 240
        ? `${skill.description.slice(0, 237)}...`
        : skill.description,
      skill_file: skill.skill_file,
      score: skill.score,
    }));
  return {
    response: {
      operation: "route",
      virtualized: virtualized || Boolean(airlock?.active),
      capability_airlock: Boolean(airlock?.active),
      query,
      matches,
      ...(matches.length ? {} : {
        reason: "No relevant vaulted specialist cleared the lexical relevance floor; use a directly available skill or work locally.",
      }),
    },
    capturedChars: 0,
  };
}

function planSkills() {
  const skills = scanRoutableSkills();
  const metadataChars = skills.reduce((sum, skill) => sum + skill.metadata_chars, 0);
  const vault = readSkillVault();
  return {
    response: {
      operation: "plan",
      active: Boolean(vault?.active),
      root_entries: new Set(skills.map((skill) => skill.root_entry)).size,
      skills: skills.length,
      metadata_chars: metadataChars,
      potential_metadata_tokens_avoided: Math.ceil(metadataChars / 4),
      changes_made: false,
      system_skills_excluded: true,
    },
    capturedChars: 0,
  };
}

function skillVaultStatus() {
  const vault = readSkillVault();
  if (vault?.active) {
    return {
      response: {
        operation: "status",
        active: true,
        root_entries: Array.isArray(vault.entries) ? vault.entries.length : 0,
        skills: Number(vault.skills || 0),
        metadata_chars: Number(vault.metadata_chars || 0),
        metadata_tokens_avoided: Math.ceil(Number(vault.metadata_chars || 0) / 4),
        vault: vault.snapshot_root,
        reversible: true,
      },
      capturedChars: 0,
    };
  }
  const planned = planSkills().response;
  return {
    response: {
      operation: "status",
      active: false,
      root_entries: planned.root_entries,
      skills: planned.skills,
      metadata_chars: planned.metadata_chars,
      metadata_tokens_avoided: 0,
      potential_metadata_tokens_avoided: planned.potential_metadata_tokens_avoided,
      reversible: true,
    },
    capturedChars: 0,
  };
}

function applySkillVault(args = {}) {
  if (args.confirm !== true) throw new Error("confirm:true is required for skills apply");
  const previous = readSkillVault();
  if (previous?.active) throw new Error("skill catalog is already virtualized");
  const liveRoot = path.join(codexHome(), "skills");
  const skills = scanRoutableSkills(liveRoot);
  const rootNames = [...new Set(skills.map((skill) => skill.root_entry))].sort();
  if (!rootNames.length) throw new Error("no routable direct skills found");
  const state = skillVaultPaths();
  const snapshotId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const snapshotRoot = path.join(state.snapshots, snapshotId);
  const entriesRoot = path.join(snapshotRoot, "entries");
  const routerDirectory = path.join(liveRoot, "capsule-router");
  const routerFile = path.join(routerDirectory, "SKILL.md");
  if (fs.existsSync(routerDirectory)) {
    throw new Error(`generated router destination exists: ${routerDirectory}`);
  }
  fs.mkdirSync(entriesRoot, { recursive: true });
  const entries = rootNames.map((name) => ({
    name,
    original: path.join(liveRoot, name),
    vaulted: path.join(entriesRoot, name),
  }));
  for (const entry of entries) {
    const resolvedOriginal = path.resolve(entry.original);
    if (path.dirname(resolvedOriginal) !== path.resolve(liveRoot)) {
      throw new Error(`refusing unsafe skill source: ${resolvedOriginal}`);
    }
    if (!fs.existsSync(resolvedOriginal)) throw new Error(`skill source disappeared: ${resolvedOriginal}`);
    if (fs.existsSync(entry.vaulted)) throw new Error(`skill vault destination exists: ${entry.vaulted}`);
  }
  const moved = [];
  let routerCreated = false;
  try {
    for (const entry of entries) {
      fs.renameSync(entry.original, entry.vaulted);
      moved.push(entry);
    }
    fs.mkdirSync(routerDirectory, { recursive: false });
    routerCreated = true;
    const routerCli = path.resolve(__dirname, "..", "scripts", "skill-router.cjs");
    const cognitionCli = path.resolve(__dirname, "..", "scripts", "cognition.cjs");
    fs.writeFileSync(routerFile, [
      "---",
      "name: capsule-router",
      "description: Universal dispatcher for a virtualized specialist catalog and cognitive compiler. Use at the start of every task to load only relevant expertise and offload finite branching work.",
      "---",
      "",
      "# Virtual skill and cognition router",
      "",
      "<!-- managed-by-capsule -->",
      "",
      "Call `capsule` with `action:\"skills\"` and `payload:{operation:\"route\",query:\"short conservative English paraphrase of the literal user request\"}`.",
      "Do not add an artifact type, architecture, technology, or domain term that the user did not request; abstention is preferable to a speculative skill match.",
      "Read only `matches[0].skill_file`; an empty match means work locally. Request `limit>1` only when another specialist is required.",
      "For branching work, call `capsule` with `action:\"cognition\"` before exploring alternatives; use assignment, knapsack, path, cover, DAG, decision, or hypothesis certificates and honor the reasoning governor.",
      `If MCP is unavailable, run \`node ${JSON.stringify(routerCli)} route \"<intent>\"\` or \`node ${JSON.stringify(cognitionCli)} compile \"<problem>\"\`.`,
      "",
    ].join("\n"), "utf8");
  } catch (error) {
    if (routerCreated && fs.existsSync(routerDirectory)) {
      fs.rmSync(routerDirectory, { recursive: true, force: true });
    }
    for (const entry of moved.reverse()) {
      if (!fs.existsSync(entry.original) && fs.existsSync(entry.vaulted)) {
        fs.renameSync(entry.vaulted, entry.original);
      }
    }
    throw error;
  }
  const metadataChars = skills.reduce((sum, skill) => sum + skill.metadata_chars, 0);
  const manifest = {
    version: 1,
    active: true,
    created_at: new Date().toISOString(),
    source_root: liveRoot,
    snapshot_root: snapshotRoot,
    router_directory: routerDirectory,
    entries,
    skills: skills.length,
    metadata_chars: metadataChars,
  };
  try {
    writeSkillVault(manifest);
  } catch (error) {
    if (fs.existsSync(routerDirectory)) fs.rmSync(routerDirectory, { recursive: true, force: true });
    for (const entry of moved.reverse()) {
      if (!fs.existsSync(entry.original) && fs.existsSync(entry.vaulted)) {
        fs.renameSync(entry.vaulted, entry.original);
      }
    }
    throw error;
  }
  return {
    response: {
      operation: "apply",
      active: true,
      root_entries: entries.length,
      skills: skills.length,
      metadata_chars: metadataChars,
      potential_metadata_tokens_avoided: Math.ceil(metadataChars / 4),
      vault: snapshotRoot,
      router_skill: routerFile,
      requires_restart: true,
      reversible: true,
    },
    capturedChars: 0,
  };
}

function restoreSkillVault(args = {}) {
  if (args.confirm !== true) throw new Error("confirm:true is required for skills restore");
  const manifest = readSkillVault();
  if (!manifest?.active || !Array.isArray(manifest.entries)) {
    throw new Error("skill catalog is not virtualized");
  }
  for (const entry of manifest.entries) {
    const liveRoot = path.resolve(manifest.source_root);
    const destination = path.resolve(entry.original);
    if (path.dirname(destination) !== liveRoot) {
      throw new Error(`refusing unsafe skill restore target: ${destination}`);
    }
    if (fs.existsSync(destination)) {
      throw new Error(`refusing to overwrite restored skill conflict: ${destination}`);
    }
    if (!fs.existsSync(entry.vaulted)) throw new Error(`vaulted skill is missing: ${entry.vaulted}`);
  }
  const routerDirectory = manifest.router_directory
    ? path.resolve(manifest.router_directory)
    : path.join(path.resolve(manifest.source_root), "capsule-router");
  const retiredRouter = path.join(path.resolve(manifest.snapshot_root), "generated-router");
  if (fs.existsSync(routerDirectory) && fs.existsSync(retiredRouter)) {
    throw new Error(`router recovery destination exists: ${retiredRouter}`);
  }
  fs.mkdirSync(manifest.source_root, { recursive: true });
  const restored = [];
  let routerRetired = false;
  try {
    if (fs.existsSync(routerDirectory)) {
      fs.renameSync(routerDirectory, retiredRouter);
      routerRetired = true;
    }
    for (const entry of manifest.entries) {
      fs.renameSync(entry.vaulted, entry.original);
      restored.push(entry);
    }
    writeSkillVault({
      ...manifest,
      active: false,
      restored_at: new Date().toISOString(),
      retired_router: routerRetired ? retiredRouter : null,
    });
  } catch (error) {
    for (const entry of restored.reverse()) {
      if (!fs.existsSync(entry.vaulted) && fs.existsSync(entry.original)) {
        fs.renameSync(entry.original, entry.vaulted);
      }
    }
    if (routerRetired && !fs.existsSync(routerDirectory) && fs.existsSync(retiredRouter)) {
      fs.renameSync(retiredRouter, routerDirectory);
    }
    throw error;
  }
  return {
    response: {
      operation: "restore",
      active: false,
      root_entries: manifest.entries.length,
      skills: manifest.skills,
      requires_restart: true,
      restored_to: manifest.source_root,
    },
    capturedChars: 0,
  };
}

function doctor() {
  const root = core.stateRoot();
  const checks = [];
  const skillCatalog = skillCatalogAudit();
  try {
    fs.mkdirSync(root, { recursive: true });
    const probe = path.join(root, `.doctor-${process.pid}.tmp`);
    fs.writeFileSync(probe, "ok", "utf8");
    fs.unlinkSync(probe);
    checks.push({ check: "state_read_write", ok: true, path: root });
  } catch (error) {
    checks.push({ check: "state_read_write", ok: false, error: error.message });
  }
  checks.push({ check: "node_18_plus", ok: Number(process.versions.node.split(".")[0]) >= 18, value: process.version });
  checks.push({
    check: "sqlite_fts5_acceleration",
    ok: true,
    value: DatabaseSync ? "available" : "unavailable; deterministic catalog scan fallback active",
  });
  const filterSurface = compat.surfaceStatus().response;
  checks.push({
    check: "capsule_filter_pipeline",
    ok: filterSurface.command_families > 0,
    value: `${filterSurface.command_families} command families; user-defined filters`,
    pipeline: filterSurface.pipeline,
    operations: filterSurface.operations,
  });
  const cognitionStatus = cognition.stats().response;
  checks.push({
    check: "cognitive_compiler",
    ok: true,
    enabled: process.env.CAPSULE_COGNITION !== "0",
    value: process.env.CAPSULE_COGNITION === "0"
      ? "disabled by CAPSULE_COGNITION=0"
      : `enabled; ${cognitionStatus.kernels} decision kernels, ${cognitionStatus.recalls} recalls`,
    prompt_storage: cognitionStatus.prompt_storage,
  });
  checks.push({
    check: "reasoning_governor",
    ok: true,
    enabled: process.env.CAPSULE_REASONING_GOVERNOR !== "0",
    value: process.env.CAPSULE_REASONING_GOVERNOR === "0"
      ? "disabled by CAPSULE_REASONING_GOVERNOR=0"
      : "enabled; provider token counters only; context/quota pressure adapts warning/brake once per turn",
  });
  checks.push({
    check: "pre_spend_token_escrow",
    ok: true,
    enabled: cognitionStatus.token_escrow.enabled,
    value: cognitionStatus.token_escrow.enabled
      ? `enabled; ${cognitionStatus.token_escrow.active_turns} budgeted turns; ` +
        `${cognitionStatus.token_escrow.predicted_net_tokens_avoided} predicted net output tokens avoided`
      : "disabled by CAPSULE_TOKEN_ESCROW=0",
    caveat: cognitionStatus.token_escrow.caveat,
  });
  checks.push({
    check: "cache_aware_roundtrip_governor",
    ok: true,
    enabled: process.env.CAPSULE_ROUNDTRIP_TAX !== "0",
    value: process.env.CAPSULE_ROUNDTRIP_TAX === "0"
      ? "disabled by CAPSULE_ROUNDTRIP_TAX=0"
      : "enabled; uncached input and cache-hit telemetry tighten output/history budgets and trigger one bounded hint per usage sample",
  });
  const progressExchange = quotaProgress.status();
  checks.push({
    check: "quota_to_progress_exchange",
    ok: true,
    enabled: process.env.CAPSULE_QUOTA_PROGRESS !== "0",
    value: process.env.CAPSULE_QUOTA_PROGRESS === "0"
      ? "disabled by CAPSULE_QUOTA_PROGRESS=0"
      : `enabled; ${progressExchange.receipts} bounded receipts; ` +
        `${progressExchange.low_progress_turns} low-progress expensive turns; ` +
        `${progressExchange.tombstones} anti-memory tombstones`,
    privacy: "Raw prompts and assistant messages are never persisted; only HMAC prompt terms, counters, booleans, and bounded receipts.",
  });
  checks.push({
    check: "compaction_flight_recorder",
    ok: true,
    value: "enabled; predictive context runway, local quota pressure, 280-600-token adaptive summaries, " +
      "execution checkpoints, and capsule-backed replay survival",
  });
  checks.push({
    check: "loop_and_poll_governor",
    ok: true,
    value: "enabled; 60-second wait coalescing, read/plan sequence fuse, spawn-cost checkpoints, identical-failure fuse, near-duplicate delta replay, successful exec-envelope stripping, and exact absolute output circuits",
  });
  let firewall = { blocked_calls: 0, approx_tokens_avoided: 0 };
  try {
    firewall = JSON.parse(fs.readFileSync(
      path.join(root, "hooks", "information-gain-firewall.json"),
      "utf8"
    ));
  } catch {
    // No blocked immutable reread has occurred yet.
  }
  checks.push({
    check: "information_gain_firewall",
    ok: true,
    enabled: process.env.CAPSULE_INFORMATION_GAIN_FIREWALL !== "0",
    value: process.env.CAPSULE_INFORMATION_GAIN_FIREWALL === "0"
      ? "disabled by CAPSULE_INFORMATION_GAIN_FIREWALL=0"
      : `enabled; ${Number(firewall.blocked_calls || 0)} redundant calls blocked; ` +
        `~${Number(firewall.approx_tokens_avoided || 0)} repeated output tokens avoided`,
    safety: "Only immutable capsules or cryptographically unchanged local files; dynamic external sources pass through.",
  });
  checks.push({
    check: "adaptive_skill_catalog",
    ok: true,
    value: skillCatalog.virtualization_active
      ? `${skillCatalog.virtualized_skills} domain-anchored routed skills; ~${skillCatalog.metadata_tokens_avoided} direct metadata tokens avoided per request`
      : `${skillCatalog.entries} direct skills; ~${skillCatalog.approx_tokens} metadata tokens`,
    recommendation: skillCatalog.virtualization_recommended,
  });
  const runtimes = runtime.runtimeStatus();
  checks.push({
    check: "language_runtimes",
    ok: true,
    value: `${runtimes.available_count}/${runtimes.total} available`,
    available: runtimes.available,
  });
  try {
    const hookStatus = require("../scripts/install-hooks.cjs").status();
    const globalCount = Object.values(hookStatus.sources.global_fallback).filter(Boolean).length;
    const bundledCount = Object.values(hookStatus.sources.plugin_bundled).filter(Boolean).length;
    const configuredCount = Object.values(hookStatus.configured_events || {}).filter(Boolean).length;
    const observedCount = Object.values(hookStatus.observed_events || {}).filter(Boolean).length;
    const effectiveCount = Object.values(hookStatus.events).filter(Boolean).length;
    const postToolObserved = hookStatus.observed_events?.PostToolUse === true;
    const hooksRemoved = hookStatus.plugin_hooks_feature?.name === "hooks" &&
      hookStatus.plugin_hooks_feature?.lifecycle === "removed";
    const policyFile = path.join(os.homedir(), ".codex", "AGENTS.md");
    const policyText = fs.existsSync(policyFile) ? fs.readFileSync(policyFile, "utf8") : "";
    const policyActive = /capsule/i.test(policyText) &&
      /action=run\|batch/i.test(policyText);
    checks.push({
      check: "automatic_codex_hooks",
      ok: true,
      installed: configuredCount >= 6,
      active: observedCount > 0,
      output_interception_active: postToolObserved,
      value: `configured ${configuredCount}/6; runtime-observed ${observedCount}/6; effective ${effectiveCount}/6; plugin-bundled ${bundledCount}/6; global fallback ${globalCount}/6`,
      plugin_hooks_feature: hookStatus.plugin_hooks_feature,
      duplicate_sources: hookStatus.duplicate_event_sources.length > 0,
      recommendation: configuredCount < 6
        ? "run npm run hooks:install, then restart Codex"
        : hooksRemoved
        ? "native hook API was removed by this Codex build; MCP policy routing is the supported fallback"
        : !postToolObserved
        ? "restart Codex, open /hooks, and trust the current Capsule definitions; use capsule explicitly until PostToolUse is runtime-observed"
        : undefined,
    });
    checks.push({
      check: "automatic_token_routing",
      // The global AGENTS.md policy is an optional convenience layer.  A
      // standalone Capsule install remains healthy when it is absent; users
      // can still invoke the MCP directly and install the policy later.
      ok: true,
      required: false,
      active: policyActive,
      mode: policyActive ? "global AGENTS.md -> Capsule MCP" : "inactive",
      policy_file: policyFile,
      native_output_interception: postToolObserved,
      value: policyActive
        ? "active; commands, files, recall, derivation, web text, and measurement are routed by global policy"
        : "inactive; install the managed Capsule policy",
    });
  } catch (error) {
    checks.push({ check: "automatic_codex_hooks", ok: true, installed: false, value: error.message });
  }
  return {
    response: {
      ok: checks.every((item) => item.ok),
      checks,
      environment: {
        platform: process.platform,
        arch: process.arch,
        skill_catalog: skillCatalog,
      },
    },
    capturedChars: 0,
  };
}

function listIndex(args = {}) {
  const limit = int(args.limit, 20, 1, 100);
  const documents = Object.values(readCatalog().documents)
    .sort((a, b) => String(b.indexed_at).localeCompare(String(a.indexed_at)))
    .slice(0, limit);
  return { response: { documents }, capturedChars: 0 };
}

function insight(args = {}) {
  const usage = compat.gain(args).response;
  const catalog = Object.values(readCatalog().documents);
  const skillCatalog = skillCatalogAudit();
  let compactionAudit = null;
  let contextPressure = null;
  if (args.compaction === true) {
    const rawAudit = compaction.auditSession(args).response;
    contextPressure = compaction.contextPressure(args).response;
    const { events = [], ...summary } = rawAudit;
    compactionAudit = {
      ...summary,
      latest_event: events.at(-1) || null,
      ...(args.compaction_events === true
        ? { events: events.slice(-int(args.compaction_event_limit, 20, 1, 100)) }
        : {}),
    };
  }
  const byKind = {};
  for (const document of catalog) byKind[document.kind] = (byKind[document.kind] || 0) + 1;
  return {
    response: {
      savings: {
        calls: usage.calls,
        raw: usage.raw,
        emitted: usage.emitted,
        avoided: usage.avoided,
      },
      by_profile: usage.by_profile,
      failures: usage.failures,
      knowledge: {
        documents: catalog.length,
        chars: catalog.reduce((sum, document) => sum + document.chars, 0),
        by_kind: byKind,
        stale_files: catalog.filter(staleState).length,
      },
      environment: {
        platform: process.platform,
        arch: process.arch,
        skill_catalog: skillCatalog,
      },
      ...(compactionAudit ? { compaction: compactionAudit } : {}),
      ...(contextPressure ? { context_pressure: contextPressure } : {}),
      ...(args.history === true ? { history: historyAudit(args) } : {}),
      hosted_dashboard_required: false,
    },
    capturedChars: 0,
  };
}

function purge(args = {}) {
  if (args.confirm !== true) throw new Error("confirm:true is required");
  const scope = args.scope || "index";
  const root = path.resolve(core.stateRoot());
  const allowed = {
    index: [path.join(root, "index")],
    projects: [path.join(root, "projects")],
    capsules: [path.join(root, "capsules"), path.join(root, "metadata"), path.join(root, "sources.json"), path.join(root, "file-replays.json")],
    cache: [
      path.join(root, "index"), path.join(root, "projects"), path.join(root, "capsules"),
      path.join(root, "metadata"), path.join(root, "sources.json"), path.join(root, "result-futures"),
      path.join(root, "file-replays.json"),
    ],
    jobs: [path.join(root, "jobs")],
    history: [path.join(root, "compat")],
    hooks: [path.join(root, "hooks")],
    all: fs.existsSync(root)
      ? fs.readdirSync(root).map((entry) => path.join(root, entry))
      : [],
  };
  if (!allowed[scope]) throw new Error("scope must be index, projects, capsules, cache, jobs, history, hooks, or all");
  if (["index", "cache", "all"].includes(scope)) closeSearchDatabase();
  const removed = [];
  for (const target of allowed[scope]) {
    const resolved = path.resolve(target);
    if (path.dirname(resolved) !== root && resolved !== path.join(root, "index") &&
        resolved !== path.join(root, "jobs") && resolved !== path.join(root, "compat") &&
        resolved !== path.join(root, "hooks") && resolved !== path.join(root, "projects") &&
        resolved !== path.join(root, "capsules") && resolved !== path.join(root, "metadata") &&
        resolved !== path.join(root, "sources.json") && resolved !== path.join(root, "result-futures") &&
        resolved !== path.join(root, "file-replays.json")) {
      throw new Error(`refusing unsafe purge target: ${resolved}`);
    }
    if (fs.existsSync(resolved)) {
      fs.rmSync(resolved, { recursive: true, force: true });
      removed.push(resolved);
    }
  }
  return { response: { scope, removed, irreversible: true }, capturedChars: 0 };
}

const FLOW_ACTIONS = new Set([
  "run", "batch", "file", "project", "search", "fetch", "expand", "diff", "list",
  "stats", "doctor", "gain", "discover", "telemetry", "insight", "cognition",
]);

const FLOW_CONDITION_FIELDS = new Set(["status", "exit_code", "output", "route", "error", "reason"]);
const FLOW_CONDITION_OPERATORS = new Set([
  "eq", "ne", "contains", "matches", "truthy", "falsy", "gt", "gte", "lt", "lte",
]);

function validateFlowCondition(condition, ids, owner, depth = 0) {
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
    throw new Error(`flow step ${owner}: when must be an object`);
  }
  if (depth > 2) throw new Error(`flow step ${owner}: when nesting exceeds 2`);
  for (const combinator of ["all", "any"]) {
    if (condition[combinator] != null) {
      const clauses = condition[combinator];
      if (!Array.isArray(clauses) || !clauses.length || clauses.length > 8) {
        throw new Error(`flow step ${owner}: when.${combinator} requires 1-8 clauses`);
      }
      return {
        [combinator]: clauses.map((clause) =>
          validateFlowCondition(clause, ids, owner, depth + 1)),
      };
    }
  }
  const step = String(condition.step || "");
  const field = String(condition.field || "status");
  const op = String(condition.op || "eq");
  if (!ids.has(step) || step === owner) throw new Error(`flow step ${owner}: invalid when step ${step}`);
  if (!FLOW_CONDITION_FIELDS.has(field)) throw new Error(`flow step ${owner}: invalid when field ${field}`);
  if (!FLOW_CONDITION_OPERATORS.has(op)) throw new Error(`flow step ${owner}: invalid when operator ${op}`);
  if (condition.value != null && !["string", "number", "boolean"].includes(typeof condition.value)) {
    throw new Error(`flow step ${owner}: when value must be scalar`);
  }
  const value = condition.value;
  if (op === "matches" && String(value || "").length > 200) {
    throw new Error(`flow step ${owner}: when regex exceeds 200 characters`);
  }
  return { step, field, op, ...(value === undefined ? {} : { value }) };
}

function flowConditionReferences(condition, target = new Set()) {
  if (!condition) return target;
  if (condition.step) target.add(condition.step);
  for (const combinator of ["all", "any"]) {
    for (const clause of condition[combinator] || []) flowConditionReferences(clause, target);
  }
  return target;
}

function evaluateFlowCondition(condition, completed) {
  if (!condition) return true;
  if (condition.all) return condition.all.every((clause) => evaluateFlowCondition(clause, completed));
  if (condition.any) return condition.any.some((clause) => evaluateFlowCondition(clause, completed));
  const actual = completed.get(condition.step)?.[condition.field];
  const expected = condition.value;
  switch (condition.op) {
    case "eq": return actual === expected;
    case "ne": return actual !== expected;
    case "contains": return String(actual ?? "").includes(String(expected ?? ""));
    case "matches": return new RegExp(String(expected || ""), "i").test(String(actual ?? ""));
    case "truthy": return Boolean(actual);
    case "falsy": return !actual;
    case "gt": return Number(actual) > Number(expected);
    case "gte": return Number(actual) >= Number(expected);
    case "lt": return Number(actual) < Number(expected);
    case "lte": return Number(actual) <= Number(expected);
    default: return false;
  }
}

function validateFlowStep(step, ids) {
  if (!step || typeof step !== "object") throw new Error("each flow step must be an object");
  const id = String(step.id || "");
  if (!/^[a-z][a-z0-9_-]{0,39}$/i.test(id)) throw new Error(`invalid flow step id: ${id}`);
  const action = String(step.action || "");
  if (!FLOW_ACTIONS.has(action)) throw new Error(`flow step ${id} action is not allowed: ${action}`);
  const payload = step.payload && typeof step.payload === "object" && !Array.isArray(step.payload)
    ? step.payload
    : {};
  if (action === "file" && ["edit", "undo"].includes(String(payload.operation || ""))) {
    throw new Error(`flow step ${id}: mutating file operations must remain explicit and serial`);
  }
  if (action === "run") {
    const profile = terminalNovelty.commandProfile(payload.command);
    if (!profile && payload.idempotent !== true) {
      throw new Error(`flow step ${id}: unclassified commands require idempotent:true`);
    }
  }
  const when = step.when == null ? null : validateFlowCondition(step.when, ids, id);
  const dependsOn = [
    ...(Array.isArray(step.depends_on) ? step.depends_on.map(String) : []),
    ...flowConditionReferences(when),
  ];
  if (dependsOn.includes(id)) throw new Error(`flow step ${id} cannot depend on itself`);
  for (const dependency of dependsOn) {
    if (!ids.has(dependency)) throw new Error(`flow step ${id} has unknown dependency: ${dependency}`);
  }
  return {
    id,
    action,
    payload,
    depends_on: [...new Set(dependsOn)],
    requires_success: step.requires_success !== false,
    ...(when ? { when } : {}),
  };
}

function flowExitCode(operation) {
  const value = operation?.response?.exit_code ??
    operation?.response?.execution?.exit_code ??
    operation?.details?.exit_code;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function compactFlowOutput(operation, maxChars, query, action) {
  if (action === "fetch" && Array.isArray(operation?.response?.results)) {
    const receipts = operation.response.results.map((result) => {
      const document = result.documents?.[0] || {};
      return [
        result.status || "?",
        result.cached ? "cache" : "net",
        `${result.bytes || 0}B`,
        document.document_id ? `doc=${document.document_id}` : "",
        document.capsule_id ? `cap=${document.capsule_id}` : "",
        document.chars != null ? `chars=${document.chars}` : "",
      ].filter(Boolean).join(" ");
    });
    return receipts.join("\n").slice(0, maxChars);
  }
  let focused = typeof operation?.responseText === "string"
    ? operation.responseText
    : typeof operation?.response?.output === "string"
      ? operation.response.output
      : core.renderOperation(operation);
  const streams = String(focused).match(/^# stdout\n([\s\S]*?)\n# stderr\n([\s\S]*)$/);
  if (streams) {
    const stdout = streams[1].trim();
    const stderr = streams[2].trim();
    focused = stdout && stderr ? `out:${stdout}\nerr:${stderr}` : stdout || stderr || "no output";
  }
  const rendered = String(focused);
  if (rendered.length <= maxChars) return compat.redact(rendered);
  const compact = compressText(rendered, {
    query,
    max_chars: maxChars,
    passthrough_chars: 0,
  });
  return compat.redact(compact.output).slice(0, maxChars);
}

function sharedFlowPrefix(values) {
  if (values.length < 2) return "";
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let index = 0;
    const limit = Math.min(prefix.length, value.length);
    while (index < limit && prefix[index] === value[index]) index += 1;
    prefix = prefix.slice(0, index);
    if (!prefix) break;
  }
  if (prefix.length < 6 || prefix.includes("\n")) return "";
  const boundary = Math.max(prefix.lastIndexOf(" "), prefix.lastIndexOf("\\"), prefix.lastIndexOf("/"));
  if (boundary >= 5) prefix = prefix.slice(0, boundary + 1);
  const grossSaved = prefix.length * (values.length - 1);
  const macroCost = prefix.length + (values.length * 2) + 5;
  return grossSaved > macroCost ? prefix : "";
}

async function runFlow(args = {}) {
  const rawSteps = Array.isArray(args.steps) ? args.steps : [];
  if (!rawSteps.length || rawSteps.length > 32) throw new Error("flow requires between 1 and 32 steps");
  const ids = new Set(rawSteps.map((step) => String(step?.id || "")));
  if (ids.size !== rawSteps.length) throw new Error("flow step ids must be unique");
  const steps = rawSteps.map((step) => validateFlowStep(step, ids));
  const concurrency = int(args.concurrency, 6, 1, 8);
  const maxTotalChars = int(args.max_chars, 12_000, 1_200, 48_000);
  const stepChars = Math.max(240, Math.min(1_600, Math.floor(maxTotalChars / steps.length)));
  const pending = new Map(steps.map((step) => [step.id, step]));
  const completed = new Map();
  const full = [];
  let frontiers = 0;
  let capturedChars = 0;

  while (pending.size) {
    const ready = [...pending.values()].filter((step) =>
      step.depends_on.every((dependency) => completed.has(dependency))
    );
    if (!ready.length) throw new Error("flow dependency graph contains a cycle");
    frontiers += 1;
    for (let offset = 0; offset < ready.length; offset += concurrency) {
      const batch = ready.slice(offset, offset + concurrency);
      const outcomes = await Promise.all(batch.map(async (step) => {
        const conditionDependencies = flowConditionReferences(step.when);
        const blocked = step.requires_success && step.depends_on.some((dependency) =>
          !conditionDependencies.has(dependency) &&
          !["ok", "passed"].includes(completed.get(dependency)?.status)
        );
        if (blocked) {
          return {
            id: step.id,
            action: step.action,
            status: "skipped",
            reason: "dependency-not-successful",
          };
        }
        if (!evaluateFlowCondition(step.when, completed)) {
          return {
            id: step.id,
            action: step.action,
            status: "skipped",
            reason: "condition-false",
          };
        }
        try {
          const operation = await dispatch({ action: step.action, payload: step.payload });
          const exitCode = flowExitCode(operation);
          const status = exitCode != null && exitCode !== 0 ? "failed" : "ok";
          capturedChars += Number(operation.capturedChars || 0);
          return {
            id: step.id,
            action: step.action,
            status,
            ...(exitCode == null ? {} : { exit_code: exitCode }),
            route: operation.route || operation.response?.route || "result",
            rendered: core.renderOperation(operation),
            output: compactFlowOutput(
              operation,
              stepChars,
              step.payload.query || step.payload.question || "",
              step.action
            ),
          };
        } catch (error) {
          return {
            id: step.id,
            action: step.action,
            status: "error",
            error: String(error.message || error).slice(0, 500),
          };
        }
      }));
      for (const outcome of outcomes) {
        completed.set(outcome.id, outcome);
        pending.delete(outcome.id);
        full.push(outcome);
      }
    }
  }

  const exactPayload = JSON.stringify({
    steps: steps.map(({ id, action, payload, depends_on, requires_success, when }) =>
      ({ id, action, payload, depends_on, requires_success, ...(when ? { when } : {}) })),
    results: full,
  });
  const exact = core.saveCapsule({
    kind: "roundtrip-singularity-flow",
    source: "capsule:flow",
    text: exactPayload,
    maxChars: 1_200,
    details: { steps: steps.length, frontiers },
  }).response.capsule_id;
  const visible = full.map(({ rendered: _rendered, ...item }) => item);
  const receiptItems = visible.filter((item) => item.reason !== "condition-false");
  const failed = receiptItems.filter((item) => ["failed", "error"].includes(item.status)).length;
  const skipped = receiptItems.filter((item) => item.status === "skipped").length;
  const conditionalSkipped = visible.length - receiptItems.length;
  const successfulOutputs = receiptItems
    .filter((item) => item.status === "ok")
    .map((item) => String(item.output || "ok").trim());
  const sharedPrefix = failed || skipped ? "" : sharedFlowPrefix(successfulOutputs);
  let receiptEncoding = "diagnostic";
  let responseText;
  let plainTokens = 0;
  let receiptTokens = 0;
  if (failed || skipped) {
    const textLines = [
      `[Capsule flow ${steps.length}/${frontiers}; fail=${failed}; skip=${skipped}; exact=${exact}]`,
    ];
    for (const item of receiptItems) {
      if (item.status === "ok") textLines.push(`${item.id}>${String(item.output || "ok").trim()}`);
      else if (item.status === "skipped") textLines.push(`${item.id}!skipped:${item.reason}`);
      else textLines.push(`${item.id}!${item.status}${item.exit_code == null ? "" : `:${item.exit_code}`}>` +
        `${String(item.output || item.error || "").trim()}`);
    }
    responseText = textLines.join("\n");
    plainTokens = core.estimateTokens(responseText);
    receiptTokens = plainTokens;
  } else {
    // Pareto Receipt Compiler: build several lossless receipts and expose only
    // the smallest. The exact aggregate remains addressable in response.exact.
    const plain = successfulOutputs.join("\n");
    const candidates = [{ encoding: "plain-ordered", text: plain }];
    if (successfulOutputs.some((output) => output.includes("\n"))) {
      candidates.push({
        encoding: "ordinal",
        text: successfulOutputs.map((output, index) => `${index + 1}>${output}`).join("\n"),
      });
    }
    if (sharedPrefix) {
      candidates.push({
        encoding: "shared-prefix",
        text: [`^=${JSON.stringify(sharedPrefix)}`]
          .concat(successfulOutputs.map((output, index) => `${index + 1}>^${output.slice(sharedPrefix.length)}`))
          .join("\n"),
      });
    }
    const seen = new Map();
    let duplicates = 0;
    const deduplicated = successfulOutputs.map((output, index) => {
      if (seen.has(output)) {
        duplicates += 1;
        return `${index + 1}=@${seen.get(output) + 1}`;
      }
      seen.set(output, index);
      return `${index + 1}>${output}`;
    }).join("\n");
    if (duplicates) candidates.push({ encoding: "exact-repeat", text: deduplicated });
    const ranked = candidates.map((candidate) => ({
      ...candidate,
      tokens: core.estimateTokens(candidate.text),
    })).sort((left, right) => left.tokens - right.tokens || left.text.length - right.text.length);
    const chosen = ranked[0];
    receiptEncoding = chosen.encoding;
    responseText = chosen.text;
    receiptTokens = chosen.tokens;
    plainTokens = core.estimateTokens(plain);
  }
  return {
    response: {
      operation: "flow",
      steps: steps.length,
      frontiers,
      concurrency,
      ok: visible.filter((item) => item.status === "ok").length,
      failed,
      skipped,
      conditional_skipped: conditionalSkipped,
      receipt_encoding: receiptEncoding,
      receipt_estimated_tokens: receiptTokens,
      plain_estimated_tokens: plainTokens,
      results: visible,
      exact,
    },
    responseText: responseText.slice(0, maxTotalChars),
    capturedChars: capturedChars + exactPayload.length,
    route: "roundtrip-singularity",
  };
}

async function dispatch(rawArgs = {}) {
  // Normalize the legacy dotted form so routers do not burn a retry on a shape error.
  if (typeof rawArgs.action === "string" && /^skills\.[a-z][a-z0-9-]*$/i.test(rawArgs.action)) {
    const operation = rawArgs.action.slice("skills.".length);
    const payload = rawArgs.payload && typeof rawArgs.payload === "object" ? rawArgs.payload : {};
    rawArgs = { ...rawArgs, action: "skills", payload: { ...payload, operation: payload.operation || operation } };
  }
  const args = unpack(rawArgs);
  switch (args.action) {
    case "run": return runCommand(args);
    case "batch": return batchCommands(args);
    case "flow": return runFlow(args);
    case "file": return inspectFile(args);
    case "project": return projectCompiler.dispatch(args);
    case "index": return indexContent(args);
    case "search": return searchIndex(args);
    case "remember": return remember(args);
    case "fetch": return fetchAndIndex(args);
    case "expand": return core.expandAnchor(args);
    case "diff": return core.diffCapsules(args);
    case "list": return args.scope === "index" ? listIndex(args) : core.listCapsules(args);
    case "stats": return stats(args);
    case "doctor": return doctor();
    case "cognition": return cognition.dispatch(args);
    case "advisor": return advisor.dispatch(args);
    case "execute": return runtime.executeCode(args, {
      addDocument,
      attachArchive,
      compressText,
      searchIndex,
    });
    case "jobs": return runtime.jobs(args);
    case "interrupt": return semanticInterrupt.semanticInterrupt(args);
    case "rewrite": return compat.rewriteCommand(args);
    case "filters": return compat.manageFilters(args);
    case "gain": return compat.gain(args);
    case "discover": return compat.discover(args);
    case "learn": return compat.learn(args);
    case "telemetry": return compat.telemetry(args);
    case "insight": return insight(args);
    case "skills": {
      const operation = args.operation || "route";
      if (operation === "route") return routeSkills(args);
      if (operation === "plan") return planSkills();
      if (operation === "status") return skillVaultStatus();
      if (operation === "apply") return applySkillVault(args);
      if (operation === "restore") return restoreSkillVault(args);
      if (operation === "airlock-plan") return capabilityAirlockPlan();
      if (operation === "airlock-apply") return applyCapabilityAirlock(args);
      if (operation === "airlock-refresh") return refreshCapabilityAirlock(args);
      if (operation === "airlock-restore") return restoreCapabilityAirlock(args);
      throw new Error("skills operation must be route, plan, status, apply, restore, airlock-plan, airlock-apply, airlock-refresh, or airlock-restore");
    }
    case "purge": return purge(args);
    case "pipe": {
      if (typeof args.content !== "string") throw new Error("content is required");
      const compact = compressText(args.content, args);
      return compact.route === "passthrough"
        ? { responseText: compact.output, route: compact.route, capturedChars: compact.raw_chars }
        : { response: compact, route: compact.route, capturedChars: compact.raw_chars };
    }
    default: throw new Error(`Unknown action: ${args.action}`);
  }
}

module.exports = {
  batchCommands,
  addDocument,
  advisor,
  attachArchive,
  closeSearchDatabase,
  cognition,
  compressText,
  dispatch,
  doctor,
  fetchAndIndex,
  indexContent,
  inspectFile,
  insight,
  projectCompiler,
  listIndex,
  remember,
  runFlow,
  runCommand,
  purge,
  searchIndex,
  stats,
  unpack,
};
