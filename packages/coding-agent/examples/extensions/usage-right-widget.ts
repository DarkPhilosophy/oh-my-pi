import type { UsageReport } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionWidgetBlock } from "@oh-my-pi/pi-coding-agent";

const WIDGET_KEY = "usage-right-widget";
const REFRESH_MS = Number.parseInt(process.env.OMP_USAGE_WIDGET_REFRESH_MS || "5000", 10) || 5000;
const FETCH_TIMEOUT_MS = Number.parseInt(process.env.OMP_USAGE_WIDGET_FETCH_TIMEOUT_MS || "2500", 10) || 2500;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

type Limit = UsageReport["limits"][number];
type Cell = { text: string } | { kind: "bar"; fraction: number | undefined };

function color(code: number, text: string): string {
	return `\x1b[${code}m${text}\x1b[0m`;
}

function visibleWidth(text: unknown): number {
	return String(text ?? "").replace(ANSI_RE, "").length;
}

function remainingFraction(amount: Limit["amount"]): number | undefined {
	if (!amount) return undefined;
	if (Number.isFinite(amount.remainingFraction)) return amount.remainingFraction;
	if (Number.isFinite(amount.usedFraction)) return Math.max(0, 1 - amount.usedFraction);
	return undefined;
}

function statusColor(fraction: number | undefined): number {
	if (!Number.isFinite(fraction)) return 90;
	if ((fraction ?? 0) <= 0.15) return 31;
	if ((fraction ?? 0) <= 0.4) return 33;
	return 32;
}

function statusTag(limit: Limit, fraction: number | undefined, blockedByOtherWindow: boolean): string {
	if (limit.status === "exhausted") {
		if (Number.isFinite(fraction) && (fraction ?? 0) > 0.01) return color(33, "[!]");
		return color(31, "[x]");
	}
	if (blockedByOtherWindow && Number.isFinite(fraction) && (fraction ?? 0) > 0.01) return color(33, "[!]");
	if (limit.status === "warning") return color(33, "[!]");
	if (limit.status === "ok") return color(32, "[ok]");
	if (Number.isFinite(fraction)) return (fraction ?? 0) <= 0.4 ? color(33, "[!]") : color(32, "[ok]");
	return color(90, "[?]");
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

function ordinalDay(n: number): string {
	const mod100 = n % 100;
	if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
	switch (n % 10) {
		case 1:
			return `${n}st`;
		case 2:
			return `${n}nd`;
		case 3:
			return `${n}rd`;
		default:
			return `${n}th`;
	}
}

function resetLabel(resetsAt: number): string {
	const duration = shortDuration(resetsAt - Date.now());
	if (!duration) return "";
	const at = new Date(resetsAt);
	const now = new Date();
	const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	const sameDay =
		at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
	if (sameDay) return `${duration} at ${time}`;
	return `${duration} at ${ordinalDay(at.getDate())} ${time}`;
}

function providerLabel(provider: string): string {
	return provider
		.split(/[-_]/g)
		.map(part => (part ? part[0]?.toUpperCase() + part.slice(1) : ""))
		.join(" ");
}

function accountLabel(report: UsageReport, limit: Limit | undefined): string {
	const email = report.metadata?.email;
	if (typeof email === "string" && email) return email;
	const accountId = report.metadata?.accountId ?? limit?.scope?.accountId;
	return typeof accountId === "string" && accountId ? accountId : "account";
}

function formatInt(n: number | undefined): string {
	return Number.isFinite(n) ? Math.round(n as number).toLocaleString("en-US") : "0";
}

function costText(ctx: ExtensionContext): string {
	const cost = ctx.sessionManager?.getUsageStatistics?.().cost;
	return Number.isFinite(cost) && cost > 0 ? ` > $${cost.toFixed(2)}` : "";
}

function row(text: string, inner: number): string {
	return `│${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))}│`;
}

function barText(fraction: number | undefined, inner: number): string {
	const safe = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction ?? 0)) : 0;
	const label = Number.isFinite(fraction) ? `${(safe * 100).toFixed(0)}% free` : "n/a";
	const prefix = "   ";
	const cells = Math.max(1, inner - visibleWidth(prefix) - 1 - visibleWidth(label));
	const filled = Math.round(safe * cells);
	const bar = color(statusColor(fraction), "█".repeat(filled)) + color(90, "░".repeat(cells - filled));
	return `${prefix}${bar} ${label}`;
}

function boxFromCells(cells: Cell[]): string[] {
	const inner = cells.reduce((max, cell) => {
		if ("kind" in cell) return max;
		return Math.max(max, visibleWidth(cell.text));
	}, 0);
	const resolved = cells.map(cell => ("kind" in cell ? barText(cell.fraction, inner) : cell.text));
	const finalInner = resolved.reduce((max, text) => Math.max(max, visibleWidth(text)), inner);
	return [
		`┌${"─".repeat(finalInner)}┐`,
		...resolved.map(text => row(text, finalInner)),
		`└${"─".repeat(finalInner)}┘`,
	];
}

function buildBlocks(ctx: ExtensionContext, reports: UsageReport[] | null): ExtensionWidgetBlock[] {
	const summaryRows: Cell[] = [{ text: " Usage" }];
	const usage = ctx.getContextUsage?.();
	if (usage) {
		const percent = Number.isFinite(usage.percent)
			? usage.percent > 1
				? usage.percent
				: usage.percent * 100
			: undefined;
		summaryRows.push({
			text: ` ctx ${formatInt(usage.tokens ?? undefined)}/${formatInt(usage.contextWindow)}${percent != null ? ` ${percent.toFixed(0)}%` : ""}${costText(ctx)}`,
		});
	}

	const blocks: ExtensionWidgetBlock[] = [{ lines: boxFromCells(summaryRows), priority: -1000 }];
	const provider = ctx.model?.provider;
	const filtered = provider ? (reports ?? []).filter(report => report.provider === provider) : (reports ?? []);
	if (filtered.length === 0) {
		blocks.push({ lines: boxFromCells([{ text: color(90, " provider usage: n/a") }]), priority: 0 });
		return blocks;
	}

	for (const [index, report] of filtered.entries()) {
		const rows: Cell[] = [{ text: ` ${providerLabel(report.provider)}` }];
		const account = accountLabel(report, report.limits[0]);
		const blockedByOtherWindow = report.limits.some(
			limit => limit.status === "exhausted" && (remainingFraction(limit.amount) ?? 0) <= 0.01,
		);
		for (const limit of report.limits) {
			const fraction = remainingFraction(limit.amount);
			const reset = limit.window?.resetsAt ? resetLabel(limit.window.resetsAt) : "";
			const windowLabel = limit.window?.label ?? limit.scope?.windowId ?? "";
			const tag = statusTag(limit, fraction, blockedByOtherWindow);
			const label = limit.label || windowLabel || "limit";
			const head = windowLabel && !label.includes(windowLabel) ? `${label} ${windowLabel}` : label;
			rows.push({ text: ` ${tag} ${head}` });
			rows.push({ text: `   ${account}${reset ? ` (${reset})` : ""}` });
			rows.push({ kind: "bar", fraction });
		}
		blocks.push({ lines: boxFromCells(rows), priority: index });
	}
	return blocks;
}

export default function usageRightWidget(pi: ExtensionAPI): void {
	let timer: Timer | undefined;
	let latestCtx: ExtensionContext | undefined;
	let latestReports: UsageReport[] | null = null;
	let busy = false;

	async function fetchReports(ctx: ExtensionContext): Promise<UsageReport[] | null> {
		if (typeof ctx.fetchUsageReports !== "function") return latestReports;
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
		ctx.ui.setWidget(WIDGET_KEY, buildBlocks(ctx, reports), { placement: "rightEditor" });
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
