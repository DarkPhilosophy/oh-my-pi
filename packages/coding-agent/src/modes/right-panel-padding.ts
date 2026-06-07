const TRAILING_PADDING_RE = /[ \t]+((?:\x1b\[[0-9;]*m)*)$/u;

export function trimRightPadding(line: string): string {
	// Hot path: runs on every rendered line each frame. A trailing-padding match
	// always ends in a space, tab, or the `m` that terminates an SGR sequence,
	// so bail cheaply otherwise.
	const last = line.charCodeAt(line.length - 1);
	if (last !== 0x20 && last !== 0x09 && last !== 0x6d) return line;
	return line.replace(TRAILING_PADDING_RE, "$1");
}
