# Planify: Wave 35 — Composable Primitives + Schema/Effect Idiom Sweep

## Context

Wave 34 closed at HEAD `b589473f` with C1–C12 landing the encore upstream DX
push, runtime ergonomics fixes, and the worked example of composable-primitive
demotion (C12: `resolveDualModelPair` from a 6-surface registry method to a
pure helper). The closing 9-lane independent audit reported:

- **1 P0 structural** — `ToolCapability` has three discrimination paths
  (brand + annotation + dead `Capability.Tool` TaggedEnum variant).
- **5 P0 composable-method demotions** — direct extensions of the C12 pattern
  across the rest of `ExtensionHostContext`, `SessionQueries`, and
  `ExtensionRegistry` surfaces.
- **18 P1s** across Effect-idiom adoption, actor-model integrity, module-top
  platform reads, dead extension surface, upstream-encore DX, and three
  remaining yield-don't-thread violations (file-index factories, acp-agents
  session-manager, librarian repo-explorer).

Full receipt: `plans/WAVE-34-audit-receipt.md`. Wave 35 closes the 6 P0s and
the highest-ROI P1s before the next independent audit may pass.

## Scope

**In**

- **C1**: Drop the dead `Capability.Tool` TaggedEnum variant (L4-P0-1). Keep
  brand + annotation + `GentToolMetadata`. Migrate any consumer that
  pattern-matches on `_tag === "tool"` to use `isToolCapability` or
  `getToolMetadata`.
- **C2–C6**: Demote five composable methods (extends C12 pattern):
  - **C2** `Agent.require` → pure helper using existing `agent.get` (L9-P0-1).
  - **C3** `session.estimateContextPercent` → pure helper using existing
    `listMessages` + pure `contextEstimation.estimateContextPercent`
    (L9-P0-2).
  - **C4** `SessionQueries.getBranchTree` → pure helper composing `listBranches`
    - `countMessagesByBranches` (expose the latter) + existing `buildBranchTree`
      (L9-P0-3).
  - **C5** `SessionQueries.getSession` / `getLastSessionByCwd` → null-wrap
    helpers over `SessionStorage` (L9-P0-4). Inline at the 2 rpc-handler call
    sites.
  - **C6** `ExtensionRegistry.getAgent` / `getModelCapability` → pure helpers
    (`findAgent` / `findModelCapability`) over `listAgents()` /
    `listModelCapabilities()` (L9-P0-5). `getAgent` already duplicates the
    `requireAgent` standalone helper at `registry.ts:565`.
- **C7** (deferred earlier per counsel revision): Actor-model integrity fixes
  (L2-P1). Land before the large schema migration so behavior regressions
  have a clean diff window:
  - **C7.1** Add `commandId` to `TerminateBranch` / `GetQueue` / `GetState`
    `primaryKey` (`agent-loop.actor.ts:334,343,379`) so distinct intents
    aren't deduped together.
  - **C7.2** Unify `enqueueMessage` handle-access paths
    (`agent-loop.actor.ts:632`). Make both reentrant and `QueueFollowUp`
    callers go through `ensureStarted`, or formalize the bypass as a typed
    distinct internal-only callback.
  - **C7.3 — SUPERSEDED (dropped 2026-05-11).** Default `send + waitFor`
    parity with `respondInteraction` is not justified. Three reasons,
    in order of certainty: 1. **The original framing is wrong about delivery errors.**
    `ref.send` is `Effect.map(discardCall, …)`
    (`effect-encore/dist/actor.js:439-448`) and the static `send`
    surface types mailbox/persistence errors
    (`effect-encore/dist/actor.d.ts:195-208`). Mailbox/persistence
    delivery failures _do_ propagate. They are not "silently
    dropped". 2. **`waitFor` would deadlock the existing test.**
    `"steer interject interrupts the active turn ahead of queued
follow-ups"` (`tests/runtime/session-runtime.test.ts:848`)
    submits "first" (gated, in-flight), enqueues "queued", then
    calls `steer` _before_ releasing the gated provider. With
    `send + waitFor`, `waitFor` blocks on actor-handler completion,
    but `applySteer` runs through the mailbox after `ensureStarted`
    and can sit behind the in-flight turn — the test would time out
    before `controls.emitAll(0)` ever ran. Empirically validated:
    applied, test timed out at 4s, reverted. 3. **`send` and `waitFor` give different acknowledgements; the
    right one for Interject is `send`.** `send` confirms mailbox
    enqueue + persistence; `waitFor` confirms the actor handler
    ran to completion. `applySteer` handler-stage failures
    (`ensureStarted` / `ensureTarget` / `markWrite` /
    `appendSteering` / `interruptActiveStream`,
    `agent-loop.actor.ts:861-925`) are _not_ surfaced to the
    caller through the current `ref.send` path — they propagate
    into the actor's error channel and are recovered/logged inside
    the loop, not awaited by the steer call. That is acceptable
    today because the steering outcome is observed downstream via
    state and message polling (the test asserts on
    `messageStorage.listMessages` ordering), but it is a real
    semantic gap, not a non-issue. The right follow-up, if/when
    needed, is a typed handler-completion ack on the public
    `SessionRuntime.steer` surface, not a blind switch to
    `waitFor`.

                                                                                                    Steer/Queue invariants verified:
                                                                                                    `agent-loop.state.ts:194-220` (steering drains before followUp) +
                                                                                                    `agent-loop.actor.ts:861-925` (only `applySteer` calls
                                                                                                    `interruptActiveStream`; `enqueueMessage` only appends to
                                                                                                    `queue.followUp`).

- **C8**: Convert STM-unsafe concurrent state to transactional primitives
  (L1-P1-2, P1-5, P1-6, P1-7):
  - **C8.1** `session-pubsub-registry.ts:29` — naked `Map` → `TxRef<HashMap>`
    (L1-P1-2).
  - **C8.2** `executor/controller.ts:66` — `SubscriptionRef` →
    `TxSubscriptionRef` (L1-P1-6). Inconsistent with the Wave 34 C8
    conversion in agent-loop.
  - **C8.3** `domain/file-lock.ts:29,52,63` — `Ref<Map<string, LockEntry>>`
    with manual `new Map(m)` copy → `TxRef<HashMap<string, TxSemaphore>>`
    (L1-P1-5). Eliminates the `acquireEntry`/`installEntry` double-check
    pattern (single `TxRef.modify` is already atomic).
  - **C8.4** `extensions/src/acp-agents/session-manager.ts:70-71` — twin
    naked `Map` (`sessions`, `byDriver`) mutated from concurrent fibers →
    `TxRef<HashMap<...>>` (L1-P1-7). Lands alongside C10.2 in the same file
    but is a distinct concern (concurrency safety, not yield-don't-thread).
- **C9**: Replace two hand-rolled caches with Effect natives:
  - **C9.1** `session-commands.ts:76–126` — `Ref<Map<string, Deferred>>` dedup
    → `Effect.cachedWithTTL` (L1-P1-3).
  - **C9.2** `model-registry.ts:153–193` — `Ref<Model[] | null>` cache →
    `Effect.cached` + manual `refresh` reset (L1-P1-4).
- **C10**: Close three remaining yield-don't-thread sites (L8-P1):
  - **C10.1** `runtime/file-index/native-adapter.ts:53,68,143` and
    `fallback-adapter.ts:53,54,76,77,136,137` — three private helpers and
    `makeFallbackService` / `makeNativeServiceFromModule` factories thread
    `Path.Path` / `FileSystem.FileSystem`. Make factories
    `Effect.Effect<FileIndexService, never, FS | Path>` that yield internally;
    pure helpers take string paths (`path.join`-resolved before call).
  - **C10.2** `extensions/src/acp-agents/session-manager.ts:79` + `index.ts:221`
    — `createAcpSessionManager(spawner)` → `() => Effect<AcpSessionManager,
never, ChildProcessSpawner>` that yields internally. Drop the
    `spawnerContext` closure; caller already has `ChildProcessSpawner` in scope.
  - **C10.3** `extensions/src/librarian/repo-explorer.ts:305-321` — drop the
    `files: ExtensionContextService["Files"]` parameter on `getCachePath`; use
    the existing sibling `getRepoCachePath` (line 324) or narrow to a
    `join: (...parts) => string` callback.
- **C11**: Remove dead `RequestCapability` surface (L4-P1-1):
  - **C11.1** Drop `promptSnippet` from `RequestCapability`
    (`request.ts:47`) and from `CapabilityMetadataFields`
    (`capability.ts:67`). No extension sets it on a request; only
    `tool.metadata.promptSnippet` is read at `agent-loop.utils.ts:53`.
  - **C11.2** Drop `permissionRules` from `RequestCapability`
    (`request.ts:48`). No current extension sets it on a request; permission
    rules gate tool execution, not request dispatch.
- **C12**: Remove dead `ExtensionHostContext.ReadOnlyAgent` /
  `ReadOnlySessionFacet` interfaces (L4-P1-2). Unreferenced outside their
  declaring file.
- **C13** (void — audit finding L4-P1-3 invalid): the audit asserted that the
  `Process` facet on `ExtensionProcessService` exposes a raw `runProcess`
  field bypassing the `run()` wrapper. On re-verification, the runtime
  facet (`ExtensionProcessService` in `domain/extension-services.ts:132-146`)
  exposes only `run()` (wrapped, returns `ExtensionServiceError`); the only
  `runProcess` field lives on `PublicExtensionSetupContext["Process"]` in
  `extensions/api.ts:243-247`, which is a _setup-time_ facet shaped from the
  host platform (`ExtensionHostPlatform`) and has no wrapper to bypass —
  setup happens before runtime services exist. The two facets the audit
  conflated are independent surfaces. The two adapter sites
  (`executor/platform-adapter.ts:51`, `anthropic/platform-adapter.ts:46`)
  store `runProcess` deliberately because downstream callers (e.g.
  `anthropic/oauth.ts:122`) catch `ExtensionHostProcessError` for
  keychain-specific timeout/exit-code branches that would be erased by a
  wrapped `ExtensionServiceError` channel. No change.
- **C14**: Migrate `schema-tagged-enum-class.ts` (443 lines, 45 sites) onto
  `Schema.TaggedUnion` (L1-P1-1). Split per counsel revision into 4
  sub-commits by package boundary — the helper exposes constructors, guards,
  `isAnyOf`, `match`, explicit wire tags, and runtime config errors that need
  preservation; a single 45-site commit would be review-hostile and hide
  regressions:
  - **C14.1** Introduce the replacement helper (`TaggedStruct(wireTag,
fields)` 20-line variant for the wire-tag mismatch case) and migrate the
    `schema-tagged-enum-class.test.ts` test surface onto the new API. Lock
    behavioral invariants (guards, `isAnyOf`, `match` semantics) under the
    new shape before any production migration.
  - **C14.2** Migrate core `domain/` + `runtime/` + `server/` schemas onto
    `Schema.TaggedUnion`. Largest batch — ~30 sites.
  - **C14.3** Migrate SDK + TUI schemas (`apps/tui/src/client/context.tsx`,
    `packages/sdk/src/server.ts`, etc).
  - **C14.4** Delete `domain/schema-tagged-enum-class.ts`. Run residue
    search (`rg TaggedEnumClass`); confirm zero hits outside `plans/` and
    dated audit receipts.
- **C15**: Three platform-alignment fixes (L3-P1):
  - **C15.1** `packages/core/src/runtime/log-paths.ts:27` — defer
    `performance.timeOrigin` capture into a `Clock` yield or `Effect.sync`
    inside the layer build.
  - **C15.2** `apps/tui/src/utils/client-logger.ts:18` — replace module-top
    `process.cwd()` with `GENT_CWD` env var (same pattern as `resolveLogPaths`).
  - **C15.3** `apps/tui/src/utils/client-logger.ts:25` — reuse the
    `PROCESS_START_TS` constant from `log-paths.ts` after C15.1, or document
    as Clock-bypass with explicit annotation. (Cannot yield Clock from
    synchronous shutdown path.)
- **C16**: Audit-closing commits for `domain/agent-pair.ts` follow-up and
  any tests that lock the demoted-method surfaces against regression
  (analogous to `extension-surface-locks.test.ts`).

**Out**

- L1 P2 cleanup (`connection-tracker`, `beta-cache`, `retry` schedule
  rewrite) — defer.
- L2 P2 (`ArtifactsStore` sharding readiness, `AutoController` mailbox
  serialization, mailbox-bypass reads) — sharding-readiness is a separate
  wave.
- L3 P2 (TUI Solid `solidNow()` helper, `bun:sqlite` doctor-only path) —
  defer.
- L5 P1 (encore `toLayer({ captureLayerContext })` + typed `withScope`
  helper) — `effect-encore` upstream changes; sequence as a separate wave
  per W34 C12 precedent.
- L6 file-merge candidates — separate cleanup wave.
- All P2s.

## Sub-commits

| #     | Subject                                                                  | Files                                                                        |
| ----- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| C1    | drop dead `Capability.Tool` TaggedEnum variant                           | `domain/capability.ts`, `domain/capability/tool.ts`, consumers               |
| C2    | demote `Agent.require` to pure helper                                    | host-context + facet + facade + 2 test stubs + tool consumers                |
| C3    | demote `session.estimateContextPercent` to pure helper                   | same 6 surfaces + 1 consumer in `auto/`                                      |
| C4    | demote `SessionQueries.getBranchTree` to pure helper                     | `session-queries.ts`, `rpc-handlers.ts`, expose `countMessagesByBranches`    |
| C5    | inline `SessionQueries.getSession`/`getLastSessionByCwd` null-wrap       | `session-queries.ts`, `rpc-handlers.ts`                                      |
| C6    | demote `ExtensionRegistry.getAgent`/`getModelCapability` to pure helpers | `registry.ts`, `tool-runner.ts`, `turn-helpers.ts`, `agent-loop.behavior.ts` |
| C7.1  | actor commandId in TerminateBranch/GetQueue/GetState primaryKey          | `runtime/agent/agent-loop.actor.ts`                                          |
| C7.2  | unify enqueueMessage handle-access                                       | `runtime/agent/agent-loop.actor.ts`                                          |
| C7.3  | SUPERSEDED — Steer semantics are correctly fire-forget; no change needed | —                                                                            |
| C8.1  | `session-pubsub-registry.ts` `Map` → `TxRef<HashMap>`                    | `domain/session-pubsub-registry.ts`, callers                                 |
| C8.2  | `executor/controller.ts` `SubscriptionRef` → `TxSubscriptionRef`         | `extensions/src/executor/controller.ts`                                      |
| C8.3  | `file-lock.ts` `Ref<Map>` → `TxRef<HashMap<string, TxSemaphore>>`        | `domain/file-lock.ts`                                                        |
| C8.4  | acp-agents twin Maps → `TxRef<HashMap>`                                  | `extensions/src/acp-agents/session-manager.ts`                               |
| C9.1  | `session-commands.ts` dedup → `Effect.cachedWithTTL`                     | `server/session-commands.ts`                                                 |
| C9.2  | `model-registry.ts` cache → `Effect.cached`                              | `runtime/model-registry.ts`                                                  |
| C10.1 | file-index factories yield FS/Path internally                            | `runtime/file-index/{native,fallback}-adapter.ts`                            |
| C10.2 | `createAcpSessionManager` yields `ChildProcessSpawner`                   | `extensions/src/acp-agents/{session-manager,index}.ts`                       |
| C10.3 | `librarian/repo-explorer.ts` drops Files-facet param                     | `extensions/src/librarian/repo-explorer.ts`                                  |
| C11.1 | drop `promptSnippet` from RequestCapability                              | `domain/capability/request.ts`, `domain/capability.ts`                       |
| C11.2 | drop `permissionRules` from RequestCapability                            | same + `registry.ts:376`                                                     |
| C12   | delete `ReadOnlyAgent` / `ReadOnlySessionFacet`                          | `domain/extension-host-context.ts`                                           |
| C13   | (void — audit finding L4-P1-3 invalid; see body)                         | n/a                                                                          |
| C14.1 | new helper + migrate `schema-tagged-enum-class` test surface             | new helper file, `tests/domain/schema-tagged-enum-class.test.ts`             |
| C14.2 | migrate core domain/runtime/server schemas to `Schema.TaggedUnion`       | ~30 sites in `packages/core/src/**`                                          |
| C14.3 | migrate SDK + TUI schemas to `Schema.TaggedUnion`                        | `packages/sdk/src/**`, `apps/tui/src/**`                                     |
| C14.4 | delete `domain/schema-tagged-enum-class.ts`; residue grep                | `domain/schema-tagged-enum-class.ts` (delete)                                |
| C15.1 | log-paths.ts defer performance.timeOrigin                                | `runtime/log-paths.ts`                                                       |
| C15.2 | client-logger cwd via GENT_CWD env                                       | `apps/tui/src/utils/client-logger.ts`                                        |
| C15.3 | client-logger isoNow reuses PROCESS_START_TS                             | `apps/tui/src/utils/client-logger.ts`                                        |

## Procedure

Per project memory rules:

- Run counsel on every commit's diff. Counsel test coverage advisories =
  blocking.
- One revision round per commit; counsel revise → one fixup commit, then
  move on.
- Validate regression tests catch the regression (empirically prove they
  fail when the protection is disabled).
- Pre-commit gate clean (lint+fmt + typecheck + build + test) before push.

## Final Batch: Independent Recursive Audit

Same 9 lanes as Wave 34 final batch. Run all lanes as parallel Explore
agents. Consolidate full P0/P1 punch list when all report. Close Wave 35 only
after the audit reports no P0/P1; if it finds P1s, synthesize Wave 36 and
continue.

**Scope is not a constraint.** Do not defer findings to a later wave for
ergonomic reasons (commit count, time-in-wave, "we'll catch it next time").
Correctness is preferred over scope discipline: 100 commits is fine as long
as the end state is structurally superior. The only acceptable reason to
defer a P0/P1 is genuine independent-investigation work (e.g., needs new
upstream API, unclear repro) — and such items must be written into the next
wave plan as concrete, named follow-ups, not waved off. The audit's job is
to find every P0/P1 the implementation lanes missed; this wave's job is to
close them. Both jobs run to completion before "closed" applies.

## Audit Receipts (carried from W34 final, HEAD `b589473f`)

Receipt at `plans/WAVE-34-audit-receipt.md`. All P0/P1 findings folded into
the sub-commit list above; remaining P2s deferred.

## Rejected Findings

- **L4-P0-3 (WAVE-35 audit) — scoped `request` factory in `defineExtension`.**
  Audit claimed 45 boilerplate sites of `extensionId:` could be removed by a
  closure-bound `request` factory injected via the `requests:` bucket
  callback. Investigation showed the 45 sites split across five distinct
  shapes: ~11 actual `request({...})` factory calls (some exported from
  sibling modules — `todo/requests.ts`), ~14 `new CapabilityError({...})`
  throws at execute-handler error membranes (not factory boilerplate), ~15
  hand-rolled `CapabilityRef` builder objects in protocol modules
  (`auto/protocol.ts`, `executor/protocol.ts`, `skills/protocol.ts`,
  `artifacts-protocol.ts` — typed RPC ref surfaces, not factory output), 2
  driver bucket config entries, and 3 internal service payloads. Only
  shape #1 is addressable, and even there the exported-request pattern
  preserves a real module boundary. The proposed fix would also make the
  `requests:` bucket asymmetric vs every other `FieldSpec<A, R>` bucket,
  trading a uniform authoring API for ~11 lines of save. Counsel-validated
  rejection. See `/tmp/counsel/personal-gent-860892a9/20260511-203548-claude-to-codex-80bf11/codex.md`.
