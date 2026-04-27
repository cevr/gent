# W10-1a — Handoff Migration (State-Holder Recipe)

This is the **first** state-holder migration in W10-1. It must establish
the recipe that W10-1d (apply-tier) replays for 4 more state-holders
and that W10-1b/c follow for genuine machines.

## Today (HEAD: dfe14342)

`packages/extensions/src/handoff.ts` declares a `Resource.machine`:

- `cooldownMachine`: `Machine.make({ state: { Active: { cooldown: number } }, … })`
- `cooldownWorkflow`: `{ machine, mapEvent (TurnCompleted), mapCommand (Suppress), mapRequest (GetCooldown), protocols: HandoffProtocol }`
- Wired via `resource(defineResource({ scope: "process", machine: cooldownWorkflow, runtime: { turnAfter: { handler: autoHandoffImpl } } }))`
- `autoHandoffImpl` (the `turnAfter` slot handler) calls
  `ctx.extension.ask(HandoffProtocol.GetCooldown.make())` and
  `ctx.extension.send(HandoffProtocol.Suppress.make(...))`. These go
  through `MachineEngine` → `ExtensionRef.{send,execute}` →
  `spawn-machine-ref.ts` which calls `actor.mapCommand/mapRequest`.
- `TurnCompleted` events flow to the machine via `MachineEngine.publish`
  → `ref.publish` → `actor.mapEvent`.

## Target (W10-1a delivers)

`actors: [behavior(cooldownBehavior)]` instead of `resources: [resource(defineResource({ machine, … }))]`. `runtime.turnAfter` slot stays in place (W10-5 deletes it).

The extension's `runtime.turnAfter` slot handler stops calling
`ctx.extension.send/ask` and instead does
`ctx.actors.find(CooldownService) → ctx.actors.{tell,ask}(ref, msg)`.
The handler also tells `CooldownMsg.TurnCompleted` itself, since the
event-→-mailbox bridge is W10-4 work — interim, the slot handler is
the natural place because `turnAfter` already fires on every
`TurnCompleted`.

### Bucket shape

```ts
const CooldownMsg = TaggedEnumClass("CooldownMsg", {
  TurnCompleted: {},
  Suppress: { count: Schema.Number },
  GetCooldown: {}, // ask payload — reply is a number, threaded via ctx.reply
})

interface CooldownState {
  readonly cooldown: number
}

const CooldownService = ServiceKey<CooldownMsg>("@gent/handoff/cooldown")

const cooldownBehavior: Behavior<CooldownMsg, CooldownState, never> = {
  initialState: { cooldown: 0 },
  serviceKey: CooldownService,
  receive: (msg, state, ctx) =>
    Effect.gen(function* () {
      switch (msg._tag) {
        case "TurnCompleted":
          return state.cooldown > 0 ? { cooldown: state.cooldown - 1 } : state
        case "Suppress":
          return { cooldown: msg.count }
        case "GetCooldown":
          yield* ctx.reply(state.cooldown)
          return state
      }
    }),
}
```

### `ExtensionHostContext` additions

The slot handler (`autoHandoffImpl`) needs to reach the cooldown
actor without going through `ExtensionRef`. Add an `actors` facet to
`ExtensionHostContext`:

```ts
interface Actors {
  readonly find: <M>(key: ServiceKey<M>) => Effect.Effect<ReadonlyArray<ActorRef<M>>>
  readonly tell: <M>(ref: ActorRef<M>, msg: M) => Effect.Effect<void>
  readonly ask: <M, A>(
    ref: ActorRef<M>,
    msg: M,
    replyKey: (a: A) => M,
  ) => Effect.Effect<A, ActorAskTimeout>
}
```

Wired in `make-extension-host-context.ts`:

```ts
actors: {
  find: (key) => deps.receptionist.find(key),
  tell: (ref, msg) => deps.actorEngine.tell(ref, msg),
  ask: (ref, msg, replyKey) => deps.actorEngine.ask(ref, msg, replyKey),
},
```

`MakeExtensionHostContextDeps` gains `receptionist: Receptionist` and
`actorEngine: ActorEngine`. The two call sites that build deps
(`session-runtime-context.ts` line 87, `rpc-handler-groups/extension.ts`
line 225) yield those Tags from the runtime profile layer.

### Slot handler wiring

```ts
const autoHandoffImpl = (input, ctx) =>
  Effect.gen(function* () {
    if (input.interrupted) return

    const refs = yield* ctx.actors.find(CooldownService)
    const cooldownRef = refs[0]
    if (cooldownRef === undefined) return

    yield* ctx.actors.tell(cooldownRef, CooldownMsg.TurnCompleted.make({}))

    const autoActive = yield* ctx.extension
      .ask(AutoProtocol.IsActive.make())
      .pipe(Effect.catchEager(() => Effect.succeed(false)))
    if (autoActive) return

    const cooldown = yield* ctx.actors
      .ask(cooldownRef, CooldownMsg.GetCooldown.make({}), (n: number) =>
        // reply token — engine asks ctx.reply(n) inside receive; the
        // token wraps the answer back into the actor's message type so
        // ask correlation can route it.
        CooldownMsg.GetCooldown.make({}),
      )
      .pipe(Effect.catchEager(() => Effect.succeed(0)))
    if (cooldown > 0) return

    // … threshold check + interaction.approve unchanged …
    if (!decision.approved) {
      yield* ctx.actors
        .tell(cooldownRef, CooldownMsg.Suppress.make({ count: 5 }))
        .pipe(Effect.catchEager(() => Effect.void))
    }
  })
```

### `HandoffProtocol` (handoff-protocol.ts)

Eliminated. The cooldown machine no longer participates in
`MachineEngine` routing, so `ExtensionMessage.command/reply` declarations
are dead. Keep `HANDOFF_EXTENSION_ID` only.

`AutoProtocol.IsActive.make()` is still used; that's W10-1b's
migration, not this commit's.

### Test migration (`packages/core/tests/extensions/handoff.test.ts`)

The "Handoff cooldown workflow" describe block currently uses
`spawnMachineExtensionRef`. Rewrite to drive the actor through
`ActorEngine` + `Receptionist`:

```ts
const layer = Layer.mergeAll(
  ActorEngine.Live,
  ActorHost.fromResolved(makeResolved([loadedHandoff])),
)
…
const refs = yield* receptionist.find(CooldownService)
const ref = refs[0]
yield* engine.tell(ref, CooldownMsg.Suppress.make({ count: 5 }))
const cooldown = yield* engine.ask(ref, CooldownMsg.GetCooldown.make({}), …)
expect(cooldown).toBe(5)
… etc.
```

The C8b regression invariants stay intact:

- Initial cooldown = 0
- `Suppress(5)` sets to 5
- Each `TurnCompleted` decrements (clamps at 0)
- `Suppress(2)` overwrites (not adds)

`HandoffTool` describe block is unchanged (it doesn't touch the workflow).

## Empirical validation

Before commit: run `bun run gate` + `bun test packages/core/tests/extensions/handoff.test.ts` to confirm parity.

Regression test: temporarily flip the actor's `Suppress` reducer to
**add** instead of overwrite (`return { cooldown: state.cooldown + msg.count }`).
The "Suppress(2) re-arms (overwrite, not add)" assertion must fail
(observed: `4`, expected: `2`). Restore.

This empirically pins the regression test to the overwrite semantic
that C8b locked.

## Files touched

- `packages/extensions/src/handoff.ts` — rewrite
- `packages/extensions/src/handoff-protocol.ts` — gut to just the id constant
- `packages/core/src/domain/extension-host-context.ts` — add `actors` facet
- `packages/core/src/runtime/make-extension-host-context.ts` — wire deps + actors facet
- `packages/core/src/runtime/session-runtime-context.ts` — yield Receptionist + ActorEngine
- `packages/core/src/server/rpc-handler-groups/extension.ts` — same
- `packages/core/src/test-utils/extension-harness.ts` — testToolContext default `actors` stub
- `packages/core/tests/extensions/handoff.test.ts` — rewrite cooldown describe

## Cites

- `derive-dont-sync` — actor view derives, doesn't sync
- `make-impossible-states-unrepresentable` — TaggedEnumClass message
- `small-interface-deep-implementation` — `actors` facet is 3 methods
- `migrate-callers-then-delete-legacy-apis` — cooldown migration first; HandoffProtocol/Resource.machine deletion is W10-5

## Recipe reuse

W10-1d apply-tier copies this recipe for 4 more state-holders:
exec-tools notifications, artifacts, memory, skills. The pattern is
mechanical:

1. Replace `cooldownMachine` Machine.make with a `Behavior<M, S, never>`.
2. Define a `ServiceKey` named after the extension+role.
3. Declare `actors: [behavior(...)]`.
4. Replace caller `ctx.extension.send/ask` with
   `ctx.actors.find(key) → tell/ask`.
5. Update tests to drive through `ActorEngine` + `Receptionist`.
