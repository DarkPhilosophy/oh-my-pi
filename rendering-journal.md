# Rendering repair journal

## Scope and safeguards

- User-selected rendering baseline: `bc6f42937aaf89f34ede0c836c5a25ba68f6a541`.
- Investigate blank bands associated with background-job updates and closing `ask`.
- Preserve working long-message streaming, Markdown icons/Copy, and `/render`.
- No commit or push is authorized for this investigation.
- Keep existing assertions; do not treat synthetic success as proof of the live user scenario.

## Investigation started

1. Read viewport placement and retained-history logic in `packages/tui/src/tui.ts`, and existing transition fixtures in `packages/coding-agent/test/transcript-midstream-toggle.test.ts`.
2. Baseline command: `bun test packages/coding-agent/test/transcript-midstream-toggle.test.ts`.
   - Result: 6 pass, 1 fail.
   - Failure: `restores the transcript after a temporary job wait is removed`; viewport no longer matches the pre-wait view. This establishes a failing transition, not the complete cause of the screenshot.
3. Tried one condition change in viewport placement: only bottom-anchor a shrinking frame when `providerVisibleHistory` is empty, rather than also when the frame has shrunk.
4. Command: `bun test packages/tui/test/history-frame-plan.test.ts packages/tui/test/right-panel.test.ts packages/coding-agent/test/transcript-midstream-toggle.test.ts`.
   - Result: 75 pass, 1 fail; the same job-wait restoration failure remains.
   - The edit tool also reported automatic formatting changes, making this experiment unsuitable to retain without normalization.
5. Reverted this unproven experiment in `packages/tui/src/tui.ts`. That file had no pre-existing difference from HEAD at investigation start. The three source files restored to the user's selected rendering baseline were not reverted.

## Checkpoint before isolated regression

- At that checkpoint, no rendering fix was retained and the job-wait transition was red.
- Subsequent provisional correction and verification are recorded below.

## Isolated contraction regression

- User corrected the affected tool to Write, not Edit. The screenshot shows a Write card; Edit is not established as affected. Keep investigation in shared frame placement, not a tool-name special case.
- Added `keeps retired text adjacent to a shrinking job and its next response` to `history-frame-plan.test.ts`.
- On unchanged source, the test fails: expected `JOB_DONE` immediately after `PREVIOUS_2`, received an empty row.
- Reapplied the single placement-condition change with this specific reproduction. The test now passes (3 assertions), including continuity through subsequent growth and absence of a scrollback-clear escape sequence.
- This proves a shared contraction gap in the synthetic frame path. It does not yet prove the complete real-session or ask case.
- The correction is provisional until broader checks and live verification complete. Existing job-wait restoration failure must not be hidden.

## Prior dynamic-tool fix and latest gate

- User clarifies that the issue concerns tools whose output changes, not only particular tool names; a previous fix addressed these changes but introduced other rendering regressions.
- Inspected `931fe14e0206cd971d41c7b023d25043d6c3870b`: it marked every unfinished tool transient and added their combined height to `viewportExpansionRows` in Composer.
- Do not restore that entire change as a shortcut. It couples mutable tool height to temporary menu/dialog expansion; user reports regressions with that version.
- Normalized only the two touched TUI files with the project formatter.
- Latest three-file gate: 76 pass, 1 fail. The original job-wait restoration failure remains; the new contraction/next-response regression passes.
- No claim of complete repair. Next verification must cover changing tool output, not just a fixed job card.

## Shrinking overflow hypothesis

- User proposes that Write grows into overflow, then shrinks out of it while viewport accounting retains the earlier extent.
- Source observation: `providerLogicalCommitted` can retain its previous maximum while current `overflow` decreases; the projection replaces `providerLogicalCommitted - overflow` leading rows with empty strings.
- This is a concrete mechanism capable of reserving blank rows after contraction. Whether those reservations are incorrect for the user's changing Write card still requires tracing its borrowed-row ownership; removing them blindly could duplicate rows already in native scrollback.
- Keep physical terminal height distinct from the logical live-content extent. Investigate both increasing and decreasing live extent together with ownership, not a tool-specific height adjustment.

## Ask with a mounted draft: isolated geometry correction

- User confirms fresh tests still show black bars for ask and background jobs; accept that observation, without attributing it to stale sessions.
- Found a specific missed insertion: the question controller mounts both the ask dialog and draft editor when a draft exists. Composer recognized a temporary host only when the editor was absent.
- Extended the existing dialog-restoration test with the dialog-plus-editor case. Before the source change: 2 pass, 1 fail; eight expected history rows become empty on close.
- Changed only the temporary-host predicate to detect a child other than the canonical editor, including when both are mounted. Did not restore transient treatment for all unfinished tools.
- After the source change: all three dialog cases pass, including unchanged viewport and scroll-buffer position after closing. Existing assertions retained.
- Formatted the touched Composer and test files. Three-file rendering gate: 77 pass, 1 fail; temporary job-wait restoration is still red.
- This proves the mounted-draft geometry correction in VirtualTerminal, not full live-session repair or background-job repair. No commit/push; `/render`, Markdown, and Copy untouched.

## Background-job follow-through

- Traced the remaining job-wait test: its temporary component explicitly declares `isTranscriptBlockTransient`, but the restored transcript interface does not consume that hook. Therefore this test cannot validate the mounted-draft correction; it covers a separate missing temporary-block lifecycle.
- Production tool components distinguish supersedable result snapshots with `isDisplaceableBlock()` and gate removal through `TranscriptContainer.canRemoveBlock()`. Do not equate that state with every unfinished tool.
- No speculative change to those production ownership rules was applied. The job restoration assertion remains intact and failing.
- Coding-agent type check passed after the Composer predicate correction.

## Isolated render scenarios requested by user

- User reports the black band remains between background-job cards and after ask; moving the chat upward is not a fix. Preserve that observation.
- Added `/render --ask`, `/render --job`, and `/render --markdown`, keeping the existing positional repetition/chunk-delay arguments. Reject combined scenario flags.
- Ask executes only the real question and its continuation; job executes only real background handoff, concurrent launches, consecutive waits and continuation. Neither includes the long Markdown introduction.
- Markdown emits one fenced body containing exactly 50 characters, without tool calls or the long workflow.
- Grouped consecutive inspection reads into batches in the default workflow instead of repeating visually identical single-read responses. Preserved stale-edit recovery and consecutive silent waits.
- Three isolated scenarios pass through InteractiveMode/VirtualTerminal with zero provider or credential calls. Coding-agent type checking passes.
- No viewport, transcript ownership, anchoring, Markdown renderer, or Copy changes made in this round. These scenario changes are diagnostic isolation, not a claim that the black band is repaired.
- Real isolated PTY: invoked all three slash flags through the editor; observed the 50-character code block, answered the actual question and observed continuation, then observed background-job completion and continuation. No provider calls were permitted in that harness.
- Condensed default workflow passed at both 20 and 40 rows (2 cases, 74 assertions). Isolated scenarios plus cancellation/event-ordering checks passed (5 cases, 22 assertions). These gates validate scenario isolation, not removal of the user-reported band.
- Stopped the owned PTY through its cleanup handler and removed the throwaway harness.

## Markdown line-count correction

- User clarified the isolated Markdown scenario must contain at least 50 lines, not one line of 50 characters. Replaced the single-line fixture with 50 distinct numbered lines and added an assertion that all 50 appear in order, exactly once, in the terminal transcript.
- Renderer geometry, ask, and job behavior remain untouched.

## User-reported job viewport trimming regression

- User confirms the isolated ask scenario works, while background jobs still leave black bands and the editor remains above the terminal bottom.
- Located the remaining local placement change: the bottom-anchor condition had dropped `rows <= providerWindow.length`. This deliberately kept a contracted frame above the bottom whenever visible history existed; it is not an expansion/accounting fix.
- Restored the original placement condition, preserving the separate Composer mounted-draft ask correction. No all-tools transient classification or viewport-size workaround added.
- Job continuity remains a separate unresolved defect; the adjacency regression test is retained unchanged.
- Verification after restoring placement: 76 passed, 2 failed across history-frame-plan, right-panel, and transcript-midstream-toggle. Failures are temporary-job context restoration and retired-text adjacency after job contraction. Assertions were not changed. Bottom-placement and ask cases passed; this is not evidence that background-job accounting is repaired.
- Subsequent user correction: ask is also still broken. Its smaller question set produces a smaller black band; the earlier isolated run must not be treated as proof of repair. Preserve this observation for both ask and job investigations.
- Real isolated job PTY after restoring the original placement condition: editor reaches the bottom, but a run of blank rows remains between completed background-job cards in native scrollback. The probe permitted no provider or credential calls and was stopped after completion.

## Checkpoint commit

- User assessment: this tree renders history/overflow/transcript/live streaming almost correctly. Remaining defect: when a temporarily rendered tool (background job, ask, sometimes read/edit) grows the viewport by +size and then retracts by -size, the viewport does not recover; the displaced text is neither flushed to history (correct) nor repainted, leaving blank rows.
- Committed as a checkpoint: renderer files restored from bc6f4293, ask-with-draft insertion accounting in composer.ts, `/render --ask/--job/--markdown` scenarios (markdown = 50 numbered lines), retained regression tests. Throwaway probes, backups, and Bazel artifacts are excluded.

## Transient-block accounting round (local only, no git operations)

- Kept locally: generic transient-block API (`isTranscriptBlockTransient`), `transientRowCount` viewport budget in composer.ts, and tool cards reporting themselves transient while still mutable. This is the direction the user endorsed.
- Reverted: every experiment in `packages/tui/src/tui.ts` this round. Restoring the retained history tail on retraction, clamping `retainedCount` to the expanded frame, and dropping the withholding of committed history all traded the black band for lost or duplicated history rows (probe: `history-one` disappeared, or `history-two/three` painted twice).
- Root cause located, not yet fixed: committed history rows are deliberately withheld from native scrollback (`retainedHistory`) and live only on screen. When a temporary insertion expands the frame upward, those rows are overwritten and exist nowhere; on retraction the renderer has nothing to repaint, so blanks remain. A real fix must write committed rows to scrollback at the moment they retire, not hold them on screen.
- Verification after revert: tui history-frame-plan + right-panel 69 pass / 1 fail (`keeps retired text adjacent to a shrinking job and its next response` — the unfixed defect); coding-agent transcript-midstream-toggle 8 pass / 0 fail; type check clean. No commit, no push.

## Transient budget bounded to free screen rows

- Root cause of the `/render` cut (STEP_127 missing at 20 rows): treating every unfinalized tool card as transient inflated the retirement budget past the physical screen, so rows were held back that the terminal could neither display nor retire. Confirmed by bisection — restricting transient to parked jobs made the 20-row workflow pass, restoring pending cards made it fail again.
- Fix (composer.ts): expansion = chrome insertion rows + min(transientRows, free screen rows), free = rows - chrome - non-transient live rows. Pending tool cards stay transient (write/read grow-then-collapse accounted) but never expand beyond what fits on screen.
- `/render` gained `--segment=<n>` to isolate one scripted response; isolated segments seed the todo list so their `done` call succeeds. Read groups now emit summary rows for entries without previews (grouped-read duplicate).
- Verification: render-test-command 7 pass / 0 fail (20- and 40-row workflows), transcript-midstream-toggle 8 pass / 0 fail, type check clean; tui history-frame-plan + right-panel 69 pass / 1 fail (`keeps retired text adjacent to a shrinking job and its next response` — the still-unfixed blackbar path in tui.ts). No commit, no push.
- Still open: the todo HUD that expires on idle is ordinary chrome, so its removal is not accounted as an insertion release; same released-row path in tui.ts as the failing test.

## Reverted the pending-card transient experiment

- User evidence: marking every still-mutating tool card transient (plus the free-rows-bounded budget) made things worse — black bars between background-job cards and persistent live/history cuts at segments 5, 8 and 10, and it broke job rendering that previously worked.
- Reverted both hunks: `isTranscriptBlockTransient()` is parked-background only again, and the expansion is back to chrome insertion rows + min(transientRowCount, rows - 1).
- Kept: read-group summary rows only for entries without previews (the duplicate), and `/render --segment=<n>`.
- Verification after revert: render-test-command 7 pass / 0 fail, transcript-midstream-toggle 8 pass / 0 fail, type check clean, tui history-frame-plan + right-panel 69 pass / 1 fail (the known unfixed shrinking-job blackbar). No commit, no push.

## Reverted the self-clearing-chrome insertion experiment

- Attempt: treat chrome that mounts/unmounts on its own (todo HUD) as an insertion — `isChromeInsertion()` in composer.ts plus `isTranscriptBlockTransient()` on `TodoHudContainer` — so the HUD expiring at idle would release rows instead of leaving a black bar.
- Result: adding the HUD rows to the expansion budget broke the five-row finalize-behind-temporary-UI case and both 20/40-row `/render` workflows (marker dropped from the tape). Bounding the sum under `rows - 1` fixed the composer tests but the workflow tape still lost a marker.
- Reverted all three hunks (helper, HUD marker, budget shape); expansion is again `autocomplete delta + min(transcript.transientRowCount, rows - 1)`. Removed the HUD test that encoded behavior the renderer cannot yet deliver.
- Verification after revert: render-test-command 7 pass / 0 fail, transcript-midstream-toggle + tui history-frame-plan + right-panel 77 pass / 1 fail (the known shrinking-job blackbar), type check clean. No commit, no push.
- Conclusion unchanged: the real fix belongs in `tui.ts` — released rows must be written to native scrollback at retraction time; holding them on screen leaves nothing to repaint on contraction.
- Checkpoint status for commit/push: the known transient-tool retraction blackbar remains unresolved. Earlier rendering was largely correct except for a smaller tool contraction bug; subsequent transient accounting experiments expanded the regression, were reverted, and this tree preserves the current flow fixes while documenting the remaining bug. User explicitly requested committing this work despite the open bug.
