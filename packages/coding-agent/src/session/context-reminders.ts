export interface ContextReminderInput {
	scope: string;
	percent: number;
	now: number;
	minimumPercent: number;
	growthPercent: number;
	cooldownMinutes: number;
	nearThreshold: boolean;
}

/** Advisory admission only: never schedules turns or performs context maintenance. */
export class ContextReminders {
	#scope: string | undefined;
	#count = 0;
	#lastAt = Number.NEGATIVE_INFINITY;
	#lastPercent = 0;
	#completion = false;
	#pressureSeen = false;

	noteCompletion(): void {
		this.#completion = true;
	}

	resetPrompt(): void {
		this.#completion = false;
	}

	take(input: ContextReminderInput): boolean {
		if (this.#scope !== input.scope) {
			this.#scope = input.scope;
			this.#count = 0;
			this.#lastPercent = 0;
			this.#pressureSeen = false;
		}
		if (!Number.isFinite(input.percent) || input.percent < input.minimumPercent || this.#count >= 3) return false;
		if (input.now - this.#lastAt < input.cooldownMinutes * 60_000) return false;
		const growth = input.percent - this.#lastPercent >= input.growthPercent;
		const pressure = input.nearThreshold && !this.#pressureSeen;
		if (!this.#completion && !growth && !pressure) return false;
		this.#count++;
		this.#lastAt = input.now;
		this.#lastPercent = input.percent;
		this.#completion = false;
		this.#pressureSeen ||= input.nearThreshold;
		return true;
	}
}
