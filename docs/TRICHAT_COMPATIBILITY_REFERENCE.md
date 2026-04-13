# TriChat Compatibility Reference

This document keeps the legacy `trichat.*` naming and command surface handy while the repo and front-page story focus on `Patient Zero`, `Agent Office`, the local MCP server, and autonomous local-AI execution.

Use this page when you need the older tool names, npm scripts, env vars, or compatibility shims that still power the current office/orchestration layer.

## What Is Still Legacy-Named

These surfaces intentionally remain named `trichat` for compatibility:

- MCP tools in the `trichat.*` namespace
- npm scripts such as `npm run trichat:office:gui`
- env vars such as `TRICHAT_AGENT_IDS`
- config files such as `config/trichat_agents.json`
- helper scripts such as `scripts/install_trichat_app.sh`

Preferred operator-facing language:

- `Agent Office` for the GUI, TUI, and operator surfaces
- `office council` for the multi-agent orchestration layer
- `Patient Zero` for the fully armed local execution posture
  Local-first autonomy is considered armed when self-drive, autopilot execution, local agents, and terminal tooling are ready; optional bridge runtimes can remain degraded without disarming the core local autonomy fabric.
  While Patient Zero remains armed, undeclared IDE/CLI intake defaults also elevate: the effective permission profile becomes `high_risk`, and autonomy ingress defaults move from bounded execution to the elevated local-control lane unless the operator explicitly picks a lower mode.

## Office TUI and Council Shells

Launch the BubbleTea TUI from the terminal:

```bash
npm run trichat:tui
```

Plain chat uses direct council replies by default. Use `/plan <message>` when you explicitly want structured planning/orchestration.

Default roster:

```bash
codex,cursor,local-imprint
```

Switch the active council roster:

```bash
TRICHAT_AGENT_IDS=gemini,claude,local-imprint npm run trichat:tui
```

Launch the TUI against the local HTTP runtime:

```bash
npm run trichat:tui:http
```

Install or refresh the macOS app wrapper:

```bash
npm run trichat:app:install
```

Run launcher and bridge diagnostics:

```bash
npm run trichat:doctor
```

Inspect the effective roster:

```bash
npm run trichat:roster
node ./scripts/trichat_roster.mjs
node ./scripts/mcp_tool_call.mjs --tool trichat.roster --args '{}' --transport stdio --stdio-command node --stdio-args dist/server.js --cwd .
```

Clean stale probe threads, eligible autopilot failures, and routine autopilot ADR residue:

```bash
npm run ring-leader:cleanup
```

Mirror an IDE/operator objective into transcript continuity, the office thread, and the durable autonomous execution lane:

```bash
npm run autonomy:ide -- "Take what I say in the IDE, record it into MCP continuity, show it in the office, and run with it in the background."
```

Optional shell examples:

```bash
./scripts/autonomy_command.sh --title "Morning autonomy smoke" --tag demo --accept "Verification evidence is attached." -- "Take this objective from intake to durable execution."
./scripts/autonomy_ide_ingress.sh --session codex-ide --thread trichat-autopilot-internal --tag ide -- "Mirror this IDE objective into the office and keep the background workflow moving."
```

Default local-first council for IDE ingress when `trichat_agent_ids` is not explicitly overridden:

- `implementation-director`
- `research-director`
- `verification-director`
- `local-imprint`

## Agent Office Dashboard Commands

Launch the animated office monitor:

```bash
npm run trichat:office
```

Launch the clickable local GUI:

```bash
npm run trichat:office:gui
```

Start the tmux war room:

```bash
npm run trichat:office:tmux
```

Open the intake desk:

```bash
npm run autonomy:intake:shell
```

The dashboard reads live state from:

- `trichat.roster`
- `trichat.workboard`
- `trichat.tmux_controller`
- `trichat.bus`
- `trichat.adapter_telemetry`
- `task.summary`
- `trichat.summary`
- `kernel.summary`
- `patient.zero`
- `privileged.exec`
- `budget.ledger`
- `feature.flag`
- `warm.cache`

Keyboard controls inside the TUI:

- `1` office
- `2` briefing
- `3` lanes
- `4` workers
- `h` help
- `r` refresh
- `p` pause
- `t` cycle theme
- `q` quit

## Reliability and Validation

Local HTTP teammate validation:

```bash
npm run launchd:install
npm run it:http:validate
```

Office and council reliability checks:

```bash
npm run trichat:bridges:test
npm run trichat:doctor
npm run production:doctor
npm run autonomy:status
npm run autonomy:maintain
npm run trichat:smoke
npm run trichat:dogfood
npm run trichat:soak:gate -- --hours 1 --interval-seconds 60
```

Alternate roster validation:

```bash
TRICHAT_AGENT_IDS=gemini,claude,local-imprint npm run trichat:doctor
```

Office tmux controller dry-run:

```bash
TRICHAT_TMUX_DRY_RUN=1 node scripts/mcp_tool_call.mjs \
  --tool trichat.tmux_controller \
  --args '{"action":"start","mutation":{"idempotency_key":"demo-start","side_effect_fingerprint":"demo-start"}}'
```

The office TUI interactive `/execute` path can route via tmux allocator (`TRICHAT_EXECUTE_BACKEND=auto|tmux|direct`) using:

- `TRICHAT_TMUX_SESSION_NAME`
- `TRICHAT_TMUX_WORKER_COUNT`
- `TRICHAT_TMUX_MAX_QUEUE_PER_WORKER`
- `TRICHAT_TMUX_SYNC_AFTER_DISPATCH`
- `TRICHAT_TMUX_LOCK_LEASE_SECONDS`

Optional fanout auto-dispatch can be enabled with `TRICHAT_AUTO_EXECUTE_AFTER_DECISION=1`.

Autopilot can use tmux nested execution directly:

```bash
TRICHAT_TMUX_DRY_RUN=1 node scripts/mcp_tool_call.mjs \
  --tool trichat.autopilot \
  --args '{
    "action":"run_once",
    "mutation":{"idempotency_key":"demo-autopilot","side_effect_fingerprint":"demo-autopilot"},
    "execute_backend":"tmux",
    "tmux_session_name":"trichat-autopilot-demo",
    "tmux_worker_count":4,
    "tmux_auto_scale_workers":true
  }'
```

## Key Legacy Env Vars

- `TRICHAT_AGENT_IDS` active office council roster
- `TRICHAT_GEMINI_CMD` / `TRICHAT_CLAUDE_CMD` provider bridge command override
- `TRICHAT_GEMINI_EXECUTABLE` / `TRICHAT_GEMINI_ARGS` provider CLI override
- `TRICHAT_CLAUDE_EXECUTABLE` / `TRICHAT_CLAUDE_ARGS` provider CLI override
- `TRICHAT_CODEX_EXECUTABLE` / `TRICHAT_CURSOR_EXECUTABLE` provider binary overrides
- `TRICHAT_GEMINI_MODE` `auto`, `cli`, or `api`
- `TRICHAT_GEMINI_MODEL` Gemini API model override
- `TRICHAT_IMPRINT_MODEL` / `TRICHAT_OLLAMA_URL` local imprint lane
- `TRICHAT_LOCAL_INFERENCE_PROVIDER` `auto`, `ollama`, or `mlx`
- `TRICHAT_MLX_PYTHON` / `TRICHAT_MLX_MODEL` / `TRICHAT_MLX_ENDPOINT` MLX lane
- `TRICHAT_MLX_SERVER_ENABLED=1` managed MLX launch agent
- `TRICHAT_BRIDGE_TIMEOUT_SECONDS` per-bridge timeout
- `TRICHAT_BRIDGE_MAX_RETRIES` / `TRICHAT_BRIDGE_RETRY_BASE_MS` wrapper retry behavior

## Branding Note

There is no separate product line called `TriChat` anymore in the repo front-page story.

What remains is:

- a compatibility tool namespace
- legacy script names
- existing config/env names
- internal orchestration implementation details

The product-facing emphasis is now:

- `Patient Zero`
- `Agent Office`
- local-first MCP server infrastructure
- autonomous local-AI execution and host control
