import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../dist/storage.js";

test("mutation journal stores a compact omission envelope for oversized results", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-mutation-cap-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const originalMax = process.env.ANAMNESIS_HUB_MUTATION_RESULT_JSON_MAX_BYTES;
  process.env.ANAMNESIS_HUB_MUTATION_RESULT_JSON_MAX_BYTES = "512";

  const storage = new Storage(dbPath);
  try {
    storage.init();
    const mutation = {
      idempotency_key: "test-large-mutation-result",
      side_effect_fingerprint: "fingerprint-large-mutation-result",
    };
    storage.beginMutation("test.large_result", mutation, { request_id: "large" });
    storage.completeMutation(mutation.idempotency_key, {
      ok: true,
      payload: "x".repeat(4096),
    });

    const row = storage["db"]
      .prepare("SELECT result_json FROM mutation_journal WHERE idempotency_key = ?")
      .get(mutation.idempotency_key);
    assert.ok(row);
    assert.ok(Buffer.byteLength(String(row.result_json), "utf8") <= 512);
    assert.equal(String(row.result_json).includes("x".repeat(1024)), false);

    const replay = storage.beginMutation("test.large_result", mutation, { request_id: "large" });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, {
      mutation_result_omitted: true,
      reason: "result_json_exceeds_max_bytes",
      original_result_json_bytes: 4120,
      original_result_sha256: replay.result.original_result_sha256,
      stored_result_json_max_bytes: 512,
    });
    assert.match(String(replay.result.original_result_sha256), /^[a-f0-9]{64}$/);

    const smallMutation = {
      idempotency_key: "test-small-mutation-result",
      side_effect_fingerprint: "fingerprint-small-mutation-result",
    };
    storage.beginMutation("test.small_result", smallMutation, { request_id: "small" });
    storage.completeMutation(smallMutation.idempotency_key, { ok: true, value: "small" });
    const smallReplay = storage.beginMutation("test.small_result", smallMutation, { request_id: "small" });
    assert.deepEqual(smallReplay, {
      replayed: true,
      result: { ok: true, value: "small" },
    });
  } finally {
    storage["db"]?.close?.();
    if (originalMax === undefined) {
      delete process.env.ANAMNESIS_HUB_MUTATION_RESULT_JSON_MAX_BYTES;
    } else {
      process.env.ANAMNESIS_HUB_MUTATION_RESULT_JSON_MAX_BYTES = originalMax;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("mutation journal retention deletes old rows and keeps the recent idempotency window", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-mutation-retention-"));
  const dbPath = path.join(tempDir, "hub.sqlite");
  const storage = new Storage(dbPath);

  try {
    storage.init();
    for (const key of ["test-old-mutation", "test-recent-mutation"]) {
      storage.beginMutation(
        "test.retention",
        {
          idempotency_key: key,
          side_effect_fingerprint: `fingerprint-${key}`,
        },
        { key }
      );
      storage.completeMutation(key, { ok: true, key });
    }

    storage["db"]
      .prepare("UPDATE mutation_journal SET created_at = ?, updated_at = ? WHERE idempotency_key = ?")
      .run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "test-old-mutation");

    const result = storage.pruneMutationJournal({
      older_than_seconds: 2 * 24 * 60 * 60,
      limit: 100,
      now: "2026-06-10T16:00:00.000Z",
    });
    assert.equal(result.deleted_count, 1);
    assert.equal(result.cutoff_iso, "2026-06-08T16:00:00.000Z");

    const rows = storage["db"]
      .prepare("SELECT idempotency_key FROM mutation_journal ORDER BY idempotency_key")
      .all()
      .map((row) => row.idempotency_key);
    assert.deepEqual(rows, ["test-recent-mutation"]);
  } finally {
    storage["db"]?.close?.();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
