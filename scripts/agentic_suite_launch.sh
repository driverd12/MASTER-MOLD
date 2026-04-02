#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-open}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_LIST_RAW="${AGENTIC_SUITE_OPEN_APPS:-Codex,Cursor}"

open_suite_apps() {
  local raw trimmed
  IFS=',' read -r -a apps <<< "${APP_LIST_RAW}"
  for raw in "${apps[@]}"; do
    trimmed="$(printf '%s' "${raw}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    [[ -n "${trimmed}" ]] || continue
    if [[ -d "/Applications/${trimmed}.app" ]]; then
      open -ga "${trimmed}" >/dev/null 2>&1 || true
    fi
  done
}

print_status() {
  local office_json
  office_json="$("${REPO_ROOT}/scripts/agent_office_gui.sh" status)"
  node --input-type=module - <<'NODE' "${office_json}" "${APP_LIST_RAW}"
const [officeText, appListRaw] = process.argv.slice(2);
let office = {};
try {
  office = JSON.parse(officeText);
} catch {
  office = { ok: false, mode: "unknown", ready: false };
}
const requestedApps = String(appListRaw || "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
process.stdout.write(
  `${JSON.stringify(
    {
      ok: Boolean(office.ok),
      office,
      requested_apps: requestedApps,
    },
    null,
    2
  )}\n`
);
NODE
}

case "${ACTION}" in
  start)
    "${REPO_ROOT}/scripts/agents_switch.sh" on >/dev/null 2>&1 || true
    "${REPO_ROOT}/scripts/agent_office_gui.sh" start
    ;;
  open)
    "${REPO_ROOT}/scripts/agents_switch.sh" on >/dev/null 2>&1 || true
    open_suite_apps
    "${REPO_ROOT}/scripts/agent_office_gui.sh" open
    ;;
  status)
    print_status
    ;;
  *)
    echo "usage: $0 [open|start|status]" >&2
    exit 2
    ;;
esac
