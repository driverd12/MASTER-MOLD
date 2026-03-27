import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("model.router persists backend state and routes by measured quality", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-next-wave-router-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    await callTool(session.client, "model.router", {
      action: "configure",
      mutation: nextMutation("model-router-configure", "model.router.configure", () => mutationCounter++),
      enabled: true,
      strategy: "prefer_quality",
    });

    await callTool(session.client, "worker.fabric", {
      action: "configure",
      mutation: nextMutation("worker-fabric-configure", "worker.fabric.configure", () => mutationCounter++),
      enabled: true,
      strategy: "resource_aware",
    });

    await callTool(session.client, "model.router", {
      action: "upsert_backend",
      mutation: nextMutation("model-router-upsert-local", "model.router.upsert.local", () => mutationCounter++),
      backend: {
        backend_id: "quality-backend",
        provider: "mlx",
        model_id: "mlx/quality-backend",
        locality: "local",
        context_window: 32768,
        throughput_tps: 120,
        latency_ms_p50: 18,
        success_rate: 0.99,
        win_rate: 0.995,
        cost_per_1k_input: 0.18,
        max_output_tokens: 8192,
        tags: ["local", "quality", "planning"],
        capabilities: {
          task_kinds: ["planning", "coding"],
        },
      },
    });

    await callTool(session.client, "model.router", {
      action: "upsert_backend",
      mutation: nextMutation("model-router-upsert-remote", "model.router.upsert.remote", () => mutationCounter++),
      backend: {
        backend_id: "fast-backend",
        provider: "ollama",
        model_id: "ollama/fast-backend",
        locality: "remote",
        context_window: 8192,
        throughput_tps: 220,
        latency_ms_p50: 6,
        success_rate: 0.72,
        win_rate: 0.7,
        cost_per_1k_input: 0.08,
        max_output_tokens: 4096,
        tags: ["remote", "speed"],
        capabilities: {
          task_kinds: ["chat"],
        },
      },
    });

    const status = await callTool(session.client, "model.router", { action: "status" });
    assert.equal(status.state.enabled, true);
    assert.equal(status.state.backends.length, 2);
    assert.equal(status.state.default_backend_id, "quality-backend");

    const route = await callTool(session.client, "model.router", {
      action: "route",
      task_kind: "coding",
      context_tokens: 4000,
      latency_budget_ms: 200,
      preferred_tags: ["quality"],
    });
    assert.equal(route.selected_backend.backend_id, "quality-backend");
    assert.equal(route.ranked_backends[0].backend.backend_id, "quality-backend");
    assert.ok(route.ranked_backends[0].reasoning.quality_score > route.ranked_backends[1].reasoning.quality_score);
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("eval suite upsert/list/run composes benchmark and router cases against real state", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-next-wave-eval-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  run("git init", tempDir);
  run("git config user.email 'codex@example.com'", tempDir);
  run("git config user.name 'Codex'", tempDir);
  fs.writeFileSync(path.join(tempDir, "README.md"), "# eval benchmark\n", "utf8");
  run("git add README.md", tempDir);
  run("git commit -m 'baseline'", tempDir);

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const benchmarkSuite = await callTool(session.client, "benchmark.suite_upsert", {
      mutation: nextMutation("benchmark-suite", "benchmark.suite_upsert", () => mutationCounter++),
      title: "Eval benchmark",
      objective: "Provide an isolated benchmark for the eval suite",
      project_dir: tempDir,
      isolation_mode: "git_worktree",
      aggregate_metric_name: "suite_success_rate",
      aggregate_metric_direction: "maximize",
      cases: [
        {
          case_id: "readme-check",
          title: "README exists",
          command: "test -f README.md",
        },
      ],
    });

    await callTool(session.client, "model.router", {
      action: "configure",
      mutation: nextMutation("router-configure", "model.router.configure", () => mutationCounter++),
      enabled: true,
      strategy: "prefer_quality",
    });
    await callTool(session.client, "model.router", {
      action: "upsert_backend",
      mutation: nextMutation("router-backend", "model.router.upsert", () => mutationCounter++),
      backend: {
        backend_id: "eval-backend",
        provider: "mlx",
        model_id: "mlx/eval-backend",
        locality: "local",
        context_window: 65536,
        throughput_tps: 140,
        latency_ms_p50: 12,
        success_rate: 0.98,
        win_rate: 0.99,
        cost_per_1k_input: 0.12,
        max_output_tokens: 8192,
        tags: ["local", "quality", "planning"],
        capabilities: {
          task_kinds: ["planning", "coding"],
        },
      },
    });

    const suite = await callTool(session.client, "eval.suite_upsert", {
      mutation: nextMutation("eval-suite-upsert", "eval.suite_upsert", () => mutationCounter++),
      title: "Router and benchmark eval",
      objective: "Verify routing and benchmark synthesis",
      aggregate_metric_name: "suite_success_rate",
      aggregate_metric_direction: "maximize",
      cases: [
        {
          case_id: "benchmark-smoke",
          title: "Isolated benchmark smoke",
          kind: "benchmark_suite",
          benchmark_suite_id: benchmarkSuite.suite.suite_id,
          required: true,
          weight: 1,
        },
        {
          case_id: "router-coding",
          title: "Router chooses the quality backend",
          kind: "router_case",
          task_kind: "coding",
          context_tokens: 4000,
          latency_budget_ms: 100,
          expected_backend_id: "eval-backend",
          expected_backend_tags: ["quality"],
          required_tags: ["quality"],
          preferred_tags: ["quality"],
          required: true,
          weight: 1,
        },
      ],
      tags: ["eval", "router"],
    });

    const suiteList = await callTool(session.client, "eval.suite_list", {});
    assert.ok(suiteList.suites.some((entry) => entry.suite_id === suite.suite.suite_id));

    const runResult = await callTool(session.client, "eval.run", {
      mutation: nextMutation("eval-run", "eval.run", () => mutationCounter++),
      suite_id: suite.suite.suite_id,
      candidate_label: "baseline",
    });
    assert.equal(runResult.ok, true);
    assert.equal(runResult.experiment_run.status, "completed");
    assert.equal(runResult.case_results.length, 2);
    assert.ok(runResult.case_results.some((entry) => entry.kind === "benchmark_suite" && entry.ok === true));
    assert.ok(runResult.case_results.some((entry) => entry.kind === "router_case" && entry.selected_backend.backend_id === "eval-backend"));
    assert.equal(runResult.artifact.artifact_type, "eval.result");
    assert.ok(Number.isFinite(runResult.aggregate_metric_value));
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("org.program and task.compile promote role doctrine into a durable plan", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-next-wave-org-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const session = await openClient({
    ANAMNESIS_HUB_DB_PATH: dbPath,
    TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
  });

  try {
    const roleUpsert = await callTool(session.client, "org.program", {
      action: "upsert_role",
      mutation: nextMutation("org-upsert", "org.program.upsert", () => mutationCounter++),
      role_id: "implementation-director",
      title: "Implementation Director",
      lane: "implementer",
      version: {
        version_id: "impl-v1",
        summary: "Direct code-focused work with explicit evidence",
        doctrine: "Prefer bounded implementation slices with rollback notes.",
        delegation_contract: "Assign leaf execution only when the objective is narrow enough.",
        evaluation_standard: "A plan is acceptable only when its evidence contract is explicit.",
        status: "candidate",
      },
    });
    assert.equal(roleUpsert.role.role_id, "implementation-director");
    assert.equal(roleUpsert.role.active_version_id, null);
    assert.equal(roleUpsert.role.versions.length, 1);

    const promoted = await callTool(session.client, "org.program", {
      action: "promote_version",
      mutation: nextMutation("org-promote", "org.program.promote", () => mutationCounter++),
      role_id: "implementation-director",
      version_id: "impl-v1",
    });
    assert.equal(promoted.role.active_version_id, "impl-v1");
    assert.equal(promoted.role.versions[0].status, "active");

    const orgStatus = await callTool(session.client, "org.program", { action: "status" });
    assert.equal(orgStatus.role_count >= 1, true);
    assert.equal(orgStatus.active_version_count >= 1, true);

    const goal = await callTool(session.client, "goal.create", {
      mutation: nextMutation("goal-create", "goal.create", () => mutationCounter++),
      title: "Compile task plan",
      objective: "Turn the objective into a durable execution DAG",
      status: "active",
      priority: 8,
      risk_tier: "medium",
      autonomy_mode: "recommend",
      acceptance_criteria: ["A selected plan exists", "Every step has an owner and evidence contract"],
      constraints: ["Stay bounded and reversible"],
      tags: ["compiler", "org-program"],
    });

    const compiled = await callTool(session.client, "task.compile", {
      mutation: nextMutation("task-compile", "task.compile", () => mutationCounter++),
      goal_id: goal.goal.goal_id,
      objective: "Implement an org-program-aware task compiler and verify it end to end",
      title: "Task compiler rollout",
      create_plan: true,
      selected: true,
      success_criteria: ["Plan exists", "Steps are ownered", "Evidence is explicit"],
    });

    assert.equal(compiled.created_plan, true);
    assert.equal(compiled.plan.goal_id, goal.goal.goal_id);
    assert.equal(compiled.plan.selected, true);
    assert.ok(compiled.steps.length >= 3);
    assert.ok(compiled.steps.some((step) => step.metadata.owner_role_id === "implementation-director"));
    assert.ok(
      compiled.steps.some(
        (step) =>
          step.metadata.org_program_version_id === "impl-v1" &&
          step.metadata.owner_role_id === "implementation-director"
      )
    );

    const plan = await callTool(session.client, "plan.get", { plan_id: compiled.plan.plan_id });
    assert.equal(plan.found, true);
    assert.equal(plan.plan.goal_id, goal.goal.goal_id);
    assert.ok(plan.step_count >= 3);
    assert.ok(plan.steps.some((step) => step.title === "Frame the objective and open execution lanes"));
  } finally {
    await session.client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function openClient(extraEnv) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: REPO_ROOT,
    env: inheritedEnv(extraEnv),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "mcp-next-wave-runtime-test", version: "0.1.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return { client };
}

function inheritedEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    env[key] = value;
  }
  return env;
}

async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  const first = response.content?.[0];
  assert.equal(first?.type, "text");
  if (response.isError) {
    throw new Error(`Tool ${name} failed: ${first.text}`);
  }
  return JSON.parse(first.text);
}

function nextMutation(testId, label, nextCounter) {
  const counter = nextCounter();
  return {
    idempotency_key: `${testId}:${label}:${counter}`,
    side_effect_fingerprint: `${testId}:${label}:${counter}`,
  };
}

function run(command, cwd) {
  const result = spawnSync("/bin/sh", ["-lc", command], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`command failed: ${command}\n${result.stderr}`);
  }
}
