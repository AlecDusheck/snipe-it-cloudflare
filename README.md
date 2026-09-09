# Snipe-IT on Cloudflare

[Snipe-IT](https://github.com/grokability/snipe-it) running entirely on Cloudflare: one container, one R2 bucket, no other services.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/AlecDusheck/snipe-it-cloudflare)

Click, pick a name, open the URL. Snipe-IT's setup wizard does the rest. Requires the Workers Paid plan.

## Motivation
Lots of people already run Snipe-IT behind a Cloudflare Tunnel. At that point, why not run it *on* Cloudflare? This runs Snipe-IT in a container close to your region, with your data checkpointed to R2 automatically, and [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) one click away as an extra layer in front of it.

## Configuration

Every string in `wrangler.jsonc` `vars`, and every secret from `wrangler secret put`, is passed to Snipe-IT as-is — use the names from [`.env.example`](https://github.com/grokability/snipe-it/blob/master/.env.example). Database and filesystem settings are fixed.

Email goes through [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) by default: onboard your domain once with `npx wrangler email sending enable example.com`, then set `MAIL_FROM_ADDR` in `wrangler.jsonc`. To use another provider instead, set `MAIL_MAILER=smtp` and the usual `MAIL_HOST` / `MAIL_PORT` / `MAIL_USERNAME` vars, with `MAIL_PASSWORD` as a secret.

`APP_URL` is taken from the first request; set it explicitly in `vars` once you add a custom domain.

Crons are UTC and Snipe-IT's scheduled tasks fire at 00:00 `APP_TIMEZONE`; shift the crons if you change the timezone.

## Backups

Under `snipeit/` in the bucket: `db/dump/` (newest `KEEP_CHECKPOINTS`), `db/binlog/`, `db/archive/YYYY-MM-DD.sql.gz` (nightly, `KEEP_ARCHIVE_DAYS`), `files/`, `keys/`. To roll back, stop the container and point `db/LATEST` at a dump:

```sh
npx wrangler r2 object get --remote snipeit-state/snipeit/db/archive/2026-09-01.sql.gz --file a.sql.gz
npx wrangler r2 object put --remote snipeit-state/snipeit/db/dump/1.sql.gz --file a.sql.gz
printf 1 | npx wrangler r2 object put --remote snipeit-state/snipeit/db/LATEST --pipe
```

## How it works

![Architecture](docs/architecture.svg)

- **Container** runs Snipe-IT and MariaDB together (nothing can route MySQL between two containers). Disk is ephemeral.
- **Database** lives on the container's disk. Binary logs ship to R2 every 30 s and a full dump every 30 min, both only when something changed, plus a dump on shutdown. Boot restores the latest dump and replays the logs. Worst case loss: one shipping interval, only if the host dies without a SIGTERM.
- **Uploads** go straight to R2: the Worker speaks just enough S3 to Snipe-IT's own S3 driver. Nothing to restore on boot.
- **Credentials** don't exist. The container reaches R2, the DO and Email Service through virtual hosts handled by the Worker; `APP_KEY` and the DB password are generated on first boot and kept in DO storage.
- **Sleep** after `SLEEP_AFTER` (1h) of idle. The next visitor sees a wake screen for ~20 s; API clients just wait. `"0"` keeps it running (~$28/mo on `standard-1`).
- **Updates** happen at boot: the newest release on `SNIPEIT_TRACK` (`v8`) is installed from GitHub the way upstream's `upgrade.php` does it. A running container restarts nightly if a release is waiting. Pin with `SNIPEIT_TRACK: "v8.7.2"`.
- **Email** goes out through Email Service via Snipe-IT's `sendmail` transport; the Worker hands the raw message to the binding.

## Development

```sh
npm install
npm run check   # types, tsc, oxlint, oxfmt
npm run deploy  # needs Docker
```
