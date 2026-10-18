# Dependency patches

`package.json` `patchedDependencies` applies each file here at install. A
patch names one exact version, so a version bump leaves the patch unapplied
until it is regenerated for the new release. An Effect patch follows
`catalog.effect`; the guards fail when a patch key names another Effect
version. These are local dependency patches, not upstream releases.

## `@opentui/core@0.5.17`

The split footer forgets its history state when it leaves for the alternate
screen. `syncSplitFooterState` resets the native split scrollback (its row
count and the column the last history row ends on), and the return to
`capture-stdout` seeds it again from the cursor row at column 0. The
terminal keeps the main screen behind the alternate one, so that state was
still true. gent's commits end mid-row (no trailing newline), so after the
return the next commit starts at column 1 of the last history row and
overwrites it. Also, `setupTerminal(false)` on the return writes `height - 1`
newlines from the cursor that the alternate screen restored. When the region
left from the screen's top row, the cursor is in the region (no clear moved
it), and the newlines push the screen's rows into scrollback: a second copy.

The patch keeps the state while the alternate screen covers the split
(`parkedSplitScrollback`, the region's surface offset). While it is held,
`syncSplitFooterState` does not reset the native split scrollback or the tail
column. Before the return's terminal setup, the cursor goes to the region's
top row, so the reserved newlines stay inside the region's rows. The first
change to `capture-stdout` after the return takes the region's offset back
(clamped by `syncSplitScrollback`) instead of the cursor seed. A resize, any
`resetSplitScrollback` (`resetSplitFooterForReplay` too) and a change to
`main-screen` drop the held state; then the return seeds from the cursor as
before. The Bun and Node bundles get the same change; native code is not
changed. The PTY tests in `packages/e2e/tests/scrollback.test.ts` ("a picker
closed over …") and the picker tests in
`apps/tui/tests/message-list.test.tsx` cover it.

The patch also crops a box's border to the scissor of the boxes around it.
The native `drawBox` checks only that the box overlaps the scissor. Its fast
path for an opaque border on a clear background then writes the border cells
straight into the buffer, past the scissor. A prompt's left rail that the
live tail cuts off at its top (history holds the prompt's top rows) then
draws on the rows above the tail. `OptimizedBuffer` keeps a copy of the
native scissor stack (`_scissorRects`, intersected as the native stack is).
`drawBox` gives the native draw the box as it is, so the box and its titles
keep their layout, and keeps the border cells outside the top scissor: it
saves them before the draw and puts back each one the draw changed to a
border glyph. Only the fast path writes there, and only with no grapheme or
link in the buffer, so a saved cell holds no grapheme reference. The other
paths and the titles (`drawText`) already respect the scissor. The Bun and
Node buffer bundles (`chunk-bun-6rvkxs1v.js`, `chunk-node-tfvyz31s.js`) get
the same change. "box borders under a scissor" in `apps/tui/tests/ui.test.tsx`
(left, centered, right and wide-character titles, nested scissors, a solid
background) and "a prompt cut by history draws its rail only beside its own
rows" in `apps/tui/tests/message-list.test.tsx` cover it.

The patch also keeps the rows a growing region pushes off the screen. When
the split region grows at the terminal's bottom, the native frame scrolls the
screen up with `CSI n S`. xterm and xterm.js drop the rows that leave the top
on `CSI S`; they do not go to scrollback. A long session's turn that retries
lost prompt and answer rows that way. Before each native frame
(`flushPendingSplitCommits`, `renderNative`), `openSplitFrame`
writes the scroll itself: it opens the synchronized update the native frame
then closes, saves the cursor, writes `n` line feeds at the screen's last row
(a line feed there sends the top row to scrollback) and restores the cursor.
It then sends the native transition again with its source row at the target
row, so the native frame keeps its row accounting (`noteViewportScroll`) and
writes no `CSI S`. The immediate scroll in `applyScreenMode` uses the same
line feeds (`ANSI.scrollIntoHistory`). Codex repairs the same fault this way
(`codex-rs/tui/src/tui/scrollback.rs`, `grow_viewport`). The renderer bundles
(`chunk-bun-h3ggawd9.js`, `chunk-node-kc1sqq2a.js`) get the same change. "a
long session's retried multiline prompt keeps every prompt and answer row
once at 45x15" in `packages/e2e/tests/scrollback.test.ts` covers it.

The line feeds and their count belong to one native frame. JS cannot write
inside a native frame, so the line feeds go out only when the native frame
after them is admitted (`splitFrameAdmitsViewportScroll`). A native frame is
skipped only for its output feed (a custom stdout): when the feed holds bytes
that no write committed, or when the queued and in-flight spans reach the
feed's capacity (4096). The patch first commits held bytes, as the native
frame would (`streamCommit`), and writes the line feeds only when the feed
has no queued or in-flight span; one span then cannot reach the capacity.
Otherwise it writes nothing, keeps the transition as it is, and retries once
the feed is idle (`scheduleRenderAfterFeedIdle`). A later resize then
replaces the transition from rows that did not move, as unpatched OpenTUI
does. Before, the line feeds went out and the native frame could still skip:
a resize before the retry counted only its own rows, and later history did
not join the rows before it. A buffered stdout without a render thread (gent
on Linux) admits every frame. With a render thread (the macOS default), a
frame is skipped while the thread holds its lock; the line feed write waits
for the thread's last write, so only the short hold before the thread waits
again can skip the frame. "split region growth" in `apps/tui/tests/ui.test.tsx`
(a growth frame skipped, a second growth before the retry, a shrink and two
commits, read in xterm) covers it.

The patch also writes a replay's clear inside the frame after it. A terminal
shows a synchronized update whole, and bytes outside one as they arrive.
`resetSplitFooterForReplay` wrote its clear (`ESC[r ESC[0m ESC[H ESC[2J`,
`ESC[3J` with `clearSavedLines`) at once, and a split resize that narrows
the screen wrote its `moveCursorAndClear` at once: the terminal showed an
empty screen until the next frames wrote history and the region again. Both
now add their bytes to `pendingSplitFramePrefix`. `openSplitFrame` writes the
prefix after the `ESC[?2026h` that opens the next native frame, under the same
admission check as the line feeds, before them. A frame that opens with a
prefix also drains every queued commit (as `drainAll` does), not
`maxSplitCommitsPerFrame`: the clear, all the history rows queued with it and
the region go out in one update. A change of screen mode that writes at once
(`applyScreenMode` without the deferred split transition) writes a held
prefix first, so the bytes keep their order. `resetSplitFooterForReplay` no
longer flushes the queued output before it resets: the flush repainted the
region from the empty next buffer, a blank frame in an update of its own,
and the rows it wrote were the ones the clear removes. The reset drops the
queue and applies a pending output mode, as the flush did once the queue was
empty. Codex keeps its frame on screen
until the next synchronized draw in the same way
(`codex-rs/tui/src/tui.rs`, `defer_thread_switch_clear`). gent queues a
replay's history in one step with the reset (`writeOffers` in
`apps/tui/src/message-list.tsx`). "a replay writes its clear and all of
history in one synchronized update" in `apps/tui/tests/message-list.test.tsx`
covers it.

The patch also retries a split commit the native side skips when the
renderer has no output feed. `flushPendingSplitCommits` retried a skipped
commit with `scheduleRenderAfterFeedIdle`, which does nothing without a feed;
gent on macOS writes to process stdout through the render thread, so it has
none. A direct flush that the thread's lock skips (the `footerHeight` and
`externalOutputMode` setters) then left its commits queued with no retry:
`idle()` resolved with them queued, and `destroy()` wrote `[snapshot WxH]`
for each. The patch retries with `scheduleRenderAfterBackpressure`, a timer
without a feed and the feed's idle with one, in both renderer bundles. gent's
exit flush waits for `idle()` (`flushTranscriptForExit` in
`apps/tui/src/message-list.tsx`). "SIGTERM during a handover …" in
`packages/e2e/tests/scrollback.test.ts` covers it: under CPU load it lost the
second message's rows 3 runs in 14 before, and 0 in 28 after. 0.6.6 waits for
the native split output in `destroy()`.

Remove this patch when an OpenTUI release keeps the split's history state
across the alternate screen, crops a box's border to the scissor, grows
the split region without `CSI S` and writes the replay's clear inside a
frame. Checked on 2026-10-04: `main` after 0.5.14 still resets the state,
its `drawVisibleBox` border fast path still writes past the scissor, and
`applyPendingSplitFooterTransition` still writes `CSI S`. Checked on
2026-10-05 (`main` at 684d70ce): `resetSplitFooterForReplay` still writes
its clear at once. Rechecked on 2026-10-10: 0.5.17 changes none of these paths.
It clamps a negative scissor size before the native push, and the patch's
`_scissorRects` copy takes the same clamped size. 0.6.0 moves layout and
paint into native code, and its split footer still resets the history state
and writes the replay clear at once; gent stays on 0.5.

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
