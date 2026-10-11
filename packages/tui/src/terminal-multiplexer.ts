/** True when this process is running inside a Herdr pane. */
export function isInsideHerdr(env: NodeJS.ProcessEnv = Bun.env): boolean {
	// HERDR_ENV=1 is canonical. Identity vars survive env-sanitizing launchers
	// that drop HERDR_ENV. Do not use HERDR_SOCKET_PATH, HERDR_BIN_PATH,
	// HERDR_SESSION, HERDR_CONFIG_PATH, or HERDR_CLIENT_SOCKET_PATH here: they
	// are client-side and can be set outside a Herdr pane, matching the
	// CMUX_SOCKET_PATH warning below.
	if (env.HERDR_ENV === "1") return true;
	if (env.HERDR_PANE_ID || env.HERDR_TAB_ID || env.HERDR_WORKSPACE_ID) return true;
	return false;
}

/** Terminal multiplexers omp recognizes as owning the screen grid. */
export type TerminalMultiplexer = "herdr" | "tmux" | "screen" | "zellij" | "cmux" | "wmux";

/**
 * Classify which terminal multiplexer owns the current screen grid, or `null`
 * for a direct terminal. Single source of truth for both the render-path gate
 * (`isInsideTerminalMultiplexer`) and the debug snapshot label.
 *
 * TMUX/STY/ZELLIJ, Herdr, and the CMUX/WMUX workspace/surface/remote-transport
 * markers are authoritative session signals. TERM can also survive when those
 * are stripped (`sudo` without -E, `su`, env-sanitizing launchers/ssh). Do not
 * use CMUX_SOCKET_PATH / WMUX_CLI / WMUX_PIPE here: they are CLI socket/path
 * overrides and can be set outside a CMUX/WMUX terminal. wmux is a Windows
 * multiplexer (Electron + xterm.js) modeled on cmux/herdr that repaints its
 * pane in place and exports WMUX=1 plus a native WMUX_SURFACE_ID.
 */
export function classifyTerminalMultiplexer(env: NodeJS.ProcessEnv = Bun.env): TerminalMultiplexer | null {
	if (isInsideHerdr(env)) return "herdr";
	if (env.TMUX) return "tmux";
	if (env.STY) return "screen";
	if (env.ZELLIJ) return "zellij";
	if (env.CMUX_WORKSPACE_ID || env.CMUX_SURFACE_ID || env.CMUX_REMOTE_TRANSPORT) return "cmux";
	if (env.WMUX === "1" || env.WMUX_SURFACE_ID) return "wmux";
	const term = env.TERM?.toLowerCase() ?? "";
	if (term.startsWith("tmux")) return "tmux";
	if (term.startsWith("screen")) return "screen";
	return null;
}

/** True when a terminal multiplexer owns the current screen grid. */
export function isInsideTerminalMultiplexer(env: NodeJS.ProcessEnv = Bun.env): boolean {
	return classifyTerminalMultiplexer(env) !== null;
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
