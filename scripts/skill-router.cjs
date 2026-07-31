#!/usr/bin/env node
"use strict";

const unified = require("../mcp/unified.cjs");

async function main() {
  const operation = String(process.argv[2] || "route").toLowerCase();
  const confirm = process.argv.includes("--confirm");
  const query = operation === "route"
    ? process.argv.slice(3).filter((value) => value !== "--confirm").join(" ").trim()
    : "";
  const result = await unified.dispatch({
    action: "skills",
    payload: {
      operation,
      ...(query ? { query } : {}),
      ...(confirm ? { confirm: true } : {}),
    },
  });
  process.stdout.write(`${JSON.stringify({ ...result.response, transport: "local-cli" })}\n`);
}

main().catch((error) => {
  process.stderr.write(`Capsule skill router error: ${error.message}\n`);
  process.exitCode = 1;
}).finally(() => {
  unified.closeSearchDatabase();
});
