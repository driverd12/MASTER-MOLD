import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../dist/storage.js";
import { acquireLock, releaseLock } from "../dist/tools/locks.js";
import { modelRouter } from "../dist/tools/model_router.js";

test("model.router write actions do not create mutation_journal rows", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-router-no-journal-"));
  const storage = new Storage(path.join(tempDir, "hub.sqlite"));

  try {
    storage.init();
    assert.equal(countJournalRows(storage), 0);

    const configured = await modelRouter(storage, {
      action: "configure",
      enabled: true,
      strategy: "prefer_speed",
      mutation: mutation("router-configure"),
    });
    assert.equal(configured.state.enabled, true);

    const upserted = await modelRouter(storage, {
      action: "upsert_backend",
      mutation: mutation("router-upsert"),
      backend: {
        backend_id: "local-fast",
        provider: "ollama",
        model_id: "gemma3:4b",
        host_id: "local",
        locality: "local",
        tags: ["fast-local"],
      },
    });
    assert.equal(upserted.state.backends.length, 1);
    assert.equal(upserted.state.default_backend_id, "local-fast");
    assert.equal(countJournalRows(storage), 0);
  } finally {
    storage["db"]?.close?.();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("lock acquire and release do not create mutation_journal rows", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-lock-no-journal-"));
  const storage = new Storage(path.join(tempDir, "hub.sqlite"));

  try {
    storage.init();
    assert.equal(countJournalRows(storage), 0);

    const acquired = await acquireLock(storage, {
      mutation: mutation("lock-acquire"),
      lock_key: "perf-pass-lock",
      owner_id: "codex",
      lease_seconds: 60,
      metadata: { reason: "performance-pass" },
    });
    assert.equal(acquired.acquired, true);
    assert.equal(acquired.owner_id, "codex");

    const released = await releaseLock(storage, {
      mutation: mutation("lock-release"),
      lock_key: "perf-pass-lock",
      owner_id: "codex",
    });
    assert.equal(released.released, true);
    assert.equal(released.reason, "released");
    assert.equal(countJournalRows(storage), 0);
  } finally {
    storage["db"]?.close?.();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function mutation(label) {
  return {
    idempotency_key: `test-${label}-mutation-key`,
    side_effect_fingerprint: `fingerprint-${label}-mutation-key`,
  };
}

function countJournalRows(storage) {
  const row = storage["db"].prepare("SELECT COUNT(*) AS count FROM mutation_journal").get();
  return Number(row.count ?? 0);
}
