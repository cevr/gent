# Machines (stage 3, P3): design for the counsel review

Status: design only, 2026-10-17. Nothing here is built. It answers the plan's
first stage-3 item in [kernel-orchestration.md](kernel-orchestration.md) (P3, Status
"Shared seam", Stages 3, R3): the core activation seam and the machine schema.
Line numbers are against `main` at `6f8cdaf7e` (no file under
`packages/core/src` or `packages/extensions/src` changed since `0cc96960b`).
Revised once after the design review; see "Review round 1" at the end.

## Summary

- Core gains one durable verb: `Session.wakeAt({ sourceId, at?, sessionId?, branchId? })`,
  with `Session.cancelWake`, and one hook kind, `wakeDue`. Core keeps the
  records in a new `branch_wakes` table and fires them from one server fiber.
  A fire opens the branch through its actor and runs the asking extension's
  `wakeDue` hook there. A record with a time fires at that time. A record with
  no time fires at the next server start. The hook says what happens next.
- A fire opens the loop without recovery's turn start (D1). The loop holds its
  recovery deferred until the next ordinary operation promotes it (A11). Any
  other build promotes at once, as before (Commit 1 facts, F1).
- Machines, warm pre-lapse handoffs and `@gent/wake` alarms all use it. No
  extension sweeps sessions at startup. Core reads only the rows that
  extensions wrote.
- `@gent/machines` is an extension in `packages/extensions/src/machines.ts`. It
  drives `Threads` with `notify: "none"` and spawns commands itself. It keeps
  `machine_runs` and `machine_steps`, and it records each action before it
  dispatches the action.

## Part A. The core activation seam

### A1. What exists today

- **Passivation.** The cluster reaper passivates an idle entity after
  `entityMaxIdleTime`, one minute by default
  (`node_modules/.bun/effect@4.0.0-rc.112/.../cluster/ShardingConfig.ts:190`). The
  branch scope closes with the entity (`packages/core/src/runtime/agent-loop.ts:1790-1813`).
  The residency count drives `Entity.keepAlive` (`agent-loop.ts:1824-1853`).
- **Holds.** `Session.holdResident` holds the loop resident until its scope
  closes (`packages/core/src/domain/extension.ts:1221-1228`). The facade gets it from
  the loop's `sessionControl` (`agent-loop.ts:1973`). A run outside a loop holds
  nothing (`packages/core/src/runtime/extension-host.ts:4522-4526`). The local test
  actor has no reaper, so there a hold does nothing (`agent-loop.ts:1806-1808`).
- **Opening a loop.** The actor opens its loop when the entity is built, unless
  the session is terminated (`agent-loop.ts:3343-3352`). The open resumes a
  cut-short user turn, or starts a queued turn that asked to wake
  (`agent-loop.ts:3297-3318`, `wantsWakeOnRecovery` at `agent-loop.ts:277-290`).
  Then it starts the `loopOpen` activations (`agent-loop.ts:3334-3337`). They run
  off the caller's path, without the side-mutation permit, and cannot ask
  (`agent-loop.ts:2479-2496`, `extension.ts:642-653`).
- **No start hook.** Loops are lazy: no startup pass rebuilds them, so a session
  that nobody opens runs no `loopOpen` (ARCHITECTURE.md:2218-2221). Startup builds
  only the launch cwd's profile (`packages/core/src/server/server.ts:2186-2199`). It
  also re-wakes branches whose interaction was answered
  (`interactionRecoveryLive`, `server.ts:2211-2247`). That pass is the one
  precedent for core waking named branches from a durable table at start.
- **Server Resources.** A server-scope build reads only the host services: the
  platform, `SqlClient` and `InteractionStorage` (`extension.ts:158`,
  `extension.ts:176-201`). It has no `ExtensionContext`. It builds when a
  profile that holds its extension resolves (`extension-host.ts:3196-3221`).
- **Cluster messages.** The actor's persisted operations are stored in SQL
  through encore's storage (`packages/core/src/storage/storage.ts:2197`). The
  runner keeps its shard locks in memory (`server.ts:2141-2148`). Effect's cluster
  can deliver a persisted message at a time (`DeliverAt`; the SQL query filters
  on `deliver_at` at `SqlMessageStorage.ts:443`). It reads the storage every
  `entityMessagePollInterval`, ten seconds by default (`ShardingConfig.ts:193`).

### A2. What `@gent/wake` does today

- **Arming.** A tool stores the entry in a per-branch JSON file under
  `<data dir>/wakes` (`packages/extensions/src/wake.ts:242-249`). Then it forks a timer
  into the branch-scoped `WakeAlarms` FiberMap (`wake.ts:739-745`, `wake.ts:686-714`).
  The timer holds the loop resident until it fires (`wake.ts:676-685`, `wake.ts:698`).
  It sleeps to the due time, then queues a `wake` message, deduplicated by
  `fireKey` (`wake.ts:505-539`, `wake.ts:293-296`, `wake.ts:321-372`).
- **Restart.** The `loopOpen` hook re-arms every stored entry, and past-due
  alarms fire at once (`wake.ts:1400-1416`, `wake.ts:723-737`).
- **A due alarm while gent is down.** Nothing fires it until something opens the
  branch. Opening the session is enough (ARCHITECTURE.md:1665). A branch that
  nobody opens never fires, and every pending alarm keeps its loop resident for
  up to 24 hours (`wake.ts:178`). The auto-resume alarm already guards lateness:
  a fire more than ten minutes past due leaves a notice and starts no turn
  (`wake.ts:436`, `wake.ts:465-470`).

### A3. The two consumers

1. **A machine run** with an open action must keep moving. After a restart it
   must resume with no owner message.
2. **The warm pre-lapse handoff** must wake an idle, passivated branch before
   its prompt cache lapses, with no user message, also across a restart.

Both need the same thing: run this extension's code on that branch at a time,
or at the next start, even when no loop is open.

### A4. The options

**(a) `BranchActivation.activate({ sessionId, branchId })` facet verb, plus a
server Resource that activates its extension's branches on its own start.**

- The verb alone is cheap. But "a server Resource, on its own start" has no
  `ExtensionContext`, so it cannot call a facet verb (`extension.ts:176-201`).
  Core would have to add the verb to the build services. That is a second,
  build-time authority surface.
- A server Resource builds only when a profile that holds its extension
  resolves. At start that is the launch cwd's profile only
  (`server.ts:2186-2199`, `extension-host.ts:3196-3221`). So a shipped extension
  resumes at boot, and a user extension of another project does not. That
  breaks "a shipped extension is never more privileged than a user extension"
  (NORTH_STAR.md, Owner rules).
- It covers no time. The warm handoff and the alarms still need a timer that
  survives passivation. Each extension would then own a server timer, a table
  and a start scan. That is the same mechanism, written once per extension.
- Activation without a hook gives the extension nothing to run on an already
  open loop: `loopOpen` runs once per build, not per activation.

**(b) An extension start hook (`host.on("serverStart")`).**

- Hooks belong to a profile. At start, only the launch profile exists, so the
  hook has the same place asymmetry as (a).
- The hook has no branch, so it has no `ExtensionContext` to act with.
- It invites every extension to sweep its state at boot. The owner rejected a
  startup sweep of unopened sessions (NORTH_STAR.md, Rejected).
- It covers no time either.

**(c) A durable core wake record that core persists and fires.** Chosen.

- One general verb covers both consumers. "Activate now" is `at: now`.
  "Resume after a restart" is a record with no time.
- Core fires the record through the branch's actor, in its mailbox (actor
  model). The branch's own profile loads the extension, wherever the project
  is. So a user extension gets exactly what a shipped one gets.
- Core reads only the rows extensions wrote, by index. No session is swept.
- The fire runs a hook and returns. Nothing waits on a branch, so children
  still wake and never block.

**(c′) The same record as a cluster message with `DeliverAt`.** Rejected.

- A cluster message cannot mean "at the next start": a processed message is
  never delivered again, and an unprocessed one waits for its time.
- Delivery is up to ten seconds late (`ShardingConfig.ts:193`). That is too
  coarse for alarms.
- A re-arm under the same key is a delete and a resend (encore's `rerun`), which
  is not one atomic write.

### A5. The chosen seam: signatures

On `ExtensionSessionService` (`packages/core/src/domain/extension.ts:1078`), beside
`holdResident`:

```ts
/**
 * Asks core to run this extension's `wakeDue` hook on a branch (the current
 * one when none is named): at `at` (epoch ms), or, with no `at`, at the next
 * server start. The record is durable and survives passivation and restarts.
 * The calling extension and `sourceId` name it: a repeat with the same
 * `sourceId` replaces `at` (no `at` keeps an earlier time already set). Any
 * extension may wake any branch of the workspace; a fire runs only the
 * calling extension's own hook there.
 */
readonly wakeAt: (params: {
  readonly sourceId: string
  readonly at?: number
  readonly sessionId?: SessionId
  readonly branchId?: BranchId
}) => Effect.Effect<void, ExtensionServiceError>
/** Removes a wake record; false when there was none. */
readonly cancelWake: (params: {
  readonly sourceId: string
  readonly sessionId?: SessionId
  readonly branchId?: BranchId
}) => Effect.Effect<boolean, ExtensionServiceError>
```

The hook kind, in `ExtensionHookSignatures` (`extension.ts:631-666`):

```ts
/** What a `wakeDue` handler asks for next. */
export const WakeNext = Schema.TaggedUnion({
  /** The work is done: the record goes. */
  Done: {},
  /** Fire again at this time (epoch ms). */
  At: { at: Schema.Finite },
  /** Keep the record; fire it again only at the next server start. */
  AtStart: {},
})
export type WakeNext = typeof WakeNext.Type

export interface WakeDueInput {
  readonly sourceId: string
  /** The time the record was due; none for a start-only record. */
  readonly at: Option.Option<number>
  /** `due`: its time came while the server ran. `start`: the startup pass fired it. */
  readonly cause: "due" | "start"
}

// in ExtensionHookSignatures
readonly wakeDue: { readonly input: WakeDueInput; readonly output: WakeNext }
```

- An extension registers at most one `wakeDue` handler. A second one fails the
  extension load, as a duplicate capability id does.
- The handler runs in the branch's `ExtensionContext`, as a `loopOpen` handler
  does. No user watches it, so it cannot ask.
- The leaf's extension id comes from the leaf context, as `send` stamps its
  metadata (`extension.ts:1414-1419`). An extension cannot write another
  extension's record.

### A6. Where the state lives

A core migration adds one table. It is additive, so the owner rule on
persisted formats holds.

```sql
CREATE TABLE branch_wakes (
  incarnation INTEGER PRIMARY KEY AUTOINCREMENT, -- never used again (F20)
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  extension_id TEXT NOT NULL,
  source_id TEXT NOT NULL CHECK (length(source_id) <= 200),
  at INTEGER,                        -- NULL: the next server start only
  version INTEGER NOT NULL,          -- bumped by every wakeAt
  attempts INTEGER NOT NULL DEFAULT 0,
  armed_boot INTEGER NOT NULL,       -- the server start that inserted it (F21)
  created_at INTEGER NOT NULL,
  UNIQUE (session_id, branch_id, extension_id, source_id),
  FOREIGN KEY (branch_id, session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE
);
CREATE INDEX branch_wakes_due ON branch_wakes (at) WHERE at IS NOT NULL;
CREATE TABLE branch_wake_boots (id INTEGER PRIMARY KEY CHECK (id = 1), boot INTEGER NOT NULL);
```

- **Storage.** `BranchWakeStorage` is a focused repository in
  `packages/core/src/storage/storage.ts`, beside the others
  (`storage.ts:2182-2201`). The DDL goes into `packages/core/src/storage/schema.ts`.
- **Service.** `BranchWakes` (upsert, cancel, and a latch that tells the clock
  to re-read) is a server service, in the `models` level of `createDependencies`,
  beside `FileLockService` (`server.ts:2303-2313`). Every facade builder can then
  yield it.
- **Clock.** `branchWakeClockLive` is a forked server fiber. It sits beside
  `interactionRecoveryLive`, above the actor layer (`server.ts:2323-2324`), and
  lives in the actor section of `runtime/agent-loop.ts` under a "durable wakes"
  banner. It is one concern with residency, so it adds no file.
- **Actor operation.** `FireWake` is added to the `AgentLoop` entity
  (`packages/core/src/domain/agent-loop.ts:672`). Its payload is `{ workspaceId,
  sessionId, branchId, extensionId, sourceId, at, cause }`, and it is not
  persisted: the row is the durable record. Its success is a
  `WakeFired = TaggedUnion({ Handled: { next: WakeNext }, Gone: {}, Unhandled: {} })`.

Every root goes through `createDependencies` (`packages/core/src/test-utils/harness.ts:1886-1972`,
`packages/sdk/src/server.ts:132`), so one wiring covers the SDK, `createE2ELayer` and
`baseLocalLayer`. The test facades that stub `holdResident`
(`harness.ts:221`, `harness.ts:670`) gain `wakeAt` and `cancelWake`.

### A7. Firing, and the order against passivation

1. **Startup pass.** As the server builds, before any client or loop can
   arm a record, the clock stores this start's number (`beginBoot`) and reads
   the wall time. It then reads every start-only row an earlier start armed
   (`armed_boot` below this start's number) and every row with `at <= now`,
   oldest `created_at` first, and fires each one, eight at a time. One armed
   in this process waits for the next start (F4, F21). A failed read is read
   again with the same bounds until it succeeds (F22).
2. **Clock loop.** After the pass, the clock loops. Each turn reads the wall
   time (`Clock.currentTimeMillis`), fires every row with `at <= now`, and
   sleeps until the smallest remaining `at`, or for 30 seconds, whichever comes
   first. An upsert opens the latch and ends the sleep early. A sleep is
   relative time, and the wall time is read again on every turn, so a forward
   jump of the system clock fires a due row within 30 seconds, and a backward
   jump fires nothing early: the clock compares stored epoch times with the
   wall time it just read. Effect's `Clock` keeps the two apart: `sleep` and
   `currentTimeMillis` are separate operations
   (`effect/src/Clock.ts:60-65`, `effect/src/Clock.ts:141-142`).
3. **Fire.** The clock sends `FireWake` to the branch's entity. A passivated
   entity is built again by the cluster. Its constructor opens the loop
   (`agent-loop.ts:3343-3352`), and the open runs the `loopOpen` activations.
   A build for a fire never starts a recovered turn (A11, F1).
4. **Handler.** The handler calls `ensureTarget` and checks the termination
   marker. A terminated or missing session answers `Gone`. Then it calls
   `ensureOpen` (A11), which opens the loop and does not promote its
   recovery. It resolves the branch profile as the activation does
   (`agent-loop.ts:2502-2504`). It takes `residency.held` for the hook's length.
   It runs the extension's `wakeDue` handler beside any turn, with no permit,
   as `loopOpen` runs. An extension that is not in the branch's profile, or
   that has no `wakeDue` handler, answers `Unhandled`.
5. **Order against `loopOpen`.** The `wakeDue` handler can run beside the same
   extension's `loopOpen` handlers. An extension that has both makes them
   idempotent under its own lock, as wake's `withLifecycle` does
   (`wake.ts:192-237`).
6. **Outcome.** Every write after a fire is one conditional SQL statement on
   the incarnation and the version the fire read, retries included (F20):
   - `Done`, `Gone`, `Unhandled`: `DELETE FROM branch_wakes WHERE <key> AND incarnation = ? AND version = ?`.
   - `At`: `UPDATE branch_wakes SET at = ?, attempts = 0 WHERE <key> AND incarnation = ? AND version = ?`.
   - `AtStart`: the same, with `at = NULL`.
   - A failure: `UPDATE branch_wakes SET at = ?, attempts = attempts + 1 WHERE <key> AND incarnation = ? AND version = ?`.
     A statement that changes no row means that a newer `wakeAt`, or a cancel
     and a new arm, replaced the record during the fire, so the newer row
     stands as written. `wakeAt` is one
     `INSERT ... ON CONFLICT DO UPDATE` that sets `version = version + 1` and
     `attempts = 0`. No write reads the row first and writes it after.
7. **Failure.** A failed or interrupted fire, or a hook that runs past 30
   seconds, keeps the row. The backoff is `at = now + min(5 s × 2^attempts,
   10 min)`. An entity that passivates during the hook interrupts it, and the
   next attempt opens the branch again.
8. **After the hook.** The fire's hold ends with the hook. Work that must keep
   the branch resident takes its own `holdResident` in a branch Resource, as
   wake's timers do.

### A7b. How much work a boot starts

The fire concurrency bounds hook calls, not model work. A hook can start a
turn (a wake alarm) or a thread round (a machine). The bound on model work at
boot comes from four rules, each in the place that owns the work:

- **User turns:** none from a fire. A fire does not promote recovery (D1,
  A11). A turn a hard kill cut short still resumes at boot through the
  redelivered keep-alive, as it did before this stage (F1).
- **Wake alarms:** an alarm in `wake` mode more than ten minutes past due
  leaves a notice and starts no turn (A9). Only alarms that came due in the
  last ten minutes start turns.
- **Machine rounds and commands:** one server-wide permit,
  `MAX_ACTIVE_MACHINE_STEPS` (4), held by a driver for the length of each
  round or command, in every process lifetime, not only at boot (B9b). The
  rounds that a crash left open count against it first.
- **Other thread rounds** that threads' `loopOpen` reconcile re-sends on an
  opened host stay under the existing per-starter cap
  (`threads.ts:977-1003`). They were running when the server stopped.

C7 tests the bound by counting concurrent model streams at boot.

### A8. Edge cases

- **Deleted branch.** The foreign key deletes the rows with the session. A fire
  that races the delete answers `Gone`.
- **Disabled extension.** The fire answers `Unhandled` and the row goes, with a
  warning in the log. The extension's `loopOpen` repairs its rows when it is
  enabled again (see the wake and machine moves below).
- **Idempotency.** The key is `(session, branch, extension, sourceId)`. A
  repeat of the same `wakeAt` writes the same row. An extension derives its
  `sourceId` from its own ids, never from a random value.
- **Cost.** One indexed read at start and one per wake-up of the clock. A fire
  costs no model call by itself. Rows exist only while some extension has
  pending work on a branch.

### A9. How the consumers use it

**Machines.** See Part B. A run arms `machine-run:<run>` with no time while it
is active, and kicks it with `at: now` when another place changes the run.

**Warm pre-lapse handoff.** This is a later extension, not stage 3.

- Its `turnAfter` arms `wakeAt({ sourceId: "handoff:warm", at: lastStepAt +
  ttl - margin })`, where `ttl` comes from `promptCacheTtlMsFor`
  (`packages/core/src/domain/agent.ts:192`). A later turn moves the time.
- Its `wakeDue` computes the handoff if the branch is idle and the
  context is past the cost floor (`coldHandoffPays`,
  `packages/core/src/runtime/model-context.ts:2279`). Then it returns `Done`.
- After a restart, a past-due row fires in the startup pass, and the hook
  finds the cache cold and returns `Done`.

**`@gent/wake` alarms move onto it.**

- **Publication order.** The core row is written first, the file entry second.
  `storeAndArm` (`wake.ts:739-745`) calls
  `wakeAt({ sourceId: "wake:<sha256 of wakeId>", at: dueAt })` for an alarm
  and for an auto-resume, then writes the file entry (F12). A crash between the two leaves a row
  with no entry. It fires once, the hook finds no entry and returns `Done`,
  and nothing is sent. The tool call that armed the alarm failed, so the model
  knows it was not set. The other order loses the alarm: a file entry with no
  row opens no branch at boot, and only an open runs the `loopOpen` repair
  (`wake.ts:1400-1416`).
- **Cancel order.** The reverse: the file entry goes first, then `cancelWake`.
  A crash between them leaves a stale row, which fires once and returns `Done`.
- **The file stays the truth.** The core row is only the trigger. The hook
  reads the authoritative entry by its id every time, and derives what to do
  from it. A missing entry returns `Done`.
- **Deadline check before delivery.** If the entry's `dueAt` is later than
  the wall time now, the hook sends nothing and returns `At { at: entry.dueAt }`.
  This stops an early fire of a repeat: a repeat stores its next tick in the
  same file update that settles the fire (`wake.ts:528-536`), and a crash
  before core applies the hook's `At` leaves the row on the old time. On
  restart the row fires early, the hook reads the advanced entry, and it
  re-arms the row to the stored tick.
- **A due fire.** An alarm fires through the existing `queueWake` and
  `fireKey`, so a repeat fire of the same tick is still a no-op
  (`wake.ts:293-296`, `wake.ts:321-372`). A one-shot returns `Done`. A repeat
  returns `At { at: next }` after its file update.
- **Lateness.** A `wake`-mode alarm more than ten minutes past due at its fire
  leaves a notice and starts no turn. This is the auto-resume rule
  (`wake.ts:436`, `wake.ts:465-470`), applied to every alarm, because a startup
  fire has no user present.
- Alarms no longer hold the loop resident. The branch can passivate during a
  24-hour wait.
- Monitors keep their in-process polling and their `holdResident`, since they
  run a command. Each monitor also arms its `wake:` row with no time, before
  its file entry, so a restart arms it again with no open. Its hook arms the
  monitor fiber and returns `AtStart`. Its end calls `cancelWake` after its
  file update.
- The `loopOpen` re-arm (`wake.ts:723-737`) stays. For every file entry it
  upserts the core row (idempotent) and arms monitors. It is no longer the only
  repair: the publication order already covers a crash. It still repairs a
  row that core settled as `Unhandled` while the extension was disabled
  (F13).
- `cancelWakes` (`wake.ts:748`) also calls `cancelWake` for each removed id.
- **Alarms stay in the JSON file.** One transactional store would need the
  wake entries in SQL and a facade verb that joins core's `branch_wakes` write
  to the extension's transaction. Core owns `branch_wakes`, and the facade has
  no transaction verb. The publication order gives the same safety: the only
  state a crash can leave is a row with no entry, which the hook recognizes and
  drops (make-operations-idempotent). Moving the entries also changes a
  persisted format with no gain in correctness, so it is not done here.

### A10. What the counsel review should check in Part A

- A fire opens the loop without promoting recovery (A11). Check that no path
  that a fire reaches starts a recovered turn: the `wakeDue` hook's own sends
  take the re-entrant path, which drains only through `canStartTurnNow`.
- `FireWake` takes no side-mutation permit. Check that a `wakeDue` handler that
  calls `Session.send` on its own branch takes the re-entrant path
  (`agent-loop.ts:3140-3170`, `agent-loop.ts:3195-3226`) and cannot deadlock.
- A send from a fired hook to another branch is an ordinary operation on that
  branch. It promotes that branch's recovery, as such a send does today
  (`extension.ts:1017-1019`). D1 covers the fired branch, not the branches its
  hook writes to on purpose.

### A11. Deferred recovery (D1)

**What the code does today.**

- The actor opens its loop when the entity is built (`agent-loop.ts:3343-3352`).
  `openLoop` starts the behavior, then runs recovery in the same chain: a
  cut-short user turn from the event log (`incompleteUserTurn`,
  `agent-loop.ts:2590-2625`) starts through `startRecovered`
  (`agent-loop.ts:1495-1505`, `agent-loop.ts:3297-3311`). With none, a stored
  queue that has items starts its next item (`agent-loop.ts:3312-3316`,
  `wantsWakeOnRecovery` at `agent-loop.ts:277-290`).
- Once the loop is `Open`, `ensureStarted` only returns the handle
  (`agent-loop.ts:3365-3386`). Recovery never runs again in that generation.
- Every drain takes the in-flight item first (`takeNextQueuedTurn`,
  `agent-loop.ts:429-432`). An `ifLatest` line is stored in the in-flight slot
  at its admission, and a restart runs it once with no new test
  (`agent-loop.ts:826-845`, `extension.ts:1029-1031`).
- So skipping the recovery block alone is not enough. A skipped cut-short turn
  is stranded for the generation. And any later drain, such as a hook's
  queued `wake` send through `wakeAfterPermit` (`agent-loop.ts:3195-3214`),
  takes the old in-flight item and runs it with no user present.

**The change: construction and promotion are two steps.**

- **State.** `AgentLoopState` (`agent-loop.ts:496-506`) gains
  `readonly recoveryDeferred?: true`. It is in memory only: each generation
  derives it again from storage, so nothing persists (derive-dont-sync).
  `buildInitialAgentLoopState` (`agent-loop.ts:508-514`) takes it, and
  `makeAgentLoopBehavior` builds every loop with it set.
- **The one gate.** `canStartTurnNow` (`agent-loop.ts:558-559`) becomes
  `s.state._tag === "Idle" && s.startingState === undefined && s.recoveryDeferred !== true`.
  All three admission and take sites read it: the `ifLatest` admission
  (`agent-loop.ts:820-825`), the plain admission (`agent-loop.ts:869`) and the
  idle take (`agent-loop.ts:905`). While recovery is deferred:
  - an `ifLatest` line is not admitted. The contract already says a line that
    is not admitted changes nothing (`extension.ts:1028-1029`);
  - a plain line is queued and its start is not reserved;
  - an idle take takes nothing, so the in-flight item stays in its slot with
    its accepted condition, and no drain (`wakeAfterPermit`,
    `startNextQueuedTurnIfIdle` at `agent-loop.ts:2992-3006`, the worker loop)
    starts a turn.
- **Construction.** `openLoop` (`agent-loop.ts:3228-3338`) keeps
  `handle.start` and `writeInitialQueue`, and drops the recovery block at
  `agent-loop.ts:3297-3318` from its chain. `runOpenHooks` still runs at its
  end (`agent-loop.ts:3334-3337`). The constructor's eager open
  (`agent-loop.ts:3343-3352`) then promotes recovery under the startup
  permit, unless a wake fire is reaching the entity (F1). Only a fire's build
  starts no turn.
- **Promotion.** A new `promoteRecovery(handle)` runs the old block once per
  generation. `LoopInbox` gains `settleRecovery: Effect<boolean>`, one queue
  transaction that clears `recoveryDeferred` and answers whether it was set
  (`persist: false`). Promotion runs it first. On `true` it runs, in order:
  1. `incompleteUserTurn`; when there is one, `startRecovered` as today;
  2. else `wantsWakeOnRecovery` over the queue as it stands now
     (`(yield* handle.inbox.read).queue`), not over the queue the open read.
     The in-flight item is still the open's, since nothing could take it. Items
     queued while deferred count too, as items queued before a restart do;
  3. `startNextQueuedTurnIfIdle(handle, { startupPermitHeld: true })` on the
     same condition as today (`agent-loop.ts:3313-3316`).
     A failure closes the behavior as the block does today
     (`agent-loop.ts:3302-3308`).
- **Who promotes.** `ensureStarted` (`agent-loop.ts:3365-3386`) calls
  `promoteRecovery` after it has an `Open` handle, inside its
  `startupSemaphore` permit. Every operation except `TerminateBranch` already
  reaches the loop through `ensureStarted`: `branchCommand`
  (`agent-loop.ts:3038-3049`), `QueueFollowUp` (`agent-loop.ts:3624-3636`),
  `RespondInteraction`, `RequestExtension` and the state reads
  (`agent-loop.ts:3388-3401`). So every ordinary operation promotes, and the
  startup interaction recovery (`server.ts:2211-2247`) still resumes as today.
  `TerminateBranch` never opens (`agent-loop.ts:3720-3733`).
- **Who does not.** A new `ensureOpen` is `ensureStarted` without the
  promotion, under the same permit. Only `FireWake` uses it. The re-entrant
  path (`reentrantHandle`, `agent-loop.ts:2972`) never promotes: it serves the
  loop's own extensions, and a fired hook is one of them.
- **`startRecovered`'s contract** (`agent-loop.ts:1495-1500`) says that no
  admission has reached the loop. With deferral, admissions may wait in the
  queue, but none holds a reservation, because `canStartTurnNow` refused it.
  The comment changes to say that: the loop is idle and holds no reservation.
- **Passivation.** A deferred loop that nobody touches passivates after a
  minute. The next generation derives the same deferral from storage.

**What it costs.** One optional field, one predicate term, one inbox verb, one
function moved out of `openLoop`, and one variant of `ensureStarted`. No
persisted format changes.

**What a user sees.** A cut-short turn on a branch that only a wake opened
resumes when the user (or another loop) next reaches that branch. A wake line
queued on that branch while deferred waits behind the recovered turn. A turn
that held the branch resident when the process died resumes at boot, as it
did before (F1).

## Part B. The machine schema and execution

### B1. Placement

- `packages/extensions/src/machines.ts`, one file under section banners:
  schema, storage, templates, driver, ask and answer, tools, registration.
- `MachineStoreResource`, server scope. It holds the two tables (migrated under
  `machine_migrations`, as threads use `thread_migrations` at
  `packages/extensions/src/threads.ts:550-628`) and the pre-P4 permits. One server
  shares it, as `ThreadsResource` does (`threads.ts:2661-2668`).
- `MachineDriversResource`, branch scope. It holds a `FiberMap` of drivers,
  keyed by run, and a lifecycle semaphore, as `WakeAlarms` does
  (`wake.ts:192-237`).
- It reads `Threads` with `Effect.serviceOption`, as threads read `Workspaces`
  (`threads.ts:2648-2652`). Without threads, `machine.start` refuses.

### B2. Schema

Repo idioms: branded ids (`packages/core/src/domain/ids.ts`), `Schema.TaggedUnion` with
PascalCase keys for stored unions, and `Schema.Union([...]).pipe(Schema.toTaggedUnion(...))`
for a wire discriminator other than `_tag` (`extension.ts:1046-1075`).

```ts
// ── ids ──
const Slug = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/))
export const MachineName = Slug.pipe(Schema.brand("MachineName"))
export const StateName = Slug.pipe(Schema.brand("StateName"))
export const RoleName = Slug.pipe(Schema.brand("RoleName"))
/** A transition key: a thread verdict, an ask choice. `retry`, `stop` and `continue` are reserved. */
export const Verdict = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/)).pipe(
  Schema.brand("Verdict"),
)
export const RunId = Schema.String.check(Schema.isPattern(/^run-[0-9a-f]{16}$/)).pipe(
  Schema.brand("RunId"),
)
/** `<run>:<seq>`: the step that asked. */
export const AskId = Schema.String.pipe(Schema.brand("AskId"))
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Template = Schema.String.check(Schema.isMaxLength(16_000))

// ── definition ──
/** One role: a P1 thread spec. Default agent: `worker`, which keeps the session cache. */
const ThreadRole = Schema.Struct({
  agent: Schema.optionalKey(AgentName),
  model: Schema.optionalKey(ModelId),
  effort: Schema.optionalKey(ReasoningEffort),
  account: Schema.optionalKey(CredentialSlot),
  instructions: Schema.optionalKey(Template),
  tools: Schema.optionalKey(Schema.Array(Schema.String)),
})

/** A loop cap: past `maxVisits` entries the run goes to `exhausted`. */
const VisitCap = {
  maxVisits: Schema.optionalKey(PositiveInt),
  exhausted: Schema.optionalKey(StateName),
}

const ThreadState = Schema.Struct({
  kind: Schema.Literal("thread"),
  thread: RoleName,
  say: Template,
  /** Unconditional: the round's text is saved, and the run moves on. */
  next: Schema.optionalKey(StateName),
  /** By verdict: the round must `thread.reply` a value whose `next` is one of these keys. */
  on: Schema.optionalKey(Schema.Record(Verdict, StateName)),
  /** `true`: a new thread on every visit. A number: a new thread from that visit on. */
  fresh: Schema.optionalKey(Schema.Union([Schema.Boolean, PositiveInt])),
  ...VisitCap,
})

/** Mirrors P4's bash `permit: { name, limit }`. */
const Permit = Schema.Struct({ name: Slug, limit: Schema.optionalKey(PositiveInt) })

const RunState = Schema.Struct({
  kind: Schema.Literal("run"),
  run: Template,
  permit: Schema.optionalKey(Permit),
  /** Default 3600. A timeout takes `fail`. */
  timeoutSeconds: Schema.optionalKey(PositiveInt),
  on: Schema.Struct({ pass: StateName, fail: StateName }),
  ...VisitCap,
})

const AskState = Schema.Struct({
  kind: Schema.Literal("ask"),
  ask: Template,
  /** The allowed answers, each with its next state. */
  on: Schema.Record(Verdict, StateName),
})

const FinalState = Schema.Struct({
  kind: Schema.Literal("final"),
  /** The line the owner's wake carries; default "<machine> finished in <state>". */
  say: Schema.optionalKey(Template),
})

export const MachineState = Schema.Union([ThreadState, RunState, AskState, FinalState]).pipe(
  Schema.toTaggedUnion("kind"),
)
export type MachineState = typeof MachineState.Type

export const MachineDefinition = Schema.Struct({
  name: MachineName,
  threads: Schema.Record(RoleName, ThreadRole),
  start: StateName,
  states: Schema.Record(StateName, MachineState),
})
export type MachineDefinition = typeof MachineDefinition.Type

// ── a run ──
/**
 * Why a run asks. `interrupted`: a command lost its process to a crash, or a
 * worker's round was stopped from outside the machine.
 */
const AskReason = Schema.Literals(["asked", "interrupted", "no-verdict", "exhausted"])

/** The verdict a round on a state with `on` must `thread.reply`; anything else is no verdict. */
export const VerdictReply = Schema.Struct({ next: Verdict })

/** The process a command started, as background bash records it (`exec-tools.ts:195-199`). */
const CommandProcess = Schema.Struct({ pid: Schema.Int, startIdentity: Schema.String })
export const RunStatus = Schema.Literals(["running", "asking", "final", "failed", "stopped"])

/** The action a step recorded before it dispatched it: the receipt recovery reads. */
export const PendingAction = Schema.TaggedUnion({
  /** `key` is the Threads idempotency key; `thread` and `round` are set once admitted. */
  Round: {
    state: StateName,
    visit: PositiveInt,
    key: Schema.String,
    attempt: PositiveInt,
    thread: Schema.optionalKey(SessionId),
    round: Schema.optionalKey(Schema.String),
  },
  /** `process` is set once the spawn reported its pid. */
  Command: {
    state: StateName,
    visit: PositiveInt,
    startedAt: Schema.Finite,
    process: Schema.optionalKey(CommandProcess),
  },
  Ask: {
    state: StateName,
    visit: PositiveInt,
    askId: AskId,
    reason: AskReason,
    choices: Schema.Array(Verdict),
    /** An interrupted command whose process group a restart could not show gone. */
    mayStillRun: Schema.optionalKey(Schema.Boolean),
    deliveredAt: Schema.optionalKey(Schema.Finite),
  },
})
export type PendingAction = typeof PendingAction.Type

/** The context templates read: each state's last value, and every value in order. */
export const RunContext = Schema.Struct({
  last: Schema.Record(StateName, Schema.Json),
  all: Schema.Record(StateName, Schema.Array(Schema.Json)),
})

/** One row of the append-only log. */
export const MachineStep = Schema.TaggedUnion({
  Started: { machine: MachineName, input: Schema.Json },
  Dispatched: { action: PendingAction },
  RoundEnded: {
    state: StateName,
    round: Schema.String,
    verdict: Schema.NullOr(Verdict),
    dead: Schema.Boolean,
    usage: Schema.optionalKey(Schema.Json),
  },
  CommandEnded: {
    state: StateName,
    exitCode: Schema.NullOr(Schema.Int),
    timedOut: Schema.Boolean,
    outputTail: Schema.String,
  },
  Interrupted: { state: StateName },
  Delivered: { askId: AskId },
  Answered: { askId: AskId, choice: Verdict, note: Schema.optionalKey(Schema.String) },
  Moved: { from: StateName, to: StateName, by: Schema.String },
  Finished: { state: StateName },
  Failed: { error: Schema.String },
  Stopped: {},
  Notified: {},
})
export type MachineStep = typeof MachineStep.Type
```

Decisions made from the principles:

- **`kind` on each state.** The plan's example infers the kind from the fields
  present (`thread`, `run`, `ask`, `final: true`). A union that is decided by
  field presence lets a state carry both `thread` and `run`, and its errors
  name no variant. An explicit discriminator makes that state impossible. The
  plan's example changes to `{ kind: "thread", ... }` and `{ kind: "final" }`.
- **`permit: { name, limit? }`**, not `permit: "gate"`, so the machine and P4's
  `bash` use one shape.
- **`fresh` takes a visit number.** The `orchestrate` skill keeps round 2 on
  the same implementor and starts a fresh one from round 3. `fresh: 3` says
  that.
- **Default cap.** A thread or run state with no `maxVisits` has a cap of 10.
  Past a cap with no `exhausted`, the run asks with reason `exhausted`. No run
  can loop forever.
- **Templates.** `{{input.<path>}}`, `{{<state>}}` (the last value as JSON),
  `{{<state>.<path>}}`, `{{all.<state>}}` (every value, a JSON array: the
  findings ledger a fresh implementor needs), and `{{visit}}` (this state's
  visit number). A missing path renders as empty text, so round 1's
  `{{review.reply.findings}}` is empty. A string renders raw, and any other value as
  JSON. Each substitution is cut to its last 8,000 characters. `input`, `all`
  and `visit` are reserved state names. There is no expression language.
- **What a state saves.** A thread state saves `{ text, reply }`. A run
  state saves `{ exitCode, output }` (the output tail). An ask saves
  `{ choice, note }`.
- **`cwd` is a start parameter**, not a magic input key. Threads start there,
  and commands run there.

`machine.define` checks the graph after the schema. `start` exists. Every
target, `next`, `on` value and `exhausted` names a state. Every `thread` names
a role. A thread state has exactly one of `next` and `on`. `exhausted` needs
`maxVisits`. No `on` key is `retry`, `stop` or `continue`. Every state is
reachable from `start`, and a final state is reachable. Every template names
`input`, `all`, `visit` or a state. The `exhausted` edges alone form no cycle:
a state whose `exhausted` is itself, or a chain of `exhausted` edges that
returns to its start, is refused. A refusal lists every problem at once.

**The choices an ask offers**, by its reason and its state:

| Reason        | Thread state with `on`       | Thread state with `next`    | Run state                                                       |
| ------------- | ---------------------------- | --------------------------- | --------------------------------------------------------------- |
| `asked`       | (ask states only) `keys(on)` |                             |                                                                 |
| `no-verdict`  | `keys(on)`, `retry`, `stop`  | `continue`, `retry`, `stop` |                                                                 |
| `interrupted` | `keys(on)`, `retry`, `stop`  | `continue`, `retry`, `stop` | `pass`, `fail`, `retry`, `stop`; no `retry` while `mayStillRun` |
| `exhausted`   | `keys(on)`, `retry`, `stop`  | `continue`, `retry`, `stop` | `pass`, `fail`, `retry`, `stop`                                 |

`continue` takes `next`. `retry` enters the same state again, as one more
visit. `stop` stops the run. A key of `on` takes its
target.

### B3. Tables

```sql
CREATE TABLE machine_runs (
  run TEXT PRIMARY KEY,
  machine TEXT NOT NULL,
  definition_json TEXT NOT NULL,     -- the snapshot taken at start
  host_session_id TEXT NOT NULL,     -- the branch whose drivers run it
  host_branch_id TEXT NOT NULL,
  owner_thread TEXT NOT NULL,        -- the thread key that may answer, stop and read
  owner_session_id TEXT,             -- the saved wake target, set before the first delivery
  owner_branch_id TEXT,
  cwd TEXT NOT NULL,
  input_json TEXT NOT NULL,
  context_json TEXT NOT NULL,        -- RunContext
  visits_json TEXT NOT NULL,         -- { [state]: count }
  roles_json TEXT NOT NULL,          -- { [role]: thread key } for non-fresh roles
  state TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','asking','final','failed','stopped')),
  pending_json TEXT,                 -- PendingAction, NULL between steps
  seq INTEGER NOT NULL,              -- the last step's seq; every write compares and sets it
  notified_at INTEGER,               -- the final or failure wake was delivered
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX machine_runs_host ON machine_runs (host_session_id, host_branch_id)
  WHERE status IN ('running','asking') OR notified_at IS NULL;
CREATE INDEX machine_runs_owner ON machine_runs (owner_thread, created_at);

CREATE TABLE machine_steps (
  run TEXT NOT NULL REFERENCES machine_runs(run) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  state TEXT NOT NULL,
  step_json TEXT NOT NULL,           -- MachineStep
  PRIMARY KEY (run, seq)
);
```

- Every run write is `commit(run, expectSeq, changes, steps)`. In one
  transaction it updates the row `WHERE run = ? AND seq = ?`, sets
  `seq = expectSeq + steps.length`, and appends the steps. A write that finds
  another seq changes nothing. Its writer reads the row again and derives its
  next move from what it finds.
- The `sessionDeleted` hook deletes the runs whose host session went, as
  threads do (`threads.ts:2993`). Their core wake rows go by the foreign key.
- The run id is `run-` plus 16 hex of SHA-256 over the host session, branch and
  tool call id, as threads derive theirs (`threads.ts:943-948`). A retried
  `machine.start` returns its run.

### B4. Who runs a step

- A **driver** is one fiber per run, in the host branch's `MachineDrivers`
  FiberMap. It captures the host's `ExtensionContext` as wake's `armEntry`
  does (`wake.ts:686-714`). Every Threads call then digests the same session
  and branch, so every key is stable across retries.
- The driver holds the host branch resident through `Session.holdResident`
  while the run has a round or a command open. It holds nothing while the run
  asks, so the host can passivate. Passivation closes the branch scope and
  ends the driver with it.
- The driver waits on three signals: its round's end on
  `Threads.subscribeRoundEnds`, its command fiber's end, and its poke queue.
  After each one it reads the row again.
- **An asking driver stays.** After it delivers an ask, the driver does not
  exit. It waits on its poke queue, and reads the row again on each poke. A
  driver exits only from a terminal row (final, failed, stopped) whose end is
  notified. This is the smaller of the two repairs for a poke that meets an
  exiting driver: an asking run then never has a driver that is about to
  exit. The cost is one idle fiber per asking run in a resident host, and
  nothing in a passivated one.
- **Retirement and activation share one lock.** `arm(run)` and the driver's
  exit both take the drivers' lifecycle semaphore, as wake's alarms do
  (`wake.ts:192-237`). `arm` under the lock: a registered driver gets a poke;
  none, and a new driver starts. The exit under the lock: read the row again;
  if its `seq` differs from the one the driver last acted on, or the row is not
  terminal and notified, the driver goes on instead; else it removes itself from
  the map and returns. A terminal row has no transition out, so the recheck
  only closes the window, and `onlyIfMissing` never meets a fiber that has
  decided to leave (`effect/src/FiberMap.ts:188-220`).
- **The wake row stays while the run is active.** The `wakeDue` handler for
  `machine-run:<run>` calls `arm(run)`. Then it returns `AtStart` while the run
  is `running` or `asking`, delivered or not. It returns `Done` only for a
  missing run, or a terminal run whose end is notified. So a fire that races an
  answer can never take the run's only trigger: the row outlives the ask.
  Each boot then opens the host of each asking run once, with no model call,
  since the open does not promote recovery (A11).
- `machine.answer` and `machine.stop` may run in another session of the owner's
  thread, after a handoff. They commit the row first, then kick the host with
  `Session.wakeAt({ sessionId: host, branchId: host, sourceId: "machine-run:<run>", at: now })`.
  The kick comes after the commit, so the fire it causes reads the committed
  row. A crash between the two leaves the `AtStart` row, and the next boot
  finds the committed answer. So the step always runs on the host, and the
  tools never reach another branch's fibers.
- A `loopOpen` handler repairs the host. For every active run on this branch,
  it upserts `machine-run:<run>` (no time) and arms the driver. This covers a
  branch generation that was rebuilt, and an extension that was disabled and
  then enabled.

### B5. The step algorithm

```text
drive(run):                                    # host branch, one fiber per run
  ends := Threads.subscribeRoundEnds           # before any read
  loop:
    r := read(run)
    case r.status
      final | failed  -> if not r.notified_at: notifyOwner(r); commit Notified
                         cancelWake("machine-run:"+run); retire(r) or continue
      stopped         -> settleStop(r); notified; cancelWake(...); retire(r) or continue
    case r.pending
      none            -> enter(r, r.state)
      Ask a           -> if not a.deliveredAt: deliverAsk(r, a)
                         await poke                       # the answer commits, then kicks
      Round x         -> with step permit, hold resident: awaitRound(r, x, ends)
      Command c       -> if commands.running(run): with step permit, hold resident: await it
                         else: recoverCommand(r, c)

enter(r, S):
  st := def.states[S]; v := r.visits[S] + 1
  if st is thread|run and v > (st.maxVisits ?? 10):
    if st.exhausted: commit { state: st.exhausted } [Moved(S, st.exhausted, "exhausted")]
    else commit { status: asking, pending: Ask(S, "exhausted", choices(st, "exhausted")) }
    return                                     # exhausted edges are acyclic (B2): this ends
  case st.kind
    final  -> commit { status: final, visits } [Finished]
    ask    -> commit { status: asking, visits, pending: Ask(S, "asked", keys(st.on)) } [Dispatched]
    run    -> with step permit:
                commit { visits, pending: Command(S, v, now) } [Dispatched]
                fork into commands(run):
                  result := permit(st.permit, runRecordedCommand(render(st.run), r.cwd,
                              started: (p) -> commit { pending.process := p })) timeout
                  commit { state: st.on[result.pass ? pass : fail], pending: none,
                           context: save(S, { exitCode, output }) } [CommandEnded, Moved]
                  poke(run)                    # a failed compare means stop won
    thread -> with step permit:
                x := Round(S, v, key: "machine:"+run+":"+(r.seq+1), attempt: 1)
                commit { visits, pending: x } [Dispatched]
                dispatchRound(r, x)

recoverCommand(r, c):                          # no fiber in this process runs it
  gone := c.process ? stopStaleProcess(c.process) : false
  commit { status: asking, pending: Ask(c.state, "interrupted", choices(st, "interrupted"),
           mayStillRun: not gone) } [Interrupted, Dispatched]

dispatchRound(r, x):                           # idempotent: the same key, the same round
  st := def.states[x.state]
  if fresh(st, x.visit) or x.attempt > 1:
    t := Threads.start({ key: x.key+":thread", notify: "none", cwd: r.cwd, ...role(st) })
  else:
    t := r.roles[st.thread] ?? Threads.start({ key: "machine:"+run+":role:"+st.thread,
                                               notify: "none", cwd: r.cwd, ...role(st) })
    commit roles[st.thread] := t.thread        # once
  round := Threads.send({ key: x.key, thread: t.thread, message: render(st.say),
                          reply: st.on ? replySpec(keys(st.on)) : none, notify: "none" })
    on ThreadBusy | ThreadsOverCap (G1): wait for any round end on `ends`, then dispatch again
  commit { pending: x with { thread: t.thread, round } }

awaitRound(r, x, ends):
  if x.round is none: dispatchRound(r, x)      # crash between the dispatch and its record
  view := Threads.round(x.round)
  while view.status = open: await the next end with round = x.round, or a poke; view := Threads.round(x.round)
  if view.stopped:
    r' := read(run)
    if r'.status = stopped: return             # machine.stop closed it; the loop settles it
    commit { status: asking, pending: Ask(S, "interrupted", choices(st, "interrupted")) }
           [RoundEnded(dead), Interrupted, Dispatched]
    return                                     # someone stopped the worker from outside
  verdict := st.on ? decodeOption(VerdictReply, view.reply) |> filter(v -> v.next in keys(st.on))
                   : Some(none)                # an unconditional state needs no verdict
  dead := view.interrupted or view.streamFailed or view.unanswered or verdict is None
  if dead and x.attempt = 1:                   # a dead worker gave no verdict: run it again once
    commit { pending: x with { key: x.key+":retry", attempt: 2, thread: none, round: none } }
           [RoundEnded(dead)]
  else if dead:
    commit { status: asking, pending: Ask(S, "no-verdict", choices(st, "no-verdict")) }
           [RoundEnded(dead), Dispatched]
  else:
    to := st.on ? st.on[verdict.next] : st.next
    commit { state: to, pending: none, context: save(S, { text: view.text, reply: view.reply }) }
           [RoundEnded, Moved]
    if the thread was fresh: Threads.stop(thread, "machine-done:"+x.key)
```

- **The verdict is decoded, never read as a property.** `RoundView.reply` is
  nullable JSON, null when the round asked for no reply or got none
  (`threads.ts:2425-2445`). A state with `on` decodes it with `VerdictReply`.
  A null, a value that does not decode, or a `next` outside `keys(on)` is no
  verdict. An unconditional state ignores the reply for its move and saves it
  as data.
- **What a state saves.** `{ text, reply }`, so a template reads
  `{{review.reply.findings}}`. The context never spreads a worker's JSON into
  its own keys.
- **A worker stopped from outside.** The owner can call `thread.stop` on a
  machine's worker thread, and Threads marks its open round stopped
  (`threads.ts:2564-2580`). The machine then asks `interrupted`, so the run
  never stays `running` on a round that will not end again.
- **A command's process.** `runRecordedCommand` is `runBashCommand`
  (`exec-tools.ts:1128-1150`) with the `started` callback that
  `spawnBashCommand` already has (`exec-tools.ts:1041-1047`). The pid and
  its `processStartIdentity` (`exec-tools.ts:971-981`) are committed into
  the pending action. Recovery stops a recorded group with background bash's
  `stopStaleProcess` (`exec-tools.ts:1018-1031`), which is true only when the
  group is shown gone. A process with no record (a crash between the spawn
  and the commit), or one that could not be stopped, may still run: the ask
  says so, and offers no `retry` until a later read shows the group gone
  (G4).
- The rule "a dead worker gives no verdict" comes from the `orchestrate`
  skill: a usage limit, an empty review or a missing hand-back neither passes
  nor fails. The run tries the round once more. The second dead round asks.
- **Ask delivery** is an outbox. `deliverAsk` saves the owner's place first,
  then sends `Session.send({ delivery: "queue", ...ownerPlace, sourceId:
  "machine-ask:<askId>", wake: true, metadata: { customType: "machine-ask",
  details } })`, then commits `deliveredAt`. The queue derives the message id
  from the source and the place, so a second delivery is a no-op, as threads
  rely on (`threads.ts:1473-1480`, `threads.ts:1387-1394`). The owner's place
  is the owner thread's newest session's active branch, the way threads find
  the starter (`threads.ts:1362-1385`).
- **The owner is woken only** by an ask (`machine-ask:<askId>`), by a final
  state (`machine-end:<run>`), and by a failure (`machine-end:<run>`). A failure
  is a fault the run cannot turn into an ask: a definition that the snapshot
  can no longer decode, a role that Threads refuses for good (an unknown
  agent), or a host session gone.

### B6. Ask and answer

`machine.answer({ run, askId, choice, note? })`. The checks run in one fixed
order, and the first that holds decides:

```text
r := read(run); refuse unless the caller's thread = r.owner_thread
prior := the Answered step for askId
if prior:                                      # 1. the ask was answered
  if (prior.choice, prior.note) = (choice, note): kick(); return admitted
  refuse Conflict
if r.pending is not Ask with this askId: refuse Stale   # 2. never answered, no longer current
a := r.pending
if choice not in a.choices: refuse Invalid     # 3. answered now, with a choice it does not offer
to := moveFor(a, choice)                       # the table in B2
commit { status: running | stopped, state: to, pending: none,
         context: save(a.state, { choice, note }) } [Answered, Moved]
  on a failed compare: start again from the top  # the Answered step now decides
kick()                                         # Session.wakeAt(host, "machine-run:"+run, at: now)
return { run, status: "admitted" }
```

- **Precedence.** An askId that has an `Answered` step is decided by it,
  whatever the run did since: the same choice and note are `admitted`, and
  any other is `Conflict`. `Stale` is only for an ask that was never answered
  and is no longer the current one: the run was stopped while it asked, or
  the id names no ask of this run. `Invalid` is only for the current ask.
- **Commit, then kick.** A crash between them leaves the `AtStart` row (B4),
  so the next boot reads the committed answer. An identical retry kicks
  again, so a kick lost to a failed call is repaired by the owner's retry.
- **Two identical answers that race.** One commit wins. The other's compare
  fails, it starts again, finds the `Answered` step, and returns `admitted`.
  There is one `Answered` step and one move, so one downstream dispatch.
- The errors are `MachineError` (a `Schema.TaggedError` with a message) and
  `MachineAnswerRefused` (a `Schema.TaggedError` with `reason: "stale" |
  "conflict" | "invalid"` and the current ask, if any).

### B7. Tools

| Tool             | Parameters                          | Returns at admission                                                                                                                                                                |
| ---------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `machine.define` | `{ definition: MachineDefinition }` | `{ name, path, digest }`. Writes `.gent/machines/<name>.json` with `writeFileAtomic` (`packages/core/src/runtime/gent-platform.ts:524`). The same content writes nothing.           |
| `machine.start`  | `{ machine, input, cwd? }`          | `{ run, state }`. Reads the file, takes the snapshot, arms `machine-run:<run>` with no time, inserts the row, arms the driver.                                                      |
| `machine.answer` | `{ run, askId, choice, note? }`     | `{ run, status }`                                                                                                                                                                   |
| `machine.status` | `{ run }`                           | the row (state, status, pending, visits) and the last 20 steps                                                                                                                      |
| `machine.list`   | `{}`                                | the owner thread's runs, newest first                                                                                                                                               |
| `machine.stop`   | `{ run }`                           | `{ run, status: "stopped" }`. Commits `stopped`, then kicks the host. The driver stops the round's thread through `Threads.stop` and interrupts the command fiber. It wakes nobody. |

The `worker` and `delegate` agents already deny `machine.*` (plan, P1 and P1b).

### B8. Recovery table

Each line is a crash point, and what the next activation does. The activation
is the `machine-run:<run>` record firing at start, or the host's `loopOpen`.

| Crash point                                                               | What recovery finds                                                               | What it does                                                                                                                                                                                      |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `machine.start`: after the wake row, before the run row                   | a row, no run                                                                     | the hook returns `Done`; the owner's call failed and is retried                                                                                                                                   |
| `machine.start`: after the run row, before the driver                     | running, no pending                                                               | enters `start`                                                                                                                                                                                    |
| enter: after `Dispatched(Round)`, before the send                         | Round with no `round`                                                             | sends with the same key: `claimRound` admits it fresh                                                                                                                                             |
| after the send was admitted, before its round id was committed            | Round with no `round`                                                             | sends with the same key: the retry returns the admitted round before any busy refusal (`threads.ts:2122-2124`)                                                                                    |
| during the round's turn                                                   | Round, thread round open                                                          | threads' `loopOpen` on the host re-sends the claimed round; the thread's loop opens and resumes the cut-short turn (`threads.ts:1606-1650`, `threads.ts:1701-1707`); the driver waits for the end |
| after the round end was recorded, before the machine's receipt            | Round, thread round ended                                                         | the driver subscribed first, then reads the ended row: receipt                                                                                                                                    |
| after the receipt commit, before the next dispatch                        | running, no pending, next state                                                   | enters the next state                                                                                                                                                                             |
| run state: after `Dispatched(Command)`, before the spawn reported its pid | Command with no `process`                                                         | asks `interrupted` with `mayStillRun`: `pass`, `fail`, `stop`; never runs the command again                                                                                                       |
| during the command, a hard kill (no finalizer ran)                        | Command with `process`                                                            | `stopStaleProcess` on the recorded group; shown gone: asks `interrupted` with `pass`, `fail`, `retry`, `stop`; not shown gone: the same ask with `mayStillRun` and no `retry`                     |
| after the command ended, before its commit                                | Command with `process`, the group gone                                            | asks `interrupted`: the output is lost                                                                                                                                                            |
| ask: after `Dispatched(Ask)`, before the delivery                         | Ask with no `deliveredAt`                                                         | delivers under `machine-ask:<askId>`                                                                                                                                                              |
| after the delivery, before `deliveredAt`                                  | Ask with no `deliveredAt`                                                         | delivers again: the queue drops the repeat; commits `deliveredAt`                                                                                                                                 |
| answer: before the commit                                                 | asking, delivered, `AtStart` row                                                  | the hook returns `AtStart`; the owner's call failed and is retried                                                                                                                                |
| answer: after the commit, before the kick                                 | running, no pending, `AtStart` row                                                | the next boot fires the row; the driver enters the answered state                                                                                                                                 |
| a fire while the run asks, racing an answer                               | asking, then running                                                              | the hook returns `AtStart`, never `Done`; the answer's kick, after its commit, fires again (B4)                                                                                                   |
| a poke while the driver retires                                           | a terminal row                                                                    | the exit and `arm` share one lock; the exit rereads `seq` (B4)                                                                                                                                    |
| a worker's round stopped from outside                                     | Round, round ended `stopped`, run `running`                                       | asks `interrupted` (B5)                                                                                                                                                                           |
| final or failed: before the owner's wake                                  | final, `notified_at` NULL                                                         | delivers `machine-end:<run>`, commits `Notified`, cancels the row                                                                                                                                 |
| stop: after the commit, before the thread stop                            | stopped, Round open                                                               | `settleStop` stops the thread with key `machine-stop:<run>`                                                                                                                                       |
| host session deleted                                                      | no run rows, no wake rows                                                         | nothing                                                                                                                                                                                           |
| branch generation rebuilt mid-command                                     | Command, the fiber was interrupted with its scope; the finalizer killed the group | `loopOpen` arms the driver: `stopStaleProcess` finds the group gone; asks `interrupted`                                                                                                           |
| boot, many runs mid-step                                                  | several Round or Command pendings                                                 | each takes its ticket of the step permit before any new dispatch (B9b)                                                                                                                            |

"A server restart in the middle of a round reruns no completed round" holds
because a completed round lives in `machine_steps` and `context_json`, and every
dispatch reuses the key it recorded before the send.

### B9. `permit` before P4

- P4 (stage 4) adds `ExtensionContext.Permits.with(name, limit, effect)`.
- Until then, `MachineStoreResource` holds a server-wide map from permit name to
  `Semaphore`, made with the first limit asked (default 1).
- This keeps two machine gates in one server from running at once. It does
  not count `bash` calls or other servers. `machine.status` names the permit a
  waiting command holds or waits for.
- Stage 4 replaces only the body of `permit(...)` with `ctx.Permits.with`. The
  definition and the stored rows do not change. P4 also brings first-in,
  first-out waiters, which the stage-3 map does not promise.

### B9b. The step permit: a bound on machine model work

- `MachineStoreResource` holds one server-wide semaphore of
  `MAX_ACTIVE_MACHINE_STEPS = 4` permits. A driver takes one for each round or
  command, from before its `Dispatched` commit to its receipt or its ask, and
  waits for one otherwise. An asking run holds none.
- **Debt from a crash.** A server Resource's build reads `SqlClient`
  (`extension.ts:158`). At build, the resource reads the runs whose pending
  action is a `Round` or a `Command`, oldest first, and takes one permit per
  run, up to the limit, as a ticket keyed by the run. That run's driver takes
  its ticket over instead of a new permit. A ticket that no driver claims in
  ten minutes is given back.
- So the rounds that a crash left open, which threads' reconcile resumes
  whatever the machine does (`threads.ts:1606-1650`), count first, and new
  dispatches wait behind them. Before the crash at most four steps were open,
  so the debt fits the limit.
- The limit is a constant, not a setting: it has no caller that needs another
  value yet (YAGNI). It sits beside the per-starter thread cap
  (`threads.ts:977-1003`), which still applies to each round.

### B10. Gaps in the threads service

Checked against `makeThreads` (`threads.ts:2620-2642`) and the inputs at
`threads.ts:1910-2000` and `threads.ts:2372-2402`.

- **G1. Refusals are not typed.** Busy, over the cap and a full queue all
  become a `ThreadError` with a message (`threads.ts:141-176`). A machine must
  wait on busy or over the cap and fail on the rest. Fix: two
  `Schema.TaggedError`s, `ThreadBusy` and `ThreadsOverCap`, that the
  service's callers get. The tools' `asThreadError` turns each into a
  `ThreadError` with the same message, so the tools' text does not change
  (F16).
- **G2. The owner's current place is private.** `starterPlace` and
  `wakeTarget` (`threads.ts:1362-1420`) find a thread's newest session and save
  the place. Machines need the same rule for an ask. Fix: export one helper
  from `threads.ts` (a module two concerns share), not a copy.
- **G3. The role fields are private.** `StartParams` and `ThreadStartInput`
  (`threads.ts:1910-1996`) are not exported. `ThreadsApi` is exported only as
  `ReturnType<typeof makeThreads>`. Fix: export `ThreadStartInput` and
  `ThreadSendInput`, so `ThreadRole` picks its fields from them.
- **Not gaps.**
  - `Threads.start` takes no `reply`, so a fresh round is a start with no task,
    then a send with `reply`. Both are idempotent by key.
  - `notify: "none"` is open to the service only (`threads.ts:295-303`).
  - The round-end feed is in memory, so the driver subscribes before it reads
    the row (`threads.ts:2634-2641`).
  - The running cap (4 by default) counts a machine's open rounds with the
    owner's own threads (`threads.ts:977-1003`). A machine
    waits for a slot.
- **G4. Outside threads: the command process.** `runBashCommand` gives no pid
  to its caller (`exec-tools.ts:1128-1150`), and `processStartIdentity` and
  `stopStaleProcess` are private (`exec-tools.ts:971`, `exec-tools.ts:1018`).
  Fix: `runBashCommand` takes an optional `recorded` hook that gets the
  started process (`CommandProcess`: pid and start identity), and
  `stopStaleProcess` is exported from `exec-tools.ts`, a module the two
  concerns then share (F17).

## Part C. Tests for stage 3's done criteria

- Machine tests go in `packages/extensions/tests/machines.test.ts`. The routed
  fake model, `call`, `waitFor` and `restartableHome` move from
  `packages/extensions/tests/threads.test.ts` (`threads.test.ts:1143-1230`,
  `threads.test.ts:2318-2331`) into `packages/extensions/tests/helpers/`, since two
  test files share them.
- Core tests for the seam go in `packages/core/tests/runtime/agent-loop.test.ts`
  and `packages/core/tests/storage/`. Each proves its regression by disabling the
  protection once (memory: validate that a regression test catches it).
- Models: `LanguageModelLayers.testStream` routes by prompt: the starter's
  `CALL` lines, and the worker's `ECHO`, `REPLY` and `HANG` lines, as the
  threads tests do.
- **Two kinds of restart.** `restartableHome` builds roots one after another
  in one process over one database file (`threads.test.ts:2318-2331`). Its
  scope closes, so finalizers run: it tests a clean stop. A hard kill runs no
  finalizer. The hard-kill cases (C2b, C3b) spawn a real process and kill it
  with SIGKILL, as the server lifecycle test does
  (`packages/e2e/tests/server-lifecycle.test.ts:140-185`,
  `packages/e2e/src/server-process-fixture.ts:80-130`). They live in
  `packages/e2e/tests/`, since they need process isolation.
- **Counters that do not trust the receipts.** A hard-kill test counts
  executions outside the database under test. Every fake model call appends
  one line (`<state>:<visit>:<attempt>`) to `calls.log` in the test's temp
  directory. Every command appends one line to `ran.log`. A duplicate
  execution then shows in the log even when it reuses a receipt row.

### C0. The seam (core)

- **A due wake reaches a new generation after passivation.** A fixture
  extension registers a branch-scope Resource that counts its builds and its
  releases in a `Ref`, a `wakeDue` handler that records its generation, and a
  tool that calls `wakeAt({ at: now + 5 min })`. `createE2ELayer` (the live
  actor has the reaper, `server.ts:2323`). `TestClock.adjust` past one minute.
  Assert one release before the deadline: the branch passivated. Then adjust
  past the due time. Assert that the hook ran once with `cause: "due"`, in the
  second generation, and that the row is gone after `Done`.
- **A start-only row fires at the next start.** Two roots in sequence over one
  file database (`restartableHome`). The first arms `wakeAt({ sourceId })` with
  no time. The second makes no client call. Assert that the hook ran with
  `cause: "start"`, and that `AtStart` keeps the row for a third root.
- **Upsert, cancel, delete.** The same `sourceId` twice leaves one row with the
  newer time and a higher version. `cancelWake` removes it. Deleting the
  session removes it.
- **The version guard.** A hook that blocks on a `Deferred`; a `wakeAt` with a
  new time while it blocks; then the hook returns `Done`, and in a second case
  fails. Assert that the newer row stands both times, with `attempts = 0`.
- **The wall clock.** A test `Clock` whose `currentTimeMillis` is the
  `TestClock` time plus an offset in a `Ref`, and whose `sleep` is the
  `TestClock`'s. A row due in one hour. Jump the offset forward by two hours,
  then adjust the `TestClock` by 30 seconds: the row fires. A second row due in
  one hour; jump the offset back by one day, then adjust by one hour of sleep:
  the row has not fired.
- **RPC acceptance.** The fixture's tool runs through `createRpcHarness`, to
  catch a per-request scope that ends the record.

### C0b. Deferred recovery (core, D1)

- **Incomplete history.** Root 1: the fixture arms a wake row with no time,
  and a received user message is stored with no turn (F1: a root closed
  mid-turn leaves the turn's keep-alive, which resumes it at boot and races
  the fire). Root 2: no client call. The row fires; the
  hook sends one `queue` line with `wake: true` to its own branch. Assert that
  the hook ran, that the model saw no call, that the queue snapshot (read from
  storage, not through an op) holds the hook's line, and that the cut-short
  message has no `TurnCompleted`. Then `GetState` from a client: assert that
  the recovered turn's model call comes first and the hook's line second.
- **In flight only.** Plant an item in the in-flight slot with `wake: true`,
  admitted under an `ifLatest` that is no longer the newest step
  (`plantInFlightTurn` from `@gent/core/test-utils`, `harness.ts:724`). The row
  fires, and the hook sends an `ifLatest` line and a plain `wake` line (F5):
  assert that the first is not admitted, and that the model saw no call. Then a client op: assert that the
  planted item runs once, with no new test of its condition, and that the
  hook's line never ran.
- **The regression proof.** With `canStartTurnNow` reverted, the first case
  sees a model call before the client op, and the second runs the planted item
  on the hook's plain send.

### C1. A track machine with no owner turn between rounds

<!-- sketch -->

```ts
it.live("a track machine runs to decide with no owner turn between rounds", () =>
  Effect.gen(function* () {
    // The owner's model counts its calls, and blocks on the first call whose
    // prompt holds the ask, after it records how many calls came before it.
    const ownerCalls = yield* Ref.make<ReadonlyArray<"plain" | "ask">>([])
    const askTurn = yield* Deferred.make<number>()
    const { client } = yield* createRpcClient(e2eLayer(trackModels({ ownerCalls, askTurn })))
    const owner = yield* client.session.create({})
    yield* call(client, owner, [["machine.define", "def", { definition: track }]])
    // track: implement (next) → review (on accepted|changes) → verify (run "true") → decide (ask)
    // The worker answers review round 1 with REPLY {"next":"changes","findings":"F1"},
    // round 2 with REPLY {"next":"accepted"}.
    const [started] = yield* call(client, owner, [
      ["machine.start", "start", { machine: "track", input: { spec: "S" } }],
    ])
    const before = yield* Deferred.await(askTurn) // the barrier: the ask's turn has begun
    // Exactly the calls of the two `call` turns above, as their scripts count
    // them: no round woke the owner before the ask was admitted.
    expect(before).toBe(callTurnSteps(defineScript) + callTurnSteps(startScript))
    const steps = yield* machineSteps(started.run)
    expect(moves(steps)).toEqual([
      "implement→review",
      "review→implement",
      "implement→review",
      "review→verify",
      "verify→decide",
    ])
    expect(renderedSay(steps, "implement", 2)).toContain("F1") // the template read the findings
    yield* releaseAskTurn
    const ask = yield* askDetails(client, owner)
    yield* call(client, owner, [
      ["machine.answer", "a1", { run: started.run, askId: ask.askId, choice: "merge" }],
    ])
    yield* waitForMessage(client, owner, "machine-end")
  }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
)
```

Assert the counts from storage too: four `thread_rounds` rows, all
`notify = 'none'`, and no `thread-round-end` message on the owner. A second
case runs the same machine through `createRpcHarness`, for the per-request
scope.

### C2. A clean restart mid-round reruns no completed round

<!-- sketch -->

```ts
it.live("a restart mid-round resumes the run with no owner message", () =>
  Effect.gen(function* () {
    const home = yield* restartableHome
    const first = yield* Effect.scoped(
      Effect.gen(function* () {
        const hanging = yield* Deferred.make<void>()
        const { client } = yield* createRpcClient(
          home.layerFor(trackModels({ hangOn: "review:2", hanging })),
        )
        const owner = yield* client.session.create({})
        const run = yield* startTrack(client, owner)
        yield* Deferred.await(hanging) // review round 2 is in its turn
        return { owner, run }
      }),
    )
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* createRpcClient(home.layerFor(trackModels({}))) // no client call on the owner
        const row = yield* waitFor(
          home.sql(runRow(first.run)),
          (r) => r.status === "asking",
          15_000,
          "the run reached decide",
        )
        expect(row.state).toBe("decide")
      }),
    )
    expect(yield* lines(home.file("calls.log"))).toEqual([
      "implement:1:1",
      "review:1:1",
      "implement:2:1",
      "review:2:1",
      "review:2:1",
    ]) // review 2 ran twice: once cut short, once resumed; no completed round ran again
  }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
)
```

A second case cuts the run between the round's admission and its round-id
commit. It writes `pending_json` back to a `Round` with no `round` through
`home.sql`, as the threads test edits `thread_rounds` (`threads.test.ts:2436-2452`).
It asserts that the next root sends nothing new: `calls.log` gains no line
for that round.

### C2b. A hard kill mid-round (e2e)

- A fixture entry (`packages/e2e/src/machine-host.ts`, a process entry) builds
  the in-process root over a given data dir with the routed fake models and a
  `calls.log` path, starts the track machine, and prints `round <state>:<visit>`
  when each round's model call begins.
- The test spawns it, waits for `round review:2`, sends SIGKILL, and waits for
  the exit. It spawns it again with no start. It polls SQL until the run asks.
- Asserts: `calls.log` holds each completed round once; the run's
  `machine_steps` hold one `RoundEnded` per completed round; the owner got one
  `machine-ask` message.

### C3. A command cut by a clean stop becomes an ask

<!-- sketch -->

```ts
it.live("a command cut by a stop asks interrupted and never runs again", () =>
  Effect.gen(function* () {
    const home = yield* restartableHome
    // verify: { kind: "run", run: "echo ran >> ran.log; sleep 60", on: { pass: "done", fail: "done" } }
    const first = yield* Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* createRpcClient(home.layerFor(models))
        const owner = yield* client.session.create({})
        const run = yield* startMachine(client, owner, "verify-only")
        yield* waitFor(
          home.sql(runRow(run)),
          (r) => r.pending?.process !== undefined,
          8_000,
          "the command recorded its process",
        )
        return { owner, run }
      }),
    )
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* createRpcClient(home.layerFor(models))
        const ask = yield* askDetails(client, first.owner)
        expect(ask).toMatchObject({
          reason: "interrupted",
          choices: ["pass", "fail", "retry", "stop"],
        })
        expect(ask.mayStillRun).toBeUndefined() // the closed scope killed the group
      }),
    )
    expect(yield* lines(home.file("ran.log"))).toEqual(["ran"])
  }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
)
```

### C3b. A hard kill mid-command (e2e)

- The same fixture entry runs `echo ran >> ran.log; sleep 60`, prints `command`
  once the pid is committed, and is killed with SIGKILL. The `sleep` survives
  the server, since no finalizer ran.
- The second process: assert that the ask is `interrupted` with no
  `mayStillRun`, that the recorded group is gone afterwards (`kill -0` on it
  fails), and that `ran.log` has one line.
- A third case kills the process between the spawn and the pid commit (a
  fixture hook that blocks there). Assert `mayStillRun: true` and no `retry`
  among the choices.

### C4. Answers: identical, conflicting, stale

<!-- sketch -->

```ts
it.live("an answer repeats, conflicts or arrives stale", () =>
  Effect.gen(function* () {
    // gate: ask (on: { go: "work", drop: "done" }) → work: thread (next: "check") → check: ask (on: { ok: "done" })
    const { client, owner, run } = yield* startedMachine("two-asks")
    const first = yield* askDetails(client, owner)
    const answer = (id: string, choice: string, askId = first.askId) =>
      call(client, owner, [["machine.answer", id, { run, askId, choice }]])
    const [ok] = yield* answer("a1", "go")
    const [again] = yield* answer("a2", "go")
    const [conflict] = yield* answer("a3", "drop")
    expect(ok.result).toMatchObject({ status: "admitted" })
    expect(again.result).toMatchObject({ status: "admitted" })
    expect(String(conflict.result)).toContain("conflict")
    // the answered ask stays decided by its answer after the run moves on
    const second = yield* askDetails(client, owner, { after: first.askId })
    const [late] = yield* answer("a4", "drop")
    expect(String(late.result)).toContain("conflict")
    // stale: an ask that was never answered and is no longer current
    yield* call(client, owner, [["machine.stop", "s1", { run }]])
    const [stale] = yield* answer("a5", "ok", second.askId)
    expect(String(stale.result)).toContain("stale")
  }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
)
```

- **Concurrent identical answers.** One owner model step calls
  `machine.answer` twice with the same `askId`, choice and note (two tool calls
  in one step). Assert both `admitted`, exactly one `Answered` step for the
  ask in `machine_steps`, and exactly one `Dispatched` for the next state, and
  one `work:1:1` line in `calls.log`.
- **Invalid.** A choice the current ask does not offer is refused `invalid`.

### C5. Wake alarms on the seam

The existing `packages/extensions/tests/wake.test.ts` restart cases keep
passing. These cases are added:

- An alarm that came due while no process ran fires at the next start with no
  client call.
- An alarm in `wake` mode more than ten minutes late leaves a notice and
  starts no turn.
- **Publication crash.** The core row is written and the file entry is not
  (the test writes the row through the fixture and leaves the file empty).
  The row fires: no message, and the row is gone.
- **Repeat-tick crash.** A repeat whose file entry holds the next tick, with
  the core row still on the old time. The row fires at boot: no message, and
  the row now holds the file's tick. A second case advances past that tick and
  sees exactly one message.
- **Cancel crash.** A row with no file entry after a cancel: it fires once,
  sends nothing, and goes.

### C6. Stop from outside, and exhausted cycles

- A worker thread stopped with `thread.stop` while its round runs: the run
  asks `interrupted`, not `running` forever.
- `machine.define` refuses a run state whose `exhausted` is itself, and a
  two-state `exhausted` cycle, listing both.
- A thread state with `on` whose worker ends with no `thread.reply`: one retry,
  then a `no-verdict` ask. A worker that replies `{ "next": 7 }`: the same.

### C7. The boot budget

- Twenty runs on twenty host branches, each left by SQL in `running` with no
  pending action, and each with an `AtStart` row. One root starts with the
  fake worker model gated by a `Deferred`, and counts open model streams in a
  `Ref`, keeping the maximum.
- Assert that the maximum is four (`MAX_ACTIVE_MACHINE_STEPS`), and that all
  twenty runs reach their next ask once the gate opens.
- A second case leaves six runs with an open `Round` pending: assert that new
  dispatches wait until those runs' tickets are claimed or released.

## Part D. Decided from the owner rules

**D1. A wake at server start does not resume a cut-short user turn.**

- Decided by NORTH_STAR.md:87 (Rejected, fail-closed): opening a session
  must not spend a paid turn with no user present. A turn the crash cut short
  at boot is that case: nobody asked for it to continue now.
- `FireWake` opens the loop without recovery's turn start. The cut-short turn
  resumes on the next ordinary operation on that branch, from a client or
  another loop, as it does today (`agent-loop.ts:3297-3311`). A11 gives the
  core change: the loop holds its recovery deferred, refuses every automatic
  start while it does, and keeps the original in-flight item in its slot.
- A machine's own rounds still run unattended: `machine.start` is the owner's
  request for that work, and each round is sent by the extension, not
  recovered by the open.
- The shape is the narrowest one found: one in-memory flag read by the one
  start predicate, and one open variant that only `FireWake` uses (A11).

Every other choice in this note follows from the principles, and the counsel
review may challenge any of them.

## Review round 1

The design review (Codex, verdict reject: keep option (c), repair recovery and
liveness) gave four blockers and eleven should-fix findings. Each was checked
against the code first. All are accepted.

| #   | Finding                                                      | Checked against                                             | How the note handles it now                                                                                                                                                        |
| --- | ------------------------------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | D1 needs deferred recovery state                             | `agent-loop.ts:429-432`, `agent-loop.ts:3343-3386`: true    | A11: a `recoveryDeferred` flag gates `canStartTurnNow`; a fire's build never promotes (F1); `ensureStarted` promotes once; `FireWake` uses `ensureOpen`; tests in C0b              |
| 2   | An answer can consume its wake before its commit             | B6 as written: true                                         | B4, B6: the run's row stays `AtStart` while the run is active; the answer commits, then kicks                                                                                      |
| 3   | A lost alarm trigger between the file write and `wakeAt`     | `wake.ts:723-737`, `wake.ts:1400-1416`: true                | A9: the core row first, the file entry second; a row with no entry fires once and goes. The move to SQL is rejected there, with the reason                                         |
| 4   | A poke can reach a driver about to exit                      | `FiberMap.ts:188-220`: true                                 | B4: an asking driver stays on its poke queue; exit and `arm` share one lock, and the exit rereads `seq`                                                                            |
| 5   | A repeat can fire its next tick early                        | `wake.ts:528-536`: true                                     | A9: the hook checks the entry's deadline before delivery and returns `At { at: entry.dueAt }`                                                                                      |
| 6   | The verdict read and the unconditional choices               | `threads.ts:2425-2445`: `reply` is nullable JSON            | B2: `VerdictReply` decoded with Schema; the choices table, with `continue` for a `next` state; B5                                                                                  |
| 7   | A worker stopped from outside leaves the run running         | `threads.ts:2564-2580`: true                                | B5: the run asks `interrupted` unless the machine itself was stopped                                                                                                               |
| 8   | A crashed command may still run under `retry`                | `exec-tools.ts:1041-1047`, `exec-tools.ts:1018-1031`: true  | B2, B5: the pending command records its pid and start identity; recovery stops the group with `stopStaleProcess`; `mayStillRun` removes `retry`; G4                                |
| 9   | `exhausted` cycles are unbounded                             | B5 as written: true                                         | B2: `machine.define` refuses any cycle of `exhausted` edges                                                                                                                        |
| 10  | No wall-clock correction                                     | `Clock.ts:60-65`: the wall time can move                    | A7: sleeps of at most 30 seconds, and the wall time read again on each turn; C0 tests both jumps                                                                                   |
| 11  | Fire concurrency does not bound model work                   | `threads.ts:977-1003`: the cap is per starter               | A7b, B9b: a server-wide step permit with crash-debt tickets; C7                                                                                                                    |
| 12  | C2 and C3 do not prove hard-crash safety                     | `threads.test.ts:2318-2331`: one process, finalizers run    | C2b, C3b: SIGKILL tests in `packages/e2e`, with `calls.log` and `ran.log` counters                                                                                                 |
| 13  | C0 can pass without passivation                              | the sketch: true                                            | C0: a branch Resource's release is observed before the deadline, and the hook runs in the second generation                                                                        |
| 14  | C1 races the ask's own owner turn                            | `agent-loop.ts:3195-3214`: the ask's turn may start at once | C1: the owner model records its calls and blocks at the first ask-bearing call; the count is read there                                                                            |
| 15  | C4 expects `Stale` where B6 returns `Conflict`               | B6 as written: true                                         | B6: the precedence is fixed (answered first, then current, then valid); C4 tests stale on a stopped run's ask and one `Answered` and one dispatch for concurrent identical answers |
| -   | The version guard is one conditional write, retries included | A7 as written: not stated                                   | A7 step 6 gives each statement                                                                                                                                                     |
| -   | C5 lacks the publication and repeat-tick crash cases         | C5 as written: true                                         | C5: publication, repeat-tick and cancel crash cases                                                                                                                                |

No decision in this round is the owner's. D1 was decided before the review
(NORTH_STAR.md:87), and A11 is its mechanism.

## Commit 1 facts

Commit 1 built Part A in core. The code disagreed with the note in these
places; the note above now follows the code.

- **F1. A cut-short turn already resumes at boot, with no user.** A11 and D1
  said that a cut-short turn resumes on the next ordinary operation, "as
  today". That is false. A running turn holds the entity resident through
  `Entity.keepAlive`, a persisted cluster request that is answered only when
  the hold ends (`effect/cluster` `entityManager.js`, the keep-alive case). A
  hard kill or an eviction leaves it unanswered, and the next process's
  cluster delivers it again at boot. That builds the entity with no
  operation, and the old constructor recovery resumed the turn.
  `hosted-storage.test.ts` ("resumes from the alarm entry alone, with no
  client") asserts this, and it failed when the build stopped promoting. So
  the build keeps promoting, and only a build for a fire does not: the clock
  marks the entity while it sends `FireWake` (`WakeFireOpenings`, a count in
  this process; `SingleRunner` holds every entity), and the constructor skips
  the promotion when the mark is set. D1 holds for the fire; the keep-alive
  resume is unchanged. One race is left and named in `ARCHITECTURE.md` (Known
  gaps): at a boot with both a pending keep-alive and a due wake on one
  branch, the first build decides whether the turn resumes then or at the
  next operation. The cluster gives no signal when its redelivery is done, and
  reading `cluster_messages` would tie gent to the library's tables.
- **F2. Deferral only when there is work.** A11 set `recoveryDeferred` on
  every build. It is set only when the build finds a cut-short turn, or a
  stored queue that wakes on recovery. A branch with none starts turns at
  once, so a fire on it can start the turn its hook asks for (the machines'
  rounds need that). `recoveryDeferred` is a required boolean, not an
  optional `true`. The cut-short turn is read once per build and promotion
  reuses it: no turn runs while the deferral holds, so the answer cannot
  change.
- **F3. Every take is gated.** A11 gated the idle takes through
  `canStartTurnNow`. `withdrawAdmittedTurn` takes the next item with no idle
  test, so the inbox take itself (`LoopInbox.take`) returns nothing while
  recovery is deferred.
- **F4. A start-only row armed during this start waits.** The start pass read
  every `at IS NULL` row whenever it ran, so a row armed before the forked
  pass read the table fired at once. The pass now reads the time as the
  server builds and takes only start-only rows created by then.
- **F5. An `ifLatest` line is refused before the gate.** With an item in the
  in-flight slot, `admit` refuses an `ifLatest` line because the queue is not
  empty, whatever `canStartTurnNow` says. So C0b's second case also sends a
  plain `wake` line, the drain that would take the in-flight item.
- **F6. The facade's wake verbs name the leaf's extension.** A run's
  `ExtensionHostContext.Session` holds no wake verbs; a `Wakes` facet built
  per run takes the leaf's extension id, as `State.changed` does, and the
  leaf adds the verbs to `ExtensionContext.Session`. A record always names the
  extension that armed it.
- **F7. Each fire is its own message.** The `FireWake` payload also carries the
  row's `version` and `attempts`, and its primary key names them, so a retry
  or a re-armed record is not taken for a duplicate of an earlier fire.
- **F8. The state read opens without promotion.** The registered state `get`
  (an extension's `listActiveLoops`) reaches the loop through `ensureOpen`; a
  client's `watchRuntime` still promotes, as a client operation.
- **F9. C0 uses requests, not a tool.** The fixture arms and cancels through
  extension requests over `createRpcClient` (the production RPC handlers), so
  no model turn is needed to arm a record.
- **F10. The seam guard wants the adapter in the same commit.** The guard
  `findUnadaptedSeams` (`packages/tooling/src/guards.ts`) fails a hook kind
  that no file under `packages/extensions/src/` or `apps/` implements. So the
  seam (commit 1) and `@gent/wake` on it (commit 2) are one commit: every
  commit passes the gate, and the seam lands with its first adapter.

## Commit 2 facts

Commit 2 moved `@gent/wake` onto the seam (A9, C5). The code disagreed with
the note in these places; the note above now follows the code.

- **F11. Alarms have no timers.** An alarm is a core row and a file entry; the
  clock fires it and `wakeDue` delivers it. Only a monitor forks work in the
  branch scope, and only a monitor holds the loop resident. The test "a re-arm
  that read an alarm while it fired does not fire it a second time" is
  deleted: its subject, two timers for one alarm, cannot occur.
- **F12. The source id is a digest.** A record's `sourceId` is capped at 200
  characters, and a resume id (`resume:<messageId>:<resetAt>`) reached 228. The
  row is `wake:` and the SHA-256 hex of the wake id (69 characters). The hook
  digests each pending entry's id to find the one that fired.
- **F13. The repair stays unconditional, and it costs one extra fire.**
  `wakeAt` always bumps the version. A fire that builds a closed loop runs
  `loopOpen`, whose repair upserts every entry's row, so the fire's answer is
  superseded and the row fires once more; the hook reads the file again and
  answers `Done` or `At`, and nothing is sent twice (the `fireKey`). The repair
  cannot skip rows that exist: core settles a row `Unhandled` (deletes it)
  while no hook is loaded, so a disabled `@gent/wake` loses every row, and only
  the next open puts them back.
- **F14. Lateness covers every `wake` alarm.** `RESUME_PAST_DUE_MS` is now
  `PAST_DUE_MS`. A `wake`-mode alarm (a resume included) more than ten minutes
  past due leaves a notice and starts no turn; a repeat still moves to its next
  tick. A `notify` alarm leaves its notice as before.
- **F15. C5's crash cases stop a write, not a process.** The unit tests run
  the hook against a fake core (a map of rows in the test context's `Wakes`
  facet) and stop the record write or the file rename at each point. The
  disable test now uses a monitor, since an alarm needs no repair to fire. Two
  integration tests run the real clock: an alarm due while no process ran
  fires at the next start, and one more than ten minutes past due leaves a
  notice. The passivation test closes an idle branch under a 24-hour alarm and
  sees the branch scope close, then the fire.

## Commit 3 facts

Commit 3 closed G1 and G4 of B10. The code disagreed with the note in these
places; the note above now follows the code.

- **F16. A kept tag changes the model's text.** A tool failure reaches the
  model as `String(error)`, which is `<tag>: <message>`. A `ThreadBusy` kept
  through `asThreadError` would read `ThreadBusy: ...` where the model read
  `ThreadError: ...`. So the tools' mapping wraps each typed refusal in a
  `ThreadError` with its message, and only the service's callers see the
  tags. The service applied no `asThreadError` before either, so a full
  queue already reaches its caller as `FollowUpQueueFull`. `ThreadBusy`
  names the open round, and `ThreadsOverCap` names the threads with one.
- **F17. One run function, not a variant.** `runRecordedCommand` would repeat
  `runBashCommand` for one hook, so `runBashCommand` takes an optional
  `recorded` instead. `JobProcess` is now the exported `CommandProcess`, and
  `recordingStart` (read the start identity, then record; a failure is
  logged) is shared with background jobs.
- **F18. G2 and G3 land with their consumer.** The dead-export scan
  (`packages/tooling/src/guards.ts`, surface `packages/extensions/src/`)
  refuses an export that no other file names: exporting `starterPlace` or
  `ThreadStartInput` alone fails it. Machines (commit 4) are their consumer,
  so they are exported there. G1's and G4's names have one now: the tests
  that check them.

## Review fix facts

A review of commit 1 found five faults. The fix commit corrects them; the
note above now follows the code.

- **F19. A promotion reserves the turn it ends the deferral for.** Promotion
  cleared `recoveryDeferred` in one queue transaction and reserved the
  recovered turn in a later one. A drain between the two (a `wakeDue` hook's
  queued line, or any send) saw an idle loop and started its own item first.
  `LoopInbox.settleRecovery` now clears the flag and sets `startingState`
  for the cut-short turn, or takes the queue's next item and reserves it, in
  one transaction; the worker forks that start uninterruptibly with the
  settle.
- **F20. A record has an incarnation.** A cancel and a new arm of the same
  key both start at `version = 1`, so a fire of the cancelled record could
  delete or reschedule the new one. Each row now has `incarnation`, the
  AUTOINCREMENT key, which SQLite never gives again after a delete; the key
  of the four columns is a `UNIQUE` constraint, so `wakeAt` stays one
  upsert. Every settle, reschedule and retry is guarded by key, incarnation
  and version, and `FireWake` carries the incarnation.
- **F21. The start pass reads by start number, not time.** F4's cutoff
  (`created_at <= startedAt`) let a row armed in the same millisecond, or
  after a backward clock jump, fire at this start. Each start now stores its
  number in `branch_wake_boots` before the root is exposed; an arm stores the
  current number in `armed_boot`; the pass reads start-only rows with
  `armed_boot` below its own. The set is fixed at the build, whenever the
  read runs.
- **F22. A failed start read is read again.** One failed `listAtStart`
  abandoned every start-only record for the process. The read is now retried
  with the same start number and wall time: 0.5 s, twice as long each time,
  at most 30 s, logged as `branch-wake.startup.failed`, until it succeeds.
  The number is stored as the server builds; a failure to store it fails the
  build, as a failed interaction recovery read does.
- **Migration 026 was edited in place.** It has not shipped: no release and
  no user database holds it, only the test databases in temporary
  directories. So the table gained its columns in 026 itself, not in a 027.

## Commit 4 facts

Commit 4 adds `packages/extensions/src/machines.ts` and the tests C1 to C4,
C6 and C7 (`packages/extensions/tests/machines.test.ts`). Where the code
differs from Part B, the code holds, as follows.

- **Steps.** `MachineStep` and `PendingAction` use `optionalKey` fields, not
  `NullOr`. Three steps are new: `Recorded { action }` (the pending action
  gained its receipt: a round's thread and id, a command's process),
  `PlaceSaved { place }` (the delivery place, saved before a delivery) and
  `Settled {}` (a stopped run's open round or command was stopped).
- **Visits.** `visits_json` holds `{ counts, grants }`. A `retry` answer to
  an `exhausted` ask grants its state one visit past the cap; without the
  grant, the retry would ask `exhausted` again at once.
- **Owner place.** `owner_session_id` and `owner_branch_id` hold the place
  saved for the next owner message, and are cleared after each delivery. A
  saved place whose session is gone is replaced once.
- **A refused send returns to the driver.** A round refused as busy or over
  the cap waits for a poke or a round end (at most 30 s), and the driver then
  reads the row again before it sends again. B5 retried inside the send, so
  a stop during a busy wait did not settle while the thread stayed busy. A
  C6 case covers it.
- **The compare-and-set has no in-process race to lose.** `bun:sqlite` is
  synchronous, so one answer's read and commit run with no yield between
  them. Six identical answers in one step do not interleave: with the `seq`
  compare removed, the case still passed three runs of three (measured). The
  case proves the deduplication of an answered ask, not the compare. The
  compare (and the `(run, seq)` key under it) still guards each commit
  across an async gap, such as a delivery's send.
- **What activates a host after a clean stop.** In C2, the threads'
  recovery of the open round opens the host even with no machine record; in
  C3, the cluster reads a message the first root left unprocessed for the
  host's loop, which opens it too (measured: both passed with the record
  removed). So C1 asserts the record itself: one start-only row while the run
  is active, none once it settled. C7 plants the records and nothing else.
- **C7 reads the drivers' waits.** A driver that finds no free step permit
  logs `machines.step.waiting` at debug level. The test waits for every
  driver past the first four to log it, so the count of open model calls is
  read once no more can start.
- **Test helpers.** The routed starter (`CALL` lines), `call` and
  `restartableHome` moved to `packages/extensions/tests/helpers/routed-session.ts`.
  The worker's calls log is a `Ref`, not a file (the roots of one test run in
  one process), and its lines are `<state>:<visit>`: a template has no
  attempt number.
- **Exports.** `threads.ts` exports `currentThreadPlace`, `StartParams`,
  `ThreadStartInput` and `ThreadSendInput` (G2, G3), since `machines.ts`
  uses them. `machines.ts` exports `MachinesExtension` and the two message
  types the tests read.
- **`machine.list` takes `Tool.EmptyParams`.** An empty `Schema.Struct({})`
  encodes as `{}` with no `type`, which the shipped-tool schema test refuses
  for Anthropic structured output (measured). `Tool.EmptyParams` encodes as an
  object that takes no key. C1 calls `machine.list` while the run asks.
- **Not in this commit.** The hard-kill cases C2b and C3b (e2e, a spawned
  process) are not written yet.

## Review fixes after commit 4

The Codex review of commits 2 and 3 found two faults and a weak test.

- **F23. The start number exists before any loop opens.** F21 stored the
  number in the wake clock's build, above the actor. The actor's
  registration lets the cluster replay stored messages, and interaction
  recovery builds beside the clock: a loop either opens can arm a
  start-only record before the clock stores the number. The record then
  names the earlier start and fires at this one. `BranchWakesLive` now
  takes the number as it builds, below the actor, and every arm goes
  through it (`BranchWakes.boot`); the clock reads the same number.
  `BranchWakeStorage.arm` takes the start it names, so storage never reads
  the number at arm time. The root test holds the clock's start until a
  recovered interaction's loop armed a record; with the old order the
  record fired at that start (measured).
- **F24. A leaderless group needs proof that it is the job's.** G4's
  `stopStaleProcess` signalled any group whose leader pid no process held.
  Once the job's group ended, an unrelated leader can take the pid, start
  children and exit; recovery then killed those children. Every command's
  processes now inherit a random `GENT_COMMAND_TOKEN`, recorded with the
  pid and start identity (`CommandProcess.token`, the machines'
  `process.token`, and background bash's `process_token` column). A
  leaderless group is stopped only when one member started with the token
  (`/proc/<pid>/environ` on Linux, `ps -E` on macOS); otherwise the stop
  answers false, and the ask or the notice says the command may still run.
  macOS hides the environment of its signed programs, so there a group of
  only `/bin/bash` and `/bin/sleep` is left alone (measured): the crash
  test's surviving descendant is the test runtime.
- **The probe after SIGTERM waits on a refusal.** macOS answers EPERM to
  signal 0 for a group of exited processes their parent has not reaped. The
  old loop read that as "may still run" and returned false (measured: two
  runs in six of the recorded-process test once the spawn passed an
  environment); it now probes again until the SIGKILL.
- **The startup retry test reads the deadlines.** It runs on `TestClock`:
  each step moves the clock to 1 ms before the next read and sees none, then
  to the read, so each failure's log time is its deadline. The deltas are
  0.5, 1, 2, 4, 8, 16, 30 and 30 s.
- **A leader gone before `ps` reads it leaves no record.** The spawn's
  `started` hook reads the leader's start identity; a leader that exits at
  once (`cmd &` and nothing after it) records nothing, so a later server
  cannot stop the child it left. The leaderless-group tests hold their
  leader on a file until the record lands (measured: three runs in four hung
  without it). The gap is G4's, unchanged here; closing it needs the record
  to come from the spawn, not from a later `ps`.

## Review fixes after the machines review

The Codex review of `0945a6f9c` and `264e6263b` named two blockers and seven
should-fix items. Each fix has a test that fails with the fix disabled.

- **R1. A stop cannot lose an admitted round.** `dispatchRound` sent first
  and committed the round's id after; a `machine.stop` between the two won
  the compare, and settlement found no thread to stop. The round's id is a
  digest of its key (`Threads.sendRound(key)`), so `recordRoundTarget` now
  commits the thread and the round's id before the send. The stop keeps the
  pending action. `stopPending` finds the round by its id (by the key when
  an older row has no id), and stops its thread only when the round is
  open; a round no send admitted is sent again by `awaitRound`
  (`Threads.findRound` answers none).
- **R2. A stopped round that stays open needs no stop event.** Rejected as
  stated. `deliverRoundEnd` publishes every recorded end, stopped or not, so
  the end of a turn that held out in an uninterruptible tool wakes the
  driver, which then asks `interrupted`. Acting on the stop mark would act
  while the worker still runs, which the review itself rules out. The C6
  test with an uninterruptible tool passes, and fails when the publish of a
  stopped round's end is removed.
- **R3. A settled stop says when a process may still run.** `Settled` takes
  `mayStillRun` when the command's group was not shown gone, when no record
  or receipt names it, or when Threads refuses the round's thread
  (`ThreadError`). Divergence: the run still settles, since no later try can
  learn more; the step and a warning keep the doubt. Other failures fail the
  step, and the driver retries after its backoff.
- **R4. The spawn writes the record.** This closes the "leader gone before
  `ps`" gap above. The caller stores a receipt path and a token before the
  spawn (`commandLaunch`; the machine's `Command.launch`, background bash's
  `process_token` and `process_receipt`). A `bash` launcher writes its own
  pid and start time to the receipt, checks that its parent is still the
  server, and only then `exec`s the command. Recovery reads the receipt
  when the row holds no process. A launch with no receipt ran nothing.
- **R5. A failed `ps` is not an empty group.** `processGroupMembers` answers
  none when `ps` exits non-zero; `stopStaleProcess` then answers false
  (may still run, no retry offered).
- **R6. Drivers drain round ends.** `roundEndSignal` drains the unbounded
  subscription into a sliding queue of one slot.
- **R7. C4 has an overlap proof.** Two `machine.answer` calls read the
  same ask through a barrier before either commits; one commits and the
  other re-reads and admits. Without the `seq` compare both commit.
- **R8. The boot-order test builds the real layers.** It builds
  `BranchWakesLive`, arms a record, then builds `branchWakeClockLive` on one
  shared storage. It does not replace a core tag through `extraLayers`.
- **R9.** `MachineDrivers.command` is an `Effect.fn`.

The old durable shape needs no shim: the main database has no
`machine_runs` table (measured), so no row lacks `Command.launch`.

## Commit 5 facts

- **The hard-kill cases are four e2e tests** in
  `packages/e2e/tests/machines-hard-kill.test.ts`, over the host entry
  `packages/e2e/src/machine-host.ts`. Each test kills a real host with
  SIGKILL and starts a second host over the same files, which makes no
  client call.
- **C2b.** The cut round runs once more under its key (`review:2:2`), and
  no completed round runs again. The run reaches its ask within 8 s.
- **Two paths activate a host after a kill.** The wake clock's start pass
  fires the run's record at once. The cluster also redelivers the driver's
  keep-alive, but only after its 10 s storage-read retry (measured: 11.2 s
  with the start pass removed, against 1 s with it). The 8 s bound tells
  the two apart. An owner turn with no run behind it waits the same 10 s
  before it resumes (measured).
- **C3b's third case changed with R4.** A command whose process record
  never committed (a trigger refuses the `Recorded` step) is stopped from
  its launcher's receipt: the ask has no `mayStillRun`, and the group is
  gone. `mayStillRun: true` now needs a receipt that cannot be read.
- **A cut answer is not reachable.** Core stores a tool call's result when
  the call ends, not when its step settles, so a kill after `machine.answer`
  committed keeps its result (measured: the result was stored while its
  sibling `bash` call still ran). The test instead sends the recorded answer
  again after the restart, as a client whose reply was lost would: it is
  admitted and applies nothing.
