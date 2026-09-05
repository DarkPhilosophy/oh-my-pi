import type { Terminal, TerminalAppearance, TerminalStartOptions } from "@oh-my-pi/pi-tui";

/**
 * Env that identifies the CLIENT terminal (multiplexer pane, terminal program,
 * remote link). Hosted sessions run extensions in the daemon process, whose
 * own env belongs to whichever client spawned it first — integrations like
 * herdr need the env of the terminal actually attached to THIS session.
 * Deliberately minimal: exact keys plus a few well-known multiplexer families;
 * never forward the full client env (keys/secrets) to the daemon.
 */
const CLIENT_TERMINAL_ENV_KEYS: Record<string, true> = {
	TERM: true,
	COLORTERM: true,
	FORCE_COLOR: true,
	NO_COLOR: true,
	TERM_PROGRAM: true,
	TERM_PROGRAM_VERSION: true,
	TERM_FEATURES: true,
	WT_SESSION: true,
	COLORFGBG: true,
	STY: true,
	DISPLAY: true,
	WAYLAND_DISPLAY: true,
	SSH_TTY: true,
	SSH_CONNECTION: true,
	TMUX: true,
	TMUX_PANE: true,
	HERDR_ENV: true,
	HERDR_SOCKET_PATH: true,
	HERDR_PANE_ID: true,
	HERDR_OMP_IDLE_DEBOUNCE_MS: true,
	HERDR_OMP_RETRY_GRACE_MS: true,
};
const CLIENT_TERMINAL_ENV_PREFIXES = ["KITTY_", "WEZTERM_", "ZELLIJ", "VSCODE_"] as const;

/** Snapshot the terminal-identity subset of an environment for a hosted session. */
export function clientTerminalEnvSnapshot(
	env: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const snapshot: Record<string, string> = {};
	for (const key in env) {
		const value = env[key];
		if (typeof value !== "string") continue;
		if (CLIENT_TERMINAL_ENV_KEYS[key] || CLIENT_TERMINAL_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) {
			snapshot[key] = value;
		}
	}
	return snapshot;
}

export type HostedTerminalDescriptor = {
	columns: number;
	rows: number;
	kittyProtocolActive: boolean;
	kittyEnableSequence: string | null;
	keyboardEnhancementEnterSequence?: string | null;
	keyboardEnhancementExitSequence?: string | null;
	appearance?: TerminalAppearance;
	/** Whether the attached terminal was focused when the descriptor was captured. */
	focused?: boolean;
	/** Terminal-identity env of the attached client (see {@link clientTerminalEnvSnapshot}). */
	clientEnv?: Record<string, string>;
};

export type HostedTerminalSize = Pick<HostedTerminalDescriptor, "columns" | "rows">;

export class HostedTerminal implements Terminal {
	#columns: number;
	#rows: number;
	#appearance: TerminalAppearance | undefined;
	readonly kittyProtocolActive: boolean;
	readonly kittyEnableSequence: string | null;
	readonly keyboardEnhancementEnterSequence: string | null;
	readonly keyboardEnhancementExitSequence: string | null;
	#inputHandler: ((data: string) => void) | undefined;
	#resizeHandler: (() => void) | undefined;
	#focusHandler: ((focused: boolean) => void) | undefined;
	#focused: boolean;
	#appearanceListeners = new Set<(appearance: TerminalAppearance) => void>();
	#output: ((data: string) => void) | undefined;
	#pendingOutput: string[] = [];
	#outputFlushQueued = false;
	#pendingOutputBytes = 0;
	readonly #transportPendingBytes: () => number;

	constructor(descriptor: HostedTerminalDescriptor, transportPendingBytes: () => number = () => 0) {
		this.#transportPendingBytes = transportPendingBytes;
		this.#columns = descriptor.columns;
		this.#rows = descriptor.rows;
		this.#appearance = descriptor.appearance;
		this.#focused = descriptor.focused ?? true;
		this.kittyProtocolActive = descriptor.kittyProtocolActive;
		this.kittyEnableSequence = descriptor.kittyEnableSequence;
		this.keyboardEnhancementEnterSequence = descriptor.keyboardEnhancementEnterSequence ?? null;
		this.keyboardEnhancementExitSequence = descriptor.keyboardEnhancementExitSequence ?? null;
	}

	get columns(): number {
		return this.#columns;
	}

	get rows(): number {
		return this.#rows;
	}

	get pendingOutputBytes(): number {
		return this.#pendingOutputBytes + this.#transportPendingBytes();
	}

	get appearance(): TerminalAppearance | undefined {
		return this.#appearance;
	}

	start(
		onInput: (data: string) => void,
		onResize: () => void,
		_onDisconnect?: () => void,
		options?: TerminalStartOptions,
	): void {
		this.#inputHandler = onInput;
		this.#resizeHandler = onResize;
		this.#focusHandler = options?.onFocusChange;
		this.#focusHandler?.(this.#focused);
	}

	stop(): void {
		this.#inputHandler = undefined;
		this.#resizeHandler = undefined;
		this.#focusHandler = undefined;
	}

	setFocus(focused: boolean): void {
		if (focused === this.#focused) return;
		this.#focused = focused;
		this.#focusHandler?.(focused);
	}

	drainInput(): Promise<void> {
		return Promise.resolve();
	}

	setOutput(output: ((data: string) => void) | undefined): void {
		if (output !== this.#output) this.#flushOutput();
		this.#output = output;
	}

	input(data: string): void {
		this.#inputHandler?.(data);
	}

	resize(size: HostedTerminalSize): void {
		if (size.columns === this.#columns && size.rows === this.#rows) return;
		this.#columns = size.columns;
		this.#rows = size.rows;
		this.#resizeHandler?.();
	}

	setAppearance(appearance: TerminalAppearance): void {
		if (appearance === this.#appearance) return;
		this.#appearance = appearance;
		for (const listener of this.#appearanceListeners) listener(appearance);
	}

	write(data: string): void {
		if (!this.#output) return;
		this.#pendingOutput.push(data);
		this.#pendingOutputBytes += Buffer.byteLength(data, "utf8");
		if (this.#outputFlushQueued) return;
		this.#outputFlushQueued = true;
		queueMicrotask(() => {
			this.#outputFlushQueued = false;
			this.#flushOutput();
		});
	}

	#flushOutput(): void {
		if (this.#pendingOutput.length === 0) return;
		const data = this.#pendingOutput.join("");
		this.#pendingOutput.length = 0;
		this.#pendingOutputBytes = 0;
		this.#output?.(data);
	}

	moveBy(lines: number): void {
		if (lines > 0) this.write(`\x1b[${lines}B`);
		else if (lines < 0) this.write(`\x1b[${-lines}A`);
	}

	hideCursor(): void {
		this.write("\x1b[?25l");
	}

	showCursor(): void {
		this.write("\x1b[?25h");
	}

	clearLine(): void {
		this.write("\x1b[2K");
	}

	clearFromCursor(): void {
		this.write("\x1b[0J");
	}

	clearScreen(): void {
		this.write("\x1b[2J\x1b[H");
	}

	setTitle(title: string): void {
		this.write(`\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		this.write(`\x1b]9;4;${active ? 1 : 0}\x1b\\`);
	}

	onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void {
		this.#appearanceListeners.add(callback);
		if (this.#appearance !== undefined) callback(this.#appearance);
	}
}

export type ClientTerminalBridgeHandlers = {
	onInput(data: string): void;
	onResize(size: HostedTerminalSize): void;
	onAppearance(appearance: TerminalAppearance): void;
	onFocus(focused: boolean): void;
};

export class ClientTerminalBridge {
	readonly #terminal: Terminal;
	readonly #handlers: ClientTerminalBridgeHandlers;
	#started = false;

	constructor(terminal: Terminal, handlers: ClientTerminalBridgeHandlers) {
		this.#terminal = terminal;
		this.#handlers = handlers;
	}

	start(): void {
		if (this.#started) return;
		this.#started = true;
		this.#terminal.onAppearanceChange(appearance => this.#handlers.onAppearance(appearance));
		this.#terminal.start(
			data => this.#handlers.onInput(data),
			() => this.#handlers.onResize({ columns: this.#terminal.columns, rows: this.#terminal.rows }),
			undefined,
			{ onFocusChange: focused => this.#handlers.onFocus(focused) },
		);
	}

	output(data: string): void {
		this.#terminal.write(data);
	}

	async stop(): Promise<void> {
		if (!this.#started) return;
		this.#started = false;
		await this.#terminal.drainInput();
		this.#terminal.stop();
	}
}
