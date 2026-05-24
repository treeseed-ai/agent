#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -n "${TREESEED_AGENT_ENV_FILE:-}" ]]; then
  echo "TREESEED_AGENT_ENV_FILE is deprecated. Store provider values with trsd config and launch through Treeseed commands so the environment is injected."
  exit 1
fi

cd "${PACKAGE_ROOT}"

if [[ ! -f "${PACKAGE_ROOT}/dist/services/manager.js" ]]; then
  npm run build
fi

exec npm run start:manager
