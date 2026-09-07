# FX terminal UI acceptance

Reference: `vercel-labs/fx` at `e3b6fe0229e7dbddc654e84a6e60498d1bd9a21f`.
The target is Gent's terminal client. Keep Gent's name and extension features.
Do not replace its runtime or copy FX's provider policy.

## Checks

The final audit below supersedes pending results in the chronological notes.

### Final acceptance audit

The source still uses the pinned FX reference above. The final Herdr pass
checked inspection, menu placement, and draft return after the progress-row
change. The final gate and E2E runs cover the current application source.
Only this evidence record changed after those runs.

| Area                 | Verified result                                                                                                                                              | Evidence section                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Reference comparison | One column, rail input, adjacent menus, grouped calls, full inspection, and progress above the composer follow FX.                                           | Source evidence; Partial-message mutation and active progress; Final walkthrough |
| Terminal sizes       | Short and long content work at 120×40, 80×24, and narrow sizes. Resize rebuilds native history and keeps the tail.                                           | Approved resize reset: verification                                              |
| Theme                | The default palette uses FX neutral values. Light and dark selection emit the expected colors. Diff signs retain semantic colors without filled backgrounds. | Edit diff theme and contrast evidence in the notes below                         |
| Input and navigation | Text, expanded paste, shell mode, session drafts, branch drafts, inspection, and queue restoration pass.                                                     | Branch draft and composer evidence in the notes below; Final walkthrough         |
| Interactions         | Questions, multi-select, free text, confirmation, real review editing, todos, and connection recovery pass. Long question controls fit at 44×12.             | Question, review, todo, and connection evidence in the notes below               |
| Native history       | Resize, repeated menu returns, later replies, compact toggles, and replacement/shrink/growth of a partial message pass.                                      | Transcript layout replay follow-up; Partial-message mutation and active progress |
| Validation           | Full gate and both E2E tasks pass on the final source. No appearance-only tests were added.                                                                  | Final walkthrough                                                                |

### Product differences and terminal limits

Gent keeps its identity, model names, cost/context labels, branch controls,
extension tools, and tool-specific detail views. FX's provider selection,
command names, per-response usage records, and timestamp presentation are
not copied. These are product differences, not claims of exact parity.

Both clients depend on the terminal for font rendering and default background.
Gent keeps that background transparent. The light-mode check verifies emitted
colors and calculated contrast against white. It does not verify a physical
light terminal background: Herdr exposes no per-pane background setting, and
the shared host theme was not changed. No pixel-identical claim is made.
Arbitrary third-party widget layouts remain extension-owned. The shipped
widgets and their supported interaction paths have the live evidence below.

Resize and transcript layout replay clear saved terminal lines, including
pre-app shell output. The user approved that policy. Session data is retained.
The OpenTUI dependency patch remains local and recorded under `patches/`.
No upstream publication, commit, merge, push, or release was performed.

- [x] Use a neutral default palette in light and dark terminals. Keep color for diff meaning. See the host-background limit above.
- [x] Keep one transcript column. Do not show a permanent navigation panel.
- [x] Place the composer after short content. Reserve its space when content fills the terminal.
- [x] Remove the idle composer's full-width border rules.
- [x] Use a connected `┃` rail for input and submitted user text. Preserve wrapping and multiline editing.
- [x] Keep status text small and neutral. Preserve primary controls when width is short.
- [x] Put command and option lists next to the composer. Keep selection, help, and close behavior consistent.
- [x] Show tool groups and call summaries by default. Keep full detail available in transcript inspection.
- [x] Keep activity, errors, approvals, questions, queued input, and shipped extension widgets legible.
- [x] Preserve drafts across navigation and transcript inspection.
- [x] Verify short and long transcripts at 120×40, 80×24, and a narrow pane.
- [x] Verify keyboard focus, resize, scrolling, interruption, and recovery through real terminal input.
- [x] Compare final captures with FX. Explain any remaining platform or product difference.
- [x] Run the full gate and relevant end-to-end tests.

### Final walkthrough

At 80×24, full inspection shows complete tool results. Escape returns to
normal summaries. The command menu sits beside the composer and displays
six results with navigation help. Closing it preserves `Final draft check`.
The temporary terminal size control was stopped. The test draft was cleared.
The isolated preview remains in Herdr pane wZ:pD. All existing architecture
work remains in the FX Rift. The warm source was not changed.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/native-transcript.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/composer-frame.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/command-palette.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/theme/themes/fx.json`
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/render.zig`
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/render_engine/footer_layout.zig`
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/footer/picker_presentation.zig`
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/render_engine/terminal_diff.zig`
- `/tmp/fx-live-tool-active.ansi`
- `/tmp/fx-live-tool-complete.ansi`
- `/tmp/fx-live-tool-inspection.ansi`
- `/tmp/gent-fx-ui-final-inspection.ansi`
- `/tmp/gent-fx-ui-final-menu.ansi`
- `/tmp/gent-fx-ui-final-draft-return.ansi`
- `/tmp/gent-fx-ui-progress-placement-gate.log`: full gate exit 0.
- `/tmp/gent-fx-ui-progress-placement-e2e.log`: both E2E tasks exit 0.
- `/tmp/gent-fx-ui-final-source-receipt.txt`: source and validation-log hashes.

## Before

Gent fills the terminal and pins its composer below empty space.
Two full-width rules frame the composer. The prompt uses `❯`.
The default system palette can introduce colored accents.
The idle footer always shows the workspace and branch.

FX follows short content with a rail composer and a plain status row.
Its menu adds rules only when the menu opens.
Its footer calculation reserves input, picker, and banner rows together.

## Source evidence

FX source root: `/Users/cvr/.cache/repo/vercel-labs/fx`.

- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/render.zig`: neutral light/dark palette and width-aware status line.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/render_engine/footer_layout.zig`: transcript-relative footer placement and bounded row allocation.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/footer/paint_plan.zig`: zero top composer chrome and activity reservation.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/assistant/user_message_card.zig`: bold text, repeated rail, display-width wrapping, no card fill.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/footer/picker_presentation.zig`: bounded menu rows and query truncation.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/transcript/tool_group_projection.zig`: summary headers with optional detail projection.

Gent source root: `/Users/cvr/Developer/personal/.rifts/gent/fx-ui`.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/app.tsx`: full-height app shell.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session.tsx`: transcript, composer, status, and extension slots.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/bordered-input.tsx`: composer rules and padding.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/composer.tsx`: input rendering and controls.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/theme/context.tsx`: default theme selection.

## Progress

The first change adds an FX-derived neutral theme as the default.
Other themes remain available. Visual acceptance is not yet proved.
The original architecture Rift remains unchanged.

The composer now uses a plain status row and no border rules.
The transcript reports its rendered height to the scroll container.
Short transcripts no longer push the composer to the terminal bottom.
Live captures at 120×40 and 60×20 show this behavior with an error turn.
Long-transcript scrolling remains unverified.

The authentication panel previously occupied normal layout space below the
session. Its outer box now uses absolute positioning. A live 120×40 capture
shows the complete panel inside the terminal.

Event notices now use a bullet and wrapping text instead of a full-width
rule. The earlier narrow capture showed truncated error text. The new
notice rendering still needs a fresh live capture.

Do not add appearance-only tests. Use terminal captures for visual checks.
Keep tests for input behavior. The existing composer submission, suspended
input, and slash popup checks pass with the new prompt symbol.

The composer now uses a box rail, so wrapped input keeps a continuous edge.
Completion lists render below the input at full width. Escape closes an
empty list as well as a populated list. Tool details now start expanded.

A 35-line live prompt at 60×20 exposed a footer overflow. The transcript
height now excludes the measured footer and extension-widget height.
The repeated capture shows the last transcript rows, the complete wrapped
error, the composer, and the status row. Mouse scrolling reaches older
rows without moving the composer. Explicit transcript clipping was added
after an older-row capture showed a rail below the viewport; that final
clipping change still needs a fresh capture.

The full gate passed before the final clipping change. Existing E2E startup
waits required the new rail symbol. A helper updated only those waits and
existing assertions; the E2E rerun is pending.

The command palette now renders below the composer. Its title has a fixed
row, separate from its filter. The live Skills menu first exposed overlapping
title and filter text; the fixed title row corrects this. Existing command
palette keyboard tests pass. A live Escape check preserves the draft.
Dark and light mode selection now keeps the FX palette.

The empty session shows `gent · Ctrl+P for commands`. The normal status row
shows the active model when available. Workspace identity appears in debug
mode only. Extension labels remain present.

Current validation: `/tmp/gent-fx-ui-menus-gate.log` passed the full gate.
`/tmp/gent-fx-ui-e2e-menu-fix.log` passed 61 end-to-end tests, including both
Skills popup checks. No appearance-only tests were added.

Open defect: explicit scrollbox clipping did not remove the user-message
rail below the viewport when scrolling into a long message. The 60×20 live
capture still shows the rail in two footer-gap rows. Do not treat clipping
or the final visual comparison as complete.

## Herdr comparison

Use Herdr as the primary visual check, per the user's request.
The current comparison panes are `wZ:p7` (Gent) and `wZ:p8` (FX).
Both have equal 61×17 outer pane geometry. The caller keeps focus.

Herdr reproduced the rail overflow. The native box border crossed the
scroll boundary while text remained clipped. User messages now render
their rail as text rows measured from the content height. The repeated
Herdr scroll check shows empty footer-gap rows and an intact composer.
The content row uses start alignment so resizing can reduce its height.

Evidence:

- `/tmp/gent-fx-ui-herdr-scroll.ansi`: older transcript rows with a clean footer boundary.
- `/tmp/gent-fx-ui-herdr-menu.ansi`: Gent command menu under the composer while viewing older transcript rows.
- `/tmp/gent-fx-ui-herdr-fx-menu.ansi`: FX command menu in the equal-size reference pane.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/message-list.tsx`: measured text rail and bold user text.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session.tsx`: transcript and footer allocation.

The command menu still differs from FX's category-tab header and denser
description columns. Final parity is not proved. The app also still uses
the OpenTUI alternate screen; FX uses terminal scrollback.

Category navigation now uses a header instead of a repeated row column.
Tab moves forward. Shift+Tab moves back. Each category change resets row
selection. Submenus reset the category filter. Herdr verified Session →
Appearance → Session with the correct filtered commands. The current
header keeps the selected category first so narrow panes cannot hide it.
The full gate passed: `/tmp/gent-fx-ui-categories-gate.log`.

Native scrollback is supported by the installed renderer. Do not report
alternate-screen use as an unavoidable platform limit. The next layout
change must account for stable transcript commits, streaming output,
session switching, draft preservation, and full-transcript inspection.

Source evidence:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/command-palette-state.ts`: category selection and reset rules.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/command-palette.tsx`: category header and keyboard handling.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/node_modules/.bun/@opentui+solid@0.5.10+8ea6d8f27251ca40/node_modules/@opentui/solid/index.bun.js`: `createScrollbackWriter` and `writeSolidToScrollback`.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/node_modules/.bun/@opentui+core@0.5.10+3fa45be7788bc228/node_modules/@opentui/core/renderer.d.ts`: split-footer mode, scrollback surfaces, and replay reset.

## Native history capability check

The temporary probe in Herdr `wZ:p7` confirms three renderer behaviors:

- A Solid snapshot can write styled content into native terminal history.
- A snapshot starts with a new Solid owner. The writer must restore the app owner, retain the snapshot renderer context, and dispose the snapshot root.
- A full-screen view can open without replacing the textarea. The draft survives repeated view changes.

The output mode must change to `passthrough` before the screen mode changes
to `alternate-screen`. On return, set `split-footer` first, then
`capture-stdout`. The renderer rejects the opposite order.

The mode change alone does not restore the visible records. The probe
calls `resetSplitFooterForReplay()` and replays its records. Herdr then
shows both records, including a draft submitted after two round trips.
This check does not prove preservation of off-screen saved lines, resize
behavior, streaming commits, or session changes. Do not clear saved lines
as an unexamined workaround.

Gent still uses its existing session scrollbox. Native history is not yet
integrated. The temporary probe must not remain in the final change.
The latest production gate predates this diagnostic script.

Evidence:

- `/tmp/gent-fx-ui-herdr-scrollback-probe.ansi`: two native records after repeated view changes.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/scripts/scrollback-probe.tsx`: temporary context, replay, and draft check.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/node_modules/.bun/@opentui+core@0.5.10+3fa45be7788bc228/node_modules/@opentui/core/chunk-bun-bb3k0yt8.js`: screen/output mode guards, replay reset, and screen transition implementation.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/main.tsx`: current renderer creation.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session.tsx`: current transcript and composer ownership.

## Native session integration

Gent now writes completed session items through its existing Solid message
renderers into native terminal history. Active output and the composer stay
in the live footer. The native-history component owns snapshot context and
cleanup. It compares committed item contents before appending more output.
The session feed remains the only message-state owner.

Terminal dimensions now describe the terminal, not the reduced footer.
Auth and other session overlays reserve the full terminal height. The first
gate exposed three auth-overlay failures. The full gate passed after this
allocation was fixed: `/tmp/gent-fx-ui-native-gate.log`.

Ctrl+O opens a full-height transcript view. The textarea stays mounted.
Herdr confirmed that a draft survives opening and closing this view.
However, closing the view currently leaves only the footer visible. The
previous output moves into saved terminal lines and does not return to the
visible area. This is an open layout defect, not completed FX parity.
Do not hide it by clearing saved terminal history.

Escape-to-return and page navigation were added after that live check.
Their gate is `/tmp/gent-fx-ui-native-controls-gate.log`. Final E2E and
resize checks remain pending. The temporary probe was removed after its
snapshot path moved into the session component.

Source evidence:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/native-transcript.tsx`: native commits, snapshot ownership, footer allocation, and transcript viewport.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/terminal-dimensions.tsx`: terminal geometry independent of the footer.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session.tsx`: live transcript integration and overlay allocation.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session-ui-state.ts`: transcript view state.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session-controller.ts`: transcript, return, and tool-detail keys.

## Visible-tail correction

The native-history component now keeps enough measured items mounted to
fill the visible transcript. It commits only complete items above that
tail. It no longer commits every item when a turn becomes idle.

Herdr confirmed visible output and draft preservation after Ctrl+O and
Escape. A second check opened a two-turn transcript, scrolled to the first
turn, and returned to the visible tail. The full gate passed:
`/tmp/gent-fx-ui-visible-tail-gate.log`.

This is not final native-history acceptance. Partial overflow within one
large item still uses the live scrollbox. Saved-line contents, resize,
session changes, and replay after an edited prefix need further checks.
The E2E run at `/tmp/gent-fx-ui-native-e2e.log` found a startup-output
assertion failure. Its cause remains under review.

Evidence:

- `/tmp/gent-fx-ui-herdr-history-return.ansi`: visible short transcript and preserved draft after Escape.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/native-transcript.tsx`: measured visible tail and complete-item commit boundary.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/core/app/app_lifecycle.zig`: exact, changed, and resized primary-transcript restoration policies.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/transcript/writer.zig`: transcript storage separate from frame-owned viewport scrolling.

The first native E2E run finished with one failure in the startup test.
That test used `pty.waitFor` before asserting against the separate retained
`ctx.output` buffer. It now waits through `waitForOutput` against the same
buffer as its unchanged assertion. The rerun is recorded at
`/tmp/gent-fx-ui-native-e2e-rerun.log`.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/e2e/tests/e2e.test.ts`: startup wait and retained-output assertion.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/e2e/src/pty-fixture.ts`: output subscription and separate PTY wait boundary.

## Resize and menu checks

The native E2E rerun passed all 61 tests across the two packages:
`/tmp/gent-fx-ui-native-e2e-rerun.log`.

Herdr checked the live session at 79-column and 43-column outer pane
widths, then restored both comparison panes to 61 columns. Text rewrapped
and the composer stayed visible. These checks used a 17-row outer pane.
They do not replace the pending larger-terminal checks.

The narrow command menu showed a scrollbar marker. Shared menu bodies
now hide vertical and horizontal scrollbar markers. Keyboard scrolling
remains enabled. The full gate passed after this change:
`/tmp/gent-fx-ui-menu-scrollbar-gate.log`.

Evidence:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/chrome-panel.tsx`: menu-body scrollbar visibility.
- `/tmp/gent-fx-ui-herdr-menu-clean.ansi`: current command menu without the scrollbar marker.

## Clear-display control

Ctrl+L now changes session display state instead of resetting the feed.
The feed no longer exposes a clear operation. The session and model APIs
are not called by this control. Full transcript inspection still reads
the unchanged feed.

Herdr checked this while idle: Ctrl+L hid the existing output and kept the
draft. Ctrl+O showed the prior output. Escape returned to the cleared view
with the same draft. Clearing during an active stream remains unverified.
The validation log is `/tmp/gent-fx-ui-clear-display-gate.log`.

Evidence:

- `/tmp/gent-fx-ui-herdr-clear-display.ansi`: cleared view with preserved draft after transcript inspection.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session-ui-state.ts`: non-negative display boundary and clear transition.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session-controller.ts`: Ctrl+L dispatch without a session or model command.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/native-transcript.tsx`: display boundary separate from full transcript items.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/hooks/use-session-feed.ts`: feed projection retained across display clear.

## Ctrl+C ownership

The renderer's automatic Ctrl+C exit is disabled at startup. Session input
now owns the key: close transcript inspection, clear a non-empty draft,
cancel an active stream, or exit when empty and idle. The app has a fallback
exit handler for routes that do not consume this key.

Herdr confirmed that Ctrl+C clears an idle draft while the Gent process
stays alive. A second press with an empty idle composer returned the pane
to its shell. Active-run cancellation and overlay-specific behavior still
need live checks. Validation logs:
`/tmp/gent-fx-ui-interrupt-gate.log` and
`/tmp/gent-fx-ui-interrupt-e2e.log`.

Source evidence:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/main.tsx`: disables renderer-owned automatic exit.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session-controller.ts`: draft, transcript, run, and idle interrupt policy.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/app.tsx`: unhandled-key exit fallback.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/tests/render-harness-boundary.tsx`: matching renderer configuration at the existing test boundary.

The Ctrl+C E2E run passed all 61 tests:
`/tmp/gent-fx-ui-interrupt-e2e.log`.

A live Herdr check used the existing mock-provider delay option. A
two-second delay finished before the cancellation check, so that attempt
did not prove active-run behavior. A ten-second delay gave a controlled
active run. The first Ctrl+C cleared a draft while the status still showed
processing. The next Ctrl+C produced an interruption notice and idle
status. Process inspection confirmed that Gent remained alive.

The delay was temporary. `main.tsx` again uses `Gent.provider.mock()` with
no delay override. No real provider call was used.

- `/tmp/gent-fx-ui-herdr-cancel-active.ansi`: interrupted run with a live idle composer.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/sdk/src/server.ts`: mock-provider delay option.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/test-utils/language-model.ts`: delayed debug stream.

## Active display-clear check

Display clear now has its own renderer effect. It is not postponed by the
active-run guard on history commits. The full gate passed:
`/tmp/gent-fx-ui-active-clear-gate.log`.

Herdr used the temporary ten-second debug delay to check a partial reply.
Ctrl+L removed the visible output while the status still showed processing.
The draft remained. However, later text from that same reply stayed hidden
in the inline view. Ctrl+O still exposed the complete response. The current
item-count display boundary is insufficient for clearing part of an active
message. This remains an open defect. Do not mark active clear complete.

The source delay override was restored after the process started.

- `/tmp/gent-fx-ui-herdr-clear-active.ansi`: cleared view with draft and active status.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/native-transcript.tsx`: independent display-clear effect and current item-count boundary.

## Content-aware display boundary

The item-count boundary was replaced with a capture of message content,
reasoning, image count, segments, and tool state. The inline projection
removes only content already shown at clear time. New messages and later
content remain eligible to render. Full transcript inspection uses the
original items. A repeated clear always creates a new boundary.

A direct projection check returned only `after.` from `before. after.`
without changing the original message. Herdr confirmed the same content
cut after transcript inspection. That check also exposed a zero-height
layout trap: a cleared viewport did not measure new content until opened
in full-height mode.

Measured content boxes now do not shrink. The inline viewport reserves
one measurement row when space exists. Herdr then confirmed that a new
prompt and its response render after clear, without opening Ctrl+O.
The same-message active continuation still needs a fresh check with this
last measurement change.

Validation: `/tmp/gent-fx-ui-clear-continuation-gate-rerun.log` passed before
the minimum-row change. Its first run failed in a GitReader test because
a temporary directory was absent. The current gate is
`/tmp/gent-fx-ui-clear-measurement-gate.log`.

Source evidence:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/transcript-display.ts`: immutable clear capture and post-clear content projection.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/native-transcript.tsx`: display revision, visible projection, and minimum measurement row.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session-ui-state.ts`: repeated clear revision instead of item count.

## Herdr active-clear follow-up

Herdr remains the primary visual check. Gent runs in `wZ:p7`. FX runs in
`wZ:p8`. No appearance-only test was added.

The active-clear defect remains open. A slow mock response confirmed that
the display projection contains new text after Ctrl+L. The measured live
content stays at one row. New text is not visible during the run.

Disabling viewport culling did not fix the defect. Preventing nested message
boxes from shrinking did not fix it. A minimum Markdown height did not fix
it. These trial changes were removed. Temporary layout logs and the mock
delay were also removed from the source.

Evidence:

- `/tmp/gent/logs/6707ae38-20260906172249-client.log`: projected text grows after clear while the measured height stays at one row.
- `/tmp/gent/logs/6707ae38-20260906172619-client.log`: frame-level render tree for the same defect.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/native-transcript.tsx`: viewport measurement and footer sizing.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/message-list.tsx`: assistant message layout.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/transcript-display.ts`: content projection after clear.

## Active-clear measurement repair

The later size trace located the defect. The new text reached both the
Markdown and code renderers. Their computed height was zero. The viewport
used hidden overflow, which constrained text measurement to the small
cleared viewport. The viewport now uses scroll overflow. Its parent still
clips the visible output.

The same Herdr sequence now shows `Two. Three.` during the active run after
Ctrl+L. Later chunks remain visible. Ctrl+O shows the full original response.
Escape returns to the post-clear text. A draft also survived transcript
inspection, menu use, and another clear.

The full gate passed. The E2E runs failed in PTY checks. Their output filter
is under inspection. Do not report the E2E gate as passed.

No appearance-only test was added. Temporary renderer logs and the mock
delay were removed from the source.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/native-transcript.tsx`: scroll-overflow measurement setting.
- `/tmp/gent/logs/6707ae38-20260906173330-client.log`: nonempty code text with zero computed height before the repair.
- `/tmp/gent-fx-ui-herdr-clear-scroll-measurement.ansi`: post-clear text in the live Herdr pane.
- `/tmp/gent-fx-ui-scroll-measurement-gate.log`: passed full gate.
- `/tmp/gent-fx-ui-scroll-measurement-e2e.log`: first failed E2E run.
- `/tmp/gent-fx-ui-scroll-measurement-e2e-rerun.log`: second failed E2E run, including long elapsed-time interruptions.

## PTY output filter repair

The startup failure was reproduced with raw PTY output. The raw output
contains the rail. The old ANSI filter removes the first frame because it
accepts BEL as the only end of an OSC command. An earlier command ends with
ST. The filter consumes visible text until a later BEL.

The fixture now uses `Bun.stripANSI`. The assertions did not change. Both
failed prompt checks pass in the focused run. No new test was added.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/e2e/src/pty-fixture.ts`: ANSI parser replacement.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/e2e/tests/e2e.test.ts`: unchanged prompt assertions.
- `/tmp/gent-fx-ui-pty-filter-diagnostic.log`: failing run with the rail present in raw output.
- `/tmp/gent-fx-ui-pty-filter-focused.log`: two passing prompt checks.

Final validation for these two repairs passed:

- `/tmp/gent-fx-ui-pty-filter-gate.log`: full gate, exit code 0.
- `/tmp/gent-fx-ui-pty-filter-e2e.log`: 61 E2E tests passed, exit code 0.

The broad FX comparison remains open. The next menu pass must move the
separator above the help row and align the description column. The current
Gent menu puts the lower rule below the help row. Its descriptions start
directly after each title. FX uses a separate description column.

- `/tmp/gent-fx-ui-menu-current.ansi`: current Gent menu.
- `/tmp/gent-fx-ui-herdr-fx-menu.ansi`: reference FX menu.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/command-palette.tsx`: menu rows and outer border.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/autocomplete-popup.tsx`: related completion menu layout.

## Picker layout pass

Command and completion menus now share a frame. The lower rule sits above
the help row. Titles and descriptions use separate columns. Each row keeps
a two-column gap. Long text uses an end ellipsis. Text clipping preserves
grapheme clusters and measures terminal columns through a platform adapter.

Herdr verified the command menu and slash completion menu in a 43-column
outer pane. The close key remains visible. Tab still changes the command
category. Equal 61-column outer panes show three command rows, like FX.
The original equal layout and caller focus were restored.

The resize sequence also exposed stale menu text above the live footer.
The header persists after the menu closes. This native-history defect is
open. Do not mark resize or final visual acceptance complete.

The full gate passed before the final import-order cleanup. The current
E2E run has an auth wait failure. A focused auth check is in progress.
No appearance-only tests were added.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/picker-frame.tsx`: shared menu frame and help row.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/picker-text.ts`: grapheme-safe end clipping.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/platform/text-width-adapter.ts`: runtime text-width adapter.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/command-palette.tsx`: aligned command rows and narrow help.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/autocomplete-popup.tsx`: aligned completion rows and narrow help.
- `/tmp/gent-fx-ui-picker-aligned.ansi`: equal-width menu frame comparison.
- `/tmp/gent-fx-ui-picker-narrow-final.ansi`: narrow command menu with end ellipses.
- `/tmp/gent-fx-ui-completion-narrow-final.ansi`: narrow completion menu.
- `/tmp/gent-fx-ui-picker-close-stale.ansi`: stale header after resize and close.
- `/tmp/gent-fx-ui-picker-adapter-gate.log`: passed gate before import-order cleanup.
- `/tmp/gent-fx-ui-picker-e2e.log`: current E2E run.

## Retained PTY waits

The auth wait also failed in the repeated E2E run. Its focused run passed.
The test waits for `API Keys`, then waits for `Claude Code`. Both strings
can arrive in one chunk. The old second wait subscribed only to future
output and could miss the text already received.

The fixture wait now polls retained, ANSI-stripped output. A helper changed
all 23 callers to pass the test context. Assertions and time limits remain
unchanged. The three focused checks passed. Full validation is in progress.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/e2e/src/pty-fixture.ts`: retained-output wait.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/e2e/tests/e2e.test.ts`: updated callers, including the two consecutive auth waits.
- `/tmp/gent-fx-ui-picker-auth-focused.log`: passing isolated auth check before the wait repair.
- `/tmp/gent-fx-ui-picker-e2e-rerun.log`: repeated future-output wait failure.
- `/tmp/gent-fx-ui-picker-retained-gate.log`: full gate for the final picker and wait changes.
- `/tmp/gent-fx-ui-picker-retained-e2e.log`: final E2E run.

A fresh Ctrl+L followed by menu open, narrow resize, wide resize, and close
did not reproduce the stale header. The defect depends on additional
primary-screen history or placement state. Keep it open. Do not clear
terminal history on every resize as a substitute for locating that state.

- `/tmp/gent-fx-ui-picker-resize-repro.ansi`: clean result when the sequence starts after Ctrl+L.

The final picker and retained-wait validation passed. The full gate exited
with code 0. All 61 E2E tests passed. The stale-history investigation and
the broader acceptance checklist remain open.

## Debug sample and plain tool headers

The debug sample did not appear in the TUI. The seed used the default
workspace, but the client used its workspace header. The owned server now
passes the same header to the seed. The sample session also lacked an
active branch. The seed now sets that branch after it creates it. Herdr
now shows the sample tool history at startup. No model calls are needed.

Tool headers no longer use rounded frames. Expanded output uses a small
indent. Completed tools use a neutral bullet. Error headers retain the
explicit failure label. Tool IDs occupy a separate, non-wrapping column.
This keeps IDs intact when a subtitle wraps in a narrow pane.

The existing six message-list checks pass without assertion changes.
The full gate passed. Herdr shows the expanded and compact tool states.
A 43-column outer pane keeps the tool ID intact. All 61 E2E checks passed.
No appearance-only tests were added.

The debug sample has old result shapes for session-search and session-read
tools. Their sample detail is incomplete. This is not evidence that their
production results fail. Native-history and full acceptance checks remain
open.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/sdk/src/server.ts`: debug seed workspace and failure logging.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/debug/session.ts`: active branch and sample tool results.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/tool-frame.tsx`: plain tool header and atomic ID column.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/tests/message-list-render.test.tsx`: unchanged tool identity and failure checks.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/transcript/tool_group_projection.zig`: plain group headers and indented detail.
- `/tmp/gent-fx-ui-tool-header-final.ansi`: expanded tool output in Herdr.
- `/tmp/gent-fx-ui-tool-header-compact-narrow.ansi`: intact tool ID at narrow width.
- `/tmp/gent-fx-ui-tool-header-gate.log`: passing full gate.
- `/tmp/gent-fx-ui-tool-header-e2e.log`: final E2E run.

## Separate inspection screen

Full-transcript view and session overlays now use the alternate screen.
Normal output still uses the split footer and native terminal history.
The transition stops stdout capture before it leaves split-footer mode.
It restores capture after it returns. OpenTUI requires this order.

Herdr confirmed a full-transcript round trip with a draft. The before and
after ANSI captures are identical. The normal terminal history returns
after Escape. A menu resize from 61 to 43 outer columns and back keeps the
draft. All 61 E2E checks and the full gate passed with this change.

The first menu entry after transcript inspection showed stale tool text
inside menu rows. A resize cleared it. Later entries were clean. This
visual defect remains open. The passing gate does not cover this terminal
buffer state. Do not treat the screen change as final history acceptance.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/native-transcript.tsx`: screen ownership and ordered capture transitions.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/core/app/app_lifecycle.zig`: separate full-transcript screen and primary restore policy.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/node_modules/.bun/@opentui+core@0.5.10+3fa45be7788bc228/node_modules/@opentui/core/chunk-bun-bb3k0yt8.js`: screen-mode capture constraint and mode transitions.
- `/tmp/gent-fx-ui-screen-before-fixed.ansi`: primary view with draft before inspection.
- `/tmp/gent-fx-ui-screen-after-fixed.ansi`: identical primary view after inspection.
- `/tmp/gent-fx-ui-menu-screen-return.ansi`: return from the resized menu.
- `/tmp/gent-fx-ui-screen-mode-fixed-gate.log`: passing full gate.
- `/tmp/gent-fx-ui-screen-mode-e2e.log`: passing E2E checks.

## Command menu screen ownership repair

The stale menu text repeated at startup in a 61-column outer pane. Opening
Ctrl+P was enough. Full-transcript inspection was not required. Waiting six
seconds did not prevent the fault. Clearing the next render buffer did not
prevent it either. Both probes were removed.

The command menu stores its open state in CommandProvider, not in the
session overlay state. NativeTranscript did not receive that state. The
menu therefore still enlarged the primary footer. The session now passes
both sources of overlay state to NativeTranscript.

The return check then exposed an ordering fault. A history write could run
before split-footer mode and capture were restored. NativeTranscript now
publishes an explicit native-output-ready state after both operations.
History writes and display resets wait for that state.

Fresh startup, menu entry, Escape, Ctrl+O, Escape, and menu re-entry now
produce a clean menu. Herdr also verified a 43-column outer pane, menu
return, and Ctrl+L from full-transcript view with a preserved draft. The
full gate and all 61 E2E checks passed. No appearance-only
tests were added. All temporary probes were removed.

The temporary empty pane used to restore the failing width was closed.
The user's wide Gent pane and caller focus were restored. This fixes the
reproduced menu-entry fault. It does not prove every native-history case.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session.tsx`: combines command menu and session overlay state.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/command/context.tsx`: command menu open state.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/native-transcript.tsx`: native-output readiness and write/reset guards.
- `/tmp/gent-fx-ui-menu-narrow-direct.ansi`: minimal failing menu entry.
- `/tmp/gent-fx-ui-menu-delayed.ansi`: failure after a six-second startup delay.
- `/tmp/gent-fx-ui-menu-clear-next-buffer.ansi`: failed buffer-clear probe.
- `/tmp/gent-fx-ui-menu-ready-roundtrip.ansi`: clean menu after inspection and return.
- `/tmp/gent-fx-ui-menu-ready-narrow.ansi`: clean narrow menu.
- `/tmp/gent-fx-ui-native-ready-clear-draft.ansi`: draft retained after display clear and menu return.
- `/tmp/gent-fx-ui-native-ready-gate.log`: passing full gate.
- `/tmp/gent-fx-ui-native-ready-e2e.log`: final E2E run.

## Long-item history investigation

The current writer keeps at least one viewport of whole messages live.
A large tool message can therefore remain outside native history even
after a short final reply arrives. Full-transcript view still shows it.

A trial moved leading messages while live content exceeded the viewport.
Herdr then showed the tool output in native history, but the initial live
reply was blank. A full-transcript round trip restored the reply. The
probe reported live height 2, scroll position 0, and viewport height 2.
This rules out an excessive scroll position as the cause of that blank.

The trial and probe were removed. The earlier menu fixes remain. The
full gate passed during the trial, but did not detect the missing visible
reply. Do not use that gate result as visual acceptance.

The next check must inspect snapshot rendering and footer transitions
together. The Solid snapshot writer is synchronous. Core also exposes a
scrollback surface with settle and row-commit operations. These APIs need
further evaluation before changing the history ownership policy.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/native-transcript.tsx`: retained whole-message policy.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/node_modules/.bun/@opentui+solid@0.5.10+8ea6d8f27251ca40/node_modules/@opentui/solid/index.bun.js`: synchronous snapshot measurement and write.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/node_modules/.bun/@opentui+core@0.5.10+3fa45be7788bc228/node_modules/@opentui/core/renderer.d.ts`: scrollback surface API.
- `/tmp/gent-fx-ui-native-overflow-history.ansi`: trial history and blank live tail.
- `/tmp/gent-fx-ui-overflow-probe.log`: measured live height and scroll position.
- `/tmp/gent-fx-ui-native-overflow-gate.log`: passing gate for the rejected visual trial.

## Live-tail height repair

The frame probe located the loss before the terminal write. The live reply
had height 2. The content area retained height 11 after the viewport shrank
to height 2. Its scroll range then placed the reply nine rows above the
viewport. Disabling culling did not fix it.

A local OpenTUI scrollbar patch also did not fix it. That patch was removed.
The package manifest and lock file have no change from this trial. A forced
frozen install restored the original package files. No dependency patch or
temporary probe remains.

NativeTranscript now sets the content minimum height to zero. This removes
the stale percentage minimum during footer shrink. The content area,
viewport, and live reply all measure two rows in the same reproduction.
The writer can now move complete leading messages into native history
until the remaining live messages fit. It retains the last message.

Herdr verified the final reply at 122-, 61-, and 43-column outer widths.
Menu and full-transcript return checks preserve it. The full gate and all
61 E2E checks passed. The temporary empty resize pane was
closed, and the wide Gent pane and caller focus were restored.

This fixes the blank live tail. Full snapshot content, a single oversized
last message, and the remaining acceptance checks still need verification.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/native-transcript.tsx`: content minimum height and leading-message commit threshold.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/node_modules/.bun/@opentui+core@0.5.10+3fa45be7788bc228/node_modules/@opentui/core/index.bun.js`: default content minimum and scroll range calculation.
- `/tmp/gent-fx-ui-history-range.log`: stale 11-row content area with a two-row viewport.
- `/tmp/gent-fx-ui-history-content-fit.log`: corrected two-row content area and visible reply.
- `/tmp/gent-fx-ui-history-fit-live.ansi`: clean live reply without probes.
- `/tmp/gent-fx-ui-history-fit-native.ansi`: captured native history.
- `/tmp/gent-fx-ui-history-fit-narrow.ansi`: clean reply after narrow resize.
- `/tmp/gent-fx-ui-restore-packages.log`: original dependency files restored.
- `/tmp/gent-fx-ui-history-fit-gate.log`: passing full gate.
- `/tmp/gent-fx-ui-history-fit-e2e.log`: final E2E run.

## Native snapshot reservation repair

Native history stopped inside the review result. Full-transcript view
showed the later session-search and session-read tools. Passing the live
measurement as an explicit snapshot height did not fix the loss.

A settled scrollback-surface trial also did not fix it. Its child bounds
included all tool output. The original synchronous writer then emitted
a complete 45-row snapshot. This located the loss after snapshot layout.
The async trial was removed.

The live footer still reserved the transcript rows that the snapshot was
moving into native history. The write now reserves only the composer.
It restores the prior footer size through Effect.ensuring. Restoration
flushes the queued snapshot before the larger live surface returns.

Herdr now shows the complete review result, session-search header, and
session-read output in native history. The live final reply stays visible.
Menu and full-transcript return checks pass. The full gate and all 61 E2E
checks passed. No probe, async writer, or dependency patch
remains.

The single oversized last message and a composer that fills the terminal
still need separate history checks. Do not mark all history behavior done.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/native-transcript.tsx`: scoped composer-only reservation around native writes.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/node_modules/.bun/@opentui+core@0.5.10+3fa45be7788bc228/node_modules/@opentui/core/chunk-bun-bb3k0yt8.js`: queued snapshot emission and footer transition flush.
- `/tmp/gent-fx-ui-snapshot-truncated.ansi`: truncated native history before the repair.
- `/tmp/gent-fx-ui-snapshot-full-view.ansi`: later tools visible in full-transcript view.
- `/tmp/gent-fx-ui-emitted-snapshot.log`: complete 45-row snapshot before native output.
- `/tmp/gent-fx-ui-commit-final-history.ansi`: complete native tool output after the repair.
- `/tmp/gent-fx-ui-commit-final-return.ansi`: history after menu and transcript return.
- `/tmp/gent-fx-ui-commit-reservation-final-gate.log`: passing full gate.
- `/tmp/gent-fx-ui-commit-reservation-final-e2e.log`: final E2E run.

## Multiline composer and picker budget

A ten-line edited draft exposed another height conflict. The editor kept
eight rows when the command menu opened. The combined footer exceeded the
terminal height. The menu help and status rows disappeared.

Composer now measures its picker container. It reserves that height before
it assigns the editor's maximum height. It also reserves the status,
spacing, and one transcript row. The same budget covers command menus and
extension completion menus. Closing a picker restores editor space.

Herdr verified the ten-line draft, menu open/close, and access to the first
and last draft lines. File completion also fits at a 43-column outer width.
The help and status rows remain visible. The full gate and all 61 E2E
checks passed. No appearance-only tests were added. The temporary empty
resize pane was removed. The wide layout and caller focus were restored.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/composer.tsx`: measured picker reservation and editor height bound.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/composer-frame.tsx`: status and spacing allocation.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/render_engine/footer_layout.zig`: combined input, picker, and hint row allocation.
- `/tmp/gent-fx-ui-multiline-menu-before.ansi`: hidden help and status rows before the fix.
- `/tmp/gent-fx-ui-multiline-menu-after.ansi`: complete menu beside a multiline draft.
- `/tmp/gent-fx-ui-multiline-draft-return.ansi`: first draft lines accessible after menu return.
- `/tmp/gent-fx-ui-multiline-completion.ansi`: file completion with the draft.
- `/tmp/gent-fx-ui-multiline-completion-narrow.ansi`: complete narrow picker and status row.
- `/tmp/gent-fx-ui-editor-budget-gate.log`: passing full gate.
- `/tmp/gent-fx-ui-editor-budget-e2e.log`: final E2E run.

## Pending input rows and active-turn checks

The live queue used a large rounded frame. It now uses plain rows with
FX's dotted pending-input rail. Gent's steer/queued labels, multiline
summary, and restore hint remain. The existing widget checks pass without
assertion changes.

Herdr verified active output, a queued message, Cmd+Up restoration, and
Ctrl+C cancellation. The queued message returns to the editor and leaves
the queue. Cancellation shows the interrupted notice and an idle composer.
The final dotted-rail capture used a process-local scripted-model delay.
No paid provider was called. The source delay probe was removed, and the
normal debug process was restored.

The full gate and all 61 E2E checks passed. Enter still queues regular
follow-up work in Gent. This pass did not change delivery semantics.
The broader FX interaction comparison remains open.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/queue-widget.tsx`: plain pending rows and dotted rail.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/tests/widgets-render.test.tsx`: unchanged steer, queued-summary, and restore-hint assertions.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/test-utils/language-model.ts`: scripted replies and delay control.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/footer/input_presentation.zig`: dotted pending-input rail.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/footer/paint_plan.zig`: bounded pending-input rows.
- `/tmp/gent-fx-ui-active-queue-before.ansi`: previous rounded queue frame.
- `/tmp/gent-fx-ui-queue-rail-final.ansi`: final pending rail in the active TUI.
- `/tmp/gent-fx-ui-queue-restored.ansi`: restored queued draft.
- `/tmp/gent-fx-ui-active-cancel.ansi`: cancellation result and idle composer.
- `/tmp/gent-fx-ui-queue-rail-gate.log`: passing full gate.
- `/tmp/gent-fx-ui-queue-rail-e2e.log`: 61 passing E2E checks.

## Question option flow and narrow help

A live `ask_user` call showed joined label and description text:
`Compact- Keep...`. Separate flex text nodes lost the visible gap at the
wrap boundary. Each option now uses one text flow with a muted description.
The new Herdr capture shows `Compact - Keep...` with complete wrapped text.

The help row now selects a width-fitting variant. Each variant keeps Enter
and Escape. The compact multi-select variant also keeps Space. This follows
FX's approval hint priority without changing Gent's answer protocol.

The check used the real TUI and `ask_user` extension with a process-local
scripted language model. Arrow-key selection and free-text submission both
returned control to the agent. No paid provider was called. The scripted
process was stopped. The normal debug process was restored in `wZ:p7`.
No appearance test was added. The full gate and all 61 E2E checks passed.

Long question documents, multi-select, and approval review screens still
need live checks. This result does not close the full interaction criterion.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/interaction-renderers/option-list.tsx`: option text flow and width-fitting help.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/interaction-renderers/ask-user.tsx`: question progression and answer resolution.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/interaction-tools/ask-user.ts`: actual tool and answer protocol.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/test-utils/language-model.ts`: process-local sequence model.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/footer/approval_ui.zig`: width-fitting approval hints retain confirm and cancel controls.
- `/tmp/gent-fx-ui-question-before.ansi`: joined option label and wrapped help.
- `/tmp/gent-fx-ui-question-after.ansi`: separated label and one-row help.
- `/tmp/gent-fx-ui-question-response.ansi`: agent continuation after free-text submission.
- `/tmp/gent-fx-ui-question-gate.log`: passing full gate.
- `/tmp/gent-fx-ui-question-e2e.log`: 61 passing E2E checks.

## Long confirmation and Markdown review text

The next Herdr check selected two options with Space and submitted both
with Enter. The following 32-line confirmation exposed a height defect:
review text pushed Yes, No, free text, and help below the terminal.

`OptionList` now measures its document and answer controls separately.
The document uses the remaining row budget. Short questions keep their
natural height. Long text scrolls without moving the answer controls.
Page Up and Page Down scroll the document. A visible hint explains this.
The outer budget reserves panel padding, composer status, and one transcript
row. Extension widgets and unusually long option labels need separate checks.

Herdr reached confirmation line 32 with both choices visible. Page Up moved
back to earlier lines. Escape cancelled the confirmation and returned to the
agent. A second run reached section 20 of a Markdown question. Enter submitted
the answer and returned to the agent. These runs used real interaction tools
and a process-local scripted model. The normal debug launch was restored.
No production model override or appearance test was added.

The full gate and all 61 E2E checks passed. The larger final FX comparison
remains open.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/interaction-renderers/option-list.tsx`: measured document viewport and fixed answer controls.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/composer-frame.tsx`: external spacing and status reservation.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/interaction-tools/prompt.ts`: real confirmation tool path.
- `/tmp/gent-fx-ui-multi-selected.ansi`: two selected options in the live pane.
- `/tmp/gent-fx-ui-long-confirm-before.ansi`: missing answer controls before the repair.
- `/tmp/gent-fx-ui-long-confirm-after.ansi`: bounded review text and visible controls.
- `/tmp/gent-fx-ui-long-confirm-bottom.ansi`: final confirmation line and visible controls.
- `/tmp/gent-fx-ui-long-confirm-cancelled.ansi`: agent continuation after cancellation.
- `/tmp/gent-fx-ui-markdown-question-top.ansi`: question and first Markdown section.
- `/tmp/gent-fx-ui-markdown-question-bottom.ansi`: final Markdown section and controls.
- `/tmp/gent-fx-ui-markdown-question-submitted.ansi`: agent continuation after submission.
- `/tmp/gent-fx-ui-long-confirm-gate.log`: passing full gate.
- `/tmp/gent-fx-ui-long-confirm-e2e.log`: 61 passing E2E checks.

## Fresh same-pane reference comparison

FX and Gent ran in `wZ:p7` without a layout change. Herdr reported a 46×24
outer pane within a 46×34 layout. This is a narrow-pane result, not the
requested 80×24 or 120×40 result. FX used host-managed auth. No prompt was
sent to a real provider. `/quit` stopped FX. Gent's normal debug run resumed.

FX showed its plain status and rail composer. Typing `/` opened its ruled
list with six visible results. Gent's Ctrl+P list used the same rule and
column structure, with seven visible entries, categories, and its retained
status row. Those content differences reflect Gent's command surface; this
capture alone does not establish complete interaction parity.

Gent preserved `draft preservation check` across Ctrl+O and Escape.
Selecting Light through the real menu emitted RGB 68/68/68 body text,
98/98/98 muted text, and 38/38/38 primary text. These match its FX theme.
The terminal background was not changed, so light-terminal contrast remains
unverified. Dark was restored. Repeated menu/theme/inspection transitions
left more blank rows above the live tail. Native-history spacing needs a
separate check before final acceptance.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/native-transcript.tsx`: screen ownership and snapshot replay.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/command-palette.tsx`: theme selection and Gent command list.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/theme/themes/fx.json`: expected light RGB values.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/builtins/commands.zig`: `/quit` exits the reference shell.
- `/tmp/fx-final-narrow-idle.ansi`: fresh FX idle surface.
- `/tmp/fx-final-narrow-menu.ansi`: fresh FX slash menu.
- `/tmp/gent-fx-ui-final-narrow-idle.ansi`: Gent idle surface in the same pane.
- `/tmp/gent-fx-ui-final-narrow-menu.ansi`: Gent command list.
- `/tmp/gent-fx-ui-final-narrow-inspection.ansi`: transcript inspection with a draft.
- `/tmp/gent-fx-ui-final-narrow-draft-return.ansi`: preserved draft after Escape.
- `/tmp/gent-fx-ui-final-narrow-light.ansi`: selected Light theme.
- `/tmp/gent-fx-ui-final-narrow-light-inspection.ansi`: Light transcript inspection.
- `/tmp/gent-fx-ui-final-narrow-dark-return.ansi`: restored Dark theme and remaining history-spacing question.

## Long options and repeated menu return

Three repeated Ctrl+P/Escape cycles kept the same transcript spacing.
The blank rows did not grow on that path. This narrows the spacing question
to other transitions; it does not prove all history replay paths correct.

Four long answer labels with descriptions exposed another overflow. The
last option and help left the terminal. The option list now has a bounded
scroll area. Arrow navigation scrolls the focused option into view. It uses
OpenTUI's child visibility operation instead of copied row calculations.
The document and answer footer still reserve their own space.

Herdr showed the complete fourth choice after three Down keys. Down reached
Other. The next Down returned to the first choice and scrolled it into view.
Enter submitted the answer and the agent resumed. The fixture used five
wrapped rows per option. A single option taller than the viewport still
depends on scrolling inside that area and needs a separate keyboard check.

The full gate and all 61 E2E checks passed. The normal debug process was
restored. No appearance test or production model override was added.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/interaction-renderers/option-list.tsx`: bounded options and focus-driven scrolling.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/node_modules/.bun/@opentui+core@0.5.10+3fa45be7788bc228/node_modules/@opentui/core/index.bun.js`: `scrollChildIntoView` implementation.
- `/tmp/gent-fx-ui-long-options-before.ansi`: cut-off last option and hidden help.
- `/tmp/gent-fx-ui-long-options-after.ansi`: bounded choices and visible help.
- `/tmp/gent-fx-ui-long-options-last.ansi`: complete focused fourth option.
- `/tmp/gent-fx-ui-long-options-wrap.ansi`: focus wraps to the first option.
- `/tmp/gent-fx-ui-long-options-submitted.ansi`: agent continuation after submission.
- `/tmp/gent-fx-ui-long-options-gate.log`: passing full gate.
- `/tmp/gent-fx-ui-long-options-e2e.log`: 61 passing E2E checks.

## Exact-size Herdr checks and picker row limit

Herdr supports direct terminal control with explicit dimensions:
`herdr terminal session control wZ:p7 --cols 80 --rows 24`.
The control stream reported an 80×24 terminal frame. Repeating with
`--cols 120 --rows 40` reported 120×40. This changes only the controlled
terminal while attached. Stopping the control stream restored the original
44×22 content viewport and the unchanged pane layout.

The checks covered seeded transcript inspection, command navigation,
multiline drafts, and new empty sessions at both sizes. FX also ran at
120×40 in the same controlled terminal. Its picker stayed at six results.
Gent showed sixteen. FX's `default_max_picker_rows` is six.

Gent now shares one six-result height budget between command and completion
lists. A smaller terminal can show fewer rows. Keyboard navigation scrolls
to later entries. The palette no longer duplicates its dedicated New Session
and Sessions actions from the slash-command registry. Registered command
descriptions now reach the palette instead of being dropped.

Creating an empty session first exposed an inherited cursor-origin defect.
The empty composer appeared at the terminal bottom. The transcript now resets
its display origin on mount without clearing saved terminal lines. The live
repeat places the empty composer at the top. Initial validation then exposed
an incomplete test-renderer lifecycle. The shared test boundary now creates
OpenTUI's in-memory renderer, sets up its terminal, and mounts Solid. It runs
the actual reset instead of mocking or skipping it. Existing assertions stay.

The final full gate and all 61 E2E checks passed. These results supersede the
intermediate failed lifecycle runs. No appearance-only test was added.

Resize acceptance is still open. Returning from 80×24 to 44×22 preserved both
draft lines but left stale composer/status rows below the active surface.
Waiting did not clear them. Opening and closing the command menu cleared the
duplicate rows. This is a real remaining defect, not a failed draft restore.
All terminal control streams ended. The original layout and debug session
were restored.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/picker-frame.tsx`: shared six-result height budget.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/command-palette.tsx`: unique session actions and preserved descriptions.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/autocomplete-popup.tsx`: matching completion height and filter row.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/native-transcript.tsx`: fresh transcript display origin.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/tests/render-harness-boundary.tsx`: in-memory terminal setup before mounting.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/core/shared/list_window.zig`: six-row default.
- `/tmp/gent-fx-ui-80x24-control.jsonl`: authoritative terminal frame dimensions.
- `/tmp/gent-fx-ui-80x24-inspection.ansi`: seeded transcript at 80×24.
- `/tmp/gent-fx-ui-80x24-menu-draft.ansi`: multiline draft before the six-row change.
- `/tmp/gent-fx-ui-80x24-menu-six.ansi`: final six-row menu at 80×24.
- `/tmp/gent-fx-ui-80x24-empty-final.ansi`: corrected empty-session origin.
- `/tmp/gent-fx-ui-120x40-inspection.ansi`: seeded transcript and two-line draft at 120×40.
- `/tmp/gent-fx-ui-120x40-empty.ansi`: original empty-session origin defect.
- `/tmp/gent-fx-ui-120x40-empty-final.ansi`: corrected empty-session origin.
- `/tmp/gent-fx-ui-120x40-menu-six.ansi`: final six-row command menu.
- `/tmp/gent-fx-ui-120x40-completion-six.ansi`: final six-row completion list.
- `/tmp/gent-fx-ui-120x40-completion-scrolled.ansi`: later completion entries remain reachable.
- `/tmp/fx-120x40-idle.ansi`: exact-size FX reference.
- `/tmp/fx-120x40-menu.ansi`: six-row FX picker at 120×40.
- `/tmp/gent-fx-ui-sized-draft-narrow-return.ansi`: remaining stale rows after resize.
- `/tmp/gent-fx-ui-sized-draft-repaint.ansi`: menu repaint clears stale rows and preserves the draft.
- `/tmp/gent-fx-ui-picker-final-gate.log`: passing final full gate.
- `/tmp/gent-fx-ui-picker-final-e2e.log`: 61 passing E2E checks.

## Resize cleanup at the actual footer origin

The repeatable Herdr diagnostic failed before the repair. A new session with
two draft lines resized from 80×24 to 44×22. The capture contained two copies
of `Second line.` and two ready-status rows. Waiting did not remove them.

OpenTUI's `processResize` estimated the old footer from the terminal bottom.
Gent's short transcript placed that footer near the top. The resulting clear
range started below stale rows. The dependency patch uses the earlier of the
actual footer origin and the existing estimate. Both Bun and Node bundles
receive the same one-line correction. The patch does not clear saved lines.

The same diagnostic then found exactly one draft line and one status row.
It also passed with the seeded transcript and with a 120×40-to-44×22 resize.
Full transcript inspection still showed the seeded tool history. The original
pane layout was restored. The temporary draft was cleared.

The full gate and all 61 E2E checks passed. This fixes the stale-row defect recorded above.
It does not establish all native-history replay behavior. The dependency
change is local; no upstream issue, PR, or release was created.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/patches/@opentui%2Fcore@0.5.10.patch`: matching Bun/Node renderer correction.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/patches/README.md`: reason and removal condition.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/package.json`: dependency patch registration.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/bun.lock`: locked patch registration.
- `/tmp/gent-fx-resize-check.ts`: temporary Herdr diagnostic with duplicate-row assertions.
- `/tmp/gent-fx-ui-sized-draft-narrow-return.ansi`: failing resize before the correction.
- `/tmp/gent-fx-ui-resize-origin-seeded.ansi`: seeded transcript resize without duplicate rows.
- `/tmp/gent-fx-ui-resize-origin-wide.ansi`: 120×40-to-narrow resize without duplicate rows.
- `/tmp/gent-fx-ui-resize-origin-inspection.ansi`: retained tool history in transcript inspection.
- `/tmp/gent-fx-ui-resize-origin-gate.log`: passing full gate.
- `/tmp/gent-fx-ui-resize-origin-e2e.log`: 61 passing E2E checks.

## Drafts across session navigation

The editor previously lost an unsent draft after a session round trip.
The app now owns an in-memory draft map, keyed by branch ID. Route cleanup
saves the draft and its editing mode. Empty editing drafts remove their entry.
This does not store drafts on disk or restore them after a process restart.

The Herdr check restored both lines of a typed draft after opening a new
session and returning. The new session had an empty editor. A separate check
restored all four lines of a large paste. Cleanup expands paste markers before
the local paste store is cleared. Submission showed all four original lines,
not a stale marker. The debug model then returned its simulated rate-limit
error; this was not a paid provider call.

The full gate and all 61 E2E checks passed. Branch switching and shell-mode
restoration still need direct checks. The tree command blocked the branch
check: “Browse Branch Tree” opens a session tree, text shows through its panel,
and the live view stopped responding to keys. The captured screen records
the symptom, not its cause. Only the isolated debug process was restarted.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/composer-drafts.tsx`: app-owned draft map.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/main.tsx`: provider lifetime.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session-controller.ts`: route restoration and captured branch key.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/use-composer-controller.ts`: paste expansion before cleanup.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session-command-registry.ts`: tree command label and handler.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/session-tree.tsx`: session tree view and key handlers.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/chrome-panel.tsx`: panel background.
- `/tmp/gent-fx-ui-navigation-draft-before.ansi`: lost typed draft before the change.
- `/tmp/gent-fx-ui-navigation-draft-after.ansi`: restored typed draft.
- `/tmp/gent-fx-ui-navigation-paste-before.ansi`: four-line paste marker.
- `/tmp/gent-fx-ui-navigation-paste-after.ansi`: restored expanded paste.
- `/tmp/gent-fx-ui-navigation-paste-submitted.ansi`: submitted original text.
- `/tmp/gent-fx-ui-session-tree-stalled.ansi`: tree view with text showing through.
- `/tmp/gent-fx-ui-navigation-draft-gate.log`: passing full gate.
- `/tmp/gent-fx-ui-navigation-draft-e2e.log`: 61 passing E2E checks.

## Session tree input and panel repair

The repeated live check left the tree visible after Escape. The client log
reported `RangeError: Maximum call stack size exceeded` during Solid updates.
A focused keyboard check reproduced the same overflow without a full session.

The tree's open-state effect read the state and filtered items that it reset.
The effect now depends only on the open flag, source tree, and current session.
Search text and selection no longer trigger that reset. The keyboard check
selects a child and closes the tree. It failed before the change and passes now.

The panel now uses the theme's menu background. Its interior no longer shows
editor or transcript text. The command label now says “Browse Session Tree.”
The command still opens the same session hierarchy; this is not a branch picker.
Herdr verified that query text stays visible and Escape returns to the editor.
The full gate passed. These checks do not prove final FX menu parity.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/session-tree.tsx`: bounded effect dependencies.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/chrome-panel.tsx`: menu background.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session-command-registry.ts`: corrected command label.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/tests/components/session-tree.test.tsx`: child selection and Escape behavior.
- `/tmp/gent/logs/6707ae38-20260906202644-client.log`: live stack overflow.
- `/tmp/gent-fx-ui-tree-red.log`: failing keyboard check before the repair.
- `/tmp/gent-fx-ui-tree-green.log`: passing keyboard check after the repair.
- `/tmp/gent-fx-ui-session-tree-fixed.ansi`: clear panel interior.
- `/tmp/gent-fx-ui-session-tree-closed.ansi`: editor restored after Escape.
- `/tmp/gent-fx-ui-tree-gate.log`: passing full gate.
- `/tmp/gent-fx-ui-tree-e2e.log`: all 61 E2E checks passed after the repair.

## Oversized message history: failed whole-message trial

A process-local sequence model returned 60 numbered paragraphs. No provider
request was sent. The current renderer kept the last message live. Herdr's
retained output contained paragraph 60 but not paragraph 1.

A trial allowed the final oversized message to enter native history. All 60
paragraphs then appeared exactly once. Opening and closing the command menu
lost paragraphs 53 through 60. Those rows were still on screen, not in saved
terminal history. Rendering the full transcript in the overlay and keeping
its height separate did not fix the return: the same eight paragraphs were
missing. This rules out full-message commit as a sufficient repair.

All trial source changes were removed. The normal debug process was restored.
The original oversized-last-message gap remains open. The next repair needs
to track committed visual rows and retain a live tail, rather than count only
whole messages. FX's committed anchor tracks visual and history offsets
separately. OpenTUI's snapshot API exposes a root and height but no row-offset
field; a clipped snapshot and live projection need investigation.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/native-transcript.tsx`: current whole-message commit boundary.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/transcript/runtime.zig`: `CommittedTranscriptAnchor` visual and history offsets.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/node_modules/@opentui/core/renderer.d.ts`: scrollback snapshot contract.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/node_modules/@opentui/solid/index.bun.js`: Solid snapshot writer.
- `/tmp/gent-fx-ui-long-message-before.txt`: missing first paragraph in retained output.
- `/tmp/gent-fx-ui-long-message-after.txt`: all 60 paragraphs once in the trial.
- `/tmp/gent-fx-ui-long-message-menu-return.txt`: missing final eight paragraphs after menu return.
- `/tmp/gent-fx-ui-long-message-menu.ansi`: transcript visible above the trial menu.
- `/tmp/gent-fx-ui-long-message-preserved.txt`: failed return check after separating overlay height.

The trial gate and E2E logs do not prove this requirement. The live return
check failed despite passing automated checks.

## Row-level native history progress

The renderer now commits only the rows that exceed the available transcript
height. A clipped snapshot writes those rows. The live view clips the same
prefix from its first item. Whole-item fingerprints still track fully saved
items; a row offset tracks the partially saved item.

The first row-split check preserved all 60 paragraphs across a menu return.
Transcript inspection then exposed a repaint problem. The return now resets
the visible split-footer surface without clearing saved terminal lines.
Overlay and inspection measurements no longer update the native tail height.

A repeated-menu check found a further ordering issue. Commits ran while the
closing menu still contributed to the measured footer height. Native commits
now wait for the first rendered frame after the return. The combined Herdr
check then found every paragraph exactly once after inspection and two menu
round trips. Counts start at the current prompt; older test sessions remain
in the terminal's saved lines and must not enter that count.

This is not full acceptance. Width changes, later messages, partial-item
revisions, and compact tool views still need checks with the row offset.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/native-transcript.tsx`: clipped snapshots, live row offset, and frame boundary.
- `/tmp/gent-fx-ui-row-tail-initial.txt`: first row-split output.
- `/tmp/gent-fx-ui-row-tail-return.txt`: first passing menu return, counted after the latest prompt.
- `/tmp/gent-fx-ui-row-tail-inspection-return.txt`: failed inspection return before repaint repair.
- `/tmp/gent-fx-ui-row-tail-repaint.txt`: passing inspection return.
- `/tmp/gent-fx-ui-row-tail-menu-final.txt`: failed repeated-menu check before the frame boundary.
- `/tmp/gent-fx-ui-row-tail-frame-return.txt`: all 60 paragraphs exactly once after the combined check.
- `/tmp/gent-fx-ui-row-frame-gate.log`: passing full gate after the frame boundary change.
- `/tmp/gent-fx-ui-row-frame-e2e.log`: all 61 E2E checks passed.

The normal isolated debug preview was restored after these checks.

## Later reply and reflow checks

A second sequence reply followed the 60-paragraph message. Each original
paragraph remained present exactly once, and the second reply was visible.
Widening to 80×24 preserved this short-line sample. Returning to the narrow
pane duplicated paragraphs 54 through 58. The control stream was closed and
the original pane size was restored.

A separate sample used 30 long paragraphs that wrap at the narrow width.
The final marker was present before resize. Widening to 80×24 removed that
marker from retained output and left an empty live transcript. Returning to
the narrow size did not restore it. Inspection then showed the prompt but
not the response in the visible capture. The current numeric row offset
cannot serve as a stable content position across reflow.

FX's terminal reset emits both display-clear and saved-lines-clear sequences.
Gent's current reset preserves saved lines. A full clear-and-rebuild policy
would also remove earlier shell output in the pane. The user was asked whether
that is acceptable; no such clearing behavior was added in this check.
Both resize defects remain open. The stable-width checks do not prove reflow.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/native-transcript.tsx`: row offset and current resize behavior.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/render_engine/terminal_diff.zig`: reset clear sequences and reset tests.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/transcript/runtime.zig`: separate resize-reset commit tracking.
- `/tmp/gent-fx-ui-row-two-turns.txt`: first message and second reply intact.
- `/tmp/gent-fx-ui-row-two-turns-wide.txt`: intact short-line sample at 80×24.
- `/tmp/gent-fx-ui-row-two-turns-narrow.txt`: duplicate paragraphs after narrowing.
- `/tmp/gent-fx-ui-reflow-before.txt`: complete wrapped sample before resize.
- `/tmp/gent-fx-ui-reflow-wide.txt`: missing final marker after widening.
- `/tmp/gent-fx-ui-reflow-return.txt`: empty live tail after returning narrow.
- `/tmp/gent-fx-ui-reflow-inspection.ansi`: incomplete visible inspection after reflow.

## Current debug tool result shapes

The search-session sample now includes its query, match count, activity time,
and excerpts. Those fields match the current tool result schema. The read-session
sample now repeats the extraction goal returned by that tool. Herdr shows the
search match and excerpt, and the extraction summary no longer says `?`.

The delegate sample's `output` field remains valid in the current schema.
It was not changed. Earlier notes that call it an obsolete result shape were
not supported by the schema check. Its generic presentation is a separate
renderer question, not a failed result decode.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/debug/session.ts`: corrected samples.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/session-tools/search-sessions.ts`: search result schema.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/session-tools/read-session.ts`: extraction result schema.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/delegate/delegate-tool.ts`: valid delegate output field.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/tool-renderers/search-sessions.tsx`: result decode and match presentation.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/tool-renderers/read-session.tsx`: extraction summary.
- `/tmp/gent-fx-ui-debug-results-visible.ansi`: corrected visible results.
- `/tmp/gent-fx-ui-debug-results-history.txt`: retained output; latest seed supersedes older debug output.
- `/tmp/gent-fx-ui-debug-results-gate.log`: passing full gate.
- `/tmp/gent-fx-ui-debug-results-e2e.log`: all 61 E2E checks passed.

## Keyboard access to oversized choices

A real `ask_user` request contained one choice with 24 detail lines. Page Down
previously scrolled only the question area. The final choice detail remained
unreachable through those keys. Page Up and Page Down now scroll the choices
when that area overflows. Shift plus either key scrolls the question. When
only the question overflows, unmodified page keys still scroll it.

Herdr reached detail 24, returned to the choice label with Page Up, and submitted
with Enter. A second request contained both a long question document and a long
choice. Both final lines were reachable independently. Enter and Escape hints
stayed visible. Escape cancelled that request. At the narrow size, the question
viewport can shrink to one row when both areas are long; the keyboard checks
prove access, not an ideal reading height.

The full gate and all 61 E2E checks passed. No appearance-only test was added.
The normal isolated debug preview was restored.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/interaction-renderers/option-list.tsx`: page-key routing and help text.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/interaction-tools/ask-user.ts`: real interaction request schema and response path.
- `/tmp/gent-fx-ui-long-choice-before.txt`: failed final-detail check before the change.
- `/tmp/gent-fx-ui-long-choice-after.txt`: final choice detail visible through Page Down.
- `/tmp/gent-fx-ui-long-choice-submitted.ansi`: model continued after submission.
- `/tmp/gent-fx-ui-long-regions-choice.txt`: choice scrolling with a long question document.
- `/tmp/gent-fx-ui-long-regions-question.txt`: final lines of both areas and visible primary controls.
- `/tmp/gent-fx-ui-choice-scroll-gate.log`: passing full gate.
- `/tmp/gent-fx-ui-choice-scroll-e2e.log`: all 61 E2E checks passed.

## Live FX tool reference

The pinned FX binary ran in Herdr against a local provider that used the
protocol from FX's own test helpers. The provider requested one read of a
temporary TypeScript file, then held a text stream until released. No upstream
model request was made. Host-managed authentication disabled local provider
credential access. HOME was not changed.

The normal FX transcript showed `1 tool call · 1 read` and one connected read
summary. It did not show the file body. The active turn showed a generating
line. The completed turn showed the answer and a small time/token summary.
Ctrl+O showed the read arguments and numbered file contents. This corrects
the earlier interpretation of “expanded by default”: FX expands the group
into call summaries, not full result bodies in the normal transcript.

Gent currently passes one expansion flag to individual renderers. Its default
therefore exposes more result content than this FX reference. The next tool
presentation change must separate group expansion from full detail. It must
preserve extension renderers and access to their complete output.

The Herdr viewport had a nonzero scroll offset during this run. Captures use
the latest 22 terminal rows, not the scrolled `visible` source. Future checks
must inspect pane scroll state before interpreting a visible capture. FX and
the local provider were stopped. Gent's normal debug preview was restored.

- `/Users/cvr/.cache/repo/vercel-labs/fx/tests/e2e/tmux-helpers.ts`: local provider protocol and tool/text events.
- `/Users/cvr/.cache/repo/vercel-labs/fx/tests/e2e/tui-gateway-stream-lifecycle.test.ts`: provider URL setup and streamed-tool workflow.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/transcript/tool_group_projection.zig`: group header and per-call summary projection.
- `/Users/cvr/.cache/repo/vercel-labs/fx/README.md`: host-managed authentication and full-transcript controls.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/message-list.tsx`: current per-renderer expansion path.
- `/tmp/gent-fx-reference.U4lKJ1/provider.ts`: local-only provider used for the comparison.
- `/tmp/gent-fx-reference.U4lKJ1/sample.ts`: read-only sample input.
- `/tmp/fx-live-tool-active.ansi`: FX group summary and active turn.
- `/tmp/fx-live-tool-complete.ansi`: FX completed tool and answer.
- `/tmp/fx-live-tool-inspection.ansi`: FX full tool detail.

## Separate tool groups from full detail

Normal view now groups adjacent calls. It shows a call count and connected
input summaries. Text, reasoning, and images keep their original order and
separate groups. Snapshot messages use the same group component. Ctrl+Shift+O
collapses the summaries. Ctrl+O opens the existing full extension renderers.
Failed calls retain their error renderers and call IDs even when groups are
collapsed. Existing failure-identity tests caught and verified this repair.
No appearance-only tests were added.

Herdr at 22 rows showed the seven-call debug group, its summaries, full
inspection output, and the collapsed header. Escape restored normal view.
Raw JSON summaries found in the first capture were removed from compact
labels. This is not proof of full FX parity. Width reflow and native history
still need repair. Extension-specific summary quality needs a further pass.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/message-list.tsx`: adjacent grouping, summaries, and failure visibility.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session.tsx`: separate group and full-detail controls.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/tests/message-list-render.test.tsx`: existing unknown and registered tool failure identity checks.
- `/tmp/gent-fx-ui-tool-groups-normal.ansi`: normal grouped output.
- `/tmp/gent-fx-ui-tool-groups-inspection.ansi`: full extension result output.
- `/tmp/gent-fx-ui-tool-groups-collapsed.ansi`: collapsed group header.

Final checks passed with exit code 0:

- `/tmp/gent-fx-ui-tool-groups-gate.log`: full gate.
- `/tmp/gent-fx-ui-tool-groups-e2e.log`: TUI and server-process E2E.

The normal debug preview was restarted with the final source. Its Herdr
scroll offset was zero. The final normal capture includes URL and delegate
task labels. Batched delegate input still uses the tool name alone.

## Restore full inspection after width reflow

The thirty-paragraph case was repeated with current Herdr rows. Paragraph 30
was present at narrow width. It disappeared after widening to 80 columns.
Full inspection also hid it after the pane returned to narrow width. Page
Down did not restore it. This confirms that the earlier inspection failure
was not only a scrolled Herdr viewport.

The partial-item wrapper had a numeric height of zero. Full inspection reset
that property with `undefined`. OpenTUI rejects `undefined` in its height
setter and therefore retained zero. Gent now sets `"auto"` explicitly when
the item has no clipped prefix. The same resize and inspection sequence now
shows paragraph 30. The check `rg -q 'End marker 30'` changed from exit 1 to
exit 0 on the captured current rows. No appearance-only test was added.

Normal-view width reflow remains broken. Its committed row offset still
refers to the old layout. This fix restores full inspection; it does not
claim to repair that separate offset or native-history duplication problem.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/native-transcript.tsx`: explicit automatic item height in full inspection.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/node_modules/@opentui/core/chunk-bun-bb3k0yt8.js`: height setter rejects invalid dimensions.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/node_modules/@opentui/core/Renderable.d.ts`: supported height values.
- `/tmp/gent-fx-ui-reflow-current-narrow.txt`: paragraph 30 before resize.
- `/tmp/gent-fx-ui-reflow-current-wide.txt`: missing normal-view tail after resize.
- `/tmp/gent-fx-ui-reflow-current-inspection.txt`: missing inspection tail before repair.
- `/tmp/gent-fx-ui-inspection-height-green.txt`: paragraph 30 after repair.
- `/tmp/gent-fx-ui-inspection-height-gate.log`: full gate passed with exit 0.
- `/tmp/gent-fx-ui-inspection-height-e2e.log`: TUI and server E2E passed with exit 0.

## Status source check and shell draft navigation

The workspace label is already limited to debug mode. The visible debug
preview must not be treated as the normal status default. FX also hides
workspace and Git labels by default. Gent's shipped bottom-right extension
adds artifact counts, not workspace identity. No status change was needed.

A shell draft (`echo FX_SHELL_DRAFT_ONLY`) survived New Session and a return
through the Sessions picker. The new session was empty. The original draft
returned with its `$` shell-mode marker. The command was never submitted.
The draft was then cleared before restarting the preview.

The Sessions picker exposed a separate layout problem. It cut titles to a
small label column although none of its rows had descriptions. The palette
now reserves a detail column only when its filtered rows have descriptions
or shortcuts. Rows without that column use the available title width.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session.tsx`: debug-only workspace label.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/utils/session-labels.ts`: model context and debug labels.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/extensions/builtins/artifacts.client.ts`: shipped bottom-right artifact count.
- `/Users/cvr/.cache/repo/vercel-labs/fx/README.md`: workspace status default.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/command-palette.tsx`: session navigation and conditional detail column.
- `/tmp/gent-fx-ui-shell-draft-return.txt`: restored draft and shell marker.

The final Herdr capture shows complete session names at the same narrow
width. Returning to Commands preserves the aligned description column.
The full gate and E2E both passed with exit 0. No appearance-only tests were
added. A further query-row issue remains: nested search repeats the `›`
separator because both the breadcrumb and typed-query prefix supply it.

- `/tmp/gent-fx-ui-session-picker-width.ansi`: full session titles without an empty detail column.
- `/tmp/gent-fx-ui-command-picker-details.ansi`: command description alignment remains.
- `/tmp/gent-fx-ui-picker-width-gate.log`: full gate.
- `/tmp/gent-fx-ui-picker-width-e2e.log`: TUI and server E2E.

## Bounded picker query row

A long query wrapped into a second row and pushed `No matches` onto the
lower menu rule in Herdr. The query now has one fixed row. Its display keeps
the trailing graphemes and cursor visible. Filtering still uses the complete
query. The nested breadcrumb supplies one separator, not two. Escape still
clears the query before it goes back to the parent menu.

The same long-query capture now shows the `END` suffix, cursor, empty-result
row, lower rule, and keyboard hints on separate rows. A nested `debug` query
shows `Commands › debug` with one separator. FX's auth picker also uses a
width-bounded query suffix; this is source evidence for the shared display
choice, not a claim that every FX picker has identical internals.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/command-palette.tsx`: bounded query prefix and row.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/picker-text.ts`: grapheme-safe query suffix.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/footer/picker_presentation.zig`: `teamQueryProjection` uses `suffixByWidth`.
- `/tmp/gent-fx-ui-query-before.ansi`: wrapped query collides with the lower rule.
- `/tmp/gent-fx-ui-query-after.ansi`: complete controls and one query row.
- `/tmp/gent-fx-ui-query-nested.ansi`: one nested separator.
- `/tmp/gent-fx-ui-query-row-gate.log`: full gate passed with exit 0.
- `/tmp/gent-fx-ui-query-row-e2e.log`: TUI and server E2E passed with exit 0.

## Resize ownership and source-position probe

An OpenTUI text probe at 24 and 40 columns confirmed that `lineStartCols`
provides source display-column offsets, not only viewport rows. The first
source line changed from starts `[0, 23]` to `[0, 37]`. The second source line
still began at offset 48. Its `lineSources` index stayed 1. These positions
can locate a live-text boundary after wrapping. They do not remove rows that
the terminal has already moved into saved history.

Further FX source inspection resolves the earlier uncertainty about its
reset path. After a settled resize, `applyResizeWithLayoutResolved` calls
`requestTerminalResetAfterResize` when width reflow is pending or size has
changed. That calls `requestTerminalReset` and sets `terminal_reset_pending`.
`FrameReset.fromPlan` selects the reset. `appendFrameReset` emits `CSI 3 J`
along with the visible-screen reset. Thus this FX path clears saved terminal
lines. This is stronger evidence than merely finding a reset helper.

Gent has not enabled saved-line clearing. Adopting this FX reset policy would
also clear shell output from before Gent started. That choice needs user
direction. A previous asynchronous question has no recorded answer. No
source-position approximation or destructive reset was added in this pass.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/node_modules/@opentui/core/types.d.ts`: source line and display-column metadata.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/node_modules/@opentui/core/renderables/TextBufferRenderable.d.ts`: public `lineInfo` and text access.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/resize_runtime.zig`: settled resize requests a terminal reset.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/transcript/runtime.zig`: resize reset sets the terminal reset flag.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/render_engine/terminal_diff.zig`: the reset clears saved lines.

## Bounded todo preview and usable task dialog

A local sequence model called the real `todo_create` tool twelve times.
The task inputs had long subjects but no executable agent prompts. No agent
was started. In the initial Herdr capture, the todo preview filled the
transcript area. The task dialog was empty and exceeded the pane width.

The preview now uses a neutral summary and bounded one-line subjects. It
shows an overflow count and the existing Ctrl+Shift+T details shortcut. The
full reply and composer remain visible at 22 rows. Stopped tasks also appear
in the summary count.

The dialog's list/detail conditions were reversed. The list now appears
first. Enter opens the selected subject and status. The panel fits the
terminal dimensions. Arrow navigation scrolls the selected task into view.
Full subjects wrap in detail view, with page keys for longer detail content.

A stronger 44×12 keyboard check found that returning from task 12's detail
hid the selection. An early size callback did not fix it. The shared scroll
hook now waits for a rendered frame before reading row positions. It runs
only while the target list is mounted and removes its callback on cleanup.
The behavior test now checks the last task, detail, list return, and close.
The existing preview test's overflow count was updated for the new limit.
No new appearance-only test was added.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/todo-widget.tsx`: bounded neutral preview and details hint.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/todo-dialog.tsx`: correct list/detail branch, panel bounds, and keyboard scrolling.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/hooks/use-scroll-sync.ts`: post-layout selection restore with cleanup.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/tests/components/todo-dialog.test.tsx`: task navigation regression test.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/tests/widgets-render.test.tsx`: existing preview expectation.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/todo/tools.ts`: real task creation used in the preview.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/todo/domain.ts`: task UI subject/status contract.
- `/tmp/gent-fx-ui-todo-widget-before.ansi`: oversized preview.
- `/tmp/gent-fx-ui-todo-widget-after.ansi`: reply, preview, and composer visible together.
- `/tmp/gent-fx-ui-todo-dialog-before.ansi`: empty, oversized task dialog.
- `/tmp/gent-fx-ui-todo-last-small.ansi`: task 12 reached at 44×12.
- `/tmp/gent-fx-ui-todo-detail-small.ansi`: full selected subject at 44×12.
- `/tmp/gent-fx-ui-todo-dialog-red.log`: empty-list regression before repair.
- `/tmp/gent-fx-ui-todo-dialog-green.log`: stronger navigation test after repair.

Final Herdr verification at 44×12 returned to task 12 with its selection
visible. The temporary size control was stopped. The full gate and E2E both
passed with exit 0. This verifies the shipped todo widget, not arbitrary
third-party widget height behavior.

- `/tmp/gent-fx-ui-todo-list-return-final.ansi`: selected last task restored after detail.
- `/tmp/gent-fx-ui-todo-layout-gate.log`: full gate.
- `/tmp/gent-fx-ui-todo-layout-e2e.log`: TUI and server E2E.

### Review editing through Herdr

The review Edit option now opens the configured editor. The reply carries
optional edited text through RPC and durable storage. The server writes its
own review path. An empty edited document stays empty. Older replies without
edited text still read the server file.

In Herdr pane `wZ:p7`, vi opened the review. `:cq` returned to the unresolved
review. A second edit followed by `:wq` saved the changed text. The turn then
finished. The pane still showed a duplicate prompt call with a running label
after completion. This remains an open transcript issue.

Evidence:

- `/tmp/gent-fx-ui-review-cancel.ansi`: review remains open after editor cancellation.
- `/tmp/gent-fx-ui-review-saved.ansi`: completed turn and stale running label.
- `/tmp/gent-review-preview.QH6CQp/.gent/prompts/herdr-review-step-tc-1.md`: saved text from the live editor.
- `/tmp/gent-fx-ui-review-editor.log`: editor behavior test.
- `/tmp/gent-fx-ui-review-rpc.log`: four RPC tests pass, including empty edited content.
- `/tmp/gent-fx-ui-review-edit-gate.log`: full gate passes.
- `/tmp/gent-fx-ui-review-edit-e2e.log`: E2E passes with exit 0.

Source:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/interaction-renderers/prompt.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/prompt-presenter-live.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/server/interaction-commands.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/interaction-request.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/server/transport-contract.ts`

### Resumed tool status

The stale running label from the review check is fixed. Cold interaction
resume publishes another start for the same tool call ID. The feed appended
a second entry. The result updated only the first entry. The feed now keeps
one entry for that ID.

The existing feed behavior test now sends two start events with distinct
event IDs for one tool call. Before the fix, it found two entries. After the
fix, it finds one completed call and one completed tool segment. The live
Herdr review workflow also shows one completed call after saving in vi.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/hooks/use-session-feed.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/tests/use-session-feed.test.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/tool-runner.ts`
- `/tmp/gent-fx-ui-resumed-tool-red.log`: duplicate entry before repair.
- `/tmp/gent-fx-ui-resumed-tool-green.log`: four feed tests pass.
- `/tmp/gent-fx-ui-resumed-tool-herdr.ansi`: one completed prompt call.
- `/tmp/gent-fx-ui-resumed-tool-gate.log`: full gate passes with exit 0.
- `/tmp/gent-fx-ui-resumed-tool-e2e.log`: both E2E tasks pass with exit 0.

Full inspection still hides successful tools that have no registered renderer.
The fallback in `SingleToolCall` renders errors only. The live review prompt
therefore needs a generic full-detail fallback in a later pass. This is separate
from the repaired duplicate-call projection.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/message-list.tsx`

### Generic full tool details

The hidden-tool issue above is fixed. Full inspection uses the existing
generic renderer when no custom renderer exists. It shows input and output.
The expanded generic renderer also keeps all JSON fields instead of selecting
only a common message field. Compact error rendering stays unchanged.

In Herdr, Ctrl+O after a review approval shows the input mode, content, and
title. It also shows the result mode, decision, and server file path. Escape
returns to one compact prompt call. This follows the FX separation between
normal tool summaries and full inspection. No appearance-only test was added.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/message-list.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/tool-renderers/generic.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/tool-renderers/generic-format.ts`
- `/tmp/gent-fx-ui-generic-detail-herdr.ansi`: full prompt arguments and result.
- `/tmp/gent-fx-ui-generic-detail-normal.ansi`: restored compact summary.
- `/tmp/gent-fx-ui-generic-detail-gate.log`: full gate passes with exit 0.
- `/tmp/gent-fx-ui-generic-detail-e2e.log`: both E2E tasks pass with exit 0.

### Question and choice row allocation

The question no longer loses its space to an oversized choice. The layout
measures fixed controls separately. It reserves those rows before splitting
the remaining document and choice space. Short terminals remove blank section
spacing. No appearance-only test was added.

The first Herdr capture at 44×22 showed one question row and eight choice
rows. The final layout shows five question rows and four choice rows. Both
regions reach line 24 through their page keys. At 44×12, both regions show
two rows. The controls and live status stay visible. Enter submits the choice
and the agent completes its turn. The temporary terminal size control was
stopped after verification.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/interaction-renderers/option-list.tsx`
- `/tmp/gent-fx-ui-question-budget-before.ansi`: question limited to one row.
- `/tmp/gent-fx-ui-question-budget-after.ansi`: balanced question and choice regions.
- `/tmp/gent-fx-ui-question-budget-end.ansi`: both final lines at 44×22.
- `/tmp/gent-fx-ui-question-small-final.ansi`: controls and status visible at 44×12.
- `/tmp/gent-fx-ui-question-small-end.ansi`: both final lines at 44×12.
- `/tmp/gent-fx-ui-question-small-submit.ansi`: completed turn after selection.
- `/tmp/gent-fx-ui-question-budget-gate.log`: full gate passes with exit 0.
- `/tmp/gent-fx-ui-question-budget-e2e.log`: both E2E tasks pass with exit 0.

### Branch picker and draft recovery

The command palette now has a Branches list. It uses the existing picker and
marks the current branch. Unnamed branches use short identity labels. The
existing Theme keyboard position stays unchanged.

The live test found related feed and storage problems. Client metadata could
stop the old subscription before navigation. Historical branch events could
replace the selected route. In-memory application sessions used a separate
event store, so SQLite snapshots returned an empty event cursor. The feed now
applies live branch metadata and navigation together. It ignores navigation
covered by the snapshot. Its identity memo uses value equality. Application
sessions now use storage-backed events for disk and in-memory SQLite. Explicit
memory event-store test overrides remain.

Herdr verified an empty composer on the new branch. The original branch draft
returns unchanged. A different draft on the second branch also returns unchanged.
Neither draft was submitted. Feed behavior tests cover identity changes and old
navigation events. No appearance-only test was added. Full gate and E2E pass.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/command-palette.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/hooks/use-session-feed.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/tests/use-session-feed.test.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/server/dependencies.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/server/session-queries.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/event-store-live.ts`
- `/tmp/gent-fx-ui-branch-route-red.log`: lost navigation before repair.
- `/tmp/gent-fx-ui-branch-replay-red.log`: historical navigation before repair.
- `/tmp/gent-fx-ui-branch-replay-green.log`: five feed tests pass.
- `/tmp/gent/logs/6707ae38-20260906221458-client.log`: repeated reloads and empty snapshot cursors before shared storage.
- `/tmp/gent-fx-ui-branch-draft-original.ansi`: original draft restored.
- `/tmp/gent-fx-ui-branch-draft-second.ansi`: second draft restored.
- `/tmp/gent-fx-ui-branch-picker-gate.log`: full gate exit 0.
- `/tmp/gent-fx-ui-branch-picker-e2e.log`: both E2E tasks exit 0.

### Theme-aware edit diffs

The edit renderer no longer uses fixed dark red and green background blocks.
It uses the selected theme for backgrounds, line numbers, syntax, and change
markers. FX has transparent diff backgrounds, neutral text, and colored signs.
Compact excerpts color only the leading marker. Counts use diff colors, not
the neutral success/error tokens.

A real edit changed a test-owned file in `/tmp/gent-fx-diff.qxH6xq`. Herdr
captures show neutral body text and FX marker colors in dark and light modes.
Dark text uses #d0d0d0. Light text uses #444444. The markers use #30a46c and
#e5484d. No colored background escape appears on the captured changed lines.
The palette was returned to Dark after the check.

Calculated contrast against white is 9.74:1 for #444444, 6.10:1 for #626262,
and 15.13:1 for #262626. Marker contrast is 3.16:1 and 3.91:1. The plus/minus
signs also carry meaning. These calculations and emitted colors do not prove
the appearance of a light terminal background. That live check remains open.

- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/render.zig`: neutral line text and marker colors.
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/tool-renderers/edit.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/theme/themes/fx.json`
- `/tmp/gent-fx-ui-diff-dark.ansi`: dark diff capture.
- `/tmp/gent-fx-ui-diff-light.ansi`: light diff capture.
- `/tmp/gent-fx-ui-diff-theme-gate.log`: full gate exit 0.
- `/tmp/gent-fx-ui-diff-theme-e2e.log`: both E2E tasks exit 0.

### Bounded status row

The composer status now measures display width. It preserves the existing
label order, skips empty labels, and adds an ellipsis to the last label that
does not fit. It does not wrap into a hidden second row. Activity and elapsed
time remain before the model and debug workspace labels.

Herdr verified an active held model turn at 28×12. Activity and elapsed time
stay visible. The model label shortens with an ellipsis. Ctrl+C cancels the
turn and returns to an idle composer. The temporary terminal size control was
stopped. No appearance-only test was added.

The pane API has no per-pane theme control. A live white-background check is
still open. The shared Herdr theme was not changed. This pass checks status
layout; it does not claim exact parity for phase words or token metrics.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/composer-frame.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session.tsx`

### Connection failure and recovery

A test-owned standalone server on port 58124 exercised a real WebSocket
failure and recovery in Herdr. The connection widget now uses a plain bullet
notice instead of the old InlineChrome border. It keeps the error text,
restart count, extension failures, and scheduled-job failures.

At 44×12, the reconnect notice, full tested socket error, draft, and status
remain visible. Restarting the same test server removes the notice and keeps
the draft unchanged. The temporary size control and test server were stopped.
The normal isolated debug preview was restored. Long third-party extension
failure lists remain an unverified edge case, not a claim of universal fit.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/connection-widget.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/e2e/tests/server-lifecycle.test.ts`
- `/tmp/gent-fx-ui-connection-before.ansi`: old bordered reconnect panel.
- `/tmp/gent-fx-ui-connection-after.ansi`: plain notice at 44×12.
- `/tmp/gent-fx-ui-connection-recovered.ansi`: recovered connection and unchanged draft.
- `/tmp/gent-fx-ui-connection-notice-gate.log`: full gate exit 0.
- `/tmp/gent-fx-ui-connection-notice-e2e.log`: both E2E tasks exit 0.
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/render.zig`: width-aware status composition.
- `/tmp/gent-fx-ui-status-active.ansi`: active status at normal pane width.
- `/tmp/gent-fx-ui-status-active-small.ansi`: active status at 28×12.
- `/tmp/gent-fx-ui-status-cancel-small.ansi`: cancellation and idle status at 28×12.
- `/tmp/gent-fx-ui-status-width-gate.log`: full gate exit 0.
- `/tmp/gent-fx-ui-status-width-e2e.log`: both E2E tasks exit 0.

### Current resize decision

A fresh Herdr check after the status changes still reproduces normal-view
tail loss. The 30-paragraph reply reaches End marker 30 at narrow width.
Widening to 80×24 leaves only the composer and status. Ctrl+O restores the
full transcript and final paragraph. The temporary size control was stopped.

FX's settled resize path requests a terminal reset. The reset emits CSI 3 J
and rebuilds output. This clears saved terminal lines, including shell output
from before the app. The user approved this policy in the next turn. Gent
now clears saved lines on resize. It rebuilds the displayed transcript after
a layout frame. Session messages remain unchanged. The goal is not complete.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/native-transcript.tsx`
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/resize_runtime.zig`
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/render_engine/terminal_diff.zig`
- `/tmp/gent-fx-ui-resize-latest-narrow.ansi`: final paragraph before resize.
- `/tmp/gent-fx-ui-resize-latest-wide.ansi`: missing live tail after resize.
- `/tmp/gent-fx-ui-resize-latest-inspection.ansi`: full inspection restores the tail.

### Approved resize reset: verification

The resize path discards old committed row counts. It restores all displayed
items for measurement. It clears saved terminal lines before the next layout
frame. It then writes the newly measured leading rows to native history.
Resize during a menu or full inspection defers the reset until normal view
returns. This can remove shell output from before Gent started, as approved.

Herdr verified a 30-paragraph mock reply at 44×22 and 80×24. All 30 end
markers appear once in each captured history. The final paragraph remains
visible after widening. Resize during full inspection also restores the tail.
Resize during the command menu preserves the draft when the menu closes.
Temporary terminal size controls were stopped. The preview remains in wZ:pC.
No paid provider calls or appearance-only tests were added.

The first gate found a blank frame because the reset ran after rendering.
Moving the reset before that frame fixed the existing App resize test. The
final full gate and both E2E tasks pass. The complete FX acceptance audit is
still open. Partial-item content changes and compact-history changes need
separate checks. These resize results do not prove those cases.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/native-transcript.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/tests/app-auth.test.tsx`
- `/tmp/gent-fx-ui-resize-reset-narrow.ansi`
- `/tmp/gent-fx-ui-resize-reset-wide.ansi`
- `/tmp/gent-fx-ui-resize-reset-history-wide.txt`
- `/tmp/gent-fx-ui-resize-reset-history-small.txt`
- `/tmp/gent-fx-ui-resize-reset-return.ansi`
- `/tmp/gent-fx-ui-resize-reset-menu-return.ansi`
- `/tmp/gent-fx-ui-resize-reset-focus.log`: 10 tests pass.
- `/tmp/gent-fx-ui-resize-reset-gate.log`: full gate exits with code 0.
- `/tmp/gent-fx-ui-resize-reset-final-e2e.log`: both E2E tasks exit with code 0.

### Transcript layout replay follow-up

The compact-tool setting now invalidates saved transcript rows. The same
rebuild path handles terminal resize and changes to committed content. It
also checks the fingerprint of a partly committed item. Previously, that
item was outside the fingerprint check. Its old row offset could survive a
content change.

At 80×24 in Herdr, compact mode removes the 13 connected tool summaries from
the seeded debug transcript. Expanded mode restores all 13. A second full
toggle cycle produces an identical expanded transcript. The temporary size
control was stopped. The current preview is wZ:pD.

This rebuild clears saved terminal lines, as the approved resize policy
does. Session data remains the source of truth. The partial-content repair
has source verification; a dedicated live mutation check remains open.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/native-transcript.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session.tsx`
- `/tmp/gent-fx-ui-tools-collapsed.txt`: no connected summary rows.
- `/tmp/gent-fx-ui-tools-expanded-again.txt`: 13 connected summary rows.
- `/tmp/gent-fx-ui-tools-expanded-confirm.txt`: identical after another cycle.
- `/tmp/gent-fx-ui-transcript-replay-gate.log`: first run hit a core process timeout.
- `/tmp/gent-fx-ui-transcript-replay-e2e.log`: both E2E tasks passed.
- `/tmp/gent-fx-ui-transcript-replay-final-gate.log`: separate full gate passed.

### Partial-message mutation and active progress

A temporary Herdr check rendered the real NativeTranscript with one 80-row
message. Keyboard input replaced that same message ID with 45 new rows,
then 3 rows, then 100 rows. Each captured history contains exactly the new
ordered rows. It contains no old message rows. The last row stays visible.
This verifies replacement, shrink, and growth of a partly saved item.
The temporary source file was removed after the check.

A fresh comparison of FX's active-turn capture exposed a remaining layout
difference. FX puts progress above the composer. Gent put it below the
composer with model labels. Gent now puts a neutral progress row above the
composer. Thinking shows `Generating`; tool activity retains its specific
label. Model, cost, and extension labels remain below the composer.

Herdr verified the new layout at 44×22 and 28×12 with a held mock response.
At 28×12, progress, input, and model remain visible. Ctrl+C removes progress
and shows the interruption notice. The terminal size control was stopped.
No paid model calls or appearance-only tests were added.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/native-transcript.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session.tsx`
- `/tmp/gent-fx-ui-partial-replaced.txt`: exactly 45 new ordered rows.
- `/tmp/gent-fx-ui-partial-short.txt`: exactly 3 new ordered rows.
- `/tmp/gent-fx-ui-partial-long.txt`: exactly 100 new ordered rows.
- `/tmp/fx-live-tool-active.ansi`: FX progress above its composer.
- `/tmp/gent-fx-ui-progress-placement.ansi`: Gent progress above its composer.
- `/tmp/gent-fx-ui-progress-placement-small.ansi`: complete controls at 28×12.
- `/tmp/gent-fx-ui-progress-placement-cancel.ansi`: cancellation at 28×12.
- `/tmp/gent-fx-ui-progress-placement-gate.log`: full gate passed.
- `/tmp/gent-fx-ui-progress-placement-e2e.log`: both E2E tasks passed.

### Shipped widget scope

The shipped client registers three widget contributions. `todos` renders the
bounded todo preview below messages. `connection` renders reconnect and
extension-health notices below messages. `todo-tracker` uses the below-input
slot for keyboard handling and returns an empty element. No shipped widget
uses the above-input slot.

The todo preview and connection recovery have live evidence above. Connection
notices now use a plain layout. Long extension/job lists remain unverified.
Third-party widget height behavior cannot be proved from the shipped widgets.
Do not treat arbitrary extension layouts as verified.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/extensions/builtins/index.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/extensions/builtins/tool-renderers.client.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/components/connection-widget.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session.tsx`
