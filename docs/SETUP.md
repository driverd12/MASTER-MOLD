# MCPlayground Core Template Setup

Fastest path to run locally.

## 1. Prerequisites

- Node.js `20.x` to `22.x`
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

Enable CFD tools (optional):

```bash
MCP_DOMAIN_PACKS=cfd
```

## 5. Verify

```bash
npm test
```

## 6. Start Server

Core STDIO:

```bash
npm run start:stdio
```

Core HTTP:

```bash
npm run start:http
```

CFD STDIO:

```bash
npm run start:cfd
```

CFD HTTP:

```bash
npm run start:cfd:http
```

## 7. Smoke Check

```bash
npm run mvp:smoke
```

Against an already-running HTTP server:

```bash
MCP_SMOKE_TRANSPORT=http MCP_HTTP_BEARER_TOKEN=change-me ./scripts/mvp_smoke.sh
```

## 8. Connect IDE/Agent

Point MCP client STDIO command to:

```bash
node /absolute/path/to/MCPlayground---Core-Template/dist/server.js
```

For full client examples, see [IDE + Agent Setup Guide](./IDE_AGENT_SETUP.md).

## Troubleshooting

- Build errors: run `npm ci` and `npm run build` again.
- Missing tools in client: restart client process and verify it points at `dist/server.js`.
- Missing CFD tools: confirm `MCP_DOMAIN_PACKS=cfd` is set for that client/session.
