# ADR 0074: Time and Context Budget Discipline

## Status
Accepted

## Context
MASTER MOLD already exposes `time.stamp` for UTC, local, Unix, host, and actor provenance. The repo also has durable memory, transcript, artifact, run-ledger, decision, ADR, and imprint surfaces. Agent-facing instructions referenced some of these tools, but they did not explicitly require recurring time checkpoints or proactive context offloading before long sessions reached forced compaction.

Long-context models can support very large windows, including million-token contexts, but current evidence does not support treating the advertised maximum as a routine operating target. Long inputs can degrade retrieval, reasoning, generation, monitoring, and memory behavior well before the hard context limit.

## Decision
Synchronized agent instructions now require explicit time and context-budget discipline:

- Use `time.stamp` at workflow start, checkpoints, handoffs, risky operations, resume points, and completion.
- Treat the active prompt as short-term working memory.
- Keep routine agent work under 40% of the effective context window where possible.
- Checkpoint at 40-50%, force offload at 50-60%, start handoff or compaction by 60-70%, and treat 80% as a hard stop unless the operator approves a source-corpus exception.
- Offload state through MCP-backed durable surfaces: `memory.append`, `transcript.squish`, `artifact.record`, `decision.link`, `adr.create`, `imprint.snapshot`, run ledgers, and task records.
- Preserve concise, source-backed notes instead of raw transcript replay.

## Consequences
- Agents should be able to recover from unexpected client compaction, restarts, and IDE handoffs with less hidden state loss.
- Million-token windows remain available for exceptional source-corpus work, but routine agent execution should use compact briefs plus selective retrieval.
- Time tracking becomes part of normal run provenance rather than an optional handoff detail.
- There is still no universal golden ratio for context usage; real task evals remain the final judge. The policy bands are conservative operating defaults, not scientific constants.

## Date
2026-06-03
