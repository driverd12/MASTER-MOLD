# Agentic Runtime Expansion: Implementation Plan

## Purpose

This document translates the phased design into concrete patch slices for the current repository.

It is intentionally incremental:

- preserve current behavior while adding new schema and tools
- keep migrations and runtime boot safe
- land thin vertical slices with tests at each step

## Current Files Most Affected

Core runtime:

- `src/server.ts`
- `src/storage.ts`
- `src/domain-packs/types.ts`
- `src/domain-packs/index.ts`

New tool modules:

- `src/tools/goal.ts`
- `src/tools/plan.ts`
- `src/tools/artifact.ts`
- `src/tools/pack_hooks.ts`

Likely integration points:

- `src/tools/task.ts`
- `src/tools/run.ts`
- `src/tools/trichat.ts`
- `src/tools/query_plan.ts`
- `src/tools/knowledge.ts`

Tests:

- `tests/core_template.integration.test.mjs`
- new integration tests for goals, plans, artifacts, and pack hooks

Docs:

- this file
- `docs/AGENTIC_RUNTIME_PHASED_DESIGN.md`

## Patch Strategy

### Slice 1: Storage Foundation Only

Goal:

- land schema migrations and storage accessors without changing tool behavior

Files:

- `src/storage.ts`

Changes:

- add `applyAgenticSchemaMigration()`
- add tables for `goals`, `goal_events`, `plans`, `plan_steps`, `plan_step_edges`, `artifacts`, `artifact_links`, `pack_hook_runs`
- add TypeScript record types and row mappers
- add CRUD helpers used by future tool modules

Acceptance criteria:

- server starts cleanly on empty DB
- server starts cleanly on existing DB
- existing tests still pass

Tests:

- migration smoke test
- create/get/list helpers through storage-level test or integration wrapper

### Slice 2: Goal CRUD

Goal:

- add durable intent management before touching planning or autopilot

Files:

- `src/tools/goal.ts`
- `src/server.ts`
- `tests/goal.integration.test.mjs`

Tool scope:

- `goal.create`
- `goal.get`
- `goal.list`
- `goal.update`
- `goal.advance`
- `goal.bundle`

Implementation notes:

- all mutating goal tools must go through `runIdempotentMutation`
- reuse existing source attribution patterns
- `goal.bundle` should be read-only and can aggregate from storage helpers
- do not auto-create tasks or plans yet

Acceptance criteria:

- goals can be created and advanced independently of tasks and TriChat
- `goal.bundle` returns deterministic related state

### Slice 3: Plan CRUD

Goal:

- persist structured plans and step dependencies before adding planners

Files:

- `src/tools/plan.ts`
- `src/server.ts`
- `src/storage.ts`
- `tests/plan.integration.test.mjs`

Tool scope:

- `plan.create`
- `plan.get`
- `plan.list`
- `plan.select`
- `plan.step_update`
- `plan.step_ready`
- `plan.invalidate`

Implementation notes:

- plan create should insert the plan, steps, and dependency edges in one transaction
- `plan.select` should update `goals.active_plan_id`
- `plan.step_ready` should evaluate edges and current statuses only
- no auto-execution yet

Acceptance criteria:

- one goal can have multiple plans
- one plan can have multiple steps with dependencies
- step readiness is deterministic

### Slice 4: Artifact Namespace

Goal:

- make evidence and outputs first-class records

Files:

- `src/tools/artifact.ts`
- `src/server.ts`
- `src/storage.ts`
- `tests/artifact.integration.test.mjs`

Tool scope:

- `artifact.record`
- `artifact.get`
- `artifact.list`
- `artifact.link`
- `artifact.bundle`
- optional `artifact.promote` if time allows

Implementation notes:

- artifact records should accept content as `uri`, `content_text`, or `content_json`
- use `artifact.link` for provenance rather than overloading arbitrary JSON fields
- bundle should return linked artifacts and entity references in one response

Acceptance criteria:

- task or run outputs can be recorded without touching transcript or memory subsystems
- artifacts can be filtered by scope and type

### Slice 5: Pack Hook Registry

Goal:

- extend the domain-pack system from tool registration to capability registration

Files:

- `src/domain-packs/types.ts`
- `src/domain-packs/index.ts`
- `src/server.ts`
- new `src/tools/pack_hooks.ts`
- `tests/pack_hooks.integration.test.mjs`

Changes:

- add planner and verifier hook types
- add registration methods to `DomainPackContext`
- add in-memory runtime registry for registered hooks
- expose `pack.hooks.list`

Acceptance criteria:

- server can enumerate available planner and verifier hooks even if no core dispatch exists yet

### Slice 6: Hook Dispatch Tools

Goal:

- allow the runtime to call pack planners and verifiers generically

Files:

- `src/tools/pack_hooks.ts`
- `src/tools/plan.ts`
- `src/server.ts`
- `src/storage.ts`
- `tests/pack_plan_verify.integration.test.mjs`

Tool scope:

- `pack.plan.generate`
- `pack.verify.run`
- `goal.plan_generate`

Implementation notes:

- planner dispatch should convert planner output into `plans` and `plan_steps`
- verifier dispatch should store `pack_hook_runs`
- verifier-produced evidence should be recorded through `artifact.record`
- do not let pack hooks write directly to the DB outside core helpers

Acceptance criteria:

- a pack hook can generate a plan for a target entity
- a pack hook can run verification and persist summary plus artifacts

### Slice 7: Reference CFD Verifier Hook

Goal:

- prove the extension model in one real domain pack

Files:

- `src/domain-packs/cfd.ts`
- `tests/cfd_pack.integration.test.mjs`

Suggested first hook:

- `cfd.verify.case_readiness`

Suggested target types:

- `cfd.case`
- optionally `cfd.run`

Suggested behavior:

- inspect case status, latest mesh quality checks, latest solve state, latest validations
- return pass/fail plus produced evidence artifacts

Why verifier first:

- minimal blast radius
- naturally aligned with current CFD metrics and validation records

### Slice 8: Goal And Plan Execution Bridges

Goal:

- connect the new design layer to current task and run primitives

Files:

- `src/tools/goal.ts`
- `src/tools/plan.ts`
- `src/tools/task.ts`
- `src/tools/run.ts`
- optionally `src/tools/query_plan.ts`

Possible additions:

- `goal.enqueue_selected_plan`
- `plan.expand_to_tasks`
- `plan.step_bind_task`

Implementation notes:

- keep this adapter layer explicit
- do not hide task creation inside low-visibility side effects
- record generated task ids on plan steps

Acceptance criteria:

- selected plan steps can become claimable tasks predictably
- tasks and runs can be traced back to goal and step ids

### Slice 9: TriChat And Autopilot Integration

Goal:

- let current multi-agent orchestration operate over durable goals and plans

Files:

- `src/tools/trichat.ts`
- `src/server.ts`
- `tests/trichat_autopilot*.test.mjs`

Suggested changes:

- goal-aware intake mode in autopilot
- planner-backed candidate plan generation
- decision and verifier results stored as artifacts
- optional `goal_id` and `plan_id` references in relevant turn metadata

Important constraint:

- do not rewrite the entire autopilot loop in one patch
- first add optional references, then add goal-driven mode behind flags or explicit inputs

### Slice 10: Evaluation And Reliability Metrics

Goal:

- measure whether the new agentic layer is actually useful

Files:

- new evaluation helpers or extension in `src/tools/health.ts` or separate tool module
- tests and docs

Suggested metrics:

- goal completion rate
- mean time from goal creation to completion
- plan invalidation rate
- verifier catch rate
- artifact coverage per run
- false-confidence rate for planner outputs

## Recommended Order Of Implementation

1. storage foundation
2. goal CRUD
3. plan CRUD
4. artifact CRUD
5. pack hook registry
6. planner and verifier dispatch
7. CFD reference verifier
8. plan-to-task bridges
9. TriChat and autopilot integration
10. evals and scorecards

## Suggested First Deliverable Set

If the next implementation round should stay moderate in scope, stop after:

1. storage foundation
2. goal CRUD
3. plan CRUD
4. artifact CRUD
5. pack hook registry

That gives the runtime a real agentic data model without forcing behavior changes into TriChat or autopilot yet.

## Explicit Non-Goals For First Implementation Round

- no vector store
- no remote service requirement
- no generalized world-model inference engine
- no mandatory changes to existing domain pack tools
- no silent automation that creates tasks from every goal

## Testing Plan

Minimum tests to add:

- `goal` lifecycle integration
- `plan` create/select/step readiness integration
- `artifact` record/link/bundle integration
- `pack.hooks.list` integration
- one pack verifier dispatch integration
- migration compatibility test for existing DB bootstrap

Regression areas to rerun:

- existing `npm test`
- current TriChat persistence tests
- core template integration test
- CFD pack integration test

## Risks And Mitigations

Risk:

- schema sprawl creates weakly-used tables

Mitigation:

- land CRUD and tests for each table set before adding more automation

Risk:

- goal, task, and run semantics overlap and confuse operators

Mitigation:

- document strict entity roles and keep adapters explicit

Risk:

- pack hooks become ad hoc side-effect engines

Mitigation:

- require hook outputs to flow through core helpers and hook run logging

Risk:

- autopilot integration becomes a destabilizing refactor

Mitigation:

- treat goal-aware autopilot as a later slice after core CRUD stabilizes

## Immediate Next Patch Recommendation

Start with a thin, reviewable branch that only adds schema and tool scaffolding:

- add migrations and record types in `src/storage.ts`
- add `src/tools/goal.ts` with `goal.create/get/list`
- register those tools in `src/server.ts`
- add one integration test for goal lifecycle

That patch is the smallest meaningful start. It establishes the new runtime vocabulary without entangling execution logic too early.
