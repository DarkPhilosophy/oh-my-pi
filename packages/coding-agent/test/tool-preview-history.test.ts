import { expect, it } from "bun:test";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { createTestSession } from "./utilities";

it.each(["write", "edit", "read"] as const)(
	"keeps changing %s previews out of history and commits completed cards once",
	async kind => {
		const context = await createTestSession();
		const terminal = new VirtualTerminal(80, 12);
		const composer = new Composer({ preferences: { quiet: true }, terminal });
		const transcript = new TranscriptContainer();
		composer.setRuntimeChildren([transcript, { render: () => ["INPUT"] }]);
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		terminal.write = data => {
			writes.push(data);
			write(data);
		};
		const paint = async () => {
			composer.ui.requestRender();
			await terminal.waitForRender();
		};
		const markers = (text: string) => Array.from(text.matchAll(/CARD_\d+_ROW_\d+/g), match => match[0]);
		const expected: string[] = [];
		composer.start();
		try {
			await paint();
			writes.length = 0;
			for (let index = 1; index <= 3; index++) {
				const path = `preview-${index}.txt`;
				const card = new ToolExecutionComponent(kind, { path }, {}, undefined, composer.ui, "/tmp");
				transcript.addChild(card);
				card.setExpanded(true);
				let content = "";
				let diff = "";
				for (let count = 5; count <= 40; count += 5) {
					content = Array.from({ length: count }, (_, row) => `CARD_${index}_ROW_${row + 1}`).join("\n");
					diff =
						`@@ -0,0 +1,${count} @@\n` +
						content
							.split("\n")
							.map(row => `+${row}`)
							.join("\n");
					if (kind === "write") card.updateArgs({ path, content });
					else if (kind === "edit")
						card.updateStreamPreview({
							generation: count,
							streaming: true,
							files: [{ path, diff, firstChangedLine: 1 }],
						});
					else card.updateResult({ content: [{ type: "text", text: content }] }, true);
					await paint();
					expect(terminal.getScrollBuffer().slice(0, -terminal.rows).join("\n")).not.toContain(
						`CARD_${index}_ROW_`,
					);
				}
				card.setArgsComplete();
				card.setExecutionStarted();
				await paint();
				card.updateResult(
					{
						content: [{ type: "text", text: kind === "read" ? content : `Saved ${path}` }],
						...(kind === "edit" ? { details: { diff, firstChangedLine: 1 } } : {}),
					},
					false,
				);
				expected.push(...markers(Bun.stripANSI(card.render(80).join("\n"))));
				await paint();
				await paint();
				expect(terminal.getViewport().at(-1)?.trimEnd()).toBe("INPUT");
				expect(markers(Bun.stripANSI(terminal.getScrollBuffer().join("\n")))).toEqual(expected);
			}
			expect(writes.join("")).not.toMatch(/\x1b\[(?:2|3)J/);
		} finally {
			composer.stop();
			await context.session.dispose();
		}
	},
);
