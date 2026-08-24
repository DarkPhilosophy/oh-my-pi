# Unified Visible Viewport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the complete physical screen the authoritative contextual viewport while keeping immutable history and mutable live rows as independent ownership metadata.

**Architecture:** Preserve finalized rows plus component segments in one logical tape, add an explicit application-owned viewport origin/follow state, and make every screen layer consume the same visible slice. Native scrollback emission remains separate and exactly-once; `committedRows` no longer limits what may be visible.

**Tech Stack:** TypeScript, Bun, `@oh-my-pi/pi-tui`, existing `TerminalFrameProvider`, renderer regression terminals, Bun test.

---

## File Responsibilities

- `packages/tui/src/tui.ts`: frame-plan types, accepted immutable tape, viewport state, input routing, visible slicing, compositing, cursor mapping, native history emission.
- `packages/coding-agent/src/modes/composer.ts`: attach component ownership metadata to finalized history offers.
- `packages/coding-agent/src/modes/components/transcript-container.ts`: expose retired row ranges with the original component ownership.
- `packages/tui/test/history-frame-plan.test.ts`: provider acceptance and immutable segment retention contracts.
- `packages/tui/test/right-panel.test.ts`: contextual placement across the live/history boundary and while scrolled.
- `packages/tui/test/render-regressions.test.ts`: viewport origin/follow-bottom and submit/finalize geometry contracts.
- `packages/tui/test/resize-anchor-recovery.test.ts`: logical top-anchor preservation across reflow.
- `packages/coding-agent/test/startup-composer.test.ts`: real Composer history batches preserve assistant ownership.
- `packages/coding-agent/test/streaming-output-scrollback.test.ts`: end-to-end streaming, scroll-up, finalization, and exactly-once history.

### Task 1: Preserve ownership metadata in finalized history

**Files:**
- Modify: `packages/tui/src/tui.ts:142-169,1285-1350`
- Modify: `packages/coding-agent/src/modes/composer.ts:201-270`
- Modify: `packages/coding-agent/src/modes/components/transcript-container.ts:545-612`
- Test: `packages/tui/test/history-frame-plan.test.ts`
- Test: `packages/coding-agent/test/startup-composer.test.ts`

- [ ] **Step 1: Add failing provider-history ownership tests**

Add a test whose provider offers a two-row finalized batch with one `TerminalFrameSegment`, acknowledges it, then renders a mutable row. Assert that `getFrameSegments()` contains both the immutable segment at rows `0..2` and the mutable segment offset after accepted history. The observable failure is that a target visible in accepted history becomes unaddressable.

- [ ] **Step 2: Run the ownership tests red**

Run:

```bash
bun test packages/tui/test/history-frame-plan.test.ts packages/coding-agent/test/startup-composer.test.ts
```

Expected: the new immutable-segment assertions fail because `HistoryBatch` currently carries only rows and `TerminalFrameProviderComponent` drops ownership metadata.

- [ ] **Step 3: Extend the history contract**

Change the type to:

```ts
export interface HistoryBatch {
  readonly id: number;
  readonly rows: readonly string[];
  readonly segments?: readonly TerminalFrameSegment[];
}
```

Store accepted segments in `TerminalFrameProviderComponent` alongside `#history`. Offset each batch segment by the accepted-history length at acceptance time. `getFrameSegments()` returns accepted immutable segments followed by current mutable segments offset by `#history.length`. Clear both rows and segments in `prepareNativeScrollbackReplay()`.

- [ ] **Step 4: Emit precise retired segments from Composer**

When Composer offers header or transcript history, include the component ranges covered by the offered rows. For a partial frontier block, preserve the source component and emit only the retired row count. Do not fabricate a root spanning unrelated children.

- [ ] **Step 5: Run ownership tests green**

Run the same two-file command. Expected: all tests pass and accepted history retains target ownership without duplicate segments.

### Task 2: Introduce explicit viewport origin and follow state

**Files:**
- Modify: `packages/tui/src/tui.ts:1352-1410,4170-4545`
- Test: `packages/tui/test/render-regressions.test.ts`

- [ ] **Step 1: Add failing viewport-state tests**

Using the existing counting/fake terminal fixture, render a tape taller than the terminal and assert:

1. initial origin equals `max(0, frameLength - height)`;
2. setting a scrolled origin keeps the same top row when rows append below;
3. reaching the maximum origin restores bottom-follow;
4. finalizing unchanged rows does not change the visible slice.

The consumer-visible failure is a cut/jump in the screen when ownership changes or output appends.

- [ ] **Step 2: Run the focused renderer test red**

```bash
bun test packages/tui/test/render-regressions.test.ts
```

Expected: the new scroll anchor assertions fail because `windowTop` is recomputed from `committedRows` and frame length on every render.

- [ ] **Step 3: Add renderer-owned viewport state**

Add private state with concrete semantics:

```ts
#viewportOrigin = 0;
#viewportFollowsBottom = true;
```

Add small private helpers:

```ts
#maximumViewportOrigin(frameLength: number, height: number): number
#reconcileViewportOrigin(frameLength: number, height: number): number
#setViewportOrigin(next: number, frameLength: number, height: number): void
```

Pinned reconciliation selects the tape tail. Unpinned reconciliation preserves `#viewportOrigin` and clamps it. `committedRows` remains an emission watermark only.

- [ ] **Step 4: Select the visible window solely from viewport state**

Replace the visibility role of `windowTop` with the reconciled viewport origin before cursor selection and compositing. Keep a separately named native emission boundary for `chunkTo`. Remove `Math.max(this.#committedRows, ...)` from viewport selection; never change the viewport origin as a side effect of history resync.

- [ ] **Step 5: Run focused renderer tests green**

Run the Task 2 command. Expected: appended rows do not move an unpinned view, bottom-follow still tracks the tail, and ownership-only changes preserve the screen.

### Task 3: Route panel geometry through the unified viewport

**Files:**
- Modify: `packages/tui/src/tui.ts:2832-2977,4527-4550`
- Test: `packages/tui/test/right-panel.test.ts`

- [ ] **Step 1: Add live-to-history panel regression**

Create a provider fixture with a target segment visible near the top of a short terminal. Render it live, retire it into a history batch without changing its bytes, and render again. Assert the panel block remains at the same physical rows. Add a scrolled case where the target is immutable history and a live editor exists below the visible slice.

- [ ] **Step 2: Run the panel test red**

```bash
bun test packages/tui/test/right-panel.test.ts
```

Expected: the panel is hidden or relocated after retirement because immutable target segments are absent or the visibility floor excludes them.

- [ ] **Step 3: Use unified tape coordinates consistently**

Keep `#compositeRightPanelIntoWindow(window, width, viewportOrigin, frame, ...)`, but ensure `placementSegments` contains both accepted history and mutable segments. Translate every segment with `segment.start - viewportOrigin`. Apply exclusions after targets exactly as today. Do not add history-specific widget logic.

- [ ] **Step 4: Run the panel test green**

Run the Task 3 command. Expected: placement is unchanged across retirement and follows the context when the viewport origin moves.

### Task 4: Add application-owned conversation scrolling

**Files:**
- Modify: `packages/tui/src/tui.ts:3519-3586`
- Test: `packages/tui/test/input.test.ts`
- Test: `packages/tui/test/render-regressions.test.ts`

- [ ] **Step 1: Add failing wheel and page navigation tests**

Cover these observable transitions:

- unconsumed wheel-up moves the conversation viewport upward by three rows and disables follow;
- unconsumed wheel-down clamps at bottom and re-enables follow;
- PageUp/PageDown move by `max(1, height - 1)` only when the focused component did not consume them;
- End returns to bottom;
- an overlay or focused scrollable component that consumes the gesture prevents conversation scrolling.

- [ ] **Step 2: Run the input tests red**

```bash
bun test packages/tui/test/input.test.ts packages/tui/test/render-regressions.test.ts
```

Expected: inputs currently reach the focused component only and no TUI viewport state changes.

- [ ] **Step 3: Add explicit input-consumption routing**

Use existing `InputListenerResult` and SGR mouse parsing patterns. Give listeners and focused components first refusal. Route only unconsumed wheel/PageUp/PageDown/Home/End gestures to the conversation viewport. Preserve the editor's existing PageUp/PageDown behavior for multiline drafts; conversation paging applies only when that focused behavior does not consume the key. If the current `Component.handleInput` cannot report consumption, extend the central input contract once rather than guessing from component type.

- [ ] **Step 4: Request a render after viewport movement**

Scrolling changes only geometry; request a full TUI render without invalidating component content. Ensure cursor visibility is suppressed or clamped when the editor lies outside the visible slice.

- [ ] **Step 5: Run input tests green**

Run the Task 4 command. Expected: all navigation transitions pass and focused component behavior is unchanged.

### Task 5: Preserve viewport anchors through resize and replay

**Files:**
- Modify: `packages/tui/src/tui.ts:4160-4525`
- Test: `packages/tui/test/resize-anchor-recovery.test.ts`
- Test: `packages/tui/test/resize-viewport-defer.test.ts`

- [ ] **Step 1: Add failing scrolled-resize tests**

Render wrapped logical rows, scroll so a known logical row is at the viewport top, resize narrower and wider, and assert that row remains visible at or nearest the top. Also assert a bottom-following view remains bottom-following.

- [ ] **Step 2: Run resize tests red**

```bash
bun test packages/tui/test/resize-anchor-recovery.test.ts packages/tui/test/resize-viewport-defer.test.ts
```

Expected: the old width-epoch logic restores the tail or committed boundary rather than the application viewport anchor.

- [ ] **Step 3: Resolve the viewport top through width epochs**

Capture the existing source boundary for the current viewport top before reflow. Resolve it after the new-width render using the existing width-epoch/source-boundary utilities. Set `#viewportOrigin` from the resolved boundary when unpinned; pinned views use the new maximum origin. If resolution is unavailable, clamp the prior origin and preserve content without duplication.

- [ ] **Step 4: Keep replay state complete**

A destructive replay resets accepted immutable rows, immutable segments, and native acknowledgement ids, then re-offers them. Preserve the logical viewport anchor across the rebuild and reconcile it only after the rebuilt tape exists.

- [ ] **Step 5: Run resize tests green**

Run the Task 5 command. Expected: scrolled and pinned resize contracts both pass.

### Task 6: Verify exactly-once streaming and actual Composer behavior

**Files:**
- Test: `packages/coding-agent/test/streaming-output-scrollback.test.ts`
- Test: `packages/coding-agent/test/startup-composer.test.ts`
- Test: `packages/tui/test/right-panel.test.ts`

- [ ] **Step 1: Add the full user-path regression**

Drive a real streaming `AssistantMessageComponent` beyond viewport height, scroll upward before completion, finalize it, submit the next user message, and continue streaming. Assert:

- the visible top marker remains stable while unpinned;
- the right panel stays on the same eligible visible target;
- every assistant marker appears exactly once in retained history plus live tape;
- returning to bottom reveals the editor and resumes follow.

- [ ] **Step 2: Run the user-path regression**

```bash
bun test packages/coding-agent/test/streaming-output-scrollback.test.ts packages/coding-agent/test/startup-composer.test.ts packages/tui/test/right-panel.test.ts
```

Expected: all tests pass with no duplicate or missing markers.

- [ ] **Step 3: Run package checks and smoke path**

```bash
bun check
bun run packages/coding-agent/src/cli.ts --smoke-test
```

Expected: `bun check: passed` and `smoke-test: ok`.

- [ ] **Step 4: Exercise the actual TUI**

Launch the current source CLI in a real terminal, stream a response taller than the viewport, scroll upward during streaming, allow completion, submit a short next message, resize once, and return to bottom. Observe that the screen does not cut at submit/finalization, the panel follows visible context, and history markers remain unique.

- [ ] **Step 5: Inspect only the touched-path delta**

Verify no panel-specific history exception, duplicate scrolling implementation, prompt change, generated output, or unrelated formatting entered the diff. Do not commit or push unless the user separately authorizes those actions.
