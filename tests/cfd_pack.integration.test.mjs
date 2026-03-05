import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("CFD domain pack supports case-to-report lifecycle", async () => {
  const testId = `${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cfd-pack-test-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  let mutationCounter = 0;

  const { client } = await openClient(dbPath, {
    MCP_DOMAIN_PACKS: "cfd",
  });

  try {
    const tools = await listTools(client);
    const names = new Set(tools.map((tool) => tool.name));
    assert.equal(names.has("cfd.case.create"), true);
    assert.equal(names.has("cfd.solve.start"), true);

    const createdCase = await callTool(client, "cfd.case.create", {
      mutation: nextMutation(testId, "cfd.case.create", () => mutationCounter++),
      title: "External aero baseline",
      objective: "Estimate drag and pressure coefficients",
      solver_family: "openfoam",
      units: "SI",
      geometry_ref: "./examples/geometry/car-body.step",
      tags: ["demo", "aero"],
      metadata: {
        customer: "demo-client",
      },
      source_client: "integration-test",
      source_agent: "codex",
    });
    assert.equal(createdCase.created, true);

    const caseId = createdCase.case.case_id;

    const mesh = await callTool(client, "cfd.mesh.generate", {
      mutation: nextMutation(testId, "cfd.mesh.generate", () => mutationCounter++),
      case_id: caseId,
      strategy: "snappyHexMesh",
      target_cell_count: 1200000,
      boundary_layers: 8,
      quality_targets: {
        skewness: 3.5,
        non_orthogonality: 65,
      },
      artifact_ref: "./artifacts/mesh/car-body.vtk",
      source_client: "integration-test",
      source_agent: "codex",
    });
    assert.equal(typeof mesh.mesh_id, "string");

    const meshCheck = await callTool(client, "cfd.mesh.check", {
      mutation: nextMutation(testId, "cfd.mesh.check", () => mutationCounter++),
      case_id: caseId,
      mesh_id: mesh.mesh_id,
      observed: {
        skewness: 3.2,
        non_orthogonality: 61,
        min_orthogonality: 24,
        max_aspect_ratio: 820,
      },
      source_client: "integration-test",
      source_agent: "codex",
    });
    assert.equal(meshCheck.pass, true);

    const started = await callTool(client, "cfd.solve.start", {
      mutation: nextMutation(testId, "cfd.solve.start", () => mutationCounter++),
      case_id: caseId,
      mesh_id: mesh.mesh_id,
      solver_version: "openfoam-v11",
      config_hash: "cfg-123456",
      command: "simpleFoam -case ./cases/car-body",
      source_client: "integration-test",
      source_agent: "codex",
    });
    assert.equal(started.run.status, "running");

    const runId = started.run.run_id;

    const extracted = await callTool(client, "cfd.post.extract", {
      mutation: nextMutation(testId, "cfd.post.extract", () => mutationCounter++),
      case_id: caseId,
      run_id: runId,
      metrics: [
        { name: "drag_coefficient", value: 0.31, unit: "-" },
        { name: "lift_coefficient", value: 0.02, unit: "-" },
        { name: "pressure_drop", value: 149.6, unit: "Pa" },
      ],
      source_client: "integration-test",
      source_agent: "codex",
    });
    assert.equal(extracted.metrics_count, 3);

    const validation = await callTool(client, "cfd.validate.compare", {
      mutation: nextMutation(testId, "cfd.validate.compare", () => mutationCounter++),
      case_id: caseId,
      run_id: runId,
      mode: "relative",
      baseline: {
        drag_coefficient: 0.30,
        lift_coefficient: 0.02,
      },
      actual: {
        drag_coefficient: 0.31,
        lift_coefficient: 0.021,
      },
      tolerances: {
        drag_coefficient: 0.05,
        lift_coefficient: 0.1,
      },
      source_client: "integration-test",
      source_agent: "codex",
    });
    assert.equal(validation.pass, true);

    const stopped = await callTool(client, "cfd.solve.stop", {
      mutation: nextMutation(testId, "cfd.solve.stop", () => mutationCounter++),
      run_id: runId,
      status: "completed",
      reason: "all residual criteria met",
      residuals: {
        p: 1e-4,
        Ux: 7e-5,
        Uy: 8e-5,
      },
      summary: {
        iterations: 340,
      },
      source_client: "integration-test",
      source_agent: "codex",
    });
    assert.equal(stopped.run.status, "completed");

    const report = await callTool(client, "cfd.report.bundle", {
      case_id: caseId,
      run_id: runId,
    });
    assert.equal(typeof report.report_markdown, "string");
    assert.ok(report.report_markdown.includes("CFD Report Bundle"));

    const schemaStatus = await callTool(client, "cfd.schema.status", {});
    assert.equal(schemaStatus.ok, true);
    assert.ok(schemaStatus.counts.cfd_cases >= 1);
    assert.ok(schemaStatus.counts.cfd_runs >= 1);
    assert.ok(schemaStatus.counts.cfd_metrics >= 3);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function openClient(dbPath, extraEnv) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: REPO_ROOT,
    env: inheritedEnv({
      ANAMNESIS_HUB_DB_PATH: dbPath,
      ...extraEnv,
    }),
    stderr: "pipe",
  });

  const client = new Client(
    { name: "mcp-cfd-pack-integration-test", version: "0.1.0" },
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

function nextMutation(testId, toolName, increment) {
  const index = increment();
  const safeToolName = toolName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  return {
    idempotency_key: `test-${testId}-${safeToolName}-${index}`,
    side_effect_fingerprint: `fingerprint-${testId}-${safeToolName}-${index}`,
  };
}

async function listTools(client) {
  const response = await client.listTools();
  return response.tools ?? [];
}

async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  const text = extractText(response);
  if (response.isError) {
    throw new Error(`Tool ${name} failed: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractText(response) {
  return (response.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}
