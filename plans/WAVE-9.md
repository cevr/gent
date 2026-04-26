# Planify: Wave 9 — Actor Primitive Foundation

## Context

Wave 7 hardened the W6 substrate (brand passes, domain
back-imports, server hardening, test gap closure). Wave 8 dropped
`effect-machine` from the agent-loop and left it as a plain
`Effect.gen` + `Ref<Phase>` driver. The substrate is now ready for
the architectural shift: replace `Resource.machine` /
`MachineEngine` / `runtime.*` slot / `subscriptions` machinery with
a single actor primitive.

Wave 9 is **foundation only**. It introduces the new shape in
`domain/actor.ts` and wires the engine, the Receptionist, and the
persistence path. No existing extension migrates onto it in W9 —
the new surface coexists with the legacy one. Wave 10 is the bulk
migration + surface collapse + deletion sweep.

The split between W9 (introduce) and W10 (migrate + delete) is
deliberate: introducing the primitive in isolation gives one
intelligible commit batch that can be reviewed as a primitive
design (not bundled with 7-site migration churn). It also lets W10
confidently delete legacy surfaces in one revertible sweep,
because every caller migrated in W10's earlier commits before the
W10 deletion lands.

The cut applies the principles `subtract-before-you-add` (build the
replacement before deleting the old surface), `small-interface-deep-implementation`
(`ActorRef<M>` + `Behavior<M>` + `ActorContext<M>` are a tight
front door over a deep implementation),
`make-impossible-states-unrepresentable` (typed mailbox messages,
`ServiceKey<M>` types peer lookups end-to-end), and
`fail-with-typed-errors` (`ActorAskTimeout` is the typed timeout
path; lookup misses return `Option<readonly ActorRef<M>[]>`).

The plan is not complete until every batch below is implemented,
gated, and reviewed once.

## Scope

- **In**: new `domain/actor.ts` (`ActorRef<M>`, `Behavior<M>`,
  `ActorContext<M>`, `ServiceKey<M>`, `tell`, `ask` with default
  5s timeout, `ActorAskTimeout` typed error); new `runtime/extensions/
actor-engine.ts` (host that spawns + supervises actors per
  extension per session, takes a `Behavior<M>` and produces an
  `ActorRef<M>`); new `runtime/extensions/receptionist.ts` (typed
  service-key registry, `register(key, ref)` / `find(key) →
Effect<readonly ref[], never>` / `subscribe(key) → Stream<...>`);
  actor persistence path (snapshot `state` + mailbox at the
  existing checkpoint surface so a session restart can rehydrate);
  `defineExtension({ actors: [...] })` loader wiring (loader reads
  the new bucket and asks `ActorEngine` to spawn each `Behavior`
  with the extension's R-channel); zero-actor extension still
  loads (the bucket is optional); cross-bucket interaction (an
  RPC handler / tool can `find(ServiceKey)` and `ask` an actor —
  this is what makes the bucket usable from W10's not-yet-migrated
  consumers); tests at every layer of the three-tier taxonomy from
  CLAUDE.md.
- **Out (W10)**: any migration of existing extension state-holders
  onto the actor primitive. No `Resource.machine` site moves in
  W9. The legacy `Resource.machine` / `MachineEngine` / slot /
  `subscriptions` surfaces stay intact. W9 is purely additive.
- **Out (W10)**: extension surface collapse (`tools` / `commands` /
  `keybinds` / `rpc` per-bucket inline handlers, deletion of
  `Capability` / `Intent` / `Projection`).
- **Out (W11)**: `needs:`-derived concurrency.
- **Out**: integrating the actor primitive with the agent-loop.
  W8 already moved the loop off `effect-machine`; W9's primitive
  is for extensions, not for the loop driver.

## Constraints

- Correctness over pragmatism. Personal library; no shims, no
  parallel APIs, no deprecation cycles.
- Each commit compiles and passes `bun run gate`.
- High-blast-radius commits (W9-1, W9-2, W9-5) also run
  `bun run test:e2e`.
- One review subagent per implementation commit.
- Apply-tier delegation per CLAUDE.md not warranted in W9 (the
  blast radius is concentrated in 4-5 new files plus loader
  wiring; design-tier authors all of it).
- The new surface must integrate with the existing actor-aware
  test harnesses noted in CLAUDE.md (`createActorHarness`,
  `makeActorRuntimeLayer`, `createRpcHarness`). If the new
  primitive doesn't fit those harnesses, the harnesses extend in
  the same wave — never fork.
- The new surface respects `packages/core/CLAUDE.md` runtime,
  extension, and provider boundaries: server-facing code stays
  on `SessionRuntime` (the actor primitive lives below it);
  extension authors get the `defineExtension({ actors })` front
  door (no `query`/`mutation`/generic `_kind` contributions);
  provider code is unaffected.

## Applicable Skills

`architecture`, `effect-v4`, `test`, `code-style`, `bun`, `planify`

## Gate Command

`bun run gate`

---

## Shape after W9

`domain/actor.ts`:

```ts
export type ActorRef<M> = {
  readonly _tag: "ActorRef"
  readonly id: ActorId
}

export type Behavior<M, S, R> = {
  readonly initialState: S
  readonly receive: (msg: M, state: S, ctx: ActorContext<M>) => Effect<S, never, R>
  readonly view?: (state: S) => Partial<{ prompt: string; toolPolicy: ToolPolicy }>
  readonly serviceKey?: ServiceKey<M>
}

export interface ActorContext<M> {
  readonly self: ActorRef<M>
  readonly tell: <N>(target: ActorRef<N>, msg: N) => Effect<void>
  readonly ask: <N, A>(
    target: ActorRef<N>,
    msg: N,
    replyKey: (a: A) => N,
  ) => Effect<A, ActorAskTimeout>
  readonly find: <N>(key: ServiceKey<N>) => Effect<ReadonlyArray<ActorRef<N>>>
  readonly subscribe: <N>(key: ServiceKey<N>) => Stream<ActorRef<N>>
}

export type ServiceKey<M> = {
  readonly _tag: "ServiceKey"
  readonly name: string
}

export class ActorAskTimeout extends Schema.TaggedError<ActorAskTimeout>()("ActorAskTimeout", {
  actorId: ActorId,
  askMs: Schema.Number,
}) {}
```

`runtime/extensions/actor-engine.ts`:
spawns one fiber per actor with a `Mailbox` queue, runs `receive`
in a loop, persists `S` at checkpoint boundaries, supervises
restart on failure (per-actor strategy declared in the Behavior).

`runtime/extensions/receptionist.ts`:
typed `Map<ServiceKey, Set<ActorRef>>` accessible to every actor
via `ctx.find` / `ctx.subscribe`.

`defineExtension({ actors: [...] })`:
new optional bucket; the loader hands each Behavior to
`ActorEngine.spawn(Behavior, extensionLayer)`.

## What stays unchanged in W9

- Every existing extension. `Resource.machine` / `MachineEngine` /
  `runtime.turnAfter` / `eventReducer` / `eachTick` /
  `subscriptions` / `Capability` / `Intent` / `Projection` /
  `pulseTags` / `ReadOnlyTag` all stay intact. They die in W10.
- The agent-loop. W8 already simplified it; W9 doesn't touch it.
- The provider boundary. Untouched.
- The `RuntimeCommand` write-surface. Untouched.

## What ships in W9

A new bucket on `defineExtension`, a new engine, a new
Receptionist, a new persistence path. **At W9 close, the bucket
exists but nothing populates it in production code** (a few
in-tree tests use it to verify the engine works end-to-end). W10
migrates ~7 sites onto it.

---

## Implementation Batches

Order: domain types first (the front door + typed mailbox shape),
then the engine (spawn/supervise/persist), then the Receptionist
(peer discovery), then persistence wiring (snapshot+restore at
the existing checkpoint surface), then loader wiring (the
`actors` bucket on `defineExtension`).

### Commit 1: `feat(domain): actor primitive — ActorRef, Behavior, ActorContext, ServiceKey, tell/ask, ActorAskTimeout`

**Why W9-1 first**: every later commit consumes the types. Author
the front door and the typed error before any host wiring goes
in.

**Files**:

- `packages/core/src/domain/actor.ts` (new — types listed in
  "Shape after W9").
- `packages/core/tests/domain/actor.test.ts` (new — type-level
  tests for `ServiceKey<M>` end-to-end inference; encode/decode
  for `ActorAskTimeout`; `tell`/`ask` typing roundtrip).

**Verification**: `bun run gate` + `bun run test:e2e`.

**Cites**: `make-impossible-states-unrepresentable`,
`small-interface-deep-implementation`,
`fail-with-typed-errors`.

### Commit 2: `feat(runtime): ActorEngine — spawn, supervise, mailbox loop`

**Why W9-2**: the host. Each `Behavior<M, S, R>` becomes a fiber
with a `Mailbox<M>` and a `Ref<S>`. `receive` runs in a loop
until interrupted or the actor terminates. Supervision strategy
declared on the Behavior (default: restart on transient failure,
escalate on poison-message).

**Files**:

- `packages/core/src/runtime/extensions/actor-engine.ts` (new —
  `spawn(Behavior, R) → Effect<ActorRef<M>, never, ActorEngine>`,
  internal `Mailbox<M>` per actor, fiber loop, supervision).
- `packages/core/tests/runtime/actor-engine.test.ts` (new — three-
  tier coverage: pure reducer test (`createActorHarness`-shaped
  for the Behavior's `receive`); actor runtime test
  (`makeActorRuntimeLayer`-shaped) for spawn + tell + state
  evolution; supervision test for transient failure restart).

**Verification**: `bun run gate` + `bun run test:e2e`.

**Cites**: `redesign-from-first-principles`,
`small-interface-deep-implementation`,
`fail-with-typed-errors`.

### Commit 3: `feat(runtime): Receptionist — typed service-key registry + find/subscribe`

**Why W9-3**: peer discovery. An actor needing to talk to another
actor calls `ctx.find(ServiceKey)` and gets back zero or more
refs (`Option`-equivalent semantics via `ReadonlyArray`).
`ctx.subscribe(ServiceKey)` returns a Stream of refs as peers
register/unregister, used for long-lived subscriptions across
restart.

**Files**:

- `packages/core/src/runtime/extensions/receptionist.ts` (new —
  `register` / `unregister` / `find` / `subscribe`; backed by
  `SubscriptionRef<Map<ServiceKey, Set<ActorRef>>>`).
- `packages/core/tests/runtime/receptionist.test.ts` (new —
  registration roundtrip; concurrent register doesn't drop
  entries; `find` on missing key returns empty array; `subscribe`
  emits on register/unregister).

**Verification**: `bun run gate`.

**Cites**: `derive-dont-sync`, `bound-resources-self-evict`,
`fail-with-typed-errors`.

### Commit 4: `feat(runtime): actor persistence — snapshot/restore at checkpoint boundary`

**Why W9-4**: durability. At checkpoint write time, every actor's
`Ref<S>` snapshots into the existing checkpoint surface. At
session restore, every actor rehydrates its state before the
mailbox loop starts. No mailbox replay (mailboxes are ephemeral —
peers re-tell on resume).

**Files**:

- `packages/core/src/runtime/extensions/actor-engine.ts` (extend
  with snapshot/restore hooks); checkpoint surface integration
  (`agent-loop.checkpoint.ts` or wherever W8 left the checkpoint
  hub) — actors plug into the same hub.
- `packages/core/tests/runtime/actor-persistence.test.ts` (new —
  spawn, send, snapshot, simulate restart with new ActorEngine,
  verify state matches; verify mailbox is _not_ replayed).

**Verification**: `bun run gate` + `bun run test:e2e`.

**Cites**: `derive-dont-sync`,
`make-impossible-states-unrepresentable`.

### Commit 5: `feat(extensions): defineExtension({ actors }) loader wiring`

**Why W9-5**: the front door. Loader at extension-load time reads
the optional `actors` bucket from the extension's contribution
and hands each Behavior to `ActorEngine.spawn(Behavior,
extensionLayer)`. Each spawn registers the Behavior's optional
`serviceKey` with the Receptionist. Existing extensions with no
`actors` bucket load unchanged.

**Files**:

- `packages/extensions/src/define.ts` (or wherever
  `defineExtension` lives) — add the `actors` field to the
  contribution shape (optional; default empty array).
- The loader (in `runtime/extensions/loader.ts` or equivalent)
  — read the new bucket and call `ActorEngine.spawn` for each
  entry.
- Test extension at `packages/core/tests/extensions/actor-bucket-fixture.ts`
  (new — minimal fixture extension declaring two actors with
  different `ServiceKey`s; one tells the other; assertion that
  state evolves correctly).
- `packages/core/tests/extensions/actor-bucket.test.ts` (new —
  three-tier coverage: unit reducer test on the fixture's
  Behaviors; actor runtime test on the engine path; RPC
  acceptance test through `createRpcHarness` to verify scope
  lifetime is correct).

**Verification**: `bun run gate` + `bun run test:e2e`.

**Cites**: `progressive-disclosure`,
`small-interface-deep-implementation`,
`migrate-callers-then-delete-legacy-apis` (the new surface lands
before any caller moves in W10).

---

W9 closes when the actor primitive ships, the gate is green, and
the test fixture exercises spawn + tell + ask + find + persist
end-to-end. The new bucket coexists with the legacy
`Resource.machine` / `MachineEngine` / slots / `subscriptions` —
no production extension migrates in W9. **`plans/WAVE-10.md`** is
the next wave: full migration + extension surface collapse +
deletion sweep.
