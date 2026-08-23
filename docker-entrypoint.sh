#!/usr/bin/env sh
set -eu

DATA_DIR="${TREESEED_PROVIDER_DATA_DIR:-/data}"
APP_UID="${TREESEED_PROVIDER_UID:-65532}"
APP_GID="${TREESEED_PROVIDER_GID:-65532}"
CHOWN_DATA="${TREESEED_PROVIDER_CHOWN_DATA:-1}"
CODEX_AUTH_SOURCE="${TREESEED_CODEX_AUTH_SOURCE:-}"
CODEX_AUTH_FILE="${TREESEED_CODEX_AUTH_FILE:-$DATA_DIR/credentials/codex-auth.json}"

mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
	if [ "$CHOWN_DATA" != "0" ]; then
		chown -R "$APP_UID:$APP_GID" "$DATA_DIR"
	fi
	if [ -n "$CODEX_AUTH_SOURCE" ]; then
		if [ ! -f "$CODEX_AUTH_SOURCE" ] || [ -L "$CODEX_AUTH_SOURCE" ]; then
			echo "Codex authentication source must be a regular, non-symlink file." >&2
			exit 78
		fi
		case "$CODEX_AUTH_FILE" in
			"$DATA_DIR"/credentials/*) ;;
			*) echo "Codex authentication target must remain in the provider credential directory." >&2; exit 78 ;;
		esac
		mkdir -p "$(dirname "$CODEX_AUTH_FILE")"
		cp "$CODEX_AUTH_SOURCE" "$CODEX_AUTH_FILE"
		chmod 0600 "$CODEX_AUTH_FILE"
		chown "$APP_UID:$APP_GID" "$CODEX_AUTH_FILE"
	fi
	exec setpriv --reuid "$APP_UID" --regid "$APP_GID" --clear-groups node ./dist/provider/lifecycle/entrypoint.js "$@"
fi

exec node ./dist/provider/lifecycle/entrypoint.js "$@"
