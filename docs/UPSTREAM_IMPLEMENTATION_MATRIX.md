# Upstream Implementation Matrix

This repository borrows ideas from several open projects, but it does not pretend to clone them 1:1. This file records what is implemented for real in this MCP server, what is adapted to fit the local-first kernel, and what remains intentionally out of scope.

## Status Legend

- `implemented`: live code path exists and is validated in this repo
- `adapted`: the upstream idea is reproduced in kernel-native form instead of copied directly
- `out of scope`: intentionally not reproduced here

## RALPH TUI

Source:
- [RALPH TUI README](https://github.com/subsy/ralph-tui)

Upstream wins we implemented:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| Autonomous operator loop (`select -> build -> execute -> completion -> next`) | `adapted` | Ring leader uses `agent.claim_next -> council -> execution router -> agent.report_result` in [src/tools/trichat.ts](../src/tools/trichat.ts) |
| Persistent session-oriented TUI | `implemented` | Agent Office dashboard and tmux war room in [scripts/agent_office_dashboard.py](../scripts/agent_office_dashboard.py) and [scripts/agent_office_tmux.sh](../scripts/agent_office_tmux.sh) |
| Real-time visibility into nested work | `implemented` | Dashboard reads `trichat.*`, `task.*`, `agent.session.*`, and `kernel.summary`; worker ownership is stamped explicitly in tmux task metadata |
| Resume / survive crashes | `implemented` | Durable state lives in SQLite, launchd keeps the HTTP daemon alive, and `resume-latest` office launch picks back up from stored thread/session state |

Intentionally out of scope:

- PRD / Beads tracker compatibility
- Ralph remote multi-machine tabs
- Ralph plugin ecosystem and external config format

## Get Shit Done

Source:
- [Get Shit Done README](https://github.com/gsd-build/get-shit-done)

Upstream wins we implemented:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| Bounded single-owner work packets | `implemented` | Delegation briefs require owner, task objective, evidence, rollback, and stop conditions in [bridges/local_imprint_bridge.py](../bridges/local_imprint_bridge.py) and [src/tools/trichat.ts](../src/tools/trichat.ts) |
| Delivery phases for discovery / planning / execution / verify | `implemented` | `playbook.*` exposes `gsd.map_codebase`, `gsd.phase_delivery`, and `gsd.debug_issue` from [src/tools/playbook.ts](../src/tools/playbook.ts) |
| Confidence-before-action discipline | `adapted` | Ring leader uses `gsd-confidence` checks for owner clarity, actionability, evidence, rollback, and anti-echo novelty in [src/tools/trichat.ts](../src/tools/trichat.ts) |
| Program the org, not the loop | `implemented` | Director-first delegation and explicit leaf routing in [config/trichat_agents.json](../config/trichat_agents.json) |

## autoresearch

Source:
- [autoresearch README](https://github.com/karpathy/autoresearch)

Upstream wins we implemented:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| Baseline -> propose -> variant -> measure -> accept/reject loop | `implemented` | `playbook.run` exposes `autoresearch.optimize_loop` in [src/tools/playbook.ts](../src/tools/playbook.ts) |
| Experiment evidence as the decision boundary | `implemented` | `experiment.*`, `artifact.*`, and verification-driven routing in [src/tools](../src/tools) |
| Small-budget overnight continuation | `adapted` | Local daemon uses bounded intervals, adaptive worker history, and tmux-backed execution instead of training-loop mutation |
| Edit only the narrow surface that matters | `adapted` | Specialists and leaf agents receive sharply bounded objectives instead of free-form recursive self-improvement work |

Intentionally out of scope:

- Single-GPU training loop itself
- Self-modifying training code path from the upstream repo

## AutoAgent

Source:
- [AutoAgent repository](https://github.com/kevinrgu/autoagent)

Upstream wins we implemented:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| Propose -> run -> score -> accept/reject optimization loop | `implemented` | `playbook.run` exposes `autoresearch.optimize_loop`, and `experiment.*` persists judged runs in [src/tools/playbook.ts](../src/tools/playbook.ts) and [src/tools](../src/tools) |
| Durable experiment ledger | `implemented` | SQLite-backed `experiment.*` and benchmark evidence replace the upstream TSV log |
| Overnight autonomous continuation | `adapted` | `goal.autorun_daemon`, launchd keepalive, and bounded maintain loops continue work without claiming free-form recursive self-modification |
| Human-steered optimization program | `adapted` | `autonomy.ide_ingress` plus `kernel.summary.self_improvement` expose the bounded optimization contract in kernel-native form |

Tracked gaps we may still adopt:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| LLM-as-judge benchmark scoring | `out of scope` | Benchmarks currently score regex/duration style metrics; richer judge-backed scoring would need a bounded addition to `benchmark.ts` rather than an implicit harness rewrite |
| Harbor task compatibility | `out of scope` | No Harbor importer/adapter exists yet; public Harbor-style benchmark suites would need an explicit translation layer into the local benchmark schema |
| Single editable harness file (`agent.py`) | `out of scope` | MASTER MOLD intentionally mutates bounded config/program surfaces instead of presenting a single self-modifying harness file |

## SuperClaude Framework

Source:
- [SuperClaude Framework README](https://github.com/SuperClaude-Org/SuperClaude_Framework)

Upstream wins we implemented:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| Explicit methodology / confidence checks | `implemented` | `gsd-confidence` is surfaced in briefing and session metadata |
| Specialized roles with clearer responsibilities | `implemented` | Ring leader, directors, SMEs, leaf agents, and support lanes are defined in the roster and bridge prompts |
| Operator-visible methodology | `implemented` | Agent Office briefing and help views show the confidence method and methodology lineage |

Intentionally out of scope:

- Slash-command surface and Claude-specific command vocabulary
- Framework-specific plugin/install layout

## DAN Prompt Gist

Source:
- [ChatGPT-Dan-Jailbreak.md gist](https://gist.github.com/coolaj86/6f4f7b30129b0251f61fa7baaa881516)

Only stylistic inspiration is allowed here:

- playful mode naming
- operator-facing energy

Unsafe guardrail bypass, jailbreak behavior, or instruction-override patterns are explicitly out of scope.

## builderz-labs / mission-control

Source:
- [mission-control README](https://github.com/builderz-labs/mission-control)

Upstream wins we implemented:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| Single mission-control surface for operators | `adapted` | Built-in `/office/` GUI plus tmux office substrate share one live MCP backend |
| Room-based orchestration view | `implemented` | Command deck, lounge, build bay, and ops rack are rendered from real MCP presence signals |
| Modern control-room feel over a local agent stack | `implemented` | Clickable Agent Office GUI served directly by the HTTP transport |

Intentionally out of scope:

- mission-control's hosted SaaS surface
- its cloud-specific deployment assumptions

## ComposioHQ / agent-orchestrator

Source:
- [agent-orchestrator README](https://github.com/ComposioHQ/agent-orchestrator)

Upstream wins we implemented:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| Event-driven reaction loop | `implemented` | `reaction.engine` plus notifier channels |
| Provider-aware orchestration | `implemented` | `provider.bridge` and canonical `autonomy.ide_ingress` |
| Human-attention escalation | `implemented` | deduped desktop/webhook notifications and office-visible reaction state |

## ruvnet / ruflo

Source:
- [ruflo README](https://github.com/ruvnet/ruflo)

Upstream wins we implemented:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| Swarm topology selection by objective | `implemented` | `swarm.profile` |
| Memory-aware preflight before coordination | `implemented` | retrieval hybrid query and checkpoint metadata on `autonomy.command` |
| Checkpointed swarm reasoning | `adapted` | durable swarm checkpoint artifacts and operator-visible swarm summary |

## hpn-bristol / agentic-ai-future-factory

Source:
- [agentic-ai-future-factory README](https://github.com/hpn-bristol/agentic-ai-future-factory)

Upstream wins we implemented:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| Reproducible workflow export | `implemented` | `workflow.export` bundle + metrics ledger |
| Data-driven orchestration metrics | `implemented` | append-only `run-metrics.jsonl` from durable run/task history |
| Argo-oriented DAG contract | `adapted` | truthful YAML contract export without claiming live cluster execution |

Intentionally out of scope:

- live Kubernetes execution
- Argo step runner

## EvoAgentX

Source:
- [EvoAgentX README](https://github.com/EvoAgentX/EvoAgentX)

Upstream wins we implemented:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| Agent-program mutation and evaluation | `implemented` | `optimizer.*` |
| Promotion only on measured improvement | `implemented` | candidate vs baseline scoring and gated promotion |
| Runtime behavior changed by promoted programs | `implemented` | `task.compile` and `trichat` consume effective org-program signals live |

Intentionally out of scope:

- arbitrary workflow-graph mutation
- free-form recursive self-improvement

## AutoAgent

Source:
- [AutoAgent README](https://github.com/kevinrgu/autoagent)

Upstream wins we implemented:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| Human-steered improvement program | `adapted` | `org.program` doctrine plus explicit `optimizer.step` focus/objective inputs steer the mutation loop |
| Baseline -> candidate -> measured keep/discard loop | `implemented` | `optimizer.*`, `experiment.*`, and `optimizer.scorecard` artifacts record candidate evaluation before promotion |
| Durable experiment ledger visible to operators and agents | `implemented` | SQLite `experiments` / `experiment_runs` plus `kernel.summary.self_improvement` expose the current measured optimization history |
| Narrow mutation surface instead of broad self-rewrites | `adapted` | The optimizer only mutates role doctrine/delegation/evaluation surfaces, and `autonomy.maintain` explicitly forbids free-form recursive self-improvement |

Intentionally out of scope:

- Harbor task runner and its benchmark branch workflow
- single-file self-modifying `agent.py` harness
- overnight recursive repo mutation outside bounded optimizer doctrine changes

## jayminwest / overstory

Source:
- [overstory README](https://github.com/jayminwest/overstory)

Upstream wins we implemented:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| Worktree-native coding workers | `implemented` | `runtime.worker` launches tmux-backed isolated worktree runtimes |
| Persistent runtime session tracking | `implemented` | durable `runtime_worker_sessions` schema |
| Runtime follow-through instead of fire-and-forget | `implemented` | completion-envelope reconciliation and maintain auto-spawn |

Intentionally out of scope:

- Overstory-specific cost console and replay UX
- provider-specific runtime adapters beyond current `codex` and `shell` runtime modes

## AutoAgent / Harbor

Source:
- [AutoAgent README](https://github.com/DAMO-NLP-SG/AutoAgent)
- [Harbor Benchmark](https://github.com/av/harbor)
- [MarkTechPost article](https://www.marktechpost.com/2026/04/05/meet-autoagent-the-open-source-library-that-lets-an-ai-engineer-and-optimize-its-own-agent-harness-overnight/)

Upstream wins we implemented:

| Upstream idea | Local status | Local implementation |
| --- | --- | --- |
| Reward-file based scoring (Harbor `reward.txt`) | `implemented` | `reward_file` metric mode in [src/tools/benchmark.ts](../src/tools/benchmark.ts) reads a numeric score from a file path after command execution |
| Harbor task directory import | `implemented` | [src/tools/harbor_adapter.ts](../src/tools/harbor_adapter.ts) scans `task.toml` + `instruction.md` + `tests/` directories and emits `benchmark.suite_upsert` payloads |
| Baseline → propose → measure → accept/reject optimization loop | `adapted` | `experiment.*` and `optimizer.*` primitives drive candidate vs baseline scoring and gated promotion |
| Agent-program mutation and evaluation | `adapted` | `optimizer.*` mutates org-program signals; `eval.run` composes benchmark suites and router cases |
| Overnight unattended improvement cycles | `adapted` | Local daemon uses launchd-backed persistence, bounded intervals, and tmux worker substrate |

Intentionally out of scope:

- LLM-as-judge scoring at benchmark runtime (eval layer is the better composition point)
- Single-file `agent.py` harness pattern (MASTER MOLD uses multi-tool composition instead)
- `program.md`-style meta-agent directive file (covered by `autonomy.ide_ingress` and agent config roster)
