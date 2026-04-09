#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEFAULT_ENV_FILE="${PACKAGE_ROOT}/.env.local-manager-cloudflare"
ENV_FILE="${TREESEED_AGENT_ENV_FILE:-${DEFAULT_ENV_FILE}}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing env file: ${ENV_FILE}"
  echo "Copy ${PACKAGE_ROOT}/.env.local-manager-cloudflare.example to ${DEFAULT_ENV_FILE} and fill in the Cloudflare and gateway values."
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

cd "${PACKAGE_ROOT}"

if [[ ! -f "${PACKAGE_ROOT}/dist/services/manager.js" ]]; then
  npm run build
fi

exec npm run start:manager
