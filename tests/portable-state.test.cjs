"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const core = require("../mcp/core.cjs");

test("new users receive platform-native Capsule state roots", () => {
  const never = () => false;
  assert.equal(
    core.stateRoot({ platform: "win32", home: "C:\\Users\\demo", env: { LOCALAPPDATA: "C:\\Local" }, exists: never }),
    path.join("C:\\Local", "Capsule")
  );
  assert.equal(
    core.stateRoot({ platform: "darwin", home: "/Users/demo", env: {}, exists: never }),
    path.join("/Users/demo", "Library", "Application Support", "Capsule")
  );
  assert.equal(
    core.stateRoot({ platform: "linux", home: "/home/demo", env: {}, exists: never }),
    path.join("/home/demo", ".local", "state", "capsule")
  );
  assert.equal(
    core.stateRoot({ platform: "linux", home: "/home/demo", env: { XDG_STATE_HOME: "/state" }, exists: never }),
    path.join("/state", "capsule")
  );
});

test("obsolete state directories are not selected", () => {
  const obsolete = path.join("/home/demo", ".local", "state", "capsule");
  const actual = core.stateRoot({
    platform: "linux",
    home: "/home/demo",
    env: {},
    exists: (candidate) => candidate === obsolete,
  });
  assert.equal(actual, path.join("/home/demo", ".local", "state", "capsule"));
});

test("Capsule state uses its public environment override", () => {
  assert.equal(
    core.stateRoot({
      platform: "linux",
      home: "/home/demo",
      env: { CAPSULE_STATE: "/capsule" },
      exists: () => false,
    }),
    path.resolve("/capsule")
  );
});
