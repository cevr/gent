# Gent Architecture

Minimal agent harness. Effect-first. Small seams. One owner per concern.

## Core Model

`gent` is organized around six nouns:

- `Server` — process-wide services only: storage, auth stores, platform, transport wiring, connection tracking.
- `Profile` — cwd-scoped policy and extension graph: permissions, drivers, projections, resources, capabilities.
- `SessionRuntime` — the single public session engine: inbox, queue, checkpoint, watch state, turn orchestration.
- `Capability` — the only callable primitive.
- `Resource` — long-lived services, schedules, subscriptions, lifecycle. Stateful actors live in the `actors:` bucket as Behaviors.
- `Projection` — pure derived views for prompt, policy, runtime, and client state.

Everything else is adapter code around those nouns.

## Rules

- Schema-first transport contract.
- Thin transport adapters.
- Command/query services, not god facades.
- Runtime owns orchestration.
- Platform edges stay explicit.
- TUI routes own screen state; components render and dispatch.
- Extension seams are explicit structural descriptors, not generic middleware buckets.
- App-specific UI extension facets live at the app edge, not in core.
- RPC is the application transport. No parallel REST surface.

## Package Map

```text
apps/
├── tui/       # OpenTUI client over the shared transport contract
└── server/    # HTTP + RPC adapter over the same app services

packages/
├── core/
│   ├── domain/    # Schemas, ids, events, service tags, pure domain helpers
│   ├── storage/   # SQLite persistence (Storage + 6 sub-Tags: SessionStorage, BranchStorage, MessageStorage, EventStorage, RelationshipStorage, ExtensionStateStorage)
│   ├── providers/ # AI SDK adapter (Provider inlines model resolution + auth)
│   ├── runtime/   # SessionRuntime, agent-loop internals, profile/runtime services
│   ├── extensions/# api.ts only — public authoring surface for extensions
│   ├── server/    # transport contract, handlers, commands, queries, startup wiring
│   └── test-utils/# test layers, recorders, fixtures
├── extensions/    # all 27 builtin extensions (imports only @gent/core/extensions/api)
└── sdk/           # direct + RPC transports over one client contract
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

Process topology is secondary. Default CLI topology is not.

Default `gent` resolves a shared server via `Gent.server({ cwd, state: Gent.state.sqlite() })` — one server per DB, multiple clients. Topology derives from configuration: `Gent.state.memory()` for in-process owned, `Gent.state.sqlite()` for registry-aware shared, `Gent.client({ url })` for remote.

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
- `packages/core/src/server/server-routes.ts`

Rule:

- no client-specific DTO remodeling
- no parallel application contract surfaces
- handlers and adapters derive from the same contract types

## App Services

The app surface is split by concern:

- `SessionCommands`
- `SessionQueries`
- `InteractionCommands`

`SessionEvents` and `SessionSubscriptions` are inlined into `rpc-handlers.ts` — they are not separate services.

`packages/core/src/server/index.ts` is intentionally small. It only assembles `AppServicesLive`.

`packages/core/src/server/dependencies.ts` owns startup wiring:

- runtime platform
- storage/event store
- auth/config/model registry
- provider stack
- extension loading (delegated to `RuntimeProfileResolver`)
- actor/runtime services

It is the composition boundary. Not the domain boundary.

### RuntimeProfileResolver

`packages/core/src/runtime/profile.ts` is the single discover → setup → reconcile → sections pipeline. Two paths used to do this independently (and drift, e.g. dropping pub/sub subscriptions on the per-cwd path); now both go through the resolver paired with `buildExtensionLayers`:

- **Server startup** (`server/dependencies.ts`) — resolves once at boot, builds the registry/state/event-bus layer via `buildExtensionLayers`, publishes the profile as a tag so `agentRuntimeLive` reuses the same prompt sections instead of recomputing.
- **Per-cwd profile cache** (`runtime/session-profile.ts`) — resolves lazily per unique cwd, builds the same layer shape via `buildExtensionLayers` inside the captured server scope.

Ephemeral child runs (`runtime/agent/agent-runner.ts`) intentionally do NOT call the resolver — they forward an already-resolved `ExtensionRegistry` from the parent and only rebuild the per-run mutable bits (storage, pub/sub engine, state runtime) for isolation. That divergence is structural, not duplication.

`compileBaseSections(profile)` resolves dynamic prompt sections inside the extension-services runtime so contributions like `Skills`'s prompt section can read services from their own `setup.layer`.

## Runtime

Core orchestration lives in:

- `packages/core/src/runtime/session-runtime.ts`
- `packages/core/src/runtime/agent/agent-loop.ts`
- `packages/core/src/runtime/agent/agent-loop.state.ts`
- `packages/core/src/runtime/agent/agent-loop.utils.ts`

Shape:

- `SessionRuntime` is the single public session engine.
- `AgentLoop` is an internal flat machine-owned control plane.
- `AgentRunner` is the helper-agent boundary. Durable runs create persisted child sessions; ephemeral runs use isolated in-memory storage and only publish parent-side `AgentRun*` receipts.
- local CLI routing is in-process by default; remote routing is explicit server topology
- queue ownership is structural
- turn phases are explicit (resolve → stream → execute-tools → finalize)
- interactions are cold machine states, not blocked fibers
- machine inspection events are published as diagnostics
- `AgentRunnerConfig` is a plain interface passed to `InProcessRunner`/`SubprocessRunner`, not a service

Do not rebuild business logic from inspection events. They are receipts, not inputs.

### Agent Runs

- Default persistence is durable.
- Read-only helper agents (`explore`, `librarian`, `reviewer`, `auditor`, `summarizer`, `title`) default to ephemeral.
- Durable runs persist a child session/branch and can be revisited with `read_session`.
- Ephemeral runs still execute a full local `AgentLoop`, but against isolated in-memory storage; they return text/usage/tool-call metadata without polluting the session tree.
- Callers that need durable history must opt in explicitly, e.g. task execution forces `persistence: "durable"`.

### Interactions (Cold Pattern)

One interaction primitive: `ctx.approve({ text, metadata? })` → `{ approved, notes? }`.

Tools that need human input call `ctx.approve()`, which delegates to `ApprovalService`. The pattern is cold — no blocked fibers, survives restarts.

```text
tool calls ctx.approve({ text, metadata? })
  → ApprovalService.present() checks for stored resolution (cold resume)
    → if found: returns { approved, notes? }
    → if not: persists to InteractionStorage, publishes InteractionPresented
      → InteractionPendingError thrown
        → machine parks in WaitingForInteraction (cold, no task fiber)

client responds via respondInteraction RPC
  → storeResolution(requestId, { approved, notes? })
    → machine receives InteractionResponded
      → WaitingForInteraction → ExecutingTools
        → tool re-runs, calls ctx.approve(), finds stored resolution
          → continues normally
```

**Event-driven UI.** The `@gent/interaction-tools` extension emits typed interaction events (`InteractionPresented` and friends on the session stream) and the client renders those directly. There is no `extensionSnapshots` cache and no projection mirror; source of truth is the storage row plus the durable interaction events (`derive-do-not-create-states`).

Key properties:

- **No Deferred, no blocked fiber.** `WaitingForInteraction` is a cold state — no `.task()`, no background work. The machine is checkpointed and survives restarts.
- **Crash-safe resume.** `rehydrate()` rebuilds the in-memory context lookup and re-publishes the event. If the process dies before wake, `listPending()` in `InteractionStorage` provides the pending requests for recovery.
- **Tool re-execution on resume.** The full `executeToolsPhase` re-runs. Pre-interaction side effects re-execute (idempotent by convention). No continuation payloads.
- **Permissions are not interactive.** Default-allow with explicit deny rules. `Permission.check` is a synchronous policy check, never blocks.

Files: `interaction-request.ts` (InteractionPendingError, makeInteractionService), `approval-service.ts` (ApprovalService), `interaction-pending-reader.ts` (pending storage read seam), `agent-loop.state.ts` (WaitingForInteraction), `interaction-commands.ts` (respond orchestration).

## Platform Boundaries

Core runtime should not reach for ambient process state unless the app shell is the real owner.

Explicit platform/runtime seams:

- `RuntimePlatform`
- tracer/logger services
- file system / path / OS services

### FileIndex

`FileIndex` — indexed file discovery backed by native Rust file finder (`@ff-labs/fff-bun`).

Production stack: `NativeFileIndexLive` (FFF, per-cwd cached finders, `.gitignore`-aware) → fallback `FallbackFileIndexLive` (Bun.Glob walk + stat). Native failure (missing binary, unsupported platform) silently degrades to fallback. Layer always succeeds.

GlobTool and GrepTool use `FileIndex.listFiles()` for file discovery, then filter with `Bun.Glob.match()` for pattern correctness. This replaces per-invocation directory walks with indexed lookups.

Files:

| File                                                       | Purpose                                           |
| ---------------------------------------------------------- | ------------------------------------------------- |
| `packages/core/src/domain/file-index.ts`                   | Service tag, `IndexedFile`, `FileIndexError`      |
| `packages/core/src/runtime/file-index/native-adapter.ts`   | FFF-backed adapter (dynamic import, polling scan) |
| `packages/core/src/runtime/file-index/fallback-adapter.ts` | Bun.Glob walk fallback                            |
| `packages/core/src/runtime/file-index/index.ts`            | `FileIndexLive` (native-first, catch-to-fallback) |

App entrypoints bind concrete Bun/OS behavior:

- `apps/tui/src/main.tsx`
- `apps/server/src/main.ts`

Production rule:

- `apps/tui/src/main.tsx` resolves a server via `Gent.server()` + `Gent.client()`
- `--connect <url>` attaches to a remote server via `Gent.client({ url })`
- `apps/server/src/main.ts` is the standalone durable server boundary

## Worker Supervisor

`packages/sdk/src/supervisor.ts` owns subprocess worker lifecycle for the worker-http topology. It is an actor-style boundary: one supervisor instance owns one assigned port, one current process, one restart counter, and serialized restart state.

Startup readiness is explicit. The server process writes `GENT_WORKER_READY <url>` to stdout from `apps/server/src/main.ts`; the supervisor does not mark the worker running until that line is observed.

Pre-ready subprocess exits are treated as launch failures, not as successful starts. The supervisor retries bounded, retryable pre-ready failures (`stdout closed`, `exited before ready`, readiness stream read failure). If startup is still inside initial acquisition, exhausted retries fail acquisition; if a supervisor already exists during restart, exhausted retries transition it to `failed`. Readiness timeouts and missing stdout remain terminal startup failures: they indicate wrong configuration or insufficient timeout, not a restartable crash.

After readiness, process exit is normal supervised crash handling:

- manual `restart` serializes through `restartPromise`
- crash restarts use exponential backoff and crash-loop detection
- shared-mode exit code `0` means intentional idle shutdown
- `stop` owns subprocess termination and moves the state to `stopped`

## TUI

TUI is a client over the shared contract, not a parallel app.

Production shape:

- local mode: one process owns renderer, runtime, storage, and reconnect UX under one root scope
- remote mode: TUI shell attaches to an external server boundary and rehydrates from transport state
- reconnect logic rehydrates from runtime state, not UI guesses

Main boundaries:

- `apps/tui/src/client/context.tsx` for client/session/event state
- `apps/tui/src/routes/session-controller.ts` for session-screen orchestration
- `apps/tui/src/extensions/client-facets.ts` for TUI-owned extension facets
- route state machines for modal/session surfaces
- components like `composer.tsx`, `message-list.tsx`, `queue-widget.tsx` as presentation + local interaction

Rules:

- one screen-level owner for session state
- one keyboard owner per route surface
- overlays/composer flows modeled explicitly
- renderer tests cover critical capture/focus paths

## Extensions

Extension shape lives in:

- `packages/core/src/extensions/api.ts` — public authoring surface (`defineExtension` + smart-constructor re-exports)
- `packages/core/src/domain/contribution.ts` — `ExtensionContributions` typed-bucket carrier (core primitives only)
- `packages/core/src/domain/extension.ts` — server contract (`GentExtension`, `ExtensionSetup`)
- `apps/tui/src/extensions/client-facets.ts` — TUI-owned client facet model
- `packages/core/src/runtime/extensions/registry.ts` — server registry
- `packages/extensions/src/` — all 27 builtin extension implementations
- `apps/tui/src/extensions/` — TUI discovery, loading, resolution

### Dependency direction

```text
apps/tui, apps/server, packages/sdk
    ↓               ↓            ↓
@gent/extensions → @gent/core
                    (no reverse dep)
```

Core never imports from extensions. Composition roots (apps, SDK) pass `BuiltinExtensions` into `DependenciesConfig.extensions`.

### Extension boundary contract

Extensions (builtin and third-party) may import from:

- `@gent/core/extensions/api` — the authoring surface
- `effect-machine` — directly, for actor extensions
- `effect`, `@effect/*` — as peer deps

Extensions may NOT import from `@gent/core/domain/*`, `@gent/core/runtime/*`, `@gent/core/storage/*`, `@gent/core/server/*`, `@gent/core/providers/*`. The `no-extension-internal-imports` oxlint rule enforces this.

Rules:

- registration shape is structural — builtins, user, and project extensions share the same setup path
- dispatch compiles once, then runs from typed registries and explicit runtime slots
- actor snapshot schema is enforced at runtime — invalid public snapshots are dropped, not passed through
- activation/startup failures degrade the extension instead of crashing host startup
- `onInit` receives `sessionCwd` from the framework — extensions should not reach into `Storage`
- actor side effects cross explicit slots (`reactions:`, declared `services`), not ambient service lookup inside Behavior handlers

For the full authoring guide, see [docs/extensions.md](docs/extensions.md). Example extensions in [examples/extensions/](examples/extensions/).

### Server Extensions

One authoring shape: `defineExtension({ id, resources?, tools?, commands?, rpc?, projections?, modelDrivers?, externalDrivers? })`. Each typed sub-array is either a literal array, a `(ctx) => array` function, or a `(ctx) => Effect<array>` factory. The bucket name IS the discriminator — TypeScript catches a Projection placed in `tools`, `commands`, or `rpc` at the call site; runtime `validatePackageShape` adds field-local error messages for runtime-loaded modules.

There is no flat `Contribution[]` and no `_kind` discriminator. `ExtensionContributions` (`packages/core/src/domain/contribution.ts`) is the typed-bucket carrier; adding a new kind means adding a new bucket field, not a new union arm.

- **Resource** — `defineResource({ scope, layer?, schedule?, start?, stop? })`. Long-lived state with explicit `scope` ("process" | "cwd" | "session" | "branch"). Replaces the legacy `layer`, `lifecycle`, `job`, and `workflow` kinds. After W10-PhaseB the FSM `machine?` slot is gone — stateful actor extensions declare `actors:` instead (see Actor Substrate below). See `packages/core/src/domain/resource.ts` and `runtime/extensions/resource-host/`.
- **Capability** — `tool(...)` / `request(...)` / `action(...)` smart constructors lowering into typed buckets. `tool` = model-facing tool; `request` = typed extension RPC callable from transport-public or agent-protocol surfaces; `action` = human-palette or human-slash command. The old `query(...)` / `mutation(...)` / `command(...)` / `agent(...)` factories are deleted — use the three typed constructors instead. See `packages/core/src/domain/capability/{tool,request,action}.ts`; `runtime/extensions/registry.ts` compiles the model, RPC, transport, and slash registries.
- **Projection** (`projection(...)`) — read-only Effect that derives a value from services and surfaces it via `prompt` / `policy` projectors. The `R` channel is fenced read-only: `ProjectionContribution<A, R extends ReadOnly>` blocks write-capable service Tags at compile time. All services used in projections must carry the `ReadOnly` brand — `MachineExecute`, `TaskStorageReadOnly`, `MemoryVaultReadOnly`, `SkillsReadOnly`, `InteractionPendingReader`, etc. See `packages/core/src/domain/{projection,read-only}.ts` and `runtime/extensions/extension-reactions.ts`.
- **Driver** — `modelDriver(...)` / `externalDriver(...)` smart constructors lowering to a single `DriverContribution = { flavor: "model" | "external", driver }`. ModelDriver = LLM provider Layer + auth; ExternalDriver = TurnEvent stream (e.g. ACP). See `packages/core/src/domain/driver.ts` and `runtime/extensions/driver-registry.ts`.

Other notes:

- Lifecycle effects live on Resources as `start` / `stop`; `start` failures degrade the Resource (other Resources keep running), `stop` runs at scope teardown via Effect's per-scope LIFO finalizer ordering.
- Prompt shaping, input normalization, permission policy, and turn reactions are explicit runtime slots compiled from Resources and Projections, not generic middleware buckets.
- Agent override is turn-scoped via `QueuedTurnItem.agentOverride`, not persistent `SwitchAgent`.
- `createSession` accepts optional `initialPrompt` + `agentOverride` for atomic create-and-send.

### EventPublisher

`EventPublisherRouterLive` (`server/event-publisher.ts`) dispatches through per-cwd profiles. For a single-cwd run the profile is resolved once at boot; for multi-cwd server topologies the router resolves lazily per cwd and fans out to the correct extension runtime. Transport-level broadcast (session stream, WebSocket push) is cwd-agnostic; only the extension runtime dispatch is per-cwd.

### Task Service Ownership

`TaskService.Live` is owned by the `@gent/task-tools` extension, not core:

- Provided via `ext.layer(TaskService.Live)` — task runs resolve `SubagentRunnerService` lazily when needed
- Task UI reads through typed task RPC and refetches from direct session events (`TaskCreated`, `TaskUpdated`, `TaskCompleted`, `TaskFailed`, `TaskStopped`, `TaskDeleted`). The actor no longer mirrors task events, and there is no task-list projection.
- task mutation flows through the extension boundary as typed Capability contributions (`intent: "write"`)
- `task.output` RPC stays as thin lazy query (message summaries too heavy for snapshots)
- Core `dependencies.ts` no longer imports or wires `TaskService` — it comes through the extension layer graph
- Event-publisher persists and broadcasts session events only. Client widgets read state via typed RPC + typed events on the normal transport stream.

### TUI Extensions

- Builtins are individual `.client.{ts,tsx}` files in `apps/tui/src/extensions/builtins/`
- Each follows `ExtensionClientModule` contract — same pipeline as user/project extensions
- Loader (`apps/tui/src/extensions/loader-boundary.ts`) accepts `disabled` list to filter extensions by id before `setup` runs
- One `setup` shape: Effect-typed `Effect<ClientContribution[], E, R>`. Setups yield from the per-provider `clientRuntime`, which provides `FileSystem | Path | ClientTransport | ClientWorkspace | ClientShell | ClientComposer | ClientLifecycle`. There is no imperative `ctx` argument and no sync `(ctx) => Array` arm. `ExtensionClientContext`, `getSnapshotRaw`, `SnapshotSource`, `ClientSnapshots`, and `defineExtensionPackage` were deleted in B11.6. `ExtensionPackage.tui()` remains as the standalone TUI extension factory (no longer paired with a server extension).
- Widgets are transport-only: subscribe to `ClientTransport.onSessionEvent` for event-backed invalidation or `ClientTransport.onExtensionStateChanged` for explicit extension-state notifications, then call typed extension RPC via `ClientTransport` for current state. Each widget owns its own Solid signal, keyed on `(sessionId, branchId)` so a stale model from the prior session never renders. See `apps/tui/src/extensions/builtins/{auto,artifacts,tasks}.client.{ts,tsx}` for the canonical pattern.
- `ClientLifecycle.addCleanup` registers Solid `createRoot(dispose)` disposers and event unsubscribes; the provider's `onCleanup` reaps them on unmount, so widget setups leave no detached roots behind.
- `useExtensionUI()` exposes reactive `sessionId()`, `branchId()`, and `clientRuntime` for widgets that need imperative access from the render layer.
- Widgets are zero-prop components that self-source from context hooks.

### Extension Actor Substrate

After W10-PhaseB collapsed the dual substrate (FSM `Resource.machine` + new `actors:` bucket) into one, all stateful extensions are `Behavior<M, S, R>` actors managed by `ActorHost` and discovered through the `Receptionist`. There is no per-session FSM lifecycle to inspect — Behaviors are process-scoped, and event-backed client widgets subscribe to the normal session event stream.

**ActorHost** (`runtime/extensions/resource-host/actor-host.ts`):

- Profile-scoped: one `ActorHost` per cwd-profile, spawning each `actors:` Behavior once per profile and registering its `ActorRef` against the Behavior's `ServiceKey` in the Receptionist.
- Snapshot writer: a periodic background fiber persists each actor's state to the `actor_persistence` table; on respawn the host loads the snapshot and resumes from there.
- `start` failures degrade only the failing actor — sibling actors keep running.

**Receptionist + ActorEngine** (`runtime/extensions/receptionist.ts`, `runtime/extensions/actor-engine.ts`):

- `Receptionist.findOne(serviceKey)` resolves the live `ActorRef`. `ActorEngine.tell(ref, msg)` is fire-and-forget; `ActorEngine.ask(ref, msg)` is request/reply with timeout.
- One `ActorEngine` instance is wired at the composition boundary so `ActorHost` (registers) and `ActorRouter` (routes) share the same actor map.

**ActorRouter** (`runtime/extensions/resource-host/actor-router.ts`):

- A thin actor-router over `ActorEngine` + `Receptionist`. Decodes the `ExtensionMessage` envelope, looks up the target Behavior's `ServiceKey`, and dispatches via `tell` (commands) or `ask` (requests).
- Behaviors do not receive `AgentEvent` automatically. Extensions that need to react to events declare `reactions:` handlers that explicitly `tell` their actor (see `auto.ts`/`handoff.ts`).
- `getActorStatuses` returns `[]` and `terminateAll` is a no-op — kept on the interface for surface compat. Behaviors are process-scoped, not per-session.

**Event-backed client invalidation**:

- Server event publishing appends and broadcasts committed `AgentEvent`s only; it does not synthesize extension invalidation events from registry metadata.
- TUI widgets that derive state from events subscribe with `ClientTransport.onSessionEvent` and refetch their typed extension RPC when relevant event tags arrive. `@gent/task-tools` is the canonical event-backed widget.
- `ExtensionStateChanged` remains available as an explicit, payload-free notification event for extensions that choose to publish it directly.

**MachineExecute** (`runtime/extensions/machine-execute.ts`):

- Read-only surface for projections and `request`-intent capabilities. Exposes only `execute<M>`; write operations (`send`/`publish`) are structurally absent. The `R` type of every `ProjectionContribution` is fenced to `ReadOnly`-branded tags — `MachineExecute` carries that brand, `MachineEngine` does not. Projection and read-intent capability authors receive `MachineExecute`; resource `start`/`stop` and write-intent capabilities receive `MachineEngine` from the ephemeral layer.

**Compositor `withOverrides`**:

`RuntimeComposer.ephemeral().withOverrides({...})` (`runtime/composer.ts`) accepts named override fields for sub-Tag-aware ephemeral layer construction. Each field maps one override slot (e.g. `provider`, `eventStore`, `storage`) to a concrete Tag + layer. `.own(...)` remains the mechanism for fully-owned per-run services (belt); `.withOverrides(...)` handles targeted service substitutions (suspenders).

## Testing

Use the smallest honest boundary:

- pure helpers: unit tests
- transport/app services: Effect tests
- TUI render/capture: OpenTUI renderer tests
- runtime ordering/turn semantics: recording layers + runtime tests

**Banned test primitives**: `Provider.Test` and `EventStore.Test` are deleted. Use `Provider.Debug()` or `Provider.Sequence([...])` for provider mocking and `EventStore.Memory` for in-memory event stores.

### Commands

| Command            | Scope                                                 | Target   |
| ------------------ | ----------------------------------------------------- | -------- |
| `bun run test`     | product behavior: core + tui + sdk + fast integration | ~2-4s    |
| `bun run test:e2e` | PTY e2e + supervisor + worker-http transport          | ~60-120s |
| `bun run gate`     | typecheck + lint + fmt + build + test                 | ~15s     |

### Test structure

`packages/core/tests/` mirrors `packages/core/src/`:

```text
tests/
├── domain/        # auth-store, auth-guard, agent, event, message, skills, ...
├── extensions/    # api, registry, compile-tool-policy, hooks, loader, memory/, ...
├── providers/     # provider, provider-auth, provider-resolution, anthropic-keychain
├── runtime/       # session-runtime, agent-loop, retry, agent-runner, tool-runner, ...
├── server/        # rpcs, session-queries, system-prompt
├── storage/       # sqlite-storage, search-storage, task-storage, bypass
├── debug/         # sequence-provider
└── test-utils/    # sequence
```

One test file per source file. No god tests. Names match source owners.

`packages/e2e/tests/` separates fast in-process contracts from slow end-to-end:

- `test` — direct-transport contract tests (in-process, no subprocess)
- `test:e2e` — PTY TUI tests, supervisor lifecycle, worker-http transport

### Important files

- `packages/core/src/test-utils/index.ts` — `SequenceRecorder`, recording layers
- `packages/core/src/test-utils/in-process-layer.ts` — `baseLocalLayer`
- `packages/core/src/test-utils/e2e-layer.ts` — `createE2ELayer`
- `packages/core/src/providers/provider.ts` — `Provider.Debug`, `Provider.Sequence`, `Provider.Signal`, `Provider.Failing` + step builders
- `apps/tui/tests/render-harness.tsx` — TUI render test harness
- `packages/e2e/tests/transport-harness.ts` — shared worker + transport cases

## Interaction Tools Extension

`@gent/interaction-tools` — `ask_user` and `prompt` tools.

The TUI renders interactions from the typed event feed (`InteractionPresented` etc.) routed by `metadata.type`. Pending interaction storage remains the durable source of truth for crash-safe resume, but the UI no longer uses a projection or actor mirror.

## Artifacts Extension

`@gent/artifacts` — generic artifact store with typed protocol. Any tool/extension can persist artifacts via `ctx.extension.ask(ArtifactProtocol.Save(...))`.

Actor state: `{ items: Artifact[] }`. Upsert by `sourceTool + branchId` (last-writer-wins). Artifacts are branch-aware — prompt projection filters to current branch. Agent-facing tools: `artifact_save`, `artifact_read`, `artifact_update`, `artifact_clear`.

Plan, audit, and review tools save artifacts deterministically after producing results. The `@gent/plan` extension is tool-only (no actor) — planning results are persisted as artifacts.

## Auto Loop Extension

`@gent/auto` — iterative workflow driver via effect-machine.

State: `Inactive | Working | AwaitingReview`. Signal tool: `auto_checkpoint`. Gate: `review` tool completion between iterations (proves adversarial review actually ran). Safety: `maxIterations` ceiling + `turnsSinceCheckpoint` wedge detection.

### JSONL Persistence

`AutoJournal` writes append-only `.gent/auto/<goal-slug>.jsonl` relative to cwd. `active.json` pointer tracks which journal to resume. Row types: `config`, `checkpoint`, `review`.

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
- `trackingApprovalService()` — returns `{ layer, presentCalled: Ref<boolean> }` for approval assertions

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
memory extension
  → declarative scheduled job contributions
  → host-owned scheduler reconciliation
  → real gent executable in headless mode
  → gent headless session with system agent
  → agent uses memory_remember/recall/forget tools
```

Scheduling is host-owned, not an extension startup side effect. Memory contributes durable global jobs; the host reconciles installation/removal and degrades scheduler failures without crashing extension activation.

Key files:

| File                                                | Purpose                       |
| --------------------------------------------------- | ----------------------------- |
| `packages/extensions/src/memory/vault.ts`           | Vault I/O service             |
| `packages/extensions/src/memory/state.ts`           | Extension state + helpers     |
| `packages/extensions/src/memory/tools.ts`           | Agent tools                   |
| `packages/extensions/src/memory/agents.ts`          | reflect + meditate agent defs |
| `packages/core/src/runtime/extensions/scheduler.ts` | Host scheduler reconciliation |
| `packages/extensions/src/memory/projection.ts`      | Prompt turn-projection helper |
| `packages/extensions/src/memory/index.ts`           | Extension registration        |

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

If you are migrating old runtime, union, capability, or provider code, see
`docs/migrations/runtime-union-provider.md`.
