import { PREFIX } from "./r2gateway";

const ROOT = `${PREFIX}files/`;

// Just enough of the S3 REST API for Flysystem's AWS adapter, backed by the R2 binding.
// Path-style: /<bucket>/<key>. Auth headers are ignored; only the container can reach this host.
export async function s3Gateway(request: Request, env: Cloudflare.Env): Promise<Response> {
	const url = new URL(request.url);
	const [bucket = "", ...rest] = url.pathname.replace(/^\/+/, "").split("/");
	const key = decodeURIComponent(rest.join("/"));
	if ((bucket !== "private" && bucket !== "public") || key.includes(".."))
		return s3Error(404, "NoSuchBucket");
	const base = `${ROOT}${bucket}/`;
	const q = url.searchParams;

	if (!key) {
		if (request.method === "HEAD") return new Response(null);
		if (request.method === "GET") return list(env, base, bucket, q);
		if (request.method === "POST" && q.has("delete")) {
			const keys = [...(await request.text()).matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => unxml(m[1] ?? ""));
			await env.STATE.delete(keys.map((k) => base + k));
			return xml(
				`<DeleteResult>${keys.map((k) => `<Deleted><Key>${esc(k)}</Key></Deleted>`).join("")}</DeleteResult>`,
			);
		}
		return s3Error(405, "MethodNotAllowed");
	}

	const full = base + key;
	switch (request.method) {
		case "GET": {
			if (q.has("acl")) return xml(ACL);
			const object = await env.STATE.get(full, { range: request.headers });
			if (!object) return s3Error(404, "NoSuchKey");
			const headers = objectHeaders(object);
			if (request.headers.has("range") && object.range) {
				const { offset = 0, length = object.size - offset } = "offset" in object.range ? object.range : {};
				headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
				return new Response(object.body, { status: 206, headers });
			}
			return new Response(object.body, { headers });
		}
		case "HEAD": {
			const object = await env.STATE.head(full);
			return object
				? new Response(null, { headers: objectHeaders(object) })
				: new Response(null, { status: 404 });
		}
		case "PUT": {
			if (q.has("acl")) return new Response(null);
			const upload = q.get("uploadId");
			const part = Number(q.get("partNumber"));
			if (upload && part) {
				const { etag } = await env.STATE.resumeMultipartUpload(full, upload).uploadPart(
					part,
					await request.arrayBuffer(),
				);
				return new Response(null, { headers: { etag: `"${etag}"` } });
			}
			const source = request.headers.get("x-amz-copy-source");
			if (source) {
				const [srcBucket = "", ...srcRest] = decodeURIComponent(source).replace(/^\/+/, "").split("/");
				const src = await env.STATE.get(`${ROOT}${srcBucket}/${srcRest.join("/")}`);
				if (!src) return s3Error(404, "NoSuchKey");
				const copied = await env.STATE.put(full, src.body, { httpMetadata: src.httpMetadata ?? {} });
				return xml(
					`<CopyObjectResult><ETag>"${copied.etag}"</ETag><LastModified>${copied.uploaded.toISOString()}</LastModified></CopyObjectResult>`,
				);
			}
			const put = await env.STATE.put(full, await uploadBody(request), {
				httpMetadata: { contentType: contentType(request) },
			});
			return new Response(null, { headers: { etag: put.httpEtag } });
		}
		case "POST": {
			if (q.has("uploads")) {
				const { uploadId } = await env.STATE.createMultipartUpload(full, {
					httpMetadata: { contentType: contentType(request) },
				});
				return xml(
					`<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${esc(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
				);
			}
			const upload = q.get("uploadId");
			if (!upload) return s3Error(400, "InvalidRequest");
			const body = await request.text();
			const parts = [...body.matchAll(/<PartNumber>(\d+)<\/PartNumber>\s*<ETag>"?([^"<]+)"?<\/ETag>/g)].map(
				(m) => ({
					partNumber: Number(m[1]),
					etag: m[2] ?? "",
				}),
			);
			const done = await env.STATE.resumeMultipartUpload(full, upload).complete(parts);
			return xml(
				`<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${esc(key)}</Key><ETag>"${done.etag}"</ETag></CompleteMultipartUploadResult>`,
			);
		}
		case "DELETE": {
			const upload = q.get("uploadId");
			if (upload) await env.STATE.resumeMultipartUpload(full, upload).abort();
			else await env.STATE.delete(full);
			return new Response(null, { status: 204 });
		}
		default:
			return s3Error(405, "MethodNotAllowed");
	}
}

async function list(
	env: Cloudflare.Env,
	base: string,
	bucket: string,
	q: URLSearchParams,
): Promise<Response> {
	const prefix = q.get("prefix") ?? "";
	const delimiter = q.get("delimiter") ?? "";
	const cursor = q.get("continuation-token") ?? "";
	const limit = Math.min(Number(q.get("max-keys") ?? 1000), 1000);
	const page = await env.STATE.list({
		prefix: base + prefix,
		limit,
		...(delimiter ? { delimiter } : {}),
		...(cursor ? { cursor } : {}),
	});
	const contents = page.objects
		.map(
			(o) =>
				`<Contents><Key>${esc(o.key.slice(base.length))}</Key><LastModified>${o.uploaded.toISOString()}</LastModified><ETag>"${o.etag}"</ETag><Size>${o.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
		)
		.join("");
	const prefixes = page.delimitedPrefixes
		.map((p) => `<CommonPrefixes><Prefix>${esc(p.slice(base.length))}</Prefix></CommonPrefixes>`)
		.join("");
	const next = page.truncated ? `<NextContinuationToken>${page.cursor}</NextContinuationToken>` : "";
	return xml(
		`<ListBucketResult><Name>${bucket}</Name><Prefix>${esc(prefix)}</Prefix><Delimiter>${esc(delimiter)}</Delimiter><MaxKeys>${limit}</MaxKeys><KeyCount>${page.objects.length}</KeyCount><IsTruncated>${page.truncated}</IsTruncated>${next}${contents}${prefixes}</ListBucketResult>`,
	);
}

const ACL =
	'<AccessControlPolicy><Owner><ID>snipe</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>snipe</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>';

function contentType(request: Request): string {
	return request.headers.get("content-type") ?? "application/octet-stream";
}

// R2 can stream a body only when its length is known up front
function uploadBody(request: Request): Promise<ArrayBuffer> | ReadableStream {
	return request.headers.has("content-length") && request.body ? request.body : request.arrayBuffer();
}

function objectHeaders(object: R2Object): Headers {
	const headers = new Headers({
		"content-length": String(object.size),
		"content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
		etag: object.httpEtag,
		"last-modified": object.uploaded.toUTCString(),
		"accept-ranges": "bytes",
	});
	object.writeHttpMetadata(headers);
	return headers;
}

function xml(body: string, status = 200): Response {
	return new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
		status,
		headers: { "content-type": "application/xml" },
	});
}

function s3Error(status: number, code: string): Response {
	return xml(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`, status);
}

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unxml(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&");
}
