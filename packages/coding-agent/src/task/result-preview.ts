import { sanitizeText } from "@oh-my-pi/pi-utils";

/** Unwrap transport-only task results for existing transcript preview renderers. */
export function formatTaskResultPreview(text: string): string {
	let body = text;
	if (text.trimStart().startsWith("<task-result ")) {
		const output = /<(output|preview)(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/\1>/.exec(text)?.[2];
		if (output !== undefined) body = output.trim();
	}
	try {
		const value: unknown = JSON.parse(body);
		if (typeof value === "string") return sanitizeText(value);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			const entries = Object.entries(value);
			if (entries.length === 1 && typeof entries[0][1] === "string") return sanitizeText(entries[0][1]);
		}
	} catch {
		// Prose, incomplete previews and arbitrary tool data retain their contents.
	}
	return body;
}
