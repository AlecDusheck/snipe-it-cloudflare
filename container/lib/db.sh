#!/bin/bash
. /opt/snipeit-cf/common.sh

BINLOG_DIR=/var/lib/mysql/binlog
DB=snipeit

# Unique binlog prefix per boot so incarnations never overwrite each other's logs in R2.
init() {
	mkdir -p "$BINLOG_DIR" /run/mysqld; chown -R mysql:mysql /var/lib/mysql /run/mysqld
	printf '[mysqld]\nlog_bin = %s/%s-bin\n' "$BINLOG_DIR" "$(date +%s)" > /etc/my.cnf.d/95-binlog.cnf
	[ -d /var/lib/mysql/mysql ] || mariadb-install-db --user=mysql --datadir=/var/lib/mysql --skip-test-db >/dev/null
}

ensure_user() {
	sql <<-SQL
		CREATE DATABASE IF NOT EXISTS \`$DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
		CREATE USER IF NOT EXISTS '$DB'@'localhost';
		ALTER USER '$DB'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
		GRANT ALL ON \`$DB\`.* TO '$DB'@'localhost';
	SQL
}

# restored rows must not be logged again, or the next incarnation would replay them twice
replay() { sql --init-command='SET sql_log_bin=0' "$@"; }

restore() {
	local tmp; tmp=$(mktemp -d)
	r2_get db/LATEST "$tmp/LATEST" 2>/dev/null || { log "no checkpoint in R2, starting fresh"; return; }
	local ts; ts=$(cat "$tmp/LATEST")
	status restoring "checkpoint $ts"
	r2_get "db/dump/$ts.sql.gz" "$tmp/dump.sql.gz" || die "checkpoint $ts is missing from R2"
	gunzip -c "$tmp/dump.sql.gz" | replay "$DB" || die "restore of checkpoint $ts failed"

	# archives restored by hand have no metadata and nothing to replay
	r2_get "db/dump/$ts.meta.json" "$tmp/meta.json" 2>/dev/null || { rm -rf "$tmp"; return; }
	local file pos; file=$(jq -r .binlog_file "$tmp/meta.json"); pos=$(jq -r .binlog_pos "$tmp/meta.json")
	while read -r key; do
		local name=${key#db/binlog/} start=4
		[[ "$name" < "$file" ]] && continue
		[ "$name" = "$file" ] && start=$pos
		status restoring "replaying $name"
		r2_get "$key" "$tmp/$name" || die "binlog $name is missing from R2"
		mariadb-binlog --start-position="$start" "$tmp/$name" | replay || die "replay of $name failed"
	done < <(r2_list "db/binlog/${file%-bin.*}-bin." | cut -f1)
	rm -rf "$tmp"
	log "restored checkpoint $ts"
}

# --master-data=2 records the binlog position inside the dump's own snapshot, so replaying
# from it never re-applies a row the dump already contains.
checkpoint() {
	# nothing committed since the last checkpoint: nothing to write
	local head; head=$(sql -Nse 'SHOW MASTER STATUS' | cut -f1,2)
	[ "$head" != "$(cat /run/snipe-cf/checkpoint.pos 2>/dev/null)" ] || return 0
	local ts tmp; ts=$(date +%s); tmp=$(mktemp -d)
	mariadb-dump --protocol=socket -uroot --single-transaction --quick --master-data=2 \
		--routines --triggers --events "$DB" | gzip > "$tmp/dump.sql.gz"
	local file pos
	read -r file pos < <(gunzip -c "$tmp/dump.sql.gz" | head -40 | sed -n "s/^-- CHANGE MASTER TO MASTER_LOG_FILE='\([^']*\)', MASTER_LOG_POS=\([0-9]*\);.*/\1 \2/p")
	[ -n "$file" ] || { log "dump has no binlog position"; rm -rf "$tmp"; return 1; }
	jq -nc --arg f "$file" --argjson p "$pos" --argjson t "$ts" --arg v "$(app_version)" \
		'{binlog_file:$f,binlog_pos:$p,ts:$t,version:$v}' > "$tmp/meta.json"
	r2_put "db/dump/$ts.sql.gz" "$tmp/dump.sql.gz"
	r2_put "db/dump/$ts.meta.json" "$tmp/meta.json"
	printf '%s' "$ts" > "$tmp/LATEST"; r2_put db/LATEST "$tmp/LATEST"
	printf '%s' "$head" > /run/snipe-cf/checkpoint.pos
	rm -rf "$tmp"
	log "checkpoint $ts (binlog $file:$pos)"
}

# Rotate when the active log grew since the last rotation, ship the closed logs once, purge them locally.
ship() {
	local index active empty=/run/snipe-cf/binlog.empty
	index="$(sql -Nse 'SELECT @@log_bin_basename').index"; active=$(tail -1 "$index")
	[ "$(stat -c %s "$active")" -gt "$(cat "$empty" 2>/dev/null || echo 0)" ] || return 0
	sql -e 'FLUSH BINARY LOGS'
	local next; next=$(tail -1 "$index"); stat -c %s "$next" > "$empty"
	while read -r path; do
		[ "$path" != "$next" ] || continue
		r2_put "db/binlog/$(basename "$path")" "$path"
	done < "$index"
	sql -e "PURGE BINARY LOGS TO '$(basename "$next")'"
}

case "${1:-}" in
	init|ensure-user|restore|checkpoint|ship) "${1//-/_}" ;;
	*) echo "usage: db.sh init|ensure-user|restore|checkpoint|ship" >&2; exit 2 ;;
esac
