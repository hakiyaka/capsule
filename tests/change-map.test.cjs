"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const changeMap = require("../mcp/change-map.cjs");
const compat = require("../mcp/compat.cjs");

const DIFF = [
  "diff --git a/src/old.js b/src/new.js",
  "similarity index 90%",
  "rename from src/old.js",
  "rename to src/new.js",
  "index 1111111..2222222 100644",
  "--- a/src/old.js",
  "+++ b/src/new.js",
  "@@ -10,2 +10,3 @@ function demo() {",
  "-  old();",
  "+  newer();",
  "+  added();",
  "   keep();",
  "diff --git a/src/new-file.js b/src/new-file.js",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/src/new-file.js",
  "@@ -0,0 +1,2 @@",
  "+one();",
  "+two();",
].join("\n");

test("renders a bounded unified-diff file and hunk manifest", () => {
  const manifest = changeMap.renderUnifiedDiffManifest(DIFF, { max_files: 1, max_hunks: 1 });
  assert.deepEqual(manifest, [
    "[Capsule change-summary v1] 2 file(s), +4 -1",
    "R src/new.js (from src/old.js)  +2 -1",
    "  @ old:10-11 new:10-12  +2 -1",
    "... 1 file(s) omitted",
  ]);
});

test("rejects non-unified text and preserves the existing diff filter fallback", () => {
  const malformed = "diff --git a/a.js b/a.js\nthis is not a unified patch";
  assert.equal(changeMap.renderUnifiedDiffManifest(malformed), null);
  assert.deepEqual(compat.filterText(malformed, { profile: "diff" }).lines, ["diff --git a/a.js b/a.js"]);
});

test("compat uses the manifest for unified diffs", () => {
  const lines = compat.filterText(DIFF, { profile: "diff" }).lines;
  assert.equal(lines[0], "[Capsule change-summary v1] 2 file(s), +4 -1");
  assert.ok(lines.includes("A src/new-file.js  +2 -0"));
});

test("handles quoted paths, binary changes, and hunk lines that resemble headers", () => {
  const diff = [
    'diff --git "a/a b\\303\\251.js" "b/a b\\303\\251.js"',
    'index 1111111..2222222 100644',
    '--- "a/a b\\303\\251.js"',
    '+++ "b/a b\\303\\251.js"',
    '@@ -1 +1 @@',
    '--- removed code',
    '+++ added code',
    'diff --git "a/blob file.bin" "b/blob file.bin"',
    'index 1111111..2222222 100644',
    'Binary files "a/blob file.bin" and "b/blob file.bin" differ',
  ].join("\n");
  const lines = changeMap.renderUnifiedDiffManifest(diff);
  assert.deepEqual(lines, [
    "[Capsule change-summary v1] 2 file(s), +1 -1",
    "M a bé.js  +1 -1",
    "  @ old:1 new:1  +1 -1",
    "M blob file.bin [binary]  +0 -0",
  ]);
});

test("rejects hunk count underruns, overruns, trailing changes, and malformed body lines", () => {
  const cases = [
    [
      "diff --git a/under.js b/under.js",
      "--- a/under.js",
      "+++ b/under.js",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
    ],
    [
      "diff --git a/over.js b/over.js",
      "--- a/over.js",
      "+++ b/over.js",
      "@@ -1 +1 @@",
      " keep",
      " extra",
    ],
    [
      "diff --git a/trailing.js b/trailing.js",
      "--- a/trailing.js",
      "+++ b/trailing.js",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "+trailing",
    ],
    [
      "diff --git a/malformed.js b/malformed.js",
      "--- a/malformed.js",
      "+++ b/malformed.js",
      "@@ -1 +1 @@",
      "body without a unified-diff prefix",
    ],
  ];
  for (const lines of cases) {
    const diff = lines.join("\n");
    assert.equal(changeMap.renderUnifiedDiffManifest(diff), null, lines[0]);
  }
  const trailing = cases[2].join("\n");
  const fallback = compat.filterText(trailing, { profile: "diff" }).lines;
  assert.ok(fallback.includes("+trailing"), "fallback must retain literal changed-line evidence");
});

test("accepts exact multi-hunk counts and no-newline markers", () => {
  const diff = [
    "diff --git a/exact.js b/exact.js",
    "--- a/exact.js",
    "+++ b/exact.js",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "\\ No newline at end of file",
    "@@ -5,2 +5,2 @@",
    " shared",
    "-before",
    "+after",
  ].join("\n");
  const manifest = changeMap.renderUnifiedDiffManifest(diff);
  assert.equal(manifest[0], "[Capsule change-summary v1] 1 file(s), +2 -2");
  assert.ok(manifest.includes("  @ old:1 new:1  +1 -1"));
  assert.ok(manifest.includes("  @ old:5-6 new:5-6  +1 -1"));
});

test("caps rendered paths so hostile diff headers stay bounded", () => {
  const name = "x".repeat(2_000);
  const lines = changeMap.renderUnifiedDiffManifest([
    `diff --git a/${name} b/${name}`,
    "Binary files differ",
  ].join("\n"));
  assert.ok(lines[1].includes("..."));
  assert.ok(lines[1].length < 320);
});
