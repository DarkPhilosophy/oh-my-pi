import { beforeAll, expect, test } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Reconciler } from "@oh-my-pi/pi-tui/native/reconcile";
import { isNativeSettled } from "@oh-my-pi/pi-tui/native/settle";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

beforeAll(async () => { await initTheme(); });

test("parked streaming output keeps its native mounts until its final result", () => {
 const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
 const component = new ToolExecutionComponent("bash", { command: "printf synthetic" }, {}, undefined, ui, process.cwd(), "synthetic-call");
 const transcript = new TranscriptContainer();
 transcript.addChild(component);
 const reconciler = new Reconciler("probe");
 const cx = { cols: 80, dark: true, reduceMotion: true, supports: () => false, feature: () => false };
 const frame = () => reconciler.reconcile({ main: transcript.nativeBlocks(), dock: [], layer: [] }, cx);
 const result = (n: number) => ({ content: [{ type: "text" as const, text: Array.from({ length: n }, (_, j) => `synthetic line ${j}`).join("\n") }] });
 try {
  component.setArgsComplete();
  component.setExecutionStarted();
  component.updateResult(result(1), true);
  component.parkAsBackground();
  expect(component.isTranscriptBlockFinalized()).toBe(true);
  frame();
  for (let n = 2; n <= 4; n++) {
   component.updateResult(result(n), true);
   const ops = frame();
   expect(ops.filter(op => op[0] === "del" || op[0] === "add")).toEqual([]);
   expect(ops.some(op => op[0] === "text")).toBe(true);
   expect(isNativeSettled(component)).toBe(false);
  }
  component.updateResult(result(5), false);
  const finalOps = frame();
  expect(finalOps.filter(op => op[0] === "del" || op[0] === "add")).toEqual([]);
  expect(isNativeSettled(component)).toBe(true);
  expect(frame()).toEqual([]);
 } finally { component.dispose(); }
});
