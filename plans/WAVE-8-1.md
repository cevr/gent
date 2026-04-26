# W8-1 Synthesis: Collapse agent-loop state to single Ref<AgentLoopState>

**Phase 2 (Synthesis) of planify run.** Phase 3 (Codex review) skipped — no codex
access this session. Inspiration absorbed from `badlogic/pi-mono` per user
directive.

## Pi-mono Calibration (what the inspiration tells us)

`pi-mono/packages/agent/src/agent-loop.ts` is **683 LOC**; ours is **3786 LOC**.
The 5.5× ratio is mostly accidental complexity in the FSM driver and the
duplicated projection Ref triplet. Pi-mono's design points (relevant to W8-1):

1. **Single source of truth is the message array on `AgentContext`.** No state
   mirror, no event union, no projection Ref. Inline mutation, events emitted
   as side-channel via callback (`emit`).
2. **Two nested `while` loops express the entire driver** — outer for follow-up
   messages, inner for tool-call drain + steering injection. Exactly the
   `while(true)` shape WAVE-8.md targets, no FSM library needed.
3. **`stopReason` on the final message terminates the loop** — no separate
   "phase" enum tracking terminal states is required at the loop layer.
4. **Public `AgentState` is derived by the outer `Agent` class** by listening
   to its own emitted events (`isStreaming`, `pendingToolCalls`,
   `streamingMessage`). This is `derive-don't-sync` literal: state is computed
   from the event stream, not pushed into another Ref.
5. **Steering is a pull**, not a push: `getSteeringMessages()` callback at
   the top of the inner loop. Today our `appendSteeringItem` writes into
   `queueRef`; W8-1 keeps the queue (independent state) but reads it from
   the same single Ref.

What we adopt for W8-1 (not the whole wave):

- Single Ref shape with `phase` discriminator + `queue`.
- Reads via projection helpers (small pure functions on `AgentLoopState`),
  matching pi-mono's "compute on access" pattern for `AgentState`.
- `runtimeStateRef` collapses into a derived projection at the
  `watchState` boundary — pi-mono-style derive-from-source.

What we **don't** adopt in W8-1 (deferred or out-of-scope):

- Replacing `Machine.spawn` with `Effect.forkScoped` — that's W8-2.
- Reshape the checkpoint to a flat Struct — that's W8-3.
- Drop the `Phase`-style FSM driver semantics — also W8-2. W8-1 keeps the
  FSM in place, just rewires it to read/write the single Ref.

## Stream A + B agreed findings

| Finding                                                                       | Stream A | Stream B                             |
| ----------------------------------------------------------------------------- | -------- | ------------------------------------ |
| `stateRef` is a derived mirror of FSM state — clean delete                    | ✓        | ✓ (no test asserts on it)            |
| `queueRef` is independent state — fold into single Ref                        | ✓        | ✓                                    |
| `runtimeStateRef` is a projection — collapse at `watchState` boundary         | ✓        | ✓ (must project inside `watchState`) |
| Test impact small (zero direct Ref assertions)                                | ✓        | ✓                                    |
| Plan's `latestInputTokens` / `turnHistory` / `TurnId` don't exist yet — defer | ✓        | (silent)                             |
| Checkpoint version bump + migration required                                  | ✓        | (didn't surface)                     |
| Single commit acceptable; ~2-3 files                                          | (silent) | ✓                                    |

## Open questions resolved

1. **Should `AgentLoopState` include `latestInputTokens` / `turnHistory`?**
   **No** — those aren't in the current state shape; introducing them in W8-1
   would expand scope. WAVE-8.md plan describes the _post-W8_ shape; W8-1's
   job is the **collapse**, not the **expansion**. The W8-2/W8-3 commits can
   add them when the FSM is gone and there's a natural place for "turn
   metadata" to live.

2. **`TurnId` — new branded ID, or reuse `MessageId`?** **Reuse for now.** No
   `TurnId` exists today; we don't need it for the collapse. Defer to W8-2
   when the per-turn fiber gains a stable identity.

3. **Checkpoint migration approach.** Bump
   `AGENT_LOOP_CHECKPOINT_VERSION`; add a `migrateLegacyCheckpointJson`
   step that maps `{ state, queue }` → `{ phase, queue }` by reading the
   old `state._tag` and projecting it to the new `phase` discriminator
   (Idle → `{ _tag: "Idle" }`, Running → `{ _tag: "Running", ... }`, etc).
   Phase 3 (W8-3) will replace this with a cleaner schema; in W8-1 the
   migration is small and load-bearing for restart safety.

## Implementation Plan

### Target shape (`agent-loop.state.ts`)

```ts
export type Phase =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Running"; readonly turnStartedAt: Date }
  | {
      readonly _tag: "WaitingForInteraction"
      readonly toolCallId: ToolCallId
      readonly awaitingSince: Date
    }

export interface AgentLoopState {
  readonly phase: Phase
  readonly queue: LoopQueueState
}

// Pure projection helpers — pi-mono "compute on access" pattern
export const isRunning = (s: AgentLoopState): boolean => s.phase._tag === "Running"
export const isIdle = (s: AgentLoopState): boolean => s.phase._tag === "Idle"
export const phaseTag = (s: AgentLoopState): Phase["_tag"] => s.phase._tag

// Projection to the externally-observable runtime state (consumed by watchState)
export const projectRuntimeState = (s: AgentLoopState): LoopRuntimeState =>
  runtimeStateFromLoopState(phaseToLoopState(s.phase), s.queue)
```

The `LoopState` (FSM state union) and `runtimeStateFromLoopState` stay —
the FSM is still in place in W8-1. We add a tiny `phaseToLoopState` adapter
so the FSM's `Machine.spawn` keeps reading the same shape it does today.

> Why keep two type names side-by-side in W8-1? Because W8-2 deletes the
> FSM. Doing the rename + delete in one commit doubles the diff and makes
> review harder. W8-1 = collapse + adapter; W8-2 = delete FSM + remove
> adapter.

### Target shape (`agent-loop.ts`)

Replace the three Ref allocations at 2374-2382 with one
`SubscriptionRef<AgentLoopState>`:

```ts
const stateRef =
  yield *
  SubscriptionRef.make<AgentLoopState>({
    phase: { _tag: "Idle" },
    queue: emptyQueue,
  })
```

Add `LoopHandle.stateRef: SubscriptionRef<AgentLoopState>` (replaces the three
existing fields). Update every read site:

| Today                                                             | After W8-1                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `Ref.get(loop.stateRef)` returning FSM `LoopState`                | `Ref.get(loop.stateRef).pipe(Effect.map(s => phaseToLoopState(s.phase)))` |
| `Ref.get(loop.queueRef)`                                          | `Ref.get(loop.stateRef).pipe(Effect.map(s => s.queue))`                   |
| `SubscriptionRef.get(loop.runtimeStateRef)`                       | `Ref.get(loop.stateRef).pipe(Effect.map(projectRuntimeState))`            |
| `SubscriptionRef.changes(loop.runtimeStateRef)` (in `watchState`) | `loop.stateRef.changes.pipe(Stream.map(projectRuntimeState))`             |

Update every write site (per Stream A's count: 12 direct writes + helpers):

| Today                                                                                                     | After W8-1                                                                                                                 |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `Ref.set(stateRef, state); SubscriptionRef.set(runtimeStateRef, ...); Ref.set(queueRef, queue)` (fan-out) | `Ref.update(loop.stateRef, s => ({ phase: loopStateToPhase(state, s.phase), queue }))`                                     |
| `takeNextQueuedTurnSerialized` (2485-86 — read+set queue)                                                 | `Ref.modify(loop.stateRef, s => { const r = takeNextQueuedTurn(s.queue); return [r.nextItem, { ...s, queue: r.queue }] })` |
| Recovery path (2890-2895 — three separate sets)                                                           | one `Ref.update`                                                                                                           |
| `persistRuntimeSnapshot` (3656-58)                                                                        | `Ref.update` over the single Ref                                                                                           |

### Target shape (`agent-loop.checkpoint.ts`)

Bump version + add migration. Don't reshape the schema yet — that's W8-3.
The persisted JSON now wraps the new struct:

```ts
export const AGENT_LOOP_CHECKPOINT_VERSION = 2 // was 1

// in migrateLegacyCheckpointJson
case 1: {
  const v1 = json as { state: LegacyLoopStateJson; queue: LoopQueueStateJson }
  const phase = legacyStateToPhase(v1.state) // straight projection
  return { version: 2, phase, queue: v1.queue }
}
```

`buildLoopCheckpointRecord` and `shouldRetainLoopCheckpoint` accept the new
struct. The two `state.state._tag !== "Idle"` and `stateTag: params.state._tag`
lines reshape to `state.phase._tag !== "Idle"` and `phaseTag: params.state.phase._tag`.

### Test impact

Per Stream B: zero direct Ref assertions in tests. Tests survive intact through
the public `AgentLoopService` interface. Two specific spots flagged:

- `tests/runtime/agent-runner.test.ts` lines 2751-2944 — checkpoint-seed helpers
  may construct fixture state. Update to new shape.
- `tests/runtime/agent-loop-checkpoint.test.ts` (if it exists) — migration test
  for `version: 1 → 2`.

`MachineInspected` event tests don't need W8-1 changes (FSM still in place).

## Files touched

1. `packages/core/src/runtime/agent/agent-loop.state.ts` — add `Phase`,
   `AgentLoopState`, projection helpers, `phaseToLoopState` adapter.
2. `packages/core/src/runtime/agent/agent-loop.ts` — replace 3 Refs with 1,
   rewire ~25 read sites and ~12 write sites, project at `watchState`.
3. `packages/core/src/runtime/agent/agent-loop.checkpoint.ts` — version bump,
   migration step, reshape `state` field to `phase`.
4. `packages/core/tests/runtime/agent-runner.test.ts` — update fixture
   helpers if they construct state directly.
5. (new, optional) `packages/core/tests/runtime/agent-loop-migration.test.ts`
   — verify `version: 1 → 2` migration on a recorded legacy checkpoint blob.
   If trivial, fold into `agent-runner.test.ts`.

## Verification

```bash
bun run gate        # typecheck + lint + fmt + build + test
bun run test:e2e    # PTY + supervisor + worker-http (durable suspension)
bun run smoke       # headless mode
```

The durable-suspension scenario is the W8 correctness bar. If a session
parked in `WaitingForInteraction` at process exit doesn't resume on restart,
the migration is wrong.

## Cited principles

- `derive-don't-sync` — `runtimeStateRef` is a projection; deriving at
  `watchState` boundary kills synchronization.
- `subtract-before-you-add` — three Refs collapse into one; no new shape
  introduced beyond the minimum needed.
- `make-impossible-states-unrepresentable` — `Phase` discriminator
  prevents "queue exists but state thinks we're Idle" inconsistencies that
  are reachable today via skewed Refs.
- `migrate-callers-then-delete-legacy-apis` — adapter (`phaseToLoopState`)
  keeps the FSM driver intact in W8-1; W8-2 deletes both the FSM and
  the adapter together.

---

## Precise execution recipe (apply-tier ready)

### Step 1: Rename FSM `AgentLoopState` → `LoopMachineState`

In `packages/core/src/runtime/agent/agent-loop.state.ts`:

- Line 233: `export const AgentLoopState = State({` → `export const LoopMachineState = State({`
- Line 263: `export type LoopState = typeof AgentLoopState.Type` → `typeof LoopMachineState.Type`
- Line 267: same — `typeof AgentLoopState.Type` → `typeof LoopMachineState.Type`
- Line 294: `AgentLoopState.Idle({` → `LoopMachineState.Idle({`
- Line 302: `AgentLoopState.Running({` → `LoopMachineState.Running({`
- Line 317: `AgentLoopState.WaitingForInteraction.with(` → `LoopMachineState.WaitingForInteraction.with(`
- Line 326: `AgentLoopState.with(` → `LoopMachineState.with(`

In `packages/core/src/runtime/agent/agent-loop.ts`:

- Line 120: import `AgentLoopState` from `./agent-loop.state.js` → import `LoopMachineState` instead
- Lines 1927, 2303, 2755, 2760, 2764, 2768, 2769, 2777, 2788, 2799, 2808, 2812, 2823, 2826, 2836:
  `AgentLoopState` → `LoopMachineState` (mechanical replace_all)

In `packages/core/src/runtime/agent/agent-loop.checkpoint.ts`:

- Line 3: import — `AgentLoopState` → `LoopMachineState`
- Line 8: `state: AgentLoopState` → `state: LoopMachineState`

### Step 2: Add new `AgentLoopState` aggregate Struct

In `agent-loop.state.ts`, after the `LoopMachineState` definition:

```ts
// ── Aggregate (post-W8-1 single-Ref shape) ──

export interface AgentLoopState {
  readonly state: LoopState
  readonly queue: LoopQueueState
  readonly startingState: LoopState | undefined
}

export const buildInitialAgentLoopState = (params: {
  state: LoopState
  queue?: LoopQueueState
}): AgentLoopState => ({
  state: params.state,
  queue: params.queue ?? emptyLoopQueueState(),
  startingState: undefined,
})

// Projections
export const projectLoopState = (s: AgentLoopState): LoopState => s.state
export const projectQueue = (s: AgentLoopState): LoopQueueState => s.queue
export const projectRuntimeState = (s: AgentLoopState): LoopRuntimeState =>
  runtimeStateFromLoopState(s.state, s.queue)
```

(Fields named `state` and `queue` to keep the diff small — every existing
read site like `Ref.get(stateRef)` becomes `Effect.map(s => s.state)`.)

### Step 3: Rewire `LoopHandle` and `makeLoop` to a single `SubscriptionRef<AgentLoopState>`

In `agent-loop.ts`, change `LoopHandle` (line 1849-1883):

```diff
 type LoopHandle = {
   actor: LoopActor
   activeStreamRef: Ref.Ref<ActiveStreamHandle | undefined>
-  stateRef: Ref.Ref<LoopState>
-  startingStateRef: Ref.Ref<LoopState | undefined>
-  queueRef: Ref.Ref<LoopQueueState>
+  loopRef: SubscriptionRef.SubscriptionRef<AgentLoopState>
   idlePersistedRef: SubscriptionRef.SubscriptionRef<number>
   turnFailureRef: SubscriptionRef.SubscriptionRef<TurnFailureState>
   sideMutationSemaphore: Semaphore.Semaphore
   queueMutationSemaphore: Semaphore.Semaphore
   persistenceFailure: Effect.Effect<void, AgentLoopError>
-  runtimeStateRef: SubscriptionRef.SubscriptionRef<LoopRuntimeState>
   ...
```

Replace allocations 2374-2384 with one `SubscriptionRef.make(buildInitialAgentLoopState({ state: initialLoopState, queue: initialQueue }))`. Remove `runtimeStateRef`.

### Step 4: Rewire all read sites

Find/replace patterns (each is a single deterministic transform):

| Read pattern                                        | Replacement                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| `Ref.get(stateRef)` (inside `makeLoop`)             | `SubscriptionRef.get(loopRef).pipe(Effect.map(s => s.state))`             |
| `Ref.get(loop.stateRef)` (outside)                  | `SubscriptionRef.get(loop.loopRef).pipe(Effect.map(s => s.state))`        |
| `Ref.get(queueRef)`                                 | `SubscriptionRef.get(loopRef).pipe(Effect.map(s => s.queue))`             |
| `Ref.get(loop.queueRef)`                            | `SubscriptionRef.get(loop.loopRef).pipe(Effect.map(s => s.queue))`        |
| `Ref.get(startingStateRef)`                         | `SubscriptionRef.get(loopRef).pipe(Effect.map(s => s.startingState))`     |
| `SubscriptionRef.get(loop.runtimeStateRef)`         | `SubscriptionRef.get(loop.loopRef).pipe(Effect.map(projectRuntimeState))` |
| `SubscriptionRef.changes(loop.runtimeStateRef)`     | `loop.loopRef.changes.pipe(Stream.map(projectRuntimeState))`              |
| `SubscriptionRef.get(idlePersistedRef)` (line 2401) | unchanged                                                                 |

### Step 5: Rewire all write sites — coalesce into `Ref.update`

The critical write site is `persistRuntimeSnapshot` at lines 2392-2434. Today it
fans out three writes (`runtimeStateRef`, `stateRef`, `startingStateRef`) after
checkpoint I/O. Replace with one `Ref.update(loopRef, s => ({ state, queue, startingState: undefined }))` after the I/O.

| Write site (line)                     | Today                                              | After                                                                                                                  |
| ------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 2402 (idle counter)                   | `SubscriptionRef.set(idlePersistedRef, count + 1)` | unchanged                                                                                                              |
| 2404-2409 (idle path: 3 writes)       | 3× set                                             | `Ref.update(loopRef, _ => ({ state, queue, startingState: undefined }))`                                               |
| 2423-2425 (retain path: 3 writes)     | 3× set                                             | same `Ref.update`                                                                                                      |
| 2461 (`updateQueue`)                  | `Ref.set(queueRef, nextQueue)`                     | `Ref.update(loopRef, s => ({ ...s, queue: nextQueue }))`                                                               |
| 2469 (`persistQueueState`)            | same                                               | same                                                                                                                   |
| 2475 (`persistQueueSnapshot`)         | same                                               | same                                                                                                                   |
| 2486 (`takeNextQueuedTurnSerialized`) | `Ref.set(queueRef, queue)`                         | `Ref.update(loopRef, s => ({ ...s, queue }))`                                                                          |
| 2890-2895 (recovery)                  | 3× set                                             | `Ref.update(loopRef, _ => ({ state: recovered.value.state, queue: recovered.value.queue, startingState: undefined }))` |
| 3658 (`getState` cache write)         | `SubscriptionRef.set(loop.runtimeStateRef, state)` | **DELETE** — `getState` no longer needs to write back; runtime state derives.                                          |

The recovery callback `Ref.set(startingStateRef, ...)` references at the recovery callsite must be handled — `startingState` is now part of the aggregate. Inspect line 3228-3242 and rewrite to set `startingState` field via `Ref.update` if needed.

### Step 6: Update `LoopHandle` exports (lines 2920-2942 return)

Drop `stateRef`, `startingStateRef`, `queueRef`, `runtimeStateRef` from the
returned record. Add `loopRef`.

### Step 7: Update consumers

Run `bun run typecheck` to surface every remaining `loop.stateRef` /
`loop.queueRef` / `loop.runtimeStateRef` / `loop.startingStateRef` reference.
Replace per Step 4 patterns. Expected ~25 sites in `agent-loop.ts`.

### Step 8: Verify

```bash
bun run gate
bun run test:e2e   # specifically the durable-suspension test
bun run smoke
```

### What this does NOT touch

- `LoopMachineState` (the FSM `State()` union) — unchanged, still drives the actor.
- `agent-loop.checkpoint.ts` — unchanged. The persisted JSON shape is identical (still `{ state, queue }`); we encode/decode against the in-memory FSM `LoopState` exactly as today.
- `runtimeStateFromLoopState` — unchanged.
- All projection helpers (`buildIdleState`, `buildRunningState`, etc.) — unchanged.
- The FSM transition table at lines 2755-2852 — unchanged.
- Any test in `tests/` — likely zero direct asserts (per Stream B).
