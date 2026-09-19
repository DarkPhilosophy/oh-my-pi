import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { QueuedMessageBox } from "../src/modes/components/queued-message-box";

const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");
const representativeBody = ["one", "two", "three", "four", "five", "six", "seven"];

describe("QueuedMessageBox collapse height", () => {
	beforeAll(async () => {
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	it("uses collapseLines as the total displaced-editor height including borders", () => {
		const collapseLines = 5;
		const rendered = new QueuedMessageBox("Steer", representativeBody, {
			collapseLines,
			expanded: false,
			footerText: "Alt+Up (or Up) to edit",
		}).render(80);

		expect(rendered).toHaveLength(collapseLines);
		expect(stripAnsi(rendered.at(-1) ?? "")).toContain("+4 rows · 16 chars");
		expect(stripAnsi(rendered.join("\n"))).toContain("├─ one");
	});

	it("keeps the same total budget when the top border is stacked externally", () => {
		const collapseLines = 5;
		const rendered = new QueuedMessageBox("Steer", representativeBody, {
			collapseLines,
			expanded: false,
			showTopBorder: false,
		}).render(80);

		expect(rendered).toHaveLength(collapseLines);
		expect(stripAnsi(rendered.at(-1) ?? "")).toContain("+3 rows · 12 chars");
	});

	it("leaves expanded boxes uncapped", () => {
		const rendered = new QueuedMessageBox("Steer", representativeBody, {
			collapseLines: 5,
			expanded: true,
		}).render(80);

		expect(rendered).toHaveLength(representativeBody.length + 2);
		expect(stripAnsi(rendered.at(-1) ?? "")).not.toContain("+");
	});

	it("truncates a body that exactly fills the editor budget to make room for chrome", () => {
		const collapseLines = 5;
		const exactBody = ["one", "two", "three", "four", "five"];
		const rendered = new QueuedMessageBox("Steer", exactBody, {
			collapseLines,
			expanded: false,
		}).render(80);

		expect(rendered).toHaveLength(collapseLines);
		expect(stripAnsi(rendered.at(-1) ?? "")).toContain("+2 rows · 8 chars");
	});
});
