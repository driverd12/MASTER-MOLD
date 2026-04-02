#!/usr/bin/env bash
set -euo pipefail

ACCOUNT="${1:-mcagent}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "error: must run as root (try: sudo $0 ${ACCOUNT})" >&2
  exit 2
fi

if ! id "${ACCOUNT}" >/dev/null 2>&1; then
  echo "error: account '${ACCOUNT}' does not exist" >&2
  exit 2
fi

if [[ -t 0 ]]; then
  read -rsp "New password for ${ACCOUNT}: " PASSWORD
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

/usr/sbin/sysadminctl -resetPasswordFor "${ACCOUNT}" -newPassword "${PASSWORD}" >/dev/null
unset PASSWORD VERIFY_PASSWORD

node --input-type=module - <<'NODE' "${ACCOUNT}"
const [account] = process.argv.slice(2);
process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      account,
      note: "Updated the live macOS account password. Re-run ./scripts/provision_mcagent_secret.sh to sync the local secret file.",
    },
    null,
    2
  )}\n`
);
NODE
