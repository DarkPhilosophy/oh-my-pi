import type { Component } from "@oh-my-pi/pi-tui";

const GAP: readonly string[] = [""];
const FLUSH: readonly string[] = [];

/**
 * One-line top margin between the working/status HUD row and the editor.
 * The band composer's status band is designed to sit flush under the working
 * row, so the gap collapses there — but only while that row actually rendered
 * content (the loader and idle title bring their own leading blank). An empty
 * status row keeps the gap so the band never sits flush against the
 * transcript. Shape and row state are read at render time, so runtime changes
 * apply immediately.
 */
export class EditorTopGap implements Component {
	/**
	 * @param statusRowOccupied Whether the status/working row directly above rendered lines this frame.
	 * @param composerShape Current session-scoped composer shape.
	 */
	constructor(
		readonly statusRowOccupied: () => boolean,
		readonly composerShape: () => string | undefined,
	) {}

	render(_width: number): readonly string[] {
		return this.composerShape() === "band" && this.statusRowOccupied() ? FLUSH : GAP;
	}
}
