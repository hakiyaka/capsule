"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

test("public documentation audit passes", () => {
  const root = path.resolve(__dirname, "..");
  const output = execFileSync(process.execPath, [path.join(root, "scripts", "docs-audit.cjs")], {
    cwd: root,
    encoding: "utf8",
  });
  const report = JSON.parse(output);
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.ok(report.inspected_files >= 10);
});
