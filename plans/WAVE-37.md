# Wave 37 — W36 closing audit P1 closure

## Frame

- **Source**: `plans/WAVE-36-audit-receipt.md` (HEAD `73aefb8f`). W36
  closing 9-lane audit produced 0 P0, 19 P1, 32 P2.
- **Durable rule**: closing audit P0/P1 → next wave; **do not
  tail-extend.** W37 closes the 19 P1s (and ride-along P2s where
  natural).
- **Method**: counsel after every batch via Opus Agent fallback (codex
  still rate-limited per `feedback_counsel_fallback_opus.md`); one
  revision round per commit; final closing 9-lane audit on the
  resulting HEAD.
- **No external users.** No shims, no parallel APIs, no deprecation
  cycles.

## Spine (7 sub-spines, 19 P1 + ~12 P2 ride-alongs)

### S1 — Storage row schemas (3 P1 + 3 P2 ride-along)

Biggest correctness win. Mirror `BranchRow`/`SessionRow` pattern.

- **C1** — Row Schemas for `MessageRow`, `MessageChunkRow`, `EventRow`
  at `packages/core/src/storage/sqlite/rows.ts:60-81`. Decode at the
  storage seam. (L3-P1-1)
- **C2** — Row Schema for `QueueRow` at
  `packages/core/src/storage/agent-loop-queue-storage.ts:23-28`.
  (L3-P1-2)
- **C3** — Schema-decode in `relationship-storage.ts:133` instead of
  `as BranchId` raw cast. (L3-P1-3)
- **C3.5** — Ride-along P2s: brand `SearchResult.sessionId/branchId`
  (`storage/search-storage.ts:24-29`), tighten
  `InteractionRequestRecord.type` to `Schema.Literal("approval")`
  (`domain/interaction-request.ts:70`), and (optionally) brand
  `RequestId` (`domain/ids.ts:42-43`).

### S2 — TaggedUnion invariant + public surface (3 P1 + 3 P2 ride-along)

The W36 audit reclassified the two `Schema.toTaggedUnion` violations
as P1 because they directly violate documented invariants.

- **C4** — `InterruptPayload` in `session-runtime.ts:121-125` →
  `.pipe(Schema.toTaggedUnion("_tag"))`. (L3-P1-6)
- **C5** — `GentRpcError` union in `server/errors.ts:54-66` → same.
  (L3-P1-7)
- **C6** — Resolve `GentRpcError` name collision: rename SDK alias
  in `packages/sdk/src/client.ts:105` to `GentClientRpcError`. Update
  the 23 internal sites and the `AppServiceError` alias at
  `core/src/server/errors.ts:52` so one symbol = one meaning.
  (L4-P1-1 + L4-P2-2 ride-along)
- **C6.5** — Ride-along P2s: delete dead `GentRpcsClient =
GentRpcClient` alias (`core/src/server/rpcs.ts:199` +
  `sdk/src/{client.ts:10,104,index.ts:40}`); drop `publicSetupContext`
  from public api (`core/src/extensions/api.ts:229-231`).

### S3 — Wide-event coverage (2 P1 + 1 P2 ride-along)

Observability gap.

- **C7** — Wrap `runTurnWorker` body in
  `withWideEvent(turnBoundary(...))` and replace the hand-rolled
  `Effect.logInfo("wide-event")` at
  `agent-loop.behavior.ts:932-947` with `WideEvent.set({...})`. Wires
  the dead `turnBoundary` helper at
  `wide-event-boundary.ts:59`. (L2-P1-1 + L2-P2-2 ride-along)
- **C8** — Extend `withWideEvent(rpcBoundary(...))` to every state-
  mutating RPC entrypoint in `server/rpc-handlers.ts:258-415`
  (`branch.create/switch/fork`, `steer.command`,
  `queue.drain/get`, `interaction.respondInteraction`,
  `session.updateReasoningLevel/watchRuntime/events`). (L2-P1-4)

### S4 — Actor + runtime correctness (2 P1)

- **C9** — Wrap `closeBehavior` flip + close in
  `startupSemaphore.withPermits(1)` at
  `agent-loop.actor.ts:512-519`. (L2-P1-2)
- **C10 — SUPERSEDED (dropped 2026-05-11).** Empirically the same as
  the previously-superseded W35-C7.3. The L2-P1-3 audit finding
  ("Persisted fire-forget silently drops delivery errors") is wrong:
  (a) `ref.send` is `Effect.map(discardCall, …)` — runtime delivery
  errors _do_ propagate (they're only statically typed `never`); and
  (b) `Steer.Interject` semantics are correctly fire-forget at the
  handler level — the caller needs to know the steering item was
  _registered_ (handler-completion via `send` proves that), not that
  the interjected turn has _run_. A `send + waitFor` (or `ref.execute`
  on the persisted Steer) switch deadlocks against the gated-turn
  pattern used by `"steer interject interrupts the active turn ahead
of queued follow-ups"`
  (`tests/runtime/session-runtime.test.ts:847`) because the waiter
  blocks on handler completion which can't fire until the in-flight
  turn releases. Re-validated empirically 2026-05-11 (W37-S4-C10):
  applied, test timed out at 4s, reverted. See commit `a8b084bc` for
  the original W35-C7.3 investigation; this re-derivation adds a code
  comment at the `session-runtime.steer` call site so future audits
  don't relitigate the call.

### S5 — JSON parse hardening (2 P1)

- **C11** — `parseAnswers` in
  `extensions/src/interaction-tools/ask-user.ts:4-15` →
  `Schema.Array(Schema.Array(Schema.String))` +
  `decodeUnknownEffect`. (L3-P1-4)
- **C12** — `parseRegistry` in `extensions/src/executor/sidecar.ts:257-275`
  → define `SidecarRegistryFile` Schema +
  `Schema.decodeUnknownEffect(Schema.fromJsonString(...))`. Remove
  the `preferSchemaOverJson` suppression. (L3-P1-5)

### S6 — Test taxonomy backfill (3 P1, 6 new harness tests)

All via the C5 RPC acceptance pattern (`createRpcHarness` + sequence
provider + Stream filter on `ToolCallSucceeded`).

- **C13** — `audit-rpc.test.ts`, `counsel-rpc.test.ts`,
  `research-rpc.test.ts`, `review-rpc.test.ts` in
  `packages/extensions/tests/{audit,counsel,research,review}/`.
  (L5-P1-1, 4 files)
- **C14** — `exec-tools-rpc.test.ts` (covers `bash`) and
  `interaction-tools-rpc.test.ts` (covers `ask-user` + `prompt`).
  Highest scope-leak risk. (L5-P1-2, 2 files)
- **C15** — `plan-rpc.test.ts` + `handoff-rpc.test.ts` in
  `packages/extensions/tests/`. `plan` composes multiple subagent
  turns — likely scope-leak source. (L5-P1-3, 2 files)
- **C15.5** — Ride-along P2: replace `Effect.sleep("50 millis")`
  proxies in `core/tests/runtime/agent-runner.test.ts:512` and
  `extensions/tests/acp-agents/acp-invalidation.test.ts:66,92` with
  Deferred gates. Cosmetic cleanup of
  `core/tests/runtime/agent-loop/helpers.ts:487` comment.

### S7 — Composable-method demotions (4 P1 + 5 P2 ride-along)

Same demotion pattern as W35 C2-C6.

- **C16** — Drop `ExtensionRegistry.listPromptSections` from
  interface (`registry.ts:511`); tests read
  `getResolved().promptSections`. (L9-P1-1)
- **C17** — Drop `ExtensionRegistry.listFailedExtensions` from
  interface (`registry.ts:514`); tests read
  `getResolved().failedExtensions`. (L9-P1-2)
- **C18** — Drop `ModelRegistry.refresh()` from interface
  (`model-registry.ts:124`); keep internal `refresh` for the scoped
  fork. (L9-P1-3)
- **C19** — Delete `SessionRuntime.invokeTool` from interface +
  impl (`session-runtime.ts:218, 621`); inline the
  `AgentLoopActor.InvokeTool.make(...)` call at
  `turn-helpers.ts:727` if still needed. (L9-P1-4)
- **C19.5** — Ride-along P2s: inline
  `SessionMutations.deleteSession` and `SessionCommands.deleteSession`
  (`server/session-commands.ts:575,989`); inline `profile.ts`
  `addRule/removeRule` eta-expansions (`runtime/profile.ts:111-112`);
  drop `PermissionService.addRule/removeRule` if no remaining prod
  callers (`domain/permission.ts:65-66`); delete
  `ConnectionTracker.Test` (`server/connection-tracker.ts:29`); drop
  `AuthGuard.requiredProviders` from interface
  (`domain/auth.ts:218`); delete `ExtensionEventSinkService.publish`
  Tag in favor of yielding `EventPublisher` directly
  (`domain/event-publisher.ts:18-20`); replace eta-wrappers in
  `make-extension-host-context.ts:439` and
  `server/rpc-handlers.ts:567` with method references.

### S8 — Yield-don't-thread polish (0 P1 + 2 P2 ride-along)

Optional polish, may roll into a later micro-batch.

- **C20** — Capture-once context bind for
  `provideActorStateServices`/`...ToStream` (`session-runtime.ts:319-330`)
  and `redeliverPendingActorMessages` /
  `respondInteraction.waitFor` (`session-runtime.ts:491-499,670-672`).
  (L8-P2-1/-2)

### S9 — L1 trace-name parity (0 P1 + 5 P2 ride-along, optional)

- **C21** — Wrap `DriverRegistry`,
  `CompiledRpcRegistry.run`, and the
  `librarian/repo-explorer`, `acp-agents/mcp-codemode`, and
  `acp-agents/claude-sdk` Promise-pyramids in `Effect.fn` /
  `async function*` for clean trace attribution. Defer if time
  pressure — pure DX. (L1-P2 cluster)

### S10 — File cohesion (0 P1 + 5 P2 ride-along, optional)

- **C22** — Inline single-consumer helpers per the receipt L6
  cluster (`reconciled-extensions.ts`,
  `apps/tui/src/hooks/use-key-chain.ts`,
  `apps/tui/src/hooks/use-exit.ts`,
  `apps/tui/src/utils/run-with-reconnect.ts`,
  `apps/tui/src/client/agent-lifecycle.ts`). Decide:
  delete-or-rewire `apps/tui/src/utils/fuzzy-score.ts` (3 callers
  duplicate `fuzzyMatch`). Defer if low-value.

## Closing audit

- **C∞** — After all P1 commits land + gate is green: closing 9-lane
  audit (same lane definitions as W36). Apply the durable rule again:
  P0/P1 → Wave 38; do not tail-extend W37.

## Ordering rationale

1. **S1 first** — row Schemas. Largest correctness blast radius, used
   by everything downstream. If we land row schemas before C19's
   `invokeTool` drop, we catch any contract drift via decode errors.
2. **S2 next** — `Schema.toTaggedUnion` is a one-line fix per union;
   `GentRpcError` rename touches 23 sites but is mechanical (delegate
   to general-purpose Agent per "smartest model designs, weaker
   applies").
3. **S3 + S4** — observability and runtime correctness. C7 (turn
   wide-event) gates trace correctness for the rest of the wave.
4. **S5** — JSON parse hardening; independent of other spines.
5. **S6** — test taxonomy backfill; depends on no other spine but
   should land before the closing audit so harness coverage is in
   place when we re-audit L5.
6. **S7** — interface demotions. Last because they touch tests we
   may add in S6.
7. **S8–S10** — optional. Skip if time-pressured.

## Counsel cadence

- After every batch (S1, S2, S3, S4, S5, S6, S7) → Opus Agent
  fallback review (codex rate-limited until further notice).
- One revision round per commit (`feedback_one_revision_per_commit`).
- No mid-spine reframing without explicit user input.
