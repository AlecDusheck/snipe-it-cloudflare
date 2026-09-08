import type { Phase } from "./status";
import html from "./wake.html";

export function wakeScreen(phase: Phase): string {
	return html.replace("__STATUS__", JSON.stringify({ phase }));
}
