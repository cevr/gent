# Wave 34 Final Audit Receipt

- **HEAD audited:** `b589473f` (post C1-C12)
- **Date:** 2026-05-11
- **Lanes:** 9 (8 carry-forward from W32/W33 + 1 new W34 composable-primitives lane)
- **Method:** Parallel Explore agents, independent reads, consolidated below

## Verdict

**Wave 34 cannot close yet.** Audit reports 1 P0 finding (Lane 4) plus 5 strong P0 composable-method demotions (Lane 9). Wave 35 is required.

## P0 Punch List (must fix in Wave 35)

### Lane 4 — Structural

**[L4-P0-1] `ToolCapability` triple-merged shape**

- `packages/core/src/domain/capability/tool.ts:233-253`, `packages/core/src/domain/capability.ts:77-101`
- `tool()` mixes `AiTool.Any` native + `Capability.Tool` TaggedEnum variant + `GentToolMetadata` annotation. Three discrimination paths for one concept. `Capability.Tool` TaggedEnum variant is dead at runtime — all reads go through `getToolMetadata()` or the native AiTool shape. Drop `Capability.Tool` from `capability.ts`; keep brand + annotation + `GentToolMetadata`.

### Lane 9 — Composable-primitive demotions (C12 pattern)

**[L9-P0-1] `Agent.require` — 6-surface null-check wrapper**

- Files: `extension-host-context.ts:73`, `extension-services.ts:104,267`, `make-extension-host-context.ts:449-458`, 2 test stubs
- Implementation is `get(name).flatMap(a => a !== undefined ? succeed(a) : fail(...))` — pure over already-exposed `agent.get`. Already duplicates the standalone `requireAgent` helper at `registry.ts:565`. Demote to pure helper.

**[L9-P0-2] `session.estimateContextPercent` — 6-surface pure composition**

- Files: `extension-host-context.ts:66,108`, `extension-services.ts:79,253-257`, `make-extension-host-context.ts:490-497`, 2 test stubs
- Implementation is `listMessages().map(msgs => contextEstimation.estimateContextPercent(msgs, modelId))`. Both `listMessages` and the pure helper already exist. Demote.

**[L9-P0-3] `SessionQueries.getBranchTree` — pure composition over `listBranches` + `countMessagesByBranches`**

- Files: `session-queries.ts:39-42, 118-126`, `rpc-handlers.ts:315`
- `buildBranchTree` is already a pure function in `session-utils.ts`. Expose `countMessagesByBranches` on the queries surface (or call storage directly in rpc-handler) and demote.

**[L9-P0-4] `SessionQueries.getSession` / `getLastSessionByCwd` — null-wrapping pass-throughs**

- Files: `session-queries.ts:28-30, 74-86`, `rpc-handlers.ts:221, 273`
- Both are `storage.getSession(id) → undefined → null`. Either inline or convert to `Effect.map(Option.fromNullable)` over `SessionStorage`.

**[L9-P0-5] `ExtensionRegistry.getAgent` / `getModelCapability` — Map lookups wrapped in `Effect.succeed`**

- Files: `registry.ts:498, 508, 533, 545`
- `getAgent` duplicates the existing `requireAgent` standalone helper. `getModelCapability` is a Map lookup. Demote both to pure helpers over `listX()`.

## P1 Punch List (next wave or W35)

### Lane 1 — Effect simplification

- **[L1-P1-1]** `schema-tagged-enum-class.ts` (443 lines) duplicates `Schema.TaggedUnion`. Migrate 45 instantiation sites. Only `wireTag` variant differs from PascalCase; solvable with 20-line helper.
- **[L1-P1-2]** `session-pubsub-registry.ts:29` — naked `Map` mutated from concurrent fibers. `TxRef<HashMap>` required.
- **[L1-P1-3]** `session-commands.ts:76-126` — `Ref<Map<string, Deferred>>` dedup cache. Use `Effect.cachedWithTTL`.
- **[L1-P1-4]** `model-registry.ts:153-193` — `Ref<Model[] | null>` cache. Use `Effect.cached`.
- **[L1-P1-5]** `file-lock.ts:29` — `Ref<Map>` with manual copy. Use `TxRef<HashMap<string, TxSemaphore>>`.
- **[L1-P1-6]** `executor/controller.ts:66` — `SubscriptionRef` (non-transactional) while core uses `TxSubscriptionRef`. Race condition risk.
- **[L1-P1-7]** `acp-agents/session-manager.ts:70-71` — twin naked `Map`s mutated from concurrent fibers.

### Lane 2 — Actor model

- **[L2-P1-1]** `agent-loop.actor.ts:334, 343, 379` — static `primaryKey` on `TerminateBranch` / `GetQueue` / `GetState` collapses distinct intents under dedup. Include `commandId`.
- **[L2-P1-2]** `agent-loop.actor.ts:632` — `enqueueMessage` reads `handleRef` via `currentHandle` bypassing `ensureStarted`. Two callers (line 688 reentrant vs line 917 `QueueFollowUp`) inconsistent.
- **[L2-P1-3]** `session-runtime.ts:678` — `Steer` uses `ref.send` (fire-forget) but is `persisted: true`. Silent failure on delivery error. Compare line 693 `respondInteraction` which polls.

### Lane 3 — Platform alignment

- **[L3-P1-1]** `packages/core/src/runtime/log-paths.ts:27` — `performance.timeOrigin` at module top.
- **[L3-P1-2]** `apps/tui/src/utils/client-logger.ts:18` — `process.cwd()` at module top, no suppression. Use `GENT_CWD` env or `GentPlatform.cwd`.
- **[L3-P1-3]** `apps/tui/src/utils/client-logger.ts:25` — `performance.timeOrigin + performance.now()` inside `isoNow()`.

### Lane 4 — Extension minimalism

- **[L4-P1-1]** `domain/capability/request.ts:47-48` — `promptSnippet` and `permissionRules` on `RequestCapability` are dead (no consumer sets them, no path reads them via `RequestCapability`).
- **[L4-P1-2]** `domain/extension-host-context.ts:56-69` — `ReadOnlyAgent` and `ReadOnlySessionFacet` unreferenced outside file. Remove.
- **[L4-P1-3]** `domain/extension-services.ts:136-150` — `Process` facet exposes raw `runProcess` field bypassing the `run()` wrapper. Two adapters (`executor/platform-adapter.ts:51`, `anthropic/platform-adapter.ts:46`) destructure the raw field. Remove the raw field, fix callers.

### Lane 5 — Upstream DX

- **[L5-P1-1]** `effect-encore` `Actor.toLayer({ captureLayerContext })` — eliminate the manual `runtimeContext` snapshot at `actor.ts:1081-1121`, `behavior.ts:295-319`, `agent-runner.ts:787-869, 992-1033`.
- **[L5-P1-2]** `effect-encore` typed `withScope` helper for service injection from parsed entity id — eliminate 17 `withWorkspace(...)` wraps at `actor.ts:735, 785-786, 908-1057`.

### Lane 7 — Extension authoring spirit

- **[L7-P1-1]** `extensions/src/librarian/repo-explorer.ts:305-321` — `getCachePath(files: ExtensionContextService["Files"], cacheDir, spec)` threads the `Files` facet as a parameter just to call `files.join`. Use sibling `getRepoCachePath` (line 324) or narrow to `join: (...parts: string[]) => string`.

### Lane 8 — Yield-don't-thread

- **[L8-P1-1]** `runtime/file-index/native-adapter.ts:53, 68, 143` + `runtime/file-index/fallback-adapter.ts:53, 54, 76, 77, 136, 137` — three helpers + one exported factory thread `Path.Path` / `FileSystem.FileSystem`. Make factories `Effect.Effect<..., never, FS | Path>` that yield internally.
- **[L8-P1-2]** `extensions/src/acp-agents/session-manager.ts:79` + `index.ts:221` — `createAcpSessionManager(spawner: ChildProcessSpawner["Service"])` threads spawner. Make it yield `ChildProcessSpawner` internally; the call site already has it in scope.

## P2 Punch List (cleanup, defer)

### Lane 1

- **[L1-P2-8]** `connection-tracker.ts` — 27-line service wrapping `Ref<number>`. Use `Metric.gauge`.
- **[L1-P2-9]** `anthropic/beta-cache.ts:27` — `Ref<BetaCacheCell>` with `ReadonlyMap`/`Set` copies. Use `TxRef<HashMap<string, HashSet>>`.
- **[L1-P2-10]** `runtime/retry.ts:151-183` — hand-rolled `Schedule.fromStepWithMetadata`. Use `Schedule.exponential | Schedule.recurs | Schedule.jittered` composition.

### Lane 2

- **[L2-P2-1]** `artifacts/store.ts:144` + `index.ts:170` — process-scoped `Ref<ArtifactsState>` keyed by `SessionId`. Correct today, unsafe under sharding.
- **[L2-P2-2]** `auto/controller.ts:401` — concurrent `Ref.update` for state transitions, no mailbox. Single-step today, growth risk if multi-step.
- **[L2-P2-3]** `agent-loop.actor.ts:328-344` — `GetQueue`/`GetState` route reads through actor mailbox. Use `AgentLoopActor.getState(entityId)` via `ActorStateRegistry`.

### Lane 3

- **[L3-P2-4]** 5 copies of `() => performance.timeOrigin + performance.now()` in apps/tui Solid hooks/components. Shared `solidNow()` utility with comment.
- **[L3-P2-5]** `apps/tui/src/ops/local-health.ts:1, 63` — raw `bun:sqlite` Database in `gent doctor`. Doctor-only path; acceptable but unsuppressed.

### Lane 4

- **[L4-P2-1]** `domain/scheduled-job.ts:22-24` — `defineScheduledJob` is identity. Drop or grow to do real anchoring.
- **[L4-P2-2]** `ExtensionHostContext` ↔ `ExtensionContextService` 1:1 indirection at `extension-services.ts:237` — single `Effect.mapError` adapter could replace per-method `mapError` boilerplate.

### Lane 5

- **[L5-P2-1]** `effect-wide-event` outcome-tag for non-error statuses (`"ok" | "error" | "interrupted" | "partial"`).
- **[L5-P2-2]** `agent-loop.behavior.ts:672, 997, 1105` — `pendingToolCallId: Schema.String` should be `ToolCallId` branded.

### Lane 6

- **[L6-P1-1]** `packages/core/src/runtime/format-schema-error.ts` — zero importers. Delete or inline.
- **[L6-P1-2]** `extensions/src/plan-tool.ts` + `extensions/src/plan.ts` — single importer split; merge.
- **[L6-P1-3]** `extensions/src/handoff-tool.ts` + `extensions/src/handoff.ts` — same pattern; merge.
- **[L6-P1-4]** `extensions/src/acp-agents/config.ts` (29 lines, 4 sibling importers) — inline into `index.ts`.
- **[L6-P2-1]** `extensions/src/skills/protocol.ts` (39 lines, 1 external importer) — inline into `skills/index.ts`.
- **[L6-P2-2]** `packages/sdk/src/transport-headers.ts` (14 lines) — inline into `server.ts`.
- **[L6-P2-3]** `packages/core/src/runtime/extensions/disabled.ts` (37 lines, 1 importer) — inline into `profile.ts`.

## Aggregate Counts

| Severity | Count                                     |
| -------- | ----------------------------------------- |
| P0       | 6 (1 structural + 5 composable demotions) |
| P1       | ~18 (across 8 lanes)                      |
| P2       | ~14 (cleanup-tier)                        |

## Close Decision

Wave 34 **does not close**. Open Wave 35 to absorb the 6 P0s + P1s as ranked. The 5 composable-method demotions (L9) extend the C12 pattern directly and should be the spine of Wave 35.
