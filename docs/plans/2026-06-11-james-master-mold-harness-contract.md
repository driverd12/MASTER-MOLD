# JAMES ↔ MASTER-MOLD Shared MCP Harness Contract (Proposal v1)

Date: 2026-06-11
Author: Fable (MASTER-MOLD-side coordination)
Status: Draft — pending JAMES/Codex review
Scope: Local harness contract only. No ownership moves. Compatibility adapters preferred.

## 1. Verified backend state (evidence, not config)

| Item | JAMES | MASTER-MOLD |
| --- | --- | --- |
| Repo path | `/Users/dan.driver/Documents/JAMES.MD - Boom internal App hosting expert` | `/Users/dan.driver/Documents/Playground/Agentic Playground/MASTER-MOLD` |
| Local HEAD | `dd2cb3e` (clean; **10 commits behind** `origin/main` = `1ea73cd`) | `3d733cd` (clean before this work) |
| Service | `com.boom.james-mini-mcp` (port 8791) — **crash-looping, ~6,540 runs, exit 78 EX_CONFIG, no Node stderr** | `com.master-mold.mcp.server` — live, runner PID 80391, listener PID 81929 |
| Bind | loopback default; manual side-port start verified healthy | `0.0.0.0:8787` with `MCP_HTTP_ALLOW_LAN=1`; LAN mitigated by network gate (empty client allowlist + signed-host requirement); loopback auto-allowed |
| Runtime | Node 22.22.2 via `/opt/homebrew/opt/node@22`; `james:mcp:doctor` healthy (only `rg` missing) | Node 22 via `MASTER_MOLD_NODE_BIN`; native `better-sqlite3` ⇒ Node pinning matters |
| /health live | `{ok,name,tools:<count>}` (200, unauthenticated) | `{ok,status,server,ts}` (200, unauthenticated; observed 9.6s response under load) |
| Unauth tool call | 401 `{ok:false,error:"unauthorized"}` when token configured | 403 plain text (`forbidden_origin` before `forbidden_bearer`) |

JAMES exit-78 diagnosis: code starts cleanly when run manually (verified on port 8799). The crash loop produces zero Node output, which indicates launchd cannot spawn into the TCC-protected `~/Documents` working directory (MASTER-MOLD deliberately runs from `~/Library/Application Support`). JAMES/Codex to remediate (grant access, relocate runtime dir, or unload the agent until fixed).

## 2. Compatibility delta table

JAMES columns reflect `origin/main` (`1ea73cd`) where noted; the local checkout (`dd2cb3e`) predates the validation/protected-path hardening.

| Dimension | JAMES (mini harness) | MASTER-MOLD (governance MCP) | Delta / action |
| --- | --- | --- | --- |
| Tool namespace | `james.<category>.<op>`, 12 tools | `<domain>.<op>` dotted, ~200 tools via `registerTool` | Compatible convention; no change |
| Schema strictness | `additionalProperties:false`, rejected pre-dispatch (`1ea73cd`; absent at local `dd2cb3e`) | zod `schema.parse()` pre-dispatch; unknown keys **silently stripped** (non-strict zod) | Document; do NOT bulk-`.strict()` MASTER-MOLD — HTTP lane stamps network identity onto tool-call bodies and would break |
| Unknown tool | HTTP 500 `{ok:false,error:"Unknown tool: X"}` (misclassified; still 500 at `1ea73cd`) | MCP `isError:true`, text `Unknown tool: X` (HTTP 200) | Taxonomy gap both sides; candidate joint target |
| Missing required arg | 400 `"<field> is required"` (`1ea73cd`) | zod error via `isError:true` | Equivalent strength, different envelope |
| Invalid type | 400 `"<field> must be …"` (`1ea73cd`) | zod error via `isError:true` | Same as above |
| Invalid semantic value | 400 IANA timezone check (`1ea73cd`) | Per-tool semantic checks (e.g. bounded ints) | OK |
| Stdio error envelope | MCP `isError:true` text; no JSON-RPC `error.code` | Same; plus sqlite-corruption structured payload | Aligned (both lack client/server classes) |
| HTTP error envelope | JSON `{ok:false,error}` with 400/401/404/413/415/500 | JSON for `/office/api/*`; **plain text** for MCP-lane errors (403/400/404/405/413) | Adapter doc: clients must tolerate both; do not retrofit silently |
| Auth (token set) | 401 on `/tools`, `/tool`; Bearer or `X-James-Token` | 403; Origin required first, then Bearer; `/ready` also gated | Status-code mismatch (401 vs 403) — document; do not weaken |
| No token configured | Loopback-only mode permitted; refuses non-loopback bind at startup | `validateBearer` fails closed: ALL MCP/API calls rejected | Both fail safe; semantics differ — contract records both as valid |
| /health | Low-info, unauthenticated ✔ | Low-info, unauthenticated ✔ | **Aligned** |
| Tool listing auth | `/tools` token-gated when configured | `tools/list` behind Origin+Bearer+session | Aligned in spirit |
| Body size limit | 64 KiB (`readLimitedJson`), 413 | **Was unbounded on MCP POST lane** (federation 512 KiB, remote-access 32 KiB were already bounded). Fixed 2026-06-11: 4 MiB default, `MCP_HTTP_MAX_BODY_BYTES` override (floor 64 KiB), 413 | ✅ Closed this session (first bounded target). `/office/api/*` POST bodies remain unbounded — next-target candidate |
| Content-type | 415 unless `application/json` (POST /tool) | Not enforced on MCP lane (SDK transport handles) | Minor; document |
| Symlinks | Skipped in walks; symlink targets refused (`1ea73cd`) | `path_safety` resolves realpath for its own DB artifacts only | Delta — see protected paths |
| Protected host/storage paths | `/boom-cloud /data /mnt /srv /home /software /fsx /cfd*` denylist on repo-targeted tools (`1ea73cd`) | **No host/storage-path denylist**; `path_safety.ts` guards only `hub.sqlite{,-wal,-shm,-journal}` | Real gap for repo-targeted MASTER-MOLD tools (`trichat.verify project_dir`, worker workspace roots). Strong next-target candidate |
| Traversal defaults | Root-confined walks, ignore-lists, 50k file cap | Tool-specific; no shared walker | Document per-tool |
| Runtime pinning | engines `>=20 <23`; no native modules | engines `>=20 <23`; `better-sqlite3` native ⇒ Node 22 pin via launchd env | Shared invariant: Homebrew node@22 path |
| Logging/audit | Startup line only; no per-request log | `logEvent` (`http.listen`, `http.error`), mutation journal (now capped per `d72f02c`) | Asymmetry acceptable: governance vs portable |
| State ownership | `data/james/state.jsonl` in JAMES repo | `hub.sqlite` + journal in MASTER-MOLD | **Never shared**; no cross-writes (verified: no overlap) |

## 3. Shared invariants (both systems MUST hold)

1. `/health` is unauthenticated, low-information only: liveness boolean, server name, optional timestamp/tool count. Never version, paths, tool names, usernames, runtime details.
2. Every tool-invoking surface requires authorization whenever a token is configured. Known exception to resolve: MASTER-MOLD `/office/api/action|intake|hosts` POST routes execute enumerated operations with origin-gating but **no bearer check** (loopback GUI lane). Contract decision needed: accept as documented operator-GUI exception (loopback + origin allowlist + enumerated actions only) or add token/cookie. Owner: Fable proposes, Codex reviews.
3. Loopback bind is the default. Non-loopback requires token (JAMES refuses to start; MASTER-MOLD additionally requires LAN flag + per-host approval + signed identity).
4. Input validation runs before dispatch (JAMES validator at `1ea73cd`; MASTER-MOLD zod).
5. All HTTP bodies are size-bounded with 413 on excess.
6. Symlinks are never followed into privileged behavior; protected DB artifacts and protected host/storage paths are refused without explicit human approval.
7. Node 22 (Homebrew `node@22`) is the pinned runtime for anything touching native modules; doctors must verify the actual binary, not PATH luck.
8. Secrets (bearer tokens) live only in launchd plists/env — never copied into docs, code, tests, or reports.

## 4. Ownership

JAMES owns: portable mini-harness behavior, app validation/deploy tooling, its launchd lifecycle, JAMES repo commits, `data/james/state.jsonl`.
MASTER-MOLD owns: live governance MCP service on 8787, autonomy/Trichat/authority surfaces, `hub.sqlite` + mutation journal, network gate/federation identity, MASTER-MOLD repo changes.
Deliberately separate forever: state stores (no hub.sqlite sharing/migration), auth tokens, launchd jobs, tool registries. Integration is contract + adapters, not merged runtime.

## 5. Common error taxonomy (target, adapter-level)

- `client_error` — unknown tool, schema violation, semantic violation, protected-path refusal. HTTP: 4xx. Stdio: `isError:true` with machine-readable prefix (proposed `[client]`), never a transport crash.
- `auth_error` — missing/invalid token or origin. JAMES 401, MASTER-MOLD 403 — both acceptable; clients must treat 401/403 as non-retryable auth failures.
- `server_error` — handler crash, storage corruption. HTTP 5xx or `isError:true` with diagnostic payload.
- `limit_error` — 413 (body), 415 (content-type), timeouts.
Adapters translate envelopes (`{ok:false,error}` ↔ plain-text ↔ MCP `isError`); neither server rewrites its native envelope.

## 6. Health/readiness model

- `/health`: liveness only, unauthenticated, both servers (already aligned).
- `/ready` (MASTER-MOLD only): authenticated, may carry rich state. JAMES does not need `/ready`.
- Doctors: `james.doctor` / `npm run james:mcp:doctor`; MASTER-MOLD `npm run doctor`, `production:doctor`. Runtime verification means probing the live port, not reading config.

## 7. Testing requirements

- Every shared-invariant behavior gets a regression test in its own repo (no cross-repo test imports).
- Pattern proven this session: failing test first → smallest change → focused suite → adjacent suite. New: `tests/http_transport_mcp_body_limit.test.mjs` (3 tests). Existing `http_transport_ready_cache.test.mjs` (29 tests) green.
- Live-service changes require a restart in a human-approved window plus the documented smoke: `curl /health`, authorized `initialize` + `tools/list`.

## 8. Changed this session (MASTER-MOLD only)

- `src/transports/http.ts`: MCP POST lane body cap — default 4 MiB, `MCP_HTTP_MAX_BODY_BYTES` override (floor 64 KiB), 413 + connection close. `parseJsonBody` gained an optional `maxBytes`; office-lane callers unchanged.
- `tests/http_transport_mcp_body_limit.test.mjs`: oversized-default, env-override, and small-body parity coverage.
- Proof gap: live PID 81929 still runs the pre-change build. Deploy at next approved window: `launchctl kickstart -k gui/501/com.master-mold.mcp.server`, then the smoke above. `dist/` on disk already contains the new build, so any KeepAlive restart will pick it up.

## 9. Next single bounded target

Protected host/storage path refusal for MASTER-MOLD repo-targeted tools: port JAMES `1ea73cd` denylist semantics (`/boom-cloud /data /mnt /srv /home /software /fsx /cfd*`, symlink-refusing, realpath-resolved) into `src/path_safety.ts` and apply it to tools that accept `project_dir`/`workspace_root`. Note `/data` needs a repo-relative carve-out (MASTER-MOLD's own `data/` directory is repo-relative, not host `/data`).

## 10. Handoffs

JAMES/Codex: fix `com.boom.james-mini-mcp` crash loop (TCC/Documents spawn denial; ~6.5k respawns is also a resource leak — consider unloading until fixed); pull local checkout up to `1ea73cd`; review this contract, especially §3.2 (office-lane exception) and §5 (taxonomy); decide 401-vs-403 documentation language.
Fable: §9 next target with test-first flow; propose office-lane auth resolution; schedule live restart + smoke for the body-cap deploy.
