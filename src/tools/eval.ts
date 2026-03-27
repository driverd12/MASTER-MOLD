import crypto from "node:crypto";
import { z } from "zod";
import {
  Storage,
  type EvalSuiteCaseRecord,
  type EvalSuiteRecord,
  type ModelRouterTaskKind,
} from "../storage.js";
import { mutationSchema, runIdempotentMutation } from "./mutation.js";
import { benchmarkRun } from "./benchmark.js";
import { routeModelBackends } from "./model_router.js";

const recordSchema = z.record(z.unknown());

const sourceSchema = z.object({
  source_client: z.string().optional(),
  source_model: z.string().optional(),
  source_agent: z.string().optional(),
});

const evalCaseSchema = z.object({
  case_id: z.string().min(1).optional(),
  title: z.string().min(1),
  kind: z.enum(["benchmark_suite", "router_case"]),
  benchmark_suite_id: z.string().min(1).optional(),
  task_kind: z.enum(["planning", "coding", "research", "verification", "chat", "tool_use"]).optional(),
  context_tokens: z.number().int().min(0).max(10000000).optional(),
  latency_budget_ms: z.number().min(0).max(10000000).optional(),
  expected_backend_id: z.string().min(1).optional(),
  expected_backend_tags: z.array(z.string().min(1)).optional(),
  required_tags: z.array(z.string().min(1)).optional(),
  preferred_tags: z.array(z.string().min(1)).optional(),
  required: z.boolean().optional(),
  weight: z.number().min(0).max(1000).optional(),
  metadata: recordSchema.optional(),
});

export const evalSuiteUpsertSchema = z.object({
  mutation: mutationSchema,
  suite_id: z.string().min(1).max(200).optional(),
  title: z.string().min(1),
  objective: z.string().min(1),
  aggregate_metric_name: z.string().min(1).default("suite_success_rate"),
  aggregate_metric_direction: z.enum(["minimize", "maximize"]).default("maximize"),
  cases: z.array(evalCaseSchema).min(1).max(100),
  tags: z.array(z.string().min(1)).optional(),
  metadata: recordSchema.optional(),
  ...sourceSchema.shape,
});

export const evalSuiteListSchema = z.object({});

export const evalRunSchema = z.object({
  mutation: mutationSchema,
  suite_id: z.string().min(1),
  candidate_label: z.string().min(1).default("baseline"),
  experiment_id: z.string().min(1).optional(),
  host_id: z.string().min(1).optional(),
  ...sourceSchema.shape,
});

function loadEvalSuites(storage: Storage) {
  return (
    storage.getEvalSuitesState() ?? {
      enabled: true,
      suites: [] as EvalSuiteRecord[],
      updated_at: new Date().toISOString(),
    }
  );
}

function normalizeTaskKind(value: unknown): ModelRouterTaskKind | null {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "planning" ||
    raw === "coding" ||
    raw === "research" ||
    raw === "verification" ||
    raw === "chat" ||
    raw === "tool_use"
    ? raw
    : null;
}

function computeEvalScore(caseResults: Array<{ ok: boolean; weight: number }>) {
  const totalWeight = caseResults.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) {
    return 0;
  }
  const weighted = caseResults.reduce((sum, entry) => sum + (entry.ok ? entry.weight : 0), 0);
  return Number(((weighted / totalWeight) * 100).toFixed(4));
}

export async function evalSuiteUpsert(storage: Storage, input: z.infer<typeof evalSuiteUpsertSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "eval.suite_upsert",
    mutation: input.mutation,
    payload: input,
    execute: () => {
      const state = loadEvalSuites(storage);
      const suiteId = input.suite_id?.trim() || `eval-suite-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const suite: EvalSuiteRecord = {
        suite_id: suiteId,
        created_at: state.suites.find((entry) => entry.suite_id === suiteId)?.created_at ?? now,
        updated_at: now,
        title: input.title.trim(),
        objective: input.objective.trim(),
        aggregate_metric_name: input.aggregate_metric_name.trim(),
        aggregate_metric_direction: input.aggregate_metric_direction === "minimize" ? "minimize" : "maximize",
        cases: input.cases.map((entry, index) => ({
          case_id: entry.case_id?.trim() || `case-${index + 1}`,
          title: entry.title.trim(),
          kind: entry.kind,
          benchmark_suite_id: entry.benchmark_suite_id?.trim() || null,
          task_kind: normalizeTaskKind(entry.task_kind),
          context_tokens: typeof entry.context_tokens === "number" ? entry.context_tokens : null,
          latency_budget_ms: typeof entry.latency_budget_ms === "number" ? entry.latency_budget_ms : null,
          expected_backend_id: entry.expected_backend_id?.trim() || null,
          expected_backend_tags: [...new Set((entry.expected_backend_tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
          required_tags: [...new Set((entry.required_tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
          preferred_tags: [...new Set((entry.preferred_tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
          required: entry.required !== false,
          weight: typeof entry.weight === "number" ? entry.weight : 1,
          metadata: entry.metadata ?? {},
        })),
        tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
        metadata: input.metadata ?? {},
      };
      const nextSuites = state.suites.filter((entry) => entry.suite_id !== suiteId).concat([suite]);
      return {
        state: storage.setEvalSuitesState({
          enabled: state.enabled,
          suites: nextSuites,
        }),
        suite,
      };
    },
  });
}

export function evalSuiteList(storage: Storage, _input: z.infer<typeof evalSuiteListSchema>) {
  const state = loadEvalSuites(storage);
  return {
    state,
    count: state.suites.length,
    suites: state.suites,
  };
}

async function runRouterCase(storage: Storage, suiteId: string, caseEntry: EvalSuiteCaseRecord) {
  const route = routeModelBackends(storage, {
    task_kind: caseEntry.task_kind ?? undefined,
    context_tokens: caseEntry.context_tokens ?? undefined,
    latency_budget_ms: caseEntry.latency_budget_ms ?? undefined,
    required_tags: caseEntry.required_tags,
    preferred_tags: caseEntry.preferred_tags,
  });
  const selected = route.selected_backend;
  const selectedTags = new Set((selected?.tags ?? []).map((entry) => entry.toLowerCase()));
  const backendIdOk = caseEntry.expected_backend_id ? selected?.backend_id === caseEntry.expected_backend_id : true;
  const tagOk =
    caseEntry.expected_backend_tags.length === 0
      ? true
      : caseEntry.expected_backend_tags.every((tag) => selectedTags.has(tag.toLowerCase()));
  const ok = Boolean(selected) && backendIdOk && tagOk;
  return {
    kind: "router_case" as const,
    case_id: caseEntry.case_id,
    title: caseEntry.title,
    ok,
    weight: caseEntry.weight,
    selected_backend: selected,
    ranked_backends: route.ranked_backends.slice(0, 5),
  };
}

export async function evalRun(storage: Storage, input: z.infer<typeof evalRunSchema>) {
  return runIdempotentMutation({
    storage,
    tool_name: "eval.run",
    mutation: input.mutation,
    payload: input,
    execute: async () => {
      const state = loadEvalSuites(storage);
      const suite = state.suites.find((entry) => entry.suite_id === input.suite_id);
      if (!suite) {
        throw new Error(`Eval suite not found: ${input.suite_id}`);
      }

      const experimentRecord =
        (input.experiment_id ? storage.getExperimentById(input.experiment_id) : null) ??
        storage.createExperiment({
          experiment_id: input.experiment_id,
          title: `${suite.title} eval`,
          objective: suite.objective,
          status: "active",
          metric_name: suite.aggregate_metric_name,
          metric_direction: suite.aggregate_metric_direction,
          tags: [...suite.tags, "eval"],
          metadata: {
            suite_id: suite.suite_id,
            source: "eval.run",
          },
          source_client: input.source_client,
          source_model: input.source_model,
          source_agent: input.source_agent,
        }).experiment;

      const runId = `eval-run-${crypto.randomUUID()}`;
      const experimentRun = storage.createExperimentRun({
        experiment_id: experimentRecord.experiment_id,
        candidate_label: input.candidate_label,
        run_id: runId,
        status: "running",
        metadata: {
          suite_id: suite.suite_id,
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      }).experiment_run;

      storage.appendRunEvent({
        run_id: runId,
        event_type: "begin",
        step_index: 0,
        status: "in_progress",
        summary: `Eval suite ${suite.suite_id} started.`,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
        details: { suite_id: suite.suite_id },
      });

      const caseResults = [];
      for (const [index, caseEntry] of suite.cases.entries()) {
        if (caseEntry.kind === "benchmark_suite") {
          if (!caseEntry.benchmark_suite_id) {
            caseResults.push({
              kind: "benchmark_suite",
              case_id: caseEntry.case_id,
              title: caseEntry.title,
              ok: false,
              weight: caseEntry.weight,
              error: "benchmark_suite_id is required",
            });
            continue;
          }
          const result = await benchmarkRun(storage, {
            mutation: {
              idempotency_key: `${input.mutation.idempotency_key}:benchmark:${index}`,
              side_effect_fingerprint: `${input.mutation.side_effect_fingerprint}:benchmark:${caseEntry.benchmark_suite_id}:${index}`,
            },
            suite_id: caseEntry.benchmark_suite_id,
            candidate_label: `${input.candidate_label}:${caseEntry.case_id}`,
            experiment_id: experimentRecord.experiment_id,
            host_id: input.host_id,
            source_client: input.source_client,
            source_model: input.source_model,
            source_agent: input.source_agent,
          });
          caseResults.push({
            kind: "benchmark_suite",
            case_id: caseEntry.case_id,
            title: caseEntry.title,
            ok: Boolean(result.ok),
            weight: caseEntry.weight,
            benchmark_run_id: result.run_id,
            aggregate_metric_value: result.aggregate_metric_value,
          });
          continue;
        }

        caseResults.push(await runRouterCase(storage, suite.suite_id, caseEntry));
      }

      const aggregateMetricValue = computeEvalScore(caseResults.map((entry) => ({ ok: entry.ok, weight: entry.weight })));
      const ok = caseResults.every((entry) => entry.ok || suite.cases.find((candidate) => candidate.case_id === entry.case_id)?.required === false);

      const artifact = storage.recordArtifact({
        artifact_type: "eval.result",
        status: "active",
        run_id: runId,
        producer_kind: "tool",
        producer_id: "eval.run",
        content_json: {
          suite_id: suite.suite_id,
          aggregate_metric_value: aggregateMetricValue,
          case_results: caseResults,
        },
        trust_tier: "derived",
        metadata: {
          suite_title: suite.title,
        },
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
      }).artifact;

      storage.appendRunEvent({
        run_id: runId,
        event_type: "end",
        step_index: suite.cases.length + 1,
        status: ok ? "completed" : "failed",
        summary: ok ? `Eval suite ${suite.suite_id} completed.` : `Eval suite ${suite.suite_id} failed.`,
        source_client: input.source_client,
        source_model: input.source_model,
        source_agent: input.source_agent,
        details: {
          suite_id: suite.suite_id,
          aggregate_metric_value: aggregateMetricValue,
          artifact_id: artifact.artifact_id,
        },
      });

      const updatedRun = storage.updateExperimentRun({
        experiment_run_id: experimentRun.experiment_run_id,
        status: ok ? "completed" : "discarded",
        summary: ok ? `Eval suite ${suite.title} completed.` : `Eval suite ${suite.title} did not meet expectations.`,
        observed_metric: aggregateMetricValue,
        metadata: {
          suite_id: suite.suite_id,
          case_results: caseResults,
        },
      }).experiment_run;

      return {
        ok,
        suite,
        run_id: runId,
        experiment: experimentRecord,
        experiment_run: updatedRun,
        aggregate_metric_value: aggregateMetricValue,
        case_results: caseResults,
        artifact,
      };
    },
  });
}
