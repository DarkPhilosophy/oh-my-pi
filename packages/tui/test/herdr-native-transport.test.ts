import { describe, expect, it } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { queryHerdrNativeTransport } from "../src/terminal-multiplexer";

describe("Herdr transport API fallback", () => {
	async function check(capabilities: unknown, env: Record<string, string> = {}) {
		const dir = mkdtempSync(join(tmpdir(), "herdr-capability-"));
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
			const result = await queryHerdrNativeTransport({ HERDR_PANE_ID: "pane-old", HERDR_SOCKET_PATH: path, TERM: "xterm-256color", ...env });
			if (requests) expect(method).toBe("ping");
			return { result, requests };
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
			rmSync(dir, { recursive: true });
		}
	}
	it("accepts an existing pane without the spawn marker", async () => {
		expect(await check({ native_transport: true })).toEqual({ result: true, requests: 1 });
	});
	it.each([undefined, {}, { native_transport: false }, { native_transport: "true" }])("fails closed for absent or invalid capability %j", async capabilities => {
		expect((await check(capabilities)).result).toBe(false);
	});
	it.each(["TMUX", "STY", "ZELLIJ", "CMUX_WORKSPACE_ID", "CMUX_SOCKET_PATH", "WMUX", "WMUX_SURFACE_ID", "HERDR_PLUGIN_ID"])("does not contact the API in nested %s", async key => {
		expect(await check({ native_transport: true }, { [key]: "" })).toEqual({ result: false, requests: 0 });
	});
	it.each(["tmux-256color", "SCREEN-256color"])("does not contact API with nested TERM %s", async TERM => {
		expect(await check({ native_transport: true }, { TERM })).toEqual({ result: false, requests: 0 });
	});
	it("preserves explicit transport opt-out", async () => {
		expect(await check({ native_transport: true }, { HERDR_NATIVE_TRANSPORT: "0" })).toEqual({ result: false, requests: 0 });
	});
	it("fails closed when the socket is unavailable", async () => {
		expect(await queryHerdrNativeTransport({ HERDR_PANE_ID: "old", HERDR_SOCKET_PATH: join(tmpdir(), "missing-herdr.sock") })).toBe(false);
	});
	it("bounds a connected but unresponsive daemon", async () => {
		const dir = mkdtempSync(join(tmpdir(), "herdr-silent-"));
		const path = join(dir, "api.sock");
		const server = createServer(socket => socket.resume());
		await new Promise<void>(resolve => server.listen(path, resolve));
		try {
			const start = performance.now();
			expect(await queryHerdrNativeTransport({ HERDR_PANE_ID: "old", HERDR_SOCKET_PATH: path })).toBe(false);
			expect(performance.now() - start).toBeLessThan(1000);
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
			rmSync(dir, { recursive: true });
		}
	});
});
