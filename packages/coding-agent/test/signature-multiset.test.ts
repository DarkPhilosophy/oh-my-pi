import { describe, expect, it } from "bun:test";
import { SignatureMultiset } from "../src/modes/utils/signature-multiset";

describe("SignatureMultiset", () => {
	it("counts occurrences so identical signatures survive one delete (cross-session)", () => {
		const m = new SignatureMultiset();
		// Main session and a focused subagent both queue the same `ok` (0 images).
		m.add("ok\u00000");
		m.add("ok\u00000");
		expect(m.has("ok\u00000")).toBe(true);
		// Restoring one session's copy must NOT unmark the other's still-queued copy.
		expect(m.delete("ok\u00000")).toBe(true);
		expect(m.has("ok\u00000")).toBe(true);
		// Consuming the second copy clears it.
		expect(m.delete("ok\u00000")).toBe(true);
		expect(m.has("ok\u00000")).toBe(false);
	});

	it("delete returns false for an unknown signature and never underflows", () => {
		const m = new SignatureMultiset();
		expect(m.delete("missing")).toBe(false);
		m.add("x");
		expect(m.delete("x")).toBe(true);
		expect(m.delete("x")).toBe(false); // already at zero, key removed
		expect(m.has("x")).toBe(false);
	});

	it("clear drops every signature", () => {
		const m = new SignatureMultiset();
		m.add("a");
		m.add("a");
		m.add("b");
		m.clear();
		expect(m.has("a")).toBe(false);
		expect(m.has("b")).toBe(false);
	});
});
