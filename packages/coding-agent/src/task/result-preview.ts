import { replaceTabs } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";

/** Unwrap transport-only task results for existing transcript preview renderers. */
export function formatTaskResultPreview(text: string): string {
	let body = text;
	let abortReason: string | undefined;
	if (text.trimStart().startsWith("<task-result ")) {
		const output = /<(output|preview)(?:\s[^>]*)?>\n?([\s\S]*)\n?<\/\1>/.exec(text);
		if (output) {
			body = output[2].trim();
			abortReason = /<abort-reason>([\s\S]*)<\/abort-reason>/.exec(text.slice(0, output.index))?.[1].trim();
		}
	}
	try {
		const value: unknown = JSON.parse(body);
		if (typeof value === "string") body = value;
		else if (value && typeof value === "object" && !Array.isArray(value)) {
			const entries = Object.entries(value);
			if (entries.length === 1 && entries[0][0] === "summary" && typeof entries[0][1] === "string")
				body = entries[0][1];
		}
	} catch {
		// Prose, incomplete previews and arbitrary tool data retain their contents.
	}
	if (abortReason) body = `${abortReason}\n\n${body}`;
	return replaceTabs(sanitizeText(body));
}
