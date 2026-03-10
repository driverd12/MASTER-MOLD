# Transport Connection Guide

## STDIO Transport

Start server:

```bash
npm run start:stdio
```

Start with CFD pack:

```bash
npm run start:cfd
```

Equivalent direct command:

```bash
node dist/server.js --domain-packs cfd
```

## HTTP Transport

Start core runtime over HTTP:

```bash
MCP_HTTP=1 MCP_HTTP_BEARER_TOKEN=change-me node dist/server.js --http --http-port 8787
```

Start HTTP with CFD pack:

```bash
MCP_HTTP=1 MCP_HTTP_BEARER_TOKEN=change-me MCP_DOMAIN_PACKS=cfd node dist/server.js --http --http-port 8787
```

## Health Checks

Use any MCP client and call:

- `health.tools`
- `health.storage`
- `migration.status`

If CFD pack is enabled:

- `cfd.schema.status`

## CORS and Auth

- `MCP_HTTP_ALLOWED_ORIGINS` controls allowed origins.
- `MCP_HTTP_BEARER_TOKEN` secures the HTTP endpoint.

## Recommended Local Dev Defaults

- HTTP host: `127.0.0.1`
- HTTP port: `8787`
- SQLite path: `./data/hub.sqlite`

## Notes for Multi-Client Sessions

- Prefer HTTP mode for many clients.
- Keep one shared SQLite DB path.
- Route all writes through MCP tools only.
- Keep startup DB guardrails enabled (`ANAMNESIS_HUB_RUN_QUICK_CHECK_ON_START=1`, `ANAMNESIS_HUB_STARTUP_BACKUP=1`) so corruption is quarantined and recovered from local backups.
