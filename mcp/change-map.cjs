"use strict";

const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_HUNKS = 8;

function count(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(maximum, parsed)) : fallback;
}

function decodeGitPath(value) {
  const source = String(value || "").trim();
  if (!source.startsWith('"') || !source.endsWith('"')) return source;
  const bytes = [];
  for (let index = 1; index < source.length - 1; index += 1) {
    const character = source[index];
    if (character !== "\\" || index + 1 >= source.length - 1) {
      bytes.push(...Buffer.from(character, "utf8"));
      continue;
    }
    const escaped = source[++index];
    const octal = source.slice(index, index + 3);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      index += 2;
      continue;
    }
    const controls = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
    if (Object.hasOwn(controls, escaped)) bytes.push(controls[escaped]);
    else bytes.push(...Buffer.from(escaped, "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

function firstGitPath(value) {
  const source = String(value || "").trim();
  const match = source.match(/^("(?:\\.|[^\"])*"|[^\t ]+)/);
  return match ? decodeGitPath(match[1]) : "";
}

function pathFromHeader(value) {
  const path = firstGitPath(value);
  if (!path || path === "/dev/null") return "";
  return path.replace(/^[ab]\//, "");
}

function diffPaths(line) {
  if (!String(line).startsWith("diff --git ")) return null;
  const source = String(line).slice("diff --git ".length);
  const paths = source.match(/"(?:\\.|[^\"])*"|[^ ]+/g);
  if (!paths || paths.length !== 2) return null;
  return {
    before: decodeGitPath(paths[0]).replace(/^a\//, ""),
    after: decodeGitPath(paths[1]).replace(/^b\//, ""),
  };
}

function hunkRange(value) {
  const match = String(value).match(/^(\d+)(?:,(\d+))?$/);
  if (!match) return null;
  const start = Number(match[1]);
  const length = Number(match[2] || 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0) return null;
  return { start, count: length };
}

function hunkComplete(hunk) {
  return !hunk ||
    (hunk.consumed_old === hunk.before.count && hunk.consumed_new === hunk.after.count);
}

function parseUnifiedDiff(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const files = [];
  let current = null;
  let activeHunk = null;
  let sawHeader = false;

  for (const line of lines) {
    const paths = diffPaths(line);
    if (line.startsWith("diff --git ")) {
      if (!paths || !hunkComplete(activeHunk)) return null;
      activeHunk = null;
      sawHeader = true;
      current = { ...paths, hunks: [], additions: 0, deletions: 0, metadata: false };
      files.push(current);
      continue;
    }
    if (!current) continue;

    const header = line.match(/^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@/);
    if (header) {
      if (!hunkComplete(activeHunk)) return null;
      const before = hunkRange(header[1]);
      const after = hunkRange(header[2]);
      if (!before || !after) return null;
      activeHunk = { before, after, additions: 0, deletions: 0, consumed_old: 0, consumed_new: 0 };
      current.hunks.push(activeHunk);
      continue;
    }

    if (activeHunk) {
      if (line === "\\ No newline at end of file") continue;
      if (line === "" && hunkComplete(activeHunk)) continue;
      const prefix = line[0];
      let oldLines = 0;
      let newLines = 0;
      if (prefix === " ") {
        oldLines = 1;
        newLines = 1;
      } else if (prefix === "+") {
        newLines = 1;
      } else if (prefix === "-") {
        oldLines = 1;
      } else {
        return null;
      }
      activeHunk.consumed_old += oldLines;
      activeHunk.consumed_new += newLines;
      if (activeHunk.consumed_old > activeHunk.before.count ||
          activeHunk.consumed_new > activeHunk.after.count) {
        return null;
      }
      if (prefix === "+") {
        current.additions += 1;
        activeHunk.additions += 1;
      } else if (prefix === "-") {
        current.deletions += 1;
        activeHunk.deletions += 1;
      }
      continue;
    }

    if (line.startsWith("rename from ")) {
      current.before = decodeGitPath(line.slice("rename from ".length));
      current.metadata = true;
    } else if (line.startsWith("rename to ")) {
      current.after = decodeGitPath(line.slice("rename to ".length));
      current.metadata = true;
    } else if (line.startsWith("new file mode ") || line.startsWith("deleted file mode ")) {
      current.metadata = true;
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      current.metadata = true;
      current.binary = true;
    } else if (line.startsWith("--- ")) {
      current.before = pathFromHeader(line.slice(4));
      current.metadata = true;
    } else if (line.startsWith("+++ ")) {
      current.after = pathFromHeader(line.slice(4));
      current.metadata = true;
    }
  }

  if (!hunkComplete(activeHunk) || !sawHeader || !files.length ||
      files.some((file) => !file.hunks.length && !file.metadata)) {
    return null;
  }
  return files;
}

function fileStatus(file) {
  if (!file.before) return "A";
  if (!file.after) return "D";
  return file.before !== file.after ? "R" : "M";
}

function range(range) {
  if (range.count === 0) return `${range.start}:0`;
  return range.count === 1 ? String(range.start) : `${range.start}-${range.start + range.count - 1}`;
}

function safePath(value) {
  const sanitized = String(value || "(unknown)").replace(/[\u0000-\u001f\u007f]/g, "?");
  return sanitized.length > 260 ? `${sanitized.slice(0, 257)}...` : sanitized;
}

function renderUnifiedDiffManifest(text, options = {}) {
  const files = parseUnifiedDiff(text);
  if (!files) return null;
  const maxFiles = count(options.max_files, DEFAULT_MAX_FILES, 500);
  const maxHunks = count(options.max_hunks, DEFAULT_MAX_HUNKS, 100);
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  const lines = [`[Capsule change-summary v1] ${files.length} file(s), +${additions} -${deletions}`];
  for (const file of files.slice(0, maxFiles)) {
    const status = fileStatus(file);
    const target = safePath(file.after || file.before);
    const rename = status === "R" ? ` (from ${safePath(file.before)})` : "";
    const binary = file.binary ? " [binary]" : "";
    lines.push(`${status} ${target}${rename}${binary}  +${file.additions} -${file.deletions}`);
    for (const hunk of file.hunks.slice(0, maxHunks)) {
      lines.push(`  @ old:${range(hunk.before)} new:${range(hunk.after)}  +${hunk.additions} -${hunk.deletions}`);
    }
    if (file.hunks.length > maxHunks) lines.push(`  ... ${file.hunks.length - maxHunks} hunk(s) omitted`);
  }
  if (files.length > maxFiles) lines.push(`... ${files.length - maxFiles} file(s) omitted`);
  return lines;
}

module.exports = { parseUnifiedDiff, renderUnifiedDiffManifest };
