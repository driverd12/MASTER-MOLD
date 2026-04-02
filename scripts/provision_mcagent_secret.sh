#!/usr/bin/env bash
set -euo pipefail

ACCOUNT="${1:-mcagent}"
SECRET_DIR="${HOME}/.codex/secrets"
SECRET_PATH="${MCP_MCAGENT_SECRET_PATH:-${SECRET_DIR}/${ACCOUNT}_admin_password}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER_PATH="${REPO_ROOT}/scripts/privileged_exec.py"

mkdir -p "${SECRET_DIR}"
chmod 700 "${SECRET_DIR}"

if [[ -t 0 ]]; then
  read -rsp "Enter password for ${ACCOUNT}: " PASSWORD
  echo
  read -rsp "Re-enter password for ${ACCOUNT}: " VERIFY_PASSWORD
  echo
  if [[ "${PASSWORD}" != "${VERIFY_PASSWORD}" ]]; then
    echo "error: password confirmation mismatch" >&2
    exit 2
  fi
else
  IFS= read -r PASSWORD
fi

if [[ -z "${PASSWORD}" ]]; then
  echo "error: empty password" >&2
  exit 2
fi

VERIFY_OUTPUT="$(
  MCAGENT_SECRET="${PASSWORD}" python3 - "${ACCOUNT}" "${HELPER_PATH}" <<'PY'
import json
import os
import subprocess
import sys

account = sys.argv[1]
helper_path = sys.argv[2]
password = os.environ.get("MCAGENT_SECRET", "")
payload = {
    "account": account,
    "target_user": "root",
    "password": password,
    "command": "/usr/bin/id",
    "args": ["-u"],
    "cwd": os.getcwd(),
    "timeout_seconds": 20,
    "env": {},
}
result = subprocess.run(
    ["python3", helper_path],
    input=json.dumps(payload),
    text=True,
    capture_output=True,
)
sys.stdout.write(result.stdout)
sys.stderr.write(result.stderr)
if result.returncode != 0:
    raise SystemExit(result.returncode)
parsed = json.loads(result.stdout or "{}")
if not parsed.get("ok") or str(parsed.get("output", "")).strip() != "0":
    raise SystemExit(9)
PY
)" || {
  unset PASSWORD VERIFY_PASSWORD
  rm -f "${SECRET_PATH}" 2>/dev/null || true
  echo "error: supplied password did not verify against the live mcagent -> root path" >&2
  exit 1
}

printf '%s' "${PASSWORD}" > "${SECRET_PATH}"
chmod 600 "${SECRET_PATH}"
unset PASSWORD VERIFY_PASSWORD

node --input-type=module - <<'NODE' "${ACCOUNT}" "${SECRET_PATH}"
const [account, secretPath] = process.argv.slice(2);
process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      account,
      secret_path: secretPath,
      backend: "local_file",
      note: "Stored outside the repo and outside SQLite state after verifying mcagent -> root access.",
    },
    null,
    2
  )}\n`
);
NODE
