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
│   ├── storage/   # SQLite persistence (focused services: Storage, CheckpointStorage, InteractionStorage, SearchStorage)
│   ├── providers/ # AI SDK adapter (Provider inlines model resolution + auth)
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

Shape:

- `ActorProcess` is the single command entry for session/branch actor work.
- `AgentLoop` is a flat machine-owned control plane (turn phases inlined, state uses union-level derive).
- `AgentRunner` is the helper-agent boundary. Durable runs create persisted child sessions; ephemeral runs use isolated in-memory storage and only publish parent-side `AgentRun*` receipts.
- production actor routing is cluster-backed inside the worker process
- queue ownership is structural
- turn phases are explicit (resolve → stream → execute-tools → finalize)
- interactions are cold machine states, not blocked fibers
- machine inspection events are published as diagnostics
- `AgentRunnerConfig` is a plain interface passed to `InProcessRunner`/`SubprocessRunner`, not a service

Do not rebuild business logic from inspection events. They are receipts, not inputs.

### Agent Runs

- Default persistence is durable.
- Read-only helper agents (`explore`, `finder`, `librarian`, `reviewer`, `auditor`, `summarizer`, `title`) default to ephemeral.
- Durable runs persist a child session/branch and can be revisited with `read_session`.
- Ephemeral runs still execute a full local `AgentLoop`, but against isolated in-memory storage; they return text/usage/tool-call metadata without polluting the session tree.
- Callers that need durable history must opt in explicitly, e.g. task execution forces `persistence: "durable"`.

### Interactions (Cold Pattern)

Tools that need human input (prompt, handoff, ask-user) use a cold interaction pattern instead of blocking fibers:

```text
tool calls handler.present()
  → InteractionPendingError thrown
    → ToolRunner re-raises it
      → executeToolsPhase propagates it
        → machine emits InteractionRequested
          → ExecutingTools → WaitingForInteraction (cold, no task fiber)

client responds via RPC
  → InteractionCommands stores resolution in-memory
    → machine receives InteractionResponded
      → WaitingForInteraction → ExecutingTools
        → tool re-runs, calls present(), finds stored resolution
          → continues normally
```

Key properties:

- **No Deferred, no blocked fiber.** `WaitingForInteraction` is a cold state — no `.task()`, no background work. The machine is checkpointed and survives restarts.
- **Crash-safe respond ordering.** `storeResolution` (in-memory) → `respondInteraction` (wake machine) → `handler.respond` (resolve in storage). If process dies before wake, request stays pending; `listPending()` re-publishes on recovery.
- **Tool re-execution on resume.** The full `executeToolsPhase` re-runs. Pre-interaction side effects re-execute (idempotent by convention). No continuation payloads.
- **Permissions are not interactive.** Default-allow with explicit deny rules. `Permission.check` is a synchronous policy check, never blocks.

Files: `interaction-request.ts` (InteractionPendingError, makeInteractionService), `interaction-handlers.ts` (PromptHandler, HandoffHandler), `agent-loop.state.ts` (WaitingForInteraction), `interaction-commands.ts` (respond orchestration).

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

- `packages/core/src/domain/extension.ts` — server contract (`GentExtension`, `ExtensionSetup`)
- `packages/core/src/domain/extension-client.ts` — TUI contract (`ExtensionClientModule`, `ExtensionClientContext`)
- `packages/core/src/runtime/extensions/hooks.ts` — interceptor compilation
- `packages/core/src/runtime/extensions/registry.ts` — server registry
- `apps/tui/src/extensions/` — TUI discovery, loading, resolution

Rules:

- hooks are typed descriptors
- registration shape is structural — builtins, user, and project extensions share the same pipeline
- dispatch compiles once, then runs from typed hook maps
- extension hook boundaries are where plugin typing must stay strict
- `uiModelSchema` is enforced at runtime — invalid models are dropped, not passed through
- `onStartup` hooks run during dependency initialization (no service requirements)
- `onInit` receives `sessionCwd` from the framework — extensions should not reach into `Storage`

For the full authoring guide, see [docs/extensions.md](docs/extensions.md). Example extensions in [examples/extensions/](examples/extensions/).

### Server Extensions

- `extension()` is the unified authoring API — all builtins and external extensions use it
- Simple path: `ext.tool()`, `ext.on()`, `ext.state()` — no Effect knowledge needed
- Full-power path: `ext.actor()`, `ext.interceptor()`, `ext.layer()`, `ext.provider()` — Effect-aware
- `defineExtension()` deleted — `extension()` is the only way to create extensions
- `ExtensionSetup.layer` — extensions provide services via `Layer.Any`
- `ext.layer(layer)` — layers merge into the main extension graph; services that need `SubagentRunnerService` resolve it lazily at call time
- `ExtensionSetup.onStartup` — one-time startup effect (e.g., cron registration)
- Agent override is turn-scoped via `QueuedTurnItem.agentOverride`, not persistent `SwitchAgent`
- `createSession` accepts optional `initialPrompt` + `agentOverride` for atomic create-and-send

### Extension Event Bus

`ExtensionEventBus` — channel-based pub/sub for extension communication (`runtime/extensions/event-bus.ts`).

- Agent events auto-published as `"agent:<EventTag>"` with sessionId/branchId after reduction
- `ext.bus.on("agent:*", handler)` — wildcard subscription, replaces deprecated `ext.observe()`
- `ext.bus.on("extensionId:channel", handler)` — targeted side-effect handlers with full service access
- Handlers can return `void`, `Promise<void>`, or `Effect<void>` — Effect handlers run in the full service context
- `sendIntent` RPC also emits to bus as `"extensionId:intentTag"` — enables side-effect handling outside pure actor reducers
- Example: `@gent/task-tools` uses `ext.bus.on("@gent/task-tools:StopTask", handler)` to call `TaskService.stop()` from a bus handler

### Task Service Ownership

`TaskService.Live` is owned by the `@gent/task-tools` extension, not core:

- Provided via `ext.layer(TaskService.Live)` — task runs resolve `SubagentRunnerService` lazily when needed
- `task.list` RPC removed — TUI reads from extension actor snapshot (actor reduces task events into UI model)
- `task.stop` removed from RPC — routed via `sendIntent` → event bus → `ext.bus.on()` handler
- `task.output` RPC stays as thin lazy query (message summaries too heavy for snapshots)
- Core `dependencies.ts` no longer imports or wires `TaskService` — it comes through the extension layer graph

### TUI Extensions

- Builtins are individual `.client.ts` files in `apps/tui/src/extensions/builtins/`
- Each follows `ExtensionClientModule` contract — same pipeline as user/project extensions
- Loader accepts `disabled` list to filter extensions by id before `setup()` is called
- `ExtensionClientContext` provides `sessionId`, `branchId`, `openOverlay`, `closeOverlay`
- `useExtensionUI()` exposes reactive `sessionId()`, `branchId()`, `snapshots()` for widgets
- Widgets are zero-prop components that self-source from context hooks

### Extension State Runtime Lifecycle

Extension actors (state machines) are managed by `ExtensionStateRuntime`. Key patterns:

**Lazy init with Deferred readiness** (`state-runtime.ts`):

- `getOrSpawnActors(sessionId)` registers a Deferred placeholder under `spawnSemaphore`, then spawns + inits actors OUTSIDE the lock. Concurrent callers await the Deferred.
- This prevents deadlocks where extension actor spawn triggers events that re-enter `getOrSpawnActors`.

**Synchronous reduce in publish path** (`dependencies.ts`):

- `ReducingEventStore.publish` persists the event, then synchronously calls `stateRuntime.reduce`. Extension `afterTransition` effects (QueueFollowUp, Interject) run during this reduce, which schedules follow-up turns on the agent loop.
- This MUST be synchronous — extension side effects participate in the turn lifecycle. Async reduction would cause the loop to reach idle before follow-ups are queued.
- Re-entrance guard: a process-wide `Ref<number>` tracks reduce depth. Nested publishes during reduce (e.g., from inspector `MachineInspected` events) skip reduce.

**effect-machine integration**:

- `Machine.spawn` is cold — no I/O, no inspector, no supervisor before `actor.start`. Recovery (state loading) and supervisor arming happen during `start`.
- `from-machine.ts` extensions use `Machine.spawn` + `ref.start` with their own persistence hydration separate from effect-machine's `Lifecycle` API.
- `AgentLoop` uses effect-machine's `Lifecycle` API: `recovery.resolve` loads checkpoints + runs `makeRecoveryDecision`, `durability.save` persists checkpoints after transitions.

## Testing

Use the smallest honest boundary:

- pure helpers: unit tests
- transport/app services: Effect tests
- TUI render/capture: OpenTUI renderer tests
- runtime ordering/turn semantics: recording layers + runtime tests

### Commands

| Command                    | Scope                                        | Target   |
| -------------------------- | -------------------------------------------- | -------- |
| `bun run test`             | core + tui + sdk unit/integration            | ~2s      |
| `bun run test:integration` | tui integration + e2e direct-transport       | ~2s      |
| `bun run test:e2e`         | PTY e2e + supervisor + worker-http transport | ~60-120s |
| `bun run gate`             | typecheck + lint + fmt + build + test        | ~15s     |

### Test structure

`packages/core/tests/` mirrors `packages/core/src/`:

```text
tests/
├── domain/        # auth-store, auth-guard, agent, event, message, skills, ...
├── extensions/    # api, registry, compile-tool-policy, hooks, loader, memory/, ...
├── providers/     # provider, provider-auth, provider-resolution, anthropic-keychain
├── runtime/       # agent-loop, actor-process, retry, agent-runner, tool-runner, ...
├── server/        # rpcs, session-queries, system-prompt
├── storage/       # sqlite-storage, search-storage, task-storage, bypass
├── tools/         # read, edit, bash, finder, code-review, counsel, delegate, ...
├── debug/         # sequence-provider
└── test-utils/    # sequence
```

One test file per source file. No god tests. Names match source owners.

`packages/e2e/tests/` separates integration from e2e:

- `test:integration` — direct-transport contract tests (in-process, no subprocess)
- `test:e2e` — PTY TUI tests, supervisor lifecycle, worker-http transport

### Important files

- `packages/core/src/test-utils/index.ts` — `SequenceRecorder`, recording layers
- `packages/core/src/test-utils/in-process-layer.ts` — `baseLocalLayer`
- `packages/core/src/test-utils/e2e-layer.ts` — `createE2ELayer`
- `packages/core/src/debug/provider.ts` — `DebugProvider`, `createSignalProvider`, `createSequenceProvider`
- `apps/tui/tests/render-harness.tsx` — TUI render test harness
- `packages/e2e/tests/transport-harness.ts` — shared worker + transport cases

## Auto Loop Extension

`@gent/auto` — iterative workflow driver via effect-machine.

State: `Inactive | Working | AwaitingCounsel`. Signal tool: `auto_checkpoint`. Gate: counsel review between iterations. Safety: `maxIterations` ceiling + `turnsSinceCheckpoint` wedge detection.

### JSONL Persistence

`AutoJournal` writes append-only `.gent/auto/<goal-slug>.jsonl` relative to cwd. `active.json` pointer tracks which journal to resume. Row types: `config`, `checkpoint`, `counsel`.

Cross-session replay via `onInit`: child sessions verify ancestry includes `active.sessionId`. Fail-closed for legacy pointers without `sessionId`. Root sessions never replay.

### Handoff Ownership

`@gent/auto` and `@gent/handoff` are cleanly separated:

- Auto detects context fill → queues follow-up telling model to call `handoff` tool
- Handoff extension owns presentation, cooldown, and user interaction
- Handoff extension skips when auto is active (guard on auto actor snapshot)

### Task Service

`TaskService` is owned by the `@gent/task-tools` extension (not core). It correlates child sessions via synthetic `toolCallId` (`task:<taskId>`). The `SubagentSpawned` event filter matches on `toolCallId`, preventing concurrent tasks from stealing each other's child session.

`task.output` RPC returns `MessageSummary[]` (role + 200-char excerpt) alongside `messageCount`.

### Test Utilities

- `withTinyContextWindow(effect)` — patches `MODEL_CONTEXT_WINDOWS` to 5k tokens for threshold tests
- `trackingHandoffHandler()` — returns `{ layer, presentCalled: Ref<boolean> }` for handoff assertions

Both exported from `@gent/core/test-utils/e2e-layer`.

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

## Observability

Wide event boundaries (one structured log per unit of work) via `effect-wide-event`:

| Boundary        | Service       | File                                            |
| --------------- | ------------- | ----------------------------------------------- |
| Agent turn      | `agent-loop`  | `runtime/agent/agent-loop.ts` (TurnMetrics ref) |
| Tool call       | `tool-runner` | `runtime/agent/tool-runner.ts`                  |
| Provider stream | `provider`    | `runtime/agent/agent-loop.ts`                   |
| RPC request     | `rpc`         | `server/rpc-handlers.ts`                        |
| Agent run       | `agent-run`   | `runtime/agent/agent-runner.ts`                 |

Logging conventions:

- Structured annotations: `Effect.logInfo("noun.verb").pipe(Effect.annotateLogs({ key: value }))`
- Never `Effect.logWarning("msg", error)` — always `.pipe(Effect.annotateLogs({ error: String(e) }))`
- Tool-level errors captured via `WideEvent.set({ toolError: "..." })` (value-level, not effect failures)

Log destinations:

- `/tmp/gent.log` — server-side JSON (via `GentLogger`)
- `/tmp/gent-client.log` — TUI-side JSON (via `clientLog`)
- `/tmp/gent-trace.log` — span traces (via `GentTracerLive`)

Request-ID correlation: TUI generates `crypto.randomUUID()` at `sendMessage`/`createSession`, passes via `requestId` field in transport contract. Server threads into log annotations and RPC wide event boundaries.

## Non-Goals

- No cluster/distribution roadmap in this document.
- No compatibility notes for deleted facades.
- No process-purity dogma. Same-process direct transport is fine.

This doc describes the architecture we want to keep, not the migration history we already paid for.
