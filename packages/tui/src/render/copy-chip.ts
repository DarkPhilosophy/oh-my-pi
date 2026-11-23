import type { Theme } from "../theme/theme";
import { getMarkdownTheme } from "../theme/tui-adapters";
import { isHyperlinkEnabled, uriHyperlink } from "./hyperlink";

/** The Markdown clipboard transport, when the terminal and its handler are ready. */
export function getCopyChipTarget(): ((text: string) => string | undefined) | undefined {
	return isHyperlinkEnabled() ? getMarkdownTheme().copyChipTarget : undefined;
}

/** Render a copy control for the original text, not its colored or cropped preview. */
export function renderCopyChip(source: string, theme: Theme, subject?: "input" | "output"): string | undefined {
	const target = getCopyChipTarget();
	if (!target) return undefined;
	const { copyChip } = getMarkdownTheme();
	if (!copyChip) return undefined;
	const text = Bun.stripANSI(source);
	if (!text.trim()) return undefined;
	const href = target(text);
	const label = subject === undefined ? copyChip : `${copyChip} ${subject}`;
	return href ? uriHyperlink(href, theme.fg("dim", `[${label}]`)) : undefined;
}
