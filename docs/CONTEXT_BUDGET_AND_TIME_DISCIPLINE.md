# Context Budget and Time Discipline

MASTER MOLD treats the model context window as short-term working memory, not as the durable system of record. Large context windows are useful for exceptional source-corpus work, but they are not a reason to let routine agent sessions drift toward 1M+ tokens.

## Time Tracking

- Use `time.stamp` at the start of every significant workflow, before important handoffs, before and after long-running or risky operations, and at completion.
- Include the returned UTC/local stamps and actor provenance in `run.begin`, `run.step`, `run.end`, task feedback, handoff artifacts, and operator notes when timing or host/IDE provenance matters.
- For work expected to run longer than 30 minutes, add a timed checkpoint at least every 30 minutes or at each owner handoff, whichever comes first.
- If a workflow is resumed after a restart, compaction, or client change, call `time.stamp` again before continuing and record the resumed source client, agent, model, and IDE.

## Context Budget Policy

There is no proven universal "golden ratio" for context usage. The reliable rule is to keep the active context as small as the task permits, then evaluate task-specific degradation. Use these policy bands against the effective context window, where effective means the smallest practical limit across the model, client, transport, local memory, tool budget, and task policy:

- **Target band:** keep routine agent work under 40% of the effective window, and prefer under 20% when retrieval plus notes can carry the task.
- **Checkpoint band:** at 40-50%, write a durable note before adding more raw context.
- **Offload band:** at 50-60%, stop expanding the active prompt and offload state through MCP memory, artifacts, decisions, or transcript squishing.
- **Handoff band:** by 60-70%, start a fresh worker/session from distilled notes and retrieved evidence instead of continuing the crowded frame.
- **Hard stop:** do not exceed 80% unless the operator explicitly approves a source-corpus exception. Record why the raw context is necessary, what will be dropped next, and where the durable notes are stored.

For a 1M-token model, this means a normal agent should not treat 1M tokens as the working target. It should usually run from a compact brief plus retrieved evidence, checkpoint around 400k-500k at the latest, and force offload before 600k unless the task truly requires raw long-form evidence.

## Safe Offloading

Agents should "write down notes" frequently enough that unexpected compaction is recoverable. A good offload note is short, source-backed, and enough for a fresh agent to continue without replaying the whole transcript.

Each checkpoint should capture:

- Current objective, owner, status, and stop condition.
- Decisions made, with `decision.link` or `adr.create` for durable policy choices.
- Files, tools, hosts, remotes, tickets, or artifacts touched.
- Evidence collected, including command names, exit status, important output summaries, and artifact IDs or file paths.
- Open questions, blockers, rollback notes, and the next concrete action.
- `time.stamp` provenance: UTC time, local time, host ID, source client, source agent, source model, and source IDE.

Use these surfaces intentionally:

- `memory.append` for distilled reusable lessons and compact handoff notes.
- `transcript.squish` when raw transcript lines need to become durable memory before they crowd the prompt.
- `artifact.record` for reports, logs, proofs, and longer evidence packets.
- `decision.link` for decisions that affect later execution.
- `adr.create` for durable architecture or policy decisions.
- `imprint.snapshot` before long-running work, restarts, or deliberate session rollover.
- `budget.ledger` and task metadata for token, time, cost, or compute budgets when they are known.

Do not offload secrets, bearer headers, private keys, credentials, or full raw transcripts unless an MCP tool is explicitly designed to store that data safely. Prefer summaries with exact error strings, file paths, command names, commit hashes, and artifact IDs.

## Context Loading Strategy

- Start from `operator.brief`, `office.snapshot` or `kernel.summary`, then retrieve only task-relevant history through `knowledge.query` or `retrieval.hybrid`.
- Load source files, logs, and transcripts in focused slices. Expand only when the current evidence is insufficient.
- Keep stable instructions and reusable context at the front of prompts when using providers with prompt caching, but do not cache noisy or rapidly changing transcript material.
- If a task needs a large corpus, summarize or index it by section first, then pull exact slices on demand.
- Before continuing after compaction, state which durable notes, artifacts, decisions, or memories were used to rebuild context.

## Research Basis

Long-context models can retrieve from very large windows, but retrieval success is not the same as reliable agent reasoning. Published work shows position sensitivity, degraded performance as context grows, and risks from poorly managed agent memory. That is why MASTER MOLD favors frequent durable checkpoints, selective retrieval, and fresh-session handoffs over pushing sessions to the advertised context limit.
