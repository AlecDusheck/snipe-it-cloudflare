#!/bin/bash
. /opt/snipeit-cf/common.sh

REPO=grokability/snipe-it

# newest non-prerelease whose tag is SNIPEIT_TRACK or starts with "SNIPEIT_TRACK."
latest() {
	curl -fsS -H 'accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases?per_page=30" \
		| jq -r --arg t "${SNIPEIT_TRACK:-v8}" '[.[] | select(.prerelease|not) | .tag_name | select(. == $t or startswith($t + "."))][0] // empty'
}

check() {
	local cur new; cur=$(app_version); new=$(latest)
	jq -nc --arg c "$cur" --arg n "$new" '{installed:$c,latest:$n,update_available:($n != "" and $c != $n)}'
}

# Same recipe as upstream's upgrade.php: release tarball + composer install, staged, then swapped in.
apply() {
	local new; new=$(latest)
	[ -n "$new" ] && [ "$new" != "$(app_version)" ] || return 0
	status updating "downloading $new"
	local stage; stage=$(mktemp -d /tmp/snipe-stage.XXXXXX)
	curl -fsSL "https://github.com/$REPO/archive/refs/tags/$new.tar.gz" | tar -xzf - -C "$stage" --strip-components=1 || die "download of $new failed"
	cp "$APP_DIR/.env" "$stage/.env"
	ln -sf "$STATE_DIR/keys/oauth-private.key" "$stage/storage/oauth-private.key"
	ln -sf "$STATE_DIR/keys/oauth-public.key" "$stage/storage/oauth-public.key"
	chown -R apache:apache "$stage"

	status updating "installing dependencies for $new"
	# composer's platform check is the compatibility gate: a release needing a newer PHP fails here, before the swap
	su-exec apache env COMPOSER_CACHE_DIR=/dev/null COMPOSER_MEMORY_LIMIT=-1 HOME=/var/www composer install \
		--working-dir="$stage" --no-dev --no-interaction --prefer-dist --optimize-autoloader --no-progress --quiet \
		|| { rm -rf "$stage"; die "$new does not install on this image's PHP; rebuild the image to update"; }

	rm -rf "$APP_DIR.prev"; mv "$APP_DIR" "$APP_DIR.prev"; mv "$stage" "$APP_DIR"
	if ! (cd "$APP_DIR" && su-exec apache php artisan --version >/dev/null 2>&1); then
		rm -rf "$APP_DIR"; mv "$APP_DIR.prev" "$APP_DIR"
		die "$new failed to boot; rolled back"
	fi
	rm -rf "$APP_DIR.prev"
	log "updated to $(app_version)"
}

case "${1:-}" in
	check|apply) "$1" ;;
	*) echo "usage: update.sh check|apply" >&2; exit 2 ;;
esac
