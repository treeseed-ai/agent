#!/usr/bin/env sh
set -eu

if [ "$(id -u)" = "0" ]; then
	echo "TreeSeed provider manager and runner containers must run unprivileged." >&2
	exit 78
fi

exec node ./dist/provider/lifecycle/entrypoint.js "$@"
