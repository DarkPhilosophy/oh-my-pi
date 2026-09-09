import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

describe("renderUsageReports content", () => {
	beforeAll(async () => {
		const darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Expected dark theme");
		setThemeInstance(darkTheme);
	});

	it("renders bars and free percentage for limits that only report remainingFraction", () => {
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: 1_700_000_000_000,
				limits: [
					{
						id: "codex-weekly",
						label: "Weekly",
						scope: { provider: "openai-codex", tier: "pro", accountId: "acct-1" },
						window: { id: "weekly", label: "weekly" },
						amount: { remainingFraction: 0.25, unit: "requests" },
						status: "ok",
					},
				],
				metadata: { email: "user@example.com" },
			},
		];

		const output = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 98));
		expect(output).toContain("25% free");
		expect(output).toMatch(/[█░]/);
		expect(output).not.toContain("··········");
	});

	it("renders Cursor request quotas in the /usage view", () => {
		const now = Date.now();
		const reports: UsageReport[] = [
			{
				provider: "cursor",
				fetchedAt: now,
				limits: [
					{
						id: "cursor:requests:gpt-4",
						label: "gpt-4 requests",
						scope: { provider: "cursor", windowId: "monthly" },
						window: { id: "monthly", label: "Monthly", resetsAt: now + 90_000_000 },
						amount: {
							unit: "requests",
							used: 150,
							limit: 500,
							remaining: 350,
							usedFraction: 0.3,
							remainingFraction: 0.7,
						},
						status: "ok",
					},
				],
				metadata: { email: "cursor@example.test" },
			},
		];

		const output = stripVTControlCharacters(renderUsageReports(reports, theme, now, 98));
		expect(output).toContain("Cursor");
		expect(output).toContain("gpt-4 requests");
		expect(output).toContain("70% free");
		expect(output).toContain("resets in 1d");
	});

	it("renders saved reset expiry lines for future and expired credits", () => {
		const now = Date.now();
		const dayMs = 24 * 60 * 60 * 1000;
		const futureIso = new Date(now + 2 * dayMs).toISOString();
		const expiredIso = new Date(now - 2 * dayMs).toISOString();
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: now,
				limits: [],
				metadata: { email: "user@example.com" },
				resetCredits: {
					availableCount: 2,
					credits: [{ expiresAt: futureIso }, { expiresAt: expiredIso }],
				},
			},
		];

		const output = stripVTControlCharacters(renderUsageReports(reports, theme, now, 98));
		expect(output).toContain("Saved rate-limit resets");
		expect(output).toContain("user@example.com: 2 saved resets");
		expect(output).toContain(`expires in`);
		expect(output).toContain(`(${futureIso.slice(0, 10)})`);
		expect(output).toContain(`expired (${expiredIso.slice(0, 10)})`);
	});

	it("keeps combined fractional quota rows within narrow report widths", () => {
		const reports: UsageReport[] = ["acct-1", "acct-2"].map((accountId, index) => ({
			provider: "openai-codex",
			fetchedAt: 1_700_000_000_000,
			limits: [
				{
					id: "codex-weekly",
					label: "Weekly",
					scope: { provider: "openai-codex", tier: "pro", accountId },
					window: { id: "weekly", label: "weekly" },
					amount: { usedFraction: index === 0 ? 0.25 : 0.75, unit: "requests" },
					status: "ok",
				},
			],
			metadata: { email: `user${index + 1}@example.com`, accountId },
		}));

		const width20Output = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 20));
		const width20QuotaLines = width20Output
			.split("\n")
			.filter(line => line.includes("free") || line.includes("combined"));
		expect(width20QuotaLines.every(line => [...line].length <= 20)).toBe(true);
		expect(width20Output).toContain("combined");

		const width16Output = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 16));
		const width16QuotaLines = width16Output
			.split("\n")
			.filter(line => line.includes("free") || line.includes("combined"));
		expect(width16QuotaLines.every(line => [...line].length <= 16)).toBe(true);
	});

	it("marks metadata-only saved resets active and bounds sanitized organization labels", () => {
		const width = 48;
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: Date.now(),
				limits: [],
				metadata: {
					email: "active@example.com",
					accountId: "acct-active",
					orgName: `Team\t\x1b[2J${" very-long".repeat(12)}`,
				},
				resetCredits: { availableCount: 1 },
			},
		];
		const rendered = renderUsageReports(reports, theme, Date.now(), width, () => ({
			email: "active@example.com",
			accountId: "acct-active",
		}));
		const output = stripVTControlCharacters(rendered);
		const resetLine = output.split("\n").find(line => line.includes("saved reset"));
		expect(resetLine).toBeDefined();
		expect(resetLine).toContain("(active)");
		expect(resetLine).not.toContain("\t");
		expect(resetLine!.length).toBeLessThanOrEqual(width);
	});

	it("distinguishes masked saved reset labels whose qualified account labels differ", () => {
		const reports: UsageReport[] = ["First org", "Second org"].map((orgName, index) => ({
			provider: "openai-codex",
			fetchedAt: 1_700_000_000_000,
			limits: [],
			metadata: {
				email: index === 0 ? "main-one@example.com" : "main-two@example.com",
				accountId: `acct-${index + 1}`,
				orgName,
			},
			resetCredits: { availableCount: 1 },
		}));

		const output = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 98, undefined, { maskAccountLabels: true }),
		);
		expect(output).toContain("mai*** (First org): 1 saved reset");
		expect(output).toContain("mai*** (Second org): 1 saved reset");
	});

	it("marks the active saved reset and disambiguates a reportless active identity", () => {
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: Date.now(),
				limits: [
					{
						id: "weekly",
						label: "Weekly",
						scope: { provider: "openai-codex", accountId: "acct-a" },
						window: { id: "weekly", label: "weekly" },
						amount: { usedFraction: 0.1, unit: "requests" },
						status: "ok",
					},
				],
				metadata: { email: "main-one@example.com", orgId: "org-a", orgName: "Team A" },
				resetCredits: { availableCount: 1 },
			},
			{
				provider: "openai-codex",
				fetchedAt: Date.now(),
				limits: [],
				metadata: { email: "main-two@example.com", orgName: "Team B" },
				resetCredits: { availableCount: 1 },
			},
		];
		const output = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 98, () => ({
				email: "main-one@example.com",
				orgId: "org-a",
				orgName: "Team A",
			})),
		);
		expect(output).toContain("main-one@example.com (Team A): 1 saved reset (active)");
		expect(output).toContain("main-two@example.com (Team B): 1 saved reset");
	});

	it("normalizes CRLF account labels and masks short opaque identities", () => {
		const reports: UsageReport[] = [{
			provider: "openai-codex",
			fetchedAt: Date.now(),
			limits: [],
			metadata: { accountId: "ab\r\ncd", orgName: "Org\tName" },
			resetCredits: { availableCount: 1 },
		}];
		const output = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 80, undefined, { maskAccountLabels: true }),
		);
		const resetLine = output.split("\n").find(line => line.includes("saved reset"));
		expect(resetLine).toContain("a*** cd (Org   Name): 1 saved reset");
		expect(output).not.toContain("\r");
		expect(output).not.toContain("\t");
	});
});
