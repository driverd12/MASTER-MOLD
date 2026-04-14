# Local Training Lane

The local adapter lane prepares explicit training packets for bounded local adapter or LoRA work. It does not claim that weights changed unless adapter artifacts exist.

## Commands

```bash
npm run local:training:status
npm run local:training:bootstrap
npm run local:training:prepare
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

## Truthfulness Rules

- `training_intent.weights_modified` remains `false` during `prepare`
- `training_intent.executed` remains `false` during `prepare`
- `safe_promotion_metadata.allowed_now` remains `false` until adapter artifacts exist and the gate is green
- missing train commands, red capability gates, or missing evidence are surfaced as readiness blockers instead of being treated as success

## Next Best Target

The next bounded implementation step is to wire an explicit local adapter training command that:

- consumes `train.jsonl` and `eval.jsonl`
- emits adapter config, weights, and metrics artifacts into the run directory
- records those artifacts back into the registry without auto-promoting the active model
