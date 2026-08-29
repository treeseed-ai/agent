#!/usr/bin/env sh
set -eu

if [ "$(id -u)" = "0" ]; then
	echo "TreeSeed provider manager and runner containers must run unprivileged." >&2
	exit 78
fi

DATA_DIR="${TREESEED_PROVIDER_DATA_DIR:-/data}"
if [ -n "${TREESEED_PROVIDER_CREDENTIAL_HISTORICAL_KEY_FILES:-}" ]; then
	node ./dist/provider/security/rewrap-vault.js "$DATA_DIR"
fi

exec node ./dist/provider/lifecycle/entrypoint.js "$@"
