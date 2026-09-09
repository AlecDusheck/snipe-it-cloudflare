#!/bin/bash
. /opt/snipeit-cf/common.sh
LIB=/opt/snipeit-cf

# any unguarded failure reports the error phase before set -e exits
trap 'status error "$BASH_COMMAND"' ERR

shutdown() {
	status stopping
	supervisorctl stop httpd scheduler shipper checkpointer >/dev/null 2>&1 || true
	"$LIB/db.sh" checkpoint || log "final checkpoint failed"
	supervisorctl shutdown >/dev/null 2>&1 || true
}

# /run is a fresh tmpfs at runtime; directories baked into the image do not survive
mkdir -p /run/snipe-cf /run/apache2 && chown apache:apache /run/apache2
# the container's stdout is a socket, which supervisord cannot open as /dev/stdout (ENXIO); a pipe can be
exec > >(cat) 2>&1
status starting
"$LIB/db.sh" init
supervisord -c /etc/supervisord.conf &
SUPERVISOR=$!
trap shutdown TERM INT

until_ok 20 r2_list db/ >/dev/null || die "cannot reach R2 through the Worker"
until_ok 60 mariadb-admin --protocol=socket -uroot ping >/dev/null 2>&1 || die "MariaDB did not start: $(supervisorctl status mariadb) $(grep -i error /run/snipe-cf/mariadb.log | tail -n 3)"
"$LIB/db.sh" ensure-user
"$LIB/db.sh" restore
keys_restore
"$LIB/update.sh" apply || log "update failed, keeping $(app_version)"

status migrating
# upstream's startup script does the Laravel prep; only its final exec is dropped
grep -v '^exec httpd' /startup.sh > /run/snipe-cf/prep.sh
(cd "$APP_DIR" && bash /run/snipe-cf/prep.sh && php artisan migrate --force && php artisan config:cache && php artisan view:cache) >/dev/null
[ -f "$STATE_DIR/keys/oauth-private.key" ] || (cd "$APP_DIR" && su-exec apache php artisan passport:keys --no-interaction >/dev/null) || true
keys_save || log "could not save Passport keys"

"$LIB/db.sh" checkpoint
# supervisord autorestarts anything that stumbles here; only the web server is fatal
supervisorctl start httpd scheduler shipper checkpointer >/dev/null || log "$(supervisorctl status | tr -s ' ' | tr '\n' ';')"
until_ok 60 curl -fsS -o /dev/null http://127.0.0.1/robots.txt || die "web server did not start: $(supervisorctl status httpd)"
status ready "Snipe-IT $(app_version)"

# wait returns when the trap fires; loop until supervisord is really gone
while kill -0 "$SUPERVISOR" 2>/dev/null; do wait "$SUPERVISOR" || true; done
