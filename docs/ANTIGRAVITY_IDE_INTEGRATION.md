# Antigravity IDE Integration Guide

This guide details how the Antigravity IDE connects to the MASTER-MOLD local MCP server. The integration was established securely over HTTP without disrupting the running local daemon.

## Transport & Client Profile

- **Transport:** HTTP
- **Endpoint:** `http://127.0.0.1:8787/`
- **Config Location:** `~/.antigravity/mcp.json`

Because the IDE runs on the same workstation as the control plane daemon, we configured it to share the persistent HTTP runtime alongside Cursor, Gemini CLI, and Claude CLI. This ensures the IDE acts as another valid client bridging to the durable SQLite task board (`hub.sqlite`).

## Validating Server Readiness

The following commands can be executed against the running HTTP server to confirm readiness without stopping the daemon:

### 1. Tool Inventory (`health.tools`)
Confirms that the HTTP endpoint can resolve available capabilities.
```bash
# Output from our integration check:
{
  "ok": true,
  "tool_count": 181
}
```

### 2. Provider Bridges (`provider.bridge`)
Verifies that all external clients are wired correctly:
```bash
npm run providers:status
```
*Result:* Local clients (`gemini-cli`, `claude-cli`, `cursor`) show `connected` and `ready: true`.

### 3. Agent Proxy (`health.litellm_proxy`)
Ensures the LiteLLM traffic proxy is alive for local/hosted inference.
```bash
{
  "status": "degraded",
  "endpoint": "http://127.0.0.1:4000",
  "healthy_count": 38,
  "unhealthy_count": 15,
  "service_healthy": true
}
```
*(Note: "degraded" is normal for the proxy if some remote regions are rate-limited. Routing remains functional.)*

## IDE Configuration Setup

The Antigravity IDE uses the following minimal payload, placed at `~/.antigravity/mcp.json`:

```json
{
  "endpoint": "http://127.0.0.1:8787/",
  "bearerToken": "<your-mcp-token-from-.env>",
  "allowedOrigins": [
    "http://localhost",
    "http://127.0.0.1"
  ]
}
```

This token must match `MCP_HTTP_BEARER_TOKEN` in the repository `.env` file. The server enforces matching origins to prevent unapproved external requests.

## Workflow Integration

Once connected, you can interact with the IDE just like other IDEs. Following the rules in `AGENTS.md`:
1. Use `operator.brief` to query your immediate bounded objective.
2. Route any new work requests down through `autonomy.ide_ingress` (never invent a separate shell loop).
3. Read kernel status through `kernel.summary` to understand queue pressure and available rosters.
