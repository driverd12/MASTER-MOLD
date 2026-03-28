import crypto from "node:crypto";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { Storage } from "../storage.js";
import { getTriChatAgentCatalog } from "../trichat_roster.js";
import { benchmarkSuiteList, benchmarkSuiteUpsert } from "./benchmark.js";
import { evalSuiteList, evalSuiteUpsert } from "./eval.js";
import { modelRouter } from "./model_router.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { getEffectiveOrgProgram, orgProgram } from "./org_program.js";
import { trichatAutopilotControl } from "./trichat.js";
import { workerFabric } from "./worker_fabric.js";

const recordSchema = z.record(z.unknown());

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const telemetryOverrideSchema = z.object({
  health_state: z.enum(["healthy", "degraded", "offline"]).optional(),
  queue_depth: z.number().int().min(0).max(100000).optional(),
  active_tasks: z.number().int().min(0).max(100000).optional(),
  latency_ms: z.number().min(0).max(10000000).optional(),
  cpu_utilization: z.number().min(0).max(1).optional(),
  ram_available_gb: z.number().min(0).max(1000000).optional(),
  ram_total_gb: z.number().min(0).max(1000000).optional(),
  disk_free_gb: z.number().min(0).max(1000000).optional(),
  thermal_pressure: z.enum(["nominal", "fair", "serious", "critical"]).optional(),
});

const backendOverrideSchema = z.object({
  backend_id: z.string().min(1),
  provider: z.enum(["ollama", "mlx", "llama.cpp", "vllm", "openai", "custom"]),
  model_id: z.string().min(1),
  endpoint: z.string().min(1).optional(),
  host_id: z.string().min(1).optional(),
  locality: z.enum(["local", "remote"]).optional(),
  tags: z.array(z.string().min(1)).optional(),
  capabilities: recordSchema.optional(),
  metadata: recordSchema.optional(),
});

export const autonomyBootstrapSchema = z
  .object({
    action: z.enum(["status", "ensure"]).default("status"),
    mutation: mutationSchema.optional(),
    local_host_id: z.string().min(1).default("local"),
    probe_ollama_url: z.string().optional(),
    autostart_ring_leader: z.boolean().optional(),
    run_immediately: z.boolean().optional(),
    seed_org_programs: z.boolean().optional(),
    seed_benchmark_suite: z.boolean().optional(),
    seed_eval_suite: z.boolean().optional(),
    telemetry_override: telemetryOverrideSchema.optional(),
    host_capabilities_override: recordSchema.optional(),
    host_tags_override: z.array(z.string().min(1)).optional(),
    backend_overrides: z.array(backendOverrideSchema).optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (value.action === "ensure" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for ensure",
        path: ["mutation"],
      });
    }
  });

type InvokeTool = (toolName: string, input: Record<string, unknown>) => Promise<unknown>;
type BackendCandidate = z.infer<typeof backendOverrideSchema>;

const DEFAULT_BENCHMARK_SUITE_ID = "autonomy.smoke.local";
const DEFAULT_EVAL_SUITE_ID = "autonomy.control-plane";
const HEARTBEAT_FRESHNESS_MS = 10 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function boolFromEnv(name: string, fallback: boolean) {
  const normalized = String(process.env[name] ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function intFromEnv(name: string, fallback: number) {
  const raw = Number.parseInt(String(process.env[name] ?? "").trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function deriveMutation(base: { idempotency_key: string; side_effect_fingerprint: string }, label: string) {
  const safeLabel = label.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const hash = crypto
    .createHash("sha256")
    .update(`${base.idempotency_key}|${base.side_effect_fingerprint}|${safeLabel}`)
    .digest("hex");
  return {
    idempotency_key: `${safeLabel}-${hash.slice(0, 20)}`,
    side_effect_fingerprint: `${safeLabel}-${hash.slice(20, 52)}`,
  };
}

function sanitizeId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function commandSucceeds(command: string, args: string[] = []) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0;
}

function readDiskFreeGb(targetDir: string) {
  const result = spawnSync("df", ["-Pk", targetDir], { encoding: "utf8" });
  if (result.status !== 0) {
    return undefined;
  }
  const lines = String(result.stdout || "")
    .trim()
    .split(/\n+/);
  if (lines.length < 2) {
    return undefined;
  }
  const columns = lines[1].trim().split(/\s+/);
  const availableKb = Number.parseInt(columns[3] ?? "", 10);
  if (!Number.isFinite(availableKb) || availableKb < 0) {
    return undefined;
  }
  return Number((availableKb / 1024 / 1024).toFixed(4));
}

function detectThermalPressure() {
  const result = spawnSync("/bin/sh", ["-lc", "pmset -g therm 2>/dev/null"], { encoding: "utf8" });
  if (result.status !== 0) {
    return undefined;
  }
  const text = String(result.stdout || "");
  const match = /CPU_Speed_Limit\s*=\s*(\d+)/i.exec(text) || /Scheduler_Limit\s*=\s*(\d+)/i.exec(text);
  if (!match) {
    return undefined;
  }
  const speedLimit = Number.parseInt(match[1], 10);
  if (!Number.isFinite(speedLimit)) {
    return undefined;
  }
  if (speedLimit >= 100) return "nominal";
  if (speedLimit >= 80) return "fair";
  if (speedLimit >= 50) return "serious";
  return "critical";
}

function isFreshIsoTimestamp(value: unknown) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) && Date.now() - timestamp <= HEARTBEAT_FRESHNESS_MS;
}

function localBackendLocality(endpoint?: string) {
  if (!endpoint) {
    return "local" as const;
  }
  try {
    const url = new URL(endpoint);
    const hostname = url.hostname.trim().toLowerCase();
    if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1") {
      return "local" as const;
    }
  } catch {
    return "local" as const;
  }
  return "remote" as const;
}

function getTmuxTelemetry(storage: Storage) {
  const state = storage.getTriChatTmuxControllerState();
  const tasks = state?.tasks ?? [];
  return {
    queue_depth: tasks.filter((task) => task.status === "queued" || task.status === "dispatched").length,
    active_tasks: tasks.filter((task) => task.status === "running").length,
    degraded: Boolean(state?.last_error),
  };
}

function detectLocalHost(storage: Storage, input: z.infer<typeof autonomyBootstrapSchema>) {
  const cpus = os.cpus();
  const load = os.loadavg()[0] || 0;
  const tmux = getTmuxTelemetry(storage);
  const override = input.telemetry_override ?? {};
  const tags = [
    "local",
    process.platform,
    process.arch,
    process.platform === "darwin" ? "macos" : "unix",
    process.arch === "arm64" ? "apple-silicon" : "x86",
  ];
  if (commandSucceeds("tmux", ["-V"])) tags.push("tmux");
  if (commandSucceeds("ollama", ["--version"])) tags.push("ollama");
  return {
    host: {
      host_id: input.local_host_id,
      enabled: true,
      transport: "local" as const,
      workspace_root: process.cwd(),
      worker_count: intFromEnv("TRICHAT_RING_LEADER_TMUX_WORKER_COUNT", 4),
      shell: process.env.SHELL || "/bin/zsh",
      capabilities: {
        locality: "local",
        platform: process.platform,
        arch: process.arch,
        cpu_count: cpus.length,
        tmux_available: commandSucceeds("tmux", ["-V"]),
        ollama_available: commandSucceeds("ollama", ["--version"]),
        full_gpu_access: process.platform === "darwin" && process.arch === "arm64",
        ...(isRecord(input.host_capabilities_override) ? input.host_capabilities_override : {}),
      },
      tags: [...new Set([...(input.host_tags_override ?? []), ...tags])],
      telemetry: {
        heartbeat_at: new Date().toISOString(),
        health_state: override.health_state ?? (tmux.degraded ? "degraded" : "healthy"),
        queue_depth: override.queue_depth ?? tmux.queue_depth,
        active_tasks: override.active_tasks ?? tmux.active_tasks,
        latency_ms: override.latency_ms,
        cpu_utilization: override.cpu_utilization ?? (cpus.length > 0 ? Math.max(0, Math.min(1, load / cpus.length)) : undefined),
        ram_available_gb: override.ram_available_gb ?? Number((os.freemem() / 1024 / 1024 / 1024).toFixed(4)),
        ram_total_gb: override.ram_total_gb ?? Number((os.totalmem() / 1024 / 1024 / 1024).toFixed(4)),
        disk_free_gb: override.disk_free_gb ?? readDiskFreeGb(process.cwd()),
        thermal_pressure: override.thermal_pressure ?? detectThermalPressure(),
      },
      metadata: {
        bootstrap_source: "autonomy.bootstrap",
      },
    },
    detection_tags: [...new Set([...(input.host_tags_override ?? []), ...tags])],
  };
}

async function fetchJsonWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function detectBackends(input: z.infer<typeof autonomyBootstrapSchema>): Promise<BackendCandidate[]> {
  if (Array.isArray(input.backend_overrides) && input.backend_overrides.length > 0) {
    return input.backend_overrides;
  }
  const discovered: BackendCandidate[] = [];
  const preferredOllamaModel = String(process.env.TRICHAT_OLLAMA_MODEL || "").trim();
  const ollamaUrl = String(input.probe_ollama_url || process.env.TRICHAT_OLLAMA_URL || "http://127.0.0.1:11434").trim();
  const ollamaTags = await fetchJsonWithTimeout(`${ollamaUrl.replace(/\/+$/, "")}/api/tags`);
  const models = Array.isArray((ollamaTags as Record<string, unknown> | null)?.models)
    ? ((ollamaTags as Record<string, unknown>).models as Array<Record<string, unknown>>)
    : [];
  const orderedModelNames = models
    .map((entry) => String(entry?.name ?? entry?.model ?? "").trim())
    .filter(Boolean)
    .sort((left, right) => {
      if (left === preferredOllamaModel) return -1;
      if (right === preferredOllamaModel) return 1;
      return left.localeCompare(right);
    })
    .slice(0, 4);
  for (const modelName of orderedModelNames) {
    const locality = localBackendLocality(ollamaUrl);
    discovered.push({
      backend_id: `ollama-${sanitizeId(modelName)}`,
      provider: "ollama",
      model_id: modelName,
      endpoint: ollamaUrl,
      host_id: locality === "local" ? input.local_host_id : undefined,
      locality,
      tags: [...new Set([locality, "ollama", ...(preferredOllamaModel && modelName === preferredOllamaModel ? ["primary"] : [])])],
      capabilities: {
        task_kinds: ["planning", "coding", "research", "verification", "chat", "tool_use"],
      },
      metadata: {
        bootstrap_source: "autonomy.bootstrap",
      },
    });
  }
  const mlxModel = String(process.env.TRICHAT_MLX_MODEL || "").trim();
  if (mlxModel && commandSucceeds("python3", ["-c", "import mlx"])) {
    discovered.push({
      backend_id: `mlx-${sanitizeId(mlxModel)}`,
      provider: "mlx",
      model_id: mlxModel,
      host_id: input.local_host_id,
      locality: "local",
      tags: ["local", "mlx"],
      capabilities: {
        task_kinds: ["planning", "coding", "research", "verification"],
      },
      metadata: {
        bootstrap_source: "autonomy.bootstrap",
      },
    });
  }
  for (const [provider, endpointEnv, modelEnv] of [
    ["llama.cpp", "TRICHAT_LLAMA_CPP_ENDPOINT", "TRICHAT_LLAMA_CPP_MODEL"],
    ["vllm", "TRICHAT_VLLM_ENDPOINT", "TRICHAT_VLLM_MODEL"],
  ] as const) {
    const endpoint = String(process.env[endpointEnv] || "").trim();
    const modelId = String(process.env[modelEnv] || "").trim();
    if (!endpoint || !modelId) continue;
    const health = await fetchJsonWithTimeout(`${endpoint.replace(/\/+$/, "")}/health`, {}, 3000);
    if (!health) continue;
    const locality = localBackendLocality(endpoint);
    discovered.push({
      backend_id: `${sanitizeId(provider)}-${sanitizeId(modelId)}`,
      provider,
      model_id: modelId,
      endpoint,
      host_id: locality === "local" ? input.local_host_id : undefined,
      locality,
      tags: [locality, provider],
      capabilities: {
        task_kinds: ["planning", "coding", "research", "verification", "chat", "tool_use"],
      },
      metadata: {
        bootstrap_source: "autonomy.bootstrap",
      },
    });
  }
  return discovered;
}

function buildDesiredAutopilotConfig() {
  const leadAgentId = String(process.env.TRICHAT_RING_LEADER_AGENT_ID || "ring-leader").trim().toLowerCase();
  const configuredSpecialists = normalizeStringArray(String(process.env.TRICHAT_RING_LEADER_SPECIALIST_AGENT_IDS || "").split(","));
  const fallbackSpecialists = getTriChatAgentCatalog()
    .filter((agent) => agent.enabled !== false)
    .filter((agent) => agent.agent_id !== leadAgentId)
    .filter((agent) => agent.coordination_tier === "director" || agent.coordination_tier === "support")
    .map((agent) => agent.agent_id);
  const awayModeRaw = String(process.env.TRICHAT_RING_LEADER_AWAY_MODE || "normal").trim().toLowerCase();
  const threadStatusRaw = String(process.env.TRICHAT_RING_LEADER_THREAD_STATUS || "active").trim().toLowerCase();
  const executeBackendRaw = String(process.env.TRICHAT_RING_LEADER_EXECUTE_BACKEND || "auto").trim().toLowerCase();
  const adrPolicyRaw = String(process.env.TRICHAT_RING_LEADER_ADR_POLICY || "high_impact").trim().toLowerCase();
  return {
    away_mode: awayModeRaw === "safe" || awayModeRaw === "aggressive" ? awayModeRaw : "normal",
    interval_seconds: intFromEnv("TRICHAT_RING_LEADER_INTERVAL_SECONDS", 180),
    thread_id: String(process.env.TRICHAT_RING_LEADER_THREAD_ID || "ring-leader-main").trim(),
    thread_title: String(process.env.TRICHAT_RING_LEADER_THREAD_TITLE || "Ring Leader Main Loop").trim(),
    thread_status: threadStatusRaw === "archived" ? "archived" : "active",
    objective: String(
      process.env.TRICHAT_RING_LEADER_OBJECTIVE ||
        process.env.ANAMNESIS_IMPRINT_MISSION ||
        "Inspect kernel state, choose one high-leverage bounded next action, and delegate specialist work with explicit success criteria and rollback awareness."
    ).trim(),
    lead_agent_id: leadAgentId,
    specialist_agent_ids: configuredSpecialists.length > 0 ? configuredSpecialists : fallbackSpecialists,
    max_rounds: intFromEnv("TRICHAT_RING_LEADER_MAX_ROUNDS", 2),
    min_success_agents: intFromEnv("TRICHAT_RING_LEADER_MIN_SUCCESS_AGENTS", 2),
    bridge_timeout_seconds: intFromEnv("TRICHAT_RING_LEADER_BRIDGE_TIMEOUT_SECONDS", 90),
    bridge_dry_run: boolFromEnv("TRICHAT_RING_LEADER_BRIDGE_DRY_RUN", false),
    execute_enabled: boolFromEnv("TRICHAT_RING_LEADER_EXECUTE_ENABLED", true),
    execute_backend: executeBackendRaw === "direct" || executeBackendRaw === "tmux" ? executeBackendRaw : "auto",
    tmux_session_name: String(process.env.TRICHAT_RING_LEADER_TMUX_SESSION_NAME || "ring-leader-autopilot").trim(),
    tmux_worker_count: intFromEnv("TRICHAT_RING_LEADER_TMUX_WORKER_COUNT", 4),
    tmux_max_queue_per_worker: intFromEnv("TRICHAT_RING_LEADER_TMUX_MAX_QUEUE_PER_WORKER", 8),
    tmux_auto_scale_workers: boolFromEnv("TRICHAT_RING_LEADER_TMUX_AUTO_SCALE_WORKERS", true),
    tmux_sync_after_dispatch: boolFromEnv("TRICHAT_RING_LEADER_TMUX_SYNC_AFTER_DISPATCH", true),
    confidence_threshold: Number.parseFloat(String(process.env.TRICHAT_RING_LEADER_CONFIDENCE_THRESHOLD || "0.45")),
    max_consecutive_errors: intFromEnv("TRICHAT_RING_LEADER_MAX_CONSECUTIVE_ERRORS", 3),
    adr_policy: adrPolicyRaw === "every_success" || adrPolicyRaw === "manual" ? adrPolicyRaw : "high_impact",
  } as const;
}

function buildDelegationContract(tier: string) {
  if (tier === "lead") {
    return "Decompose goals into bounded work, choose the correct lane, require evidence and rollback plans, and keep specialists focused on one owner per slice.";
  }
  if (tier === "director") {
    return "Accept bounded goals from the ring leader, split them into leaf-sized tasks, supervise assigned leaves, and escalate blockers with concrete evidence.";
  }
  if (tier === "leaf") {
    return "Own one bounded slice at a time, produce minimal diffs or findings, report evidence, and stop at the safety boundary instead of improvising scope.";
  }
  return "Provide high-signal support when explicitly asked, stay concise, and avoid spawning hidden workstreams.";
}

function buildEvaluationStandard(lane: string, tier: string) {
  if (lane === "implementer") return "Success requires an explicit owner, a minimal change set, clear verification, and rollback notes when risk is non-trivial.";
  if (lane === "analyst") return "Success requires decision-ready synthesis, clear assumptions, explicit evidence gaps, and bounded recommendations.";
  if (lane === "verifier" || tier === "support") return "Success requires concrete failure modes, honest confidence, explicit blockers, and no decorative certainty.";
  return "Success requires bounded scope, concrete next actions, evidence quality, and rollback awareness.";
}

async function inspectBootstrapState(
  storage: Storage,
  invokeTool: InvokeTool,
  input: z.infer<typeof autonomyBootstrapSchema>,
  backendCandidates?: BackendCandidate[]
) {
  const persistedFabric = storage.getWorkerFabricState();
  const persistedHosts = Array.isArray(persistedFabric?.hosts) ? persistedFabric!.hosts : [];
  const persistedLocalHost = persistedHosts.find((entry) => entry.host_id === input.local_host_id) ?? null;

  const effectiveFabricStatus = (await Promise.resolve(
    workerFabric(storage, {
      action: "status",
      fallback_workspace_root: process.cwd(),
      fallback_worker_count: intFromEnv("TRICHAT_RING_LEADER_TMUX_WORKER_COUNT", 4),
      fallback_shell: process.env.SHELL || "/bin/zsh",
    })
  )) as any;
  const effectiveHosts = Array.isArray(effectiveFabricStatus.state?.hosts) ? effectiveFabricStatus.state.hosts : [];
  const effectiveLocalHost =
    effectiveHosts.find((entry: any) => String(entry.host_id || "") === input.local_host_id) ?? null;

  const persistedRouter = storage.getModelRouterState();
  const persistedBackends = Array.isArray(persistedRouter?.backends) ? persistedRouter!.backends : [];
  const localBackends = persistedBackends.filter(
    (entry) => String(entry.host_id || "") === input.local_host_id || String(entry.locality || "") === "local"
  );

  const requiredRoleIds = getTriChatAgentCatalog()
    .filter((agent) => agent.enabled !== false)
    .map((agent) => agent.agent_id);
  const missingRoleIds = requiredRoleIds.filter((roleId) => !getEffectiveOrgProgram(storage, roleId));

  const benchmarkState = benchmarkSuiteList(storage, {});
  const evalState = evalSuiteList(storage, {});
  const benchmarkSuiteIds = benchmarkState.suites.map((entry) => entry.suite_id);
  const evalSuiteIds = evalState.suites.map((entry) => entry.suite_id);

  const autopilotStatus = (await Promise.resolve(
    trichatAutopilotControl(storage, invokeTool, { action: "status" } as any)
  )) as Record<string, unknown>;
  const desiredAutopilot = buildDesiredAutopilotConfig();
  const actualConfig = isRecord(autopilotStatus.config) ? autopilotStatus.config : {};
  const configDrift = [
    String(actualConfig.lead_agent_id || "") !== desiredAutopilot.lead_agent_id ? "lead_agent_id" : null,
    String(actualConfig.thread_id || "") !== desiredAutopilot.thread_id ? "thread_id" : null,
    JSON.stringify(normalizeStringArray(actualConfig.specialist_agent_ids)) !==
    JSON.stringify(desiredAutopilot.specialist_agent_ids)
      ? "specialist_agent_ids"
      : null,
  ].filter(Boolean);

  const repairsNeeded: string[] = [];
  if (!persistedFabric?.enabled || !persistedLocalHost) {
    repairsNeeded.push("worker.fabric.local_host_missing");
  } else if (!isFreshIsoTimestamp(persistedLocalHost.telemetry?.heartbeat_at)) {
    repairsNeeded.push("worker.fabric.local_host_stale");
  }
  if (!persistedRouter?.enabled || localBackends.length === 0) {
    repairsNeeded.push("model.router.local_backend_missing");
  } else if (!localBackends.some((entry) => isFreshIsoTimestamp(entry.heartbeat_at))) {
    repairsNeeded.push("model.router.local_backend_stale");
  }
  if (missingRoleIds.length > 0) {
    repairsNeeded.push("org.program.missing_roles");
  }
  if (!benchmarkSuiteIds.includes(DEFAULT_BENCHMARK_SUITE_ID)) {
    repairsNeeded.push("benchmark.suite.missing_default");
  }
  if (!evalSuiteIds.includes(DEFAULT_EVAL_SUITE_ID)) {
    repairsNeeded.push("eval.suite.missing_default");
  }
  const shouldAutostart = input.autostart_ring_leader ?? boolFromEnv("TRICHAT_RING_LEADER_AUTOSTART", true);
  if (shouldAutostart && !autopilotStatus.running) {
    repairsNeeded.push("trichat.autopilot.not_running");
  }
  if (shouldAutostart && configDrift.length > 0) {
    repairsNeeded.push("trichat.autopilot.config_drift");
  }

  return {
    local_host_id: input.local_host_id,
    worker_fabric: {
      enabled: Boolean(persistedFabric?.enabled),
      host_present: Boolean(persistedLocalHost),
      host_fresh: Boolean(persistedLocalHost && isFreshIsoTimestamp(persistedLocalHost.telemetry?.heartbeat_at)),
      default_host_id: persistedFabric?.default_host_id ?? null,
      host_ids: persistedHosts.map((entry) => entry.host_id),
      telemetry: persistedLocalHost?.telemetry ?? null,
      effective_local_telemetry: effectiveLocalHost?.telemetry ?? null,
    },
    model_router: {
      enabled: Boolean(persistedRouter?.enabled),
      backend_present: localBackends.length > 0,
      backend_fresh: localBackends.some((entry) => isFreshIsoTimestamp(entry.heartbeat_at)),
      default_backend_id: persistedRouter?.default_backend_id ?? null,
      backend_ids: persistedBackends.map((entry) => entry.backend_id),
      local_backend_ids: localBackends.map((entry) => entry.backend_id),
    },
    org_programs: {
      ready: missingRoleIds.length === 0,
      required_role_ids: requiredRoleIds,
      missing_role_ids: missingRoleIds,
    },
    benchmark_suites: {
      ready: benchmarkSuiteIds.includes(DEFAULT_BENCHMARK_SUITE_ID),
      suite_ids: benchmarkSuiteIds,
    },
    eval_suites: {
      ready: evalSuiteIds.includes(DEFAULT_EVAL_SUITE_ID),
      suite_ids: evalSuiteIds,
    },
    ring_leader: {
      running: Boolean(autopilotStatus.running),
      lead_agent_id: String(actualConfig.lead_agent_id || "") || null,
      thread_id: String(actualConfig.thread_id || "") || null,
      config_drift: configDrift,
    },
    detections: {
      host_tags: detectLocalHost(storage, input).detection_tags,
      backends: (backendCandidates ?? []).map((entry) => ({
        backend_id: entry.backend_id,
        provider: entry.provider,
        model_id: entry.model_id,
        locality: entry.locality ?? null,
      })),
    },
    repairs_needed: repairsNeeded,
    self_start_ready: repairsNeeded.length === 0,
  };
}

export async function autonomyBootstrap(storage: Storage, invokeTool: InvokeTool, input: z.infer<typeof autonomyBootstrapSchema>) {
  const detectedBackends = await detectBackends(input);
  if (input.action === "status") {
    return inspectBootstrapState(storage, invokeTool, input, detectedBackends);
  }

  return runIdempotentMutation({
    storage,
    tool_name: "autonomy.bootstrap",
    mutation: input.mutation!,
    payload: input,
    execute: async () => {
      const actions: string[] = [];
      const localHost = detectLocalHost(storage, input);
      const desiredAutopilot = buildDesiredAutopilotConfig();
      const shouldAutostart = input.autostart_ring_leader ?? boolFromEnv("TRICHAT_RING_LEADER_AUTOSTART", true);

      const persistedFabric = storage.getWorkerFabricState();
      if (!persistedFabric?.enabled || persistedFabric.default_host_id !== input.local_host_id) {
        await workerFabric(storage, {
          action: "configure",
          mutation: deriveMutation(input.mutation!, "autonomy.worker.fabric.configure"),
          enabled: true,
          strategy: "resource_aware",
          default_host_id: input.local_host_id,
          source_client: "autonomy.bootstrap",
          source_agent: input.source_agent,
          source_model: input.source_model,
        });
        actions.push("worker.fabric.configure");
      }
      await workerFabric(storage, {
        action: "upsert_host",
        mutation: deriveMutation(input.mutation!, "autonomy.worker.fabric.local_host"),
        host: localHost.host,
        source_client: "autonomy.bootstrap",
        source_agent: input.source_agent,
        source_model: input.source_model,
      });
      actions.push("worker.fabric.upsert_host");

      if (detectedBackends.length > 0) {
        const routerStatus = storage.getModelRouterState();
        const primaryBackend = detectedBackends[0];
        if (!routerStatus?.enabled || routerStatus.default_backend_id !== primaryBackend.backend_id) {
          await modelRouter(storage, {
            action: "configure",
            mutation: deriveMutation(input.mutation!, "autonomy.model.router.configure"),
            enabled: true,
            strategy: "prefer_quality",
            default_backend_id: primaryBackend.backend_id,
            source_client: "autonomy.bootstrap",
            source_agent: input.source_agent,
            source_model: input.source_model,
          });
          actions.push("model.router.configure");
        }
        for (const backend of detectedBackends) {
          await modelRouter(storage, {
            action: "upsert_backend",
            mutation: deriveMutation(input.mutation!, `autonomy.model.router.${backend.backend_id}`),
            backend: {
              ...backend,
              heartbeat_at: new Date().toISOString(),
              metadata: {
                ...(backend.metadata ?? {}),
                bootstrap_source: "autonomy.bootstrap",
              },
            },
            source_client: "autonomy.bootstrap",
            source_agent: input.source_agent,
            source_model: input.source_model,
          });
          actions.push(`model.router.upsert_backend:${backend.backend_id}`);
        }
      }

      const persistedRouterAfterEnsure = storage.getModelRouterState();
      const availableLocalBackends = (persistedRouterAfterEnsure?.backends ?? []).filter(
        (entry) =>
          entry.enabled !== false &&
          (String(entry.host_id || "") === input.local_host_id || String(entry.locality || "") === "local")
      );

      if (input.seed_org_programs !== false) {
        for (const agent of getTriChatAgentCatalog().filter((entry) => entry.enabled !== false)) {
          const existing = getEffectiveOrgProgram(storage, agent.agent_id);
          if (existing) continue;
          await orgProgram(storage, {
            action: "upsert_role",
            mutation: deriveMutation(input.mutation!, `autonomy.org.program.${agent.agent_id}`),
            role_id: agent.agent_id,
            title: agent.display_name,
            description: agent.description ?? `${agent.display_name} autonomous operating doctrine.`,
            lane: agent.role_lane ?? "general",
            version: {
              version_id: `${agent.agent_id}-bootstrap-v1`,
              summary: `${agent.display_name} bootstrap operating doctrine`,
              doctrine: agent.system_prompt,
              delegation_contract: buildDelegationContract(String(agent.coordination_tier || "")),
              evaluation_standard: buildEvaluationStandard(String(agent.role_lane || ""), String(agent.coordination_tier || "")),
              status: "active",
              metadata: {
                bootstrap_source: "autonomy.bootstrap",
              },
            },
            source_client: "autonomy.bootstrap",
            source_agent: input.source_agent,
            source_model: input.source_model,
          });
          actions.push(`org.program.upsert_role:${agent.agent_id}`);
        }
      }

      if (input.seed_benchmark_suite !== false) {
        const suites = benchmarkSuiteList(storage, {});
        if (!suites.suites.some((entry) => entry.suite_id === DEFAULT_BENCHMARK_SUITE_ID)) {
          await benchmarkSuiteUpsert(storage, {
            mutation: deriveMutation(input.mutation!, "autonomy.benchmark.suite"),
            suite_id: DEFAULT_BENCHMARK_SUITE_ID,
            title: "Autonomy smoke benchmark",
            objective: "Verify the local-first agent stack can still build and answer core MCP health queries inside isolated execution.",
            project_dir: process.cwd(),
            isolation_mode: "git_worktree",
            aggregate_metric_name: "suite_success_rate",
            aggregate_metric_direction: "maximize",
            cases: [
              {
                case_id: "build",
                title: "TypeScript build stays green",
                command: "npm run build",
              },
              {
                case_id: "storage-health",
                title: "Isolated stdio storage health stays reachable",
                command:
                  "node ./scripts/mcp_tool_call.mjs --tool health.storage --args '{}' --transport stdio --stdio-command node --stdio-args 'dist/server.js' --cwd . >/dev/null",
              },
              {
                case_id: "roster-health",
                title: "Isolated stdio tri-chat roster stays reachable",
                command:
                  "node ./scripts/mcp_tool_call.mjs --tool trichat.roster --args '{}' --transport stdio --stdio-command node --stdio-args 'dist/server.js' --cwd . >/dev/null",
              },
            ],
            tags: ["autonomy", "smoke", "bootstrap"],
            metadata: {
              bootstrap_source: "autonomy.bootstrap",
            },
            source_client: "autonomy.bootstrap",
            source_agent: input.source_agent,
            source_model: input.source_model,
          });
          actions.push("benchmark.suite_upsert:autonomy.smoke.local");
        }
      }

      if (input.seed_eval_suite !== false && availableLocalBackends.length > 0) {
        const evalSuites = evalSuiteList(storage, {});
        if (!evalSuites.suites.some((entry) => entry.suite_id === DEFAULT_EVAL_SUITE_ID)) {
          const primaryBackend = availableLocalBackends[0];
          await evalSuiteUpsert(storage, {
            mutation: deriveMutation(input.mutation!, "autonomy.eval.suite"),
            suite_id: DEFAULT_EVAL_SUITE_ID,
            title: "Autonomy control-plane eval",
            objective: "Keep the self-starting worker fabric, router, and benchmark substrate honest.",
            aggregate_metric_name: "suite_success_rate",
            aggregate_metric_direction: "maximize",
            cases: [
              {
                case_id: "autonomy-benchmark-smoke",
                title: "Autonomy smoke benchmark stays green",
                kind: "benchmark_suite",
                benchmark_suite_id: DEFAULT_BENCHMARK_SUITE_ID,
                required: true,
                weight: 1,
              },
              {
                case_id: "router-primary-planning",
                title: "Planning routes to the current primary local backend",
                kind: "router_case",
                task_kind: "planning",
                context_tokens: 4000,
                latency_budget_ms: 2000,
                expected_backend_id: primaryBackend.backend_id,
                expected_backend_tags: primaryBackend.tags ?? [],
                preferred_tags: primaryBackend.tags ?? [],
                required: true,
                weight: 1,
              },
            ],
            tags: ["autonomy", "control-plane", "bootstrap"],
            metadata: {
              bootstrap_source: "autonomy.bootstrap",
              primary_backend_id: primaryBackend.backend_id,
            },
            source_client: "autonomy.bootstrap",
            source_agent: input.source_agent,
            source_model: input.source_model,
          });
          actions.push("eval.suite_upsert:autonomy.control-plane");
        }
      }

      const autopilotStatus = (await Promise.resolve(
        trichatAutopilotControl(storage, invokeTool, { action: "status" } as any)
      )) as Record<string, unknown>;
      const currentConfig = isRecord(autopilotStatus.config) ? autopilotStatus.config : {};
      const autopilotNeedsSync =
        shouldAutostart &&
        availableLocalBackends.length > 0 &&
        (!autopilotStatus.running ||
          String(currentConfig.thread_id || "") !== desiredAutopilot.thread_id ||
          String(currentConfig.lead_agent_id || "") !== desiredAutopilot.lead_agent_id ||
          JSON.stringify(normalizeStringArray(currentConfig.specialist_agent_ids)) !==
            JSON.stringify(desiredAutopilot.specialist_agent_ids));
      if (autopilotNeedsSync) {
        await trichatAutopilotControl(storage, invokeTool, {
          action: "start",
          mutation: deriveMutation(input.mutation!, "autonomy.trichat.autopilot.start"),
          run_immediately: input.run_immediately ?? false,
          ...desiredAutopilot,
        } as any);
        actions.push("trichat.autopilot.start");
      }

      const status = await inspectBootstrapState(storage, invokeTool, input, detectedBackends);
      return {
        ok: status.self_start_ready,
        actions,
        status,
      };
    },
  });
}
