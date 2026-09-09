import { Container } from "@cloudflare/containers";
import { mailGateway } from "./mail";
import { r2Gateway } from "./r2gateway";
import { s3Gateway } from "./s3";
import { type Phase, parseReport, status, type Status } from "./status";
import { wakeScreen } from "./wake";

const APP_PORT = 80;
const STATUS_PATH = "/.snipe-cf.json";
const ERROR_BACKOFF_MS = 60_000;
// a fresh deploy can take minutes before an instance can be placed
const START_GRACE_MS = 10 * 60_000;

export class SnipeITContainer extends Container {
	override defaultPort = APP_PORT;
	// the default check fetches "/", which Snipe-IT answers with a redirect the check can't follow
	override pingEndpoint = "localhost/robots.txt";
	private readonly neverSleep = this.env.SLEEP_AFTER === "0";
	// "0" is not a valid duration; never-sleep is implemented in onActivityExpired instead
	override sleepAfter = this.neverSleep ? "1h" : this.env.SLEEP_AFTER;

	override async onActivityExpired(): Promise<void> {
		if (!this.neverSleep) await this.stop();
	}

	override async onStop({ exitCode, reason }: { exitCode: number; reason: string }): Promise<void> {
		console.log(`container stopped: exit ${exitCode} (${reason})`);
		const last = await this.ctx.storage.get<Status>("status");
		if (last?.phase !== "error") await this.setPhase("stopped");
		// a self-update exits on purpose; when never sleeping, come straight back
		if (this.neverSleep && exitCode === 0) await this.schedule(1, "wake");
	}

	/** Pushed by the container through the do.snipe-cf.internal outbound handler. */
	async setPhase(phase: Phase, detail = ""): Promise<void> {
		console.log(`phase ${phase}${detail && `: ${detail}`}`);
		await this.ctx.storage.put("status", status(phase));
	}

	async status(): Promise<Status> {
		const last = (await this.ctx.storage.get<Status>("status")) ?? status("stopped");
		if (last.phase === "error" || !this.ctx.container?.running) return last;
		return last.phase === "stopped" ? status("starting") : last;
	}

	async wake(): Promise<Status> {
		const current = await this.status();
		const age = Date.now() - current.since;
		if (current.phase === "error" && age < ERROR_BACKOFF_MS) return current;
		if (current.phase !== "stopped" && current.phase !== "error") return current;
		try {
			await this.setPhase("starting");
			await this.start({ envVars: await this.startEnv() });
		} catch (err) {
			// usually "no container instance available" while a fresh deploy is still provisioning
			console.error("start failed", err);
			if (current.phase === "stopped" && age < START_GRACE_MS) {
				await this.ctx.storage.put("status", current);
			} else {
				await this.setPhase("error");
			}
		}
		return this.status();
	}

	// polls wake(), not status(), so a container that stops mid-wait is started again
	private async waitUntilReady(deadline: number): Promise<Status> {
		let current = await this.wake();
		while (current.phase !== "ready" && current.phase !== "error" && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 500));
			current = await this.wake();
		}
		return current;
	}

	private async secret(key: string, prefix = ""): Promise<string> {
		let value = await this.ctx.storage.get<string>(key);
		if (!value) {
			value = prefix + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
			await this.ctx.storage.put(key, value);
		}
		return value;
	}

	// Every string in the Worker env (vars and secrets) reaches Snipe-IT verbatim; the fixed block
	// wins so nothing can point the app at another database or filesystem.
	private async startEnv(): Promise<Record<string, string>> {
		const [appKey, dbPassword, appUrl] = await Promise.all([
			this.secret("appKey", "base64:"),
			this.secret("dbPassword"),
			this.ctx.storage.get<string>("appUrl"),
		]);
		const passthrough = Object.fromEntries(
			Object.entries(this.env).filter((e): e is [string, string] => typeof e[1] === "string"),
		);
		const url = passthrough.APP_URL ?? appUrl ?? "http://localhost";
		return {
			APP_ENV: "production",
			APP_DEBUG: "false",
			SECURE_COOKIES: String(url.startsWith("https://")),
			MAIL_MAILER: "sendmail",
			MAIL_SENDMAIL_PATH: "/opt/snipeit-cf/sendmail -t -i",
			APP_URL: url,
			...passthrough,
			APP_KEY: appKey,
			APP_TRUSTED_PROXIES: "*",
			DB_CONNECTION: "mariadb",
			DB_HOST: "localhost",
			DB_SOCKET: "/run/mysqld/mysqld.sock",
			DB_DATABASE: "snipeit",
			DB_USERNAME: "snipeit",
			DB_PASSWORD: dbPassword,
			DB_DUMP_PATH: "/usr/bin",
			// database sessions survive sleep/wake; file sessions would log everyone out
			SESSION_DRIVER: "database",
			CACHE_DRIVER: "file",
			QUEUE_CONNECTION: "sync",
			// uploads go straight to R2 through the S3 gateway; nothing to restore on boot
			PRIVATE_FILESYSTEM_DISK: "s3_private",
			PUBLIC_FILESYSTEM_DISK: "s3_public",
			PUBLIC_S3_PROXY: "true",
			BACKUP_FILESYSTEM_DRIVER: "s3",
			BACKUP_FILESYSTEM_ROOT: "backups",
			...s3Disk("PRIVATE", "private"),
			...s3Disk("PUBLIC", "public"),
		};
	}

	// Updates are applied at boot, so a running container just needs a graceful stop.
	async restartIfOutdated(): Promise<string> {
		if ((await this.status()).phase !== "ready" || !this.ctx.container?.running) return "not running";
		const proc = await this.ctx.container.exec(["/opt/snipeit-cf/update.sh", "check"], { stderr: "ignore" });
		const { stdout } = await proc.output();
		const check: unknown = JSON.parse(new TextDecoder().decode(stdout));
		const outdated =
			typeof check === "object" &&
			check !== null &&
			"update_available" in check &&
			check.update_available === true;
		if (outdated) await this.stop();
		return outdated ? "update available, restarting" : "up to date";
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		await this.learnAppUrl(url);
		if (url.pathname === STATUS_PATH) {
			const { phase } = url.searchParams.get("wake") === "1" ? await this.wake() : await this.status();
			return Response.json({ phase }, { headers: { "cache-control": "no-store" } });
		}

		const api = isApiRequest(request);
		// API clients wait; browsers get the wake screen after a short grace period
		const { phase } = await this.waitUntilReady(Date.now() + (api ? 100_000 : 2_500));
		if (phase === "ready") {
			// the hop to the container is plain HTTP; Apache maps this back to HTTPS=on for PHP
			const headers = new Headers(request.headers);
			headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
			return this.containerFetch(new Request(request, { headers }), APP_PORT);
		}

		const headers = { "retry-after": "5", "cache-control": "no-store" };
		if (api) {
			const messages = `Snipe-IT is not available (${phase}). Retry shortly.`;
			return Response.json({ status: "error", messages }, { status: 503, headers });
		}
		return new Response(wakeScreen(phase), {
			status: 503,
			headers: { ...headers, "content-type": "text/html; charset=utf-8" },
		});
	}

	// Laravel needs an absolute APP_URL; taken from the first request instead of asked for at setup.
	// Set APP_URL in wrangler.jsonc to override (e.g. after adding a custom domain).
	private async learnAppUrl(url: URL): Promise<void> {
		if (url.hostname === "localhost" || (await this.ctx.storage.get("appUrl"))) return;
		await this.ctx.storage.put("appUrl", url.origin);
	}
}

// Virtual hosts the container talks to. Requests never leave Cloudflare and need no credentials:
// the handler runs in the Worker with the bindings, and ctx.containerId proves who is calling.
SnipeITContainer.outboundByHost = {
	"r2.snipe-cf.internal": r2Gateway,
	"s3.snipe-cf.internal": s3Gateway,
	"mail.snipe-cf.internal": mailGateway,
	"do.snipe-cf.internal": async (request, env, ctx) => {
		const report = parseReport(await request.json());
		if (!report) return new Response("bad status", { status: 400 });
		await env.SNIPEIT.get(env.SNIPEIT.idFromString(ctx.containerId)).setPhase(report.phase, report.detail);
		return new Response(null);
	},
};

function s3Disk(scope: "PRIVATE" | "PUBLIC", bucket: string): Record<string, string> {
	return {
		[`${scope}_AWS_ACCESS_KEY_ID`]: "snipe",
		[`${scope}_AWS_SECRET_ACCESS_KEY`]: "snipe",
		[`${scope}_AWS_DEFAULT_REGION`]: "auto",
		[`${scope}_AWS_BUCKET`]: bucket,
		[`${scope}_AWS_ENDPOINT`]: "http://s3.snipe-cf.internal",
		[`${scope}_AWS_PATH_STYLE`]: "true",
	};
}

function isApiRequest(request: Request): boolean {
	if (new URL(request.url).pathname.startsWith("/api/")) return true;
	const accept = request.headers.get("accept") ?? "";
	return accept.includes("application/json") || !accept.includes("text/html");
}
