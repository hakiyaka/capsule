"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const storage = require("../mcp/storage.cjs");

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "capsule-storage-test-"));
}

test("shared storage helpers keep bounds and hashes deterministic", () => {
  assert.equal(storage.boundedInteger("12.9", 4, 0, 20), 12);
  assert.equal(storage.boundedInteger("not-a-number", 4, 0, 20), 4);
  assert.equal(storage.boundedInteger(-2, 4, 0, 20), 0);
  assert.equal(storage.clampNumber("1.5", 4, 0, 2), 1.5);
  assert.equal(storage.clampNumber("not-a-number", 4, 0, 2), 4);
  assert.equal(storage.sha256("Capsule"), storage.sha256(Buffer.from("Capsule", "utf8")));
  assert.match(storage.sha256("Capsule"), /^[a-f0-9]{64}$/);
});

test("atomic JSON writes create parents, leave no temp files, and round-trip", () => {
  const root = temporaryRoot();
  const file = path.join(root, "nested", "state.json");
  const written = storage.writeJsonAtomic(file, { version: 1, values: [1, 2, 3] });
  assert.equal(written, path.resolve(file));
  assert.deepEqual(storage.readJson(file, null), { version: 1, values: [1, 2, 3] });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["state.json"]);
});

test("JSON error policy distinguishes optional caches from required state", () => {
  const root = temporaryRoot();
  const file = path.join(root, "broken.json");
  fs.writeFileSync(file, "{broken", "utf8");
  assert.deepEqual(storage.readJson(file, { cold: true }), { cold: true });
  assert.throws(() => storage.readJson(file, {}, { onError: "missing" }), /Unexpected token|JSON/);
  assert.deepEqual(storage.readJson(path.join(root, "missing.json"), { cold: true }, { onError: "missing" }), { cold: true });
});
