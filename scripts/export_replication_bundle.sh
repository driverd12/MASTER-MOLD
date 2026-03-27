#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${1:-${REPO_ROOT}/data/exports/replication/${TIMESTAMP}}"
mkdir -p "${OUT_DIR}"

BRANCH_NAME="$(git rev-parse --abbrev-ref HEAD)"
HEAD_SHA="$(git rev-parse HEAD)"
REPO_NAME="$(basename "${REPO_ROOT}")"
BUNDLE_PATH="${OUT_DIR}/${REPO_NAME}-${TIMESTAMP}.bundle"
MANIFEST_PATH="${OUT_DIR}/replication-manifest.json"
BOOTSTRAP_PATH="${OUT_DIR}/bootstrap-server.sh"

npm run build >/dev/null

git bundle create "${BUNDLE_PATH}" HEAD "${BRANCH_NAME}"
git status --short --branch > "${OUT_DIR}/git-status.txt"
git remote -v > "${OUT_DIR}/git-remotes.txt"
cp .env.example "${OUT_DIR}/.env.example"
cp config/trichat_agents.json "${OUT_DIR}/trichat_agents.json"

node --input-type=module - <<'NODE' "${MANIFEST_PATH}" "${BRANCH_NAME}" "${HEAD_SHA}" "${BUNDLE_PATH}" "${REPO_ROOT}"
import fs from "node:fs";
const [manifestPath, branchName, headSha, bundlePath, repoRoot] = process.argv.slice(2);
const manifest = {
  generated_at: new Date().toISOString(),
  repo_root: repoRoot,
  branch: branchName,
  head_sha: headSha,
  bundle_path: bundlePath,
  bootstrap_steps: [
    "git clone <bundle> <target-dir>",
    "cp .env.example .env",
    "npm ci",
    "npm run build",
    "npm run launchd:install",
    "npm run codex:mcp:register",
    "npm run trichat:app:install",
    "npm run ring-leader:start",
  ],
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
NODE

cat > "${BOOTSTRAP_PATH}" <<EOF
#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="\${1:-${REPO_NAME}}"
BUNDLE_PATH="\${2:-$(basename "${BUNDLE_PATH}")}"

git clone "\${BUNDLE_PATH}" "\${TARGET_DIR}"
cd "\${TARGET_DIR}"
git checkout "${BRANCH_NAME}"

if [[ ! -f ".env" ]]; then
  cp .env.example .env
fi

npm ci
npm run build
npm run launchd:install
npm run codex:mcp:register
npm run trichat:app:install
npm run ring-leader:start
npm run trichat:doctor
EOF
chmod +x "${BOOTSTRAP_PATH}"

printf '{\n'
printf '  "ok": true,\n'
printf '  "branch": "%s",\n' "${BRANCH_NAME}"
printf '  "head_sha": "%s",\n' "${HEAD_SHA}"
printf '  "output_dir": "%s",\n' "${OUT_DIR}"
printf '  "bundle_path": "%s"\n' "${BUNDLE_PATH}"
printf '}\n'
