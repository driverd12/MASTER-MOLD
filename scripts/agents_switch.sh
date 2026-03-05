#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-status}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCH_DIR="${HOME}/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"

MCP_LABEL="com.mcplayground.mcp.server"
AUTO_LABEL="com.mcplayground.imprint.autosnapshot"
WORKER_LABEL="com.mcplayground.imprint.inboxworker"
MCP_PLIST="${LAUNCH_DIR}/${MCP_LABEL}.plist"
AUTO_PLIST="${LAUNCH_DIR}/${AUTO_LABEL}.plist"
WORKER_PLIST="${LAUNCH_DIR}/${WORKER_LABEL}.plist"

is_loaded() {
  local label="$1"
  launchctl print "${DOMAIN}/${label}" >/dev/null 2>&1
}

bootout_if_exists() {
  local plist="$1"
  if [[ -f "${plist}" ]]; then
    launchctl bootout "${DOMAIN}" "${plist}" >/dev/null 2>&1 || true
  fi
}

bootstrap_if_exists() {
  local plist="$1"
  if [[ -f "${plist}" ]]; then
    launchctl bootstrap "${DOMAIN}" "${plist}" >/dev/null 2>&1 || true
  fi
}

case "${ACTION}" in
  on)
    if [[ ! -f "${MCP_PLIST}" || ! -f "${AUTO_PLIST}" || ! -f "${WORKER_PLIST}" ]]; then
      "${REPO_ROOT}/scripts/launchd_install.sh"
    else
      launchctl enable "${DOMAIN}/${MCP_LABEL}" >/dev/null 2>&1 || true
      launchctl enable "${DOMAIN}/${AUTO_LABEL}" >/dev/null 2>&1 || true
      launchctl enable "${DOMAIN}/${WORKER_LABEL}" >/dev/null 2>&1 || true
      bootout_if_exists "${MCP_PLIST}"
      bootout_if_exists "${AUTO_PLIST}"
      bootout_if_exists "${WORKER_PLIST}"
      bootstrap_if_exists "${MCP_PLIST}"
      bootstrap_if_exists "${AUTO_PLIST}"
      bootstrap_if_exists "${WORKER_PLIST}"
      launchctl kickstart -k "${DOMAIN}/${MCP_LABEL}" >/dev/null 2>&1 || true
      launchctl kickstart -k "${DOMAIN}/${AUTO_LABEL}" >/dev/null 2>&1 || true
      launchctl kickstart -k "${DOMAIN}/${WORKER_LABEL}" >/dev/null 2>&1 || true
      for _ in 1 2 3 4 5; do
        if "${REPO_ROOT}/scripts/imprint_auto_snapshot_ctl.sh" start >/dev/null 2>&1; then
          break
        fi
        sleep 2
      done
    fi
    ;;
  off)
    "${REPO_ROOT}/scripts/imprint_auto_snapshot_ctl.sh" stop >/dev/null 2>&1 || true
    bootout_if_exists "${WORKER_PLIST}"
    bootout_if_exists "${AUTO_PLIST}"
    bootout_if_exists "${MCP_PLIST}"
    ;;
  status)
    ;;
  install)
    "${REPO_ROOT}/scripts/launchd_install.sh"
    ;;
  uninstall)
    "${REPO_ROOT}/scripts/launchd_uninstall.sh"
    ;;
  *)
    echo "usage: $0 [on|off|status|install|uninstall]" >&2
    exit 2
    ;;
esac

MCP_RUNNING=false
AUTO_AGENT_LOADED=false
WORKER_AGENT_LOADED=false
if is_loaded "${MCP_LABEL}"; then MCP_RUNNING=true; fi
if is_loaded "${AUTO_LABEL}"; then AUTO_AGENT_LOADED=true; fi
if is_loaded "${WORKER_LABEL}"; then WORKER_AGENT_LOADED=true; fi

AUTO_SNAPSHOT_STATUS="{}"
if STATUS_JSON="$("${REPO_ROOT}/scripts/imprint_auto_snapshot_ctl.sh" status 2>/dev/null)"; then
  AUTO_SNAPSHOT_STATUS="${STATUS_JSON}"
fi

node --input-type=module - <<'NODE' \
"${ACTION}" \
"${DOMAIN}" \
"${MCP_LABEL}" \
"${AUTO_LABEL}" \
"${MCP_RUNNING}" \
"${AUTO_AGENT_LOADED}" \
"${WORKER_LABEL}" \
"${WORKER_AGENT_LOADED}" \
"${MCP_PLIST}" \
"${AUTO_PLIST}" \
"${WORKER_PLIST}" \
"${AUTO_SNAPSHOT_STATUS}"
const [
  action,
  domain,
  mcpLabel,
  autoLabel,
  mcpRunning,
  autoAgentLoaded,
  workerLabel,
  workerAgentLoaded,
  mcpPlist,
  autoPlist,
  workerPlist,
  autoSnapshotStatusRaw,
] = process.argv.slice(2);

let autoSnapshotStatus = {};
try {
  autoSnapshotStatus = JSON.parse(autoSnapshotStatusRaw);
} catch {
  autoSnapshotStatus = {};
}

const payload = {
  ok: true,
  action,
  domain,
  switches: {
    mcp_server: mcpRunning === 'true',
    auto_snapshot: autoAgentLoaded === 'true',
    inbox_worker: workerAgentLoaded === 'true',
  },
  launchd: {
    mcp_label: mcpLabel,
    mcp_loaded: mcpRunning === 'true',
    mcp_plist: mcpPlist,
    auto_snapshot_label: autoLabel,
    auto_snapshot_agent_loaded: autoAgentLoaded === 'true',
    auto_snapshot_plist: autoPlist,
    inbox_worker_label: workerLabel,
    inbox_worker_loaded: workerAgentLoaded === 'true',
    inbox_worker_plist: workerPlist,
  },
  auto_snapshot_runtime: autoSnapshotStatus,
};

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
NODE
