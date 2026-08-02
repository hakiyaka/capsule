"use strict";

if (require.main === module) {
  process.env.CAPSULE_HOOK_PROCESS = "1";
  process.env.CAPSULE_HOOK_PROCESS = "1";
}

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../mcp/core.cjs");
const compat = require("../mcp/compat.cjs");
const cognition = require("../mcp/cognition.cjs");
const advisor = require("../mcp/advisor.cjs");
const compaction = require("../mcp/compaction.cjs");
const quotaProgress = require("../mcp/quota-progress.cjs");
const unified = require("../mcp/unified.cjs");
const reasoningResidual = require("../mcp/reasoning-residual.cjs");
const terminalGenome = require("../mcp/terminal-genome.cjs");

function readInput() {
  try {
    const value = fs.readFileSync(0, "utf8").trim();
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

function firstString(value, keys) {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  return "";
}

function sessionId(input) {
  const explicit = firstString(input, ["session_id", "sessionId", "conversation_id", "thread_id"]);
  if (explicit) return explicit;
  const stableFallback = firstString(input, [
    "session_file", "sessionFile", "transcript_path", "transcriptPath", "rollout_path", "rolloutPath",
    "cwd", "project_dir", "projectDir", "workspace",
  ]);
  if (!stableFallback) return "unknown";
  const normalized = path.resolve(stableFallback).toLowerCase();
  const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 20);
  return `fallback:${digest}`;
}

function projectDir(input) {
  return firstString(input, ["cwd", "project_dir", "projectDir", "workspace"]) || process.cwd();
}

function projectScope(input) {
  const resolved = path.resolve(projectDir(input));
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 20);
  return `project:${digest}`;
}

function hookRoot() {
  const root = path.join(core.stateRoot(), "hooks");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function logError(event, error) {
  try {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      event,
      error: error && error.stack ? error.stack : String(error),
    });
    fs.appendFileSync(path.join(hookRoot(), "errors.jsonl"), `${line}\n`, "utf8");
  } catch {
    // Hooks must never block Codex because diagnostics could not be written.
  }
}

function roundTripGuidance(input, toolName) {
  const normalized = String(toolName || "").trim().toLowerCase();
  if (!normalized || /capsule/.test(normalized)) return "";
  const key = crypto.createHash("sha256").update(sessionId(input)).digest("hex").slice(0, 20);
  const root = path.join(hookRoot(), "roundtrips");
  const file = path.join(root, `${key}.json`);
  fs.mkdirSync(root, { recursive: true });
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    state = {};
  }
  const now = Date.now();
  const continues = state.tool === normalized && now - Number(state.at || 0) <= 5 * 60_000;
  const count = continues ? Number(state.count || 0) + 1 : 1;
  const next = { tool: normalized, count, at: now };
  const temporary = `${file}.${process.pid}.${now}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next)}\n`, "utf8");
  fs.renameSync(temporary, file);
  if (![4, 12, 30].includes(count)) return "";
  return `Capsule noticed ${count} consecutive ${toolName} round trips. ` +
    "Batch independent or read-only operations into one call when safe; keep mutations and approval boundaries separate.";
}

function repeatedReadGuidance(input, toolName) {
  const normalized = String(toolName || "").trim().toLowerCase();
  const words = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const readOnlyWords = new Set([
    "read", "view", "list", "search", "find", "get", "open", "stat", "stats",
    "doctor", "insight", "screenshot", "expand", "diff",
  ]);
  if (!words.some((word) => readOnlyWords.has(word))) return "";
  const toolInput = input.tool_input || input.toolInput || {};
  let serialized;
  try {
    serialized = JSON.stringify(toolInput);
  } catch {
    return "";
  }
  if (!serialized || serialized.length > 100_000) return "";
  const requestHash = crypto.createHash("sha256")
    .update(`${normalized}\0${serialized}`)
    .digest("hex")
    .slice(0, 20);
  const sessionHash = crypto.createHash("sha256").update(sessionId(input)).digest("hex").slice(0, 20);
  const root = path.join(hookRoot(), "repeated-reads");
  const file = path.join(root, `${sessionHash}-${requestHash}.json`);
  fs.mkdirSync(root, { recursive: true });
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    state = {};
  }
  const now = Date.now();
  const count = now - Number(state.at || 0) <= 10 * 60_000 ? Number(state.count || 0) + 1 : 1;
  const temporary = `${file}.${process.pid}.${now}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ count, at: now })}\n`, "utf8");
  fs.renameSync(temporary, file);
  if (![2, 5].includes(count)) return "";
  return `Capsule noticed the same read-only ${toolName} request ${count} times. ` +
    "Reuse the prior result, request a diff, or repeat only if the underlying state may have changed.";
}

function sanitizeAutomaticMemory(content) {
  let text = String(content || "");
  text = text.replace(
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
    "[REDACTED PRIVATE KEY]"
  );
  text = text.replace(
    /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi,
    "$1[REDACTED]@"
  );
  text = text.replace(
    /(\b(?:authorization\s*[:=]?\s*)?bearer\s+)[^\s,;]+/gi,
    "$1[REDACTED]"
  );
  text = compat.redact(text);
  text = text.replace(
    /\b(root|admin(?:istrator)?)\s+([^\s,;]+)/gi,
    (all, role, candidate) => {
      const classes = [
        /[a-z]/.test(candidate),
        /[A-Z]/.test(candidate),
        /\d/.test(candidate),
        /[^A-Za-z0-9]/.test(candidate),
      ].filter(Boolean).length;
      return candidate.length >= 8 && classes >= 3 ? `${role} [REDACTED]` : all;
    }
  );
  return text.slice(0, 12_000);
}

function rememberEvent(input, event, content, title = event) {
  if (!content) return;
  const sanitized = sanitizeAutomaticMemory(content);
  if (!sanitized) return;
  if (process.env.CAPSULE_HOOK_PROCESS === "1") {
    try {
      const file = path.join(hookRoot(), "memory-spool.jsonl");
      fs.appendFileSync(file, `${JSON.stringify({
        at: new Date().toISOString(),
        event,
        title,
        session_id: sessionId(input),
        project: projectScope(input),
        content: sanitized,
      })}\n`, "utf8");
    } catch (error) {
      logError(`${event}-spool`, error);
    }
    return;
  }
  try {
    unified.remember({
      content: sanitized,
      tag: event,
      title,
      source: `session://${sessionId(input)}/${event}/${Date.now()}`,
      tags: ["session-event", event, sessionId(input), projectScope(input)],
      content_type: "prose",
    });
  } catch (error) {
    // Persistent recall is an optional side effect. A busy index must never
    // discard a compact replacement and leak the original large tool output.
    logError(`${event}-remember`, error);
  }
}

function writeHeartbeat(event, input) {
  try {
    const normalized = String(event || "unknown").replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
    const file = path.join(hookRoot(), `heartbeat-${normalized}.json`);
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    const heartbeat = {
      at: new Date().toISOString(),
      event: normalized,
      pid: process.pid,
      session_id: sessionId(input),
      script: path.resolve(__filename),
    };
    fs.writeFileSync(temporary, `${JSON.stringify(heartbeat)}\n`, "utf8");
    fs.renameSync(temporary, file);
  } catch {
    // Runtime proof is diagnostic only and must not affect the hook contract.
  }
}

function phaseCheckpointFile(input) {
  const key = crypto.createHash("sha256").update(sessionId(input)).digest("hex").slice(0, 20);
  const root = path.join(hookRoot(), "phase-checkpoints");
  fs.mkdirSync(root, { recursive: true });
  return path.join(root, `${key}.json`);
}

function writePhaseCheckpoint(input, content) {
  const sanitized = sanitizeAutomaticMemory(content).replace(/\s+/g, " ").trim().slice(0, 800);
  if (!sanitized) return;
  const file = phaseCheckpointFile(input);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    state = {};
  }
  const entries = Array.isArray(state.entries) ? state.entries : [];
  if (entries.at(-1)?.content === sanitized) return;
  const next = {
    entries: [...entries, { at: new Date().toISOString(), content: sanitized }].slice(-3),
  };
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function latestPhaseCheckpoint(input) {
  try {
    const state = JSON.parse(fs.readFileSync(phaseCheckpointFile(input), "utf8"));
    const entries = Array.isArray(state.entries) ? state.entries : [];
    return String(entries.at(-1)?.content || "").slice(0, 420);
  } catch {
    return "";
  }
}

function pressureState(input) {
  try {
    return compaction.contextPressure(reasoningGovernorArgs(input)).response;
  } catch {
    return {
      available: false,
      mode: "normal",
      policy: compaction.policyForMode("normal"),
    };
  }
}

function roundTripTaxGuidance(input) {
  if (process.env.CAPSULE_ROUNDTRIP_TAX === "0") return "";
  const pressure = pressureState(input);
  const tax = pressure.roundtrip_tax || {};
  if (!tax.telemetry_available || !tax.elevated) return "";
  const usageKey = [
    Number(tax.input_tokens || 0),
    Number(tax.cached_input_tokens || 0),
    Number(tax.uncached_input_tokens || 0),
  ].join(":");
  if (usageKey === "0:0:0") return "";
  const file = hashedHookStateFile(input, "roundtrip-tax");
  const state = readHookState(file, {});
  if (state.usage_key === usageKey) return "";
  writeHookState(file, { usage_key: usageKey, emitted_at: Date.now() });
  const incident = String(tax.cache_incident?.classification || "");
  return `[Capsule tax: uncached=${Number(tax.uncached_input_tokens || 0)}t; ` +
    `cache=${Number(tax.cache_hit_percent || 0)}%; ${incident ? `cause=${incident}; ` : ""}batch safe reads/polls; avoid plan-only repeat.]`;
}

function hashedHookStateFile(input, folder) {
  const key = crypto.createHash("sha256").update(sessionId(input)).digest("hex").slice(0, 20);
  const root = path.join(hookRoot(), folder);
  fs.mkdirSync(root, { recursive: true });
  return path.join(root, `${key}.json`);
}

function readHookState(file, fallback = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeHookState(file, state) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function recordProviderSessionPointer(input) {
  const sessionFile = firstString(input, [
    "session_file", "sessionFile", "transcript_path", "transcriptPath", "rollout_path", "rolloutPath",
  ]);
  if (!sessionFile || !fs.existsSync(sessionFile)) return;
  writeHookState(path.join(hookRoot(), "provider-telemetry-current.json"), {
    session_id: explicitSessionId(input),
    session_file: path.resolve(sessionFile),
    project: projectDir(input),
    timestamp: new Date().toISOString(),
  });
}

function compactToolPath(value) {
  const text = String(value || "").replace(/\\/g, "/").replace(/[\r\n\t]/g, " ").trim();
  if (!text || text.length > 1_000) return "";
  return text.split("/").filter(Boolean).slice(-3).join("/").slice(0, 180);
}

function toolPaths(input) {
  const found = [];
  const seen = new Set();
  const root = input.tool_input || input.toolInput || {};
  function add(value) {
    const compacted = compactToolPath(value);
    if (compacted && !found.includes(compacted)) found.push(compacted);
  }
  function visit(value, key = "", depth = 0) {
    if (depth > 5 || value == null || found.length >= 8) return;
    if (typeof value === "string") {
      if (/(?:path|file|target|source|destination|workspace|cwd)/i.test(key)) add(value);
      for (const match of value.matchAll(/^\*{3} (?:Add|Update|Delete) File:\s*(.+)$/gm)) add(match[1]);
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    for (const [childKey, child] of Object.entries(value)) visit(child, childKey, depth + 1);
  }
  visit(root);
  return found;
}

function isPollTool(toolName) {
  return /(?:^|[._-])(?:wait(?:_agent)?|list_agents|write_stdin|status)(?:$|[._-])/i.test(String(toolName || ""));
}

function isShellToolName(toolName) {
  return /(?:^|[._-])(?:local[_-]?shell|shell(?:[_-]?command)?|bash|zsh|fish|sh|powershell|pwsh|cmd|terminal|exec(?:[_-]?command)?|write[_-]?stdin)(?:$|[._-])/i.test(
    String(toolName || "").trim()
  );
}

function executionStateFallback() {
  return {
    epoch: 0,
    reads: {},
    changed: [],
    tests: [],
    poll_count: 0,
    no_progress_reads: 0,
    plan_count: 0,
    same_plan_count: 0,
    spawn_count: 0,
    mutation_count: 0,
    tool_calls: 0,
    advisor_enabled: true,
    project_scope: "",
    task_id: "",
    task_term_hashes: [],
    task_budget: null,
    sequence: [],
    sequence_warnings: [],
    repeated_read_count: 0,
    successful_evidence: {},
    context_interest_tokens: 0,
    context_interest_tier: 0,
  };
}

function startAdvisorTask(input, prompt) {
  const file = hashedHookStateFile(input, "execution-progress");
  const current = readHookState(file, executionStateFallback());
  if (process.env.CAPSULE_ADVISOR === "0") return { changed: false, boundary: false, plan: null };
  const now = Date.now();
  const configuredTtl = Number(process.env.CAPSULE_ADVISOR_TASK_TTL_MS);
  const taskTtl = Number.isFinite(configuredTtl)
    ? Math.min(7 * 24 * 60 * 60 * 1_000, Math.max(60_000, Math.trunc(configuredTtl)))
    : 6 * 60 * 60 * 1_000;
  const currentProject = projectScope(input);
  const expired = Number(current.task_started_at || 0) > 0 &&
    now - Number(current.task_started_at) > taskTtl;
  const projectChanged = Boolean(current.project_scope) && current.project_scope !== currentProject;
  const prior = expired || projectChanged
    ? { ...executionStateFallback(), epoch: Number(current.epoch || 0) + 1 }
    : current;
  let plan;
  try {
    plan = advisor.plan({
      prompt,
      previous_task: {
        fingerprint: prior.task_id,
        term_hashes: prior.task_term_hashes,
      },
    }).response;
  } catch {
    return { changed: false, plan: null };
  }
  const changed = !prior.task_id || plan.task_boundary === true || expired || projectChanged;
  const next = changed
    ? {
      ...executionStateFallback(),
      epoch: Number(current.epoch || 0) + 1,
      task_started_at: now,
    }
    : prior;
  next.task_id = plan.task_id;
  next.task_term_hashes = plan.term_hashes;
  next.task_budget = {
    max_calls: plan.max_tool_calls,
    max_read_calls: plan.max_read_calls,
  };
  next.project_scope = currentProject;
  next.task_prompt_count = Number(next.task_prompt_count || 0) + 1;
  next.updated_at = Date.now();
  writeHookState(file, next);
  return {
    changed,
    boundary: Boolean(current.task_id && (plan.task_boundary || expired || projectChanged)),
    plan,
  };
}

function isNativeEditToolName(toolName) {
  const normalized = String(toolName || "").trim().toLowerCase().replace(/\s+/g, "_");
  if (!normalized) return false;
  const leaf = normalized.split(/[.:/]/).filter(Boolean).at(-1) || "";
  return /^(?:apply[_-]?patch|edit|write|update|edit[_-]?file|write[_-]?file|update[_-]?file|multi[_-]?edit|str[_-]?replace[_-]?editor)$/.test(leaf);
}

function nativeEditInventory(input) {
  const roots = [
    input.available_tools,
    input.availableTools,
    input.tool_names,
    input.toolNames,
    input.tool_inventory,
    input.toolInventory,
    input.capabilities?.tools,
  ].filter((value) => value != null);
  const queue = roots.map((value) => ({ value, depth: 0 }));
  const seen = new Set();
  let visited = 0;
  while (queue.length && visited < 256) {
    const { value, depth } = queue.shift();
    visited += 1;
    if (typeof value === "string") {
      if (isNativeEditToolName(value)) return value;
      continue;
    }
    if (!value || typeof value !== "object" || seen.has(value) || depth >= 4) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const child of value.slice(0, 128)) queue.push({ value: child, depth: depth + 1 });
      continue;
    }
    for (const [key, child] of Object.entries(value).slice(0, 128)) {
      if (isNativeEditToolName(key)) return key;
      if (/^(?:name|tool_name|toolName|id)$/i.test(key) && typeof child === "string" &&
          isNativeEditToolName(child)) return child;
      if (typeof child === "object" && child != null) queue.push({ value: child, depth: depth + 1 });
    }
  }
  return "";
}

function nativeEditCapabilityFile(input) {
  if (!explicitSessionId(input)) return "";
  return hashedHookStateFile(input, "native-edit-capability");
}

function rememberNativeEditTool(input, toolName) {
  if (!isNativeEditToolName(toolName)) return "";
  const file = nativeEditCapabilityFile(input);
  if (file) writeHookState(file, { tool_name: String(toolName).slice(0, 160), observed_at: Date.now() });
  return String(toolName);
}

function availableNativeEditTool(input, currentToolName = "") {
  const configured = String(process.env.CAPSULE_NATIVE_EDIT_TOOL || "").trim();
  if (/^(?:0|off|false|none|disabled)$/i.test(configured)) return "";
  if (configured) return isNativeEditToolName(configured) ? configured : "native editing tool";
  const observed = nativeEditInventory(input) ||
    (isNativeEditToolName(currentToolName) ? String(currentToolName) : "");
  if (observed) return rememberNativeEditTool(input, observed);
  const file = nativeEditCapabilityFile(input);
  if (!file) return "";
  const saved = readHookState(file, {});
  return isNativeEditToolName(saved.tool_name) ? String(saved.tool_name) : "";
}

const NATIVE_EDIT_TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".rst", ".adoc", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml", ".html", ".htm", ".css", ".scss", ".sass",
  ".less", ".py", ".rb", ".php", ".java", ".kt", ".kts", ".c", ".h", ".cc", ".cpp", ".hpp",
  ".cs", ".go", ".rs", ".swift", ".sh", ".bash", ".zsh", ".fish", ".ps1", ".sql", ".graphql",
  ".gql", ".proto", ".ini", ".cfg", ".conf", ".properties", ".gradle", ".sln", ".csproj", ".fsproj",
  ".vbproj", ".vue", ".svelte", ".astro", ".lock",
]);
const NATIVE_EDIT_TEXT_NAMES = new Set([
  "dockerfile", "makefile", "license", "readme", "agents.md", ".env", ".gitignore", ".gitattributes",
  ".editorconfig", ".npmrc", ".prettierrc", ".eslintrc",
]);

function canonicalProspectivePath(target) {
  let cursor = path.resolve(target);
  const suffix = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return "";
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  try {
    const real = fs.realpathSync.native ? fs.realpathSync.native(cursor) : fs.realpathSync(cursor);
    return path.resolve(real, ...suffix);
  } catch {
    return "";
  }
}

function staticWorkspaceTextTarget(input, literal) {
  const value = String(literal || "").trim();
  if (!value || value.length > 400 || /[\0\r\n*?%$`]/.test(value) || value.startsWith("~")) return "";
  const root = canonicalProspectivePath(projectDir(input));
  const candidate = canonicalProspectivePath(path.isAbsolute(value) ? value : path.resolve(projectDir(input), value));
  if (!root || !candidate) return "";
  const rootKey = process.platform === "win32" ? root.toLowerCase() : root;
  const candidateKey = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const relative = path.relative(rootKey, candidateKey);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return "";
  try {
    if (fs.existsSync(candidate) && !fs.statSync(candidate).isFile()) return "";
  } catch {
    return "";
  }
  const basename = path.basename(candidateKey).toLowerCase();
  if (!NATIVE_EDIT_TEXT_EXTENSIONS.has(path.extname(basename)) && !NATIVE_EDIT_TEXT_NAMES.has(basename)) return "";
  return candidate;
}

function onlyKnownCalls(text, allowed) {
  for (const match of String(text).matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    if (!allowed.has(match[1].toLowerCase())) return false;
  }
  return true;
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pythonStaticEditProof(text) {
  const withoutPathlib = text.replace(/\bfrom\s+pathlib\s+import\s+Path\b/gi, "");
  if (/\b(?:from|import)\b/i.test(withoutPathlib) ||
      !onlyKnownCalls(text, new Set(["path", "write_text", "read_text", "replace", "open", "write"]))) return null;
  const direct = /Path\s*\(\s*(?<pq>["'])(?<target>[A-Za-z0-9_.\\/ @:+-]{1,400})\k<pq>\s*\)\s*\.\s*write_text\s*\(\s*(?<cq>["'])(?<content>[^"'\\\r\n]{0,2048})\k<cq>(?:\s*,\s*encoding\s*=\s*["']utf-?8["'])?\s*\)/i.exec(text);
  if (direct) return { target: direct.groups.target, kind: "literal-write" };
  const assignedLiteral = /\b(?<variable>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*Path\s*\(\s*(?<pq>["'])(?<target>[A-Za-z0-9_.\\/ @:+-]{1,400})\k<pq>\s*\)(?:\s*;|\s*\r?\n)[\s\S]{0,300}?\b\k<variable>\s*\.\s*write_text\s*\(\s*(?<cq>["'])(?<content>[^"'\\\r\n]{0,2048})\k<cq>(?:\s*,\s*encoding\s*=\s*["']utf-?8["'])?\s*\)/i.exec(text);
  if (assignedLiteral) return { target: assignedLiteral.groups.target, kind: "literal-write" };
  const assignedReplace = /\b(?<variable>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*Path\s*\(\s*(?<pq>["'])(?<target>[A-Za-z0-9_.\\/ @:+-]{1,400})\k<pq>\s*\)(?:\s*;|\s*\r?\n)[\s\S]{0,300}?\b\k<variable>\s*\.\s*write_text\s*\(\s*\k<variable>\s*\.\s*read_text\s*\(\s*(?:encoding\s*=\s*["']utf-?8["'])?\s*\)\s*\.\s*replace\s*\(\s*(?<oq>["'])(?<old>[^"'\\\r\n]{1,512})\k<oq>\s*,\s*(?<nq>["'])(?<next>[^"'\\\r\n]{0,512})\k<nq>\s*\)\s*(?:,\s*encoding\s*=\s*["']utf-?8["'])?\s*\)/i.exec(text);
  if (assignedReplace) return { target: assignedReplace.groups.target, kind: "literal-replace" };
  const pathAssignment = /\b(?<variable>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*Path\s*\(\s*(?<pq>["'])(?<target>[A-Za-z0-9_.\\/ @:+-]{1,400})\k<pq>\s*\)/i.exec(text);
  if (pathAssignment && [...text.matchAll(/\bPath\s*\(/gi)].length === 1) {
    const pathVariable = regexEscape(pathAssignment.groups.variable);
    const read = new RegExp(`\\b([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*${pathVariable}\\s*\\.\\s*read_text\\s*\\(\\s*(?:encoding\\s*=\\s*[\"']utf-?8[\"'])?\\s*\\)`, "i").exec(text);
    if (read) {
      const readVariable = regexEscape(read[1]);
      const replace = new RegExp(`\\b([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*${readVariable}\\s*\\.\\s*replace\\s*\\(\\s*([\"'])([^\"'\\\\\\r\\n]{1,512})\\2\\s*,\\s*([\"'])([^\"'\\\\\\r\\n]{0,512})\\4\\s*\\)`, "i").exec(text);
      if (replace) {
        const nextVariable = regexEscape(replace[1]);
        const write = new RegExp(`\\b${pathVariable}\\s*\\.\\s*write_text\\s*\\(\\s*${nextVariable}\\s*(?:,\\s*encoding\\s*=\\s*[\"']utf-?8[\"'])?\\s*\\)`, "i").test(text);
        if (write) return { target: pathAssignment.groups.target, kind: "literal-replace" };
      }
    }
  }
  const append = /\bopen\s*\(\s*(?<pq>["'])(?<target>[A-Za-z0-9_.\\/ @:+-]{1,400})\k<pq>\s*,\s*(?<mq>["'])a(?:t)?\k<mq>\s*\)\s*\.\s*write\s*\(\s*(?<cq>["'])(?<content>[^"'\\\r\n]{0,2048})\k<cq>\s*\)/i.exec(text);
  return append ? { target: append.groups.target, kind: "literal-append" } : null;
}

function nodeStaticEditProof(text) {
  const withoutFs = text.replace(/\brequire\s*\(\s*["'](?:node:)?fs["']\s*\)/gi, "");
  if (/\b(?:require|import)\b/i.test(withoutFs) || /\bJSON\s*\.\s*(?:parse|stringify)\s*\(/i.test(text) ||
      !onlyKnownCalls(text, new Set(["require", "writefilesync", "appendfilesync", "readfilesync", "replace"]))) return null;
  const direct = /\bfs\s*\.\s*(?<method>writeFileSync|appendFileSync)\s*\(\s*(?<pq>["'])(?<target>[A-Za-z0-9_.\\/ @:+-]{1,400})\k<pq>\s*,\s*(?<cq>["'])(?<content>[^"'\\\r\n]{0,2048})\k<cq>(?:\s*,\s*["']utf-?8["'])?\s*\)/i.exec(text);
  if (direct) return { target: direct.groups.target, kind: /append/i.test(direct.groups.method) ? "literal-append" : "literal-write" };
  const replace = /\bfs\s*\.\s*writeFileSync\s*\(\s*(?<wq>["'])(?<target>[A-Za-z0-9_.\\/ @:+-]{1,400})\k<wq>\s*,\s*fs\s*\.\s*readFileSync\s*\(\s*(?<rq>["'])(?<read>[A-Za-z0-9_.\\/ @:+-]{1,400})\k<rq>\s*,\s*["']utf-?8["']\s*\)\s*\.\s*replace\s*\(\s*(?<oq>["'])(?<old>[^"'\\\r\n]{1,512})\k<oq>\s*,\s*(?<nq>["'])(?<next>[^"'\\\r\n]{0,512})\k<nq>\s*\)\s*\)/i.exec(text);
  return replace && replace.groups.target === replace.groups.read
    ? { target: replace.groups.target, kind: "literal-replace" }
    : null;
}

function powerShellPathAfter(text, command) {
  const match = new RegExp(`\\b${command}\\b\\s+(?:-(?:Literal)?Path\\s+)?(?:\"([^\"]{1,400})\"|'([^']{1,400})'|([A-Za-z0-9_.\\\\/@:+-]{1,400}))`, "i").exec(text);
  return match ? { target: match[1] || match[2] || match[3] || "", end: match.index + match[0].length } : null;
}

function powerShellStaticEditProof(text) {
  if (/\b(?:Import-Module|Invoke-Expression|ConvertTo-Json|ConvertFrom-Json|ConvertTo-Yaml|ConvertFrom-Yaml|Import-Csv|Export-Csv)\b/i.test(text)) return null;
  const fileCall = /::(?<method>WriteAllText|AppendAllText)\s*\(\s*(?<pq>["'])(?<target>[A-Za-z0-9_.\\/ @:+-]{1,400})\k<pq>\s*,\s*(?<cq>["'])(?<content>[^"'`\r\n]{0,2048})\k<cq>\s*\)/i.exec(text);
  if (fileCall) return { target: fileCall.groups.target, kind: /append/i.test(fileCall.groups.method) ? "literal-append" : "literal-write" };
  const mutation = powerShellPathAfter(text, "(?:Set-Content|Add-Content)");
  if (!mutation) return null;
  const tail = text.slice(mutation.end);
  const literalValue = /^\s+(?:-Value\s+)?(?:"[^"`\r\n]{0,2048}"|'[^'\r\n]{0,2048}')\s*;?\s*["']?\s*$/i.test(tail);
  if (literalValue) return { target: mutation.target, kind: /Add-Content/i.test(text.slice(mutation.end - mutation.target.length - 80, mutation.end)) ? "literal-append" : "literal-write" };
  const source = powerShellPathAfter(text, "Get-Content");
  const replace = /-replace\s*(?<oq>["'])(?<old>[^"'`\r\n]{1,512})\k<oq>\s*,\s*(?<nq>["'])(?<next>[^"'`\r\n]{0,512})\k<nq>/i.test(text);
  return source && source.target === mutation.target && replace
    ? { target: mutation.target, kind: "literal-replace" }
    : null;
}

function simpleInterpreterTextEdit(input, toolName) {
  if (!isShellToolName(toolName)) return null;
  const { toolInput, command } = shellCommand(input);
  const text = String(command || "").trim();
  if (!text || text.length > 12_000 || text.split(/\r?\n/).length > 40) return null;
  if (toolInput.native_edit_force === true || toolInput.nativeEditForce === true ||
      toolInput.capsule_force === true || toolInput.capsuleForce === true) return null;

  const intent = [
    text,
    firstString(input, ["intent", "query", "prompt"]),
    firstString(toolInput, ["intent", "query", "description"]),
  ].join(" ");
  if (/\b(?:bulk|mechanical|generated?|generator|codegen|scaffold|format(?:ter|ting)?|prettier|black|migration|migrate|schema|seed|fixture|snapshot|vendor|lockfile|compile|bundle|transpil|binary|media|image|audio|video|archive)\b/i.test(intent) ||
      /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|pdf|zip|7z|tar|gz|mp3|wav|flac|mp4|mov|webm|woff2?|ttf|otf|wasm)\b/i.test(text) ||
      /\b(?:write_bytes|writeallbytes|buffer\.from|base64|encoding\s*=\s*["'](?:hex|base64)|toString\s*\(\s*["']base64)\b/i.test(text)) {
    return null;
  }
  if (/\b(?:for\s+each|foreach|for\s*\(|for\s+\w+\s+in|while\s*\(|r?glob\s*\(|os\.walk|walkdir|get-childitem\b[^\r\n]*-recurse|child_process|subprocess|start-process|invoke-webrequest|requests?\.|fetch\s*\(|https?:\/\/|sqlite|database|re\.sub\s*\(|json\.(?:dump|dumps)|yaml\.|csv\.)\b/i.test(text)) {
    return null;
  }

  const pythonInline = /\b(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?\s+(?:-c\b|-\s*(?:$|[;&|]))/im.test(text);
  const nodeInline = /\bnode(?:\.exe)?\s+(?:-e\b|--eval\b|-\s*(?:$|[;&|]))/im.test(text);
  const powershellInline = /\b(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]{0,300}\s-(?:c|command)\b/i.test(text) ||
    /(?:^|[._-])(?:powershell|pwsh)(?:$|[._-])/i.test(String(toolName || "")) ||
    /(?:^|[;|]\s*)(?:Set-Content|Add-Content|Out-File)\b|::(?:WriteAllText|AppendAllText)\s*\(/i.test(text);
  let interpreter = "";
  let mutationPattern = null;
  let proof = null;
  if (pythonInline) {
    interpreter = "Python";
    mutationPattern = /\.write_text\s*\(|\bopen\s*\([^\r\n)]{0,320},\s*["'][watx](?:\+|t)?["'][^)]*\)\s*\.write\s*\(/gi;
    proof = pythonStaticEditProof(text);
  } else if (nodeInline) {
    interpreter = "Node";
    mutationPattern = /\b(?:writeFileSync|appendFileSync|writeFile|appendFile)\s*\(/gi;
    proof = nodeStaticEditProof(text);
  } else if (powershellInline) {
    interpreter = "PowerShell";
    mutationPattern = /\b(?:Set-Content|Add-Content|Out-File)\b|::(?:WriteAllText|AppendAllText)\s*\(/gi;
    proof = powerShellStaticEditProof(text);
  } else {
    return null;
  }
  const mutations = [...text.matchAll(mutationPattern)].length;
  const target = proof ? staticWorkspaceTextTarget(input, proof.target) : "";
  if (mutations !== 1 || !proof || !target) return null;
  return { interpreter, mutations, target, kind: proof.kind };
}

function nativeEditPreferenceGuard(input, toolName) {
  if (process.env.CAPSULE_NATIVE_EDIT_GUARD === "0") return null;
  const nativeTool = availableNativeEditTool(input, toolName);
  const candidate = simpleInterpreterTextEdit(input, toolName);
  if (!nativeTool || !candidate) return null;
  const reason = `[Capsule native-edit guard: ${candidate.interpreter} appears to be used only for a bounded text edit. ` +
    `Use ${nativeTool} instead. Shell execution remains valid for generators, formatters, migrations, ` +
    "bulk/mechanical rewrites, binary/media work, or when no native edit tool exists. " +
    "Set native_edit_force=true only for a deliberate exception.]";
  return reason.slice(0, 620);
}

function requiresLiteralShellOutput(input) {
  const toolInput = input.tool_input || input.toolInput || {};
  const { command } = shellCommand(input);
  const intent = [
    command,
    firstString(input, ["intent", "query", "prompt"]),
    firstString(toolInput, ["intent", "query", "description"]),
  ].join(" ");
  return /\b(?:benchmark|performance|profil(?:e|ing)?|latency|duration|elapsed|timing|wall[ -]?time|verbatim|unabridged|raw output|full output|complete output|exact output)\b|(?:ham|tam|eksiksiz)\s+çıktı/iu.test(
    intent
  );
}

function isQuietPollOutput(output) {
  const text = String(output || "");
  if (!text || /\b(?:completed?|finished|done|failed|failure|error|needs? attention|user input|final answer|terminated|cancelled|canceled|interrupted)\b/i.test(text)) {
    return false;
  }
  return /\b(?:running|waiting|unchanged|no (?:new )?(?:output|activity|update)|timed out|timeout|still|in[_ -]?progress|pending)\b/i.test(
    text
  );
}

function isPlanningTool(toolName) {
  return /(?:^|[._-])(?:update[_-]?plan|create[_-]?goal|update[_-]?goal|get[_-]?goal)(?:$|[._-])/i.test(
    String(toolName || "")
  );
}

function isSpawnTool(toolName) {
  return /(?:^|[._-])spawn[_-]?agent(?:$|[._-])/i.test(String(toolName || ""));
}

function isMutationTool(toolName) {
  if (isPlanningTool(toolName) || isPollTool(toolName)) return false;
  return /(?:apply[_ -]?patch|write|edit|delete|remove|create|update|move|rename|send)/i.test(
    String(toolName || "")
  );
}

function nodeReplCode(input) {
  const normalized = firstString(input, ["tool_name", "toolName", "name"]).toLowerCase();
  if (!/(?:node[_ -]?repl|node_repl)(?:[._-].*)?$/.test(normalized)) return "";
  return firstString(input.tool_input || input.toolInput || {}, ["code"]);
}

function isNodeReplMutation(input) {
  const code = nodeReplCode(input);
  if (!code) return false;
  return /(?:\.click\s*\(|\.fill\s*\(|\.type\s*\(|\.press\s*\(|\.goto\s*\(|navigate\s*\(|writeFile|appendFile|rmSync|unlink|rename|mkdir|setContent|addScriptTag|dispatchEvent)/i.test(
    code
  );
}

function isObservationalNodeRepl(input) {
  const code = nodeReplCode(input);
  if (!code || isNodeReplMutation(input)) return false;
  return /(?:playwright|chromium|pages\s*\(|tabs|locator|querySelector|innerText|textContent|accessibility|snapshot|screenshot|performance|getEntries|request|response|content\s*\(|evaluate\s*\()/i.test(
    code
  );
}

function isObservationalShell(input, toolName) {
  if (!isShellToolName(toolName)) return false;
  const { command } = shellCommand(input);
  if (!command) return false;
  return /(?:^|[;&|]\s*)(?:rg|grep|findstr|select-string|git\s+(?:status|diff|log|show)|ls|dir|tree|find|get-childitem|gci|cat|type|get-content|head|tail)\b/i.test(command) &&
    !/\b(?:remove-item|set-content|add-content|out-file|rm|del|erase|mv|move|cp|copy|git\s+(?:add|commit|push|reset|checkout)|npm\s+install|pnpm\s+install|yarn\s+install)\b/i.test(command);
}

function explicitEfficiencyOverride(input) {
  const toolInput = input.tool_input || input.toolInput || {};
  return toolInput.force_refresh === true || toolInput.forceRefresh === true ||
    toolInput.capsule_force === true || toolInput.capsuleForce === true;
}

function isBatchedObservation(input, toolName) {
  const normalized = String(toolName || "").toLowerCase();
  const toolInput = input.tool_input || input.toolInput || {};
  if (Array.isArray(toolInput.commands) && toolInput.commands.length > 1) return true;
  if (Array.isArray(toolInput.queries) && toolInput.queries.length > 1) return true;
  if (Array.isArray(toolInput.paths) && toolInput.paths.length > 1) return true;
  if (/capsule/.test(normalized) &&
      String(toolInput.action || "").toLowerCase() === "batch") return true;
  const command = firstString(toolInput, ["command"]);
  return Boolean(command && /(?:&&|\|\||;\s*\S|\|\s*\S)/.test(command));
}

function contextInterestCharge(pressure) {
  const tax = pressure?.roundtrip_tax || {};
  const input = Number(tax.input_tokens || pressure?.input_tokens || 0);
  const cached = Math.min(input, Number(tax.cached_input_tokens || pressure?.cached_input_tokens || 0));
  const uncached = Number(tax.uncached_input_tokens || Math.max(0, input - cached));
  if (!input && !cached && !uncached) return 0;
  return Math.max(0, Math.round(uncached + cached * 0.1));
}

function recordContextInterestBlock(charge, mode) {
  const file = path.join(hookRoot(), "context-interest-exchange.json");
  const state = readHookState(file, {
    blocked_singletons: 0,
    estimated_weighted_context_tokens_redirected: 0,
  });
  state.blocked_singletons += 1;
  state.estimated_weighted_context_tokens_redirected += Math.max(0, Number(charge || 0));
  state.last_mode = mode;
  state.last_blocked_at = new Date().toISOString();
  writeHookState(file, state);
}

function interestAdjustedPolicy(input, policy) {
  const state = readHookState(hashedHookStateFile(input, "execution-progress"), {});
  const tier = Number(state.context_interest_tier || 0);
  if (tier <= 0) return policy;
  const factor = tier >= 2 ? 0.45 : 0.7;
  return {
    ...policy,
    tool_max_chars: Math.max(900, Math.round(policy.tool_max_chars * factor)),
    tool_passthrough_chars: Math.max(220, Math.round(policy.tool_passthrough_chars * factor)),
    thread_item_chars: Math.max(120, Math.round(policy.thread_item_chars * factor)),
  };
}

function isFailedToolResult(input, output = toolOutput(input)) {
  if (input.is_error === true || input.isError === true) return true;
  const response = rawToolOutput(input);
  if (response && typeof response === "object") {
    if (response.is_error === true || response.isError === true || response.success === false) return true;
    const exitCode = Number(response.exit_code ?? response.exitCode);
    if (Number.isFinite(exitCode) && exitCode !== 0) return true;
    if (/^(?:failed|failure|error)$/i.test(String(response.status || ""))) return true;
  }
  return /(?:^|[\r\n{,])\s*(?:"?exit[_ ]?code"?\s*[:=]\s*[1-9]\d*|process exited with code\s+[1-9]\d*|"?status"?\s*[:=]\s*"?(?:failed|failure|error)|"?success"?\s*[:=]\s*false)\b/i.test(
    String(output || "")
  );
}

function planningFingerprint(input) {
  const toolInput = input.tool_input || input.toolInput || {};
  let value = toolInput;
  if (Array.isArray(toolInput.plan)) {
    value = toolInput.plan.map((item) => ({
      step: String(item?.step || "").replace(/\s+/g, " ").trim().toLowerCase(),
      status: String(item?.status || "").trim().toLowerCase(),
    }));
  } else if (Object.hasOwn(toolInput, "objective") || Object.hasOwn(toolInput, "status")) {
    value = {
      objective: String(toolInput.objective || "").replace(/\s+/g, " ").trim().toLowerCase(),
      status: String(toolInput.status || "").trim().toLowerCase(),
    };
  }
  try {
    return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
  } catch {
    return "";
  }
}

function toolSequenceFingerprint(input, toolName) {
  try {
    const serialized = JSON.stringify(input.tool_input || input.toolInput || {});
    if (serialized.length > 100_000) return "";
    return crypto.createHash("sha256")
      .update(`${String(toolName || "").trim().toLowerCase()}\0${serialized}`)
      .digest("hex")
      .slice(0, 16);
  } catch {
    return "";
  }
}

function stableEvidenceIdentity(input, toolName) {
  if (process.env.CAPSULE_INFORMATION_GAIN_FIREWALL === "0") return "";
  const normalized = String(toolName || "").trim().toLowerCase();
  const toolInput = input.tool_input || input.toolInput || {};
  if (toolInput.force_refresh === true || toolInput.forceRefresh === true) return "";
  if (/browser|chrome|web|http|gmail|email|calendar|weather|finance|sports|time|wait|status|poll/.test(normalized)) return "";
  const capsuleAction = String(toolInput.action || "").toLowerCase();
  const capsulePayload = toolInput.payload || {};
  if (/capsule/.test(normalized) && capsuleAction === "expand" && capsulePayload.capsule_id) {
    return `immutable-capsule:${toolSequenceFingerprint(input, normalized)}`;
  }
  if (!isReadOnlyTool(normalized) && !isReadOnlyCapsule(input, normalized)) return "";
  const rawPaths = [];
  const seen = new Set();
  function visitPaths(value, key = "", depth = 0) {
    if (depth > 5 || value == null || rawPaths.length >= 4) return;
    if (typeof value === "string") {
      if (/(?:path|file|target|source|destination)/i.test(key) && value.length <= 4_096) rawPaths.push(value);
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visitPaths(item, key, depth + 1);
      return;
    }
    for (const [childKey, child] of Object.entries(value)) visitPaths(child, childKey, depth + 1);
  }
  visitPaths(toolInput);
  const paths = rawPaths.map((item) => path.resolve(projectDir(input), item));
  if (!paths.length) return "";
  const proofs = [];
  for (const target of paths) {
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return "";
      const digest = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
      proofs.push(`${target}\0${stat.size}\0${digest}`);
    } catch {
      return "";
    }
  }
  return `local-evidence:${toolSequenceFingerprint(input, normalized)}:${crypto.createHash("sha256")
    .update(proofs.join("\n")).digest("hex").slice(0, 24)}`;
}

function recordInformationGainBlock(saved) {
  const file = path.join(hookRoot(), "information-gain-firewall.json");
  const state = readHookState(file, {
    blocked_calls: 0,
    avoided_output_chars: 0,
    approx_tokens_avoided: 0,
  });
  state.blocked_calls += 1;
  state.avoided_output_chars += Number(saved.output_chars || 0);
  state.approx_tokens_avoided = core.approxTokens(state.avoided_output_chars);
  state.last_blocked_at = new Date().toISOString();
  writeHookState(file, state);
}

function sequenceCycleGuidance(input, toolName, state) {
  if (process.env.CAPSULE_SEQUENCE_FUSE === "0") return "";
  const normalized = String(toolName || "").trim().toLowerCase();
  if (isPollTool(normalized) ||
      (!isReadOnlyTool(normalized) && !isReadOnlyCapsule(input, normalized) && !isPlanningTool(normalized))) return "";
  const fingerprint = toolSequenceFingerprint(input, normalized);
  if (!fingerprint) return "";
  const epoch = Number(state.epoch || 0);
  const sequence = Array.isArray(state.sequence) ? state.sequence.slice(-15) : [];
  sequence.push(`${epoch}:${fingerprint}`);
  state.sequence = sequence;
  for (let width = 4; width >= 2; width -= 1) {
    if (sequence.length < width * 2) continue;
    const latest = sequence.slice(-width);
    const prior = sequence.slice(-width * 2, -width);
    if (new Set(latest).size < 2 || latest.some((item, index) => item !== prior[index])) continue;
    const pattern = crypto.createHash("sha256").update(latest.join("|")).digest("hex").slice(0, 16);
    const warned = new Set(Array.isArray(state.sequence_warnings) ? state.sequence_warnings : []);
    if (warned.has(pattern)) return "";
    warned.add(pattern);
    state.sequence_warnings = [...warned].slice(-8);
    return `Capsule sequence fuse: a ${width}-step read/plan sequence repeated twice ` +
      "without an implementation mutation. Reuse the prior capsules, execute the next concrete change, " +
      "run one decisive diff/test, or state the blocker.";
  }
  return "";
}

function noteToolIntent(input, toolName) {
  const file = hashedHookStateFile(input, "execution-progress");
  const state = readHookState(file, executionStateFallback());
  const normalized = String(toolName || "").toLowerCase();
  const advisorEnabled = process.env.CAPSULE_ADVISOR !== "0";
  if (state.advisor_enabled !== undefined && Boolean(state.advisor_enabled) !== advisorEnabled) {
    const epoch = Number(state.epoch || 0) + 1;
    Object.assign(state, executionStateFallback(), { epoch, advisor_enabled: advisorEnabled });
  } else {
    state.advisor_enabled = advisorEnabled;
  }
  state.tool_calls = Number(state.tool_calls || 0) + 1;
  const paths = toolPaths(input);
  let guidance = "";
  let blockReason = "";
  if (isPollTool(normalized)) {
    state.poll_count = Number(state.poll_count || 0) + 1;
    if ([2, 4, 8].includes(state.poll_count)) {
      guidance = `Capsule poll governor: ${state.poll_count} consecutive wait/status calls. ` +
        "Do not re-plan unchanged state; use one bounded wait and wake only for new output, completion, attention, or user input.";
    }
  } else if (isSpawnTool(normalized)) {
    state.poll_count = 0;
    state.spawn_count = Number(state.spawn_count || 0) + 1;
    if ([4, 8].includes(state.spawn_count)) {
      guidance = `Capsule fan-out governor: ${state.spawn_count} subagents were spawned ` +
        "since the last implementation mutation. Reuse existing agents, keep new tasks self-contained, " +
        "and avoid recursive delegation unless it covers a distinct dependency.";
    }
  } else if (isPlanningTool(normalized)) {
    state.poll_count = 0;
    state.plan_count = Number(state.plan_count || 0) + 1;
    const fingerprint = planningFingerprint(input);
    const samePlan = Boolean(
      fingerprint &&
      fingerprint === state.last_plan_fingerprint &&
      Number(state.last_plan_epoch || 0) === Number(state.epoch || 0)
    );
    state.same_plan_count = samePlan ? Number(state.same_plan_count || 1) + 1 : 1;
    state.last_plan_fingerprint = fingerprint;
    state.last_plan_epoch = Number(state.epoch || 0);
    if (samePlan && [2, 4].includes(state.same_plan_count)) {
      guidance = `Capsule plan fuse: the same plan was submitted ${state.same_plan_count} times without an implementation mutation. ` +
        "Execute the next concrete step, run the decisive check, or state the blocker instead of re-planning.";
    } else if ([3, 6].includes(state.plan_count)) {
      guidance = `Capsule plan-only loop: ${state.plan_count} planning/goal updates since the last implementation mutation. ` +
        "Preserve this plan and move to the next executable action; do not spend another model turn restating it.";
    }
  } else {
    state.poll_count = 0;
    if (isReadOnlyTool(normalized) || isReadOnlyCapsule(input, normalized) ||
        isObservationalNodeRepl(input) || isObservationalShell(input, normalized)) {
      state.no_progress_reads = Number(state.no_progress_reads || 0) + 1;
      const pressure = pressureState(input);
      const charge = contextInterestCharge(pressure);
      state.context_interest_tokens = Number(state.context_interest_tokens || 0) + charge;
      const limit = pressure.mode === "emergency" ? 3
        : pressure.mode === "critical" ? 4
        : pressure.mode === "high" ? 6
        : pressure.roundtrip_tax?.elevated ? 8
        : Number.POSITIVE_INFINITY;
      state.context_interest_tier = state.no_progress_reads >= limit + 2 ? 2
        : state.no_progress_reads >= limit ? 1
        : 0;
      const readFingerprint = toolSequenceFingerprint(input, normalized);
      const sameRead = Boolean(
        readFingerprint &&
        readFingerprint === state.last_read_fingerprint &&
        Number(state.last_read_epoch || 0) === Number(state.epoch || 0)
      );
      state.repeated_read_count = sameRead ? Number(state.repeated_read_count || 1) + 1 : 1;
      state.last_read_fingerprint = readFingerprint;
      state.last_read_epoch = Number(state.epoch || 0);
      const evidenceIdentity = stableEvidenceIdentity(input, normalized);
      const savedEvidence = evidenceIdentity ? state.successful_evidence?.[evidenceIdentity] : null;
      if (savedEvidence && Number(savedEvidence.epoch ?? -1) === Number(state.epoch || 0)) {
        blockReason = "[Capsule information-gain firewall: identical cryptographically unchanged evidence is already visible; " +
          "reuse the prior result/capsule. Set force_refresh=true only when a deliberate reread is required.]";
        recordInformationGainBlock(savedEvidence);
      }
      if (!blockReason && state.no_progress_reads >= limit &&
          !explicitEfficiencyOverride(input) && !isBatchedObservation(input, normalized)) {
        const estimated = charge || Math.round(Number(pressure.input_tokens || 0) * 0.2);
        blockReason = `[Capsule context-interest exchange: ${state.no_progress_reads} singleton observations without ` +
          `a mutation at ${pressure.mode} pressure; next round costs ≈${estimated} weighted context tokens. ` +
          "Batch the remaining independent reads in one call, execute the evidence-backed change, or set " +
          "capsule_force=true when this singleton is indispensable.]";
        recordContextInterestBlock(estimated, pressure.mode);
      }
      for (const item of paths) {
        const prior = state.reads[item] || { count: 0, epoch: Number(state.epoch || 0) };
        state.reads[item] = {
          count: Number(prior.count || 0) + 1,
          epoch: Number(state.epoch || 0),
          at: Date.now(),
        };
      }
      if (sameRead && [2, 4, 8].includes(state.repeated_read_count)) {
        guidance = `Capsule exact-read fuse: the identical read/expand/observation was requested ` +
          `${state.repeated_read_count} times without a mutation. Reuse the already visible result or its exact capsule; ` +
          "request only an uncovered range if more evidence is required.";
      } else if ([4, 8, 16].includes(state.no_progress_reads)) {
        guidance = isObservationalNodeRepl(input)
          ? `Capsule browser observation budget: ${state.no_progress_reads} read-only Node REPL calls since the last mutation. ` +
            "Reuse persistent bindings and combine independent DOM/network/screenshot inspections into one JavaScript call with a compact aggregate."
          : `Capsule no-progress loop: ${state.no_progress_reads} read-only calls since the last mutation. ` +
            "Reuse prior evidence/capsules or a diff; make the next executable change, run the decisive check, or state the blocker.";
      }
    }
  }
  if (isMutationTool(normalized) && Number(state.mutation_count || 0) >= 1 &&
      !explicitEfficiencyOverride(input)) {
    guidance = [guidance,
      "Capsule edit batch: another mutation already succeeded in this task; group remaining file changes " +
      "in one transaction/patch and run one decisive verification instead of opening another small edit loop."]
      .filter(Boolean).join("\n");
  }
  const budget = advisorEnabled ? (state.task_budget || {}) : {};
  const maxCalls = Number(budget.max_calls || 0);
  const readLike = isReadOnlyTool(normalized) || isReadOnlyCapsule(input, normalized) ||
    isPollTool(normalized) || isPlanningTool(normalized) ||
    isObservationalShell(input, normalized) || isObservationalNodeRepl(input) ||
    isSpawnTool(normalized);
  if (state.task_id && maxCalls > 0 && state.tool_calls === Math.ceil(maxCalls * 0.5)) {
    guidance = [guidance,
      `Capsule advisor: ${state.tool_calls}/${maxCalls} task tool calls used. ` +
      "Batch remaining observations, group edits, and reserve one verification call."]
      .filter(Boolean).join("\n");
  }
  if (!blockReason && state.task_id && maxCalls > 0 && state.tool_calls > maxCalls && readLike &&
      !explicitEfficiencyOverride(input)) {
    blockReason = `[Capsule tool budget: ${state.tool_calls - 1}/${maxCalls} calls already spent for this task; ` +
      "read-only/planning call withheld. Reuse visible capsules, make the grouped change, verify once, " +
      "or set capsule_force=true for an indispensable observation.]";
  }
  const cycleGuidance = sequenceCycleGuidance(input, normalized, state);
  const retryGuidance = failurePreflight(input, normalized);
  guidance = [guidance, cycleGuidance, retryGuidance].filter(Boolean).join("\n").slice(0, 1_200);
  state.last_tool = normalized.slice(0, 160);
  state.last_paths = paths;
  state.updated_at = Date.now();
  writeHookState(file, state);
  return {
    guidance,
    pollCount: Number(state.poll_count || 0),
    blockReason,
  };
}

function noteToolResult(input, toolName) {
  const normalized = String(toolName || "").toLowerCase();
  const file = hashedHookStateFile(input, "execution-progress");
  const state = readHookState(file, executionStateFallback());
  const evidenceIdentity = stableEvidenceIdentity(input, normalized);
  if (evidenceIdentity && !isFailedToolResult(input)) {
    const successfulEvidence = state.successful_evidence || {};
    successfulEvidence[evidenceIdentity] = {
      epoch: Number(state.epoch || 0),
      output_chars: toolOutput(input).length,
      at: Date.now(),
    };
    state.successful_evidence = Object.fromEntries(
      Object.entries(successfulEvidence)
        .sort((left, right) => Number(right[1].at || 0) - Number(left[1].at || 0))
        .slice(0, 64)
    );
  }
  if (!isFailedToolResult(input) && (isMutationTool(normalized) || isNodeReplMutation(input))) {
    state.epoch = Number(state.epoch || 0) + 1;
    state.no_progress_reads = 0;
    state.plan_count = 0;
    state.same_plan_count = 0;
    state.last_plan_fingerprint = "";
    state.last_plan_epoch = Number(state.epoch || 0);
    state.spawn_count = 0;
    state.sequence = [];
    state.sequence_warnings = [];
    state.repeated_read_count = 0;
    state.last_read_fingerprint = "";
    state.last_read_epoch = Number(state.epoch || 0);
    state.context_interest_tokens = 0;
    state.context_interest_tier = 0;
    state.mutation_count = Number(state.mutation_count || 0) + 1;
    state.changed = [...new Set([...(state.changed || []), ...toolPaths(input)])].slice(-8);
  }
  const command = firstString(input.tool_input || input.toolInput || {}, ["command"]);
  if (/\b(?:test|pytest|jest|vitest|lint|build|check)\b/i.test(`${normalized} ${command}`)) {
    const output = toolOutput(input);
    const outcome = isFailedToolResult(input, output) || /\b(?:failed|failure|error)\b/i.test(output) ? "fail" : "pass";
    state.tests = [...(state.tests || []), {
      tool: normalized.slice(-80),
      outcome,
      at: Date.now(),
    }].slice(-3);
  }
  state.updated_at = Date.now();
  writeHookState(file, state);
}

function executionCheckpoint(input) {
  const state = readHookState(hashedHookStateFile(input, "execution-progress"), {});
  if (!state.updated_at) return "";
  const reads = Object.entries(state.reads || {})
    .sort((left, right) => Number(right[1].at || 0) - Number(left[1].at || 0))
    .slice(0, 4)
    .map(([file, item]) => `${file}x${Number(item.count || 0)}`)
    .join(",");
  const changed = (state.changed || []).slice(-4).join(",");
  const tests = (state.tests || []).slice(-2).map((item) => `${item.tool}:${item.outcome}`).join(",");
  const residual = reasoningResidual.checkpoint(explicitSessionId(input));
  return [
    `epoch=${Number(state.epoch || 0)}`,
    reads ? `inspected=${reads}` : "",
    changed ? `changed=${changed}` : "",
    tests ? `tests=${tests}` : "",
    residual ? `residual=${residual}` : "",
    state.last_tool ? `last=${state.last_tool}` : "",
    Number(state.no_progress_reads || 0) ? `reads_since_progress=${state.no_progress_reads}` : "",
    Number(state.plan_count || 0) ? `plans_since_progress=${state.plan_count}` : "",
    Number(state.spawn_count || 0) ? `subagents_since_progress=${state.spawn_count}` : "",
    Number(state.context_interest_tokens || 0)
      ? `context_interest≈${state.context_interest_tokens} weighted_tokens`
      : "",
  ].filter(Boolean).join("; ").slice(0, 360);
}

function executionEpoch(input) {
  return Number(readHookState(
    hashedHookStateFile(input, "execution-progress"),
    { epoch: 0 }
  ).epoch || 0);
}

function rawToolOutput(input) {
  return input.tool_response ?? input.toolResponse ??
    input.tool_output ?? input.toolOutput ?? input.output ?? input.result;
}

function postToolReplacement(replacement, additionalContext = "") {
  const reason = String(replacement || "").trim();
  if (!reason) return {};
  if (process.env.CAPSULE_HOOK_WIRE === "0") return {};
  return {
    continue: false,
    stopReason: "Capsule replaced the completed tool result with a compact exact-recoverable form.",
    reason,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      ...(additionalContext ? { additionalContext } : {}),
    },
  };
}

function recordHookHistory(event = {}) {
  compat.recordHistory({
    ...event,
    effective: process.env.CAPSULE_HOOK_WIRE !== "0",
    delivery_contract: process.env.CAPSULE_HOOK_WIRE === "0"
      ? "benchmark-control-passthrough"
      : "codex-posttool-continue-false-v1",
  });
}

function containsMedia(value, state = { seen: new Set(), nodes: 0 }) {
  state.nodes += 1;
  if (state.nodes > 1_000 || value == null) return false;
  if (typeof value === "string") return /data:(?:image|audio|video)\//i.test(value);
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return true;
  if (typeof value !== "object" || state.seen.has(value)) return false;
  state.seen.add(value);
  const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
  if (["image", "image_url", "audio", "audio_url", "video", "video_url"].includes(type)) return true;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:image|audio|video)(?:_url|Url|_bytes|Bytes)?$/i.test(key)) return true;
    if (containsMedia(child, state)) return true;
  }
  return false;
}

function explicitSessionId(input) {
  return firstString(input, ["session_id", "sessionId", "conversation_id", "thread_id"]);
}

function mediaReplayFile(input) {
  const id = explicitSessionId(input);
  if (!id) return "";
  const sessionHash = crypto.createHash("sha256").update(id).digest("hex").slice(0, 20);
  const root = path.join(hookRoot(), "media-replays");
  fs.mkdirSync(root, { recursive: true });
  return path.join(root, `${sessionHash}.json`);
}

function mediaFingerprint(value) {
  const hash = crypto.createHash("sha256");
  const state = { seen: new Set(), nodes: 0, parts: 0, rawChars: 0 };
  const dataUrl = /data:(?:image|audio|video)\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*;base64,[a-z0-9+/=_-]+/gi;

  function add(label, content) {
    state.parts += 1;
    state.rawChars += typeof content === "string" ? content.length : content.byteLength;
    hash.update(`\0${label}\0`);
    hash.update(content);
  }

  function visit(node, mediaHint = false, label = "root") {
    state.nodes += 1;
    if (state.nodes > 5_000 || node == null) return;
    if (typeof node === "string") {
      let matchedDataUrl = false;
      let match;
      dataUrl.lastIndex = 0;
      while ((match = dataUrl.exec(node)) !== null) {
        matchedDataUrl = true;
        add(label, match[0]);
      }
      if (mediaHint && !matchedDataUrl && node.length >= 32) add(label, node);
      return;
    }
    if (Buffer.isBuffer(node)) {
      add(label, node);
      return;
    }
    if (ArrayBuffer.isView(node)) {
      add(label, Buffer.from(node.buffer, node.byteOffset, node.byteLength));
      return;
    }
    if (typeof node !== "object" || state.seen.has(node)) return;
    state.seen.add(node);
    const type = typeof node.type === "string" ? node.type.toLowerCase() : "";
    const mime = firstString(node, ["mimeType", "mime_type", "media_type"]).toLowerCase();
    const localMediaHint = mediaHint ||
      /^(?:image|image_url|audio|audio_url|video|video_url)$/.test(type) ||
      /^(?:image|audio|video)\//.test(mime);
    for (const [key, child] of Object.entries(node)) {
      const childHint = localMediaHint &&
        /^(?:data|base64|bytes|image|image_url|audio|audio_url|video|video_url)$/i.test(key);
      visit(child, childHint, `${label}.${key}`);
    }
  }

  visit(value);
  if (!state.parts) return null;
  return {
    digest: hash.digest("hex"),
    rawChars: state.rawChars,
    parts: state.parts,
  };
}

function exactOutputFingerprint(value) {
  try {
    if (typeof value === "string") {
      return crypto.createHash("sha256").update(value).digest("hex");
    }
    if (Buffer.isBuffer(value)) {
      return crypto.createHash("sha256").update(value).digest("hex");
    }
    if (ArrayBuffer.isView(value)) {
      return crypto.createHash("sha256")
        .update(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
        .digest("hex");
    }
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") return "";
    return crypto.createHash("sha256").update(serialized).digest("hex");
  } catch {
    return "";
  }
}

function mediaReplay(input, toolName, rawOutput) {
  if (process.env.CAPSULE_MEDIA_DEDUPE === "0") return { duplicate: false };
  const normalized = String(toolName || "").trim().toLowerCase();
  if (!/(?:view[_ -]?image|image[_ -]?view|screenshot)/.test(normalized) &&
      !isBrowserTool(normalized)) {
    return { duplicate: false };
  }
  const file = mediaReplayFile(input);
  if (!file) return { duplicate: false };
  const fingerprint = mediaFingerprint(rawOutput);
  if (!fingerprint) return { duplicate: false };
  const exactDigest = exactOutputFingerprint(rawOutput);
  if (!exactDigest) return { duplicate: false };
  const toolInput = input.tool_input || input.toolInput || {};
  const detail = typeof toolInput.detail === "string" && toolInput.detail
    ? toolInput.detail.toLowerCase()
    : "high";
  const variant = `${normalized}:${detail}`;
  let serializedInput;
  try {
    serializedInput = JSON.stringify(toolInput);
  } catch {
    return { duplicate: false };
  }
  const requestHash = crypto.createHash("sha256")
    .update(`${normalized}\0${serializedInput}`)
    .digest("hex")
    .slice(0, 24);
  try {
    let state = { entries: {} };
    try {
      state = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      state = { entries: {} };
    }
    if (!state || typeof state !== "object" || typeof state.entries !== "object") {
      state = { entries: {} };
    }
    const now = Date.now();
    const lifetime = 10 * 60_000;
    const duplicate = Object.values(state.entries).some((item) =>
      item.variant === variant &&
      item.digest === fingerprint.digest &&
      item.exact_digest === exactDigest &&
      now - Number(item.at || 0) <= lifetime
    );
    const entries = Object.fromEntries(
      Object.entries(state.entries)
        .filter(([, item]) => now - Number(item.at || 0) <= lifetime)
        .sort((left, right) => Number(right[1].at || 0) - Number(left[1].at || 0))
        .slice(0, 31)
    );
    entries[requestHash] = {
      digest: fingerprint.digest,
      exact_digest: exactDigest,
      variant,
      raw_chars: fingerprint.rawChars,
      parts: fingerprint.parts,
      at: now,
    };
    const temporary = `${file}.${process.pid}.${now}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ entries })}\n`, "utf8");
    fs.renameSync(temporary, file);
    return { duplicate: Boolean(duplicate), ...fingerprint };
  } catch {
    return { duplicate: false };
  }
}

function clearMediaReplay(input) {
  const file = mediaReplayFile(input);
  if (!file) return;
  try {
    const now = Date.now();
    const temporary = `${file}.${process.pid}.${now}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ entries: {} })}\n`, "utf8");
    fs.renameSync(temporary, file);
  } catch {
    // Media optimization is best-effort and must never block a task.
  }
}

function isReadOnlyTool(toolName) {
  const normalized = String(toolName || "").trim().toLowerCase();
  if (!normalized ||
      /(?:capsule|write|edit|delete|remove|create|send|update|apply|execute|shell|command)/.test(normalized)) {
    return false;
  }
  const words = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const readOnlyWords = new Set([
    "read", "view", "list", "search", "find", "get", "open", "stat", "stats",
    "doctor", "insight", "screenshot", "expand", "diff", "snapshot", "wait",
  ]);
  return words.some((word) => readOnlyWords.has(word));
}

function isReadOnlyCapsule(input, toolName) {
  const normalized = String(toolName || "").trim().toLowerCase();
  if (!/capsule/.test(normalized)) return false;
  const toolInput = input.tool_input || input.toolInput || {};
  return /^(?:expand|file|search|stats|gain|insight|doctor|discover|list|diff|skills|telemetry|ledger)$/.test(
    String(toolInput.action || "").trim().toLowerCase()
  );
}

function isReplayEligibleTool(input, toolName) {
  if (isReadOnlyTool(toolName)) return true;
  const normalized = String(toolName || "").trim().toLowerCase();
  const highRiskMutation = /\b(?:apply[_ -]?patch|write[_ -]?file|delete|remove|move|rename|send|deploy|publish|commit|push|archive|trash|label|update|create|install|uninstall|set[_ -]?content|out[_ -]?file|add[_ -]?content|copy[_ -]?item)\b/i;
  if (isShellToolName(normalized)) {
    const { command } = shellCommand(input);
    return Boolean(command) && !highRiskMutation.test(command);
  }
  if (/(?:^|[._-])exec$|node[_ -]?repl/.test(normalized)) {
    try {
      const serialized = JSON.stringify(input.tool_input || input.toolInput || {});
      return !highRiskMutation.test(serialized);
    } catch {
      return false;
    }
  }
  return false;
}

function normalizeDeltaLine(value) {
  return String(value || "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>")
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<time>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|msec|milliseconds?|s|sec|seconds?)\b/gi, "<duration>")
    .replace(/[ \t]+$/g, "");
}

function boundedDeltaLines(lines, limit = 8) {
  const unique = [...new Set(lines.filter((line) => String(line).trim()))];
  const important = unique.filter((line) =>
    /\b(?:error|fail(?:ed|ure)?|exception|panic|warning|changed|added|removed|pass(?:ed)?|success)\b/i.test(line)
  );
  const selected = [...important, ...unique].filter((line, index, all) => all.indexOf(line) === index);
  return selected.slice(0, limit);
}

function nearDuplicateDelta(beforeText, afterText, beforeId, afterId) {
  const configuredMinimum = Number(process.env.CAPSULE_DELTA_CHARS);
  const minimumChars = Number.isFinite(configuredMinimum)
    ? Math.min(50_000, Math.max(1_000, Math.trunc(configuredMinimum)))
    : 3_000;
  if (beforeText.length < minimumChars || afterText.length < minimumChars ||
      beforeText.length > 2_000_000 || afterText.length > 2_000_000) {
    return null;
  }
  const beforeLines = beforeText.replace(/\r\n/g, "\n").split("\n");
  const afterLines = afterText.replace(/\r\n/g, "\n").split("\n");
  if (beforeLines.length > 20_000 || afterLines.length > 20_000) return null;
  const beforeNormalized = beforeLines.map(normalizeDeltaLine);
  const afterNormalized = afterLines.map(normalizeDeltaLine);
  const beforeCounts = new Map();
  const afterCounts = new Map();
  for (const line of beforeNormalized) beforeCounts.set(line, Number(beforeCounts.get(line) || 0) + 1);
  for (const line of afterNormalized) afterCounts.set(line, Number(afterCounts.get(line) || 0) + 1);
  let intersection = 0;
  for (const [line, count] of beforeCounts) {
    intersection += Math.min(count, Number(afterCounts.get(line) || 0));
  }
  const overlap = (2 * intersection) / Math.max(1, beforeLines.length + afterLines.length);
  const configuredSimilarity = Number(process.env.CAPSULE_DELTA_SIMILARITY);
  const threshold = Number.isFinite(configuredSimilarity)
    ? Math.min(0.98, Math.max(0.6, configuredSimilarity))
    : 0.78;
  if (overlap < threshold) return null;

  const remainingBefore = new Map(beforeCounts);
  const added = [];
  for (let index = 0; index < afterNormalized.length; index += 1) {
    const line = afterNormalized[index];
    const count = Number(remainingBefore.get(line) || 0);
    if (count > 0) remainingBefore.set(line, count - 1);
    else added.push(afterLines[index]);
  }
  const remainingAfter = new Map(afterCounts);
  const removed = [];
  for (let index = 0; index < beforeNormalized.length; index += 1) {
    const line = beforeNormalized[index];
    const count = Number(remainingAfter.get(line) || 0);
    if (count > 0) remainingAfter.set(line, count - 1);
    else removed.push(beforeLines[index]);
  }
  const body = [];
  for (const line of boundedDeltaLines(removed)) body.push(`- ${line}`);
  for (const line of boundedDeltaLines(added)) body.push(`+ ${line}`);
  if (!body.length) body.push("~ stable content; only volatile timestamp/duration/format fields changed");
  const header = `[Capsule delta overlap=${(overlap * 100).toFixed(1)}%; before=${beforeId}; exact=${afterId}; raw=${afterText.length}]`;
  const replacement = sanitizeAutomaticMemory(`${header}\n${body.join("\n")}`).slice(0, 1_600);
  if (replacement.length + 160 >= afterText.length) return null;
  return {
    replacement,
    overlap: Number(overlap.toFixed(4)),
    added: added.length,
    removed: removed.length,
  };
}

function failureReplayFile(input) {
  const id = explicitSessionId(input);
  if (!id) return "";
  const sessionHash = crypto.createHash("sha256").update(id).digest("hex").slice(0, 20);
  const root = path.join(hookRoot(), "failure-replays");
  return path.join(root, `${sessionHash}.json`);
}

function failureRequestHash(input, toolName) {
  try {
    const serialized = JSON.stringify(input.tool_input || input.toolInput || {});
    return crypto.createHash("sha256")
      .update(`${String(toolName || "").trim().toLowerCase()}\0${serialized}`)
      .digest("hex")
      .slice(0, 24);
  } catch {
    return "";
  }
}

function failureHeadline(output) {
  const lines = String(output || "").split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const signal = lines.find((line) =>
    /\b(?:error|exception|failed|failure|fatal|panic|timeout|traceback|exit code\s*[:=]?\s*[1-9])\b/i.test(line)
  );
  return sanitizeAutomaticMemory(signal || lines[0] || "Repeated tool failure")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 360);
}

function failurePreflight(input, toolName) {
  if (process.env.CAPSULE_FAILURE_FUSE === "0") return "";
  const file = failureReplayFile(input);
  const requestHash = failureRequestHash(input, toolName);
  if (!file || !requestHash || !fs.existsSync(file)) return "";
  try {
    const state = readHookState(file, { entries: {} });
    const prior = state.entries?.[requestHash];
    if (!prior || Date.now() - Number(prior.at || 0) > 10 * 60_000) return "";
    return `[Capsule retry fuse: unchanged ${toolName || "tool"} input failed x${Number(prior.count || 1)}; ` +
      `vary input/state${prior.capsule_id ? `; exact=${prior.capsule_id}` : ""}]`;
  } catch {
    return "";
  }
}

function failureReplay(input, toolName, output) {
  if (process.env.CAPSULE_FAILURE_FUSE === "0") return { duplicate: false };
  const file = failureReplayFile(input);
  const requestHash = failureRequestHash(input, toolName);
  if (!file || !requestHash) return { duplicate: false };
  const failed = isFailedToolResult(input, output);
  if (!failed && !fs.existsSync(file)) return { duplicate: false };
  try {
    if (failed) fs.mkdirSync(path.dirname(file), { recursive: true });
    const now = Date.now();
    const lifetime = 10 * 60_000;
    const state = readHookState(file, { entries: {} });
    const entries = Object.fromEntries(
      Object.entries(state.entries || {})
        .filter(([, item]) => now - Number(item.at || 0) <= lifetime)
        .sort((left, right) => Number(right[1].at || 0) - Number(left[1].at || 0))
        .slice(0, 31)
    );
    const prior = entries[requestHash];
    if (!failed || !output) {
      if (prior) {
        delete entries[requestHash];
        writeHookState(file, { entries });
      }
      return { duplicate: false };
    }

    const digest = crypto.createHash("sha256").update(output).digest("hex");
    const duplicate = Boolean(
      prior &&
      prior.digest === digest &&
      now - Number(prior.at || 0) <= lifetime
    );
    let capsuleId = duplicate ? String(prior.capsule_id || "") : "";
    if (!capsuleId && output.length >= 512) {
      capsuleId = core.saveCapsule({
        kind: "hook-tool-error",
        source: String(toolName || "tool-error"),
        text: output,
        question: firstString(input, ["intent", "query"]),
        maxChars: 1_200,
        details: { session_id: sessionId(input), project_dir: projectDir(input) },
      }).response.capsule_id;
    }
    const count = duplicate ? Number(prior.count || 1) + 1 : 1;
    const headline = duplicate ? String(prior.headline || failureHeadline(output)) : failureHeadline(output);
    entries[requestHash] = {
      tool: String(toolName || "").trim().toLowerCase(),
      digest,
      count,
      raw_chars: output.length,
      headline,
      at: now,
      ...(capsuleId ? { capsule_id: capsuleId } : {}),
    };
    writeHookState(file, { entries });
    const replacement = duplicate && capsuleId
      ? sanitizeAutomaticMemory(
        `[Capsule repeated failure x${count}; unchanged; exact=${capsuleId}]\n${headline}\n` +
        "Retry only after input/state changes."
      ).slice(0, 720)
      : "";
    return {
      duplicate: Boolean(replacement && replacement.length + 100 < output.length),
      replacement,
      rawChars: output.length,
      capsuleId,
      count,
    };
  } catch {
    return { duplicate: false };
  }
}

function textReplayFile(input) {
  const id = explicitSessionId(input);
  if (!id) return "";
  const sessionHash = crypto.createHash("sha256").update(id).digest("hex").slice(0, 20);
  const root = path.join(hookRoot(), "text-replays");
  fs.mkdirSync(root, { recursive: true });
  return path.join(root, `${sessionHash}.json`);
}

function textReplay(input, toolName, output) {
  const poll = isPollTool(toolName) &&
    process.env.CAPSULE_POLL_REPLAY !== "0" &&
    isQuietPollOutput(output);
  const minimumChars = poll ? 32 : 512;
  if (process.env.CAPSULE_TEXT_DEDUPE === "0" ||
      !isReplayEligibleTool(input, toolName) || output.length < minimumChars || isFailedToolResult(input, output)) {
    return { duplicate: false };
  }
  const file = textReplayFile(input);
  if (!file) return { duplicate: false };
  const normalized = String(toolName || "").trim().toLowerCase();
  const digest = crypto.createHash("sha256").update(output).digest("hex");
  let serializedInput;
  try {
    serializedInput = JSON.stringify(input.tool_input || input.toolInput || {});
  } catch {
    return { duplicate: false };
  }
  const requestHash = crypto.createHash("sha256")
    .update(`${normalized}\0${serializedInput}`)
    .digest("hex")
    .slice(0, 24);
  try {
    let state = { entries: {} };
    try {
      state = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      state = { entries: {} };
    }
    if (!state || typeof state !== "object" || typeof state.entries !== "object") {
      state = { entries: {} };
    }
    const now = Date.now();
    const shortLifetime = 10 * 60_000;
    const capsuleLifetime = 60 * 60_000;
    const lifetimeFor = (item) => item.capsule_id ? capsuleLifetime : shortLifetime;
    const priorRequest = state.entries[requestHash];
    const matching = poll
      ? priorRequest?.digest === digest &&
        now - Number(priorRequest.at || 0) <= lifetimeFor(priorRequest)
        ? priorRequest
        : null
      : Object.values(state.entries).find((item) =>
        item.digest === digest &&
        now - Number(item.at || 0) <= lifetimeFor(item)
      );
    let capsuleId = matching?.capsule_id || "";
    const configuredThreshold = Number(process.env.CAPSULE_REPLAY_CAPSULE_CHARS);
    const capsuleThreshold = Number.isFinite(configuredThreshold)
      ? Math.min(20_000, Math.max(512, Math.trunc(configuredThreshold)))
      : 3_000;
    if (!capsuleId && output.length >= capsuleThreshold) {
      capsuleId = core.saveCapsule({
        kind: "hook-tool-output",
        source: normalized || "read-only-tool",
        text: output,
        question: firstString(input, ["intent", "query"]),
        maxChars: 1_200,
        details: { session_id: sessionId(input), project_dir: projectDir(input) },
      }).response.capsule_id;
    }
    let delta = null;
    if (!matching && capsuleId && priorRequest?.capsule_id && priorRequest.digest !== digest &&
        now - Number(priorRequest.at || 0) <= capsuleLifetime) {
      try {
        const before = core.loadCapsule(priorRequest.capsule_id);
        delta = nearDuplicateDelta(before.text, output, priorRequest.capsule_id, capsuleId);
      } catch {
        delta = null;
      }
    }
    const generation = Number(state.generation || 0);
    const entries = Object.fromEntries(
      Object.entries(state.entries)
        .filter(([, item]) => now - Number(item.at || 0) <= lifetimeFor(item))
        .sort((left, right) => Number(right[1].at || 0) - Number(left[1].at || 0))
        .slice(0, 63)
    );
    entries[requestHash] = {
      tool: normalized,
      digest,
      raw_chars: output.length,
      at: now,
      generation,
      ...(capsuleId ? { capsule_id: capsuleId } : {}),
    };
    const temporary = `${file}.${process.pid}.${now}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ generation, entries })}\n`, "utf8");
    fs.renameSync(temporary, file);
    return {
      duplicate: Boolean(matching),
      rawChars: output.length,
      capsuleId,
      delta,
      poll,
      afterCompaction: Boolean(matching && Number(matching.generation || 0) < generation),
    };
  } catch {
    return { duplicate: false };
  }
}

function clearTextReplay(input) {
  const file = textReplayFile(input);
  if (!file) return;
  try {
    const now = Date.now();
    const temporary = `${file}.${process.pid}.${now}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ entries: {} })}\n`, "utf8");
    fs.renameSync(temporary, file);
  } catch {
    // Text replay optimization is best-effort and must never block a task.
  }
}

function markTextReplayCompaction(input) {
  const file = textReplayFile(input);
  if (!file) return { capsuleIds: [] };
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    const now = Date.now();
    const generation = Number(state?.generation || 0) + 1;
    const entries = Object.fromEntries(
      Object.entries(state?.entries || {})
        .filter(([, item]) => item?.capsule_id && now - Number(item.at || 0) <= 60 * 60_000)
        .sort((left, right) => Number(right[1].at || 0) - Number(left[1].at || 0))
        .slice(0, 63)
    );
    const temporary = `${file}.${process.pid}.${now}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ generation, entries, compacted_at: now })}\n`, "utf8");
    fs.renameSync(temporary, file);
    return { capsuleIds: [...new Set(Object.values(entries).map((item) => item.capsule_id))] };
  } catch {
    return { capsuleIds: [] };
  }
}

function toolOutput(input) {
  const value = rawToolOutput(input);
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isStructuredWebTool(toolName) {
  const normalized = String(toolName || "").trim().toLowerCase();
  return /(?:^|[._-])web(?:$|[._-])/.test(normalized) &&
    /(?:run|search|open|query|fetch|web)/.test(normalized);
}

function collectWebQueryStrings(value, output, key = "", depth = 0, seen = new WeakSet()) {
  if (depth > 10 || output.length >= 64) return;
  if (typeof value === "string") {
    if (/^(?:q|query|queries|search_query|search_queries|prompt|intent)$/i.test(key)) {
      output.push(value.slice(0, 4_000));
    }
    return;
  }
  if (value == null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectWebQueryStrings(item, output, key, depth + 1, seen);
  } else {
    for (const [childKey, child] of Object.entries(value)) {
      collectWebQueryStrings(child, output, childKey, depth + 1, seen);
    }
  }
  seen.delete(value);
}

function webQueryTerms(input) {
  const toolInput = input.tool_input || input.toolInput || {};
  const queries = [];
  collectWebQueryStrings({
    intent: input.intent,
    query: input.query,
    prompt: input.prompt,
    tool_input: toolInput,
  }, queries);
  const query = queries.join(" ").toLowerCase();
  return [...new Set(query.match(/[\p{L}\p{N}_-]{3,}/gu) || [])].slice(0, 24);
}

function trimWebUrl(value) {
  let token = String(value || "").replace(/[.,;!?]+$/u, "");
  for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
    while (token.endsWith(close) &&
      token.split(close).length - 1 > token.split(open).length - 1) {
      token = token.slice(0, -1);
    }
  }
  return token;
}

function embeddedWebNavigation(value) {
  const text = String(value || "");
  const found = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`\\]+/giu)) {
    const token = trimWebUrl(match[0]);
    if (token) found.push(token);
  }
  for (const match of text.matchAll(/\bturn\d+[a-z][a-z0-9_-]*\d+\b/giu)) {
    found.push(match[0]);
  }
  return [...new Set(found)];
}

function isWebIdentityField(key) {
  return /^(?:url|uri|href|link|source_url|canonical_url|display_url|ref_id|refid|reference_id|referenceid|id|type|title|source)$/i.test(String(key));
}

function addWebFidelity(inventory, kind, value) {
  if (inventory.overflow || value === undefined) return;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return;
  const signature = `${kind}\0${typeof value}\0${encoded}`;
  if (inventory.seen.has(signature)) return;
  const nextChars = inventory.chars + encoded.length;
  if (inventory.items + 1 > 256 || nextChars > 24_000) {
    inventory.overflow = true;
    return;
  }
  inventory.seen.add(signature);
  inventory.items += 1;
  inventory.chars = nextChars;
  inventory[kind].push(value);
}

function collectWebFidelity(value, inventory, key = "", seen = new WeakSet()) {
  if (value == null || typeof value !== "object") {
    if (isWebIdentityField(key)) addWebFidelity(inventory, "identity", value);
    if (typeof value === "string" && !isWebIdentityField(key)) {
      for (const token of embeddedWebNavigation(value)) {
        addWebFidelity(inventory, "navigation", token);
      }
    }
    return;
  }
  if (seen.has(value)) {
    inventory.overflow = true;
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectWebFidelity(item, inventory, key, seen);
  } else {
    for (const [childKey, child] of Object.entries(value)) {
      collectWebFidelity(child, inventory, childKey, seen);
    }
  }
  seen.delete(value);
}

function relevantWebLine(line, terms, limit = 180) {
  const lower = line.toLowerCase();
  let index = -1;
  for (const term of terms) {
    const candidate = lower.indexOf(term);
    if (candidate >= 0 && (index < 0 || candidate < index)) index = candidate;
  }
  if (index < 0) return "";
  const start = Math.max(0, index - Math.floor(limit * 0.3));
  return line.slice(start, start + limit);
}

function boundedWebText(value, terms, limit = 720) {
  const text = String(value || "");
  if (text.length <= limit) return { value: text, omitted: 0 };
  const relevant = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const snippet = relevantWebLine(line, terms);
    if (snippet) {
      relevant.push(snippet);
      if (relevant.length >= 6) break;
    }
  }
  let marker = `[Capsule web text truncated; omitted=${Math.max(1, text.length - limit)}]`;
  let head = "";
  let middle = "";
  let tail = "";
  let omitted = text.length;
  for (let pass = 0; pass < 2; pass += 1) {
    const separators = relevant.length ? 3 : 2;
    const available = Math.max(0, limit - marker.length - separators);
    const middleLimit = relevant.length ? Math.floor(available * 0.25) : 0;
    const headLimit = Math.floor((available - middleLimit) * 0.62);
    const tailLimit = Math.max(0, available - middleLimit - headLimit);
    head = text.slice(0, headLimit);
    middle = relevant.join("\n").slice(0, middleLimit);
    tail = text.slice(-tailLimit);
    omitted = Math.max(0, text.length - head.length - middle.length - tail.length);
    marker = `[Capsule web text truncated; omitted=${omitted}]`;
  }
  const projected = [head, marker, ...(middle ? [middle] : []), tail].join("\n");
  return { value: projected, omitted };
}

function projectStructuredWebValue(value, terms, state, limit, key = "", seen = new WeakSet()) {
  if (typeof value === "string") {
    if (isWebIdentityField(key)) return value;
    const bounded = boundedWebText(value, terms, limit);
    if (bounded.omitted) {
      state.truncated_fields += 1;
      state.omitted_chars += bounded.omitted;
      for (const token of embeddedWebNavigation(value)) state.navigation.add(token);
    }
    return bounded.value;
  }
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Capsule circular reference omitted]";
  seen.add(value);
  let projected;
  if (Array.isArray(value)) {
    projected = value.map((item) =>
      projectStructuredWebValue(item, terms, state, limit, key, seen));
  } else {
    projected = Object.create(null);
    for (const [childKey, child] of Object.entries(value)) {
      projected[childKey] = projectStructuredWebValue(child, terms, state, limit, childKey, seen);
    }
  }
  seen.delete(value);
  return projected;
}

function structuredWebLeafLimits(exactChars) {
  if (exactChars >= 96_000) return [220];
  if (exactChars >= 32_000) return [420, 220];
  return [720, 420, 220];
}

function matchingExactCapsule(capsuleId, exact) {
  if (!capsuleId) return "";
  try {
    return core.loadCapsule(capsuleId).text === exact ? capsuleId : "";
  } catch {
    return "";
  }
}

function structuredWebProjection(rawOutput, input, toolName, existingCapsuleId = "") {
  if (process.env.CAPSULE_WEB_PROJECTION === "0" ||
      !isStructuredWebTool(toolName) ||
      !rawOutput || typeof rawOutput !== "object" ||
      containsMedia(rawOutput)) {
    return "";
  }
  let exact;
  let canonical;
  try {
    exact = JSON.stringify(rawOutput, null, 2);
    canonical = JSON.parse(exact);
  } catch {
    return "";
  }
  if (exact.length < 4_000 || exact.length > 2_000_000) return "";
  const fidelity = {
    identity: [],
    navigation: [],
    seen: new Set(),
    items: 0,
    chars: 0,
    overflow: false,
  };
  collectWebFidelity(canonical, fidelity);
  if (fidelity.overflow) return "";

  const terms = webQueryTerms(input);
  const requiredSaving = Math.max(512, Math.ceil(exact.length * 0.05));
  const placeholderCapsuleId = "cap_0000000000000000";
  let selected = null;
  for (const leafChars of structuredWebLeafLimits(exact.length)) {
    const state = { truncated_fields: 0, omitted_chars: 0, navigation: new Set() };
    const projected = projectStructuredWebValue(canonical, terms, state, leafChars);
    const render = (capsuleId) => JSON.stringify({
      capsule_web_projection: {
        version: 1,
        raw_chars: exact.length,
        leaf_chars: leafChars,
        truncated_fields: state.truncated_fields,
        omitted_chars: state.omitted_chars,
        fidelity_items: fidelity.items,
        ...(state.navigation.size ? { navigation: [...state.navigation] } : {}),
        exact: capsuleId,
      },
      result: projected,
    });
    const candidate = render(placeholderCapsuleId);
    if (candidate.length <= 12_000 && candidate.length + requiredSaving <= exact.length) {
      selected = { render };
      break;
    }
  }
  if (!selected) return "";

  let capsuleId = matchingExactCapsule(existingCapsuleId, exact);
  if (!capsuleId) {
    try {
      capsuleId = core.saveCapsule({
        kind: "structured-web-result",
        source: toolName || "web",
        text: exact,
        question: terms.join(" "),
        maxChars: 1_200,
        details: { session_id: sessionId(input), project_dir: projectDir(input) },
      }).response.capsule_id;
    } catch {
      return "";
    }
  }
  const rendered = selected.render(capsuleId);
  if (rendered.length > 12_000 || rendered.length + requiredSaving > exact.length) return "";
  return rendered;
}

function isBrowserTool(toolName) {
  const normalized = String(toolName || "").trim().toLowerCase();
  return Boolean(normalized) &&
    !/capsule/.test(normalized) &&
    /(?:^|[._-])(?:browser|chrome|playwright|cdp|computer[_-]?use)(?:$|[._-])/.test(normalized);
}

function browserStateProjection(output, input, toolName, existingCapsuleId = "") {
  if (process.env.CAPSULE_BROWSER_PROJECTION === "0" ||
      !isBrowserTool(toolName) ||
      isFailedToolResult(input, output) ||
      output.length < 4_000 ||
      output.length > 2_000_000) {
    return "";
  }

  let source = compat.redact(output);
  try {
    const parsed = JSON.parse(source);
    source = JSON.stringify(parsed, null, 2);
  } catch {
    // Accessibility trees, DOM text and logs are commonly plain text.
  }

  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 30_000) return "";
  const normalized = [];
  const counts = new Map();
  for (const raw of lines) {
    const line = raw.replace(/[ \t]+$/g, "");
    if (!line.trim()) continue;
    const key = line.trim();
    counts.set(key, Number(counts.get(key) || 0) + 1);
    if (counts.get(key) === 1) normalized.push(line);
  }

  const candidateLines = normalized.filter((line) => line.length <= 1_000);
  const select = (pattern, limit) => candidateLines.filter((line) => pattern.test(line)).slice(0, limit);
  const metadata = select(
    /\b(?:url|uri|title|page|tab|target|location|origin|viewport|frame|document|readyState)\b/i,
    18
  );
  const critical = select(
    /\b(?:error|exception|failed|failure|warning|alert|dialog|modal|blocked|denied|timeout|unhandled|console|network|request|response|status\s*[:=]?\s*[45]\d\d)\b/i,
    24
  );
  const stateful = select(
    /\b(?:focused|focusable|selected|checked|pressed|expanded|disabled|required|invalid|busy|current|active|value|placeholder)\b/i,
    24
  );
  const interactive = select(
    /\b(?:button|link|textbox|input|textarea|checkbox|radio|combobox|listbox|menuitem|option|slider|spinbutton|switch|tab|treeitem)\b/i,
    48
  );
  const structure = select(/\b(?:heading|main|navigation|banner|contentinfo|form|table|row|cell)\b/i, 18);
  const selected = [...new Set([
    ...metadata,
    ...critical,
    ...stateful,
    ...interactive,
    ...structure,
    ...candidateLines.slice(0, 4),
    ...candidateLines.slice(-4),
  ])];

  // A minified HTML/DOM snapshot may be one enormous line. Extract only
  // navigation and interactive evidence; the exact original remains local.
  if (selected.join("\n").length < 300 && source.length > 4_000) {
    const fragments = [];
    const fragmentPattern = /<(?:title|a|button|input|textarea|select|option|dialog|form|h[1-6])\b[^>]*>[^<]{0,240}|(?:https?:\/\/|\/)[^\s"'<>]{2,240}/gi;
    for (const match of source.matchAll(fragmentPattern)) {
      const value = match[0].replace(/\s+/g, " ").trim();
      if (value && !fragments.includes(value)) fragments.push(value);
      if (fragments.length >= 60) break;
    }
    selected.unshift(...fragments);
  }

  const roleCounts = new Map();
  for (const line of normalized) {
    const match = line.match(/\b(button|link|textbox|input|checkbox|radio|combobox|menuitem|option|dialog|heading|tab)\b/i);
    if (match) {
      const role = match[1].toLowerCase();
      roleCounts.set(role, Number(roleCounts.get(role) || 0) + 1);
    }
  }
  const roles = [...roleCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([role, count]) => `${role}:${count}`)
    .join(",");
  const repeated = [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  let capsuleId = existingCapsuleId;
  if (!capsuleId) {
    capsuleId = core.saveCapsule({
      kind: "browser-state",
      source: toolName || "browser",
      text: output,
      question: firstString(input, ["intent", "query"]),
      maxChars: 1_200,
      details: { session_id: sessionId(input), project_dir: projectDir(input) },
    }).response.capsule_id;
  }
  const header = `[Capsule browser-state raw=${output.length}; lines=${lines.length}; ` +
    `kept=${selected.length}; repeated=${repeated}${roles ? `; roles=${roles}` : ""}; exact=${capsuleId}]`;
  const replacement = sanitizeAutomaticMemory(`${header}\n${selected.join("\n")}`).slice(0, 6_000);
  return replacement.length + 240 < output.length ? replacement : "";
}

function pressureCircuit(output, capsuleId, pressure, maxChars, exactOutput = output) {
  const redacted = compat.redact(output);
  const lines = redacted.split(/\r?\n/).filter((line) => line.trim());
  const selected = [];
  for (const line of lines.filter((item) => /\b(?:error|failed|failure|exception|panic|warning)\b/i.test(item)).slice(0, 3)) {
    if (!selected.includes(line)) selected.push(line);
  }
  for (const line of [lines[0], lines.at(-1)]) {
    if (line && !selected.includes(line)) selected.push(line);
  }
  if (!selected.length && redacted) {
    selected.push(redacted.slice(0, 320), redacted.slice(-320));
  }
  const digest = crypto.createHash("sha256").update(exactOutput).digest("hex");
  const header = `[Capsule pressure circuit: ${pressure.mode}; raw_chars=${exactOutput.length}; ` +
    `sha256=${digest}; exact=${capsuleId}]`;
  const budget = Math.max(320, Math.min(1_200, Number(maxChars || 700)));
  const evidence = selected.join("\n").slice(0, Math.max(0, budget - header.length - 20));
  return `${header}${evidence ? `\nEvidence:\n${evidence}` : ""}`;
}

function boundedText(value, limit) {
  const text = String(value || "")
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 20))} …[truncated]`;
}

function messageText(item) {
  if (typeof item.text === "string") return item.text;
  if (typeof item.message === "string") return item.message;
  if (!Array.isArray(item.content)) return "";
  return item.content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function projectThread(threadResult) {
  if (!threadResult || typeof threadResult !== "object" ||
      !threadResult.thread || !Array.isArray(threadResult.turns)) {
    return "";
  }
  const lines = [
    "[Capsule thread projection: tool arguments and outputs omitted]",
    `Thread: ${boundedText(threadResult.thread.title || threadResult.thread.id || "untitled", 180)}`,
  ];
  const status = threadResult.thread.status?.type || threadResult.thread.status;
  if (status) lines.push(`Status: ${boundedText(status, 40)}`);
  if (threadResult.page?.hasMore) {
    lines.push(`Older turns available with cursor: ${boundedText(threadResult.page.nextCursor, 120)}`);
  }
  for (const turn of threadResult.turns.slice(0, 12)) {
    const users = [];
    const finals = [];
    const updates = [];
    const reasoning = [];
    const tools = new Map();
    let failed = 0;
    let compactions = 0;
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      if (item.type === "userMessage") users.push(messageText(item));
      if (item.type === "agentMessage") {
        if (item.phase === "final_answer") finals.push(messageText(item));
        else updates.push(messageText(item));
      }
      if (item.type === "reasoning") {
        const summaries = Array.isArray(item.summary) ? item.summary : [item.summary];
        for (const summary of summaries) {
          if (summary && !reasoning.includes(summary)) reasoning.push(String(summary));
        }
      }
      if (/toolcall$/i.test(String(item.type || ""))) {
        const name = [item.server, item.tool || item.name].filter(Boolean).join(".") || "tool";
        tools.set(name, Number(tools.get(name) || 0) + 1);
        if (item.status && item.status !== "completed") failed += 1;
      }
      if (/compaction/i.test(String(item.type || ""))) compactions += 1;
    }
    lines.push(`\nTurn ${boundedText(turn.id || "", 80)} (${boundedText(turn.status || "unknown", 30)})`);
    if (users.length) lines.push(`User: ${boundedText(users.join(" | "), 900)}`);
    if (reasoning.length) lines.push(`Reasoning: ${boundedText(reasoning.join("; "), 500)}`);
    if (tools.size) {
      const counts = [...tools.entries()].map(([name, count]) => `${name}×${count}`).join(", ");
      lines.push(`Tools: ${boundedText(counts, 700)}${failed ? `; non-completed=${failed}` : ""}`);
    }
    if (compactions) lines.push(`Compactions: ${compactions}`);
    if (updates.length) lines.push(`Latest update: ${boundedText(updates.at(-1), 500)}`);
    if (finals.length) lines.push(`Final: ${boundedText(finals.at(-1), 1_200)}`);
  }
  return boundedText(lines.join("\n"), 16_000);
}

function threadProjection(rawOutput, input, toolName) {
  if (process.env.CAPSULE_THREAD_PROJECTION === "0") return "";
  const normalized = String(toolName || "").toLowerCase();
  const toolInput = input.tool_input || input.toolInput || {};
  if (/read[_ -]?thread/.test(normalized) && toolInput.includeOutputs === true) return "";
  const projections = [];
  const seen = new Set();
  const state = { nodes: 0, objects: new Set() };

  function visit(value, depth = 0) {
    state.nodes += 1;
    if (state.nodes > 500 || depth > 8 || value == null) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length < 40 || !/^[{[]/.test(trimmed)) return;
      try {
        visit(JSON.parse(trimmed), depth + 1);
      } catch {
        // Most strings are ordinary tool output, not nested JSON.
      }
      return;
    }
    if (typeof value !== "object" || state.objects.has(value)) return;
    state.objects.add(value);
    const projected = projectThread(value);
    if (projected) {
      const key = `${value.thread?.id || ""}:${value.page?.nextCursor || ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        projections.push(projected);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    for (const key of ["result", "text", "content", "output", "data"]) {
      if (key in value) visit(value[key], depth + 1);
    }
  }

  visit(rawOutput);
  if (!projections.length) return "";
  return boundedText(projections.join("\n\n"), 20_000);
}

function shellCommand(input) {
  const toolInput = input.tool_input || input.toolInput || {};
  if (typeof toolInput.command === "string") return { toolInput, command: toolInput.command };
  return { toolInput, command: "" };
}

function isCodexTranscriptRead(input, toolName) {
  if (process.env.CAPSULE_TRANSCRIPT_SHIELD === "0" ||
      !isReplayEligibleTool(input, toolName)) {
    return false;
  }
  let serialized = "";
  try {
    serialized = JSON.stringify(input.tool_input || input.toolInput || {});
  } catch {
    return false;
  }
  serialized = serialized.replace(/\\\\/g, "\\");
  return /(?:^|[\\/])\.codex[\\/](?:sessions|archived_sessions)(?:[\\/]|")|rollout-[^"'\\/\s]+\.jsonl\b/i.test(
    serialized
  );
}

function sessionTranscriptProjection(output, input) {
  if (process.env.CAPSULE_SESSION_QUERY === "0") return "";
  const text = String(output || "");
  if (text.length < 4_000) return "";
  const candidates = text.split(/\r?\n/).filter((line) => /^\s*\{[\s\S]*\}\s*$/.test(line));
  if (candidates.length < 4) return "";

  const records = [];
  let malformed = 0;
  for (const line of candidates.slice(0, 20_000)) {
    try {
      const parsed = JSON.parse(line);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        malformed += 1;
        continue;
      }
      records.push({ parsed, line });
    } catch {
      malformed += 1;
    }
  }
  if (records.length < 4 || records.length / candidates.length < 0.85) return "";

  const types = new Map();
  const payloadTypes = new Map();
  const timestamps = [];
  const largest = [];
  const toolInput = input.tool_input || input.toolInput || {};
  let intent = "";
  try {
    intent = JSON.stringify(toolInput);
  } catch {
    intent = "";
  }
  const ignored = new Set([
    "codex", "sessions", "archived", "rollout", "jsonl", "users", "documents",
    "get", "content", "select", "string", "powershell", "command", "path", "true", "false",
  ]);
  const queryTerms = [...new Set(
    (intent.toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) || [])
      .filter((term) => !ignored.has(term) && !/^\d+$/.test(term))
  )].slice(0, 8);
  const matches = [];

  for (const { parsed, line } of records) {
    const type = String(parsed.type || "unknown");
    const payloadType = String(parsed.payload?.type || "");
    types.set(type, (types.get(type) || 0) + 1);
    if (payloadType) payloadTypes.set(payloadType, (payloadTypes.get(payloadType) || 0) + 1);
    const timestamp = parsed.timestamp || parsed.time || parsed.created_at;
    if (typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp))) timestamps.push(timestamp);
    largest.push({
      chars: line.length,
      type: payloadType ? `${type}/${payloadType}` : type,
      sha256: crypto.createHash("sha256").update(line).digest("hex").slice(0, 12),
    });
    if (matches.length < 3 && queryTerms.length &&
        queryTerms.some((term) => line.toLowerCase().includes(term)) &&
        !/data:(?:image|audio|video)\//i.test(line)) {
      matches.push(boundedText(compat.redact(line), 360));
    }
  }

  const countMap = (map, limit = 8) => [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([name, count]) => `${name}×${count}`)
    .join(", ");
  largest.sort((left, right) => right.chars - left.chars);
  timestamps.sort();
  const digest = crypto.createHash("sha256").update(text).digest("hex");
  const lines = [
    "[Capsule session transcript projection: raw records omitted; exact capsule follows]",
    `records=${records.length}; malformed=${malformed}; raw_chars=${text.length}; sha256=${digest}`,
    timestamps.length ? `range=${timestamps[0]} .. ${timestamps.at(-1)}` : "",
    `record_types=${countMap(types) || "unknown"}`,
    payloadTypes.size ? `payload_types=${countMap(payloadTypes)}` : "",
    `largest=${largest.slice(0, 3).map((item) => `${item.type}:${item.chars}:${item.sha256}`).join(", ")}`,
    queryTerms.length ? `query_terms=${queryTerms.join(",")}` : "",
    matches.length ? `matched_evidence:\n${matches.map((item) => `- ${item}`).join("\n")}` : "",
  ].filter(Boolean);
  return boundedText(lines.join("\n"), 1_800);
}

function compactExecEnvelope(input, toolName, output) {
  if (process.env.CAPSULE_CONTROL_ENVELOPE === "0" ||
      isFailedToolResult(input, output) ||
      !isShellToolName(toolName)) {
    return { changed: false, output };
  }
  if (requiresLiteralShellOutput(input)) {
    return { changed: false, output };
  }
  const text = String(output || "");
  if (!text) return { changed: false, output: text };

  try {
    const parsed = JSON.parse(text);
    if (parsed && !Array.isArray(parsed) && typeof parsed === "object" &&
        typeof parsed.session_command === "string") {
      const compact = { ...parsed };
      delete compact.session_command;
      const replacement = Object.keys(compact).length
        ? JSON.stringify(compact)
        : "[Capsule poll unchanged; repeated session command omitted]";
      if (replacement.length + 24 < text.length) {
        return {
          changed: true,
          output: replacement,
          removedChars: text.length - replacement.length,
          profile: "control-envelope",
        };
      }
    }
  } catch {
    // Most exec output is a plain-text envelope.
  }

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  let fields = 0;
  while (index < Math.min(lines.length, 12)) {
    const line = lines[index].trim();
    if (/^Exit code:\s*0\s*$/i.test(line) ||
        /^Wall time:\s*.+$/i.test(line) ||
        /^Chunk ID:\s*.+$/i.test(line) ||
        /^Process exited with code\s+0\s*$/i.test(line) ||
        /^Original token count:\s*\d+\s*$/i.test(line) ||
        /^(?:Final )?Output:\s*$/i.test(line)) {
      fields += 1;
      index += 1;
      continue;
    }
    break;
  }
  if (fields < 2) return { changed: false, output: text };
  const body = lines.slice(index).join("\n").trimEnd();
  const replacement = body || "[Capsule exec ok; no output]";
  if (replacement.length + 16 >= text.length) return { changed: false, output: text };
  return {
    changed: true,
    output: replacement,
    removedChars: text.length - replacement.length,
    profile: "control-envelope",
  };
}

function quote(value) {
  return `"${String(value).replaceAll("\"", "\\\"")}"`;
}

function subagentHistoryNeed(message) {
  const text = String(message || "").trim();
  if (!text) return "recent";
  if (/\b(?:full|complete|entire)\s+(?:conversation|history|parent context)|\ball\s+(?:prior|previous)\s+(?:context|decisions?)|\bevery decision above\b|(?:tüm|tam)\s+(?:konuşma|geçmiş|bağlam)|yukarıdaki tüm kararlar|toda\s+la\s+(?:conversaci[oó]n|historia)|contexto\s+completo|todas\s+las\s+decisiones\s+anteriores|toute\s+la\s+(?:conversation|historique)|contexte\s+complet|toutes\s+les\s+d[eé]cisions\s+pr[eé]c[eé]dentes|(?:gesamte|vollst[aä]ndige)\s+(?:unterhaltung|verlauf|kontext)|alle\s+vorherigen\s+entscheidungen|(?:conversa|hist[oó]rico|contexto)\s+complet[oa]|todas\s+as\s+decis[oõ]es\s+anteriores|完整(?:对话|上下文)|全部历史|所有之前的决定|会話全体|完全な(?:履歴|コンテキスト)|以前のすべての決定|전체\s*(?:대화|기록|컨텍스트)|이전의\s*모든\s*결정|весь\s+диалог|полная\s+история|полный\s+контекст|все\s+предыдущие\s+решения|المحادثة\s+كاملة|السجل\s+الكامل|السياق\s+الكامل|كل\s+القرارات\s+السابقة|पूरी\s+बातचीत|पूरा\s+(?:इतिहास|संदर्भ)|पिछले\s+सभी\s+निर्णय/i.test(text)) {
    return "full";
  }
  if (/\b(?:above|earlier|previous|prior|conversation|parent context|this (?:task|request)|same (?:task|request)|continue|we discussed|user asked|fix it|do it|use that)\b|(?:yukarıdaki|önceki|geçmiş konuşma|bu görev|bu talep|devam et|konuştuğumuz|onu düzelt|bunu yap)|(?:arriba|anterior|contin[uú]a|esta tarea|lo hablamos)|(?:ci-dessus|pr[eé]c[eé]dent|continue|cette t[aâ]che)|(?:oben|vorherig|weiter|diese aufgabe)|(?:acima|anterior|continue|esta tarefa)|(?:上面的|之前的|继续|这个任务)|(?:上記|以前|続け|このタスク)|(?:위의|이전|계속|이 작업)|(?:выше|предыдущ|продолж|эту задачу)|(?:أعلاه|السابق|تابع|هذه المهمة)|(?:ऊपर|पिछल|जारी|यह कार्य)/i.test(text)) {
    return "recent";
  }
  if (text.length >= 80 ||
      /\b(?:inspect|run|search|research|validate|test|summarize|implement|compare|audit|analy[sz]e|read|review|measure|design|find|check|build|inspecciona|ejecuta|busca|prueba|revisa|implementa|compara|inspecte|ex[eé]cute|recherche|teste|r[eé]sume|impl[eé]mente|compare|pr[uü]fe|f[uü]hre|suche|implementiere|vergleiche|inspecione|execute|pesquise|resuma|implemente)\b|(?:检查|运行|搜索|测试|总结|实现|比较|审查|検査|実行|検索|テスト|要約|実装|比較|レビュー|검사|실행|검색|테스트|요약|구현|비교|검토|проверь|запусти|найди|исследуй|тестируй|реализуй|сравни|افحص|شغّل|ابحث|اختبر|لخّص|نفّذ|قارن|जाँच|चलाएँ|खोजें|परीक्षण|सारांश|लागू|तुलना)/i.test(text) ||
      /(?:[A-Za-z]:[\\/]|\/[\w.-]+\/|https?:\/\/|`[^`]+`)/.test(text)) {
    return "none";
  }
  return "recent";
}

function subagentModel(message, need) {
  const text = String(message || "");
  const terraRequired = need === "full" || text.length >= 1_200 ||
    /\b(?:architecture|migration|production|security|incident|forensic|root cause|distributed|concurren|race condition|data loss|threat model|cryptograph|legal|medical|financial|cross-platform|end-to-end|mimari|ge[cç]i[sş]|ta[sş][ıi]ma|[üu]retim|g[üu]venlik|olay m[üu]dahalesi|k[öo]k neden|e[sş]zamanl[ıi]|veri kayb[ıi]|tehdit modeli)\b/i.test(text);
  return terraRequired ? "gpt-5.6-terra" : "gpt-5.6-luna";
}

function subagentForkPolicy(input, toolInput, forkTurns) {
  const mode = String(process.env.CAPSULE_FORK_POLICY || "auto").toLowerCase();
  if (mode === "off") return {};
  const message = firstString(toolInput, ["message", "prompt", "task"]);
  const need = subagentHistoryNeed(message);
  const explicitModel = firstString(toolInput, ["model"]);
  const selectedModel = explicitModel || subagentModel(message, need);
  const explicitlyBounded = forkTurns === "none" ||
    (typeof forkTurns === "string" && /^\d+$/.test(forkTurns) && Number(forkTurns) <= 5);
  const target = need === "none" ? "none" : need === "recent" ? "3" : "";
  const parentTokens = Number(pressureState(input).input_tokens || 0);
  const boundedTarget = !explicitlyBounded && mode === "auto" && target ? target : forkTurns;
  const changed = !explicitModel || boundedTarget !== forkTurns;

  if (changed) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        ...(!explicitModel ? {
          permissionDecision: "deny",
          permissionDecisionReason: "Capsule requires an explicit subagent model. " +
            "Use gpt-5.6-luna when the current spawn tool supports it; otherwise use gpt-5.6-terra.",
        } : {}),
        updatedInput: {
          ...toolInput,
          ...(!explicitModel ? { model: selectedModel } : {}),
          ...(boundedTarget !== forkTurns ? { fork_turns: boundedTarget } : {}),
        },
        additionalContext: need === "full"
          ? `[Capsule subagent model=${selectedModel}; history-dependent full subagent fork preserved` +
            `${parentTokens ? `; parent_input≈${parentTokens}` : ""}]`
          : `[Capsule subagent model=${selectedModel}; ` +
            `bounded_fork=${JSON.stringify(boundedTarget || forkTurns || "all")}; need=${need}` +
            `${parentTokens ? `; parent_input≈${parentTokens}` : ""}]`,
      },
    };
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: need === "full"
        ? "Capsule preserved an explicitly history-dependent full subagent fork" +
          `${parentTokens ? ` (parent input≈${parentTokens} tokens)` : ""}.`
        : `Capsule observed an unbounded subagent fork; recommended fork_turns:${JSON.stringify(target)}.`,
    },
  };
}

function preToolUseCore(input) {
  const toolName = firstString(input, ["tool_name", "toolName", "name"]).toLowerCase();
  if (/(?:^|[._-])read[_-]?thread$/.test(toolName)) {
    const toolInput = input.tool_input || input.toolInput || {};
    if (process.env.CAPSULE_THREAD_PREFLIGHT === "0" || toolInput.includeOutputs === true) return {};
    const pressure = pressureState(input);
    const policy = interestAdjustedPolicy(input, pressure.policy || compaction.policyForMode("normal"));
    const turnLimit = Number.isFinite(Number(toolInput.turnLimit))
      ? Math.min(policy.thread_turns, Math.max(1, Number(toolInput.turnLimit)))
      : policy.thread_turns;
    const maxOutputCharsPerItem = Number.isFinite(Number(toolInput.maxOutputCharsPerItem))
      ? Math.min(policy.thread_item_chars, Math.max(0, Number(toolInput.maxOutputCharsPerItem)))
      : policy.thread_item_chars;
    const updatedInput = {
      ...toolInput,
      turnLimit,
      maxOutputCharsPerItem,
      includeOutputs: false,
    };
    if (JSON.stringify(updatedInput) === JSON.stringify(toolInput)) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput,
        additionalContext: `[Capsule history bounded; paginate or use includeOutputs=true; pressure=${pressure.mode}]`,
      },
    };
  }
  if (/spawn[_ -]?agent/.test(toolName)) {
    const toolInput = input.tool_input || input.toolInput || {};
    const forkTurns = toolInput.fork_turns ?? toolInput.forkTurns;
    return subagentForkPolicy(input, toolInput, forkTurns);
  }
  if (!isShellToolName(toolName)) return {};
  const { toolInput, command } = shellCommand(input);
  if (!command) return {};
  const rewrite = compat.rewriteCommand({ command, cwd: projectDir(input), hook: true }).response;
  if (!rewrite.should_wrap) return {};
  const pressure = pressureState(input);
  const policy = interestAdjustedPolicy(input, pressure.policy || compaction.policyForMode("normal"));
  const payloadRoot = path.join(hookRoot(), "payloads");
  fs.mkdirSync(payloadRoot, { recursive: true });
  const payloadPath = path.join(payloadRoot, `payload-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(payloadPath, `${JSON.stringify({
    command,
    cwd: projectDir(input),
    profile: rewrite.profile,
    query: firstString(input, ["intent", "query"]),
    session_id: explicitSessionId(input),
    execution_epoch: Number(readHookState(
      hashedHookStateFile(input, "execution-progress"),
      { epoch: 0 }
    ).epoch || 0),
    input_tokens: Number(pressure.input_tokens || 0),
    max_chars: policy.tool_max_chars,
    passthrough_chars: policy.tool_passthrough_chars,
  })}\n`, "utf8");
  const cli = path.join(__dirname, "cli.cjs");
  const invoke = process.platform === "win32" ? "& " : "";
  const wrapped = `${invoke}${quote(process.execPath)} --no-warnings ${quote(cli)} shell --payload ${quote(payloadPath)}`;
  const hookSpecificOutput = {
    hookEventName: "PreToolUse",
    updatedInput: { ...toolInput, command: wrapped },
  };
  if (rewrite.reason !== "safe repeated-status candidate") {
    hookSpecificOutput.additionalContext = "[Capsule shell wrapped; exact output is locally expandable]";
  }
  return { hookSpecificOutput };
}

function postToolUseCore(input) {
  const name = firstString(input, ["tool_name", "toolName", "name"]);
  if (/capsule/i.test(name)) return {};
  const pressure = pressureState(input);
  const basePolicy = interestAdjustedPolicy(input, pressure.policy || compaction.policyForMode("normal"));
  const transcriptShield = isCodexTranscriptRead(input, name);
  const policy = transcriptShield
    ? {
      ...basePolicy,
      tool_trigger_chars: Math.min(basePolicy.tool_trigger_chars, 1_200),
      tool_max_chars: Math.min(basePolicy.tool_max_chars, 2_400),
      tool_passthrough_chars: Math.min(basePolicy.tool_passthrough_chars, 600),
    }
    : basePolicy;
  const guidance = [
    roundTripGuidance(input, name),
    repeatedReadGuidance(input, name),
  ].filter(Boolean).join("\n");
  const rawOutput = rawToolOutput(input);
  if (containsMedia(rawOutput)) {
    const replay = mediaReplay(input, name, rawOutput);
    if (replay.duplicate) {
      const replacement = "[Capsule media replay: exact duplicate omitted]";
      recordHookHistory({
        command: name || "view_image",
        cwd: projectDir(input),
        profile: "media-replay",
        route: "compressed",
        raw_chars: replay.rawChars,
        emitted_chars: replacement.length,
        exit_code: 0,
        source: "hook-media-replay",
      });
      return postToolReplacement(replacement, guidance);
    }
    return guidance ? {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: guidance,
      },
    } : {};
  }
  const output = toolOutput(input);
  if (isShellToolName(name) && requiresLiteralShellOutput(input)) {
    recordHookHistory({
      command: name || "shell",
      cwd: projectDir(input),
      profile: "literal-shell",
      route: "passthrough",
      raw_chars: output.length,
      emitted_chars: output.length,
      exit_code: isFailedToolResult(input, output) ? 1 : 0,
      source: "hook-literal-shell",
    });
    return guidance ? {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: guidance,
      },
    } : {};
  }
  const failure = failureReplay(input, name, output);
  if (failure.duplicate) {
    recordHookHistory({
      command: name || "tool-error",
      cwd: projectDir(input),
      profile: "failure-replay",
      route: "compressed",
      raw_chars: failure.rawChars,
      emitted_chars: failure.replacement.length,
      exit_code: 1,
      source: "hook-failure-replay",
    });
    return postToolReplacement(failure.replacement, guidance);
  }
  const replay = textReplay(input, name, output);
  if (replay.duplicate) {
    const replacement = replay.poll
      ? "[Capsule poll: exactly unchanged]"
      : replay.afterCompaction && replay.capsuleId
      ? `[Capsule replay after compaction; exact=${replay.capsuleId}]`
      : `[Capsule replay: exact duplicate omitted${replay.capsuleId ? `; exact=${replay.capsuleId}` : ""}]`;
    const replayGuidance = replay.poll ? "" : guidance;
    const margin = replay.poll ? 8 : 80;
    if (replay.rawChars > replacement.length + replayGuidance.length + margin) {
      recordHookHistory({
        command: name || "read-only-tool",
        cwd: projectDir(input),
        profile: "tool-replay",
        route: "compressed",
        raw_chars: replay.rawChars,
        emitted_chars: replacement.length,
        exit_code: 0,
        source: "hook-tool-replay",
      });
      return postToolReplacement(replacement, replayGuidance);
    }
  }
  if (replay.delta) {
    recordHookHistory({
      command: name || "read-only-tool",
      cwd: projectDir(input),
      profile: "tool-delta-replay",
      route: "compressed",
      raw_chars: replay.rawChars,
      emitted_chars: replay.delta.replacement.length,
      exit_code: 0,
      source: "hook-tool-delta-replay",
    });
    return postToolReplacement(replay.delta.replacement, guidance);
  }
  if (isStructuredWebTool(name) && rawOutput && typeof rawOutput === "object") {
    const projectedWeb = structuredWebProjection(rawOutput, input, name, replay.capsuleId);
    if (projectedWeb) {
      recordHookHistory({
        command: name || "web",
        cwd: projectDir(input),
        profile: "structured-web-projection",
        route: "compressed",
        raw_chars: output.length,
        emitted_chars: projectedWeb.length,
        exit_code: 0,
        source: "hook-structured-web",
      });
      return postToolReplacement(projectedWeb, guidance);
    }
    return guidance ? {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: guidance,
      },
    } : {};
  }
  const projectedThread = threadProjection(rawOutput, input, name);
  if (projectedThread) {
    recordHookHistory({
      command: name || "read_thread",
      cwd: projectDir(input),
      profile: "thread-projection",
      route: "compressed",
      raw_chars: output.length,
      emitted_chars: projectedThread.length,
      exit_code: input.is_error ? 1 : 0,
      source: "hook-thread-projection",
    });
    return postToolReplacement(projectedThread, guidance);
  }
  const projectedTranscript = transcriptShield ? sessionTranscriptProjection(output, input) : "";
  if (projectedTranscript) {
    const savedTranscript = core.saveCapsule({
      kind: "session-transcript",
      source: firstString(input.tool_input || input.toolInput || {}, ["path", "command"]) || name || "session-transcript",
      text: output,
      question: firstString(input, ["intent", "query"]),
      maxChars: 1_000,
      details: { session_id: sessionId(input), project_dir: projectDir(input) },
    });
    const replacement = `${projectedTranscript}\n[Capsule exact=${savedTranscript.response.capsule_id}]`;
    if (output.length > replacement.length + 80) {
      recordHookHistory({
        command: name || "session-transcript",
        cwd: projectDir(input),
        profile: "session-query",
        route: "compressed",
        raw_chars: output.length,
        emitted_chars: replacement.length,
        exit_code: 0,
        source: "hook-session-query",
      });
      return postToolReplacement(replacement, guidance);
    }
  }
  const projectedBrowser = browserStateProjection(output, input, name, replay.capsuleId);
  if (projectedBrowser) {
    recordHookHistory({
      command: name || "browser",
      cwd: projectDir(input),
      profile: "browser-state",
      route: "compressed",
      raw_chars: output.length,
      emitted_chars: projectedBrowser.length,
      exit_code: 0,
      source: "hook-browser-state",
    });
    rememberEvent(input, "browser-state", projectedBrowser, name || "browser-state");
    return postToolReplacement(projectedBrowser, guidance);
  }
  const envelope = compactExecEnvelope(input, name, output);
  const visibleOutput = envelope.output;
  const shell = isShellToolName(name);
  const genome = shell && !isFailedToolResult(input, output)
    ? terminalGenome.project({
      session_id: explicitSessionId(input),
      cwd: projectDir(input),
      command: shellCommand(input).command,
      text: visibleOutput,
      exact_text: output,
      capsule_id: replay.capsuleId || failure.capsuleId || "",
      success: true,
    })
    : null;
  if (genome) {
    recordHookHistory({
      command: name || "shell",
      cwd: projectDir(input),
      profile: "terminal-" + (genome.mode || "genome"),
      route: "compressed",
      raw_chars: output.length,
      emitted_chars: genome.output.length,
      exit_code: 0,
      source: "hook-terminal-" + (genome.mode || "genome"),
    });
    return postToolReplacement(genome.output, guidance);
  }
  if (!visibleOutput || visibleOutput.length < policy.tool_trigger_chars) {
    if (visibleOutput && /\b(error|failed|exception|traceback|panic)\b/i.test(visibleOutput)) {
      rememberEvent(input, "tool-error", visibleOutput.slice(0, 20_000), name || "tool-error");
    }
    if (envelope.changed) {
      recordHookHistory({
        command: name || "tool",
        cwd: projectDir(input),
        profile: envelope.profile,
        route: "compressed",
        raw_chars: output.length,
        emitted_chars: visibleOutput.length,
        exit_code: 0,
        source: "hook-control-envelope",
      });
      return postToolReplacement(visibleOutput, guidance);
    }
    return guidance ? {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: guidance,
      },
    } : {};
  }
  const saved = failure.capsuleId
    ? { response: { capsule_id: failure.capsuleId } }
    : replay.capsuleId
    ? { response: { capsule_id: replay.capsuleId } }
    : core.saveCapsule({
      kind: "hook-tool-output",
      source: name || "tool",
      text: output,
      question: firstString(input, ["intent", "query"]),
      maxChars: 1_200,
      details: { session_id: sessionId(input), project_dir: projectDir(input) },
    });
  const compact = unified.compressText(visibleOutput, {
    command: name,
    query: firstString(input, ["intent", "query"]),
    cwd: projectDir(input),
    passthrough_chars: policy.tool_passthrough_chars,
    max_chars: policy.tool_max_chars,
  });
  const securityPassthrough = compact.route !== "compressed" &&
    Number(compact.secret_redactions || 0) > 0 &&
    compact.output !== visibleOutput;
  if (securityPassthrough) {
    const securityContext = [
      guidance,
      `[Capsule security redaction; exact=${saved.response.capsule_id}]`,
    ].filter(Boolean).join("\n");
    recordHookHistory({
      command: name || "tool",
      cwd: projectDir(input),
      profile: "json-security-redaction",
      route: "compressed",
      raw_chars: output.length,
      emitted_chars: compact.output.length,
      exit_code: input.is_error ? 1 : 0,
      source: "hook-json-security",
    });
    rememberEvent(input, "tool-summary", compact.output.slice(0, 20_000), name || "tool-summary");
    return postToolReplacement(compact.output, securityContext);
  }
  if (compact.route !== "compressed") {
    const configuredAbsolute = Number(process.env.CAPSULE_ABSOLUTE_OUTPUT_CHARS);
    const absoluteThreshold = transcriptShield
      ? 4_000
      : Number.isFinite(configuredAbsolute)
      ? Math.min(1_000_000, Math.max(16_000, Math.trunc(configuredAbsolute)))
      : 32_000;
    const configuredUniversalCap = Number(process.env.CAPSULE_UNIVERSAL_HARD_CAP_CHARS);
    const universalHardCap = process.env.CAPSULE_UNIVERSAL_HARD_CAP !== "0" &&
      visibleOutput.length > (Number.isFinite(configuredUniversalCap)
        ? Math.min(4_000_000, Math.max(64_000, Math.trunc(configuredUniversalCap)))
        : 1_000_000);
    const absoluteEligible = process.env.CAPSULE_ABSOLUTE_OUTPUT !== "0" &&
      isReplayEligibleTool(input, name) &&
      !isFailedToolResult(input, output) &&
      visibleOutput.length > absoluteThreshold;
    const circuitEligible = universalHardCap || absoluteEligible || ["critical", "emergency"].includes(pressure.mode) ||
      (pressure.mode === "high" && output.length > policy.tool_max_chars * 2);
    if (circuitEligible && visibleOutput.length > policy.tool_max_chars) {
      const circuitPressure = transcriptShield
        ? { ...pressure, mode: "session-log-shield" }
        : universalHardCap && pressure.mode === "normal"
        ? { ...pressure, mode: "universal-hard-cap" }
        : absoluteEligible && pressure.mode === "normal"
        ? { ...pressure, mode: "absolute-cap" }
        : pressure;
      const replacement = pressureCircuit(
        visibleOutput,
        saved.response.capsule_id,
        circuitPressure,
        policy.tool_passthrough_chars,
        output
      );
      recordHookHistory({
        command: name || "tool",
        cwd: projectDir(input),
        profile: "pressure-circuit",
        route: "compressed",
        raw_chars: output.length,
        emitted_chars: replacement.length,
        exit_code: input.is_error ? 1 : 0,
        source: "hook-pressure-circuit",
      });
      rememberEvent(input, "tool-summary", replacement, name || "tool-summary");
      return postToolReplacement(replacement, guidance);
    }
    recordHookHistory({
      command: name || "tool",
      cwd: projectDir(input),
      profile: envelope.changed ? envelope.profile : compact.profile,
      route: envelope.changed ? "compressed" : compact.route,
      raw_chars: output.length,
      emitted_chars: visibleOutput.length,
      exit_code: input.is_error ? 1 : 0,
      source: envelope.changed ? "hook-control-envelope" : "hook",
    });
    if (!envelope.changed) return {};
    return postToolReplacement(visibleOutput, guidance);
  }
  recordHookHistory({
    command: name || "tool",
    cwd: projectDir(input),
    profile: compact.profile,
    route: compact.route,
    raw_chars: output.length,
    emitted_chars: compact.output.length,
    exit_code: input.is_error ? 1 : 0,
    source: "hook",
  });
  const replacement = `${compact.output}\n\n[Capsule exact=${saved.response.capsule_id}]`;
  rememberEvent(input, "tool-summary", replacement.slice(0, 20_000), name || "tool-summary");
  return postToolReplacement(replacement, guidance);
}

function sessionContext(input, reason, hookEventName) {
  const configuredLimit = Number(process.env.CAPSULE_RECALL_LIMIT);
  const recallLimit = Number.isFinite(configuredLimit)
    ? Math.min(3, Math.max(0, Math.trunc(configuredLimit)))
    : 1;
  if (recallLimit === 0) return {};
  const recent = unified.searchIndex({
    queries: ["decision", "error", "blocker", "plan", "user prompt"],
    tags: ["session-event", projectScope(input)],
    sort: "timeline",
    limit: 1,
    snippet_chars: 280,
  }).response.searches.flatMap((search) => search.results);
  const projectName = path.basename(projectDir(input)).replace(/[^\p{L}\p{N}_-]+/gu, " ").trim();
  const migrated = process.env.CAPSULE_INCLUDE_MIGRATED === "1" && recent.length < 3
    ? unified.searchIndex({
    queries: ["decision", "error", "blocker", "plan"].map((term) =>
      projectName.length >= 2 ? `${projectName} ${term}` : term
    ),
    kind: "migrated-context",
    sort: "timeline",
    limit: 1,
    snippet_chars: 280,
  }).response.searches.flatMap((search) => search.results)
    : [];
  const unique = new Map();
  for (const item of [...recent, ...migrated]) unique.set(item.document_id, item);
  const searched = [...unique.values()].slice(0, recallLimit);
  if (!searched.length) return {};
  const context = searched.map((item) => `- ${item.title}: ${item.snippet}`).join("\n");
  return {
    hookSpecificOutput: {
      hookEventName,
      additionalContext: `Capsule ${reason} context (local persistent memory):\n${context}`,
    },
  };
}

function reasoningGovernorArgs(input) {
  return {
    session: sessionId(input),
    session_file: firstString(input, [
      "session_file", "sessionFile", "transcript_path", "transcriptPath", "rollout_path", "rolloutPath",
    ]),
  };
}

function adaptiveGovernorArgs(input) {
  const base = reasoningGovernorArgs(input);
  const mode = pressureState(input).mode || "normal";
  const thresholds = {
    normal: { warning: 512, hard: 1_536, credit_warning: 4_096, credit_hard: 12_288 },
    high: { warning: 384, hard: 1_024, credit_warning: 3_072, credit_hard: 8_192 },
    critical: { warning: 256, hard: 640, credit_warning: 2_048, credit_hard: 5_120 },
    emergency: { warning: 128, hard: 384, credit_warning: 1_024, credit_hard: 3_072 },
  }[mode] || { warning: 512, hard: 1_536, credit_warning: 4_096, credit_hard: 12_288 };
  const adaptive = { ...base };
  if (process.env.CAPSULE_REASONING_WARNING == null &&
      process.env.CAPSULE_REASONING_BRAKE == null) {
    adaptive.warning = thresholds.warning;
    adaptive.hard = thresholds.hard;
  }
  if (process.env.CAPSULE_CREDIT_WARNING == null &&
      process.env.CAPSULE_CREDIT_BRAKE == null) {
    adaptive.credit_warning = thresholds.credit_warning;
    adaptive.credit_hard = thresholds.credit_hard;
  }
  return adaptive;
}

function mergeGovernor(result, governor, hookEventName) {
  if (!governor?.emit || !governor.context) return result;
  const prior = result?.hookSpecificOutput || {};
  const additionalContext = [prior.additionalContext, governor.context].filter(Boolean).join("\n").slice(0, 1800);
  return {
    ...(result || {}),
    hookSpecificOutput: {
      ...prior,
      hookEventName,
      additionalContext,
    },
  };
}

function mergeHookSupplement(result, input, supplement, hookEventName) {
  const prior = result?.hookSpecificOutput || {};
  const toolInput = input.tool_input || input.toolInput || {};
  const pollUpdate = {};
  const normalized = firstString(input, ["tool_name", "toolName", "name"]).toLowerCase();
  if (isPollTool(normalized)) {
    if (Object.hasOwn(toolInput, "yield_time_ms") && Number(toolInput.yield_time_ms) < 60_000) {
      pollUpdate.yield_time_ms = 60_000;
    }
    if (Object.hasOwn(toolInput, "timeout_ms") && Number(toolInput.timeout_ms) < 60_000) {
      pollUpdate.timeout_ms = 60_000;
    }
  }
  const candidateInput = Object.keys(pollUpdate).length
    ? { ...(prior.updatedInput || toolInput), ...pollUpdate }
    : prior.updatedInput;
  const safeUpdatedInput = (() => {
    if (!candidateInput) return undefined;
    if (isPollTool(normalized) ||
        /(?:^|[._-])read[_-]?thread$/.test(normalized) ||
        /spawn[_ -]?agent/.test(normalized)) {
      return candidateInput;
    }
    if (isShellToolName(normalized)) {
      const { command } = shellCommand(input);
      const rewrite = command
        ? compat.rewriteCommand({ command, cwd: projectDir(input), hook: true }).response
        : null;
      if (rewrite?.should_wrap && typeof candidateInput.command === "string") return candidateInput;
    }
    return undefined;
  })();
  const additionalContext = [prior.additionalContext, supplement.guidance]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1_800);
  if (!safeUpdatedInput && !additionalContext) return result;
  return {
    ...(result || {}),
    hookSpecificOutput: {
      ...prior,
      hookEventName,
      ...(safeUpdatedInput && prior.permissionDecision !== "deny"
        ? { permissionDecision: "allow" }
        : {}),
      ...(safeUpdatedInput ? { updatedInput: safeUpdatedInput } : {}),
      ...(additionalContext ? { additionalContext } : {}),
    },
  };
}

function preToolUse(input) {
  const toolName = firstString(input, ["tool_name", "toolName", "name"]);
  const nativeEditBlock = nativeEditPreferenceGuard(input, toolName);
  if (nativeEditBlock) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: nativeEditBlock,
        additionalContext: nativeEditBlock,
      },
    };
  }
  const supplement = noteToolIntent(input, toolName);
  if (supplement.blockReason) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: supplement.blockReason,
        additionalContext: supplement.blockReason,
      },
    };
  }
  let result = mergeHookSupplement(preToolUseCore(input), input, supplement, "PreToolUse");
  if (process.env.CAPSULE_REASONING_GOVERNOR === "0") return result;
  const governor = cognition.checkGovernor(adaptiveGovernorArgs(input)).response;
  return mergeGovernor(result, governor, "PreToolUse");
}

function postToolUse(input) {
  const result = postToolUseCore(input);
  const toolName = firstString(input, ["tool_name", "toolName", "name"]);
  noteToolResult(input, toolName);
  quotaProgress.noteTool({
    session_id: sessionId(input),
    tool_name: toolName,
    epoch: executionEpoch(input),
  });
  if (process.env.CAPSULE_REASONING_GOVERNOR === "0") return result;
  const governor = cognition.checkGovernor(adaptiveGovernorArgs(input)).response;
  return mergeGovernor(result, governor, "PostToolUse");
}

function handle(event, input) {
  if (event === "pretooluse") return preToolUse(input);
  if (event === "posttooluse") return postToolUse(input);
  if (event === "userpromptsubmit") {
    clearMediaReplay(input);
    const prompt = firstString(input, ["prompt", "user_prompt", "userPrompt", "message"]);
    if (process.env.CAPSULE_CAPTURE_PROMPTS === "1") {
      rememberEvent(input, "user-prompt", prompt, "User prompt");
    }
    const context = [];
    const advisorTask = prompt ? startAdvisorTask(input, prompt) : null;
    if (advisorTask?.plan?.context) context.push(advisorTask.plan.context);
    const taxGuidance = roundTripTaxGuidance(input);
    if (taxGuidance) context.push(taxGuidance);
    if (prompt && process.env.CAPSULE_COGNITION !== "0") {
      const project = projectScope(input);
      const pressure = pressureState(input);
      const escrow = cognition.planEscrow({
        prompt,
        pressure_mode: pressure.mode || "normal",
        record: true,
      }).response;
      const before = cognition.governor({
        ...reasoningGovernorArgs(input),
        mode: "status",
      }).response;
      const exchange = quotaProgress.begin({
        session_id: sessionId(input),
        project,
        prompt_fingerprint: cognition.fingerprint(prompt),
        epoch: executionEpoch(input),
        explicit_detail: Boolean(escrow.explicit_detail),
        usage: before.total,
        quota: pressure.quota,
      });
      cognition.notePrompt({ ...reasoningGovernorArgs(input), project, prompt });
      if (escrow.context) context.push(escrow.context);
      if (exchange.context) context.push(exchange.context);
      const compiled = cognition.compile({ prompt }).response;
      const recalled = advisorTask?.boundary
        ? { hit: false }
        : cognition.recall({ prompt, project, threshold: 0.86 }).response;
      if (recalled.hit) {
        context.push(
          `[Capsule cognition replay ${recalled.kernel_id}; similarity=${recalled.score}] ` +
          `${recalled.kernel} ${recalled.stale_guard}`
        );
      }
      if (compiled.context) context.push(compiled.context);
    }
    if (!context.length) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: context.join("\n").slice(0, 900),
      },
    };
  }
  if (event === "sessionstart") {
    clearMediaReplay(input);
    const source = firstString(input, ["source", "reason", "resume_source"]).toLowerCase();
    if (source.includes("compact")) return {};
    clearTextReplay(input);
    return sessionContext(input, "session-start", "SessionStart");
  }
  if (event === "precompact") {
    terminalGenome.reset({ session_id: explicitSessionId(input), cwd: projectDir(input) });
    clearMediaReplay(input);
    const replay = markTextReplayCompaction(input);
    rememberEvent(input, "compaction", firstString(input, ["summary", "context", "transcript"]), "Compaction");
    const pressure = pressureState(input);
    const policy = pressure.policy || compaction.policyForMode("normal");
    const historical = pressure.recent_compactions >= 1 ? latestPhaseCheckpoint(input) : "";
    const seed = compaction.buildSeed({
      session: sessionId(input),
      session_file: firstString(input, [
        "session_file", "sessionFile", "transcript_path", "transcriptPath", "rollout_path", "rolloutPath",
      ]),
      max_chars: policy.seed_chars,
      summary_tokens: policy.summary_tokens,
      historical,
      progress: [executionCheckpoint(input), quotaProgress.checkpoint(sessionId(input))]
        .filter(Boolean)
        .join("; "),
      tombstones: quotaProgress.tombstones(sessionId(input)).map((item) =>
        `¬${item.state}@${String(item.id || "").slice(0, 12)}:e${Number(item.epoch || 0)}` +
        `#${String(item.receipt_id || "").slice(0, 12)}`
      ),
      generation_file: `${phaseCheckpointFile(input)}.context-gc.json`,
    }).response;
    const seededCapsules = new Set(seed.capsules || []);
    const replayOnly = replay.capsuleIds.filter((capsule) => !seededCapsules.has(capsule));
    const capsuleContext = replayOnly.length
      ? `Capsule exact capsules surviving compaction: ${replayOnly.slice(-8).join(", ")}.`
      : "";
    const imageContext = pressure.retained_image_items > 0
      ? "Capsule image pressure: preserve derived conclusions and file references only; omit inline/base64 media payloads."
      : "";
    const additionalContext = [seed.context, capsuleContext, imageContext]
      .filter(Boolean)
      .join("\n")
      .slice(0, Math.min(1_400, policy.seed_chars + 180));
    if (!additionalContext) return sessionContext(input, "pre-compact", "PreCompact");
    return {
      hookSpecificOutput: {
        hookEventName: "PreCompact",
        additionalContext,
      },
    };
  }
  if (event === "stop") {
    const finalMessage = firstString(
      input,
      ["last_assistant_message", "lastAssistantMessage", "response", "message"]
    );
    writePhaseCheckpoint(input, finalMessage);
    rememberEvent(
      input,
      "assistant-final",
      finalMessage,
      "Assistant final"
    );
    if (process.env.CAPSULE_COGNITION !== "0" && finalMessage) {
      const governor = cognition.governor({
        ...reasoningGovernorArgs(input),
        mode: "status",
      }).response;
      const pressure = pressureState(input);
      quotaProgress.finish({
        session_id: sessionId(input),
        credit_weighted_delta: governor.credit_weighted_delta,
        reasoning_delta: governor.reasoning_delta,
        usage: governor.total,
        last: governor.last,
        quota: pressure.quota,
        epoch: executionEpoch(input),
        final_message: finalMessage,
      });
      cognition.commitSession({ session: sessionId(input), solution: finalMessage });
    }
    return {};
  }
  return {};
}

function main() {
  const event = String(process.argv[2] || "").toLowerCase();
  try {
    const input = readInput();
    recordProviderSessionPointer(input);
    writeHeartbeat(event, input);
    process.stdout.write(JSON.stringify(handle(event, input)));
  } catch (error) {
    logError(event, error);
    process.stdout.write("{}");
  }
}

if (require.main === module) main();

module.exports = {
  handle,
  main,
  postToolUse,
  preToolUse,
  sessionContext,
  structuredWebProjection,
};
