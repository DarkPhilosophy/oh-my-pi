import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir | undefined;
afterEach(() => {
	vi.restoreAllMocks();
	tempDir?.removeSync();
	tempDir = undefined;
});

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: Date.now() });

// A foreign writer appended to the session file. Every later append used to
// re-serialize the whole transcript on the UI thread and hit the same size
// check again: seconds per append on a large session, a freeze on every frame.
it("stops rewriting the whole transcript after a foreign-writer conflict", async () => {
	tempDir = TempDir.createSync("@omp-conflict-storm-");
	const writes = vi.spyOn(FileSessionStorage.prototype, "writeTextSync");
	const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
	manager.appendMessage(user("first"));
	await manager.flush();
	const file = manager.getSessionFile();
	if (!file) throw new Error("expected a session file");
	await fs.appendFile(file, '{"foreign":true}\n');

	await manager.addWorkspaceDirectory(path.join(tempDir.path(), "extra")).catch(() => undefined);
	expect(() => manager.flushSync()).toThrow(SessionWriteConflictError);
	const afterConflict = writes.mock.calls.length;

	for (let i = 0; i < 5; i++) manager.appendMessage(user(`later ${i}`));
	try {
		manager.flushSync();
	} catch {}

	expect(writes.mock.calls.length).toBe(afterConflict);
});
