import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { AdvisorNote } from "@oh-my-pi/pi-tui/chat/messages";
import { formatAdvisorBatchContent } from "../../src/advisor/advise-tool";
import {
	type AdvisorCuratorCandidate,
	applyAdvisorCuration,
	attributeMergedAdvisorNote,
	curateAdvisorCandidates,
} from "../../src/advisor/curator";
import type { ModelRegistry } from "../../src/config/model-registry";
import type { Settings } from "../../src/config/settings";
import * as judgment from "../../src/judgment";

function settingsStub(curator: "auto" | "off" = "auto"): Settings {
	return {
		get: (key: string) => {
			if (key === "advisor.curator") return curator;
			if (key === "advisor.curatorTimeoutMs") return 250;
			if (key === "advisor.curatorContextChars") return 12_000;
			return undefined;
		},
	} as unknown as Settings;
}

const registry = {} as ModelRegistry;

function candidate(
	id: string,
	note: string,
	advisor: string,
	severity: "nit" | "concern" = "concern",
): AdvisorCuratorCandidate {
	return { id, note, advisor, severity, coveredTurn: 1 };
}

const context = { revision: 3, currentTurn: 4, recentPrimaryMessages: "the primary rewrote the parser" };

function stubJudge(answers: Record<string, unknown>): void {
	spyOn(judgment, "resolveJudge").mockReturnValue({
		label: "stub",
		judge: async () => ({ answers }),
	} as unknown as ReturnType<typeof judgment.resolveJudge>);
}

afterEach(() => {
	// Full-suite safety: never leave the judge resolver patched for later files.
	spyOn(judgment, "resolveJudge").mockRestore();
});

describe("advisor curator", () => {
	it("collapses the same issue raised by several advisors into one surviving note", async () => {
		const candidates = [
			candidate("a", "the retry loop never backs off", "Reliability"),
			candidate("b", "retries hammer the endpoint with no delay", "Performance", "nit"),
			candidate("c", "no exponential backoff between retries", "Architecture", "nit"),
		];
		stubJudge({
			"addressed:a": { type: "noul", noul: 0.1 },
			"addressed:b": { type: "noul", noul: 0.1 },
			"addressed:c": { type: "noul", noul: 0.1 },
			"group:a": { type: "choice", choice: "merge" },
			"group:b": { type: "choice", choice: "merge" },
			"group:c": { type: "choice", choice: "merge" },
		});

		const { decisions } = await curateAdvisorCandidates({ settings: settingsStub(), registry, candidates, context });

		// Exactly one note survives, and it is the highest-severity original —
		// never generated text. The other two merge into it rather than being
		// dropped, so their advisors can still be attributed.
		const kept = decisions.filter(decision => decision.action === "keep");
		expect(kept.map(decision => decision.candidateId)).toEqual(["a"]);
		const merged = decisions.filter(decision => decision.action === "merge");
		expect(merged.map(decision => decision.mergeInto)).toEqual(["a", "a"]);
	});

	it("never elects two candidates as each other's merge target", async () => {
		const candidates = [candidate("a", "same issue", "One"), candidate("b", "same issue, other words", "Two")];
		stubJudge({
			"addressed:a": { type: "noul", noul: 0 },
			"addressed:b": { type: "noul", noul: 0 },
			"group:a": { type: "choice", choice: "merge" },
			"group:b": { type: "choice", choice: "merge" },
		});

		const { decisions } = await curateAdvisorCandidates({ settings: settingsStub(), registry, candidates, context });

		// A pairwise merge would leave a → b and b → a, a cycle in which no note
		// reaches the primary at all.
		expect(decisions.filter(decision => decision.action === "keep")).toHaveLength(1);
		const merge = decisions.find(decision => decision.action === "merge");
		expect(merge?.mergeInto).not.toBe(merge?.candidateId);
	});

	it("drops a note the primary's recent work already resolved", async () => {
		const candidates = [
			candidate("a", "parser ignores CRLF", "Correctness"),
			candidate("b", "add a CHANGELOG entry", "Process"),
		];
		stubJudge({
			"addressed:a": { type: "noul", noul: 0.92 },
			"addressed:b": { type: "noul", noul: 0.04 },
			"group:a": { type: "choice", choice: "keep" },
			"group:b": { type: "choice", choice: "keep" },
		});

		const { decisions } = await curateAdvisorCandidates({ settings: settingsStub(), registry, candidates, context });

		expect(decisions.find(decision => decision.candidateId === "a")?.action).toBe("drop");
		expect(decisions.find(decision => decision.candidateId === "b")?.action).toBe("keep");
	});

	it("delivers every candidate unchanged when curation is off", async () => {
		const resolve = spyOn(judgment, "resolveJudge");
		const candidates = [candidate("a", "one", "One"), candidate("b", "two", "Two")];

		const { decisions } = await curateAdvisorCandidates({
			settings: settingsStub("off"),
			registry,
			candidates,
			context,
		});

		expect(decisions.every(decision => decision.action === "keep")).toBe(true);
		// Disabled means no judgment backend is consulted at all.
		expect(resolve).not.toHaveBeenCalled();
	});

	it("delivers every candidate unchanged when the judge fails", async () => {
		const candidates = [candidate("a", "one", "One"), candidate("b", "two", "Two")];
		spyOn(judgment, "resolveJudge").mockReturnValue({
			label: "stub",
			judge: async () => {
				throw new Error("no judgment backend");
			},
		} as unknown as ReturnType<typeof judgment.resolveJudge>);

		const { decisions } = await curateAdvisorCandidates({ settings: settingsStub(), registry, candidates, context });

		// Fail-open: a curator outage must cost advice quality, never advice.
		expect(decisions.map(decision => decision.action)).toEqual(["keep", "keep"]);
	});

	it("keeps a candidate the judge answered nothing about", async () => {
		const candidates = [candidate("a", "one", "One")];
		stubJudge({});

		const { decisions } = await curateAdvisorCandidates({ settings: settingsStub(), registry, candidates, context });

		expect(decisions).toEqual([{ candidateId: "a", action: "keep" }]);
	});

	it("delivers every candidate unchanged when the judge exceeds the timeout", async () => {
		const candidates = [candidate("a", "one", "One"), candidate("b", "two", "Two"), candidate("c", "three", "Three")];
		spyOn(judgment, "resolveJudge").mockReturnValue({
			label: "stub",
			judge: (_request: unknown, options?: { signal?: AbortSignal }) => {
				const { promise, reject } = Promise.withResolvers<never>();
				options?.signal?.addEventListener("abort", () => reject(options.signal?.reason ?? new Error("aborted")));
				return promise;
			},
		} as unknown as ReturnType<typeof judgment.resolveJudge>);

		const { decisions } = await curateAdvisorCandidates({
			settings: settingsStub(),
			registry,
			candidates,
			context,
			signal: AbortSignal.timeout(20),
		});

		// The point of the timeout is that advice still arrives: a slow judge may
		// cost curation quality, never a note.
		expect(decisions.map(decision => decision.action)).toEqual(["keep", "keep", "keep"]);
	});

	it("marks only the surviving note as curated and renders it for the agent", () => {
		const notes: AdvisorNote[] = [
			{ note: "blocking failure", severity: "blocker", advisor: "Safety" },
			{ note: "the retry loop never backs off", severity: "concern", advisor: "Reliability" },
			{ note: "retries hammer the endpoint", severity: "nit", advisor: "Performance" },
		];
		const curatable = notes.slice(1);

		const applied = applyAdvisorCuration(notes, curatable, [
			{ candidateId: "0", action: "keep" },
			{ candidateId: "1", action: "merge", mergeInto: "0" },
		]);

		// The blocker passes through untouched and unmarked; only the note that
		// absorbed another advisor's report is flagged.
		expect(applied.map(note => note.curated)).toEqual([undefined, true]);
		const rendered = formatAdvisorBatchContent(applied);
		expect(rendered).toContain('advisor="Reliability" severity="concern" curated="true"');
		expect(rendered).not.toContain('advisor="Safety" severity="blocker" curated');
		// Attribution stays inside the note; the curator never signs it.
		expect(rendered).not.toContain("Curator");
		expect(rendered).toContain("Also raised by Performance.");
	});

	it("attributes merged sources without restating their notes", () => {
		expect(
			attributeMergedAdvisorNote("the retry loop never backs off", ["Performance", "Architecture", undefined]),
		).toBe("the retry loop never backs off\n\nAlso raised by Performance, Architecture.");
		expect(attributeMergedAdvisorNote("solo", [])).toBe("solo");
	});
});
