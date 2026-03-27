#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"
eval "$("${REPO_ROOT}/scripts/export_dotenv_env.sh" "${REPO_ROOT}")"

TRANSPORT="${TRICHAT_RING_LEADER_TRANSPORT:-}"
if [[ -z "${TRANSPORT}" ]]; then
  if [[ -n "${MCP_HTTP_BEARER_TOKEN:-}" ]]; then
    TRANSPORT="http"
  else
    TRANSPORT="stdio"
  fi
fi

MCP_URL="${TRICHAT_MCP_URL:-http://127.0.0.1:8787/}"
MCP_ORIGIN="${TRICHAT_MCP_ORIGIN:-http://127.0.0.1}"
STDIO_COMMAND="${TRICHAT_MCP_STDIO_COMMAND:-node}"
STDIO_ARGS="${TRICHAT_MCP_STDIO_ARGS:-dist/server.js}"

call_tool() {
  local tool="$1"
  local args_json="$2"
  node ./scripts/mcp_tool_call.mjs \
    --tool "${tool}" \
    --args "${args_json}" \
    --transport "${TRANSPORT}" \
    --url "${MCP_URL}" \
    --origin "${MCP_ORIGIN}" \
    --stdio-command "${STDIO_COMMAND}" \
    --stdio-args "${STDIO_ARGS}" \
    --cwd "${REPO_ROOT}"
}

NOW_TS="$(date +%s)"
RAND_SUFFIX="$(node --input-type=module -e 'process.stdout.write(Math.random().toString(36).slice(2, 8));')"
MUTATION_BASE="ring-leader-cleanup-${NOW_TS}-${RAND_SUFFIX}"

THREADS_JSON="$(call_tool "trichat.thread_list" '{"limit":200}')"
FAILED_TASKS_JSON="$(call_tool "task.list" '{"status":"failed","limit":200}')"
AUTOPILOT_SESSIONS_JSON="$(call_tool "agent.session_list" '{"status":"active","client_kind":"trichat-autopilot","limit":200}')"

THREAD_IDS_TO_ARCHIVE="$(node --input-type=module - <<'NODE' "${THREADS_JSON}"
const payload = JSON.parse(process.argv[2] || "{}");
const threads = Array.isArray(payload.threads) ? payload.threads : [];
const matchesCleanupPattern = (value) => /(probe|smoke)/i.test(String(value || ""));
const selected = threads
  .filter((thread) => String(thread.status || "") === "active")
  .filter((thread) => String(thread.thread_id || "") !== "ring-leader-main")
  .filter((thread) => matchesCleanupPattern(thread.thread_id) || matchesCleanupPattern(thread.title))
  .map((thread) => String(thread.thread_id || "").trim())
  .filter(Boolean);
process.stdout.write(selected.join("\n"));
NODE
)"

ARCHIVED_COUNT=0
if [[ -n "${THREAD_IDS_TO_ARCHIVE}" ]]; then
  while IFS= read -r thread_id; do
    [[ -n "${thread_id}" ]] || continue
    mutation_id="${MUTATION_BASE}-thread-${ARCHIVED_COUNT}"
    call_tool "trichat.thread_open" "$(node --input-type=module - <<'NODE' "${thread_id}" "${mutation_id}"
const [threadId, mutationId] = process.argv.slice(2);
process.stdout.write(JSON.stringify({
  mutation: {
    idempotency_key: mutationId,
    side_effect_fingerprint: mutationId,
  },
  thread_id: threadId,
  status: "archived",
  metadata: {
    archived_by: "ring_leader_cleanup",
    cleanup_reason: "stale_probe_thread",
  },
}));
NODE
)" >/dev/null
    ARCHIVED_COUNT=$((ARCHIVED_COUNT + 1))
  done <<< "${THREAD_IDS_TO_ARCHIVE}"
fi

SESSION_IDS_TO_CLOSE="$(node --input-type=module - <<'NODE' "${AUTOPILOT_SESSIONS_JSON}"
const payload = JSON.parse(process.argv[2] || "{}");
const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
const matchesCleanupPattern = (value) => /(probe|smoke)/i.test(String(value || ""));
const selected = sessions
  .filter((session) => String(session.session_id || "") !== "trichat-autopilot:ring-leader-main")
  .filter((session) => {
    const metadata = session.metadata && typeof session.metadata === "object" ? session.metadata : {};
    const threadId = String(metadata.thread_id || "");
    const threadStatus = String(metadata.thread_status || "");
    return (
      threadStatus === "archived" ||
      matchesCleanupPattern(threadId) ||
      matchesCleanupPattern(session.session_id) ||
      matchesCleanupPattern(session.display_name)
    );
  })
  .map((session) => String(session.session_id || "").trim())
  .filter(Boolean);
process.stdout.write(selected.join("\n"));
NODE
)"

CLOSED_SESSION_COUNT=0
if [[ -n "${SESSION_IDS_TO_CLOSE}" ]]; then
  while IFS= read -r session_id; do
    [[ -n "${session_id}" ]] || continue
    mutation_id="${MUTATION_BASE}-session-${CLOSED_SESSION_COUNT}"
    call_tool "agent.session_close" "$(node --input-type=module - <<'NODE' "${session_id}" "${mutation_id}"
const [sessionId, mutationId] = process.argv.slice(2);
process.stdout.write(JSON.stringify({
  mutation: {
    idempotency_key: mutationId,
    side_effect_fingerprint: mutationId,
  },
  session_id: sessionId,
  metadata: {
    closed_by: "ring_leader_cleanup",
    close_reason: "stale_archived_autopilot_session",
  },
}));
NODE
)" >/dev/null
    CLOSED_SESSION_COUNT=$((CLOSED_SESSION_COUNT + 1))
  done <<< "${SESSION_IDS_TO_CLOSE}"
fi

FAILED_TASK_IDS_TO_RETRY="$(node --input-type=module - <<'NODE' "${FAILED_TASKS_JSON}"
const payload = JSON.parse(process.argv[2] || "{}");
const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
const selected = tasks
  .filter((task) => String(task.source || "") === "trichat.autopilot")
  .filter((task) => String(task.last_error || "").toLowerCase().includes("confidence below threshold"))
  .filter((task) => Number(task.attempt_count || 0) < Number(task.max_attempts || 0))
  .filter((task) => String(task.payload?.classification || "").toLowerCase() === "read")
  .map((task) => String(task.task_id || "").trim())
  .filter(Boolean);
process.stdout.write(selected.join("\n"));
NODE
)"

RETRIED_COUNT=0
if [[ -n "${FAILED_TASK_IDS_TO_RETRY}" ]]; then
  while IFS= read -r task_id; do
    [[ -n "${task_id}" ]] || continue
    mutation_id="${MUTATION_BASE}-task-${RETRIED_COUNT}"
    call_tool "task.retry" "$(node --input-type=module - <<'NODE' "${task_id}" "${mutation_id}"
const [taskId, mutationId] = process.argv.slice(2);
process.stdout.write(JSON.stringify({
  mutation: {
    idempotency_key: mutationId,
    side_effect_fingerprint: mutationId,
  },
  task_id: taskId,
  delay_seconds: 0,
  force: false,
  reason: "cleanup retry after ring-leader confidence rehab",
}));
NODE
)" >/dev/null
    RETRIED_COUNT=$((RETRIED_COUNT + 1))
  done <<< "${FAILED_TASK_IDS_TO_RETRY}"
fi

UNTRACKED_AUTOPILOT_ADRS="$(git ls-files --others --exclude-standard -- "docs/adrs/*trichat-autopilot-ring-leader-main-*.md" || true)"
PRUNED_ADR_COUNT=0
if [[ -n "${UNTRACKED_AUTOPILOT_ADRS}" ]]; then
  while IFS= read -r adr_path; do
    [[ -n "${adr_path}" ]] || continue
    rm -f -- "${adr_path}"
    PRUNED_ADR_COUNT=$((PRUNED_ADR_COUNT + 1))
  done <<< "${UNTRACKED_AUTOPILOT_ADRS}"
fi

printf '{\n'
printf '  "ok": true,\n'
printf '  "transport": "%s",\n' "${TRANSPORT}"
printf '  "archived_probe_threads": %d,\n' "${ARCHIVED_COUNT}"
printf '  "closed_stale_autopilot_sessions": %d,\n' "${CLOSED_SESSION_COUNT}"
printf '  "retried_failed_autopilot_tasks": %d,\n' "${RETRIED_COUNT}"
printf '  "pruned_untracked_autopilot_adrs": %d\n' "${PRUNED_ADR_COUNT}"
printf '}\n'
