import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

function textContent(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter(
				(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
			)
			.map(block => block.text)
			.join("\n") ?? ""
	);
}

describe("createAgentSession cwd after resume", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("runs tools from the resumed session directory", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-resume-cwd-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		const sessionsDir = path.join(tempDir, "sessions");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });

		const markerA = `marker-from-a-${Snowflake.next()}`;
		const markerB = `marker-from-b-${Snowflake.next()}`;
		fs.writeFileSync(path.join(cwdA, "cwd-marker"), `${markerA}\n`);
		fs.writeFileSync(path.join(cwdB, "cwd-marker"), `${markerB}\n`);

		const targetManager = SessionManager.create(cwdB, sessionsDir);
		let targetSessionFile: string | undefined;
		try {
			targetManager.appendMessage({ role: "user", content: "target session", timestamp: 2 });
			targetManager.appendMessage(createAssistantMessage("target reply"));
			await targetManager.ensureOnDisk();
			targetSessionFile = targetManager.getSessionFile();
		} finally {
			await targetManager.close();
		}
		if (!targetSessionFile) throw new Error("Expected target session file");

		const sourceManager = SessionManager.create(cwdA, sessionsDir);

		let session: AgentSession | undefined;
		try {
			sourceManager.appendMessage({ role: "user", content: "source session", timestamp: 1 });
			await sourceManager.flush();
			({ session } = await createAgentSession({
				cwd: cwdA,
				agentDir: tempDir,
				sessionManager: sourceManager,
				settings: Settings.isolated({
					"async.enabled": false,
					"bash.autoBackground.enabled": false,
					"bashInterceptor.enabled": false,
				}),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				toolNames: ["bash", "read"],
			}));

			expect(await session.switchSession(targetSessionFile)).toBe(true);

			const canonicalCwdB = fs.realpathSync(cwdB);
			expect(session.sessionManager.getCwd()).toBe(canonicalCwdB);

			const bashTool = session.getToolByName("bash");
			if (!bashTool) throw new Error("Expected bash tool");
			const pwdResult = await bashTool.execute("pwd-after-resume", { command: "pwd -P" });
			expect(textContent(pwdResult).split(/\r?\n/, 1)[0]).toBe(canonicalCwdB);

			const readTool = session.getToolByName("read");
			if (!readTool) throw new Error("Expected read tool");
			const markerResult = await readTool.execute("read-after-resume", { path: "cwd-marker" });
			const markerText = textContent(markerResult);
			expect(markerText).toContain(markerB);
			expect(markerText).not.toContain(markerA);
		} finally {
			if (session) {
				await session.dispose();
			} else {
				await sourceManager.close();
			}
		}
	});
});
