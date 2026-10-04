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

Remove this patch when an OpenTUI release keeps the split's history state
across the alternate screen. Checked on 2026-10-04: `main` after 0.5.14
still resets it.

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
