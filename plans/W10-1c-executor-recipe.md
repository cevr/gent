# W10-1c — executor extension: actor migration recipe

**Status:** design — execution pending
**Predecessor:** W10-1b (auto)
**Successor:** W10-1d (apply-tier 4 state-holders)

## Why this is a separate sub-commit

Executor is the **second** genuine multi-state machine to migrate. Unlike auto, its FSM contains a long-running side effect: `Machine.spawn(Connecting, ...)` runs the connection work as a state-scoped effect, automatically cancelled on state exit. The W10 actor primitive (`Behavior<M, S, R>`) has no on-state-entry hook, so the connection-effect contract has to be re-modeled.

This commit also exercises the **cross-extension Receptionist discovery** path — outside callers (e.g. tools, future projections) reach `ExecutorService` through `ctx.actors.find(ExecutorService)` rather than `ctx.extension.ask(ExecutorProtocol.GetSnapshot)`. (Note: callers stay on `ctx.extension.ask` for this commit; the actor-route fallback in W10-1b.0 forwards. Direct cross-extension discovery is exercised by ExecutorReadyService — TBD whether needed.)

## Today (HEAD: cd4c8cee)

`packages/extensions/src/executor/actor.ts` declares:

- `MachineState`: `Idle | Connecting{cwd} | Ready{mode, baseUrl, scopeId, executorPrompt} | Error{message}`
- `MachineEvent`: `Connect{cwd}`, `Connected{...}`, `ConnectionFailed{message}`, `Disconnect{}`, `GetSnapshot` (reply schema)
- `executorMachine`: declarative `.on(...)` table + `.spawn(Connecting, ...)` for the connection effect
- `executorActor`: `{ machine, slots, mapCommand, mapRequest, protocols, onInit }` — `onInit` checks `autoStart` setting and `send(Connect)` on Idle.
- Slots: `resolveEndpoint`, `inspectMcp`, `resolveSettings` — implementations call `ExecutorSidecar` / `ExecutorMcpBridge` from layer.

Wiring (`index.ts`): single Resource with `{layer: Sidecar.Live + McpBridge.Live, machine: executorActor}`. Two `action()` slash commands (`executor-start`, `executor-stop`).

Tools (`tools.ts`): `ExecuteTool`, `ResumeTool` both call `ctx.extension.ask(ExecutorProtocol.GetSnapshot.make())` to read `baseUrl`.

External callers — searched: only the test suite drives `runtime.execute(sessionId, ExecutorProtocol.X, branchId)`. No production cross-extension consumer of executor today.

## Target

`actors: [behavior(executorBehavior)]` instead of `resources: [resource(defineResource({ machine, ... }))]`. The Resource shell stays for layer + onInit-equivalent until W10-5 deletes it; its `actor:` field goes away.

### Connection effect — the key design change

`Behavior` has no on-state-entry hook, so we move the connection work out of the actor and onto a slot handler that observes state transitions. Two viable approaches:

**Option A — `view`-driven externalized connector.** Keep state purely synchronous in the actor; expose `view(state)` that surfaces "connecting needed" to a slot subscriber that forks the connection. Reject: requires a new "actor view subscriber" runtime primitive that doesn't exist yet, and `view` is supposed to be cheap-and-pure.

**Option B — slot-handler observer fires the connection on `Connect`.** The Resource shell's `runtime.toolResult` doesn't fit (no tool calls drive Connect). Use the existing `runtime.turnAfter` slot or a new `runtime.onMessageObserved` hook... still feels like force-fitting.

**Option C — the actor itself forks the connection from `receive`.** Inside `case "Connect":`, before returning the new `Connecting` state, `Effect.forkScoped` the connection effect using `ctx`-provided scope. Reject: `ActorContext` has no `forkScoped` and the W10 plan would need to grow one.

**Option D — the Resource shell's `onInit`-replacement runs a long-lived observer.** Extension load installs a fiber that:

1.  Subscribes to the actor's state changes (via a NEW `ctx.actors.subscribeState(ref)` that pushes the latest `S` whenever `receive` returns).
2.  Whenever the latest state is `Connecting`, run the connection effect scoped to "until state changes".
3.  On `Connected`/`ConnectionFailed`, send the result.

**Adopted with simplification.** We don't need a new `subscribeState` API for one extension: the Resource shell can drive the connection synchronously inside the slot handler that _also_ sends `Connect`. That collapses to:

**Option D' (final) — receive-side connection effect with ConnectAndConnect-loop pattern.** The actor receives `Connect{cwd}` and returns `Connecting{cwd}`. The connection effect lives on the `runtime.onInit`-equivalent (W10's "extension load" boundary) — but since that hook also doesn't exist on Behavior, the cleanest fit for THIS commit is:

**Option E (final) — split executor into two actors.**

- `ExecutorActor`: pure FSM state-holder; `receive` is sync.
- `ExecutorConnectionRunner`: long-lived observer fiber registered as a Resource at extension-load time. Subscribes to the FSM's `state` (via a small sample-on-tell helper), forks the connection effect when Connecting is the current state, cancels on state-exit. Sends `Connected`/`ConnectionFailed` back.

This isolates the side-effect from the pure FSM and matches `single-responsibility-per-actor`. **But** it adds an actor without precedent in W10-1a/1b.

**Final adopted design — Option F.** Keep ONE actor. Use the `Behavior.receive` to handle synchronous transitions. Run the connection effect from the `runtime.toolResult` slot... wait, that doesn't fire on Connect. Run it from the `runtime` slot wired to the `action(executor-start)` execute path: when the action fires, it does:

```ts
execute: (_, extCtx) =>
  Effect.gen(function* () {
    const refs = yield* extCtx.actors.find(ExecutorService)
    const ref = refs[0]
    if (!ref) return
    yield* extCtx.actors.tell(ref, ExecutorMsg.Connect.make({ cwd: extCtx.cwd }))
    // Run the connection effect here, scoped to the action's execution
    yield* runConnectionEffect(extCtx, ref)
  })
```

But this couples the connection effect to the action surface. autoStart-driven Connect (formerly `onInit`) wouldn't run the connection effect.

### Adopted: Option G — Connection runs on a Resource-shell hook.

Re-read of `defineResource` in core: the resource shell exposes `runtime.toolResult` and `runtime.turnAfter` slot handlers, plus a `layer` that runs at extension load. The `layer` itself can `forkScoped` a long-lived observer — that's the cleanest place for the connection effect.

```ts
defineResource({
  scope: "process",
  layer: Layer.scoped(
    ExecutorConnectionFiber,
    Effect.gen(function* () {
      // Resolve actor ref via Receptionist after extension load completes
      const receptionist = yield* Receptionist
      const engine = yield* ActorEngine
      // Subscribe to the actor's state-change Stream (see "subscribeState"
      // below — added as a small helper on ActorEngine for W10-1c)
      yield* engine.subscribeState(ref).pipe(
        Stream.runForEach((state) => {
          if (state._tag !== "Connecting") return Effect.void
          // Fork the connection — auto-cancelled on next state emission
          return runConnection(state, ref).pipe(Effect.forkScoped, Effect.asVoid)
        }),
      )
    }),
  ),
})
```

**Caveat**: `engine.subscribeState` doesn't exist yet. The Resource layer is a Scoped Effect run _during extension load_, and at that moment the actor may not be spawned yet (spawn happens in a separate ActorHost layer). So we'd need either (a) await actor spawn before resolving the ref, or (b) loop on `find(ExecutorService)` until non-empty.

The ergonomic approach is to add `engine.subscribeState<M, S>(ref): Stream<S>` that reads from the actor's internal state-change PubSub (already present for `subscribe(serviceKey)`-equivalent). One small hook on the actor primitive.

**Decision for W10-1c**: add `engine.subscribeState` + use Option G. Document the new primitive in the Behavior boundary docs.

### Recipe shape (final)

1. `ExecutorMsg = TaggedEnumClass({ Connect{cwd}, Connected{...}, ConnectionFailed{message}, Disconnect{}, IsActive{}, GetSnapshot{} })`.
2. `ExecutorState = TaggedEnumClass({ Idle, Connecting{cwd}, Ready{...}, Error{message} })`.
3. `ExecutorService = ServiceKey<ExecutorMsg>("@gent/executor/workflow")`.
4. `executorBehavior: Behavior<ExecutorMsg, ExecutorState, never>`:
   - `receive` is a pure switch on `(state._tag, msg._tag)`; returns next state and replies for `IsActive`/`GetSnapshot`.
   - `persistence`: TBD — connection state is volatile; if we persist `Ready`, the next process can't possibly be on the same socket. **Decide: don't persist.** (Same as the old machine — no `withDecodingDefaultTypeKey` was used.)
5. `runtime.toolResult` / `runtime.turnAfter` slots — none today, none added.
6. Resource shell:
   - `layer`: `Sidecar.Live + McpBridge.Live + ConnectionRunner.Live` — the third sub-layer is a `Layer.scoped` that forks the connection observer.
   - `machine` field DELETED (per W10-1b.1 precedent).
7. `autoStart` (formerly `onInit` autoStart-Connect): the connection observer's first iteration checks settings, and if `autoStart`, tells `Connect`.

### Cross-extension discovery

The executor tools (`ExecuteTool`/`ResumeTool`) currently use `ctx.extension.ask(ExecutorProtocol.GetSnapshot)`. The actor-route fallback in MachineEngine (W10-1b.0) routes that envelope to the actor mailbox. So tools don't need to change.

If we want to **exercise** cross-extension `find(ExecutorService)` to validate the path: add a unit test that spawns the executor extension, then from a peer extension's slot handler does `ctx.actors.find(ExecutorService)` and asserts a non-empty ref set. This is the empirical validation called for in the W10 plan ("exercises cross-extension `find` + `ask`").

## Files

- `packages/extensions/src/executor/actor.ts` — rewrite to Behavior shape
- `packages/extensions/src/executor/index.ts` — drop `executorActor` field, keep Resource for layer + connection runner
- `packages/extensions/src/executor/tools.ts` — unchanged (route-adapter forwards GetSnapshot)
- `packages/extensions/src/executor/protocol.ts` — unchanged
- NEW: `packages/extensions/src/executor/connection-runner.ts` — `Layer.scoped` observer that subscribes to executor state and forks the connection effect on entry to Connecting.
- `packages/core/src/runtime/extensions/actor-engine.ts` — add `subscribeState<M, S>(ref): Stream<S>` (W10-1c primitive)
- `packages/core/src/domain/actor.ts` — add `subscribeState` to `ActorContext` and `ActorEngine` interface.
- `packages/core/tests/extensions/executor.test.ts` + `executor-integration.test.ts` — rewrite to drive actor through engine. Reuse the auto.test.ts harness pattern.

## Empirical regression

Flip `transitionConnect` to return `Idle` instead of `Connecting{cwd}`. The "Connect from Idle moves to Connecting" test must fail. Restore.

A second regression for the connection runner: stub the runner to never fire, and the "autoStart triggers ready state" test must fail. Restore.

## Cites

- `single-responsibility-per-actor` — pure FSM in actor, side-effect runner alongside.
- `derive-dont-sync` — view derives projection; runner derives its trigger from state stream.
- `make-impossible-states-unrepresentable` — TaggedEnumClass exhaustion.
- `migrate-callers-then-delete-legacy-apis` — Resource.actor field gone; protocol envelopes routed by W10-1b.0 fallback.
- `composability-not-flags` — typed reply schema, no UI snapshot peek.

## Open questions

1. **`subscribeState` primitive name + shape.** Stream<S> emitting on every receive-return? Or only on state change (filterChanged)? Default to filterChanged — emits-on-change is the reactive-cell semantics callers want.
2. **autoStart timing.** Layer.scoped runs at extension load, before any actor is spawned. The runner must wait for `find(ExecutorService).filter(non-empty)` then start observing. Or: the runner registers itself as a peer actor with its own ServiceKey and the engine `tell`s it after spawn — but that's a circular bootstrap.
   - Practical: poll `find(ExecutorService)` until non-empty, then proceed. With small backoff + a timeout. The test harness can wait for the engine to settle.
3. **What if `Behavior` should grow an on-state-entry hook?** That's a primitive change and outside W10-1c. Add a follow-up task if implementing Option G is messier than expected.
