# Planify: Wave 16 - Align Gent With Effect And Actors

## Thesis

Wave 16 started with the Effect beta.59 schema failure fixed in
`9affca78 fix: preserve effect tool schemas for providers`. The bug was not an
isolated provider issue. It exposed a larger design smell: Gent sometimes
flattens Effect-native concepts into local DTOs, mutable registries, and
adapter services, then rebuilds the original Effect shape later.

The wave goal is to remove that churn. Gent should be small because it stands
on two platforms instead of competing with them:

1. **Effect is the platform.** Use Effect and Effect AI primitives for tools,
   toolkits, models, prompts, chat history, RPC, layers, service context,
   schemas, storage transactions, streams, refs, semaphores, and typed errors.
2. **Actors are the runtime shape.** Long-lived coordination belongs in actors:
   session/branch loops, extension state, prompt/tool-policy producers,
   lifecycle state, and stateful reactions. Synchronous folds can remain plain
   functions, but durable or live state should not hide in maps, hook arrays, or
   per-call bundles.

Gent owns product semantics: sessions, branches, transcripts, tool policy,
permission decisions, extension authoring, storage durability, and the UI/RPC
contract. Everything else should be borrowed from Effect or expressed as an
actor.

## Principle Application

| Principle                                                             | Consequence                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `/Users/cvr/.brain/principles/correctness-over-pragmatism.md`         | Prefer structural migrations over compatibility wrappers. SQL migrations and broad rewrites are allowed.     |
| `/Users/cvr/.brain/principles/redesign-from-first-principles.md`      | Redesign each boundary as if Effect AI beta.59 and the actor model had been day-one assumptions.             |
| `/Users/cvr/.brain/principles/subtract-before-you-add.md`             | Delete no-op fields, DTO mirrors, bridge services, duplicate registries, and legacy storage columns first.   |
| `/Users/cvr/.brain/principles/use-the-platform.md`                    | Use Effect `Tool`, `Toolkit`, `Model`, `Prompt`, `Chat`, `Rpc`, `Layer`, `Context`, `Ref`, and `Semaphore`.  |
| `/Users/cvr/.brain/principles/boundary-discipline.md`                 | Validate at transport, storage, provider, and extension loading boundaries; trust domain classes internally. |
| `/Users/cvr/.brain/principles/small-interface-deep-implementation.md` | Collapse shallow public contracts into fewer deeper services or actor protocols.                             |
| `/Users/cvr/.brain/principles/fix-root-causes.md`                     | Treat incorrect bridges and unowned live state as root causes, not cleanup nits.                             |

## Execution Rules

- Commit-sized migrations with `bun run gate` after each commit.
- Focused tests first when the touched surface has a smaller faithful suite.
- `bun run test:e2e` after provider, transport, storage, tool, and actor-loop
  phases are done.
- Mechanical migrations get delegated only after one manual before/after proves
  the shape.
- A finding can be rejected only with stronger counter-evidence written back
  into this file.

## Already Landed

- `9affca78 fix: preserve effect tool schemas for providers`
  - Provider tool conversion now passes Effect `Schema` into `AiTool.dynamic`
    instead of raw JSON Schema.
  - Regression proves Anthropic structured-output codec accepts advertised tool
    parameters.
- `81069950 refactor(provider): delete dead request bridges`
  - Removed unused model-provider `abortSignal` and `providerOptions` request
    fields.

## Target Architecture

### Provider And AI

Provider code should speak Effect AI directly. The turn boundary should produce
Effect AI `Prompt`, `Toolkit`, `Model` or `LanguageModel`, and options. Provider
implementations should not receive local message/tool DTOs only to reconstruct
the same Effect values.

Gent-specific provider semantics that remain:

- Model registry and pricing snapshots.
- Auth selection and provider credential policy.
- Transcript durability and UI event emission.
- External driver support where the driver is not an Effect AI model.

Everything else should prefer Effect AI primitives.

### Runtime And Actors

The session/branch agent loop is a durable actor in all but name. It owns a
mailbox, state, queue, lifecycle, restore, terminate, watch, and ask/tell
surface. It should become a session-loop actor protocol instead of a second
runtime beside `ActorEngine`.

Stateful extension behavior should follow the same rule. Pure hooks may stay as
ordered folds. Anything with lifecycle, state, durable view, or long-lived
coordination should become an actor with messages and optional `view`.

The local `ActorEngine` stays for now because it already uses Effect primitives
in load-bearing places. The wave must still audit whether it should eventually
adapt to Effect cluster `Entity`/`Rpc`, rather than grow into a separate
distributed actor framework.

### Transport And Storage

Transport should expose domain schema classes directly when the domain class is
the contract. Separate DTOs survive only when they are explicit read models with
different semantics.

Storage rewrites and SQLite migrations are in scope. If an old table shape keeps
a DTO mirror alive, migrate the data and remove the shape. Startup migrations
must be idempotent and tested against old-shape database fixtures.

### Composition

Effect `Layer` and `Context` are the composition model. Gent should not pass
service bundles through parameters, manually re-extract service snapshots from a
built context, or duplicate server composition roots.

Profile/runtime composition should provide a context; call sites should yield
the service they need.

## Evidence

### Effect AI Bridges

- Local provider request fields live at
  `/Users/cvr/Developer/personal/gent/packages/core/src/providers/provider.ts:160-178`.
  The previous schema bug came from rebuilding Effect tools at
  `/Users/cvr/Developer/personal/gent/packages/core/src/providers/provider.ts:229-260`.
- Upstream model/layer ownership exists in
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Model.ts:56-71`
  and
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Model.ts:123-180`.
- Upstream `LanguageModel` stream/generate options own model calls at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/LanguageModel.ts:251-299`.
- Upstream `Chat` owns stateful history and toolkit-aware generate/stream entry
  points at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Chat.ts:93-238`.
- Upstream `ResponseIdTracker` owns response-id correlation at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/ResponseIdTracker.ts:22-94`.

### Tool Substrate

- Local `ToolToken`, `ToolInput`, and `tool(...)` live at
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:38-154`.
- Local JSON-schema conversion lives at
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/tool-schema.ts:11-60`.
- Upstream `Tool` owns identity, schema, annotations, dependencies, and
  approval metadata at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Tool.ts:175-260`.
- Upstream `Tool.make`, `Tool.dynamic`, and `Tool.getJsonSchema` live at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Tool.ts:1150-1314`
  and
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Tool.ts:1538-1599`.
- Upstream `Toolkit` owns handler decoding and execution at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Toolkit.ts:201-209`
  and
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Toolkit.ts:323-436`.

### Actor Runtime

- `AgentLoopService` exposes tell/ask/watch-shaped methods at
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts:394-459`.
- `AgentLoop` keeps loop handles and mutation semaphores in maps at
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts:513-540`.
- Loop creation, start, cleanup, terminate, and restore live at
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts:1412-1613`.
- The existing actor engine already exposes `spawn`, `tell`, typed `ask`,
  `snapshot`, and `subscribeState` at
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/actor-engine.ts:171-231`.
- Upstream Effect cluster `Entity` models actor types, RPC protocols, mailbox
  settings, client lookup, and sharding layers at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/cluster/Entity.ts:50-180`.

### Extension Runtime

- Extension reactions compile ordered hook arrays at
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts:226-290`.
- Those reactions execute through manual loops at
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts:292-520`.
- Actor views already contribute prompt sections and tool policy through
  `ActorEngine`/`Receptionist` at
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts:413-458`.
- The extension runtime service is currently a marker object at
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/resource-host/extension-runtime.ts:12-27`.

### Transport And Storage

- Domain `Message` exists at
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/message.ts:82-100`,
  but transport recreates it as `MessageInfo` at
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:213-232`.
- The message bridge is in
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-utils.ts:34-48`
  and
  `/Users/cvr/Developer/personal/gent/apps/tui/src/hooks/use-session-feed.ts:131-151`.
- Domain and transport session tree shapes duplicate each other at
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/message.ts:153-158`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:64-99`,
  and
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handler-groups/session.ts:28-37`.
- `StorageService` is a broad facade at
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts:25-145`.
- Focused storage tags are derived from the broad facade at
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts:168-185`.
- Live/memory/test storage assembly repeats the same shape at
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts:261-348`.
- SQLite keeps legacy `messages.parts` while also storing chunked content at
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:470-510`.
- Message write encoding still produces `legacyPartsJson` at
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite/rows.ts:177-184`.
- Migration and repair hooks already live at
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:341-391`
  and
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:585-622`.

### Layer And RPC Composition

- Server entrypoints duplicate manual context composition at
  `/Users/cvr/Developer/personal/gent/apps/server/src/main.ts:113-137`
  and
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/server.ts:197-225`.
- `SessionProfile` stores a built `Context` and extracted service snapshots at
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/profile.ts:374-405`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-profile.ts:54-67`,
  and
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-profile.ts:253-276`.
- Upstream `Context` is already the service container at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/Context.ts:69-75`.
- Upstream `Layer.mergeAll` and `Layer.provideMerge` are the composition
  primitives at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/Layer.ts:975-981`
  and
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/Layer.ts:1237-1250`.
- SDK `GentNamespacedClient` mirrors the generated RPC client at
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/namespaced-client.ts:13-130`,
  while `GentRpcs` already provides typed RPC keys at
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpcs.ts:99-129`.

## Commit Wave

### Phase 1: Remove Proven Dead Bridges

**Commit 1.1: `refactor(provider): delete dead request bridges`**

- Status: complete in `81069950`.
- Removed unused model-provider `abortSignal` and `providerOptions`.
- Gate: passed.

**Commit 1.2: `refactor(events): simplify publisher routing`**

- Delete unused `SessionProfileCache` late binding in
  `packages/core/src/server/event-publisher.ts`.
- Replace queue/ack delivery worker with a direct `Semaphore` plus `Ref`
  duplicate tracker if ordering/idempotency tests prove equivalent behavior.
- Remove router-handle mutation from `packages/core/src/server/dependencies.ts`.
- Verify focused event publisher tests, then `bun run gate`.

**Commit 1.3: `refactor(interactions): make live coordination effect-managed`**

- Move live pending/resolution state in
  `packages/core/src/domain/interaction-request.ts` from raw maps to `Ref` or
  `SubscriptionRef`.
- Preserve durable interaction storage semantics in
  `packages/core/src/server/interaction-commands.ts`.
- Verify focused interaction tests, then `bun run gate`.

### Phase 2: Make Effect AI The Provider Surface

**Commit 2.1: `refactor(provider): use effect ai model values`**

- Replace one-field `ProviderResolution` with upstream `Model` or direct
  `LanguageModel` layer values.
- Update provider extensions to return Effect AI model values where package APIs
  support it.
- Verify provider resolution tests, provider extension tests, then
  `bun run gate`.

**Commit 2.2: `refactor(tools): make extension tools native effect tools`**

- Make `tool(...)` return an Effect AI `Tool.Any` annotated with Gent metadata.
- Teach `ToolRunner` to read Gent metadata from tool annotations.
- Pass native tools/toolkits to providers.
- Migrate one builtin tool manually, then delegate the remaining mechanical
  tool migrations with before/after examples.
- Verify provider tool schema regression tests, tool runner tests, then
  `bun run gate`.

**Commit 2.3: `refactor(tools): delete custom json schema bridge`**

- Delete `packages/core/src/domain/tool-schema.ts`.
- Remove `buildToolJsonSchema` exports.
- Use `Tool.getJsonSchema(tool, { transformer })` in codemode/MCP surfaces that
  still need JSON Schema.
- Verify codemode or focused extension tests, provider schema regression, then
  `bun run gate`.

**Commit 2.4: `refactor(ai): make prompt and chat primitives effect-native`**

- Status: in progress across reviewable sub-commits.
- Completed:
  - `8bfc8366` deletes the custom provider request bridge.
  - `53463864` centralizes Effect `Prompt` / `Response` compatibility.
  - `438bb1f8` centralizes transcript part projections.
  - `a678239f` and `d4f4089d` move search indexing onto the projection module
    while preserving raw image media type indexing.
  - `a5c3e098` and `1b52a26b` migrate runtime, extension, and acceptance-test
    message-part reads to projection helpers.
- Move provider entrypoints toward `Prompt.Prompt`, `Toolkit`,
  `LanguageModel`, and `Chat`.
- Shrink or delete `packages/core/src/providers/ai-transcript.ts` once upstream
  `Prompt`/`Response` values cross the provider boundary.
- Audit previous-response handling against `ResponseIdTracker`.
- Verify provider transcript/schema tests, focused turn streaming tests, then
  `bun run gate`.

### Phase 3: Make Actors The Runtime Surface

**Commit 3.1: `refactor(runtime): transact loop state through subscription ref`**

- Add one state mutation helper around `SubscriptionRef.modifyEffect`.
- Delete queue mutation semaphore/reservation state where the helper owns the
  transition.
- Verify queue/watch runtime tests, then `bun run gate`.

**Commit 3.2: `refactor(runtime): make session loops actor-owned`**

- Promote the existing loop command union into a `SessionLoopActor` protocol.
- Keep loop state as actor state.
- Replace `loopsRef`, `mutationSemaphoresRef`, loop handles, and watcher scope
  with actor spawn/find/tell/ask/subscribeState.
- Make `SessionRuntime` a thin transport validation plus actor command adapter.
- Verify agent-loop actor tests, SessionRuntime RPC acceptance tests, then
  `bun run gate`.

**Commit 3.3: `refactor(extensions): actorize stateful reactions`**

- Split extension reactions into pure folds versus stateful runtime behavior.
- Keep pure message/prompt/projection folds in the reaction compiler.
- Move stateful turn/message/tool behavior to actor messages or actor views.
- Verify extension reaction/actor-view tests, then `bun run gate`.

**Commit 3.4: `audit(actor): decide local engine versus effect cluster`**

- Decide whether local `ActorEngine` remains the in-process actor model,
  becomes an adapter over Effect cluster primitives, or migrates selected actor
  classes to `Entity`.
- Do not change the engine unless the audit proves an immediate simplification.
- Preserve ask/tell/snapshot/restart tests as executable evidence.
- Verify actor engine tests, then `bun run gate`.

### Phase 4: Collapse Transport And Storage Mirrors

**Commit 4.1: `refactor(transport): return domain messages directly`**

- Replace `MessageInfo` / `MessageInfoReadonly` with domain `Message`.
- Return `Schema.Array(Message)` from message RPCs.
- Delete `messageToInfo` and event-to-transport remapping.
- Verify message/session snapshot tests, then `bun run gate`.

Status: completed in two reviewable commits, then tightened for the no-users
experimental stance. The first removed server-side message transport conversion
and e2e-verified the runtime boundary; the second migrated SDK/TUI consumers to
domain `Message`; the follow-up deleted the `MessageInfo` compatibility export.

**Commit 4.2: `refactor(storage): collapse message content storage`**

- Treat the database as disposable: no legacy migration path, no old-shape
  fixture, no startup repair of retired message blobs.
- Remove `messages.parts` from fresh schema and all read/write SQL.
- Remove `legacyPartsJson`.
- Delete storage tests that exist only to preserve old DB shapes.
- Verify storage and search tests, then `bun run gate`.

**Commit 4.3: `refactor(sessions): own session tree projection in one layer`**

- Keep one session tree shape: domain schema, explicit read model, or actor
  projection. Delete the others.
- Move projection to the owning query layer if retained.
- Verify session tree tests, then `bun run gate`.

### Phase 5: Collapse Layer, Storage, Resource, And SDK Surfaces

**Commit 5.1: `refactor(profile): collapse service snapshots into context`**

- Return profile data plus `layerContext`.
- Stop exporting duplicate service snapshots.
- Add a helper for reading services from the profile context where needed.
- Verify profile/session runtime tests, then `bun run gate`.

**Commit 5.2: `refactor(server): share the server composition root`**

- Add one shared layer constructor for dependencies, app services, identity,
  connection tracking, and route dependencies.
- Replace manual context merging in server and SDK boot.
- Verify SDK tests, server typecheck, then `bun run gate`.

**Commit 5.3: `refactor(storage): make focused stores primary`**

- Delete the broad `StorageService` facade if focused services cover call sites,
  or reduce it to a private implementation detail.
- Let focused storage services own construction directly.
- Keep one storage test layer shape for integration tests.
- Verify storage service tests, server dependency/profile tests, then
  `bun run gate`.

**Commit 5.4: `refactor(resources): author resources as effect services`**

- Replace shallow resource descriptors with helpers that accept Effect
  service/layer values and infer tags where possible.
- Migrate simple resources first; migrate executor only if the helper honestly
  fits lifecycle requirements.
- Verify extension lifecycle/resource tests, then `bun run gate`.

**Commit 5.5: `refactor(sdk): delete namespaced rpc mirror`**

- Delete `GentNamespacedClient`.
- Expose the generated RPC client directly or keep an app-edge ergonomic facade.
- Migrate TUI client calls to generated RPC keys.
- Verify SDK tests, relevant TUI tests, then `bun run gate`.

## Review Gates

- After Phase 1: event and interaction behavior is unchanged, and no dead
  request/event bridge remains.
- After Phase 2: provider/tool/prompt boundaries are Effect AI native unless a
  retained Gent layer has explicit product semantics.
- After Phase 3: runtime coordination is actor-owned; any stateful reaction
  outside actors has a written reason.
- After Phase 4: transport and storage expose one source of truth per concept.
- After Phase 5: composition is Layer/Context-first, and public SDK/storage
  surfaces are narrow.

## Completion Rule

Wave 16 closes only when:

- Every accepted bridge is deleted or reclassified with stronger evidence in
  this file.
- `bun run gate` passes after every commit.
- `bun run test:e2e` passes after Phases 2, 3, and 4.
- A final recursive audit finds no P0/P1/P2 uncollapsed Effect or actor-model
  bridge in touched surfaces.
