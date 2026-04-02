#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "${REPO_ROOT}/scripts/install_trichat_app.sh" --launcher suite --name "Agentic Suite" "$@"
