"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const core = require("./core.cjs");

const INDEX_VERSION = 3;
const EXCLUDED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".codex", ".idea", ".vscode", ".capsule",
  "node_modules", "vendor", "target", "dist", "build", "out", "coverage",
  ".next", ".nuxt", ".cache", ".pytest_cache", "__pycache__", ".venv", "venv",
]);
const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cjs", ".cpp", ".cs", ".css", ".cts", ".go", ".h", ".hpp", ".html",
  ".java", ".js", ".jsx", ".kt", ".kts", ".mjs", ".mts", ".md", ".mdx", ".php", ".ps1",
  ".py", ".rb", ".rs", ".sh", ".sql", ".swift", ".toml", ".ts", ".tsx",
  ".vue", ".svelte", ".xml", ".yaml", ".yml",
]);
const CONFIG_NAMES = new Set([
  "package.json", "tsconfig.json", "jsconfig.json", "pyproject.toml",
  "requirements.txt", "cargo.toml", "go.mod", "pom.xml", "build.gradle",
  "build.gradle.kts", "composer.json", "gemfile", "dockerfile",
  "docker-compose.yml", "docker-compose.yaml", "makefile", "cmakelists.txt",
]);
const ENTRY_NAMES = new Set([
  "main", "index", "app", "server", "cli", "program", "startup", "__main__",
]);
const DYNAMIC_EXTENSIONS = new Set([
  ".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx", ".py", ".rb", ".php",
]);
const SECRET_RE = /\b(api[_-]?(?:key|token)|access[_-]?token|auth[_-]?token|authorization|cookie|credential|password|passwd|private[_-]?key|secret|token)\s*([:=])\s*(?:bearer\s+)?[^\s,;]+|\bbearer\s+[a-z0-9._~+/=-]+/ig;
const QUERY_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "does", "for", "from", "how",
  "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "what", "where",
  "which", "with", "ve", "bir", "bu", "icin", "için", "nasil", "nasıl", "nerede",
]);

function integer(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function slash(value) {
  return String(value).replace(/\\/g, "/");
}

function tokenize(value) {
  return [...String(value || "").toLowerCase().matchAll(/[\p{L}\p{N}_$.-]{2,}/gu)]
    .map((match) => match[0]);
}

function unique(values, limit = 500) {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function redactVisible(value) {
  return String(value).replace(SECRET_RE, (match, name, separator) => {
    if (name) return `${name}${separator}[REDACTED]`;
    return `${match.slice(0, match.search(/\s/))} [REDACTED]`;
  });
}

function projectPaths(root) {
  const canonical = slash(path.resolve(root)).toLowerCase();
  const id = sha256(canonical).slice(0, 20);
  const directory = path.join(core.stateRoot(), "projects", id);
  return {
    id,
    directory,
    index: path.join(directory, "index.json"),
  };
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function projectCacheEntries() {
  const root = path.join(core.stateRoot(), "projects");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{20}$/.test(entry.name))
    .map((entry) => {
      const directory = path.join(root, entry.name);
      const indexFile = path.join(directory, "index.json");
      const index = readJson(indexFile, {});
      let bytes = 0;
      try { bytes = fs.statSync(indexFile).size; } catch {}
      const lastUsed = Date.parse(index.updated_at || index.created_at || "") ||
        (fs.existsSync(indexFile) ? fs.statSync(indexFile).mtimeMs : 0);
      return {
        project_id: entry.name,
        directory,
        root: index.root || null,
        bytes,
        last_used: Number(lastUsed) || 0,
        root_exists: Boolean(index.root && fs.existsSync(index.root)),
      };
    })
    .sort((left, right) => right.last_used - left.last_used);
}

function maintainProjectCache(options = {}) {
  const cacheRoot = path.join(core.stateRoot(), "projects");
  fs.mkdirSync(cacheRoot, { recursive: true });
  const lock = path.join(core.stateRoot(), "project-cache-gc.lock");
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let stale = false;
    try { stale = Date.now() - fs.statSync(lock).mtimeMs > 5 * 60 * 1000; } catch {}
    if (!stale) return { skipped: "locked", removed: 0 };
    fs.rmSync(lock, { recursive: true, force: true });
    try { fs.mkdirSync(lock); } catch { return { skipped: "locked", removed: 0 }; }
  }
  try {
  const maximumProjects = integer(
    options.max_projects ?? process.env.CAPSULE_PROJECT_CACHE_MAX_PROJECTS,
    64,
    1,
    100_000,
  );
  const maximumBytes = integer(
    options.max_bytes ?? process.env.CAPSULE_PROJECT_CACHE_MAX_BYTES,
    256 * 1024 * 1024,
    1024,
    16 * 1024 * 1024 * 1024,
  );
  const ttlDays = integer(
    options.ttl_days ?? process.env.CAPSULE_PROJECT_CACHE_TTL_DAYS,
    90,
    1,
    3650,
  );
  const protectId = String(options.protect_id || "");
  const now = Date.now();
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  const entries = projectCacheEntries();
  let currentBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  let currentProjects = entries.length;
  const removed = [];
  for (const entry of [...entries].reverse()) {
    if (entry.project_id === protectId) continue;
    const expired = now - entry.last_used > ttlMs;
    const missing = !entry.root_exists;
    const overQuota = currentProjects > maximumProjects || currentBytes > maximumBytes;
    if (!expired && !missing && !overQuota) continue;
    fs.rmSync(entry.directory, { recursive: true, force: true });
    currentProjects -= 1;
    currentBytes = Math.max(0, currentBytes - entry.bytes);
    removed.push(entry.project_id);
  }
  return {
    projects_before: entries.length,
    projects_after: currentProjects,
    bytes_before: entries.reduce((total, entry) => total + entry.bytes, 0),
    bytes_after: currentBytes,
    removed: removed.length,
    removed_ids: options.include_ids ? removed : undefined,
    limits: { max_projects: maximumProjects, max_bytes: maximumBytes, ttl_days: ttlDays },
    quota_satisfied: currentProjects <= maximumProjects && currentBytes <= maximumBytes,
  };
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function roleFor(relative, extension) {
  const lower = slash(relative).toLowerCase();
  const name = path.basename(lower);
  const stem = path.basename(lower, extension);
  if (/(^|\/)(?:test|tests|spec|specs|__tests__)(\/|$)|(?:^|[._-])(?:test|spec)\./.test(lower)) {
    return "test";
  }
  if (CONFIG_NAMES.has(name) || /(^|\/)(?:config|configs)(\/|$)/.test(lower)) return "config";
  if ([".md", ".mdx"].includes(extension) || /(^|\/)docs?(\/|$)/.test(lower)) return "docs";
  if (ENTRY_NAMES.has(stem) || /(^|\/)(?:bin|cmd)(\/|$)/.test(lower)) return "entry";
  if (/migration|schema|model|entity/.test(lower)) return "data";
  return "source";
}

function languageFor(extension) {
  return {
    ".cjs": "javascript", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
    ".cts": "typescript", ".mts": "typescript", ".ts": "typescript", ".tsx": "typescript",
    ".py": "python", ".rb": "ruby", ".rs": "rust", ".go": "go", ".java": "java",
    ".kt": "kotlin", ".kts": "kotlin", ".cs": "csharp", ".c": "c", ".cc": "cpp",
    ".cpp": "cpp", ".h": "c", ".hpp": "cpp", ".php": "php", ".swift": "swift",
    ".ps1": "powershell", ".sh": "shell", ".sql": "sql", ".vue": "vue",
    ".svelte": "svelte", ".md": "markdown", ".mdx": "markdown",
  }[extension] || extension.slice(1) || "text";
}

function candidateFile(name) {
  const lower = name.toLowerCase();
  const extension = path.extname(lower);
  return SOURCE_EXTENSIONS.has(extension) || CONFIG_NAMES.has(lower);
}

function walkProject(root, options = {}) {
  const maximumFiles = integer(options.max_files, 50_000, 1, 200_000);
  const maximumBytes = integer(options.max_file_bytes, 768 * 1024, 1024, 16 * 1024 * 1024);
  const files = [];
  let ignoredLarge = 0;
  let ignoredSymlinks = 0;
  const visit = (directory) => {
    if (files.length >= maximumFiles) return;
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= maximumFiles) break;
      if (entry.isSymbolicLink()) {
        ignoredSymlinks += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) {
          visit(path.join(directory, entry.name));
        }
        continue;
      }
      if (!entry.isFile() || !candidateFile(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const stat = fs.statSync(absolute);
      if (stat.size > maximumBytes) {
        ignoredLarge += 1;
        continue;
      }
      files.push({
        absolute,
        relative: slash(path.relative(root, absolute)),
        size: stat.size,
        mtime_ms: Math.trunc(stat.mtimeMs),
      });
    }
  };
  visit(root);
  return {
    files,
    truncated: files.length >= maximumFiles,
    ignored_large: ignoredLarge,
    ignored_symlinks: ignoredSymlinks,
  };
}

const SYMBOL_PATTERNS = [
  ["class", /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/],
  ["interface", /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/],
  ["type", /\b(?:export\s+)?(?:type|enum|struct|trait|record)\s+([A-Za-z_$][\w$]*)/],
  ["function", /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/],
  ["function", /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*[<(]/],
  ["function", /^\s*(?:pub\s+)?func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/],
  ["function", /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/],
  ["class", /^\s*class\s+([A-Za-z_][\w]*)\s*[:(<]/],
  ["function", /^\s*(?:public|private|protected|internal|static|final|virtual|override|async|\s)+\s+[A-Za-z_<>,[\]?]+\s+([A-Za-z_][\w]*)\s*\(/],
  ["function", /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/],
  ["heading", /^\s{0,3}#{1,6}\s+(.{2,120})$/],
];

function indentation(line) {
  const prefix = String(line || "").match(/^[\t ]*/)?.[0] || "";
  return [...prefix].reduce((total, character) => total + (character === "\t" ? 4 : 1), 0);
}

function indentedSymbolEnd(lines, startIndex, maximumLines) {
  const base = indentation(lines[startIndex]);
  let lastContent = startIndex;
  const limit = Math.min(lines.length, startIndex + maximumLines);
  for (let index = startIndex + 1; index < limit; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (indentation(lines[index]) <= base) break;
    lastContent = index;
  }
  return {
    endLine: lastContent + 1,
    truncated: lastContent + 1 === limit && limit < lines.length,
  };
}

function braceSymbolEnd(lines, startIndex, maximumLines) {
  const state = { blockComment: false, quote: "", escaped: false };
  let depth = 0;
  let opened = false;
  const limit = Math.min(lines.length, startIndex + maximumLines);
  for (let index = startIndex; index < limit; index += 1) {
    const line = lines[index];
    for (let cursor = 0; cursor < line.length; cursor += 1) {
      const character = line[cursor];
      const next = line[cursor + 1] || "";
      if (state.blockComment) {
        if (character === "*" && next === "/") {
          state.blockComment = false;
          cursor += 1;
        }
        continue;
      }
      if (state.quote) {
        if (state.escaped) {
          state.escaped = false;
        } else if (character === "\\") {
          state.escaped = true;
        } else if (character === state.quote) {
          state.quote = "";
        }
        continue;
      }
      if (character === "/" && next === "/") break;
      if (character === "/" && next === "*") {
        state.blockComment = true;
        cursor += 1;
        continue;
      }
      if (character === "'" || character === "\"" || character === "`") {
        state.quote = character;
        continue;
      }
      if (character === "{") {
        depth += 1;
        opened = true;
      } else if (character === "}" && opened) {
        depth -= 1;
        if (depth <= 0) return { endLine: index + 1, truncated: false };
      }
    }
    if (!opened && index - startIndex >= 7) break;
  }
  return {
    endLine: startIndex + 1,
    truncated: opened && limit < lines.length,
  };
}

function headingSymbolEnd(lines, startIndex, maximumLines) {
  const level = lines[startIndex].match(/^\s{0,3}(#{1,6})\s/)?.[1].length || 6;
  const limit = Math.min(lines.length, startIndex + maximumLines);
  let endIndex = startIndex;
  for (let index = startIndex + 1; index < limit; index += 1) {
    const nextLevel = lines[index].match(/^\s{0,3}(#{1,6})\s/)?.[1].length;
    if (nextLevel && nextLevel <= level) break;
    if (lines[index].trim()) endIndex = index;
  }
  return {
    endLine: endIndex + 1,
    truncated: endIndex + 1 === limit && limit < lines.length,
  };
}

function symbolSpan(lines, symbol, extension, maximumLines = 240) {
  const startIndex = Math.max(0, Number(symbol.line || 1) - 1);
  if (symbol.kind === "heading") return headingSymbolEnd(lines, startIndex, maximumLines);
  if (extension === ".py") return indentedSymbolEnd(lines, startIndex, maximumLines);
  return braceSymbolEnd(lines, startIndex, maximumLines);
}

function importsFromLine(line, extension) {
  const imports = [];
  const add = (specifier) => {
    if (specifier && !specifier.startsWith("node:")) imports.push(specifier);
  };
  let match;
  if ((match = line.match(/\b(?:import|export)\b[\s\S]*?\bfrom\s*["']([^"']+)["']/))) add(match[1]);
  if ((match = line.match(/^\s*import\s*["']([^"']+)["']/))) add(match[1]);
  if ((match = line.match(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/))) add(match[1]);
  if ((match = line.match(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/))) add(match[1]);
  if ((match = line.match(/^\s*import\s+([A-Za-z_][\w.]*)/)) && extension === ".py") add(match[1]);
  if ((match = line.match(/^\s*(?:use|mod)\s+([A-Za-z_][\w:]*)/))) add(match[1].replace(/::/g, "/"));
  if ((match = line.match(/^\s*#include\s*[<"]([^>"]+)[>"]/))) add(match[1]);
  if ((match = line.match(/^\s*using\s+([A-Za-z_][\w.]*)\s*;/))) add(match[1]);
  if ((match = line.match(/^\s*import\s+([A-Za-z_][\w.*]*)\s*;/))) add(match[1]);
  if ((match = line.match(/^\s*require(?:_relative)?\s+["']([^"']+)["']/))) add(match[1]);
  return imports;
}

function extractFacts(text, relative) {
  const extension = path.extname(relative).toLowerCase();
  const lines = String(text).split(/\r?\n/);
  const symbols = [];
  const imports = [];
  const lexical = new Set(tokenize(relative));
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const specifier of importsFromLine(line, extension)) {
      imports.push({ specifier, line: index + 1 });
      for (const term of tokenize(specifier)) lexical.add(term);
    }
    for (const [kind, pattern] of SYMBOL_PATTERNS) {
      const match = line.match(pattern);
      if (!match) continue;
      const name = match[1].trim();
      symbols.push({
        name,
        kind,
        line: index + 1,
        signature: line.trim().slice(0, 240),
      });
      for (const term of tokenize(name)) lexical.add(term);
      break;
    }
    if (lexical.size < 2_000) {
      for (const term of tokenize(line)) lexical.add(term);
    }
  }
  const boundedSymbols = symbols.slice(0, 600).map((symbol) => {
    const span = symbolSpan(lines, symbol, extension);
    return {
      ...symbol,
      end_line: Math.max(symbol.line, span.endLine),
      ...(span.truncated ? { span_truncated: true } : {}),
    };
  });
  return {
    language: languageFor(extension),
    role: roleFor(relative, extension),
    dynamic: DYNAMIC_EXTENSIONS.has(extension),
    lines: lines.length,
    symbols: boundedSymbols,
    imports: imports.slice(0, 600),
    terms: [...lexical].slice(0, 2_000),
  };
}

function resolveSpecifier(fromRelative, specifier, paths) {
  if (!specifier) return null;
  const normalized = slash(specifier).replace(/^~\//, "");
  const candidates = [];
  const fromDirectory = path.posix.dirname(slash(fromRelative));
  if (normalized.startsWith(".")) {
    candidates.push(path.posix.normalize(path.posix.join(fromDirectory, normalized)));
  } else if (normalized.includes("/") && !normalized.startsWith("@")) {
    candidates.push(normalized);
  }
  if (/^[A-Za-z_][\w.]*$/.test(normalized)) {
    candidates.push(normalized.replace(/\./g, "/"));
  }
  const extensions = [...SOURCE_EXTENSIONS];
  for (const base of unique(candidates, 20)) {
    const direct = base.replace(/^\.\//, "");
    if (paths.has(direct)) return direct;
    for (const extension of extensions) {
      if (paths.has(`${direct}${extension}`)) return `${direct}${extension}`;
      if (paths.has(`${direct}/index${extension}`)) return `${direct}/index${extension}`;
      if (paths.has(`${direct}/mod${extension}`)) return `${direct}/mod${extension}`;
    }
  }
  return null;
}

function buildEdges(files) {
  const paths = new Set(Object.keys(files));
  const edges = {};
  for (const [relative, file] of Object.entries(files)) {
    const targets = file.imports
      .map((entry) => resolveSpecifier(relative, entry.specifier, paths))
      .filter(Boolean);
    edges[relative] = unique(targets, 1_000);
  }
  return edges;
}

function summarizeIndex(index) {
  const values = Object.values(index.files);
  const byLanguage = {};
  const byRole = {};
  let symbols = 0;
  let imports = 0;
  for (const file of values) {
    byLanguage[file.language] = (byLanguage[file.language] || 0) + 1;
    byRole[file.role] = (byRole[file.role] || 0) + 1;
    symbols += file.symbols.length;
    imports += file.imports.length;
  }
  return {
    files: values.length,
    bytes: values.reduce((total, file) => total + file.bytes, 0),
    lines: values.reduce((total, file) => total + file.lines, 0),
    symbols,
    imports,
    resolved_edges: Object.values(index.edges).reduce((total, targets) => total + targets.length, 0),
    dynamic_files: values.filter((file) => file.dynamic).length,
    languages: byLanguage,
    roles: byRole,
  };
}

function loadIndex(root) {
  const locations = projectPaths(root);
  const index = readJson(locations.index, null);
  if (!index || index.version !== INDEX_VERSION || index.root !== slash(root)) return null;
  return index;
}

function resolveProjectRoot(args = {}) {
  const supplied = (key) => Object.prototype.hasOwnProperty.call(args, key);
  const validate = (key) => {
    const value = args[key];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`project payload.${key} must be a non-empty path`);
    }
    return value;
  };
  const canonicalize = (value) => {
    const resolved = path.resolve(value);
    let canonical;
    try {
      canonical = fs.realpathSync(resolved);
    } catch (error) {
      throw new Error(`project root does not exist: ${resolved}`, { cause: error });
    }
    if (!fs.statSync(canonical).isDirectory()) {
      throw new Error(`project root is not a directory: ${slash(canonical)}`);
    }
    return slash(canonical);
  };
  return supplied("root")
    ? canonicalize(validate("root"))
    : canonicalize(supplied("cwd") ? validate("cwd") : process.cwd());
}

function renderScanReceipt(result) {
  const stats = result.stats;
  const languages = Object.entries(stats.languages)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([name, count]) => `${name}:${count}`)
    .join(",");
  return [
    `[Capsule project scan ${result.cache_mode}; files=${stats.files}; changed=${result.changed}; reused=${result.reused}; deleted=${result.deleted}]`,
    `symbols=${stats.symbols}; edges=${stats.resolved_edges}; lines=${stats.lines}; dynamic=${stats.dynamic_files}`,
    `languages=${languages || "none"}`,
    `semantic_index=${result.exact}`,
  ].join("\n");
}

function scanProject(args = {}) {
  const root = resolveProjectRoot(args);
  const locations = projectPaths(root);
  const previous = loadIndex(root);
  const survey = walkProject(root, args);
  const fastCache = args.fast_cache !== false && process.env.CAPSULE_PROJECT_FAST_CACHE !== "0";
  const files = {};
  let changed = 0;
  let reused = 0;
  let metadataReused = 0;
  let hashed = 0;
  for (const candidate of survey.files) {
    const old = previous?.files?.[candidate.relative];
    if (
      fastCache &&
      old &&
      Number(old.bytes) === Number(candidate.size) &&
      Number(old.mtime_ms) === Number(candidate.mtime_ms)
    ) {
      files[candidate.relative] = {
        ...old,
        bytes: candidate.size,
        mtime_ms: candidate.mtime_ms,
      };
      reused += 1;
      metadataReused += 1;
      continue;
    }
    const content = fs.readFileSync(candidate.absolute, "utf8");
    const contentHash = sha256(content);
    hashed += 1;
    if (old && old.hash === contentHash) {
      files[candidate.relative] = {
        ...old,
        bytes: candidate.size,
        mtime_ms: candidate.mtime_ms,
      };
      reused += 1;
      continue;
    }
    changed += 1;
    files[candidate.relative] = {
      path: candidate.relative,
      hash: contentHash,
      bytes: candidate.size,
      mtime_ms: candidate.mtime_ms,
      ...extractFacts(content, candidate.relative),
    };
  }
  const deleted = previous
    ? Object.keys(previous.files).filter((relative) => !files[relative]).length
    : 0;
  const index = {
    version: INDEX_VERSION,
    project_id: locations.id,
    root,
    created_at: previous?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    files,
    edges: buildEdges(files),
    survey: {
      truncated: survey.truncated,
      ignored_large: survey.ignored_large,
      ignored_symlinks: survey.ignored_symlinks,
    },
  };
  index.stats = summarizeIndex(index);
  writeJsonAtomic(locations.index, index);
  const archived = core.saveCapsule({
    kind: "project-semantic-index",
    source: `project:${root}`,
    text: JSON.stringify(index),
    question: args.query || args.question || "",
    maxChars: integer(args.max_chars, 4_000, 500, 20_000),
    details: {
      project_id: locations.id,
      changed,
      reused,
      deleted,
    },
  });
  const projectGc = maintainProjectCache({
    protect_id: locations.id,
    max_projects: args.cache_max_projects,
    max_bytes: args.cache_max_bytes,
    ttl_days: args.cache_ttl_days,
  });
  const response = {
    operation: "scan",
    project_id: locations.id,
    root,
    cache_mode: previous ? (changed || deleted ? "incremental" : "warm") : "cold",
    changed,
    reused,
    deleted,
    stats: index.stats,
    survey: index.survey,
    cache_validation: fastCache ? "mtime+size" : "sha256",
    metadata_reused: metadataReused,
    hashed,
    exact: archived.response.capsule_id,
    cache_gc: projectGc,
  };
  return {
    response,
    responseText: renderScanReceipt(response),
    capturedChars: archived.capturedChars,
    route: "project-compiler",
  };
}

function fitRefactorText(text, maximumChars, maximumTokens) {
  const source = String(text || "");
  const characterBound = source.slice(0, Math.max(0, maximumChars));
  if (core.estimateTokens(characterBound) <= maximumTokens) return characterBound;
  let low = 0;
  let high = characterBound.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = characterBound.slice(0, middle);
    if (core.estimateTokens(candidate) <= maximumTokens) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best.trimEnd();
}

function refactorProject(args = {}) {
  const root = resolveProjectRoot(args);
  const scan = scanProject({
    ...args,
    root,
    max_files: args.scan_max_files == null ? 50_000 : args.scan_max_files,
  });
  const index = loadIndex(root);
  const target = String(args.target || args.query || args.question || "").trim();
  if (!target) throw new Error("project refactor requires payload.target, query, or question");
  const rawTerms = unique(tokenize(target), 32);
  const terms = rawTerms.filter((term) => !QUERY_STOPWORDS.has(term));
  const searchTerms = terms.length ? terms : rawTerms;
  const symbolHits = [];
  for (const file of Object.values(index.files)) {
    for (const symbol of file.symbols) {
      const name = symbol.name.toLowerCase();
      const exact = searchTerms.some((term) => name === term);
      const partial = searchTerms.some((term) => name.includes(term));
      if (exact || partial) {
        symbolHits.push({
          path: file.path,
          symbol,
          score: (exact ? 40 : 18) + (symbol.kind === "function" ? 4 : 0),
          exact,
        });
      }
    }
  }
  const ranked = Object.values(index.files)
    .map((file) => ({ file, ...scoreFile(target, searchTerms, file) }))
    .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path));
  const seedLimit = integer(args.seed_limit, 4, 1, 12);
  const seeds = unique([
    ...symbolHits.filter((hit) => hit.exact).sort((left, right) => right.score - left.score).map((hit) => hit.path),
    ...symbolHits.sort((left, right) => right.score - left.score).map((hit) => hit.path),
    ...ranked.filter((item) => item.score > 0).map((item) => item.file.path),
  ], seedLimit);
  if (!seeds.length) throw new Error(`refactor target was not found in the semantic index: ${target}`);
  const depth = integer(args.depth, 2, 0, 4);
  const maximumFiles = integer(args.max_files, 12, 1, 48);
  const direction = ["forward", "reverse", "both"].includes(args.direction)
    ? args.direction
    : "both";
  const distances = cone(
    index,
    seeds,
    depth,
    direction,
    Math.min(index.stats.files, Math.max(maximumFiles, maximumFiles * 4)),
  );
  const centrality = graphRanks(index, direction);
  const hitByPath = new Map();
  for (const hit of symbolHits) {
    const prior = hitByPath.get(hit.path) || { score: 0, symbols: [] };
    prior.score = Math.max(prior.score, hit.score);
    prior.symbols.push(hit.symbol);
    hitByPath.set(hit.path, prior);
  }
  const selectedPaths = [...distances.keys()]
    .sort((left, right) => {
      const leftHit = hitByPath.get(left)?.score || 0;
      const rightHit = hitByPath.get(right)?.score || 0;
      return distances.get(left) - distances.get(right)
        || rightHit - leftHit
        || (centrality.get(right) || 0) - (centrality.get(left) || 0)
        || left.localeCompare(right);
    })
    .slice(0, maximumFiles);
  const reverse = reverseEdges(index);
  const selectedSet = new Set(selectedPaths);
  const selected = selectedPaths.map((relative) => {
    const file = index.files[relative];
    const hitSymbols = hitByPath.get(relative)?.symbols || [];
    const symbols = (hitSymbols.length ? hitSymbols : file.symbols.slice(0, 3))
      .slice(0, 8)
      .map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        line: symbol.line,
        end_line: symbol.end_line || symbol.line,
        signature: symbol.signature,
        ...(symbol.span_truncated ? { span_truncated: true } : {}),
      }));
    return {
      path: relative,
      hash: file.hash,
      role: file.role,
      language: file.language,
      lines: file.lines,
      via: distances.get(relative) === 0 ? "seed" : `graph:${distances.get(relative)}`,
      symbols,
      imports: (index.edges[relative] || []).slice(0, 12),
      importers: (reverse[relative] || []).slice(0, 12),
      centrality: Number((centrality.get(relative) || 0).toFixed(8)),
    };
  });
  const tests = Object.values(index.files)
    .filter((file) => file.role === "test")
    .map((file) => {
      const linked = (index.edges[file.path] || []).some((pathName) => selectedSet.has(pathName));
      const mentions = searchTerms.some((term) => file.path.toLowerCase().includes(term) || file.terms.includes(term));
      return { file, score: (linked ? 30 : 0) + (mentions ? 18 : 0) + (selectedSet.has(file.path) ? 20 : 0) };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path))
    .slice(0, integer(args.max_tests, 6, 1, 16))
    .map((item) => ({
      path: item.file.path,
      hash: item.file.hash,
      score: item.score,
      via: item.score >= 30 ? "dependency" : "term",
    }));
  const manifest = {
    version: 1,
    operation: "refactor",
    root,
    project_id: index.project_id,
    target,
    index_exact: scan.response.exact,
    terms: searchTerms,
    direction,
    depth,
    seeds,
    files: selected,
    tests,
    guardrails: [
      "edit only hash-matching files",
      "use symbol line spans as anchors",
      "run impacted tests before the full suite",
      "expand exact evidence only when an anchor conflicts",
    ],
  };
  const archived = core.saveCapsule({
    kind: "project-refactor-plan",
    source: `project-refactor:${root}:${sha256(target).slice(0, 16)}`,
    text: JSON.stringify(manifest),
    question: target,
    maxChars: integer(args.archive_max_chars, 16_000, 1_000, 64_000),
    details: {
      project_id: index.project_id,
      selected_files: selected.length,
      tests: tests.length,
    },
  });
  const maximumChars = integer(args.max_chars, 6_000, 800, 24_000);
  const maximumTokens = integer(args.max_tokens, core.approxTokens(maximumChars), 64, 12_000);
  const targetLabel = target.length <= 280 ? target : `${target.slice(0, 264)}…#${sha256(target).slice(0, 12)}`;
  const fileLines = selected.map((file) => {
    const symbols = file.symbols.map((symbol) => `${symbol.name}@${symbol.line}-${symbol.end_line}`).join(",") || "-";
    const edges = [...file.imports, ...file.importers].slice(0, 8).join(",") || "-";
    return `F: ${file.path} [${file.via};${file.role};hash=${file.hash.slice(0, 12)}] S=${symbols} E=${edges}`;
  });
  const testLine = tests.length
    ? `T: ${tests.map((test) => `${test.path}[${test.hash.slice(0, 12)}]`).join(",")}`
    : "T: no indexed impacted test; search explicitly before editing";
  const candidateText = fitRefactorText([
    `[Capsule refactor-plan v1; target=${JSON.stringify(targetLabel)}; cone=${selected.length}/${distances.size}; cache=${scan.response.cache_mode}]`,
    `R: seeds=${seeds.join(",")}; direction=${direction}; depth=${depth}; metadata_reused=${scan.response.metadata_reused}; hashed=${scan.response.hashed}`,
    ...fileLines,
    testLine,
    "G: edit only hash-matching anchors; run T first; expand exact capsule only on conflict; then full suite.",
    `X: exact=${archived.response.capsule_id}; manifest_files=${selected.length}; proof=hash+span+dependency-cone`,
  ].join("\n"), maximumChars, maximumTokens);
  const baselineText = JSON.stringify({ target, files: selected, tests });
  const baselineTokens = core.estimateTokens(baselineText);
  const activationReserve = integer(args.activation_reserve_tokens, 48, 0, 1_000);
  const profitable = core.tokenSafe(
    baselineText,
    candidateText,
    Number(args.safety_ratio) || 0.98,
    activationReserve,
  );
  const responseText = profitable
    ? candidateText
    : `[Capsule refactor-plan passthrough; target=${JSON.stringify(targetLabel)}; ` +
      `exact=${archived.response.capsule_id}; files=${selected.length}; tests=${tests.length}; ` +
      "expand exact manifest before editing.]";
  const emittedTokens = core.estimateTokens(responseText);
  const packet = {
    operation: "refactor",
    root,
    project_id: index.project_id,
    target,
    cache_mode: scan.response.cache_mode,
    changed: scan.response.changed,
    reused: scan.response.reused,
    metadata_reused: scan.response.metadata_reused,
    hashed: scan.response.hashed,
    seeds,
    direction,
    depth,
    selected_files: selected,
    tests,
    exact: archived.response.capsule_id,
    index_exact: scan.response.exact,
    guardrails: manifest.guardrails,
    profit_gate: {
      profitable,
      baseline_kind: "symbol-hash-impact-manifest",
      baseline_tokens: baselineTokens,
      emitted_tokens: emittedTokens,
      avoided_tokens: Math.max(0, baselineTokens - emittedTokens),
      avoided_ratio: baselineTokens
        ? Number((Math.max(0, baselineTokens - emittedTokens) / baselineTokens).toFixed(4))
        : 0,
      activation_reserve_tokens: activationReserve,
    },
  };
  return {
    response: packet,
    responseText,
    capturedChars: JSON.stringify(manifest).length + archived.capturedChars,
    route: "project-refactor-proof",
  };
}

function reverseEdges(index) {
  const reverse = {};
  for (const relative of Object.keys(index.files)) reverse[relative] = [];
  for (const [from, targets] of Object.entries(index.edges)) {
    for (const target of targets) {
      if (reverse[target]) reverse[target].push(from);
    }
  }
  return reverse;
}

function graphRanks(index, direction = "both", iterations = 12, damping = 0.85) {
  const nodes = Object.keys(index.files).sort();
  if (!nodes.length) return new Map();
  const reverse = reverseEdges(index);
  const nodeSet = new Set(nodes);
  const adjacency = new Map(nodes.map((node) => {
    const neighbors = direction === "forward"
      ? index.edges[node] || []
      : direction === "reverse"
        ? reverse[node] || []
        : [...(index.edges[node] || []), ...(reverse[node] || [])];
    return [node, [...new Set(neighbors)].filter((neighbor) => nodeSet.has(neighbor)).sort()];
  }));
  const uniform = 1 / nodes.length;
  let ranks = new Map(nodes.map((node) => [node, uniform]));
  const rounds = integer(iterations, 12, 1, 40);
  const factor = Math.min(0.99, Math.max(0.01, Number(damping) || 0.85));
  for (let round = 0; round < rounds; round += 1) {
    const next = new Map(nodes.map((node) => [node, (1 - factor) * uniform]));
    let dangling = 0;
    for (const node of nodes) {
      const neighbors = adjacency.get(node);
      const rank = ranks.get(node) || 0;
      if (!neighbors.length) {
        dangling += rank;
        continue;
      }
      const share = factor * rank / neighbors.length;
      for (const neighbor of neighbors) next.set(neighbor, next.get(neighbor) + share);
    }
    const danglingShare = factor * dangling * uniform;
    if (danglingShare) {
      for (const node of nodes) next.set(node, next.get(node) + danglingShare);
    }
    ranks = next;
  }
  return ranks;
}

function intentBoost(query, file) {
  const pathLower = file.path.toLowerCase();
  let score = 0;
  const rules = [
    [/\btest|spec|coverage|failing\b/i, file.role === "test"],
    [/\bconfig|build|deploy|environment|dependency\b/i, file.role === "config"],
    [/\bentry|start|boot|request|route|api\b/i, file.role === "entry"],
    [/\bdispatch|mcp|action|tool\b/i, file.role === "entry"],
    [/\bschema|database|migration|model|query\b/i, file.role === "data"],
    [/\bdoc|readme|usage|guide\b/i, file.role === "docs"],
    [/\bauth|login|session|token\b/i, /auth|login|session|token/.test(pathLower)],
    [/\bui|frontend|component|page|view\b/i, /component|page|view|ui|frontend/.test(pathLower)],
  ];
  for (const [pattern, matched] of rules) if (pattern.test(query) && matched) score += 8;
  return score;
}

function scoreFile(query, terms, file, weights = new Map()) {
  const pathLower = file.path.toLowerCase();
  const symbolText = file.symbols.map((symbol) => symbol.name.toLowerCase());
  const importText = file.imports.map((entry) => entry.specifier.toLowerCase());
  const lexical = new Set(file.terms);
  let score = intentBoost(query, file);
  const reasons = [];
  for (const term of terms) {
    let termScore = 0;
    if (pathLower.includes(term)) termScore += 10;
    if (symbolText.some((name) => name === term)) termScore += 18;
    else if (symbolText.some((name) => name.includes(term))) termScore += 12;
    if (importText.some((name) => name.includes(term))) termScore += 6;
    if (lexical.has(term)) termScore += 2;
    if (termScore) {
      const weighted = Number((termScore * (weights.get(term) || 1)).toFixed(2));
      score += weighted;
      reasons.push(`${term}:${weighted}`);
    }
  }
  if (!terms.length && ["entry", "config", "docs"].includes(file.role)) score += 2;
  const asksForTests = /\btests?|specs?|coverage|failing\b/i.test(query);
  const asksForDocs = /\bdocs?|readme|guide|usage|documentation\b/i.test(query);
  const asksForBenchmarks = /\bbenchmarks?|performance|measure|measurement\b/i.test(query);
  if (file.role === "test" && !asksForTests) score *= 0.35;
  if (file.role === "docs" && !asksForDocs) score *= 0.5;
  if (/^(?:bench|benchmark)\//i.test(file.path) && !asksForBenchmarks) score *= 0.35;
  return { score, reasons };
}

function cone(index, seeds, depth, direction, limit) {
  const reverse = reverseEdges(index);
  const distances = new Map(seeds.map((seed) => [seed, 0]));
  const queue = [...seeds];
  while (queue.length && distances.size < limit) {
    const current = queue.shift();
    const distance = distances.get(current);
    if (distance >= depth) continue;
    const neighbors = direction === "forward"
      ? index.edges[current] || []
      : direction === "reverse"
        ? reverse[current] || []
        : [...(index.edges[current] || []), ...(reverse[current] || [])];
    for (const neighbor of neighbors) {
      if (distances.has(neighbor)) continue;
      distances.set(neighbor, distance + 1);
      queue.push(neighbor);
      if (distances.size >= limit) break;
    }
  }
  return distances;
}

function boundedEvidence(text, maximumChars) {
  if (text.length <= maximumChars) return { text, complete: true };
  const marker = "\n… exact body continues in capsule …\n";
  if (maximumChars <= marker.length + 2) {
    if (maximumChars <= 1) return { text: "…".slice(0, Math.max(0, maximumChars)), complete: false };
    return {
      text: `${text.slice(0, maximumChars - 1)}…`,
      complete: false,
    };
  }
  const available = Math.max(2, maximumChars - marker.length);
  const head = Math.ceil(available * 0.7);
  const tail = available - head;
  return {
    text: `${text.slice(0, head)}${marker}${text.slice(-tail)}`,
    complete: false,
  };
}

function evidenceForFile(root, file, terms, maximumExcerpts, maximumSymbolChars = 2_400) {
  const text = fs.readFileSync(path.join(root, file.path), "utf8");
  const lines = text.split(/\r?\n/);
  const preferred = [];
  const add = (start, end, details = {}) => {
    preferred.push({
      start: Math.max(1, start),
      end: Math.min(lines.length, Math.max(start, end)),
      ...details,
    });
  };
  for (const symbol of file.symbols) {
    if (!terms.length || terms.some((term) => symbol.name.toLowerCase().includes(term))) {
      add(
        symbol.line,
        terms.length ? (symbol.end_line || symbol.line) : symbol.line,
        {
          kind: terms.length ? "symbol-body" : "symbol-signature",
          symbol: symbol.name,
          span_truncated: Boolean(symbol.span_truncated),
        },
      );
    }
  }
  for (const entry of file.imports) {
    if (terms.some((term) => entry.specifier.toLowerCase().includes(term))) {
      add(entry.line, entry.line, { kind: "import" });
    }
  }
  if (terms.length) {
    for (let index = 0; index < lines.length && preferred.length < maximumExcerpts * 4; index += 1) {
      const lower = lines[index].toLowerCase();
      if (terms.some((term) => lower.includes(term))) {
        add(index, index + 2, { kind: "lexical" });
      }
    }
  }
  if (!preferred.length) {
    for (const symbol of file.symbols.slice(0, maximumExcerpts)) {
      add(symbol.line, symbol.line, { kind: "symbol-signature", symbol: symbol.name });
    }
  }
  if (!preferred.length && lines.length) add(1, 1, { kind: "file-head" });
  const selected = [];
  const seen = new Set();
  for (const range of preferred) {
    if (selected.length >= maximumExcerpts) break;
    if (selected.some((item) => range.start >= item.start_line && range.end <= item.end_line)) continue;
    const key = `${range.start}:${range.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const raw = lines.slice(range.start - 1, range.end).join("\n");
    const bounded = boundedEvidence(
      raw,
      range.kind === "symbol-body" ? maximumSymbolChars : Math.min(600, maximumSymbolChars),
    );
    selected.push({
      start_line: range.start,
      end_line: range.end,
      kind: range.kind,
      ...(range.symbol ? { symbol: range.symbol } : {}),
      complete: bounded.complete && !range.span_truncated,
      excerpt: redactVisible(bounded.text),
    });
  }
  return { text, excerpts: selected };
}

function compactList(label, values, limit = 8, maximumChars = 480) {
  if (!values.length) return "";
  const selected = values.slice(0, limit);
  const omitted = Math.max(0, values.length - selected.length);
  const suffix = omitted ? `, +${omitted}` : "";
  return `${label}: ${selected.join(", ")}${suffix}`.slice(0, maximumChars);
}

function filePacketHeader(file) {
  return [
    `@${file.path} role=${file.role} lang=${file.language} score=${file.score} via=${file.via}`,
    compactList("symbols", file.symbols, 8),
    compactList("imports", file.imports, 6),
  ].filter(Boolean).join("\n");
}

function evidencePriority(evidence) {
  const kind = {
    "symbol-body": 80,
    "symbol-signature": 45,
    import: 30,
    lexical: 20,
    "file-head": 10,
  }[evidence.kind] || 5;
  return kind + (evidence.complete ? 12 : 0);
}

function evidencePacketLine(evidence, maximumChars = Infinity, maximumTokens = Infinity) {
  const identity = [
    `L${evidence.start_line}-${evidence.end_line}`,
    evidence.kind || "evidence",
    evidence.symbol ? `symbol=${evidence.symbol}` : "",
  ].filter(Boolean).join(" ");
  const available = Number.isFinite(maximumChars)
    ? Math.max(1, Math.floor(maximumChars) - identity.length - 2)
    : evidence.excerpt.length;
  const render = (limit) => {
    const bounded = boundedEvidence(evidence.excerpt, Math.max(1, limit));
    return {
      text: `${identity}: ${bounded.text}`,
      complete: Boolean(evidence.complete && bounded.complete),
    };
  };
  let rendered = render(available);
  if (!Number.isFinite(maximumTokens) || core.estimateTokens(rendered.text) <= maximumTokens) {
    return rendered;
  }

  // Find the largest whole evidence atom that also fits the token share. This
  // keeps the coverage pass fair even when code has far more tokens per
  // character than prose.
  let low = 1;
  let high = available;
  let best = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = render(middle);
    if (core.estimateTokens(candidate.text) <= maximumTokens) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best || render(1);
}

function renderQueryPacket(packet, maximumChars, maximumTokens = core.approxTokens(maximumChars)) {
  const queryLimit = Math.max(80, Math.min(420, Math.floor(maximumChars * 0.22)));
  const query = packet.query.length <= queryLimit
    ? packet.query
    : `${packet.query.slice(0, Math.max(1, queryLimit - 18))}…#${sha256(packet.query).slice(0, 12)}`;
  const prefix = [
    `[Capsule project query; selected=${packet.selected_files.length}/${packet.index.files}; depth=${packet.impact.depth}; exact=${packet.exact}]`,
    `q=${JSON.stringify(query)}`,
  ].join("\n");
  const totalEvidence = packet.selected_files.reduce((sum, file) => sum + file.evidence.length, 0);
  const footerFor = (visibleFiles, visibleEvidence, truncatedEvidence, tokens, chars) => [
    `packing: visible_files=${visibleFiles}/${packet.selected_files.length}; ` +
      `evidence=${visibleEvidence}/${totalEvidence}; truncated=${truncatedEvidence}; ` +
      `tokens=${tokens}/${maximumTokens}; ` +
      `chars=${chars}/${maximumChars}; exact_recovery=${packet.exact}`,
    `exclusion: ${packet.impact.excluded_files} files outside selected score/cone; ` +
      `resolved_graph=${packet.impact.resolved_edges}; dynamic_files=${packet.impact.dynamic_files}`,
    packet.uncertainty.length ? `uncertainty: ${packet.uncertainty.join("; ").slice(0, 260)}` : "",
  ].filter(Boolean).join("\n");
  const footerReserve = footerFor(
    packet.selected_files.length,
    totalEvidence,
    totalEvidence,
    maximumTokens,
    maximumChars,
  );
  const characterBudget = Math.max(0, maximumChars - prefix.length - footerReserve.length - 4);
  const tokenBudget = Math.max(
    0,
    // Token estimation is not perfectly additive across joined blocks. Keep a
    // small boundary reserve for separators and telemetry digits.
    maximumTokens - core.estimateTokens(prefix) - core.estimateTokens(footerReserve) - 12,
  );
  const chosen = new Map();
  let usedChars = 0;
  let usedTokens = 0;

  const addEvidence = (
    file,
    evidence,
    maximumAtomChars = Infinity,
    maximumAtomTokens = Infinity,
  ) => {
    const current = chosen.get(file.path);
    const header = current ? "" : filePacketHeader(file);
    const line = evidencePacketLine(evidence, maximumAtomChars, maximumAtomTokens);
    const addition = [header, line.text].filter(Boolean).join("\n");
    const separatorCost = current ? 1 : (chosen.size ? 2 : 0);
    const additionChars = addition.length + separatorCost;
    const additionTokens = core.estimateTokens(addition) + separatorCost;
    if (usedChars + additionChars > characterBudget || usedTokens + additionTokens > tokenBudget) return false;
    if (current) current.evidence.push({ source: evidence, rendered: line });
    else chosen.set(file.path, { file, header, evidence: [{ source: evidence, rendered: line }] });
    usedChars += additionChars;
    usedTokens += additionTokens;
    return true;
  };

  // Coverage pass: buy a compact proof atom for every ranked file before any
  // earlier file may spend the shared remainder on a larger body.
  for (let index = 0; index < packet.selected_files.length; index += 1) {
    const file = packet.selected_files[index];
    const evidence = [...file.evidence].sort((left, right) =>
      evidencePriority(right) - evidencePriority(left)
      || left.start_line - right.start_line
      || left.end_line - right.end_line
    )[0];
    if (!evidence) continue;
    const remainingFiles = Math.max(1, packet.selected_files.length - index);
    const header = filePacketHeader(file);
    const fairChars = Math.floor((characterBudget - usedChars) / remainingFiles);
    const fairTokens = Math.floor((tokenBudget - usedTokens) / remainingFiles);
    addEvidence(
      file,
      evidence,
      Math.max(1, Math.min(128, fairChars - header.length - 2)),
      Math.max(1, Math.min(40, fairTokens - core.estimateTokens(header) - 1)),
    );
  }

  // Expansion pass: after diversity is secured, widen each primary atom with an
  // equal share of what remains. Replacing an atom costs only its delta.
  const covered = [...chosen.values()];
  for (let index = 0; index < covered.length; index += 1) {
    const entry = covered[index];
    const item = entry.evidence[0];
    if (!item || item.rendered.complete) continue;
    const remainingFiles = Math.max(1, covered.length - index);
    const oldChars = item.rendered.text.length;
    const oldTokens = core.estimateTokens(item.rendered.text);
    const extraChars = Math.max(0, Math.floor((characterBudget - usedChars) / remainingFiles));
    const extraTokens = Math.max(0, Math.floor((tokenBudget - usedTokens) / remainingFiles));
    const expanded = evidencePacketLine(
      item.source,
      oldChars + extraChars,
      oldTokens + extraTokens,
    );
    const deltaChars = expanded.text.length - oldChars;
    const deltaTokens = core.estimateTokens(expanded.text) - oldTokens;
    if (
      deltaChars >= 0
      && deltaTokens >= 0
      && usedChars + deltaChars <= characterBudget
      && usedTokens + deltaTokens <= tokenBudget
    ) {
      item.rendered = expanded;
      usedChars += deltaChars;
      usedTokens += deltaTokens;
    }
  }

  // Utility-per-token pass: add whole remaining atoms with stable tie breaks.
  const remaining = packet.selected_files.flatMap((file, fileIndex) =>
    file.evidence.map((evidence, evidenceIndex) => ({ file, fileIndex, evidence, evidenceIndex }))
  ).filter((candidate) => !chosen.get(candidate.file.path)?.evidence.some(
    (item) => item.source === candidate.evidence
  )).map((candidate) => {
    const text = evidencePacketLine(candidate.evidence).text;
    const tokens = Math.max(1, core.estimateTokens(text));
    const novelty = chosen.has(candidate.file.path) ? 0 : 24;
    const utility = evidencePriority(candidate.evidence) + Number(candidate.file.score || 0) + novelty;
    return { ...candidate, utility, tokens, ratio: utility / tokens };
  }).sort((left, right) =>
    right.ratio - left.ratio
    || right.utility - left.utility
    || left.fileIndex - right.fileIndex
    || left.evidenceIndex - right.evidenceIndex
  );
  for (const candidate of remaining) addEvidence(candidate.file, candidate.evidence);

  const blocks = [...chosen.values()].map((entry) => [
    entry.header,
    ...entry.evidence.map((item) => item.rendered.text),
  ].join("\n"));
  const visibleEvidence = [...chosen.values()].reduce((sum, entry) => sum + entry.evidence.length, 0);
  const truncatedEvidence = [...chosen.values()].reduce(
    (sum, entry) => sum + entry.evidence.filter((item) => !item.rendered.complete).length,
    0,
  );
  const body = blocks.join("\n\n");
  let emittedChars = 0;
  let emittedTokens = 0;
  let text = "";
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const footer = footerFor(
      chosen.size,
      visibleEvidence,
      truncatedEvidence,
      emittedTokens,
      emittedChars,
    );
    text = [prefix, body, footer].filter(Boolean).join("\n\n");
    const nextChars = text.length;
    const nextTokens = core.estimateTokens(text);
    if (nextChars === emittedChars && nextTokens === emittedTokens) break;
    emittedChars = nextChars;
    emittedTokens = nextTokens;
  }
  packet.packing = {
    strategy: "ranked-coverage+utility-per-token",
    maximum_chars: maximumChars,
    maximum_tokens: maximumTokens,
    emitted_chars: emittedChars,
    emitted_tokens: emittedTokens,
    visible_files: chosen.size,
    selected_files: packet.selected_files.length,
    visible_evidence: visibleEvidence,
    total_evidence: totalEvidence,
    truncated_evidence: truncatedEvidence,
    exact_recovery: packet.exact,
  };
  if (emittedChars > maximumChars || emittedTokens > maximumTokens) {
    throw new Error(
      `project packet budget invariant violated: chars=${emittedChars}/${maximumChars}; ` +
      `tokens=${emittedTokens}/${maximumTokens}; body_chars=${usedChars}/${characterBudget}; ` +
      `body_tokens=${usedTokens}/${tokenBudget}`,
    );
  }
  return text;
}

function queryProject(args = {}) {
  const root = resolveProjectRoot(args);
  const scan = scanProject({
    ...args,
    root,
    max_files: args.scan_max_files == null ? 50_000 : args.scan_max_files,
  });
  const index = loadIndex(root);
  const query = String(args.query || args.question || args.target || "").trim();
  if (!query) throw new Error("project query requires payload.query, question, or target");
  const rawTerms = unique(tokenize(query), 64);
  const filteredTerms = rawTerms.filter((term) => !QUERY_STOPWORDS.has(term));
  const terms = filteredTerms.length ? filteredTerms : rawTerms;
  const values = Object.values(index.files);
  const weights = new Map(terms.map((term) => {
    const documents = values.filter((file) =>
      file.path.toLowerCase().includes(term) ||
      file.symbols.some((symbol) => symbol.name.toLowerCase().includes(term)) ||
      file.imports.some((entry) => entry.specifier.toLowerCase().includes(term)) ||
      file.terms.includes(term)
    ).length;
    return [term, 1 + Math.log((values.length + 1) / (documents + 1))];
  }));
  const ranked = Object.values(index.files)
    .map((file) => ({ file, ...scoreFile(query, terms, file, weights) }))
    .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path));
  const seedLimit = integer(args.seed_limit, 6, 1, 30);
  let seeds = ranked.filter((item) => item.score > 0).slice(0, seedLimit).map((item) => item.file.path);
  if (!seeds.length) {
    seeds = ranked
      .filter((item) => ["entry", "config", "docs"].includes(item.file.role))
      .slice(0, seedLimit)
      .map((item) => item.file.path);
  }
  if (!seeds.length) seeds = ranked.slice(0, seedLimit).map((item) => item.file.path);
  const depth = integer(args.depth, 1, 0, 5);
  const maximumFiles = integer(args.max_files, 14, 1, 80);
  const direction = ["forward", "reverse", "both"].includes(args.direction)
    ? args.direction
    : "both";
  const candidateLimit = Math.min(
    index.stats.files,
    Math.max(maximumFiles, maximumFiles * 4),
  );
  const distances = cone(index, seeds, depth, direction, candidateLimit);
  const centrality = graphRanks(index, direction);
  const rankedByPath = new Map(ranked.map((item) => [item.file.path, item]));
  const selectedPaths = [...distances.keys()]
    .sort((left, right) => {
      const leftRank = rankedByPath.get(left)?.score || 0;
      const rightRank = rankedByPath.get(right)?.score || 0;
      const leftCentrality = centrality.get(left) || 0;
      const rightCentrality = centrality.get(right) || 0;
      return distances.get(left) - distances.get(right)
        || rightRank - leftRank
        || rightCentrality - leftCentrality
        || left.localeCompare(right);
    })
    .slice(0, maximumFiles);
  const maximumExcerpts = integer(args.excerpts_per_file, 3, 1, 12);
  const maximumSymbolChars = integer(args.symbol_max_chars, 2_400, 400, 12_000);
  const selected = [];
  const exactFiles = [];
  for (const relative of selectedPaths) {
    const file = index.files[relative];
    const rankedFile = ranked.find((item) => item.file.path === relative);
    const evidence = evidenceForFile(root, file, terms, maximumExcerpts, maximumSymbolChars);
    exactFiles.push({ path: relative, hash: file.hash, text: evidence.text });
    selected.push({
      path: relative,
      role: file.role,
      language: file.language,
      score: rankedFile?.score || 0,
      centrality: Number((centrality.get(relative) || 0).toFixed(8)),
      reasons: rankedFile?.reasons || [],
      via: distances.get(relative) === 0 ? "seed" : `graph:${distances.get(relative)}`,
      symbols: file.symbols.slice(0, 16).map((symbol) => `${symbol.kind}:${symbol.name}@${symbol.line}`),
      imports: file.imports.slice(0, 12).map((entry) => entry.specifier),
      evidence: evidence.excerpts,
    });
  }
  const dynamicSelected = selectedPaths.filter((relative) => index.files[relative].dynamic).length;
  const uncertainty = [];
  if (index.stats.dynamic_files) {
    uncertainty.push("dynamic imports/reflection may create unresolved edges; runtime traces can raise confidence");
  }
  if (index.survey.truncated) uncertainty.push("file survey reached max_files");
  if (index.survey.ignored_large) uncertainty.push(`${index.survey.ignored_large} oversized files were excluded`);
  const exactPayload = {
    operation: args.operation || "query",
    root,
    query,
    project_id: index.project_id,
    index_exact: scan.response.exact,
    selected_files: exactFiles,
    selected_semantics: selected,
    uncertainty,
  };
  const archived = core.saveCapsule({
    kind: "project-proof-packet",
    source: `project-query:${root}:${sha256(query).slice(0, 16)}`,
    text: JSON.stringify(exactPayload),
    question: query,
    maxChars: integer(args.max_chars, 12_000, 800, 48_000),
    details: {
      project_id: index.project_id,
      selected_files: selected.length,
      total_files: index.stats.files,
    },
  });
  const packet = {
    operation: args.operation || "query",
    project_id: index.project_id,
    root,
    query,
    index: index.stats,
    cache_mode: scan.response.cache_mode,
    changed: scan.response.changed,
    reused: scan.response.reused,
    selected_files: selected,
    impact: {
      direction,
      depth,
      seeds,
      rank_strategy: "lexical-idf+dependency-pagerank",
      candidates_ranked: distances.size,
      excluded_files: Math.max(0, index.stats.files - selected.length),
      resolved_edges: index.stats.resolved_edges,
      dynamic_files: dynamicSelected,
      negative_certificate: dynamicSelected
        ? "bounded static exclusion; unresolved dynamic edges remain"
        : "no resolved dependency path within the requested cone",
    },
    uncertainty,
    exact: archived.response.capsule_id,
    index_exact: scan.response.exact,
  };
  const maximumChars = integer(args.max_chars, 12_000, 800, 48_000);
  const maximumTokens = integer(args.max_tokens, core.approxTokens(maximumChars), 64, 24_000);
  const candidate = renderQueryPacket(packet, maximumChars, maximumTokens);
  const rawSelected = exactFiles.map((file) => `# ${file.path}\n${file.text}`).join("\n\n");
  const baselineTokens = core.estimateTokens(rawSelected);
  const candidateTokens = core.estimateTokens(candidate);
  const activationReserve = integer(args.activation_reserve_tokens, 48, 0, 1_000);
  const profitable = core.tokenSafe(
    rawSelected,
    candidate,
    Number(args.safety_ratio) || 0.98,
    activationReserve,
  );
  const responseText = profitable
    ? candidate
    : redactVisible(rawSelected.slice(0, maximumChars));
  const emittedTokens = core.estimateTokens(responseText);
  packet.profit_gate = {
    profitable,
    baseline_kind: "raw-selected-files",
    baseline_tokens: baselineTokens,
    candidate_tokens: candidateTokens,
    emitted_tokens: emittedTokens,
    activation_reserve_tokens: activationReserve,
    avoided_tokens: Math.max(0, baselineTokens - emittedTokens),
    avoided_ratio: baselineTokens
      ? Number((Math.max(0, baselineTokens - emittedTokens) / baselineTokens).toFixed(4))
      : 0,
  };
  return {
    response: packet,
    responseText,
    capturedChars: rawSelected.length + archived.capturedChars,
    route: profitable ? "project-proof-packet" : "project-profit-passthrough",
  };
}

function projectStatus(args = {}) {
  const root = resolveProjectRoot(args);
  const index = loadIndex(root);
  if (!index) {
    return {
      response: { operation: "status", root, indexed: false },
      capturedChars: 0,
      route: "project-compiler",
    };
  }
  return {
    response: {
      operation: "status",
      root,
      indexed: true,
      project_id: index.project_id,
      created_at: index.created_at,
      updated_at: index.updated_at,
      stats: index.stats,
      survey: index.survey,
      cache: maintainProjectCache({ protect_id: index.project_id }),
    },
    capturedChars: 0,
    route: "project-compiler",
  };
}

function dispatch(args = {}) {
  const operation = String(args.operation || (args.query || args.question ? "query" : "scan"));
  if (operation === "scan") return scanProject(args);
  if (operation === "query") return queryProject(args);
  if (operation === "refactor") return refactorProject(args);
  if (operation === "impact") {
    if (!args.target && !args.query) throw new Error("project impact requires payload.target or query");
    return queryProject({
      ...args,
      operation: "impact",
      query: args.target || args.query,
      direction: args.direction || "reverse",
      depth: args.depth == null ? 2 : args.depth,
    });
  }
  if (operation === "status") return projectStatus(args);
  if (operation === "gc") {
    if (Object.prototype.hasOwnProperty.call(args, "root")) {
      throw new Error("project gc is global and does not accept payload.root");
    }
    return {
      response: {
        operation: "gc",
        projects: maintainProjectCache({
          max_projects: args.cache_max_projects,
          max_bytes: args.cache_max_bytes,
          ttl_days: args.cache_ttl_days,
          include_ids: true,
        }),
        capsules: core.maintainCapsuleCache({
          max_entries: args.capsule_max_entries,
          max_bytes: args.capsule_max_bytes,
          ttl_days: args.capsule_ttl_days,
          min_recent: args.capsule_min_recent,
          include_ids: true,
        }),
      },
      capturedChars: 0,
      route: "project-cache-gc",
    };
  }
  throw new Error("project operation must be scan, query, refactor, impact, status, or gc");
}

module.exports = {
  dispatch,
  extractFacts,
  graphRanks,
  loadIndex,
  maintainProjectCache,
  queryProject,
  refactorProject,
  resolveProjectRoot,
  renderQueryPacket,
  scanProject,
};
