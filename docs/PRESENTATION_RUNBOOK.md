# Presentation Runbook

This is the shortest honest path to show a full autonomous workflow tomorrow.

## 1. Prove the control plane is healthy

```bash
npm test
npm run production:doctor
```

## 2. Show the office

```bash
open /Applications/Agent\ Office.app
```

Or:

```bash
npm run trichat:office:tmux
```

## 3. Show provider federation truthfully

```bash
npm run providers:status
npm run providers:export
```

Call out the distinction:

- inbound MCP clients: Codex, Cursor, Gemini CLI, GitHub Copilot CLI
- outbound live council agents today: Codex, Cursor, Gemini, Claude, local agents
- ChatGPT/OpenAI custom MCP is remote-only, so the bundle exports a manifest instead of pretending local install exists

## 4. Hand the system a real objective

From Codex/IDE or shell:

```bash
npm run autonomy:ide -- "Take this objective, mirror it into continuity and the office, let the local-first council attempt it first, and continue in the background."
```

## 5. Explain what happens next

`autonomy.ide_ingress`:

1. appends transcript continuity
2. mirrors into the office/TriChat thread
3. records durable memory and runtime event evidence
4. launches `autonomy.command`
5. keeps execution on the same ring-leader background lane

## 6. Show the local-first policy

If the objective does not explicitly override `trichat_agent_ids`, IDE ingress now defaults to:

- `implementation-director`
- `research-director`
- `verification-director`
- `local-imprint`

That means the house agents try first, and frontier/external assistance is an intentional escalation rather than the default.
