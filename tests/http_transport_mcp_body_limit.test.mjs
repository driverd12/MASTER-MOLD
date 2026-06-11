import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { startHttpTransport } from "../dist/transports/http.js";

const BEARER_TOKEN = "mcp-body-limit-token";

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

function postMcpRequest(port, rawBody) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "POST",
        headers: {
          Origin: "http://127.0.0.1",
          Authorization: `Bearer ${BEARER_TOKEN}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(rawBody),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          settled = true;
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", (error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
      }
    );
    request.setTimeout(10_000, () => {
      request.destroy(new Error("timed out waiting for MCP POST response"));
    });
    request.on("error", (error) => {
      // The server may reset the upload stream after responding 413; only
      // surface socket errors when no response was received.
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    request.end(rawBody);
  });
}

function buildToolsListBody(paddingBytes) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: paddingBytes > 0 ? { _padding: "x".repeat(paddingBytes) } : {},
  });
}

async function withTransport(run) {
  const port = await reservePort();
  const server = await startHttpTransport(
    () =>
      new Server(
        {
          name: "http-mcp-body-limit-test",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
          },
        }
      ),
    {
      host: "127.0.0.1",
      port,
      allowedOrigins: ["http://127.0.0.1"],
      bearerToken: BEARER_TOKEN,
    }
  );
  try {
    await run(port);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

test("MCP POST lane rejects bodies above the default cap with 413", { concurrency: false }, async () => {
  await withTransport(async (port) => {
    const oversized = buildToolsListBody(4 * 1024 * 1024 + 64 * 1024);
    const response = await postMcpRequest(port, oversized);
    assert.equal(response.statusCode, 413);
    assert.match(response.body, /request body exceeds/i);
  });
});

test("MCP POST lane honors MCP_HTTP_MAX_BODY_BYTES override", { concurrency: false }, async () => {
  const previous = process.env.MCP_HTTP_MAX_BODY_BYTES;
  process.env.MCP_HTTP_MAX_BODY_BYTES = String(64 * 1024);
  try {
    await withTransport(async (port) => {
      const oversized = buildToolsListBody(96 * 1024);
      const response = await postMcpRequest(port, oversized);
      assert.equal(response.statusCode, 413);
      assert.match(response.body, /request body exceeds/i);
    });
  } finally {
    if (previous === undefined) {
      delete process.env.MCP_HTTP_MAX_BODY_BYTES;
    } else {
      process.env.MCP_HTTP_MAX_BODY_BYTES = previous;
    }
  }
});

test("MCP POST lane still routes small authorized bodies", { concurrency: false }, async () => {
  await withTransport(async (port) => {
    const small = buildToolsListBody(0);
    const response = await postMcpRequest(port, small);
    // A non-initialize request without a session id must keep reaching MCP
    // session routing (400), proving the cap does not block normal traffic.
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /Missing MCP session id or initialize payload/);
  });
});
