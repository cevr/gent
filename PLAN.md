# Extension Runtime Fidelity Plan

Status: proposed.

## Context

The current extension system is good enough to ship, but not honest about what it is.

- It is actor-shaped, not actor-faithful.
- It isolates startup failures better than before, but supervision is still mostly log-and-degrade.
- Status and diagnostics are assembled in too many places.
- The client/runtime seam duplicates protocol and status logic.
- The test suite mixes strong behavioral regression tests with low-signal shape/inventory tests.
- `@effect-diagnostics` suppressions are partly justified host-boundary glue and partly real debt.

This plan fixes the foundation first, then deletes scaffolding, then cleans tests and suppressions on a stable architecture.

## Scope

In scope:

- make the extension runtime faithful enough to the actor model to justify the term
- simplify extension boot, health, projection, and client seams without losing features
- consolidate and sharpen tests around behavior seams
- remove high-value suppression debt

Out of scope:

- redesigning provider auth
- redesigning memory feature semantics beyond its scheduler boundary
- changing remote/local product topology again

## Governing Principles

- `/Users/cvr/.brain/principles/foundational-thinking.md`
- `/Users/cvr/.brain/principles/boundary-discipline.md`
- `/Users/cvr/.brain/principles/fix-root-causes.md`
- `/Users/cvr/.brain/principles/subtract-before-you-add.md`
- `/Users/cvr/.brain/principles/serialize-shared-state-mutations.md`
- `/Users/cvr/.brain/principles/redesign-from-first-principles.md`
- `/Users/cvr/.brain/principles/migrate-callers-then-delete-legacy-apis.md`
- `/Users/cvr/.brain/principles/prove-it-works.md`
- `/Users/cvr/.brain/principles/experience-first.md`

## Relevant Skills

- `architecture`
- `effect-v4`
- `code-style`
- `tdd`
- `review`
- `bun`
- `opentui`

## Global Rules

Every batch must:

1. end with exactly one single-purpose commit
2. run:
   - `bun run gate`
3. run an independent review agent on the batch diff before continuing
4. stop if the review finds a high-severity issue
5. only continue after review findings are addressed or explicitly deferred in the plan
6. do not begin the next batch until the current batch commit exists, verification is green, and review has signed off

Review prompt baseline for every batch:

- audit for behavioral regressions
- audit for architecture drift against this plan
- audit for test quality and missing coverage
- audit for new suppression comments or type escapes

## Batches

### Batch 0 — Remove `test:integration` And Fold It Into `test`

Goal:

- make fast integration tests part of the normal `test` pipeline so `bun run gate` covers them by default

Why:

- these tests were split out to protect speed, but they are now fast enough to belong in the main path
- if integration coverage is important enough to gate every batch, it should not require a second human command forever

Justification:

- scaffold first
- every later batch benefits from one honest default verification path

Files:

- `/Users/cvr/Developer/personal/gent/package.json`
- `/Users/cvr/Developer/personal/gent/turbo.json`
- `/Users/cvr/Developer/personal/gent/packages/core/package.json`
- `/Users/cvr/Developer/personal/gent/packages/sdk/package.json`
- `/Users/cvr/Developer/personal/gent/apps/tui/package.json`
- `/Users/cvr/Developer/personal/gent/packages/e2e/package.json`
- docs referencing `test:integration`

Brain principles:

- `foundational-thinking`
- `prove-it-works`
- `experience-first`
- `subtract-before-you-add`

Relevant skills:

- `bun`
- `tdd`
- `code-style`

Changes:

- fold fast integration suites into `bun run test`
- remove `test:integration` as a script entirely
- ensure `bun run gate` executes those suites automatically
- document the new test contract in repo docs if needed

Tasks:

1. remove `test:integration` from root and workspace package scripts
2. remove any `test:integration` turbo task wiring
3. fold fast TUI and e2e integration suites into each package `test` script
4. update docs, comments, and agent instructions that still mention `test:integration`
5. run `bun run gate`
6. get independent review on the batch diff
7. commit only Batch 0 changes

Verification:

- `bun run gate`
- prove former integration-only failures now fail `bun run gate`
- independent review agent on the commit diff

Commit rule:

- one batch, one commit
- commit only Batch 0 changes before moving on

### Batch 1 — Make The Actor Contract Honest

Goal:

- define the real actor runtime contract and remove lifecycle ambiguity

Why:

- the current system claims `spawn -> start -> ... -> stop`, but adapters eagerly start themselves
- `ask` is promised uniformly but not actually implemented uniformly
- raw state access and host-side derive weaken actor ownership

Justification:

- foundational data structures first
- parent-owned lifecycle before supervision policy
- no further simplification will stick if the core contract stays muddy

Files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/from-reducer.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/from-machine.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-actor-shared.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/state-runtime.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/actor.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/lifecycle.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/from-machine.test.ts`

Brain principles:

- `foundational-thinking`
- `boundary-discipline`
- `serialize-shared-state-mutations`
- `subtract-before-you-add`

Relevant skills:

- `architecture`
- `effect-v4`
- `tdd`

Changes:

- make `spawn` cold and parent-owned
- keep one honest `ExtensionRef` surface with explicit `void` replies where needed
- remove eager start from adapters
- remove raw `Ref` escape hatches from adapter init hooks; deeper projection ownership lands later
- add red tests for lifecycle ownership before implementation

Tasks:

1. write or tighten red tests for cold spawn, explicit start, and stop ownership
2. keep `ask` on the actor boundary, treat unsupported requests as loud protocol/runtime errors, and use explicit `void` replies for command-like requests
3. remove eager actor start from reducer and machine adapters
4. make runtime own lifecycle transitions explicitly
5. replace raw `Ref` state reach-through with snapshot/update helpers where the adapter contract currently leaks
6. run `bun run gate`
7. get independent review on the batch diff
8. commit only Batch 1 changes

Verification:

- `bun run gate`
- add/keep focused actor lifecycle tests
- independent review agent on the commit diff

Commit rule:

- one batch, one commit
- commit only Batch 1 changes before moving on

### Batch 2 — Queue Delivery, Don’t Inline Reduce

Goal:

- move extension message/event delivery to real per-session queued processing

Why:

- current reduction runs inline on the `EventStore.publish` call stack
- nested delivery currently gets skipped instead of queued
- one slow extension can block host publish

Justification:

- this is the main reason “actor model” is currently overstated
- it is also the main serialization boundary for shared mutable extension state

Files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/state-runtime.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/turn-control.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/concurrency.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/event-routing.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/server/reducing-event-store.test.ts`

Brain principles:

- `serialize-shared-state-mutations`
- `fix-root-causes`
- `redesign-from-first-principles`
- `boundary-discipline`

Relevant skills:

- `architecture`
- `effect-v4`
- `tdd`

Changes:

- no synchronous extension reduction from event-store publish
- no nested publish skip path
- queued processing per session/extension
- define backpressure/error policy explicitly

Tasks:

1. add red tests for nested publish ordering, no-skip delivery, and slow extension isolation
2. introduce per-session or per-extension queues at the runtime boundary
3. remove inline reduction from event-store publish paths
4. define and encode backpressure/error handling semantics in code and tests
5. verify publish callers still see correct durability/ordering guarantees
6. run `bun run gate`
7. get independent review on the batch diff
8. commit only Batch 2 changes

Verification:

- `bun run gate`
- regression tests for nested publish, ordering, and slow/failing extension delivery
- independent review agent on the commit diff

Commit rule:

- one batch, one commit
- commit only Batch 2 changes before moving on

### Batch 3 — Add Real Supervision Policy

Goal:

- make extension runtime failures supervised instead of merely logged and marked failed

Why:

- current runtime failure handling is mostly status bookkeeping
- actor model value here is failure isolation with explicit supervision semantics

Justification:

- once delivery is mailbox-based, restart/escalation policy becomes coherent
- without policy, “actor failure isolation” remains half-true

Files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/state-runtime.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/actor.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/concurrency.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/activation.test.ts`

Brain principles:

- `fix-root-causes`
- `foundational-thinking`
- `experience-first`

Relevant skills:

- `architecture`
- `effect-v4`
- `tdd`

Changes:

- one-for-one supervision policy
- bounded restart budget
- terminal failed state after exhaustion
- explicit distinction between activation failure and actor runtime failure

Tasks:

1. add red tests for restart-on-failure, retry budget exhaustion, and terminal failed state
2. encode supervision policy in runtime state instead of ad hoc failure bookkeeping
3. distinguish activation failures from runtime failures in types and status
4. ensure restart does not violate queue ordering or lifecycle ownership from prior batches
5. run `bun run gate`
6. get independent review on the batch diff
7. commit only Batch 3 changes

Verification:

- `bun run gate`
- tests for restart, retry exhaustion, and final failed state
- independent review agent on the commit diff

Commit rule:

- one batch, one commit
- commit only Batch 3 changes before moving on

### Batch 4 — Collapse Extension Boot Into One Reconciler

Goal:

- replace the multi-pass discovery/setup/validate/startup/scheduler/status assembly with one host reconciliation pipeline

Why:

- validation and health are computed in more than one place
- registry currently re-derives facts already known by boot
- scheduler diagnostics are bolted on after activation instead of being part of host truth

Justification:

- duplicate truth is already producing architecture drag
- this is a straightforward subtraction batch once actor/runtime rules are stable

Files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/activation.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/scheduler.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/activation.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/registry.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/scheduler.test.ts`

Brain principles:

- `subtract-before-you-add`
- `boundary-discipline`
- `encode-lessons-in-structure`
- `foundational-thinking`

Relevant skills:

- `architecture`
- `effect-v4`
- `tdd`

Changes:

- single host reconciliation result:
  - active extensions
  - failed extensions
  - scheduled job diagnostics
  - static contribution catalog
- registry stops re-validating or re-joining status

Tasks:

1. map current multi-pass extension boot/status flow end-to-end before cutting code
2. create one reconciler result that owns extension activation, validation, scheduler diagnostics, and catalog assembly
3. delete duplicate validation/status joins from registry and startup wiring
4. update tests so non-fatal degradation is asserted through the new reconciler output
5. run `bun run gate`
6. get independent review on the batch diff
7. commit only Batch 4 changes

Verification:

- `bun run gate`
- contract tests for one-pass reconciliation and non-fatal extension degradation
- independent review agent on the commit diff

Commit rule:

- one batch, one commit
- commit only Batch 4 changes before moving on

### Batch 5 — Unify Extension Health Surface

Goal:

- replace split activation/actor/scheduler status with one server-owned health model

Why:

- current health data is joined across registry, runtime, RPC, and TUI
- the TUI widget is compensating for backend fragmentation

Justification:

- health is one product surface and should have one owner
- this batch deletes both server and client glue

Files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpcs/extension.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/context.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/connection-widget.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/widgets-render.test.tsx`

Brain principles:

- `boundary-discipline`
- `subtract-before-you-add`
- `experience-first`

Relevant skills:

- `architecture`
- `effect-v4`
- `opentui`
- `tdd`

Changes:

- one `ExtensionHealth` model from the server
- TUI consumes one health feed instead of recomputing categories
- remove duplicated status joins and refresh glue where possible

Tasks:

1. define one server-owned `ExtensionHealth` model covering activation, actor runtime, and scheduler status
2. thread that model through transport contract, RPCs, and handlers
3. simplify TUI extension status context to consume one feed instead of joining categories
4. update degraded-state and refresh tests around the new health model
5. run `bun run gate`
6. get independent review on the batch diff
7. commit only Batch 5 changes

Verification:

- `bun run gate`
- TUI tests for degraded activation/runtime/scheduler states and refresh behavior
- independent review agent on the commit diff

Commit rule:

- one batch, one commit
- commit only Batch 5 changes before moving on

### Batch 6 — Remove Client-Side Protocol Duplication

Goal:

- delete duplicate protocol-registration logic in the TUI/client path if message metadata already provides enough typing/decoding information

Why:

- current client protocol registry is likely duplicate truth
- protocol knowledge should live at the boundary, not in two places

Justification:

- this is pure subtraction if Batch 5 is complete
- it reduces one more category of drift between server and TUI

Files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-protocol.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-client.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/loader.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/resolve.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/context.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-discovery.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-resolve.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-integration.test.ts`

Brain principles:

- `subtract-before-you-add`
- `boundary-discipline`
- `foundational-thinking`

Relevant skills:

- `architecture`
- `effect-v4`
- `tdd`

Changes:

- prefer message metadata / shared protocol definitions as single source of truth
- delete client-side duplicate protocol map if not needed
- keep type-safe ask/send behavior intact

Tasks:

1. trace every current client-side protocol registration or decode table
2. remove duplicate client protocol maps where message metadata already carries the truth
3. preserve typed ask/send behavior through shared protocol definitions or metadata
4. collapse tests onto the surviving client seam
5. run `bun run gate`
6. get independent review on the batch diff
7. commit only Batch 6 changes

Verification:

- `bun run gate`
- extension client/TUI protocol tests stay green with fewer moving parts
- independent review agent on the commit diff

Commit rule:

- one batch, one commit
- commit only Batch 6 changes before moving on

### Batch 7 — Consolidate Tests Around Behavioral Seams

Goal:

- keep the good regression tests, cut or merge low-signal structural tests

Why:

- current suites include real behavioral guards and also a lot of shape/inventory noise
- duplicate collision/precedence coverage is spread across too many files

Justification:

- test cleanup should happen after the architecture stabilizes, not before
- TDD principles say public seam and behavior first

Files:

- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/api.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/builtins.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/loader.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/registry.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/memory/state.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/memory/dreaming.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/client-context.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-discovery.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-resolve.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-integration.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/widgets-render.test.tsx`
- `/Users/cvr/Developer/personal/gent/packages/sdk/tests/client.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/tests/supervisor.test.ts`

Brain principles:

- `prove-it-works`
- `boundary-discipline`
- `subtract-before-you-add`

Relevant skills:

- `tdd`
- `test`
- `code-style`

Changes:

- preserve high-value behavior suites:
  - agent-loop continuation/recovery/interaction
  - scheduler
  - memory vault
  - TUI degraded-state rendering
  - local supervisor lifecycle
- collapse duplicate extension collision/precedence coverage
- replace fake-provider/context tests with real public-seam tests
- split unrelated concerns jammed into single test files

Tasks:

1. inventory extension, sdk, and TUI test files by behavior seam vs shape noise
2. delete or merge low-signal inventory/structure tests
3. keep and sharpen regression tests around public behavior seams
4. replace fake provider/context coverage with real public seam tests where still needed
5. split overloaded files only where it improves ownership and clarity
6. run `bun run gate`
7. get independent review on the batch diff
8. commit only Batch 7 changes

Verification:

- `bun run gate`
- review test diff specifically for behavior-vs-implementation quality
- independent review agent on the commit diff

Commit rule:

- one batch, one commit
- commit only Batch 7 changes before moving on

### Batch 8 — Pay Down High-Value Suppression Debt

Goal:

- remove suppressions that hide weak typing or unnecessary abstraction leaks while keeping justified host-boundary suppressions

Why:

- wildcard `*:off` suppressions are mostly real debt
- many `nodeBuiltinImport:off` suppressions are actually fine and should stay

Justification:

- cleanup should target high-value suppressions only
- don’t churn justified host-boundary seams for ideology points

Files:

- `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/hooks/use-runtime.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/event-bus.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/interaction-request.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/interaction-handlers.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/tools/ask-user.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/e2e-layer.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/fixtures.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/main.tsx`

Brain principles:

- `boundary-discipline`
- `fix-root-causes`
- `subtract-before-you-add`

Relevant skills:

- `effect-v4`
- `code-style`
- `tdd`

Changes:

- remove wildcard runtime-boundary suppressions by tightening types
- replace raw JSON interaction persistence path with schema-backed encoding/decoding
- remove trivial no-op/time suppressions
- leave justified host-boundary `nodeBuiltinImport:off` comments alone unless a stronger boundary appears

Tasks:

1. inventory remaining suppressions by category: justified boundary, real debt, test noise
2. remove wildcard suppressions by tightening the underlying types or seams
3. replace any raw JSON persistence path with schema-backed encoding/decoding
4. keep justified host-boundary suppressions and document why they survive
5. run `bun run gate`
6. get independent review on the batch diff
7. commit only Batch 8 changes

Verification:

- `bun run gate`
- grep audit of remaining suppressions with explanation for each survivor
- independent review agent on the commit diff

Commit rule:

- one batch, one commit
- commit only Batch 8 changes before moving on

### Batch 9 — Final Verification Against Plan

Goal:

- verify the final system against the architectural claims in this plan

Why:

- without a final audit, cleanup batches tend to drift and leave quiet contradictions behind

Files:

- `/Users/cvr/Developer/personal/gent/PLAN.md`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`
- all touched files from Batches 1-8

Brain principles:

- `prove-it-works`
- `fix-root-causes`
- `experience-first`

Relevant skills:

- `review`
- `architecture`
- `tdd`

Changes:

- no feature work unless final audit finds a real miss
- compare end state to each batch goal
- document intentional deviations
- update `ARCHITECTURE.md` if the final design diverged

Tasks:

1. audit each completed batch against its goal, tasks, and verification claims
2. fix any real misses found by the audit
3. update architecture/docs for any intentional divergence from the original bridge design
4. run `bun run gate`
5. get independent review on the full stack diff
6. commit only Batch 9 changes

Verification:

- `bun run gate`
- independent review agent for whole-stack audit
- final manual checklist:
  - actor lifecycle is parent-owned
  - delivery is queued, not inline
  - health has one owner
  - client protocol/status duplication is removed or justified
  - tests describe behavior at public seams
  - remaining suppressions are justified

Commit rule:

- one batch, one commit
- commit only Batch 9 changes before closing the plan

## Decision Tree To Resolve Before Batch 1

1. Should “actor model” mean true queued mailbox delivery?
   Recommended: yes.

2. Should every extension support `ask`?
   Recommended: no. Split command-only from request-capable refs if needed.

3. Should the host ever read raw extension state?
   Recommended: no. Projection/view data only.

4. Should actor runtime failures restart automatically?
   Recommended: yes, with bounded one-for-one retries.

5. Should activation, actor, and scheduler status unify into one health model?
   Recommended: yes.

6. Should the event bus remain available?
   Recommended: yes, but explicitly as observation/pubsub, not actor ownership.

7. Should scheduled jobs stay global?
   Recommended: yes. That matches current product intent.

8. Should test cleanup happen before architecture cleanup?
   Recommended: no. Architecture first, then tests.

## Success Criteria

- extension runtime is honest about its actor semantics
- one owner per state/health surface
- less duplicated truth across boot, registry, RPC, and TUI
- tests emphasize behavior and regressions over structure snapshots
- high-value suppressions removed, justified ones documented
