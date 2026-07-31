"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

test("public repository surface passes the portable release audit", () => {
  const root = path.resolve(__dirname, "..");
  const output = execFileSync(process.execPath, [path.join(root, "scripts", "public-readiness.cjs")], {
    cwd: root,
    encoding: "utf8",
  });
  const result = JSON.parse(output);
  assert.equal(result.passed, true);
  assert.equal(result.display_name, "Capsule");
  assert.ok(result.inspected_files > 0);
});
