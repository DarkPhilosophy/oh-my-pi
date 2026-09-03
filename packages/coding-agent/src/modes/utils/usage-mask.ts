/**
 * Privacy masking for account labels in `/usage`: `mai@x.com (org)` → `mai*** (org)`.
 * Opaque identities without an `@` (account/project ids such as `d660od9t…`)
 * mask the same way — first three graphemes then stars — while the report's own
 * placeholders (`account 2`) pass through, since they carry no identity.
 * Two accounts whose masks collide (`mai1@…` and `mai2@…` both mask to `mai***`)
 * are disambiguated with an ordinal — `mai***`, `mai*** (2)` — so a merged
 * multi-account report stays readable without leaking the local part.
 */
import { getSegmenter } from "@oh-my-pi/pi-tui";

export const MASK_STARS = "***";

const PLACEHOLDER_LABEL = /^account \d+$/;
/** Short human words (`user`, `me`) are not identities worth masking; ids are longer. */
const OPAQUE_ID_MIN_LENGTH = 8;

/** Mask one label independently (no collision handling). */
export function maskAccountLabel(label: string, enabled: boolean): string {
	if (!enabled) return label;
	const at = label.indexOf("@");
	let identityEnd: number;
	if (at > 0) {
		identityEnd = at;
	} else {
		if (PLACEHOLDER_LABEL.test(label)) return label;
		const space = label.indexOf(" ");
		identityEnd = space === -1 ? label.length : space;
		if (identityEnd < OPAQUE_ID_MIN_LENGTH) return label;
	}
	const suffixStart = label.indexOf(" ", identityEnd);
	const suffix = suffixStart === -1 ? "" : label.slice(suffixStart);
	const visibleLocal = [...getSegmenter().segment(label.slice(0, identityEnd))]
		.slice(0, 3)
		.map(segment => segment.segment)
		.join("");
	return `${visibleLocal}${MASK_STARS}${suffix}`;
}

export type AccountMasker = (label: string) => string;

/**
 * Build a masker over a known set of labels. Labels are numbered in first-seen
 * order when their masks collide; labels outside the set fall back to a plain
 * mask. Disabled → identity.
 */
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

/** `mai*** (org)` + 2 → `mai*** (2) (org)`: the ordinal sits right after the stars. */
function insertOrdinal(masked: string, ordinal: number): string {
	const stars = masked.indexOf(MASK_STARS);
	if (stars === -1) return `${masked} (${ordinal})`;
	const end = stars + MASK_STARS.length;
	return `${masked.slice(0, end)} (${ordinal})${masked.slice(end)}`;
}
