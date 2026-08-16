import { describe, expect, it } from "bun:test";
import { TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

describe("TUI start listeners", () => {
	it("fires registered hooks on initial start and restart", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		let starts = 0;
		tui.addStartListener(() => {
			starts++;
		});

		try {
			tui.start();
			expect(starts).toBe(1);

			tui.stop();
			tui.start();
			expect(starts).toBe(2);
		} finally {
			tui.stop();
		}
	});
	it("forwards terminal focus transitions to subscribers", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const states: boolean[] = [];
		const unsubscribe = tui.onTerminalFocusChange(focused => states.push(focused));

		try {
			tui.start();
			expect(states).toEqual([true]);
			terminal.emitFocus(false);
			terminal.emitFocus(true);
			expect(states).toEqual([true, false, true]);
		} finally {
			unsubscribe();
			tui.stop();
		}
	});
});
