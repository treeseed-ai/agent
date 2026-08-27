#!/usr/bin/env bash
set -euo pipefail

session_id="${TREESEED_DEVELOPMENT_SESSION_ID:?TREESEED_DEVELOPMENT_SESSION_ID is required}"
worktree="${TREESEED_DEVELOPMENT_WORKTREE:?TREESEED_DEVELOPMENT_WORKTREE is required}"
project="treeseed-agent-${session_id//[^a-zA-Z0-9_-]/-}"
session_root="$worktree/.treeseed/cache/development-sessions/$session_id/provider"
state_file="$session_root/runtime/capacity-state.json"
export TREESEED_PROVIDER_HOST_DATA_DIR="$session_root"

compose() {
  docker compose --file compose.capacity-provider.yml --project-name "$project" "$@"
}

drain() {
  compose stop manager >/dev/null 2>&1 || true
  node scripts/development/check-drain.mjs "$state_file"
}

case "${1:-}" in
  rebuild)
    test -f "${TREESEED_CAPACITY_PROVIDER_MANIFEST:?TREESEED_CAPACITY_PROVIDER_MANIFEST is required}"
    test -f "${TREESEED_CODEX_AUTH_HOST_FILE:?TREESEED_CODEX_AUTH_HOST_FILE is required}"
    mkdir -p "$session_root"
    drain
    exec docker compose --file compose.capacity-provider.yml --project-name "$project" up --build --remove-orphans
    ;;
  drain)
    drain
    ;;
  verify)
    test "$(compose ps --status running --services | sort | tr '\n' ' ')" = "manager runner "
    node scripts/development/check-drain.mjs "$state_file"
    npm run test:provider-runtime
    ;;
  cleanup)
    drain
    compose down --remove-orphans
    case "$session_root" in
      "$worktree/.treeseed/cache/development-sessions/$session_id/provider") rm -rf -- "$session_root" ;;
      *) printf 'Refusing unsafe provider cleanup path\n' >&2; exit 1 ;;
    esac
    ;;
  *)
    printf 'usage: %s rebuild|drain|verify|cleanup\n' "$0" >&2
    exit 2
    ;;
esac
