"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const unified = require("../mcp/unified.cjs");

test("capsule parameter errors provide a self-correcting next call", async () => {
  await assert.rejects(
    unified.dispatch({ action: "fetch", payload: {} }),
    /fetch requires payload\.url or payload\.requests/
  );
  await assert.rejects(
    unified.dispatch({ action: "expand", payload: {} }),
    /expand requires payload\.capsule_id copied from a prior cap_\*/
  );
});
