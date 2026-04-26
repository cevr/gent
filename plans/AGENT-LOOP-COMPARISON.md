# Agent-Loop Comparison: gent vs pi-mono

Planning artifact for Wave 8 (agent-loop simplification). Recorded
2026-04-26 on the substrate at HEAD `cad345ba`. Cited from
`plans/WAVE-8.md`.

## Context

The W6 closing audit raised a follow-on question: is `effect-machine`
the right tool for gent's agent-loop, or is it dogfood-tax masking
accidental complexity? `pi-mono` (`badlogic/pi-mono`) ships an agent
harness with the same featureset minus extensions/persistence/projections,
in 1.2k LOC of plain TypeScript. gent's agent-loop is 4.1k LOC of
Effect 4.x + `effect-machine`. The gap is partially genuine featureset
and partially Effect-vs-plain-TS overhead, but a portion is
FSM-imposed overhead the analysis below identifies.

## Pi-mono's loop shape

Plain async-iterator/Promise loop:

- Entry seeding: `agentLoop(prompts, ctx, config)` returns an
  `EventStream`; emits `agent_start` + `turn_start`, pushes prompts
  onto context — `pi-mono/packages/agent/src/agent-loop.ts:103-117`.
- Outer `while(true)` for follow-ups
  (`pi-mono/packages/agent/src/agent-loop.ts:168`); inner
  `while (hasMoreToolCalls || pendingMessages.length > 0)`
  (`pi-mono/packages/agent/src/agent-loop.ts:172`).
- Steering injection drained via `config.getSteeringMessages()` callback
  before each assistant response
  (`pi-mono/packages/agent/src/agent-loop.ts:165, 180-188, 216`).
- Stream assistant: `streamAssistantResponse` walks
  `for await (event of response)`, mutating a partial message
  in-place; emits `message_update` per chunk
  (`pi-mono/packages/agent/src/agent-loop.ts:238-330`).
- Tool dispatch: `executeToolCalls` filters `content.type === "toolCall"`;
  sequential or parallel split by `config.toolExecution`
  (`pi-mono/packages/agent/src/agent-loop.ts:336-348`).
- Loop continuation: pushes results onto context; emits `turn_end`;
  re-polls steering
  (`pi-mono/packages/agent/src/agent-loop.ts:204-216`).
- Follow-ups: when no more tool calls, polls `getFollowUpMessages` and
  re-enters inner loop
  (`pi-mono/packages/agent/src/agent-loop.ts:220-225`).
- Interrupts: single `AbortSignal` threaded everywhere
  (`pi-mono/packages/agent/src/agent-loop.ts:194-198`). Session-level
  concerns (queues, abort lifecycle, `prompt()` re-entrancy guard) live
  in the `Agent` class wrapper
  (`pi-mono/packages/agent/src/agent.ts:130-160, 374-398`).
- No persistence, no human-interaction suspension, no recovery, no
  extensions, no projections.

## Gent's loop shape

Per-turn body (`runTurn`,
`gent/packages/core/src/runtime/agent/agent-loop.ts:2523-2752`) is
itself a plain `Effect.gen` `while(true)` doing what pi-mono does:
resolve turn → pre-turn extension hook → stream → dispatch tools (may
throw `ToolInteractionPending` to suspend) → finalize. The body
returns `TurnDone | TurnFailed | InteractionRequested`.

`effect-machine` is wrapped _around_ that body:

- 3 states (`agent-loop.state.ts:233-245`): `Idle`, `Running`,
  `WaitingForInteraction`.
- 7 events (`agent-loop.state.ts:247-259`): `Start`, `TurnDone`,
  `TurnFailed`, `InteractionRequested`, `InteractionResponded`,
  `SwitchAgent`, `Interrupt`.
- Transition table at `agent-loop.ts:2754-2852`.
- Spawn + recovery/durability lifecycle at `agent-loop.ts:2854-2917`.
- Outer dispatch (`runTurn`, `applySteer`, `respondInteraction`,
  `agent-loop.ts:3244-3376`) drives the actor with `actor.call(...)` /
  `actor.send(...)`.

So `effect-machine` drives the multi-turn outer loop, queue draining,
suspension on human approval, and persistence. The inner per-turn
`resolve→stream→tools` is not FSM-driven — it's already plain
`while(true)`.

`MachineEngine` (`runtime/extensions/resource-host/machine-engine.ts`)
is a _separate, distinct_ host: it spawns one `effect-machine` actor
per extension per session. Unrelated to the agent-loop's own machine.
`agent-loop.ts:2185, 2201` only takes `MachineEngine` because per-turn
`resolveTurnContext` dispatches `execute(...)` against extension actors.

## Size delta breakdown (3786 vs 616 LOC, ~6×)

- **(i) Genuine featureset gent has and pi-mono lacks** — extension
  hooks (`resolveTurnContext` `agent-loop.ts:488-660`,
  `runTurnBeforeHook` `1163`), permission gating (`executeToolCalls`
  `1054-1122` + `WaitingForInteraction` plumbing), checkpoint persistence
  (`agent-loop.checkpoint.ts` + `makeRecoveryDecision` `2030-2179`),
  event publishing/wide-events, driver abstraction (external vs internal,
  `729-1052`), agent switching, branched sessions, queue persistence,
  `MachineInspected` tracing, multi-session loop registry.
  **~60-65% of LOC.**
- **(ii) Effect-vs-plain-TS overhead** — `Layer.effect`, service yields
  (`agent-loop.ts:2196-2219`), `Effect.fn` wrappers,
  `pipe(Effect.catchEager(...))`, `Schema.TaggedStruct` command schemas
  (`1736-1788`), `Ref`/`SubscriptionRef`/`Deferred`/`Scope` plumbing for
  what pi-mono does with class fields. **~20-25%.**
- **(iii) `effect-machine` machinery** — `agent-loop.state.ts` (356 LOC:
  state/event declarations, builders, projections, queue helpers);
  `agent-loop.checkpoint.ts` (87 LOC, exists _because_ the machine has
  snapshot-able state); `Machine.make`/transition table
  (`agent-loop.ts:2754-2852`, ~100 LOC); recovery/durability lifecycle
  wiring (~60 LOC); inspector publish bridge (`1984-2028`);
  `failActorExit` / `actorCauseFailure` / `awaitIdlePersisted` /
  `awaitTurnFailure` (`1917-1981`); `startingStateRef` reservation dance
  (`3228`); per-call `mapLoopActorCause` cleanup (`2285-2307`).
  **~10-15%, ~400-500 LOC of pure FSM-host overhead.**

## Does `effect-machine` carry weight in the loop?

For each FSM-shaped concern:

- **`Idle ↔ Running` for "is a turn active?"** — could be one
  `Ref<Option<RunningContext>>`. The transition is a single bit plus a
  `sideMutationSemaphore` that already exists to serialize
  (`agent-loop.ts:2838`). The machine adds nothing semantic. **Plain
  Effect+Ref equally clear.**

- **`Running → Running` re-enter on `TurnDone` to drain queue**
  (`agent-loop.ts:2777-2787`) — pi-mono expresses this as outer
  `while(true)` inside `runTurn`'s body
  (`pi-mono agent-loop.ts:168-228`). The reenter trick is _required_
  because the FSM models per-turn as a one-shot task; queue drain has
  to be expressed as a transition. **Plain async loop is cleaner. The
  FSM masks the natural shape.**

- **`WaitingForInteraction`** — genuine FSM territory: the loop must
  durably suspend, survive process restart, resume from a tool-call ID.
  But the machine's `WaitingForInteraction` carries the same fields as
  `Running` plus two strings (`agent-loop.state.ts:240-244`); the resume
  transition (`agent-loop.ts:2823-2833`) just copies fields back. The
  interesting work — "did the interaction get answered?" — is a
  `Deferred` lookup in `respondInteraction`
  (`agent-loop.ts:3360-3376`). What `WaitingForInteraction` actually
  buys you is a _snapshottable durable phase tag_ plus a guard that
  `Interrupt` does the right thing in the cold state. That's worth ~1
  boolean field. A plain `Ref<Phase>` enum + the existing checkpoint
  storage gets you the same thing.

- **`SwitchAgent` / `Interrupt`** — message sends to a running fiber.
  `effect-machine`'s mailbox/serialization is doing real work:
  `actor.call(...)` is queued behind the `Running` task
  (`agent-loop.ts:3300, 3314, 3324`). But pi-mono solves the same
  problem with `AbortController` + queue mutex
  (`pi-mono agent.ts:374, 132-135`). For two operations this is a thin
  win.

- **`TurnFailed`** — failure mapped to event by the task's `onFailure`
  (`agent-loop.ts:2851`). Could be a `try/catch` updating a `Ref` and
  continuing. **Plain Effect equally clear.**

- **Recovery/durability lifecycle** (`agent-loop.ts:2856-2913`) — the
  _only_ clean win: `Machine.spawn` plumbs in load+save callbacks at
  fixed lifecycle points. But the body of those callbacks
  (`makeRecoveryDecision` 150 LOC + manual `Ref.set` for queue/state/
  runtime — `agent-loop.ts:2890-2895`) is hand-rolled anyway. The FSM
  gives 3 well-defined save-points (state changes), but you have to
  manually mirror state into `stateRef` / `queueRef` /
  `runtimeStateRef` because consumers (`watchState`, `applySteer`'s
  `projectedState` check, `getState`) read from those Refs, not the
  actor snapshot. **The FSM and the Refs duplicate state.**

- **`startingStateRef` reservation** (`agent-loop.ts:3229`) — code reads
  the actor's state, decides what _will_ happen, writes the future
  state to a Ref, then sends the event. That dance exists because
  `actor.call(Start)` is async — observers reading via
  `currentRuntimeState` would see stale `Idle`. With a plain Ref and a
  `Phase` enum updated atomically before kicking off the turn fiber,
  the reservation goes away.

- **State/event snapshot serialization** (`agent-loop.checkpoint.ts` +
  `LoopStateBaseFields`/`RunningTurnFields` schemas,
  `agent-loop.state.ts:191-202`) — must hand-author Schema for every
  state field anyway. With plain Refs you'd write one `Schema.Struct`
  for the persisted shape. Net wash.

**Verdict on the FSM in the loop**: it carries weight in _exactly two_
places — durable suspension during human approval, and serializing
concurrent `Interrupt`/`SwitchAgent` against the running task.
Everything else (Idle/Running tracking, queue drain via re-enter,
TurnFailed/TurnDone bookkeeping, reservation dance, recovery wiring,
the projection Ref triplet) is overhead the FSM imposes rather than
solves. The duplicated `stateRef`/`queueRef`/`runtimeStateRef`
projection alongside the actor snapshot is the clearest sign of
accidental complexity masked by the FSM.

## Recommendation: drop `effect-machine` from the agent-loop

Justification:

- **`subtract-before-you-add`**: ~500 LOC of FSM machinery in
  `agent-loop.ts` deletes; `agent-loop.state.ts` collapses to ~80 LOC of
  pure helpers (keep queue/projection types, drop State/Event); 87 LOC
  of `agent-loop.checkpoint.ts` reshapes to a flat `Schema.Struct`. Net
  ~800 LOC of accidental complexity removed from the most-read file in
  the codebase.
- **`small-interface-deep-implementation`**: pi-mono's interface is
  `agentLoop(prompts, ctx, config) → EventStream` plus an `Agent` class
  wrapping abort/queue. Small interface, deep implementation. Gent's
  interface (`AgentLoopService` with `runTurn` / `applySteer` /
  `respondInteraction` / `recordToolResult` / `invokeTool` / `getState`
  / `watchState` / `terminateSession` / `restoreSession`) is wider but
  each method is shallow because the FSM is the implementation. With
  plain Effect, the surface collapses to a `Ref<Phase>` + `Fiber<Turn>`
  per session and the methods become `Ref.update` / `Fiber.interrupt`
  calls.
- **`redesign-from-first-principles`**: the per-turn body is _already_
  plain `Effect.gen while(true)`
  (`gent agent-loop.ts:2595-2733`). The FSM is grafted on as an outer
  driver whose only durable piece of work is "remember we're waiting
  for a human, survive restart". That can be a single `Phase` field
  in the existing checkpoint schema. The "actor" model isn't
  load-bearing — exactly one consumer per `(sessionId, branchId)`, no
  fan-out, no inter-actor protocol.
- **Dogfood is not a justification when the consumer is the wrong shape.**
  Two states + a `Deferred` + an `AbortController` is not a state
  machine; it's a fiber with a phase tag.

The "keep `effect-machine` in the loop, just drop `MachineEngine`" middle
option is the worst of both worlds: keep the duplicated Refs and the
reservation dance, lose the extension-actor justification for the
library, still pay the dogfood tax in the most-read file.

## Where `effect-machine` survives in gent

The library carries weight in two extension sites — these stay:

### `auto` (`packages/extensions/src/auto.ts`, 758 LOC)

3 states × 6+ events × 13 declared transitions
(`auto.ts:208-336`). Strong evidence this is a real FSM:

1. **Same event has different effects in different states.**
   `TurnCompleted` in `Working` increments + checks wedge limit; in
   `AwaitingReview` it's a no-op refresh; in `Inactive` it's not handled
   at all (rejected). `RequestHandoff` does different things in
   `Working` vs `AwaitingReview`. `AutoSignal` only makes sense in
   `Working`. With a `Phase` tag + flat `Ref<State>`, every event handler
   becomes `switch (phase)` — exactly what `.on(state, event, ...)`
   declares directly.
2. **The state IS the data.** `Inactive { reason }`,
   `Working { startedAt, iterations, planId, rows[], cooldown }`,
   `AwaitingReview { startedAt, awaitingSince, planId, rows[],
reviewerCooldown }`. The AwaitingReview-specific `awaitingSince` and
   `reviewerCooldown` are _meaningless_ in `Working`. The discriminated
   union makes invalid combinations unrepresentable. Flatten to one
   struct + `Phase` tag and you re-introduce the
   `state.awaitingSince === undefined when phase === Working`
   invariant by hand.

### `executor/actor` (`packages/extensions/src/executor/actor.ts`, 257 LOC)

`Idle | Connecting | Ready | Error` — connection lifecycle FSM.
Classically FSM-shaped: discrete states with different valid operations
in each. Not analyzed line-by-line here but the pattern matches `auto`.

## Where `effect-machine` does NOT carry weight

These sites drop FSM entirely (W10 actor migration converts them to
plain `Ref<S>` inside actor `Behavior`):

- `handoff` cooldown — single state holder.
- `artifacts` store — CRUD over a `Ref` shape.
- `memory` store — CRUD over a `Ref` shape.
- `exec-tools` notification queue — async-producer queue, no transitions.
- `skills` init flag — single boolean.
- agent-loop (this analysis).

## Net impact on planned waves

- **W8 (agent-loop simplification)**: drops `effect-machine` from
  `agent-loop.ts` + `agent-loop.state.ts`. ~800 LOC deletion. Does not
  touch `MachineEngine` (still used by extensions).
- **W10 (extension migration + surface collapse)**: 5 zero-transition
  state-holders migrate to plain `Ref<S>` inside actor `Behavior`. 2
  genuine FSMs (`auto`, `executor/actor`) keep `effect-machine` _as a
  library_, used inside their actor `Behavior`. `MachineEngine` _the
  host_ deletes — its consumers all moved to the new actor primitive.

## Reference index

- pi-mono loop body:
  `pi-mono/packages/agent/src/agent-loop.ts:155-232` (`runLoop`)
- pi-mono session wrapper:
  `pi-mono/packages/agent/src/agent.ts:130-160, 307-368, 374-398`
- gent runTurn body:
  `gent/packages/core/src/runtime/agent/agent-loop.ts:2523-2752`
- gent FSM declaration:
  `gent/packages/core/src/runtime/agent/agent-loop.state.ts:233-259`
- gent FSM transition table:
  `gent/packages/core/src/runtime/agent/agent-loop.ts:2754-2852`
- gent FSM spawn + recovery/durability:
  `gent/packages/core/src/runtime/agent/agent-loop.ts:2854-2917`
- gent reservation dance smell:
  `gent/packages/core/src/runtime/agent/agent-loop.ts:3228-3242`
- gent state projection Refs (duplicate of actor snapshot):
  `gent/packages/core/src/runtime/agent/agent-loop.ts:2890-2895, 2920-2942`
- `MachineEngine`:
  `gent/packages/core/src/runtime/extensions/resource-host/machine-engine.ts:1-311`
- `auto` machine:
  `gent/packages/extensions/src/auto.ts:208-336`
- `executor/actor` machine:
  `gent/packages/extensions/src/executor/actor.ts`
