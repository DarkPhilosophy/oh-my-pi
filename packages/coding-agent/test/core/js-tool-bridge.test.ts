import { describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import { type TodoPhase, TodoTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

function createTool(name: string, execute: AgentTool["execute"]): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({}),
		concurrency: "parallel",
		execute,
	} as unknown as AgentTool;
}

function createSession(tools: AgentTool[]): ToolSession {
	const registry = new Map(tools.map(tool => [tool.name, tool]));
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		getToolByName: name => registry.get(name),
	};
}

describe("callSessionTool", () => {
	it("injects js intent and summarizes text results", async () => {
		const execute = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "hello" }],
		});
		const session = createSession([createTool("read", execute)]);
		const statuses: Array<Record<string, unknown>> = [];

		const result = await callSessionTool(
			"read",
			{ path: "/tmp/demo.txt" },
			{
				session,
				emitStatus: event => {
					statuses.push(event);
				},
			},
		);

		expect(result).toBe("hello");
		expect(execute).toHaveBeenCalledWith(
			expect.stringMatching(/^js-read-/),
			{ path: "/tmp/demo.txt", [INTENT_FIELD]: "js prelude" },
			undefined,
			undefined,
			undefined,
		);
		expect(statuses).toEqual([expect.objectContaining({ op: "read", path: "/tmp/demo.txt", chars: 5 })]);
	});

	it("passes the session tool context to bridged executions", async () => {
		const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
		const context = { settings: Settings.isolated() } as AgentToolContext;
		const session = {
			...createSession([createTool("bash", execute)]),
			getToolContext: () => context,
		};

		await callSessionTool("bash", { command: "true" }, { session });

		expect(execute).toHaveBeenCalledWith(
			expect.stringMatching(/^js-bash-/),
			{ command: "true", [INTENT_FIELD]: "js prelude" },
			undefined,
			undefined,
			context,
		);
	});

	it("validates optional nulls before executing a real todo tool", async () => {
		let phases: TodoPhase[] = [
			{
				name: "Regression",
				tasks: [{ content: "Exercise bridge", status: "in_progress" }],
			},
		];
		const session: ToolSession = {
			...createSession([]),
			getTodoPhases: () => phases,
			setTodoPhases: next => {
				phases = next;
			},
			getToolByName: name => (name === "todo" ? (todoTool as unknown as AgentTool) : undefined),
		};
		const todoTool = new TodoTool(session);

		const result = await callSessionTool(
			"todo",
			{
				op: "done",
				phase: "Regression",
				list: null,
				task: null,
				items: null,
				reason: null,
			},
			{ session },
		);

		expect(result).not.toEqual(expect.objectContaining({ hasError: true }));
		expect(phases[0]?.tasks.map(task => task.status)).toEqual(["completed"]);
	});

	it("rejects null for a required field before executing a strict tool", async () => {
		const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "unexpected" }] });
		const tool: AgentTool = {
			name: "strict",
			label: "strict",
			description: "strict tool",
			parameters: type({ value: "string" }),
			concurrency: "parallel",
			execute,
		} as unknown as AgentTool;
		await expect(callSessionTool("strict", { value: null }, { session: createSession([tool]) })).rejects.toThrow(
			"Validation failed",
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("preserves caller intent through closed-schema validation", async () => {
		const tool: AgentTool = {
			name: "intent",
			label: "intent",
			description: "intent tool",
			parameters: type({ "value?": "string" }).onUndeclaredKey("reject"),
			concurrency: "shared",
			execute: async (_id: string, args: unknown) => ({
				content: [{ type: "text", text: String((args as Record<string, unknown>)[INTENT_FIELD]) }],
			}),
		} as unknown as AgentTool;
		const result = await callSessionTool(
			"intent",
			{ value: "x", [INTENT_FIELD]: "caller intent" },
			{ session: createSession([tool]) },
		);
		expect(result).toBe("caller intent");
	});

	it("validates and preserves a schema-declared intent field", async () => {
		const execute = async (_id: string, args: unknown) => ({
			content: [
				{
					type: "text" as const,
					text: `${typeof (args as Record<string, unknown>)[INTENT_FIELD]}:${String((args as Record<string, unknown>)[INTENT_FIELD])}`,
				},
			],
		});
		const tool: AgentTool = {
			name: "required-intent",
			label: "required intent",
			description: "required intent tool",
			parameters: type({ [INTENT_FIELD]: "number" }),
			concurrency: "parallel",
			execute,
		} as unknown as AgentTool;

		const result = await callSessionTool(
			"required-intent",
			{ [INTENT_FIELD]: "5" },
			{ session: createSession([tool]) },
		);

		expect(result).toBe("number:5");
	});

	it("validates constrained tool-owned intent without supplying a missing optional value", async () => {
		const execute = vi.fn(async (_id: string, args: unknown) => ({
			content: [{ type: "text" as const, text: String((args as Record<string, unknown>)[INTENT_FIELD]) }],
		}));
		const tool: AgentTool = {
			name: "constrained-intent",
			label: "constrained intent",
			description: "constrained intent tool",
			parameters: type({ [`${INTENT_FIELD}?`]: "'allowed'" }),
			concurrency: "parallel",
			execute,
		} as unknown as AgentTool;

		await expect(
			callSessionTool("constrained-intent", { [INTENT_FIELD]: "disallowed" }, { session: createSession([tool]) }),
		).rejects.toThrow("Validation failed");
		expect(execute).not.toHaveBeenCalled();
		expect(await callSessionTool("constrained-intent", {}, { session: createSession([tool]) })).toBe("undefined");
	});

	it("recovers a missing todo operation from raw parse metadata", async () => {
		let phases: TodoPhase[] = [];
		const session: ToolSession = {
			...createSession([]),
			getTodoPhases: () => phases,
			setTodoPhases: next => {
				phases = next;
			},
			getToolByName: name => (name === "todo" ? (todoTool as unknown as AgentTool) : undefined),
		};
		const todoTool = new TodoTool(session);

		const result = await callSessionTool(
			"todo",
			{
				list: [{ phase: "Recovered", items: ["From malformed JSON"] }],
				__parseError: "Unexpected token",
				__rawJson: '{"list": [broken}',
			},
			{ session },
		);

		expect(result).not.toEqual(expect.objectContaining({ hasError: true }));
		expect(phases).toEqual([
			{ name: "Recovered", tasks: [{ content: "From malformed JSON", status: "in_progress" }] },
		]);
	});

	it("returns structured tool results when details or images are present", async () => {
		const session = createSession([
			createTool("custom", async () => ({
				content: [
					{ type: "text", text: "done" },
					{ type: "image", mimeType: "image/png", data: "abc123" },
				],
				details: { ok: true },
			})),
		]);

		const result = await callSessionTool("custom", {}, { session });

		expect(result).toEqual({
			text: "done",
			details: { ok: true },
			images: [{ mimeType: "image/png", data: "abc123" }],
		});
	});

	it("marks structured results when the underlying tool reports an error", async () => {
		const session = createSession([
			createTool("mcp__demo_fail", async () => ({
				content: [{ type: "text", text: "Error: bad input" }],
				details: { serverName: "demo", mcpToolName: "fail", isError: true },
			})),
		]);
		const statuses: Array<Record<string, unknown>> = [];

		const result = await callSessionTool(
			"mcp__demo_fail",
			{},
			{ session, emitStatus: event => statuses.push(event) },
		);

		expect(result).toEqual({
			text: "Error: bad input",
			details: { serverName: "demo", mcpToolName: "fail", isError: true },
			hasError: true,
		});
		expect(statuses).toEqual([
			expect.objectContaining({
				op: "mcp__demo_fail",
				chars: 16,
				hasError: true,
				error: "Error: bad input",
			}),
		]);
	});

	it("marks results with top-level isError", async () => {
		const session = createSession([
			createTool(
				"custom",
				async () =>
					({
						content: [{ type: "text", text: "preview mismatch" }],
						isError: true,
					}) as AgentToolResult,
			),
		]);
		const statuses: Array<Record<string, unknown>> = [];

		const result = await callSessionTool("custom", {}, { session, emitStatus: event => statuses.push(event) });

		expect(result).toEqual({
			text: "preview mismatch",
			details: undefined,
			hasError: true,
		});
		expect(statuses).toEqual([
			expect.objectContaining({
				op: "custom",
				chars: 16,
				hasError: true,
				error: "preview mismatch",
			}),
		]);
	});

	it("throws when the requested tool is not available in the session registry", async () => {
		const session = createSession([]);

		await expect(callSessionTool("missing", {}, { session })).rejects.toThrow("Unknown tool from js runtime");
	});

	it("executes the bridge-authorized tool instead of the raw registry tool", async () => {
		const rawExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "raw" }] });
		const authorizedExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "authorized" }] });
		const session = {
			...createSession([createTool("write", rawExecute)]),
			getToolForEvalBridge: () => createTool("write", authorizedExecute),
		};

		const result = await callSessionTool("write", { path: "out.txt", content: "data" }, { session });

		expect(result).toBe("authorized");
		expect(authorizedExecute).toHaveBeenCalledTimes(1);
		expect(rawExecute).not.toHaveBeenCalled();
	});

	it("rejects checkpoint and rewind before reaching the registry", async () => {
		const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
		const session = createSession([createTool("checkpoint", execute), createTool("rewind", execute)]);

		await expect(callSessionTool("checkpoint", { goal: "g" }, { session })).rejects.toThrow(
			"cannot run through the eval bridge",
		);
		await expect(callSessionTool("rewind", { report: "r" }, { session })).rejects.toThrow(
			"cannot run through the eval bridge",
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("rejects a registry tool excluded from the eval bridge", async () => {
		const rawExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "raw" }] });
		const session = {
			...createSession([createTool("write", rawExecute)]),
			getToolForEvalBridge: () => undefined,
		};

		await expect(callSessionTool("write", { path: "out.txt", content: "data" }, { session })).rejects.toThrow(
			"Unknown tool from js runtime",
		);
		expect(rawExecute).not.toHaveBeenCalled();
	});
});
