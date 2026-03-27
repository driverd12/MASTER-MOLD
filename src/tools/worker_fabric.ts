import { z } from "zod";
import {
  Storage,
  type WorkerFabricHostRecord,
  type WorkerFabricHostTelemetryRecord,
  type WorkerFabricStateRecord,
} from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import type { ExecutionIsolationMode } from "../execution_isolation.js";

const hostTransportSchema = z.enum(["local", "ssh"]);
const thermalPressureSchema = z.enum(["nominal", "fair", "serious", "critical"]);

const recordSchema = z.record(z.unknown());

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const workerFabricTelemetrySchema = z.object({
  heartbeat_at: z.string().optional(),
  health_state: z.enum(["healthy", "degraded", "offline"]).optional(),
  queue_depth: z.number().int().min(0).max(100000).optional(),
  active_tasks: z.number().int().min(0).max(100000).optional(),
  latency_ms: z.number().min(0).max(10000000).optional(),
  cpu_utilization: z.number().min(0).max(1).optional(),
  ram_available_gb: z.number().min(0).max(1000000).optional(),
  ram_total_gb: z.number().min(0).max(1000000).optional(),
  gpu_utilization: z.number().min(0).max(1).optional(),
  gpu_memory_available_gb: z.number().min(0).max(1000000).optional(),
  gpu_memory_total_gb: z.number().min(0).max(1000000).optional(),
  disk_free_gb: z.number().min(0).max(1000000).optional(),
  thermal_pressure: thermalPressureSchema.optional(),
});

const workerFabricHostSchema = z.object({
  host_id: z.string().min(1),
  enabled: z.boolean().optional(),
  transport: hostTransportSchema.default("local"),
  ssh_destination: z.string().min(1).optional(),
  workspace_root: z.string().min(1),
  worker_count: z.number().int().min(1).max(64).default(1),
  shell: z.string().min(1).optional(),
  capabilities: recordSchema.optional(),
  tags: z.array(z.string().min(1)).optional(),
  telemetry: workerFabricTelemetrySchema.optional(),
  metadata: recordSchema.optional(),
});

export const workerFabricSchema = z
  .object({
    action: z.enum(["status", "configure", "upsert_host", "heartbeat", "remove_host"]).default("status"),
    mutation: mutationSchema.optional(),
    enabled: z.boolean().optional(),
    strategy: z.enum(["balanced", "prefer_local", "prefer_capacity", "resource_aware"]).optional(),
    default_host_id: z.string().min(1).optional(),
    host_id: z.string().min(1).optional(),
    host: workerFabricHostSchema.optional(),
    telemetry: workerFabricTelemetrySchema.optional(),
    capabilities: recordSchema.optional(),
    tags: z.array(z.string().min(1)).optional(),
    include_disabled: z.boolean().optional(),
    fallback_workspace_root: z.string().min(1).optional(),
    fallback_worker_count: z.number().int().min(1).max(64).optional(),
    fallback_shell: z.string().min(1).optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if (value.action !== "status" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for configure, upsert_host, and remove_host",
        path: ["mutation"],
      });
    }
    if (value.action === "upsert_host" && !value.host) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "host is required for upsert_host",
        path: ["host"],
      });
    }
    if (value.action === "remove_host" && !value.host_id?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "host_id is required for remove_host",
        path: ["host_id"],
      });
    }
    if (value.action === "heartbeat" && !value.host_id?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "host_id is required for heartbeat",
        path: ["host_id"],
      });
    }
  });

export type WorkerFabricSlot = {
  worker_id: string;
  host_id: string;
  transport: "local" | "ssh";
  ssh_destination: string | null;
  workspace_root: string;
  shell: string;
  tags: string[];
  capabilities: Record<string, unknown>;
  telemetry: WorkerFabricHostTelemetryRecord;
  metadata: Record<string, unknown>;
};

export type TaskExecutionRouting = {
  preferred_host_ids: string[];
  allowed_host_ids: string[];
  preferred_host_tags: string[];
  required_host_tags: string[];
  isolation_mode: ExecutionIsolationMode;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function normalizeTelemetry(input: Partial<WorkerFabricHostTelemetryRecord> | Record<string, unknown> | null | undefined) {
  const heartbeatAt =
    typeof input?.heartbeat_at === "string" && input.heartbeat_at.trim().length > 0
      ? input.heartbeat_at.trim()
      : null;
  const healthRaw = String(input?.health_state ?? "").trim().toLowerCase();
  const healthState =
    healthRaw === "degraded" || healthRaw === "offline" ? healthRaw : "healthy";
  const thermalRaw = String(input?.thermal_pressure ?? "").trim().toLowerCase();
  const thermalPressure =
    thermalRaw === "nominal" || thermalRaw === "fair" || thermalRaw === "serious" || thermalRaw === "critical"
      ? thermalRaw
      : null;
  const readRate = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
  const readCount = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  const readFloat = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Number(value.toFixed(4))) : null;
  return {
    heartbeat_at: heartbeatAt,
    health_state: healthState,
    queue_depth: readCount(input?.queue_depth),
    active_tasks: readCount(input?.active_tasks),
    latency_ms: readFloat(input?.latency_ms),
    cpu_utilization: readRate(input?.cpu_utilization),
    ram_available_gb: readFloat(input?.ram_available_gb),
    ram_total_gb: readFloat(input?.ram_total_gb),
    gpu_utilization: readRate(input?.gpu_utilization),
    gpu_memory_available_gb: readFloat(input?.gpu_memory_available_gb),
    gpu_memory_total_gb: readFloat(input?.gpu_memory_total_gb),
    disk_free_gb: readFloat(input?.disk_free_gb),
    thermal_pressure: thermalPressure,
  } satisfies WorkerFabricHostTelemetryRecord;
}

export function computeHostHealthScore(telemetry: WorkerFabricHostTelemetryRecord) {
  const healthBase = telemetry.health_state === "offline" ? 0 : telemetry.health_state === "degraded" ? 0.55 : 1;
  const cpuScore = telemetry.cpu_utilization === null ? 0.6 : 1 - telemetry.cpu_utilization;
  const gpuScore = telemetry.gpu_utilization === null ? 0.6 : 1 - telemetry.gpu_utilization;
  const queuePenalty = Math.min(0.4, telemetry.queue_depth * 0.03);
  const thermalPenalty =
    telemetry.thermal_pressure === "critical"
      ? 0.45
      : telemetry.thermal_pressure === "serious"
        ? 0.25
        : telemetry.thermal_pressure === "fair"
          ? 0.1
          : 0;
  const memoryScore =
    telemetry.ram_available_gb === null || telemetry.ram_total_gb === null || telemetry.ram_total_gb <= 0
      ? 0.65
      : Math.max(0.05, Math.min(1, telemetry.ram_available_gb / telemetry.ram_total_gb));
  const gpuMemoryScore =
    telemetry.gpu_memory_available_gb === null ||
    telemetry.gpu_memory_total_gb === null ||
    telemetry.gpu_memory_total_gb <= 0
      ? 0.65
      : Math.max(0.05, Math.min(1, telemetry.gpu_memory_available_gb / telemetry.gpu_memory_total_gb));
  const score = healthBase * 0.35 + cpuScore * 0.15 + gpuScore * 0.1 + memoryScore * 0.15 + gpuMemoryScore * 0.15 + (1 - queuePenalty) * 0.1;
  return Math.max(0, Number((score - thermalPenalty).toFixed(4)));
}

function normalizeHost(input: WorkerFabricHostRecord): WorkerFabricHostRecord {
  return {
    host_id: input.host_id.trim(),
    enabled: input.enabled !== false,
    transport: input.transport === "ssh" ? "ssh" : "local",
    ssh_destination: input.ssh_destination?.trim() || null,
    workspace_root: input.workspace_root.trim(),
    worker_count: Math.max(1, Math.min(64, Math.trunc(input.worker_count || 1))),
    shell: input.shell?.trim() || "/bin/zsh",
    capabilities: isRecord(input.capabilities) ? input.capabilities : {},
    tags: [...new Set((input.tags ?? []).map((entry) => entry.trim()).filter(Boolean))],
    telemetry: normalizeTelemetry(isRecord(input.telemetry) ? input.telemetry : input.telemetry ?? null),
    metadata: isRecord(input.metadata) ? input.metadata : {},
    updated_at: input.updated_at,
  };
}

export function buildImplicitLocalWorkerFabric(input: {
  workspace_root: string;
  worker_count: number;
  shell: string;
}): WorkerFabricStateRecord {
  const now = new Date().toISOString();
  return {
    enabled: true,
    strategy: "prefer_local",
    default_host_id: "local",
    updated_at: now,
    hosts: [
      {
        host_id: "local",
        enabled: true,
        transport: "local",
        ssh_destination: null,
        workspace_root: input.workspace_root,
        worker_count: Math.max(1, Math.min(64, Math.trunc(input.worker_count || 1))),
        shell: input.shell || "/bin/zsh",
        capabilities: {
          locality: "local",
        },
        tags: ["local", "default"],
        telemetry: normalizeTelemetry({
          heartbeat_at: now,
          health_state: "healthy",
        }),
        metadata: {},
        updated_at: now,
      },
    ],
  };
}

export function resolveEffectiveWorkerFabric(storage: Storage, input: {
  fallback_workspace_root: string;
  fallback_worker_count: number;
  fallback_shell: string;
}) {
  const persisted = storage.getWorkerFabricState();
  if (!persisted || !persisted.enabled || persisted.hosts.filter((host) => host.enabled).length === 0) {
    return buildImplicitLocalWorkerFabric({
      workspace_root: input.fallback_workspace_root,
      worker_count: input.fallback_worker_count,
      shell: input.fallback_shell,
    });
  }

  const enabledHosts = persisted.hosts.map(normalizeHost).filter((host) => host.enabled);
  const defaultHostId =
    persisted.default_host_id && enabledHosts.some((host) => host.host_id === persisted.default_host_id)
      ? persisted.default_host_id
      : enabledHosts[0]?.host_id ?? null;

  return {
    ...persisted,
    default_host_id: defaultHostId,
    hosts: enabledHosts,
  } satisfies WorkerFabricStateRecord;
}

export function buildWorkerFabricSlots(
  storage: Storage,
  input: {
    fallback_workspace_root: string;
    fallback_worker_count: number;
    fallback_shell: string;
  }
): WorkerFabricSlot[] {
  const state = resolveEffectiveWorkerFabric(storage, input);
  const explicitFabric = Boolean(storage.getWorkerFabricState()?.enabled);
  const singleImplicitLocal =
    !explicitFabric &&
    state.hosts.length === 1 &&
    state.hosts[0]?.host_id === "local" &&
    state.hosts[0]?.transport === "local";

  return state.hosts.flatMap((host) =>
    Array.from({ length: host.worker_count }, (_, index) => {
      const laneId = `worker-${index + 1}`;
      return {
        worker_id: singleImplicitLocal ? laneId : `${host.host_id}--${laneId}`,
        host_id: host.host_id,
        transport: host.transport,
        ssh_destination: host.ssh_destination,
        workspace_root: host.workspace_root,
        shell: host.shell,
        tags: host.tags,
        capabilities: host.capabilities,
        telemetry: host.telemetry,
        metadata: host.metadata,
      } satisfies WorkerFabricSlot;
    })
  );
}

export function resolveTaskExecutionRouting(metadata: Record<string, unknown> | null | undefined): TaskExecutionRouting {
  const execution = isRecord(metadata?.task_execution)
    ? metadata?.task_execution
    : isRecord(metadata?.execution)
      ? metadata?.execution
      : {};
  const isolationRaw = String((execution as Record<string, unknown>).isolation_mode ?? "git_worktree")
    .trim()
    .toLowerCase();
  const isolationMode: ExecutionIsolationMode =
    isolationRaw === "copy" || isolationRaw === "none" ? isolationRaw : "git_worktree";
  return {
    preferred_host_ids: normalizeStringArray((execution as Record<string, unknown>).preferred_host_ids),
    allowed_host_ids: normalizeStringArray((execution as Record<string, unknown>).allowed_host_ids),
    preferred_host_tags: normalizeStringArray((execution as Record<string, unknown>).preferred_host_tags),
    required_host_tags: normalizeStringArray((execution as Record<string, unknown>).required_host_tags),
    isolation_mode: isolationMode,
  };
}

export function rankWorkerFabricSlots(
  slots: WorkerFabricSlot[],
  routing: TaskExecutionRouting,
  strategy: WorkerFabricStateRecord["strategy"],
  defaultHostId: string | null
) {
  return slots
    .filter((slot) => {
      if (routing.allowed_host_ids.length > 0 && !routing.allowed_host_ids.includes(slot.host_id)) {
        return false;
      }
      if (routing.required_host_tags.length > 0) {
        const hostTags = new Set(slot.tags.map((entry) => entry.toLowerCase()));
        if (!routing.required_host_tags.every((tag) => hostTags.has(tag.toLowerCase()))) {
          return false;
        }
      }
      return true;
    })
    .sort((left, right) => {
      const leftPreferredHost = routing.preferred_host_ids.includes(left.host_id) ? 1 : 0;
      const rightPreferredHost = routing.preferred_host_ids.includes(right.host_id) ? 1 : 0;
      if (leftPreferredHost !== rightPreferredHost) {
        return rightPreferredHost - leftPreferredHost;
      }
      const leftPreferredTags = routing.preferred_host_tags.filter((tag) =>
        left.tags.map((entry) => entry.toLowerCase()).includes(tag.toLowerCase())
      ).length;
      const rightPreferredTags = routing.preferred_host_tags.filter((tag) =>
        right.tags.map((entry) => entry.toLowerCase()).includes(tag.toLowerCase())
      ).length;
      if (leftPreferredTags !== rightPreferredTags) {
        return rightPreferredTags - leftPreferredTags;
      }
      if (strategy === "resource_aware") {
        const leftScore = computeHostHealthScore(left.telemetry);
        const rightScore = computeHostHealthScore(right.telemetry);
        if (leftScore !== rightScore) {
          return rightScore - leftScore;
        }
      }
      if (strategy === "prefer_local") {
        const leftLocal = left.transport === "local" ? 1 : 0;
        const rightLocal = right.transport === "local" ? 1 : 0;
        if (leftLocal !== rightLocal) {
          return rightLocal - leftLocal;
        }
      }
      if (defaultHostId) {
        const leftDefault = left.host_id === defaultHostId ? 1 : 0;
        const rightDefault = right.host_id === defaultHostId ? 1 : 0;
        if (leftDefault !== rightDefault) {
          return rightDefault - leftDefault;
        }
      }
      if (strategy === "prefer_capacity") {
        const leftCapacity = Number(left.capabilities.gpu_memory_gb ?? left.capabilities.ram_gb ?? 0);
        const rightCapacity = Number(right.capabilities.gpu_memory_gb ?? right.capabilities.ram_gb ?? 0);
        if (leftCapacity !== rightCapacity) {
          return rightCapacity - leftCapacity;
        }
      }
      const leftQueue = left.telemetry.queue_depth;
      const rightQueue = right.telemetry.queue_depth;
      if (leftQueue !== rightQueue) {
        return leftQueue - rightQueue;
      }
      return left.worker_id.localeCompare(right.worker_id);
    });
}

export function workerFabric(storage: Storage, input: z.infer<typeof workerFabricSchema>) {
  if (input.action === "status") {
    const state = resolveEffectiveWorkerFabric(storage, {
      fallback_workspace_root: input.fallback_workspace_root ?? process.cwd(),
      fallback_worker_count: input.fallback_worker_count ?? 1,
      fallback_shell: input.fallback_shell ?? "/bin/zsh",
    });
    return {
      state,
      slots: buildWorkerFabricSlots(storage, {
        fallback_workspace_root: input.fallback_workspace_root ?? process.cwd(),
        fallback_worker_count: input.fallback_worker_count ?? 1,
        fallback_shell: input.fallback_shell ?? "/bin/zsh",
      }),
      hosts_summary: state.hosts.map((host) => ({
        host_id: host.host_id,
        enabled: host.enabled,
        transport: host.transport,
        tags: host.tags,
        telemetry: host.telemetry,
        health_score: computeHostHealthScore(host.telemetry),
      })),
    };
  }

  return runIdempotentMutation({
    storage,
    tool_name: "worker.fabric",
    mutation: input.mutation!,
    payload: input,
    execute: () => {
      const existing = storage.getWorkerFabricState() ?? {
        enabled: false,
        strategy: "balanced" as const,
        default_host_id: null,
        hosts: [],
        updated_at: new Date().toISOString(),
      };

      if (input.action === "configure") {
        return {
          state: storage.setWorkerFabricState({
            enabled: input.enabled ?? existing.enabled,
            strategy: input.strategy ?? existing.strategy,
            default_host_id: input.default_host_id ?? existing.default_host_id,
            hosts: existing.hosts,
          }),
        };
      }

      if (input.action === "upsert_host") {
        const host = input.host!;
        const nextHosts = existing.hosts.filter((entry) => entry.host_id !== host.host_id).concat([
          {
            host_id: host.host_id,
            enabled: host.enabled !== false,
            transport: host.transport,
            ssh_destination: host.ssh_destination?.trim() || null,
            workspace_root: host.workspace_root,
            worker_count: host.worker_count,
            shell: host.shell?.trim() || "/bin/zsh",
            capabilities: host.capabilities ?? {},
            tags: host.tags ?? [],
            telemetry: normalizeTelemetry(host.telemetry),
            metadata: host.metadata ?? {},
            updated_at: new Date().toISOString(),
          },
        ]);
        return {
          state: storage.setWorkerFabricState({
            enabled: existing.enabled,
            strategy: existing.strategy,
            default_host_id: existing.default_host_id ?? host.host_id,
            hosts: nextHosts,
          }),
        };
      }

      if (input.action === "heartbeat") {
        const hostId = input.host_id!.trim();
        const existingHost = existing.hosts.find((entry) => entry.host_id === hostId);
        if (!existingHost) {
          throw new Error(`Unknown worker fabric host: ${hostId}`);
        }
        const nextHosts = existing.hosts.map((entry) =>
          entry.host_id !== hostId
            ? entry
            : {
                ...entry,
                enabled: input.enabled ?? entry.enabled,
                capabilities: input.capabilities && isRecord(input.capabilities)
                  ? { ...entry.capabilities, ...input.capabilities }
                  : entry.capabilities,
                tags: input.tags ? [...new Set([...entry.tags, ...input.tags.map((tag) => tag.trim()).filter(Boolean)])] : entry.tags,
                telemetry: normalizeTelemetry({
                  ...entry.telemetry,
                  ...(input.telemetry ?? {}),
                  heartbeat_at: input.telemetry?.heartbeat_at?.trim() || new Date().toISOString(),
                }),
                updated_at: new Date().toISOString(),
              }
        );
        return {
          state: storage.setWorkerFabricState({
            enabled: existing.enabled,
            strategy: existing.strategy,
            default_host_id: existing.default_host_id,
            hosts: nextHosts,
          }),
        };
      }

      const nextHosts = existing.hosts.filter((entry) => entry.host_id !== input.host_id);
      return {
        state: storage.setWorkerFabricState({
          enabled: existing.enabled,
          strategy: existing.strategy,
          default_host_id:
            existing.default_host_id === input.host_id ? nextHosts[0]?.host_id ?? null : existing.default_host_id,
          hosts: nextHosts,
        }),
      };
    },
  });
}
