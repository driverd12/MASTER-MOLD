import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("context_budget.status reports guard bands and blocks expansion when offload is required", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-context-budget-status-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const { client } = await openClient(dbPath);

  try {
    const listed = await client.listTools();
    const names = new Set((listed.tools ?? []).map((tool) => tool.name));
    assert.equal(names.has("context_budget.status"), true);
    assert.equal(names.has("context_budget.checkpoint"), true);

    const target = await callTool(client, "context_budget.status", {
      context_tokens: 390,
      max_context_tokens: 1000,
      source_client: "codex.desktop",
      source_agent: "codex",
      source_model: "gpt-5",
    });
    assert.equal(target.context_budget_status.band, "target");
    assert.equal(target.context_budget_status.used_percent, 39);
    assert.equal(target.context_budget_status.block_expansion, false);
    assert.equal(target.context_budget_status.should_checkpoint, false);

    const offload = await callTool(client, "context_budget.status", {
      context_tokens: 550,
      max_context_tokens: 1000,
      objective: "Continue a long MASTER-MOLD implementation without forced compaction.",
      source_client: "codex.desktop",
      source_agent: "codex",
      source_model: "gpt-5",
    });
    assert.equal(offload.context_budget_status.band, "offload");
    assert.equal(offload.context_budget_status.used_percent, 55);
    assert.equal(offload.context_budget_status.should_checkpoint, true);
    assert.equal(offload.context_budget_status.should_memory_capture, true);
    assert.equal(offload.context_budget_status.should_squish, true);
    assert.equal(offload.context_budget_status.block_expansion, true);
    assert.ok(offload.context_budget_status.next_actions.some((entry) => /context_budget\.checkpoint/i.test(entry)));

    const hardStop = await callTool(client, "context_budget.status", {
      used_percent: 82,
      objective: "Raw source-corpus exception test.",
      source_client: "codex.desktop",
      source_agent: "codex",
    });
    assert.equal(hardStop.context_budget_status.band, "hard_stop");
    assert.equal(hardStop.context_budget_status.operator_approval_required, true);
    assert.equal(hardStop.context_budget_status.block_expansion, true);
    assert.ok(hardStop.context_budget_status.next_actions.some((entry) => /stop loading raw context/i.test(entry)));
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("context_budget.checkpoint captures memory and squishes linked transcript lines", async () => {
  const testId = `context-budget-checkpoint-${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-context-budget-checkpoint-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;
  const { client } = await openClient(dbPath);
  const runId = `${testId}-run`;

  try {
    await callTool(client, "transcript.log", {
      mutation: nextMutation(testId, "transcript.log.user", () => mutationCounter++),
      run_id: runId,
      role: "user",
      content: "User asked for a runtime context budget guard with automatic memory capture.",
    });
    await callTool(client, "transcript.log", {
      mutation: nextMutation(testId, "transcript.log.assistant", () => mutationCounter++),
      run_id: runId,
      role: "assistant",
      content: "Agent implemented a checkpoint flow and needs to resume from durable notes.",
    });

    const checkpoint = await callTool(client, "context_budget.checkpoint", {
      mutation: nextMutation(testId, "context_budget.checkpoint", () => mutationCounter++),
      run_id: runId,
      task_id: "task-context-budget",
      goal_id: "goal-context-budget",
      context_tokens: 650,
      max_context_tokens: 1000,
      objective: "Implement a MASTER-MOLD context budget runtime guard.",
      current_status: "Implementation in progress after red test.",
      next_action: "Implement the context_budget tool module and register the tools.",
      evidence: ["Red test proves missing context_budget.status and context_budget.checkpoint tools."],
      open_questions: ["Should the worker brief show the same guard policy?"],
      blockers: ["GitHub push auth is still unavailable on this machine."],
      rollback_notes: ["Remove context_budget tool registration if the guard breaks startup."],
      files_touched: ["tests/context_budget.integration.test.mjs"],
      source_client: "codex.desktop",
      source_agent: "codex",
      source_model: "gpt-5",
    });

    assert.equal(checkpoint.context_budget_status.band, "handoff");
    assert.equal(checkpoint.context_budget_status.block_expansion, true);
    assert.equal(checkpoint.created_memory, true);
    assert.equal(typeof checkpoint.memory_id, "number");
    assert.equal(checkpoint.transcript_squish.created_memory, true);
    assert.equal(checkpoint.transcript_squish.squished_count, 2);
    assert.match(checkpoint.resume_brief, /Implement a MASTER-MOLD context budget runtime guard/i);
    assert.match(checkpoint.resume_brief, /Next action: Implement the context_budget tool module/i);

    const memory = await callTool(client, "memory.get", { id: checkpoint.memory_id });
    assert.equal(memory.found, true);
    assert.match(memory.memory.content, /Context budget checkpoint/i);
    assert.match(memory.memory.content, /Band: handoff/i);
    assert.match(memory.memory.content, /GitHub push auth is still unavailable/i);

    const timeline = await callTool(client, "transcript.run_timeline", {
      run_id: runId,
      include_squished: true,
      limit: 10,
    });
    assert.equal(timeline.count, 2);
    assert.equal(timeline.lines.every((line) => line.is_squished === true), true);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("task.compile emits context budget policy into compact working memory", async () => {
  const testId = `context-budget-task-compile-${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-context-budget-task-compile-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;
  const { client } = await openClient(dbPath);

  try {
    const goal = await callTool(client, "goal.create", {
      mutation: nextMutation(testId, "goal.create", () => mutationCounter++),
      title: "Context budget compile goal",
      objective: "Compile a task with runtime context budget guidance.",
      acceptance_criteria: ["Compiled working memory includes context budget policy."],
    });
    const compiled = await callTool(client, "task.compile", {
      mutation: nextMutation(testId, "task.compile", () => mutationCounter++),
      goal_id: goal.goal.goal_id,
      objective: "Implement a runtime context guard and preserve recovery notes before compaction.",
      create_plan: true,
      selected: true,
    });

    assert.equal(compiled.working_memory.context_budget.status_tool, "context_budget.status");
    assert.equal(compiled.working_memory.context_budget.checkpoint_tool, "context_budget.checkpoint");
    assert.equal(compiled.working_memory.context_budget.thresholds.offload_percent, 50);
    assert.equal(compiled.working_memory.context_budget.thresholds.handoff_percent, 60);
    assert.equal(compiled.working_memory.context_budget.thresholds.hard_stop_percent, 80);
    assert.match(compiled.compile_brief.content_text, /Context budget/i);
    assert.match(compiled.compile_brief.content_text, /context_budget\.checkpoint/i);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function openClient(dbPath) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_AGENT_IDS: "",
      MCP_NOTIFIER_DRY_RUN: "1",
      MASTER_MOLD_HOST_ID: "test-host",
    },
    stderr: "inherit",
  });

  const client = new Client({ name: "context-budget-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  const originalClose = client.close.bind(client);
  client.close = async () => {
    await originalClose().catch(() => {});
    if (typeof transport.close === "function") {
      await transport.close().catch(() => {});
    }
  };
  return { client };
}

async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  const text = (response.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
  if (response.isError) {
    throw new Error(`Tool ${name} failed: ${text}`);
  }
  return JSON.parse(text);
}

function nextMutation(testId, label, nextValue) {
  const index = nextValue();
  return {
    idempotency_key: `${testId}-${label}-${index}`,
    side_effect_fingerprint: `${testId}:${label}:${index}`,
  };
}
