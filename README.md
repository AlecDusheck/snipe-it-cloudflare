# Snipe-IT on Cloudflare

[Snipe-IT](https://github.com/grokability/snipe-it) running entirely on Cloudflare: one container, one R2 bucket, no other services.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/AlecDusheck/snipe-it-cloudflare)

Click, pick a name, open the URL. Snipe-IT's setup wizard does the rest. Requires the Workers Paid plan.

## How it works

```
browser ─▶ Worker ─▶ Durable Object ─▶ container (Apache/PHP 8.4 + MariaDB)
                          ▲                 │  http://*.snipe-cf.internal
                          └── phase ────────┤
                                            ▼
                                    R2: dumps, binlogs, uploads
```

- **Container** runs Snipe-IT and MariaDB together (nothing can route MySQL between two containers). Disk is ephemeral.
- **Database** lives on the container's disk. Binary logs ship to R2 every 15 s, a full dump every 15 min and on shutdown. Boot restores the latest dump and replays the logs. Worst case loss: one shipping interval, only if the host dies without a SIGTERM.
- **Uploads** go straight to R2: the Worker speaks just enough S3 to Snipe-IT's own S3 driver. Nothing to restore on boot.
- **Credentials** don't exist. The container reaches R2, the DO and Email Service through virtual hosts handled by the Worker; `APP_KEY` and the DB password are generated on first boot and kept in DO storage.
- **Sleep** after `SLEEP_AFTER` (1h) of idle. The next visitor sees a wake screen for ~~20 s; API clients just wait. `"0"` keeps it running (~~$28/mo on `standard-1`).
- **Updates** happen at boot: the newest release on `SNIPEIT_TRACK` (`v8`) is installed from GitHub the way upstream's `upgrade.php` does it. A running container restarts nightly if a release is waiting. Pin with `SNIPEIT_TRACK: "v8.7.2"`.
- **Email** uses Cloudflare Email Service via Snipe-IT's `sendmail` transport. Once: `npx wrangler email sending enable example.com`, then set `MAIL_FROM_ADDR`.

## Configuration

Every string in `wrangler.jsonc` `vars`, and every secret from `wrangler secret put`, is passed to Snipe-IT as-is — use the names from [`.env.example`](https://github.com/grokability/snipe-it/blob/master/.env.example). Database and filesystem settings are fixed.

Crons are UTC and Snipe-IT's scheduled tasks fire at 00:00 `APP_TIMEZONE`; shift the crons if you change the timezone.

## Backups

Under `snipeit/` in the bucket: `db/dump/` (newest `KEEP_CHECKPOINTS`), `db/binlog/`, `db/archive/YYYY-MM-DD.sql.gz` (nightly, `KEEP_ARCHIVE_DAYS`), `files/`, `keys/`. To roll back, stop the container and point `db/LATEST` at a dump:

```sh
npx wrangler r2 object get --remote snipeit-state/snipeit/db/archive/2026-09-01.sql.gz --file a.sql.gz
npx wrangler r2 object put --remote snipeit-state/snipeit/db/dump/1.sql.gz --file a.sql.gz
printf 1 | npx wrangler r2 object put --remote snipeit-state/snipeit/db/LATEST --pipe
```

## Caveats

- One instance, no HA — inherent to a database inside the container.
- The image is only a runtime; hit Redeploy now and then for Alpine/PHP patches. A Snipe-IT major needing a newer PHP refuses to install until you do.
- Cloudflare's container disk snapshots are in the runtime types but undocumented; once they land, the restore path can shrink to one call.

## Development

```sh
npm install
npm run check   # types, tsc, oxlint, oxfmt
npm run deploy  # needs Docker
```
