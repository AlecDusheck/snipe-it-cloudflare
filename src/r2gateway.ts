export const PREFIX = "snipeit/";
const KEY = /^(db|keys)\/.+$/;

export async function listAll(env: Cloudflare.Env, prefix: string): Promise<R2Object[]> {
	const objects: R2Object[] = [];
	let cursor: string | undefined;
	do {
		const page = await env.STATE.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
		objects.push(...page.objects);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return objects;
}

// Minimal object protocol for the container's own state (db checkpoints, binlogs, keys).
// GET /?list=<prefix> returns "key<TAB>size" lines; everything else is GET/HEAD/PUT/DELETE /<key>.
export async function r2Gateway(request: Request, env: Cloudflare.Env): Promise<Response> {
	const url = new URL(request.url);
	const list = url.searchParams.get("list");
	if (list !== null) {
		const objects = await listAll(env, PREFIX + list.replace(/^\/+/, ""));
		return new Response(objects.map((o) => `${o.key.slice(PREFIX.length)}\t${o.size}\n`).join(""));
	}

	const raw = decodeURIComponent(url.pathname).replace(/^\/+/, "");
	const printable = [...raw].every((c) => c.charCodeAt(0) >= 0x20);
	if (!printable || !KEY.test(raw) || raw.includes("..") || raw.endsWith("/")) {
		return new Response("bad key\n", { status: 400 });
	}
	const key = PREFIX + raw;

	switch (request.method) {
		case "GET": {
			const object = await env.STATE.get(key);
			if (!object) return new Response(null, { status: 404 });
			return new Response(object.body, { headers: { "content-length": String(object.size) } });
		}
		case "HEAD": {
			const object = await env.STATE.head(key);
			return new Response(
				null,
				object ? { headers: { "content-length": String(object.size) } } : { status: 404 },
			);
		}
		case "PUT":
			if (!request.body) return new Response("empty body\n", { status: 400 });
			await env.STATE.put(key, request.body);
			return new Response(null, { status: 201 });
		case "DELETE":
			await env.STATE.delete(key);
			return new Response(null);
		default:
			return new Response(null, { status: 405 });
	}
}
