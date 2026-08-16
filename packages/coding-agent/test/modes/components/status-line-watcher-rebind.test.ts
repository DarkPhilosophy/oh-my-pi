/**
 * Contract: the status line's git HEAD watcher follows the session-owned cwd.
 * A focus switch to a session rooted in another repository must close the old
 * watcher and register a new one against the new repo's HEAD — otherwise
 * branch changes in the newly focused repo never repaint, and the stale
 * watcher keeps firing for a repo the user is no longer looking at.
 *
 * fs.watch and the git seams are mocked: real watchers in parallel Bun test
 * workers are a known SIGTRAP/flake hazard (see interactive-mode-lsp-startup
 * test), and the contract under test is watcher lifecycle, not inotify.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { StatusLineSettings } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { GitRepository } from "@oh-my-pi/pi-coding-agent/utils/git";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function makeSession(cwd: string): AgentSession {
	return {
		state: { messages: [], model: undefined },
		messages: [],
		model: undefined,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		getAsyncJobSnapshot: () => ({ running: [] }),
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getCwd: () => cwd,
			getSessionName: () => "watcher-rebind test",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as AgentSession;
}

function fakeRepo(root: string): GitRepository {
	return {
		commonDir: `${root}/.git`,
		gitDir: `${root}/.git`,
		gitEntryPath: `${root}/.git`,
		headPath: `${root}/.git/HEAD`,
		repoRoot: root,
	};
}

const gitSegmentSettings: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["path", "git"],
	rightSegments: ["session_name"],
	separator: "powerline-thin",
	sessionAccent: false,
	transparent: false,
};

describe("StatusLineComponent git watcher rebind", () => {
	it("closes the old repo watcher and watches the new repo on session switch", () => {
		const watchers: Array<{ path: string; closeCalls: () => number }> = [];
		vi.spyOn(git.head, "watch").mockImplementation(repository => {
			let closed = 0;
			watchers.push({
				path: repository.headPath,
				closeCalls: () => closed,
			});
			return () => {
				closed += 1;
			};
		});
		vi.spyOn(git.repo, "resolveSync").mockImplementation(cwd => fakeRepo(cwd));

		const component = new StatusLineComponent(makeSession("/repo-a"));
		component.updateSettings(gitSegmentSettings);
		component.watchBranch(() => {});

		expect(watchers).toHaveLength(1);
		expect(watchers[0]?.path).toBe("/repo-a/.git/HEAD");

		component.setSession(makeSession("/repo-b"));

		expect(watchers).toHaveLength(2);
		expect(watchers[1]?.path).toBe("/repo-b/.git/HEAD");
		expect(watchers[0]?.closeCalls()).toBe(1);
		expect(watchers[1]?.closeCalls()).toBe(0);

		component.dispose();
		expect(watchers[1]?.closeCalls()).toBe(1);
	});

	it("re-points the watcher through updateSettings after the session cwd moves", () => {
		// The /move path (InteractiveMode.applyCwdChange) re-snapshots status-line
		// settings via updateSettings AFTER SessionManager.getCwd() already moved;
		// updateSettings itself must rebuild the watcher against the new cwd.
		const watchers: Array<{ path: string; closeCalls: () => number }> = [];
		vi.spyOn(git.head, "watch").mockImplementation(repository => {
			let closed = 0;
			watchers.push({
				path: repository.headPath,
				closeCalls: () => closed,
			});
			return () => {
				closed += 1;
			};
		});
		vi.spyOn(git.repo, "resolveSync").mockImplementation(cwd => fakeRepo(cwd));

		let cwd = "/repo-move-a";
		const session = makeSession(cwd);
		(session.sessionManager as unknown as Record<string, unknown>).getCwd = () => cwd;
		const component = new StatusLineComponent(session);
		component.updateSettings(gitSegmentSettings);
		component.watchBranch(() => {});

		expect(watchers).toHaveLength(1);
		expect(watchers[0]?.path).toBe("/repo-move-a/.git/HEAD");

		cwd = "/repo-move-b";
		component.updateSettings(gitSegmentSettings);

		expect(watchers).toHaveLength(2);
		expect(watchers[1]?.path).toBe("/repo-move-b/.git/HEAD");
		expect(watchers[0]?.closeCalls()).toBe(1);

		// Destination project without git-backed segments: the old watcher must
		// close and NO replacement may be created.
		cwd = "/repo-move-c";
		component.updateSettings({ ...gitSegmentSettings, leftSegments: ["path"], rightSegments: ["session_name"] });

		expect(watchers).toHaveLength(2);
		expect(watchers[1]?.closeCalls()).toBe(1);

		// And back: enabling git segments again creates a watcher for the
		// current cwd.
		component.updateSettings(gitSegmentSettings);
		expect(watchers).toHaveLength(3);
		expect(watchers[2]?.path).toBe("/repo-move-c/.git/HEAD");

		component.dispose();
	});
});
