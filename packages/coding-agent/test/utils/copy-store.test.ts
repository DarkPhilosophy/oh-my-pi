import { describe, expect, it } from "bun:test";
import {
	copyUrlTarget,
	createCopyDesktopEntry,
	supportsCopyUrlHandler,
} from "@oh-my-pi/pi-coding-agent/utils/copy-store";

describe("copy URL handler", () => {
	it("does not advertise a client-local copy link in remote or unsupported sessions", () => {
		expect(supportsCopyUrlHandler("linux", { SSH_CONNECTION: "client server" }, "/usr/bin/xdg-mime")).toBe(false);
		expect(supportsCopyUrlHandler("linux", {}, null)).toBe(false);
		expect(supportsCopyUrlHandler("darwin", {}, "/usr/bin/xdg-mime")).toBe(false);
		expect(supportsCopyUrlHandler("linux", {}, "/usr/bin/xdg-mime")).toBe(true);
	});

	it("emits a target only after the local handler is confirmed reachable", () => {
		expect(copyUrlTarget("echo ready", false)).toBeUndefined();
		expect(copyUrlTarget("echo ready", true)).toMatch(/^omp-copy:/);
	});

	it("quotes and escapes the executable as one desktop Exec argument", () => {
		const entry = createCopyDesktopEntry('/opt/Oh My $Pi/omp"dev');
		expect(entry).toContain('Exec="/opt/Oh My \\$Pi/omp\\"dev" copy %u');
	});
});
