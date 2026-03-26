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

Production TUI is a shell over a supervised worker process. Debug mode uses the same worker transport seam with ephemeral storage and scripted providers.

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
- debug mode stays on the worker path; only the worker dependencies change
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

## Memory Extension

Builtin extension (`@gent/memory`). Persistent memory across sessions via flat `.md` files.

### Vault

```text
~/.gent/memory/
├── index.md                          # Root index
├── global/
│   ├── index.md
│   └── <topic>.md
└── project/
    └── <project-name>-<sha256_6>/
        ├── index.md
        └── <topic>.md
```

Session-local memories are volatile (actor state only). Promotion to disk is explicit via tools.

Project key: `<basename>-<sha256_6>` of canonical repo root — collision-safe across same-named repos.

### Tools

- `memory_remember` — write to vault (project/global) or session state
- `memory_recall` — search/list memories, full content for search, index for no-query
- `memory_forget` — remove from vault or session state

### Prompt Injection

Compact summary injected as system prompt section. Capped at 8 entries (session + project + global). `memory_recall` tool available for deep dives beyond the cap.

### Dreaming

Extension-defined system agents run in headless mode for memory consolidation:

- `memory:reflect` — review recent sessions, extract project-level memories (weekday evenings)
- `memory:meditate` — consolidate vault, merge duplicates, promote patterns to global (weekly)

Architecture:

```text
Bun.cron (launchd plist on macOS)
  → dream-worker.ts
    → bun run --cwd apps/tui dev -H -a memory:reflect "..."
    → gent headless session with system agent
    → agent uses memory_remember/recall/forget tools
```

Dream worker is a thin scheduler. Intelligence lives in agent definitions and gent's runtime.

Cron jobs are registered via the extension's `onStartup` hook (idempotent — same title overwrites the launchd plist). The framework runs all `onStartup` hooks during dependency initialization.

Key files:

| File                                                  | Purpose                       |
| ----------------------------------------------------- | ----------------------------- |
| `packages/core/src/extensions/memory/vault.ts`        | Vault I/O service             |
| `packages/core/src/extensions/memory/state.ts`        | Extension state + helpers     |
| `packages/core/src/extensions/memory/tools.ts`        | Agent tools                   |
| `packages/core/src/extensions/memory/agents.ts`       | reflect + meditate agent defs |
| `packages/core/src/extensions/memory/dreaming.ts`     | Bun.cron registration         |
| `packages/core/src/extensions/memory/dream-worker.ts` | Cron entry point              |
| `packages/core/src/extensions/memory/projection.ts`   | Prompt section + UI model     |
| `packages/core/src/extensions/memory/index.ts`        | Extension registration        |

## Non-Goals

- No cluster/distribution roadmap in this document.
- No compatibility notes for deleted facades.
- No process-purity dogma. Same-process direct transport is fine.

This doc describes the architecture we want to keep, not the migration history we already paid for.
