import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const REPO_ROOT = process.cwd();

test("autonomy shell wrapper ensure converges the control plane through the real script entrypoint", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-autonomy-shell-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const ollama = await startFakeOllamaServer({
    models: [
      {
        name: "llama3.2:3b",
      },
    ],
  });

  try {
    const baseEnv = inheritedEnv({
      ANAMNESIS_HUB_DB_PATH: dbPath,
      TRICHAT_BUS_SOCKET_PATH: path.join(tempDir, "trichat.bus.sock"),
      TRICHAT_OLLAMA_URL: ollama.url,
      TRICHAT_RING_LEADER_AUTOSTART: "1",
      TRICHAT_RING_LEADER_BRIDGE_DRY_RUN: "1",
      TRICHAT_RING_LEADER_EXECUTE_ENABLED: "0",
      TRICHAT_RING_LEADER_INTERVAL_SECONDS: "600",
      TRICHAT_RING_LEADER_TRANSPORT: "stdio",
      MCP_HTTP_BEARER_TOKEN: "",
    });

    const ensure = await runShellJson(["./scripts/autonomy_ctl.sh", "ensure"], baseEnv);
    assert.equal(ensure.ok, true);
    assert.equal(ensure.status.self_start_ready, true);
    assert.equal(ensure.status.worker_fabric.host_present, true);
    assert.equal(ensure.status.model_router.backend_present, true);
    assert.equal(ensure.status.ring_leader.running, true);

    const status = await runShellJson(["./scripts/autonomy_ctl.sh", "status"], baseEnv);
    assert.equal(status.self_start_ready, true);
    assert.deepEqual(status.repairs_needed, []);
  } finally {
    await ollama.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function startFakeOllamaServer({ models }) {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models }));
      return;
    }
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind fake Ollama server");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
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

async function runShellJson(command, env) {
  const [file, ...args] = command;
  const result = await execFileAsync(file, args, {
    cwd: REPO_ROOT,
    env,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}
