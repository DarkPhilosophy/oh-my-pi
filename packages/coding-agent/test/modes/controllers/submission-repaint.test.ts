import { beforeAll, expect, it } from "bun:test";
import { Text, TUI } from "@oh-my-pi/pi-tui";
import { HostedTerminal } from "../../../src/daemon/terminal-bridge";
import { EventController } from "../../../src/modes/controllers/event-controller";
import { initTheme } from "../../../src/modes/theme/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(() => initTheme());

it("does not repaint unchanged history when an optimistic submission is acknowledged", async () => {
	const terminal = new HostedTerminal({
		columns: 80,
		rows: 24,
		kittyProtocolActive: false,
		kittyEnableSequence: null,
	});
	const output: string[] = [];
	terminal.setOutput(data => output.push(data));
	const ui = new TUI(terminal);
	ui.addChild(new Text("HISTORY_SENTINEL\noptimistic send", 0, 0));
	const ctx = createInteractiveModeContext({
		optimisticUserMessageSignature: "optimistic send\u00000",
		locallySubmittedUserSignatures: new Set(["optimistic send\u00000"]),
		getUserMessageText: () => "optimistic send",
	});
	ctx.ui = ui;
	const controller = new EventController(ctx);
	try {
		ui.start();
		ui.renderNow();
		await Promise.resolve();
		expect(output.join("")).toContain("HISTORY_SENTINEL");
		output.length = 0;
		await controller.handleEvent({
			type: "message_start",
			message: {
				role: "user",
				content: [{ type: "text", text: "optimistic send" }],
				attribution: "user",
				timestamp: Date.now(),
			},
		});
		await Bun.sleep(100);
		expect(output.join("")).not.toContain("HISTORY_SENTINEL");
		expect(output.join("")).not.toContain("\x1b[3J");
	} finally {
		ui.stop();
		terminal.setOutput(undefined);
	}
});

it("defers hosted paints while transport is backed up and resumes with the latest state", async () => {
	let pendingBytes = 0;
	const terminal = new HostedTerminal(
		{ columns: 80, rows: 24, kittyProtocolActive: false, kittyEnableSequence: null },
		() => pendingBytes,
	);
	const output: string[] = [];
	terminal.setOutput(data => output.push(data));
	const ui = new TUI(terminal);
	const text = new Text("initial", 0, 0);
	ui.addChild(text);
	try {
		ui.start();
		ui.renderNow();
		await Promise.resolve();
		output.length = 0;
		pendingBytes = 10 * 1024 * 1024;
		text.setText("stale-frame");
		ui.requestRender();
		await Bun.sleep(100);
		expect(output.join("")).not.toContain("stale-frame");
		text.setText("latest-frame");
		pendingBytes = 0;
		await Bun.sleep(100);
		expect(output.join("")).toContain("latest-frame");
		expect(output.join("")).not.toContain("stale-frame");
	} finally {
		ui.stop();
		terminal.setOutput(undefined);
	}
});
