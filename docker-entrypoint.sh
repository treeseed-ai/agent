#!/usr/bin/env sh
set -eu

DATA_DIR="${TREESEED_PROVIDER_DATA_DIR:-/data}"
APP_UID="${TREESEED_PROVIDER_UID:-65532}"
APP_GID="${TREESEED_PROVIDER_GID:-65532}"
CHOWN_DATA="${TREESEED_PROVIDER_CHOWN_DATA:-1}"

mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
	if [ "$CHOWN_DATA" != "0" ]; then
		chown -R "$APP_UID:$APP_GID" "$DATA_DIR"
	fi
	exec setpriv --reuid "$APP_UID" --regid "$APP_GID" --clear-groups node ./dist/provider/lifecycle/entrypoint.js "$@"
fi

exec node ./dist/provider/lifecycle/entrypoint.js "$@"
