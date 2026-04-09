import { z } from "zod";
import { summarizeDesktopControlState } from "../desktop_control_plane.js";
import { summarizePatientZeroState } from "../patient_zero_plane.js";
import {
  type AgentSessionRecord,
  type RuntimeWorkerSessionRecord,
  type TaskRecord,
  type TriChatAdapterTelemetrySummaryRecord,
  Storage,
} from "../storage.js";
import { getTriChatAgentCatalog, getTriChatConfiguredDefaultAgentIds } from "../trichat_roster.js";
import type { AgentLearningOverview } from "./agent_learning.js";
import { listAgentSessions } from "./agent_session.js";
import { summarizeAgentLearning } from "./agent_learning.js";
import { getAutonomyMaintainRuntimeStatus } from "./autonomy_maintain.js";
import { kernelSummary, summarizeAutonomyMaintain } from "./kernel.js";
import { operatorBrief } from "./operator_brief.js";
import {
  buildProviderBridgeOnboardingSummary,
  resolveProviderBridgeDiagnostics,
  resolveProviderBridgeSnapshot,
} from "./provider_bridge.js";
import { getReactionEngineRuntimeStatus } from "./reaction_engine.js";
import { summarizeLiveRuntimeWorkers } from "./runtime_worker.js";
import { taskList, taskSummary } from "./task.js";
import { getAutopilotStatus, trichatAdapterTelemetry, trichatSummary, trichatWorkboard } from "./trichat.js";
import { readWarmCacheEntry } from "../warm_cache_runtime.js";
import { buildPatientZeroReport } from "./patient_zero.js";
import { buildPrivilegedAccessStatus } from "./privileged_exec.js";

const recordSchema = z.record(z.unknown());
type TaskListPayload = ReturnType<typeof taskList>;
type TaskSummaryPayload = ReturnType<typeof taskSummary>;
type AgentSessionListPayload = ReturnType<typeof listAgentSessions>;
type LearningPayload = AgentLearningOverview | {};
type AdapterPayload = ReturnType<typeof trichatAdapterTelemetry>;
type WorkboardPayload = ReturnType<typeof trichatWorkboard>;
type TriChatSummaryPayload = ReturnType<typeof trichatSummary>;
type OperatorBriefPayload = ReturnType<typeof operatorBrief>;
type ProviderBridgePayload = {
  snapshot: ReturnType<typeof resolveProviderBridgeSnapshot>;
  diagnostics: ReturnType<typeof resolveProviderBridgeDiagnostics>;
};
type RuntimeWorkersPayload = {
  count: number;
  sessions: RuntimeWorkerSessionRecord[];
  summary: {
    session_count: number;
    active_count: number;
    counts: Record<string, number>;
    latest_session: RuntimeWorkerSessionRecord | null;
  };
};

export const officeSnapshotSchema = z.object({
  thread_id: z.string().min(1).optional(),
  turn_limit: z.number().int().min(1).max(30).default(12),
  task_limit: z.number().int().min(1).max(64).default(24),
  session_limit: z.number().int().min(1).max(100).default(50),
  event_limit: z.number().int().min(1).max(80).default(24),
  learning_limit: z.number().int().min(1).max(500).default(120),
  runtime_worker_limit: z.number().int().min(1).max(100).default(20),
  include_kernel: z.boolean().default(true),
  include_learning: z.boolean().default(true),
  include_bus: z.boolean().default(true),
  include_adapter: z.boolean().default(true),
  include_runtime_workers: z.boolean().default(true),
  metadata: recordSchema.optional(),
});

const OFFICE_SNAPSHOT_DEFAULT_THREAD_ID = "ring-leader-main";

export function officeSnapshotWarmCacheKey(threadId: string) {
  return `office.snapshot:${threadId}`;
}

function isDefaultOfficeSnapshotRequest(input: z.infer<typeof officeSnapshotSchema>) {
  return (
    (input.thread_id?.trim() || OFFICE_SNAPSHOT_DEFAULT_THREAD_ID) !== "" &&
    input.turn_limit === 12 &&
    input.task_limit === 24 &&
    input.session_limit === 50 &&
    input.event_limit === 24 &&
    input.learning_limit === 120 &&
    input.runtime_worker_limit === 20 &&
    input.include_kernel === true &&
    input.include_learning === true &&
    input.include_bus === true &&
    input.include_adapter === true &&
    input.include_runtime_workers === true &&
    input.metadata === undefined
  );
}

function normalizeAgentId(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function dedupeAgentIds(values: unknown[]) {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const agentId = normalizeAgentId(value);
    if (!agentId || seen.has(agentId)) {
      continue;
    }
    seen.add(agentId);
    ordered.push(agentId);
  }
  return ordered;
}

function ageSeconds(value: string | null | undefined) {
  if (!value) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, (Date.now() - parsed) / 1000);
}

function providerBridgeDiagnosticsStale(autonomyMaintainState: Record<string, unknown>) {
  const lastCheckAt = String(autonomyMaintainState.last_provider_bridge_check_at ?? "").trim();
  const configuredIntervalSeconds = Number(autonomyMaintainState.interval_seconds ?? 120);
  const intervalSeconds = Number.isFinite(configuredIntervalSeconds) && configuredIntervalSeconds > 0 ? configuredIntervalSeconds : 120;
  return ageSeconds(lastCheckAt) > Math.max(intervalSeconds * 3, 300);
}

function summarizeTmuxDashboard(state: ReturnType<Storage["getTriChatTmuxControllerState"]>) {
  const tasks = state?.tasks ?? [];
  const queueDepth = tasks.filter((task) => task.status === "queued" || task.status === "dispatched").length;
  const runningDepth = tasks.filter((task) => task.status === "running").length;
  const failed = tasks.filter((task) => task.status === "failed");
  const queuedOrRunning = tasks.filter(
    (task) => task.status === "queued" || task.status === "dispatched" || task.status === "running"
  );
  const oldestTask = queuedOrRunning
    .slice()
    .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at))[0];
  return {
    queue_depth: queueDepth,
    running_depth: runningDepth,
    queue_oldest_task_id: oldestTask?.task_id ?? null,
    queue_age_seconds: oldestTask ? ageSeconds(oldestTask.created_at) : 0,
    failure_count: failed.length,
    failure_class: failed.length > 0 ? "task-failed" : "none",
    worker_load: [],
    host_load: [],
  };
}

function summarizeRuntimeWorkers(storage: Storage, limit: number): RuntimeWorkersPayload {
  return summarizeLiveRuntimeWorkers(storage, limit);
}

function summarizeAutonomyMaintainState(storage: Storage) {
  const state = storage.getAutonomyMaintainState();
  const summary = summarizeAutonomyMaintain(state, storage);
  return {
    action: "status_cached",
    state: state ?? {
      enabled: false,
      interval_seconds: 120,
      learning_review_interval_seconds: 300,
      run_eval_if_due: true,
      eval_interval_seconds: 21600,
      eval_suite_id: "autonomy.control-plane",
      minimum_eval_score: 75,
      last_run_at: null,
      last_bootstrap_ready_at: null,
      last_goal_autorun_daemon_at: null,
      last_tmux_maintained_at: null,
      last_learning_review_at: null,
      last_learning_entry_count: 0,
      last_learning_active_agent_count: 0,
      last_eval_run_at: null,
      last_eval_run_id: null,
      last_eval_score: null,
      last_provider_bridge_check_at: null,
      provider_bridge_diagnostics: [],
      last_actions: [],
      last_attention: [],
      last_error: null,
      updated_at: new Date().toISOString(),
    },
    runtime: summary.runtime,
    due: {
      stale: summary.stale,
      eval: summary.eval_due,
    },
    subsystems: summary.subsystems,
  };
}

function buildOfficeSetupDiagnostics(params: {
  kernel: Record<string, unknown>;
  providerBridge: {
    diagnostics: ProviderBridgePayload["diagnostics"];
    onboarding: ReturnType<typeof buildProviderBridgeOnboardingSummary>;
  };
  desktopControl: {
    state: ReturnType<Storage["getDesktopControlState"]>;
    summary: ReturnType<typeof summarizeDesktopControlState>;
  };
  patientZero: {
    state: ReturnType<Storage["getPatientZeroState"]>;
    summary: ReturnType<typeof summarizePatientZeroState>;
    report: ReturnType<typeof buildPatientZeroReport>;
  };
}) {
  const kernelSetup = asRecord(params.kernel.setup_diagnostics);
  const kernelPlatform = asRecord(kernelSetup.platform);
  const kernelFallback = asRecord(kernelSetup.fallback);
  return {
    source: "office.snapshot",
    platform: {
      platform: String(kernelPlatform.platform ?? process.platform),
      arch: String(kernelPlatform.arch ?? process.arch),
      browser_app: String(kernelPlatform.browser_app ?? params.patientZero.summary.browser_app ?? "").trim() || null,
    },
    provider_bridge: {
      generated_at: params.providerBridge.diagnostics.generated_at,
      cached: params.providerBridge.diagnostics.cached,
      stale: params.providerBridge.diagnostics.stale ?? false,
      connected_count: params.providerBridge.diagnostics.diagnostics.filter((entry) => entry.status === "connected").length,
      configured_count: params.providerBridge.diagnostics.diagnostics.filter((entry) => entry.status === "configured").length,
      disconnected_count: params.providerBridge.diagnostics.diagnostics.filter((entry) => entry.status === "disconnected").length,
      unavailable_count: params.providerBridge.diagnostics.diagnostics.filter((entry) => entry.status === "unavailable").length,
      onboarding: params.providerBridge.onboarding,
    },
    desktop_control: params.desktopControl.summary,
    patient_zero: params.patientZero.summary,
    fallback: {
      core_usable:
        typeof kernelFallback.core_usable === "boolean"
          ? kernelFallback.core_usable
          : params.providerBridge.diagnostics.stale !== true,
      browser_degraded:
        typeof kernelFallback.browser_degraded === "boolean"
          ? kernelFallback.browser_degraded
          : params.patientZero.summary.browser_ready !== true,
      provider_bridge_degraded:
        typeof kernelFallback.provider_bridge_degraded === "boolean"
          ? kernelFallback.provider_bridge_degraded
          : params.providerBridge.diagnostics.stale === true,
      desktop_degraded:
        typeof kernelFallback.desktop_degraded === "boolean"
          ? kernelFallback.desktop_degraded
          : params.desktopControl.summary.stale === true,
    },
    next_actions: Array.isArray(kernelSetup.next_actions)
      ? kernelSetup.next_actions.map((entry) => String(entry ?? "").trim()).filter(Boolean)
      : [],
  };
}

function summarizeReactionEngineState(storage: Storage) {
  const state = storage.getReactionEngineState();
  const runtime = getReactionEngineRuntimeStatus();
  const stale =
    state?.enabled === true && ageSeconds(runtime.last_tick_at || state.last_run_at) > Math.max((state.interval_seconds ?? 60) * 3, 300);
  return {
    ...(state ?? {
      enabled: false,
      interval_seconds: 60,
      dedupe_window_seconds: 300,
      channels: [],
      last_run_at: null,
      last_sent_at: null,
      last_sent_count: 0,
      last_alert_key: null,
      last_alert_seen_count: 0,
      recent_notifications: [],
      last_error: null,
      updated_at: new Date().toISOString(),
    }),
    runtime,
    stale,
  };
}

function buildRosterPayload(
  workboard: WorkboardPayload,
  agentSessions: AgentSessionListPayload,
  learning: LearningPayload,
  autopilot: Record<string, unknown>
) {
  const latestTurn = (workboard.active_turn as Record<string, unknown> | null) ?? (workboard.latest_turn as Record<string, unknown> | null) ?? {};
  const latestMetadata = (latestTurn.metadata as Record<string, unknown> | undefined) ?? {};
  const autopilotState = asRecord(autopilot.state);
  const autopilotConfig = asRecord(autopilotState.config);
  const autopilotPool = asRecord(autopilotState.effective_agent_pool);
  const autopilotSession = asRecord(asRecord(autopilotState.session).session);
  const autopilotSessionMetadata = asRecord(autopilotSession.metadata);
  const defaultAgentIds = getTriChatConfiguredDefaultAgentIds();
  const activeAgentIds = dedupeAgentIds([
    autopilotPool.lead_agent_id,
    ...((Array.isArray(autopilotPool.specialist_agent_ids) ? autopilotPool.specialist_agent_ids : []) as unknown[]),
    ...((Array.isArray(autopilotPool.council_agent_ids) ? autopilotPool.council_agent_ids : []) as unknown[]),
    autopilotConfig.lead_agent_id,
    ...((Array.isArray(autopilotConfig.specialist_agent_ids) ? autopilotConfig.specialist_agent_ids : []) as unknown[]),
    autopilotSession.agent_id,
    ...((Array.isArray(autopilotSessionMetadata.specialist_agent_ids) ? autopilotSessionMetadata.specialist_agent_ids : []) as unknown[]),
    ...((Array.isArray(autopilotSessionMetadata.council_agent_ids) ? autopilotSessionMetadata.council_agent_ids : []) as unknown[]),
    latestMetadata.lead_agent_id,
    latestTurn.selected_agent,
    ...((Array.isArray(latestTurn.expected_agents) ? latestTurn.expected_agents : []) as unknown[]),
    ...((Array.isArray(latestMetadata.specialist_agent_ids) ? latestMetadata.specialist_agent_ids : []) as unknown[]),
    ...agentSessions.sessions.map((session) => session.agent_id),
    ...(((learning as Record<string, unknown>).top_agents as Array<Record<string, unknown>> | undefined) ?? []).map(
      (entry) => entry.agent_id
    ),
    ...defaultAgentIds,
  ]);
  return {
    default_agent_ids: defaultAgentIds,
    active_agent_ids: activeAgentIds,
    agents: getTriChatAgentCatalog().map((agent) => ({
      agent_id: agent.agent_id,
      display_name: agent.display_name,
      provider: agent.provider ?? null,
      role_lane: agent.role_lane ?? "support",
      coordination_tier: agent.coordination_tier ?? "support",
      parent_agent_id: agent.parent_agent_id ?? "",
      managed_agent_ids: agent.managed_agent_ids ?? [],
      accent_color: agent.accent_color ?? "",
      enabled: agent.enabled !== false,
    })),
    source: "office.snapshot",
  };
}

function buildKernelPayload(storage: Storage, summary: TaskSummaryPayload, sessions: AgentSessionListPayload) {
  return kernelSummary(storage, {
    session_limit: Math.max(8, sessions.count || 8),
    event_limit: 12,
    task_running_limit: Math.max(8, summary.running.length || 8),
  });
}

export function computeOfficeSnapshot(storage: Storage, input: z.infer<typeof officeSnapshotSchema>) {
  const threadId = input.thread_id?.trim() || "ring-leader-main";
  const errors: string[] = [];
  const safe = <T>(label: string, fallback: T, read: () => T) => {
    try {
      return read();
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return fallback;
    }
  };

  const workboard = safe<WorkboardPayload>("workboard", trichatWorkboard(storage, { thread_id: threadId, limit: 1 }), () =>
    trichatWorkboard(storage, { thread_id: threadId, limit: input.turn_limit })
  );
  const taskSummaryPayload = safe<TaskSummaryPayload>("task_summary", taskSummary(storage, { running_limit: 8 }), () =>
    taskSummary(storage, { running_limit: Math.max(4, Math.min(24, input.task_limit)) })
  );
  const taskRunning = safe<TaskListPayload>("task_running", { status_filter: "running", count: 0, tasks: [] as TaskRecord[] }, () =>
    taskList(storage, { status: "running", limit: input.task_limit })
  );
  const taskPending = safe<TaskListPayload>("task_pending", { status_filter: "pending", count: 0, tasks: [] as TaskRecord[] }, () =>
    taskList(storage, { status: "pending", limit: input.task_limit })
  );
  const agentSessions = safe<AgentSessionListPayload>("agent_sessions", {
    status_filter: null,
    agent_id_filter: null,
    client_kind_filter: null,
    active_only_filter: null,
    count: 0,
    sessions: [] as AgentSessionRecord[],
  }, () =>
    listAgentSessions(storage, { limit: input.session_limit })
  );
  const learning = input.include_learning
    ? safe<LearningPayload>("learning", {
        generated_at: new Date().toISOString(),
        filter: { agent_id: null },
        total_entries: 0,
        active_entry_count: 0,
        suppressed_entry_count: 0,
        prefer_count: 0,
        avoid_count: 0,
        agent_count: 0,
        agents_with_active_entries: 0,
        kind_counts: {
          execution_pattern: 0,
          delegation_pattern: 0,
          verification_pattern: 0,
          failure_pattern: 0,
          guardrail: 0,
        },
        top_agents: [],
        recent_entries: [],
      }, () =>
        summarizeAgentLearning(storage, {
          limit: input.learning_limit,
          top_agents_limit: 8,
          recent_limit: 8,
        })
      )
    : {};
  const autopilot = safe<Record<string, unknown>>("autopilot", {}, () => ({
    state: getAutopilotStatus(storage),
  }));
  const roster = safe("roster", {
    default_agent_ids: getTriChatConfiguredDefaultAgentIds(),
    active_agent_ids: [] as string[],
    agents: getTriChatAgentCatalog().map((agent) => ({
      agent_id: agent.agent_id,
      display_name: agent.display_name,
      provider: agent.provider ?? null,
      role_lane: agent.role_lane ?? "support",
      coordination_tier: agent.coordination_tier ?? "support",
      parent_agent_id: agent.parent_agent_id ?? "",
      managed_agent_ids: agent.managed_agent_ids ?? [],
      accent_color: agent.accent_color ?? "",
      enabled: agent.enabled !== false,
    })),
    source: "office.snapshot",
  }, () =>
    buildRosterPayload(workboard, agentSessions, learning, autopilot)
  );
  const tmuxState = safe("tmux", null, () => storage.getTriChatTmuxControllerState());
  const tmux = {
    generated_at: new Date().toISOString(),
    action: "status_cached",
    session_active: Boolean(tmuxState?.enabled),
    state: tmuxState ?? { enabled: false, tasks: [] },
    dashboard: summarizeTmuxDashboard(tmuxState),
  };
  const adapter = input.include_adapter
    ? safe<AdapterPayload>("adapter", {
        generated_at: new Date().toISOString(),
        agent_id: null,
        channel: null,
        state_count: 0,
        states: [],
        summary: {
          total_channels: 0,
          open_channels: 0,
          total_trips: 0,
          total_successes: 0,
          total_turns: 0,
          total_degraded_turns: 0,
          newest_state_at: null,
          newest_event_at: null,
          newest_trip_opened_at: null,
          per_agent: [],
        } satisfies TriChatAdapterTelemetrySummaryRecord,
        recent_events: [],
        last_open_events: [],
      }, () =>
        trichatAdapterTelemetry(storage, { action: "status", include_events: true, event_limit: Math.min(12, input.event_limit) })
      )
    : {};
  const busTail = input.include_bus
    ? safe("bus_tail", { count: 0, thread_id: threadId, events: [] as unknown[] }, () => {
        const events = storage.listTriChatBusEvents({ thread_id: threadId, limit: input.event_limit });
        return {
          count: events.length,
          thread_id: threadId,
          events,
        };
      })
    : {};
  const trichatSummaryPayload = safe<TriChatSummaryPayload>("trichat_summary", {
    generated_at: new Date().toISOString(),
    thread_counts: {
      active: 0,
      archived: 0,
      total: 0,
    },
    message_count: 0,
    oldest_message_at: null,
    newest_message_at: null,
    busiest_threads: [],
  }, () =>
    trichatSummary(storage, { busiest_limit: 6 })
  );
  const runtimeWorkers = input.include_runtime_workers
    ? safe<RuntimeWorkersPayload>("runtime_workers", {
        count: 0,
        sessions: [] as RuntimeWorkerSessionRecord[],
        summary: {
          session_count: 0,
          active_count: 0,
          counts: {},
          latest_session: null,
        },
      } as RuntimeWorkersPayload, () =>
        summarizeRuntimeWorkers(storage, input.runtime_worker_limit)
      )
    : {};
  const operatorBriefPayload = safe<OperatorBriefPayload>(
    "operator_brief",
    {
      generated_at: new Date().toISOString(),
      thread_id: threadId,
      current_objective: null,
      goal: null,
      plan: null,
      step: null,
      task: null,
      ring_leader_session: null,
      runtime_worker_session: null,
      delegation_brief: {
        delegate_agent_id: null,
        task_objective: null,
        success_criteria: [],
        evidence_requirements: [],
        rollback_notes: [],
      },
      compile_brief_artifact: null,
      runtime_brief_markdown: null,
      execution_backlog: [],
      kernel: null,
      brief_markdown: "# Operator Brief\n\nNo active operator brief available.",
      source: "operator.brief",
    } as unknown as OperatorBriefPayload,
    () =>
      operatorBrief(storage, {
        thread_id: threadId,
        include_kernel: false,
        include_runtime_brief: false,
        include_compile_brief: true,
        compact: true,
      })
  );
  const autonomyMaintain = safe("autonomy_maintain", summarizeAutonomyMaintainState(storage), () =>
    summarizeAutonomyMaintainState(storage)
  );
  const autonomyMaintainState = asRecord(autonomyMaintain.state);
  const persistedProviderBridgeGeneratedAt =
    String(autonomyMaintainState.last_provider_bridge_check_at ?? autonomyMaintainState.updated_at ?? "").trim() ||
    new Date().toISOString();
  const persistedProviderBridgeDiagnostics = Array.isArray(autonomyMaintainState.provider_bridge_diagnostics)
    ? autonomyMaintainState.provider_bridge_diagnostics
    : [];
  const persistedProviderBridgeStale = providerBridgeDiagnosticsStale(autonomyMaintainState);
  const selectedProviderBridgeDiagnostics = {
    generated_at: persistedProviderBridgeGeneratedAt,
    cached: persistedProviderBridgeDiagnostics.length > 0,
    stale: persistedProviderBridgeStale,
    diagnostics: persistedProviderBridgeDiagnostics,
  };
  const providerBridge = safe<ProviderBridgePayload>(
    "provider_bridge",
    {
      snapshot: resolveProviderBridgeSnapshot({ workspace_root: process.cwd() }),
      diagnostics: selectedProviderBridgeDiagnostics,
    },
    () => ({
      snapshot: resolveProviderBridgeSnapshot({ workspace_root: process.cwd() }),
      diagnostics: selectedProviderBridgeDiagnostics,
    })
  );
  const providerBridgeOnboarding = buildProviderBridgeOnboardingSummary({
    clients: providerBridge.snapshot.clients,
    diagnostics: providerBridge.diagnostics.diagnostics,
    server_name: providerBridge.snapshot.server_name,
    generated_at: providerBridge.diagnostics.generated_at,
    diagnostics_stale: providerBridge.diagnostics.stale ?? false,
  });
  const kernel = input.include_kernel
    ? safe("kernel", buildKernelPayload(storage, taskSummaryPayload, agentSessions), () =>
        buildKernelPayload(storage, taskSummaryPayload, agentSessions)
      )
    : {};
  const providerReadyAgentIds =
    selectedProviderBridgeDiagnostics.stale === true
      ? []
      : providerBridge.diagnostics.diagnostics
          .filter((entry) => entry.status === "connected" || entry.status === "configured")
          .map((entry) => String(entry.office_agent_id || "").trim().toLowerCase())
          .filter(Boolean);
  if (providerReadyAgentIds.length) {
    const rosterPayload = roster as Record<string, unknown>;
    const activeAgentIds = Array.isArray(rosterPayload.active_agent_ids) ? (rosterPayload.active_agent_ids as unknown[]) : [];
    rosterPayload.active_agent_ids = dedupeAgentIds([...activeAgentIds, ...providerReadyAgentIds]);
  }

  const desktopControlState = storage.getDesktopControlState();
  const desktopControl = {
    state: desktopControlState,
    summary: summarizeDesktopControlState(desktopControlState),
  };
  const patientZeroState = storage.getPatientZeroState();
  const privilegedAccess = buildPrivilegedAccessStatus(storage);
  const patientZero = {
    state: patientZeroState,
    summary: summarizePatientZeroState(patientZeroState, desktopControlState, privilegedAccess.summary as Record<string, unknown>),
    report: buildPatientZeroReport(storage),
  };
  const setupDiagnostics = buildOfficeSetupDiagnostics({
    kernel: asRecord(kernel),
    providerBridge: {
      ...providerBridge,
      onboarding: providerBridgeOnboarding,
    },
    desktopControl,
    patientZero,
  });

  return {
    generated_at: new Date().toISOString(),
    thread_id: threadId,
    errors,
    roster,
    workboard,
    tmux,
    task_summary: taskSummaryPayload,
    task_running: taskRunning,
    task_pending: taskPending,
    agent_sessions: agentSessions,
    adapter,
    bus_tail: busTail,
    trichat_summary: trichatSummaryPayload,
    kernel,
    learning,
    autopilot,
    autonomy_maintain: autonomyMaintain,
    runtime_workers: runtimeWorkers,
    operator_brief: operatorBriefPayload,
    provider_bridge: {
      ...providerBridge,
      onboarding: providerBridgeOnboarding,
    },
    desktop_control: desktopControl,
    patient_zero: patientZero,
    privileged_access: privilegedAccess,
    setup_diagnostics: setupDiagnostics,
    source: "office.snapshot",
  };
}

export function officeSnapshot(storage: Storage, input: z.infer<typeof officeSnapshotSchema>) {
  const threadId = input.thread_id?.trim() || OFFICE_SNAPSHOT_DEFAULT_THREAD_ID;
  const warmCacheState = storage.getWarmCacheState();
  if (isDefaultOfficeSnapshotRequest(input)) {
    const cached = readWarmCacheEntry(officeSnapshotWarmCacheKey(threadId), warmCacheState.ttl_seconds * 1000);
    if (cached && cached.payload && typeof cached.payload === "object" && !Array.isArray(cached.payload)) {
      const liveDesktopControlState = storage.getDesktopControlState();
      const liveDesktopControl = {
        state: liveDesktopControlState,
        summary: summarizeDesktopControlState(liveDesktopControlState),
      };
      const livePatientZeroState = storage.getPatientZeroState();
      const livePrivilegedAccess = buildPrivilegedAccessStatus(storage);
      const livePatientZero = {
        state: livePatientZeroState,
        summary: summarizePatientZeroState(
          livePatientZeroState,
          liveDesktopControlState,
          livePrivilegedAccess.summary as Record<string, unknown>
        ),
        report: buildPatientZeroReport(storage),
      };
      const cachedPayload = cached.payload as Record<string, unknown>;
      const cachedKernel = asRecord(cachedPayload.kernel);
      const cachedProviderBridge = asRecord(cachedPayload.provider_bridge);
      const cachedProviderBridgeSnapshot = asRecord(cachedProviderBridge.snapshot);
      const cachedProviderBridgeDiagnostics = asRecord(cachedProviderBridge.diagnostics);
      const cachedProviderBridgePayload = {
        snapshot: {
          ...cachedProviderBridgeSnapshot,
          clients: Array.isArray(cachedProviderBridgeSnapshot.clients) ? cachedProviderBridgeSnapshot.clients : [],
          server_name: String(cachedProviderBridgeSnapshot.server_name ?? "mcplayground"),
        },
        diagnostics: {
          ...cachedProviderBridgeDiagnostics,
          generated_at: String(cachedProviderBridgeDiagnostics.generated_at ?? new Date().toISOString()),
          cached: cachedProviderBridgeDiagnostics.cached === true,
          stale: cachedProviderBridgeDiagnostics.stale === true,
          diagnostics: Array.isArray(cachedProviderBridgeDiagnostics.diagnostics)
            ? cachedProviderBridgeDiagnostics.diagnostics
            : [],
        },
        onboarding:
          cachedProviderBridge.onboarding && typeof cachedProviderBridge.onboarding === "object"
            ? (cachedProviderBridge.onboarding as ReturnType<typeof buildProviderBridgeOnboardingSummary>)
            : buildProviderBridgeOnboardingSummary({
                clients: Array.isArray(cachedProviderBridgeSnapshot.clients) ? cachedProviderBridgeSnapshot.clients : [],
                diagnostics: Array.isArray(cachedProviderBridgeDiagnostics.diagnostics)
                  ? cachedProviderBridgeDiagnostics.diagnostics
                  : [],
                server_name: String(cachedProviderBridgeSnapshot.server_name ?? "mcplayground"),
                generated_at: String(cachedProviderBridgeDiagnostics.generated_at ?? new Date().toISOString()),
                diagnostics_stale: cachedProviderBridgeDiagnostics.stale === true,
              }),
      };
      const liveSetupDiagnostics = buildOfficeSetupDiagnostics({
        kernel: cachedKernel,
        providerBridge: cachedProviderBridgePayload,
        desktopControl: liveDesktopControl,
        patientZero: livePatientZero,
      });
      return {
        ...cachedPayload,
        kernel: {
          ...cachedKernel,
          desktop_control: liveDesktopControl,
          patient_zero: livePatientZero,
          privileged_access: livePrivilegedAccess,
        },
        provider_bridge: cachedProviderBridgePayload,
        desktop_control: liveDesktopControl,
        patient_zero: livePatientZero,
        privileged_access: livePrivilegedAccess,
        setup_diagnostics: liveSetupDiagnostics,
        cache: {
          hit: true,
          key: cached.key,
          warmed_at: cached.warmed_at,
          duration_ms: cached.duration_ms,
        },
      };
    }
  }

  return {
    ...computeOfficeSnapshot(storage, input),
    cache: {
      hit: false,
      key: null,
      warmed_at: null,
      duration_ms: null,
    },
  };
}
