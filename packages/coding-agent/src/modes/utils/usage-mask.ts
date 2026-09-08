/**
 * Privacy masking for account labels in `/usage`: `mai@x.com (org)` → `mai*** (org)`.
 * Opaque identities without an `@` are masked regardless of length; report
 * placeholders pass through. Colliding masks receive stable ordinals.
 */
import { getSegmenter, replaceTabs } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";

export const MASK_STARS = "***";
const PLACEHOLDER_LABEL = /^account \d+$/;

/** Normalize provider-controlled account metadata for single-line display. */
export function normalizeUsageAccountLabel(label: string): string {
	return replaceTabs(sanitizeText(label)).replace(/[\r\n]+/g, " ");
}

export function maskAccountLabel(label: string, enabled: boolean): string {
	if (!enabled || label.length === 0) return label;
	const at = label.indexOf("@");
	let identityEnd: number;
	if (at > 0) identityEnd = at;
	else {
		if (PLACEHOLDER_LABEL.test(label)) return label;
		const space = label.indexOf(" ");
		identityEnd = space === -1 ? label.length : space;
	}
	const suffixStart = label.indexOf(" ", identityEnd);
	const suffix = suffixStart === -1 ? "" : label.slice(suffixStart);
	let visibleLocal = "";
	let count = 0;
	let lastStart = 0;
	for (const { segment } of getSegmenter().segment(label.slice(0, identityEnd))) {
		count++;
		if (count > 3) break;
		lastStart = visibleLocal.length;
		visibleLocal += segment;
	}
	if (at <= 0 && count <= 3) visibleLocal = visibleLocal.slice(0, lastStart);
	return `${visibleLocal}${MASK_STARS}${suffix}`;
}

export type AccountMasker = (label: string) => string;

export function createAccountMasker(labels: Iterable<string>, enabled: boolean): AccountMasker {
	if (!enabled) return label => label;
	const resolved = new Map<string, string>();
	const seen = new Map<string, number>();
	for (const label of labels) {
		if (resolved.has(label)) continue;
		const masked = maskAccountLabel(label, true);
		const count = (seen.get(masked) ?? 0) + 1;
		seen.set(masked, count);
		resolved.set(label, count === 1 ? masked : insertOrdinal(masked, count));
	}
	return label => resolved.get(label) ?? maskAccountLabel(label, true);
}

function insertOrdinal(masked: string, ordinal: number): string {
	const stars = masked.indexOf(MASK_STARS);
	if (stars === -1) return `${masked} (${ordinal})`;
	const end = stars + MASK_STARS.length;
	return `${masked.slice(0, end)} (${ordinal})${masked.slice(end)}`;
}
