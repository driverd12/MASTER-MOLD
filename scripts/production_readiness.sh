#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"
eval "$("${REPO_ROOT}/scripts/export_dotenv_env.sh" "${REPO_ROOT}")"

need_cmd() {
  local name="$1"
  command -v "${name}" >/dev/null 2>&1 || {
    echo "[production] missing required command: ${name}" >&2
    exit 2
  }
}

need_cmd node
need_cmd python3
need_cmd tmux
need_cmd curl

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mcplayground-production-readiness-XXXXXX")"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

TRICHAT_HTTP_URL="${TRICHAT_MCP_URL:-http://127.0.0.1:8787/}"
TRICHAT_HTTP_ORIGIN="${TRICHAT_MCP_ORIGIN:-http://127.0.0.1}"

call_http() {
  local tool="$1"
  local args="${2:-\{\}}"
  node ./scripts/mcp_tool_call.mjs \
    --tool "${tool}" \
    --args "${args}" \
    --transport http \
    --url "${TRICHAT_HTTP_URL}" \
    --origin "${TRICHAT_HTTP_ORIGIN}" \
    --cwd "${REPO_ROOT}"
}

echo "[production] repo: ${REPO_ROOT}"
echo "[production] node: $(node -v)"
echo "[production] python: $(python3 --version 2>&1)"
echo "[production] mcp url: ${TRICHAT_HTTP_URL}"

call_http trichat.autopilot '{"action":"status"}' > "${TMP_DIR}/autopilot.json"
python3 - "${TMP_DIR}/autopilot.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
pool = data.get("effective_agent_pool") or {}
lead = pool.get("lead_agent_id")
specialists = pool.get("specialist_agent_ids") or []
confidence_mode = (((data.get("session") or {}).get("session") or {}).get("metadata") or {}).get("last_confidence_method", {}).get("mode")
if not data.get("running"):
    raise SystemExit("ring leader autopilot is not running")
if lead != "ring-leader":
    raise SystemExit(f"expected ring-leader lead agent, found {lead!r}")
if len(specialists) < 3:
    raise SystemExit("expected at least three specialist agents in the effective pool")
print(f"[production] autopilot: running lead={lead} specialists={','.join(specialists)}")
if confidence_mode:
    print(f"[production] confidence method: {confidence_mode}")
PY

kernel_ok=0
for attempt in 1 2 3 4 5; do
  call_http kernel.summary '{"session_limit":6,"event_limit":6,"task_running_limit":8}' > "${TMP_DIR}/kernel.json"
  if python3 - "${TMP_DIR}/kernel.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
overview = data.get("overview") or {}
adaptive = overview.get("adaptive_session_counts") or {}
active_sessions = overview.get("active_session_count", 0)
healthy = adaptive.get("healthy", 0)
degraded = adaptive.get("degraded", 0)
print(f"[production] kernel state: {data.get('state')} active_sessions={active_sessions} healthy={healthy} degraded={degraded}")
if active_sessions < 1 or healthy < 1:
    raise SystemExit(1)
PY
  then
    kernel_ok=1
    break
  fi
  sleep 0.5
done

if [[ "${kernel_ok}" -ne 1 ]]; then
  echo "[production] kernel summary never reported an active healthy session after retry window" >&2
  exit 1
fi

call_http playbook.list '{"limit":20}' > "${TMP_DIR}/playbooks.json"
python3 - "${TMP_DIR}/playbooks.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
playbooks = {entry["playbook_id"]: entry for entry in data.get("playbooks", [])}
required = {
    "gsd.map_codebase": "gsd-build/get-shit-done",
    "gsd.phase_delivery": "gsd-build/get-shit-done",
    "gsd.debug_issue": "gsd-build/get-shit-done",
    "autoresearch.optimize_loop": "karpathy/autoresearch",
}
missing = []
wrong_source = []
for playbook_id, source_repo in required.items():
    entry = playbooks.get(playbook_id)
    if not entry:
        missing.append(playbook_id)
        continue
    if entry.get("source_repo") != source_repo:
        wrong_source.append(f"{playbook_id}:{entry.get('source_repo')}")
if missing or wrong_source:
    raise SystemExit(f"missing or mismatched playbooks missing={missing} wrong_source={wrong_source}")
print("[production] methodology playbooks: gsd + autoresearch present")
PY

python3 ./scripts/agent_office_dashboard.py \
  --transport http \
  --url "${TRICHAT_HTTP_URL}" \
  --origin "${TRICHAT_HTTP_ORIGIN}" \
  --resume-latest \
  --view help \
  --once \
  --width 120 \
  --height 30 > "${TMP_DIR}/office-help.txt"
grep -q "Truth mode:" "${TMP_DIR}/office-help.txt"
grep -q "SuperClaude-inspired confidence checks" "${TMP_DIR}/office-help.txt"
echo "[production] office dashboard: help view renders with truth mode + methodology surface"

test -d "/Applications/Agent Office.app"
echo "[production] app launcher: /Applications/Agent Office.app present"

tmux has-session -t agent-office
WINDOWS="$(tmux list-windows -t agent-office -F '#{window_name}')"
echo "${WINDOWS}" | grep -qx 'office'
echo "${WINDOWS}" | grep -qx 'briefing'
echo "${WINDOWS}" | grep -qx 'lanes'
echo "${WINDOWS}" | grep -qx 'workers'
printf "[production] tmux windows:\n%s\n" "${WINDOWS}"

call_http trichat.tmux_controller '{"action":"status"}' > "${TMP_DIR}/tmux.json"
python3 - "${TMP_DIR}/tmux.json" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
dashboard = data.get("dashboard") or {}
print(
    "[production] tmux controller: "
    f"queue_depth={dashboard.get('queue_depth')} "
    f"failure_count={dashboard.get('failure_count')} "
    f"queue_age_seconds={dashboard.get('queue_age_seconds')}"
)
PY

echo "[production] readiness: PASS"
