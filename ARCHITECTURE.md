# Gent Architecture

Minimal agent harness. Effect-first. Small seams. One owner per concern.

## Rules

- Schema-first transport contract.
- Thin transport adapters.
- Command/query services, not god facades.
- Runtime owns orchestration.
- Platform edges stay explicit.
- TUI routes own screen state; components render and dispatch.
- Extension hooks are structural descriptors, not stringly maps.

## Package Map

```text
apps/
├── tui/       # OpenTUI client over the shared transport contract
└── server/    # HTTP + RPC adapter over the same app services

packages/
├── core/
│   ├── domain/    # Schemas, ids, events, service tags, pure domain helpers
│   ├── storage/   # SQLite persistence
│   ├── providers/ # Model/provider/auth adapters
│   ├── runtime/   # actor-process, agent-loop, task/runtime services
│   ├── tools/     # tool definitions + handlers
│   ├── extensions/# builtin extensions
│   ├── server/    # transport contract, handlers, commands, queries, startup wiring
│   └── test-utils/# test layers, recorders, fixtures
└── sdk/           # direct + HTTP transports over one client contract
```

## System Shape

```text
TUI / SDK / HTTP client
          │
          ▼
  transport contract
          │
   ┌──────┴──────┐
   │             │
   ▼             ▼
direct        RPC / HTTP
adapter        adapter
   │             │
   └──────┬──────┘
          ▼
   app services
          │
   ┌──────┴──────┐
   ▼             ▼
commands      queries/events
          │
          ▼
   runtime + boundaries
```

Process topology is secondary, but production topology is not.

Production TUI is a shell over a supervised worker process. Debug-only local hosting lives under `apps/tui/src/debug/*`.

## Transport Boundary

Source of truth:

- `packages/core/src/server/transport-contract.ts`

That module owns:

- client-facing types
- queue/session/message projections
- contract semantics

Adapters:

- `packages/sdk/src/client.ts`
- `packages/core/src/server/rpcs.ts`
- `packages/core/src/server/http-api.ts`

Rule:

- no client-specific DTO remodeling
- no parallel contract surfaces
- handlers and adapters derive from the same contract types

## App Services

The app surface is split by concern:

- `SessionCommands`
- `SessionQueries`
- `SessionEvents`
- `InteractionCommands`

`packages/core/src/server/index.ts` is intentionally small. It only assembles `AppServicesLive`.

`packages/core/src/server/dependencies.ts` owns startup wiring:

- runtime platform
- storage/event store
- auth/config/model registry
- provider stack
- extension loading
- actor/runtime services

It is the composition boundary. Not the domain boundary.

## Runtime

Core orchestration lives in:

- `packages/core/src/runtime/actor-process.ts`
- `packages/core/src/runtime/agent/agent-loop.ts`
- `packages/core/src/runtime/agent/agent-loop.state.ts`
- `packages/core/src/runtime/agent/agent-loop.utils.ts`
- `packages/core/src/runtime/agent/agent-loop-phases.ts`

Shape:

- `ActorProcess` is the single command entry for session/branch actor work.
- `AgentLoop` is a flat machine-owned control plane.
- production actor routing is cluster-backed inside the worker process
- queue ownership is structural
- turn phases are explicit
- machine inspection events are published as diagnostics

Do not rebuild business logic from inspection events. They are receipts, not inputs.

## Platform Boundaries

Core runtime should not reach for ambient process state unless the app shell is the real owner.

Explicit platform/runtime seams:

- `RuntimePlatform`
- tracer/logger services
- file system / path / OS services

App entrypoints bind concrete Bun/OS behavior:

- `apps/tui/src/main.tsx`
- `apps/server/src/main.ts`

Production rule:

- `apps/tui/src/main.tsx` supervises the worker and talks through transport only
- debug-only direct hosting is isolated under `apps/tui/src/debug/*`
- production `main.tsx` must not import app dependency wiring directly

## TUI

TUI is a client over the shared contract, not a parallel app.

Production shape:

- shell process owns renderer, input, reconnect UX
- worker process owns storage, providers, actor runtime, durability
- reconnect logic rehydrates from worker state, not UI guesses

Main boundaries:

- `apps/tui/src/client/context.tsx` for client/session/event state
- `apps/tui/src/routes/session-controller.ts` for session-screen orchestration
- route state machines for modal/session surfaces
- components like `composer.tsx`, `message-list.tsx`, `queue-widget.tsx` as presentation + local interaction

Rules:

- one screen-level owner for session state
- one keyboard owner per route surface
- overlays/composer flows modeled explicitly
- renderer tests cover critical capture/focus paths

## Extensions

Extension shape lives in:

- `packages/core/src/domain/extension.ts`
- `packages/core/src/runtime/extensions/hooks.ts`
- `packages/core/src/runtime/extensions/registry.ts`

Rules:

- hooks are typed descriptors
- registration shape is structural
- dispatch compiles once, then runs from typed hook maps
- extension hook boundaries are where plugin typing must stay strict

## Testing

Use the smallest honest boundary:

- pure helpers: unit tests
- transport/app services: Effect tests
- TUI render/capture: OpenTUI renderer tests
- runtime ordering/turn semantics: recording layers + runtime tests

Important files:

- `packages/core/src/test-utils/index.ts`
- `tests/runtime.test.ts`
- `apps/tui/tests/render-harness.tsx`

## Non-Goals

- No cluster/distribution roadmap in this document.
- No compatibility notes for deleted facades.
- No process-purity dogma. Same-process direct transport is fine.

This doc describes the architecture we want to keep, not the migration history we already paid for.
