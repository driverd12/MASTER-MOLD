import { z } from "zod";
import { Storage } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { squishTranscript } from "./transcript.js";

export const CONTEXT_BUDGET_THRESHOLDS = {
  target_percent: 40,
  checkpoint_percent: 40,
  offload_percent: 50,
  handoff_percent: 60,
  hard_stop_percent: 80,
};

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const contextBudgetMeasurementObject = z.object({
  context_tokens: z.number().int().min(0).max(10_000_000).optional(),
  max_context_tokens: z.number().int().min(1).max(10_000_000).optional(),
  used_percent: z.number().min(0).max(1_000).optional(),
  used_ratio: z.number().min(0).max(10).optional(),
  objective: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
  goal_id: z.string().min(1).optional(),
  plan_id: z.string().min(1).optional(),
  ...sourceSchema.shape,
});

function validateMeasurement(value: z.infer<typeof contextBudgetMeasurementObject>, ctx: z.RefinementCtx) {
  const hasTokenPair = value.context_tokens !== undefined && value.max_context_tokens !== undefined;
  if (!hasTokenPair && value.used_percent === undefined && value.used_ratio === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "provide context_tokens + max_context_tokens, used_percent, or used_ratio",
      path: ["context_tokens"],
    });
  }
  if (value.context_tokens !== undefined && value.max_context_tokens === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "max_context_tokens is required when context_tokens is provided",
      path: ["max_context_tokens"],
    });
  }
}

const contextBudgetMeasurementSchema = contextBudgetMeasurementObject.superRefine(validateMeasurement);

export const contextBudgetStatusSchema = contextBudgetMeasurementSchema;

export const contextBudgetCheckpointSchema = contextBudgetMeasurementObject.extend({
  mutation: mutationSchema,
  current_status: z.string().min(1),
  next_action: z.string().min(1),
  evidence: z.array(z.string().min(1)).max(20).optional(),
  open_questions: z.array(z.string().min(1)).max(20).optional(),
  blockers: z.array(z.string().min(1)).max(20).optional(),
  rollback_notes: z.array(z.string().min(1)).max(20).optional(),
  files_touched: z.array(z.string().min(1)).max(50).optional(),
  artifact_ids: z.array(z.string().min(1)).max(50).optional(),
  auto_squish: z.boolean().optional(),
}).superRefine(validateMeasurement);

type ContextBudgetMeasurement = z.infer<typeof contextBudgetMeasurementSchema>;
type ContextBudgetCheckpointInput = z.infer<typeof contextBudgetCheckpointSchema>;

export type ContextBudgetBand = "target" | "checkpoint" | "offload" | "handoff" | "hard_stop";

export function defaultContextBudgetContract() {
  return {
    policy_version: "context-budget-v1",
    status_tool: "context_budget.status",
    checkpoint_tool: "context_budget.checkpoint",
    thresholds: { ...CONTEXT_BUDGET_THRESHOLDS },
    bands: {
      target: "Keep routine work under 40% of the effective context window.",
      checkpoint: "At 40-50%, write a durable note before loading more raw context.",
      offload: "At 50-60%, stop expanding the prompt and capture memory plus transcript squish state.",
      handoff: "At 60-70%, start a fresh worker/session from the checkpoint brief.",
      hard_stop: "At 80%+, stop unless the operator approves a source-corpus exception.",
    },
    required_checkpoint_fields: [
      "objective",
      "current_status",
      "next_action",
      "evidence",
      "open_questions",
      "blockers",
      "rollback_notes",
      "time/provenance",
    ],
  };
}

export function contextBudgetStatus(input: z.infer<typeof contextBudgetStatusSchema>) {
  return {
    ok: true,
    context_budget_status: evaluateContextBudget(input),
  };
}

export async function contextBudgetCheckpoint(storage: Storage, input: ContextBudgetCheckpointInput) {
  return runIdempotentMutation({
    storage,
    tool_name: "context_budget.checkpoint",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const contextBudgetStatus = evaluateContextBudget(input);
      const transcriptSquish =
        input.run_id && input.auto_squish !== false && contextBudgetStatus.should_squish
          ? squishTranscript(storage, {
              run_id: input.run_id,
              limit: 500,
              max_points: 8,
            })
          : {
              run_id: input.run_id ?? null,
              created_memory: false,
              squished_count: 0,
              reason: input.run_id ? "squish-not-required-for-band" : "no-run-id",
            };
      const resumeBrief = buildResumeBrief(input, contextBudgetStatus, transcriptSquish);
      const memory = storage.insertMemory({
        content: resumeBrief,
        keywords: dedupeKeywords([
          "context-budget",
          "checkpoint",
          contextBudgetStatus.band,
          input.task_id,
          input.goal_id,
          input.run_id,
          input.source_client,
          input.source_agent,
        ]),
      });
      const event = storage.appendRuntimeEvent({
        event_type: "context_budget.checkpoint",
        entity_type: input.task_id ? "task" : input.goal_id ? "goal" : input.run_id ? "run" : "memory",
        entity_id: input.task_id ?? input.goal_id ?? input.run_id ?? String(memory.id),
        status: contextBudgetStatus.status,
        summary: `context budget checkpoint: ${contextBudgetStatus.band}`,
        content: resumeBrief,
        details: {
          context_budget_status: contextBudgetStatus,
          memory_id: memory.id,
          transcript_squish: transcriptSquish,
          artifact_ids: input.artifact_ids ?? [],
          files_touched: input.files_touched ?? [],
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      });
      return {
        ok: true,
        context_budget_status: contextBudgetStatus,
        created_memory: true,
        memory_id: memory.id,
        memory_created_at: memory.created_at,
        transcript_squish: transcriptSquish,
        resume_brief: resumeBrief,
        event,
      };
    },
  });
}

function evaluateContextBudget(input: ContextBudgetMeasurement) {
  const usedPercent = resolveUsedPercent(input);
  const band = bandForPercent(usedPercent);
  const shouldCheckpoint = usedPercent >= CONTEXT_BUDGET_THRESHOLDS.checkpoint_percent;
  const shouldSquish = usedPercent >= CONTEXT_BUDGET_THRESHOLDS.offload_percent;
  const shouldHandoff = usedPercent >= CONTEXT_BUDGET_THRESHOLDS.handoff_percent;
  const hardStop = usedPercent >= CONTEXT_BUDGET_THRESHOLDS.hard_stop_percent;
  const blockExpansion = shouldSquish;
  return {
    policy_version: "context-budget-v1",
    measured_at: new Date().toISOString(),
    band,
    status: statusForBand(band),
    used_percent: roundPercent(usedPercent),
    used_ratio: Number((usedPercent / 100).toFixed(4)),
    context_tokens: input.context_tokens ?? null,
    max_context_tokens: input.max_context_tokens ?? null,
    objective: input.objective ?? null,
    run_id: input.run_id ?? null,
    task_id: input.task_id ?? null,
    goal_id: input.goal_id ?? null,
    plan_id: input.plan_id ?? null,
    thresholds: { ...CONTEXT_BUDGET_THRESHOLDS },
    should_warn: shouldCheckpoint,
    should_checkpoint: shouldCheckpoint,
    should_memory_capture: shouldCheckpoint,
    should_squish: shouldSquish,
    should_handoff: shouldHandoff,
    block_expansion: blockExpansion,
    operator_approval_required: hardStop,
    next_actions: nextActionsForBand(band),
    source_client: input.source_client ?? null,
    source_model: input.source_model ?? null,
    source_agent: input.source_agent ?? null,
  };
}

function resolveUsedPercent(input: ContextBudgetMeasurement) {
  if (typeof input.used_percent === "number" && Number.isFinite(input.used_percent)) {
    return Math.max(0, input.used_percent);
  }
  if (typeof input.used_ratio === "number" && Number.isFinite(input.used_ratio)) {
    return Math.max(0, input.used_ratio <= 1 ? input.used_ratio * 100 : input.used_ratio);
  }
  if (
    typeof input.context_tokens === "number" &&
    Number.isFinite(input.context_tokens) &&
    typeof input.max_context_tokens === "number" &&
    Number.isFinite(input.max_context_tokens) &&
    input.max_context_tokens > 0
  ) {
    return Math.max(0, (input.context_tokens / input.max_context_tokens) * 100);
  }
  return 0;
}

function bandForPercent(usedPercent: number): ContextBudgetBand {
  if (usedPercent >= CONTEXT_BUDGET_THRESHOLDS.hard_stop_percent) {
    return "hard_stop";
  }
  if (usedPercent >= CONTEXT_BUDGET_THRESHOLDS.handoff_percent) {
    return "handoff";
  }
  if (usedPercent >= CONTEXT_BUDGET_THRESHOLDS.offload_percent) {
    return "offload";
  }
  if (usedPercent >= CONTEXT_BUDGET_THRESHOLDS.checkpoint_percent) {
    return "checkpoint";
  }
  return "target";
}

function statusForBand(band: ContextBudgetBand) {
  switch (band) {
    case "target":
      return "ok";
    case "checkpoint":
      return "checkpoint_recommended";
    case "offload":
      return "offload_required";
    case "handoff":
      return "handoff_required";
    case "hard_stop":
      return "hard_stop";
  }
}

function nextActionsForBand(band: ContextBudgetBand) {
  switch (band) {
    case "target":
      return [
        "Continue with compact retrieval and focused file slices.",
        "Recheck context_budget.status before loading large files, logs, transcripts, or generated artifacts.",
      ];
    case "checkpoint":
      return [
        "Call context_budget.checkpoint before adding more raw context.",
        "Capture objective, current status, evidence, blockers, rollback notes, and next action.",
      ];
    case "offload":
      return [
        "Call context_budget.checkpoint before loading more raw context.",
        "Squish linked transcript lines and resume from durable memory/artifact notes.",
        "Block prompt expansion until the checkpoint memory exists.",
      ];
    case "handoff":
      return [
        "Call context_budget.checkpoint immediately and start a fresh worker/session from the resume brief.",
        "Do not continue expanding the current frame except to capture durable notes.",
      ];
    case "hard_stop":
      return [
        "Stop loading raw context until the operator approves a source-corpus exception.",
        "Call context_budget.checkpoint immediately, capture rollback and next-action notes, then compact or hand off.",
      ];
  }
}

function roundPercent(value: number) {
  return Number(value.toFixed(value % 1 === 0 ? 0 : 2));
}

function buildResumeBrief(
  input: ContextBudgetCheckpointInput,
  status: ReturnType<typeof evaluateContextBudget>,
  transcriptSquish: Record<string, unknown>
) {
  const lines = [
    "Context budget checkpoint",
    `Recorded: ${status.measured_at}`,
    `Band: ${status.band}`,
    `Status: ${status.status}`,
    `Used context: ${status.used_percent}%`,
    `Block expansion: ${status.block_expansion ? "yes" : "no"}`,
    `Objective: ${input.objective ?? "n/a"}`,
    `Current status: ${input.current_status}`,
    `Next action: ${input.next_action}`,
    `Run: ${input.run_id ?? "n/a"}`,
    `Task: ${input.task_id ?? "n/a"}`,
    `Goal: ${input.goal_id ?? "n/a"}`,
    `Plan: ${input.plan_id ?? "n/a"}`,
    `Source: client=${input.source_client ?? "n/a"} agent=${input.source_agent ?? "n/a"} model=${input.source_model ?? "n/a"}`,
    "",
    renderList("Evidence", input.evidence ?? []),
    "",
    renderList("Open questions", input.open_questions ?? []),
    "",
    renderList("Blockers", input.blockers ?? []),
    "",
    renderList("Rollback notes", input.rollback_notes ?? []),
    "",
    renderList("Files touched", input.files_touched ?? []),
    "",
    renderList("Artifacts", input.artifact_ids ?? []),
    "",
    "Transcript squish",
    `- created_memory: ${String(transcriptSquish.created_memory ?? false)}`,
    `- squished_count: ${String(transcriptSquish.squished_count ?? 0)}`,
    transcriptSquish.memory_id ? `- memory_id: ${String(transcriptSquish.memory_id)}` : `- reason: ${String(transcriptSquish.reason ?? "n/a")}`,
    "",
    "Resume instructions",
    "- Rebuild context from this memory first, then retrieve cited artifacts or task records only as needed.",
    "- Do not replay the full transcript unless the operator explicitly approves it.",
    "- Run context_budget.status before loading more large files or transcript slices.",
  ];
  return lines.join("\n");
}

function renderList(title: string, items: string[]) {
  const normalized = dedupeStrings(items);
  if (normalized.length === 0) {
    return `${title}\n- none`;
  }
  return [title, ...normalized.map((entry) => `- ${entry}`)].join("\n");
}

function dedupeStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function dedupeKeywords(values: Array<string | null | undefined>) {
  return dedupeStrings(values)
    .map((value) => value.toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .slice(0, 24);
}
