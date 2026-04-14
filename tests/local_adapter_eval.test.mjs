import test from "node:test";
import assert from "node:assert/strict";

import {
  PROMOTION_CHALLENGES,
  scoreChallengeOutput,
  summarizeEvaluation,
} from "../scripts/local_adapter_eval.mjs";

test("scoreChallengeOutput rewards structured JSON and penalizes invalid output", () => {
  const challenge = PROMOTION_CHALLENGES.find((entry) => entry.case_id === "json-control-plane");
  assert.ok(challenge);

  const strong = scoreChallengeOutput(
    challenge,
    '{"risk":"Stale ready status hides drift.","fix":"Report explicit ready status and stale state truthfully."}'
  );
  const weak = scoreChallengeOutput(challenge, "not json at all");

  assert.ok(strong.score > weak.score);
  assert.equal(weak.reasons.includes("json.invalid"), true);
});

test("summarizeEvaluation accepts only when reward, delta, artifacts, and smoke gates are satisfied", () => {
  const accepted = summarizeEvaluation({
    challengeResults: [
      {
        base: { score: 80, max_score: 25 },
        adapter: { score: 90, max_score: 25 },
      },
      {
        base: { score: 80, max_score: 25 },
        adapter: { score: 88, max_score: 25 },
      },
      {
        base: { score: 80, max_score: 25 },
        adapter: { score: 85, max_score: 25 },
      },
      {
        base: { score: 80, max_score: 25 },
        adapter: { score: 84, max_score: 25 },
      },
    ],
    trainingMetrics: {
      generate_smoke_ok: true,
      test_loss: 5.2,
      final_val_loss: 5,
      final_train_loss: 4.9,
    },
    acceptance: {
      min_reward_score: 75,
      min_delta_vs_baseline: -5,
      max_test_loss: 8,
      require_generate_smoke: true,
      require_artifacts: true,
    },
    artifacts: {
      all_present: true,
    },
  });
  const rejected = summarizeEvaluation({
    challengeResults: [
      {
        base: { score: 90, max_score: 25 },
        adapter: { score: 60, max_score: 25 },
      },
    ],
    trainingMetrics: {
      generate_smoke_ok: false,
      test_loss: 12,
      final_val_loss: 9,
      final_train_loss: 8,
    },
    acceptance: {
      min_reward_score: 75,
      min_delta_vs_baseline: -5,
      max_test_loss: 8,
      require_generate_smoke: true,
      require_artifacts: true,
    },
    artifacts: {
      all_present: false,
    },
  });

  assert.equal(accepted.accepted, true);
  assert.equal(rejected.accepted, false);
  assert.ok(rejected.blockers.includes("adapter_artifacts_missing"));
  assert.ok(rejected.blockers.includes("training_generate_smoke_failed"));
  assert.ok(rejected.blockers.includes("training_test_loss_above_gate"));
  assert.ok(rejected.blockers.includes("adapter_reward_below_gate"));
});
