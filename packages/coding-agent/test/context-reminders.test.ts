import { describe, expect, it } from "bun:test";
import { ContextReminders, type ContextReminderInput } from "../src/session/context-reminders";

const input: ContextReminderInput = {
	scope: "window-1",
	percent: 45,
	now: 1_000_000,
	minimumPercent: 40,
	growthPercent: 20,
	cooldownMinutes: 15,
	nearThreshold: false,
};

describe("advisory context reminder admission", () => {
	it("admits context growth without a todo list and suppresses unchanged work", () => {
		const reminders = new ContextReminders();
		expect(reminders.take(input)).toBe(true);
		expect(reminders.take({ ...input, now: input.now + 3_600_000 })).toBe(false);
		expect(reminders.take({ ...input, percent: 65, now: input.now + 3_600_000 })).toBe(true);
	});

	it("requires both meaningful change and cooldown, never elapsed time alone", () => {
		const reminders = new ContextReminders();
		expect(reminders.take(input)).toBe(true);
		expect(reminders.take({ ...input, percent: 70, now: input.now + 1 })).toBe(false);
		expect(reminders.take({ ...input, now: input.now + 3_600_000 })).toBe(false);
		expect(reminders.take({ ...input, percent: 70, now: input.now + 3_600_000 })).toBe(true);
	});

	it("admits a completed task without waiting for another context growth threshold", () => {
		const reminders = new ContextReminders();
		expect(reminders.take(input)).toBe(true);
		reminders.noteCompletion();
		expect(reminders.take({ ...input, now: input.now + 1 })).toBe(false);
		expect(reminders.take({ ...input, now: input.now + 900_000 })).toBe(true);
		expect(reminders.take({ ...input, now: input.now + 1_800_000 })).toBe(false);
	});

	it("does not let new prompts reset the spam budget or require an unfinished todo", () => {
		const reminders = new ContextReminders();
		expect(reminders.take(input)).toBe(true);
		reminders.noteCompletion();
		reminders.resetPrompt();
		expect(reminders.take({ ...input, now: input.now + 900_000 })).toBe(false);
		expect(reminders.take({ ...input, percent: 65, now: input.now + 900_000 })).toBe(true);
	});

	it("caps a context window and rearms only after a real window change", () => {
		const reminders = new ContextReminders();
		for (let index = 0; index < 3; index++) {
			reminders.noteCompletion();
			expect(reminders.take({ ...input, now: input.now + index * 900_000 })).toBe(true);
		}
		reminders.noteCompletion();
		expect(reminders.take({ ...input, percent: 99, now: input.now + 3_600_000 })).toBe(false);
		expect(reminders.take({ ...input, scope: "window-2", now: input.now + 3_600_000 })).toBe(true);
	});

	it("preserves the cooldown across rollover instead of immediately nagging again", () => {
		const reminders = new ContextReminders();
		expect(reminders.take(input)).toBe(true);
		expect(reminders.take({ ...input, scope: "window-2", now: input.now + 300_000 })).toBe(false);
		expect(reminders.take({ ...input, scope: "window-2", now: input.now + 900_000 })).toBe(true);
	});

	it("coalesces near-threshold pressure and never bypasses the cooldown", () => {
		const reminders = new ContextReminders();
		expect(reminders.take({ ...input, growthPercent: 60 })).toBe(false);
		expect(reminders.take({ ...input, growthPercent: 60, nearThreshold: true })).toBe(true);
		expect(reminders.take({ ...input, nearThreshold: true, now: input.now + 1 })).toBe(false);
		expect(reminders.take({ ...input, nearThreshold: true, now: input.now + 900_000 })).toBe(false);
	});

	it("does not spend reminders on small contexts or invalid usage", () => {
		const reminders = new ContextReminders();
		reminders.noteCompletion();
		for (const percent of [0, 20, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(reminders.take({ ...input, percent })).toBe(false);
		}
		expect(reminders.take(input)).toBe(true);
	});
});
