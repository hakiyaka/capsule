"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const core = require("./core.cjs");
const compat = require("./compat.cjs");
const terminal = require("./terminal-novelty.cjs");

const VERIFY_PROFILES = new Set(["test", "lint", "typecheck", "build", "format-check"]);

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalPath(value) {
  const resolved = path.resolve(String(value));
  if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
  const suffix = [];
  let ancestor = resolved;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`no existing ancestor for path: ${resolved}`);
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.resolve(fs.realpathSync(ancestor), ...suffix);
}

function canonicalKey(value) {
  const normalized = path.resolve(String(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function atomicWrite(target, bytes) {
  const temporary = `${target}.capsule-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, bytes);
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

function occurrenceIndex(text, needle, occurrence) {
  if (!needle) throw new Error("edit anchor/find text must not be empty");
  const wanted = Number(occurrence ?? 1);
  if (!Number.isInteger(wanted) || wanted < 1) throw new Error("occurrence must be a positive integer");
  let cursor = 0;
  for (let count = 1; count <= wanted; count += 1) {
    const found = text.indexOf(needle, cursor);
    if (found < 0) return -1;
    if (count === wanted) return found;
    cursor = found + needle.length;
  }
  return -1;
}

function normalizeOperation(raw) {
  if (Array.isArray(raw)) {
    const [kind, first = "", second = "", option] = raw;
    if (kind === "l" || kind === "lines") {
      return { kind: "lines", start_line: first, end_line: second, text: String(option ?? "") };
    }
    if (kind === "r" || kind === "replace") {
      return {
        kind: "replace",
        find: String(first),
        text: String(second),
        ...(option === "all" ? { all: true } : { occurrence: option ?? 1 }),
      };
    }
    if (kind === "d" || kind === "delete") {
      return {
        kind: "delete",
        find: String(first),
        ...(second === "all" ? { all: true } : { occurrence: second || 1 }),
      };
    }
    if (kind === "b" || kind === "before") {
      return { kind: "before", anchor: String(first), text: String(second), occurrence: option ?? 1 };
    }
    if (kind === "a" || kind === "after") {
      return { kind: "after", anchor: String(first), text: String(second), occurrence: option ?? 1 };
    }
    if (kind === "p" || kind === "prepend") return { kind: "prepend", text: String(first) };
    if (kind === "e" || kind === "append") return { kind: "append", text: String(first) };
    throw new Error(`unknown compact edit operation: ${String(kind)}`);
  }
  if (!raw || typeof raw !== "object") throw new Error("each edit operation must be an object or tuple");
  return {
    kind: String(raw.op || raw.kind || "").toLowerCase(),
    find: String(raw.find ?? raw.old ?? ""),
    anchor: String(raw.anchor ?? ""),
    text: String(raw.text ?? raw.put ?? raw.new ?? ""),
    start_line: raw.start_line ?? raw.startLine,
    end_line: raw.end_line ?? raw.endLine,
    occurrence: raw.occurrence ?? raw.at ?? 1,
    all: raw.all === true,
  };
}

function pathMatches(left, right) {
  return canonicalKey(canonicalPath(left)) === canonicalKey(canonicalPath(right));
}

function baselineFor(target, beforeBytes, capsuleId) {
  if (!capsuleId) throw new Error(`line edits require baseline_capsule_id for ${target}`);
  const baseline = core.loadCapsule(String(capsuleId));
  const metadata = baseline.metadata || {};
  if (metadata.kind !== "file") throw new Error(`baseline capsule must be a file capsule: ${capsuleId}`);
  if (!pathMatches(metadata.source, target)) throw new Error(`baseline capsule source does not match target: ${target}`);
  const beforeSha = digest(beforeBytes);
  if (String(metadata.sha256 || "").toLowerCase() !== beforeSha) {
    throw new Error(`baseline capsule is stale for ${target}`);
  }
  return String(baseline.text).replace(/^\uFEFF/, "");
}

function lineSpans(text) {
  const spans = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") continue;
    const end = index > start && text[index - 1] === "\r" ? index - 1 : index;
    spans.push({ start, end });
    start = index + 1;
  }
  if (start < text.length) spans.push({ start, end: text.length });
  return spans;
}

function lineEdits(baseline, operations) {
  const spans = lineSpans(baseline);
  const edits = operations.map((operation) => {
    const start = Number(operation.start_line);
    const end = Number(operation.end_line);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > spans.length) {
      throw new Error(`invalid 1-based inclusive line range: ${operation.start_line}-${operation.end_line}`);
    }
    const first = spans[start - 1];
    const last = spans[end - 1];
    return {
      start_line: start,
      end_line: end,
      start: Buffer.byteLength(baseline.slice(0, first.start), "utf8"),
      end: Buffer.byteLength(baseline.slice(0, last.end), "utf8"),
      text: operation.text,
    };
  }).sort((left, right) => right.start - left.start || right.end - left.end);
  for (let index = 1; index < edits.length; index += 1) {
    if (edits[index - 1].start < edits[index].end) throw new Error("line edit ranges must not overlap");
  }
  let output = Buffer.from(baseline, "utf8");
  for (const edit of edits) {
    output = Buffer.concat([output.subarray(0, edit.start), Buffer.from(edit.text, "utf8"), output.subarray(edit.end)]);
  }
  return { text: output.toString("utf8"), replacements: edits.length, kind: "lines" };
}

function applyOperation(input, raw) {
  const operation = normalizeOperation(raw);
  if (operation.kind === "prepend" || operation.kind === "p") {
    return { text: operation.text + input, replacements: 1, kind: "prepend" };
  }
  if (operation.kind === "append" || operation.kind === "e") {
    return { text: input + operation.text, replacements: 1, kind: "append" };
  }

  const find = operation.kind === "before" || operation.kind === "after"
    ? operation.anchor
    : operation.find;
  if (!find) throw new Error(`${operation.kind || "edit"} requires exact find/anchor text`);

  if (operation.all) {
    const pieces = input.split(find);
    const count = pieces.length - 1;
    if (!count) throw new Error(`exact text not found for ${operation.kind}`);
    const replacement = operation.kind === "delete" ? "" : operation.text;
    return { text: pieces.join(replacement), replacements: count, kind: operation.kind };
  }

  const index = occurrenceIndex(input, find, operation.occurrence);
  if (index < 0) throw new Error(`exact text occurrence ${operation.occurrence} not found for ${operation.kind}`);
  let start = index;
  let end = index + find.length;
  let replacement = operation.text;
  if (operation.kind === "before" || operation.kind === "b") {
    end = index;
  } else if (operation.kind === "after" || operation.kind === "a") {
    start = index + find.length;
    end = start;
  } else if (operation.kind === "delete" || operation.kind === "d") {
    replacement = "";
  } else if (operation.kind !== "replace" && operation.kind !== "r") {
    throw new Error(`unknown edit operation: ${operation.kind}`);
  }
  return {
    text: input.slice(0, start) + replacement + input.slice(end),
    replacements: 1,
    kind: operation.kind,
  };
}

function resolveEntries(args) {
  const cwd = path.resolve(args.cwd || process.cwd());
  const requestedRoot = path.resolve(args.root || cwd);
  if (!fs.existsSync(requestedRoot) || !fs.statSync(requestedRoot).isDirectory()) {
    throw new Error(`edit root is not an existing directory: ${requestedRoot}`);
  }
  const root = fs.realpathSync(requestedRoot);
  const rawEntries = Array.isArray(args.files)
    ? args.files
    : [{ path: args.path, edits: args.edits || args.ops, expected_sha256: args.expected_sha256, baseline_capsule_id: args.baseline_capsule_id || args.expected_capsule_id, create: args.create }];
  if (!rawEntries.length) throw new Error("files or path is required");
  const resolvedEntries = rawEntries.map((entry) => {
    if (!entry || typeof entry.path !== "string" || !entry.path) throw new Error("each file requires path");
    const requestedTarget = path.resolve(cwd, entry.path);
    const target = canonicalPath(requestedTarget);
    if (!args.allow_outside_root && !inside(root, target)) {
      throw new Error(`edit target resolves outside root: ${requestedTarget} -> ${target}`);
    }
    const exists = fs.existsSync(requestedTarget);
    if (!exists && entry.create !== true && args.create !== true) {
      throw new Error(`file does not exist (set create:true to create): ${requestedTarget}`);
    }
    if (exists && !fs.statSync(target).isFile()) throw new Error(`edit target is not a file: ${target}`);
    const beforeBytes = exists ? fs.readFileSync(target) : Buffer.alloc(0);
    const bom = beforeBytes.length >= 3 &&
      beforeBytes[0] === 0xef && beforeBytes[1] === 0xbb && beforeBytes[2] === 0xbf;
    const before = beforeBytes.toString("utf8").replace(/^\uFEFF/, "");
    const beforeSha = digest(beforeBytes);
    const expected = String(entry.expected_sha256 || args.expected_sha256 || "").toLowerCase();
    if (expected && expected !== beforeSha) {
      throw new Error(`sha256 precondition failed for ${target}: expected ${expected}, got ${beforeSha}`);
    }
    const operations = entry.edits || entry.ops;
    if (!Array.isArray(operations) || !operations.length) throw new Error(`edits/ops required for ${target}`);
    const normalized = operations.map(normalizeOperation);
    const hasLines = normalized.some((operation) => operation.kind === "lines" || operation.kind === "l");
    if (hasLines && normalized.some((operation) => operation.kind !== "lines" && operation.kind !== "l")) {
      throw new Error(`line edits cannot mix with legacy text operations: ${target}`);
    }
    const baselineId = entry.baseline_capsule_id || entry.expected_capsule_id || args.baseline_capsule_id || args.expected_capsule_id;
    let after = before;
    const applied = [];
    if (hasLines) {
      const baseline = baselineFor(target, beforeBytes, baselineId);
      const result = lineEdits(baseline, normalized);
      after = result.text;
      applied.push({ op: result.kind, replacements: result.replacements, baseline_capsule_id: String(baselineId) });
    } else {
      for (const raw of operations) {
        const result = applyOperation(after, raw);
        after = result.text;
        applied.push({ op: result.kind, replacements: result.replacements });
      }
    }
    if (after === before && entry.allow_noop !== true && args.allow_noop !== true) {
      throw new Error(`edit transaction produced no change: ${target}`);
    }
    const afterBytes = Buffer.from(`${bom ? "\uFEFF" : ""}${after}`, "utf8");
    return {
      path: target,
      beforeBytes,
      afterBytes,
      before,
      after,
      beforeSha,
      afterSha: digest(afterBytes),
      applied,
      existed: exists,
    };
  });
  const targets = new Set();
  for (const entry of resolvedEntries) {
    const key = canonicalKey(entry.path);
    if (targets.has(key)) throw new Error(`duplicate canonical edit target: ${entry.path}`);
    targets.add(key);
  }
  return resolvedEntries;
}

function transactionRoot() {
  const root = path.join(core.stateRoot(), "edit-transactions");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function verificationSpecs(args, root) {
  if (args.verify == null) return [];
  const requestedRoot = path.resolve(root);
  if (!fs.existsSync(requestedRoot) || !fs.statSync(requestedRoot).isDirectory()) {
    throw new Error(`verification root is not an existing directory: ${requestedRoot}`);
  }
  const canonicalRoot = fs.realpathSync(requestedRoot);
  const raw = Array.isArray(args.verify) ? args.verify : [args.verify];
  if (!raw.length || raw.length > 8) throw new Error("verify requires between 1 and 8 commands");
  return raw.map((item, index) => {
    const spec = typeof item === "string" ? { command: item } : item;
    if (!spec || typeof spec.command !== "string" || !spec.command.trim()) {
      throw new Error(`verify[${index}] requires command`);
    }
    const profile = String(spec.profile || terminal.commandProfile(spec.command)).toLowerCase();
    if (!VERIFY_PROFILES.has(profile) && args.verify_allow_unclassified !== true) {
      throw new Error(`verify[${index}] is not a validation command; set a supported profile or verify_allow_unclassified:true`);
    }
    const requestedCwd = path.resolve(args.cwd || requestedRoot, spec.cwd || ".");
    if (!fs.existsSync(requestedCwd) || !fs.statSync(requestedCwd).isDirectory()) {
      throw new Error(`verification cwd is not an existing directory: ${requestedCwd}`);
    }
    const cwd = fs.realpathSync(requestedCwd);
    if (!args.allow_outside_root && !inside(canonicalRoot, cwd)) {
      throw new Error(`verification cwd resolves outside root: ${requestedCwd} -> ${cwd}`);
    }
    return {
      command: spec.command,
      args: Array.isArray(spec.args) ? spec.args.map(String) : [],
      cwd,
      profile: VERIFY_PROFILES.has(profile) ? profile : "custom",
      timeout_ms: spec.timeout_ms || args.verify_timeout_ms,
      max_output_bytes: spec.max_output_bytes || spec.max_bytes || args.verify_max_bytes,
    };
  });
}

function verificationProof(text, exitCode) {
  const lines = compat.redact(String(text || "")).replace(/\r\n?/g, "\n").split("\n")
    .map((line) => terminal.normalizeLine(line).trim())
    .filter(Boolean);
  const pattern = exitCode === 0
    ? /\b(?:pass(?:ed)?|success|succeeded|ok|clean|complete(?:d)?|built|finished|0 errors?|0 failures?)\b/i
    : /\b(?:error|fail(?:ed|ure)?|exception|panic|fatal|assert(?:ion)?|expected|actual|received|cannot|not found)\b/i;
  const matched = [...new Set(lines.filter((line) => pattern.test(line)))];
  const signal = exitCode === 0 ? matched.slice(-3) : matched.slice(0, 3);
  if (!signal.length) signal.push(exitCode === 0 ? "exit 0" : `exit ${exitCode}`);
  return signal.join(" | ").slice(0, 360);
}

function runVerification(specs, stopOnFailure) {
  const results = [];
  let capturedChars = 0;
  for (const spec of specs) {
    try {
      const saved = core.surveyCommand({
        command: spec.command,
        args: spec.args,
        cwd: spec.cwd,
        timeout_ms: spec.timeout_ms,
        max_output_bytes: spec.max_output_bytes,
        max_chars: 1_200,
      });
      const capsuleId = saved.response.capsule_id;
      const archived = core.loadCapsule(capsuleId);
      const exitCode = Number(archived.metadata.details.exit_code ?? 1);
      capturedChars += archived.text.length;
      results.push({
        command: spec.command,
        args: spec.args,
        profile: spec.profile,
        exit_code: exitCode,
        elapsed_ms: archived.metadata.details.elapsed_ms,
        proof: verificationProof(archived.text, exitCode),
        exact: capsuleId,
      });
      if (exitCode !== 0 && stopOnFailure) break;
    } catch (error) {
      results.push({
        command: spec.command,
        args: spec.args,
        profile: spec.profile,
        exit_code: null,
        launch_error: String(error.message || error).slice(0, 360),
      });
      if (stopOnFailure) break;
    }
  }
  return {
    results,
    capturedChars,
    passed: results.length === specs.length && results.every((item) => item.exit_code === 0),
    stopped_early: results.length < specs.length,
  };
}

function edit(args = {}) {
  if (args.operation === "undo") return undo(args);
  if (args.operation && !["edit", "preview"].includes(args.operation)) {
    throw new Error("file operation must be edit, preview, or undo");
  }
  const entries = resolveEntries(args);
  const preview = args.dry_run === true || args.operation === "preview";
  if (preview && args.verify != null) throw new Error("preview cannot run verification");
  const rootPath = path.resolve(args.root || args.cwd || process.cwd());
  const verify = verificationSpecs(args, rootPath);
  const transactionId = `edit_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
  const receipt = entries.map((entry) => ({
    path: entry.path,
    before_sha256: entry.beforeSha,
    after_sha256: entry.afterSha,
    chars_before: entry.before.length,
    chars_after: entry.after.length,
    operations: entry.applied,
  }));
  if (preview) {
    return {
      response: { operation: "preview", transaction_id: transactionId, files: receipt, committed: false },
      capturedChars: entries.reduce((sum, entry) => sum + entry.before.length, 0),
    };
  }

  const root = transactionRoot();
  const backupDir = path.join(root, transactionId);
  fs.mkdirSync(backupDir);
  const written = [];
  try {
    entries.forEach((entry, index) => {
      fs.writeFileSync(path.join(backupDir, `${index}.before`), entry.beforeBytes);
    });
    for (const entry of entries) {
      fs.mkdirSync(path.dirname(entry.path), { recursive: true });
      atomicWrite(entry.path, entry.afterBytes);
      written.push(entry);
    }
  } catch (error) {
    for (const entry of written.reverse()) {
      if (entry.existed) atomicWrite(entry.path, entry.beforeBytes);
      else fs.rmSync(entry.path, { force: true });
    }
    try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
    throw error;
  }

  const manifest = {
    transaction_id: transactionId,
    at: new Date().toISOString(),
    files: entries.map((entry, index) => ({
      path: entry.path,
      backup: `${index}.before`,
      existed: entry.existed,
      before_sha256: entry.beforeSha,
      after_sha256: entry.afterSha,
    })),
  };
  fs.writeFileSync(path.join(backupDir, "transaction.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const beforeCapsule = core.saveCapsule({
      kind: "edit-before",
      source: entry.path,
      text: entry.before,
      maxChars: 600,
      details: { transaction_id: transactionId },
    }).response.capsule_id;
    const afterCapsule = core.saveCapsule({
      kind: "edit-after",
      source: entry.path,
      text: entry.after,
      maxChars: 600,
      details: { transaction_id: transactionId },
    }).response.capsule_id;
    receipt[index].exact_before = beforeCapsule;
    receipt[index].exact_after = afterCapsule;
  }
  const verification = verify.length
    ? runVerification(verify, args.verify_stop_on_failure !== false)
    : null;
  const verificationResults = verification?.results.map((item, index) => {
    const { command: _command, args: _args, ...proof } = item;
    return { i: index + 1, ...proof };
  });
  return {
    response: {
      operation: "edit",
      transaction_id: transactionId,
      committed: true,
      undo: "file {operation:\"undo\",transaction_id,confirm:true}",
      files: receipt,
      ...(verification ? {
        proofpatch: {
          status: verification.passed ? "passed" : "failed",
          run: verification.results.length,
          ...(verification.stopped_early ? { stopped_early: true } : {}),
          results: verificationResults,
        },
      } : {}),
    },
    capturedChars: entries.reduce((sum, entry) => sum + entry.before.length, 0) +
      Number(verification?.capturedChars || 0),
  };
}

function undo(args = {}) {
  if (args.confirm !== true) throw new Error("undo requires confirm:true");
  const transactionId = String(args.transaction_id || "");
  if (!/^edit_[a-z0-9]+_[a-f0-9]{12}$/.test(transactionId)) throw new Error("valid transaction_id is required");
  const directory = path.join(transactionRoot(), transactionId);
  const manifestPath = path.join(directory, "transaction.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`edit transaction not found: ${transactionId}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.undone_at) throw new Error(`edit transaction already undone: ${transactionId}`);
  const entries = manifest.files.map((entry) => {
    const current = fs.existsSync(entry.path) ? fs.readFileSync(entry.path) : Buffer.alloc(0);
    const currentSha = digest(current);
    if (currentSha !== entry.after_sha256) {
      throw new Error(`undo refused because file changed after transaction: ${entry.path}`);
    }
    return { ...entry, before: fs.readFileSync(path.join(directory, entry.backup)) };
  });
  for (const entry of entries) {
    if (entry.existed) atomicWrite(entry.path, entry.before);
    else fs.rmSync(entry.path, { force: true });
  }
  manifest.undone_at = new Date().toISOString();
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {
    response: {
      operation: "undo",
      transaction_id: transactionId,
      restored: entries.map((entry) => entry.path),
    },
    capturedChars: entries.reduce((sum, entry) => sum + entry.before.length, 0),
  };
}

module.exports = { applyOperation, edit, verificationProof, verificationSpecs };
