import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, highlightCode, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	const darkTheme = await getThemeByName("dark");
	if (!darkTheme) throw new Error("Expected dark theme to exist");
	setThemeInstance(darkTheme);
});

const LINE = "export const value: number = 1; // trailing comment";

describe("synchronous highlight bound", () => {
	it("still highlights an ordinary code block", () => {
		const code = Array.from({ length: 50 }, () => LINE).join("\n");
		const lines = highlightCode(code, "typescript");
		expect(lines).toHaveLength(50);
		// Highlighted output carries ANSI color; plain fallback would not.
		expect(lines[0]).toContain("\x1b[");
	});

	it("renders a many-line body plain even when its bytes are small", () => {
		// 5,000 one-character lines are ~10k characters, yet the tokenizer's cost
		// is per line (~0.7 ms each): highlighting this would freeze the UI for
		// over a second. A character-only bound let it through.
		const code = Array.from({ length: 5000 }, () => "x").join("\n");
		const started = performance.now();
		const lines = highlightCode(code, "typescript");
		const elapsed = performance.now() - started;
		expect(lines).toHaveLength(5000);
		expect(lines[0]).toBe("x");
		expect(elapsed).toBeLessThan(200);
	});

	it("renders an oversized single line plain", () => {
		const code = "const s = '" + "a".repeat(70_000) + "';";
		const lines = highlightCode(code, "typescript");
		expect(lines).toEqual([code]);
	});
});
