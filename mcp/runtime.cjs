"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const core = require("./core.cjs");

function int(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function commandExists(command) {
  const result = process.platform === "win32"
    ? spawnSync("where.exe", [command], { windowsHide: true, stdio: "ignore", timeout: 2_000 })
    : spawnSync("/bin/sh", ["-lc", `command -v -- ${command}`], { stdio: "ignore", timeout: 2_000 });
  return result.status === 0;
}

function runtimeStatus() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const available = {
    javascript: true,
    typescript: nodeMajor >= 22,
    shell: process.platform === "win32" ? commandExists("powershell") : commandExists("sh"),
    python: commandExists("python"),
    ruby: commandExists("ruby"),
    php: commandExists("php"),
    perl: commandExists("perl"),
    r: commandExists("Rscript"),
    elixir: commandExists("elixir"),
    go: commandExists("go"),
    rust: commandExists("rustc"),
    csharp: commandExists("dotnet-script"),
  };
  return {
    available,
    available_count: Object.values(available).filter(Boolean).length,
    total: Object.keys(available).length,
  };
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function jobsPath() {
  const root = path.join(core.stateRoot(), "jobs");
  fs.mkdirSync(root, { recursive: true });
  return { root, catalog: path.join(root, "jobs.json") };
}

function readJobs() {
  try {
    return JSON.parse(fs.readFileSync(jobsPath().catalog, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, jobs: {} };
    throw error;
  }
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
  executeCode,
  jobs,
  runtimeStatus,
};
