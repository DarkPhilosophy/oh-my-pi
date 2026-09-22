import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";

import { makeAssistantMessage } from "./helpers";

describe("SessionManager.continueRecent /new boundary", () => {
	let testAgentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalTmuxPane = process.env.TMUX_PANE;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		// Deterministic, non-TTY terminal id so breadcrumb read/write is stable.
		process.env.TMUX_PANE = "%new-boundary-test";
		testAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-new-boundary-"));
		setAgentDir(testAgentDir);
		cwd = path.join(testAgentDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
	});

	afterEach(async () => {
		if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalTmuxPane;
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(testAgentDir, { recursive: true, force: true });
	});

	it("honors a same-terminal lazy fresh-session breadcrumb when no output was produced", async () => {
		const old = SessionManager.create(cwd);
		old.appendMessage({ role: "user", content: "older work", timestamp: 1 });
		old.appendMessage(makeAssistantMessage());
		await old.flush();
		const oldFile = old.getSessionFile();
		if (!oldFile) throw new Error("Expected persisted old session file");
		await old.close();

		// Initial session creation remains lazy. Its terminal-scoped breadcrumb
		// must keep same-terminal auto-resume from selecting the older file.
		const fresh = SessionManager.create(cwd);
		const freshFile = fresh.getSessionFile();
		if (!freshFile) throw new Error("Expected a fresh session file path");
		expect(fs.existsSync(freshFile)).toBe(false);
		await fresh.close();

		const relaunched = await SessionManager.continueRecent(cwd);
		try {
			expect(relaunched.getEntries()).toHaveLength(0);
			expect(path.resolve(relaunched.getSessionFile() ?? "")).not.toBe(path.resolve(freshFile));
			expect(path.resolve(relaunched.getSessionFile() ?? "")).not.toBe(path.resolve(oldFile));
		} finally {
			await relaunched.close();
		}
	});

	it("materializes a lazy session when the first user message is submitted", async () => {
		const session = SessionManager.create(cwd);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected an allocated session path");
		expect(fs.existsSync(sessionFile)).toBe(false);

		session.appendMessage({ role: "user", content: "start the conversation", timestamp: 1 });
		await session.flush();

		expect(fs.existsSync(sessionFile)).toBe(true);
		await session.close();
		expect(fs.existsSync(sessionFile)).toBe(true);
	});

	it("reaps an unused /new boundary before creating the next one", async () => {
		const session = SessionManager.create(cwd);
		await session.newSession();
		const first = session.getSessionFile();
		if (!first) throw new Error("Expected first boundary path");
		expect(fs.existsSync(first)).toBe(true);

		await session.newSession();
		const second = session.getSessionFile();
		if (!second) throw new Error("Expected second boundary path");
		expect(fs.existsSync(first)).toBe(false);
		expect(fs.existsSync(second)).toBe(true);

		await session.close();
		expect(fs.existsSync(second)).toBe(false);
	});

	it("keeps an active /new boundary across terminals, then removes it on clean close", async () => {
		const old = SessionManager.create(cwd);
		old.appendMessage({ role: "user", content: "pre-new work", timestamp: 1 });
		old.appendMessage(makeAssistantMessage());
		await old.flush();
		const oldFile = old.getSessionFile();
		if (!oldFile) throw new Error("Expected persisted old session file");
		await old.close();

		const resumed = await SessionManager.continueRecent(cwd);
		await resumed.newSession();
		const freshFile = resumed.getSessionFile();
		if (!freshFile) throw new Error("Expected a fresh session file path");

		const tiedMtime = new Date("2026-01-01T00:00:00.000Z");
		fs.utimesSync(oldFile, tiedMtime, tiedMtime);
		fs.utimesSync(freshFile, tiedMtime, tiedMtime);

		process.env.TMUX_PANE = "%new-boundary-relaunched-terminal";
		const relaunched = await SessionManager.continueRecent(cwd);
		try {
			expect(relaunched.getEntries()).toHaveLength(0);
			expect(path.resolve(relaunched.getSessionFile() ?? "")).toBe(path.resolve(freshFile));
			expect(path.resolve(relaunched.getSessionFile() ?? "")).not.toBe(path.resolve(oldFile));
		} finally {
			await relaunched.close();
		}

		expect(fs.existsSync(freshFile)).toBe(true);
		await resumed.close();
		expect(fs.existsSync(freshFile)).toBe(false);
	});

	it("still falls back to the most-recent session for a genuinely stale breadcrumb", async () => {
		// A normal persisted session (survives).
		const first = SessionManager.create(cwd);
		first.appendMessage({ role: "user", content: "first session", timestamp: 1 });
		first.appendMessage(makeAssistantMessage());
		await first.flush();
		await first.close();

		// A distinct second session becomes the terminal's breadcrumb target and
		// materializes on disk (re-stamped non-fresh), then is externally deleted.
		const second = SessionManager.create(cwd);
		second.appendMessage({ role: "user", content: "second session", timestamp: 1 });
		second.appendMessage(makeAssistantMessage());
		await second.flush();
		const secondFile = second.getSessionFile();
		if (!secondFile) throw new Error("Expected persisted second session file");
		await second.close();
		await fsp.rm(secondFile, { force: true });

		const relaunched = await SessionManager.continueRecent(cwd);
		try {
			// Materialized-then-deleted target (non-fresh) → fall back to the
			// most-recent surviving session, not a fresh empty one.
			expect(JSON.stringify(relaunched.getEntries())).toContain("first session");
		} finally {
			await relaunched.close();
		}
	});
});
