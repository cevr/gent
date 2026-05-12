# Wave 36 closing 9-lane audit receipt

## Frame

- HEAD audited: `2018fa92` (W36 spine complete: C1 rpcs collapse, C2
  ws-tracing collapse, C3 mcp-bridge Effect-native pagination, C4
  ALTER TABLE idempotency guards, C5 RPC acceptance for
  delegate+memory, C6 resource-manager Deferred gates).
- Method: 9 independent `general-purpose` Agent lanes against fresh
  HEAD; no cross-pollination; codex rate-limited so all lanes were
  Opus per `feedback_counsel_fallback_opus.md`.
- Disposition rule (W36 plan): **any P0 or P1 findings open Wave 37.
  Do not tail-extend W36.** P2s may roll into W37 or split.

## Tally

| Lane                               | P0    | P1     | P2     |
| ---------------------------------- | ----- | ------ | ------ |
| L1 — Effect simplification         | 0     | 0      | 5      |
| L2 — Actor + wide-event boundaries | 0     | 4      | 2      |
| L3 — Schema / storage integrity    | 0     | 7      | 3      |
| L4 — Public API ceremony           | 0     | 1      | 3      |
| L5 — Test taxonomy                 | 0     | 3      | 3      |
| L6 — File cohesion                 | 0     | 0      | 5      |
| L7 — Ctx-as-param leaks            | 0     | 0      | 0      |
| L8 — Yield-don't-thread            | 0     | 0      | 2      |
| L9 — Composable-method demotions   | 0     | 4      | 9      |
| **Total**                          | **0** | **19** | **32** |

Wave 37 is needed (19 P1s, no P0s). No emergency.

## P1 findings (W37 spine candidates)

### L2 — Actor + wide-event boundaries

- **L2-P1-1** — `packages/core/src/runtime/agent/agent-loop.behavior.ts:932-947`
  — `finalizeTurn` emits a hand-rolled `Effect.logInfo("wide-event")`
  but the turn body is never wrapped in `withWideEvent(turnBoundary(...))`.
  The `turnBoundary` helper at `wide-event-boundary.ts:59` is dead.
  Fix: wrap `runTurnWorker` body in `withWideEvent(turnBoundary(...))`
  and replace the hand-rolled log with `WideEvent.set({ ... })`.
- **L2-P1-2** — `packages/core/src/runtime/agent/agent-loop.actor.ts:512-519`
  — `closeBehavior` flips `closed=true` and calls `loop.close` outside
  `startupSemaphore`. Concurrent `ensureStarted` can race between the
  flag read and the close, leaking a fiber. Fix: wrap the flip + close
  in `startupSemaphore.withPermits(1)`.
- **L2-P1-3** — `packages/core/src/runtime/session-runtime.ts:652` —
  `steer` uses `ref.send(...)` (fire-and-forget) but the RPC handler
  surface implies sync completion. Failures are invisible. Fix: switch
  to `ref.execute(...)` like Submit/Run/DrainQueue, or send+waitFor like
  RespondInteraction.
  - **RESOLVED-BY-SUPERSEDE 2026-05-11 (W37-S4-C10).** The finding
    framing is wrong on three counts: (a) `ref.send` does propagate
    runtime delivery errors (the `Effect.map(discardCall, …)` keeps
    them; only statically typed `never`); (b) `Steer.Interject`
    semantics are correctly fire-forget at the handler level — caller
    needs "steering item registered," not "interjected turn ran";
    (c) switching deadlocks against the gated-turn test pattern
    (`tests/runtime/session-runtime.test.ts:847`) because `applySteer`
    yields `ensureStarted` while the in-flight turn holds the actor.
    Empirically validated twice: W35-C7.3 (commit `a8b084bc`) and
    W37-S4-C10 (2026-05-11) — both produced 4s timeout. Resolution:
    durable code comment at `session-runtime.steer` + supersede note
    in `plans/WAVE-37.md` C10.
- **L2-P1-4** — `packages/core/src/server/rpc-handlers.ts:258-415` —
  `branch.create / branch.switch / branch.fork / steer.command /
queue.drain / queue.get / interaction.respondInteraction /
session.updateReasoningLevel / session.watchRuntime / session.events`
  lack `withWideEvent(rpcBoundary(...))` while `session.delete` and
  `message.send` have them. Inconsistent tracing at the RPC edge.
  Fix: extend the existing `rpcBoundary` envelope to every state-
  mutating RPC entrypoint.

### L3 — Schema / storage integrity

- **L3-P1-1** — `packages/core/src/storage/sqlite/rows.ts:60-81` —
  `MessageRow`, `MessageChunkRow`, `EventRow` are TS interfaces, not
  Schemas. Brand fields (`MessageId`, `SessionId`, `BranchId`) are
  unchecked type assertions on read. A corrupted row silently bypasses
  brand contracts. Fix: define row Schemas and decode at the storage
  seam (mirror `SessionRow`/`BranchRow`).
- **L3-P1-2** — `packages/core/src/storage/agent-loop-queue-storage.ts:23-28`
  — `QueueRow` interface lacks runtime schema validation;
  `session_id`/`branch_id` returned via type assertion only. Same fix
  pattern as L3-P1-1.
- **L3-P1-3** — `packages/core/src/storage/relationship-storage.ts:133`
  — `row.branch_id as BranchId` raw brand cast. Symptomatic of the
  interface-not-schema row-typing issue. Fix: schema-decode the row.
- **L3-P1-4** — `packages/extensions/src/interaction-tools/ask-user.ts:4-15`
  — `parseAnswers` uses raw `JSON.parse` + runtime type guards; returns
  `string[][]` via cast. Fix: `Schema.Array(Schema.Array(Schema.String))`
  - `decodeUnknownEffect`.
- **L3-P1-5** — `packages/extensions/src/executor/sidecar.ts:257-275`
  — `parseRegistry` raw-casts `JSON.parse` output without schema
  validation; comment explicitly suppresses `preferSchemaOverJson`.
  Fix: define `SidecarRegistryFile` Schema +
  `Schema.decodeUnknownEffect(Schema.fromJsonString(...))`.
- **L3-P1-6** — `packages/core/src/runtime/session-runtime.ts:121-125`
  — `InterruptPayload` is hand-rolled `Schema.Union` of `TaggedStruct`s
  without `.pipe(Schema.toTaggedUnion("_tag"))`. Direct violation of the
  "every tagged/discriminated union uses `Schema.TaggedUnion`" rule in
  packages/core/CLAUDE.md and `feedback_tagged_enum_class.md`. Fix:
  pipe through `Schema.toTaggedUnion("_tag")`.
- **L3-P1-7** — `packages/core/src/server/errors.ts:54-66` —
  `GentRpcError` union same violation as L3-P1-6. Fix: same.

### L4 — Public API ceremony

- **L4-P1-1** — `packages/sdk/src/client.ts:105` +
  `packages/core/src/server/errors.ts:39,54` — `GentRpcError` name
  collides across two layers: the wire schema union (server) and the
  client-decoded union (SDK, which adds `RpcClientError` +
  `GentConnectionError`). Same identifier, semantically different.
  Fix: rename the SDK alias to `GentClientRpcError` (or rename the
  server-side to `GentRpcWireError`); one symbol, one meaning.

### L5 — Test taxonomy

- **L5-P1-1** — `packages/extensions/tests/{audit,counsel,research,review}/`
  — four extensions still lack `createRpcHarness` acceptance
  counterparts. Direct `runToolWithCtx` only. Fix: add one
  `*-rpc.test.ts` per extension mirroring the C5 pattern.
- **L5-P1-2** — `packages/extensions/tests/exec-tools/bash-execution.test.ts`,
  `packages/extensions/tests/interaction-tools/{ask-user,prompt}.test.ts`
  — no RPC harness counterpart for two extension groups that exercise
  interaction- and process-lifecycle surfaces (highest scope-leak
  risk). Fix: add `exec-tools-rpc.test.ts` and
  `interaction-tools-rpc.test.ts`.
- **L5-P1-3** — `packages/extensions/tests/plan-tool.test.ts`,
  `plan.test.ts`, `handoff.test.ts` — `plan` composes multiple
  subagent turns, a likely scope-leak source. Fix: add at least one
  RPC acceptance test for `plan` and `handoff`.

### L9 — Composable-method demotions

- **L9-P1-1** — `packages/core/src/runtime/extensions/registry.ts:511`
  — `ExtensionRegistry.listPromptSections` body is a single-line
  `Effect.succeed([...resolved.promptSections.values()])`; NO
  production callers (only tests). Fix: drop from interface; tests
  read `getResolved().promptSections`.
- **L9-P1-2** — `packages/core/src/runtime/extensions/registry.ts:514`
  — `ExtensionRegistry.listFailedExtensions` body is
  `Effect.succeed(resolved.failedExtensions)`; NO production callers.
  Fix: drop from interface; tests read
  `getResolved().failedExtensions`.
- **L9-P1-3** — `packages/core/src/runtime/model-registry.ts:124` —
  `ModelRegistry.refresh()` is public but has zero production callers
  (live impl self-schedules `forkScoped(refresh)`). Fix: drop from
  interface; keep internal `refresh` for the scoped fork.
- **L9-P1-4** — `packages/core/src/runtime/session-runtime.ts:218` —
  `SessionRuntime.invokeTool` on the public service contract has NO
  production caller. RPC handlers don't dispatch through it; only
  test stubs. Fix: delete from interface and impl block (line 621);
  inline the `AgentLoopActor.InvokeTool.make(...)` call at the one
  true caller in `turn-helpers.ts:727` if it still needs it.

## P2 findings (defer or roll into W37 tail)

### L1 — Effect simplification

- `runtime/extensions/driver-registry.ts:71,89,100` — Tag methods
  `filterModelCatalog / requireModel / requireExternal` should be
  wrapped in `Effect.fn("DriverRegistry.<name>")` for trace parity.
- `runtime/extensions/registry.ts:283` — `CompiledRpcRegistry.run`
  not wrapped in `Effect.fn`; wrap for cross-extension RPC trace
  visibility.
- `extensions/librarian/repo-explorer.ts:111-122,127-149` — `fetch` /
  `listFiles` mix sync work into `Effect.tryPromise`; split into
  Effect.gen + per-boundary `tryPromise`/`try` for clean attribution.
- `extensions/acp-agents/mcp-codemode.ts:196-220` — SDK boundary
  Promise-chain pyramid; convert to a single `async` arrow with
  try/catch for readability.
- `extensions/acp-agents/claude-sdk.ts:250-269` — `takeUntilResult`
  hand-rolled `.then`; convert to `async function*` for clarity.

### L2 — Actor + wide-event boundaries

- `agent-loop.behavior.ts:150,501-505,1325` — `setStartingState` is
  on the public `AgentLoopBehavior` interface, mutates `loopRef`
  directly, has zero callers. Dead surface — delete.
- `wide-event-boundary.ts:59-68` — `turnBoundary` exported but unused
  in production; either wire it (L2-P1-1) or drop.

### L3 — Schema / storage integrity

- `domain/interaction-request.ts:70` —
  `InteractionRequestRecord.type: Schema.String` accepts any string,
  but only writer uses `"approval"`. Tighten to
  `Schema.Literal("approval")`.
- `storage/search-storage.ts:24-29` — `SearchResult.sessionId` /
  `branchId` are `Schema.String` not branded. Inconsistent.
- `domain/ids.ts:42-43` — `RequestId` unbranded
  (`Schema.String.check(isMaxLength(128))`). Consider branding.

### L4 — Public API ceremony

- `core/src/server/rpcs.ts:199` + `sdk/src/client.ts:10,104` +
  `sdk/src/index.ts:40` — `GentRpcsClient = GentRpcClient` W36 C1
  alias has zero non-export consumers; delete.
- `core/src/server/errors.ts:52` — `AppServiceError = GentRpcError`
  same-shape alias used in 23 internal sites. Inline one name and
  delete the alias.
- `core/src/extensions/api.ts:229-231` — `publicSetupContext` factory
  exported in the public surface but only used by internal loader +
  tests. Drop from the API export.

### L5 — Test taxonomy

- `core/tests/runtime/agent-runner.test.ts:512` —
  `Effect.sleep("50 millis")` to outlast a 5ms timeout. Replace with
  `Deferred.await(never)` or `TestClock.adjust`.
- `extensions/tests/acp-agents/acp-invalidation.test.ts:66,92` —
  `Effect.sleep("50 millis")` inside fake child-process stdout. Gate
  on the already-created `firstWrite` Deferred.
- `core/tests/runtime/agent-loop/helpers.ts:487` — `waitFor` polling
  helper comment could discourage callers from threading more
  `Effect.sleep` outside the helper. Cosmetic.

### L6 — File cohesion

- `core/src/test-utils/reconciled-extensions.ts` (37 lines) — single
  consumer `tests/test-utils/reconciled-extensions.test.ts:5`; inline.
- `apps/tui/src/hooks/use-key-chain.ts` (35 lines) — single consumer
  `routes/session-controller.ts:39`; inline.
- `apps/tui/src/hooks/use-exit.ts` (39 lines) — single consumer
  `routes/session-controller.ts:38`; inline.
- `apps/tui/src/utils/run-with-reconnect.ts` (40 lines) — single
  consumer `hooks/use-session-feed.ts`; inline.
- `apps/tui/src/client/agent-lifecycle.ts` (33 lines) — single
  consumer `client/context.tsx`; inline reducer there.
- Side-note (not strictly L6): `apps/tui/src/utils/fuzzy-score.ts`
  (47 lines) has zero production consumers; three search sites
  define their own `fuzzyMatch` helpers. Either rewire callers or
  delete the file + test + doc reference.

### L8 — Yield-don't-thread

- `runtime/session-runtime.ts:319-330` —
  `provideActorStateServices`/`...ToStream` re-bind three Tags per
  call when they could be captured once via `Effect.context<...>()`
  - `provideContext`.
- `runtime/session-runtime.ts:491-499,670-672` —
  `redeliverPendingActorMessages` and `respondInteraction.waitFor`
  re-provide the same Tags per call; same context-capture fix.

### L9 — Composable-method demotions

- `server/session-commands.ts:575,989` —
  `SessionMutations.deleteSession` is a single-call pass-through to
  `deleteSessionCascade`, and `SessionCommands.deleteSession` is pure
  eta-expansion of `mutations.deleteSession`. Inline.
- `runtime/profile.ts:111-112` — `addRule`/`removeRule` pure
  eta-expansions of `configService.add/removePermissionRule`.
  Inline.
- `runtime/config-service.ts:65-66` — `addPermissionRule` /
  `removePermissionRule` have only test callers + the
  profile.ts eta-wrappers. Inline at the single profile call site
  or drop entirely (also see PermissionService.addRule/removeRule).
- `domain/permission.ts:65-66` — `PermissionService.addRule` /
  `removeRule` have zero production callers, only tests. Drop and
  expose `Live(initialRules)` only.
- `server/connection-tracker.ts:29` — `ConnectionTracker.Test = () =>
ConnectionTracker.Live` has zero callers; violates the CLAUDE.md
  "only add a Test layer when there's a real alternative
  implementation" rule. Delete.
- `domain/auth.ts:218` — `AuthGuard.requiredProviders` is an internal
  helper; no production callers (only tests). Drop from interface;
  keep as local `const` inside `AuthGuard.Live`.
- `runtime/make-extension-host-context.ts:439` —
  `listAgents: () => deps.extensionRegistry.listAgents()` eta-expansion.
  Replace with method reference.
- `server/rpc-handlers.ts:567` —
  `queueFollowUp: (input) => sessionRuntime.queueFollowUp(input)` eta-
  expansion. Replace with method reference.
- `domain/event-publisher.ts:18-20` — `ExtensionEventSinkService.publish`
  body is `publisher.publish`; no production yields of
  `ExtensionEventSink`. Delete the Tag; callers yield `EventPublisher`
  directly.

## Disposition

- **Wave 37** opens for the 17 P1 findings above. Spine should
  cluster:
  - Storage row schemas (L3-P1-1/-2/-3) — biggest correctness win.
  - Wide-event coverage (L2-P1-1 + L2-P1-4) — observability gap.
  - Actor/runtime correctness (L2-P1-2 closeBehavior race, L2-P1-3
    steer failure invisibility).
  - JSON parse hardening (L3-P1-4 ask-user, L3-P1-5 sidecar
    registry).
  - Public surface (L4-P1-1 GentRpcError collision, L3-P1-6/-7
    `Schema.toTaggedUnion` invariant violations).
  - Test taxonomy backfill (L5-P1-1/-2/-3, 6 new harness tests).
  - Composable-method demotions (L9-P1-1/-2/-3/-4, four dead-surface
    drops).
- P2s (34 items) — disposition is W37's call; many naturally
  cluster with the P1 they accompany (e.g. L3-P2 schema-tagging
  ride-along with L3-P1 row schemas, L2-P2-1 setStartingState
  delete + L2-P2-2 turnBoundary tidy with the L2-P1-1 wide-event
  fix).
- Durable rule restated for the next wave: **the closing audit of
  a wave that produces P0/P1 findings opens the next wave; do not
  tail-extend.** This is the second consecutive wave to honor it
  (W35 closing audit triggered W36; W36 closing audit triggers
  W37).
