#!/usr/bin/env python3
"""TriChat adapter bridge for GitHub Copilot CLI."""

from __future__ import annotations

import os
import sys

from bridge_common import (
    BridgeContext,
    build_context,
    build_dry_run_content,
    compact,
    emit_pong,
    emit_response,
    is_dry_run,
    normalize_plain_response,
    normalize_proposal,
    resolve_cli_executable,
    read_payload,
    run_cli_command,
)

LOG_PREFIX = "copilot_bridge"
BRIDGE_NAME = "copilot-bridge"


def main() -> int:
    payload = read_payload(LOG_PREFIX)
    context = build_context(payload, "github-copilot")

    if context.op == "ping":
        emit_pong(context, bridge=BRIDGE_NAME, meta={"provider": "github-copilot-cli"})
        return 0

    if is_dry_run():
        emit_response(
            context,
            build_dry_run_content(context),
            bridge=BRIDGE_NAME,
            meta={"provider": "github-copilot-cli", "mode": "dry-run"},
        )
        return 0

    try:
        result = run_copilot(context)
    except RuntimeError as error:
        print(f"[{LOG_PREFIX}] {compact(str(error), limit=600)}", file=sys.stderr)
        return 2

    if context.response_mode == "plain":
        content = normalize_plain_response(result.output, agent_id=context.agent_id, objective=context.objective)
    else:
        content = normalize_proposal(
            result.output,
            agent_id=context.agent_id,
            objective=context.objective,
            fallback_confidence=0.72,
            fallback_mentorship=f"{context.agent_id} mentorship: keep proposals compact, safe, and replay-friendly.",
        ).to_json()
    emit_response(context, content, bridge=BRIDGE_NAME, meta=result.meta)
    return 0


def run_copilot(context: BridgeContext):
    executable = resolve_cli_executable(
        str(os.environ.get("TRICHAT_GITHUB_COPILOT_EXECUTABLE") or ""),
        "copilot",
    )
    model = str(os.environ.get("TRICHAT_GITHUB_COPILOT_MODEL") or "").strip()
    reasoning_effort = str(os.environ.get("TRICHAT_GITHUB_COPILOT_REASONING_EFFORT") or "low").strip() or "low"
    cmd = [
        executable,
        "-s",
        "-p",
        build_prompt(context),
        "--allow-all-tools",
        "--no-custom-instructions",
        "--reasoning-effort",
        reasoning_effort,
        "--disable-builtin-mcps",
        "--disable-mcp-server",
        str(os.environ.get("TRICHAT_GITHUB_COPILOT_DISABLE_MCP_SERVER") or "mcplayground"),
    ]
    if model:
        cmd.extend(["--model", model])
    return run_cli_command(
        command=cmd,
        workspace=context.workspace,
        log_prefix=LOG_PREFIX,
        provider="github-copilot-cli",
    )


def build_prompt(context: BridgeContext) -> str:
    if context.response_mode == "plain":
        return (
            f"You are {context.agent_id} in a multi-agent council.\n"
            "Reply directly to the user in plain text.\n"
            "- Do not return JSON.\n"
            "- Keep the answer concise and user-facing.\n"
            f"User message: {context.objective}\n"
        )
    return (
        f"You are {context.agent_id} in a multi-agent council.\n"
        "Return JSON only, no markdown.\n"
        'Schema: {"strategy": string, "commands": string[], "confidence": number, "mentorship_note": string}\n'
        "Requirements:\n"
        "- commands must be read-only and safe; prefer npm run build, npm test, git status.\n"
        "- confidence in [0.05, 0.99].\n"
        "- keep strategy concise and concrete.\n"
        f"Objective: {context.objective}\n"
    )


if __name__ == "__main__":
    raise SystemExit(main())
