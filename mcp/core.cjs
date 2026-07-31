"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

const DEFAULT_MAX_CHARS = 800;
const MAX_RETURN_CHARS = 12000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_COMMAND_BYTES = 32 * 1024 * 1024;
const DEFAULT_PASSTHROUGH_CHARS = 1536;
const DEFAULT_CAPSULE_SAFETY_RATIO = 0.72;
const DEFAULT_ACTIVATION_RESERVE_TOKENS = 160;
const GPT_5_6_INPUT_PRICING_USD_PER_MILLION = Object.freeze({
  "gpt-5.6-sol": Object.freeze({
    short: Object.freeze({ input: 5, cached_input: 0.5 }),
    long: Object.freeze({ input: 10, cached_input: 1 }),
  }),
  "gpt-5.6-terra": Object.freeze({
    short: Object.freeze({ input: 2.5, cached_input: 0.25 }),
    long: Object.freeze({ input: 5, cached_input: 0.5 }),
  }),
  "gpt-5.6-luna": Object.freeze({
    short: Object.freeze({ input: 1, cached_input: 0.1 }),
    long: Object.freeze({ input: 2, cached_input: 0.2 }),
  }),
});
const GPT_5_6_PRICING_SOURCE = "https://developers.openai.com/api/docs/pricing";
const MIN_AUTO_LEXICAL_COVERAGE = 0.5;
// Keep the default conservative: a result future is only worthwhile when the
// captured output is clearly large enough to amortize its lookup metadata.
// This also makes the policy stable across Node versions and operating systems
// whose test-runner banners differ slightly in size.
const RESULT_FUTURE_MIN_REUSE_CHARS = 4096;
const DEFAULT_CAPSULE_CACHE_BYTES = 512 * 1024 * 1024;
const DEFAULT_CAPSULE_CACHE_ENTRIES = 10_000;
const DEFAULT_CAPSULE_CACHE_TTL_DAYS = 180;
const DEFAULT_CAPSULE_CACHE_MIN_RECENT = 256;
const SIGNAL_RE = /\b(error|fatal|exception|panic|failed?|warning|warn|todo|fixme|deprecated|security|denied|timeout)\b/i;
const STRUCTURE_RE = /^(?:\s{0,3}#{1,6}\s|\s*(?:class|function|interface|enum|def|fn|func|struct|impl)\s+|\s*["'][^"']+["']\s*:)/;

function clampInt(value, fallback, min, max) {
  const number = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback;
  return Math.max(min, Math.min(max, number));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function approxTokens(chars) {
  return Math.ceil(Math.max(0, Number(chars) || 0) / 4);
}

function estimateInputSavingsUsd(avoidedTokens, args = {}) {
  const requestedModel = String(
    args.pricing_model || args.model || process.env.CAPSULE_PRICING_MODEL || "gpt-5.6-sol"
  ).trim().toLowerCase();
  const model = requestedModel === "gpt-5.6" ? "gpt-5.6-sol" : requestedModel;
  const prices = GPT_5_6_INPUT_PRICING_USD_PER_MILLION[model] || GPT_5_6_INPUT_PRICING_USD_PER_MILLION["gpt-5.6-sol"];
  const contextTier = String(
    args.context_tier || process.env.CAPSULE_CONTEXT_TIER || "short"
  ).trim().toLowerCase() === "long" ? "long" : "short";
  const suppliedCachedShare = args.cached_share ?? process.env.CAPSULE_CACHED_SHARE;
  const parsedCachedShare = suppliedCachedShare == null || suppliedCachedShare === ""
    ? 0.5
    : Number(suppliedCachedShare);
  const cachedShare = Number.isFinite(parsedCachedShare)
    ? Math.min(1, Math.max(0, parsedCachedShare))
    : 0.5;
  const tokens = Math.max(0, Number(avoidedTokens) || 0);
  const millions = tokens / 1_000_000;
  const price = prices[contextTier];
  const roundUsd = (value) => Number(value.toFixed(6));
  const allCached = millions * price.cached_input;
  const allUncached = millions * price.input;
  const estimated = allCached * cachedShare + allUncached * (1 - cachedShare);
  return {
    currency: "USD",
    model: GPT_5_6_INPUT_PRICING_USD_PER_MILLION[model] ? model : "gpt-5.6-sol",
    requested_model: requestedModel,
    context_tier: contextTier,
    avoided_input_tokens: Math.round(tokens),
    cached_share_assumption: Number(cachedShare.toFixed(4)),
    estimated_saved_usd: roundUsd(estimated),
    range_usd: {
      all_cached: roundUsd(allCached),
      all_uncached: roundUsd(allUncached),
    },
    price_usd_per_million: {
      input: price.input,
      cached_input: price.cached_input,
    },
    source: GPT_5_6_PRICING_SOURCE,
    scope: "API-price equivalent for avoided input context; not a ChatGPT/Codex subscription bill.",
  };
}

function estimateTokens(text) {
  const value = String(text || "");
  const pieces = value.match(/[\p{L}\p{M}\p{N}_$.-]+|[^\s\p{L}\p{M}\p{N}]/gu) || [];
  let estimated = 0;
  for (const piece of pieces) {
    if (/^[\p{L}\p{M}\p{N}_$.-]+$/u.test(piece)) {
      const bytes = Buffer.byteLength(piece, "utf8");
      const divisor = /^[\x00-\x7f]+$/.test(piece) ? 6 : 4;
      estimated += Math.max(1, Math.ceil(bytes / divisor));
    } else {
      estimated += 1;
    }
  }
  estimated += (value.match(/\n/g) || []).length;
  return Math.max(value.length ? 1 : 0, estimated);
}

function tokenSafe(rawText, candidateText, safetyRatio, activationReserve = DEFAULT_ACTIVATION_RESERVE_TOKENS) {
  const raw = estimateTokens(rawText);
  const candidate = estimateTokens(candidateText) + activationReserve;
  return candidate < raw && candidate <= raw * safetyRatio;
}

function stateRoot(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const home = options.home || os.homedir();
  const override = env.CAPSULE_STATE;
  if (override) return path.resolve(override);

  let current;
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    current = path.join(localAppData, "Capsule");
  } else if (env.XDG_STATE_HOME) {
    current = path.join(env.XDG_STATE_HOME, "capsule");
  } else if (platform === "darwin") {
    current = path.join(home, "Library", "Application Support", "Capsule");
  } else {
    current = path.join(home, ".local", "state", "capsule");
  }
  return current;
}

function pathsForState() {
  const root = stateRoot();
  return {
    root,
    capsules: path.join(root, "capsules"),
    metadata: path.join(root, "metadata"),
    sources: path.join(root, "sources.json"),
    ledger: path.join(root, "ledger.json"),
    resultFutures: path.join(root, "result-futures"),
  };
}

function ensureState() {
  const state = pathsForState();
  fs.mkdirSync(state.capsules, { recursive: true });
  fs.mkdirSync(state.metadata, { recursive: true });
  fs.mkdirSync(state.resultFutures, { recursive: true });
  return state;
}

const RESULT_FUTURE_EXCLUDED_DIRS = new Set([
  ".git", ".hg", ".svn", ".codex", ".idea", ".vscode", ".capsule", ".capsule",
  "node_modules", "vendor", "target", "dist", "build", "out", "coverage",
  ".next", ".nuxt", ".cache", ".pytest_cache", "__pycache__",
]);

function resultFutureCommand(args = {}) {
  if (args.result_future === false || args.force_refresh === true) return null;
  if (!args.command || typeof args.command !== "string" || !Array.isArray(args.args || [])) return null;
  const executable = path.basename(args.command).toLowerCase().replace(/\.(exe|cmd|bat)$/i, "");
  const commandArgs = args.args || [];
  const first = String(commandArgs[0] || "").toLowerCase();
  const second = String(commandArgs[1] || "").toLowerCase();
  const script = first === "run" ? second : first;
  let profile = null;
  if (
    (executable === "node" && commandArgs.includes("--test")) ||
    ["pytest", "py.test"].includes(executable) ||
    (executable === "cargo" && first === "test") ||
    (executable === "go" && first === "test") ||
    (executable === "dotnet" && first === "test") ||
    (["npm", "pnpm", "yarn", "bun"].includes(executable) && script === "test")
  ) profile = "test";
  else if (
    executable === "eslint" ||
    (executable === "cargo" && first === "clippy") ||
    (["npm", "pnpm", "yarn", "bun"].includes(executable) && script === "lint")
  ) profile = "lint";
  else if (
    executable === "tsc" ||
    (["npm", "pnpm", "yarn", "bun"].includes(executable) && script === "typecheck")
  ) profile = "typecheck";
  else if (
    (executable === "cargo" && first === "check") ||
    (["npm", "pnpm", "yarn", "bun"].includes(executable) && script === "check")
  ) profile = "check";
  else if (
    (executable === "dotnet" && first === "build") ||
    (["npm", "pnpm", "yarn", "bun"].includes(executable) && script === "build")
  ) profile = "build";
  else if (
    (executable === "prettier" && commandArgs.some((item) => ["--check", "--list-different"].includes(item))) ||
    (executable === "black" && commandArgs.includes("--check")) ||
    (executable === "ruff" && first === "format" && commandArgs.includes("--check")) ||
    (["npm", "pnpm", "yarn", "bun"].includes(executable) &&
      ["format:check", "format-check"].includes(script))
  ) profile = "format-check";
  else if (
    executable === "fd" ||
    (executable === "rg" && commandArgs.includes("--files"))
  ) profile = "file-list";
  else if (["rg", "grep", "findstr"].includes(executable)) profile = "search";
  else if (executable === "git" && first === "status") profile = "git-status";
  else if (executable === "git" && first === "diff") profile = "git-diff";
  if (!profile) return null;
  return { executable, commandArgs, profile };
}

function resultFutureFingerprint(cwd, profile = "content") {
  const digest = crypto.createHash("sha256");
  let files = 0;
  let bytes = 0;
  const pathsOnly = profile === "file-list";
  const visit = (directory, relative = "") => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (RESULT_FUTURE_EXCLUDED_DIRS.has(entry.name)) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute, rel);
      } else if (entry.isFile()) {
        const stat = fs.statSync(absolute);
        files += 1;
        bytes += stat.size;
        if (files > 20000 || bytes > 256 * 1024 * 1024 || stat.size > 16 * 1024 * 1024) {
          throw new Error("workspace exceeds result-future fingerprint safety budget");
        }
        digest.update(rel).update("\0");
        if (!pathsOnly) digest.update(fs.readFileSync(absolute));
        digest.update("\0");
      }
    }
  };
  try {
    visit(cwd);
    if (profile === "git-status" || profile === "git-diff") {
      for (const name of ["HEAD", "index", "packed-refs"]) {
        const gitState = path.join(cwd, ".git", name);
        digest.update(`.git/${name}`).update("\0");
        if (fs.existsSync(gitState)) digest.update(fs.readFileSync(gitState));
        digest.update("\0");
      }
    }
    return { hash: digest.digest("hex"), files, bytes };
  } catch {
    return null;
  }
}

function resultFutureIdentity(args, cwd, command) {
  const environment = ["NODE_ENV", "CI", "TZ", "LANG", "PYTHONHASHSEED"]
    .map((name) => [name, process.env[name] || ""]);
  return sha256(JSON.stringify({
    command: path.resolve(args.command),
    args: command.commandArgs,
    cwd,
    runtime: process.version,
    platform: process.platform,
    arch: process.arch,
    environment,
  }));
}

function findResultFuture(args = {}) {
  const command = resultFutureCommand(args);
  if (!command) return null;
  const cwd = path.resolve(args.cwd || process.cwd());
  const fingerprint = resultFutureFingerprint(cwd, command.profile);
  if (!fingerprint) return null;
  const identity = resultFutureIdentity(args, cwd, command);
  const file = path.join(ensureState().resultFutures, `${identity}.json`);
  const record = readJson(file, null);
  const ttlMs = clampInt(
    args.result_future_ttl_ms || process.env.CAPSULE_RESULT_FUTURE_TTL_MS,
    180000,
    1000,
    3600000
  );
  const minReuseChars = clampInt(
    args.result_future_min_reuse_chars,
    RESULT_FUTURE_MIN_REUSE_CHARS,
    0,
    1024 * 1024
  );
  if (
    !record ||
    record.fingerprint !== fingerprint.hash ||
    Date.now() - record.created_at > ttlMs ||
    record.text.length < minReuseChars
  ) {
    return { command, cwd, fingerprint, identity, file, hit: null };
  }
  return { command, cwd, fingerprint, identity, file, hit: record };
}

function saveResultFuture(future, payload) {
  if (!future || payload.details.exit_code !== 0) return false;
  const after = resultFutureFingerprint(future.cwd, future.command.profile);
  if (!after || after.hash !== future.fingerprint.hash) return false;
  writeJsonAtomic(future.file, {
    version: 1,
    profile: future.command.profile,
    created_at: Date.now(),
    fingerprint: after.hash,
    files: after.files,
    bytes: after.bytes,
    text: payload.text,
    source: payload.source,
    details: payload.details,
  });
  return true;
}

function reuseResultFuture(future, args) {
  const record = future.hit;
  const savedMs = Math.max(0, Number(record.details.elapsed_ms) || 0);
  const candidate = saveCapsule({
    kind: "command",
    source: record.source,
    text: record.text,
    question: args.question,
    maxChars: clampInt(args.max_chars, DEFAULT_MAX_CHARS, 800, MAX_RETURN_CHARS),
    details: { ...record.details, result_future: true, saved_elapsed_ms: savedMs },
  });
  candidate.response = {
    route: "result-future",
    capsule_id: candidate.response.capsule_id,
    exact_expand: true,
    result_future: {
      profile: future.command.profile,
      proof: "unchanged command+environment+Merkle",
      files_verified: future.fingerprint.files,
      saved_elapsed_ms: savedMs,
      age_ms: Date.now() - record.created_at,
    },
  };
  candidate.route = "result-future";
  candidate.capturedChars = 0;
  return candidate;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function normalizeLines(text) {
  return String(text).replace(/\r\n?/g, "\n").split("\n");
}

function tokenize(value) {
  return [...String(value).toLowerCase().matchAll(/[\p{L}\p{N}_$.-]{2,}/gu)]
    .map((match) => match[0])
    .filter((term) => term.length > 1);
}

function formatLines(lines, start, end, maxChars) {
  const width = String(end).length;
  const parts = [];
  let used = 0;
  let truncated = false;
  for (let index = start - 1; index < end && index < lines.length; index += 1) {
    const rendered = `${String(index + 1).padStart(width, " ")} | ${lines[index]}`;
    if (used + rendered.length + 1 > maxChars) {
      truncated = true;
      break;
    }
    parts.push(rendered);
    used += rendered.length + 1;
  }
  return { text: parts.join("\n"), truncated };
}

function cropFocusedLine(line, prefix, maxChars, focusColumn) {
  const available = Math.max(1, maxChars - prefix.length);
  if (line.length <= available) return { text: `${prefix}${line}`, cropped: false };
  const marker = "…";
  const contentBudget = Math.max(1, available - 2);
  const target = Math.max(0, Math.min(line.length, focusColumn || 0));
  let sliceStart = Math.max(0, target - Math.floor(contentBudget / 2));
  sliceStart = Math.min(sliceStart, Math.max(0, line.length - contentBudget));
  const sliceEnd = Math.min(line.length, sliceStart + contentBudget);
  return {
    text: `${prefix}${sliceStart > 0 ? marker : ""}${line.slice(sliceStart, sliceEnd)}${sliceEnd < line.length ? marker : ""}`,
    cropped: true,
  };
}

function formatFocusedLines(lines, start, end, maxChars, focusLine, focusColumn = 0) {
  if (!focusLine || focusLine < start || focusLine > end) {
    return formatLines(lines, start, end, maxChars);
  }
  const width = String(end).length;
  const focusIndex = focusLine - 1;
  const prefix = `${String(focusLine).padStart(width, " ")} | `;
  const focus = cropFocusedLine(lines[focusIndex], prefix, maxChars, focusColumn);
  const selected = new Map([[focusIndex, focus.text]]);
  let used = focus.text.length;
  let left = focusIndex - 1;
  let right = focusIndex + 1;

  while (left >= start - 1 || right < end) {
    let added = false;
    for (const index of [left, right]) {
      if (index < start - 1 || index >= end) continue;
      const rendered = `${String(index + 1).padStart(width, " ")} | ${lines[index]}`;
      if (used + rendered.length + 1 <= maxChars) {
        selected.set(index, rendered);
        used += rendered.length + 1;
        added = true;
      }
    }
    left -= 1;
    right += 1;
    if (!added && left < start - 1 && right >= end) break;
  }

  return {
    text: [...selected.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]).join("\n"),
    truncated: focus.cropped || selected.size < end - start + 1,
  };
}

function focusedRange(lines, start, end, focus, maxChars) {
  const sample = lines.slice(start - 1, end);
  const averageLineChars = sample.length
    ? sample.reduce((sum, line) => sum + line.length + 8, 0) / sample.length
    : 24;
  const visibleLines = Math.max(1, Math.min(
    end - start + 1,
    Math.floor(maxChars / Math.max(12, averageLineChars))
  ));
  const target = Math.max(start, Math.min(end, focus || start));
  let visibleStart = target - Math.floor(visibleLines / 2);
  visibleStart = Math.max(start, Math.min(visibleStart, end - visibleLines + 1));
  const visibleEnd = Math.min(end, visibleStart + visibleLines - 1);
  return { start: visibleStart, end: visibleEnd };
}

function changedRegion(beforeText, afterText) {
  if (beforeText == null) return null;
  const before = normalizeLines(beforeText);
  const after = normalizeLines(afterText);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  if (prefix === before.length && prefix === after.length) {
    return {
      identical: true,
      before_start_line: null,
      before_end_line: null,
      after_start_line: null,
      after_end_line: null,
      common_prefix_lines: prefix,
      common_suffix_lines: 0,
    };
  }
  return {
    identical: false,
    before_start_line: prefix + 1,
    before_end_line: Math.max(prefix, before.length - suffix),
    after_start_line: prefix + 1,
    after_end_line: Math.max(prefix, after.length - suffix),
    common_prefix_lines: prefix,
    common_suffix_lines: suffix,
  };
}

function windowCandidates(lines, question, change, windowLines) {
  const terms = [...new Set(tokenize(question))];
  const stride = Math.max(1, windowLines - Math.floor(windowLines / 5));
  const candidates = [];

  for (let start = 1; start <= lines.length; start += stride) {
    const end = Math.min(lines.length, start + windowLines - 1);
    const slice = lines.slice(start - 1, end);
    const lower = slice.join("\n").toLowerCase();
    const matched = terms.filter((term) => lower.includes(term));
    const signalCount = slice.filter((line) => SIGNAL_RE.test(line)).length;
    const structureCount = slice.filter((line) => STRUCTURE_RE.test(line)).length;
    const intersectsChange = Boolean(
      change &&
      !change.identical &&
      change.after_start_line != null &&
      start <= change.after_end_line &&
      end >= change.after_start_line
    );
    let questionFocusIndex = -1;
    let focusColumn = 0;
    for (let index = 0; index < slice.length && questionFocusIndex < 0; index += 1) {
      const lowerLine = slice[index].toLowerCase();
      const columns = matched.map((term) => lowerLine.indexOf(term)).filter((column) => column >= 0);
      if (columns.length) {
        questionFocusIndex = index;
        focusColumn = Math.min(...columns);
      }
    }
    const signalFocusIndex = slice.findIndex((line) => SIGNAL_RE.test(line));
    let focus = questionFocusIndex >= 0
      ? start + questionFocusIndex
      : signalFocusIndex >= 0
        ? start + signalFocusIndex
        : start;
    if (intersectsChange && questionFocusIndex < 0 && signalFocusIndex < 0) {
      focus = Math.max(start, Math.min(end, change.after_start_line));
    }
    if (questionFocusIndex < 0 && signalFocusIndex >= 0) {
      const signalMatch = SIGNAL_RE.exec(slice[signalFocusIndex]);
      focusColumn = signalMatch ? signalMatch.index : 0;
    }
    let score = matched.length * 12 + signalCount * 3 + Math.min(structureCount, 4);
    const reasons = [];
    if (matched.length) reasons.push(`question:${matched.join(",")}`);
    if (signalCount) reasons.push(`diagnostic:${signalCount}`);
    if (structureCount) reasons.push(`structure:${structureCount}`);
    if (intersectsChange) {
      score += 18;
      reasons.push("changed-region");
    }
    if (start === 1) {
      score += 1;
      reasons.push("head");
    }
    if (end === lines.length) {
      score += 1;
      reasons.push("tail");
    }
    candidates.push({ start, end, focus, focusColumn, score, reasons, matched });
    if (end === lines.length) break;
  }
  return { candidates, terms };
}

function termPointCandidates(lines, terms, windowLines) {
  const candidates = [];
  for (const term of terms) {
    for (let index = 0; index < lines.length; index += 1) {
      const column = lines[index].toLowerCase().indexOf(term);
      if (column < 0) continue;
      const focus = index + 1;
      const before = Math.floor(windowLines / 2);
      let start = Math.max(1, focus - before);
      const end = Math.min(lines.length, start + windowLines - 1);
      start = Math.max(1, end - windowLines + 1);
      candidates.push({
        start,
        end,
        focus,
        focusColumn: column,
        score: 100,
        reasons: [`question:${term}`],
        matched: [term],
        explicitFocus: true,
      });
      break;
    }
  }
  return candidates;
}

function chooseAnchors(lines, question, change, maxChars, windowLines = 36) {
  const windowed = windowCandidates(lines, question, change, windowLines);
  const terms = windowed.terms;
  const candidates = [
    ...termPointCandidates(lines, terms, windowLines),
    ...windowed.candidates,
  ];
  const chosen = [];
  const covered = new Set();
  const targetCount = terms.length
    ? Math.min(8, Math.max(1, terms.length))
    : Math.min(2, candidates.length);

  while (chosen.length < targetCount) {
    const ranked = candidates
      .filter((candidate) => !chosen.includes(candidate))
      .map((candidate) => ({
        candidate,
        newTerms: candidate.matched.filter((term) => !covered.has(term)).length,
      }))
      .filter((entry) => !terms.length || entry.newTerms > 0)
      .sort((a, b) =>
        (b.candidate.explicitFocus ? 1 : 0) - (a.candidate.explicitFocus ? 1 : 0) ||
        b.newTerms - a.newTerms ||
        b.candidate.score - a.candidate.score ||
        a.candidate.start - b.candidate.start
      );
    if (!ranked.length) break;
    const candidate = ranked[0].candidate;
    const redundantOverlap = chosen.some(
      (entry) =>
        !candidate.explicitFocus &&
        !entry.explicitFocus &&
        candidate.start <= entry.end &&
        candidate.end >= entry.start
    );
    if (redundantOverlap) {
      candidates.splice(candidates.indexOf(candidate), 1);
      continue;
    }
    chosen.push(candidate);
    candidate.matched.forEach((term) => covered.add(term));
  }

  if (!chosen.length && lines.length) {
    const fallback = [...candidates].sort((a, b) => b.score - a.score || a.start - b.start)[0];
    chosen.push(fallback || {
      start: 1,
      end: Math.min(lines.length, windowLines),
      focus: 1,
      focusColumn: 0,
      score: 0,
      reasons: ["head"],
      matched: [],
    });
  }

  chosen.sort((a, b) => a.start - b.start);
  const excerptBudget = Math.max(160, Math.floor((maxChars - 500) / Math.max(1, chosen.length)));
  const anchors = chosen.map((entry) => {
    const visible = focusedRange(lines, entry.start, entry.end, entry.focus, excerptBudget);
    const excerpt = formatFocusedLines(
      lines,
      visible.start,
      visible.end,
      excerptBudget,
      entry.focus,
      entry.focusColumn
    );
    return {
      anchor_id: `a_${visible.start}_${visible.end}_${entry.focusColumn || 0}`,
      start_line: visible.start,
      end_line: visible.end,
      focus_line: entry.focus,
      focus_column: entry.focusColumn || 0,
      score: entry.score,
      reasons: entry.reasons,
      excerpt: excerpt.text,
      excerpt_truncated: excerpt.truncated,
    };
  });
  const visibleCovered = new Set();
  for (const anchor of anchors) {
    const lower = anchor.excerpt.toLowerCase();
    for (const term of terms) {
      if (lower.includes(term)) visibleCovered.add(term);
    }
  }

  return {
    anchors,
    coverage: terms.length ? Number((visibleCovered.size / terms.length).toFixed(3)) : null,
    matched_terms: [...visibleCovered],
    question_terms: terms,
  };
}

function capsuleFiles(capsuleId) {
  const state = ensureState();
  return {
    raw: path.join(state.capsules, `${capsuleId}.txt.gz`),
    metadata: path.join(state.metadata, `${capsuleId}.json`),
  };
}

function loadMetadata(capsuleId) {
  if (!/^cap_[a-f0-9]{16}$/.test(String(capsuleId))) {
    throw new Error(`Invalid capsule_id: ${capsuleId}`);
  }
  const files = capsuleFiles(capsuleId);
  try {
    return readJson(files.metadata, null);
  } catch (error) {
    throw new Error(`Could not read capsule metadata: ${error.message}`);
  }
}

function loadCapsule(capsuleId) {
  const metadata = loadMetadata(capsuleId);
  if (!metadata) throw new Error(`Capsule not found: ${capsuleId}`);
  const files = capsuleFiles(capsuleId);
  let text;
  try {
    text = zlib.gunzipSync(fs.readFileSync(files.raw)).toString("utf8");
  } catch (error) {
    throw new Error(`Could not read capsule archive: ${error.message}`);
  }
  return { metadata, text };
}

let capsuleMaintenanceLastRun = 0;
let capsuleMaintenanceSaves = 0;
let capsuleMaintenanceRunning = false;

function cacheFileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function maintainCapsuleCache(options = {}) {
  const state = ensureState();
  const lock = path.join(state.root, "capsule-cache-gc.lock");
  if (options.lock !== false) {
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
  }
  try {
  const now = Date.now();
  const maxBytes = clampInt(
    options.max_bytes ?? process.env.CAPSULE_CACHE_MAX_BYTES,
    DEFAULT_CAPSULE_CACHE_BYTES,
    1024,
    64 * 1024 * 1024 * 1024,
  );
  const maxEntries = clampInt(
    options.max_entries ?? process.env.CAPSULE_CACHE_MAX_ENTRIES,
    DEFAULT_CAPSULE_CACHE_ENTRIES,
    1,
    1_000_000,
  );
  const ttlDays = clampInt(
    options.ttl_days ?? process.env.CAPSULE_CACHE_TTL_DAYS,
    DEFAULT_CAPSULE_CACHE_TTL_DAYS,
    1,
    3650,
  );
  const minRecent = clampInt(
    options.min_recent ?? process.env.CAPSULE_CACHE_MIN_RECENT,
    DEFAULT_CAPSULE_CACHE_MIN_RECENT,
    0,
    100_000,
  );
  const metadataFiles = fs.readdirSync(state.metadata)
    .filter((name) => /^cap_[a-f0-9]{16}\.json$/.test(name));
  const entries = metadataFiles.map((name) => {
    const metadataFile = path.join(state.metadata, name);
    const metadata = readJson(metadataFile, {});
    const capsuleId = name.slice(0, -5);
    const rawFile = path.join(state.capsules, `${capsuleId}.txt.gz`);
    const lastSeen = Date.parse(metadata.last_seen_at || metadata.created_at || "") ||
      cacheFileSize(metadataFile) && fs.statSync(metadataFile).mtimeMs || 0;
    return {
      capsule_id: capsuleId,
      metadata,
      metadata_file: metadataFile,
      raw_file: rawFile,
      last_seen: Number(lastSeen) || 0,
      bytes: cacheFileSize(metadataFile) + cacheFileSize(rawFile),
    };
  }).sort((left, right) => right.last_seen - left.last_seen);
  const sources = readJson(state.sources, {});
  let sourcesChanged = false;
  for (const [key, capsuleId] of Object.entries(sources)) {
    if (!entries.some((entry) => entry.capsule_id === capsuleId)) {
      delete sources[key];
      sourcesChanged = true;
    }
  }
  const sourceKeys = new Map();
  for (const [key, capsuleId] of Object.entries(sources)) {
    if (!sourceKeys.has(capsuleId)) sourceKeys.set(capsuleId, []);
    sourceKeys.get(capsuleId).push(key);
  }
  const hardProtected = new Set(entries.slice(0, minRecent).map((entry) => entry.capsule_id));
  for (const entry of entries.slice(0, minRecent)) {
    if (entry.metadata.previous_capsule_id) hardProtected.add(entry.metadata.previous_capsule_id);
  }
  let currentBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  let currentEntries = entries.length;
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  const removed = [];
  for (const entry of [...entries].reverse()) {
    if (hardProtected.has(entry.capsule_id)) continue;
    const expired = now - entry.last_seen > ttlMs;
    const overQuota = currentEntries > maxEntries || currentBytes > maxBytes;
    if (!expired && !overQuota) continue;
    const keys = sourceKeys.get(entry.capsule_id) || [];
    if (keys.length && !overQuota) continue;
    for (const key of keys) {
      delete sources[key];
      sourcesChanged = true;
    }
    try { fs.rmSync(entry.raw_file, { force: true }); } catch {}
    try { fs.rmSync(entry.metadata_file, { force: true }); } catch {}
    currentBytes = Math.max(0, currentBytes - entry.bytes);
    currentEntries -= 1;
    removed.push(entry.capsule_id);
  }
  if (sourcesChanged) writeJsonAtomic(state.sources, sources);
  return {
    entries_before: entries.length,
    entries_after: currentEntries,
    bytes_before: entries.reduce((total, entry) => total + entry.bytes, 0),
    bytes_after: currentBytes,
    removed: removed.length,
    removed_ids: options.include_ids ? removed : undefined,
    limits: { max_bytes: maxBytes, max_entries: maxEntries, ttl_days: ttlDays, min_recent: minRecent },
    quota_satisfied: currentEntries <= maxEntries && currentBytes <= maxBytes,
  };
  } finally {
    if (options.lock !== false) fs.rmSync(lock, { recursive: true, force: true });
  }
}

function maybeMaintainCapsuleCache() {
  if (process.env.CAPSULE_CACHE_GC === "0" || capsuleMaintenanceRunning) return null;
  capsuleMaintenanceSaves += 1;
  const now = Date.now();
  if (capsuleMaintenanceLastRun && capsuleMaintenanceSaves < 32 &&
      now - capsuleMaintenanceLastRun < 60_000) return null;
  capsuleMaintenanceRunning = true;
  try {
    const result = maintainCapsuleCache();
    capsuleMaintenanceLastRun = now;
    capsuleMaintenanceSaves = 0;
    return result;
  } catch {
    return null;
  } finally {
    capsuleMaintenanceRunning = false;
  }
}

function sourceKey(kind, source) {
  return sha256(`${kind}\0${source}`);
}

function saveCapsule({ kind, source, text, question, maxChars, details = {} }) {
  const state = ensureState();
  const contentHash = sha256(Buffer.from(text, "utf8"));
  const capsuleId = `cap_${contentHash.slice(0, 16)}`;
  const files = capsuleFiles(capsuleId);
  const existing = readJson(files.metadata, null);
  const sources = readJson(state.sources, {});
  const key = sourceKey(kind, source);
  const previousCapsuleId = sources[key] || null;
  let previousText = null;

  if (previousCapsuleId) {
    if (previousCapsuleId === capsuleId) {
      previousText = text;
    } else {
      try {
        previousText = loadCapsule(previousCapsuleId).text;
      } catch {
        previousText = null;
      }
    }
  }

  const change = changedRegion(previousText, text);
  const lines = normalizeLines(text);
  const selection = chooseAnchors(lines, question || "", change, maxChars);
  const metadata = {
    capsule_id: capsuleId,
    sha256: contentHash,
    kind,
    source,
    source_key: key,
    created_at: existing ? existing.created_at : new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    chars: text.length,
    bytes: Buffer.byteLength(text, "utf8"),
    lines: lines.length,
    question: question || null,
    anchors: selection.anchors.map(({ excerpt, ...anchor }) => anchor),
    previous_capsule_id: previousCapsuleId === capsuleId
      ? existing && existing.previous_capsule_id
      : previousCapsuleId,
    changed_region: change,
    details,
  };

  if (!fs.existsSync(files.raw)) {
    fs.writeFileSync(files.raw, zlib.gzipSync(Buffer.from(text, "utf8"), { level: 9 }));
  }
  writeJsonAtomic(files.metadata, metadata);
  sources[key] = capsuleId;
  writeJsonAtomic(state.sources, sources);
  const cacheGc = maybeMaintainCapsuleCache();

  return {
    response: {
      capsule_id: capsuleId,
      bytes: metadata.bytes,
      lines: metadata.lines,
      previous_capsule_id: previousCapsuleId,
      changed_region: change,
      coverage: selection.coverage,
      coverage_kind: "literal-visible",
      missing_terms: selection.question_terms.filter((term) => !selection.matched_terms.includes(term)),
      evidence_islands: selection.anchors.map((anchor) => ({
        anchor_id: anchor.anchor_id,
        start_line: anchor.start_line,
        end_line: anchor.end_line,
        excerpt: anchor.excerpt,
        excerpt_truncated: anchor.excerpt_truncated,
      })),
      ...(cacheGc && cacheGc.removed ? { cache_gc: cacheGc } : {}),
      ...(kind === "command" ? {
        execution: {
          exit_code: details.exit_code,
          signal: details.signal,
          elapsed_ms: details.elapsed_ms,
        },
      } : {}),
    },
    capturedChars: text.length,
    baselineText: text,
    route: "capsule",
  };
}

function readFilePayload(args = {}) {
  if (!args.path || typeof args.path !== "string") throw new Error("path is required");
  const absolute = path.resolve(args.path);
  const maximum = clampInt(args.max_bytes, DEFAULT_MAX_BYTES, 1024, 256 * 1024 * 1024);
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) throw new Error(`Not a file: ${absolute}`);
  if (stat.size > maximum) {
    throw new Error(`File is ${stat.size} bytes; max_bytes is ${maximum}`);
  }
  const buffer = fs.readFileSync(absolute);
  if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) {
    throw new Error(`Binary file rejected: ${absolute}`);
  }
  const text = buffer.toString("utf8");
  const maxChars = clampInt(args.max_chars, DEFAULT_MAX_CHARS, 800, MAX_RETURN_CHARS);
  return {
    absolute,
    text,
    maxChars,
    details: {
      mtime: stat.mtime.toISOString(),
      requested_max_chars: maxChars,
    },
  };
}

function passthrough(text, details = {}) {
  return {
    responseText: text,
    response: null,
    capturedChars: text.length,
    baselineText: text,
    route: "passthrough",
    details,
  };
}

function renderOperation(operation) {
  return operation.responseText !== undefined
    ? operation.responseText
    : JSON.stringify(operation.response);
}

function encodeLineDictionary(text) {
  const segments = String(text).match(/[^\n]*\n|[^\n]+$/g) || [""];
  const dictionary = [];
  const ids = new Map();
  const sequence = [];
  for (const segment of segments) {
    let id = ids.get(segment);
    if (id === undefined) {
      id = dictionary.length;
      ids.set(segment, id);
      dictionary.push(segment);
    }
    const last = sequence[sequence.length - 1];
    if (last && last[0] === id) last[1] += 1;
    else sequence.push([id, 1]);
  }
  return JSON.stringify({
    format: "capsule-line-dictionary-v1",
    dictionary,
    sequence,
  });
}

function decodeLineDictionary(encoded) {
  const parsed = typeof encoded === "string" ? JSON.parse(encoded) : encoded;
  if (!parsed || parsed.format !== "capsule-line-dictionary-v1") {
    throw new Error("Not a capsule-line-dictionary-v1 payload");
  }
  return parsed.sequence.map(([id, count]) => parsed.dictionary[id].repeat(count)).join("");
}

function lossless(text, encoded, details = {}) {
  return {
    responseText: encoded,
    response: null,
    capturedChars: text.length,
    baselineText: text,
    route: "lossless",
    details,
  };
}

function surveyFile(args = {}) {
  const payload = readFilePayload(args);
  return saveCapsule({
    kind: "file",
    source: payload.absolute,
    text: payload.text,
    question: args.question,
    maxChars: payload.maxChars,
    details: payload.details,
  });
}

function smartFile(args = {}) {
  const payload = readFilePayload(args);
  const mode = args.mode || (args.require_full ? "full" : "auto");
  if (!["auto", "full", "capsule"].includes(mode)) throw new Error(`Invalid mode: ${mode}`);
  const safetyRatio = Math.max(
    0.1,
    Math.min(0.95, Number(args.safety_ratio) || DEFAULT_CAPSULE_SAFETY_RATIO)
  );
  const passthroughChars = clampInt(
    args.passthrough_chars,
    DEFAULT_PASSTHROUGH_CHARS,
    0,
    16 * 1024 * 1024
  );
  if (mode === "full") {
    const encoded = encodeLineDictionary(payload.text);
    return tokenSafe(payload.text, encoded, safetyRatio)
      ? lossless(payload.text, encoded, payload.details)
      : passthrough(payload.text, payload.details);
  }
  if (mode === "auto" && payload.text.length <= passthroughChars) {
    return passthrough(payload.text, payload.details);
  }
  const candidate = saveCapsule({
    kind: "file",
    source: payload.absolute,
    text: payload.text,
    question: args.question,
    maxChars: payload.maxChars,
    details: payload.details,
  });
  if (mode === "auto") {
    const rendered = renderOperation(candidate);
    const hasQuery = tokenize(args.question || "").length > 0;
    if (
      (hasQuery && (candidate.response.coverage || 0) < MIN_AUTO_LEXICAL_COVERAGE) ||
      !tokenSafe(payload.text, rendered, safetyRatio)
    ) {
      return passthrough(payload.text, payload.details);
    }
  }
  return candidate;
}

function environmentValue(env, name, fallback = "") {
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key == null ? fallback : env[key];
}

function resolveWindowsExecutable(command, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const pathApi = options.path || path;
  const statSync = options.statSync || fs.statSync;
  const pathDelimiter = options.pathDelimiter || (platform === "win32" ? ";" : pathApi.delimiter);
  if (platform !== "win32") return command;
  const hasDirectory = /[\\/]/.test(command);
  const cwd = pathApi.resolve(options.cwd || process.cwd());
  const resolvedCommand = hasDirectory ? pathApi.resolve(cwd, command) : command;
  const pathDirectories = String(environmentValue(env, "PATH", ""))
    .split(pathDelimiter)
    .map((directory) => directory.trim().replace(/^"([\s\S]*)"$/, "$1"))
    .filter(Boolean);
  const directories = hasDirectory
    ? [pathApi.dirname(resolvedCommand)]
    : [cwd, ...pathDirectories];
  const base = hasDirectory ? pathApi.basename(resolvedCommand) : command;
  const suppliedExtension = pathApi.extname(base);
  const executableExtensions = String(environmentValue(env, "PATHEXT", ".COM;.EXE;.BAT;.CMD"))
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
  const extensions = suppliedExtension
    ? [""]
    : [...executableExtensions, ""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = pathApi.join(directory, `${base}${extension}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Continue through PATH/PATHEXT candidates.
      }
    }
  }
  return command;
}

function commandSpawnPlan(command, commandArgs = [], options = {}) {
  if (!Array.isArray(commandArgs) || commandArgs.some((item) => typeof item !== "string")) {
    throw new Error("command args must be an array of strings");
  }
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const pathApi = options.path || path;
  const existsSync = options.existsSync || fs.existsSync;
  const resolved = resolveWindowsExecutable(command, { ...options, platform, env, path: pathApi });
  if (platform !== "win32" || !/\.(?:cmd|bat|ps1)$/i.test(resolved)) {
    return { command: resolved, args: commandArgs, env };
  }
  const systemRoot = environmentValue(env, "SystemRoot", "C:\\Windows");
  const bundledPowerShell = pathApi.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const powershell = existsSync(bundledPowerShell) ? bundledPowerShell : "powershell.exe";
  const script = [
    "$tcArgs = @((ConvertFrom-Json -InputObject $env:CAPSULE_COMMAND_ARGS));",
    "$tcCommand = $env:CAPSULE_COMMAND;",
    "Remove-Item Env:CAPSULE_COMMAND,Env:CAPSULE_COMMAND_ARGS -ErrorAction SilentlyContinue;",
    "& $tcCommand @tcArgs;",
    "if ($null -eq $LASTEXITCODE) { exit 0 } else { exit $LASTEXITCODE }",
  ].join(" ");
  return {
    command: powershell,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    env: {
      ...env,
      CAPSULE_COMMAND: resolved,
      CAPSULE_COMMAND_ARGS: JSON.stringify(commandArgs),
    },
  };
}

function splitCommandString(command) {
  const tokens = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) {
        quote = "";
      } else if (character === "\\" && command[index + 1] === quote) {
        current += quote;
        index += 1;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (quote) throw new Error("command contains an unterminated quote");
  if (current) tokens.push(current);
  return tokens;
}

function hasUnquotedShellSyntax(command) {
  let quote = "";
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote && command[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
    } else if (/[\r\n|;&<>`]/.test(character)) {
      return true;
    }
  }
  return process.platform === "win32" &&
    /^(?:\s*\$|\s*(?:Get|Set|Write|New|Remove|Copy|Move|Test|Select|ForEach|Where)-)/i.test(command);
}

function commandStringShellPlan(command) {
  if (process.platform !== "win32") {
    return { command: "/bin/sh", args: ["-lc", command] };
  }
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const bundledPowerShell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  return {
    command: fs.existsSync(bundledPowerShell) ? bundledPowerShell : "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ],
  };
}

function captureCommand(args = {}) {
  if (!args.command || typeof args.command !== "string") throw new Error("command is required");
  if (args.args != null && (!Array.isArray(args.args) || args.args.some((item) => typeof item !== "string"))) {
    throw new Error("args must be an array of strings");
  }
  const requestedCommand = args.command.trim();
  let command = requestedCommand;
  let commandArgs = args.args || [];
  let commandStringShell = false;
  if (commandArgs.length === 0 && /\s/.test(requestedCommand)) {
    if (hasUnquotedShellSyntax(requestedCommand)) {
      const shellPlan = commandStringShellPlan(requestedCommand);
      command = shellPlan.command;
      commandArgs = shellPlan.args;
      commandStringShell = true;
    } else {
      const tokens = splitCommandString(requestedCommand);
      if (tokens.length > 1) {
        [command, ...commandArgs] = tokens;
      }
    }
  }
  const cwd = path.resolve(args.cwd || process.cwd());
  const timeout = clampInt(args.timeout_ms, 30000, 100, 120000);
  const maxBuffer = clampInt(args.max_output_bytes, DEFAULT_COMMAND_BYTES, 4096, 128 * 1024 * 1024);
  const started = Date.now();
  const plan = commandSpawnPlan(command, commandArgs, { cwd });
  const result = spawnSync(plan.command, plan.args, {
    cwd,
    encoding: "utf8",
    env: plan.env,
    shell: false,
    windowsHide: true,
    timeout,
    maxBuffer,
  });
  const elapsedMs = Date.now() - started;
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const errorText = result.error ? `${result.error.name}: ${result.error.message}` : "";
  if (result.error) {
    throw new Error(`Command capture failed before a complete archive was available: ${errorText}`);
  }
  const text = [
    "# stdout",
    stdout,
    "# stderr",
    stderr,
  ].join("\n");
  const maxChars = clampInt(args.max_chars, DEFAULT_MAX_CHARS, 800, MAX_RETURN_CHARS);
  return {
    text,
    maxChars,
    details: {
      command,
      args: commandArgs,
      ...(command !== requestedCommand ? { requested_command: requestedCommand, command_string_compat: true } : {}),
      ...(commandStringShell ? { command_string_shell: true } : {}),
      cwd,
      exit_code: result.status,
      signal: result.signal,
      elapsed_ms: elapsedMs,
      spawn_error: null,
      requested_max_chars: maxChars,
    },
    source: JSON.stringify({ command, args: commandArgs, cwd }),
  };
}

function surveyCommand(args = {}) {
  const payload = captureCommand(args);
  return saveCapsule({
    kind: "command",
    source: payload.source,
    text: payload.text,
    question: args.question,
    maxChars: payload.maxChars,
    details: payload.details,
  });
}

function smartCommand(args = {}) {
  const mode = args.mode || "auto";
  if (!["auto", "full", "capsule"].includes(mode)) throw new Error(`Invalid mode: ${mode}`);
  const executable = path.basename(String(args.command || "")).toLowerCase();
  const future = mode === "auto" ? findResultFuture(args) : null;
  if (future && future.hit) {
    const reused = reuseResultFuture(future, args);
    if (renderOperation(reused).length < future.hit.text.length) return reused;
    return passthrough(future.hit.text, {
      ...future.hit.details,
      result_future: true,
      result_future_profile: future.command.profile,
      result_future_proof: "unchanged command+environment+Merkle",
      result_future_files_verified: future.fingerprint.files,
      saved_elapsed_ms: Math.max(0, Number(future.hit.details?.elapsed_ms) || 0),
    });
  }
  const payload = captureCommand(args);
  saveResultFuture(future, payload);
  const safetyRatio = Math.max(
    0.1,
    Math.min(0.95, Number(args.safety_ratio) || DEFAULT_CAPSULE_SAFETY_RATIO)
  );
  const passthroughChars = clampInt(
    args.passthrough_chars,
    DEFAULT_PASSTHROUGH_CHARS,
    0,
    16 * 1024 * 1024
  );
  if (mode === "full") {
    const encoded = encodeLineDictionary(payload.text);
    return tokenSafe(payload.text, encoded, safetyRatio)
      ? lossless(payload.text, encoded, payload.details)
      : passthrough(payload.text, payload.details);
  }
  if (mode === "auto" && payload.text.length <= passthroughChars) {
    return passthrough(payload.text, payload.details);
  }
  const candidate = saveCapsule({
    kind: "command",
    source: payload.source,
    text: payload.text,
    question: args.question,
    maxChars: payload.maxChars,
    details: payload.details,
  });
  if (mode === "auto") {
    const rendered = renderOperation(candidate);
    const hasQuery = tokenize(args.question || "").length > 0;
    if (
      (hasQuery && (candidate.response.coverage || 0) < MIN_AUTO_LEXICAL_COVERAGE) ||
      !tokenSafe(payload.text, rendered, safetyRatio)
    ) {
      return passthrough(payload.text, payload.details);
    }
  }
  return candidate;
}

function expandAnchor(args = {}) {
  const capsuleId = args.capsule_id || args.id || args.ref;
  if (!capsuleId) {
    throw new Error("expand requires payload.capsule_id copied from a prior cap_* result; do not call expand before a capsule exists");
  }
  const capsule = loadCapsule(capsuleId);
  const lines = normalizeLines(capsule.text);
  let start;
  let end;
  let focusLine;
  let focusColumn = 0;

  if (args.anchor_id) {
    const anchor = (capsule.metadata.anchors || []).find((entry) => entry.anchor_id === args.anchor_id);
    if (!anchor) throw new Error(`Anchor not found: ${args.anchor_id}`);
    const before = clampInt(args.before, 0, 0, 500);
    const after = clampInt(args.after, 0, 0, 500);
    start = Math.max(1, anchor.start_line - before);
    end = Math.min(lines.length, anchor.end_line + after);
    focusLine = anchor.focus_line;
    focusColumn = anchor.focus_column || 0;
  } else {
    start = clampInt(args.start_line, 1, 1, Math.max(1, lines.length));
    end = clampInt(args.end_line, start, start, Math.max(start, lines.length));
  }

  const explicitRange = args.anchor_id != null || args.end_line != null;
  const maxChars = clampInt(
    args.max_chars,
    explicitRange ? MAX_RETURN_CHARS : 2400,
    400,
    MAX_RETURN_CHARS
  );
  const excerpt = formatFocusedLines(lines, start, end, maxChars, focusLine, focusColumn);
  const visibleLineMatches = [...excerpt.text.matchAll(/(?:^|\n)\s*(\d+)\s+\|/g)];
  const lastVisibleLine = visibleLineMatches.length
    ? Number(visibleLineMatches.at(-1)[1])
    : start;
  return {
    response: {
      capsule_id: args.capsule_id,
      start_line: start,
      end_line: end,
      excerpt: excerpt.text,
      truncated: excerpt.truncated,
      ...(!args.anchor_id && excerpt.truncated && lastVisibleLine < end
        ? { next_start_line: lastVisibleLine + 1, next_end_line: end }
        : {}),
    },
    capturedChars: 0,
  };
}

function diffCapsules(args = {}) {
  if (!args.before_id || !args.after_id) throw new Error("before_id and after_id are required");
  const before = loadCapsule(args.before_id);
  const after = loadCapsule(args.after_id);
  const change = changedRegion(before.text, after.text);
  const maxChars = clampInt(args.max_chars, 6000, 800, MAX_RETURN_CHARS);

  if (change.identical) {
    return {
      response: {
        before_id: args.before_id,
        after_id: args.after_id,
        identical: true,
      },
      capturedChars: 0,
    };
  }

  const beforeLines = normalizeLines(before.text);
  const afterLines = normalizeLines(after.text);
  const context = clampInt(args.context_lines, 3, 0, 50);
  const halfBudget = Math.max(200, Math.floor((maxChars - 700) / 2));
  const beforeStart = Math.max(1, change.before_start_line - context);
  const beforeEnd = Math.min(beforeLines.length, change.before_end_line + context);
  const afterStart = Math.max(1, change.after_start_line - context);
  const afterEnd = Math.min(afterLines.length, change.after_end_line + context);
  const beforeExcerpt = formatLines(beforeLines, beforeStart, beforeEnd, halfBudget);
  const afterExcerpt = formatLines(afterLines, afterStart, afterEnd, halfBudget);

  return {
    response: {
      before_id: args.before_id,
      after_id: args.after_id,
      identical: false,
      changed_region: change,
      before: {
        start_line: beforeStart,
        end_line: beforeEnd,
        excerpt: beforeExcerpt.text,
        truncated: beforeExcerpt.truncated,
      },
      after: {
        start_line: afterStart,
        end_line: afterEnd,
        excerpt: afterExcerpt.text,
        truncated: afterExcerpt.truncated,
      },
      note: "This is a bounded exact before/after window around the first and last changed lines.",
    },
    capturedChars: 0,
  };
}

function listCapsules(args = {}) {
  const state = ensureState();
  const limit = clampInt(args.limit, 20, 1, 100);
  const entries = fs.readdirSync(state.metadata)
    .filter((name) => /^cap_[a-f0-9]{16}\.json$/.test(name))
    .map((name) => readJson(path.join(state.metadata, name), null))
    .filter(Boolean)
    .sort((a, b) => String(b.last_seen_at).localeCompare(String(a.last_seen_at)))
    .slice(0, limit)
    .map((entry) => ({
      capsule_id: entry.capsule_id,
      kind: entry.kind,
      source: entry.source,
      lines: entry.lines,
      chars: entry.chars,
      last_seen_at: entry.last_seen_at,
      previous_capsule_id: entry.previous_capsule_id,
    }));
  return { response: { capsules: entries }, capturedChars: 0 };
}

function recordExposure(operation, capturedChars, emittedChars) {
  const state = ensureState();
  const ledger = readJson(state.ledger, { events: [] });
  ledger.events.push({
    at: new Date().toISOString(),
    operation,
    captured_chars: Math.max(0, capturedChars || 0),
    emitted_chars: Math.max(0, emittedChars || 0),
  });
  if (ledger.events.length > 10000) ledger.events = ledger.events.slice(-10000);
  writeJsonAtomic(state.ledger, ledger);
}

function exposureLedger(args = {}) {
  const state = ensureState();
  const ledger = readJson(state.ledger, { events: [] });
  const recent = clampInt(args.recent, ledger.events.length || 1, 1, 10000);
  const events = ledger.events.slice(-recent);
  const captured = events.reduce((sum, event) => sum + event.captured_chars, 0);
  const emitted = events.reduce((sum, event) => sum + event.emitted_chars, 0);
  const avoided = Math.max(0, captured - emitted);
  const ratio = captured ? Number((avoided / captured).toFixed(4)) : 0;
  const avoidedTokens = approxTokens(avoided);
  const byOperation = {};
  for (const event of events) {
    const current = byOperation[event.operation] || { calls: 0, captured_chars: 0, emitted_chars: 0 };
    current.calls += 1;
    current.captured_chars += event.captured_chars;
    current.emitted_chars += event.emitted_chars;
    byOperation[event.operation] = current;
  }
  return {
    response: {
      events: events.length,
      captured: { chars: captured, approx_tokens: approxTokens(captured) },
      emitted: { chars: emitted, approx_tokens: approxTokens(emitted) },
      avoided: { chars: avoided, approx_tokens: avoidedTokens, ratio },
      dollar_estimate: estimateInputSavingsUsd(avoidedTokens, args),
      by_operation: byOperation,
      caveat: "Approximate avoidable context exposure at four characters per token; not provider billing.",
    },
    capturedChars: 0,
  };
}

module.exports = {
  approxTokens,
  changedRegion,
  chooseAnchors,
  decodeLineDictionary,
  diffCapsules,
  encodeLineDictionary,
  estimateTokens,
  estimateInputSavingsUsd,
  commandSpawnPlan,
  expandAnchor,
  exposureLedger,
  listCapsules,
  loadCapsule,
  maintainCapsuleCache,
  recordExposure,
  renderOperation,
  saveCapsule,
  smartCommand,
  resultFutureCommand,
  smartFile,
  stateRoot,
  surveyCommand,
  surveyFile,
  tokenSafe,
};
