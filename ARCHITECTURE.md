# Gent Architecture

Minimal agent harness. Effect-first. Small seams. One owner per concern.

## Core Model

`gent` is organized around six nouns:

- `Server` — process-wide services only: storage, auth stores, platform, transport wiring, connection tracking.
- `Profile` — cwd-scoped policy and extension graph: permissions, drivers, reactions, resources, capability leaves.
- `SessionRuntime` — the single public session engine: inbox, queue, checkpoint, watch state, turn orchestration.
- `Tool` / `Request` / `Action` — independent callable leaves for model tools, extension RPC, and human UI actions.
- `Resource` — long-lived services, schedules, lifecycle, and extension-owned state.
- `Reaction` — turn/message/tool-result hooks for prompt, policy, runtime, and client state derivation.

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
├── core/          # public extension authoring API only
├── core-internal/ # monorepo-internal domain/runtime/server/test surface
│   ├── domain/    # Schemas, ids, events, service tags, pure domain helpers
│   ├── storage/   # Storage tags, schema ownership, SQLite assembler, focused repositories
│   ├── providers/ # Effect AI provider stack: model resolution, auth, debug/sequence drivers
│   ├── runtime/   # SessionRuntime, agent-loop internals, profile/runtime services
│   ├── extensions/# api.ts public extension surface
│   ├── server/    # transport contract, handlers, commands, queries, startup wiring
│   └── test-utils/# test layers, recorders, fixtures
├── extensions/    # shipped extension set
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

Default `gent` resolves a shared server via `Gent.server({ cwd, state: Gent.state.sqlite() })`. SQLite-backed local clients use one host-local server lock at `~/.gent/server.lock`; workspace routing is carried by the `x-gent-workspace-id` RPC header. Topology derives from configuration: `Gent.state.memory()` for in-process owned, `Gent.state.sqlite()` for shared local server, `Gent.client({ url })` for remote.

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

`packages/core/src/runtime/profile.ts` is the single discover → setup → reconcile → sections pipeline. Both profile entrypoints go through the resolver paired with `buildExtensionLayers`:

- **Server startup** (`server/dependencies.ts`) — resolves once at boot, builds the registry/state/event-bus layer via `buildExtensionLayers`, publishes the profile as a tag so `agentRuntimeLive` reuses the same prompt sections instead of recomputing.
- **Per-cwd profile cache** (`runtime/session-profile.ts`) — resolves lazily per unique cwd, builds the same layer shape via `buildExtensionLayers` inside the captured server scope.

Ephemeral child runs (`runtime/agent/agent-runner.ts`) intentionally do NOT call the resolver — they forward an already-resolved `ExtensionRegistry` from the parent and only rebuild the per-run mutable bits (storage, pub/sub engine, state runtime) for isolation. That divergence is structural, not duplication.

`compileBaseSections(profile)` resolves dynamic prompt sections inside the extension-services runtime so contributions like `Skills`'s prompt section can read services from their own `setup.layer`.

## Runtime

Core orchestration lives in:

- `packages/core/src/runtime/session-runtime.ts`
- `packages/core/src/runtime/agent/agent-loop.actor.ts`
- `packages/core/src/runtime/agent/agent-loop.behavior.ts`
- `packages/core/src/runtime/agent/agent-loop.state.ts`
- `packages/core/src/runtime/agent/turn-helpers.ts`
- `packages/core/src/runtime/agent/turn-response/`

Shape:

- `SessionRuntime` is the single public session engine.
- `AgentLoop` is an actor-backed internal control plane. There is no public
  `AgentLoop` service facade; `session-runtime.ts` talks to
  `agent-loop.actor.ts` directly. The actor entity id includes
  `(workspaceId, sessionId, branchId)`.
- Runtime commands resolve an existing `(sessionId, branchId)` target before loop dispatch.
- `AgentRunner` is the helper-agent boundary. Durable runs create persisted child sessions; ephemeral runs use isolated in-memory storage and only publish parent-side `AgentRun*` receipts.
- local CLI routing uses the shared server lock by default; remote routing is explicit server topology
- queue ownership is structural
- turn resolution streams through `LanguageModel.streamText` from `ModelResolver`, with durable stream/tool/finalization events derived from the response stream.
- interactions are cold machine states, not blocked fibers
- machine inspection events are published as diagnostics
- `AgentRunnerConfig` is a plain interface passed to `InProcessRunner`/`SubprocessRunner`, not a service

Do not rebuild business logic from inspection events. They are receipts, not inputs.

### Agent Runs

- Default persistence is durable.
- Read-only helper agents (`explore`, `librarian`, `reviewer`, `auditor`, `summarizer`, `title`) default to ephemeral.
- Durable runs persist a child session/branch and can be revisited with `read_session`.
- Ephemeral runs still execute a full local `AgentLoop`, but against isolated in-memory storage; they return text/usage/tool-call metadata without polluting the session tree.
- Callers that need durable history must opt in explicitly, e.g. todo execution forces `persistence: "durable"`.

### Interactions (Cold Pattern)

One interaction primitive: `ctx.approve({ text, metadata? })` → `{ approved, notes? }`.

Tools that need human input call `ctx.approve()`, which delegates to `ApprovalService`. The pattern is cold — no blocked fibers, survives restarts.

```text
tool calls ctx.approve({ text, metadata? })
  → ApprovalService.present() checks for stored resolution (cold resume)
    → if found: returns { approved, notes? }
    → if not: persists to InteractionStorage, publishes InteractionPresented
      → InteractionPendingError thrown
        → machine parks in WaitingForInteraction (cold, no turn fiber)

client responds via respondInteraction RPC
  → storeResolution(requestId, { approved, notes? })
    → machine receives InteractionResponded
      → WaitingForInteraction → ExecutingTools
        → tool re-runs, calls ctx.approve(), finds stored resolution
          → continues normally
```

**Event-driven UI.** The `@gent/interaction-tools` extension emits typed interaction events (`InteractionPresented` and friends on the session stream) and the client renders those directly. There is no `extensionSnapshots` cache and no projection mirror; source of truth is the storage row plus the durable interaction events (`derive-do-not-create-states`).

Key properties:

- **No Deferred, no blocked fiber.** `WaitingForInteraction` is a cold state — no background turn work. The machine is checkpointed and survives restarts.
- **Crash-safe resume.** `rehydrate()` rebuilds the in-memory context lookup and re-publishes the event. If the process dies before wake, `listPending()` in `InteractionStorage` provides the pending requests for recovery.
- **Tool re-execution on resume.** The full `executeToolsPhase` re-runs. Pre-interaction side effects re-execute (idempotent by convention). No continuation payloads.
- **Permissions are not interactive.** Default-allow with explicit deny rules. `Permission.check` is a synchronous policy check, never blocks.

Files: `interaction-request.ts` (InteractionPendingError, makeInteractionService), `approval-service.ts` (ApprovalService), `interaction-pending-reader.ts` (pending storage read seam), `agent-loop.state.ts` (WaitingForInteraction), `interaction-commands.ts` (respond orchestration).

## Platform Boundaries

Core runtime should not reach for ambient process state unless the app shell is the real owner.

Explicit platform/runtime seams:

- `GentPlatform` owns host capabilities such as process identity, signals, env,
  executable path, ids, time, and OS info.
- `RuntimeEnvironment` carries launch/session configuration values:
  `cwd`, `home`, and platform name.
- tracer/logger services
- file system / path / OS services

### FileIndex

`FileIndex` — indexed file discovery backed by native Rust file finder (`@ff-labs/fff-bun`).

Production stack: `NativeFileIndexLive` (FFF, per-cwd cached finders, `.gitignore`-aware) → fallback `FallbackFileIndexLive` (Effect `FileSystem` walk + `picomatch` filtering). Native failure (missing binary, unsupported platform) silently degrades to fallback. Layer always succeeds.

GlobTool and GrepTool reach the index through `ctx.Files.listFiles()` on `ExtensionContext`, then filter with `picomatch` for pattern correctness. This replaces per-invocation directory walks with indexed lookups. Shipped extensions never import the `FileIndex` Tag directly — the runtime resolves it once and exposes it on the public `Files` facade.

Files:

| File                                                       | Purpose                                           |
| ---------------------------------------------------------- | ------------------------------------------------- |
| `packages/core/src/domain/file-index.ts`                   | Service tag, `IndexedFile`, `FileIndexError`      |
| `packages/core/src/runtime/file-index/native-adapter.ts`   | FFF-backed adapter (dynamic import, polling scan) |
| `packages/core/src/runtime/file-index/fallback-adapter.ts` | Effect FileSystem + picomatch fallback            |
| `packages/core/src/runtime/file-index/index.ts`            | `FileIndexLive` (native-first, catch-to-fallback) |

App entrypoints bind concrete Bun/OS behavior:

- `apps/tui/src/main.tsx`
- `apps/server/src/main.ts`

Production rule:

- `apps/tui/src/main.tsx` resolves a server via `Gent.server()` + `Gent.client()`
- `--connect <url>` attaches to a remote server via `Gent.client({ url })`
- `apps/server/src/main.ts` is the standalone durable server boundary

## Shared Server Discovery

`packages/sdk/src/server-lock.ts` owns shared-server discovery. It stores one host-local identity record at `~/.gent/server.lock`, not one registry file per workspace or database. Clients only attach after probing `/_gent/identity` and matching the full server identity tuple, so stale pidfiles and PID reuse do not signal unrelated processes.

`packages/sdk/src/server.ts` resolves SQLite-backed clients through this single shared server record. Workspace isolation comes from the `x-gent-workspace-id` RPC header and workspace-prefixed AgentLoop actor entity IDs, not from per-workspace server processes.

The old SDK worker supervisor and worker-http transport are deleted. E2E coverage that needs process boundaries uses focused server-process fixtures; transport contract tests run through the in-process direct transport.

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
- `packages/extensions/src/` — shipped extension implementations
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

Extensions may import from:

- `@gent/core/extensions/api` — the authoring surface
- `effect`, `@effect/*` — as peer deps

Extensions may NOT import Gent domain, runtime, storage, server, or provider
internals through either `@gent/core` or `@gent/core-internal`. The
`no-extension-internal-imports` oxlint rule enforces this for shipped
extensions, and the same rule defines the contract for user/project
extensions. "Builtin" means "included in the default distribution", not
privileged.

### Extension API Inventory

`@gent/core/extensions/api` is the extension API. Anything an extension needs
must either live here as a stable authoring primitive or move behind a
host-owned design. It should expose:

- extension shape: `defineExtension`, `GentExtension`,
  `ExtensionSetupContext`, `DefineExtensionInput`;
- typed leaves: `tool`, `request`, `ref`, `action`;
- scoped resources: `defineResource`, `resource`, resource scope/schedule
  types;
- turn hooks: the public reaction input/output types needed to author
  `reactions`;
- agents and model ids: `defineAgent`, `AgentName`, `ModelId`, run-spec
  helpers needed for turn-scoped subagent dispatch;
- stable ids and author-facing schemas: `ExtensionId`, `ArtifactId`,
  `ToolCallId`, `PermissionRule`, output/message projection
  helpers that are safe to serialize across the extension boundary;
- host facts: `ExtensionSetupContext.host`, a small public view over
  host-owned platform facts such as OS info, executable path, home directory,
  command candidates, and loopback port probes;
- author-facing errors: capability, provider-auth, agent-run, and typed
  transition errors that extension code can intentionally return or inspect.

Everything else is builtin/internal:

- raw runtime host context and hook plumbing (`ExtensionHostContext`,
  `ToolExecuteInput`, `ProjectionTurnContext`, permission/context message
  internals);
- storage, event publisher, event store, todo/session mutation services, and
  interaction pending readers;
- runtime/platform services and helpers (`GentPlatform`, `ToolRunner`,
  `ExtensionEventSink`, `runProcess`);
- agent loop/session runtime internals and process runners that are only host
  implementation details;
- raw event/todo/message domain internals that are not part of the serialized
  authoring contract;
- driver registry internals and provider auth persistence machinery;
- test-only helpers such as `getToolEffect`, raw metadata tags, and fixture
  constructors.

Rules:

- registration shape is structural — builtins, user, and project extensions share the same setup path
- builtins are only the initial extension set — app code consumes registry or
  transport projections instead of privileged `@gent/extensions` registries
- dispatch compiles once, then runs from typed registries and explicit runtime slots
- public snapshot schema is enforced at runtime — invalid snapshots are dropped, not passed through
- activation/startup failures degrade the extension instead of crashing host startup
- stateful side effects cross explicit typed slots (`reactions:`, resources, or
  extension-owned services), not private host imports

For the full authoring guide, see [docs/extensions.md](docs/extensions.md). Example extensions in [examples/extensions/](examples/extensions/).

### Server Extensions

One authoring shape: `defineExtension({ id, resources?, tools?, actions?, requests?, agents?, reactions?, modelDrivers?, externalDrivers? })`. Each typed bucket is either a literal array, a `() => array` function, or a `() => Effect<array>` factory. Setup-time host facts come from `yield* ExtensionSetupContext`; runtime host authority comes from `yield* ExtensionContext`. The bucket name IS the discriminator — TypeScript catches the wrong leaf in `tools`, `actions`, or `requests` at the call site; runtime `validatePackageShape` adds field-local error messages for runtime-loaded modules.

There is no flat `Contribution[]` and no `_kind` discriminator. `ExtensionContributions` (`packages/core/src/domain/contribution.ts`) is the typed-bucket carrier; adding a new kind means adding a new bucket field, not a new union arm.

- **Resource** — `defineResource({ scope, layer?, schedule?, start?, stop? })`. Long-lived state with explicit `scope`. Today only `"process"` is public, because it is the only lifecycle with a host owner. `cwd`, `session`, and `branch` lifetimes stay out of the author API until their runtime owners exist. Stateful extension logic is either a normal scoped service/resource or, for true actor protocols, an Effect Entity/RPC owner at the runtime boundary. See `packages/core/src/domain/resource.ts` and `runtime/extensions/resource-host/`.
- **Callable leaves** — `tool(...)` / `request(...)` / `action(...)` smart constructors lowering into typed buckets. `tool` = model-facing tool; `request` = typed extension RPC; `action` = human-palette or human-slash command. Handlers receive input only. Host authority comes from the `ExtensionContext` facade (`Session`, `Agent`, `Interaction`, `Process`, `Files`, `FileLock`, `State`); extension-private authority comes from extension-owned Effect service Tags. The `Files` / `FileLock` / `State` facets wrap the host-internal `FileIndex`, `FileLockService`, and `ExtensionStatePublisher` so shipped and external extensions share the same surface. See `packages/core/src/domain/capability/{tool,request,action}.ts`; `runtime/extensions/registry.ts` compiles the model, RPC, and slash registries.
- **Reactions** — `reactions.turnProjection`, `systemPrompt`, `turnBefore`, `turnAfter`, `messageOutput`, and `toolResult` are the explicit runtime hooks. Reaction handlers receive event input only and yield `ExtensionContext` or extension-owned service Tags when they need authority. See `packages/core/src/domain/extension.ts` and `runtime/extensions/extension-reactions.ts`.
- **Driver** — `modelDrivers` and `externalDrivers` are split buckets of `ModelDriverContribution` and `ExternalDriverContribution`. Model drivers provide LLM provider layers + auth; external drivers stream Effect AI response parts from process-owned executors such as ACP. See `packages/core/src/domain/driver.ts` and `runtime/extensions/driver-registry.ts`.

Other notes:

- Lifecycle effects live on Resources as `start` / `stop`; `start` failures degrade the owning extension, remove its dependent contributions from active registries, and surface through extension health / `gent doctor`. Other extensions keep running. `stop` runs at scope teardown via Effect's per-scope LIFO finalizer ordering.
- Prompt shaping, input normalization, permission policy, and turn reactions are explicit runtime slots compiled from extension reactions and typed leaves, not generic middleware buckets.
- Agent override is turn-scoped via `QueuedTurnItem.agentOverride`, not persistent `SwitchAgent`.
- `createSession` accepts optional `initialPrompt` + `agentOverride` for atomic create-and-send.

### EventPublisher

`EventPublisherRouterLive` (`server/event-publisher.ts`) dispatches through per-cwd profiles. For a single-cwd run the profile is resolved once at boot; for multi-cwd server topologies the router resolves lazily per cwd and fans out to the correct extension runtime. Transport-level broadcast (session stream, WebSocket push) is cwd-agnostic; only the extension runtime dispatch is per-cwd.

### Todo Service Ownership

`TodoService.Live` is owned by the `@gent/todo` extension, not core:

- Provided by `@gent/todo` as a process resource layer
  (`TodoStorage.Live + TodoService.Live`).
- Todo mutation flows through typed extension requests and extension tools yield
  `TodoService` from their own extension runtime.
- Todo UI reads through typed extension RPC and refetches when
  `@gent/todo` emits an `ExtensionStateChanged` pulse on the normal
  session stream.
- Core has no product todo domain. Core `MachineTaskSucceeded` /
  `MachineTaskFailed` events are runtime/tool telemetry and stay filtered from
  public transport.
- Event-publisher persists and broadcasts session events only. Client widgets
  read state via typed RPC plus transport events; they do not consume a core
  todo service or privileged builtin API.

### TUI Extensions

- Builtins are individual `.client.{ts,tsx}` files in `apps/tui/src/extensions/builtins/`
- Each follows `ExtensionClientModule` contract — same pipeline as user/project extensions
- Loader (`apps/tui/src/extensions/loader-boundary.ts`) accepts `disabled` list to filter extensions by id before `setup` runs
- One `setup` shape: Effect-typed `Effect<ClientContribution[], E, R>`. Setups yield from the per-provider `clientRuntime`, which provides `FileSystem | Path | ClientTransport | ClientWorkspace | ClientShell | ClientComposer | ClientLifecycle`. There is no imperative `ctx` argument, no sync `(ctx) => Array` arm, and no package wrapper around paired server/client modules. Shared server/client artifacts use `defineExtension({ client })`; TUI-only artifacts use `.client.{ts,tsx}` modules.
- Widgets are transport-only: subscribe to `ClientTransport.onSessionEvent` for event-backed invalidation or `ClientTransport.onExtensionStateChanged` for explicit extension-state notifications, then call typed extension RPC via `ClientTransport` for current state. Each widget owns its own Solid signal, keyed on `(sessionId, branchId)` so a stale model from the prior session never renders. See `apps/tui/src/extensions/builtins/{auto,artifacts,todos}.client.{ts,tsx}` for the canonical pattern.
- `ClientLifecycle.addCleanup` registers Solid `createRoot(dispose)` disposers and event unsubscribes; the provider's `onCleanup` reaps them on unmount, so widget setups leave no detached roots behind.
- `useExtensionUI()` exposes reactive `sessionId()`, `branchId()`, and `clientRuntime` for widgets that need imperative access from the render layer.
- Widgets are zero-prop components that self-source from context hooks.

### Extension State

Extension state lives in scoped Effect services/resources and publishes product
events through the normal session event stream.

True actor protocols should be introduced at their owning runtime boundary
using Effect Entity/RPC rather than recreating mailbox, discovery, persistence,
or ask/reply infrastructure inside extension authoring.

**Event-backed client invalidation**:

- Server event publishing appends and broadcasts committed `AgentEvent`s only; it does not synthesize extension invalidation events from registry metadata.
- TUI widgets that derive state from events subscribe with `ClientTransport.onSessionEvent` and refetch their typed extension RPC when relevant event tags arrive. `@gent/todo` is the canonical event-backed widget.
- `ExtensionStateChanged` remains available as an explicit, payload-free notification event for extensions that choose to publish it directly.

**Ephemeral runtime builder**:

`agent-runner.ts` builds ephemeral child runs by snapshotting the parent context
with `Layer.succeedContext(...)`, merging child-owned override families with
`Layer.provideMerge`, and wrapping the final merged layer in `Layer.fresh`.
Each override family, such as `storage`, `eventStore`, or `eventPublisher`,
maps to a required child layer; matching child Tags occlude parent Tags through
last-writer-wins context merge.

Ephemeral children reuse the parent-resolved extension registry and rebuild
resource service layers with `buildExtensionLayers(..., { lifecycle: "skip" })`.
That keeps extension services available inside the child runtime while leaving
process resource `start`/`stop` lifecycle ownership with profile resolution.

## Testing

Use the smallest honest boundary:

- pure helpers: unit tests
- transport/app services: Effect tests
- TUI render/capture: OpenTUI renderer tests
- runtime ordering/turn semantics: recording layers + runtime tests

**Banned test primitives**: `Provider.Test`, provider-wrapper statics, and `EventStore.Test` are deleted. Use `LanguageModelLayers.debug()` / `LanguageModelLayers.sequence([...])` from `@gent/core-internal/test-utils/language-model` for model mocking and `EventStore.Memory` for in-memory event stores.

**Banned test control flow**: test files do not use `async`/`await`, Promise chains, raw Promise-returning test bodies, or hook cleanup patterns. Use `it.live` / `it.scopedLive` and scoped Effect resources so finalizers run under the test runtime.

**Names describe behavior**: active test modules are behavior-named. Historical process names belong only in `plans/` and dated audit receipts.

### Commands

| Command            | Scope                                                 | Target  |
| ------------------ | ----------------------------------------------------- | ------- |
| `bun run test`     | product behavior: core + tui + sdk + fast integration | ~2-4s   |
| `bun run test:e2e` | PTY e2e + focused server-process lifecycle coverage   | ~50-70s |
| `bun run gate`     | typecheck + lint + fmt + build + test                 | ~15s    |

### Test structure

`packages/core/tests/` mirrors `packages/core/src/`:

```text
tests/
├── domain/        # auth, agent, event, message, skills, ...
├── extensions/    # api, registry, compile-tool-policy, hooks, loader, memory/, ...
├── providers/     # provider, provider-auth, provider-resolution, anthropic-keychain
├── runtime/       # session-runtime, agent-loop, retry, agent-runner, tool-runner, ...
├── server/        # rpcs, session-queries, system-prompt
├── storage/       # sqlite-storage, search-storage, todo storage
├── debug/         # sequence-provider
└── test-utils/    # sequence
```

One test file per source file. No god tests. Names match source owners.

`packages/e2e/tests/` separates fast in-process contracts from slow end-to-end:

- `test` — direct-transport contract tests (in-process, no subprocess)
- `test:e2e` — PTY TUI tests and focused server-process lifecycle coverage

### Important files

- `packages/core/src/test-utils/index.ts` — `SequenceRecorder`, recording layers
- `packages/core/src/test-utils/in-process-layer.ts` — `baseLocalLayer`, a
  production-root preset over `makeServerRootLayer` with in-memory SQLite,
  storage-backed events, debug providers, and test service overrides
- `packages/core/src/test-utils/e2e-layer.ts` — `createE2ELayer`, a
  production-root preset over `makeServerRootLayer` that keeps real
  `ToolRunner.Live`, extension setup/resource startup, event publishing, and
  interaction recovery while expressing test storage/provider/auth/approval
  differences through dependency overrides
- `packages/core/src/test-utils/rpc-harness.ts` — thin RPC acceptance helper:
  `createE2ELayer` → `Gent.test` → seeded `session.create`
- `packages/core/src/test-utils/language-model.ts` — `LanguageModelLayers.debug`, `sequence`, `signal`, `failing` + stream-part helpers
- `apps/tui/tests/render-harness.tsx` — TUI render test harness
- `packages/e2e/tests/transport-harness.ts` — direct transport contract harness

## Interaction Tools Extension

`@gent/interaction-tools` — `ask_user` and `prompt` tools.

The TUI renders interactions from the typed event feed (`InteractionPresented` etc.) routed by `metadata.type`. Pending interaction storage remains the durable source of truth for crash-safe resume.

## Artifacts Extension

`@gent/artifacts` — generic artifact store exposed through typed public extension RPC. In-process tools yield artifact services directly; client/UI callers use `client.extension.request(...)`.

State: `{ items: Artifact[] }`. Upsert by `sourceTool + branchId` (last-writer-wins). Artifacts are branch-aware — prompt projection filters to current branch. Agent-facing tools: `artifact_save`, `artifact_read`, `artifact_update`, `artifact_clear`.

Plan, audit, and review tools save artifacts deterministically after producing results. The `@gent/plan` extension is tool-only (no actor) — planning results are persisted as artifacts.

## Auto Loop Extension

`@gent/auto` — iterative workflow driver backed by scoped services plus
`reactions.toolResult` / `turnAfter`.

State: `Inactive | Working | AwaitingReview`. Signal tool: `auto_checkpoint`. Gate: `review` tool completion between iterations (proves adversarial review actually ran). Safety: `maxIterations` ceiling + `turnsSinceCheckpoint` wedge detection.

### JSONL Persistence

`AutoJournal` writes append-only `.gent/auto/<goal-slug>.jsonl` relative to cwd. `active.json` pointer tracks which journal to resume. Row types: `config`, `checkpoint`, `review`.

Cross-session replay via `onInit`: child sessions verify ancestry includes `active.sessionId`. Pointers without `sessionId` fail closed. Root sessions never replay.

### Handoff Ownership

`@gent/auto` and `@gent/handoff` are cleanly separated:

- Auto detects context fill → queues follow-up telling model to call `handoff` tool
- Handoff extension owns presentation, cooldown, and user interaction
- Handoff extension skips when auto is active (guard on `AutoRpc.IsActive`)

### Todo Service

`TodoService` is owned by the `@gent/todo` extension (not core). Todos are
durable work items with optional nesting (`parentId`) plus dependency edges
(`blockedBy`). Storage rejects parent/dependency cycles so the dependency graph
stays a DAG.

### Test Utilities

- `withTinyContextWindow(effect)` — patches `MODEL_CONTEXT_WINDOWS` to 5k tokens for threshold tests
- `trackingApprovalService()` — returns `{ layer, presentCalled: Ref<boolean> }` for approval assertions

Both exported from `@gent/core-internal/test-utils/e2e-layer`.

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

Session-local memories are volatile and stay in the in-process extension service. Promotion to disk is explicit via tools.

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

| Boundary     | Service       | File                                   |
| ------------ | ------------- | -------------------------------------- |
| Agent turn   | `agent-loop`  | `runtime/agent/agent-loop.behavior.ts` |
| Tool call    | `tool-runner` | `runtime/agent/tool-runner.ts`         |
| Model stream | `model`       | `runtime/agent/agent-loop.behavior.ts` |
| RPC request  | `rpc`         | `server/rpc-handlers.ts`               |
| Agent run    | `agent-run`   | `runtime/agent/agent-runner.ts`        |

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
