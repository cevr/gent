# W10-1b — auto extension: actor migration recipe

**Status:** design — execution in progress
**Predecessor:** W10-1a (handoff cooldown actor)
**Successors:** W10-1c (executor), W10-1d (apply-tier 4 stores), W10-3d (rpc bucket)

## Why this is a separate sub-commit

Auto is the first **genuine multi-state machine** to migrate. Handoff (W10-1a)
was a single integer counter; auto is `Inactive | Working | AwaitingReview` with
8 transitions, replies, replay, and after-transition side effects. The plan
calls W10-1b "design-tier — establishes the recipe for genuine machines".

## Design decision: hand-rolled FSM inside `receive`

The W10 plan text says "`effect-machine` inside `Behavior`". Three options
were considered:

1. **Nest `Machine.spawn` inside the actor lifecycle.** Rejected: `Behavior`
   has no per-actor `init`/`scope` hook to hold a long-lived `MachineRef`,
   and adding one is W9-engine surgery outside W10-1b's scope. Also creates
   dual-actor-system ownership (effect-machine actor + our actor for the
   same logical entity) — a `make-impossible-states-unrepresentable`
   violation.
2. **Use `executeTransition` / `findTransitions` from effect-machine inside
   `receive`.** Rejected: those are `@internal` — the only public sync
   transition primitive is `Machine.spawn`. Reaching into internals locks
   us to today's effect-machine internals.
3. **Hand-roll a switch-on-(state.\_tag, msg.\_tag) FSM inside `receive`.**
   **Adopted.** This is what `effect-machine` itself compiles to. The
   transition table is finite (8 entries) and the switch is exhaustive by
   `TaggedEnumClass`. We lose the declarative `.on(Inactive, StartAuto, ...)`
   builder syntax but gain a single source of truth and a clean fit with
   `Behavior<M, S, never>`.

This choice is the recipe W10-1c (executor) and W10-1d apply-tier replays.
W10-2 then folds `view(state)` projections, and W10-3d/W10-4 lift
ExtensionMessage routing to actor messages so we can delete the legacy
`mapCommand`/`mapRequest`/`mapEvent` plumbing on the Resource shell.

## Surface mapping

### Actor identity

- `AutoMsg = TaggedEnumClass(...)` covering: `StartAuto`, `CancelAuto`,
  `AutoSignal`, `RequestHandoff`, `ReviewSignal`, `TurnCompleted`,
  `IsActive` (reply Boolean), `GetSnapshot` (reply AutoSnapshotReply).
- `AutoState = TaggedEnumClass({ Inactive, Working, AwaitingReview })` —
  identical fields to today's `MachineState`.
- `AutoService = ServiceKey<AutoMsg>("@gent/auto/workflow")`.

### What `receive` does

For each `(state._tag, msg._tag)` pair: produce next `AutoState` (and call
`ctx.reply` for IsActive/GetSnapshot). Pure function-of-(state, msg) shape;
side effects are computed _after_ the state transition, see "afterTransition"
below.

### afterTransition (QueueFollowUp side effects)

Today's `afterTransition` returns `Array<{ _tag: "QueueFollowUp", ... }>` and
the Resource runtime drains those into `runEffects(...)` which calls the
SessionMutationService to enqueue follow-up messages.

In the actor world, `receive` returns just `S`. So the recipe is:

1. After computing `nextState`, compute the same `Array<QueueFollowUp>`
   in-line.
2. Resolve the `SessionMutationService` directly via
   `ctx.actors.find(SessionMutationService)` if it has been migrated, OR
   keep a thin shim that uses `ExtensionHostContext`'s session mutation
   surface during the W10-4 transition.

Path of least friction for THIS commit: keep `runEffects` running through
the existing Resource shell's host context. We expose a small
`SessionMutationFacet` ServiceKey (registered by the runtime) that the auto
behavior `find`s. If that facet doesn't exist yet at this commit, we leave
the `runtime.toolResult` slot to drive the journal interceptor and have the
auto actor send a synthetic `QueueFollowUp` message to a dedicated relay
behavior — TBD when implementing.

For W10-1b the simplest concrete shape: lift the `runEffects` work onto the
**slot handler** (`autoHandoffImpl`/`journalInterceptorImpl`) layer that
already has `ExtensionHostContext` in scope. The actor receives `TurnCompleted`,
recomputes the FSM, and returns its new state. The slot handler — which is
what observes turn boundaries today via `runtime.turnAfter` — then calls
`ctx.actors.ask(autoRef, GetSnapshot)`, derives any pending follow-up, and
enqueues it through `ctx.session.*`. This keeps the side-effect boundary
where it already lives (slot handler) and avoids adding a new actor channel.
The effect transition logic is preserved bit-for-bit.

### Replay (onInit)

Today's `onInit` reads the journal slot, validates ancestry, and sends a
sequence of events into the machine. In the actor world there is no `onInit`
hook on `Behavior`. The recipe:

- Have the slot handler that owns the AutoJournal layer (the same Resource
  that exists today — kept for its `turnAfter` slot until W10-5) drive
  replay at extension start by sending messages to the actor:
  `find(AutoService) → tell(StartAuto) → tell(AutoSignal × N) → tell(ReviewSignal × M)`.
- The Resource shell's existing `onInit` becomes the replay driver. Until
  W10-4 deletes the Resource shell entirely, this is the cleanest staging
  point.

### State persistence

`Behavior.persistence = { key, state }`. The behavior declares
`@gent/auto/workflow` as the key and `AutoState.schema` as the codec. The
W10-0d ActorPersistenceStorage handles snapshot/restore. We DROP the
effect-machine `withDecodingDefaultTypeKey(0)` migrations on
`handoffRequestSeq`, since the actor surface is fresh and any prior
persistence keyspace from the old Resource is namespaced separately
(W10-0c). On restore failure: the engine logs and falls back to
`initialState` per the W10-0d quarantine semantics.

### ExtensionMessage routing

Today the workflow exposes its surface through `mapCommand` / `mapRequest`
on the BuiltinResourceMachine. Callers reach the auto state via
`ctx.extension.send(AutoProtocol.X)` and `ctx.extension.ask(...)`. The
loader builds an `ExtensionRef` per extension; for FSM extensions
`spawnMachineExtensionRef` translates ExtensionMessages to machine events
through `mapCommand`/`mapRequest`.

For an actor-only extension (no FSM) that recipe has no machine to dispatch
into. The W10-1b unblock is a **second `ExtensionRef` builder**:
`spawnActorBackedExtensionRef(extensionId, contributions, hostCtx)` whose
`send/execute` route ExtensionMessages to the actor's mailbox via
`serviceKey` lookup.

Implementation shape: AutoMsg's command variants reuse the same `_tag`
strings as the ExtensionMessage envelopes (`StartAuto`, `CancelAuto`,
`RequestHandoff`, `ToggleAuto`). The ExtensionMessage envelope itself is
structurally compatible — it carries `_tag` plus the same fields, plus an
`extensionId` discriminator the actor ignores. Reply variants
(`IsActive`, `GetSnapshot`) likewise share `_tag`. So the builder can
forward the envelope directly as an `AutoMsg`:

```
ref.send(msg):    find(svc) → tell(first, msg)
ref.execute(msg): find(svc) → ask(first, msg, replyKey)
```

The `replyKey` token for `ask` is required by `ctx.actors.ask`'s
correlation. Since the reply value pin is captured by the protocol's
declared reply schema, the builder constructs `replyKey: () => msg`
(returning the request itself — the engine drops the returned value, only
uses it for the type pin, identical pattern as W10-1a).

Inside the actor: `receive` switches on `_tag` for the ExtensionMessage
variants (`StartAuto`, `CancelAuto`, `RequestHandoff`, `ToggleAuto`,
`IsActive`, `GetSnapshot`) and the AgentEvent-mapped variants
(`AutoSignal`, `ReviewSignal`, `TurnCompleted`). For the reply variants
it calls `ctx.reply(...)`. For the rest it returns the new state.

The Resource shell stays for layer + slots (`turnAfter` / `toolResult`)
until W10-5, but its `actor:` field is removed. The loader picks the
actor-backed builder when an extension has `actors:` and no `actor:`.

### Tests

Existing tests at `packages/core/tests/extensions/auto.test.ts` and
`auto-integration.test.ts` exercise the surface through `runtime.send` /
`runtime.execute` (ExtensionMessage-level). Because we kept route-adapter
behavior on the Resource shell, those tests should pass unchanged. We
**add** one direct-actor test mirroring W10-1a that drives the actor via
`engine.tell` / `engine.ask` — this pins the FSM behavior independent of
the routing layer for the W10-3d caller migration.

### Empirical regression

For a genuine multi-state FSM, the highest-value invariant to lock is the
review gate: `Working + AutoSignal(continue) → AwaitingReview` and
`AwaitingReview + ReviewSignal → Working`. Validation: flip the
`AutoSignal(continue)` arm to return `Working` directly (skipping the review
gate). The new direct-actor test should fail (state stays at `Working`,
expects `AwaitingReview`). Restore — passes.

## Files

- `packages/extensions/src/auto.ts` — FSM moves to `autoBehavior`; Resource
  shell shrinks to layer + slots + map\*-as-route-adapter.
- `packages/extensions/src/handoff.ts` — `AutoProtocol.IsActive` ask path
  unchanged at the call site (the Resource shell still routes it).
- `packages/core/tests/extensions/auto.test.ts` — direct-actor regression
  test added.
- `packages/core/tests/extensions/auto-integration.test.ts` — should pass
  unchanged.

## Verification

`bun run gate` plus the empirical regression validation described above.

## Cites

- `redesign-from-first-principles` — actor as the single state-holder shape.
- `make-impossible-states-unrepresentable` — `TaggedEnumClass` exhaustion in
  `receive` switch.
- `migrate-callers-then-delete-legacy-apis` — Resource shell becomes a
  routing thunk; W10-3d/W10-4 deletes it.
- `composability-not-flags` — typed `GetSnapshot` reply, no UI snapshot peek.
