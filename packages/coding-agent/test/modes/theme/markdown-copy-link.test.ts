import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getMarkdownTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/tui-adapters";
import { resolveCopyBlock, supportsCopyUrlHandler } from "@oh-my-pi/pi-coding-agent/utils/copy-store";
import { Markdown, TERMINAL } from "@oh-my-pi/pi-tui";

const originalHyperlinks = TERMINAL.hyperlinks;

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
	TERMINAL.hyperlinks = true;
});

afterAll(() => {
	TERMINAL.hyperlinks = originalHyperlinks;
	resetSettingsForTest();
});

describe("Markdown copy link", () => {
	it("renders a real OSC 8 target that decodes to the original code", () => {
		const code = "const value = 1;\n";
		const footer = new Markdown(`\`\`\`ts\n${code}\`\`\``, 0, 0, getMarkdownTheme()).render(80).at(-1) ?? "";
		const target = /\x1b\]8;;(omp-copy:[^\x07]+)\x07/.exec(footer)?.[1];

		expect(target).toBeDefined();
		expect(resolveCopyBlock(target!)).toBe(code.trimEnd());
		expect(footer).toContain("[copy]");
	});

	it("emits clickable copy targets only on platforms with an installed handler path", () => {
		expect(supportsCopyUrlHandler("linux")).toBe(true);
		expect(supportsCopyUrlHandler("darwin")).toBe(false);
		expect(supportsCopyUrlHandler("win32")).toBe(false);
	});
});
