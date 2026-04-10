#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function commandWorks(command) {
  const result = spawnSync(command, ["--version"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore",
    timeout: 3000,
    windowsHide: true,
  });
  return result.status === 0;
}

function winPath(...parts) {
  return parts.some((part) => !part) ? null : path.join(...parts);
}

function bashCandidates() {
  const candidates = [];
  if (process.env.BASH_BIN) {
    candidates.push(process.env.BASH_BIN);
  }
  if (process.platform === "win32") {
    candidates.push(
      "bash",
      winPath(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
      winPath(process.env.ProgramFiles, "Git", "usr", "bin", "bash.exe"),
      winPath(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
      winPath(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe")
    );
  } else {
    candidates.push("bash", "/bin/bash", "/usr/bin/bash");
  }
  return candidates.filter(Boolean);
}

function resolveBash() {
  for (const candidate of bashCandidates()) {
    if (commandWorks(candidate)) {
      return candidate;
    }
  }
  return null;
}

function usage() {
  process.stderr.write("usage: run_sh.mjs ./scripts/script.sh [args...]\n");
}

const [script, ...args] = process.argv.slice(2);
if (!script) {
  usage();
  process.exit(2);
}

const scriptPath = path.resolve(process.cwd(), script);
if (!fs.existsSync(scriptPath)) {
  process.stderr.write(`run_sh.mjs: script not found: ${script}\n`);
  process.exit(2);
}

const bash = resolveBash();
if (!bash) {
  process.stderr.write(`run_sh.mjs: Bash is required to run ${script}.\n`);
  if (process.platform === "win32") {
    process.stderr.write("run_sh.mjs: Install Git for Windows, rerun `npm run bootstrap:env`, or set BASH_BIN to bash.exe.\n");
  } else {
    process.stderr.write("run_sh.mjs: Install bash with your platform package manager.\n");
  }
  process.exit(127);
}

const result = spawnSync(bash, [scriptPath, ...args], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) {
  process.stderr.write(`run_sh.mjs: ${result.error.message}\n`);
  process.exit(1);
}
if (result.signal) {
  process.stderr.write(`run_sh.mjs: ${script} terminated by ${result.signal}\n`);
  process.exit(1);
}
process.exit(result.status ?? 0);
