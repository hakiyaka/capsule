"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
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

test("public benchmark receipts omit raw prompt and session fields", () => {
  const root = path.resolve(__dirname, "..");
  const bench = path.join(root, "bench");
  const forbidden = new Set(["query", "prompt", "session_file", "session_id", "skill_file", "transcript", "capsule_id"]);
  const offenders = [];
  function walk(value, file) {
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, file));
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (forbidden.has(key)) offenders.push(`${path.relative(root, file)}:${key}`);
        walk(child, file);
      }
    }
  }
  for (const file of fs.readdirSync(bench).filter((name) => name.endsWith(".json"))) {
    const absolute = path.join(bench, file);
    walk(JSON.parse(fs.readFileSync(absolute, "utf8")), absolute);
  }
  assert.deepEqual(offenders, []);
});

test("tagged release workflow pins the tree and verifies a deterministic archive", () => {
  const root = path.resolve(__dirname, "..");
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /remote_tag_sha/);
  assert.match(workflow, /if \[\[ -z "\$remote_tag_sha" \]\]/);
  assert.match(workflow, /Publish or repair the GitHub release[\s\S]*remote_tag_sha[\s\S]*gh release view/);
  assert.match(workflow, /TZ:\s*UTC/);
  assert.match(workflow, /sha256sum --check/);
  const liveWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "live.yml"), "utf8");
  assert.match(liveWorkflow, /workflow_run\.head_sha/);
});
