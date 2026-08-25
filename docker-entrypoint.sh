#!/usr/bin/env sh
set -eu

DATA_DIR="${TREESEED_PROVIDER_DATA_DIR:-/data}"
APP_UID="${TREESEED_PROVIDER_UID:-65532}"
APP_GID="${TREESEED_PROVIDER_GID:-65532}"
CHOWN_DATA="${TREESEED_PROVIDER_CHOWN_DATA:-1}"
CODEX_AUTH_SOURCE="${TREESEED_CODEX_AUTH_SOURCE:-}"
CODEX_AUTH_FILE="${TREESEED_CODEX_AUTH_FILE:-$DATA_DIR/credentials/codex-auth.json}"
MANIFEST_SOURCE="${TREESEED_CAPACITY_PROVIDER_SOURCE:-}"
MANIFEST_FILE="${TREESEED_CAPACITY_PROVIDER_MANIFEST:-$DATA_DIR/config/treeseed.capacity-provider.yaml}"

if [ "$(id -u)" = "0" ] && [ "${1:-}" = "healthcheck" ]; then
	exec setpriv --reuid "$APP_UID" --regid "$APP_GID" --clear-groups node ./dist/provider/lifecycle/entrypoint.js "$@"
fi

mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
	if [ "$CHOWN_DATA" != "0" ]; then
		chown -R "$APP_UID:$APP_GID" "$DATA_DIR"
	fi
	if [ -n "$MANIFEST_SOURCE" ]; then
		if [ ! -f "$MANIFEST_SOURCE" ] || [ -L "$MANIFEST_SOURCE" ]; then
			echo "Capacity-provider manifest source must be a regular, non-symlink file." >&2
			exit 78
		fi
		case "$MANIFEST_FILE" in
			"$DATA_DIR"/config/*) ;;
			*) echo "Capacity-provider manifest target must remain in the provider configuration directory." >&2; exit 78 ;;
		esac
		mkdir -p "$(dirname "$MANIFEST_FILE")"
		cp "$MANIFEST_SOURCE" "$MANIFEST_FILE"
		chmod 0600 "$MANIFEST_FILE"
		chown "$APP_UID:$APP_GID" "$MANIFEST_FILE"
		export TREESEED_CAPACITY_PROVIDER_MANIFEST="$MANIFEST_FILE"
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
