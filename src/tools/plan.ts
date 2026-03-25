import { z } from "zod";
import { Storage } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

const planStatusSchema = z.enum([
  "draft",
  "candidate",
  "selected",
  "in_progress",
  "completed",
  "invalidated",
  "archived",
]);

const planPlannerKindSchema = z.enum(["core", "pack", "human", "trichat"]);

const planStepStatusSchema = z.enum([
  "pending",
  "ready",
  "running",
  "blocked",
  "completed",
  "failed",
  "skipped",
  "invalidated",
]);

const planStepKindSchema = z.enum(["analysis", "mutation", "verification", "decision", "handoff"]);
const planExecutorKindSchema = z.enum(["tool", "task", "worker", "human", "trichat"]);

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const planStepCreateSchema = z.object({
  step_id: z.string().min(1).max(200).optional(),
  seq: z.number().int().min(1),
  title: z.string().min(1),
  step_kind: planStepKindSchema.default("analysis"),
  status: planStepStatusSchema.default("pending"),
  executor_kind: planExecutorKindSchema.optional(),
  executor_ref: z.string().min(1).optional(),
  tool_name: z.string().min(1).optional(),
  input: z.record(z.unknown()).optional(),
  expected_artifact_types: z.array(z.string().min(1)).optional(),
  acceptance_checks: z.array(z.string().min(1)).optional(),
  retry_policy: z.record(z.unknown()).optional(),
  timeout_seconds: z.number().int().min(1).max(86_400).optional(),
  metadata: z.record(z.unknown()).optional(),
  depends_on: z.array(z.string().min(1)).optional(),
});

export const planCreateSchema = z
  .object({
    mutation: mutationSchema,
    plan_id: z.string().min(1).max(200).optional(),
    goal_id: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().min(1),
    status: planStatusSchema.default("candidate"),
    planner_kind: planPlannerKindSchema.default("core"),
    planner_id: z.string().min(1).optional(),
    selected: z.boolean().optional(),
    confidence: z.number().min(0).max(1).optional(),
    assumptions: z.array(z.string().min(1)).optional(),
    success_criteria: z.array(z.string().min(1)).optional(),
    rollback: z.array(z.string().min(1)).optional(),
    budget: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
    steps: z.array(planStepCreateSchema).min(1),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    const explicitStepIds = new Set<string>();
    for (const step of value.steps) {
      if (!step.step_id) {
        continue;
      }
      if (explicitStepIds.has(step.step_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate step_id: ${step.step_id}`,
          path: ["steps"],
        });
      }
      explicitStepIds.add(step.step_id);
    }
    for (const step of value.steps) {
      for (const dependencyId of step.depends_on ?? []) {
        if (!explicitStepIds.has(dependencyId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `depends_on references step_id not explicitly defined in this request: ${dependencyId}`,
            path: ["steps"],
          });
        }
      }
    }
  });

export const planGetSchema = z.object({
  plan_id: z.string().min(1),
});

export const planListSchema = z.object({
  goal_id: z.string().min(1).optional(),
  status: planStatusSchema.optional(),
  selected_only: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const planUpdateSchema = z
  .object({
    mutation: mutationSchema,
    plan_id: z.string().min(1),
    title: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
    status: planStatusSchema.optional(),
    selected: z.boolean().optional(),
    deselect_other_plans: z.boolean().optional(),
    planner_id: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1).nullable().optional(),
    assumptions: z.array(z.string().min(1)).optional(),
    success_criteria: z.array(z.string().min(1)).optional(),
    rollback: z.array(z.string().min(1)).optional(),
    budget: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    const hasPatchField =
      value.title !== undefined ||
      value.summary !== undefined ||
      value.status !== undefined ||
      value.selected !== undefined ||
      value.deselect_other_plans !== undefined ||
      value.planner_id !== undefined ||
      value.confidence !== undefined ||
      value.assumptions !== undefined ||
      value.success_criteria !== undefined ||
      value.rollback !== undefined ||
      value.budget !== undefined ||
      value.metadata !== undefined;
    if (!hasPatchField) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "at least one plan field must be provided",
        path: ["plan_id"],
      });
    }
  });

export async function planCreate(storage: Storage, input: z.infer<typeof planCreateSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "plan.create",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.createPlan({
        plan_id: input.plan_id,
        goal_id: input.goal_id,
        title: input.title,
        summary: input.summary,
        status: input.status,
        planner_kind: input.planner_kind,
        planner_id: input.planner_id,
        selected: input.selected,
        confidence: input.confidence,
        assumptions: input.assumptions,
        success_criteria: input.success_criteria,
        rollback: input.rollback,
        budget: input.budget,
        metadata: input.metadata,
        steps: input.steps,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      }),
  });
}

export function planGet(storage: Storage, input: z.infer<typeof planGetSchema>) {
  const plan = storage.getPlanById(input.plan_id);
  if (!plan) {
    return {
      found: false,
      plan_id: input.plan_id,
    };
  }
  const steps = storage.listPlanSteps(input.plan_id);
  return {
    found: true,
    plan,
    step_count: steps.length,
    steps,
  };
}

export function planList(storage: Storage, input: z.infer<typeof planListSchema>) {
  const plans = storage.listPlans({
    goal_id: input.goal_id,
    status: input.status,
    selected_only: input.selected_only,
    limit: input.limit ?? 100,
  });
  return {
    goal_id_filter: input.goal_id ?? null,
    status_filter: input.status ?? null,
    selected_only: input.selected_only ?? false,
    count: plans.length,
    plans,
  };
}

export async function planUpdate(storage: Storage, input: z.infer<typeof planUpdateSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "plan.update",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.updatePlan({
        plan_id: input.plan_id,
        title: input.title,
        summary: input.summary,
        status: input.status,
        selected: input.selected,
        deselect_other_plans: input.deselect_other_plans,
        planner_id: input.planner_id,
        confidence: input.confidence,
        assumptions: input.assumptions,
        success_criteria: input.success_criteria,
        rollback: input.rollback,
        budget: input.budget,
        metadata: input.metadata,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      }),
  });
}
