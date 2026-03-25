import { z } from "zod";
import { Storage } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { ensureWorkspaceFingerprint } from "./workspace_fingerprint.js";

const taskStatusSchema = z.enum(["pending", "running", "completed", "failed", "cancelled"]);
const sourceSchema = z.object({
  source: z.string().optional(),
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export const taskRoutingSchema = z.object({
  preferred_agent_ids: z.array(z.string().min(1)).optional(),
  allowed_agent_ids: z.array(z.string().min(1)).optional(),
  preferred_client_kinds: z.array(z.string().min(1)).optional(),
  allowed_client_kinds: z.array(z.string().min(1)).optional(),
  required_capabilities: z.array(z.string().min(1)).optional(),
  preferred_capabilities: z.array(z.string().min(1)).optional(),
});

export const taskCreateSchema = z.object({
  mutation: mutationSchema,
  task_id: z.string().min(1).max(200).optional(),
  objective: z.string().min(1),
  project_dir: z.string().min(1).optional(),
  payload: z.record(z.unknown()).optional(),
  routing: taskRoutingSchema.optional(),
  priority: z.number().int().min(0).max(100).optional(),
  max_attempts: z.number().int().min(1).max(20).optional(),
  available_at: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.unknown()).optional(),
  ...sourceSchema.shape,
});

export const taskListSchema = z.object({
  status: taskStatusSchema.optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const taskTimelineSchema = z.object({
  task_id: z.string().min(1),
  limit: z.number().int().min(1).max(500).optional(),
});

export const taskSummarySchema = z.object({
  running_limit: z.number().int().min(1).max(200).optional(),
});

export const taskClaimSchema = z.object({
  mutation: mutationSchema,
  worker_id: z.string().min(1),
  lease_seconds: z.number().int().min(15).max(86400).optional(),
  task_id: z.string().min(1).optional(),
});

export const taskHeartbeatSchema = z.object({
  mutation: mutationSchema,
  task_id: z.string().min(1),
  worker_id: z.string().min(1),
  lease_seconds: z.number().int().min(15).max(86400).optional(),
});

export const taskCompleteSchema = z.object({
  mutation: mutationSchema,
  task_id: z.string().min(1),
  worker_id: z.string().min(1),
  result: z.record(z.unknown()).optional(),
  summary: z.string().optional(),
});

export const taskFailSchema = z.object({
  mutation: mutationSchema,
  task_id: z.string().min(1),
  worker_id: z.string().min(1),
  error: z.string().min(1),
  result: z.record(z.unknown()).optional(),
  summary: z.string().optional(),
});

export const taskRetrySchema = z.object({
  mutation: mutationSchema,
  task_id: z.string().min(1),
  delay_seconds: z.number().int().min(0).max(86400).optional(),
  reason: z.string().optional(),
  force: z.boolean().optional(),
});

export const taskAutoRetrySchema = z
  .object({
    action: z.enum(["status", "start", "stop", "run_once"]).default("status"),
    mutation: mutationSchema.optional(),
    interval_seconds: z.number().int().min(5).max(3600).optional(),
    batch_limit: z.number().int().min(1).max(500).optional(),
    base_delay_seconds: z.number().int().min(0).max(86400).optional(),
    max_delay_seconds: z.number().int().min(0).max(604800).optional(),
    run_immediately: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action !== "status" && !value.mutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mutation is required for start, stop, and run_once actions",
        path: ["mutation"],
      });
    }
  });

type TaskAutoRetryConfig = {
  interval_seconds: number;
  batch_limit: number;
  base_delay_seconds: number;
  max_delay_seconds: number;
};

type TaskAutoRetryRunResult = {
  task_id: string;
  attempt_count: number;
  max_attempts: number;
  delay_seconds: number;
  retried: boolean;
  reason?: string;
  error?: string;
};

type TaskAutoRetryTickResult = {
  completed_at: string;
  failed_seen: number;
  retried_count: number;
  skipped_count: number;
  run_results: TaskAutoRetryRunResult[];
  skipped?: boolean;
  reason?: string;
};

const DEFAULT_TASK_AUTO_RETRY_CONFIG: TaskAutoRetryConfig = {
  interval_seconds: 60,
  batch_limit: 20,
  base_delay_seconds: 30,
  max_delay_seconds: 3600,
};

const taskAutoRetryRuntime: {
  running: boolean;
  timer: NodeJS.Timeout | null;
  config: TaskAutoRetryConfig;
  in_tick: boolean;
  started_at: string | null;
  last_tick_at: string | null;
  last_error: string | null;
  tick_count: number;
  total_failed_seen: number;
  total_retried: number;
  total_skipped: number;
} = {
  running: false,
  timer: null,
  config: { ...DEFAULT_TASK_AUTO_RETRY_CONFIG },
  in_tick: false,
  started_at: null,
  last_tick_at: null,
  last_error: null,
  tick_count: 0,
  total_failed_seen: 0,
  total_retried: 0,
  total_skipped: 0,
};

export function initializeTaskAutoRetryDaemon(storage: Storage) {
  const persisted = storage.getTaskAutoRetryState();
  if (!persisted) {
    taskAutoRetryRuntime.config = { ...DEFAULT_TASK_AUTO_RETRY_CONFIG };
    stopTaskAutoRetryDaemon();
    return {
      restored: false,
      running: false,
      config: { ...taskAutoRetryRuntime.config },
    };
  }

  taskAutoRetryRuntime.config = resolveTaskAutoRetryConfig(persisted, DEFAULT_TASK_AUTO_RETRY_CONFIG);
  if (persisted.enabled) {
    startTaskAutoRetryDaemon(storage);
  } else {
    stopTaskAutoRetryDaemon();
  }

  return {
    restored: true,
    running: taskAutoRetryRuntime.running,
    config: { ...taskAutoRetryRuntime.config },
    updated_at: persisted.updated_at,
  };
}

export async function taskCreate(storage: Storage, input: z.infer<typeof taskCreateSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "task.create",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const metadata = {
        ...(input.metadata ?? {}),
        ...(input.routing
          ? {
              task_routing: {
                preferred_agent_ids: dedupeStrings(input.routing.preferred_agent_ids),
                allowed_agent_ids: dedupeStrings(input.routing.allowed_agent_ids),
                preferred_client_kinds: dedupeStrings(input.routing.preferred_client_kinds),
                allowed_client_kinds: dedupeStrings(input.routing.allowed_client_kinds),
                required_capabilities: dedupeStrings(input.routing.required_capabilities),
                preferred_capabilities: dedupeStrings(input.routing.preferred_capabilities),
              },
            }
          : {}),
      };
      const task = storage.createTask({
        task_id: input.task_id,
        objective: input.objective,
        project_dir: input.project_dir ?? ".",
        payload: input.payload,
        priority: input.priority,
        max_attempts: input.max_attempts,
        available_at: input.available_at,
        source: input.source,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
        tags: input.tags,
        metadata,
      });
      ensureWorkspaceFingerprint(storage, input.project_dir ?? ".", {
        source: "task.create",
      });
      return task;
    },
  });
}

function dedupeStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

export function taskList(storage: Storage, input: z.infer<typeof taskListSchema>) {
  const tasks = storage.listTasks({
    status: input.status,
    limit: input.limit ?? 100,
  });
  return {
    status_filter: input.status ?? null,
    count: tasks.length,
    tasks,
  };
}

export function taskTimeline(storage: Storage, input: z.infer<typeof taskTimelineSchema>) {
  const limit = input.limit ?? 100;
  const events = storage.getTaskTimeline(input.task_id, limit);
  return {
    task_id: input.task_id,
    count: events.length,
    events,
  };
}

export function taskSummary(storage: Storage, input: z.infer<typeof taskSummarySchema>) {
  const summary = storage.getTaskSummary({
    running_limit: input.running_limit ?? 10,
  });
  return {
    ...summary,
    running_count: summary.running.length,
  };
}

export async function taskClaim(storage: Storage, input: z.infer<typeof taskClaimSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "task.claim",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.claimTask({
        worker_id: input.worker_id,
        lease_seconds: input.lease_seconds ?? 300,
        task_id: input.task_id,
      }),
  });
}

export async function taskHeartbeat(storage: Storage, input: z.infer<typeof taskHeartbeatSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "task.heartbeat",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.heartbeatTaskLease({
        task_id: input.task_id,
        worker_id: input.worker_id,
        lease_seconds: input.lease_seconds ?? 300,
      }),
  });
}

export async function taskComplete(storage: Storage, input: z.infer<typeof taskCompleteSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "task.complete",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.completeTask({
        task_id: input.task_id,
        worker_id: input.worker_id,
        result: input.result,
        summary: input.summary,
      }),
  });
}

export async function taskFail(storage: Storage, input: z.infer<typeof taskFailSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "task.fail",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.failTask({
        task_id: input.task_id,
        worker_id: input.worker_id,
        error: input.error,
        result: input.result,
        summary: input.summary,
      }),
  });
}

export async function taskRetry(storage: Storage, input: z.infer<typeof taskRetrySchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "task.retry",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.retryTask({
        task_id: input.task_id,
        delay_seconds: input.delay_seconds ?? 0,
        reason: input.reason,
        force: input.force,
      }),
  });
}

export function taskAutoRetryControl(storage: Storage, input: z.infer<typeof taskAutoRetrySchema>) {
  if (input.action === "status") {
    return getTaskAutoRetryStatus();
  }

  if (!input.mutation) {
    throw new Error("mutation is required for start, stop, and run_once actions");
  }

  return runIdempotentMutation({
    storage,
    tool_name: "task.auto_retry",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      if (input.action === "start") {
        const wasRunning = taskAutoRetryRuntime.running;
        taskAutoRetryRuntime.config = resolveTaskAutoRetryConfig(input, taskAutoRetryRuntime.config);
        startTaskAutoRetryDaemon(storage);
        let initialTick: TaskAutoRetryTickResult | undefined;
        if (input.run_immediately ?? true) {
          initialTick = runTaskAutoRetryTick(storage, taskAutoRetryRuntime.config);
        }
        return {
          running: true,
          started: !wasRunning,
          updated: wasRunning,
          config: { ...taskAutoRetryRuntime.config },
          persisted: storage.setTaskAutoRetryState({
            enabled: true,
            interval_seconds: taskAutoRetryRuntime.config.interval_seconds,
            batch_limit: taskAutoRetryRuntime.config.batch_limit,
            base_delay_seconds: taskAutoRetryRuntime.config.base_delay_seconds,
            max_delay_seconds: taskAutoRetryRuntime.config.max_delay_seconds,
          }),
          initial_tick: initialTick,
          status: getTaskAutoRetryStatus(),
        };
      }

      if (input.action === "stop") {
        const wasRunning = taskAutoRetryRuntime.running;
        stopTaskAutoRetryDaemon();
        return {
          running: false,
          stopped: wasRunning,
          persisted: storage.setTaskAutoRetryState({
            enabled: false,
            interval_seconds: taskAutoRetryRuntime.config.interval_seconds,
            batch_limit: taskAutoRetryRuntime.config.batch_limit,
            base_delay_seconds: taskAutoRetryRuntime.config.base_delay_seconds,
            max_delay_seconds: taskAutoRetryRuntime.config.max_delay_seconds,
          }),
          status: getTaskAutoRetryStatus(),
        };
      }

      const config = resolveTaskAutoRetryConfig(input, taskAutoRetryRuntime.config);
      const tick = runTaskAutoRetryTick(storage, config);
      return {
        running: taskAutoRetryRuntime.running,
        tick,
        status: getTaskAutoRetryStatus(),
      };
    },
  });
}

function getTaskAutoRetryStatus() {
  return {
    running: taskAutoRetryRuntime.running,
    in_tick: taskAutoRetryRuntime.in_tick,
    config: { ...taskAutoRetryRuntime.config },
    started_at: taskAutoRetryRuntime.started_at,
    last_tick_at: taskAutoRetryRuntime.last_tick_at,
    last_error: taskAutoRetryRuntime.last_error,
    stats: {
      tick_count: taskAutoRetryRuntime.tick_count,
      total_failed_seen: taskAutoRetryRuntime.total_failed_seen,
      total_retried: taskAutoRetryRuntime.total_retried,
      total_skipped: taskAutoRetryRuntime.total_skipped,
    },
  };
}

function resolveTaskAutoRetryConfig(
  input:
    | z.infer<typeof taskAutoRetrySchema>
    | Partial<
        Pick<
          z.infer<typeof taskAutoRetrySchema>,
          "interval_seconds" | "batch_limit" | "base_delay_seconds" | "max_delay_seconds"
        >
      >,
  fallback: TaskAutoRetryConfig
): TaskAutoRetryConfig {
  const baseDelay = input.base_delay_seconds ?? fallback.base_delay_seconds ?? DEFAULT_TASK_AUTO_RETRY_CONFIG.base_delay_seconds;
  const maxDelayRaw = input.max_delay_seconds ?? fallback.max_delay_seconds ?? DEFAULT_TASK_AUTO_RETRY_CONFIG.max_delay_seconds;
  return {
    interval_seconds: input.interval_seconds ?? fallback.interval_seconds ?? DEFAULT_TASK_AUTO_RETRY_CONFIG.interval_seconds,
    batch_limit: input.batch_limit ?? fallback.batch_limit ?? DEFAULT_TASK_AUTO_RETRY_CONFIG.batch_limit,
    base_delay_seconds: baseDelay,
    max_delay_seconds: Math.max(baseDelay, maxDelayRaw),
  };
}

function startTaskAutoRetryDaemon(storage: Storage) {
  stopTaskAutoRetryDaemon();
  taskAutoRetryRuntime.running = true;
  taskAutoRetryRuntime.in_tick = false;
  taskAutoRetryRuntime.started_at = new Date().toISOString();
  taskAutoRetryRuntime.last_error = null;
  taskAutoRetryRuntime.timer = setInterval(() => {
    try {
      runTaskAutoRetryTick(storage, taskAutoRetryRuntime.config);
    } catch (error) {
      taskAutoRetryRuntime.last_error = error instanceof Error ? error.message : String(error);
    }
  }, taskAutoRetryRuntime.config.interval_seconds * 1000);
  taskAutoRetryRuntime.timer.unref?.();
}

function stopTaskAutoRetryDaemon() {
  if (taskAutoRetryRuntime.timer) {
    clearInterval(taskAutoRetryRuntime.timer);
  }
  taskAutoRetryRuntime.timer = null;
  taskAutoRetryRuntime.running = false;
  taskAutoRetryRuntime.in_tick = false;
}

function runTaskAutoRetryTick(storage: Storage, config: TaskAutoRetryConfig): TaskAutoRetryTickResult {
  if (taskAutoRetryRuntime.in_tick) {
    const completedAt = new Date().toISOString();
    return {
      completed_at: completedAt,
      failed_seen: 0,
      retried_count: 0,
      skipped_count: 0,
      run_results: [],
      skipped: true,
      reason: "tick-in-progress",
    };
  }

  taskAutoRetryRuntime.in_tick = true;
  try {
    const failedTasks = storage.listFailedTasksForAutoRetry(config.batch_limit);
    const runResults: TaskAutoRetryRunResult[] = [];
    const runErrors: string[] = [];
    let retriedCount = 0;
    let skippedCount = 0;

    for (const task of failedTasks) {
      const delaySeconds = computeRetryBackoffSeconds(
        task.attempt_count,
        config.base_delay_seconds,
        config.max_delay_seconds
      );
      try {
        const retryResult = storage.retryTask({
          task_id: task.task_id,
          delay_seconds: delaySeconds,
          reason: `auto-retry attempt=${task.attempt_count} backoff=${delaySeconds}s`,
        });
        if (retryResult.retried) {
          retriedCount += 1;
        } else {
          skippedCount += 1;
        }
        runResults.push({
          task_id: task.task_id,
          attempt_count: task.attempt_count,
          max_attempts: task.max_attempts,
          delay_seconds: delaySeconds,
          retried: retryResult.retried,
          reason: retryResult.reason,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        runErrors.push(`${task.task_id}: ${message}`);
        skippedCount += 1;
        runResults.push({
          task_id: task.task_id,
          attempt_count: task.attempt_count,
          max_attempts: task.max_attempts,
          delay_seconds: delaySeconds,
          retried: false,
          error: message,
        });
      }
    }

    const completedAt = new Date().toISOString();
    taskAutoRetryRuntime.tick_count += 1;
    taskAutoRetryRuntime.total_failed_seen += failedTasks.length;
    taskAutoRetryRuntime.total_retried += retriedCount;
    taskAutoRetryRuntime.total_skipped += skippedCount;
    taskAutoRetryRuntime.last_tick_at = completedAt;
    taskAutoRetryRuntime.last_error = runErrors.length
      ? `${runErrors.length} task(s) failed retry: ${runErrors[0]}`
      : null;

    return {
      completed_at: completedAt,
      failed_seen: failedTasks.length,
      retried_count: retriedCount,
      skipped_count: skippedCount,
      run_results: runResults,
      reason: runErrors.length ? taskAutoRetryRuntime.last_error ?? undefined : undefined,
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    taskAutoRetryRuntime.tick_count += 1;
    taskAutoRetryRuntime.last_tick_at = completedAt;
    taskAutoRetryRuntime.last_error = message;
    return {
      completed_at: completedAt,
      failed_seen: 0,
      retried_count: 0,
      skipped_count: 0,
      run_results: [],
      reason: message,
    };
  } finally {
    taskAutoRetryRuntime.in_tick = false;
  }
}

function computeRetryBackoffSeconds(attemptCount: number, baseDelaySeconds: number, maxDelaySeconds: number): number {
  const normalizedAttempt = Math.max(1, Math.floor(attemptCount));
  const exponent = Math.max(0, normalizedAttempt - 1);
  const scaled = baseDelaySeconds * Math.pow(2, exponent);
  const bounded = Math.min(maxDelaySeconds, scaled);
  return Math.max(0, Math.round(bounded));
}
