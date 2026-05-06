import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = process.cwd();

test("time.stamp returns current operator-ready date and time stamps", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "master-mold-time-stamp-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const before = Date.now();
  const { client } = await openClient(dbPath);

  try {
    const listed = await client.listTools();
    assert.equal((listed.tools ?? []).some((tool) => tool.name === "time.stamp"), true);

    const stamp = await callTool(client, "time.stamp", {
      timezone: "America/Denver",
      locale: "en-US",
      source_client: "codex.desktop",
      source_agent: "codex",
      source_model: "gpt-5.5",
      source_ide: "codex",
    });
    const after = Date.now();

    assert.equal(stamp.ok, true);
    assert.equal(stamp.timezone, "America/Denver");
    assert.equal(stamp.locale, "en-US");
    assert.equal(stamp.source, "system_clock");
    assert.match(stamp.iso_utc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(stamp.date_utc, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(stamp.time_utc, /^\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(Number.isInteger(stamp.unix_seconds), true);
    assert.equal(Number.isInteger(stamp.unix_milliseconds), true);
    assert.ok(stamp.unix_milliseconds >= before);
    assert.ok(stamp.unix_milliseconds <= after + 250);
    assert.equal(stamp.unix_seconds, Math.floor(stamp.unix_milliseconds / 1000));
    assert.equal(stamp.local.timezone, "America/Denver");
    assert.equal(typeof stamp.local.human, "string");
    assert.ok(stamp.local.human.length > 0);
    assert.match(stamp.stamps.compact_utc, /^\d{8}T\d{6}Z$/);
    assert.match(stamp.stamps.filename_utc, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
    assert.match(stamp.stamps.filename_local, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[A-Za-z0-9_-]+$/);
    assert.equal(stamp.host.host_id, "test-host");
    assert.equal(typeof stamp.host.hostname, "string");
    assert.ok(stamp.host.hostname.length > 0);
    assert.equal(stamp.actor.source_client, "codex.desktop");
    assert.equal(stamp.actor.source_agent, "codex");
    assert.equal(stamp.actor.source_model, "gpt-5.5");
    assert.equal(stamp.actor.source_ide, "codex");
    assert.equal(stamp.provenance.host_id, "test-host");
    assert.equal(stamp.provenance.source_client, "codex.desktop");
    assert.equal(stamp.provenance.source_agent, "codex");
    assert.equal(stamp.provenance.source_ide, "codex");
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

  const client = new Client({ name: "time-stamp-test", version: "0.1.0" }, { capabilities: {} });
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
