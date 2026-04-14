import test from "node:test";
import assert from "node:assert/strict";

import { resolvePrimarySoakCandidate } from "../scripts/local_adapter_soak.mjs";

function sampleManifest(status = "adapter_primary_mlx") {
  return {
    candidate_id: "local-adapter-sample",
    status,
    promotion_result: {
      eval_suite_id: "local-adapter-eval-suite",
      benchmark_suite_id: "local-adapter-benchmark-suite",
    },
    integration_result: {
      target: status.includes("ollama") ? "ollama" : "mlx",
      backend_id: status.includes("ollama") ? "ollama-adapter-local-adapter-sample" : "mlx-adapter-local-adapter-sample",
      model_id: status.includes("ollama")
        ? "local-adapter-sample-ollama"
        : "mlx-community/Qwen2.5-Coder-3B-Instruct-4bit",
      endpoint: status.includes("ollama") ? "http://127.0.0.1:11434" : "http://127.0.0.1:8788",
    },
    cutover_result: {
      previous_default_backend_id: "ollama-qwen3-5-35b-a3b-coding-nvfp4",
    },
  };
}

function sampleRegistration() {
  return {
    decision: {
      status: "registered",
      accepted: true,
      integration_consideration: {
        router: {
          planned_backend: {
            backend_id: "mlx-adapter-local-adapter-sample",
            tags: ["local", "mlx", "adapter"],
          },
        },
        ollama: {
          planned_backend: {
            backend_id: "ollama-adapter-local-adapter-sample",
            tags: ["local", "ollama", "adapter"],
          },
        },
      },
    },
  };
}

test("resolvePrimarySoakCandidate requires the adapter to already be the primary backend", () => {
  const blocked = resolvePrimarySoakCandidate(sampleManifest("adapter_served_mlx"), sampleRegistration());
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /active router default/i);
});

test("resolvePrimarySoakCandidate returns the active primary backend and rollback path", () => {
  const candidate = resolvePrimarySoakCandidate(sampleManifest("adapter_primary_mlx"), sampleRegistration());
  assert.equal(candidate.ok, true);
  assert.equal(candidate.target, "mlx");
  assert.equal(candidate.backend_id, "mlx-adapter-local-adapter-sample");
  assert.equal(candidate.previous_default_backend_id, "ollama-qwen3-5-35b-a3b-coding-nvfp4");
  assert.equal(candidate.eval_suite_id, "local-adapter-eval-suite");
});
