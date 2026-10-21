import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { QueuedMessagesBand } from "@oh-my-pi/pi-tui/prompt/queued-messages";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

afterAll(() => {
	resetSettingsForTest();
});

/** A node's props as a plain record: narrowed at runtime, never asserted. */
function propsOf(node: NativeNode): Record<string, unknown> {
	const props: unknown = node.p;
	return props !== null && typeof props === "object" ? Object.fromEntries(Object.entries(props)) : {};
}

function walk(node: NativeNode, visit: (node: NativeNode) => void): void {
	visit(node);
	for (const child of node.c ?? []) {
		if (typeof child === "object" && child !== null && "k" in child) walk(child, visit);
	}
}

function find(root: NativeNode, predicate: (node: NativeNode) => boolean): NativeNode[] {
	const found: NativeNode[] = [];
	walk(root, node => {
		if (predicate(node)) found.push(node);
	});
	return found;
}

function first(nodes: readonly NativeNode[]): NativeNode {
	const [node] = nodes;
	if (node === undefined) throw new Error("expected a node, found none");
	return node;
}

describe("queued messages on the native wire", () => {
	const message = "first line\n\n    indented second\r\nthird\twith tab";
	const band = () => new QueuedMessagesBand([{ label: "Steering", messages: [message] }], "alt+up", () => {});

	it("keeps newlines and indentation and wraps by word without truncating", () => {
		const pill = first(find(band().describe(), node => propsOf(node).role === "omp.queue.item"));
		const props = propsOf(first(find(pill, node => node.k === "text")));
		expect(typeof props.text).toBe("string");
		expect(String(props.text).startsWith("first line\n\n    indented second\nthird")).toBe(true);
		expect(String(props.text)).not.toContain("\u21b5");
		expect(String(props.text)).not.toContain("\r");
		expect(props.wrap).toBe("word");
		expect(props.truncate).toBeUndefined();
		expect(props.grow).toBe(1);
	});

	it("keeps the Edit control reachable beside the text", () => {
		const edit = first(find(band().describe(), node => propsOf(node).role === "omp.queue.edit"));
		const actions = propsOf(edit).actions;
		expect(actions !== null && typeof actions === "object" && "click" in actions ? actions.click : undefined).toBe(
			"queue.edit",
		);
	});
});

describe("user messages on the native wire", () => {
	it("asks for real line breaks for typed text, leaving the text itself unchanged", () => {
		const text = "one\ntwo\n\n```ts\nlet a = 1;\nlet b = 2;\n```\nfour \u21b5 literal";
		const props = propsOf(first(find(new UserMessageComponent(text).describe(), node => node.k === "md")));
		expect(props.breaks).toBe("hard");
		expect(props.text).toBe(text);
	});

	it("leaves synthetic, agent-attributed input as ordinary markdown", () => {
		const markdown = first(
			find(new UserMessageComponent("one\ntwo", { synthetic: true }).describe(), node => node.k === "md"),
		);
		expect(propsOf(markdown).breaks).toBeUndefined();
	});
});
