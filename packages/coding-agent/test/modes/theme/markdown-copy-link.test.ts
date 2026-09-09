import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getMarkdownTheme, setCopyUrlHandlerReady } from "@oh-my-pi/pi-coding-agent/modes/theme/tui-adapters";
import { copyUrlTarget, resolveCopyBlock, supportsCopyUrlHandler } from "@oh-my-pi/pi-coding-agent/utils/copy-store";
import { Markdown, TERMINAL } from "@oh-my-pi/pi-tui";

const originalHyperlinks = TERMINAL.hyperlinks;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
	TERMINAL.hyperlinks = true;
	setCopyUrlHandlerReady(true);
});

afterEach(() => {
	setCopyUrlHandlerReady(false);
	TERMINAL.hyperlinks = originalHyperlinks;
	resetSettingsForTest();
});

describe("Markdown copy link", () => {
	it("renders the copy chip as an OSC 8 hyperlink carrying the original code", () => {
		const code = "const value = 1;\n";
		const footer = new Markdown(`\`\`\`ts\n${code}\`\`\``, 0, 0, getMarkdownTheme()).render(80).at(-1) ?? "";
		const target = footer.match(/\x1b]8;;(omp-copy:[^\x07]+)\x07/)?.[1];

		expect(target).toBeDefined();
		expect(resolveCopyBlock(target!)).toBe(code.trimEnd());
		expect(footer).toContain("[copy]");
	});

	it("invalidates cached Markdown when copy-handler readiness changes", () => {
		const source = "```ts\nconst cached = true;\n```";
		const renderFooter = () => new Markdown(source, 0, 0, getMarkdownTheme()).render(80).at(-1) ?? "";
		const copyTarget = (footer: string) => footer.match(/\x1b]8;;(omp-copy:[^\x07]+)\x07/)?.[1];

		setCopyUrlHandlerReady(false);
		expect(copyTarget(renderFooter())).toBeUndefined();

		setCopyUrlHandlerReady(true);
		expect(copyTarget(renderFooter())).toBeDefined();

		setCopyUrlHandlerReady(false);
		expect(copyTarget(renderFooter())).toBeUndefined();
	});

	it("copies the parsed body when a list consumes part of a tab", () => {
		const footer = new Markdown("- ```js\n\tx\n  ```", 0, 0, getMarkdownTheme()).render(80).at(-1) ?? "";
		const target = footer.match(/\x1b]8;;(omp-copy:[^\x07]+)\x07/)?.[1];

		expect(target).toBeDefined();
		expect(resolveCopyBlock(target!)).toBe(" x");
	});

	it("preserves a tab when a two-digit list uses its full continuation indent", () => {
		const footer = new Markdown("10. ```js\n    \tfoo\n    ```", 0, 0, getMarkdownTheme()).render(80).at(-1) ?? "";
		const target = footer.match(/\x1b]8;;(omp-copy:[^\x07]+)\x07/)?.[1];

		expect(target).toBeDefined();
		expect(resolveCopyBlock(target!)).toBe("\tfoo");
	});

	it("skips container-prefixed comment leaves before a later fenced copy", () => {
		const source = "- <!--\n  ```js\n  wrong\n  ```\n  -->\n- ```js\n  right\n  ```";
		const footer = new Markdown(source, 0, 0, getMarkdownTheme()).render(80).at(-1) ?? "";
		const target = footer.match(/\x1b]8;;(omp-copy:[^\x07]+)\x07/)?.[1];

		expect(target).toBeDefined();
		expect(resolveCopyBlock(target!)).toBe("right");
	});
	it("round-trips an empty fenced body through the copy URL", () => {
		const target = copyUrlTarget("", true);
		expect(target).toBe("omp-copy:0.");
		expect(resolveCopyBlock(target!)).toBe("");
	});
	it("recovers the visible CRLF fence after a hidden comment fence", () => {
		const source = "<!--\r\n```js\r\nwrong\r\n```\r\n-->\r\n\r\n```js\r\nright\r\n```";
		const footer = new Markdown(source, 0, 0, getMarkdownTheme()).render(80).at(-1) ?? "";
		const target = footer.match(/\x1b]8;;(omp-copy:[^\x07]+)\x07/)?.[1];
		expect(target).toBeDefined();
		expect(resolveCopyBlock(target!)).toBe("right");
	});
	it("recovers a lone-CR tabbed fence after a hidden earlier fence", () => {
		const source = "<!--\r```js\rwrong\r```\r-->\r\r```js\r\tfoo\r```";
		const footer = new Markdown(source, 0, 0, getMarkdownTheme()).render(80).at(-1) ?? "";
		const target = footer.match(/\x1b]8;;(omp-copy:[^\x07]+)\x07/)?.[1];
		expect(target).toBeDefined();
		expect(resolveCopyBlock(target!)).toBe("\tfoo");
	});
	it("emits clickable copy targets only on platforms with an installed handler path", () => {
		expect(supportsCopyUrlHandler("linux", {}, "/usr/bin/xdg-mime")).toBe(true);
		expect(supportsCopyUrlHandler("darwin")).toBe(false);
		expect(supportsCopyUrlHandler("win32")).toBe(false);
	});
});
