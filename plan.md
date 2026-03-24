# No-Polling Boundary Plan

Status: in progress.

## End-State API

Three seams. No mixed ownership.

- `getSessionSnapshot(...)`
- `streamEvents(...)`
- `watchRuntime(...)`

Types:

- `SessionSnapshot`
- `SessionRuntime`

## Problem

The current boundary is wrong.

- `watchSessionState(...)` mixes storage-owned data and actor-owned runtime state.
- `watchQueue(...)` is poll-and-diff.
- `subscribeEvents(...)` in the SQLite-backed server path is also poll-and-diff.
- the TUI ends up reconciling two writers for the same visible surface:
  - persisted snapshots
  - live streamed events

That is not a UI bug. It is a boundary bug.

## First-Principles Design

If we had known the real requirement from the start, we would have built:

1. one-shot persisted snapshot query

- storage-owned
- session metadata + persisted messages

2. append-only event stream

- replay + live continuation
- event-owned

3. current-value runtime watch

- current value immediately
- pushed updates after that
- actor-owned
- includes queue state because queue and runtime status share the same owner and source

That means:

- no `watchSessionState(...)`
- no separate `watchQueue(...)`
- no poll-and-diff in production subscriptions

## Governing Principles

- `~/.brain/principles/boundary-discipline.md`
- `~/.brain/principles/serialize-shared-state-mutations.md`
- `~/.brain/principles/fix-root-causes.md`
- `~/.brain/principles/subtract-before-you-add.md`
- `~/.brain/principles/redesign-from-first-principles.md`
- `~/.brain/principles/encode-lessons-in-structure.md`
- `~/.brain/principles/migrate-callers-then-delete-legacy-apis.md`
- `~/.brain/principles/prove-it-works.md`
- `~/.brain/principles/experience-first.md`
- `~/.brain/principles/foundational-thinking.md`
- `~/.brain/principles/make-operations-idempotent.md`

## Design Rules

- one owner per state surface
- no API that fuses storage-owned messages with actor-owned runtime flags
- use existing actor machinery before inventing another publisher layer
- no stopgaps
- no compatibility padding once the better API is chosen
- delete legacy seams in the same refactor wave after callers migrate
- serial architecture invariant:
  - one worker process is the single writer
  - one actor per session/branch serializes all mutations
  - SQLite is durability and replay only, not the live bus
  - attached clients only observe or enqueue commands to the owning actor

## Critical Receipts

Existing actor push primitive:

- `ActorRef.snapshot`
- `ActorRef.state`
- `ActorRef.changes`
- `ActorRef.waitFor`

Source:

- `/Users/cvr/Developer/personal/gent/node_modules/effect-machine/dist/actor.d.ts`

Existing event-store split:

- in-memory `EventStore` is already push-based
- SQLite-backed `EventStoreLive` is the polling implementation that must be fixed

Sources:

- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/event.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/event-store.ts`

## Non-Goals

- do not event-source token streaming
- do not keep `watchSessionState(...)`
- do not keep `watchQueue(...)`
- do not add retry or polling logic to SDK to mask backend design flaws
- do not keep local TUI reconciliation logic for streamed assistant content

## Task List

- [x] Batch 1 — Split snapshot from runtime at the contract layer
- [x] Batch 2 — Make event streaming fully push-based in `EventStoreLive`
- [x] Batch 3 — Expose `watchRuntime(...)` from the actor boundary
- [x] Batch 4 — Migrate transport and SDK to the new seams
- [x] Batch 5 — Rewrite TUI around snapshot + events + runtime
- [x] Batch 6 — Delete legacy APIs and prove the full chain
- [ ] Batch 7 — Burn Down Remaining Production Sleeps

## Batch 1 — Split Snapshot From Runtime At The Contract Layer

Commit:

- `refactor(contract): split session snapshot from runtime`

Why:

- the current contract type is the root bug
- `SessionState` mixes two owners into one API
- everything else is forced to compensate for that bad cut

Relevant skills:

- `architecture`
- `effect-v4`
- `code-style`

Relevant principles:

- `boundary-discipline`
- `redesign-from-first-principles`
- `subtract-before-you-add`
- `migrate-callers-then-delete-legacy-apis`

Files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-queries.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts`

Detailed spec:

- delete `watchSessionState(...)` from the contract
- delete `watchQueue(...)` from the contract
- introduce:
  - `getSessionSnapshot({ sessionId, branchId })`
  - `streamEvents({ sessionId, branchId, after })`
  - `watchRuntime({ sessionId, branchId })`
- `SessionSnapshot` contains:
  - persisted session metadata
  - persisted messages
  - optional last durable event id only if truly needed
- `SessionRuntime` contains only actor-owned runtime fields
  - status / phase
  - current agent
  - queue snapshot
  - active turn metadata if useful
  - no persisted messages

Tests:

- replace contract tests that assume `watchSessionState(...)` or `watchQueue(...)`
- add compile/runtime tests for the new contract types
- run:
  - `bun run gate`

## Batch 2 — Make Event Streaming Fully Push-Based In `EventStoreLive`

Commit:

- `refactor(events): make sqlite event streaming push-based`

Why:

- event polling is still real production polling
- the in-memory event store is already correct
- the SQLite-backed implementation is the actual target

Relevant skills:

- `architecture`
- `effect-v4`
- `code-style`

Relevant principles:

- `fix-root-causes`
- `boundary-discipline`
- `make-operations-idempotent`

Files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/server/event-store.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/event.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts`

Detailed spec:

- rewrite `EventStoreLive.subscribe(...)` so it does:
  - durable catch-up from storage
  - then live continuation from an in-process push channel
- mirror the existing in-memory design rather than inventing a new event API
- make the live path explicit:
  - add `PubSub.unbounded<EventEnvelope>()` inside `EventStoreLive`
  - `publish` appends to SQLite first, then pushes to `PubSub`
  - `subscribe` reads buffered events from SQLite, then continues from `PubSub`
- the single-writer invariant makes this safe:
  - the worker always appends before pushing
  - clients never mutate event state directly
- preserve replay semantics with `after`
- preserve session/branch filtering
- no `Effect.sleep(...)`
- no storage polling loop

Tests:

- parity tests for:
  - replay after cursor
  - live continuation
  - reconnect after restart
- run:
  - `bun run gate`
  - `bun test tests/event-stream-parity.test.ts tests/live-event-parity.test.ts`

## Batch 3 — Expose `watchRuntime(...)` From The Actor Boundary

Commit:

- `feat(runtime): expose actor-backed runtime watch`

Why:

- the actor already owns runtime truth
- `ActorRef.changes` already exists
- the correct design is to expose that ownership directly

Relevant skills:

- `architecture`
- `effect-v4`
- `code-style`

Relevant principles:

- `serialize-shared-state-mutations`
- `subtract-before-you-add`
- `fix-root-causes`
- `encode-lessons-in-structure`

Files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.state.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/actor-process.ts`

Detailed spec:

- add `watchRuntime(...)` backed by:
  - current `actor.snapshot`
  - subsequent `actor.changes`
- map loop state through existing pure projections in `agent-loop.state.ts`
- include queue state in the runtime payload instead of exposing a second watch
- expose through `AgentLoopService`
- expose through `ActorProcessService`
- cold-start is create-on-demand, not a separate coordination problem:
  - `watchRuntime(...)` calls `getLoop(...)`
  - `getLoop(...)` is already semaphore-protected and idempotent
  - a newly created loop starts in `Idle`, which is the initial runtime snapshot
  - after that, the watch continues from `actor.changes`
- do not add a loop-lifecycle pubsub or registry `SubscriptionRef` unless the actor path proves insufficient

Tests:

- runtime tests for:
  - immediate idle snapshot with no loop
  - watch wakes up on first submitted turn
  - queue changes appear through runtime updates
  - restart/recovery still converges correctly
- run:
  - `bun run gate`

## Batch 4 — Migrate Transport And SDK To The New Seams

Commit:

- `refactor(transport): adopt snapshot, events, and runtime`

Why:

- after Batches 1-3, transport should get thinner
- transport should expose the correct ownership model, not a convenience blob

Relevant skills:

- `architecture`
- `effect-v4`
- `code-style`

Relevant principles:

- `boundary-discipline`
- `migrate-callers-then-delete-legacy-apis`
- `subtract-before-you-add`

Files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpcs.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts`

Detailed spec:

- move all callers off:
  - `watchSessionState(...)`
  - `watchQueue(...)`
  - `subscribeLiveEvents(...)` if it becomes redundant
- bind transport methods to:
  - `getSessionSnapshot(...)`
  - `streamEvents(...)`
  - `watchRuntime(...)`
- remove legacy contract paths in the same refactor wave

Tests:

- direct / in-process RPC / worker transport parity
- run:
  - `bun run gate`
  - `bun test tests/transport-contract.test.ts tests/watch-state-parity.test.ts tests/queue-contract.test.ts`

## Batch 5 — Rewrite TUI Around Snapshot + Events + Runtime

Commit:

- `refactor(tui): consume the correct boundaries`

Why:

- once boundaries are correct, the TUI should simplify
- no more local reconciliation theater

Relevant skills:

- `opentui`
- `react`
- `architecture`
- `code-style`

Relevant principles:

- `experience-first`
- `boundary-discipline`
- `subtract-before-you-add`

Files:

- `/Users/cvr/Developer/personal/gent/apps/tui/src/hooks/use-session-feed.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-controller.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/integration/session-feed-boundary.test.tsx`

Detailed spec:

- bootstrap persisted history from `getSessionSnapshot(...)`
- update visible messages from `streamEvents(...)`
- drive thinking/progress/status from `watchRuntime(...)`
- drive queue widget from `watchRuntime().queue`
- delete `mergeProjectedMessages`
- delete any local streamed-content reconciliation shim
- migrate `context.tsx` too
  - it currently consumes the mixed state seam during reconnect/bootstrap

Tests:

- integration proofs for:
  - partial streamed content before final completion
  - status/progress follows runtime updates
  - queue updates while active turn runs
  - reconnect and worker restart recover correctly
- run:
  - `bun run gate`
  - `bun run test:integration`

## Batch 6 — Delete Legacy APIs And Prove The Full Chain

Commit:

- `refactor(state): delete legacy mixed-state and polling seams`

Why:

- if old seams survive, they will be reused
- no backwards compatibility requirement here

Relevant skills:

- `architecture`
- `effect-v4`
- `code-style`

Relevant principles:

- `migrate-callers-then-delete-legacy-apis`
- `encode-lessons-in-structure`
- `prove-it-works`

Files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-subscriptions.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-queries.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/hooks/use-session-feed.ts`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`
- `/Users/cvr/Developer/personal/gent/AGENTS.md`

Detailed spec:

- remove:
  - `watchSessionState(...)`
  - `watchQueue(...)`
  - `subscribeLiveEvents(...)` if redundant
  - any production poll-and-diff helpers
  - any comments/docs that normalize polling
- document the final model explicitly:
  - snapshot query
  - event stream
  - runtime watch

Tests:

- full unit gate
- full integration lane
- manual proof:
  - run a real session
  - verify streamed content, progress state, and queue state all update live with no polling
- run:
  - `bun run gate`
  - `bun run test:integration`

## Batch 7 — Burn Down Remaining Production Sleeps

Commit:

- `refactor(runtime): replace readiness polling with explicit receipts`

Why:

- the session/event seams are not the only remaining sleeps
- worker readiness and reconnect logic still use fixed delays
- that is still temporal coupling, just in a different coat

Relevant skills:

- `architecture`
- `effect-v4`
- `code-style`

Relevant principles:

- `fix-root-causes`
- `boundary-discipline`
- `prove-it-works`

Files:

- `/Users/cvr/Developer/personal/gent/apps/server/src/main.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/worker/supervisor.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/utils/run-with-reconnect.ts`
- `/Users/cvr/Developer/personal/gent/tests/seam-fixture.ts`

Detailed spec:

- add an explicit worker readiness receipt after the HTTP layer is actually built
- remove supervisor startup polling based on `Bun.sleep(100)`
- remove ad hoc worker-not-running waits in TUI client bootstrap
- make reconnect wait on lifecycle or stream failure receipts where possible, not fixed sleeps
- leave true retry/backoff code alone unless it is faking state observation
- production session/event/runtime subscription paths should not depend on `Effect.sleep(...)`

Tests:

- worker startup still succeeds
- worker restart still succeeds
- TUI bootstrap still reconnects correctly
- run:
  - `bun run gate`
  - `bun run test:integration`

## Success Criteria

- no `Effect.sleep(...)` in production event/state subscription paths
- no `watchSessionState(...)`
- no `watchQueue(...)`
- no mixed storage+runtime state watch API
- no TUI reconciliation shim for partial assistant streaming
- all visible session behavior flows from the correct owner:
  - storage snapshot
  - event stream
  - runtime watch

## Receipts

- `/Users/cvr/Developer/personal/gent/plan.md`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/event.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/event-store.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-subscriptions.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-queries.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-events.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.state.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/actor-process.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/hooks/use-session-feed.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx`
- `/Users/cvr/Developer/personal/gent/node_modules/effect-machine/dist/actor.d.ts`
- `/tmp/counsel/20260324-113846-codex-to-claude-4ed72a/claude.md`
- `/tmp/counsel/20260324-114701-codex-to-claude-0eb8e4/claude.md`
