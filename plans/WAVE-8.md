# Planify: Wave 8 — Agent-Loop Simplification

## Context

The W6 closing audit (Lane 9) and the explicit pi-mono comparison
recorded at `plans/AGENT-LOOP-COMPARISON.md` reach the same verdict:
`effect-machine` is the wrong tool for `agent-loop.ts`. The per-turn
body (`runTurn`, `agent-loop.ts:2523-2752`) is _already_ a plain
`Effect.gen while(true)` doing the same work pi-mono does in a plain
async iterator. The FSM is grafted on as an outer driver; for 5 of 7
loop concerns it adds overhead the loop solves by hand anyway, and
imposes structural duplication (`stateRef` / `queueRef` /
`runtimeStateRef` projection alongside the actor snapshot — the
clearest sign of accidental complexity).

Concretely, the FSM in the loop carries weight in _exactly two_
places: durably suspending while waiting for human approval, and
serializing concurrent `Interrupt` / `SwitchAgent` against the
running task. Both can be expressed in plain Effect with a
`Ref<Phase>` + a single `Fiber<Turn>` per session + a
`sideMutationSemaphore` (which already exists). Net deletion: ~800
LOC of accidental complexity from the most-read file in the
codebase.

`effect-machine`-the-library survives in `auto` and `executor/actor`
where it carries genuine weight (per the comparison: same event has
different effects in different states; the state IS the data). W8
does **not** touch those.
`MachineEngine`-the-host (the per-extension actor host) is unaffected
by W8 — it's the agent-loop's own FSM that goes away. `MachineEngine`
dies later in W10 when extension state-holders migrate off it onto
the actor primitive introduced in W9.

**Wave 8 simplifies the agent-loop _before_ the actor primitive lands**
because (a) the simplification is independent of the primitive design,
(b) doing it on the W6 substrate makes the diff readable (one
intelligible "drop the FSM" change, not bundled with primitive
introduction), and (c) the resulting plain-Effect shape is what W9's
actor primitive must integrate against, so settling it first prevents
re-design churn in W9.

The plan is not complete until every batch below is implemented,
gated, and reviewed once.

## Scope

- **In**: drop `effect-machine` from `agent-loop.ts` and
  `agent-loop.state.ts`; replace the FSM driver with a plain
  `Ref<Phase>` + `Fiber<Turn>` per session; collapse the duplicated
  `stateRef` / `queueRef` / `runtimeStateRef` projection set to a
  single source of truth; reshape `agent-loop.checkpoint.ts` to a
  flat `Schema.Struct` over the new phase-tagged shape; preserve the
  externally-observable `AgentLoopService` contract (`runTurn`,
  `applySteer`, `respondInteraction`, `recordToolResult`, `invokeTool`,
  `getState`, `watchState`, `terminateSession`, `restoreSession`);
  preserve durable interaction suspension semantics (a session
  awaiting human approval at process restart resumes correctly);
  preserve `RuntimeCommand` write-surface (per `packages/core/CLAUDE.md`
  Runtime Boundary).
- **Out (Wave 9)**: actor primitive (`ActorRef`, `Behavior`, etc.).
- **Out (Wave 10)**: `MachineEngine` deletion + extension migration.
  W8 leaves `MachineEngine` untouched — extensions still depend on it.
- **Out (Wave 11)**: `needs:`-derived concurrency.
- **Out**: any user-facing API change. The agent-loop's RPC surface
  and `RuntimeCommand` constructors are unchanged. This is a pure
  internal substrate swap.
- **Out**: cosmetic refactors not tied to FSM removal; observability
  surface changes (Otel spans, wide events) beyond what the FSM
  removal _forces_ (e.g., the dropped `MachineInspected` bridge —
  the wide-event boundary is preserved).

## Constraints

- Correctness over pragmatism. Personal library; no parallel APIs,
  no shims.
- Each commit compiles and passes `bun run gate`.
- High-blast-radius commits (W8-1, W8-3) also run `bun run test:e2e`
  and `bun run smoke`.
- The `RuntimeCommand` write-surface from
  `packages/core/CLAUDE.md` is non-negotiable — every command flows
  through `dispatch(...)` after the swap exactly as it does today.
- Durable suspension behavior is verified end-to-end: a session
  parked in `Phase.WaitingForInteraction` at process exit must
  resume on restart and complete the response. This is the _one_
  feature the FSM justifies; preserving it is the correctness
  bar for the wave.
- One review subagent per implementation commit.
- Apply-tier delegation per CLAUDE.md: design-tier authors the
  phase-tag shape, the single-fiber driver, and the checkpoint
  schema reshape. There is no apply-tier tail in W8 because the
  blast radius is concentrated in 4 files (`agent-loop.ts`,
  `agent-loop.state.ts`, `agent-loop.checkpoint.ts`, plus tests).

## Applicable Skills

`architecture`, `effect-v4`, `test`, `code-style`, `bun`, `planify`

## Gate Command

`bun run gate`

---

## Shape after W8

`runtime/agent/agent-loop.ts` — the per-session loop is a single
fiber driven by:

```ts
type Phase =
  | { _tag: "Idle" }
  | { _tag: "Running"; turnStartedAt: Date; turnId: TurnId }
  | { _tag: "WaitingForInteraction"; turnId: TurnId; toolCallId: ToolCallId; awaitingSince: Date }
  | { _tag: "Terminated"; reason: TerminationReason }

interface AgentLoopState {
  readonly phase: Phase
  readonly queue: ReadonlyArray<QueuedCommand>
  readonly runtimeStateProjection: RuntimeStateProjection // derived from extensions
  readonly turnHistory: ReadonlyArray<TurnSummary>
  readonly latestInputTokens: Option<number>
}
```

Single `Ref<AgentLoopState>` per session. No `Machine.spawn`, no
state/event union, no transition table, no projection Ref triplet.

The driver shape:

```ts
const runLoop = Effect.gen(function* () {
  const state = yield* SubscriptionRef.make(initial)
  const turnFiber = yield* Ref.make<Option<Fiber<TurnOutcome>>>(Option.none())
  const sideMutationSemaphore = yield* Semaphore.make(1)

  // Mailbox-equivalent: methods on AgentLoopService take the semaphore,
  // inspect+update state, optionally interrupt or replace turnFiber.
  return AgentLoopService.of({
    runTurn: (cmd) => withSerialization(...),
    applySteer: (cmd) => withSerialization(...),
    respondInteraction: (cmd) => withSerialization(...),
    // ... other methods ...
    watchState: state.changes,
  })
})
```

`agent-loop.state.ts` collapses from 356 LOC to ~80 LOC of pure
helpers (queue ops, projection update, Phase transition validators
expressed as plain functions returning `Either<Reason, Phase>`).
State/event union and `Machine`-generic types deleted.

`agent-loop.checkpoint.ts` reshapes from 87 LOC of state-snapshot
serialization to ~60 LOC of one flat `Schema.Struct<AgentLoopState>`

- a single load/save pair. No multi-state-shape branching because
  the persisted thing is one type.

## What dies in W8

Verified at HEAD `cad345ba` (W7 base) against
`plans/AGENT-LOOP-COMPARISON.md`'s reference index:

- `Machine.make` instantiation + transition table at
  `agent-loop.ts:2754-2852` (~100 LOC).
- `Machine.spawn` + recovery/durability lifecycle at
  `agent-loop.ts:2854-2917` (~60 LOC).
- Inspector publish bridge `agent-loop.ts:1984-2028` (~45 LOC).
- `failActorExit`, `actorCauseFailure`, `awaitIdlePersisted`,
  `awaitTurnFailure` helpers at `agent-loop.ts:1917-1981` (~65 LOC).
- `mapLoopActorCause` per-call cleanup `agent-loop.ts:2285-2307`
  (~25 LOC).
- `startingStateRef` reservation dance `agent-loop.ts:3228-3242`
  (~15 LOC).
- The `stateRef` / `queueRef` / `runtimeStateRef` projection mirror
  set + every site that updates them (`agent-loop.ts:2890-2895`,
  `2920-2942` + ~25 update sites).
- `agent-loop.state.ts` State/Event union + Schema for state
  snapshot fields (`agent-loop.state.ts:191-259`, ~70 LOC).
- `agent-loop.checkpoint.ts` multi-state branching.

What stays:

- Per-turn body (`runTurn`, `agent-loop.ts:2523-2752`) — already
  plain `Effect.gen`. Carved out unchanged.
- `resolveTurnContext` extension hook
  (`agent-loop.ts:488-660`) — extension-facing, untouched.
- `runTurnBeforeHook` (`agent-loop.ts:1163`) — untouched.
- `executeToolCalls` permission gating (`agent-loop.ts:1054-1122`)
  — untouched; the `WaitingForInteraction` plumbing it triggers now
  goes through the `Phase` Ref instead of an FSM event.
- `RuntimeCommand` write-surface and `dispatch(...)` — the public
  contract. Internal driver swap is invisible to consumers.
- `MachineEngine` (the per-extension actor host) — untouched. Lives
  until W10 deletes it.
- Wide-event boundary and Otel spans — preserved with light wiring
  changes only where the dropped FSM bridge surfaced them.

## Why this isn't a regression

| Today (FSM-driven)                                        | After W8 (plain Effect)                                                                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Idle ↔ Running` for "is a turn active?"                  | `phase._tag === "Running"` check on `Ref<AgentLoopState>`.                                                                             |
| `Running → Running` re-enter on `TurnDone` to drain queue | Inner `while(true)` in the per-turn fiber body (pi-mono's shape).                                                                      |
| `WaitingForInteraction` durable phase                     | `phase: { _tag: "WaitingForInteraction", ... }` in the same Ref.                                                                       |
| Resume after restart                                      | Checkpoint loads `AgentLoopState` (one flat Struct); fiber spawns into `Phase.WaitingForInteraction` and parks on the same `Deferred`. |
| `SwitchAgent` / `Interrupt` serialized via `actor.call`   | Same serialization via `sideMutationSemaphore` (already exists).                                                                       |
| `TurnFailed` event mapped from task `onFailure`           | Per-turn fiber's `Effect.catchAllCause` updates `phase` to `Idle` + records failure in `turnHistory`.                                  |
| Recovery/durability lifecycle plumbed via `Machine.spawn` | Single `loadCheckpoint` / `saveCheckpoint` pair; save points: phase change + queue change.                                             |
| `MachineInspected` tracing wide events                    | Plain `Effect.annotateSpans` + `WideEvent.set` at the same logical points. No bridge needed.                                           |

The two genuine FSM wins (durable suspension + send serialization)
are preserved. Everything else collapses.

---

## Implementation Batches

Order: phase-tag + single-Ref shape first (collapses all the
projection mirror sites), then driver swap (replaces FSM with
plain fiber), then checkpoint reshape (flat Struct over the new
shape), then test gate.

### Commit 1: `refactor(runtime): collapse loop state to single Ref<AgentLoopState> with phase tag`

**Why W8-1 first**: every later commit assumes one `Ref` is the
source of truth for loop state. Until `stateRef` / `queueRef` /
`runtimeStateRef` collapse into one, the FSM removal can't proceed
because each Ref has a separate update site.

**Approach**:

- Introduce `Phase` discriminated union and `AgentLoopState` Struct
  in `agent-loop.state.ts`.
- Replace the three Refs with one `SubscriptionRef<AgentLoopState>`.
- Every read site that did `Ref.get(stateRef)` /
  `Ref.get(queueRef)` / `Ref.get(runtimeStateRef)` becomes a
  projection over the single Ref.
- Every update site that fanned out to multiple Refs becomes one
  `Ref.update`.
- The FSM stays in this commit — it now reads/writes the single
  Ref instead of three. This is the migration step before W8-2
  swaps the driver.

**Files**: `packages/core/src/runtime/agent/agent-loop.ts`,
`packages/core/src/runtime/agent/agent-loop.state.ts`, plus every
test that asserts against `stateRef` / `queueRef` /
`runtimeStateRef` directly.

**Verification**: `bun run gate` + `bun run test:e2e` +
`bun run smoke`.

**Cites**: `derive-dont-sync`, `single-source-of-truth`,
`subtract-before-you-add`.

### Commit 2: `refactor(runtime): replace effect-machine driver with plain fiber + Ref<Phase>`

**Why W8-2**: the FSM goes away. With state already collapsed to a
single Ref (W8-1), the driver swap becomes mechanical:

- `Machine.make` + transition table → switch on `state.phase._tag`
  inside each `AgentLoopService` method.
- `Machine.spawn` → `Effect.forkScoped` of the per-turn fiber, with
  the spawned fiber stored in `Ref<Option<Fiber<TurnOutcome>>>`.
- `actor.call(Start)` / `actor.send(Interrupt)` etc. → method
  bodies acquiring `sideMutationSemaphore`, mutating
  `Ref<AgentLoopState>`, optionally interrupting + replacing the
  turn fiber.
- `failActorExit` / `actorCauseFailure` / `awaitIdlePersisted` /
  `awaitTurnFailure` / `mapLoopActorCause` / `startingStateRef`
  reservation dance → all delete; their work is now expressed
  natively (Phase transitions inside the semaphore-guarded methods,
  failures via `Effect.catchAllCause` on the turn fiber).
- Inspector publish bridge → replace with `Effect.annotateSpans` +
  `WideEvent.set` directly at the same logical points (Phase
  transition, turn start/end, interaction park/resume).

**Approach**: design-tier writes the driver shape. The blast radius
is contained to `agent-loop.ts` so apply-tier delegation isn't
warranted.

**Files**: `packages/core/src/runtime/agent/agent-loop.ts`,
`packages/core/src/runtime/agent/agent-loop.state.ts` (delete
State/Event union + Schema for snapshot, keep helpers/queue ops/
projection types).

**Verification**: `bun run gate` + `bun run test:e2e` +
`bun run smoke`.

**Cites**: `redesign-from-first-principles`,
`small-interface-deep-implementation`,
`subtract-before-you-add`.

### Commit 3: `refactor(runtime): reshape checkpoint to flat AgentLoopState struct`

**Why W8-3**: with the FSM gone, the checkpoint persists one
shape (`AgentLoopState`), not a state-tagged union. Collapse the
multi-state branching to a single `Schema.Struct` round-trip.

**Approach**:

- `agent-loop.checkpoint.ts` becomes one `Schema.Struct` for
  `AgentLoopState` plus encode/decode helpers.
- Recovery decision (`makeRecoveryDecision`,
  `agent-loop.ts:2030-2179`) reshapes against the flat struct: the
  branching that previously inspected which state-tag the snapshot
  was now inspects `phase._tag`.
- Save points: every `Ref.update` that changes `phase` or `queue`
  hands off to the checkpoint writer.

**Files**:
`packages/core/src/runtime/agent/agent-loop.checkpoint.ts`,
`packages/core/src/runtime/agent/agent-loop.ts` (the
recovery-decision branch and the save-point hookup).

**Verification**: `bun run gate` +
`bun run test:e2e` (durable-suspension end-to-end test must pass —
session parks at `WaitingForInteraction`, process exits, restart
resumes the same `Deferred`).

**Cites**: `small-interface-deep-implementation`,
`make-impossible-states-unrepresentable`,
`derive-dont-sync`.

### Commit 4: `test(runtime): durable suspension + queue drain regression suite`

**Why W8-4**: closes the correctness bar. Two scenarios must be
tested end-to-end against the post-W8 driver:

1. **Durable suspension**: session enters `WaitingForInteraction`
   on a permission-needing tool call; checkpoint persists; new
   process loads the checkpoint; session resumes; the originating
   `respondInteraction` `Deferred` lookup correctly hands the
   answer back to the resumed turn fiber. Equivalent test exists
   today against the FSM; this is the same scenario re-pointed at
   the post-W8 substrate. Verifies the _one_ FSM-justified feature
   is preserved.
2. **Queue drain**: while a turn is `Running`, multiple
   `runTurn` calls land. Each is queued; after `TurnDone` the
   inner `while(true)` drains them in order. Today's equivalent is
   the `Running → Running` re-enter; this verifies the plain-Effect
   inner-while shape preserves the order + count semantics.

Plus migrate the existing FSM-shaped tests in
`tests/runtime/agent-runner.test.ts` (3786-LOC parent, ~15
FSM-touching test bodies) to the post-W8 shape. Most are
behavioral and survive intact; ones that asserted on
`stateRef.machineState._tag` or similar internal-state details
update to assert against `state.phase._tag`.

**Files**: `packages/core/tests/runtime/agent-runner.test.ts`,
new `packages/core/tests/runtime/agent-loop-suspension.test.ts`,
new `packages/core/tests/runtime/agent-loop-queue-drain.test.ts`.

**Verification**: `bun run gate` + `bun run test:e2e`.

**Cites**: per test (most cite
`make-impossible-states-unrepresentable` for phase-tag invariants
and `redesign-from-first-principles` for the suspension scenario).

---

W8 closes when the FSM is gone from the agent-loop, the gate is
green, and the durable-suspension regression test passes
end-to-end. **`plans/WAVE-9.md`** is the next wave: actor primitive
foundation (`ActorRef`, `Behavior`, `ActorContext`, `ServiceKey`,
`Receptionist`, `tell`, `ask`, persistence). W9 is foundation work
only — no migrations.
