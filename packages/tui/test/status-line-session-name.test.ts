import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { renderSegment } from "../src/status-line/segments";
import type { SegmentContext } from "../src/status-line/types";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

interface AdvisorEntry {
	name?: string;
	status: string;
	yielded: boolean;
}

function ctxWith(sessionName: string, advisors?: AdvisorEntry[]): SegmentContext {
	return {
		session: {
			sessionManager: { getSessionName: () => sessionName },
			getAdvisorStatusOverview: advisors === undefined ? undefined : () => ({ configured: true, advisors }),
		},
	} as unknown as SegmentContext;
}

function plain(text: string): string {
	return stripVTControlCharacters(text);
}

describe("session_name status-line segment", () => {
	it("shows the session title when no advisor is working", () => {
		const idle = ctxWith("rework the advisor", [{ name: "Reliability", status: "running", yielded: true }]);
		expect(plain(renderSegment("session_name", idle).content)).toContain("rework the advisor");
	});

	it("names the single advisor that is reviewing instead of the title", () => {
		const ctx = ctxWith("rework the advisor", [
			{ name: "Reliability", status: "running", yielded: false },
			{ name: "Performance", status: "running", yielded: true },
		]);
		const content = plain(renderSegment("session_name", ctx).content);
		expect(content).toContain("Reliability reviewing");
		// The title is read once; live activity owns the slot while it lasts.
		expect(content).not.toContain("rework the advisor");
	});

	it("counts concurrent reviewers rather than cycling their names", () => {
		const advisors = Array.from({ length: 10 }, (_, index) => ({
			name: `Advisor${index}`,
			status: "running",
			yielded: index >= 3,
		}));
		const content = plain(renderSegment("session_name", ctxWith("title", advisors)).content);
		// Cycling names would rewrite the segment every frame and jitter the bar.
		expect(content).toContain("3 advisors reviewing");
		expect(content).not.toContain("Advisor0");
	});

	it("falls back to a generic label for the unnamed default advisor", () => {
		const ctx = ctxWith("title", [{ status: "running", yielded: false }]);
		expect(plain(renderSegment("session_name", ctx).content)).toContain("advisor reviewing");
	});

	it("keeps the title when an advisor is failed or out of quota rather than working", () => {
		const ctx = ctxWith("title", [
			{ name: "Broken", status: "error", yielded: false },
			{ name: "Spent", status: "quota_exhausted", yielded: false },
		]);
		expect(plain(renderSegment("session_name", ctx).content)).toContain("title");
	});
});
