import type { UsageReport } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const WIDGET_KEY = "usage-right-widget";
const REFRESH_MS = Number.parseInt(process.env.OMP_USAGE_WIDGET_REFRESH_MS || "5000", 10) || 5000;
const FETCH_TIMEOUT_MS = Number.parseInt(process.env.OMP_USAGE_WIDGET_FETCH_TIMEOUT_MS || "2500", 10) || 2500;
const INNER = 38;
const BAR = 16;

function color(code: number, text: string): string {
	return `\x1b[${code}m${text}\x1b[0m`;
}

function remainingFraction(amount: UsageReport["limits"][number]["amount"]): number | undefined {
	if (!amount) return undefined;
	if (Number.isFinite(amount.remainingFraction)) return amount.remainingFraction;
	if (Number.isFinite(amount.usedFraction)) return Math.max(0, 1 - amount.usedFraction);
	return undefined;
}

function statusColor(fraction: number | undefined): number {
	if (!Number.isFinite(fraction)) return 90;
	if (fraction <= 0.15) return 31;
	if (fraction <= 0.4) return 33;
	return 32;
}

function statusTag(
	limit: UsageReport["limits"][number],
	fraction: number | undefined,
): { text: string; width: number } {
	if (limit.status === "exhausted") return { text: color(31, "[x]"), width: 3 };
	if (limit.status === "warning") return { text: color(33, "[!]"), width: 3 };
	if (limit.status === "ok") return { text: color(32, "[ok]"), width: 4 };
	if (Number.isFinite(fraction))
		return fraction <= 0.4 ? { text: color(33, "[!]"), width: 3 } : { text: color(32, "[ok]"), width: 4 };
	return { text: color(90, "[?]"), width: 3 };
}

function shortDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "";
	const minutes = Math.floor(ms / 60000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rem = minutes % 60;
	if (hours < 24) return rem ? `${hours}h${rem}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	const hour = hours % 24;
	return hour ? `${days}d${hour}h` : `${days}d`;
}

function providerLabel(provider: string): string {
	return provider
		.split(/[-_]/g)
		.map(part => (part ? part[0]?.toUpperCase() + part.slice(1) : ""))
		.join(" ");
}

function accountLabel(report: UsageReport, limit: UsageReport["limits"][number] | undefined): string {
	const email = report.metadata?.email;
	if (typeof email === "string" && email) return email;
	const accountId = report.metadata?.accountId ?? limit?.scope?.accountId;
	return typeof accountId === "string" && accountId ? accountId : "account";
}

function formatInt(n: number | undefined): string {
	return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "0";
}

function clip(text: unknown, max: number): string {
	const value = String(text ?? "");
	if (value.length <= max) return value;
	return max <= 1 ? value.slice(0, max) : `${value.slice(0, max - 1)}…`;
}

function row(text: string): string {
	const value = clip(text, INNER);
	return `│${value}${" ".repeat(Math.max(0, INNER - value.length))}│`;
}

function coloredRow(text: string, visibleWidth: number): string {
	return `│${text}${" ".repeat(Math.max(0, INNER - visibleWidth))}│`;
}

function barLine(fraction: number | undefined): string {
	const safe = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
	const filled = Math.round(safe * BAR);
	const bar = color(statusColor(fraction), "█".repeat(filled)) + color(90, "░".repeat(BAR - filled));
	const label = Number.isFinite(fraction) ? `${(safe * 100).toFixed(0)}% free` : "n/a";
	return coloredRow(`   ${bar} ${label}`, 3 + BAR + 1 + label.length);
}

function box(rows: string[]): string[] {
	return [`┌${"─".repeat(INNER)}┐`, ...rows, `└${"─".repeat(INNER)}┘`];
}

function buildLines(ctx: ExtensionContext, reports: UsageReport[] | null): string[] {
	const rows: string[] = [row(" Usage")];
	const usage = ctx.getContextUsage?.();
	if (usage) {
		const percent = Number.isFinite(usage.percent)
			? usage.percent > 1
				? usage.percent
				: usage.percent * 100
			: undefined;
		rows.push(
			row(
				` ctx ${formatInt(usage.tokens)}/${formatInt(usage.contextWindow)}${percent != null ? ` ${percent.toFixed(0)}%` : ""}`,
			),
		);
	}

	const provider = ctx.model?.provider;
	const filtered = provider ? (reports ?? []).filter(report => report.provider === provider) : (reports ?? []);
	if (filtered.length === 0) {
		rows.push(row(""));
		rows.push(row(" provider usage: n/a"));
		return box(rows);
	}

	for (const report of filtered) {
		rows.push(row(""));
		rows.push(row(` ${providerLabel(report.provider)}`));
		const account = accountLabel(report, report.limits[0]);
		for (const limit of report.limits) {
			const fraction = remainingFraction(limit.amount);
			const reset = limit.window?.resetsAt ? shortDuration(limit.window.resetsAt - Date.now()) : "";
			const windowLabel = limit.window?.label ?? limit.scope?.windowId ?? "";
			const tag = statusTag(limit, fraction);
			const head = windowLabel && !limit.label.includes(windowLabel) ? `${limit.label} ${windowLabel}` : limit.label;
			const headText = clip(head, INNER - tag.width - 2);
			rows.push(coloredRow(` ${tag.text} ${headText}`, 1 + tag.width + 1 + headText.length));
			rows.push(row(`   ${clip(account, INNER - 6 - reset.length)}${reset ? ` (${reset})` : ""}`));
			rows.push(barLine(fraction));
		}
	}
	return box(rows);
}

export default function usageRightWidget(pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setInterval> | undefined;
	let latestCtx: ExtensionContext | undefined;
	let latestReports: UsageReport[] | null = null;
	let busy = false;

	async function fetchReports(ctx: ExtensionContext): Promise<UsageReport[] | null> {
		try {
			const { promise: timeout, resolve } = Promise.withResolvers<undefined>();
			const handle = setTimeout(() => resolve(undefined), FETCH_TIMEOUT_MS);
			handle.unref?.();
			const reports = await Promise.race([ctx.fetchUsageReports(), timeout]);
			if (Array.isArray(reports)) latestReports = reports;
			return Array.isArray(reports) ? reports : latestReports;
		} catch {
			return latestReports;
		}
	}

	function paint(ctx: ExtensionContext, reports: UsageReport[] | null = latestReports): void {
		ctx.ui.setWidget(WIDGET_KEY, buildLines(ctx, reports), { placement: "rightEditor" });
	}

	async function refresh(ctxArg?: ExtensionContext, options: { network?: boolean } = {}): Promise<void> {
		const ctx = ctxArg ?? latestCtx;
		if (!ctx?.hasUI) return;
		latestCtx = ctx;
		paint(ctx);
		if (options.network === false || busy) return;
		busy = true;
		try {
			paint(ctx, await fetchReports(ctx));
		} finally {
			busy = false;
		}
	}

	function startTimer(): void {
		if (timer) return;
		timer = setInterval(() => void refresh(undefined, { network: true }), REFRESH_MS);
		timer.unref?.();
	}

	function stopTimer(): void {
		if (!timer) return;
		clearInterval(timer);
		timer = undefined;
	}

	pi.registerCommand("usage-panel", {
		description: "Refresh the right-side usage panel",
		handler: async (_args, ctx) => {
			await refresh(ctx, { network: true });
			ctx.ui.notify("usage panel refreshed", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		startTimer();
		await refresh(ctx, { network: true });
	});
	pi.on("turn_start", async (_event, ctx) => {
		latestCtx = ctx;
		await refresh(ctx, { network: false });
	});
	pi.on("agent_start", async (_event, ctx) => {
		latestCtx = ctx;
		await refresh(ctx, { network: false });
	});
	pi.on("message_start", async (_event, ctx) => {
		latestCtx = ctx;
		await refresh(ctx, { network: false });
	});
	pi.on("message_update", async (_event, ctx) => {
		latestCtx = ctx;
		await refresh(ctx, { network: false });
	});
	pi.on("message_end", async (_event, ctx) => {
		latestCtx = ctx;
		await refresh(ctx, { network: false });
	});
	pi.on("tool_execution_start", async (_event, ctx) => {
		latestCtx = ctx;
		await refresh(ctx, { network: false });
	});
	pi.on("tool_execution_update", async (_event, ctx) => {
		latestCtx = ctx;
		await refresh(ctx, { network: false });
	});
	pi.on("tool_execution_end", async (_event, ctx) => {
		latestCtx = ctx;
		await refresh(ctx, { network: false });
	});
	pi.on("turn_end", async (_event, ctx) => {
		latestCtx = ctx;
		await refresh(ctx, { network: true });
	});
	pi.on("agent_end", async (_event, ctx) => {
		latestCtx = ctx;
		await refresh(ctx, { network: true });
	});
	pi.on("session_switch", async (_event, ctx) => {
		latestCtx = ctx;
		await refresh(ctx, { network: true });
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopTimer();
		ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "rightEditor" });
	});
}
