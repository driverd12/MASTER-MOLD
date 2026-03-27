import { z } from "zod";
import {
  Storage,
  type ModelRouterBackendRecord,
  type ModelRouterStateRecord,
  type ModelRouterTaskKind,
} from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { computeHostHealthScore, resolveEffectiveWorkerFabric } from "./worker_fabric.js";

const recordSchema = z.record(z.unknown());

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const backendSchema = z.object({
  backend_id: z.string().min(1),
  enabled: z.boolean().optional(),
  provider: z.enum(["ollama", "mlx", "llama.cpp", "vllm", "openai", "custom"]).default("custom"),
  model_id: z.string().min(1),
  endpoint: z.string().min(1).optional(),
  host_id: z.string().min(1).optional(),
  locality: z.enum(["local", "remote"]).optional(),
  context_window: z.number().int().min(256).max(10000000).optional(),
  throughput_tps: z.number().min(0).max(1000000).optional(),
  latency_ms_p50: z.number().min(0).max(10000000).optional(),
  success_rate: z.number().min(0).max(1).optional(),
  win_rate: z.number().min(0).max(1).optional(),
  cost_per_1k_input: z.number().min(0).max(1000000).optional(),
  max_output_tokens: z.number().int().min(0).max(10000000).optional(),
  tags: z.array(z.string().min(1)).optional(),
  capabilities: recordSchema.optional(),
  metadata: recordSchema.optional(),
  heartbeat_at: z.string().optional(),
});

const routeTaskKindSchema = z.enum(["planning", "coding", "research", "verification", "chat", "tool_use"]);

export const modelRouterSchema = z
  .object({
    action: z.enum(["status", "configure", "upsert_backend", "heartbeat", "remove_backend", "route"]).default("status"),
    mutation: mutationSchema.optional(),
    enabled: z.boolean().optional(),
    strategy: z.enum(["balanced", "prefer_speed", "prefer_quality", "prefer_cost", "prefer_context_fit"]).optional(),
    default_backend_id: z.string().min(1).optional(),
    backend_id: z.string().min(1).optional(),
    backend: backendSchema.optional(),
    tags: z.array(z.string().min(1)).optional(),
    capabilities: recordSchema.optional(),
    quality_preference: z.enum(["speed", "balanced", "quality", "cost"]).optional(),
    task_kind: routeTaskKindSchema.optional(),
    context_tokens: z.number().int().min(0).max(10000000).optional(),
    latency_budget_ms: z.number().min(0).max(10000000).optional(),
    required_tags: z.array(z.string().min(1)).optional(),
    preferred_tags: z.array(z.string().min(1)).optional(),
    required_backend_ids: z.array(z.string().min(1)).optional(),
    fallback_workspace_root: z.string().min(1).optional(),
    fallback_worker_count: z.number().int().min(1).max(64).optional(),
    fallback_shell: z.string().min(1).optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (value.action !== "status" && value.action !== "route" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for model router writes",
        path: ["mutation"],
      });
    }
    if (value.action === "upsert_backend" && !value.backend) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "backend is required for upsert_backend",
        path: ["backend"],
      });
    }
    if ((value.action === "remove_backend" || value.action === "heartbeat") && !value.backend_id?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "backend_id is required",
        path: ["backend_id"],
      });
    }
  });

type RouteQualityPreference = "speed" | "balanced" | "quality" | "cost";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function loadModelRouterState(storage: Storage): ModelRouterStateRecord {
  return (
    storage.getModelRouterState() ?? {
      enabled: false,
      strategy: "balanced",
      default_backend_id: null,
      backends: [],
      updated_at: new Date().toISOString(),
    }
  );
}

function normalizeBackend(input: ModelRouterBackendRecord): ModelRouterBackendRecord {
  return {
    backend_id: input.backend_id.trim(),
    enabled: input.enabled !== false,
    provider: input.provider,
    model_id: input.model_id.trim(),
    endpoint: input.endpoint?.trim() || null,
    host_id: input.host_id?.trim() || null,
    locality: input.locality === "remote" ? "remote" : "local",
    context_window: Math.max(256, Math.min(10_000_000, Math.trunc(input.context_window || 8192))),
    throughput_tps:
      typeof input.throughput_tps === "number" && Number.isFinite(input.throughput_tps) ? Number(input.throughput_tps.toFixed(4)) : null,
    latency_ms_p50:
      typeof input.latency_ms_p50 === "number" && Number.isFinite(input.latency_ms_p50) ? Number(input.latency_ms_p50.toFixed(4)) : null,
    success_rate:
      typeof input.success_rate === "number" && Number.isFinite(input.success_rate) ? Math.max(0, Math.min(1, input.success_rate)) : null,
    win_rate:
      typeof input.win_rate === "number" && Number.isFinite(input.win_rate) ? Math.max(0, Math.min(1, input.win_rate)) : null,
    cost_per_1k_input:
      typeof input.cost_per_1k_input === "number" && Number.isFinite(input.cost_per_1k_input) ? Number(input.cost_per_1k_input.toFixed(4)) : null,
    max_output_tokens:
      typeof input.max_output_tokens === "number" && Number.isFinite(input.max_output_tokens) ? Math.max(0, Math.round(input.max_output_tokens)) : null,
    tags: [...new Set((input.tags ?? []).map((entry) => entry.trim()).filter(Boolean))],
    capabilities: isRecord(input.capabilities) ? input.capabilities : {},
    metadata: isRecord(input.metadata) ? input.metadata : {},
    heartbeat_at: input.heartbeat_at?.trim() || null,
    updated_at: input.updated_at,
  };
}

function resolveTaskAffinity(backend: ModelRouterBackendRecord, taskKind: ModelRouterTaskKind | null) {
  if (!taskKind) {
    return 0.7;
  }
  const tags = new Set(backend.tags.map((entry) => entry.toLowerCase()));
  const taskKinds = normalizeStringArray((backend.capabilities as Record<string, unknown>).task_kinds).map((entry) =>
    entry.toLowerCase()
  );
  if (taskKinds.includes(taskKind)) {
    return 1;
  }
  if (taskKind === "coding" && (tags.has("code") || tags.has("coding") || tags.has("reasoning"))) {
    return 0.95;
  }
  if (taskKind === "research" && (tags.has("research") || tags.has("analysis") || tags.has("long-context"))) {
    return 0.95;
  }
  if (taskKind === "verification" && (tags.has("verify") || tags.has("critic") || tags.has("review"))) {
    return 0.95;
  }
  if (taskKind === "planning" && (tags.has("planner") || tags.has("reasoning"))) {
    return 0.95;
  }
  return tags.has(taskKind) ? 0.9 : 0.55;
}

function resolveRouteStrategy(inputPreference: RouteQualityPreference | undefined, stateStrategy: ModelRouterStateRecord["strategy"]) {
  if (inputPreference === "speed") {
    return "prefer_speed" as const;
  }
  if (inputPreference === "quality") {
    return "prefer_quality" as const;
  }
  if (inputPreference === "cost") {
    return "prefer_cost" as const;
  }
  return stateStrategy;
}

export function routeModelBackends(
  storage: Storage,
  input: {
    task_kind?: ModelRouterTaskKind;
    context_tokens?: number;
    latency_budget_ms?: number;
    required_tags?: string[];
    preferred_tags?: string[];
    required_backend_ids?: string[];
    quality_preference?: RouteQualityPreference;
    fallback_workspace_root?: string;
    fallback_worker_count?: number;
    fallback_shell?: string;
  }
) {
  const state = loadModelRouterState(storage);
  if (!state.enabled || state.backends.length === 0) {
    return {
      state,
      selected_backend: null,
      ranked_backends: [],
      strategy: resolveRouteStrategy(input.quality_preference, state.strategy),
      task_kind: input.task_kind ?? null,
      context_tokens: input.context_tokens ?? null,
      latency_budget_ms: input.latency_budget_ms ?? null,
    };
  }
  const requiredTags = normalizeStringArray(input.required_tags);
  const preferredTags = normalizeStringArray(input.preferred_tags);
  const requiredBackendIds = normalizeStringArray(input.required_backend_ids);
  const effectiveStrategy = resolveRouteStrategy(input.quality_preference, state.strategy);
  const fabric = resolveEffectiveWorkerFabric(storage, {
    fallback_workspace_root: input.fallback_workspace_root ?? process.cwd(),
    fallback_worker_count: input.fallback_worker_count ?? 1,
    fallback_shell: input.fallback_shell ?? "/bin/zsh",
  });
  const hostHealthById = new Map(
    fabric.hosts.map((host) => [host.host_id, computeHostHealthScore(host.telemetry)])
  );

  const ranked = state.backends
    .filter((backend) => backend.enabled)
    .filter((backend) => requiredBackendIds.length === 0 || requiredBackendIds.includes(backend.backend_id))
    .filter((backend) => requiredTags.every((tag) => backend.tags.map((entry) => entry.toLowerCase()).includes(tag.toLowerCase())))
    .map((backend) => {
      const contextFit =
        typeof input.context_tokens === "number" && input.context_tokens > 0
          ? Math.max(0.1, Math.min(1, backend.context_window / input.context_tokens))
          : 0.8;
      const latencyScore =
        typeof input.latency_budget_ms === "number" && input.latency_budget_ms > 0
          ? backend.latency_ms_p50 === null
            ? 0.5
            : Math.max(0.1, Math.min(1, input.latency_budget_ms / Math.max(input.latency_budget_ms, backend.latency_ms_p50)))
          : backend.latency_ms_p50 === null
            ? 0.5
            : Math.max(0.1, Math.min(1, 2000 / Math.max(2000, backend.latency_ms_p50)));
      const qualityScore = ((backend.win_rate ?? 0.65) * 0.6) + ((backend.success_rate ?? 0.75) * 0.4);
      const throughputScore = backend.throughput_tps === null ? 0.5 : Math.max(0.1, Math.min(1, backend.throughput_tps / 200));
      const costScore =
        backend.cost_per_1k_input === null ? 0.6 : Math.max(0.05, Math.min(1, 1 / Math.max(1, backend.cost_per_1k_input)));
      const taskAffinity = resolveTaskAffinity(backend, input.task_kind ?? null);
      const preferredTagScore =
        preferredTags.length === 0
          ? 0.6
          : preferredTags.filter((tag) => backend.tags.map((entry) => entry.toLowerCase()).includes(tag.toLowerCase())).length /
            preferredTags.length;
      const hostHealth =
        backend.host_id && hostHealthById.has(backend.host_id) ? hostHealthById.get(backend.host_id)! : backend.locality === "local" ? 0.9 : 0.7;
      const strategyScore =
        effectiveStrategy === "prefer_speed"
          ? latencyScore * 0.45 + throughputScore * 0.2 + qualityScore * 0.15 + contextFit * 0.1 + hostHealth * 0.1
          : effectiveStrategy === "prefer_quality"
            ? qualityScore * 0.45 + taskAffinity * 0.2 + contextFit * 0.15 + hostHealth * 0.1 + latencyScore * 0.1
            : effectiveStrategy === "prefer_cost"
              ? costScore * 0.45 + hostHealth * 0.2 + latencyScore * 0.15 + qualityScore * 0.1 + contextFit * 0.1
              : effectiveStrategy === "prefer_context_fit"
                ? contextFit * 0.45 + qualityScore * 0.15 + latencyScore * 0.15 + taskAffinity * 0.15 + hostHealth * 0.1
                : qualityScore * 0.25 +
                  latencyScore * 0.2 +
                  contextFit * 0.15 +
                  throughputScore * 0.1 +
                  costScore * 0.1 +
                  taskAffinity * 0.1 +
                  preferredTagScore * 0.05 +
                  hostHealth * 0.05;
      return {
        backend,
        score: Number(strategyScore.toFixed(4)),
        reasoning: {
          strategy: effectiveStrategy,
          context_fit: Number(contextFit.toFixed(4)),
          latency_score: Number(latencyScore.toFixed(4)),
          quality_score: Number(qualityScore.toFixed(4)),
          throughput_score: Number(throughputScore.toFixed(4)),
          cost_score: Number(costScore.toFixed(4)),
          task_affinity: Number(taskAffinity.toFixed(4)),
          preferred_tag_score: Number(preferredTagScore.toFixed(4)),
          host_health: Number(hostHealth.toFixed(4)),
        },
      };
    })
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      const leftDefault = left.backend.backend_id === state.default_backend_id ? 1 : 0;
      const rightDefault = right.backend.backend_id === state.default_backend_id ? 1 : 0;
      if (leftDefault !== rightDefault) {
        return rightDefault - leftDefault;
      }
      return left.backend.backend_id.localeCompare(right.backend.backend_id);
    });

  return {
    state,
    selected_backend: ranked[0]?.backend ?? null,
    ranked_backends: ranked,
    strategy: effectiveStrategy,
    task_kind: input.task_kind ?? null,
    context_tokens: input.context_tokens ?? null,
    latency_budget_ms: input.latency_budget_ms ?? null,
  };
}

export async function modelRouter(storage: Storage, input: z.infer<typeof modelRouterSchema>) {
  if (input.action === "status") {
    return {
      state: loadModelRouterState(storage),
      backend_count: loadModelRouterState(storage).backends.length,
    };
  }

  if (input.action === "route") {
    return routeModelBackends(storage, {
      task_kind: input.task_kind,
      context_tokens: input.context_tokens,
      latency_budget_ms: input.latency_budget_ms,
      required_tags: input.required_tags,
      preferred_tags: input.preferred_tags,
      required_backend_ids: input.required_backend_ids,
      quality_preference: input.quality_preference,
      fallback_workspace_root: input.fallback_workspace_root,
      fallback_worker_count: input.fallback_worker_count,
      fallback_shell: input.fallback_shell,
    });
  }

  return runIdempotentMutation({
    storage,
    tool_name: "model.router",
    mutation: input.mutation!,
    payload: input,
    execute: () => {
      const existing = loadModelRouterState(storage);
      if (input.action === "configure") {
        return {
          state: storage.setModelRouterState({
            enabled: input.enabled ?? existing.enabled,
            strategy: input.strategy ?? existing.strategy,
            default_backend_id: input.default_backend_id ?? existing.default_backend_id,
            backends: existing.backends,
          }),
        };
      }

      if (input.action === "upsert_backend") {
        const backend = normalizeBackend({
          backend_id: input.backend!.backend_id,
          enabled: input.backend!.enabled !== false,
          provider: input.backend!.provider,
          model_id: input.backend!.model_id,
          endpoint: input.backend!.endpoint?.trim() || null,
          host_id: input.backend!.host_id?.trim() || null,
          locality: input.backend!.locality === "remote" ? "remote" : input.backend!.host_id ? "remote" : "local",
          context_window: input.backend!.context_window ?? 8192,
          throughput_tps: input.backend!.throughput_tps ?? null,
          latency_ms_p50: input.backend!.latency_ms_p50 ?? null,
          success_rate: input.backend!.success_rate ?? null,
          win_rate: input.backend!.win_rate ?? null,
          cost_per_1k_input: input.backend!.cost_per_1k_input ?? null,
          max_output_tokens: input.backend!.max_output_tokens ?? null,
          tags: input.backend!.tags ?? [],
          capabilities: input.backend!.capabilities ?? {},
          metadata: input.backend!.metadata ?? {},
          heartbeat_at: input.backend!.heartbeat_at?.trim() || null,
          updated_at: new Date().toISOString(),
        });
        const nextBackends = existing.backends.filter((entry) => entry.backend_id !== backend.backend_id).concat([backend]);
        return {
          state: storage.setModelRouterState({
            enabled: existing.enabled,
            strategy: existing.strategy,
            default_backend_id: existing.default_backend_id ?? backend.backend_id,
            backends: nextBackends,
          }),
        };
      }

      if (input.action === "heartbeat") {
        const backendId = input.backend_id!.trim();
        const nextBackends = existing.backends.map((backend) =>
          backend.backend_id !== backendId
            ? backend
            : normalizeBackend({
                ...backend,
                model_id: input.backend?.model_id?.trim() || backend.model_id,
                endpoint: input.backend?.endpoint?.trim() || backend.endpoint,
                host_id: input.backend?.host_id?.trim() || backend.host_id,
                locality: input.backend?.locality === "remote" ? "remote" : input.backend?.locality === "local" ? "local" : backend.locality,
                context_window: input.backend?.context_window ?? backend.context_window,
                throughput_tps: input.backend?.throughput_tps ?? backend.throughput_tps,
                latency_ms_p50: input.backend?.latency_ms_p50 ?? backend.latency_ms_p50,
                success_rate: input.backend?.success_rate ?? backend.success_rate,
                win_rate: input.backend?.win_rate ?? backend.win_rate,
                cost_per_1k_input: input.backend?.cost_per_1k_input ?? backend.cost_per_1k_input,
                max_output_tokens: input.backend?.max_output_tokens ?? backend.max_output_tokens,
                tags: input.tags ? [...new Set([...backend.tags, ...input.tags.map((tag) => tag.trim()).filter(Boolean)])] : backend.tags,
                capabilities: input.capabilities && isRecord(input.capabilities)
                  ? { ...backend.capabilities, ...input.capabilities }
                  : backend.capabilities,
                heartbeat_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
        );
        return {
          state: storage.setModelRouterState({
            enabled: existing.enabled,
            strategy: existing.strategy,
            default_backend_id: existing.default_backend_id,
            backends: nextBackends,
          }),
        };
      }

      const nextBackends = existing.backends.filter((backend) => backend.backend_id !== input.backend_id);
      return {
        state: storage.setModelRouterState({
          enabled: existing.enabled,
          strategy: existing.strategy,
          default_backend_id:
            existing.default_backend_id === input.backend_id ? nextBackends[0]?.backend_id ?? null : existing.default_backend_id,
          backends: nextBackends,
        }),
      };
    },
  });
}
