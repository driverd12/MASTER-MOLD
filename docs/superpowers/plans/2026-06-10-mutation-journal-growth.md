# Mutation Journal Growth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MASTER-MOLD's mutation journal size-bounded so the MCP control plane stays performant ahead of CEREBRO implementation work.

**Architecture:** Keep exact idempotency replay for normal-sized mutation results, but replace oversized stored results with a small explicit omission envelope. Add a storage-level TTL sweep and call it from `autonomy.maintain` during the existing storage upkeep section.

**Tech Stack:** Node.js 22, TypeScript, better-sqlite3, Node test runner.

---

## Goals And Objectives

1. **Goal: Stop unbounded `result_json` growth.**
   Objective: cap stored mutation replay payloads without re-running completed side effects.

2. **Goal: Make journal cleanup automatic.**
   Objective: add a retention sweep that preserves a recent idempotency window and is invoked by `autonomy.maintain`.

3. **Goal: Preserve CEREBRO readiness boundaries.**
   Objective: keep MASTER-MOLD as the MCP-facing router/governance layer and avoid coupling this fix to future CEREBRO daemon internals.

4. **Goal: Leave lower-ranked follow-ups explicit.**
   Objective: defer non-mutation journaling exclusions, startup-backup cooldown changes, runtime-event index tuning, and transcript delete batching until this first fix is verified.

## Task 1: Mutation Result Size Cap

**Files:**
- Modify: `src/storage.ts`
- Test: `tests/mutation_journal_retention.test.mjs`

- [ ] Write a failing test proving an oversized mutation result stores a compact omission envelope instead of the full payload.
- [ ] Verify the test fails before implementation.
- [ ] Implement result serialization with a default max byte cap and env override.
- [ ] Verify exact replay still works for small results.

## Task 2: Mutation Journal TTL Sweep

**Files:**
- Modify: `src/storage.ts`
- Modify: `src/tools/autonomy_maintain.ts`
- Test: `tests/mutation_journal_retention.test.mjs`

- [ ] Write a failing test proving old journal rows are deleted while recent rows remain.
- [ ] Implement `Storage.pruneMutationJournal(...)` with dry, bounded delete semantics.
- [ ] Call the sweep from `autonomy.maintain` storage upkeep using a default 2-day window.
- [ ] Verify focused tests and `npm run build`.

## Follow-Up Queue

- Fix startup-backup cooldown so changed DB content does not force a full copy every restart.
- Review corrupt-DB quarantine cascade once journal growth is bounded.
- Evaluate runtime-event indexes and transcript retention batching after the storage hot path is stable.

## Pass 2: High-Volume Non-Replay Paths

**Goal:** Stop creating `mutation_journal` rows for hot paths where replay is not needed.

**Objective:** Preserve existing client request shapes and tool behavior while removing idempotency-journal writes from `model.router` writes and `lock.acquire` / `lock.release`.

**Files:**
- Modify: `src/tools/model_router.ts`
- Modify: `src/tools/locks.ts`
- Test: `tests/non_replay_journal_bypass.test.mjs`

- [ ] Write failing tests that show `model.router` write actions currently create journal rows.
- [ ] Write failing tests that show `lock.acquire` and `lock.release` currently create journal rows.
- [ ] Replace the idempotency wrapper in `model.router` writes with direct execution while keeping `mutation` accepted by the schema.
- [ ] Replace the idempotency wrappers in lock tools with direct storage calls while keeping `mutation` accepted by the schema.
- [ ] Run focused Node 22 tests for the bypass and prior journal-retention coverage.
