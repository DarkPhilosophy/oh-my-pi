# Rendering repair journal

## Scope and safeguards

- User-selected rendering baseline: `bc6f42937aaf34ede0c836c5a25ba68f6a541`.
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

## Current contraction finding

- User reports the latest local behavior is more stable during streaming, but the current contraction handling is still a mask: when a temporary job/ask/tool loses rows (`-size`), the chat is moved upward instead of restoring the full logical viewport and keeping all context available.
- The black bar remains subtly visible for `ask`; the same pattern is visible for background jobs.
- Required model: temporary UI/tool growth must be tracked from the beginning as virtual viewport growth (`base viewport + inserted rows`), then the exact inserted rows are removed on contraction while the original context remains available. Rows displaced by the temporary expansion must not be silently flushed without a corresponding visible/owned replacement.
- Current `tui.ts` still has a `startTop` contraction branch that changes placement based on retained visible history. This can hide the hole by moving the chat rather than reconciling the rows released by the shrinking tool.
- This is an open bug; no fix is claimed yet.
- Tried a shared retraction reconciliation in `tui.ts`: temporarily flushed retained visible rows when `viewportExpansionRows` changed from positive to zero, while keeping bottom anchoring.
- The shrinking-job fixture passed, but the ask/job transition suite regressed (`2` failures, including transcript restoration and missing `ROW_10`). The experiment was immediately reverted; no source behavior from it remains.
- After rollback, `transcript-midstream-toggle` returned to `8 pass / 0 fail`. The root issue remains that retained rows are not reconciled with the real tool-owned transient lifetime; the chat must not be moved upward as a substitute.

## Contraction placement experiment

- Restored the exact `startTop` condition from `bc6f4293`; the baseline comparison showed no other renderer logic difference.
- Added one narrow contraction branch only when visible retained history exists and the new mutable frame is shorter than the previous one; it keeps the new frame adjacent to retained history instead of inserting a blank seam.
- Verification: the shrinking-job regression and the combined history/transcript suites pass (`47/47`).
- This is a local experiment, not a final root fix: the branch preserves adjacency but does not yet implement the required atomic scrollback commit plus viewport repaint for every real tool contraction.

## Semantic transient viewport implementation attempt

- The first proposed `tui.ts`-only replacement of `""` padding was tested against the shrinking-job regression and failed because the semantic prefix had already been committed to native scrollback.
- The attempted Composer ownership adjustment was reverted because borrowing every active transcript row would suppress normal streaming retirement.
- Current conclusion: transient ownership must be supplied by the actual transcript entries that remain logically live; it must not be inferred from total active rows or reconstructed with blank padding.

## Semantic prefix contraction fix

- The contraction fixture now supplies the still-live prefix through `viewport` together with `borrowedViewportRows`, matching the Composer/TUI ownership contract.
- `tui.ts` no longer pads the retained prefix with synthetic empty rows; it reuses only real retained rows and leaves rows outside the physical viewport for normal history handling.
- Verification: shrinking-job regression passes; combined history and transcript suites pass (`47/47`).

## Contraction guard experiment

- Re-enabled the surviving-prefix reconciliation when a history batch is emitted in the same frame as borrowed ownership drops (`borrowed 20 → 0`, `history 26`).
- Exact current-checkout tests: shrinking-job 1/1, temporary-job-wait 1/1, complete transcript-midstream 8/8.
- The 20-row and 40-row workflow gates exceeded the 30-second command limit before producing a result; no visual success is claimed.

## Current transient-growth verification

- The transient-growth checks now assert native scrollback ownership through `baseY`, rather than comparing the combined scrollback-plus-viewport projection (which necessarily changes when the visible grid is repainted).
- Verification: `history-frame-plan.test.ts` plus `transcript-midstream-toggle.test.ts` passed `49/49`; the complete `/render` workflow at 20 and 40 rows passed `2/2`.
- No GitHub operation was performed. The real job/ask contraction behavior remains covered by the existing transition tests and requires live confirmation for final visual acceptance.

## Partial-result contraction investigation

- Reproduced `/render --job 1 5` through real local tools and captured every terminal write together with the Composer plan. With only parked tasks marked transient, contraction left six empty rows between completed job cards.
- The existing isolated-scenario test only checked tool execution, not this geometry. Added a regression that checks card adjacency after every write and preserves the ordered continuation markers. It fails without the candidate change.
- Broadening transient ownership to every unfinished call or keeping finalized displaceable snapshots transient removed the job gap but lost streaming markers in the complete workflow. Both variants were withdrawn. The final predicate does not reserve rows for argument-only calls or finalized per-turn snapshots.
- The narrower candidate marks existing partial-result snapshots transient, in addition to parked tasks. Argument-only calls retain their previous behavior. The isolated job trace has no inter-card gap and emits no scrollback-clear sequence; a fresh real PTY run also preserves adjacent cards.
- Final verification: 88 tests passed across the complete render workflow, transcript-midstream, history-frame-plan and right-panel suites. The full workflow includes both 20-row and 40-row terminals. Package type checking and scoped lint/format checking passed.
- A fresh 110×20 real PTY ran `/render --job 1 5`, followed by `/render --ask 1 5` and an actual answer. Completed job cards remained adjacent; the question continuation appeared directly after the result card. The editor remained in its normal bottom chrome position. This verifies those exercised paths, not every possible tool/idle transition or the user's own terminal.
- Removed the owned diagnostic probe after retaining the regression test, stopped the owned PTYs, and narrowed the changelog claim to the demonstrated partial-result job gap. No geometry, padding, anchoring, right-panel, Copy or `/render` implementation changes were made in this round. Existing local work is preserved; no commit or remote operation was performed.

## Simultaneous history retirement and live overflow

- User live testing invalidated the previous broad readiness claim: job gaps and partially repeated/cut Read cards remained. Preserved the partial-result lifecycle improvement instead of reverting it.
- Expanded the real-tool job geometry regression to 20, 30, 40 and 60 rows. The 40-row case reproduced an extra blank row between cards before this correction.
- Captured the producer plan and physical terminal tape after each write. A frame can retire a finalized history batch and also have newly overflowing live rows. The old mutually exclusive history/no-history branches skipped borrowing those new rows before `slice(overflow)`, losing the prefix from that physical frame.
- Corrected that shared accounting: first reconcile the finalized batch, then account for newly overflowing live rows in the same frame. Shutdown draining deliberately does not borrow new live rows while finalized batches remain. No new padding, chat-position heuristic, widget change, or tool-specific renderer branch was introduced.
- Added a regression asserting exact ordered text across simultaneous retirement/overflow and the following frame. An initial variant duplicated a row during terminal handoff; the shutdown guard corrected that failure without weakening its assertion.
- Verification: history-frame-plan, right-panel and transcript-midstream passed 81/81; job geometry at all four heights passed 4/4; complete workflows at 20/40 rows passed 2/2. A new 441-frame job capture included four simultaneous history/overflow frames and zero missing command-card prefixes. Its sole scrollback clear occurred during initial empty workflow setup, not a job transition.
- A fresh 110×40 PTY exercised `/render --job 1 5`; the captured completed cards and continuation were contiguous. These are measured local paths, not a claim of exhaustive live acceptance. Everything remains local, with no commit or push.

## Live feedback and varied Read fixture sizes

- User reports that the latest local candidate still cuts/repeats live Read cards and leaves job gaps at the viewport/history boundary. The previous readiness report is not evidence that this live defect is resolved; preserve the feedback as the current acceptance result.
- Expanded `/render` input fixtures without changing segment order: small (24 lines), medium (64 lines), and large (128 lines). Medium/large rows contain distinct numbered cells and values rather than repeated short text; large rows are hundreds of characters wide. Reads now request each fixture's full line range.
- The existing collapsed Read preview still shows its normal first three source lines; expanding the card exposes the full large fixture. No production preview limits or renderer geometry were changed for this fixture update.
- Verification: the complete 40-row workflow passed with the varied fixtures. A full 150×40 captured workflow completed with 970 terminal writes and no unfinished Read border followed by another Read header in that particular run. This does not invalidate the user's live reproductions.

## Collapsed-tool boundary duplication confirmed

- User clarifies that all live failures were observed with normal collapsed tools, without Ctrl+O. Expansion toggles are an additional case, not a prerequisite or an explanation for this bug.
- Re-analyzed the captured complete 150×40 workflow for repeated Output sections inside one card, instead of merely searching for missing borders or gaps. Nine frames contain a duplicated Output separator in the same background-job card.
- First observed transition: frame 798 has native baseY=421 and 37 logical viewport rows; frame 799 keeps native baseY=421, grows to 48 logical rows, and reports expansion=10 with borrowed=0. Its write starts at physical row 1 with an Output separator, directly below another separator already in native history. Thus a complete outer border is insufficient as an integrity assertion.
- This reproduces the user's boundary-cut/duplicate symptom with collapsed cards and identifies a concrete transition for further investigation. No new renderer patch has been applied on the basis of this observation.

## Visible waiting interval in isolated job scenario

- At the user's request, `/render --job` now launches background jobs lasting 20 seconds and uses five-second timeouts for its first two wait calls instead of 250 milliseconds. Later waits allow completion; the general workflow retains its existing timings.
- The isolated real-tool job scenario completed successfully in 30 seconds. This timing change enables visual inspection of waiting transitions; it is not a renderer fix.

## Scroll accessibility while temporary UI remains open

- User live testing confirms that command suggestions also hide previously accessible content while `/` remains open; closing the menu restores it. Restoration alone is not acceptance: displaced content must remain reachable through scrolling during the insertion.
- A new isolated job capture also reproduced duplicated Output sections while waiting was active. The observed transition keeps native scrollback position unchanged while the logical frame grows from 37 to 48 rows and reports 10 expansion rows; this occurrence does not involve a new history batch.
- The current expansion count is not a complete virtual viewport or a scroll-accessible backing store. The proposed extensible buffer with an initial two-screen reserve requires explicit row ownership and scroll projection; multiplying a height alone would not expose application-retained rows to native terminal scrolling.
- This round records observations and an architectural suggestion only. No buffer redesign, renderer behavior change, commit, or remote operation was performed. The renderer defect remains unresolved.

## Isolated reversible-buffer experiment

- Added a standalone interactive experiment in `packages/tui/examples/reversible-viewport-experiment.ts`; production rendering sources were not changed.
- Model: stable row identities, application-owned finalized history, a reversible live buffer, identified temporary insertions, an initial 2H capacity reserve that grows when needed, and a reader anchor. Removal and terminal resize do not commit content; permanent append may retire a stable prefix when no insertion pins it.
- Verification runs the emitted terminal bytes through VirtualTerminal: 65 frames at heights 1, 12, 20, 40 and 100 cover insertion/removal, covered-context scrolling, nested insertions, streaming beyond 2H, reader anchoring, mutable-block contraction and height reduction. All assertions pass; native scrollback remains unchanged.
- An initial normal-screen resize moved rows into native scrollback. The experiment therefore explicitly uses the alternate screen in both its interactive entry and verification. This is an architectural difference, not an existing OMP renderer fix: finalized history and scrolling are owned by the application. Native mouse-wheel scrollback, production tool lifecycles, width reflow, persistence, and bounded-memory retirement during indefinitely active insertions are not demonstrated here.
- Started the interactive program in an owned PTY, exercised waiting insertion and removal, and exited normally. Final verification passed after formatting. No commit, push, or replacement of the current renderer was performed.

## Production OMP boundary regression

- Extended the existing real-tool `/render --job` test to reject repeated Output sections within a single card after every terminal write. This runs the actual AgentSession, Composer, tool execution and TUI path, not a standalone viewport model.
- The 40-row run fails with two consecutive Output separators inside the same background-job card, reproducing the reported defect that the previous adjacency-only assertion missed.
- Tested borrowing the complete overflow instead of subtracting reversible expansion. The actual job run then failed with six blank rows between cards. Reverted that source change; retained the stronger regression assertion.
- The captured offending transition has 37 to 48 logical rows, expansion 0 to 10, unchanged native baseY 64, and no new history batch. The source defect remains unresolved. No commit or GitHub operation was performed.

## Clarified A/B/C ownership contract

- A is the physical live window; B is an additional application-retained live window; C is immutable native history. Overflow from A enters B, not C. Only eligible overflow from B enters C.
- User example, newest first: A=[1,2,3], B=[], C=[]; inserting 0 produces A=[0,1,2], B=[3], C=[]; inserting [9,8,7] then produces A=[9,8,7], B=[0,1,2], C=[3].
- Removing temporary rows refills A from B without reading, clearing, or rewriting C. A and B need actual semantic rows and ownership, not empty padding or a height counter. The current Composer expansion budget and native borrowed-row bookkeeping do not establish this contract.
- The latest erase-before-repaint experiment still reproduced the duplicate Output separator in the actual 40-row job workflow. Removed that unsuccessful hunk and restored source formatting. This is negative evidence against stale uncleared viewport cells as the sole cause; no fix or live readiness is claimed.

## A/B/C clarification: projection rather than disjoint windows

- User corrected the preceding interpretation: A is a dynamic live projection, not a fixed-capacity store independent of B. B retains real uncommitted context that A can display; their content must not be counted as separate copies.
- The intended retained live extent grows toward two terminal heights once enough content exists. Temporary UI occupies projection space without deleting displaced context from B or committing it to C. Removing temporary UI restores context from B; the temporary rows themselves do not enter B or permanent history.
- Distinguish visual displacement, live retention, and irreversible history commitment. A temporary insertion/removal alone must not advance the permanent boundary. Short initial content must not be padded with fabricated context merely to reach the target extent.
- This clarification supersedes the fixed, disjoint A/B interpretation above. It records the requested contract, not a completed implementation or verification.

## Superseding clarification: controlled live/history boundary

- The user subsequently rejected the no-commit-on-temporary-insertion restriction in lines 247–248. Insertion may displace context through B into C when the retained live capacity is full. Removing that insertion does not retrieve committed context from C, does not cause another flush, and does not insert blank replacements.
- Example with terminal height five: ten retained rows plus two temporary rows can commit two old context rows; removal leaves eight retained context rows, still more than the physical screen. A later temporary row fits and disappears without another commit; permanent additions refill available capacity before further overflow.
- The essential requirement is a dynamic live projection backed by actual intermediate retained rows and one explicit permanent-commit boundary. Physical height determines painting, not independently the lifetime of retained content. History and the displayed live continuation must remain ordered without cuts or duplicate rows during growth, replacement, and removal.
- These are clarified requirements, not evidence of an implemented or verified fix. Preserve native interaction and existing local work; no separate alternate-screen demo or remote operation is requested.

## Current full-overflow candidate — retained locally

- Preserved the current changes as explicitly requested by the user; no undo, commit, or remote operation.
- TUI now accounts for full borrowable overflow, skips reserved-slot blanking during expansion, removes already borrowed slots instead of painting empty rows after expansion, and limits replay prefixes to real retained rows.
- The actual 40-row `/render --job` regression now passes, including inter-card gaps and duplicated Output sections. The captured preceding failure showed borrowed=5, expansion 10→0, and six empty painted rows.
- Broader verification is not green: 75 passed and 7 failed across history-frame-plan, right-panel, and transcript-midstream-toggle. Failures include reversible expansion ownership, command-menu restoration, and bottom placement. This candidate is not ready for user testing or a completed fix. Tests were not weakened.

## Production retained-live integration

- Added a retained live-frame snapshot to TranscriptContainer. It holds the complete editable row sequence, including rows outside the physical terminal window, and is reset with the transcript.
- Composer now obtains its live rows from this snapshot and offers retirement against two terminal heights rather than a single screen plus a temporary-growth counter.
- Added an explicit retainedLiveViewport plan contract: off-screen rows remain producer-owned rather than being implicitly borrowed into native history by the writer.
- The transcript insertion/removal regression passes, including off-screen context retention; the coding-agent type check passes. Production job and full-workflow verification remain in progress. No completion or live-readiness claim is made.
- Existing local work remains in place. No commit, push, or other remote operation was performed.

## Resumed after interrupted instance

- Resumed verification of the existing retained-live candidate without reverting local work or performing remote operations.
- The production 40-row concurrent-job test passes on the current source (30.12 seconds).
- The shared geometry gate reports 72 passes and 10 failures. These include duplicated native rows, missing live transcript rows after menu removal, and editor placement; they are not treated as obsolete assertions or a completed fix.
- Full production workflow verification is running against the same source. Readiness remains unconfirmed.
- User live report confirms inaccessible history and explains that the candidate still cuts the displayed context. The `Fixture 1, row 1` text originates in the job scenario's existing `cat sample-1.txt && sleep 8` action, not a renderer debug overlay.
- Full resumed production gate failed (6 passed, 5 failed), including missing Markdown lines, missing STEP markers, and 60-row job geometry.
- Corrected the retained-mode transport: off-screen producer-owned rows are now included in the existing borrowed-row transfer rather than discarded by physical clipping with a zero borrow count. This preserves the separate producer retirement ledger while making those rows reachable in terminal output.
- Focused verification after this change passes for isolated Markdown and 60-row jobs (2 tests); full and shared gates are being rerun. This does not yet establish complete reversible behavior.

## Experimental rendering progress checkpoint

- User requested preserving and publishing the current progress, not declaring the renderer fixed.
- Latest user live assessment: final output of `/render` and `/render --job` is satisfactory, with coherent history and a consistent final viewport/history boundary. Rendering during execution, especially `/render --job`, remains incorrect.
- This checkpoint is experimental work in progress. Live cuts, duplicates, and gaps are not claimed resolved.
- Latest full verification reported 42 passes and 8 failures across production rendering, transcript transitions, and right-panel tests. After isolating legacy prefix padding from retained-live handling, history-frame-plan and right-panel pass 74 tests; the production failures have not been demonstrated resolved.
- Preserve the current implementation and regression tests. Exclude local backups, temporary model databases, and the diagnostic live-card probe from the commit; leave those files untouched locally.

## Local repair after experimental checkpoint

- Captured the real job transition: logical rows contract from 38 to 31 while 18 rows remain borrowed and native baseY stays unchanged. Slicing only at physical overflow repainted a borrowed card into the viewport a second time.
- Retained-mode projection now begins after both physical overflow and the already-borrowed prefix. Temporary chrome coverage is passed through to the writer, and chrome-only displacement is excluded from new borrowing.
- Separated physical header retirement from the two-screen transcript retention capacity. Header ownership now advances before physical clipping can drop the first streamed row.
- Restored erase-before-reposition for old mutable cells. The complete eight-test midstream suite now passes without changing assertions.
- Current complete production/history/right-panel gate: 84 pass, 1 fail. The remaining observed failure is an extra blank row between job cards at 60 terminal rows. Capturing that transition next; this is not completion.
- All changes remain local. No commit or push.
- The 60-row capture isolates the remaining gap to working-indicator removal after the final streamed response: logical frame 110→109, borrowed prefix 41→50, no new native scroll (baseY remains 79). The preceding card ends at tape row 78; its one separator becomes two because the 59-row suffix is reanchored one row lower. This is not the earlier duplicated-Output transition, which the current max(overflow, committed) projection already handles. No additional source change was made on the stale advisor hypothesis.

## Requested coherent chrome checkpoint

- User reports improved overall rendering but remaining menu-open scroll gaps, raised input after contraction, and blank space when the todo HUD expires. These remain required behavior, not accepted compromises.
- Tested a retained-mode bottom-anchor override with existing borrowed rows. The production gate reported 57 passes and 5 failures: all four job geometries gained blank bands, and the 40-row workflow lost a streaming boundary. The candidate is preserved locally under `.backup/tui-bottom-anchor-candidate.ts` but excluded from active source and publication.
- The pre-existing local progress is preserved. No universal chrome-removal fix is claimed; command-menu scroll accessibility and todo-idle contraction remain unresolved.

## Preserve progress before further chrome work

- User clarified that the immediate request is to commit the preceding working progress, not delay preservation while attempting a universal fix.
- Active rendering changes are the pre-chrome-experiment changes documented above: retained-prefix projection, physical header retirement, chrome borrowing bound, and erase-before-reposition. The added bottom-anchor override is not in the active source.
- Latest focused verification after excluding that override: 51 tests passed across history-frame-plan and transcript-midstream-toggle. This is not a claim that all production rendering defects are fixed.
- Publish only the two rendering source files and this journal. Preserve all local backups and diagnostic files without staging or deleting them.

## User-requested command-menu checkpoint

- User requests committing and publishing the current candidate, then pausing all work. Their mini live tests show no duplicates, black bars, or cutting; the chat still does not stay at the bottom. Broader live testing remains pending.
- Composer now includes chrome-displaced transcript overflow in the borrowable row bound. The new regression exercises continued streaming while command suggestions remain open.
- Latest automated midstream run: 4 pass, 5 fail. The new open-menu streaming case passes; remaining failures cover dialog restoration, visible-tail restoration, and menu-close restoration. Preserve these assertions and record this as experimental progress, not a completed fix.
- Publish only the scoped Composer change, its regression test, and this journal. Leave backups, temporary databases, and the diagnostic probe untouched. No further rendering changes are part of this checkpoint.

## User correction: preserve terminal history

- The user rejects the later destructive-replay patches as symptom masking, not a correct implementation of viewport expansion and contraction. Earlier passing tests and completion claims did not establish preservation of the terminal scroll position.
- MUST NOT use `clearScrollback`, `#prepareForcedRender(true)`, or an equivalent history wipe/rebuild to repair ordinary rendering: slash suggestions, TODO dismissal, waiting/ask transitions, or streaming tool updates.
- Existing terminal history MUST remain intact during ordinary rendering. Fix logical viewport capacity, mutable-row ownership, clipping, and expansion/contraction instead of resetting history to hide gaps or stale output.
- Resize or another specifically justified reset operation may have a dedicated reset path; these exceptions MUST NOT become automatic fallback reconciliation for ordinary frames.
- Appending a replay of the whole history without clearing is not a substitute: it can duplicate history and disturb scrolling. Preserve existing history, not merely avoid the ED3 sequence.
- Acceptance must include preserved history content/order, no duplicate or missing rows, correct bottom anchoring when following live output, and no forced scroll-position jump, alongside slash, TODO, ask/wait, and long mutable-tool scenarios.
- This entry records the required constraint only. It does not remove the existing destructive replay paths or claim the rendering defects are fixed.
