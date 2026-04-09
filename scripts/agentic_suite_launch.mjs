#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { repoRootFromMeta, loadRunnerEnv } from "./mcp_runner_support.mjs";

const ACTION = String(process.argv[2] || "open").trim() || "open";
const REPO_ROOT = repoRootFromMeta(import.meta.url);
loadRunnerEnv(REPO_ROOT);

const OFFICE_LAUNCHER = path.join(REPO_ROOT, "scripts", "agent_office_gui.mjs");
const MANIFEST_PATH = path.join(REPO_ROOT, "scripts", "platform_manifest.json");
const DEFAULT_APP_LIST = "Codex,Cursor";

function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    return {};
  }
}

function detectLinuxDistribution() {
  if (process.platform !== "linux") {
    return null;
  }
  try {
    const raw = fs.readFileSync("/etc/os-release", "utf8");
    const fields = {};
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (!match) {
        continue;
      }
      fields[match[1]] = match[2].replace(/^"/, "").replace(/"$/, "");
    }
    const id = String(fields.ID || "").toLowerCase();
    const like = String(fields.ID_LIKE || "").toLowerCase();
    if (id === "ubuntu" || like.includes("ubuntu") || like.includes("debian")) {
      return "ubuntu";
    }
    if (id === "rocky" || like.includes("rhel") || like.includes("fedora")) {
      return id === "amzn" ? "amazon-linux" : "rocky";
    }
    if (id === "amzn" || id === "amazon" || like.includes("amzn") || like.includes("amazon")) {
      return "amazon-linux";
    }
  } catch {}
  return "linux-generic";
}

function resolvePlatformLauncherConfig(manifest, launcherKey) {
  const launcher = manifest?.launchers?.[launcherKey]?.[process.platform] || {};
  const distro = detectLinuxDistribution();
  const supportedDistributions = Array.isArray(launcher.supported_distributions)
    ? launcher.supported_distributions.map((entry) => String(entry))
    : [];
  const distributionSupported =
    process.platform !== "linux" ||
    supportedDistributions.length === 0 ||
    (distro !== null && supportedDistributions.includes(distro));
  return {
    ...launcher,
    entrypoint: typeof launcher.entrypoint === "string" ? launcher.entrypoint : null,
    service_mode: typeof launcher.service_mode === "string" ? launcher.service_mode : null,
    visible_surface: typeof launcher.visible_surface === "string" ? launcher.visible_surface : null,
    supported: launcher.supported === true,
    distro,
    distribution_supported: distributionSupported,
  };
}

function parseRequestedApps() {
  return String(process.env.AGENTIC_SUITE_OPEN_APPS || DEFAULT_APP_LIST)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function commandExists(command) {
  const whichCommand = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(whichCommand, [command], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function resolveWin32ProgramFilesPath(relativePath) {
  if (process.platform !== "win32" || typeof relativePath !== "string" || !relativePath.trim()) {
    return null;
  }
  for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean)) {
    const candidate = path.resolve(root, relativePath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveWin32LocalAppDataPath(relativePath) {
  if (process.platform !== "win32" || typeof relativePath !== "string" || !relativePath.trim()) {
    return null;
  }
  const root = process.env.LOCALAPPDATA;
  if (!root) {
    return null;
  }
  const candidate = path.resolve(root, relativePath);
  return fs.existsSync(candidate) ? candidate : null;
}

function launchDarwinCandidate(candidate) {
  const appName = typeof candidate.app_name === "string" && candidate.app_name.trim()
    ? candidate.app_name.trim()
    : null;
  const appPath = typeof candidate.app_path === "string" && candidate.app_path.trim()
    ? candidate.app_path.trim()
    : null;
  if (appPath && !fs.existsSync(appPath)) {
    return false;
  }
  if (!appName && !appPath) {
    return false;
  }
  const args = appName ? ["-ga", appName] : [appPath];
  const result = spawnSync("open", args, { stdio: "ignore", timeout: 10000 });
  return result.status === 0;
}

function darwinCandidateAvailable(candidate) {
  const appPath = typeof candidate.app_path === "string" && candidate.app_path.trim()
    ? candidate.app_path.trim()
    : null;
  const appName = typeof candidate.app_name === "string" && candidate.app_name.trim()
    ? candidate.app_name.trim()
    : null;
  if (appPath) {
    return fs.existsSync(appPath);
  }
  return Boolean(appName);
}

function launchLinuxCandidate(candidate) {
  const binary = typeof candidate.binary === "string" && candidate.binary.trim()
    ? candidate.binary.trim()
    : null;
  if (!binary || !commandExists(binary)) {
    return false;
  }
  const child = spawn(binary, [], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  return true;
}

function linuxCandidateAvailable(candidate) {
  const binary = typeof candidate.binary === "string" && candidate.binary.trim()
    ? candidate.binary.trim()
    : null;
  return Boolean(binary && commandExists(binary));
}

function launchWin32Candidate(candidate) {
  const resolvedPath =
    resolveWin32ProgramFilesPath(candidate.program_files_path) ||
    resolveWin32LocalAppDataPath(candidate.local_app_data_path);
  const target =
    resolvedPath ||
    (typeof candidate.binary === "string" && candidate.binary.trim() && commandExists(candidate.binary)
      ? candidate.binary.trim()
      : null);
  if (!target) {
    return false;
  }
  const result = spawnSync("cmd.exe", ["/c", "start", "", target], {
    stdio: "ignore",
    timeout: 10000,
    windowsHide: true,
  });
  return result.status === 0;
}

function win32CandidateAvailable(candidate) {
  return Boolean(
    resolveWin32ProgramFilesPath(candidate.program_files_path) ||
    resolveWin32LocalAppDataPath(candidate.local_app_data_path) ||
    (typeof candidate.binary === "string" && candidate.binary.trim() && commandExists(candidate.binary))
  );
}

function launchCandidate(candidate) {
  if (process.platform === "darwin") {
    return launchDarwinCandidate(candidate);
  }
  if (process.platform === "linux") {
    return launchLinuxCandidate(candidate);
  }
  if (process.platform === "win32") {
    return launchWin32Candidate(candidate);
  }
  return false;
}

function candidateAvailable(candidate) {
  if (process.platform === "darwin") {
    return darwinCandidateAvailable(candidate);
  }
  if (process.platform === "linux") {
    return linuxCandidateAvailable(candidate);
  }
  if (process.platform === "win32") {
    return win32CandidateAvailable(candidate);
  }
  return false;
}

function launchRequestedApps(config, requestedApps) {
  const launched = [];
  const failed = [];
  const appMap = config?.apps && typeof config.apps === "object" ? config.apps : {};
  for (const appName of requestedApps) {
    const candidates = Array.isArray(appMap?.[appName]) ? appMap[appName] : [];
    const opened = candidates.some((candidate) => launchCandidate(candidate));
    if (opened) {
      launched.push(appName);
    } else {
      failed.push(appName);
    }
  }
  return { launched, failed };
}

function probeRequestedApps(config, requestedApps) {
  const available = [];
  const unavailable = [];
  const appMap = config?.apps && typeof config.apps === "object" ? config.apps : {};
  for (const appName of requestedApps) {
    const candidates = Array.isArray(appMap?.[appName]) ? appMap[appName] : [];
    const reachable = candidates.some((candidate) => candidateAvailable(candidate));
    if (reachable) {
      available.push(appName);
    } else {
      unavailable.push(appName);
    }
  }
  return {
    mode: "availability",
    available,
    unavailable,
    launched: [],
    failed: [],
  };
}

function callOfficeLauncher(action) {
  const completed = spawnSync(process.execPath, [OFFICE_LAUNCHER, action], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: "utf8",
    timeout: action === "status" ? 15000 : 60000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    ok: completed.status === 0,
    status: completed.status,
    stdout: String(completed.stdout || ""),
    stderr: String(completed.stderr || ""),
  };
}

function readOfficeStatus() {
  const completed = callOfficeLauncher("status");
  try {
    return JSON.parse(completed.stdout);
  } catch {
    return {
      ok: false,
      mode: "unknown",
      health: false,
      listener: false,
      ready: false,
      launchable: false,
      url: String(process.env.TRICHAT_MCP_URL || "http://127.0.0.1:8787/office/"),
      platform: process.platform,
    };
  }
}

function buildSuiteStatus(config, requestedApps, appsResult, office, browserOpened) {
  const nextActions = [];
  const appReadyCount = appsResult.mode === "availability" ? appsResult.available.length : appsResult.launched.length;
  const unavailableApps = appsResult.mode === "availability" ? appsResult.unavailable : appsResult.failed;
  if (!office.launchable) {
    nextActions.push("Run `npm run trichat:office:web:start` to bring the office HTTP surface to a ready state.");
  }
  if (!browserOpened && office.launchable) {
    nextActions.push("Run `npm run trichat:office:web` if you need the visible office browser surface immediately.");
  }
  if (unavailableApps.length > 0) {
    nextActions.push(
      appsResult.mode === "availability"
        ? `Some requested apps are not currently detectable: ${unavailableApps.join(", ")}. Browser/status fallback remains available.`
        : `Some requested apps were not launched: ${unavailableApps.join(", ")}. The office browser remains the reassurance fallback.`
    );
  }
  if (process.platform === "linux" && config.distribution_supported === false) {
    nextActions.push(
      `This Linux host is outside the primary support set (${(config.supported_distributions || []).join(", ")}); browser/status fallback stays available.`
    );
  }
  return {
    ok: office.launchable || appReadyCount > 0,
    platform: process.platform,
    distribution: config.distro,
    requested_apps: requestedApps,
    app_probe_mode: appsResult.mode,
    available_apps: appsResult.available,
    unavailable_apps: appsResult.unavailable,
    launched_apps: appsResult.launched,
    failed_apps: appsResult.failed,
    office,
    suite_launcher: {
      supported: config.supported === true,
      distribution_supported: config.distribution_supported !== false,
      entrypoint: config.entrypoint,
      service_mode: config.service_mode,
      visible_surface: config.visible_surface,
    },
    reassurance_surface:
      appReadyCount > 0 ? "app" : browserOpened || office.launchable ? "browser" : "status",
    browser_fallback_opened: browserOpened,
    next_actions: nextActions,
  };
}

function printStatus() {
  const manifest = loadManifest();
  const config = resolvePlatformLauncherConfig(manifest, "agentic_suite");
  const requestedApps = parseRequestedApps();
  const appsResult = probeRequestedApps(config, requestedApps);
  const office = readOfficeStatus();
  process.stdout.write(`${JSON.stringify(buildSuiteStatus(config, requestedApps, appsResult, office, false), null, 2)}\n`);
}

function usage() {
  process.stderr.write("usage: agentic_suite_launch.mjs [open|start|status]\n");
}

async function main() {
  if (!["open", "start", "status"].includes(ACTION)) {
    usage();
    process.exit(2);
    return;
  }
  if (ACTION === "status") {
    printStatus();
    return;
  }

  const manifest = loadManifest();
  const config = resolvePlatformLauncherConfig(manifest, "agentic_suite");
  const requestedApps = parseRequestedApps();
  const officeStart = callOfficeLauncher("start");
  const office = readOfficeStatus();

  if (ACTION === "start") {
    if (!officeStart.ok) {
      process.stderr.write(officeStart.stderr || officeStart.stdout || "Agentic Suite failed to start the office surface.\n");
      process.exit(1);
      return;
    }
    process.stdout.write(`Agentic Suite ready at ${office.url}\n`);
    return;
  }

  const appsResult = launchRequestedApps(config, requestedApps);
  const browserOpen = callOfficeLauncher("open");
  const suiteStatus = buildSuiteStatus(
    config,
    requestedApps,
    {
      mode: "launch",
      available: appsResult.launched,
      unavailable: appsResult.failed,
      ...appsResult,
    },
    office,
    browserOpen.ok
  );
  if (!browserOpen.ok && !suiteStatus.ok) {
    process.stdout.write(`${JSON.stringify(suiteStatus, null, 2)}\n`);
    process.exit(1);
    return;
  }
  if (browserOpen.ok) {
    process.stdout.write(`Agentic Suite opened at ${office.url}\n`);
  } else if (suiteStatus.reassurance_surface === "app") {
    process.stdout.write("Agentic Suite launched desktop apps; browser fallback was not opened automatically.\n");
  } else if (office.launchable) {
    process.stdout.write(`Agentic Suite is ready at ${office.url}, but the browser fallback was not opened automatically.\n`);
  }
  if (suiteStatus.next_actions.length > 0) {
    process.stdout.write(`${suiteStatus.next_actions.join("\n")}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
