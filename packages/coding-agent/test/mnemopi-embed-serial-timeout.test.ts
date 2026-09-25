/**
 * A model-change rebuild schedules hundreds of embed batches at once. The
 * worker embeds them one at a time, but every request used to start its
 * timeout when it was sent — so batches still waiting in the worker's queue
 * timed out, the worker was SIGKILLed, the rebuild failed and restarted on the
 * next launch, pinning several cores on every omp start.
 */
import { describe, expect, it } from "bun:test";
import { MnemopiEmbedClient, type MnemopiEmbedWorkerHandle } from "@oh-my-pi/pi-coding-agent/mnemopi/embed-client";
import type {
 MnemopiEmbedWorkerInbound,
 MnemopiEmbedWorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/mnemopi/embed-protocol";

/** Serial worker: answers each embed `workMs` after it starts, one at a time. */
class SerialWorker implements MnemopiEmbedWorkerHandle {
 terminated = 0;
 #handler: ((message: MnemopiEmbedWorkerOutbound) => void) | undefined;
 #busyUntil = 0;
 constructor(readonly workMs: number) { }

 send(message: MnemopiEmbedWorkerInbound): void {
  if (message.type === "init") {
   queueMicrotask(() => this.#handler?.({ type: "ready", id: message.id }));
   return;
  }
  if (message.type !== "embed") return;
  const start = Math.max(Date.now(), this.#busyUntil);
  this.#busyUntil = start + this.workMs;
  setTimeout(
   () => this.#handler?.({ type: "vectors", id: message.id, vectors: message.texts.map(() => [1]) }),
   this.#busyUntil - Date.now(),
  );
 }
 onMessage(handler: (message: MnemopiEmbedWorkerOutbound) => void): () => void {
  this.#handler = handler;
  return () => { };
 }
 onError(): () => void {
  return () => { };
 }
 ref(): void { }
 unref(): void { }
 async terminate(): Promise<void> {
  this.terminated++;
  this.#handler = undefined;
 }
}

describe("mnemopi embed client under a queued rebuild", () => {
 it("times each request only for its own work, not the queue ahead of it", async () => {
  const worker = new SerialWorker(40);
  // Each batch takes 40ms; the timeout (100ms) is well above one batch but
  // far below the whole queue of 6 (240ms).
  const client = new MnemopiEmbedClient(() => worker, 100);
  try {
   const model = await client.initialize("fast-bge-base-en-v1.5", "/tmp/cache");
   const batches = Array.from({ length: 6 }, async (_, i) => {
    for await (const vectors of model!.embed([`batch ${i}`])) return vectors;
    return [];
   });
   const results = await Promise.all(batches);
   expect(results).toEqual(Array.from({ length: 6 }, () => [[1]]));
   expect(worker.terminated).toBe(0);
  } finally {
   await client.terminate();
  }
 });
});
