import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  canUseLocalOllamaCliForEndpoint,
  probeLocalOllamaBackend,
  setLocalOllamaModelResidency,
} from "../dist/local_backend_probe.js";

test("canUseLocalOllamaCliForEndpoint only allows the local CLI host", () => {
  const originalOllamaHost = process.env.OLLAMA_HOST;
  delete process.env.OLLAMA_HOST;
  try {
    assert.equal(canUseLocalOllamaCliForEndpoint("http://127.0.0.1:11434"), true);
    assert.equal(canUseLocalOllamaCliForEndpoint("http://localhost:11434"), true);
    assert.equal(canUseLocalOllamaCliForEndpoint("http://127.0.0.1:31337"), false);
    assert.equal(canUseLocalOllamaCliForEndpoint("http://10.0.0.8:11434"), false);
  } finally {
    if (originalOllamaHost === undefined) {
      delete process.env.OLLAMA_HOST;
    } else {
      process.env.OLLAMA_HOST = originalOllamaHost;
    }
  }
});

test("canUseLocalOllamaCliForEndpoint respects OLLAMA_HOST overrides", () => {
  const originalOllamaHost = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = "http://localhost:22434";
  try {
    assert.equal(canUseLocalOllamaCliForEndpoint("http://127.0.0.1:22434"), true);
    assert.equal(canUseLocalOllamaCliForEndpoint("http://localhost:11434"), false);
  } finally {
    if (originalOllamaHost === undefined) {
      delete process.env.OLLAMA_HOST;
    } else {
      process.env.OLLAMA_HOST = originalOllamaHost;
    }
  }
});

test("probeLocalOllamaBackend measures real service and benchmark data", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === "/api/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "0.6.0" }));
      return;
    }
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          models: [
            {
              name: "llama3.2:3b",
              model: "llama3.2:3b",
            },
          ],
        })
      );
      return;
    }
    if (req.url === "/api/ps") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          models: [
            {
              name: "llama3.2:3b",
              model: "llama3.2:3b",
              size_vram: 2_147_483_648,
              context_length: 8192,
              expires_at: "2026-03-30T02:30:00Z",
            },
          ],
        })
      );
      return;
    }
    if (req.url === "/api/generate") {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        const payload = JSON.parse(body);
        assert.equal(payload.model, "llama3.2:3b");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            response: "ok",
            done: true,
            total_duration: 320_000_000,
            eval_count: 8,
            eval_duration: 200_000_000,
          })
        );
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;

  try {
    const result = await probeLocalOllamaBackend({
      endpoint,
      model_id: "llama3.2:3b",
      benchmark: true,
    });
    assert.equal(result.service_ok, true);
    assert.equal(result.version, "0.6.0");
    assert.equal(result.model_known, true);
    assert.equal(result.model_loaded, true);
    assert.equal(result.resident_model_count, 1);
    assert.equal(result.resident_context_length, 8192);
    assert.equal(result.resident_expires_at, "2026-03-30T02:30:00Z");
    assert.ok(result.resident_vram_gb !== null);
    assert.ok(result.resident_vram_gb > 1.9);
    assert.equal(result.processor_summary, null);
    assert.equal(result.gpu_offload_ratio, null);
    assert.equal(result.benchmark_attempted, true);
    assert.equal(result.benchmark_ok, true);
    assert.equal(result.benchmark_eval_count, 8);
    assert.ok(result.benchmark_latency_ms !== null);
    assert.ok(result.throughput_tps !== null);
    assert.ok(result.throughput_tps > 30);
    assert.deepEqual(requests, ["/api/version", "/api/tags", "/api/ps", "/api/generate"]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("setLocalOllamaModelResidency sends real preload and unload requests", async () => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    if (req.url === "/api/generate") {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        bodies.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ response: "ok", done: true }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;

  try {
    const warm = await setLocalOllamaModelResidency({
      endpoint,
      model_id: "llama3.2:3b",
      action: "prewarm",
      keep_alive: "10m",
    });
    const cool = await setLocalOllamaModelResidency({
      endpoint,
      model_id: "llama3.2:3b",
      action: "unload",
    });
    assert.equal(warm.ok, true);
    assert.equal(cool.ok, true);
    assert.equal(bodies[0].keep_alive, "10m");
    assert.equal(bodies[1].keep_alive, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
