/** Daemon status types and renderers now live in the TUI package; kept as a stable local import path. */
export {
	type DaemonConnectionSnapshot,
	type DaemonProfile,
	type DaemonSessionDisplay,
	type DaemonShard,
	formatDaemonServerStatus,
	formatDaemonWelcomeStatus,
} from "@oh-my-pi/pi-tui/chrome/daemon-status";
