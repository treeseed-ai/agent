#!/usr/bin/env bash
set -euo pipefail

session_id="${TREESEED_DEVELOPMENT_SESSION_ID:?TREESEED_DEVELOPMENT_SESSION_ID is required}"
worktree="${TREESEED_DEVELOPMENT_WORKTREE:?TREESEED_DEVELOPMENT_WORKTREE is required}"
: "${TREESEED_CAPACITY_PROVIDER_MANIFEST:=/etc/treeseed/components/agent/treeseed.capacity-provider.yaml}"
: "${TREESEED_CODEX_AUTH_HOST_FILE:=/etc/treeseed/credentials/agent-codex-auth}"
export TREESEED_CAPACITY_PROVIDER_MANIFEST TREESEED_CODEX_AUTH_HOST_FILE
project="treeseed-agent-${session_id//[^a-zA-Z0-9_-]/-}"
session_root="$worktree/.treeseed/cache/development-sessions/$session_id/provider"
state_file="$session_root/runtime/capacity-state.json"
export TREESEED_PROVIDER_HOST_DATA_DIR="$session_root"

clone_released_connection_custody() {
  local released_container="${TREESEED_RELEASED_PROVIDER_MANAGER_CONTAINER:-treeseed-agent-manager-1}"
  docker inspect "$released_container" >/dev/null 2>&1 || {
    printf 'Released provider connection custody is unavailable for the required development clone.\n' >&2
    return 1
  }
  local released_image
  released_image="$(docker inspect --format '{{.Config.Image}}' "$released_container")"
  docker run --rm --user 0 --volumes-from "$released_container:ro" --volume "$session_root:/candidate" --entrypoint sh "$released_image" -c \
    'cp -a /data/connections.yaml /data/identity-v3.json /data/connections /data/secrets /candidate/'
  docker run --rm --user 0 --env TARGET_URL --volume "$session_root:/candidate" --entrypoint node "$released_image" -e \
    'const fs=require("fs"),root="/candidate/connections"; for(const name of fs.readdirSync(root)){if(!name.endsWith(".json"))continue;const path=`${root}/${name}`,value=JSON.parse(fs.readFileSync(path,"utf8"));value.controlPlaneUrl=process.env.TARGET_URL;fs.writeFileSync(path,`${JSON.stringify(value,null,2)}\n`,{mode:0o600});} const custody="/candidate/connections.yaml";fs.writeFileSync(custody,fs.readFileSync(custody,"utf8").replace(/(^\s*controlPlaneUrl:\s*).+$/gmu,`$1${process.env.TARGET_URL}`),{mode:0o600});' \
    --
}

connect_control_plane_network() {
  local network="${TREESEED_CONTROL_PLANE_DOCKER_NETWORK:-treeseed-platform}"
  local target_url="${TREESEED_DEVELOPMENT_CONTROL_PLANE_URL:-http://api-live:3000}"
  export TARGET_URL="$target_url"
  for service in manager runner; do
    local container="${project}-${service}-1"
    docker network connect "$network" "$container" >/dev/null 2>&1 || true
  done
}

pause_released_provider() {
  docker stop "${TREESEED_RELEASED_PROVIDER_MANAGER_CONTAINER:-treeseed-agent-manager-1}" \
    "${TREESEED_RELEASED_PROVIDER_RUNNER_CONTAINER:-treeseed-agent-runner-1}" >/dev/null
}

restore_released_provider() {
  docker start "${TREESEED_RELEASED_PROVIDER_RUNNER_CONTAINER:-treeseed-agent-runner-1}" \
    "${TREESEED_RELEASED_PROVIDER_MANAGER_CONTAINER:-treeseed-agent-manager-1}" >/dev/null 2>&1 || true
}

remove_candidate_data() {
  local released_container="${TREESEED_RELEASED_PROVIDER_MANAGER_CONTAINER:-treeseed-agent-manager-1}"
  local released_image
  released_image="$(docker inspect --format '{{.Config.Image}}' "$released_container")"
  docker run --rm --user 0 --volume "$session_root:/candidate" --entrypoint sh "$released_image" -c \
    'find /candidate -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +'
  rmdir "$session_root" 2>/dev/null || true
}

compose() {
  docker compose --file compose.capacity-provider.yml --project-name "$project" "$@"
}

drain() {
  compose stop manager >/dev/null 2>&1 || true
  node scripts/development/check-drain.mjs "$state_file"
}

case "${1:-}" in
  rebuild)
    mkdir -p "$session_root"
    drain
    export TARGET_URL="${TREESEED_DEVELOPMENT_CONTROL_PLANE_URL:-http://api-live:3000}"
    clone_released_connection_custody
    npm run capacity-provider:build
    compose build
    trap restore_released_provider ERR
    pause_released_provider
    compose up --remove-orphans --detach
    connect_control_plane_network
    trap - ERR
    exec docker compose --file compose.capacity-provider.yml --project-name "$project" logs --follow
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
    restore_released_provider
    case "$session_root" in
      "$worktree/.treeseed/cache/development-sessions/$session_id/provider") remove_candidate_data ;;
      *) printf 'Refusing unsafe provider cleanup path\n' >&2; exit 1 ;;
    esac
    ;;
  *)
    printf 'usage: %s rebuild|drain|verify|cleanup\n' "$0" >&2
    exit 2
    ;;
esac
