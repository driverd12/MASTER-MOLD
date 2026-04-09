# MCPlayground Core Template Setup

Fastest path to run locally.

## 1. Prerequisites

- Node.js `20.x` to `22.x`
- `python3` `3.9+`
- `git`

## 2. Clone

```bash
git clone https://github.com/driverd12/MCPlayground---Core-Template.git
cd MCPlayground---Core-Template
```

## 3. Install and Build

```bash
npm ci
npm run build
```

## 4. Configure Environment

```bash
cp .env.example .env
```

Minimal values:

```bash
ANAMNESIS_HUB_DB_PATH=./data/hub.sqlite
MCP_HTTP_BEARER_TOKEN=change-me
MCP_HTTP_ALLOWED_ORIGINS=http://localhost,http://127.0.0.1
```

Built-in domain packs:

```bash
# default: agentic
# optional minimal mode:
MCP_DOMAIN_PACKS=none
```

## 5. Verify

```bash
npm run doctor
npm test
```

## 6. Start Server

STDIO:

```bash
npm run start:stdio
```

HTTP:

```bash
npm run start:http
```

## 7. Smoke Check

```bash
npm run mvp:smoke
```

Against an already-running HTTP server:

```bash
MCP_SMOKE_TRANSPORT=http MCP_HTTP_BEARER_TOKEN=change-me ./scripts/mvp_smoke.sh
```

## 8. Launch Agent Office

Cross-platform office launcher:

```bash
npm run trichat:office:web
```

Status only:

```bash
npm run trichat:office:web:status
```

## 9. Launch Agentic Suite

Cross-platform suite launcher:

```bash
npm run agentic:suite
```

Status only:

```bash
npm run agentic:suite:status
```

## 10. Connect IDE/Agent

Point MCP client STDIO command to:

```bash
node /absolute/path/to/MCPlayground---Core-Template/dist/server.js
```

For full client examples, see [IDE + Agent Setup Guide](./IDE_AGENT_SETUP.md).

## Troubleshooting

- Build errors: run `npm ci` and `npm run build` again.
- Missing tools in client: restart client process and verify it points at `dist/server.js`.
- Missing agentic tools: confirm `MCP_DOMAIN_PACKS` is unset or includes `agentic`; `MCP_DOMAIN_PACKS=none` disables built-ins.
