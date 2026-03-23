# Seam Test Plan

Status: in progress.

## Task List

- [x] Batch 1 — Shared contract harness
- [x] Batch 2 — Event stream parity
- [x] Batch 3 — Worker boundary tests
- [ ] Batch 4 — Session feed projection tests
- [ ] Batch 5 — Queue and resume semantics across boundaries
- [ ] Batch 6 — Structural guards

## Summary

The bug we just hit was not a core logic bug. It was a seam bug:

- cluster-backed actor runtime
- worker transport
- remote event subscription
- TUI feed projection

The code worked. The boundary did not.

So the plan is not "add more tests" in the abstract.

The plan is:

1. test the shared contract across transports
2. test live event delivery across runtime boundaries
3. test TUI projections against real backend signals
4. encode those seams structurally so regressions fail fast

No full e2e browser-style harness needed.
But boundary tests are mandatory now.

## Principles

### Prove It Works

- do not trust compile, mocks, or local reducers alone
- exercise the real input -> runtime -> storage -> event -> UI chain
- every new seam test must observe the real artifact:
  - real worker
  - real transport
  - real event stream
  - real queue snapshot

### Boundary Discipline

- test shells at the shell
- test business logic in pure/unit tests
- do not pretend a mocked event callback proves an RPC stream works
- do not pretend `SessionCommands -> ActorProcess` proves TUI-visible behavior

### Encode Lessons In Structure

- transport parity should live in one shared suite, not four ad hoc tests
- worker-only regressions should have worker-only boundary tests
- TUI feed regressions should have feed projection tests driven by real backend events

### Subtract Before Add

- prefer one reusable contract-suite over many one-off tests
- prefer one seam harness per boundary over scattered bespoke fixtures

## Current Audit

### What we already test well

- core actor/queue/tool behavior
- checkpoint recovery
- storage semantics
- TUI render surfaces
- worker boot/restart supervision

### What was missing

- remote `subscribeEvents` live delivery after `sendMessage`
- parity between direct/in-process/http/worker transports
- TUI session feed behavior driven by a real backend transport
- queue/thinking visibility through the remote worker seam

## Test Matrix

The shared client contract should be exercised across these transports:

- direct client
  - `makeDirectGentClient`
- in-process RPC client
  - `makeInProcessClient`
- HTTP RPC client
  - `makeHttpGentClient`
- worker-supervised client
  - `startWorkerSupervisor(...).client`

Core rule:

- the same behavioral assertions should run against all four when possible
- if a behavior is transport-specific, make that explicit in the test name

## Batches

### Batch 1 — Shared Contract Harness

Checklist:

- [x] add reusable transport harness
- [x] add shared contract assertions
- [x] run first parity suite against direct client
- [x] run first parity suite against in-process RPC client
- [x] run first parity suite against HTTP worker client
- [x] `bun run gate`

Goal:

- build one reusable transport-suite harness

Deliverables:

- helper that takes a `GentClient` factory
- shared assertions for:
  - create session
  - list session
  - send message
  - list messages
  - get session state
  - queue snapshot

Tests:

- new shared contract suite under `tests/` or `packages/sdk/tests/`
- one smoke case per transport using the same assertions

Gate:

- `bun run gate`

### Batch 2 — Event Stream Parity

Checklist:

- [x] shared stream assertions for replay/live/after semantics
- [x] cover in-process RPC stream
- [x] cover HTTP worker stream
- [x] keep queue/steer visibility assertions out of stream tests
- [x] `bun run gate`

Goal:

- prove `subscribeEvents` behaves the same across transports

Assertions:

- buffered replay works
- live events continue after replay
- `after` cursor works
- stream survives normal turn completion
- stream parity covers only what the stream actually owns:
  - buffered replay
  - live continuation
  - cursor semantics

Tests:

- shared stream suite against:
  - in-process RPC
  - HTTP RPC
  - worker client
- direct client excluded only if it lacks the exact same stream semantics

Special focus:

- this batch should permanently cover the regression we just fixed
- queue and steer ordering remain Batch 5 concerns because they are primarily snapshot/command semantics, not first-class event-stream contracts

Gate:

- `bun run gate`

### Batch 3 — Worker Boundary Tests

Checklist:

- [x] restart preserves session visibility
- [x] restart preserves queue visibility
- [x] auth/session visibility through worker seam
- [x] debug mode uses same seam
- [x] `bun run gate`

Goal:

- test the actual worker seam, not just process liveness

Assertions:

- worker client receives live events after `sendMessage`
- worker restart preserves session state
- worker restart preserves queue visibility
- debug worker path uses same seam and same bootstrap behavior
- auth/session state remains visible through worker transport

Tests:

- extend `apps/tui/tests/worker-supervisor.test.ts`

Gate:

- `bun run gate`

### Batch 4 — Session Feed Projection Tests

Checklist:

- [ ] real transport-backed feed harness
- [ ] thinking indicator projection
- [ ] assistant message projection
- [ ] queue widget projection
- [ ] error-to-session-event projection
- [ ] `bun run gate`

Goal:

- prove TUI state derives correctly from real backend events

Assertions:

- thinking indicator appears on `StreamStarted`
- assistant message appears from stream/message events
- queue widget updates while active turn is running
- interjection/queued follow-up ordering shows correctly
- error events become session events, not composer pollution

Approach:

- do not mock callback-only event emitters
- drive `ClientProvider` / `useSessionFeed` from a real transport-backed client

Tests:

- new feed-boundary tests in `apps/tui/tests/`

Gate:

- `bun run gate`

### Batch 5 — Queue And Resume Semantics Across Boundaries

Checklist:

- [ ] active-turn queue visibility
- [ ] steer beats follow-up
- [ ] drain matches UI restore semantics
- [ ] restart while queued work exists converges correctly
- [ ] `bun run gate`

Goal:

- prove queue state is observable and durable through seams

Assertions:

- multiple sends during active turn show queued follow-up entries
- steer cuts ahead of queued follow-up
- `getQueuedMessages` matches observed event/state progression
- drained queue contents match what UI restores to composer
- worker restart during queued work converges correctly

Tests:

- contract-level queue suite
- worker-boundary queue suite

Gate:

- `bun run gate`

### Batch 6 — Structural Guards

Checklist:

- [ ] document seam test guidance
- [ ] add lightweight guards where useful
- [ ] point future client behavior tests at shared contract suite
- [ ] `bun run gate`

Goal:

- stop us from drifting back into false-confidence tests

Deliverables:

- boundary guard docs/tests updated
- test helper docs for “which seam to test where”
- make the transport contract suite the default place for new client behavior

Tests:

- lightweight structural guard where helpful
- no giant meta-tests

Gate:

- `bun run gate`

## Execution Rules

- each batch gets its own commit
- each batch adds or upgrades tests before moving on
- no batch is done until `bun run gate` passes
- if a batch touches a seam, verify that seam directly
- no replacing boundary tests with mocks once a real seam harness exists

## Success Criteria

We are done when:

- transport parity exists as a real reusable suite
- worker event delivery is covered beyond one-off regression tests
- TUI feed projection is tested against a real backend transport
- queue visibility and restart behavior are covered at the worker boundary
- the next “backend worked, UI was blind” bug fails a boundary test immediately

## Receipts

- `/Users/cvr/Developer/personal/gent/tests/core.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/client-context.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/tests/client.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/worker-supervisor.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-events.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/event-store.ts`
- `/Users/cvr/Developer/personal/gent/apps/server/src/main.ts`
- `/Users/cvr/.brain/principles/prove-it-works.md`
- `/Users/cvr/.brain/principles/boundary-discipline.md`
