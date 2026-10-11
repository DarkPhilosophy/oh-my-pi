import { cmuxMultiplexer } from "./multiplexers/cmux";
import { herdrMultiplexer } from "./multiplexers/herdr";
import { orcaMultiplexer } from "./multiplexers/orca";
import { screenMultiplexer } from "./multiplexers/screen";
import { tmuxMultiplexer } from "./multiplexers/tmux";
import type { TerminalMultiplexerModule, TerminalMultiplexerNotificationRequest } from "./multiplexers/types";
import { wmuxMultiplexer } from "./multiplexers/wmux";
import { zellijMultiplexer } from "./multiplexers/zellij";

/**
 * Every multiplexer omp recognizes, in classification order within each
 * precedence tier. Adding a multiplexer means adding its module here.
 */
const registry = [
	herdrMultiplexer,
	tmuxMultiplexer,
	screenMultiplexer,
	zellijMultiplexer,
	cmuxMultiplexer,
	wmuxMultiplexer,
	orcaMultiplexer,
] as const satisfies readonly TerminalMultiplexerModule[];

/** Terminal multiplexers omp recognizes. */
export type TerminalMultiplexer = (typeof registry)[number]["id"];

const TERMINAL_MULTIPLEXERS: readonly TerminalMultiplexerModule<TerminalMultiplexer>[] = registry;
const MULTIPLEXERS_BY_ID = Object.fromEntries(
	TERMINAL_MULTIPLEXERS.map(multiplexer => [multiplexer.id, multiplexer]),
) as Record<TerminalMultiplexer, TerminalMultiplexerModule<TerminalMultiplexer>>;
const SESSION_TIER = TERMINAL_MULTIPLEXERS.filter(multiplexer => multiplexer.precedence === "session");
const OUTER_APP_TIER = TERMINAL_MULTIPLEXERS.filter(multiplexer => multiplexer.precedence === "outerApp");
const NOTIFICATION_TIER_ORDER = ["pane", "surface", "inBand"] as const;
// Innermost target first: a pane inside a surface must receive its own signal
// before the containing surface, followed by in-band rewrites. Registry order
// breaks ties within a tier (sort is stable).
const NOTIFIERS = TERMINAL_MULTIPLEXERS.flatMap(multiplexer =>
	multiplexer.notifier ? [{ multiplexer, notifier: multiplexer.notifier }] : [],
).sort((a, b) => NOTIFICATION_TIER_ORDER.indexOf(a.notifier.tier) - NOTIFICATION_TIER_ORDER.indexOf(b.notifier.tier));

/** Every environment variable multiplexer classification reads, including the TERM fallback. */
export const TERMINAL_MULTIPLEXER_ENV_KEYS: readonly string[] = [
	...TERMINAL_MULTIPLEXERS.flatMap(multiplexer => multiplexer.sessionEnvKeys),
	"TERM",
];

/**
 * Whether an explicit session marker identifies the current provider.
 *
 * TERM is intentionally excluded: it is a classification fallback, not proof
 * that a particular multiplexer session owns the current grid.
 */
export function hasTerminalMultiplexerSession(
	multiplexer: TerminalMultiplexer,
	env: NodeJS.ProcessEnv = Bun.env,
): boolean {
	return MULTIPLEXERS_BY_ID[multiplexer].isInside(env);
}

/**
 * Every multiplexer whose explicit session markers are present, in registry
 * order. Nested sessions all appear; TERM is not consulted.
 */
export function terminalMultiplexerSessions(
	env: NodeJS.ProcessEnv = Bun.env,
): TerminalMultiplexerModule<TerminalMultiplexer>[] {
	return TERMINAL_MULTIPLEXERS.filter(multiplexer => multiplexer.isInside(env));
}

/**
 * The multiplexer TERM names, whether or not its session markers survived.
 * This is classification's TERM fallback; session markers are not consulted.
 */
export function terminalMultiplexerForTerm(
	env: NodeJS.ProcessEnv = Bun.env,
): TerminalMultiplexerModule<TerminalMultiplexer> | undefined {
	const term = env.TERM?.toLowerCase() ?? "";
	return TERMINAL_MULTIPLEXERS.find(
		multiplexer => multiplexer.termPrefix !== undefined && term.startsWith(multiplexer.termPrefix),
	);
}

/**
 * Registry entry for the multiplexer hosting the current process, or
 * `undefined` for a direct terminal. Same precedence as
 * {@link classifyTerminalMultiplexer}.
 */
export function classifyTerminalMultiplexerModule(
	env: NodeJS.ProcessEnv = Bun.env,
): TerminalMultiplexerModule<TerminalMultiplexer> | undefined {
	return (
		SESSION_TIER.find(multiplexer => multiplexer.isInside(env)) ??
		terminalMultiplexerForTerm(env) ??
		OUTER_APP_TIER.find(multiplexer => multiplexer.isInside(env))
	);
}

/**
 * Classify which terminal multiplexer hosts the current process, or `null` for
 * a direct terminal. Single source of truth for both the render-path gate
 * (`isInsideTerminalMultiplexer`) and the debug snapshot label.
 *
 * Session markers are authoritative. TERM can also survive when those markers
 * are stripped (`sudo` without -E, `su`, env-sanitizing launchers/ssh), so a
 * `tmux`/`screen` TERM prefix comes next. Outer applications such as Orca rank
 * last so a multiplexer running inside them wins.
 */
export function classifyTerminalMultiplexer(env: NodeJS.ProcessEnv = Bun.env): TerminalMultiplexer | null {
	return classifyTerminalMultiplexerModule(env)?.id ?? null;
}

/** True when the classified multiplexer owns the current screen grid. */
export function isInsideTerminalMultiplexer(env: NodeJS.ProcessEnv = Bun.env): boolean {
	return classifyTerminalMultiplexerModule(env)?.ownsScreenGrid ?? false;
}

/**
 * Offer a notification to every active session's notifier, innermost tier
 * first. Returns whether one delivered it; otherwise the terminal fallback
 * applies unchanged.
 */
export function routeTerminalMultiplexerNotification(request: TerminalMultiplexerNotificationRequest): boolean {
	return NOTIFIERS.some(({ multiplexer, notifier }) => multiplexer.isInside(request.env) && notifier.send(request));
}

/** Whether this process runs inside a Herdr pane; the predicate lives on the Herdr backend module. */
export function isInsideHerdr(env: NodeJS.ProcessEnv = Bun.env): boolean {
	return herdrMultiplexer.isInside(env);
}

/** Herdr forwards native APC only when no nested multiplexer can consume it. */
export function canQueryHerdrNativeTransport(env: NodeJS.ProcessEnv = Bun.env): boolean {
	return env.HERDR_NATIVE_TRANSPORT === "1" && isDirectHerdrPane(env);
}

/**
 * A pane Herdr relays native frames from: every client attached to it sees the
 * classic rows Herdr parses into its grid, so a native frame and the rows are
 * written together. A direct native host has no such relay.
 */
export function isDirectHerdrPane(env: NodeJS.ProcessEnv = Bun.env): boolean {
	if (!isInsideHerdr(env) || env.HERDR_PLUGIN_ID !== undefined) return false;
	if (["TMUX", "STY", "ZELLIJ", "WMUX", "WMUX_SURFACE_ID"].some(key => env[key] !== undefined)) return false;
	if (Object.keys(env).some(key => key.startsWith("CMUX_") && env[key] !== undefined)) return false;
	const term = env.TERM?.toLowerCase() ?? "";
	return !term.startsWith("tmux") && !term.startsWith("screen");
}

/**
 * Whether this Herdr pane announces that its daemon forwards Kitty graphics to
 * attached clients. Only our Herdr fork sets `HERDR_KITTY_GRAPHICS=1` at pane
 * spawn (when its `kitty_graphics` setting is on); upstream Herdr never does,
 * so it stays gated. Nested multiplexers consume or rewrite the APC, hence the
 * direct-pane requirement, and a Paseo host (xterm.js, no Kitty renderer)
 * vetoes it like every other image protocol.
 */
export function canUseHerdrKittyGraphics(env: NodeJS.ProcessEnv = Bun.env): boolean {
	return env.HERDR_KITTY_GRAPHICS === "1" && !env.PASEO_TERMINAL_ID && isDirectHerdrPane(env);
}

/** Whether discovery is safe, without sending any terminal query. */
export function canDiscoverHerdrNativeTransport(env: NodeJS.ProcessEnv = Bun.env): boolean {
	return (
		isDirectHerdrPane(env) &&
		env.HERDR_NATIVE_TRANSPORT === undefined &&
		!!env.HERDR_PANE_ID &&
		!!env.HERDR_SOCKET_PATH
	);
}

/** Whether the daemon can be asked for Kitty forwarding: a pane without the spawn marker. */
export function canDiscoverHerdrKittyGraphics(env: NodeJS.ProcessEnv = Bun.env): boolean {
	return (
		isDirectHerdrPane(env) &&
		!env.PASEO_TERMINAL_ID &&
		env.HERDR_KITTY_GRAPHICS === undefined &&
		!!env.HERDR_PANE_ID &&
		!!env.HERDR_SOCKET_PATH
	);
}

interface HerdrPingCapabilities {
	native_transport?: unknown;
	kitty_graphics?: unknown;
}

/** One bounded read-only `ping`; resolves null when the daemon cannot answer in time. */
async function pingHerdrCapabilities(env: NodeJS.ProcessEnv): Promise<HerdrPingCapabilities | null> {
	const { createConnection } = await import("node:net");
	const { promise, resolve } = Promise.withResolvers<HerdrPingCapabilities | null>();
	const socket = createConnection({ path: env.HERDR_SOCKET_PATH! });
	let buffer = "";
	let settled = false;
	const finish = (capabilities: HerdrPingCapabilities | null) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		socket.destroy();
		resolve(capabilities);
	};
	const timer = setTimeout(() => finish(null), 250);
	socket.once("error", () => finish(null));
	socket.once("close", () => finish(null));
	socket.once("connect", () =>
		socket.write(JSON.stringify({ id: "omp-native-capability", method: "ping", params: {} }) + "\n"),
	);
	socket.on("data", chunk => {
		buffer += chunk.toString();
		if (buffer.length > 65536) return finish(null);
		const end = buffer.indexOf("\n");
		if (end < 0) return;
		try {
			const reply = JSON.parse(buffer.slice(0, end));
			const valid = reply.id === "omp-native-capability" && reply.result?.type === "pong";
			finish(valid ? ((reply.result.capabilities as HerdrPingCapabilities | undefined) ?? {}) : null);
		} catch {
			finish(null);
		}
	});
	return promise;
}

/** Read-only, bounded capability discovery for panes predating the spawn hint. */
export async function queryHerdrNativeTransport(env: NodeJS.ProcessEnv = Bun.env): Promise<boolean> {
	if (canQueryHerdrNativeTransport(env)) return true;
	if (!canDiscoverHerdrNativeTransport(env)) return false;
	return (await pingHerdrCapabilities(env))?.native_transport === true;
}

/**
 * Whether the daemon of a marker-free direct Herdr pane forwards Kitty graphics
 * (`capabilities.kitty_graphics`). Fails closed on every error, old daemon or
 * missing field; an explicit `HERDR_KITTY_GRAPHICS` value is never second-guessed.
 */
export async function queryHerdrKittyGraphics(env: NodeJS.ProcessEnv = Bun.env): Promise<boolean> {
	if (canUseHerdrKittyGraphics(env)) return true;
	if (!canDiscoverHerdrKittyGraphics(env)) return false;
	return (await pingHerdrCapabilities(env))?.kitty_graphics === true;
}
