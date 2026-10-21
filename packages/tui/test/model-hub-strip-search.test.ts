/**
 * A chip strip (thinking level, role assignment, name entry) owns every key
 * while it is open, so the picker must not offer a search field with a stale
 * query behind it. The stored query and caret survive for the strip's exit.
 */
import { beforeAll, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeUiEvent } from "../src/native/node";
import {
	ModelHubComponent,
	type ModelHubCallbacks,
	type ModelHubRegistry,
	type ModelHubSource,
} from "../src/overlays/model-hub";
import { initTheme } from "../src/theme";
import type { TUI } from "../src/index";

const tuiStub = { requestRender: () => {}, terminal: { rows: 30 } } as unknown as TUI;

const pickerCx: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};

const reasoner = buildModel({
	id: "claude-sonnet",
	name: "claude-sonnet",
	api: "ollama-chat",
	provider: "anthropic",
	baseUrl: "https://example.com",
	reasoning: true,
	thinking: { efforts: [Effort.Low, Effort.High], mode: "effort" },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 1024,
});

// Chip ids follow #thinkingChips: inherit, off, auto, low, high.
const CHIP_HIGH = "4";

const source: ModelHubSource = {
	revision: 0,
	disabledProviders: [],
	fallbackChains: {},
	modelRoleStorage: "global",
	cycleOrder: [],
	getProjectModelRole: () => undefined,
	getGlobalModelRole: () => undefined,
	getModelRoleSource: () => "global",
	defaultThinkingLevel: "inherit",
	modelProviderOrder: [],
	knownRoleIds: ["default"],
	mruOrder: [],
	modelPerf: new Map(),
	// `default` is explicitly assigned, so its Roles row can open a thinking strip.
	getModelRole: role => (role === "default" ? "anthropic/claude-sonnet" : undefined),
	getRoleInfo: role => ({ name: role, section: "chat", accepts: () => true }),
	defaultRoleChain: () => [],
	resolveRoleValue: () => ({ model: reasoner, explicitThinkingLevel: false }),
};

const registryStub: ModelHubRegistry = {
	getError: () => undefined,
	getAvailable: () => [],
	getAll: () => [],
	authStorage: { keys: { source: () => undefined } },
	getDiscoverableProviders: () => [],
	getProviderDiscoveryState: () => undefined,
	find: () => undefined,
	refresh: async () => {},
	refreshProvider: async () => {},
};

interface Assigned {
	role: string;
	level: unknown;
}

function createHub(): { hub: ModelHubComponent; assigned: Assigned[] } {
	const assigned: Assigned[] = [];
	const callbacks: ModelHubCallbacks = {
		onAssign: (_model, role, level) => {
			assigned.push({ role, level });
			return true;
		},
		onUnassign: () => {},
		onCancel: () => {},
		onSavePreset: () => {},
	};
	return { hub: new ModelHubComponent(tuiStub, source, registryStub, [{ model: reasoner }], callbacks), assigned };
}

function pickerProps(hub: ModelHubComponent): TspPickerProps {
	const root = hub.describe(pickerCx);
	if (root.k !== "picker" || !root.p) throw new Error(`expected a picker root, got ${root.k}`);
	return root.p;
}

const ESC = "\x1b";
const CLICK_ROLES = { type: "select", key: "scopes", item: "roles" } as const;

/** A picker action button press; the root picker's keypath is `""`. */
function action(act: string, value?: string): NativeUiEvent {
	return { type: "action", key: "", act, ...(value === undefined ? {} : { value }), mods: [] };
}

beforeAll(async () => {
	await initTheme(false);
});

test("a live query on the Roles rows is hidden while the thinking strip is open and returns on exit", () => {
	const { hub, assigned } = createHub();
	for (const ch of "son") hub.handleInput(ch);
	hub.handleNativeEvent(CLICK_ROLES);
	expect(pickerProps(hub).query).toBe("son");

	// `t` would edit the live query, so the strip opens from its action button.
	hub.handleNativeEvent(action("roles:thinking"));
	const open = pickerProps(hub);
	expect(open.strip).not.toBeNull();
	expect(open.focus).toBe("strip");
	expect(open.query).toBeNull();
	expect(open.cursor).toBeUndefined();

	// Printable keys drive the strip, never the hidden search.
	hub.handleInput("x");
	expect(pickerProps(hub).query).toBeNull();

	// Picking a level changes thinking, not the query.
	hub.handleNativeEvent(action("strip", CHIP_HIGH));
	expect(assigned).toEqual([{ role: "default", level: Effort.High }]);
	const closed = pickerProps(hub);
	expect(closed.strip).toBeNull();
	expect(closed.query).toBe("son");
	expect(closed.cursor).toBe(3);
	expect(closed.scope).toBe("roles");
});

test("cancelling the thinking strip restores the stored query and caret", () => {
	const { hub, assigned } = createHub();
	for (const ch of "son") hub.handleInput(ch);
	hub.handleNativeEvent(CLICK_ROLES);
	hub.handleNativeEvent(action("roles:thinking"));
	expect(pickerProps(hub).query).toBeNull();

	hub.handleInput(ESC);
	const props = pickerProps(hub);
	expect(props.strip).toBeNull();
	expect(props.query).toBe("son");
	expect(props.cursor).toBe(3);
	expect(assigned).toEqual([]);
});

test("pointer actions cannot clear or re-scope the hidden search while a strip is open", () => {
	const { hub } = createHub();
	for (const ch of "son") hub.handleInput(ch);
	hub.handleNativeEvent(CLICK_ROLES);
	hub.handleNativeEvent(action("roles:thinking"));

	hub.handleNativeEvent(action("clear"));
	hub.handleNativeEvent(action("scope", "all"));
	hub.handleNativeEvent(action("tab", "chat"));
	hub.handleNativeEvent({ type: "select", key: "scopes", item: "all" });
	hub.handleNativeEvent({ type: "select", key: "roleTabs", item: "chat" });
	hub.handleNativeEvent({ type: "activate", key: "roles", item: "role:default" });
	expect(pickerProps(hub).query).toBeNull();
	expect(pickerProps(hub).scope).toBe("roles");

	hub.handleInput(ESC);
	const props = pickerProps(hub);
	expect(props.query).toBe("son");
	expect(props.scope).toBe("roles");
});

test("the model browser hides its search under the role strip and restores it on cancel", () => {
	const { hub } = createHub();
	for (const ch of "son") hub.handleInput(ch);
	expect(pickerProps(hub).query).toBe("son");

	// Enter on the selected model opens the role-assignment strip.
	hub.handleInput("\r");
	const open = pickerProps(hub);
	expect(open.strip).not.toBeNull();
	expect(open.focus).toBe("strip");
	expect(open.query).toBeNull();

	hub.handleInput(ESC);
	const closed = pickerProps(hub);
	expect(closed.strip).toBeNull();
	expect(closed.query).toBe("son");
	expect(closed.cursor).toBe(3);
});
