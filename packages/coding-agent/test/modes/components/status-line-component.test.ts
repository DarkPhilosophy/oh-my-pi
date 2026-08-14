import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { DaemonConnectionSnapshot } from "@oh-my-pi/pi-coding-agent/daemon/status";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/component";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { withProjectDir } from "@oh-my-pi/pi-utils";

function makeSessionWithLastMessage(lastMessage: unknown, prewalkArmed: boolean = false) {
	return {
		messages: lastMessage ? [lastMessage] : [],
		model: { contextWindow: 128000 },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens: 42, contextWindow: 128000 }),
		state: {
			messages: lastMessage ? [lastMessage] : [],
			model: { contextWindow: 128000 },
		},
		sessionManager: {
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
				tokensPerSecond: null,
			}),
			getSessionName: () => "test-session",
		},
		getPrewalkState: () => (prewalkArmed ? { target: { id: "cheap-model", provider: "openai" } } : undefined),
		getAsyncJobSnapshot: () => undefined,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
		isFastModeActive: () => false,
		configuredThinkingLevel: () => undefined,
		modelRegistry: {
			isUsingOAuth: () => false,
		},
	};
}

function makeCountingSession(argumentsValue: Record<string, unknown>) {
	let contextUsageCalls = 0;
	const message = {
		role: "assistant",
		timestamp: 1,
		content: [{ type: "toolCall", name: "write", arguments: argumentsValue }],
	};
	const session = makeSessionWithLastMessage(message) as Record<string, unknown>;
	session.getContextUsage = () => {
		contextUsageCalls += 1;
		return { tokens: 42, contextWindow: 128000 };
	};
	return {
		session: session as unknown as AgentSession,
		calls: () => contextUsageCalls,
		args: argumentsValue,
	};
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

describe("StatusLineComponent", () => {
	it("fingerprints tool-call arguments containing bigint values", () => {
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage({
				role: "assistant",
				timestamp: 1,
				content: [
					{
						type: "toolCall",
						name: "read",
						arguments: { offset: 1n, nested: { limit: 2n } },
					},
				],
			}) as unknown as AgentSession,
		);

		expect(statusLine.getCachedContextBreakdown()).toEqual({ usedTokens: 42, contextWindow: 128000 });
	});

	it("recomputes context usage when tool-call argument sizes mutate in place", () => {
		// The fingerprint memo must notice in-place mutations the streaming
		// parser performs on the LAST message's toolCall arguments: string
		// growth, number digit growth, boolean flips, and a property appearing
		// where undefined was. Same-object re-render without mutation must hit
		// the memo (no recompute).
		const counting = makeCountingSession({
			content: "ab",
			offset: 1,
			flag: true,
			extra: undefined as unknown,
		});
		const statusLine = new StatusLineComponent(counting.session);

		statusLine.getCachedContextBreakdown();
		const baseline = counting.calls();
		statusLine.getCachedContextBreakdown();
		expect(counting.calls()).toBe(baseline); // memo hit, no mutation

		counting.args.content = "abcdef";
		statusLine.getCachedContextBreakdown();
		expect(counting.calls()).toBe(baseline + 1); // string growth

		counting.args.offset = 1000000000;
		statusLine.getCachedContextBreakdown();
		expect(counting.calls()).toBe(baseline + 2); // number digit growth

		counting.args.flag = false;
		statusLine.getCachedContextBreakdown();
		expect(counting.calls()).toBe(baseline + 3); // boolean flip (4 vs 5)

		counting.args.extra = "now-present";
		statusLine.getCachedContextBreakdown();
		expect(counting.calls()).toBe(baseline + 4); // undefined -> value appears
	});

	it("survives circular tool-call arguments via the String fallback", () => {
		const circular: Record<string, unknown> = { name: "loop" };
		circular.self = circular;
		const counting = makeCountingSession(circular);
		const statusLine = new StatusLineComponent(counting.session);

		expect(statusLine.getCachedContextBreakdown()).toEqual({ usedTokens: 42, contextWindow: 128000 });
	});

	it("renders Prewalk annotation when prewalk is armed", () => {
		const statusLine = new StatusLineComponent(makeSessionWithLastMessage(null, true) as unknown as AgentSession);

		// By default preset, 'mode' segment is included in left/right segments.
		// Let's get the border and see if Prewalk is rendered.
		const border = statusLine.getTopBorder(100);
		// SGR codes might be included, so we check if the stripped content contains "Prewalk"
		const stripped = border.content.replace(/\x1b\[[0-9;]*m/g, "");
		// Renders start fire-and-forget git/PR lookups; dispose BEFORE asserting
		// so a failed expectation cannot leak a live component whose late
		// callbacks hit the settings proxy after another file resets it.
		statusLine.dispose();
		expect(stripped).toContain("Prewalk");
	});
	it("renders an empty top border before a remote session projection is attached", () => {
		const statusLine = new StatusLineComponent();

		expect(statusLine.getTopBorder(100)).toEqual({ content: "", width: 0, revision: 0 });
	});

	it("renders the session-owned cwd even when the render scope carries a foreign project dir", () => {
		// Hosted daemon sessions can render from callbacks running outside the
		// session's async project scope (socket events, TUI timers), where the
		// process-global project dir belongs to another session or the daemon's
		// scratch cwd. The path segment must stay pinned to the session's cwd —
		// alternating sources is the "flickering 📂" bug.
		const session = makeSessionWithLastMessage(null) as Record<string, unknown>;
		(session.sessionManager as Record<string, unknown>).getCwd = () => "/tmp/flicker-session-project";
		const statusLine = new StatusLineComponent(session as unknown as AgentSession);

		const rendered = withProjectDir("/tmp/flicker-foreign-daemon-cwd", () =>
			statusLine.getTopBorder(200).content.replace(/\x1b\[[0-9;]*m/g, ""),
		);
		statusLine.dispose();

		expect(rendered).toContain("flicker-session-project");
		expect(rendered).not.toContain("flicker-foreign-daemon-cwd");
	});
});

it("renders daemon degradation from the supplied snapshot", () => {
	const statusLine = new StatusLineComponent(makeSessionWithLastMessage(null) as unknown as AgentSession);
	const snapshot: DaemonConnectionSnapshot = {
		state: "reconnecting",
		shard: { profile: null },
		attempt: 2,
	};
	statusLine.setServerStatus(snapshot);
	const rendered = statusLine
		.render(100)
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "");
	statusLine.dispose();
	expect(rendered).toContain("server reconnecting");
});
