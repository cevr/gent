# Gent model-context projection audit

Audit date: 2026-09-06. Scope: goal item 6 only. This report records source
evidence and a bounded implementation contract. The pure projector and its
focused tests now implement that contract. Native model turns enforce the
projection before provider dispatch. Durable storage and semantic compaction
remain separate concerns.

## Conclusion

The audit found two gaps. The bounded projection now closes both model-path
gaps:

1. Native turns previously sent every visible message in a branch. The
   projector now enforces a model budget before a provider call.
2. Native turns previously projected tool calls and results by role only. The
   projector now validates IDs, names, and complete call/result groups.

The standalone pure projector at
`/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/model-context.ts`
validates these boundaries and returns bounded suffix metadata. The native model
path calls it before `toPrompt`. Semantic compaction is still a later unit.

Durable visible history is currently preserved. Message storage and the session
snapshot return the full branch. The `hidden` metadata flag excludes a message
from model context while keeping it visible to the transcript. A future
compactor must keep this separation.

## Current model path

```text
MessageStorage.listMessages(branch)
  -> resolveTurnContext: copy rows and remove only hidden messages
  -> resolveTurnSource: resolve catalog capability and projectModelContext
  -> toPrompt(projected.messages, systemPrompt)
  -> LanguageModel.streamText(prompt, toolkit)
```

`MessageStorage.listMessages` selects all rows for a branch. The query has no
limit or compaction boundary:

- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/storage/message-storage.ts:36-50`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/storage/message-storage.ts:185-211`

`resolveTurnContext` copies that complete result and filters only messages with
`metadata.hidden === true`. It returns the remaining array unchanged:

- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/agent/turn-resolve.ts:152-154`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/agent/turn-resolve.ts:227-228`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/agent/turn-resolve.ts:298-310`

`resolveTurnSource` reads the effective model capability, estimates the actual
system prompt and advertised tool schemas, reserves the provider output limit,
and calls `projectModelContext` before model resolution and `streamText`:

- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/agent/turn-source.ts:142-173`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/model-context.ts:1-55`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/model-registry.ts:128-295`

External drivers remain responsible for their own context. They receive the
durable visible history without this native model projection.

## Gap 1: bounded projection now enforced; semantic compaction remains

`estimateTokens` and `estimateContextPercent` are pure advisory helpers. They
count message parts with a rough four-character token estimate, add a fixed
4,000-token overhead, and return a rounded percentage. They do not select or
truncate messages:

- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/context-estimation.ts:12-37`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/context-estimation.ts:40-70`

The only consumers found are the extension context helper and handoff checks.
They use the percentage to trigger an 85% handoff decision. They do not guard a
model call:

- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/domain/extension-services.ts:525-535`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/extensions/src/handoff.ts:117-137`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/extensions/src/auto/index.ts:181-199`

The model catalog carries `contextLength`. Native turn resolution now reads the
effective model capability with `ModelRegistry.get` and passes that limit to the
prompt projector. Missing or invalid limits fail with a typed capability error.
The deterministic test registry uses an explicit named test capability. It does
not change production behavior:

- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/domain/model.ts:22-30`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/model-registry.ts:22-30`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/model-registry.ts:44-81`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/model-registry.ts:128-295`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/agent/turn-source.ts:142-220`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/providers/model-resolver.ts:13-38`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/providers/model-resolver.ts:157-171`

### Executed overflow probe

The pre-integration probe accepted a one-million-character user message. The
old estimator created a two-message prompt after adding the system prompt. It
reported 250,000 tokens against its 200,000-token fallback window and returned
127%:

```json
{ "promptMessages": 2, "estimatedTokens": 250000, "contextWindow": 200000, "contextPercent": 127 }
```

Receipt: `/tmp/gent-model-context-audit-orphan-probe.log`.

The old focused estimator and transcript tests asserted arithmetic and role
projection only. The new native integration tests capture the provider prompt,
prove suffix truncation and durable-history preservation, and verify that the
provider receives the explicit output reserve:

- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/tests/runtime/context-estimation.test.ts:14-250`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/tests/providers/ai-transcript.test.ts:36-181`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/tests/runtime/agent-loop/model-context.test.ts:1-260`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/tests/server/model-context.test.ts:1-180`

## Gap 2: tool-pair validation now enforced

`toPromptMessages` preserves input order, filters hidden messages, and chooses a
role-specific part projection. It does not inspect a tool-call ID before adding
a tool result. `toPrompt` passes the result to `Prompt.fromMessages`:

- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/providers/ai-transcript.ts:26-125`

The installed Effect constructor also does not perform cross-message pairing.
`makeMessage` constructs a typed message, and `fromMessages` wraps the supplied
array:

- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/node_modules/.bun/effect@4.0.0-rc.112/node_modules/effect/src/unstable/ai/Prompt.ts:1078-1088`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/node_modules/.bun/effect@4.0.0-rc.112/node_modules/effect/src/unstable/ai/Prompt.ts:1777-1782`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/node_modules/.bun/effect@4.0.0-rc.112/node_modules/effect/src/unstable/ai/Prompt.ts:2002-2005`

### Executed pre-integration orphan probe

The pre-integration projector accepted an assistant call with ID `call` followed
by an unrelated tool result with ID `orphan`:

```json
{
  "promptMessages": [
    { "role": "assistant", "parts": ["tool-call:call"] },
    { "role": "tool", "parts": ["tool-result:orphan"] }
  ]
}
```

Receipt: `/tmp/gent-model-context-audit-orphan-probe.log`.

The existing transcript test uses a valid pair. The display projection has a
separate pairing helper, but it marks a missing result as `running`; that helper
does not guard the model prompt:

- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/tests/providers/ai-transcript.test.ts:37-160`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/domain/message-part-display.ts:200-315`

The runtime does attempt recovery for one incomplete normal turn. It persists
the assistant tool call before tool execution, persists tool results later, and
`resumeTurn` reruns missing tool results before the next model step:

- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/agent/turn-tool-execution.ts:64-115`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/agent/agent-loop.turn-execution.ts:419-460`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/agent/agent-loop.turn-execution.ts:462-585`

That recovery path does not make `toPrompt` safe for malformed or partial
durable history by itself. The standalone projector now rejects an orphan
result, a mismatched tool name, incomplete groups, and cuts through a
multi-call group. Native model integration invokes this validation before
provider resolution. Its scripted boundary test captures the next provider
prompt and verifies that parallel call IDs and result IDs remain paired:

- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/model-context.ts:1-556`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/tests/runtime/agent-loop/model-context.test.ts:120-260`

The existing continuation tests prove normal multi-step persistence and
interruption behavior. The new model-context integration test proves bounded
projection at the native provider boundary:

- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/tests/runtime/agent-loop-continuation.test.ts:49-197`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/tests/runtime/agent-loop/queue.test.ts:300-360`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/tests/runtime/agent-loop/model-context.test.ts:1-260`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/tests/runtime/agent-loop/model-context.test.ts:1-260`

## Durable visible history

`MessageMetadata.hidden` documents the intended split: hidden messages leave the
model context but remain in the transcript:

- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/domain/message.ts:40-50`

The session query reads every message, derives tool interaction display data, and
returns the full projected message list in `SessionSnapshot`:

- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/server/session-queries.ts:63-88`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/server/session-queries.ts:124-134`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/domain/message-part-display.ts:302-315`

No evidence shows a current compactor deleting durable rows. The demonstrated
requirement is therefore a future implementation boundary: compact only the
prompt projection, or append an explicit summary message without deleting the
source transcript.

## Minimal implementation contract

The standalone seam is separate from `MessageStorage` and from the transcript
display projection. Its public contract is:

```ts
const ModelContextBudget = Schema.Struct({
  contextLimitTokens: Schema.Natural,
  reservedSystemTokens: Schema.Natural,
  reservedToolTokens: Schema.Natural,
  reservedOutputTokens: Schema.Natural,
})

const ModelContextProjection = Schema.Struct({
  messages: Schema.Array(Message),
  estimatedTokens: Schema.Natural,
  availableInputTokens: Schema.Natural,
  omittedMessageIds: Schema.Array(MessageId),
  truncated: Schema.Boolean,
})

projectModelContext(
  messages: ReadonlyArray<Message>,
  budget: ModelContextBudget,
): Result.Result<ModelContextProjection, ModelContextError>
```

The seam must satisfy these rules:

1. Snapshot the input array. Do not mutate durable messages.
2. Select a deterministic newest suffix or turn set for the same ordered input
   whose estimated input plus
   reserved system/tool tokens stays within `contextLimitTokens`.
3. Treat an assistant tool-call group and its matching tool results as one
   selection unit. Match stable call IDs and tool names. Never send an orphan
   result or an unmatched call to the model.
4. If any incomplete group cannot form a valid provider prompt, reject the
   projection with a typed diagnostic. Do not silently omit the group or
   fabricate a successful result. Define the explicit behavior for a single
   user message that alone exceeds the budget.
5. Preserve the original message order and all durable visible history. The TUI
   and session snapshot must continue to read the un-compacted branch.
6. Pass the real model context limit into this seam. Do not use the current
   static fallback map as the enforcement source. Reserve space for the actual
   system prompt, toolkit, and output policy.

`Schema.Natural` validates untrusted budget input at its boundary. Runtime
callers must decode external input with `Schema.decodeUnknown` before calling
the typed projector. The estimate is a planning bound, not an exact provider
token guarantee.

The focused unit now covers:

- separate reserves and a large newest user turn;
- repeated calls with the same ordered input return the same projection;
- complete single and parallel tool-call groups stay paired;
- hidden call/result edges, duplicate IDs, orphan results, mismatched names,
  wrong roles, and incomplete groups produce typed diagnostics;
- the projector does not mutate its input array;
- budget schemas reject negative and non-finite values.

The native integration tests now prove that an omitted old message remains in
`MessageStorage` while the provider prompt receives the bounded suffix. The RPC
acceptance test proves that a projection failure emits `ErrorOccurred`, settles
the request, leaves the runtime idle, and allows a later turn. Hidden-message
display separation remains a separate visible-history test boundary:

- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/tests/runtime/agent-loop/model-context.test.ts:35-118`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/tests/server/model-context.test.ts:1-180`

This contract does not select a model summarizer. It does not add a provider
catalog, a second event store, or a durable-history rewrite.

## Validation receipts

The focused pure projection checks passed:

```text
27 pass
0 fail
74 expect() calls
```

Command:

```sh
env -u FORCE_COLOR NO_COLOR=1 bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/runtime/context-estimation.test.ts packages/core/tests/providers/ai-transcript.test.ts packages/core/tests/domain/message-part-projection.test.ts
```

Receipt: `/tmp/gent-model-context-audit-tests.log`.

The extension helper checks also passed:

```text
3 pass
0 fail
8 expect() calls
```

Command:

```sh
env -u FORCE_COLOR NO_COLOR=1 bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/extensions/extension-session-helpers.test.ts
```

Receipt: `/tmp/gent-model-context-audit-helper-tests.log`.

The new pure projector checks passed:

```text
14 pass
0 fail
34 expect() calls
```

Command:

```sh
cd packages/core && env -u FORCE_COLOR NO_COLOR=1 bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/runtime/model-context.test.ts
```

Receipt: `/tmp/gent-model-context-unit.log`.

The implementation and focused tests pass oxlint and formatter checks:

```sh
env -u FORCE_COLOR NO_COLOR=1 bunx oxlint --ignore-path=.oxlintignore packages/core/src/runtime/model-context.ts packages/core/tests/runtime/model-context.test.ts
bunx oxfmt --check packages/core/src/runtime/model-context.ts packages/core/tests/runtime/model-context.test.ts docs/research/2026-09-06-model-context-projection-audit.md
```

The package typecheck passes for the current core tree:

```sh
bunx tsc --noEmit -p packages/core/tsconfig.json --pretty false
```

Receipt: `/tmp/gent-model-context-integration-typecheck-final.log`.

The current focused integration suite passes:

```text
18 pass
0 fail
49 expect() calls
```

Command:

```sh
cd packages/core && env -u FORCE_COLOR NO_COLOR=1 bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/runtime/model-context.test.ts tests/runtime/agent-loop/model-context.test.ts tests/server/model-context.test.ts
```

The adjacent root checks pass 47 tests and 148 assertions. The RPC settlement
check passes 1 test and 7 assertions:

- `/tmp/gent-context-adjacent-root-tests.log`
- `/tmp/gent-model-context-rpc-settlement-root.log`

The full core test command reaches all suites but currently fails in six
resource-graph command tests. Those failures report missing
`ResourceGraphStorage` and `Layer.scoped is not a function`; they are outside
this model-context change:

- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/tests/extensions/resource-graph-command.test.ts`

No external model call ran.

## Prior FX terminal receipt

The previous FX transcript task used the closed `pilotty` session
`gent-fx-transcript`. No pane remains live:

```sh
pilotty list-sessions
```

It returned an empty session list. Captures remain at:

- `/tmp/gent-fx-transcript-normal-success.txt`
- `/tmp/gent-fx-transcript-narrow-success.txt`
- `/tmp/gent-fx-transcript-normal-initial.txt`
- `/tmp/gent-fx-transcript-narrow.txt`

The exact spawn, resize, snapshot, and kill commands are not present in this
audit receipt, so they are not reproduced from memory. This audit did not
reopen that terminal session.

## Pinned research used

The prior-art document was read before this audit. Its OpenCode section requires
replay, normalized-event, interrupted-tool, and bounded-compaction tests. It also
states that a summary must not replace Gent's durable history:

- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/docs/research/2026-09-06-malleability-and-harness-prior-art.md:347-398`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/docs/research/2026-09-06-malleability-and-harness-prior-art.md:192-207`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/plans/live-composition.md:124-154`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/compaction.ts:115-163`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/prompt.ts:96-100`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/prompt.ts:1100-1129`
