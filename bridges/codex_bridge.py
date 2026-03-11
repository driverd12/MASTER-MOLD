#!/usr/bin/env python3
"""TriChat adapter bridge for Codex CLI.

This script speaks the trichat adapter protocol on stdin/stdout.
All telemetry logs are emitted to stderr to avoid corrupting JSON envelopes.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

BRIDGE_PROTOCOL_VERSION = "trichat-bridge-v1"
RESPONSE_KIND = "trichat.adapter.response"
PONG_KIND = "trichat.adapter.pong"

DEFAULT_COMMANDS = [
    "npm run build",
    "npm test",
    "git status",
]


@dataclass
class Proposal:
    strategy: str
    commands: list[str]
    confidence: float
    mentorship_note: str

    def to_json(self) -> str:
        return json.dumps(
            {
                "strategy": self.strategy,
                "commands": self.commands,
                "confidence": self.confidence,
                "mentorship_note": self.mentorship_note,
            },
            ensure_ascii=True,
        )


def main() -> int:
    payload = read_payload()
    op = str(payload.get("op", "ask")).strip().lower()
    agent_id = str(payload.get("agent_id") or "codex").strip() or "codex"
    request_id = str(payload.get("request_id") or f"req-{os.getpid()}").strip()
    protocol_version = str(payload.get("protocol_version") or BRIDGE_PROTOCOL_VERSION).strip() or BRIDGE_PROTOCOL_VERSION
    thread_id = str(payload.get("thread_id") or "thread").strip() or "thread"

    if op == "ping":
        emit_envelope(
            kind=PONG_KIND,
            protocol_version=protocol_version,
            request_id=request_id,
            agent_id=agent_id,
            thread_id=thread_id,
            content="pong",
        )
        return 0

    objective = extract_objective(payload)
    workspace = resolve_workspace(payload)
    prompt = build_codex_prompt(agent_id, objective)
    model_output = run_codex(prompt=prompt, workspace=workspace)
    proposal = normalize_proposal(model_output, agent_id=agent_id, objective=objective)
    emit_envelope(
        kind=RESPONSE_KIND,
        protocol_version=protocol_version,
        request_id=request_id,
        agent_id=agent_id,
        thread_id=thread_id,
        content=proposal.to_json(),
    )
    return 0


def read_payload() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        print(f"[codex_bridge] invalid json payload: {error}", file=sys.stderr)
        return {}
    if isinstance(parsed, dict):
        return parsed
    return {}


def extract_objective(payload: dict[str, Any]) -> str:
    for key in ("prompt", "user_prompt", "objective", "content"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return re.sub(r"\s+", " ", value).strip()
    return "Propose a safe reliability improvement for TriChat."


def resolve_workspace(payload: dict[str, Any]) -> Path:
    for key in ("workspace", "project_dir", "cwd"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return Path(value).expanduser().resolve()
    return Path.cwd().resolve()


def build_codex_prompt(agent_id: str, objective: str) -> str:
    return (
        f"You are {agent_id} in a multi-agent council.\n"
        "Return JSON only, no markdown.\n"
        "Schema: {\"strategy\": string, \"commands\": string[], \"confidence\": number, \"mentorship_note\": string}\n"
        "Requirements:\n"
        "- commands must be read-only and safe; prefer npm run build, npm test, git status.\n"
        "- confidence in [0.05, 0.99].\n"
        "- keep strategy concise and concrete.\n"
        f"Objective: {objective}\n"
    )


def run_codex(prompt: str, workspace: Path) -> str:
    cmd = [
        "codex",
        "exec",
        "--skip-git-repo-check",
        "--json",
        "--cd",
        str(workspace),
        prompt,
    ]
    env = dict(os.environ)
    timeout_seconds = int(float(env.get("TRICHAT_BRIDGE_TIMEOUT_SECONDS", "90")))
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=max(10, timeout_seconds),
            check=False,
        )
    except Exception as error:  # noqa: BLE001
        print(f"[codex_bridge] codex exec failed: {error}", file=sys.stderr)
        return ""

    stdout = proc.stdout or ""
    stderr = proc.stderr or ""
    if stderr.strip():
        print(f"[codex_bridge] stderr: {compact(stderr)}", file=sys.stderr)
    return extract_codex_agent_text(stdout)


def extract_codex_agent_text(stdout: str) -> str:
    message_text = ""
    for line in stdout.splitlines():
        candidate = line.strip()
        if not candidate.startswith("{"):
            continue
        try:
            event = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        if event.get("type") != "item.completed":
            continue
        item = event.get("item")
        if not isinstance(item, dict):
            continue
        if item.get("type") != "agent_message":
            continue
        text = item.get("text")
        if isinstance(text, str) and text.strip():
            message_text = text.strip()
    return message_text


def normalize_proposal(raw: str, agent_id: str, objective: str) -> Proposal:
    parsed = try_parse_json_object(raw)
    if isinstance(parsed, dict):
        strategy = normalize_text(parsed.get("strategy")) or normalize_text(parsed.get("summary"))
        strategy = strategy or f"{agent_id} recommends a staged reliability pass for: {objective}"
        commands = normalize_commands(parsed.get("commands"))
        confidence = normalize_confidence(parsed.get("confidence"))
        mentorship_note = normalize_text(parsed.get("mentorship_note")) or (
            f"{agent_id} mentorship: codify safe command planning, idempotency, and gate-driven execution."
        )
        return Proposal(
            strategy=strategy,
            commands=commands,
            confidence=confidence,
            mentorship_note=mentorship_note,
        )

    strategy = normalize_text(raw) or f"{agent_id} recommends a staged reliability pass for: {objective}"
    return Proposal(
        strategy=strategy,
        commands=list(DEFAULT_COMMANDS),
        confidence=0.72,
        mentorship_note=f"{agent_id} mentorship: keep proposals compact, safe, and replay-friendly.",
    )


def normalize_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", value).strip()


def normalize_commands(value: Any) -> list[str]:
    commands: list[str] = []
    if isinstance(value, list):
        for item in value:
            text = normalize_text(item)
            if text:
                commands.append(text)
    deduped: list[str] = []
    seen: set[str] = set()
    for command in commands:
        key = command.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(command)
    return deduped or list(DEFAULT_COMMANDS)


def normalize_confidence(value: Any) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        numeric = 0.72
    numeric = max(0.05, min(0.99, numeric))
    return round(numeric, 3)


def try_parse_json_object(raw: str) -> dict[str, Any] | None:
    text = normalize_text(raw)
    if not text:
        return None
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, flags=re.DOTALL | re.IGNORECASE)
    if fenced:
        try:
            parsed = json.loads(fenced.group(1))
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

    for match in re.finditer(r"\{[\s\S]*\}", text):
        snippet = match.group(0)
        try:
            parsed = json.loads(snippet)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue
    return None


def emit_envelope(
    *,
    kind: str,
    protocol_version: str,
    request_id: str,
    agent_id: str,
    thread_id: str,
    content: str,
) -> None:
    envelope = {
        "kind": kind,
        "protocol_version": protocol_version,
        "request_id": request_id,
        "agent_id": agent_id,
        "thread_id": thread_id,
        "content": content,
    }
    sys.stdout.write(json.dumps(envelope, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def compact(value: str, limit: int = 400) -> str:
    text = normalize_text(value)
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)] + "..."


if __name__ == "__main__":
    raise SystemExit(main())
