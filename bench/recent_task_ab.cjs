"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const currentVersion = require("../package.json").version;
const currentUnified = require("../mcp/unified.cjs");
const currentCompaction = require("../mcp/compaction.cjs");

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function percent(before, after) {
  return before > 0 ? Number(((before - after) / before * 100).toFixed(2)) : 0;
}

function chars(value) {
  return JSON.stringify(value).length;
}

function textTokens(value) {
  return Math.ceil(Number(value || 0) / 4);
}

function versionTuple(value) {
  return String(value).split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(left, right) {
  const a = versionTuple(left);
  const b = versionTuple(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return String(left).localeCompare(String(right));
}

function findBaselineRoot() {
  const explicit = argument("--baseline");
  if (explicit) return path.resolve(explicit);
  const cache = path.join(os.homedir(), ".codex", "plugins", "cache", "personal", "capsule");
  if (!fs.existsSync(cache)) throw new Error("No installed Capsule cache; pass --baseline <plugin-root>.");
  const candidates = fs.readdirSync(cache, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) =>
      fs.existsSync(path.join(cache, name, "mcp", "unified.cjs")) &&
      fs.existsSync(path.join(cache, name, "mcp", "compaction.cjs"))
    )
    .sort(compareVersions);
  if (!candidates.length) throw new Error("No previous installed Capsule version found.");
  const older = candidates.filter((name) => compareVersions(name, currentVersion) < 0);
  return path.join(cache, (older.length ? older : candidates).at(-1));
}

function recentSessions(limit) {
  const explicit = argument("--session");
  if (explicit) return [path.resolve(explicit)];
  const root = argument("--sessions-root", path.join(os.homedir(), ".codex", "sessions"));
  if (!fs.existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length) {
    const folder = pending.pop();
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push({ file: target, mtime: fs.statSync(target).mtimeMs });
      }
    }
  }
  return files.sort((left, right) => right.mtime - left.mtime)
    .slice(0, limit)
    .map((item) => item.file);
}

function skillReadChars(matches) {
  const files = [...new Set((matches || []).map((match) => match.skill_file).filter(Boolean))];
  return files.reduce((sum, file) => {
    try {
      return sum + fs.readFileSync(file, "utf8").length;
    } catch {
      return sum;
    }
  }, 0);
}

async function routingBenchmark(baselineUnified) {
  const queries = [
    "verify Capsule activation after Codex restart and automatic compaction savings telemetry",
    "measure automatic context compaction token savings in another Codex thread using session telemetry",
  ];
  const cases = [];
  for (const query of queries) {
    const baseline = await baselineUnified.dispatch({
      action: "skills",
      payload: { operation: "route", query },
    });
    const treatment = await currentUnified.dispatch({
      action: "skills",
      payload: { operation: "route", query },
    });
    const baselineRouteChars = chars(baseline.response);
    const treatmentRouteChars = chars(treatment.response);
    const baselineSkillChars = skillReadChars(baseline.response.matches);
    const treatmentSkillChars = skillReadChars(treatment.response.matches);
    const before = baselineRouteChars + baselineSkillChars;
    const after = treatmentRouteChars + treatmentSkillChars;
    cases.push({
      query_sha256: require("node:crypto").createHash("sha256").update(query).digest("hex"),
      baseline_matches: baseline.response.matches.map((match) => match.name),
      treatment_matches: treatment.response.matches.map((match) => match.name),
      baseline_route_chars: baselineRouteChars,
      treatment_route_chars: treatmentRouteChars,
      baseline_required_skill_chars: baselineSkillChars,
      treatment_required_skill_chars: treatmentSkillChars,
      before_chars: before,
      after_chars: after,
      saved_percent: percent(before, after),
    });
  }
  const before = cases.reduce((sum, item) => sum + item.before_chars, 0);
  const after = cases.reduce((sum, item) => sum + item.after_chars, 0);
  return {
    scope: "Router response plus the SKILL.md reads required by positive matches.",
    before_chars: before,
    after_chars: after,
    avoided_chars: before - after,
    avoided_approx_text_tokens: textTokens(before - after),
    saved_percent: percent(before, after),
    cases,
  };
}

function compactionBenchmark(files, baselineCompaction) {
  const insightCases = [];
  const seedCases = [];
  for (const file of files) {
    const baselineAudit = baselineCompaction.auditSession({ session_file: file }).response;
    if (baselineAudit.available && baselineAudit.compactions > 0) {
      const treatmentAudit = currentUnified.insight({
        compaction: true,
        session_file: file,
      }).response.compaction;
      const before = chars(baselineAudit);
      const after = chars(treatmentAudit);
      insightCases.push({
        compactions: baselineAudit.compactions,
        before_chars: before,
        after_chars: after,
        avoided_chars: before - after,
        saved_percent: percent(before, after),
      });
    }

    const baselineSeed = baselineCompaction.buildSeed({ session_file: file }).response;
    const treatmentSeed = currentCompaction.buildSeed({ session_file: file }).response;
    if (baselineSeed.available || treatmentSeed.available) {
      const baselineContext = String(baselineSeed.context || "");
      const treatmentContext = String(treatmentSeed.context || "");
      seedCases.push({
        before_chars: baselineContext.length,
        after_chars: treatmentContext.length,
        avoided_chars: baselineContext.length - treatmentContext.length,
        saved_percent: percent(baselineContext.length, treatmentContext.length),
        baseline_capsules_retained: (baselineSeed.capsules || [])
          .filter((capsule) => baselineContext.includes(capsule)).length,
        treatment_capsules_retained: (treatmentSeed.capsules || [])
          .filter((capsule) => treatmentContext.includes(capsule)).length,
      });
    }
  }
  const insightBefore = insightCases.reduce((sum, item) => sum + item.before_chars, 0);
  const insightAfter = insightCases.reduce((sum, item) => sum + item.after_chars, 0);
  const seedBefore = seedCases.reduce((sum, item) => sum + item.before_chars, 0);
  const seedAfter = seedCases.reduce((sum, item) => sum + item.after_chars, 0);
  return {
    insight: {
      scope: "Serialized compaction audit section; treatment keeps aggregates plus the latest event.",
      before_chars: insightBefore,
      after_chars: insightAfter,
      avoided_chars: insightBefore - insightAfter,
      avoided_approx_text_tokens: textTokens(insightBefore - insightAfter),
      saved_percent: percent(insightBefore, insightAfter),
      cases: insightCases,
    },
    seed: {
      scope: "PreCompact continuation seed input; treatment uses a 1,200-char field budget and <=600-token summary target.",
      before_chars: seedBefore,
      after_chars: seedAfter,
      avoided_chars: seedBefore - seedAfter,
      avoided_approx_text_tokens: textTokens(seedBefore - seedAfter),
      saved_percent: percent(seedBefore, seedAfter),
      cases: seedCases,
    },
  };
}

async function main() {
  const baselineRoot = findBaselineRoot();
  const baselineUnified = require(path.join(baselineRoot, "mcp", "unified.cjs"));
  const baselineCompaction = require(path.join(baselineRoot, "mcp", "compaction.cjs"));
  const files = recentSessions(Math.max(1, Number(argument("--limit", "5")) || 5));
  const routing = await routingBenchmark(baselineUnified);
  const compaction = compactionBenchmark(files, baselineCompaction);
  const result = {
    generated_at: new Date().toISOString(),
    baseline_label: "installed Capsule baseline",
    treatment_label: "working tree",
    sessions_scanned: files.length,
    routing,
    compaction,
    caveat: "Local serialized-character A/B. Approximate text tokens use four characters per token; image tokens, provider billing, caching, latency, and hidden compactor generation are excluded.",
  };
  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  const write = argument("--write");
  if (write) fs.writeFileSync(path.resolve(write), rendered, "utf8");
  process.stdout.write(rendered);
  currentUnified.closeSearchDatabase();
  baselineUnified.closeSearchDatabase();
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
