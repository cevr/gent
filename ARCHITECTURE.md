# Gent Architecture

Minimal agent harness. Effect-first. Small seams. One owner per concern.

The resource evolution plan is in [`docs/malleability.md`](docs/malleability.md).

## Core Model

`gent` is organized around five nouns:

- `Server` — process-wide services only: storage, auth stores, platform, transport wiring, connection tracking.
- `Profile` — cwd-scoped policy and extension graph: permissions, drivers, hooks, resources, capability leaves.
- `SessionRuntime` — the single public session engine: inbox, queue, checkpoint, watch state, turn orchestration.
- `Tool` / `Request` — independent callable leaves for model tools and typed extension RPC. Requests with a `slash:` block also surface as human slash commands.
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

`AppServicesLive` is assembled inline at the top of `packages/core/src/server/server-root.ts` (private to the file — `buildServerRoot` is the only consumer).

`packages/core/src/server/dependencies.ts` owns startup wiring:

- runtime platform
- storage/event store
- auth/config/model registry
- provider stack
- extension loading and live Profile ownership
- actor/runtime services

It is the composition boundary. Not the domain boundary.

### Runtime Profile

`packages/core/src/runtime/profile.ts` owns the shared profile pipeline.
`loadRuntimeProfileDeclarations` discovers extensions, runs trusted setup,
validates declarations, and loads static prompt inputs. It does not acquire
Resource layers, invoke their lifecycle hooks, or reconcile scheduled jobs.
Trusted setup can still perform its own effects; this is not a sandbox boundary.

`runtime/live-profile.ts` sends these declarations to the graph host and
reconciles scheduled jobs while staging the catalog. `buildProfileCatalog`
assembles registries and prompt inputs from the acquired resource context.
`buildExtensionLayers` remains the isolated child adapter. It builds child
service values without repeating the parent's process lifecycle hooks.
Profile tests use the live cache. The tool test layer uses the production
composition root. Neither has a separate activation implementation.

The production server uses one live profile owner:

- `runtime/session-profile.ts` owns entries by workspace and canonical cwd.
  `runtime/live-profile.ts` stages each catalog from the graph host's acquired
  service context. It does not acquire a second resource layer.
- `server/dependencies.ts` recovers durable graph owners before selecting the
  launch profile from that cache. An unavailable saved launch owner fails startup.
  It does not receive a default profile with replacement authority.
- `runtime/extensions/resource-host/resource-graph-command.ts` records desired
  state and dispatches commands through Effect Encore. Recovery reacquires live
  scopes, including graphs previously marked applied. A saved applied receipt
  does not prove that this process owns the resource.
- `runtime/extensions/resource-host/resource-graph-host.ts` owns catalog
  publication, resource generations, and admission leases. Effect Machine in
  `resource-lifecycle.ts` owns each local resource's lifecycle. Effect scopes own
  its acquired services and cleanup. Neither library replaces the branch actor.

Live turn profiles enter the selected publication lease before execution.
Direct actor tests can use an explicit legacy profile without a graph host.
Native source-mode approval, public repair, direct-command cleanup, and external
callback limits have focused validation. Full gate and terminal/server E2E pass.
See `plans/live-composition-review.md` for evidence and recovery limits.

Ephemeral child runs (`runtime/agent/agent-runner.ts`) intentionally do NOT call the resolver — they forward an already-resolved `ExtensionRegistry` from the parent and only rebuild the per-run mutable bits (storage, pub/sub engine, state runtime) for isolation. That divergence is structural, not duplication.

`compileBaseSections(profile)` combines static core and extension prompt sections.
Per-turn projection hooks resolve dynamic prompt content inside the extension
service context.

## Runtime

Core orchestration lives in:

- `packages/core/src/runtime/session-runtime.ts`
- `packages/core/src/runtime/agent/agent-loop.actor.ts`
- `packages/core/src/runtime/agent/agent-loop.behavior.ts`
- `packages/core/src/runtime/agent/agent-loop.state.ts`
- `packages/core/src/runtime/agent/turn-helpers.ts`
- `packages/core/src/runtime/agent/turn-response.ts`

Shape:

- `SessionRuntime` is the single public session engine.
- `AgentLoop` is an actor-backed internal control plane. There is no public
  `AgentLoop` service facade; `session-runtime.ts` talks to
  `agent-loop.actor.ts` directly. The actor entity id includes
  `(workspaceId, sessionId, branchId)`.
- Runtime commands resolve an existing `(sessionId, branchId)` target before loop dispatch.
- `AgentRunner` is the helper-agent boundary. Durable runs create persisted child sessions; ephemeral runs use isolated in-memory storage and only publish parent-side `AgentRun*` receipts.
- Durable child admission uses one shared ancestry check. Missing or incomplete
  ancestry is an error, not root depth. A parent at the depth limit cannot spawn.
  This check is not a concurrency or token budget and does not add child handles.
- `SessionRuntime.sendUserMessage` accepts an explicit completion mode. `admission`
  uses the existing persisted `SubmitDurable` actor operation and returns after
  enqueue. `turn` waits through `SubmitAndWait`. Omission preserves existing
  correlation-based behavior. Admission callers must reuse their command or
  request ID for retries. This provides a queue-owned start path without a new
  detached worker or scheduler; the child-handle API remains unfinished.
- Durable child creation accepts an optional admission request. The existing
  `SessionOperationStorage` records `agent.start` input and child IDs in the same
  transaction as the child session, branch, and spawn event. Repeated identical
  input returns the same child. Changed input fails. The receipt belongs to the
  parent branch, so deleting the child does not allow a retry to recreate it.
  Caller-owned transactions are rejected before admission.
- New durable start requests reserve at most four unfinished children per parent
  branch. The existing creation transaction verifies parent-branch ownership,
  reuses an existing receipt first, then checks capacity and creates the child.
  Capacity comes from stored start receipts without a matching completed user
  turn, not live actors. Unstarted and unknown outcomes retain reservations.
  A fresh runner sees the same count. This limit applies to the private durable
  start path, not legacy blocking or ephemeral runs, and is not a token budget.
  Deleting completion evidence does not silently release an uncertain reservation.
- The durable runner's private `start` operation joins child creation to
  `SessionRuntime.sendUserMessage` with admission completion. Its command ID is
  derived from the stable start request. The same receipt and command are reused
  on retry. It returns child session/branch IDs while the actor owns execution.
  It requires durable persistence and sets parent tool identity from the host
  input. This operation is not yet exposed to extensions or cells and does not
  implement child budgets.
- The durable runner's private `inspect` operation accepts the start request ID
  and parent session/branch. It checks the workspace-scoped receipt before child
  reads, then verifies child ancestry and branch ownership. It reads the exact
  admitted message's `TurnCompleted` event in the same read transaction. A later
  turn cannot replace this result. Missing completion means no recorded terminal
  receipt, not proof of a running actor. Inspection does not start or resume work.
  It returns the raw completion flags without claiming task success. The public
  child-handle facade and cell integration remain unfinished.
- There is no `wait` operation. A parent never blocks on a child. The private
  `list` operation reads the parent-owned child registry from the same durable
  start receipts, and `ChildCompletionDelivery` turns each child's terminal
  receipt into one idempotent follow-up message on the parent branch (see
  Agent Runs). The follow-up carries `wake`, so a parent branch with no prior
  turn still starts a turn to read it.
- The private durable `cancel` operation checks the same owned receipt and sends
  a stable steering command for the admitted message only. A stored completion
  makes cancellation a no-op. Caller transactions are rejected. The return value
  confirms durable command submission, not completed cancellation; `wait` reads
  the resulting completion. Processed targeted cancellation is retained before
  queue admission; the full child creation-to-enqueue restart check remains open.
- `Interject` steering never interrupts an open stream. The item is admitted to
  the durable steering queue; a running turn delivers it at its next safe step
  boundary (tool results stored, no stream open) by persisting the interjection
  as a transcript message before the next model call, so the same turn continues.
  Items with an agent override or run spec need their own turn profile and wait
  for the turn boundary, where steering still precedes queued follow-ups.
- Follow-up admission from inside a held side-mutation permit (a running turn, a
  tool invocation, an extension request) only appends to the durable queue. The
  turn starts from a wake that runs after the permit is released, or at the next
  turn boundary. `QueueFollowUp` carries an explicit `wake` flag; without it a
  branch with no prior history keeps the item queued until a real turn arrives.
- Orphan reconciliation: a stored tool result that has no terminal tool event
  (a recovered cell, a binding replay failure, a host that died mid-call) gets
  its `ToolCallSucceeded`/`ToolCallFailed` event from `reconcileToolProjections`
  when the result is persisted, before the turn reads the transcript for new
  model work. Clients replaying `ToolCallStarted` never keep a stale running
  projection. Ambiguous side effects are not replayed; the exact binding replay
  rules decide whether a native call runs again or fails.
- Narrow retry: `retryProviderCall` retries retryable provider failures with
  bounded exponential backoff plus jitter, and only before observable output.
  After partial output the partial assistant message stays, a durable
  continuation instruction (`<turn>:continuation:<step>`, `customType`
  `continuation`) follows it, and the same turn runs one more model step. Two
  continuations per turn; a further partial failure ends the turn as
  `streamFailed`.
- `Cancel` and `Interrupt` steering can include an expected message ID. Omission
  preserves branch-wide behavior. The worker checks the target before signaling
  and again when resuming an interaction. A local interruption permit serializes
  running-turn cancellation cleanup with turn completion and next-turn selection.
  It is separate from the side-mutation permit held by the running turn, so
  cancellation can stop active work without waiting for that work to finish.
- Targeted cancellation records `turn.cancel` in the existing workspace-scoped
  durable-operation table before the steering handler starts the branch owner.
  The receipt belongs to the child session/branch and survives until that branch
  is deleted. Repeated cancellation is idempotent; a conflicting owner fails.
  Turn entry checks this receipt before model work. It persists the user message
  and clears the in-flight queue marker once per turn, including early-cancelled
  turns, so cancellation has a stored message and terminal receipt. This does not
  replay cell source, and it does not prevent effects that ran before cancellation.
- Child cancellation also commits that intent before submitting steering, whose
  acknowledgement does not wait for its handler. Start and cancel share message
  submission from the saved start receipt and original command ID. This lets an
  admitted but unsubmitted child complete as interrupted without a model call.
  Retrying start or cancel does not create another child message.
- local CLI routing uses the shared server lock by default; remote routing is explicit server topology
- queue ownership is structural
- turn resolution streams through `LanguageModel.streamText` from `ModelResolver`, with durable stream/tool/finalization events derived from the response stream.
- New `TurnCompleted` receipts include `streamFailed`, including explicit false.
  Historical receipts can omit it; absence does not prove model success. The
  receipt commits with turn duration. This flag reports model failure only, not
  task success or a complete child outcome. Actor Idle is not completion proof.
- New turn-stream start/end receipts include the user-message ID and model-step
  number. Model, external, failure, and interruption paths keep that identity.
  Historical and forwarded ephemeral receipts can omit it and must not be treated
  as exact per-turn budget evidence. Token-budget enforcement remains unfinished;
  compaction invokes a separate model and needs accounting within the same policy.
- Response projection treats token usage as known only when both totals are
  nonnegative safe integers. Missing or invalid totals remain absent, not zero.
  Compaction uses the same conversion and stores reported usage plus model ID in
  the durable summary details. Summary reuse retains that receipt without another
  model call. Failed attempts and crashes before summary persistence still need
  durable attempt accounting; this metadata alone does not enforce a budget.
- interactions are cold machine states, not blocked fibers
- machine inspection events are published as diagnostics
- `AgentRunnerConfig` is a plain interface passed to `InProcessRunner`, not a service

Do not rebuild business logic from inspection events. They are receipts, not inputs.

### Agent Runs

- `AgentRunnerService` exposes durable `start`, `inspect`, `list`, and `cancel`
  beside blocking `run`. Start takes a stable request ID and exact parent/tool
  address, returns the child handle at once, and never returns the child's
  answer. The service closes storage/runtime requirements at construction and
  delegates to the existing durable child owner; it creates no worker or queue.
  Storage failures become `AgentRunError`. Inspect returns the original turn
  receipt, not a task-success assertion. List reads the parent-owned child
  registry (`durable_operations`), which survives restarts.
- `ChildCompletionDelivery` is the host's completion path. It watches the
  child's turn receipt and queues one ordinary user message on the parent branch
  (`follow-up:…:child:<requestId>:complete`, metadata `customType:
"child-completion"`) with the outcome, a bounded preview, and the saved output
  path, then publishes `AgentRunSucceeded` for the transcript. The follow-up
  message id is the idempotency key; delivery is serialized and watchers are
  deduplicated per request. Startup reconciles the registry: finished children
  are delivered, unfinished ones are watched again. No cell or tool waits for a
  child; the model reads completion on a later turn.
  `ExtensionContext.Agent` exposes these operations with host-owned parent IDs.
  Start requires a tool context and injects its tool-call ID. Requests can inspect,
  list, and cancel owned starts but cannot invent a tool identity to start work.
  The builtin `DelegateExtension` supplies one admission call, `delegate`, plus
  `agent-child` and `agent-children` as ordinary tools. Cells use `tools.call`;
  the bridge keeps permissions, bound generations, and operation receipts.
  `delegate` returns a tagged result: `completed` with the foreground child's
  output, or `running` with the handle of a `background: true` child admitted
  under the delegate tool-call ID. It accepts the existing RunSpec overrides for
  model, reasoning, tool selection, and added instructions. The host still fixes
  durable persistence and the parent/tool address. Control returns pending or
  the original completed-turn flags, not task success. Absent completion flags
  are omitted from the JSON result. For a recovered Unknown delegate operation,
  its inner toolCallId is the child requestId. The parent can inspect or cancel
  that start without rerunning cell source or issuing another delegation.
  Parents read child output through the existing `read_session` tool using the
  returned session and branch IDs. Omitting its extraction goal avoids another
  model call. This reads the session tree, not an exact-turn result snapshot.
  The extension is not in BuiltinExtensions yet. Default
  cutover remains unfinished.
- Admitted child sessions share a durable limit of 32 native-model resolution
  attempts across their branches. SessionOperationStorage reserves each attempt
  before model resolution, including the summary path. Reservations are not
  refunded after failure or interruption. The counter uses the existing durable
  operation store. An exhausted child produces a failed-turn receipt. External
  drivers are rejected for admitted children because their internal model calls
  have no accounting contract. Root sessions and legacy children without a start
  receipt are outside this limit. This is not a token or whole-subtree budget.
- The production root builds `SessionRuntime.Client` and `AgentRunnerService`
  before registering AgentLoop handlers. Encore's client-only actor layer uses
  the same cluster and memoized state registry as the handler layer. The handlers
  capture the completed service context, so recursive calls have an agent runner.
  Interaction recovery starts after handler registration. No second actor owner
  or scheduler is created. `SessionRuntime.Live` retains the combined test surface.
- Default persistence is durable.
- One shipped agent, `main`. A child spawned from a cell with `delegate` inherits the caller's agent and model; a run may narrow it with RunSpec overrides (model, tools, prompt addendum). Helper runs such as handoff distillation and `read_session` goal extraction pass `persistence: "ephemeral"` explicitly. An ephemeral run may pass `history: "inherit"` to seed its private branch with a copy of the parent branch's messages; `/btw` uses this for tool-less side questions that never write back to the parent.
- Persistent goals (`@gent/goal`) live in `~/.gent/goals/<branchId>.json`. After every uninterrupted turn while a goal is active, the goal `turnAfter` hook charges the turn's usage to the goal and queues a `goal-context` user message; a spent token budget flips the goal to `budget_limited` instead. Only the `goal` tool's `complete` action ends a goal. The TUI collapses `goal-context` rows to one line unless full detail is on.
- Durable runs persist a child session/branch and can be revisited with `read_session`.
- Ephemeral runs still execute a full local `AgentLoop`, but against isolated in-memory storage; they return text/usage/tool-call metadata without polluting the session tree.
- Child metadata reads only the requested branch. Stream totals remain unknown
  if any stored stream has missing or invalid usage, or if the sum exceeds safe
  integer precision. Explicit zero is retained; no stream receipts means unknown.
  These are reported stream totals, not full model-attempt budget accounting.
- Callers that need durable history must opt in explicitly with `persistence: "durable"`.

### Interactions (Cold Pattern)

Session snapshots and event replay use the same storage-backed event service,
including when SQLite runs in memory. `EventStore.Memory` is an explicit test
override, not the default for in-memory application sessions. This keeps the
snapshot cursor aligned with replayed navigation and interaction events.

Slow-client policy: `session-pubsub-registry.ts` gives each session one sliding
PubSub of event ids, not envelopes. Publishing never waits for a subscriber, so a
stalled client cannot block tool execution. `makeCursorReplayStream` opens the
subscription first, drains the durable store from the subscriber's cursor, and
drains again on every notification burst. Lost or coalesced notifications cost
one extra read, never an event, and replay and live delivery share one ordered
source, so there is no replay/live race. Both `EventStoreLive` and
`EventStore.Memory` use this path; `tests/domain/event-stream-delivery.test.ts`
proves the stalled-subscriber, race, and branch-filter properties for both.

Synchronization marker: a subscription opened with `synchronize` emits one
`StreamSynchronized` envelope after the replay drain and before the first live
event. Its id and `lastEventId` are the replay cursor, so a client that resumes
from the last id it saw neither skips nor repeats an event. The RPC
`session.events` stream always asks for it; in-process consumers that await a
specific event do not. The marker is never stored: both event stores reject it
in `append`. The TUI feed reads it as the end of replay and keeps it out of its
duplicate set, since it shares an id with the last replayed event.

One interaction primitive: `ctx.Interaction.approve({ text, metadata? })` → `{ approved, notes?, editedContent? }`.

Tools that need human input call `ctx.Interaction.approve()`, which delegates to
`ApprovalService`. The turn parks without keeping a blocked tool fiber. Cold
replay also requires a trusted, unchanged saved tool binding. A source-only tool
without durable identity can resume in the same loaded generation, but not after
an unsupported restart or replacement.

```text
tool calls ctx.Interaction.approve({ text, metadata? })
  → ApprovalService.present() checks for stored resolution (cold resume)
    → if found: returns { approved, notes?, editedContent? }
    → if not: persists to InteractionStorage, publishes InteractionPresented
      → InteractionPendingError thrown
        → machine parks in WaitingForInteraction (cold, no turn fiber)

client responds via respondInteraction RPC
  → storeResolution(requestId, { approved, notes?, editedContent? })
    → machine receives InteractionResponded
      → WaitingForInteraction → ExecutingTools
        → tool re-runs, calls ctx.Interaction.approve(), finds stored resolution
          → continues normally
```

**Event-driven UI.** The `@gent/interaction-tools` extension emits typed interaction events (`InteractionPresented` and friends on the session stream) and the client renders those directly. There is no `extensionSnapshots` cache and no projection mirror; source of truth is the storage row plus the durable interaction events (`derive-do-not-create-states`).

Key properties:

- **No Deferred, no blocked fiber.** `WaitingForInteraction` is a cold state — no background turn work. The machine is checkpointed and survives restarts.
- **Crash-safe resume.** `rehydrate()` rebuilds the in-memory context lookup and re-publishes the event. If the process dies before wake, `listPending()` in `InteractionStorage` provides the pending requests for recovery.
- **Exact replay.** Resume uses the saved assistant message, call ID, input, and
  binding. Completed sibling results are reused with their structured values.
  Only unfinished calls execute again. A pending call can repeat work before its
  interaction point; authors must make that work safe to repeat. This is not an
  exactly-once guarantee for arbitrary external effects.
- **Invalid replay.** Changed bindings and corrupt completed-result data fail
  explicitly. A paired failed result keeps later model turns usable. A corrupt
  completed result does not give permission to repeat the tool.
- **One binding policy.** `runtime/agent/tool-binding-resolution.ts` owns
  current capture, durable lookup, identity checks, and invalid local-binding
  cleanup for native, external, and direct tool adapters. A missing durable row
  permits only a same-process, same-generation capability with no durable
  identity. A local copy cannot replace a missing durable row. Dynamic durable
  markers cannot replay. Each adapter owns result persistence and interaction
  handling.
  `resolveStoredToolBinding` validates an already-owned durable identity without
  reading an assistant-message binding row. Native replay uses this same check.
  Inner-operation storage can use it without synthetic transcript tool calls.
  Its caller must verify receipt ownership and hold the publication lease.
- **Internal direct command.** `InvokeTool` is not a waiting turn. If its tool
  requests approval, the command closes the request, saves a paired failed result,
  and returns an explicit failure. Redelivery preserves that failure without
  running the tool again. Interactive tools use native or external session turns.
- **Permissions are not interactive.** Default-allow with explicit deny rules. `Permission.check` is a synchronous policy check, never blocks.

Files: `interaction-request.ts` (InteractionPendingError, makeInteractionService), `approval-service.ts` (ApprovalService), `interaction-pending-reader.ts` (pending storage read seam), `agent-loop.state.ts` (WaitingForInteraction), `interaction-commands.ts` (respond orchestration).

## Platform Boundaries

Core runtime should not reach for ambient process state unless the app shell is the real owner.

The Bun cell implementation in `runtime/code-cell/` is the shipped model
execution surface. `cell-extension.ts` declares the `@gent/cell` builtin with the
`cell` tool; core owns it because the turn resolver owns the `cell` surface rule. The server root composes it ahead of the extension package
builtins. Test presets that exercise host tools directly omit it. `cell-kernel.ts` owns serialized evaluate/reset operations,
evaluation deadlines, host-call dispatch, and worker disposal. Each evaluation
receives its host service from the caller's Effect context. Worker faults lose
working state; ordinary cell errors preserve it. No cell is automatically replayed.
`cell-process.ts` owns the worker process and its bounded pipes. The worker runs
with the host's working directory, environment, and OS permissions, the same
authority the bash tool grants, so cells use the full Bun runtime, `require`,
and dynamic `import` directly. Protocol frames travel on dedicated descriptors
(3 worker to host, 4 host to worker); the worker keeps stdout and stderr for cell
output. Each Evaluate carries an unpredictable output token; after the cell the
worker writes an end-of-cell marker carrying that token to both streams and only
then sends the result frame. The host returns the cell once both marks arrived,
so the text before them belongs to that cell in full. A marker with any other
token is ordinary text. Each stream is complete and ordered on its own; stdout
and stderr are not ordered against each other. Writes after the marks (such as a
lingering child process) are dropped when the next Evaluate is sent, and writes
after that belong to the next cell. The output returns
ahead of the cell's display, as Prime Agent's kernel does; a bounded prefix also
serves as diagnostics when the worker fails. Cells evaluate in the worker's
own realm, so the process is the isolation unit. This is not
a second agent engine or persistence owner. After a fault, only explicit reset
can replace the worker. Each kernel permits three replacement attempts by
default, including failed starts. Close cancels active work and waits for its
cleanup. The Gent policy bridge and other platform isolation remain unfinished.

The core build compiles `runtime/code-cell/main.ts` into `dist/gent-cell`.
Turbo builds that declared dependency before the TUI copies the worker into
`bin/gent-cell` beside `bin/gent`. Core owns the worker build; the TUI only
packages it. The worker embeds Bun and needs no external Bun executable. Its
compile options disable automatic dotenv, bunfig, tsconfig, and package.json
loading. The process launcher uses this artifact as both its runtime
and worker path. Turbo caches core's `dist` output and both TUI binaries. The
TUI task hashes its build script. Run the root build for dependency ordering.
This is a packaged worker, not a daemon or a new session owner.
`GentPlatform.cellWorkerPath` selects the worker without opening it. The compiled
host uses its sibling `gent-cell`. Source runs use core's `dist/gent-cell`, resolved
from the platform module, not cwd or the Bun executable. Source runs need the core
build first. The TUI build sets the compiled-host marker explicitly.
`agent-loop.behavior.ts` builds `CellExecution.Branch` in the existing loop scope
and supplies it to turn execution. Each branch owns a separate service and lazy
worker. Closing the loop scope closes that worker. Source runs have no
build artifact, so builtin tools carry no durable identity there; cells record a
`ProcessLocal` binding that names the live resource generation instead. Such an
operation resumes only inside that generation and is rejected with
`SourceMismatch` after a restart or replacement. Compiled hosts keep durable
artifact identities. The existing interrupt
command now also calls the branch cell service's cancellation operation. It
signals active evaluation and waits for cleanup. Cells queued before cancellation
cannot evaluate; the branch interrupt flag also stops later calls in that turn.

Inner calls a cell admits publish the ordinary tool events with a
`parentToolCallId` naming the cell. `cell-operation-receipt.ts` attaches compact
receipts (`tool`, `outcome`, `summary`) to the saved cell result whenever a cell
made inner calls, so the transcript keeps effects visible after reload. The TUI
nests live inner calls under the cell, counts them in the compact tree, and shows
receipts in the `cell` renderer. The headless runner indents nested calls.

When policy selects `cell` for a native model turn, only `cell` is advertised.
ResolvedTurnContext keeps separate model and host binding maps. Both derive from
the same policy result. The full host map supplies cell callbacks and recovery;
the outer map cannot directly dispatch unadvertised host tools. Tool discovery
returns the selected declaration's input schema and usage guidelines. External
drivers and turns that do not select `cell` keep their existing tool surface.
Cancellation saves a failed outer receipt without replaying source. An active
worker loses state and requires explicit reset; a cell stopped before evaluation
reports that it did not start. The steering RPC still acknowledges durable
delivery, not completed cancellation. Clients observe completion through events.

`storage/cell-execution-storage.ts` provides outer cell admission in the existing
SQLite database. A claim must refer to one `cell` call in an assistant message
owned by the current workspace, session, and branch. Only the first claim returns
the stored source for evaluation. Repeat claims return the saved tool result or
`Incomplete`; that state does not prove a live worker and never permits another
evaluation. Results are immutable. Receipts cascade with their assistant message.
Admission rejects a caller-owned SQL transaction so its claim commits before
external effects start. Cell execution must remain outside SQL transactions.
`runtime/code-cell/cell-execution.ts` joins this store to the real kernel. Each
layer fixes one session and branch. It serializes admission, evaluation, result
storage, and reset. It opens a worker only after a fresh claim. Saved results and
incomplete claims do not start a worker. Initial startup failures consume the
same bounded replacement budget as later worker failures. Interruption leaves
the claim incomplete; the next call reports a typed unknown outcome without
running the source again. A saved result does not restore VM working state.
Inner operation bindings and durable approvals use the stores described below.

`runtime/agent/current-tool-call.ts` carries the transcript-owned call address
and the turn's selected tool bindings.
The shared turn dispatcher supplies it for each bound tool invocation, including
explicit tool invocation. `runtime/code-cell/cell-dispatch.ts` uses that address
and the current live turn publication to enter branch-owned cell execution.
It does not search messages or accept a call address from model input. It rejects
an inner host operation that attempts to dispatch another outer cell. Missing
branch ownership or recorded turn context returns an `AgentLoopError`, not a
missing-service defect. The RPC test catches a nested-dispatch rejection inside
the worker and verifies that the attempted source did not change retained state.
The RPC lifetime test uses this adapter and checks two identical sources in one model
response. Each source runs once and receives a distinct result receipt.
`runtime/code-cell/cell-tool.ts` now declares the cell tool and is exercised by
this RPC test. It is not installed in the default profile yet. It returns saved
JSON success data or fails with the public `ToolResultFailure` type. The normal
tool runner preserves that failure's JSON data and still supplies transcript
identity itself. The type cannot select a call ID or tool name. Permission checks
and preflight hooks still run before execution. The cell declaration maps worker
suspension back to the original pending interaction for the actor. The fresh
approval RPC test checks allow and deny through the real compiled worker. The
host tool restarts at its approval boundary and records one decision. The outer
source does not restart or continue after approval. Recovery returns the saved
operation results in a failed outer result with visible worker state loss.

The shared `domain/cell-input.ts` schema accepts optional `reset: true`. Admission
reads this flag from the stored assistant call. After a fresh claim commits, the
branch execution permit covers reset and evaluation together. Completed or
incomplete calls do not reset the worker. A repeated reset call returns its saved
result without clearing newer working state. Cancellation checks run before reset.
Reset uses the existing worker reset and bounded replacement path; it does not
replay old source or erase operation receipts.

Fresh cell host calls select only from the supplied turn bindings. They do not
search the full extension registry by name. Thus an agent-denied tool cannot be
reached through a cell, and a newly registered replacement cannot replace the
captured capability. The host still enters the current publication and checks
permissions before execution. The RPC lifetime test verifies a registered but
agent-denied tool receives no calls. Catalog discovery must use this selected
set. Default cutover must retain a host binding set when the advertised model
surface narrows to `cell`; it cannot reuse a cell-only advertised map for discovery.

The catalog is instruction plus data, not a tool. When the surface narrows to
`cell`, `buildTurnPromptSections` adds a `cell-catalog` section that lists every
selected host tool with its prompt snippet or description; the section is
rebuilt each turn, so live composition changes reach the model as ordinary
instruction changes. `runtime/code-cell/cell-catalog.ts` builds the data half
from the same selected map: name, description, guidelines, and the actual Effect
AI input schema, hashed over its encoding. `dispatchCell` hands it to the cell
host; `cell-kernel.ts` sends it inside `Evaluate` only when the hash differs
from what the current worker holds, and clears that memory when a replacement
worker starts, so the first cell on a new worker carries the full catalog. The
worker keeps the catalog beside the namespace: `reset` clears bindings, not the
catalog, and a snapshot never contains it. Inside the cell `tools.search(query,
offset)` and `tools.describe(name)` are local synchronous reads over that data,
20 names per page with a next offset; they record no operation receipt and grant
no execution permission. The RPC lifetime test checks the search set and a host
schema through the compiled worker, and that a later cell without a catalog
still describes the tool. An agent-denied tool and the outer `cell` are absent
from search.

Tool dispatch accepts separate outer and host binding maps. Normal turns supply
the selected map for both. Recovery validates pending outer calls against their
saved binding identities. If an outer cell was never admitted, recovery also
resolves the current agent policy to obtain its host set. It does not limit that
set to pending outer call names or search the unrestricted registry. If current
policy removes `cell`, the replay dispatcher receives no outer cell binding and
returns a failure without executing it. Already admitted cells still use saved
operation recovery and never evaluate their source again.

`runtime/code-cell/cell-tool-call.ts` adapts one already-bound host call to
`ToolRunner.runBound`. It requires an explicit `Permission` service and does not
resolve a missing binding by name. The caller still owns the durable operation
receipt and publication lease. Execution returns the original tool result.
A separate result conversion runs after persistence and maps failures to cell errors.
`CellToolCallSuspended` instead carries the pending interaction and inner call
identity out of evaluation. The kernel stops and discards the worker; it does
not send that signal to cell JavaScript as a catchable error. Recorded execution
preserves the suspension and leaves its outer claim incomplete. Durable inner
operation resume uses the recorded host below; suspension never authorizes cell replay.

`storage/cell-tool-operation-storage.ts` records inner operations under an
admitted outer cell in the same SQLite database. The operation's input, tool
binding, and derived tool-call ID are immutable. Its state is Started, Waiting,
Resuming, or Completed. Repeated admission never grants another execution.
Resume requires the exact waiting request and a valid saved approval decision.
It commits Resuming before tool execution; that state cannot be reclaimed after
a crash. A unique request link prevents two operations from sharing an approval.
The existing interaction service still owns the request and decision. Completed
cells cannot admit or resume more host effects. Message deletion cascades to
these receipts. Suspension persists a new approval through InteractionStorage
and links its operation in one transaction. It rejects caller transactions and
completed cells. The production approval callback uses this operation when the
host supplies CurrentCellToolOperation. ApprovalService validates that owner and
selects only its saved resume request. A fresh operation cannot consume a branch
decision. The existing one-pending-request-per-branch constraint stays in place.
The cell host supplies this address from admitted operation storage and validates
the recorded binding under its publication lease.
The store does not itself run tools or restore a worker continuation.

`runtime/code-cell/cell-tool-host.ts` joins fresh inner-operation admission to
the tool adapter. It enters the existing live turn publication lease, captures
the exact capability, and requires a source identity before admission. It gives
the approval service the host-owned operation address. It saves the original
tool result before returning a JSON value or failure to the cell. Equal completed
calls reuse their receipt; unfinished calls report an unknown outcome and never
run again. `resumeCellToolOperation` enters the selected live publication, reads
the owned operation, and validates its saved binding with the shared replay
policy before committing one resume attempt. It executes only that inner call
with its saved input and identity, then stores the original result. It never
evaluates outer cell source or restores the worker stack. Concurrent or repeated
resume attempts cannot execute the same waiting operation twice. Initial model
dispatch does not select this host yet. Saved turn recovery does.
`CellToolOperationStorage.listForCell` provides the durable recovery input for
that integration. It checks workspace, session, branch, and the admitted outer
call. It returns all operation receipts without granting another execution.
The branch phase is held in memory; queue storage persists the in-flight item,
not the complete Running state. Recovery must use stored cell receipts rather
than depend on a new field in that transient phase.

`runtime/code-cell/cell-recovery.ts` builds the paired outer result after the
branch owner has stopped cell execution. It preserves undecided approvals,
resumes only waiting operations with saved decisions, and reuses completed
receipts. Started or Resuming operations remain unknown; recovery does not
execute them again. Its saved outer result reports lost worker state and lists
completed tool results separately from unknown operations. Repeated recovery
returns that result. This adapter has no evaluator call. Callers must not run
recovery beside an active cell.

`agent-loop.turn-execution.ts` routes admitted saved cell calls through this
adapter before native binding replay. `CellExecutionStorage.get` reads admission
without creating it. Unadmitted calls keep the native path. Recovery requires a
live publication. A suspended inner operation parks the actor with the outer
cell call ID and the original request ID. After the response, the existing turn
worker resumes recovery. Recovered cell results join native sibling results in
one complete transcript message; no partial message marks the step complete.
The branch runtime context supplies the existing storage services. This does not
add a worker, runtime owner, or model-facing cell dispatch path.

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

- extension shape: `defineExtension`, `GentExtension`, `ExtensionHost`,
  `registrationDomains`;
- typed leaves: `tool`, `request`, `ref`;
- scoped resources: `defineResource`, `defineStateResource`, `ResourceId`,
  `ResourceRevision`, and resource scope types;
- turn hooks: the public hook input/output types needed to author
  `host.on(kind, handler)`;
- agents and model ids: `defineAgent`, `AgentName`, `ModelId`, run-spec
  helpers needed for turn-scoped subagent dispatch;
- stable ids and author-facing schemas: `ExtensionId`, `ArtifactId`,
  `ToolCallId`, `PermissionRule`, output/message projection
  helpers that are safe to serialize across the extension boundary;
- host facts: `ExtensionHost.host` and `ExtensionHost.Process`, a small public view over
  host-owned platform facts such as OS info, executable path, home directory,
  command candidates, and loopback port probes;
- author-facing errors: capability, provider-auth, agent-run, and typed
  transition errors that extension code can intentionally return or inspect.

Everything else is builtin/internal:

- raw runtime host context and hook plumbing (`ExtensionHostContext`,
  `ToolExecuteInput`, `ProjectionTurnContext`, permission/context message
  internals);
- storage, event publisher, event store, session mutation services, and
  interaction pending readers;
- runtime/platform services and helpers (`GentPlatform`, `ToolRunner`,
  `ExtensionEventSink`, `runProcess`);
- agent loop/session runtime internals and process runners that are only host
  implementation details;
- raw event/message domain internals that are not part of the serialized
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
- declaration setup and validation failures exclude the affected extension;
  resource start failures reject the live graph publication
- stateful side effects cross explicit typed slots (`host.on` hooks, resources,
  or extension-owned services), not private host imports

For the full authoring guide, see [docs/extensions.md](docs/extensions.md). Example extensions in [examples/extensions/](examples/extensions/).

### Server Extensions

One authoring shape: `defineExtension({ id, setup })`. `setup` is an Effect that yields `ExtensionHost` (`packages/core/src/domain/extension-host.ts`) and calls `host.register(domain, ...values)` for leaves (`tool`, `request`, `resource`, `job`, `agent`, `modelDriver`, `externalDriver`) and `host.on(kind, handler)` for hooks. Setup-time host facts (`cwd`, `home`, `source`, `host`, `Process`) live on the same service; runtime host authority comes from `yield* ExtensionContext`. The domain string IS the discriminator — TypeScript checks the value type per domain at the call site. The loader (`runtime/extensions/loader.ts`) provides a collecting host, seals the registrations into `ExtensionContributions`, binds requests to the extension id, and runs `validateExtensionPackage` so malformed registrations fail activation instead of dispatch.

There is no flat `Contribution[]` and no `_kind` discriminator. `ExtensionContributions` (`packages/core/src/domain/contribution.ts`) is the compiled record consumed by the registry, hook compiler, and resource graph; adding a new kind means adding a registration domain and a record field, not a new union arm. Extensions have no per-extension `Scope`: the live profile re-runs `setup` on refresh and the resource graph owns acquisition and release.

- **Resource** — `defineResource({ id, revision?, requires?, required?, scope, layer?, start?, stop? })`. Long-lived state has a stable identity and explicit `scope`; `revision` records resource semantics, including configuration changes, and defaults to `"1"`; `requires` defaults to `[]`, and `required` defaults to `false`. Today only `"process"` is public, because it is the only lifecycle with a host owner. `cwd`, `session`, and `branch` lifetimes stay out of the author API until their runtime owners exist. Stateful extension logic is either a normal scoped service/resource or, for true actor protocols, an Effect Entity/RPC owner at the runtime boundary. See `packages/core/src/domain/resource.ts` and `runtime/extensions/resource-host/`.
- **Callable leaves** — `tool(...)` / `request(...)` smart constructors registered under the `tool` and `request` domains. `tool` = model-facing tool; `request` = typed extension RPC, optionally decorated with `slash: { trigger?, name, description, category?, keybind? }` to surface as a human slash command. Handlers receive input only. Host authority comes from the `ExtensionContext` facade (`Session`, `Agent`, `Interaction`, `Process`, `Files`, `FileLock`, `State`); extension-private authority comes from extension-owned Effect service Tags. The `Files` / `FileLock` / `State` facets wrap the host-internal `FileIndex`, `FileLockService`, and `ExtensionStatePublisher` so shipped and external extensions share the same surface. See `packages/core/src/domain/capability/{tool,request}.ts`; `runtime/extensions/registry.ts` compiles the model, RPC, and slash registries.
- **Hooks** — `host.on("systemPrompt" | "turnProjection" | "turnAfter" | "toolCall" | "toolResult", handler)` registers the explicit runtime hooks; each kind is typed by `ExtensionHookSignatures`. Hooks, tools, and requests all cross one membrane: `provideExtensionLeaf(frame)` in `runtime/extensions/extension-effect-membrane.ts` reads the run's `CurrentExtensionHostContext` and provides `ExtensionContext`; the turn projection is an input to `resolveTurnProjection`. Hook handlers receive event input only and yield `ExtensionContext` or extension-owned service Tags when they need authority. `turnAfter` carries the turn's token usage. See `packages/core/src/domain/extension.ts` and `runtime/extensions/extension-hooks.ts`.
- **Driver** — the `modelDriver` and `externalDriver` domains take `ModelDriverContribution` and `ExternalDriverContribution`. Model drivers provide LLM provider layers + auth; external drivers stream Effect AI response parts from process-owned executors. See `packages/core/src/domain/driver.ts` and `runtime/extensions/driver-registry.ts`.

Other notes:

- Lifecycle effects live on Resources as `start` / `stop`. A failed start
  rejects publication and closes newly acquired resources. First activation
  leaves no cache entry. A failed replacement after retirement leaves no
  active publication; it does not restore retired authority. Validation failure
  before retirement preserves the previous publication. A missing optional
  provider suspends affected extensions through the resource plan.
  Scheduler failures remain extension health diagnostics. The graph host
  owns resource stop order and scoped cleanup.
- Prompt shaping, input normalization, permission policy, and turn hooks are explicit runtime slots compiled from extension hooks and typed leaves, not generic middleware buckets.
- Agent override is turn-scoped via `QueuedTurnItem.agentOverride`, not persistent `SwitchAgent`.
- `createSession` accepts optional `initialPrompt` + `agentOverride` for atomic create-and-send.

### EventPublisher

`EventPublisherRouterLive` (`server/event-publisher.ts`) dispatches through per-cwd profiles. For a single-cwd run the profile is resolved once at boot; for multi-cwd server topologies the router resolves lazily per cwd and fans out to the correct extension runtime. Transport-level broadcast (session stream, WebSocket push) is cwd-agnostic; only the extension runtime dispatch is per-cwd.

### TUI Extensions

- Builtins are individual `.client.{ts,tsx}` files in `apps/tui/src/extensions/builtins/`
- Each follows `ExtensionClientModule` contract — same pipeline as user/project extensions
- Loader (`apps/tui/src/extensions/loader-boundary.ts`) accepts `disabled` list to filter extensions by id before `setup` runs
- One `setup` shape: Effect-typed `Effect<ClientContribution[], E, R>`. Setups yield from the per-provider `clientRuntime`, which provides `FileSystem | Path | ClientTransport | ClientWorkspace | ClientShell | ClientComposer | ClientLifecycle`. There is no imperative `ctx` argument, no sync `(ctx) => Array` arm, and no package wrapper around paired server/client modules. Shared server/client artifacts use `defineExtension({ client })`; TUI-only artifacts use `.client.{ts,tsx}` modules.
- Widgets are transport-only: subscribe to `ClientTransport.onSessionEvent` for event-backed invalidation or `ClientTransport.onExtensionStateChanged` for explicit extension-state notifications, then call typed extension RPC via `ClientTransport` for current state. Each widget owns its own Solid signal, keyed on `(sessionId, branchId)` so a stale model from the prior session never renders. See `apps/tui/src/extensions/builtins/artifacts.client.ts` for the canonical pattern.
- `ClientLifecycle.addCleanup` registers Solid `createRoot(dispose)` disposers and event unsubscribes; the provider's `onCleanup` reaps them on unmount, so widget setups leave no detached roots behind.
- `ClientLifecycle.scoped` allocates Effect resources in the client-provider lifetime. The main TUI scope awaits provider disposal before process exit.
- `ClientActivity` exposes a reactive view of the active UI session and its working, blocked, idle, or unavailable state. Headless clients do not provide an activity accessor.
- `@gent/herdr` is a built-in client extension. It reports that UI activity through Herdr's local socket when `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID` are present. It sends ordered reports with the session ID and releases its authority on exit. The shared server and child agents do not own this reporter.
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
- TUI widgets that derive state from events subscribe with `ClientTransport.onSessionEvent` and refetch their typed extension RPC when relevant event tags arrive. `@gent/artifacts` is the canonical event-backed widget.
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
├── extensions/    # api, registry, compile-tool-policy, hooks, loader, ...
├── providers/     # provider, provider-auth, provider-resolution, anthropic-keychain
├── runtime/       # session-runtime, agent-loop, retry, agent-runner, tool-runner, ...
├── server/        # rpcs, session-queries, system-prompt
├── storage/       # sqlite-storage, search-storage
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

Workflow commands (`/plan`, `/review`, `/audit`, `/counsel`, `/research`) live in `@gent/workflows` as prompt recipes: each queues a follow-up that composes `delegate`, `artifact_save`, `prompt`, and `repo` from one cell. There is no orchestration code for them; the model runs the recipe and saves the result with the matching `sourceTool`.

### Test Utilities

- `withTinyContextWindow(effect)` — patches `MODEL_CONTEXT_WINDOWS` to 5k tokens for threshold tests
- `trackingApprovalService()` — returns `{ layer, presentCalled: Ref<boolean> }` for approval assertions

Both exported from `@gent/core-internal/test-utils/e2e-layer`.

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
