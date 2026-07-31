#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function codexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

const routerFile = path.join(codexHome(), "skills", "capsule-router", "SKILL.md");
if (!fs.existsSync(routerFile)) {
  process.stdout.write(`${JSON.stringify({ refreshed: false, reason: "router is not installed", router_file: routerFile })}\n`);
  process.exit(0);
}
const previous = fs.readFileSync(routerFile, "utf8");
if (!previous.includes("managed-by-capsule")) {
  throw new Error(`refusing to replace an unmanaged skill: ${routerFile}`);
}
const skillRouter = path.resolve(__dirname, "skill-router.cjs");
const cognitionCli = path.resolve(__dirname, "cognition.cjs");
const content = [
  "---",
  "name: capsule-router",
  "description: Universal dispatcher for a virtualized specialist catalog and cognitive compiler. Use at the start of every task to load only relevant expertise and offload finite branching work.",
  "---",
  "",
  "# Virtual skill and cognition router",
  "",
  "<!-- managed-by-capsule -->",
  "",
  "Call `capsule` with `action:\"skills\"` and `payload:{operation:\"route\",query:\"short conservative English paraphrase of the literal user request\"}`.",
  "Do not add an artifact type, architecture, technology, or domain term that the user did not request; abstention is preferable to a speculative skill match.",
  "Read only `matches[0].skill_file`; an empty match means work locally. Request `limit>1` only when another specialist is required.",
  "For branching work, call `capsule` with `action:\"cognition\"` before exploring alternatives; use assignment, knapsack, path, cover, DAG, decision, or hypothesis certificates and honor the reasoning governor.",
  `If MCP is unavailable, run \`node ${JSON.stringify(skillRouter)} route \"<intent>\"\` or \`node ${JSON.stringify(cognitionCli)} compile \"<problem>\"\`.`,
  "",
].join("\n");
const temporary = `${routerFile}.${process.pid}.${Date.now()}.tmp`;
fs.writeFileSync(temporary, content, "utf8");
fs.renameSync(temporary, routerFile);
process.stdout.write(`${JSON.stringify({
  refreshed: true,
  router_file: routerFile,
  previous_chars: previous.length,
  current_chars: content.length,
  requires_restart: true,
})}\n`);
