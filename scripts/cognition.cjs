#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const cognition = require("../mcp/cognition.cjs");

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function payload() {
  const file = option("--file");
  const encoded = option("--payload");
  if (file) return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  if (encoded) return JSON.parse(encoded);
  const operation = String(process.argv[2] || "compile").toLowerCase();
  const positional = process.argv.slice(3).filter((value, index, all) =>
    !["--file", "--payload"].includes(value) &&
    !["--file", "--payload"].includes(all[index - 1])
  );
  if (["compile", "recall"].includes(operation)) {
    return { operation, prompt: positional.join(" ").trim() };
  }
  throw new Error("structured operations require --payload '{...}' or --file <json>");
}

try {
  const result = cognition.dispatch(payload());
  process.stdout.write(`${JSON.stringify({ ...result.response, transport: "local-cli" })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
