import test from "node:test";
import assert from "node:assert/strict";

import {
  buildIntegrationConsideration,
  decidePromotion,
} from "../scripts/local_adapter_promote.mjs";

function sampleManifest() {
  return {
    candidate_id: "local-adapter-sample",
    base_model: "qwen3.5:35b-a3b-coding-nvfp4",
    training_result: {
      adapter_path: "/tmp/adapter",
    },
    training_target: {
      requested_model_ref: "mlx-community/Qwen2.5-Coder-3B-Instruct-4bit",
    },
  };
}

test("buildIntegrationConsideration stays truthful about router and Ollama blockers", () => {
  const accepted = buildIntegrationConsideration(sampleManifest(), { status: "registered" });
  const rejected = buildIntegrationConsideration(sampleManifest(), { status: "rejected" });

  assert.equal(accepted.router.eligible, true);
  assert.equal(accepted.router.live_ready, false);
  assert.ok(accepted.router.blockers.includes("mlx_adapter_serving_path_not_implemented"));
  assert.equal(accepted.ollama.eligible, true);
  assert.ok(accepted.ollama.blockers.includes("ollama_adapter_export_not_implemented"));

  assert.equal(rejected.router.eligible, false);
  assert.ok(rejected.router.blockers.includes("candidate_not_registered"));
});

test("decidePromotion registers only when both the report and eval gate are green", () => {
  const registered = decidePromotion({
    manifest: sampleManifest(),
    report: {
      summary: {
        accepted: true,
        reward_score: 86,
        baseline_score: 82,
        delta_score: 4,
        blockers: [],
      },
    },
    evalRun: {
      ok: true,
      aggregate_metric_value: 100,
    },
  });
  const rejected = decidePromotion({
    manifest: sampleManifest(),
    report: {
      summary: {
        accepted: false,
        reward_score: 60,
        baseline_score: 80,
        delta_score: -20,
        blockers: ["adapter_reward_below_gate"],
      },
    },
    evalRun: {
      ok: false,
      aggregate_metric_value: 0,
    },
  });

  assert.equal(registered.status, "registered");
  assert.equal(registered.accepted, true);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.accepted, false);
  assert.ok(rejected.blockers.includes("adapter_reward_below_gate"));
  assert.ok(rejected.blockers.includes("eval_gate_failed"));
});
