import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getKittyGraphics, setKittyGraphics } from "../src/kitty-graphics";
import {
	applyHerdrKittyGraphics,
	ImageProtocol,
	setTerminalImageProtocol,
	TERMINAL,
} from "../src/terminal-capabilities";
import { canDiscoverHerdrKittyGraphics, queryHerdrKittyGraphics } from "../src/terminal-multiplexer";

const PANE = { HERDR_ENV: "1", HERDR_PANE_ID: "pane-old", TERM: "xterm-256color" };

async function check(capabilities: unknown, env: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "herdr-kitty-"));
	const path = join(dir, "api.sock");
	let requests = 0;
	let method: string | undefined;
	const server = createServer(socket => {
		let buffer = "";
		socket.on("data", data => {
			buffer += data.toString();
			if (!buffer.includes("\n")) return;
			requests++;
			const request = JSON.parse(buffer);
			method = request.method;
			socket.end(JSON.stringify({ id: request.id, result: { type: "pong", capabilities } }) + "\n");
		});
	});
	await new Promise<void>(resolve => server.listen(path, resolve));
	try {
		const result = await queryHerdrKittyGraphics({ ...PANE, HERDR_SOCKET_PATH: path, ...env });
		if (requests) expect(method).toBe("ping");
		return { result, requests };
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
		rmSync(dir, { recursive: true });
	}
}

describe("Herdr Kitty forwarding discovery", () => {
	it("accepts a marker-free pane whose daemon advertises kitty_graphics", async () => {
		expect(await check({ kitty_graphics: true })).toEqual({ result: true, requests: 1 });
	});

	it.each([undefined, {}, { kitty_graphics: false }, { kitty_graphics: "true" }, { native_transport: true }])(
		"fails closed for absent or invalid capability %j",
		async capabilities => {
			expect((await check(capabilities)).result).toBe(false);
		},
	);

	it("trusts the spawn marker without contacting the daemon", async () => {
		expect(await check({ kitty_graphics: false }, { HERDR_KITTY_GRAPHICS: "1" })).toEqual({ result: true, requests: 0 });
	});

	it("never second-guesses an explicit marker value", async () => {
		expect(await check({ kitty_graphics: true }, { HERDR_KITTY_GRAPHICS: "0" })).toEqual({ result: false, requests: 0 });
	});

	it.each(["TMUX", "STY", "ZELLIJ", "CMUX_WORKSPACE_ID", "WMUX", "WMUX_SURFACE_ID", "HERDR_PLUGIN_ID"])(
		"does not contact the API in nested %s",
		async key => {
			expect(await check({ kitty_graphics: true }, { [key]: "x" })).toEqual({ result: false, requests: 0 });
		},
	);

	it.each(["tmux-256color", "SCREEN-256color"])("does not contact the API with nested TERM %s", async TERM => {
		expect(await check({ kitty_graphics: true }, { TERM })).toEqual({ result: false, requests: 0 });
	});

	it("needs pane identity and a socket", () => {
		expect(canDiscoverHerdrKittyGraphics({ ...PANE, HERDR_SOCKET_PATH: "/x" })).toBe(true);
		expect(canDiscoverHerdrKittyGraphics({ ...PANE })).toBe(false);
		expect(canDiscoverHerdrKittyGraphics({ HERDR_ENV: "1", TERM: "xterm", HERDR_SOCKET_PATH: "/x" })).toBe(false);
	});

	it("fails closed when the socket is unavailable", async () => {
		expect(
			await queryHerdrKittyGraphics({ ...PANE, HERDR_SOCKET_PATH: join(tmpdir(), "missing-herdr-kitty.sock") }),
		).toBe(false);
	});
});

describe("applyHerdrKittyGraphics", () => {
	const savedProtocol = TERMINAL.imageProtocol;
	const savedPlaceholders = getKittyGraphics().unicodePlaceholders;
	afterEach(() => {
		setTerminalImageProtocol(savedProtocol);
		setKittyGraphics({ unicodePlaceholders: savedPlaceholders });
	});

	it("turns Kitty and placeholders on for a daemon-confirmed direct pane", () => {
		setTerminalImageProtocol(null);
		expect(applyHerdrKittyGraphics({ ...PANE })).toBe(true);
		expect(TERMINAL.imageProtocol as ImageProtocol | null).toBe(ImageProtocol.Kitty);
		expect(getKittyGraphics().unicodePlaceholders).toBe(true);
	});

	it("keeps the user's placeholder opt-out", () => {
		setTerminalImageProtocol(null);
		expect(applyHerdrKittyGraphics({ ...PANE, PI_NO_KITTY_PLACEHOLDERS: "1" })).toBe(true);
		expect(getKittyGraphics().unicodePlaceholders).toBe(false);
	});

	it("does nothing in a nested multiplexer, under Paseo, or when a protocol is already set", () => {
		setTerminalImageProtocol(null);
		expect(applyHerdrKittyGraphics({ ...PANE, TMUX: "x" })).toBe(false);
		expect(applyHerdrKittyGraphics({ ...PANE, PASEO_TERMINAL_ID: "t" })).toBe(false);
		expect(TERMINAL.imageProtocol as ImageProtocol | null).toBeNull();
		setTerminalImageProtocol(ImageProtocol.Sixel);
		expect(applyHerdrKittyGraphics({ ...PANE })).toBe(false);
		expect(TERMINAL.imageProtocol as ImageProtocol | null).toBe(ImageProtocol.Sixel);
	});
});
