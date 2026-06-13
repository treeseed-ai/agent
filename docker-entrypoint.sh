#!/usr/bin/env sh
set -eu

DATA_DIR="${TREESEED_PROVIDER_DATA_DIR:-/data}"
APP_UID="${TREESEED_PROVIDER_UID:-65532}"
APP_GID="${TREESEED_PROVIDER_GID:-65532}"

mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
	chown -R "$APP_UID:$APP_GID" "$DATA_DIR"
	exec setpriv --reuid "$APP_UID" --regid "$APP_GID" --clear-groups node ./dist/provider/entrypoint.js "$@"
fi

exec node ./dist/provider/entrypoint.js "$@"
