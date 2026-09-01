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

stage_development_manifest() {
  local workspace_manifest="$worktree/../../treeseed.capacity-provider.yaml"
  local source_manifest="$TREESEED_CAPACITY_PROVIDER_MANIFEST"
  local state_base="${XDG_STATE_HOME:-${HOME:?HOME is required}/.local/state}"
  local guest_receipt="$state_base/treeseed/development/sandbox-guest.json"
  local target_manifest="$session_root/config/treeseed.capacity-provider.yaml"
  if test -r "$workspace_manifest"; then source_manifest="$workspace_manifest"
  elif ! test -r "$source_manifest"; then source_manifest="$session_root/config/released.capacity-provider.yaml"; fi
  test -r "$source_manifest" || { printf 'Released provider manifest is unavailable through host or released-container custody.\n' >&2; return 1; }
  test -r "$guest_receipt" || { printf 'Import the local guest first with `trsd dev host guest image import treeseed/sandbox-codex:local`.\n' >&2; return 1; }
  mkdir -p "$(dirname "$target_manifest")"
  node --input-type=module - "$source_manifest" "$guest_receipt" "$target_manifest" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const [, , source, receiptPath, target] = process.argv;
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
if (receipt.schemaVersion !== 'treeseed.development-sandbox-guest/v1' || !/^sha256:[a-f0-9]{64}$/.test(String(receipt.digest))) throw new Error('Development sandbox guest receipt is invalid.');
const manifest = readFileSync(source, 'utf8');
const matches = manifest.match(/guestImageDigest:\s*sha256:[a-f0-9]{64}/g) ?? [];
if (!matches.length) throw new Error('Provider manifest declares no guest image digest.');
writeFileSync(target, manifest.replace(/guestImageDigest:\s*sha256:[a-f0-9]{64}/g, `guestImageDigest: ${receipt.digest}`), { mode: 0o644 });
NODE
  chmod 0644 "$target_manifest"
  TREESEED_CAPACITY_PROVIDER_MANIFEST="$target_manifest"
  export TREESEED_CAPACITY_PROVIDER_MANIFEST
}

clone_released_connection_custody() {
  if test -f "$session_root/connections.yaml" && test -f "$session_root/identity-v3.json" && test -d "$session_root/connections"; then
    return 0
  fi
  local released_container="${TREESEED_RELEASED_PROVIDER_MANAGER_CONTAINER:-treeseed-agent-manager-1}"
  local source_container="$released_container"
  if ! docker inspect "$source_container" >/dev/null 2>&1; then
    source_container="$(docker ps --filter 'name=treeseed-agent-dev-' --filter status=running --format '{{.Names}}' \
      | grep -- '-manager-1$' | grep -v -- "^${project}-manager-1$" | sort | tail -n 1)"
  fi
  test -n "$source_container" && docker inspect "$source_container" >/dev/null 2>&1 || {
    printf 'Provider connection custody is unavailable for the required development clone.\n' >&2
    return 1
  }
  local released_image
  released_image="$(docker inspect --format '{{.Config.Image}}' "$source_container")"
  docker run --rm --user 0 --env HOST_UID="$(id -u)" --env HOST_GID="$(id -g)" --volumes-from "$source_container:ro" --volume "$session_root:/candidate" --entrypoint sh "$released_image" -c \
    'mkdir -p /candidate/config && cp -a /data/connections.yaml /data/identity-v3.json /data/connections /data/secrets /candidate/ && cp /config/treeseed.capacity-provider.yaml /candidate/config/released.capacity-provider.yaml && chown -R 65532:65532 /candidate && chown "$HOST_UID:$HOST_GID" /candidate/config && chmod 0755 /candidate/config && chmod 0644 /candidate/config/released.capacity-provider.yaml'
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
    "${TREESEED_RELEASED_PROVIDER_RUNNER_CONTAINER:-treeseed-agent-runner-1}" >/dev/null 2>&1 || true
  while read -r container; do
    case "$container" in "${project}-manager-1"|"${project}-runner-1"|'') continue ;; esac
    docker stop "$container" >/dev/null 2>&1 || true
  done < <(docker ps --filter 'name=treeseed-agent-dev-' --format '{{.Names}}' | grep -E -- '-(manager|runner)-1$' || true)
}

restore_released_provider() {
  docker start "${TREESEED_RELEASED_PROVIDER_RUNNER_CONTAINER:-treeseed-agent-runner-1}" \
    "${TREESEED_RELEASED_PROVIDER_MANAGER_CONTAINER:-treeseed-agent-manager-1}" >/dev/null 2>&1 || true
}

remove_candidate_data() {
  local released_container="${TREESEED_RELEASED_PROVIDER_MANAGER_CONTAINER:-treeseed-agent-manager-1}"
  local released_image
  if docker inspect "$released_container" >/dev/null 2>&1; then
    released_image="$(docker inspect --format '{{.Config.Image}}' "$released_container")"
  else
    released_image="${TREESEED_DEVELOPMENT_PROVIDER_RUNNER_IMAGE:-treeseed/agent-runner:local}"
    docker image inspect "$released_image" >/dev/null
  fi
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
  build)
    npm run capacity-provider:build -- --roles base,guest
    trsd dev host guest image import treeseed/sandbox-codex:local
    compose build
    ;;
  start)
    mkdir -p "$session_root"
    drain
    TREESEED_SANDBOX_BROKER_GID="$(stat -c '%g' /run/treeseed/sandbox)"
    export TREESEED_SANDBOX_BROKER_GID
    export TARGET_URL="${TREESEED_DEVELOPMENT_CONTROL_PLANE_URL:-http://api-live:3000}"
    clone_released_connection_custody
    stage_development_manifest
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
    if test "${TREESEED_DEVELOPMENT_CLEANUP_SCOPE:-runtime}" = session; then
      case "$session_root" in
        "$worktree/.treeseed/cache/development-sessions/$session_id/provider") remove_candidate_data ;;
        *) printf 'Refusing unsafe provider cleanup path\n' >&2; exit 1 ;;
      esac
    fi
    ;;
  *)
    printf 'usage: %s build|start|drain|verify|cleanup\n' "$0" >&2
    exit 2
    ;;
esac
