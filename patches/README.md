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

The patch also passes a call to a tool the request did not declare on, as
`@effect/ai-openai@4.0.0` below does.

Remove the system part when the SDK keeps a later system message in place,
and the undeclared-name part with `effect@4.0.0`'s. Rechecked on
2026-10-01: 4.0.0 still replaces `system`, so the patch was regenerated for
that release. It patches `dist` only; the shipped `src` copy keeps the
upstream text.

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

The patch also passes a call to a tool the request did not declare on, as
`@effect/ai-openai@4.0.0` below does.

Remove the reasoning part when the SDK sends the reasoning back itself, and
the undeclared-name part with `effect@4.0.0`'s. Rechecked on
2026-10-01: 4.0.0 still drops reasoning without an item id, so the patch was
regenerated for that release. It patches `dist` only (the `.js` and the option's type in the `.d.ts`); the shipped
`src` copy keeps the upstream text.

## `@effect/platform-node-shared@4.0.0`

The child process spawner runs a `stdin` stream into the child through a
sink that listens for the writable's `error` event only while it runs. A
child that exits before it reads all of its input (a pager the reader
quits, a pager an interrupt stops) fails a write that Node still holds
after the sink stopped, and that `error` event has no listener: it throws
as an uncaught exception and ends gent. The child's stdout and stderr keep
a listener of their own for this reason; stdin had none.

The patch adds a no-op `error` listener on the child's stdin when the
spawner creates the stdin sink. The sink still fails on a write error while
it runs; the child's exit code reports a child that left early. `src` and
`dist` get the same change. Without it, the interrupt test in
`apps/tui/tests/extensions/git.client.test.tsx` ("an interrupted page …")
fails with `EPIPE`; a reader who quits the pager early meets the same race.

Remove this patch when an `@effect/platform-node-shared` release keeps a
listener on the child's stdin. Checked on 2026-10-04: 4.0.0, the latest
release, has none.

## `effect@4.0.0`

`LanguageModel.streamText` and `generateText` with
`disableToolCallResolution: true` decode each tool call's parameters against
the tool's encoded parameter schema (`makeToolkitWithEncodedParameters`). A
model call whose input the schema refuses (a wrong type, a missing key)
fails the whole reply with `InvalidOutputError`. gent resolves tool calls
itself (`runtime/turn.ts`), so that failure is a failed model step: the
loop retries it as a transient provider error, a paid request that the
model will likely answer the same way, and the model never reads why its
call failed. With tool call resolution on, the SDK already decodes the
parameters as opaque (`makeToolkitWithOpaqueParameters`) and lets the
Toolkit refuse an invalid call as that call's result.

A call to a name the toolkit does not hold (a tool no extension registers)
fails the reply the same way: the response schema has a tool call part for
each toolkit tool only. Before that, each driver SDK fails the reply with
`ToolNotFoundError` for a name the request did not declare
(`transformToolCallParams`), which is also every tool the turn did not
advertise: the request declares the advertised tools only (`oneOf`).

The patch decodes the parameters as opaque on both paths, and on the
disabled path decodes a call to a name the toolkit does not hold as a call
to that name with opaque parameters (`withCalledTools`). The driver patches
(`@effect/ai-anthropic`, `@effect/ai-openai`, `@effect/ai-openai-compat`)
pass a call to an undeclared name on as the model wrote it. The tool runner
(`runtime/tools.ts`) is then the one place that checks a call: it answers an
invalid call with a failed result (`Tool '<id>' input failed`, or `Unknown
tool: <id>`) that the model reads on its next step. The request is not
changed: the tool declarations come from the toolkit the turn passes, as
before. A provider-executed tool call is no longer checked on the disabled
path; gent declares none. "refused tool calls on the wire" in
`packages/extensions/tests/wire-tool-names.test.ts` (each shipped driver)
and "a call the tool runner refuses …" in
`packages/core/tests/runtime/tools.test.ts` cover it; "tool declarations on
the wire" in the first file pins each driver's declaration bytes.

A request with no toolkit, or an empty one, takes an early return that
decodes the reply against `Toolkit.empty`, so any tool call in it fails the
reply. A turn that advertises no tool sends no toolkit. The patch makes that
early return decode a called name with opaque parameters too
(`emptyToolkitFor`, `decodeEmptyToolkitParts`), but only with
`disableToolCallResolution: true`, which the turn now passes on that path.
The flag does not go on the request, so the request is the same bytes.
Without the flag, the early return decodes as upstream does. "a turn that
advertises no tool" in the same test file covers it.

Remove this patch when an Effect release, with tool call resolution off,
decodes tool call parameters as opaque and decodes a call to an undeclared
name, in both `generateText` and `streamText`, and with a toolkit, an empty
toolkit, and no toolkit. Checked on 2026-10-04: 4.0.0, the latest release,
does neither. It
patches `dist` only; the shipped `src` copy keeps the upstream text.

## `@effect/ai-openai@4.0.0`

`transformToolCallParams` fails the reply with `ToolNotFoundError` when a
call names a tool the request did not declare. The patch passes that call on
with its parameters as the model wrote them; the tool runner answers it
(`effect@4.0.0` above). Remove this patch with that one's undeclared-name
part. Checked on 2026-10-04: 4.0.0, the latest release, fails the reply. It
patches `dist` only; the shipped `src` copy keeps the upstream text.
