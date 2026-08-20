import { describe, expect, it } from "bun:test";
import { parseDaemonLifecycleArgv } from "@oh-my-pi/pi-coding-agent/daemon/lifecycle";

describe("root daemon lifecycle controls", () => {
	it("keeps bare --daemon on the interactive route", () => {
		expect(parseDaemonLifecycleArgv(["--daemon"])).toBeUndefined();
		expect(parseDaemonLifecycleArgv(["--daemon", "--resume", "latest"])).toBeUndefined();
	});

	it("parses background start and graceful defaults", () => {
		expect(parseDaemonLifecycleArgv(["--daemon", "bgjob"])).toEqual({ action: "bgjob", mode: "graceful" });
		expect(parseDaemonLifecycleArgv(["--daemon", "kill"])).toEqual({ action: "kill", mode: "graceful" });
		expect(parseDaemonLifecycleArgv(["--daemon", "refresh", "graceful"])).toEqual({
			action: "refresh",
			mode: "graceful",
		});
	});

	it("requires an explicit force mode for immediate shutdown", () => {
		expect(parseDaemonLifecycleArgv(["--daemon", "kill", "force"])).toEqual({ action: "kill", mode: "force" });
		expect(parseDaemonLifecycleArgv(["--daemon", "refresh", "--force"])).toEqual({
			action: "refresh",
			mode: "force",
		});
		expect(parseDaemonLifecycleArgv(["--daemon", "kill", "force", "graceful"])).toEqual({
			error: "Choose only one daemon shutdown mode: force or graceful",
		});
	});

	it("rejects lifecycle arguments that could be mistaken for a prompt", () => {
		expect(parseDaemonLifecycleArgv(["--daemon", "kill", "later"])).toEqual({
			error: "Unknown daemon lifecycle argument: later",
		});
		expect(parseDaemonLifecycleArgv(["--daemon", "bgjob", "force"])).toEqual({ error: "Usage: omp --daemon bgjob" });
	});
});
