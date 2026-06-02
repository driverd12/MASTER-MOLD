#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

eval "$("${REPO_ROOT}/scripts/export_dotenv_env.sh" "${REPO_ROOT}")"

export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
exec node dist/server.js
