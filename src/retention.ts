import { listAll, PREFIX } from "./r2gateway";

const DUMPS = `${PREFIX}db/dump/`;
const BINLOGS = `${PREFIX}db/binlog/`;
const ARCHIVE = `${PREFIX}db/archive/`;
const metaKey = (dump: string) => dump.replace(/\.sql\.gz$/, ".meta.json");

// Nightly: copy the latest checkpoint into db/archive/YYYY-MM-DD.sql.gz, drop archives past
// KEEP_ARCHIVE_DAYS, keep the newest KEEP_CHECKPOINTS dumps and only the binlogs they need.
export async function archiveAndPrune(env: Cloudflare.Env): Promise<string> {
	const latest = await (await env.STATE.get(`${PREFIX}db/LATEST`))?.text();
	if (!latest) return "no checkpoint yet";

	const day = new Date().toISOString().slice(0, 10);
	const cutoff = new Date(Date.now() - Number(env.KEEP_ARCHIVE_DAYS) * 86_400_000).toISOString().slice(0, 10);
	const [dump, archives, dumps] = await Promise.all([
		env.STATE.get(`${DUMPS}${latest}.sql.gz`),
		listAll(env, ARCHIVE),
		listAll(env, DUMPS),
	]);
	if (dump) await env.STATE.put(`${ARCHIVE}${day}.sql.gz`, dump.body);

	const oldArchives = archives
		.map((o) => o.key)
		.filter((k) => k.slice(ARCHIVE.length, ARCHIVE.length + 10) < cutoff);
	const sqlDumps = dumps.map((o) => o.key).filter((k) => k.endsWith(".sql.gz"));
	const stale = sqlDumps.slice(0, Math.max(0, sqlDumps.length - Math.max(2, Number(env.KEEP_CHECKPOINTS))));
	await env.STATE.delete([...oldArchives, ...stale, ...stale.map(metaKey)]);

	const oldest = sqlDumps[stale.length];
	let logs = 0;
	if (oldest) {
		const meta: unknown = await (await env.STATE.get(metaKey(oldest)))?.json();
		const floor =
			typeof meta === "object" && meta !== null && "binlog_file" in meta ? meta.binlog_file : null;
		if (typeof floor === "string") {
			const dead = (await listAll(env, BINLOGS))
				.map((o) => o.key)
				.filter((k) => k.slice(BINLOGS.length) < floor);
			await env.STATE.delete(dead);
			logs = dead.length;
		}
	}
	return `archived ${day}, removed ${oldArchives.length} archives, ${stale.length} dumps, ${logs} binlogs`;
}
