import { z } from "zod";
import { Storage } from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";

const goalStatusSchema = z.enum([
  "draft",
  "active",
  "blocked",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "archived",
]);

const goalRiskTierSchema = z.enum(["low", "medium", "high", "critical"]);

const autonomyModeSchema = z.enum([
  "observe",
  "recommend",
  "stage",
  "execute_bounded",
  "execute_destructive_with_approval",
]);

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

export const goalCreateSchema = z
  .object({
    mutation: mutationSchema,
    goal_id: z.string().min(1).max(200).optional(),
    title: z.string().min(1),
    objective: z.string().min(1),
    status: goalStatusSchema.default("draft"),
    priority: z.number().int().min(0).max(100).optional(),
    risk_tier: goalRiskTierSchema.default("medium"),
    autonomy_mode: autonomyModeSchema.default("recommend"),
    target_entity_type: z.string().min(1).optional(),
    target_entity_id: z.string().min(1).optional(),
    acceptance_criteria: z.array(z.string().min(1)).min(1),
    constraints: z.array(z.string().min(1)).optional(),
    assumptions: z.array(z.string().min(1)).optional(),
    budget: z.record(z.unknown()).optional(),
    owner: z.record(z.unknown()).optional(),
    tags: z.array(z.string().min(1)).optional(),
    metadata: z.record(z.unknown()).optional(),
    ...sourceSchema.shape,
  })
  .superRefine((value, ctx) => {
    if ((value.target_entity_type && !value.target_entity_id) || (!value.target_entity_type && value.target_entity_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "target_entity_type and target_entity_id must be provided together",
        path: ["target_entity_type"],
      });
    }
  });

export const goalGetSchema = z.object({
  goal_id: z.string().min(1),
});

export const goalListSchema = z
  .object({
    status: goalStatusSchema.optional(),
    target_entity_type: z.string().min(1).optional(),
    target_entity_id: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.target_entity_type && value.target_entity_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "target_entity_type is required when target_entity_id is provided",
        path: ["target_entity_type"],
      });
    }
  });

export async function goalCreate(storage: Storage, input: z.infer<typeof goalCreateSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "goal.create",
    mutation: input.mutation,
    payload: input,
    execute: () =>
      storage.createGoal({
        goal_id: input.goal_id,
        title: input.title,
        objective: input.objective,
        status: input.status,
        priority: input.priority,
        risk_tier: input.risk_tier,
        autonomy_mode: input.autonomy_mode,
        target_entity_type: input.target_entity_type,
        target_entity_id: input.target_entity_id,
        acceptance_criteria: input.acceptance_criteria,
        constraints: input.constraints,
        assumptions: input.assumptions,
        budget: input.budget,
        owner: input.owner,
        tags: input.tags,
        metadata: input.metadata,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      }),
  });
}

export function goalGet(storage: Storage, input: z.infer<typeof goalGetSchema>) {
  const goal = storage.getGoalById(input.goal_id);
  if (!goal) {
    return {
      found: false,
      goal_id: input.goal_id,
    };
  }
  return {
    found: true,
    goal,
  };
}

export function goalList(storage: Storage, input: z.infer<typeof goalListSchema>) {
  const goals = storage.listGoals({
    status: input.status,
    target_entity_type: input.target_entity_type,
    target_entity_id: input.target_entity_id,
    limit: input.limit ?? 100,
  });
  return {
    status_filter: input.status ?? null,
    target_entity_type_filter: input.target_entity_type ?? null,
    target_entity_id_filter: input.target_entity_id ?? null,
    count: goals.length,
    goals,
  };
}
