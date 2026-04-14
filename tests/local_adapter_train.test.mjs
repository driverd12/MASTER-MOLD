import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseTrainingLog, resolveTrainingModelRef } from "../scripts/local_adapter_train.mjs";

test("resolveTrainingModelRef preserves explicit local model paths", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-train-model-"));
  try {
    const resolved = resolveTrainingModelRef({
      modelRef: tempDir,
      runtimeModel: "qwen3.5:35b-a3b-coding-nvfp4",
    });
    assert.equal(resolved.resolution_source, "explicit_path");
    assert.equal(resolved.resolved_model_path, tempDir);
    assert.equal(resolved.companion_for_runtime_model, "qwen3.5:35b-a3b-coding-nvfp4");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("parseTrainingLog extracts train, validation, and test metrics from mlx-lm output", () => {
  const parsed = parseTrainingLog(`
Iter 1: Train loss 1.923, Learning Rate 1.0e-5, It/sec 0.42
Iter 4: Val loss 1.551, Val took 2.8s
Iter 8: Train loss 1.102, Learning Rate 1.0e-5, It/sec 0.39
Test loss 1.337, Test ppl 3.807.
`);
  assert.deepEqual(parsed.train_loss_points, [1.923, 1.102]);
  assert.deepEqual(parsed.val_loss_points, [1.551]);
  assert.equal(parsed.final_train_loss, 1.102);
  assert.equal(parsed.final_val_loss, 1.551);
  assert.equal(parsed.test_loss, 1.337);
  assert.equal(parsed.test_ppl, 3.807);
});
