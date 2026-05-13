# Wave 39 plan

## Frame

- **Source**: closes 1 P0 + 30 P1 from
  `plans/WAVE-38-audit-receipt.md`.
- **HEAD start**: `f0ce0947` (W38 spine close).
- **Rule**: Sub-commit per spine; counsel after each commit via Opus
  Agent fallback (codex rate-limited); one revision round per
  commit; gate between batches.
- **P2 bucket**: 30 items roll into W39 as opportunistic ride-alongs
  (pick up within spines that touch the same files; do not let P2
  sweeps inflate the diff).
- **P0 first**: L3-P0-1 (event JSON silent decode failure) lands
  in S1-C1 before any other work. Silent durable-storage failure
  is the highest-impact bug class in this codebase.

## Spines

### S1 — Storage + decode safety (L3 P0 + P1 cluster)

Closes L3-P0-1, L3-P1-1, L3-P1-2, L3-P1-3, L3-P1-4. Highest
priority: P0 lands first.

- **C1** (P0): Route event JSON decode failures through observable
  channel at
  `packages/core/src/storage/event-storage.ts:136-137, 192-193`.
  Replace `Effect.option` swallow with
  `Effect.tapErrorCause(cause => Effect.logWarning("event decode failed").pipe(Effect.annotateLogs({ event_id, error: String(cause) })))`
  then propagate a tagged `EventDecodeError` (new
  `Schema.TaggedErrorClass`). Silent drops become loud warnings;
  decoder bugs surface in logs.
- **C2**: Brand `WorkspaceId` at actor payload boundary at
  `packages/core/src/runtime/agent/agent-loop.actor.ts:91-93`.
  Replace `Schema.String` with `WorkspaceId` brand on payload
  schemas. Same pattern W37-L3 used for other branded IDs.
- **C3**: Replace `Schema.decodeSync` throw with
  `Schema.decodeUnknownEffect` at
  `InteractionStorage.listPending`. Failures propagate via Effect
  error channel.
- **C4**: Brand `RecordToolResult.toolName` as `ToolName` and
  `DriverFailureRef.id` as `DriverFailureId` (new brand). Two-line
  schema updates + propagate brand through callers.
- **P2 ride-alongs**: L3-P2-1 (actor command payload TaggedUnion),
  L3-P2-3 (decode-once `decodeEventRow`).

### S2 — Actor surface integrity (L2 + L9 P1 cluster)

Closes L2-P1-1, L2-P1-2, L9-P1-1, L9-P1-2.

- **C5**: Wrap `session.getSnapshot` and `session.getTree` RPC
  handlers in `withWideEvent(rpcBoundary(...))` at
  `packages/core/src/server/rpc-handlers.ts:290, 292-293`. Pair-fix
  — both reach actor + multi-storage and miss observability.
- **C6**: Demote `SessionRuntime.runPrompt` double-wrap at
  `packages/core/src/runtime/session-runtime.ts:600-609`. Drop the
  outer `AgentRunError` re-wrap; `runPromptThroughActor` already
  maps at 355-363. Two redundant error levels collapse to one.
- **C7**: Demote `SessionRuntime.restoreSession` at
  `session-runtime.ts:722-726`. Single caller at
  `session-commands.ts:153` yields `AgentLoopSessionGovernance`
  directly. Delete the wrapper.
- **P2 ride-alongs**: L2-P2-1 (`getSnapshot` swallows actor errors
  as Idle — split tag handling), L2-P2-2 (`GetState`/`GetQueue`
  short-circuit for empty branches), L9-P2-1
  (`ExtensionRegistry.listExtensionStatuses` /
  `listAgents` / `listModelCapabilities` → field reads).

### S3 — Turn-helpers trace parity (L1-P1-2)

Closes L1-P1-2.

- **C8**: Wrap exported helpers in
  `packages/core/src/runtime/agent/turn-helpers.ts` in
  `Effect.fn("TurnHelpers.<name>")`. Targets: `resolveTurnContext`,
  `resolveTurnSource`, `executeToolCalls`, `recordToolResult`,
  `applyPricing`, and any other top-level `Effect.gen` arrows.
- **P2 ride-alongs**: L1-P2-2 (dead `Effect.fn` wraps in same
  file).

### S4 — File cohesion splits (L6 P1 cluster)

Closes L6-P1-1, L6-P1-2, L6-P1-3, L6-P1-4, L6-P1-5. **High
blast-radius** per `~/.brain/principles`: sub-commit per file.

- **C9**: Delete empty `packages/core/src/runtime/agent/phases/`
  directory.
- **C10**: Split
  `packages/core/src/runtime/agent/agent-loop.behavior.ts` (1332
  lines, 5 concerns). Counsel-validated split before applying:
  proposed → `agent-loop.behavior.ts` (state transitions),
  `agent-loop.turn-execution.ts`, `agent-loop.streaming.ts`,
  `agent-loop.persistence.ts`, `agent-loop.queue.ts`.
- **C11**: Split `packages/core/src/runtime/agent-runner.ts`
  (1186 lines, 3 jobs). Proposed → `agent-runner.layer.ts`
  (composition), `agent-runner.prompt.ts` (execution),
  `agent-runner.aggregate.ts` (result aggregation).
- **C12**: Split `packages/core/src/server/session-commands.ts`
  (1000 lines). Extract `makeRequestDeduper` to
  `packages/core/src/runtime/request-dedup.ts`; split commands by
  namespace.
- **C13**: Split `packages/core/src/runtime/agent/turn-helpers.ts`
  (775-line kitchen sink) into `turn-persistence.ts` /
  `turn-resolve.ts` / `turn-tool-execution.ts` /
  `turn-pricing.ts`. Apply AFTER S3-C8 to avoid double-rework.
- **P2 ride-alongs**: L6-P2-2
  (`packages/core/src/server/rpc-handlers.ts` namespace split —
  defer if S4 already heavy).

### S5 — Ctx-as-param + yield-don't-thread (L7 + L8 cluster)

Closes L7-P1-1, L7-P1-2, L7-P1-3, L7-P1-4, L7-P1-5, L8-P1-1,
L8-P1-2, L8-P1-3, L8-P1-4, L8-P1-5. 10 P1s, all the same
anti-pattern. **High blast-radius** — counsel before applying;
sub-commit per service.

- **C14**: Drop `PublishEvent` callback threading; yield
  `EventPublisher` inside. Touches 8+ levels in agent-loop +
  turn-helpers + tool-runner. Pair-fix with L7-P1-4
  (`ToolRunner.run` publishEvent option).
- **C15**: Drop `ExtensionHostContext` param threading; yield
  inside resolve helpers.
- **C16**: Drop `PricingLookup` function extraction at agent-loop
  / turn-helpers; yield `ModelRegistry` inside. Pair-fix with
  L8-P1-5.
- **C17**: Drop `enqueueFollowUp` callback param on
  `makeAgentLoopBehavior`; yield a follow-up service inside.
- **C18**: Yield-fix `resolveTurnSource` — drop closure-captured
  Tags + re-injection via `provideService`; yield directly inside
  closure body.
- **C19**: Capture-once `turnContext` bag for `runTurn` (mirror
  W37-S8 actorContext pattern). Closes L8-P1-2; sets up L8-P2-1
  ride-along (`InvokeTool` handler shares the bag).
- **C20**: Fix external-driver `runTool` scope-crossing closure at
  L8-P1-4. Services must be yielded within the per-tool scope,
  not captured from the parent.
- **P2 ride-alongs**: L8-P2-1 (`InvokeTool` shares the C19 bag),
  L7-P2-1 / L7-P2-2 (Profile-scoped registry Tag for
  `ResolvedSessionServices` + `SessionEnvironment` — W37 carry-
  over; defer if S5 already heavy).

### S6 — Permission.Live collapse (L1-P1-1)

Closes L1-P1-1.

- **C21**: Collapse `packages/core/src/domain/permission.ts:70-85`
  from `Layer.effect` to `Layer.sync`. Drop the orphan `Ref` (now
  unused after W38-C12 `addRule/removeRule/getRules` demotion).
  PermissionService is `{ check }` — pure.
- **P2 ride-alongs**: L9-P2-4 (`Permission.Live` has zero
  production callers — move to `test-utils` or delete entirely
  after C21 confirms pure shape).

### S7 — SDK + Test taxonomy (L4 + L5 cluster)

Closes L4-P1-1, L4-P1-2, L5-P1-1, L5-P1-2, L5-P1-3.

- **C22**: Drop duplicate `Message` export at
  `packages/sdk/src/index.ts:8`; keep single source via
  `client.ts` re-export.
- **C23**: Remove `GentRpcClient` internal transport leak at
  `packages/sdk/src/index.ts:39`. Move to internal-only path.
- **C24**: Restore `recordToolResult` dedup test behavioral
  assertions against actor-state at
  `packages/core/tests/runtime/session-runtime.test.ts` (W38-S4-C13
  dropped queue/payload assertions during method-demotion
  migration).
- **C25**: Audit `packages/core/tests/runtime/*` for direct
  `AgentLoopActor.Context` access violating Runtime Boundary
  (`packages/core/CLAUDE.md:15-17`). Migrate violations to
  `SessionCommands` / `SessionQueries`. Tests that genuinely need
  actor internals stay in `tests/runtime/agent-loop/`.
- **C26**: Rename `describe("check")` block to behavioral naming
  at `packages/core/tests/domain/permission.test.ts` ("missing
  rule denies", "matching rule allows", etc).
- **P2 ride-alongs**: L5-P2-1 (4 helper files in
  `tests/runtime/agent-loop/` with method-name describes — same
  rename pattern as C26), L4-P2-2 (`ExtensionContextService` move
  to `@gent/core-internal/test-utils/` — W38 ride-along that
  didn't land).

## Optional spines (defer if scope inflates)

### S8 — Composable-method demotion ride-along (L9 P2 cluster)

Roll into S2 if surface stays small; otherwise defer to W40.

- L9-P2-1: `ExtensionRegistry.listExtensionStatuses` /
  `listAgents` / `listModelCapabilities` → `getResolved()` reads.
- L9-P2-2: `findAgent` / `findModelCapability` inline / delete.
- L9-P2-3: `EventPublisher.publish` collapse (demote one direction
  of `append + deliver`).
- L9-P2-5: `ExtensionRegistry.resolveToolPolicy` inline at
  `turn-helpers.ts:424`.

### S9 — Wide-event spread to remaining read paths (L2 P2)

- L2-P2-4: `RecordToolResult` handler wide-event coverage.
- L2-P2-5: tag-prefixed primary keys for actor dedup.

### S10 — Storage decode polish (L3 P2)

- L3-P2-1: actor command payload TaggedUnion migration.
- L3-P2-3: decode-once `decodeEventRow`.

### S11 — Actor lifecycle hardening (L2 P2-3)

- L2-P2-3: `openLoop` failed-startup leak window — wrap
  post-handleRef-set in `Effect.onError(cleanupLoop)`.

## Counsel cadence

After each commit:

1. Run gate (typecheck + lint + fmt + build + test).
2. Counsel via Opus Agent fallback (codex rate-limited).
3. If counsel returns `revise`: one fixup commit. If `block`:
   revisit design.
4. Update `memory/project_w39_status.md` per spine completion.

**Counsel before sub-commit splits**: S4-C10 (behavior.ts split),
S4-C11 (agent-runner.ts split), S4-C13 (turn-helpers split), S5-C14
through S5-C20 (10-P1 yield-don't-thread cluster). Design-tier
work; do not delegate.

## Closing audit (final batch)

After S7 lands and gate is clean at W39 HEAD, run the same 9-lane
audit pattern used to close W37 and W38. Identical scope per lane;
do not vary prompts across waves.

- **L1 — Effect simplification**: `Effect.fn` trace-name gaps,
  `Effect.gen` arrows that could be `Effect.succeed`,
  dead/redundant Effect wraps.
- **L2 — Actor + wide-event boundaries**:
  `withWideEvent(rpcBoundary(...))` coverage on new/changed RPC
  handlers, actor handler trace wraps, race conditions,
  `Effect.forkScoped` vs `Effect.fork` mistakes, entityIdOf
  argument mismatches.
- **L3 — Schema / storage integrity**: row Schemas, decode
  safety (no `Schema.decodeSync` throws), brand erasure at
  boundaries, TaggedUnion vs hand-rolled `_tag` literals,
  `Effect.option` silent drops on durable storage.
- **L4 — Public API ceremony**: dead exports from
  `@gent/core/extensions/api` + `@gent/sdk`, parallel API names,
  double-exports, internal transports leaked through public
  surface.
- **L5 — Test taxonomy**: behavioral describe naming (not method
  names), Runtime Boundary respect (`packages/core/CLAUDE.md`
  rules), RPC acceptance coverage for new extension surface,
  `Effect.sleep` proxies for state transitions.
- **L6 — File cohesion**: files >700 lines mixing concerns, empty
  residue directories, generic utilities living in
  feature-specific files.
- **L7 — Ctx-as-param leaks**: service Tags / facades threaded as
  function parameters, callbacks for what should be service
  methods, registry Tags scoped wrong.
- **L8 — Yield-don't-thread**: closure-captured Tags then
  re-injected via `provideService`, services threaded through
  scope-crossing closures, helper call sites re-threading what
  the caller already yielded.
- **L9 — Composable-method demotions**: service interface methods
  that thin-wrap other public methods or actor commands, helpers
  with zero non-test callers, pure functions masquerading as
  service methods.

Each lane: independent Opus `general-purpose` Agent against fresh
HEAD; no cross-pollination; cap at 6-8 findings; severity-prefixed
(P0/P1/P2); file:line citations for every claim.

Lanes that complete report findings back here. When all 9 return,
write `plans/WAVE-39-audit-receipt.md` using the W37/W38 template
(Frame → Tally table → W39 closure verification → P0 findings →
P1 findings by lane → P2 ride-along bucket → Wave 40 disposition).

## Disposition rule

P0/P1 findings from the W39 closing audit will open Wave 40. Do
not tail-extend W39. P2s roll into W40 ride-along bucket.
