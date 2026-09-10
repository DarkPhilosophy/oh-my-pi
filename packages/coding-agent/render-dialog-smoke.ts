import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "./src/config/model-registry";
import { Settings } from "./src/config/settings";
import type { ExtensionUIContext } from "./src/extensibility/extensions/types";
import { InteractiveMode } from "./src/modes/interactive-mode";
import { AgentSession } from "./src/session/agent-session";
import { AuthStorage } from "./src/session/auth-storage";
import { SessionManager } from "./src/session/session-manager";
const directory = TempDir.createSync("/tmp/omp-dialog-smoke-");
const settings = await Settings.init({ inMemory: true });
settings.set("startup.quiet", true);
settings.set("compaction.enabled", false);
const auth = await AuthStorage.create(":memory:");
const agent = new Agent({
	initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, tools: [] },
	streamFn: () => {
		throw new Error("Provider forbidden");
	},
	getApiKey: () => {
		throw new Error("Credentials forbidden");
	},
});
const session = new AgentSession({
	agent,
	settings,
	sessionManager: SessionManager.inMemory(directory.path()),
	modelRegistry: new ModelRegistry(auth, directory.join("models.yml")),
});
let ui: ExtensionUIContext;
const mode = new InteractiveMode(session, "dialog-smoke", undefined, context => {
	ui = context;
});
await mode.init({ suppressWelcomeIntro: true });
const frames: unknown[] = [];
const renderFrame = mode.composer.renderFrame.bind(mode.composer);
mode.composer.renderFrame = size => {
	const frame = renderFrame(size);
	frames.push({
		viewport: frame.viewport,
		history: frame.history,
		expansion: frame.viewportExpansionRows,
		borrowed: frame.borrowedViewportRows,
	});
	void Bun.write(directory.join("frames.json"), JSON.stringify(frames));
	return frame;
};
mode.ui.addInputListener(data => {
	if (data !== "\x07") return undefined;
	void ui.askDialog!([
		{ id: "probe", question: "Verify real dialog dismissal", options: [{ label: "Continue" }, { label: "Cancel" }] },
	]).catch(() => {});
	return { consume: true };
});
process.on("exit", () => auth.close());
