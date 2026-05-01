# Planify: Wave 16 - Collapse Effect Beta Bridges

## Context

Wave 16 follows the Effect beta.59 schema failure fixed in
`9affca78 fix: preserve effect tool schemas for providers`. That failure was a
symptom of a larger pattern: Gent sometimes flattens Effect-native concepts
into local DTOs, then rebuilds the Effect shape at the boundary. Against
`effect-ts/effect-smol` beta.59, the correct direction is subtraction: keep
Effect `Tool`, `Toolkit`, `LanguageModel`, `Model`, `Response`, `Rpc`, `Layer`,
`Context`, `Ref`, `SubscriptionRef`, and `Semaphore` as the primitives, and
only retain Gent code where it owns product semantics.

## Scope

- In: assumptions, bridges, DTOs, wrappers, and manual concurrency layers that
  duplicate Effect or Effect AI primitives.
- In: changes that reduce public surface or collapse duplicated state while
  preserving existing Gent behavior.
- In: SQLite schema/data migrations and storage service rewrites when the
  current shape is what keeps DTO mirrors or split read models alive.
- In: commit-sized migrations with gate between commits.
- Out: broad actor-engine deletion. The runtime audit found the actor engine
  already uses `Queue`, `Deferred`, `SubscriptionRef`, `Scope`, and `Stream`
  in load-bearing places.
- Out: speculative replacement of every domain service tag. Audits found many
  tags own real boundaries.

## Principles

| Principle                                                             | Application                                                                                  |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/Users/cvr/.brain/principles/correctness-over-pragmatism.md`         | Do not patch around beta drift; collapse the incorrect bridge.                               |
| `/Users/cvr/.brain/principles/redesign-from-first-principles.md`      | Redesign each boundary as if Effect AI beta.59 primitives existed on day one.                |
| `/Users/cvr/.brain/principles/subtract-before-you-add.md`             | Delete dead request fields, stale handles, DTO mirrors, and hand-rolled protocols first.     |
| `/Users/cvr/.brain/principles/use-the-platform.md`                    | Prefer Effect `Tool`, `Toolkit`, `Model`, `Rpc`, `Layer`, `Context`, `Ref`, and `Semaphore`. |
| `/Users/cvr/.brain/principles/boundary-discipline.md`                 | Validate at transport/storage boundaries; trust domain classes internally.                   |
| `/Users/cvr/.brain/principles/small-interface-deep-implementation.md` | Hide Gent metadata behind narrow primitives instead of exporting shallow parallel contracts. |
| `/Users/cvr/.brain/principles/fix-root-causes.md`                     | Treat unused bridges and unowned mutable state as root causes, not cleanup nits.             |

## Gate Command

```bash
bun run gate
```

For narrow commits, run a focused test first, then `bun run gate`.

## Research Lanes

| Lane                  | Agent                                  | Result                                                                          |
| --------------------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| Provider / Effect AI  | `019de44c-fb3c-7843-8c9c-2244b8c46fe5` | Dead request bridges, `ProviderResolution` wrapper.                             |
| Transport / DTO       | `019de44c-fb79-70b2-9ab2-b84f61b4f40a` | `MessageInfo`, namespaced SDK mirror, session tree projection.                  |
| Services / Layers     | `019de44c-fb8b-7e21-8e34-069e54c0324e` | Manual server contexts, duplicated `SessionProfile`, stale event router handle. |
| Runtime / Concurrency | `019de44c-fb9f-7151-b217-6d7bd0095d4a` | Interaction `Map`s, queue mutation semaphore, event delivery queue/ack worker.  |
| Extension API         | `019de44c-fbb0-7633-9bc6-9df50fed2f0b` | `ToolToken` parallel substrate, `tool-schema.ts`, resource descriptors.         |
| Storage / Persistence | local follow-up                        | Storage rewrite is allowed where it deletes transport/read-model indirection.   |

## Accepted Findings

### Provider Bridges

- Local `ProviderRequest.abortSignal` exists at
  `/Users/cvr/Developer/personal/gent/packages/core/src/providers/provider.ts:160-167`
  and call sites pass it from
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/phases/turn.ts:748-765`,
  but `Provider.stream` at
  `/Users/cvr/Developer/personal/gent/packages/core/src/providers/provider.ts:596-635`
  never forwards it. The actual interruption is already owned by
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-response/collectors.ts:164-167`.
- Upstream `LanguageModel` options at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/LanguageModel.ts:251-299`
  do not carry `AbortSignal`; stream interruption is the Effect `Stream` mechanism.
- Local `ProviderRequest.providerOptions` at
  `/Users/cvr/Developer/personal/gent/packages/core/src/providers/provider.ts:160-178`
  is not read in the provider call at
  `/Users/cvr/Developer/personal/gent/packages/core/src/providers/provider.ts:613-622`.
  Upstream provider metadata belongs on prompt/response parts, e.g.
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Prompt.ts:70-90`
  and
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Response.ts:438-457`.
- Local `ProviderResolution` is a one-field `{ layer }` wrapper at
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/driver.ts:81-85`.
  Upstream already models provider/model/layer with `AiModel.Model` at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Model.ts:56-71`
  and
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Model.ts:123-180`.

### Tool Substrate

- Local `ToolToken` duplicates Effect AI `Tool` at
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:38-52`,
  local `ToolInput` duplicates authoring at
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:69-115`,
  and `tool(...)` lowers through casts at
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:124-154`.
- Provider conversion rebuilds Effect tools at
  `/Users/cvr/Developer/personal/gent/packages/core/src/providers/provider.ts:229-260`.
- Upstream `Tool` already owns identity, schemas, annotations, dependencies,
  and approval metadata at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Tool.ts:175-260`,
  while `Tool.make` and `Tool.dynamic` exist at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Tool.ts:1150-1314`.
- Upstream `Toolkit` derives typed handlers, decodes params, encodes results,
  and streams handler output at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Toolkit.ts:201-209`
  and
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Toolkit.ts:323-436`.
- Local `tool-schema.ts` hand-rolls JSON schema flattening at
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/tool-schema.ts:11-60`.
  Upstream `Tool.getJsonSchema` exists at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Tool.ts:1538-1599`,
  and provider-specific flattening belongs in codec transformers such as
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/OpenAiStructuredOutput.ts:60-88`.

### Transport DTOs

- Domain `Message` already exists at
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/message.ts:82-100`,
  but transport recreates it as `MessageInfo` at
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:213-232`.
  The bridge is visible in
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-utils.ts:34-48`
  and
  `/Users/cvr/Developer/personal/gent/apps/tui/src/hooks/use-session-feed.ts:131-151`.
- Upstream RPC examples return `Schema.Class` directly at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/platform-node/test/fixtures/rpc-schemas.ts:8-18`
  and assert class instances survive RPC at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/platform-node/test/fixtures/rpc-e2e.ts:32-45`.
- SDK `GentNamespacedClient` manually mirrors the generated RPC client at
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/namespaced-client.ts:13-130`,
  although `GentRpcs` already produces a typed generated client at
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpcs.ts:99-129`.
  Upstream dotted RPC keys are callable directly at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/platform-node/test/fixtures/rpc-e2e.ts:48-52`.
- Domain session tree shape exists at
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/message.ts:153-158`,
  while transport defines and maps another tree at
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:64-99`
  and
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handler-groups/session.ts:28-37`.

### Layer / Context Wiring

- Server entrypoints duplicate composition by building `Context`s manually at
  `/Users/cvr/Developer/personal/gent/apps/server/src/main.ts:113-137`
  and
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/server.ts:197-225`.
  Upstream `Layer.mergeAll` and `Layer.provideMerge` are the platform wiring
  primitives at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/Layer.ts:975-981`
  and
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/Layer.ts:1237-1250`.
- `SessionProfile` stores a built `Context` and also extracts the same services
  into a custom dependency record at
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/profile.ts:374-405`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-profile.ts:54-67`,
  and
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-profile.ts:253-276`.
  Upstream `Context` already is the service container at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/Context.ts:69-75`.
- Event publisher late-binds `SessionProfileCache` at
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/event-publisher.ts:113-143`,
  resolves a profile at
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/event-publisher.ts:187-227`,
  then does not use the resolved profile. That creates a circular dependency
  without product behavior.

### Runtime Concurrency

- `makeInteractionService` uses plain mutable maps at
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/interaction-request.ts:156-166`
  and mutates them across Effect boundaries at
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/interaction-request.ts:175-240`.
  Upstream `Ref` and `SubscriptionRef` provide atomic Effect-managed state at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/Ref.ts:426-434`
  and
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/SubscriptionRef.ts:395-437`.
- Agent loop queue mutation layers a semaphore and reservation state around
  an existing `SubscriptionRef` at
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.state.ts:370-402`
  and
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts:645-748`.
  Upstream `SubscriptionRef.modifyEffect` is the intended transaction primitive at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/SubscriptionRef.ts:381-437`.
- Event delivery builds a queue/ack worker at
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/event-publisher.ts:34-71`,
  though callers await `deliver`. Upstream `Semaphore` and `Ref` cover this
  serialization/idempotency shape at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/Semaphore.ts:34-58`,
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/Semaphore.ts:205-220`,
  and
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/Ref.ts:426-434`.

### Storage / Persistence Rewrite Allowance

- `StorageService` is a broad legacy facade at
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts:25-145`,
  and focused sub-tags are currently derived from that same facade at
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts:168-185`.
  The plan may delete or invert that shape if direct focused services make the
  boundary smaller.
- Live/memory/test storage layer assembly repeats the same `base + sub-tags +
extras` shape at
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts:261-348`.
  Any profile/server composition cleanup may replace this with one shared
  storage composition root instead of preserving all three variants.
- The current SQLite schema keeps legacy `messages.parts` while also storing
  chunked message content at
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:470-510`
  and encodes `legacyPartsJson` as an empty array at
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite/rows.ts:177-184`.
  A storage simplification pass may migrate data to one canonical message
  content representation and drop the duplicate column after compatibility
  backfills are proven.
- Schema initialization already owns migrations, repair, indexes, and FTS
  rebuilds at
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:341-391`
  and
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:585-622`.
  New migrations belong here, with rollback-free idempotent startup behavior and
  dedicated tests against an old-shape database fixture.

## Commit Wave

### Commit 1: `refactor(provider): delete dead request bridges`

**Changes**:
| File | Change |
| --- | --- |
| `packages/core/src/providers/provider.ts` | Remove `abortSignal` and `providerOptions` from `ProviderRequestBase`. |
| `packages/core/src/runtime/agent/phases/turn.ts` | Stop passing `abortSignal`; keep interruption in the collector. |
| `packages/core/tests/providers/provider-resolution.test.ts` | Adjust fixtures if they mention removed fields. |

**Verification**:

- `env -u FORCE_COLOR NO_COLOR=1 bun test --reporter=dots packages/core/tests/providers/provider-resolution.test.ts`
- `bun run gate`

### Commit 2: `refactor(events): simplify publisher routing`

**Changes**:
| File | Change |
| --- | --- |
| `packages/core/src/server/event-publisher.ts` | Delete `SessionProfileCache` late-binding handle and unused profile resolution. Replace queue/ack worker with `Semaphore` plus `Ref` duplicate tracking. |
| `packages/core/src/server/dependencies.ts` | Remove router handle construction and post-cache mutation. |
| `packages/core/tests/**/event*.test.ts` | Keep or add focused event delivery ordering/idempotency coverage. |

**Verification**:

- Focused event publisher tests.
- `bun run gate`

### Commit 3: `refactor(interactions): make live coordination effect-managed`

**Changes**:
| File | Change |
| --- | --- |
| `packages/core/src/domain/interaction-request.ts` | Make the constructor Effect-based and store pending/resolution state in `Ref` or `SubscriptionRef`. |
| `packages/core/src/runtime/approval-service.ts` | Update construction to provide the Effect-managed service. |
| `packages/core/src/server/interaction-commands.ts` | Keep durable response semantics but route live coordination through the new atomic service. |
| `packages/core/tests/**/interaction*.test.ts` | Prove cold resume and single pending request semantics. |

**Verification**:

- Focused interaction tests.
- `bun run gate`

### Commit 4: `refactor(profile): collapse service snapshots into context`

**Changes**:
| File | Change |
| --- | --- |
| `packages/core/src/runtime/profile.ts` | Return profile data plus `layerContext`; stop eagerly exporting every service snapshot. |
| `packages/core/src/runtime/session-profile.ts` | Shrink `SessionProfile` and add `profileService(profile, Tag)` helper. |
| `packages/core/src/runtime/session-runtime-context.ts` | Read active bindings from the context helper. |
| `packages/core/src/server/rpc-handlers.ts` | Resolve per-session services from profile context. |

**Verification**:

- Focused profile/session runtime tests.
- `bun run gate`

### Commit 5: `refactor(server): share the server composition root`

**Changes**:
| File | Change |
| --- | --- |
| `packages/core/src/server/server-runtime.ts` | Add one shared layer constructor for dependencies, app services, identity, connection tracking, and route dependencies. |
| `apps/server/src/main.ts` | Replace manual context merging with the shared constructor. |
| `packages/sdk/src/server.ts` | Replace duplicate server bootstrapping with the shared constructor. |

**Verification**:

- `bun run --cwd packages/sdk test`
- `bun run --cwd apps/server typecheck` or package typecheck command.
- `bun run gate`

### Commit 6: `refactor(transport): return domain messages directly`

**Changes**:
| File | Change |
| --- | --- |
| `packages/core/src/server/transport-contract.ts` | Replace `MessageInfo` / `MessageInfoReadonly` with domain `Message`. |
| `packages/core/src/server/rpcs/message.ts` | Return `Schema.Array(Message)`. |
| `packages/core/src/server/session-utils.ts` | Delete `messageToInfo`. |
| `apps/tui/src/hooks/use-session-feed.ts` | Remove event-to-transport remapping. |

**Verification**:

- Focused message/session snapshot tests.
- `bun run gate`

### Commit 6.5: `refactor(storage): collapse message content storage`

**Changes**:
| File | Change |
| --- | --- |
| `packages/core/src/storage/schema.ts` | Add an idempotent migration from legacy `messages.parts` to the single surviving content representation, then drop or ignore the duplicate field through a table rebuild if needed. |
| `packages/core/src/storage/sqlite/rows.ts` | Remove `legacyPartsJson` once reads/writes use the canonical content table only. |
| `packages/core/src/storage/sqlite/impl.ts` | Simplify message insert/read paths around the surviving schema. |
| `packages/core/tests/storage/**` | Add an old-shape database fixture that proves migration, readback, search indexing, and `MessageReceived` event backfill. |

**Verification**:

- Focused storage migration tests.
- Focused message/search tests.
- `bun run gate`

### Commit 7: `refactor(sessions): own session tree projection in one layer`

**Changes**:
| File | Change |
| --- | --- |
| `packages/core/src/domain/message.ts` | Either make the domain tree schema-backed or remove the public domain tree if it is only a query read model. |
| `packages/core/src/server/transport-contract.ts` | Rename transport-only shape to an explicit read model if retained. |
| `packages/core/src/server/rpc-handler-groups/session.ts` | Move tree projection to the owning query layer or delete it if returning the domain tree. |
| `apps/tui/src/components/session-tree.tsx` | Consume the single surviving shape. |

**Verification**:

- Focused session tree tests.
- `bun run gate`

### Commit 8: `refactor(provider): use effect ai model values`

**Changes**:
| File | Change |
| --- | --- |
| `packages/core/src/domain/driver.ts` | Replace one-field `ProviderResolution` with upstream `AiModel.Model` or direct language-model layer. |
| `packages/core/src/providers/provider.ts` | Provide/use the upstream model abstraction without a Gent wrapper. |
| `packages/extensions/src/{anthropic,openai,mistral,google,bedrock}/**` | Return upstream model values where provider packages support them. |
| `packages/core/tests/providers/provider-resolution.test.ts` | Update test fixtures to the surviving primitive. |

**Verification**:

- Provider resolution tests.
- Focused provider extension tests.
- `bun run gate`

### Commit 9: `refactor(tools): make extension tools native effect tools`

**Changes**:
| File | Change |
| --- | --- |
| `packages/core/src/domain/capability/tool.ts` | Make `tool(...)` return an Effect AI `Tool.Any` annotated with Gent metadata. |
| `packages/core/src/extensions/api.ts` | Re-export the native tool-facing authoring surface. |
| `packages/core/src/runtime/agent/tool-runner.ts` | Read Gent metadata from tool annotations and execute via the native handler bridge. |
| `packages/core/src/providers/provider.ts` | Stop converting `ToolToken` to `AiTool.dynamic`; pass native tools/toolkits. |

**Mechanical migration rule**:

- First migrate one builtin tool and provider path manually.
- Then delegate remaining builtin tool updates with exact before/after examples.
- Stop delegation if a tool relies on behavior not representable as native `Tool` plus Gent annotations.

**Verification**:

- Provider tool schema regression test.
- Tool runner tests.
- `bun run gate`

### Commit 10: `refactor(tools): delete custom json schema bridge`

**Changes**:
| File | Change |
| --- | --- |
| `packages/core/src/domain/tool-schema.ts` | Delete after native tools are in place. |
| `packages/core/src/extensions/api.ts` | Remove `buildToolJsonSchema` export. |
| `packages/core/src/extensions/authoring.ts` | Remove `buildToolJsonSchema` export. |
| `packages/extensions/src/acp-agents/mcp-codemode.ts` | Use `Tool.getJsonSchema(tool, { transformer })`. |

**Verification**:

- Codemode tests or focused extension tests.
- Provider schema regression.
- `bun run gate`

### Commit 11: `refactor(sdk): delete namespaced rpc mirror`

**Changes**:
| File | Change |
| --- | --- |
| `packages/sdk/src/namespaced-client.ts` | Delete manual mirror. |
| `packages/sdk/src/client.ts` | Expose `GentRpcClient` directly or move any ergonomic facade to the app edge. |
| `apps/tui/src/**` | Migrate `client.session.foo(...)` to generated RPC keys such as `client["session.foo"](...)`. |
| `packages/sdk/tests/**` | Update SDK API expectations. |

**Verification**:

- `bun run --cwd packages/sdk test`
- TUI tests touching client calls.
- `bun run gate`

### Commit 12: `refactor(runtime): transact queue state through subscription ref`

**Changes**:
| File | Change |
| --- | --- |
| `packages/core/src/runtime/agent/agent-loop.state.ts` | Add one `mutateLoopState` helper around `SubscriptionRef.modifyEffect`. |
| `packages/core/src/runtime/agent/agent-loop.ts` | Delete `queueMutationSemaphore`, reservation state, and duplicate projected/current-state checks where the helper owns the transition. |
| `packages/core/tests/runtime/**` | Prove submit/drain/watch state behavior through public runtime APIs. |

**Verification**:

- Focused queue/watch runtime tests.
- `bun run gate`

### Commit 13: `refactor(resources): author resources as effect services`

**Changes**:
| File | Change |
| --- | --- |
| `packages/core/src/domain/resource.ts` | Add resource helpers that accept Effect service/layer values and infer tags where possible. |
| `packages/extensions/src/skills/index.ts` | Migrate simple service resource to the new helper. |
| `packages/extensions/src/task-tools/index.ts` | Migrate simple process resource. |
| `packages/extensions/src/executor/index.ts` | Migrate only if the new helper honestly fits lifecycle requirements. |

**Verification**:

- Extension lifecycle/resource tests.
- `bun run gate`

### Commit 14: `refactor(storage): make focused stores primary`

**Changes**:
| File | Change |
| --- | --- |
| `packages/core/src/storage/sqlite-storage.ts` | Delete the broad `StorageService` facade if focused services cover all call sites, or reduce it to a private implementation detail. |
| `packages/core/src/storage/*-storage.ts` | Own focused service construction directly instead of deriving every tag from one mega-service value. |
| `packages/core/src/server/dependencies.ts` | Consume the shared storage composition root rather than manually merging storage-related tags. |
| `packages/core/src/test-utils/**` | Keep one storage test layer shape for integration tests. |

**Verification**:

- Focused storage service tests.
- Server dependency/profile tests.
- `bun run gate`

## Review Checkpoints

- After Commit 2: quick review for event semantics before touching interaction state.
- After Commit 5: review composition/profile changes before transport churn.
- After Commit 6.5: review storage schema and migration invariants before more
  transport/session read-model deletion.
- After Commit 8: review provider/model semantics before native tool migration.
- After Commit 10: review tool migration and delete any temporary adapter seams.
- After Commit 14: final recursive audit against this plan plus `effect-smol`.

## Completion Rule

Wave 16 closes only when:

- All accepted bridges are either deleted or explicitly reclassified with
  stronger counter-evidence in this file.
- `bun run gate` passes after every commit.
- `bun run test:e2e` passes after the transport/provider/tool commits are done.
- A final recursive audit finds no P0/P1/P2 uncollapsed Effect bridge in the
  touched surfaces.

## Status

- Commit 0 complete before this plan:
  `9affca78 fix: preserve effect tool schemas for providers`
- Audit complete:
  five subagents reported grounded findings with local and upstream receipts.
  Weak findings were rejected, including broad actor-engine deletion and broad
  domain service tag churn.
