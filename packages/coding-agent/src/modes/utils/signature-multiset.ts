/**
 * A reference-counted multiset of local-submission signatures.
 *
 * Each locally submitted message records a `${text}\u0000${imageCount}` signature so
 * the matching `message_start` is recognized as local and never clobbers a draft.
 * A plain `Set` collapses identical signatures from different sessions into one
 * entry, so consuming/restoring one session's queued message would unmark an
 * identical message still queued in another (the main session vs a focused
 * subagent both holding e.g. `ok\u00000`). Counting occurrences keeps each
 * session's signature independent: a signature added twice must be deleted twice
 * before {@link has} turns false.
 *
 * Method names mirror the `Set` subset the call sites use (`add` / `delete` /
 * `has` / `clear`); {@link delete} returns whether a signature was present (and
 * consumes one occurrence), matching `Set.prototype.delete` so the message-start
 * "was this local?" check stays unchanged. {@link LocalSignatureTracker} is the
 * shared shape — a plain `Set<string>` also satisfies it (test stubs that never
 * exercise cross-session duplicates can keep using one).
 */
export interface LocalSignatureTracker {
	add(signature: string): void;
	delete(signature: string): boolean;
	has(signature: string): boolean;
	clear(): void;
	/** Iterate the distinct tracked signatures (a `Set<string>` also satisfies this). */
	[Symbol.iterator](): IterableIterator<string>;
}
export class SignatureMultiset implements LocalSignatureTracker {
	#counts = new Map<string, number>();

	add(signature: string): void {
		this.#counts.set(signature, (this.#counts.get(signature) ?? 0) + 1);
	}

	/** Consume one occurrence; returns whether the signature was present. */
	delete(signature: string): boolean {
		const count = this.#counts.get(signature);
		if (count === undefined) return false;
		if (count <= 1) this.#counts.delete(signature);
		else this.#counts.set(signature, count - 1);
		return true;
	}

	has(signature: string): boolean {
		return this.#counts.has(signature);
	}

	clear(): void {
		this.#counts.clear();
	}

	[Symbol.iterator](): IterableIterator<string> {
		return this.#counts.keys();
	}
}
