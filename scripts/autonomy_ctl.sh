#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-status}"
case "${ACTION}" in
  status|ensure)
    ;;
  *)
    echo "usage: $0 [status|ensure]" >&2
    exit 2
    ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"
eval "$("${REPO_ROOT}/scripts/export_dotenv_env.sh" "${REPO_ROOT}")"

TOKEN_FILE="${REPO_ROOT}/data/imprint/http_bearer_token"
if [[ -z "${MCP_HTTP_BEARER_TOKEN:-}" && -f "${TOKEN_FILE}" ]]; then
  export MCP_HTTP_BEARER_TOKEN="$(cat "${TOKEN_FILE}")"
fi

HTTP_URL="${TRICHAT_MCP_URL:-http://127.0.0.1:8787/}"
HTTP_ORIGIN="${TRICHAT_MCP_ORIGIN:-http://127.0.0.1}"
STDIO_COMMAND="${TRICHAT_MCP_STDIO_COMMAND:-node}"
STDIO_ARGS="${TRICHAT_MCP_STDIO_ARGS:-dist/server.js}"

resolve_transport() {
  local preferred="${TRICHAT_RING_LEADER_TRANSPORT:-}"
  if [[ -n "${preferred}" ]]; then
    printf '%s\n' "${preferred}"
    return 0
  fi
  if [[ -n "${MCP_HTTP_BEARER_TOKEN:-}" ]]; then
    if node ./scripts/mcp_tool_call.mjs \
      --tool health.storage \
      --args '{}' \
      --transport http \
      --url "${HTTP_URL}" \
      --origin "${HTTP_ORIGIN}" \
      --cwd "${REPO_ROOT}" >/dev/null 2>&1; then
      printf 'http\n'
      return 0
    fi
  fi
  printf 'stdio\n'
}

TRANSPORT="$(resolve_transport)"

if [[ "${ACTION}" == "status" ]]; then
  node ./scripts/mcp_tool_call.mjs \
    --tool autonomy.bootstrap \
    --args '{"action":"status"}' \
    --transport "${TRANSPORT}" \
    --url "${HTTP_URL}" \
    --origin "${HTTP_ORIGIN}" \
    --stdio-command "${STDIO_COMMAND}" \
    --stdio-args "${STDIO_ARGS}" \
    --cwd "${REPO_ROOT}"
  exit 0
fi

NOW_TS="$(date +%s)"
RAND_SUFFIX="$(node --input-type=module -e 'process.stdout.write(Math.random().toString(36).slice(2, 8));')"
IDEMPOTENCY_KEY="autonomy-bootstrap-${ACTION}-${NOW_TS}-${RAND_SUFFIX}"
FINGERPRINT="autonomy-bootstrap-${ACTION}-fingerprint-${NOW_TS}-${RAND_SUFFIX}"

ARGS_JSON="$(node --input-type=module - <<'NODE' \
"${IDEMPOTENCY_KEY}" \
"${FINGERPRINT}" \
"${AUTONOMY_BOOTSTRAP_RUN_IMMEDIATELY:-0}" \
"${TRICHAT_RING_LEADER_AUTOSTART:-1}"
function parseBoolean(value, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

const [
  idempotencyKey,
  sideEffectFingerprint,
  runImmediately,
  autostartRingLeader,
] = process.argv.slice(2);

process.stdout.write(
  JSON.stringify({
    action: "ensure",
    mutation: {
      idempotency_key: idempotencyKey,
      side_effect_fingerprint: sideEffectFingerprint,
    },
    run_immediately: parseBoolean(runImmediately, false),
    autostart_ring_leader: parseBoolean(autostartRingLeader, true),
    seed_org_programs: true,
    seed_benchmark_suite: true,
    seed_eval_suite: true,
    source_client: "autonomy_ctl.sh",
  })
);
NODE
)"

node ./scripts/mcp_tool_call.mjs \
  --tool autonomy.bootstrap \
  --args "${ARGS_JSON}" \
  --transport "${TRANSPORT}" \
  --url "${HTTP_URL}" \
  --origin "${HTTP_ORIGIN}" \
  --stdio-command "${STDIO_COMMAND}" \
  --stdio-args "${STDIO_ARGS}" \
  --cwd "${REPO_ROOT}"
