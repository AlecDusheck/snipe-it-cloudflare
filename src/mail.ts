import { EmailMessage } from "cloudflare:email";
import PostalMime from "postal-mime";

// Snipe-IT's sendmail transport pipes raw MIME to a shim that POSTs it here; the message goes to
// Email Service as-is, once per recipient. Only the header block is parsed.
export async function mailGateway(request: Request, env: Cloudflare.Env): Promise<Response> {
	if (request.method !== "POST") return new Response(null, { status: 404 });
	const raw = await request.text();
	const headerEnd = raw.search(/\r?\n\r?\n/);
	const mail = await PostalMime.parse(headerEnd < 0 ? raw : raw.slice(0, headerEnd));
	const from = mail.from?.address;
	if (!from) return new Response("no sender", { status: 400 });
	const recipients = [...(mail.to ?? []), ...(mail.cc ?? []), ...(mail.bcc ?? [])]
		.map((a) => a.address)
		.filter((a): a is string => typeof a === "string");
	if (recipients.length === 0) return new Response("no recipients", { status: 400 });
	// a real sendmail strips Bcc before handing the message on
	const stripped = raw.replace(/^Bcc:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*\r?\n/im, "");
	await Promise.all(recipients.map((to) => env.EMAIL.send(new EmailMessage(from, to, stripped))));
	return new Response(`sent to ${recipients.length}\n`);
}
