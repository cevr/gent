# Durable context admission

Research date: 2026-09-08. This is a design note. It does not claim implementation or measured cache savings.

## Source status

The source root is `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction`. HEAD is `753910d5`. Cache counters are committed in `a09715d8`. Codex chronological context preservation is committed in `753910d5`.

The parent agent has uncommitted cache-routing changes. The current unit covers Codex OAuth routing only. It supplies the durable session ID through `ProviderHints.cacheKey`. The parent reports that the full gate is running again. This note does not record a passing result for that unit.

The OpenAI API-key route still uses the compatibility adapter. That adapter drops `prompt_cache_key`. Its request converter does not forward the field. Its known-property set also excludes the field from custom-property forwarding. Passing a key into provider configuration is therefore insufficient. That route needs an upstream repair, a package patch, or a verified move to native Responses before Gent can claim routing support. Do not send unsupported keys through the shared Google or Mistral configuration.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/domain/driver.ts:99-104`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/agent/turn-source.ts:288-295`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/src/openai/index.ts:63-80,152-190`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/node_modules/@effect/ai-openai-compat/src/OpenAiLanguageModel.ts:1615-1683`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/src/openai-compatible-driver.ts:23-38,63-87`

The pinned prior-project research is `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/plans/opencode-cache-priors-2026-09-08.md`. The parent plan is `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/plans/core-extension-reduction-2026-09-08.md`.

## Decision

Add one host-owned context admission module over `MessageStorage`. Keep the existing actor as its execution owner. It needs no new service Tag, SQL table, prompt registry, or actor. The proposed module is `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/model-context-admission.ts`.

Branch resources need not precede this work. Durable transcript state does not need an extension resource lifetime. Branch resources remain necessary before the kernel and `ModelContextLedger` move into extensions.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/agent/agent-loop.behavior.ts:321-333`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/agent/agent-loop.worker.ts:159-188`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/domain/resource.ts:27-44`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/model-context-ledger.ts:21-55`

## Prompt contract

Treat the fully resolved prompt as one context document initially. Include the ordered sections and every final `systemPrompt` hook. Save exact rendered bytes. Do not reconstruct old text with current renderers.

An update contains a complete replacement document at the current history position. Its text states that it replaces earlier host context records. It states that omitted content is no longer current. That replacement does not cover user messages or tool results.

This sends more tokens when context changes. It avoids unsafe section extraction from arbitrary final strings. Finer section updates can follow only when the existing final hook has a structured contract that preserves those sections.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/domain/prompt.ts:8-33`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/agent/turn-resolve.ts:308-331`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/extensions/extension-hooks.ts:231-261`

## Durable records and admission

Keep the record schema, state projection, and admission functions in the proposed module. Use schema-tagged message metadata for two record types:

- A hidden system record saves an epoch ID and baseline bytes.
- A visible system record saves the epoch ID, complete current bytes, and rendered replacement text.

The same row contains the admitted state and its model-visible update. Derive the current state from valid records in the raw branch transcript. Compare exact bytes. Equal bytes produce no record. An `A → B → A` sequence still produces two updates.

Read the current state again inside the existing storage transaction. Insert the context record and append `MessageReceived` together. Deliver the event after commit. A retry returns the saved record. Use an append time no earlier than the transcript tail because storage sorts by timestamp before insertion order.

Call admission from normal `runTurnStep` after resolution and the interrupt check. Keep `resolveTurnContext` free of new context writes. Recovery calls it while missing tool results are still being restored. A context record must not split a call from its result.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/storage/message-storage.ts:135-150,185-207`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/storage/sqlite-storage.ts:28-51`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/agent/turn-persistence.ts:148-157`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/agent/agent-loop.turn-execution.ts:677-701,852-865,906-959`

## Authority and failed rendering

Recognize context state only when the message has the system role and the complete host record schema. Reject records with an extension author ID. Do not trust `customType` alone. The supported extension follow-up API accepts arbitrary metadata, but the host fixes its message role to `user`. This is an API boundary, not a sandbox for trusted extension JavaScript.

Return an internal render-completeness result from the existing hook resolver. Today, a failed projection disappears from its aggregate. A failed final hook returns its current input. A string comparison would admit those failures as content removal.

Keep later hooks running. Do not admit an incomplete render. Retain the last saved context. Fail model-step preparation visibly when rendering is incomplete. This is an explicit change from the current fail-soft hook behavior. It prevents a stale prompt catalog from accompanying changed tool authority. Keeping the current continue-on-error behavior would instead require saved outputs for individual existing hook slots.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/domain/message.ts:42-51`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/domain/extension-services.ts:103-109`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/agent/agent-loop.handlers.ts:376-399`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/extensions/extension-hooks.ts:127-164,231-261`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/domain/extension.ts:188-193`

## Restart, fork, and context reset

Restart reads saved baseline and update bytes. It does not regenerate history. Truncation derives state from the remaining records.

A fork inherits context at its selected message cutoff. Read the copied records. Do not seed from the parent's latest state. Keep epoch identity independent of message IDs because fork copies assign new message IDs. Nested branch forks retain the durable session ID, so that ID is sufficient for the proposed cache-routing key.

Handle ephemeral inheritance explicitly. It currently excludes hidden rows. Copy the valid baseline with inherited history, or establish a new child epoch and exclude inherited context records. Never copy updates without their baseline.

Pin active context updates during ordinary projection. Exclude them from summary input. Validate a compaction result before committing its new baseline and summary together. Insert the baseline before the summary so a fork at that summary includes both. Remove superseded updates only from the model view. A failed compaction retains the previous epoch. Apply the same explicit epoch reset to `context.newWindow()`.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/server/session-mutations-live.ts:283-344`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/domain/message.ts:113-129`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/agent/agent-runner.ts:201-213`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/agent/agent-runner.ephemeral.ts:197-201`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/model-context.ts:518-573`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/model-compaction.ts:671-758,775-899`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/model-context-window.ts:63-75`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/agent/turn-source.ts:340-475`

## Provider preparation

Repair the Anthropic adapter's prompt conversion before it loses earlier system content. A pinned package patch keeps leading system content and converts later system groups to escaped user context at the same position. This shared conversion serves streaming, text generation, and object generation. Gent's final HTTP tests cover API-key and OAuth routes. Keep this provider behavior outside the core loop.

The fallback has lower authority. It preserves text and order. It does not provide native system-message authority. Do not infer native support from a model-name regex. Keep tool output as tool output.

The unpatched Anthropic converter overwrites its top-level system value for each system group. An HTTP transform runs too late to restore lost text. The serializer repair needs no ambient `ExtensionContext`, model-service wrapper, or new provider registry. Updates must follow completed client tool results. Do not insert them between a call and its result. See [the provider research](anthropic-context-priors-2026-09-08.md) for server-tool and thinking-cache limits.

Check final OAuth wire bodies. The OAuth transform moves baseline content into the first user message. It adds billing and identity blocks. Cache placement must account for those transforms. The installed adapter discards assistant cache hints, so an assistant annotation alone proves no wire behavior.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/providers/model-resolver.ts:127-168`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/src/anthropic/index.ts:92-96,120-156`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/node_modules/effect/src/unstable/ai/LanguageModel.ts:95-186`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/node_modules/.bun/@effect+ai-anthropic@4.0.0-rc.112+11eac7cfbf53fc55/node_modules/@effect/ai-anthropic/src/AnthropicLanguageModel.ts:919-935,1075-1086`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/src/anthropic/keychain-client.ts:416-464`

## Delivery and acceptance

1. **Finish Codex cache routing.** Keep the current pending unit scoped to OAuth. Verify the serialized stable session key. Verify that Google and Mistral receive no unsupported field. Record the API-key adapter limit.
2. **Preserve Anthropic context.** Add provider-owned lowering. Test API-key and OAuth wire bodies. Check baseline preservation, update position, tool pairs, escaping, and all three model entry points.
3. **Admit durable context.** Integrate admission, render completeness, restart, fork, truncation, compaction, and window reset together. Test transaction rollback, duplicate admission, forged metadata, failed hooks, and pending-tool recovery. Keep authoritative context outside lossy summaries.
4. **Move changing content into extensions.** Read the date at each model step. State the time zone. Move catalog rendering with the explicit tool-surface consumer. Use selected host tools, not `allTools`. Test date rollover, registration reorder, additions, changes, and removals. Keep the outer cell schema and description stable.
5. **Apply provider cache policy.** Count markers in serialized requests. Retain tool definitions when calls are forbidden. Enforce execution denial in the host. Preserve historical call IDs, inputs, results, and compatible metadata. Measure consecutive live requests. Report inclusive input, cache reads, cache writes, and latency. Prove API-key routing on the wire after its adapter repair or verified native Responses migration.

Run the full gate and live Herdr checks after each logical code commit. Record exact behavior exercised. A cache miss alone is not a correctness failure. Unknown cache usage remains unknown. Continue the separate branch-resource and kernel move after the durable context path is sound.

No source code or tests were changed for this note.
