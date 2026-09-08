#!/bin/bash
set -euo pipefail

STATE_DIR=/var/lib/snipeit
APP_DIR=/var/www/html
R2=http://r2.snipe-cf.internal

log() { printf '[snipe-cf] %s\n' "$*" >&2; }
die() { status error "$*"; exit 1; }

# status <phase> [detail] — reported to the Durable Object, which logs the detail
status() {
	log "$1${2:+: $2}"
	jq -nc --arg p "$1" --arg d "${2:-}" '{phase:$p,detail:$d}' \
		| curl -fsS --max-time 5 -H 'content-type: application/json' --data-binary @- http://do.snipe-cf.internal/status -o /dev/null \
		|| log "status push failed ($1)"
}

# until_ok <tries> <cmd...> — retry once a second
until_ok() { for _ in $(seq "$1"); do "${@:2}" && return; sleep 1; done; return 1; }

r2_get()  { curl -fsS --retry 3 "$R2/$1" -o "$2"; }
r2_put()  { curl -fsS --retry 3 -T "$2" "$R2/$1" -o /dev/null; }
r2_list() { curl -fsS --retry 3 "$R2/?list=$1"; }

sql() { mariadb --protocol=socket -uroot "$@"; }

app_version() {
	sed -n "s/.*'app_version' *=> *'\([^']*\)'.*/\1/p" "$APP_DIR/config/version.php" 2>/dev/null | head -1
}

# Passport keys are the only local state besides the database; losing them invalidates every API token
keys_restore() {
	mkdir -p "$STATE_DIR/keys"
	for k in oauth-private.key oauth-public.key; do
		[ -f "$STATE_DIR/keys/$k" ] || r2_get "keys/$k" "$STATE_DIR/keys/$k" 2>/dev/null || rm -f "$STATE_DIR/keys/$k"
	done
	chown -R apache "$STATE_DIR/keys"
}
keys_save() {
	for k in "$STATE_DIR"/keys/*.key; do [ -f "$k" ] && r2_put "keys/$(basename "$k")" "$k"; done
}
