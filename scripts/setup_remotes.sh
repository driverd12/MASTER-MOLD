#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/setup_remotes.sh [--github-url URL] [--gitea-url URL]

Renames remotes and configures:
  - origin -> github
  - github remote URL
  - gitea remote URL
  - combined remote "all" that pushes to github and gitea
USAGE
  exit 1
}

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "setup_remotes.sh must be run inside a git repository" >&2
  exit 1
fi

github_url=""
gitea_url=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --github-url)
      github_url="$2"
      shift 2
      ;;
    --gitea-url)
      gitea_url="$2"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

if [[ -z "$github_url" ]]; then
  if git remote | grep -qx 'origin'; then
    old_origin_url="$(git remote get-url origin)"
    github_url="${old_origin_url//MCPlayground---Core-Template/master-mold}"
    github_url="${github_url//MCPLAYGROUND---Core-Template/master-mold}"
  else
    github_url=""
  fi
fi

if [[ -z "$gitea_url" ]]; then
  if git remote | grep -qx 'git-tea'; then
    old_gitea_url="$(git remote get-url git-tea)"
    gitea_url="${old_gitea_url//SUPERPOWERS--Local-First-Agent-Orchestration---MCP-Runtime/master-mold--Local-First-Agent-Orchestration---MCP-Runtime}"
    gitea_url="${gitea_url//superpowers--Local-First-Agent-Orchestration---MCP-Runtime/master-mold--Local-First-Agent-Orchestration---MCP-Runtime}"
  else
    gitea_url=""
  fi
fi

if [[ -z "$github_url" || -z "$gitea_url" ]]; then
  echo "Failed to infer remote URLs. Please provide both URLs explicitly:" >&2
  echo "  --github-url <url> --gitea-url <url>" >&2
  exit 1
fi

if git remote | grep -qx 'origin'; then
  git remote rename origin github
fi

if git remote | grep -qx 'github'; then
  git remote set-url github "$github_url"
else
  git remote add github "$github_url"
fi

if git remote | grep -qx 'git-tea'; then
  git remote rename git-tea gitea
fi

if git remote | grep -qx 'gitea'; then
  git remote set-url gitea "$gitea_url"
else
  git remote add gitea "$gitea_url"
fi

if git remote | grep -qx 'all'; then
  git remote remove all
fi

git remote add all "$github_url"
git remote set-url --add --push all "$gitea_url"

git remote -v
