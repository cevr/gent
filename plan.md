# Seam Test Improvement Plan

Status: not started.

## Task List

- [ ] Batch 1 — Decouple supervision from transport
- [ ] Batch 2 — Shared worker fixture and boilerplate collapse
- [ ] Batch 3 — Polling reduction and event-driven waits
- [ ] Batch 4 — Fast parity vs slow lifecycle split
- [ ] Batch 5 — Missing boundary coverage
- [ ] Batch 6 — DX cleanup and final timing pass

## Summary

The seam tests are valuable. They also cost too much and ask too much of the reader.

Current problems:

1. worker cold-start churn dominates runtime
2. polling loops stack on top of each other
3. harness boilerplate is duplicated across suites
4. supervision and transport are still coupled in code
5. fast contract parity and slow lifecycle/recovery scenarios are mixed too loosely
6. a few important seams still are not covered

The goal is not fewer seam tests.
The goal is:

- keep the confidence
- cut avoidable runtime
- make supervision a first-class concern independent of transport
- make the right test home obvious
- close the remaining boundary gaps

Transport and supervision are separate axes.

- transport:
  - direct
  - in-process RPC
  - HTTP RPC
- hosting:
  - same process
  - child worker process
  - remote server process
- supervision:
  - none
  - local/service restart
  - process restart
  - cluster/entity durability

So the plan is not "worker tests = supervision tests".
The plan is:

- decouple supervision from transport first
- test transport parity where transport matters
- test supervision/lifecycle where supervision matters
- test combined seams explicitly when the bug depends on both

## Principles

### Prove It Works

- keep real seam tests for real seam bugs
- optimize harness/runtime, not confidence away
- every boundary claim should still be backed by a test that crosses that boundary

### Boundary Discipline

- supervision should own lifecycle, not client construction
- shared client behavior belongs in transport suites
- worker lifecycle belongs in worker suites
- TUI feed projection belongs in transport-backed feed suites
- server entrypoint behavior belongs in server seam suites
- do not treat transport and supervision as the same concern

### Subtract Before Add

- delete repeated temp-dir/env/setup code before adding new cases
- reuse one worker per suite where restart isolation is not the point
- replace generic polling with event-driven waits where possible

### Encode Lessons In Structure

- fast suites and slow suites should be structurally distinct
- transport helpers should make the intended seam explicit
- new client behavior tests should naturally land in the right suite because the harness makes that easy

## Current Audit

### Runtime cost

- worker-starting suites are the slow path
- `tests/transport-contract.test.ts` + `tests/event-stream-parity.test.ts` + `tests/queue-contract.test.ts` take about `7.3s`
- `apps/tui/tests/worker-supervisor.test.ts` + `apps/tui/tests/session-feed-boundary.test.tsx` take about `18.5s`
- the slowest individual tests are the session-feed boundary tests at about `3.7s` to `3.9s` each

### Main causes

- repeated worker spawn per test
- `100ms` polling in worker readiness
- `100ms` polling in durable event tailing
- `100ms` polling in generic test `waitFor`
- `25ms` render polling in feed tests

### DX / maintainability smells

- duplicated temp-dir/env worker setup in multiple files
- duplicated `waitFor` helpers
- `WorkerSupervisor` constructs an HTTP client instead of exposing a supervised host
- no clean split between:
  - fast transport parity
  - slow restart/recovery/lifecycle tests
- transport, hosting, and supervision are not named separately enough in the current harness

### Missing seams

- reconnect behavior when a live subscriber survives worker restart
- server HTTP entrypoint seam independent of TUI supervisor
- system/native auth seam through the worker path
- durable mid-turn recovery observed through transport/UI
- route/bootstrap seam against the real worker path

## Batch Ordering Rationale

Do the architecture cut first.

- if supervision stays fused to HTTP worker transport, the later test cleanup just hardens the wrong seam
- once supervision is lifecycle-only, the transport suites and supervision suites can split cleanly
- then fixture extraction and speed work can follow the new structure instead of fighting it

## Batches

### Batch 1 — Decouple Supervision From Transport

Checklist:

- [ ] define a supervision-only surface
- [ ] separate supervised host info from client construction
- [ ] keep worker HTTP as one adapter, not the supervisor itself
- [ ] preserve current TUI behavior
- [ ] `bun run gate`

Goal:

- make supervision a lifecycle concern instead of an HTTP-specific wrapper

Execution plan:

1. Split current worker seam into:
   - supervisor/lifecycle
   - transport binding
2. Make the supervisor expose host info/state only:
   - start
   - stop
   - restart
   - lifecycle state
   - endpoint/host descriptor
3. Move `GentClient` construction out of the supervisor
4. Keep TUI call sites thin by composing:
   - supervised worker host
   - HTTP transport adapter
5. Leave room for future:
   - supervised direct host
   - supervised in-process RPC host

Concrete tasks:

- [ ] extract a worker host/supervisor core from `apps/tui/src/worker/supervisor.ts`
- [ ] introduce a transport binder for HTTP worker hosts
- [ ] update TUI startup to compose supervisor + transport explicitly
- [ ] update tests to target the new seam names
- [ ] prove existing worker restart/debug behavior still works

Acceptance:

- supervisor no longer directly calls `makeHttpGentClient`
- transport binding is explicit at composition sites
- worker behavior is unchanged from the TUI’s point of view
- the code now makes it plausible to supervise non-HTTP hosts later

Expected commit:

- `refactor(tui): decouple worker supervision from transport`

Likely files:

- `/Users/cvr/Developer/personal/gent/apps/tui/src/worker/supervisor.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/main.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/app-bootstrap.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/worker-supervisor.test.ts`
- `/Users/cvr/Developer/personal/gent/tests/transport-harness.ts`

### Batch 2 — Shared Worker Fixture And Boilerplate Collapse

Checklist:

- [ ] add one reusable worker test fixture for temp-dir/env/start/stop
- [ ] remove repeated worker setup from `worker-supervisor` and `session-feed-boundary`
- [ ] remove duplicated `waitFor` helpers where the same helper can be shared
- [ ] keep semantics unchanged
- [ ] `bun run gate`

Goal:

- make the seam tests cheaper to write and easier to read

Execution plan:

1. Inventory all duplicated worker boot helpers:
   - temp dir creation
   - auth/data path wiring
   - debug/provider env wiring
   - start/stop/restart wrapper shape
2. Introduce one shared worker fixture with:
   - `withWorker(...)`
   - `withWorkerClient(...)`
   - optional `providerMode`, `debug`, `fileBackedAuth`, `persistenceMode`
3. Move duplicated `waitFor` into one shared test helper only where call sites are genuinely identical
4. Refactor:
   - `apps/tui/tests/worker-supervisor.test.ts`
   - `apps/tui/tests/session-feed-boundary.test.tsx`
   - `tests/transport-harness.ts`
5. Keep assertions and test names stable unless they are misleading

Concrete tasks:

- [ ] add shared worker fixture module
- [ ] add shared `waitForEffect` helper or equivalent
- [ ] migrate `worker-supervisor.test.ts`
- [ ] migrate `session-feed-boundary.test.tsx`
- [ ] migrate worker branch of `transport-harness.ts`
- [ ] remove dead local helpers after migration

Acceptance:

- worker-based test files lose repeated temp-dir/env/startup scaffolding
- no semantic regression in current seam coverage
- focused rerun:
  - `apps/tui/tests/worker-supervisor.test.ts`
  - `apps/tui/tests/session-feed-boundary.test.tsx`
  - `tests/transport-contract.test.ts`
  - `tests/event-stream-parity.test.ts`
  - `tests/queue-contract.test.ts`

Deliverables:

- shared worker fixture helper under `tests/` or `apps/tui/tests/`
- one shared polling/wait utility where reuse is actually justified

Expected commit:

- `test(seams): extract shared worker test fixture`

Likely files:

- `/Users/cvr/Developer/personal/gent/tests/transport-harness.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/worker-supervisor.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/session-feed-boundary.test.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/render-harness.tsx`
- `/Users/cvr/Developer/personal/gent/tests/` new helper file

### Batch 3 — Polling Reduction And Event-Driven Waits

Checklist:

- [ ] identify waits that can become event/deferred driven
- [ ] reduce test-side polling first
- [ ] reduce worker-ready polling if practical without making startup flakier
- [ ] do not regress durability semantics in event-store subscription
- [ ] `bun run gate`

Goal:

- cut needless latency from the seam harness

Execution plan:

1. Classify waits by kind:
   - worker startup readiness
   - client-side state/query convergence
   - event stream delivery
   - TUI render convergence
2. Replace polling where a signal already exists:
   - `Deferred`
   - `Stream.take` / first matching envelope
   - worker lifecycle subscription
   - state transition listener
3. Keep bounded polling only where the system genuinely has no push signal
4. Tighten poll intervals only after removing unnecessary polls
5. Re-measure the same focused suites as Batch 1

Concrete tasks:

- [ ] replace event-delivery waits with stream/deferred waits where possible
- [ ] replace worker restart waits with lifecycle subscription helper reuse
- [ ] reduce or eliminate render polling preconditions by waiting on backend state first
- [ ] evaluate whether `waitForWorkerReady` can switch from HTTP polling to a cheaper readiness signal
- [ ] leave `EventStore.subscribe` durability semantics intact unless a push-based tail is actually justified

Acceptance:

- at least the obvious event-driven waits are no longer polling loops
- no increase in flake rate
- focused suites are faster or at worst equal with lower complexity

Measurement protocol:

- before and after:
  - `bun test tests/transport-contract.test.ts tests/event-stream-parity.test.ts tests/queue-contract.test.ts`
  - `cd apps/tui && bun test --preload ./node_modules/@opentui/solid/scripts/preload.ts tests/worker-supervisor.test.ts tests/session-feed-boundary.test.tsx`

Expected commit:

- `test(seams): reduce polling in seam harnesses`

Targets:

- `waitFor` in transport and worker tests
- feed render waits where a backend event or session-state edge can be used first
- worker readiness handshake in supervisor tests

Likely files:

- `/Users/cvr/Developer/personal/gent/tests/transport-harness.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/worker-supervisor.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/session-feed-boundary.test.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/worker/supervisor.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/event-store.ts`

### Batch 4 — Fast Parity Vs Slow Lifecycle Split

Checklist:

- [ ] make the fast transport parity suites obviously fast-only
- [ ] move restart/recovery scenarios to worker-only suites where needed
- [ ] reuse one worker per `describe` where restart isolation is not the point
- [ ] keep transport parity assertions shared
- [ ] `bun run gate`

Goal:

- separate “contract parity” from “lifecycle durability”

Additional goal:

- make transport vs supervision intent obvious in test layout

Rules:

- fast parity:
  - `direct`
  - `in-process-rpc`
  - `worker-http` only where transport parity matters
- slow lifecycle:
  - restart
  - crash recovery
  - queued convergence
  - auth persistence

Structure:

- transport suites should be parameterized by transport
- supervision suites should be parameterized by host/supervisor strategy only if that distinction matters
- combined tests should say so explicitly in the test name

Execution plan:

1. Define suite ownership explicitly:
   - transport parity
   - lifecycle/restart
   - recovery/durability
   - TUI projection
2. Move or rename tests whose current home hides that distinction
3. Reuse one worker per `describe` for pure parity checks
4. Keep restart-per-test only where restart itself is under test
5. Narrow transport matrices where a test is not truly transport-shaped

Concrete tasks:

- [ ] audit every test in `transport-contract`, `event-stream-parity`, `queue-contract`, `worker-supervisor`
- [ ] move restart-only cases out of generic parity suites if any remain
- [ ] collapse repeated worker-per-test parity setup to worker-per-describe where safe
- [ ] rename tests that currently blur transport and supervision concerns
- [ ] verify direct/in-process/worker coverage still maps cleanly to intended seams

Acceptance:

- a reader can tell from file name and test name whether a failure is:
  - transport parity
  - worker lifecycle
  - durability/recovery
  - TUI projection
- worker-heavy parity tests spawn fewer workers

Expected commit:

- `test(seams): split parity from lifecycle coverage`

Likely files:

- `/Users/cvr/Developer/personal/gent/tests/transport-contract.test.ts`
- `/Users/cvr/Developer/personal/gent/tests/event-stream-parity.test.ts`
- `/Users/cvr/Developer/personal/gent/tests/queue-contract.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/worker-supervisor.test.ts`

### Batch 5 — Missing Boundary Coverage

Checklist:

- [ ] add reconnect-after-worker-restart live subscription test
- [ ] add server HTTP entrypoint seam test
- [ ] add system/native auth seam test where supported
- [ ] add durable mid-turn recovery observable through transport or TUI
- [ ] add route/bootstrap seam test against worker path
- [ ] `bun run gate`

Goal:

- cover the real gaps, not meta-test around them

Execution plan:

1. Add the missing seams one at a time, not as one giant integration dump
2. Prefer boundary-local tests:
   - worker seam in worker tests
   - bootstrap seam in TUI bootstrap tests
   - server entry seam in server/core tests
3. Only add a new helper when at least two new cases need it

Concrete tasks:

- [ ] add reconnect-after-restart subscription test
- [ ] add server HTTP entrypoint transport test without TUI supervisor involvement
- [ ] add native/system auth seam test gated by platform support
- [ ] add client-visible mid-turn recovery test
- [ ] add bootstrap seam tests for:
  - new session with prompt
  - continue latest session
  - specific session resume

Acceptance:

- each currently missing seam has at least one concrete test owner
- mid-turn recovery is no longer only proven in core actor/storage tests
- route/bootstrap behavior is proven against the real worker seam

Risk notes:

- native auth test must skip cleanly when host platform/backend is unavailable
- server seam test should not duplicate worker tests; it should isolate server hosting without supervisor behavior

Expected commit shape:

- potentially split into two commits:
  - `test(seams): cover reconnect and server seams`
  - `test(seams): cover auth recovery and bootstrap seams`

Assertions:

- active subscriber reconnects and resumes event visibility after worker restart
- server app seam serves the same contract without TUI supervisor involvement
- native auth-backed credentials are visible through worker transport on supported platforms
- recovery after crash during a turn is visible from the client side, not only in core recovery tests
- home/continue/session bootstrap paths behave correctly against the worker seam
- at least one suite proves supervision can be exercised independently of transport assumptions when practical

Likely files:

- `/Users/cvr/Developer/personal/gent/apps/tui/tests/worker-supervisor.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/session-feed-boundary.test.tsx`
- `/Users/cvr/Developer/personal/gent/tests/core.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/server/src/main.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/auth-storage.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/main.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/app-bootstrap.ts`

### Batch 6 — DX Cleanup And Final Timing Pass

Checklist:

- [ ] measure the focused seam suites again
- [ ] document which suite owns which boundary
- [ ] trim any remaining dead helpers introduced during the refactor
- [ ] confirm no important seam is still unowned
- [ ] `bun run gate`

Goal:

- finish with a test layout that is faster, clearer, and easier to extend

Execution plan:

1. Re-measure the focused seam suites
2. Compare against current baseline:
   - `7.3s` for contract/event/queue subset
   - `18.5s` for worker/feed subset
3. Remove leftover helper cruft and misnamed fixtures
4. Write down suite ownership briefly, but only in docs agents actually read
5. Confirm no remaining important seam is orphaned

Concrete tasks:

- [ ] run before/after timing comparison
- [ ] prune dead helpers introduced in earlier batches
- [ ] tighten names for fixtures/helpers/suites where still muddy
- [ ] update `plan.md` with completion state and final measurements
- [ ] optionally update `AGENTS.md` or test-local docs only if the ownership split is still non-obvious

Acceptance:

- focused worker/feed suite is materially faster than `18.5s`, or we have a written explanation of the hard floor
- focused contract/event/queue suite is at least no worse than `7.3s`
- suite ownership is obvious from filenames + helper names, not only prose
- no known missing seam remains unassigned

Expected commit:

- `test(seams): finalize harness ownership and timings`

Success criteria:

- worker-heavy suites are materially faster
- harness duplication is lower
- parity vs lifecycle split is obvious from file structure
- transport vs supervision split is obvious from file structure
- the missing seams above have owners
- new seam work has an obvious home

## Execution Rules

- each batch gets its own commit
- each batch includes relevant tests or test refactors
- no batch is done until `bun run gate` passes
- if a batch claims a speedup, re-measure the focused seam suite
- do not delete a real seam test without replacing its coverage
- pause after each batch with:
  - changed files
  - measured timings if relevant
  - any seam ownership changes

## Receipts

- `/Users/cvr/Developer/personal/gent/tests/transport-harness.ts`
- `/Users/cvr/Developer/personal/gent/tests/transport-contract.test.ts`
- `/Users/cvr/Developer/personal/gent/tests/event-stream-parity.test.ts`
- `/Users/cvr/Developer/personal/gent/tests/queue-contract.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/worker-supervisor.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/session-feed-boundary.test.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/worker/supervisor.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/event-store.ts`
- `/Users/cvr/Developer/personal/gent/tests/core.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/main.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/app-bootstrap.ts`
