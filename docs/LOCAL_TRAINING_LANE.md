# Local Training Lane

The local adapter lane prepares explicit training packets for bounded local adapter or LoRA work. It does not claim that weights changed unless adapter artifacts exist.

## Commands

```bash
npm run local:training:status
npm run local:training:bootstrap
npm run local:training:prepare
npm run local:training:train
```

## What `prepare` Writes

Each run writes a packet under `data/training/local_adapter_lane/<run_id>/`:

- `corpus.jsonl`: the curated full corpus after dedupe and length filtering
- `train.jsonl`: deterministic train split
- `eval.jsonl`: deterministic eval holdout
- `manifest.json`: the packet contract for the run

The registry entry is appended to `data/training/model_registry.json` with:

- `candidate_id`: stable local adapter candidate identifier
- `status`: current lane state, such as `prepared_blocked`
- `trainer_ready`: whether the local MLX trainer backend is importable
- `promotion_gate_ready`: whether the latest local capability report is clean
- `readiness_blockers`: explicit reasons the lane is not ready to run or promote

## Packet Guarantees

`manifest.json` now records:

- curation stats and source breakdown
- train and eval counts
- local evaluation targets for Ollama and MLX context
- benchmark and eval acceptance criteria
- rollback metadata for the currently promoted Ollama model
- safe promotion metadata that stays false until adapter artifacts and gates exist

## Train Command

`npm run local:training:train` runs a bounded MLX LoRA pass against the latest prepared packet.

- It uses a trainable MLX companion model by default instead of pretending the active Ollama runtime model is directly fine-tuned in place.
- On this Mac, the default companion is the cached `mlx-community/Qwen2.5-Coder-3B-Instruct-4bit` snapshot when present.
- It materializes `train.jsonl`, `valid.jsonl`, and `test.jsonl` for `mlx_lm.lora`, writes adapter artifacts under `adapter/`, records `training_metrics.json`, and runs one adapter-backed generation smoke test.
- It does not auto-promote the adapter into the live Ollama route. Training and promotion remain separate gates.

## Truthfulness Rules

- `training_intent.weights_modified` remains `false` during `prepare`
- `training_intent.executed` remains `false` during `prepare`
- `safe_promotion_metadata.allowed_now` remains `false` until adapter artifacts exist and the gate is green
- missing train commands or missing evidence are surfaced as readiness blockers instead of being treated as success
- a red promotion gate does not block training execution; it blocks later promotion and route cutover

## Next Best Target

The next bounded implementation step after `train` is to add an adapter-aware evaluation and deployment lane that:

- verifies the trained adapter against bounded prompts or benchmark cases
- decides whether the adapter should back an MLX-serving lane or an exported Ollama companion path
- keeps rollback and live-route cutover explicit instead of optimistic
