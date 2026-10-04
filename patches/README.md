# Dependency patches

`package.json` `patchedDependencies` applies each file here at install. A
patch names one exact version, so a version bump leaves the patch unapplied
until it is regenerated for the new release. The Effect patches follow
`catalog.effect`; the guards fail when a patch key names another Effect
version. These are local dependency patches, not upstream releases.

## `@opentui/core@0.5.14`

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
Node buffer bundles (`chunk-bun-sjw2d9bq.js`, `chunk-node-80p7e6t6.js`) get
the same change. "box borders under a scissor" in `apps/tui/tests/ui.test.tsx`
(left, centered, right and wide-character titles, nested scissors, a solid
background) and "a prompt cut by history draws its rail only beside its own
rows" in `apps/tui/tests/message-list.test.tsx` cover it.

The patch also keeps the rows a growing region pushes off the screen. When
the split region grows at the terminal's bottom, the native frame scrolls the
screen up with `CSI n S`. xterm and xterm.js drop the rows that leave the top
on `CSI S`; they do not go to scrollback. A long session's turn that retries
lost prompt and answer rows that way. Before each native frame
(`flushPendingSplitCommits`, `renderNative`), `scrollSplitViewportIntoHistory`
writes the scroll itself: it opens the synchronized update the native frame
then closes, saves the cursor, writes `n` line feeds at the screen's last row
(a line feed there sends the top row to scrollback) and restores the cursor.
It then sends the native transition again with its source row at the target
row, so the native frame keeps its row accounting (`noteViewportScroll`) and
writes no `CSI S`. The immediate scroll in `applyScreenMode` uses the same
line feeds (`ANSI.scrollIntoHistory`). Codex repairs the same fault this way
(`codex-rs/tui/src/tui/scrollback.rs`, `grow_viewport`). The renderer bundles
(`chunk-bun-j2z63cdy.js`, `chunk-node-wp7ct2m6.js`) get the same change. "a
long session's retried multiline prompt keeps every prompt and answer row
once at 45x15" in `packages/e2e/tests/scrollback.test.ts` covers it.

Remove this patch when an OpenTUI release keeps the split's history state
across the alternate screen, crops a box's border to the scissor and grows
the split region without `CSI S`. Checked on 2026-10-04: `main` after 0.5.14
still resets the state, its `drawVisibleBox` border fast path still writes
past the scissor, and `applyPendingSplitFooterTransition` still writes
`CSI S`.

## `@effect/ai-anthropic@4.0.0`

`prepareMessages` sets the request's `system` field from each system group
it meets, so a system message after the first message replaces the system
prompt. gent sends the runtime's turn notices as such a later system
message; in `system` they would change the cached prompt prefix every turn
and lose their place in the conversation.

The patch keeps the first system group in `system` and sends a later one,
in place, as a user message whose text blocks read
`<host-context-update>\n…\n</host-context-update>`, with `&`, `<` and `>`
escaped so the text cannot close the wrapper. The opening is
`HOST_CONTEXT_UPDATE_OPEN` in `packages/extensions/src/providers.ts`. Both
Messages drivers (`anthropic.ts`, and `opencode.ts` for its Messages models)
read it through `isHostContextUpdate` there to keep the cache marker off
these blocks.

Remove this patch when the SDK keeps a later system message in place.
Rechecked on 2026-10-01: 4.0.0 still replaces `system`, so the patch was
regenerated for that release. It patches `dist` only; the shipped `src` copy
keeps the upstream text.

## `@effect/ai-openai-compat@4.0.0`

The SDK reads a model's reasoning from a Chat Completions reply
(`reasoning_content`), but never sends it back. The prompt conversion drops
a reasoning part without an OpenAI item id, which every part this SDK
produces lacks, and `toChatMessages` drops reasoning items. It also starts
a new assistant message for a tool call that follows text. DeepSeek, Kimi
and GLM want their reasoning back on the assistant message that holds it,
and the tool calls on the same message as the text.

The patch adds a model config option, `replayReasoning`, off by default and
stripped from the request body. Off, the request is the upstream SDK's. On,
a reasoning part without an id stays a reasoning item, and `toChatMessages`
puts its text in `reasoning_content` on that prompt message's assistant
message. A tool call joins the assistant message before it in the same
prompt message. A `message_boundary` item marks where each prompt message
starts, so reasoning a reply ended on never reaches a later reply. Only the
OpenCode driver
(`packages/extensions/src/opencode.ts`) turns it on, then moves the text to
the field the model's models.dev entry names (`interleaved.field`), or drops
it when the entry names none.

Remove this patch when the SDK sends the reasoning back itself. Rechecked on
2026-10-01: 4.0.0 still drops reasoning without an item id, so the patch was
regenerated for that release. It patches `dist` only (the `.js` and the option's type in the `.d.ts`); the shipped
`src` copy keeps the upstream text.
