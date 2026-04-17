# ADR 0073: Synchronized Agent Instruction Hardening

## Status
Accepted

## Context
Multiple agents (Codex, GitHub Copilot, Cursor, Gemini CLI, Claude) utilize the MASTER MOLD MCP server as a control plane. Previously, the instruction files (`GEMINI.md`, `copilot-instructions.md`, etc.) were inconsistent, lacking shared core mandates and a unified operational baseline.

## Decision
Synchronize and harden all agent instruction files across `AGENTS.md`, `GEMINI.md`, `CLAUDE.md`, and `.github/copilot-instructions.md`. Establish a "one canonical intake lane" via `autonomy.ide_ingress`, preserve truthful client-role boundaries, and use a shared "Agent Prompting Baseline" for high-confidence autonomous execution.

## Consequences
- **Gemini CLI, Claude, and GitHub Copilot** now operate with the same MCP-first baseline as the other senior agents in the council.
- **Improved Coordination**: Agents can now more effectively hand off work, knowing the next agent follows the same evidence-driven and MCP-first rules.
- **Safety**: Standardized safety gates (preflight/postflight) are now explicitly part of the Gemini workflow.
- **Traceability**: Durable agent guidance now lives in tracked instruction files and ADRs instead of ad hoc local breadcrumbs.

## Date
2026-04-08
