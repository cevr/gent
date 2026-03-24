# State Machine Audit Plan

Status: in progress.

## Audit Summary

The repo is not “anti-machine”. It has both good machines and obvious misses.

What is good:

- `AgentLoop` phase modeling is the right backbone.
- small pure reducers in TUI are often the right size:
  - `home-state`
  - `session-ui-state`
  - `composer-state`
  - `prompt-search-state`
  - `session-tree-state`
  - `mermaid-viewer-state`
- projections like `agent-lifecycle` should stay projections, not get promoted to machines.

What is wrong:

- some canonical runtime state is still reconstructed indirectly instead of read from the owning machine
- one core actor creation seam is not serialized
- some TUI workflows have multiple writers instead of one owner
- one TUI machine (`session-machine`) looks ceremonial rather than structural
- one TUI workflow (`auth`) is half machine, half component branching
- one big non-trivial UI workflow (`command-palette`) is still ad hoc local state

## Governing Rules

Use a machine or reducer when:

- the workflow has more than two meaningful modes
- async phases matter
- selection/search/loading/open state coexist
- multiple writers currently mutate the same workflow
- transition validity matters

Do not force a machine when:

- the state is a projection or cache
- the state is scalar or monotonic
- the reducer is already tiny and pure
- the complexity is in rendering, not control flow

## Brain Principles

- `~/.brain/principles/boundary-discipline.md`
- `~/.brain/principles/serialize-shared-state-mutations.md`
- `~/.brain/principles/redesign-from-first-principles.md`
- `~/.brain/principles/subtract-before-you-add.md`
- `~/.brain/principles/encode-lessons-in-structure.md`
- `~/.brain/principles/fix-root-causes.md`
- `~/.brain/principles/prove-it-works.md`
- `~/.brain/principles/experience-first.md`

## Non-Goals

Do not machine-ize these just for consistency theater:

- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/agent-lifecycle.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/session-tree-state.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/mermaid-viewer-state.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/hooks/use-spinner-clock.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/permissions.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/branch-picker.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/hooks/use-file-search.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/hooks.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts`

Those are either projections, tiny reducers, or pure compilation logic.

## Task List

- [x] Batch 1 — Serialize loop ownership and stop exporting fictional runtime state
- [x] Batch 2 — Collapse duplicate core actor orchestration around one real turn pipeline
- [x] Batch 3 — Give the composer one owner
- [x] Batch 4 — De-duplicate and flatten prompt search
- [ ] Batch 5 — Promote command palette to an explicit reducer
- [ ] Batch 6 — Simplify or demote `session-machine`
- [ ] Batch 7 — Finish or demote `auth-machine`
- [ ] Batch 8 — Clean up low-priority state ownership drift and test seams

## Batch 1 — Serialize Loop Ownership And Canonical Runtime State

Commit:

- `fix(runtime): serialize loop ownership and project canonical state`

Why:

- current “one actor per session/branch” guarantee is not actually serialized
- exported runtime/session state is partly fiction and partly reconstructed from event history
- this is a correctness problem, not cleanup

Relevant skills:

- `architecture`
- `effect-v4`
- `code-style`

Relevant principles:

- `serialize-shared-state-mutations`
- `fix-root-causes`
- `boundary-discipline`
- `prove-it-works`

Files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/actor-process.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-queries.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-subscriptions.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx`

Detailed spec:

- make `getLoop` creation atomic
- no double-spawn race for the same `sessionId:branchId`
- introduce one canonical runtime snapshot from the owning loop
- make `ActorProcess.getState` honest
  - either back all fields with real data
  - or narrow the public type
- make `SessionQueries.getSessionState` and watch subscriptions read the canonical projection
- stop reconstructing `isStreaming` and agent solely from event history when the machine already knows

Tests:

- add a concurrency test proving two concurrent `sendUserMessage` calls do not create two loops
- add runtime/query tests proving `getSessionState` matches the live machine snapshot
- run:
  - `bun run gate`
  - targeted integration seam tests that use `watchSessionState`

## Batch 2 — Collapse Duplicate Tool Orchestration At The Actor Boundary

Commit:

- `refactor(runtime): share tool invocation pipeline`

Why:

- the real duplicate orchestration is not `AgentActor`
- the real duplicate orchestration is `LocalActorTransportLive.invokeTool`
- that path manually persists assistant/tool messages, publishes tool events, runs tools, and forks a follow-up turn outside the shared phase helpers
- this is the wrong ownership boundary

Relevant skills:

- `architecture`
- `effect-v4`
- `code-style`

Relevant principles:

- `subtract-before-you-add`
- `redesign-from-first-principles`
- `encode-lessons-in-structure`
- `fix-root-causes`

Files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop-phases.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/actor-process.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts`
- `/Users/cvr/Developer/personal/gent/tests/runtime.test.ts`
- `/Users/cvr/Developer/personal/gent/tests/core-boundary.test.ts`

Detailed spec:

- extract shared helper(s) for:
  - synthetic assistant tool-call persistence
  - tool execution
  - tool result persistence
- make `LocalActorTransportLive.invokeTool` delegate to that shared pipeline
- keep `AgentActor` unless we prove its lifecycle shell adds no value
- if the shared helper exposes missing invariants, fix them once there
  - for example tool-result message publication

Tests:

- add one actor-process test proving `invokeTool` persists assistant + tool messages and schedules one follow-up
- keep the cluster actor boundary test green
- run:
  - `bun run gate`

## Batch 3 — Give The Composer One Owner

Commit:

- `refactor(tui): unify composer interaction state`

Why:

- composer workflow is currently split across:
  - `use-composer-controller`
  - `composer-state`
  - session route/controller suspension and restore flags
- one user workflow, many writers

Relevant skills:

- `opentui`
- `react`
- `architecture`
- `code-style`

Relevant principles:

- `serialize-shared-state-mutations`
- `boundary-discipline`
- `experience-first`
- `encode-lessons-in-structure`

Files:

- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/use-composer-controller.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/composer-state.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-controller.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/composer.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/composer-prompt.tsx`

Detailed spec:

- define one `ComposerInteractionState`
- explicit modes:
  - `editing`
  - `shell`
  - `autocomplete`
  - `prompt`
  - optionally `restoring` / `history`
- move transition legality into one reducer/module
- leave shell execution, IO, and rendering outside the reducer
- remove split ownership of suspend/restore/autocomplete mode

Tests:

- add reducer tests for mode transitions
- extend composer render tests for autocomplete/prompt/suspend transitions
- run:
  - `bun run gate`
  - `bun run --cwd apps/tui test:integration -- integration/session-feed-boundary.test.tsx`

## Batch 4 — De-Duplicate And Flatten Prompt Search

Commit:

- `refactor(tui): share prompt search controller`

Why:

- prompt search is implemented twice
- session path is also unnecessarily nested:
  - parent says prompt-search is open
  - child state also says open/closed

Relevant skills:

- `opentui`
- `react`
- `architecture`
- `code-style`

Relevant principles:

- `subtract-before-you-add`
- `encode-lessons-in-structure`
- `experience-first`
- `boundary-discipline`

Files:

- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/prompt-search-state.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/home-state.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/home.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-ui-state.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-controller.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/prompt-search-palette.tsx`

Detailed spec:

- extract one prompt-search controller/reducer
- shared behavior:
  - query
  - selection
  - preview
  - restore draft
  - close/submit/cancel
- flatten session overlay shape so there is not an outer `prompt-search` plus inner `closed|open`

Tests:

- shared prompt-search reducer tests
- keep render tests for prompt search passing
- fix the currently broken render proof path if still failing
- run:
  - `bun run gate`
  - `bun run test:integration`

## Batch 5 — Promote Command Palette To An Explicit Reducer

Commit:

- `refactor(tui): model command palette transitions explicitly`

Why:

- command palette is the clearest under-modeled non-trivial UI workflow
- it already has async loading, hierarchical navigation, search, selection, and reset semantics

Relevant skills:

- `opentui`
- `react`
- `architecture`
- `code-style`

Relevant principles:

- `boundary-discipline`
- `serialize-shared-state-mutations`
- `experience-first`
- `prove-it-works`

Files:

- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/command-palette.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/command/context.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/router/router.ts`

Detailed spec:

- extract `command-palette-state.ts`
- define events:
  - `Open`
  - `Close`
  - `LoadSessions`
  - `SessionsLoaded`
  - `PushLevel`
  - `PopLevel`
  - `SearchTyped`
  - `SearchBackspaced`
  - `MoveUp`
  - `MoveDown`
  - `ActivateSelection`
- keep RPC fetching as effects outside the reducer
- stop splitting open-state ownership between provider and component unless the provider becomes the sole owner

Tests:

- pure reducer tests for palette stack/search/selection behavior
- render test for keyboard navigation at each level
- run:
  - `bun run gate`

## Batch 6 — Simplify Or Demote `session-machine`

Commit:

- `refactor(tui): simplify session lifecycle state`

Why:

- current machine looks ceremonial
- state is duplicated and rewrapped in `context.tsx`
- some machine states do not correspond to real async boundaries

Relevant skills:

- `architecture`
- `react`
- `code-style`

Relevant principles:

- `subtract-before-you-add`
- `boundary-discipline`
- `fix-root-causes`
- `experience-first`

Files:

- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/session-machine.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx`

Detailed spec:

- choose one of two paths:
  - demote to a plain reducer with only real async states
  - or keep the machine and make it the sole exported session state
- delete dead events like `SwitchRequested` if they remain unused
- ensure `Loading` / `Switching` correspond to real work, not instant ceremony
- stop wrapping machine state into a second near-identical union

Tests:

- session lifecycle reducer/machine tests
- client-context tests for create/switch/clear
- run:
  - `bun run gate`

## Batch 7 — Finish Or Demote `auth-machine`

Commit:

- `refactor(tui): align auth flow machine with real async states`

Why:

- auth is truly stateful enough for a machine
- but the current design stops halfway and leaves the component to do the hard part

Relevant skills:

- `opentui`
- `react`
- `architecture`
- `code-style`

Relevant principles:

- `experience-first`
- `boundary-discipline`
- `prove-it-works`
- `encode-lessons-in-structure`

Files:

- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/auth-machine.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/auth.tsx`

Detailed spec:

- preferred path: keep the machine, but model real async substates
  - `Loading`
  - `Deleting`
  - `SubmittingKey`
  - `OAuthWaiting`
  - `OAuthCodeEntry`
  - `Resolved`
  - `Failed`
- or demote completely if `effect-machine` is not pulling its weight
- remove state-specific branching from the component as much as possible

Tests:

- transition tests for auth states:
  - load success/failure
  - method switch
  - key submit success/failure
  - oauth start
  - manual code entry
  - auto callback
  - cancel/back behavior
- run:
  - `bun run gate`
  - targeted auth integration tests if present

## Batch 8 — Low-Priority State Ownership Drift And Test Seams

Commit:

- `refactor(state): codify workflow ownership rules`

Why:

- remaining issues are smaller but worth tightening after the major seams

Relevant skills:

- `architecture`
- `opentui`
- `effect-v4`
- `code-style`

Relevant principles:

- `encode-lessons-in-structure`
- `boundary-discipline`
- `prove-it-works`

Files:

- `/Users/cvr/Developer/personal/gent/apps/tui/src/hooks/use-skills.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/subagent-runner.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/prompt-search-render.test.tsx`

Detailed spec:

- move shared skills cache ownership under provider or explicit scope
- reduce lifecycle drift in `subagent-runner` by extracting shared phase helpers
- fix the broken prompt-search render proof path
- burn down remaining test sleeps
  - replace receipt-free waits with deferreds, event waits, or explicit acceptance signals
  - especially in runtime concurrency proofs where `sleep(...)` is still doing synchronization work
- document repo rule:
  - workflow state gets one owner
  - projections stay local and dumb

Tests:

- add/repair tests around the changed ownership seams
- run:
  - `bun run gate`
  - `bun run test:integration`

## Receipts

Primary audit receipts used to build this plan:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.state.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop-phases.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.checkpoint.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/actor-process.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-queries.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-subscriptions.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/hooks.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/session-machine.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/agent-lifecycle.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/auth-machine.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/auth.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/home-state.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-ui-state.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-controller.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/composer-state.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/use-composer-controller.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/prompt-search-state.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/session-tree-state.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/mermaid-viewer-state.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/command-palette.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/command/context.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/permissions.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/branch-picker.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/hooks/use-file-search.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/hooks/use-skills.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/subagent-runner.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/home-state.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/session-ui-state.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/session-tree-state.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/mermaid-viewer-state.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/prompt-search-render.test.tsx`
