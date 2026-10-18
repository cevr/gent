# Dependency patches

`package.json` `patchedDependencies` applies each file here at install. A
patch names one exact version, so a version bump leaves the patch unapplied
until it is regenerated for the new release. An Effect patch follows
`catalog.effect`; the guards fail when a patch key names another Effect
version. These are local dependency patches, not upstream releases.

## `@opentui/core@0.6.6`

The patch changes the split footer in the Bun and Node renderer bundles
(`chunk-bun-6qjat6qa.js`, `chunk-node-2rg7pskw.js`) the same way. Native code
is not changed. 0.6 moves layout, paint and terminal output into native code;
the split footer's history state, its transitions and its output feed stay
behind `sessionSplitControl` and `NativeSession.write`, which the patch uses.

**The split footer keeps its history state across the alternate screen.**
`syncSplitFooterState` resets the native split scrollback (its row count and
the column the last history row ends on) when the region leaves for the
alternate screen, and the return to `capture-stdout` seeds it again from the
cursor row at column 0. The terminal keeps the main screen behind the
alternate one, so the old state was still true. gent's commits end mid-row,
so after the return the next commit started at column 1 of the last history
row and overwrote it. The patch keeps the state while the alternate screen
covers the split (`parkedSplitScrollback`: the region's surface offset and
tail column). While it is held, `syncSplitFooterState` does not reset the
native split scrollback. The return (`applyScreenMode` from the alternate
screen, or the first change to `capture-stdout` after it) takes the region's
offset back through the `render-offset` and `sync` controls
(`restoreParkedSplitScrollback`) instead of the cursor seed. A resize, any
`resetSplitScrollback` (a replay too) and a change to `main-screen` drop the
held state. 0.6 returns with `exitAltScreen` and writes no newlines, so the
0.5 patch's cursor move before the terminal setup is gone. The picker tests
in `apps/tui/tests/message-list.test.tsx` ("a picker on the alternate screen
gives the region back as it was", "a picker that closes over a short session
…", "a turn that ends behind a picker …", "after a picker closes …") and the
PTY tests in `packages/e2e/tests/scrollback.test.ts` ("a picker closed over
…") cover it.

**A growing region scrolls its rows into scrollback with line feeds.** When
the split region grows at the terminal's bottom, the native frame
(`applyPendingSplitFooterTransition` in `renderer.zig`) scrolls the screen up
with `CSI n S`. xterm and xterm.js drop the rows that leave the top on
`CSI S`; they do not go to scrollback. A long session's turn that retries
lost prompt and answer rows that way. The native split control refuses a
transition change while a frame paints, so the patch changes the transition
when it is set: `setPendingSplitFooterTransition` sends the native side a
viewport scroll whose source row is its target row, so the native frame
keeps its row count (`noteViewportScroll`) and writes no `CSI S`. The
renderer keeps the transition as computed, for the next resize or growth to
start from. Before the native frame (`presentNativeScene`, and each frame of
`flushNativeSplitOutput`), `openSplitFrame` writes the scroll itself: it
opens the synchronized update the native frame then closes, saves the
cursor, writes `n` line feeds at the screen's last row (a line feed there
sends the top row to scrollback) and restores the cursor. The immediate
scroll in `applyScreenMode` uses the same line feeds
(`ANSI.scrollIntoHistory`). Codex repairs the same fault this way
(`codex-rs/tui/src/tui/scrollback.rs`, `grow_viewport`).

The line feeds go out before the native frame that counts them, and the
output feed can still refuse that frame (`FeedBackend.prepareFrame`: the
queued and in-flight spans reach the feed's capacity of 128, or no chunk is
free). The native frame then rolls back and keeps its transition, so its
retry counts the rows. Until a frame counts them
(`splitViewportScrollUncounted`), `applyScreenMode` and `processResize`
wait, as they wait for queued commits: a growth or resize before the retry
would replace the transition from rows that already moved, and later history
would not join the rows before it. A write the feed refuses writes nothing,
and the frame waits for output idle. The growth cases of "split region
history" in `apps/tui/tests/ui.test.tsx` (a growth, then a growth whose frame
the feed refuses and a second growth before the retry, a shrink and two
commits, read in xterm) and "a long session's retried multiline prompt keeps
every prompt and answer row once at 45x15" in
`packages/e2e/tests/scrollback.test.ts` cover it.

**A replay's clear goes out inside the frame after it.** A terminal shows a
synchronized update whole, and bytes outside one as they arrive.
`applySplitFooterReplayReset` writes its clear (`ESC[r ESC[0m ESC[H
ESC[2J`, `ESC[3J` with `clearSavedLines`) at once, and a split resize that
narrows the screen writes its `moveCursorAndClear` with the resize: the
terminal showed an empty screen until the next frames wrote history and the
region again. Both now add their bytes to `pendingSplitFramePrefix`, and the
narrowing resize is a plain `NativeSession.resize`. `openSplitFrame` writes
the prefix after the `ESC[?2026h` that opens the next frame, before the line
feeds. A frame that opens with a prefix takes every queued commit, not
`maxSplitCommitsPerFrame` (the queue still caps a batch by its cells): the
clear, the history rows queued with it and the region go out in one update.
A change of screen mode that writes at once (`applyScreenMode` without the
deferred split transition) writes a held prefix first, so the bytes keep
their order, and a flush (`suspend`, `destroy`) writes a prefix that no
frame took. Codex keeps its frame on screen until the next synchronized draw
in the same way (`codex-rs/tui/src/tui.rs`, `defer_thread_switch_clear`).
gent queues a replay's history in one step with the reset (`writeOffers` in
`apps/tui/src/message-list.tsx`). "a replay writes its clear and all of
history in one synchronized update" in
`apps/tui/tests/message-list.test.tsx` covers it.

**A blank history row that ends without a newline keeps its row.** 0.6
paints a scrollback snapshot natively (`renderSnapshot`, `preserveUnwritten`),
so a cell nothing drew holds no character, where 0.5 held a space. The native
split scrollback counts a row by its last drawn cell (`snapshotRowEnd`): a
blank row is zero columns, and a commit that ends on it without a newline
leaves the tail column at 0. The next commit then does not start a new row
(`starts_mid_line` in `appendSplitFooterSnapshotCommit`) and writes over the
blank row. gent ends each commit on its last row and lets the next one start
its own row (`landDrawn` in `apps/tui/src/message-list.tsx`), so the spacers
between items left history as the footer grew at a turn's start.
`enqueueRenderedScrollbackCommit` now draws a space with transparent colors
in the first cell of such a last row: the row is one column wide, and the
next commit starts a new row after it. "a blank history row ended without a
newline keeps its row" in `apps/tui/tests/ui.test.tsx` and "a turn that
starts from idle keeps every transcript row once, in order, while it runs,
at 60x20" in `packages/e2e/tests/scrollback.test.ts` cover it.

Each test above fails on 0.6.6 without its part of the patch and passes with
it (2026-10-17: the patch built without each part in turn; without the
growth and resize wait, only the refused-frame growth case fails).

Three faults the 0.5.17 patch fixed are gone. 0.6's native `drawBox` crops a
border to the scissor; "box borders under a scissor" in
`apps/tui/tests/ui.test.tsx` stays as its regression test. 0.6 has no
feed-idle retry for a skipped split commit: `destroy()` waits for the native
split flush and writes the queued commits before it closes, so the
`scheduleRenderAfterBackpressure` retry is not ported; "SIGTERM during a
handover …" in `packages/e2e/tests/scrollback.test.ts` still covers it. A
destroy no longer writes `[snapshot WxH]` for a queued commit. gent's exit
still waits for `renderer.idle()` after its last commit
(`flushTranscriptForExit` in `apps/tui/src/message-list.tsx`), so the commits
reach the terminal before the destroy, and then awaits `renderer.closed`.

Checked on 2026-10-17 against `anomalyco/opentui` `main` at f8f608e (0.6.6
and one diff-gutter commit): `syncSplitFooterState` and the return to
`capture-stdout` still reset the split scrollback,
`applyPendingSplitFooterTransition` still writes `CSI S`, and
`applySplitFooterReplayReset` and `processResize` still write their clears
outside a frame, and `snapshotRowEnd` still counts a blank row as zero
columns. Remove this patch when an OpenTUI release keeps the split's history
state across the alternate screen, grows the split region without `CSI S`
(and counts the scroll in the frame that writes it), writes the replay and
narrowing clears inside a frame, and keeps a blank last row that ends without
a newline.

## Effect SDKs (no patch since 4.0.5)

`effect` 4.0.5 and its driver SDKs need no patch. Checked on 2026-10-17
against the published 4.0.5 tarballs:

- Tool calls. With `disableToolCallResolution: true`,
  `toolCallValidation: "deferred"` decodes each tool call's parameters as
  opaque and decodes a call to a name the toolkit does not hold
  (`withUndeclaredToolCalls`), in `generateText` and `streamText`, with a
  toolkit, an empty toolkit and no toolkit. `@effect/ai-anthropic`,
  `@effect/ai-openai` and `@effect/ai-openai-compat` pass a call to an
  undeclared name on as the model wrote it in that mode
  (`transformToolCallParams`). This is what the `effect@4.0.2` patch and the
  undeclared-name part of the three driver patches did. The turn passes the
  option on each request (`runtime/turn.ts`), so the tool runner
  (`runtime/tools.ts`) is still the one place that checks a call. One
  difference: deferred mode checks a provider-executed call's parameters
  against the tool; gent declares no provider-executed tool. "refused tool
  calls on the wire", "tool declarations on the wire" and "a turn that
  advertises no tool" in `packages/extensions/tests/wire-tool-names.test.ts`
  and "a call the tool runner refuses …" in
  `packages/core/tests/runtime/tools.test.ts` cover it.
- Reasoning on Chat Completions. `@effect/ai-openai-compat` sends the
  reasoning of a prompt message back on its assistant message, in the field
  the reply read it from (`reasoning` or `reasoning_content`, the latter by
  default), and sends one prompt message's text, reasoning and tool calls as
  one chat message. The 4.0.2 patch did this behind `replayReasoning`. The
  Chat Completions class (`packages/extensions/src/providers.ts`,
  `reasoningInField`) still moves the text to the field the model's
  models.dev entry names (`interleaved.field`), or drops it when the entry
  names none. The SDK's image options key is now `openai-compat`, not
  `openai`. "OpenCode reasoning" in
  `packages/extensions/tests/opencode.test.ts` covers it.
- Child stdin. `@effect/platform-node-shared` keeps a fallback `error`
  listener on the child's stdin until it closes (`handleInputErrors`), the
  listener the 4.0.2 patch added. "an interrupted page …" in
  `apps/tui/tests/extensions/git.client.test.tsx` covers it.

A later Anthropic system message (the runtime's turn notices) needs no
patch. The SDK keeps later system messages as `system` messages in history
for a model that takes one (`supportsMidConversationSystemMessages` in its
capability table, which `LanguageModel` reports as
`supportsSystemMessagesInHistory`) when each has a place: after a user
turn, and last or before an assistant turn. Otherwise, for a model the
table marks false or when any one of them cannot be placed, it appends
every one of them to the top-level `system`, which would change the cached
prefix each turn. Core decides the role before the SDK sees the prompt
(`promptForModel` in `packages/core/src/runtime/model-context.ts`): a later
system message stays one only when its text is wholly gent's own, the model
reports the capability, and it has a place; every other goes as a
`<host-context-update>` user message at its place, so the SDK never moves
one. The OpenCode gateways' Messages models set
`midConversationSystemMessages: false`, so they get the same form. The
table is optimistic: an id it does not know counts as taking a later
system message. A new Claude model that does not would refuse a trusted
notice with a 400 where the old wrap always worked, so recheck the table on
each SDK bump. Rechecked on 2026-10-17: 4.0.5's table is the 4.0.2 table
(false for the 3.x, 4.0, 4.1 and 4.5 families, true for any other id).
