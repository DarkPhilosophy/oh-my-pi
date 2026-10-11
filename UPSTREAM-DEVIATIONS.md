# Upstream deviations

## Images inside Herdr panes (2026-10-08)

- Why: upstream `resolveImageProtocol` returns `null` for every Herdr pane (d3109c8816, #10353): Herdr does not say whether its attached client renders Kitty graphics, and leaked outer-terminal ids caused blank images. Our Herdr fork's VT engine ingests Kitty APC and re-emits it to clients (and blanks Unicode-placeholder cells), so the chip thumbnail was only an icon in every classic client.
- `packages/tui/src/terminal-multiplexer.ts`: `canUseHerdrKittyGraphics` (`HERDR_KITTY_GRAPHICS=1`, direct pane, not under Paseo), `canDiscoverHerdrKittyGraphics`, `queryHerdrKittyGraphics` (bounded `ping`, reads `capabilities.kitty_graphics === true`, fails closed) over a shared `pingHerdrCapabilities`. Upstream Herdr and nested tmux/screen/zellij/cmux/wmux/plugin panes stay gated.
- `packages/tui/src/terminal-capabilities.ts`: Herdr branch of `resolveImageProtocol` yields Kitty only when announced; Paseo vetoes first; `applyHerdrKittyGraphics` applies the same state after daemon confirmation. `packages/tui/src/kitty-graphics.ts`: placeholders follow the same condition. `packages/tui/src/tui.ts`: one-shot discovery next to the SIXEL probe for panes without the marker.
- Chip link: `packages/coding-agent/src/modes/utils/image-source-link.ts` resolves a `local://pasted-image-*` source to its on-disk file for OSC 8 / native hrefs (was `file:///<cwd>/local:/pasted-image-*.png`, which Herdr's preview accepted by extension but could not open). Used in `input-controller.ts`, `ui-helpers.ts`, `interactive-mode.ts` (draft materializer); `custom-editor.ts` prefers the materializer's link. The source itself stays `local://` for `/move`.
- Tests: `packages/tui/test/herdr-kitty-graphics.test.ts`, additions in `terminal-capabilities.test.ts`, updated `coding-agent/test/image-paste-source-path.test.ts`.
- Needs from Herdr (not done here): export `HERDR_KITTY_GRAPHICS=1` at pane spawn when `kitty_graphics::is_enabled()` and/or add `capabilities.kitty_graphics` to `ping`. Reconcile on upstream merges by keeping the Herdr branch and the helper.

## Attyx terminal detection (2026-10-08)

- `packages/tui/src/terminal-capabilities.ts`: new `TerminalId` `attyx`, a `KNOWN_TERMINALS` entry and a `fromProgram('attyx')` case (Attyx sets `TERM_PROGRAM=Attyx`). Only `hyperlinks` differs from the trueColor defaults, so OMP emits OSC 8 links such as the `[copy]` (`omp-copy:`) footer in native Attyx panes. Test in `packages/tui/test/terminal-capabilities.test.ts`. Reconcile on upstream merges by keeping the `attyx` entry.

## Dual rendering in Herdr panes: classic rows next to the native surface (2026-10-08)

- Why: every client attached to a Herdr pane shares one PTY. Attyx draws the TSP surface; Herdr's own client, Tabby, etc. only see the VT grid, which upstream OMP stopped painting once the surface was live (`#doRender` returned after `native.render()`).
- `packages/tui/src/terminal-multiplexer.ts`: `isDirectHerdrPane` is exported (same predicate as before: Herdr identity, no plugin/nested multiplexer).
- `packages/tui/src/terminal.ts`: `Terminal.nativeRelayed?` / `ProcessTerminal.nativeRelayed` = `isDirectHerdrPane($env)` unless `PI_TUI_DUAL=0`. A direct native host (Attyx without Herdr, Tern) is never relayed and keeps native-only behaviour.
- `packages/tui/src/tui.ts`: `#nativeDual` (set in `#startNative` from `terminal.nativeRelayed`; cleared in `#revokeNative`). Dual mode: `#doRender` runs `native.render()` and then the unchanged row pipeline from the same component state (each a separate `terminal.write`; a surface message is one atomic APC); no first-paint hold for the hello probe and no erase of painted rows at handshake; row render cadence/adaptive backpressure kept (native frames share it instead of the credit-only delay 0); resize runs `noteTerminalColumns` and then the normal row resize/replay; `stop()` flushes row history. `#nativeLive` keeps its meaning, so TSP input routing, `closeNative`, `nativeRendering` and the debug mirror are untouched.
- Contract with Attyx (no wire change): the session surface stays `mode:"inline"`, `role:"omp.session"`, `adopt` as before. Attyx treats a live, non-retained surface with `mode=="screen"` or `role=="omp.session"` as owning the pane and skips the classic grid; Herdr's classic clients keep the rows. Do NOT switch the session surface to `mode:"screen"`: tsp-core rejects `adopt` for non-inline surfaces and replaces same-mode surfaces (a fullscreen overlay's screen surface would destroy it).
- Known limit: `nativeRendering` consumers in coding-agent (e.g. the `/btw` inline panel, which is withheld in favour of its history sheet) still pick native-only presentation; classic clients get the sheet overlay rows instead.
- Tests: `packages/tui/test/native/dual-render.test.ts` (+ `relayed` option in `test/native/tsp-harness.ts`). Reconcile on upstream merges by keeping the `#nativeDual` guards at the sites above and the harness option.

## Agent identity for Herdr in the dev launcher (2026-10-08)

- `packages/coding-agent/scripts/omp`: `run_bun` launches Bun as `exec -a omp` on every platform (upstream: macOS inside Herdr only), using bash when `/bin/sh` lacks `exec -a`. Herdr identifies the pane's agent from argv[0]; through the dev launcher it was `bun`, so in daemon mode (where this process stays the pane's client) Herdr listed no agent. Reconcile on upstream merges by keeping the unconditional `exec -a omp` and the bash fallback.

## Existing-pane API discovery (2026-10-08)

- `packages/tui/src/terminal-multiplexer.ts`: retains marker fast path; missing marker in an ordinary direct Herdr pane queries existing socket `ping` for `capabilities.native_transport`. Requires pane identity and socket, rejects plugin/nested markers and tmux/screen TERM before connecting; explicit marker opt-outs are retained. Discovery fails closed on malformed/old/error responses, caps response size at 64 KiB and total socket wait at 250 ms.
- `packages/tui/src/terminal.ts`: holds first paint synchronously during discovery, performs hello/DA1 only after affirmative API response, resolves null on failure, and invalidates late callbacks on stop/restart using a generation counter. PI_TUI_NATIVE overrides and default test-runtime probe suppression are unchanged.
- `packages/tui/test/herdr-native-transport.test.ts` and `packages/tui/test/native/probe.test.ts`: real Unix socket coverage for marker-free panes, disabled/old capability, nested/plugin rejection, unavailable/unresponsive daemons, first-paint pending, hello success, negative callbacks and stop races.
- Reconciliation: merge upstream capability discovery rather than removing the nested guards; rerun native probe/capability tests, owned Attyx marker/no-marker handoffs and real nested-tmux title check. Running processes cannot be retroactively given a new inherited environment variable; restart only OMP when desired, not the pane shell.

## Automatic native transport negotiation in Herdr (2026-10-07)

Authored in this task; applies to this checkout, not another OMP clone.

- `packages/tui/src/terminal-multiplexer.ts`: exports `canQueryHerdrNativeTransport`, requiring Herdr classification and the exact `HERDR_NATIVE_TRANSPORT=1` capability hint. Rejects any defined TMUX, STY, ZELLIJ, WMUX, WMUX_SURFACE_ID or CMUX_* environment marker, including empty values, and TERM prefixes tmux/screen (case-insensitive). Classification itself is unchanged.
- `packages/tui/src/terminal.ts`: checks the capability helper after explicit PI_TUI_NATIVE overrides and before the existing multiplexer rejection. PI_TUI_NATIVE=0 remains the absolute opt-out; PI_TUI_NATIVE=1 retains its existing explicit force semantics. An automatic probe does not assume the host supports TSP: the existing hello/DA1 negotiation still decides support.
- `packages/tui/test/native/probe.test.ts`: exercises real ProcessTerminal probe writes and hello callbacks for native Herdr, missing/disabled hints, nested multiplexers, TERM fallbacks and opt-out, with the fixture's forced flag removed for these cases.

Purpose: allow a TSP-enabled Herdr fork to forward OMP's native handshake automatically, while avoiding APC queries that nested tmux can consume as a pane title.

Upstream reconciliation: retain the capability gate and negative nested-multiplexer tests until upstream offers an equivalent negotiated Herdr transport. Merge any new multiplexer markers into the rejection checks; do not replace this with Herdr-first classification alone, since that hides nested TMUX/STY/ZELLIJ markers. Re-run the native probe and terminal-capability tests and the Attyx owned GUI handoff/nested-tmux checks after merging. Remove these fork changes only when upstream covers both automatic Herdr negotiation and nested title safety.

Pre-existing dirty `MODULE.bazel.lock` and `packages/coding-agent/src/prompts/tools/computer.md` were not authored or changed by this task and are not attributed to this transport deviation.
