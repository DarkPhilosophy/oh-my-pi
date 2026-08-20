import { describe, expect, it } from "bun:test";
import { registerCopyBlock, resolveCopyBlock } from "../../src/utils/copy-store";

describe("copy-store", () => {
	it("encodes a block into a stable omp-copy:<len>.<base64url> target", () => {
		const code = "print('hi')\n";
		const target = registerCopyBlock(code);
		expect(target).toMatch(/^omp-copy:\d+\.[A-Za-z0-9_-]+$/);
		// Deterministic: identical code yields an identical target.
		expect(registerCopyBlock(code)).toBe(target);
		expect(registerCopyBlock(`${code} `)).not.toBe(target);
	});

	it("round-trips code through the target url (no disk store)", () => {
		const code = "SELECT 1;\nSELECT 2;\n";
		expect(resolveCopyBlock(registerCopyBlock(code))).toBe(code);
	});

	it("round-trips a large multi-KB block", () => {
		const code = `${"const line = 1;\n".repeat(400)}`; // ~6 KB
		expect(resolveCopyBlock(registerCopyBlock(code))).toBe(code);
	});

	it("resolves a bare payload and tolerates a trailing slash", () => {
		const code = "const answer = 42;\n";
		const target = registerCopyBlock(code);
		const payload = target.slice("omp-copy:".length);
		expect(resolveCopyBlock(payload)).toBe(code);
		// A trailing slash a terminal/OS may append is tolerated.
		expect(resolveCopyBlock(`${target}/`)).toBe(code);
	});

	it("preserves unicode and multi-byte content", () => {
		const code = "café — 日本語 — 🚀\n";
		expect(resolveCopyBlock(registerCopyBlock(code))).toBe(code);
	});

	it("rejects a truncated url (no silent partial copy)", () => {
		const code = "x".repeat(2000);
		const target = registerCopyBlock(code);
		// A terminal cutting the OSC 8 URI drops the tail of the base64 payload.
		const cut = target.slice(0, target.length - 100);
		expect(resolveCopyBlock(cut)).toBeUndefined();
	});

	it("rejects legacy 16-hex ids, missing length prefix and non-utf8", () => {
		// Stale chip from the old disk-store scheme: omp-copy:<16-hex>, no `<len>.`.
		expect(resolveCopyBlock("omp-copy:529e76b5669e8193")).toBeUndefined();
		expect(resolveCopyBlock("529e76b5669e8193")).toBeUndefined();
		// Correct length but non-utf8 bytes must not resolve to garbage.
		const nonUtf8 = Buffer.from([0xff, 0xfe, 0xfd]);
		expect(resolveCopyBlock(`omp-copy:${nonUtf8.length}.${nonUtf8.toString("base64url")}`)).toBeUndefined();
	});

	it("returns undefined for empty or prefix-only payloads", () => {
		expect(resolveCopyBlock("omp-copy:")).toBeUndefined();
		expect(resolveCopyBlock("")).toBeUndefined();
		expect(resolveCopyBlock("omp-copy:12")).toBeUndefined(); // no dot/payload
	});
});
