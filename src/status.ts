export const PHASES = [
	"stopped",
	"starting",
	"restoring",
	"updating",
	"migrating",
	"ready",
	"stopping",
	"error",
] as const;
export type Phase = (typeof PHASES)[number];

export interface Status {
	phase: Phase;
	/** when this phase began, ms since epoch */
	since: number;
}

export function status(phase: Phase): Status {
	return { phase, since: Date.now() };
}

export function parseReport(value: unknown): { phase: Phase; detail: string } | null {
	if (typeof value !== "object" || value === null || !("phase" in value)) return null;
	const phase = PHASES.find((p) => p === value.phase);
	const detail = "detail" in value && typeof value.detail === "string" ? value.detail : "";
	return phase ? { phase, detail } : null;
}
