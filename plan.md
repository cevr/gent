# Subscription Seam Plan

Status: complete.

## Task List

- [x] Batch 1 — Decouple supervision from transport
- [x] Batch 2 — Shared worker fixture and boilerplate collapse
- [x] Batch 3 — Split subscription semantics
- [x] Batch 4 — Move TUI/feed tests onto the right seam
- [x] Batch 5 — Add missing boundary coverage for each seam
- [x] Batch 6 — DX cleanup, timing pass, final gate

## Summary

The current subscription model is overloaded.

One API is trying to be three things:

1. durable event log replay
2. live event subject
3. current state watcher

That is the source of a lot of the race pain.

The cleaner model is:

- event log:
  - append-only
  - cursor-based
  - replayable
- live events:
  - from-now-on
  - no replay
  - transient
- watched state:
  - immediate current snapshot
  - then updates
  - derived from backend state, not rebuilt ad hoc in each caller

Do not force replay-subject semantics onto raw events.
Do not force current-state semantics onto an event log.

## Principles

### Boundary Discipline

- raw event history is a different boundary from current derived state
- transport should expose those seams explicitly, not via caller folklore
- supervision remains separate from transport and from subscriptions

### Prove It Works

- each seam gets its own tests
- transport parity tests should not depend on TUI projection details
- TUI/feed tests should use the state/watch seam when that is the real contract

### Subtract Before Add

- stop making callers do “fetch snapshot, subscribe events, reconcile locally” when the backend can expose the right watch seam
- remove ambiguous subscription behavior before adding more harness cleverness

### Encode Lessons In Structure

- `subscribeEvents` means durable event log semantics
- `subscribeLiveEvents` means live-only semantics
- `watchSessionState` / `watchQueue` mean replay-current-value semantics

## Seam Model

### 1. Event Log

Purpose:

- receipts
- recovery
- auditability
- replay from `after`

Properties:

- ordered
- durable
- cursor-based
- append-only

API shape:

- `subscribeEvents({ sessionId, branchId?, after? })`

This stays.

### 2. Live Events

Purpose:

- low-latency “from now on” observation
- no caller confusion about replay handoff

Properties:

- ephemeral
- no replay
- no cursor

API shape:

- `subscribeLiveEvents({ sessionId, branchId? })`

This is new.

### 3. Watched State

Purpose:

- current session/feed/queue state
- replay-subject semantics
- TUI-friendly

Properties:

- emits current snapshot immediately
- then emits updates
- no caller-side “get snapshot then hope subscription catches up”

API shape:

- `watchSessionState({ sessionId, branchId })`
- `watchQueue({ sessionId, branchId })`
- maybe later:
  - `watchWorkerState`
  - `watchAuthState`

This is the real “ReplaySubject” seam.

## Current Audit

### What is wrong now

- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`
  - only exposes `subscribeEvents({ after })`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx`
  - has to fetch snapshot, subscribe, and project local state
- `/Users/cvr/Developer/personal/gent/tests/event-stream-parity.test.ts`
  - exists because replay/live semantics are subtle and caller-visible
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/event-store.ts`
  - disk store is an event-log seam, not a state-watch seam

### What is already good

- supervision and transport are now separate in code
- worker fixture duplication is reduced
- transport parity and worker boundary suites exist

## Batch Ordering Rationale

Do the semantic split before more performance work.

Why:

- if the seam is still ambiguous, faster tests just hide the wrong model
- once the seam is explicit, the right test homes become obvious
- only then does further polling reduction make architectural sense

## Batches

### Batch 3 — Split Subscription Semantics

Goal:

- make the contract explicit:
  - replayed event log
  - live event stream
  - watched derived state

Checklist:

- [x] keep `subscribeEvents` as event-log replay
- [x] add `subscribeLiveEvents`
- [x] add `watchSessionState`
- [x] add `watchQueue`
- [x] derive types from transport schemas
- [x] `bun run gate`

Execution plan:

1. Extend `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`
   - define live/watch inputs and outputs
2. Extend server handlers / client adapters
   - `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpcs.ts`
   - `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts`
   - `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts`
3. Keep `subscribeEvents` semantics strict
   - durable replay + `after`
4. Implement live-only and watch-state surfaces behind the same transport contract
5. Do not remove old callers yet

Acceptance:

- each subscription API has one job
- no API name implies mixed semantics
- SDK/direct/http all expose the same split contract

Expected commit:

- `feat(transport): split event and state subscriptions`

### Batch 4 — Move TUI / Feed Tests Onto The Right Seam

Goal:

- stop making the TUI rebuild replay-subject behavior out of raw events when it really wants watched state

Checklist:

- [x] move session/feed projection onto `watchSessionState`
- [x] move queue widget projection onto `watchQueue`
- [x] keep raw event subscription only where raw events are actually needed
- [x] update TUI seam tests
- [x] `bun run gate`

Execution plan:

1. Update `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx`
   - use watch seams for derived state
   - keep raw events for receipts/debug surfaces only
2. Update session feed projection tests
   - `/Users/cvr/Developer/personal/gent/apps/tui/tests/session-feed-boundary.test.tsx`
3. Remove caller-side snapshot + event reconciliation that becomes redundant
4. Preserve current UI behavior

Acceptance:

- TUI feed state no longer depends on replay/live timing luck
- queue/thinking/current state come from watch seams
- raw event streams remain available for receipts and machine/debug surfaces

Expected commit:

- `refactor(tui): consume watched session state`

### Batch 5 — Missing Boundary Coverage For Each Seam

Goal:

- prove each seam independently

Checklist:

- [x] event-log parity suite
- [x] live-event parity suite
- [x] watched-state parity suite
- [x] worker restart coverage per seam
- [x] auth and bootstrap seams where still missing
- [x] `bun run gate`

Execution plan:

1. Keep event-log parity in:
   - `/Users/cvr/Developer/personal/gent/tests/event-stream-parity.test.ts`
2. Add live-event parity suite
   - immediate post-subscribe delivery
   - no replay guarantees
3. Add watched-state parity suite
   - immediate current snapshot
   - subsequent updates
   - restart/reconnect behavior
4. Add missing seams:
   - server HTTP entrypoint
   - system/native auth through worker
   - route/bootstrap seam against real worker path

Acceptance:

- tests are organized by seam, not by vague “integration”
- a regression tells us which contract failed

Expected commit:

- `test(seams): cover event live and watch contracts`

### Batch 6 — DX Cleanup, Timing Pass, Final Gate

Goal:

- keep the confidence, reduce the friction

Checklist:

- [x] measure focused seam runtimes again
- [x] split fast parity from slow lifecycle suites clearly
- [x] tidy helper names/docs
- [x] close the plan
- [x] `bun run gate`

Execution plan:

1. Re-measure:
   - transport parity
   - worker boundary
   - TUI feed boundary
2. Separate suite groupings explicitly:
   - fast seam parity
   - worker lifecycle/restart
   - TUI feed/render seam
3. Update test docs if needed
4. Mark plan complete only if the contracts are explicit in code and tests

Acceptance:

- the right seam is obvious from the test file name
- callers no longer have to guess which subscription semantics they are getting
- runtimes are no worse than today, preferably better

Expected commit:

- `docs(test): finalize subscription seam coverage`

## Receipts

- `/Users/cvr/Developer/personal/gent/plan.md`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx`
- `/Users/cvr/Developer/personal/gent/tests/event-stream-parity.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/event.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/event-store.ts`
- `/Users/cvr/.brain/principles/boundary-discipline.md`
- `/Users/cvr/.brain/principles/prove-it-works.md`
- `/Users/cvr/.brain/principles/subtract-before-you-add.md`
- `/Users/cvr/.brain/principles/encode-lessons-in-structure.md`
