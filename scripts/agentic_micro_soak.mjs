#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

let mutationCounter = 0;

function nextMutation(label) {
  mutationCounter += 1;
  return {
    idempotency_key: `agentic-micro-soak-${label}-${mutationCounter}`,
    side_effect_fingerprint: `agentic-micro-soak-${label}-${mutationCounter}`,
  };
}

async function listTools(client) {
  const response = await client.listTools();
  return response.tools ?? [];
}

function extractText(response) {
  return (response.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  const text = extractText(response);
  if (response.isError) {
    throw new Error(`Tool ${name} failed: ${text}`);
  }
  return JSON.parse(text);
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-core-template-agentic-micro-soak-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ANAMNESIS_HUB_DB_PATH: dbPath,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "agentic-micro-soak", version: "0.1.0" }, { capabilities: {} });

  try {
    await client.connect(transport);

    const tools = new Set((await listTools(client)).map((tool) => tool.name));
    assert.equal(tools.has("goal.autorun_daemon"), true);
    assert.equal(tools.has("kernel.summary"), true);

    await callTool(client, "agent.session_open", {
      mutation: nextMutation("session.codex"),
      session_id: "micro-soak-codex",
      agent_id: "codex",
      client_kind: "codex",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      status: "active",
      capabilities: {
        coding: true,
        planning: true,
        worker: true,
      },
    });

    await callTool(client, "agent.session_open", {
      mutation: nextMutation("session.imprint"),
      session_id: "micro-soak-imprint",
      agent_id: "local-imprint",
      client_kind: "imprint",
      transport_kind: "stdio",
      workspace_root: REPO_ROOT,
      status: "active",
      capabilities: {
        worker: true,
        background: true,
      },
    });

    const optimizationGoal = await callTool(client, "goal.create", {
      mutation: nextMutation("goal.optimization"),
      title: "Micro-soak optimization goal",
      objective: "Reduce latency of the agent claim loop and benchmark the result",
      status: "active",
      autonomy_mode: "execute_bounded",
      acceptance_criteria: ["An optimization plan and experiment ledger are created automatically"],
      metadata: {
        preferred_metric_name: "latency_ms",
        preferred_metric_direction: "minimize",
        acceptance_delta: 5,
      },
    });
    const optimizationExecution = await callTool(client, "goal.execute", {
      mutation: nextMutation("goal.execute.optimization"),
      goal_id: optimizationGoal.goal.goal_id,
      max_passes: 4,
    });
    assert.equal(optimizationExecution.plan.metadata.planner_hook.hook_id, "agentic.optimization_loop");

    const experiments = await callTool(client, "experiment.list", {
      goal_id: optimizationGoal.goal.goal_id,
      limit: 10,
    });
    assert.equal(experiments.count, 1);

    const highComplexityTask = await callTool(client, "task.create", {
      mutation: nextMutation("task.high-complexity"),
      objective: "Implement and verify a bounded refactor across the local agentic kernel codebase with explicit regression checks",
      project_dir: REPO_ROOT,
      priority: 8,
      tags: ["agentic", "implementation"],
    });
    const imprintWorklist = await callTool(client, "agent.worklist", {
      session_id: "micro-soak-imprint",
      include_ineligible: true,
      limit: 10,
    });
    assert.ok(
      imprintWorklist.ineligible_tasks.some(
        (task) =>
          task.task_id === highComplexityTask.task.task_id &&
          task.blockers.some((blocker) => blocker.startsWith("insufficient_capability_tier"))
      )
    );

    const evidenceGoal = await callTool(client, "goal.create", {
      mutation: nextMutation("goal.evidence"),
      title: "Micro-soak evidence goal",
      objective: "Ensure missing verification evidence blocks plan advancement",
      status: "active",
      autonomy_mode: "execute_bounded",
      acceptance_criteria: ["The step remains blocked when the expected artifact is missing"],
    });
    const evidencePlan = await callTool(client, "plan.create", {
      mutation: nextMutation("plan.evidence"),
      goal_id: evidenceGoal.goal.goal_id,
      title: "Micro-soak evidence plan",
      summary: "Require a verification report artifact before marking the step complete",
      selected: true,
      steps: [
        {
          step_id: "verify-step",
          seq: 1,
          title: "Produce a verification report",
          step_kind: "verification",
          executor_kind: "worker",
          expected_artifact_types: ["verification_report"],
          input: {
            objective: "Run verification and attach the verification report artifact",
            project_dir: REPO_ROOT,
          },
        },
      ],
    });
    const dispatched = await callTool(client, "plan.dispatch", {
      mutation: nextMutation("plan.dispatch.evidence"),
      plan_id: evidencePlan.plan.plan_id,
    });
    const claimedEvidenceTask = await callTool(client, "agent.claim_next", {
      mutation: nextMutation("agent.claim.evidence"),
      session_id: "micro-soak-codex",
      task_id: dispatched.results[0].task_id,
      lease_seconds: 120,
    });
    assert.equal(claimedEvidenceTask.claimed, true);
    const reportedEvidence = await callTool(client, "agent.report_result", {
      mutation: nextMutation("agent.report.evidence"),
      session_id: "micro-soak-codex",
      task_id: claimedEvidenceTask.task.task_id,
      outcome: "completed",
      summary: "Completed verification but intentionally omitted the artifact to test blocking",
      result: { completed: true },
    });
    assert.equal(reportedEvidence.plan_step_update.step.status, "blocked");
    assert.deepEqual(reportedEvidence.evidence_gate.missing_artifact_types, ["verification_report"]);

    const deliveryGoal = await callTool(client, "goal.create", {
      mutation: nextMutation("goal.delivery"),
      title: "Micro-soak delivery goal",
      objective: "Generate the next bounded delivery slice without manual re-entry",
      status: "active",
      autonomy_mode: "execute_bounded",
      acceptance_criteria: ["A single daemon tick can execute eligible delivery work"],
      tags: ["agentic"],
    });
    const daemonRunOnce = await callTool(client, "goal.autorun_daemon", {
      action: "run_once",
      mutation: nextMutation("goal.autorun-daemon"),
      goal_id: deliveryGoal.goal.goal_id,
      max_passes: 4,
    });
    assert.equal(daemonRunOnce.tick.skipped, false);
    assert.equal(daemonRunOnce.tick.tick.executed_count, 1);

    const summary = await callTool(client, "kernel.summary", {
      goal_limit: 10,
      event_limit: 20,
      artifact_limit: 10,
      session_limit: 10,
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          state: summary.state,
          attention: summary.attention,
          overview: summary.overview,
          optimization_goal_id: optimizationGoal.goal.goal_id,
          experiment_id: experiments.experiments[0].experiment_id,
          evidence_goal_id: evidenceGoal.goal.goal_id,
          delivery_goal_id: deliveryGoal.goal.goal_id,
        },
        null,
        2
      )
    );
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
