# Upstream deviations

## Automatic native transport negotiation in Herdr (2026-10-07)

Authored in this task; applies to this checkout, not another OMP clone.

- `packages/tui/src/terminal-multiplexer.ts`: exports `canQueryHerdrNativeTransport`, requiring Herdr classification and the exact `HERDR_NATIVE_TRANSPORT=1` capability hint. Rejects any defined TMUX, STY, ZELLIJ, WMUX, WMUX_SURFACE_ID or CMUX_* environment marker, including empty values, and TERM prefixes tmux/screen (case-insensitive). Classification itself is unchanged.
- `packages/tui/src/terminal.ts`: checks the capability helper after explicit PI_TUI_NATIVE overrides and before the existing multiplexer rejection. PI_TUI_NATIVE=0 remains the absolute opt-out; PI_TUI_NATIVE=1 retains its existing explicit force semantics. An automatic probe does not assume the host supports TSP: the existing hello/DA1 negotiation still decides support.
- `packages/tui/test/native/probe.test.ts`: exercises real ProcessTerminal probe writes and hello callbacks for native Herdr, missing/disabled hints, nested multiplexers, TERM fallbacks and opt-out, with the fixture's forced flag removed for these cases.

Purpose: allow a TSP-enabled Herdr fork to forward OMP's native handshake automatically, while avoiding APC queries that nested tmux can consume as a pane title.

Upstream reconciliation: retain the capability gate and negative nested-multiplexer tests until upstream offers an equivalent negotiated Herdr transport. Merge any new multiplexer markers into the rejection checks; do not replace this with Herdr-first classification alone, since that hides nested TMUX/STY/ZELLIJ markers. Re-run the native probe and terminal-capability tests and the Attyx owned GUI handoff/nested-tmux checks after merging. Remove these fork changes only when upstream covers both automatic Herdr negotiation and nested title safety.

Pre-existing dirty `MODULE.bazel.lock` and `packages/coding-agent/src/prompts/tools/computer.md` were not authored or changed by this task and are not attributed to this transport deviation.
