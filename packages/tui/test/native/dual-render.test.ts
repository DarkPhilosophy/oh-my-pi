import { afterEach, describe, expect, it } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { md } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { isNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import { defaultEditorTheme } from "../test-themes";
import { TspHarness } from "./tsp-harness";

/** A component with both faces: classic rows and a native description, over one state. */
class Note implements Component {
	text: string;
	typed: string[] = [];
	events: NativeUiEvent[] = [];
	constructor(text: string) {
		this.text = text;
	}
	render(): readonly string[] {
		return [`row: ${this.text}`];
	}
	describe(): NativeNode {
		return md(this.text);
	}
	handleInput(data: string): void {
		this.typed.push(data);
		this.text += data;
	}
	handleNativeEvent(event: NativeUiEvent): void {
		this.events.push(event);
	}
}

/** Past the single render cadence both faces share. */
const CADENCE_MS = 100;

/** Request a render and let the shared cadence elapse. */
function repaint(h: TspHarness): void {
	h.tui.requestRender();
	h.flush(CADENCE_MS);
}

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
});

/** Every raw terminal write, in order. */
function recordWrites(h: TspHarness): string[] {
	const writes: string[] = [];
	const write = h.terminal.write.bind(h.terminal);
	h.terminal.write = (data: string) => {
		writes.push(data);
		write(data);
	};
	return writes;
}

describe("dual rendering behind a relay", () => {
	it("paints the classic rows and the surface from one state, leaving no TSP in the rows", async () => {
		const note = new Note("hello");
		harness = await TspHarness.start(tui => tui.addChild(note), { relayed: true });
		const h = harness;
		expect(isNativeRendering()).toBe(true);
		expect(h.terminal.surface).toBeDefined();
		expect(h.byId(`${h.region("main")!.c![0]!.id}`)).toMatchObject({ k: "md", p: { text: "hello" } });
		expect(Bun.stripANSI(h.terminal.rowBytes)).toContain("row: hello");
		expect(h.terminal.rowBytes).not.toContain("tsp;");
		expect(h.terminal.rowBytes).not.toContain("\x1b_");

		note.text = "changed";
		repaint(h);
		expect(h.byId(`${h.region("main")!.c![0]!.id}`)).toMatchObject({ p: { text: "changed" } });
		expect(Bun.stripANSI(h.terminal.rowBytes)).toContain("row: changed");
		expect(h.terminal.rowBytes).not.toContain("\x1b_");
		expect(h.errors).toEqual([]);
	});

	it("never mixes a surface message and row bytes in one write", async () => {
		const note = new Note("a");
		harness = await TspHarness.start(tui => tui.addChild(note), { relayed: true });
		const h = harness;
		const writes = recordWrites(h);
		for (const text of ["b", "c", "d"]) {
			note.text = text;
			repaint(h);
		}
		const mixed = writes.filter(
			data => data.includes("\x1b_tsp;") && Bun.stripANSI(data).replace(/\x1b_[^\x1b]*\x1b\\/g, "") !== "",
		);
		expect(writes.some(data => data.includes("\x1b_tsp;"))).toBe(true);
		expect(writes.some(data => data.includes("row: d"))).toBe(true);
		expect(mixed).toEqual([]);
	});

	it("does no work when nothing changed", async () => {
		const note = new Note("still");
		harness = await TspHarness.start(tui => tui.addChild(note), { relayed: true });
		const h = harness;
		const writes = recordWrites(h);
		repaint(h);
		repaint(h);
		expect(writes.filter(data => data.includes("\x1b_tsp;"))).toEqual([]);
		expect(writes.filter(data => Bun.stripANSI(data).includes("row:"))).toEqual([]);
	});

	it("handles classic keys and surface events on the same component", async () => {
		const note = new Note("");
		harness = await TspHarness.start(
			tui => {
				tui.addChild(note);
				tui.setFocus(note);
			},
			{ relayed: true },
		);
		const h = harness;
		h.terminal.send("x");
		h.flush(CADENCE_MS);
		expect(note.typed).toEqual(["x"]);
		expect(h.byId(`${h.region("main")!.c![0]!.id}`)).toMatchObject({ p: { text: "x" } });
		expect(Bun.stripANSI(h.terminal.rowBytes)).toContain("row: x");

		h.event({ ev: "toggle", sf: h.terminal.surface!, id: h.region("main")!.c![0]!.id, collapsed: false });
		expect(note.events).toHaveLength(1);
	});

	it("keeps a direct native host native-only: no rows are painted next to its surface", async () => {
		const note = new Note("direct");
		harness = await TspHarness.start(tui => tui.addChild(note));
		expect(harness.terminal.surface).toBeDefined();
		expect(Bun.stripANSI(harness.terminal.rowBytes).trim()).toBe("");
	});

	it("paints rows immediately without waiting for the hello reply", async () => {
		const note = new Note("early");
		harness = await TspHarness.start(tui => tui.addChild(note), { relayed: true, manualProbe: true });
		const h = harness;
		expect(Bun.stripANSI(h.terminal.rowBytes)).toContain("row: early");
		const before = h.terminal.rowBytes.length;
		h.terminal.answerProbe();
		h.flush();
		expect(h.terminal.surface).toBeDefined();
		// The row paint stays: nothing is erased for the surface.
		expect(h.terminal.rowBytes.length).toBe(before);
	});

	it("flushes the row history at stop so the classic clients keep their transcript", async () => {
		const note = new Note("kept");
		harness = await TspHarness.start(tui => tui.addChild(note), { relayed: true });
		const h = harness;
		const writes = recordWrites(h);
		h.stop();
		harness = undefined;
		expect(writes.some(data => data.includes("\x1b_tsp;x;"))).toBe(true);
		expect(writes.join("")).toContain("\r");
	});

	it("an unreplied probe leaves classic clients their rows", async () => {
		const note = new Note("plain");
		harness = await TspHarness.start(tui => tui.addChild(note), { relayed: true, reply: false });
		expect(harness.terminal.surface).toBeUndefined();
		expect(Bun.stripANSI(harness.terminal.rowBytes)).toContain("row: plain");
	});
});

describe("dual rendering input coherence", () => {
	it("a surface edit event shows in the classic rows", async () => {
		const editor = new Editor(defaultEditorTheme);
		harness = await TspHarness.start(
			tui => {
				tui.addChild(editor);
				tui.setFocus(editor);
			},
			{ relayed: true },
		);
		const h = harness;
		const node = h.find(n => n.k === "editor")!;
		const rowsBefore = h.terminal.rowBytes.length;
		h.event({ ev: "edit", sf: h.terminal.surface!, id: node.id, from: 0, to: 0, text: "/", cursor: 1, len: 0 });
		h.flush(CADENCE_MS);
		expect(editor.getText()).toBe("/");
		expect(h.byId(node.id)?.p).toMatchObject({ text: "/" });
		expect(Bun.stripANSI(h.terminal.rowBytes.slice(rowsBefore))).toContain("/");
	});

	it("a classic keystroke shows in the surface and the rows from the same editor", async () => {
		const editor = new Editor(defaultEditorTheme);
		harness = await TspHarness.start(
			tui => {
				tui.addChild(editor);
				tui.setFocus(editor);
			},
			{ relayed: true },
		);
		const h = harness;
		const node = h.find(n => n.k === "editor")!;
		const rowsBefore = h.terminal.rowBytes.length;
		h.terminal.send("q");
		h.flush(CADENCE_MS);
		expect(editor.getText()).toBe("q");
		expect(h.byId(node.id)?.p).toMatchObject({ text: "q" });
		expect(Bun.stripANSI(h.terminal.rowBytes.slice(rowsBefore))).toContain("q");
	});
});
