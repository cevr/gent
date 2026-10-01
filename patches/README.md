# Dependency patches

`package.json` `patchedDependencies` applies each file here at install. A
patch names one exact version, so a version bump leaves the patch unapplied
until it is regenerated for the new release. The Effect patches follow
`catalog.effect`; the guards fail when a patch key names another Effect
version. These are local dependency patches, not upstream releases.

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
