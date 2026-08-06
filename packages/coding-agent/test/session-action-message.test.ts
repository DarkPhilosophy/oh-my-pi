import { describe, expect, test } from "bun:test";
import { sessionActionMessage } from "../src/session/session-action-message";

describe("sessionActionMessage", () => {
	test("renders the resume notice with the first 8 id chars and the cwd", () => {
		expect(sessionActionMessage("resumed", "019fc165-1a9b-7000-94bf-16f092ad9572", "/var/home/alexa/tmp")).toBe(
			"Session 019fc165 resumed in /var/home/alexa/tmp",
		);
	});

	test("renders the move notice identically across surfaces", () => {
		expect(sessionActionMessage("moved", "019fbe86-0000-7000-8000-000000000000", "/var/home/alexa")).toBe(
			"Session 019fbe86 moved in /var/home/alexa",
		);
	});

	test("renders the fork notice with the resulting session id and cwd", () => {
		expect(sessionActionMessage("forked", "019fc166-1a9b-7000-94bf-16f092ad9572", "/work/fork")).toBe(
			"Session 019fc166 forked in /work/fork",
		);
	});

	test("falls back to a readable marker when the id is missing", () => {
		expect(sessionActionMessage("resumed", undefined, "/tmp")).toBe("Session unknown resumed in /tmp");
	});
});
