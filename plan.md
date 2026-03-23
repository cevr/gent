# TUI Worker Supervision And Durable Turns

Status: implemented.

## Summary

Move the TUI onto a supervised worker-hosted app runtime.

Do not use a Bun `Worker` thread as the architectural target. Use a child process.

Reason:

- BEAM/OTP value is crash isolation plus supervision.
- Thread workers do not buy a hard enough failure boundary.
- We already have the right inner abstraction:
  - transport contract
  - actor-process boundary
  - cluster-shaped actor entity

So the target architecture is:

- TUI shell process
  - owns terminal, renderer, input, local UX state
  - supervises one child app worker
- app worker process
  - hosts app services
  - exposes the shared transport contract
  - boots `ClusterSingleLive`
  - runs `ActorProcess` through `SessionActorEntity` / `ClusterActorProcessLive`
- durable actor state
  - queued turns and in-flight turn recovery survive worker restarts

This is not just “make crashes less bad.” It is a shift to a more OTP-shaped topology.

## Design Principles

- Redesign from first principles:
  - if we had known from day one that the TUI should survive app crashes, we would never have booted the app graph inside `apps/tui/src/main.tsx`.
- Serialize shared-state mutations structurally:
  - one owner for turn state
  - one durable log for actor commands/checkpoints
  - no “best effort” reconstruction from incidental UI state
- Boundary discipline:
  - TUI owns presentation
  - worker owns application/runtime
  - transport contract is the seam
- Subtract before adding:
  - kill in-process TUI app hosting once the worker path exists
  - do not keep two first-class runtime topologies forever

## Principle Audit

This plan is intentionally shaped around the brain principles.

### Boundary Discipline

- good:
  - TUI shell vs worker ownership is explicit
  - transport contract stays singular
  - `EventStore` is not overloaded into recovery truth
- rule for implementation:
  - validation stays at worker transport / RPC boundaries
  - recovery logic stays in durable actor runtime code, not in TUI heuristics

### Serialize Shared-State Mutations

- good:
  - turn state has one owner: the worker-hosted actor runtime
  - queue state is not reconstructed from UI state
- required:
  - one durable inbox
  - one checkpoint store
  - one recovery coordinator on worker boot

### Subtract Before You Add

- required ordering:
  - add worker topology
  - migrate callers
  - delete production in-process hosting
- anti-goal:
  - no permanent dual-topology runtime

### Make Operations Idempotent

- this was underspecified in the first draft
- now required:
  - every durable command has a stable command id
  - inbox replay is explicitly idempotent
  - checkpoints reconcile partial prior runs
  - recovery converges after repeated crashes

### Migrate Callers Then Delete Legacy APIs

- this was too soft in the first draft
- now required:
  - once worker transport is the right path, migrate all production TUI callers
  - delete production direct-hosting path in the same refactor wave
  - keep only test/debug scaffolding that is structurally fenced off

### Prove It Works

- compile/lint is insufficient here
- every batch must include direct runtime proof:
  - kill worker
  - observe restart
  - verify rehydration
  - verify queue/turn recovery behavior

### Encode Lessons In Structure

- do not leave “remember to use worker transport” as a doc rule
- encode end-state invariants in structure:
  - explicit worker bootstrap entrypoint
  - TUI production path cannot import app dependency wiring directly
  - tests assert restart/recovery semantics

## Target Architecture

```text
TUI shell process
    │
    ▼
supervisor
    │
    ▼
app worker process
    │
    ▼
worker transport adapter
    │
    ▼
shared transport contract
    │
    ▼
ClusterSingleLive
    │
    ▼
ClusterActorProcessLive / SessionActorEntity
    │
    ▼
durable inbox + checkpoints + projections
```

### Ownership

- TUI shell owns:
  - renderer lifecycle
  - keyboard and route state
  - reconnect logic
  - restart UX
- worker owns:
  - storage
  - providers
  - event store
  - actor runtime
  - queue state
  - turn execution
- durable turn state owns:
  - what should resume after a crash

## Execution Rules

These apply to every batch without exception.

- each batch gets its own commit
- each batch adds or updates the tests that prove that batch
- no batch is done until `bun run gate` passes
- when a batch introduces a new runtime seam, verify the actual runtime seam directly, not just unit tests

## Key Decisions

### 1. Child process, not thread worker

Use a child process for real isolation.

Do not treat `Worker` as the guiding star.

### 2. Transport contract stays singular

The worker must expose the same client contract as direct / HTTP.

No worker-specific DTO layer.

### 3. Use Effect cluster where it helps

`ActorProcess` is already cluster-shaped:

- `SessionActorEntity`
- `SessionActorEntityLive`
- `ClusterActorProcessLive`
- `ClusterSingleLive`

Use that.

This is not a later optimization. It is the worker runtime default.

Use cluster for actor routing and durable mailbox semantics inside the worker, not as an excuse to distribute the whole app immediately.

Practical target:

- worker boots `ClusterSingleLive`
- worker uses `ClusterActorProcessLive`
- session/branch actors live behind the entity boundary
- `LocalActorProcessLive` survives only in tests/debug scaffolding

### 4. Turn durability is required for the real win

Without durability, worker supervision only gives:

- TUI survives crash
- worker restarts
- session can reconnect

But current in-memory turn queue and in-flight run still die with the worker.

That is not enough.

### 5. Use journaled commands + checkpoints, not naive full event sourcing

Do not pretend every stream chunk needs to be event-sourced.

Best cut:

- durable actor inbox / command journal
- durable turn checkpoints
- projections stay derivable
- existing `EventStore` remains diagnostic / UI-facing event stream

So the source of truth becomes:

- commands
- queue mutations
- turn phase checkpoints

Not:

- ad hoc machine locals
- incidental UI state
- replaying every provider token forever

## Durability Model

### Durable Records

Add durable records for:

- actor inbox entries
  - `SendUserMessage`
  - `Interrupt`
  - `SteerAgent`
  - `SendToolResult`
- queue snapshot or queue mutation log
- active turn checkpoint
  - current phase
  - sessionId / branchId
  - current message id
  - agent
  - startedAt
  - interrupt flags
  - persisted assistant draft id, if any
  - pending tool calls, if any
- worker supervision metadata
  - restart count
  - last crash reason

### Recovery Semantics

On worker restart:

1. restore durable inbox / queue state
2. restore actor checkpoints
3. for each actor:
   - if idle, no-op
   - if queued, resume draining
   - if in-flight streaming, mark interrupted-by-crash and continue from a safe phase

### Safe Resume Policy

Be explicit. Do not fake transparency.

Recommended policy:

- if crash occurs before assistant message persistence:
  - re-run the turn from the last durable pre-stream checkpoint
- if crash occurs after partial assistant persistence but before finalization:
  - finalize interrupted state
  - continue queue drain
- if crash occurs during tool execution:
  - only auto-resume idempotent tools
  - otherwise persist interrupted/failed state and require a follow-up turn

This is closer to OTP reality:

- supervision restarts processes
- work replay depends on durable mailbox/state
- side effects need explicit idempotency policy

## Commit Batches

### Batch 1 — Introduce Worker Topology

Justification:

- First-principles cut.
- The TUI shell should stop booting app services directly.
- The worker should not start life on a dead-end local runtime path.

Target:

- add an app worker entrypoint
- add TUI supervisor process management
- make the worker host the shared contract immediately
- keep behavior unchanged from the user’s perspective

Task list:

- create worker bootstrap entrypoint that hosts app services
- define shell ↔ worker lifecycle states
- start/stop/restart worker from the TUI shell
- point production TUI client creation at the worker-hosted shared contract
- fence direct hosting behind test/debug-only scaffolding immediately
- update docs to reflect the new topology
- add one end-to-end proof:
  - TUI starts
  - worker boots
  - shared client calls succeed through the worker
  - session home/session render still works

Relevant skills:

- `architecture`
- `effect-v4`
- `bun`
- `opentui`

Primary files:

- `/Users/cvr/Developer/personal/gent/apps/tui/src/main.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/app.tsx`
- `/Users/cvr/Developer/personal/gent/apps/server/src/main.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/worker/supervisor.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts`

### Batch 2 — Make Cluster The Worker Runtime Default

Justification:

- We already have `SessionActorEntity`.
- Booting the worker on `LocalActorProcessLive` first would be throwaway architecture.

Target:

- worker uses cluster-backed actor routing as the runtime default

Task list:

- wire worker runtime through `ClusterSingleLive`
- provide `ClusterActorProcessLive` instead of `LocalActorProcessLive` in production worker wiring
- ensure session actors are addressed by `sessionId:branchId`
- keep non-cluster local/test layers for tests only
- document the new runtime path
- add a direct verification test that two session actors isolate queue state under the cluster-backed path

Relevant skills:

- `architecture`
- `effect-v4`

Primary files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/actor-process.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/cluster-layer.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts`
- `/Users/cvr/Developer/personal/gent/apps/server/src/main.ts`

### Batch 3 — Add Durable Actor Inbox

Justification:

- Supervision without a durable inbox is restart theater.

Target:

- commands to actors are durably recorded before execution

Task list:

- define durable inbox schema/tables
- include stable command ids / idempotency keys
- persist actor-targeted commands before dispatch
- mark command lifecycle:
  - pending
  - running
  - completed
  - failed
- restore pending/running commands on worker boot
- keep inbox ownership in the worker, not the TUI
- add reconciliation rules for duplicate command replay
- prove convergence when the same command is replayed after crash

Relevant skills:

- `effect-v4`
- `architecture`

Primary files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/actor-process.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/event.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/queue.ts`

### Batch 4 — Add Turn Checkpoints

Justification:

- Cluster mailbox durability is not enough.
- In-flight turn state still dies unless we checkpoint the turn machine explicitly.

Target:

- `AgentLoop` persists phase checkpoints at stable boundaries

Task list:

- define checkpoint schema:
  - resolving
  - streaming
  - executing-tools
  - finalizing
- checkpoint queue state and active turn identity
- checkpoint persisted assistant draft references where needed
- checkpoint pending tool executions / replay policy metadata
- restore loop state from checkpoints on worker restart
- define checkpoint versioning / invalidation rules
- add crash-at-each-phase tests, not just happy-path recovery

Relevant skills:

- `effect-v4`
- `architecture`

Primary files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.state.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop-phases.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts`

### Batch 5 — Define Crash Recovery Semantics

Justification:

- “Resume after crash” is meaningless unless phase-by-phase semantics are explicit.

Target:

- crash behavior becomes a designed policy, not emergent behavior

Task list:

- define replay/resume rules for each phase
- define idempotent vs non-idempotent tool behavior
- define what gets surfaced to the user after recovery
- publish restart/recovery events into the session stream
- ensure queues continue draining after recovery
- explicitly reject “best effort” silent recovery where correctness is ambiguous
- require a recovery matrix in docs/tests:
  - crash point
  - persisted state
  - resumed action
  - user-visible outcome

Relevant skills:

- `effect-v4`
- `architecture`

Primary files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.state.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop-phases.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts`

### Batch 6 — Reconnect And Heal In The TUI

Justification:

- Worker restarts are only valuable if the shell reconnects cleanly.

Target:

- TUI shell survives worker crash and rehydrates state

Task list:

- detect worker death
- show restart/reconnecting state in the TUI
- restart worker under supervision policy
- reconnect transport
- rehydrate:
  - session state
  - queue snapshot
  - latest branch messages
  - event subscription after last event id
- prove it end-to-end by killing the worker during an active session and observing recovery directly

Relevant skills:

- `opentui`
- `react`
- `architecture`
- `effect-v4`

Primary files:

- `/Users/cvr/Developer/personal/gent/apps/tui/src/main.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-controller.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session.tsx`

### Batch 7 — Delete Transitional In-Process Hosting

Justification:

- Keeping two first-class topologies forever is architectural cowardice.

Target:

- TUI uses worker-hosted app runtime by default
- direct hosting is test-only or intentionally debug-only

Task list:

- migrate remaining production callers first
- remove production in-process app boot from TUI in the same wave
- prune compatibility helpers that only supported dual topology
- simplify docs and startup paths to one real default
- keep the minimum test scaffolding needed for local/in-memory tests
- encode the end-state in structure:
  - no production import path from TUI shell to app dependency wiring
  - tests or lint/grep guard against regression

Relevant skills:

- `architecture`
- `effect-v4`

Primary files:

- `/Users/cvr/Developer/personal/gent/apps/tui/src/main.tsx`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`

## Test Plan

### Worker supervision

- TUI starts worker and reaches home/session successfully
- worker crash triggers restart
- TUI reconnects automatically
- active session view rehydrates after restart
- repeated crash/restart converges to the same shell state

### Durable inbox

- queued follow-up survives worker crash
- steering command survives worker crash
- inbox replay is idempotent on repeated restart
- duplicate command delivery converges, not duplicates

### Turn checkpoints

- crash during resolving resumes correctly
- crash during streaming yields interrupted/replayed semantics as designed
- crash during tool execution respects idempotency rules
- crash during finalizing does not strand queue state
- crash twice at the same phase still converges

### Cluster-backed actor routing

- `SessionActorEntity` routes by `sessionId:branchId`
- multiple sessions isolate queue state correctly
- worker restart restores entity-backed actor state from durability layer

### Full gate after each batch

- `bun run lint`
- `bun run typecheck`
- `bun run test`
- `bun run build`

## Structural End-State Invariants

These should be encoded, not remembered:

- production TUI shell does not host app dependencies in-process
- production TUI talks only through worker transport
- worker owns actor runtime and durable recovery
- `EventStore` is not the sole recovery truth
- command replay and recovery are idempotent by design

## Open Questions

These should be answered during implementation, not hand-waved away now.

### Should existing `EventStore` be the source of truth?

Probably no.

Reason:

- current event stream is diagnostic/UI-facing
- not every event is the right persistence unit for recovery
- provider chunk replay is too noisy

Better:

- keep `EventStore` for domain + diagnostic events
- add a dedicated durable inbox/checkpoint store
- optionally derive projections from that plus storage state

### Should we fully event-source turns?

Probably not.

Best cut:

- event-source commands and durable phase transitions
- checkpoint rich runtime state at stable boundaries
- do not store every token chunk as the canonical recovery mechanism

### Should cluster be cross-process/networked immediately?

No.

Use `ClusterSingleLive` inside one worker process first.

That already gives:

- entity routing
- better supervision semantics
- a path to future distribution without forcing it now

## Source Receipts

- `/Users/cvr/Developer/personal/gent/apps/tui/src/main.tsx`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/actor-process.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.state.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/cluster-layer.ts`
- `/Users/cvr/.brain/principles/redesign-from-first-principles.md`
- `/Users/cvr/.brain/principles/serialize-shared-state-mutations.md`
