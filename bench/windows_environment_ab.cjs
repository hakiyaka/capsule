"use strict";

// Deterministic A/B for setup-friction context. The baseline is a bounded
// representative Windows discovery transcript, not provider telemetry.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const runtime = require("../mcp/runtime.cjs");

const previousState = process.env.CAPSULE_STATE;
const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-environment-ab-"));
process.env.CAPSULE_STATE = state;

const pathLines = Array.from({ length: 54 }, (_, index) =>
  `C:\\Tools\\slot-${String(index + 1).padStart(2, "0")}\\bin`
);
const baseline = [
  "PS> $env:Path",
  pathLines.join(";"),
  "PS> Get-Command python,py,python3,node,npm,git | Format-List Name,Source,Version",
  "Name : python\nSource : %LOCALAPPDATA%\\Programs\\Python\\Python312\\python.exe\nVersion : 3.12.4",
  "Name : py\nSource : C:\\Windows\\py.exe\nVersion : 3.12.4",
  "Name : node\nSource : C:\\Program Files\\nodejs\\node.exe\nVersion : 22.17.0",
  "PS> py -0p",
  "-V:3.12 * %LOCALAPPDATA%\\Programs\\Python\\Python312\\python.exe",
  "PS> python --version\nPython 3.12.4",
  "PS> node --version\nv22.17.0",
  "PS> npm --version\n10.8.2",
].join("\n");

try {
  let probes = 0;
  const first = runtime.runtimeProfile({
  cwd: process.cwd(),
  refresh: true,
  probe: () => {
    probes += 1;
    return true;
  },
  });
  const afterFirst = probes;
  const cached = runtime.runtimeProfile({
  cwd: process.cwd(),
  probe: () => {
    probes += 1;
    return true;
  },
  });

  const cases = [1, 3, 10].map((repeats) => {
  const a = baseline.length * repeats;
  const b = first.responseText.length + Math.max(0, repeats - 1) * cached.responseText.length;
  const avoided = Math.max(0, a - b);
  return {
    repeats,
    naive_chars: a,
    environment_lease_chars: b,
    saving_percent: Number(((avoided / a) * 100).toFixed(2)),
    avoided_tokens_estimate: Math.floor(avoided / 4),
  };
  });

  console.log(JSON.stringify({
  benchmark: "windows-environment-ab",
  method: "A=representative repeated PATH/Python/launcher discovery transcript; B=one cached environment lease response",
  baseline_chars_per_discovery: baseline.length,
  first_local_probe_calls: afterFirst,
  cached_local_probe_calls: probes - afterFirst,
  lease_chars: first.responseText.length,
  cases,
  caveat: "Character proxy only; not provider billing, hidden reasoning, or a claim that every Windows task costs more.",
  }, null, 2));
} finally {
  if (previousState == null) delete process.env.CAPSULE_STATE;
  else process.env.CAPSULE_STATE = previousState;
  fs.rmSync(state, { recursive: true, force: true });
}
