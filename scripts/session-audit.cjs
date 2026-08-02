"use strict";

const fs = require("node:fs");
const sessionAudit = require("../mcp/session-audit.cjs");

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const args = {
  codex_home: argument("--codex-home", process.env.CODEX_HOME),
  max_files: argument("--max-files", undefined),
  max_bytes: argument("--max-bytes", undefined),
  include_archived: !process.argv.includes("--no-archived"),
  on_progress: ({ index, files, bytes }) => {
    if (process.stderr.isTTY) {
      process.stderr.write("[Capsule session audit] " + index + "/" + files + " files, " + bytes + " bytes scanned\r");
    }
  },
};

const outputPath = argument("--output", undefined);

const result = sessionAudit.scanHistory(args);
if (process.stderr.isTTY) process.stderr.write("\n");
const serialized = JSON.stringify(result, null, 2) + "\n";
if (outputPath) {
  fs.writeFileSync(outputPath, Buffer.from(serialized, "utf8"));
  process.stdout.write(`${outputPath}\n`);
} else {
  process.stdout.write(serialized);
}
