# Wave 38 closing 9-lane audit receipt

## Frame

- HEAD audited: `f0ce0947` (W38 spine complete: S1 trace-name
  parity, S2 SDK + Public API cleanup, S3 yield-don't-thread
  (turn-helpers), S4 composable-method demotions, S5 dead-surface
  deletion).
- Method: 9 independent Opus `general-purpose` Agent lanes against
  fresh HEAD; no cross-pollination; codex rate-limited so all
  lanes were Opus per `feedback_counsel_fallback_opus.md`.
- Disposition rule: **any P0 or P1 finding opens Wave 39. Do not
  tail-extend W38.** P2s roll into W39 ride-along bucket.

## Tally

| Lane                               | P0    | P1     | P2     |
| ---------------------------------- | ----- | ------ | ------ |
| L1 — Effect simplification         | 0     | 2      | 4      |
| L2 — Actor + wide-event boundaries | 0     | 2      | 4      |
| L3 — Schema / storage integrity    | 1     | 4      | 3      |
| L4 — Public API ceremony           | 0     | 2      | 3      |
| L5 — Test taxonomy                 | 0     | 3      | 3      |
| L6 — File cohesion                 | 0     | 5      | 3      |
| L7 — Ctx-as-param leaks            | 0     | 5      | 2      |
| L8 — Yield-don't-thread            | 0     | 5      | 3      |
| L9 — Composable-method demotions   | 0     | 2      | 5      |
| **Total**                          | **1** | **30** | **30** |

Wave 39 is needed (**1 P0**, 30 P1s). The P0 (L3-P0-1) is a
silent-data-loss path on event JSON decode — schedule first in
W39.

## W38 closure verification (claim → reality)

All 12 P1 closures from `plans/WAVE-37-audit-receipt.md` verified
clean at HEAD `f0ce0947`:

- **S1-C1 → L1-P1-1**: `GitReader` clone/fetch/listFiles/readFile
  wrapped in `Effect.fn("GitReader.<m>")` at
  `packages/extensions/src/librarian/repo-explorer.ts`. ✓
- **S1-C2 → L1-P1-2**: `ExecutorSidecar` resolveEndpoint/stop/find/
  resolveSettings wrapped in `Effect.fn("ExecutorSidecar.<m>")` at
  `packages/extensions/src/executor/sidecar.ts`. ✓
- **S1-C3 → L1-P1-3**: AgentLoop actor handlers
  (Submit/SubmitDurable/QueueFollowUp/Steer/Interrupt/
  RespondInteraction/DrainQueue/GetQueue/GetState/RecordToolResult/
  InvokeTool/TerminateBranch) wrapped in `Effect.fn("AgentLoop.<op>")`
  at `packages/core/src/runtime/agent/agent-loop.actor.ts`. ✓
- **S1-C4 → L1-P1-4**: ~17 AgentLoopBehavior state-transition
  methods wrapped (interruptActiveStream, setStartingState,
  reserveStartOrQueueFollowUp, reserveRunStartOrQueueFollowUp,
  takeNextQueuedTurnFromState, clearInFlightTurn, appendSteering,
  drainQueue, switchAgentOnState, interrupt, startTurn,
  switchAgent, respondInteraction, start, close, saveCheckpoint,
  persistRuntimeState, commitQueueTransaction). ✓
- **S2-C5 → L4-P1-1**: `GentRpcClientError` renamed to
  `GentClientRpcError` at source; SDK exports only canonical name.
  ✓
- **S2-C6 → L4-P1-2**: 14 dead exports removed from
  `@gent/core/extensions/api`; FieldSpec + DefineExtensionInput
  file-local; projection helpers internal-only. ✓
- **S3-C7 → L7-P1-1**: `executeTools` no longer threads
  `extensionRegistry` + `permission`; R-channel hoisted; call
  sites wrap with `Effect.provideService`. ✓
- **S3-C8 → L7-P1-2**: `collectTurnStream` no longer threads
  `extensionRegistry` + `permission` + `driverRegistry`. ✓
- **S3-C9 → L7-P1-3**: `finalizeTurn` no longer threads
  `extensionRegistry`. ✓
- **S4-C10 → L9-P1-1**: `SessionRuntime.getState` demoted; 6 test
  sites migrated to `actorClientFactory + entityIdOf`. ✓
- **S4-C11 → L9-P1-2**: `DriverRegistry.requireModel` +
  `requireExternal` deleted. ✓
- **S4-C12 → L9-P1-3**: `Permission.addRule` + `removeRule` +
  `getRules` deleted; PermissionService = `{ check }`. ✓
- **S4-C13 → W37-S7 carry-over**: `SessionRuntime.recordToolResult`
  demoted to actor. ✓
- **S4-C14 → W37-S7 carry-over**: `ModelRegistry.refresh` dropped
  from interface; 5 test sites use `waitFor(list, predicate)`. ✓
- **S5-C15**: `ResourceManagerService` deleted; 9 test files +
  `dependencies.ts` + `session-runtime.ts` + `ephemeral-root.ts`
  - `extension-harness.ts` purged. ✓

## P0 finding (W39 emergency-class)

### L3 — Schema / storage integrity (1 P0)

- **L3-P0-1** —
  `packages/core/src/storage/event-storage.ts:136-137, 192-193` —
  Event JSON loses tag-level decode safety: malformed rows are
  silently dropped via `Effect.option`. A corrupted or
  schema-drifted event row disappears from the stream with no
  warning. Fix: route decode failures into `Effect.logWarning`
  with `event_id` + decode error annotation, then either propagate
  a tagged decode error or drop with a counted metric. Silent
  failure on durable storage is the highest-impact bug class for
  this codebase.

## P1 findings (W39 spine candidates)

### L1 — Effect simplification (2 P1)

- **L1-P1-1** — `packages/core/src/domain/permission.ts:70-85` —
  `Permission.Live` retains an unused `Ref` after the W38-C12
  `addRule/removeRule/getRules` demotion. The Live layer is now
  pure (only `check`) so the `Layer.effect` should collapse to
  `Layer.sync` and drop the orphan ref.
- **L1-P1-2** — `packages/core/src/runtime/agent/turn-helpers.ts`
  — exported helpers (`resolveTurnContext`, `resolveTurnSource`,
  and other top-level `Effect.gen` arrows) lack `Effect.fn` trace
  names. SessionRuntime public methods skipped by the W38-S1
  trace-parity sweep. Apply `Effect.fn("TurnHelpers.<name>")` for
  each exported helper.

### L2 — Actor + wide-event boundaries (2 P1)

- **L2-P1-1** — `packages/core/src/server/rpc-handlers.ts:292-293`
  — `session.getSnapshot` RPC handler missing
  `withWideEvent(rpcBoundary(...))`. Every other actor-touching
  handler wraps; this read path (actor reanimation + multi-storage
  reads) skips observability. Pair-fix with L2-P1-2.
- **L2-P1-2** — `packages/core/src/server/rpc-handlers.ts:290` —
  `session.getTree` missing `withWideEvent(rpcBoundary(...))`. The
  underlying `getSessionTree` walks the graph with
  `concurrency: 5`; no `duration_ms`/`status`/`traceId` event
  emitted today.

### L3 — Schema / storage integrity (4 P1, plus P0 above)

- **L3-P1-1** —
  `packages/core/src/runtime/agent/agent-loop.actor.ts:91-93` —
  `WorkspaceId` brand erased at the actor payload boundary
  (`Schema.String` instead of `WorkspaceId`). Same brand-loss
  pattern W37-L3 closed for other IDs.
- **L3-P1-2** — `InteractionStorage.listPending` uses
  `Schema.decodeSync` that throws synchronously instead of
  `Schema.decodeUnknownEffect` + Effect-channel propagation.
- **L3-P1-3** — `RecordToolResult` payload `toolName` is unbranded
  `Schema.String`; should be `ToolName` brand at
  `packages/core/src/runtime/agent/agent-loop.actor.ts`.
- **L3-P1-4** — `DriverFailureRef.id` is raw `Schema.String`;
  should be branded `DriverFailureId` for traceability across the
  driver-failure surface.

### L4 — Public API ceremony (2 P1)

- **L4-P1-1** — `packages/sdk/src/index.ts:8` — `Message` type
  double-exported from `sdk/index.ts` and via `client.ts`
  re-export. Pick one.
- **L4-P1-2** — `packages/sdk/src/index.ts:39` — `GentRpcClient`
  internal transport leaked through the SDK public surface; should
  remain internal to the client implementation.

### L5 — Test taxonomy (3 P1)

- **L5-P1-1** —
  `packages/core/tests/runtime/session-runtime.test.ts` —
  `recordToolResult` dedup test dropped queue/payload assertions
  during W38-S4-C13 migration. Restore the dedup behavioral
  assertions against actor-state instead of removed runtime
  method.
- **L5-P1-2** — tests reach across the Runtime Boundary into
  `AgentLoopActor.Context` directly, violating
  `packages/core/CLAUDE.md:15-17` ("Server-facing code uses
  `SessionRuntime` only. `AgentLoop` is a runtime-internal
  implementation detail."). Audit `tests/runtime/*` for the
  pattern.
- **L5-P1-3** —
  `packages/core/tests/domain/permission.test.ts` — still uses
  method-name `describe("check")` block instead of behavioral
  naming ("missing rule denies", "matching rule allows", etc).

### L6 — File cohesion (5 P1)

- **L6-P1-1** — `packages/core/src/runtime/agent/phases/` is empty
  residue from a prior refactor; delete the directory.
- **L6-P1-2** — `packages/core/src/runtime/agent/agent-loop.behavior.ts`
  is 1332 lines mixing 5 concerns (state transitions, turn
  execution, streaming, persistence, queue management). Split.
- **L6-P1-3** — `packages/core/src/runtime/agent-runner.ts` is
  1186 lines doing 3 jobs (layer composition, prompt execution,
  result aggregation). Split.
- **L6-P1-4** — `packages/core/src/server/session-commands.ts` is
  1000 lines + carries a generic `makeRequestDeduper` utility that
  belongs in a shared location.
- **L6-P1-5** — `packages/core/src/runtime/agent/turn-helpers.ts`
  is a 775-line kitchen sink; recommend split into
  `turn-persistence` / `turn-resolve` / `turn-tool-execution` /
  `turn-pricing`.

### L7 — Ctx-as-param leaks (5 P1)

- **L7-P1-1** — `PublishEvent` callback threaded 8+ levels through
  agent-loop helpers; should be yielded inside.
- **L7-P1-2** — `ExtensionHostContext` threaded as param through
  resolve helpers; should be yielded.
- **L7-P1-3** — `PricingLookup` function extracted from
  `ModelRegistry` Tag and threaded as a pure function; lose the
  Tag context.
- **L7-P1-4** — `ToolRunner.run` takes ctx + publishEvent options;
  the publishEvent slot is the same anti-pattern as L7-P1-1.
- **L7-P1-5** — `enqueueFollowUp` callback param on
  `makeAgentLoopBehavior`; should be a service method yielded
  inside.

### L8 — Yield-don't-thread (5 P1)

- **L8-P1-1** — `resolveTurnSource` closure-captures Tags then
  re-injects via `provideService`; should yield inside the closure
  body.
- **L8-P1-2** — `runTurn` re-threads services at every helper call
  site; capture-once bag pattern (mirror W37-S8 actorContext).
- **L8-P1-3** — `ToolRunner.Live` closure-captures shape needs
  documentation; intent is correct but invisible at the call site.
- **L8-P1-4** — external-driver `runTool` runs after caller scope
  closed; services threaded through scope-crossing closure.
  Lifecycle bug latent.
- **L8-P1-5** — `PricingLookup` extraction overlap with L7-P1-3;
  pair-fix.

### L9 — Composable-method demotions (2 P1)

- **L9-P1-1** —
  `packages/core/src/runtime/session-runtime.ts:600-609` —
  `SessionRuntime.runPrompt` is a no-op double-wrap of
  `runPromptThroughActor`. Both map to `AgentRunError` (lines
  600-609 outer, 355-363 inner). Either the outer wrap is dead or
  the impl signature should be `RunPromptPayload` (the interface
  type). Two redundant error levels obscure cause chains.
- **L9-P1-2** —
  `packages/core/src/runtime/session-runtime.ts:722-726` —
  `SessionRuntime.restoreSession` is a 1-line delegation to
  `AgentLoopSessionGovernance.clearTerminated`. Only caller is
  `packages/core/src/server/session-commands.ts:153`. Caller could
  yield governance directly. Demote.

## P2 ride-along bucket (W39 ride-along, not spine)

### L1 — Effect simplification (4 P2)

- L1-P2-1: tracename gaps in extension model-driver internals
  (non-Tag arrows).
- L1-P2-2: dead `Effect.fn` wraps on helpers with single call site.
- L1-P2-3: `Effect.gen` arrows in `runtime/profile.ts` that could
  be `Effect.succeed`.
- L1-P2-4: stale comment headers referencing pre-W37 layer
  composition.

### L2 — Actor + wide-event boundaries (4 P2)

- L2-P2-1: `session.getSnapshot` silently swallows actor-state
  errors as Idle via `Effect.catchEager` — masks `AgentLoopError`
  / sharding / transport failures.
- L2-P2-2: `GetState`/`GetQueue` reanimate sleeping branches on
  every read; could short-circuit for empty branches.
- L2-P2-3: `openLoop` failed-startup leak window —
  `Ref.set(handleRef, handle)` runs before
  `handle.start.pipe(...)`; partial state visible until shutdown
  finalizer.
- L2-P2-4: `RecordToolResult` handler has no wide-event coverage;
  tests-only path today but observability gap if external drivers
  use this op.
- L2-P2-5: `Submit`/`Run`/`QueueFollowUp` share `message.id` as
  `primaryKey` across distinct op tags; correct today but fragile
  to future dedup-policy changes.

### L3 — Schema / storage integrity (3 P2)

- L3-P2-1: tag-level Schema for actor command payloads (currently
  Effect Schema struct, not TaggedUnion).
- L3-P2-2: stale comment on `decodeMessageRow` referencing W34
  pattern.
- L3-P2-3: `decodeEventRow` could decode-once into a typed view
  rather than re-decode on each downstream call.

### L4 — Public API ceremony (3 P2)

- L4-P2-1: redundant re-export pyramid `sdk/index.ts` → `sdk/client.ts`
  → `core/server/rpcs.ts` for `GentRpcsClient`.
- L4-P2-2: `ExtensionContextService` move to
  `@gent/core-internal/test-utils/` (W37 ride-along that didn't
  land in W38-S2).
- L4-P2-3: SDK README missing for current public surface.

### L5 — Test taxonomy (3 P2)

- L5-P2-1: 4 helper files in `tests/runtime/agent-loop/` with
  method-name describes.
- L5-P2-2: `tests/storage/` files duplicate fixture setup that
  belongs in `test-utils`.
- L5-P2-3: `tests/extensions/` uses inline AgentDefinition.make
  fixtures that could share a factory.

### L6 — File cohesion (3 P2)

- L6-P2-1: `packages/core/src/runtime/extensions/registry.ts` at
  618 lines is approaching split-territory; defer until concrete
  cohesion break appears.
- L6-P2-2: `packages/core/src/server/rpc-handlers.ts` at 850 lines
  has natural seams along RPC namespaces.
- L6-P2-3: `apps/tui/src/sessions/`screens duplicates atom
  glue across 5 files.

### L7 — Ctx-as-param leaks (2 P2)

- L7-P2-1: Profile-scoped registry Tag for `ResolvedSessionServices`
  (W37 deferred to W39).
- L7-P2-2: `SessionEnvironment` ctx-as-param companion (W37
  deferred).

### L8 — Yield-don't-thread (3 P2)

- L8-P2-1: capture-once `turnContext` bag mirroring W37-S8
  actorContext (W38-S3 ride-along deferred).
- L8-P2-2: `InvokeTool` handler share the bag if hoisted.
- L8-P2-3: `runTurnWorker` inner `provideService` chain could be a
  single `Layer.provideMerge`.

### L9 — Composable-method demotions (5 P2)

- L9-P2-1: `ExtensionRegistry.listExtensionStatuses` /
  `listAgents` / `listModelCapabilities` are thin pass-throughs of
  `getResolved()`. Demote in favour of `getResolved()` reads (or
  expose as plain fields for consistency with
  `extensionReactions`).
- L9-P2-2: `findAgent` / `findModelCapability` exported helpers
  have zero non-test callers; inline / delete.
- L9-P2-3: `EventPublisher.publish` is a 2-step compose of
  `append + deliver`. Three-method surface duplicates intent;
  demote one direction. `ExtensionEventSink` +
  `ExtensionStatePublisher.changed` wrap `publish` and could
  inline.
- L9-P2-4: `Permission.Live` has zero production callers
  (`profile.ts:101` builds inline). Move to `test-utils` or
  delete.
- L9-P2-5: `ExtensionRegistry.resolveToolPolicy` is a thin wrapper
  over pure `compileToolPolicy(...)` + `listModelCapabilities`.
  Single caller (`turn-helpers.ts:424`). Inline at call site.

## Wave 39 disposition

- **Spine (mandatory)**: L3-P0-1 (silent event decode), 30 P1s
  organized into S1 (storage + decode safety: L3-P0-1 + L3-P1-1/2/3/4),
  S2 (actor surface integrity: L2-P1-1/2 + L9-P1-1/2), S3
  (turn-helpers trace parity: L1-P1-2), S4 (cohesion splits:
  L6-P1-1/2/3/4/5 — likely sub-commit at design tier), S5
  (yield-don't-thread + ctx-as-param: L7-P1-1/2/3/4/5 +
  L8-P1-1/2/3/4/5), S6 (Permission.Live collapse: L1-P1-1), S7
  (SDK + test taxonomy: L4-P1-1/2 + L5-P1-1/2/3).
- **Ride-along bucket**: 30 P2s, executed opportunistically while
  spines land.
- **W38 carry-overs**: none (all 12 P1s closed; ride-alongs S7-S11
  from W38 plan rolled into W39 ride-along bucket as documented
  in W38 plan disposition rule).
