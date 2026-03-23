# Codebase Improvement Plan

Status: complete.

All 11 batches in this plan have been implemented. `ARCHITECTURE.md` is the source of truth for the resulting end state. This file is now a historical receipt for why the cuts were made.

## Audit Synthesis

### Effect v4

- Strong: `ServiceMap.Service`, schemas, typed ids, machine/actor work.
- Weak: boundary discipline, startup/layer composition, ambient Bun/Node access, and runtime escape hatches like nested `Effect.runSync` / `Effect.runPromise`.
- Biggest Effect win is simplification, not “more Effect”.

### Architecture

- Core runtime/eventing is directionally disciplined.
- The real boundary issue is not in-process vs out-of-process. It is that the transport contract is not singular enough yet.
- Transport DTOs are triplicated across `core`, RPC, and SDK.
- `GentCore` and `createDependencies` are still god-shaped.

### OpenTUI

- Good primitives and state-machine direction in several places.
- Biggest TUI smells:
  - keyboard ownership split across multiple input systems
  - `Session` route still acts like a god-controller
  - tests are logic-heavy, renderer-light
  - debug boot is too app-owned
  - one render-path process global leak remains

### Simplification

- Repeated pattern: too many owners for one piece of state.
- Repeated pattern: structure is declared in docs/principles, but not encoded strongly enough in code.
- Repeated pattern: transport and orchestration seams are duplicated by hand.

## Non-Goals

- No feature cuts.
- No speculative platform rewrite.
- No nested machine explosion.
- No cluster/distribution work.

## Commit Batches

### Batch 1 — Make the Transport Boundary Explicit

Justification:

- Highest architectural inconsistency in the repo.
- Every other batch gets easier once this is explicit.
- First-principles answer is not “pick a process.” It is “pick one contract.”

Decision:

- Keep in-process RPC if we want it.
- But make it an adapter over the same authoritative transport contract the remote client uses.
- One contract surface. Multiple transports:
  - direct / in-process
  - remote / HTTP
- The architectural rule becomes:
  - clients talk to the app through transport contracts
  - transport implementation may be in-process or out-of-process
  - DTOs and semantics are shared either way

Task list:

- write the boundary rule into `ARCHITECTURE.md`
- define the single contract entrypoint and ban transport-local DTO remodeling
- make direct/in-process and HTTP clients implement the same contract shape
- delete client-specific contract glue that only exists because the boundary is fuzzy
- run gate before moving to Batch 2

Relevant skills:

- `architecture`
- `effect-v4`
- `bun`

Primary files:

- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/main.tsx`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpcs.ts`

### Batch 2 — Unify Transport Contracts

Justification:

- Current DTO duplication across `core`, RPC, and SDK is a drift factory.
- Schema is supposed to be source of truth; it is not here.
- Boundary discipline says schemas/codecs live at the edge once, not redefined per layer.

Target:

- Define transport DTO schemas/codecs once.
- Derive server handler types and SDK client types from them.
- Stop hand-maintaining parallel shapes for sessions, branches, session trees, session state, steer commands, and message projections.
- Keep direct/in-process transport as a transport adapter, not a second contract surface.

Task list:

- inventory duplicated transport DTOs across `core`, RPC, and SDK
- choose one schema/codecs module as the source of truth
- derive handler and client input/output types from that source
- delete parallel DTO/type aliases after migration
- update docs/examples to point at the singular contract surface

Relevant skills:

- `architecture`
- `effect-v4`

Primary files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/server/core.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpcs.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts`

### Batch 3 — Split the Startup/Layer Graph

Justification:

- `createDependencies` is doing too much real work during layer assembly.
- Startup semantics are opaque, over-composed, and harder to test than they need to be.
- Subtract before adding: remove the blob before inventing more helper layers.

Target:

- Separate:
  - platform/home/cwd resolution
  - storage/event-store/auth wiring
  - extension/skills discovery
  - provider stack
  - runtime/interaction handlers
- Reduce `Layer.merge/provide` soup into a few explicit composites.

Task list:

- map current startup responsibilities by concern
- extract stable composite layers with one responsibility each
- move effectful discovery/config work to explicit startup boundaries
- delete now-redundant merge/provide indirection
- verify both server and TUI boot through the same cleaned startup seams

Relevant skills:

- `effect-v4`
- `architecture`

Primary files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/server/index.ts`
- `/Users/cvr/Developer/personal/gent/apps/server/src/main.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/main.tsx`

### Batch 4 — Encode Runtime Platform Boundaries

Justification:

- Core still reaches for ambient Bun/Node/OS state in too many places.
- That weakens portability, testability, and boundary discipline.
- Ambient runtime access is boundary leakage, not convenience.

Target:

- Introduce a thin runtime platform service for:
  - cwd/home/platform
  - stdout/stderr sinks
  - trace/log file writes
- Eliminate direct `process`, `os`, and naked `Bun.write` access from core runtime code where practical.

Task list:

- inventory core runtime touches of `process`, `os`, `Bun`, and direct file sinks
- define the minimum platform service surface needed by core
- migrate callers to that service
- delete leftover ambient runtime reads from core
- keep app entrypoints as the only place allowed to bind concrete platform behavior

Relevant skills:

- `effect-v4`
- `architecture`

Primary files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/server/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/config-service.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/tracer.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/logger.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/tools/repo-explorer.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/tools/librarian.ts`

### Batch 5 — Collapse TUI Session Ownership

Justification:

- The TUI still has too many orchestration owners for one session.
- This is the root cause behind several UI synchronization and keyboard bugs.
- Serialize shared UI state mutations structurally: one owner, not conventions.

Target:

- Build one session controller surface that owns:
  - feed projection
  - queue sync
  - agent status
  - overlay/input mode
- Keep `Session` mostly presentation + scoped command dispatch.

Task list:

- inventory all current session-state owners and what each mutates
- choose one authoritative session controller surface
- move feed/queue/status/overlay state under that controller
- delete duplicated route/local/session-machine coordination
- keep render components dumb where possible

Relevant skills:

- `opentui`
- `architecture`
- `react`

Primary files:

- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/session-machine.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/hooks/use-session-feed.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-ui-state.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/input-state.ts`

### Batch 6 — Unify Keyboard Ownership

Justification:

- Keyboard handling is still split across route handlers, stack/capture routing, and textarea-local suppression.
- This is a known bug farm.
- Shared input state without exclusive ownership is serialized-state failure in miniature.

Target:

- One route-local keyboard command surface per screen.
- Overlays/composer/palette/question flows become explicit submodes, not overlapping listeners.

Task list:

- inventory every active keyboard subscription per screen
- choose one owner for screen-level command dispatch
- model overlays/composer/palette as submodes under that owner
- delete overlapping listeners and suppression hacks
- add regression tests for enter/escape/focus capture

Relevant skills:

- `opentui`
- `react`

Primary files:

- `/Users/cvr/Developer/personal/gent/apps/tui/src/keyboard/context.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/input.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/prompt-search-palette.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/home.tsx`

### Batch 7 — Add Real OpenTUI Renderer Tests

Justification:

- Current TUI tests prove logic, not renderer behavior.
- That leaves focus, layout, scroll, and keyboard-capture regressions to manual discovery.
- OpenTUI already ships the renderer tooling we need. Not using it is self-inflicted blindness.

Target:

- Add renderer-backed tests for:
  - message list
  - composer/input
  - prompt search
  - task/queue widgets
  - keyboard capture and overlay focus
- Use the actual OpenTUI testing surface:
  - `@opentui/core/testing#createTestRenderer`
  - `@opentui/solid#testRender`
- Mirror OpenTUI's own testing style:
  - renderer input and capture tests at core level
  - Solid snapshot/layout tests for textarea-like surfaces

Task list:

- add one reusable renderer test harness for gent TUI
- cover focus/capture/layout cases that logic tests miss today
- migrate the highest-risk session/composer/prompt-search tests first
- add widget rendering assertions for queue/task/message surfaces
- delete redundant low-signal tests once renderer coverage makes them obsolete

Relevant skills:

- `opentui`
- `test`

Primary files:

- `/Users/cvr/Developer/personal/gent/apps/tui/tests/session-render.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/input-textarea.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/message-list.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/input.tsx`
- `/Users/cvr/.cache/repo/anomalyco/opentui/packages/core/src/testing.ts`
- `/Users/cvr/.cache/repo/anomalyco/opentui/packages/core/src/tests/renderer.input.test.ts`
- `/Users/cvr/.cache/repo/anomalyco/opentui/packages/solid/index.ts`
- `/Users/cvr/.cache/repo/anomalyco/opentui/packages/solid/tests/textarea.test.tsx`

### Batch 8 — Shrink Debug/App Boot Surfaces

Justification:

- Debug mode is useful, but too much of it lives in the app shell instead of a reusable scenario layer.
- First-principles answer is not “move some helpers.” It is “make app boot thin and scenario assembly explicit.”

Target:

- Delete app-owned debug orchestration that does not belong in the shell.
- Make debug scenario assembly a core-side service or scenario module.
- Keep TUI boot to “request debug session + navigate”.
- Remove render-path dependence on `process.stdout` for component sizing.

Task list:

- separate debug scenario assembly from app boot
- move reusable debug wiring into core-side modules
- reduce TUI boot to composition plus navigation
- remove stdout-based render sizing leaks from components
- delete debug-only shell glue left behind

Relevant skills:

- `opentui`
- `architecture`

Primary files:

- `/Users/cvr/Developer/personal/gent/apps/tui/src/main.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/debug/bootstrap.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/message-list.tsx`

### Batch 9 — Decompose GentCore Into Command/Query Seams

Justification:

- `GentCore` is still absorbing too many responsibilities.
- Thin RPC handlers are good, but not if the service behind them is the whole app.
- “Decompose” is not enough; the god service has to stop existing as the architectural center.

Target:

- Replace `GentCore` as the main façade with explicit command and query services.
- Keep handlers thin without routing everything through one god surface.
- Delete compatibility methods that only preserve the old façade shape.

Task list:

- inventory `GentCore` methods by command/query/projection concern
- design the minimal service seams needed by handlers and clients
- migrate handlers to the new command/query services
- delete `GentCore` façade methods as their callers disappear
- update docs to reflect the new application service layout

Relevant skills:

- `architecture`
- `effect-v4`

Primary files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/server/core.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts`

### Batch 10 — Re-encode Extension Hook Structure

Justification:

- Current hook composition still relies on string keys and `any` at the most important plugin seam.
- Boundary discipline says plugin shape should be validated once at registration, not interpreted ad hoc later.

Target:

- Move from stringly interceptor/observer classification to typed hook descriptors or explicit hook registries.
- Encode hook kind in structure, not conventions.

Task list:

- inventory current hook kinds and registration paths
- define typed hook descriptors or explicit registries
- validate hook shape at registration time
- migrate runtime dispatch to the typed structure
- delete stringly classification helpers and `any` escape hatches

Relevant skills:

- `architecture`
- `effect-v4`

Primary files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/hooks.ts`

### Batch 11 — Redesign the End-State Architecture

Justification:

- Final batch should not be a compatibility-minded cleanup pass.
- Brain says:
  - redesign from first principles
  - subtract before you add
  - tighten boundaries
- So this batch is the end-state pass: if we were building gent today with everything we now know, what would we actually keep?

Target:

- No backward-compat wrappers.
- No transitional duplicate seams.
- Choose the simplest target architecture and cut to it.
- Likely end state:
  - one schema-first transport contract package or module
  - thin transport adapters for in-process and HTTP clients
  - command/query seams instead of `GentCore` as the whole app
  - one TUI session controller per screen, presentation below it
  - core runtime owning orchestration, platform/runtime edges pushed to explicit services
  - extension hooks encoded structurally, not stringly
- Delete transitional glue introduced by earlier batches once the target shape is clear.

Task list:

- redraw the final package/service map with no compatibility assumptions
- identify transitional modules introduced in earlier batches
- delete the ones that no longer earn their keep
- rewrite `ARCHITECTURE.md` to describe the actual end state, not the migration history
- run full gate and a final audit pass against the brain principles

Relevant skills:

- `effect-v4`
- `architecture`
- `opentui`

Primary files:

- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/core.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpcs.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session.tsx`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.state.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.utils.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop-phases.ts`

## Recommended Order

1. Batch 1 — Make the Transport Boundary Explicit
2. Batch 2 — Unify Transport Contracts
3. Batch 3 — Split the Startup/Layer Graph
4. Batch 4 — Encode Runtime Platform Boundaries
5. Batch 5 — Collapse TUI Session Ownership
6. Batch 6 — Unify Keyboard Ownership
7. Batch 7 — Add Real OpenTUI Renderer Tests
8. Batch 8 — Shrink Debug/App Boot Surfaces
9. Batch 9 — Decompose GentCore Into Command/Query Seams
10. Batch 10 — Re-encode Extension Hook Structure
11. Batch 11 — Redesign the End-State Architecture

## Source Receipts

### Brain Principles

- `/Users/cvr/.brain/principles/redesign-from-first-principles.md`
- `/Users/cvr/.brain/principles/serialize-shared-state-mutations.md`
- `/Users/cvr/.brain/principles/boundary-discipline.md`
- `/Users/cvr/.brain/principles/subtract-before-you-add.md`
- `/Users/cvr/.brain/principles/encode-lessons-in-structure.md`
- `/Users/cvr/.brain/principles/fix-root-causes.md`

### Skills

- `/Users/cvr/Developer/personal/dotfiles/skills/effect-v4/SKILL.md`
- `/Users/cvr/Developer/personal/dotfiles/skills/architecture/SKILL.md`
- `/Users/cvr/Developer/personal/dotfiles/skills/opentui/SKILL.md`
- `/Users/cvr/Developer/personal/dotfiles/skills/opentui/references/solid/REFERENCE.md`
- `/Users/cvr/Developer/personal/dotfiles/skills/opentui/references/keyboard/REFERENCE.md`
- `/Users/cvr/Developer/personal/dotfiles/skills/opentui/references/testing/REFERENCE.md`

### Codebase

- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`
- `/Users/cvr/Developer/personal/gent/apps/server/src/main.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/AGENTS.md`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/main.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/debug/bootstrap.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/session-machine.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/hooks/use-session-feed.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/hooks/use-machine.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/keyboard/context.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/home.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-ui-state.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/input.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/input-state.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/prompt-search-state.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/prompt-search-palette.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/message-list.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/queue-widget.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/task-widget.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/inline-chrome.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/tool-frame.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/session-render.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/input-textarea.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/core.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpcs.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/event-store.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/event.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/providers/provider-factory.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/actor-process.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/config-service.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/task-service.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/tracer.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/logger.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/hooks.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.state.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.utils.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop-phases.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/tools/repo-explorer.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/tools/librarian.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts`

### External Receipts

- `/Users/cvr/.cache/repo/anomalyco/opentui/packages/core/src/testing.ts`
- `/Users/cvr/.cache/repo/anomalyco/opentui/packages/core/src/tests/renderer.input.test.ts`
- `/Users/cvr/.cache/repo/anomalyco/opentui/packages/solid/index.ts`
- `/Users/cvr/.cache/repo/anomalyco/opentui/packages/solid/tests/textarea.test.tsx`
