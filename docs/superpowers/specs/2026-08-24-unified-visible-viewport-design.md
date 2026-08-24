# Unified Visible Viewport Design

## Problem

The renderer currently conflates two independent concepts:

1. **row ownership/stability** — whether a row is immutable history or mutable live output;
2. **visibility** — which physical terminal rows the user can see now.

`TerminalFrameProviderComponent` concatenates accepted history and the mutable viewport, while the native-scrollback renderer floors `windowTop` at `committedRows`. The right-panel compositor then receives only the mutable frame window and component segments expressed in that frame. When a turn is finalized or a new message retires rows into history, those rows can remain physically visible but disappear from the renderer's semantic viewport. The panel exposes the flaw by losing otherwise visible target rows and relocating lower in the screen.

## Goal

Make the viewport equal the complete physical screen area visible to the user, regardless of whether its rows are immutable history or mutable live output. All contextual drawing, animation, overlays, cursor mapping, and hit testing must consume this same viewport geometry.

## Invariants

- `visible viewport` and `history/live ownership` are orthogonal.
- Every rendered frame has exactly one viewport coordinate space: rows `0..<terminalHeight`.
- History rows remain immutable and are never re-appended merely because they are visible.
- Live rows remain mutable until finalized.
- Finalizing a row changes ownership only; if the visible content is unchanged, its viewport coordinate must not jump.
- Submitting a message must not discard or rebase visible geometry.
- A contextual panel may draw over any eligible visible row, including an immutable history row, without modifying the stored transcript or native history.
- Scrolling changes the viewport origin; it does not change row ownership.
- The bottom-following state is explicit. New output follows only while pinned to bottom; when scrolled up, the viewport remains anchored and unseen new rows accumulate below.
- Returning to bottom restores follow mode deterministically.
- Resize recomputes wrapping and clamps the viewport anchor without duplicating or losing logical rows.

## Architectural Decision

OMP will own the conversation viewport and its scroll position. Native terminal scrollback remains an output compatibility/cache concern, not the source of viewport geometry. This is necessary because terminals do not provide a portable, reliable query for the user's native scrollback offset; contextual redraw and hit testing cannot be correct without an application-owned origin.

The renderer will maintain a unified logical row tape:

```text
[ immutable transcript rows | mutable live rows | input/status rows ]
                            ^ ownership boundaries only

visible viewport = tape[viewportOrigin .. viewportOrigin + terminalHeight]
```

The viewport origin is independent of the immutable/live boundary.

## Data Model

Introduce explicit viewport state in the TUI renderer:

```ts
interface VisibleViewportState {
  origin: number;
  height: number;
  followBottom: boolean;
}
```

The frame provider continues to supply finalized history batches and a mutable viewport, but the provider component exposes a unified row tape and unified component segments. Accepted history is retained as immutable rows with their component ownership metadata rather than becoming geometry-less strings.

`TerminalFrameSegment` remains expressed in unified tape coordinates after the provider component offsets mutable segments by accepted-history length. Finalized history batches carry the segments that cover the accepted rows, so contextual ownership survives retirement.

```ts
interface HistoryBatch {
  readonly id: number;
  readonly rows: readonly string[];
  readonly segments?: readonly TerminalFrameSegment[];
}
```

The TUI renderer computes one visible slice from the unified tape and passes that exact slice, its origin, and unified segments to compositors.

## Scrolling

Conversation scrolling is handled by the TUI while it owns input:

- wheel up/down moves `origin` by a bounded row delta;
- PageUp/PageDown move by a viewport-relative amount;
- Home moves to the oldest retained row;
- End moves to the bottom and sets `followBottom = true`;
- any upward movement sets `followBottom = false`;
- downward movement that reaches the maximum origin restores `followBottom = true`.

When `followBottom` is false, appended or mutated rows below the visible slice do not move `origin`. If mutations occur inside the visible slice, the renderer repaints those rows in place. An optional, existing status surface may indicate unseen rows later, but this change does not add a new notification feature.

## Rendering Pipeline

1. Render provider output into the unified logical tape.
2. Preserve accepted history rows and their segments as immutable prefix data.
3. Reconcile the viewport anchor:
   - pinned: `origin = max(0, tape.length - height)`;
   - unpinned: keep the same logical top row where possible, then clamp.
4. Slice exactly `height` rows from `origin`, padding only below the tape.
5. Map cursor markers, overlays, panels, and hit regions from tape coordinates into viewport coordinates by subtracting `origin`.
6. Paint the physical grid from that composited viewport.
7. Separately advance native-history bookkeeping for compatibility; never use `committedRows` as a lower bound for the visible origin.

## Right Panel

The right panel receives unified segments. Target and exclusion filtering therefore works identically for visible immutable and mutable rows. No widget-specific fallback, synthetic target, or special history mode is added.

Panel text is a transient screen layer. It is composited after the visible slice is selected and is never written into transcript rows or finalized history batches.

## Native Scrollback Compatibility

The native history writer remains responsible for emitting finalized rows exactly once. The application-owned viewport is authoritative while OMP is active. Native scrollback can still contain the completed transcript for post-session inspection and terminal compatibility, but native scrolling is not used to determine OMP's contextual viewport.

The existing committed-prefix, replay, resize, and divergence checks remain history-emission safeguards. Their geometry responsibility is removed incrementally: `committedRows` may constrain emission, but never viewport selection.

## Resize

Rows are re-rendered at the new width. The viewport stores a logical top anchor where source boundaries are available; otherwise it uses the existing width-epoch boundary machinery. After reflow:

- bottom-following view remains bottom-following;
- scrolled view resolves the prior top anchor at the new width;
- origin is clamped to the new tape length;
- the panel and overlays are recomputed from the same new visible slice.

## Input and Hit Testing

Mouse/wheel dispatch first gives overlays and components their existing local handling. Unconsumed conversation-scroll gestures update the unified viewport. Any component hit regions are translated through the same `origin` used by rendering, preventing visual/input disagreement.

## Failure Handling

- If a history batch is repeated, its identifier prevents duplicate acceptance.
- If a batch lacks segment metadata, its rows remain visible but are ineligible for component-targeted contextual layers; this is a conservative transitional fallback.
- If an anchor cannot be resolved across width reflow, clamp to the closest valid origin and retain content rather than duplicating it.
- Destructive replay rebuilds both immutable rows and their segment metadata before restoring the viewport anchor.

## Delivery Sequence

1. Preserve segment metadata when rows retire into history.
2. Add explicit viewport state and unified slicing while retaining bottom-follow behavior.
3. Route right-panel placement through unified segments.
4. Add OMP-owned scrolling and anchor preservation.
5. Remove the old `committedRows` visibility floor after regression coverage proves the unified path.
6. Verify finalization, submit, live streaming, scroll-up, scroll-down, resize, overlays, and panel placement through the actual TUI surface.

## Acceptance Criteria

- A visible target row stays at the same physical coordinate when it changes from live to history.
- Submitting the next user message does not cut the visible area or relocate the panel unless the viewport content genuinely changes.
- The panel can remain contextual while viewing older transcript rows.
- Scrolling up freezes the visible logical position while new output streams below.
- Scrolling back to bottom resumes following output.
- History rows are emitted once, with no missing or duplicated transcript lines.
- Panel/overlay bytes never enter stored history.
- Cursor, mouse, and panel coordinates agree with the visible screen after scrolling and resizing.
- Existing bottom-follow behavior remains unchanged for users who never scroll.
