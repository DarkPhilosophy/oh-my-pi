import { loadNative } from "./loader-state.js";

/** Copy text to the clipboard, loading the native addon on first use. */
export function copyToClipboard(text) {
	return loadNative().copyToClipboard(text);
}

/** Read text from the clipboard, loading the native addon on first use. */
export function readTextFromClipboard() {
	/** @type {{ readTextFromClipboard(): string }} */
	const native = loadNative();
	return native.readTextFromClipboard();
}

/** Read an image from the clipboard, loading the native addon on first use. */
export function readImageFromClipboard() {
	return loadNative().readImageFromClipboard();
}
