"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const core = require("./core.cjs");
const storage = require("./storage.cjs");

const RUNTIME_PROFILE_TTL_MS = 15 * 60 * 1000;
const RUNTIME_PROFILE_MAX_ENTRIES = 32;
const COMMAND_PROBE_MAX_ENTRIES = 256;
const commandProbeCache = new Map();
const runtimeProfileCache = new Map();

function cacheSet(cache, key, value, maxEntries) {
  const now = Date.now();
  for (const [candidate, entry] of cache) {
    if (Number(entry?.expires_at) <= now) cache.delete(candidate);
  }
  cache.set(key, value);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function int(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function environmentValue(env, name, fallback = "") {
  if (Object.prototype.hasOwnProperty.call(env || {}, name)) return env[name];
  const key = Object.keys(env || {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key == null ? fallback : env[key];
}

function shortHash(value) {
  return storage.sha256(value).slice(0, 12);
}

function normalizedCwd(value, platform) {
  const resolved = path.resolve(value || process.cwd());
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathFingerprint(env, platform = process.platform) {
  const pathValue = String(environmentValue(env, "PATH", ""));
  const entries = pathValue.split(platform === "win32" ? ";" : ":").map((item) => item.trim()).filter(Boolean);
  return {
    entries: entries.length,
    hash: shortHash(pathValue),
  };
}

function profileKey({ cwd, platform, env }) {
  const resolvedCwd = path.resolve(cwd || process.cwd());
  const localPythonPaths = platform === "win32"
    ? [path.join(".venv", "Scripts", "python.exe"), path.join("venv", "Scripts", "python.exe")]
    : [path.join(".venv", "bin", "python"), path.join("venv", "bin", "python")];
  return shortHash(JSON.stringify({
    cwd: normalizedCwd(resolvedCwd, platform),
    platform,
    arch: process.arch,
    path: environmentValue(env, "PATH", ""),
    pathext: environmentValue(env, "PATHEXT", ""),
    shell: environmentValue(env, "ComSpec", environmentValue(env, "SHELL", "")),
    virtual_env: environmentValue(env, "VIRTUAL_ENV", ""),
    conda_prefix: environmentValue(env, "CONDA_PREFIX", ""),
    workspace_python: localPythonPaths.map((relative) => [relative, fs.existsSync(path.join(resolvedCwd, relative))]),
  }));
}

function commandExists(command, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const cacheKey = `${platform}\0${cwd}\0${command}\0${environmentValue(env, "PATH", "")}\0${environmentValue(env, "PATHEXT", "")}`;
  const cached = commandProbeCache.get(cacheKey);
  if (cached && cached.expires_at > Date.now()) return cached.available;
  let result;
  try {
    result = platform === "win32"
      ? spawnSync("where.exe", [command], { cwd, env, windowsHide: true, stdio: "ignore", timeout: 2_000 })
      : spawnSync("/bin/sh", ["-lc", `command -v -- ${command}`], { cwd, env, stdio: "ignore", timeout: 2_000 });
  } catch {
    result = { status: 1 };
  }
  const available = result.status === 0;
  cacheSet(commandProbeCache, cacheKey, { available, expires_at: Date.now() + RUNTIME_PROFILE_TTL_MS }, COMMAND_PROBE_MAX_ENTRIES);
  return available;
}

function runtimeStorePath() {
  const root = path.join(core.stateRoot(), "runtime");
  return { root, file: path.join(root, "profiles.json") };
}

function readRuntimeStore() {
  const parsed = storage.readJson(runtimeStorePath().file, null);
  if (parsed && parsed.version === 1 && parsed.profiles && typeof parsed.profiles === "object") return parsed;
  return { version: 1, profiles: {} };
}

function writeRuntimeStore(store) {
  try {
    writeAtomic(runtimeStorePath().file, store);
  } catch {
    // Runtime discovery remains useful when the optional state directory is read-only.
  }
}

function profileCommand(command, source, alternatives = []) {
  return { command, source, ...(alternatives.length ? { alternatives } : {}) };
}

function runtimeProfile(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const cwd = path.resolve(options.cwd || process.cwd());
  const key = profileKey({ cwd, platform, env });
  const now = Date.now();
  const refresh = options.refresh === true;
  const injectedProbe = typeof options.probe === "function" ? options.probe : null;
  const probe = (command) => injectedProbe
    ? Boolean(injectedProbe(command, { cwd, env, platform }))
    : commandExists(command, { cwd, env, platform });

  const memoryEntry = runtimeProfileCache.get(key);
  if (!refresh && memoryEntry && Number(memoryEntry.expires_at) > now) {
    return formatRuntimeProfile(memoryEntry, { cacheHit: true, now, operation: options.operation || "snapshot" });
  }
  const diskStore = readRuntimeStore();
  const diskEntry = diskStore.profiles[key];
  if (!refresh && diskEntry && Number(diskEntry.expires_at) > now) {
    cacheSet(runtimeProfileCache, key, diskEntry, RUNTIME_PROFILE_MAX_ENTRIES);
    return formatRuntimeProfile(diskEntry, { cacheHit: true, now, operation: options.operation || "snapshot" });
  }

  const pathInfo = pathFingerprint(env, platform);
  const exists = typeof options.exists === "function" ? options.exists : fs.existsSync;
  let probeCount = 0;
  const check = (command) => {
    probeCount += 1;
    return probe(command);
  };
  const localPythonPaths = platform === "win32"
    ? [path.join(".venv", "Scripts", "python.exe"), path.join("venv", "Scripts", "python.exe")]
    : [path.join(".venv", "bin", "python"), path.join("venv", "bin", "python")];
  const pythonAlternatives = [];
  let python = null;
  for (const relative of localPythonPaths) {
    const candidate = path.join(cwd, relative);
    if (exists(candidate)) {
      python = profileCommand(`.${path.sep}${relative}`, "workspace-venv");
      break;
    }
  }
  const virtualEnv = environmentValue(env, "VIRTUAL_ENV", "");
  if (!python && virtualEnv) {
    const candidate = path.join(virtualEnv, platform === "win32" ? "Scripts" : "bin", "python");
    if (exists(candidate)) python = profileCommand("python", "VIRTUAL_ENV");
  }
  const pythonCandidates = platform === "win32"
    ? [
        ["py", "py-launcher", "py -3"],
        ["python", "PATH", "python"],
        ["python3", "PATH", "python3"],
      ]
    : [
        ["python3", "PATH", "python3"],
        ["python", "PATH", "python"],
      ];
  for (const [candidate, source, display] of pythonCandidates) {
    if (check(candidate)) {
      pythonAlternatives.push(display);
      if (!python) python = profileCommand(display, source);
    }
  }
  const shellCandidates = platform === "win32"
    ? [["pwsh", "PowerShell 7"], ["powershell", "Windows PowerShell"]]
    : [["zsh", "zsh"], ["bash", "bash"], ["sh", "sh"]];
  let shell = null;
  for (const [candidate, display] of shellCandidates) {
    if (check(candidate)) {
      shell = profileCommand(display, "PATH");
      break;
    }
  }
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const available = {
    javascript: true,
    typescript: nodeMajor >= 22,
    shell: Boolean(shell),
    python: Boolean(python),
    ruby: check("ruby"),
    php: check("php"),
    perl: check("perl"),
    r: check(platform === "win32" ? "Rscript.exe" : "Rscript"),
    elixir: check("elixir"),
    go: check("go"),
    rust: check("rustc"),
    csharp: check("dotnet-script"),
  };
  const managerCandidates = ["git", "npm", "pnpm", "yarn", "bun", "uv", "pip", "poetry", "conda"];
  const packageManagers = managerCandidates.filter((command) => check(command));
  const createdAt = new Date(now).toISOString();
  const entryToStore = {
    version: 1,
    key,
    lease_id: `env_${key}`,
    created_at: createdAt,
    expires_at: now + RUNTIME_PROFILE_TTL_MS,
    platform,
    arch: process.arch,
    workspace: path.basename(cwd),
    path: pathInfo,
    shell,
    node: { command: "node", version: process.versions.node },
    python,
    python_alternatives: [...new Set(pythonAlternatives)],
    package_managers: packageManagers,
    available,
    probe_count: probeCount,
  };
  cacheSet(runtimeProfileCache, key, entryToStore, RUNTIME_PROFILE_MAX_ENTRIES);
  const nextStore = readRuntimeStore();
  nextStore.profiles[key] = entryToStore;
  const entries = Object.entries(nextStore.profiles)
    .sort((left, right) => Number(right[1].created_at ? Date.parse(right[1].created_at) : 0) - Number(left[1].created_at ? Date.parse(left[1].created_at) : 0))
    .slice(0, RUNTIME_PROFILE_MAX_ENTRIES);
  nextStore.profiles = Object.fromEntries(entries);
  writeRuntimeStore(nextStore);
  return formatRuntimeProfile(entryToStore, { cacheHit: false, now, operation: options.operation || "snapshot" });
}

function formatRuntimeProfile(profile, { cacheHit, now, operation = "snapshot" }) {
  const safe = profile && typeof profile === "object" ? profile : {};
  const safePath = safe.path && typeof safe.path === "object" ? safe.path : {};
  const safeNode = safe.node && typeof safe.node === "object"
    ? { command: String(safe.node.command || "node"), version: String(safe.node.version || "unknown") }
    : { command: "node", version: "unknown" };
  const safePython = safe.python && typeof safe.python === "object" ? safe.python : null;
  const safeShell = safe.shell && typeof safe.shell === "object" ? safe.shell : null;
  const safeManagers = Array.isArray(safe.package_managers)
    ? safe.package_managers.filter((item) => typeof item === "string")
    : [];
  const safeAlternatives = Array.isArray(safe.python_alternatives)
    ? safe.python_alternatives.filter((item) => typeof item === "string")
    : [];
  const safeAvailable = safe.available && typeof safe.available === "object" ? safe.available : {};
  const leaseId = String(safe.lease_id || "env_unknown");
  const platform = String(safe.platform || "unknown");
  const arch = String(safe.arch || "unknown");
  const workspace = String(safe.workspace || "unknown");
  const python = safePython && safePython.command ? String(safePython.command) : "missing";
  const shell = safeShell && safeShell.command ? String(safeShell.command) : "missing";
  const managers = safeManagers.length ? safeManagers.join(",") : "none";
  const pathEntries = Number.isFinite(Number(safePath.entries)) ? Number(safePath.entries) : 0;
  const pathHash = String(safePath.hash || "unknown");
  const expiresAt = Number.isFinite(Number(safe.expires_at)) ? Number(safe.expires_at) : 0;
  const probeCount = Number.isFinite(Number(safe.probe_count)) ? Number(safe.probe_count) : 0;
  const responseText = [
    `Environment lease ${leaseId}: ${platform}/${arch}; workspace=${workspace}; shell=${shell}; node=${safeNode.version}; python=${python}; managers=${managers}.`,
    `PATH entries=${pathEntries}, fingerprint=${pathHash}; cache=${cacheHit ? "hit" : "miss"}; reuse_until=${expiresAt}. Raw PATH and environment values omitted.`,
  ].join(" ");
  return {
    response: {
      operation,
      lease_id: leaseId,
      platform,
      arch,
      workspace,
      shell: safeShell,
      node: safeNode,
      python: safePython,
      python_alternatives: safeAlternatives,
      package_managers: safeManagers,
      available: safeAvailable,
      path: { entries: pathEntries, hash: pathHash },
      cache_hit: cacheHit,
      expires_at: expiresAt,
      probe_count: probeCount,
      savings: {
        repeated_probe_calls_avoided: cacheHit ? probeCount : 0,
        model_visible_chars: responseText.length,
        note: "Local probes are cached; no provider billing or hidden-reasoning saving is inferred.",
      },
    },
    responseText,
    route: "environment-lease",
    capturedChars: 0,
    ...(now ? { observed_at: new Date(now).toISOString() } : {}),
  };
}

function invalidateRuntimeProfile(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const cwd = path.resolve(options.cwd || process.cwd());
  const key = profileKey({ cwd, platform, env });
  runtimeProfileCache.delete(key);
  const store = readRuntimeStore();
  const removed = Boolean(store.profiles[key]);
  delete store.profiles[key];
  if (removed) writeRuntimeStore(store);
  return { response: { operation: "invalidate", removed, lease_key: `env_${key}` }, capturedChars: 0 };
}

function environmentProfile(args = {}) {
  const operation = String(args.operation || args.op || "snapshot").toLowerCase();
  if (["invalidate", "reset", "clear"].includes(operation)) return invalidateRuntimeProfile(args);
  if (!["snapshot", "status", "refresh"].includes(operation)) {
    throw new Error("environment operation must be snapshot, status, refresh, or invalidate");
  }
  return runtimeProfile({ ...args, operation, refresh: operation === "refresh" || args.refresh === true });
}

function runtimeStatus(options = {}) {
  const profile = runtimeProfile(options).response;
  const available = {
    ...profile.available,
  };
  return {
    available,
    available_count: Object.values(available).filter(Boolean).length,
    total: Object.keys(available).length,
    lease_id: profile.lease_id,
    cache_hit: profile.cache_hit,
    probe_count: profile.probe_count,
  };
}

function writeAtomic(file, value) {
  return storage.writeJsonAtomic(file, value, { pretty: true });
}

function jobsPath() {
  const root = path.join(core.stateRoot(), "jobs");
  fs.mkdirSync(root, { recursive: true });
  return { root, catalog: path.join(root, "jobs.json") };
}

function readJobs() {
  return storage.readJson(jobsPath().catalog, { version: 1, jobs: {} }, { onError: "missing" });
}

function saveJobs(value) {
  writeAtomic(jobsPath().catalog, value);
}

function escapeSingle(value) {
  return String(value).replaceAll("'", "''");
}

function invocationFor(language, code, sourcePath, scratch) {
  const normalized = String(language || "javascript").toLowerCase();
  const sourceLiteral = sourcePath ? JSON.stringify(sourcePath) : "null";
  if (normalized === "javascript" || normalized === "typescript") {
    const extension = normalized === "typescript" ? ".ts" : ".cjs";
    const script = path.join(scratch, `program${extension}`);
    const prefix = sourcePath
      ? `const FILE_CONTENT = require("node:fs").readFileSync(${sourceLiteral}, "utf8");\nconst FILE_PATH = ${sourceLiteral};\n`
      : "const FILE_CONTENT = undefined;\nconst FILE_PATH = undefined;\n";
    fs.writeFileSync(script, `${prefix}${code}\n`, "utf8");
    return {
      command: process.execPath,
      args: normalized === "typescript" ? ["--experimental-strip-types", script] : [script],
      script,
    };
  }
  if (normalized === "python") {
    const script = path.join(scratch, "program.py");
    const prefix = sourcePath
      ? `from pathlib import Path\nFILE_PATH = ${JSON.stringify(sourcePath)}\nFILE_CONTENT = Path(FILE_PATH).read_text(encoding="utf-8")\n`
      : "FILE_PATH = None\nFILE_CONTENT = None\n";
    fs.writeFileSync(script, `${prefix}${code}\n`, "utf8");
    return { command: "python", args: [script], script };
  }
  if (normalized === "shell") {
    if (process.platform === "win32") {
      const script = path.join(scratch, "program.ps1");
      const prefix = sourcePath
        ? `$FILE_PATH = '${escapeSingle(sourcePath)}'\n$FILE_CONTENT = Get-Content -Raw -LiteralPath $FILE_PATH\n`
        : "$FILE_PATH = $null\n$FILE_CONTENT = $null\n";
      fs.writeFileSync(script, `${prefix}${code}\n`, "utf8");
      return { command: "powershell", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script], script };
    }
    const script = path.join(scratch, "program.sh");
    const prefix = sourcePath
      ? `FILE_PATH='${String(sourcePath).replaceAll("'", "'\\''")}'\nFILE_CONTENT=$(cat -- "$FILE_PATH")\nexport FILE_PATH FILE_CONTENT\n`
      : "FILE_PATH=\nFILE_CONTENT=\nexport FILE_PATH FILE_CONTENT\n";
    fs.writeFileSync(script, `${prefix}${code}\n`, "utf8");
    return { command: "/bin/sh", args: [script], script };
  }
  if (normalized === "ruby") {
    const script = path.join(scratch, "program.rb");
    const prefix = sourcePath
      ? `FILE_PATH = ${JSON.stringify(sourcePath)}\nFILE_CONTENT = File.read(FILE_PATH, encoding: "UTF-8")\n`
      : "FILE_PATH = nil\nFILE_CONTENT = nil\n";
    fs.writeFileSync(script, `${prefix}${code}\n`, "utf8");
    return { command: "ruby", args: [script], script };
  }
  if (normalized === "php") {
    const script = path.join(scratch, "program.php");
    const prefix = sourcePath
      ? `<?php\n$FILE_PATH = ${JSON.stringify(sourcePath)};\n$FILE_CONTENT = file_get_contents($FILE_PATH);\n`
      : "<?php\n$FILE_PATH = null;\n$FILE_CONTENT = null;\n";
    fs.writeFileSync(script, `${prefix}${code}\n`, "utf8");
    return { command: "php", args: [script], script };
  }
  if (normalized === "perl") {
    const script = path.join(scratch, "program.pl");
    const prefix = sourcePath
      ? `my $FILE_PATH = ${JSON.stringify(sourcePath)};\nopen my $fh, '<:encoding(UTF-8)', $FILE_PATH or die $!;\nlocal $/; my $FILE_CONTENT = <$fh>;\n`
      : "my $FILE_PATH = undef;\nmy $FILE_CONTENT = undef;\n";
    fs.writeFileSync(script, `${prefix}${code}\n`, "utf8");
    return { command: "perl", args: [script], script };
  }
  if (normalized === "r") {
    const script = path.join(scratch, "program.R");
    const prefix = sourcePath
      ? `FILE_PATH <- ${JSON.stringify(sourcePath)}\nFILE_CONTENT <- paste(readLines(FILE_PATH, warn=FALSE, encoding="UTF-8"), collapse="\\n")\n`
      : "FILE_PATH <- NULL\nFILE_CONTENT <- NULL\n";
    fs.writeFileSync(script, `${prefix}${code}\n`, "utf8");
    return { command: "Rscript", args: [script], script };
  }
  if (normalized === "elixir") {
    const script = path.join(scratch, "program.exs");
    const prefix = sourcePath
      ? `file_path = ${JSON.stringify(sourcePath)}\nfile_content = File.read!(file_path)\n`
      : "file_path = nil\nfile_content = nil\n";
    fs.writeFileSync(script, `${prefix}${code}\n`, "utf8");
    return { command: "elixir", args: [script], script };
  }
  if (normalized === "go") {
    const script = path.join(scratch, "main.go");
    fs.writeFileSync(script, code, "utf8");
    const args = ["run", script];
    if (sourcePath) {
      const helper = path.join(scratch, "capsule_input.go");
      fs.writeFileSync(helper, [
        "package main",
        "import \"os\"",
        `var FILE_PATH = ${JSON.stringify(sourcePath)}`,
        "var FILE_CONTENT = func() string { value, _ := os.ReadFile(FILE_PATH); return string(value) }()",
        "",
      ].join("\n"), "utf8");
      args.push(helper);
    }
    return { command: "go", args, script };
  }
  if (normalized === "rust") {
    const script = path.join(scratch, "main.rs");
    const output = path.join(scratch, process.platform === "win32" ? "program.exe" : "program");
    const injected = sourcePath
      ? String(code).replace(/fn\s+main\s*\(\s*\)\s*\{/,
        (opening) => `${opening}\nlet FILE_PATH = ${JSON.stringify(sourcePath)};\nlet FILE_CONTENT = std::fs::read_to_string(FILE_PATH).unwrap();`)
      : code;
    if (sourcePath && injected === code) throw new Error("Rust file derivation requires code containing fn main() {");
    fs.writeFileSync(script, injected, "utf8");
    return { compile: { command: "rustc", args: [script, "-o", output] }, command: output, args: [], script };
  }
  if (normalized === "csharp") {
    const script = path.join(scratch, "program.cs");
    const prefix = sourcePath
      ? `var FILE_PATH = ${JSON.stringify(sourcePath)};\nvar FILE_CONTENT = System.IO.File.ReadAllText(FILE_PATH);\n`
      : "string? FILE_PATH = null;\nstring? FILE_CONTENT = null;\n";
    fs.writeFileSync(script, `${prefix}${code}\n`, "utf8");
    return { command: "dotnet-script", args: [script], script };
  }
  throw new Error(`unsupported language: ${language}`);
}

function captureProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const maxBytes = int(options.max_output_bytes, 32 * 1024 * 1024, 4_096, 128 * 1024 * 1024);
    const timeout = int(options.timeout_ms, 30_000, 100, 300_000);
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let overflow = false;
    const timer = setTimeout(() => child.kill(), timeout);
    const collect = (bucket, chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        overflow = true;
        child.kill();
      } else bucket.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (overflow) {
        reject(new Error(`execution output exceeded max_output_bytes (${maxBytes})`));
        return;
      }
      resolve({
        exit_code: code,
        signal,
        elapsed_ms: Date.now() - started,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function executeCode(args = {}, helpers = {}) {
  if (typeof args.code !== "string") throw new Error("code is required");
  const sourcePath = args.path ? path.resolve(args.path) : null;
  if (sourcePath && !fs.statSync(sourcePath).isFile()) throw new Error(`path is not a file: ${sourcePath}`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-exec-"));
  const invocation = invocationFor(args.language || "javascript", args.code, sourcePath, scratch);
  const environment = {
    ...process.env,
    CAPSULE_FILE: sourcePath || "",
    ...(args.env || {}),
  };
  if (invocation.compile) {
    const compiled = await captureProcess(invocation.compile.command, invocation.compile.args, {
      cwd: scratch,
      env: environment,
      timeout_ms: args.timeout_ms,
      max_output_bytes: args.max_output_bytes,
    });
    if (compiled.exit_code !== 0) {
      fs.rmSync(scratch, { recursive: true, force: true });
      const text = `# stdout\n${compiled.stdout}\n# stderr\n${compiled.stderr}`;
      return { responseText: text, route: "passthrough", capturedChars: text.length };
    }
  }
  if (args.background === true) {
    const state = jobsPath();
    const jobId = `job_${cryptoRandom(12)}`;
    const stdoutPath = path.join(state.root, `${jobId}.stdout.log`);
    const stderrPath = path.join(state.root, `${jobId}.stderr.log`);
    const stdoutFd = fs.openSync(stdoutPath, "a");
    const stderrFd = fs.openSync(stderrPath, "a");
    const child = spawn(invocation.command, invocation.args, {
      cwd: scratch,
      env: environment,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
    child.unref();
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    const jobs = readJobs();
    jobs.jobs[jobId] = {
      job_id: jobId,
      pid: child.pid,
      language: args.language || "javascript",
      created_at: new Date().toISOString(),
      scratch,
      stdout: stdoutPath,
      stderr: stderrPath,
    };
    saveJobs(jobs);
    return { response: { ...jobs.jobs[jobId], running: true }, capturedChars: 0 };
  }

  try {
    const result = await captureProcess(invocation.command, invocation.args, {
      cwd: scratch,
      env: environment,
      timeout_ms: args.timeout_ms,
      max_output_bytes: args.max_output_bytes,
    });
    const text = `# stdout\n${result.stdout}\n# stderr\n${result.stderr}`;
    const saved = core.saveCapsule({
      kind: "execution",
      source: JSON.stringify({ language: args.language || "javascript", sourcePath }),
      text,
      question: args.intent || args.query || "",
      maxChars: args.max_chars || 1_200,
      details: result,
    });
    if (args.intent && text.length > int(args.index_threshold_chars, 5_000, 0, 1_000_000) && helpers.addDocument) {
      helpers.addDocument({
        source: `execution://${saved.response.capsule_id}`,
        title: args.intent,
        content: text,
        kind: "execution",
        tags: ["execution", args.language || "javascript"],
      });
      const searched = helpers.searchIndex({ query: args.intent, kind: "execution", limit: 5 });
      return {
        response: {
          route: "indexed",
          capsule_id: saved.response.capsule_id,
          exit_code: result.exit_code,
          elapsed_ms: result.elapsed_ms,
          search: searched.response,
        },
        capturedChars: text.length,
      };
    }
    const compact = helpers.compressText(text, {
      profile: args.profile || "generic",
      query: args.intent || args.query,
      max_chars: args.max_chars,
      passthrough_chars: args.passthrough_chars,
    });
    return helpers.attachArchive(compact, saved.response.capsule_id, {
      exit_code: result.exit_code,
      elapsed_ms: result.elapsed_ms,
      language: args.language || "javascript",
      scratch_isolated: true,
      security_note: "Scratch-directory isolation is not an OS security sandbox.",
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function cryptoRandom(length) {
  return require("node:crypto").randomBytes(length).toString("hex").slice(0, length);
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readTail(file, maxChars) {
  if (!fs.existsSync(file)) return "";
  const size = fs.statSync(file).size;
  const bytes = Math.min(size, maxChars * 2);
  const handle = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    fs.readSync(handle, buffer, 0, bytes, size - bytes);
    return buffer.toString("utf8").slice(-maxChars);
  } finally {
    fs.closeSync(handle);
  }
}

function jobs(args = {}) {
  const operation = args.operation || "list";
  const catalog = readJobs();
  const entries = Object.values(catalog.jobs).map((job) => ({ ...job, running: isRunning(job.pid) }));
  if (operation === "list") return { response: { jobs: entries }, capturedChars: 0 };
  const job = catalog.jobs[args.job_id];
  if (!job) throw new Error(`job not found: ${args.job_id}`);
  if (operation === "status") return { response: { ...job, running: isRunning(job.pid) }, capturedChars: 0 };
  if (operation === "log") {
    const maxChars = int(args.max_chars, 8_000, 200, 50_000);
    return {
      response: {
        job_id: job.job_id,
        running: isRunning(job.pid),
        stdout: readTail(job.stdout, maxChars),
        stderr: readTail(job.stderr, maxChars),
      },
      capturedChars: 0,
    };
  }
  if (operation === "stop") {
    if (args.confirm !== true) throw new Error("confirm:true is required");
    const running = isRunning(job.pid);
    if (running) process.kill(job.pid);
    return { response: { job_id: job.job_id, stopped: running }, capturedChars: 0 };
  }
  if (operation === "remove") {
    if (args.confirm !== true) throw new Error("confirm:true is required");
    if (isRunning(job.pid)) throw new Error("stop the job before removing it");
    for (const file of [job.stdout, job.stderr]) if (fs.existsSync(file)) fs.unlinkSync(file);
    if (job.scratch && fs.existsSync(job.scratch)) fs.rmSync(job.scratch, { recursive: true, force: true });
    delete catalog.jobs[job.job_id];
    saveJobs(catalog);
    return { response: { removed: job.job_id }, capturedChars: 0 };
  }
  throw new Error(`unknown jobs operation: ${operation}`);
}

module.exports = {
  environmentProfile,
  executeCode,
  jobs,
  runtimeProfile,
  runtimeStatus,
};
