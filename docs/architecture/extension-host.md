# Extension host

Extension shape lives in:

- `packages/core/src/extensions/api.ts` — public authoring surface (`defineExtension` + smart-constructor re-exports)
- `packages/core/src/domain/extension.ts` — `ExtensionContributions` typed-bucket carrier (core primitives only)
- `packages/core/src/domain/extension.ts` — server contract (`GentExtension`, `ExtensionSetupServices`)
- `apps/tui/src/extensions.ts` — public client authoring surface (`@gent/tui/extensions`); every shipped client extension imports the TUI only through it
- `apps/tui/src/extensions/client-facets.ts` — TUI-owned client facet model
- `packages/core/src/runtime/extension-host.ts` — server registry
- `packages/extensions/src/` — shipped extension implementations
- `apps/tui/src/extensions/` — TUI discovery, loading, resolution

## Dependency direction

```text
apps/tui, packages/sdk
    ↓               ↓            ↓
@gent/extensions → @gent/core
                    (no reverse dep)
```

Core never imports from extensions. Composition roots (apps, SDK) pass `BuiltinExtensions` into `DependenciesConfig.extensions`.

## Extension boundary contract

Extensions may import from:

- `@gent/core/extensions/api` — the authoring surface
- `@gent/core/extensions/branch-tools` — the branch-tool entry
- `effect`, `effect/*`, `@effect/*` — as peer deps. A user or project
  extension run by the compiled binary resolves only the ones listed below.

Extensions may NOT import Gent domain, runtime, storage, server, or provider
internals, nor the `@gent/core/host` and `@gent/core/test-utils` entries. The
`core-entry-boundary` oxlint rule enforces this for shipped and reference
extensions, and the same rule defines the contract for user/project
extensions. The same rule keeps `@gent/core/test-utils` out of product code:
only tests, `packages/e2e/`, and the harness itself read it, by package
specifier or by a relative path that resolves into it. Nothing outside
`packages/core/`, tests included, reads core source by relative path. A test
that needs host state arranges it through a `test-utils` operation. A `host`
name needs a product caller. "Builtin" means "included in the default distribution", not
privileged.

TUI client extensions may also import shared client data from `@gent/core/protocol`. This exception does not apply to server extension implementations or to nested protocol paths.

The loaders enforce the same contract at runtime. The compiled binary has no
node_modules and runs with `--no-install`, so a user or project extension
resolves only a specifier a loader binds to the module the process already
runs (`GentPlatform.bindModules`, a Bun runtime plugin). It gets the same Tags
and Schema classes as a shipped extension, and an unbound specifier is never
fetched from npm. The bound specifiers are exact:

- Every extension file: `@gent/core/extensions/api`,
  `@gent/core/extensions/branch-tools`, `effect`, and each `effect/*` module
  that `packages/extensions/src/` or `examples/extensions/` imports, bound by
  the server loader (`extensionEntryModules`, `runtime/extension-host.ts`) and
  by the TUI loader. `effect` is core's own dependency, so the test harness,
  which binds only core's map, resolves them as production does.
- The `@effect/*` packages the shipped extensions import:
  `BuiltinExtensionModules` in `@gent/extensions`, bound by the SDK server
  root before it loads extensions. It holds each `@effect/*` specifier that
  `packages/extensions/src/` or `examples/extensions/` imports, and no other.
  `packages/extensions/tests/index.test.ts` derives both sets from the sources
  and fails when core's `effect` entries or this map differ, so a shipped
  extension never reads a module a user extension cannot. A user extension is
  as capable as a shipped one.
  The provider SDKs (`@effect/ai-anthropic`, `-openai`, `-openai-compat`,
  `-typesafe`) bind lazily: a shipped driver imports its SDK at its first model
  build, and a user extension's import loads it then too, so a launch does not
  evaluate their generated schemas (compiled launch module evaluation 122 ms
  to 79 ms). A binding loads its SDK through the `#unbound/*` alias in
  `packages/extensions/package.json`: once bound, the SDK's own name resolves
  to the binding, which would import itself.
- Client files only: `@gent/core/protocol`, `@gent/tui/extensions`,
  `@gent/extensions/client` (the shipped extensions' RPCs, ids and message
  types), `solid-js`, `solid-js/store` and `@opentui/solid`. A test in
  `apps/tui/tests/extensions/loader-boundary.test.ts` reads every `@gent/*`
  specifier the shipped client files import and fails on one the loader does
  not bind, so a shipped client never reads a module a user client cannot.
  Bun resolves a bare import
  from a runtime plugin without the importer, so these are bound under a prefix
  drawn for each TUI load. The TUI loader compiles each `*.client.*` file with
  `Bun.build` and the OpenTUI Solid transform, and renames these imports to the
  prefixed names in the file, in the relative modules it imports, and in the
  packages it bundles. A server extension in the same process imports
  `@gent/core/protocol` and gets "Cannot find package".

Nothing else resolves, internal entries such as `@gent/core/host` included.

## Extension API Inventory

`@gent/core/extensions/api` is the extension API. Anything an extension needs
must either live here as a stable authoring primitive or move behind a
host-owned design. It should expose:

- extension shape: `defineExtension`, `GentExtension`, `ExtensionHost`;
- typed leaves: `tool`, `request`, `defineRequests`, `ref`;
- scoped resources: `defineResource`;
- turn hooks: the public hook input/output types needed to author
  `host.on(kind, handler)`;
- agents and model ids: `AgentDefinition`, `AgentName`, `ModelId`, run-spec
  helpers needed for turn-scoped subagent dispatch;
- stable ids and author-facing schemas: `ExtensionId`,
  `ToolCallId`, output/message projection
  helpers that are safe to serialize across the extension boundary;
- host facts: `ExtensionHost.host`, a small public view over host-owned
  platform facts such as OS info, executable path, and home directory;
- `runProcess` / `ProcessError`: the one command helper over the Effect
  `ChildProcessSpawner`;
- `GentPlatform`: the gent member of the platform services every root gives
  an extension (host facts, the image codec, and `loopbackServer`, the
  listener the OpenAI and MCP sign-in redirects take); the layers that build
  it stay on the host entries;
- `saveToolImage` / `ToolImage` / `ToolImageError`: a tool's image, scaled
  to fit the fixed limits, stored
  once by content (`<data dir>/blobs/<sha256>.<ext>`) and returned by
  reference in its output (`packages/core/src/runtime/tool-image.ts`).
  Storage counts each blob's references (`tool_image_references`, one row
  for each stored message that holds the image, written in the message's
  transaction and removed with it), and a server start removes only a blob
  no stored message references and nobody used for a day. With no lock
  across servers, the sweep moves a candidate aside with one rename and
  checks its time and references again: a save that reused the blob before
  the move brings it back, and a save after the move writes it again;
- author-facing errors: load, driver, provider-auth, service, process and
  interaction errors that extension code can intentionally return or inspect;
  an error only tests read (the capability errors) stays in core, where core
  tests import it by relative path.

Everything else is builtin/internal:

- raw runtime host context and hook plumbing (`ExtensionHostContext`,
  permission/context message internals);
- storage, event publisher, event store, session mutation services, and
  interaction pending readers;
- runtime services (`ToolRunner`);
- agent loop/session runtime internals and process runners that are only host
  implementation details;
- raw event/message domain internals that are not part of the serialized
  authoring contract;
- the extension registry's driver maps and provider auth persistence machinery;
- test-only helpers such as raw metadata tags and fixture constructors.

Rules:

- registration shape is structural — builtins, user, and project extensions share the same setup path
- builtins are only the initial extension set — app code consumes registry or
  transport projections instead of privileged `@gent/extensions` registries
- dispatch compiles once, then runs from typed registries and explicit runtime slots
- public snapshot schema is enforced at runtime — invalid snapshots are dropped, not passed through
- declaration setup, validation, and process-resource build failures exclude
  the affected extension; a branch-resource build failure fails its loop
- stateful side effects cross explicit typed slots (`host.on` hooks, resources,
  or extension-owned services), not private host imports

For the full authoring guide, see [docs/extensions.md](../extensions.md). Example extensions in [examples/extensions/](../../examples/extensions/).

## Server Extensions

One authoring shape: `defineExtension({ id, setup })`. `setup` is an Effect that yields `ExtensionHost` (`packages/core/src/domain/extension.ts`) and calls `host.register(domain, ...values)` for leaves (`tool`, `request`, `resource`, `agent`, `modelDriver`, `apiClass`, `modelRouter`) and `host.on(kind, handler)` for hooks. Setup-time host facts (`cwd`, `home`, `host`) live on the same service; runtime host authority comes from `yield* ExtensionContext`. The domain string IS the discriminator — TypeScript checks the value type per domain at the call site. Bun loads a user `.ts` extension with no type check, so `register` also checks the domain at run time: an unknown one, such as the bucket name in `register("tools", t)`, fails the load with a message that names it, the near miss, and the domains. The loader (`runtime/extension-host.ts`) provides a collecting host, seals the registrations into `ExtensionContributions`, binds requests to the extension id, and runs `validateExtensionPackage` so malformed registrations fail activation instead of dispatch.

There is no flat `Contribution[]` and no `_kind` discriminator. `ExtensionContributions` (`packages/core/src/domain/extension.ts`) is the compiled record consumed by the registry, hook compiler, and profile build; adding a new kind means adding a registration domain and a record field, not a new union arm. Each extension's process resources build once into their own child of the profile scope, which owns acquisition and release.

- **Resource** — `defineResource({ id, scope, layer })`. Start work runs in the layer build and disposal is a finalizer in it. Long-lived state has a stable identity and explicit `scope`; resources build in extension resolution order. `scope` is `"server"` (built once per server for each extension version and shared by every place's profiles, released when the last holder retires), `"process"` (built per place over the server builds its profile holds, shared by that place's profiles that hold the same builds, released when the last holder retires) or `"branch"` (built per branch loop, released when the loop closes). Stateful extension logic is either a normal scoped service/resource or, for true actor protocols, an Effect Entity/RPC owner at the runtime boundary. See `packages/core/src/domain/extension.ts`, and `holdResources` and `buildScopeResources` in `runtime/extension-host.ts`.
- **Callable leaves** — `tool(...)` / `request(...)` smart constructors registered under the `tool` and `request` domains. `tool` = model-facing tool; `request` = typed extension RPC, optionally decorated with `slash: { trigger?, name, description, category?, keybind? }` to surface as a human slash command. Handlers receive input only. Host authority comes from the `ExtensionContext` facade (`Session`, `Interaction`, `FileLock`, `Models`, `State`); files, paths, processes, and ids come from the Effect platform services (`FileSystem`, `Path`, `ChildProcessSpawner`, `Crypto`); extension-private authority comes from extension-owned Effect service Tags. The `FileLock` facet wraps the host-internal `FileLockService`, the `Models` facet the `DecisionModelResolver`, and the `State` facet publishes `ExtensionStateChanged` on `EventStore`, so shipped and external extensions share the same surface. See `packages/core/src/domain/capability.ts`; `runtime/extension-host.ts` compiles the model, RPC, and slash registries. A request that fails answers the client with the extension's own reason as the `ExtensionProtocolError` message (a handler's error message, or `"<extension>" has no request "<id>"`), with no loop or runtime wrapper; the TUI shows a failed slash command as `/<name> failed: <reason>` on the status row.
- **Addressed session verbs** — `ExtensionContext.Session` reaches other branches through the same verbs the server uses: `create` (durable-once by `requestId`, optional `historyBranchId` copies the visible rows in, depth admitted by the host), `forkBranch` (a branch of the run's own session that holds the messages up to `atMessageId`, the rewind the client's `branch.fork` makes, over the same `SessionMutations.forkSessionBranch`; durable-once by `requestId`; the old branch keeps every message and the active branch does not move), `send` (one user message with a `delivery` mode: `"turn"` starts a turn on another branch with the loop `completion` modes, and the own branch refuses it and points at `"queue"`; `"queue"` is a follow-up keyed by `sourceId`, and with `ifLatest: <messageId>` a conditional one: `LoopInbox.admit` admits it only while the loop can start a turn, its queue is empty (no parked steer, follow-up or item in flight) and that id is still the branch's newest step (`latestStep`: the newest user-role message that is not a runtime row or a joined steer), and then reserves the start at once (`admitAndBegin` on the own branch, so a caller that holds the side-mutation permit does not wait for the start), all under the queue permit; the same transaction stores the item in the queue's in-flight slot, because an accepted line is a promise: the caller may forget its own record (`@gent/wake` drops its alarm row) as soon as `send` returns, so a restart before the turn stores its message runs the item once from that slot (`wantsWakeOnRecovery`, or `incompleteUserTurn` once the message is stored), with no new test of `ifLatest`, and the turn clears the slot when it stores the message; otherwise it admits nothing, as a repeat does; `"steer"` joins the running turn as an `Interject`), `stop` (writes a `Cancel` steer that stops the running turn, whichever message opened it; `Interrupt` has no writer and only decodes), `stopMessage` (the persisted `StopMessage` actor operation, through `stopMessageOn`: it records the durable cancellation of one message id, so a turn that message opens later starts interrupted, takes back a steer with that id that no step has read, and interrupts the running turn that message opened. A step's join of steers and the take-back hold the same queue permit, so a message is either joined or taken back, never both. It answers true only when this stop reached the message; false when the loop no longer holds it (its turn ended, or a step joined it into a turn another message opened, which runs on) or an earlier interrupt already stops its turn. A steer taken back answers true, unless an earlier stop from the same requesting branch already stops the turn the steer waited to join: the turn's latch records the requester of its first stop, and that stop's caller already reports the branch. A stop that reaches a running turn also takes back, under the interrupt permit, every waiting steer its own requesting branch sent (the `sender` a loop records on a steer into another branch's `Steer` operation and queue item, never a client): the turn's end cannot hand such a steer on as the next turn, so a later stop of that steer reaches nothing and the branch is reported once, however late that stop comes. A `Cancel` steer that names a `messageId` still decodes and runs the same routine), `events` (replay, then the `StreamSynchronized` marker, then live; `from: "now"` skips the replay and starts at the newest stored event), `delete` (cascade), `dequeueFollowUp`, `holdResident` (a scoped hold that keeps the own branch's loop resident; see Residency in `runtime.md`), and `wakeAt` / `cancelWake` (a durable wake record of the calling extension on any branch of the workspace; see Durable wakes in `runtime.md`). `send` and `stop` are a facade over the unchanged actor operations `SubmitDurable`, `QueueFollowUp`, and `Steer`, except that a `queue` or `steer` into the loop's own branch is admitted re-entrantly inside the caller: a client request's grant is read at admission, while the request provably runs, and a send from a context kept past it is an extension send; the raw `SteerCommand` stays on the RPC contract, not in the extension API. The bodies live in the `agent-loop.client` section of `packages/core/src/domain/agent-loop.ts`; The loop's `sessionControl` calls the queue bodies (`queueFollowUpOn`, `dequeueFollowUpOn`), and both `SessionRuntime` and `sessionControl` call `submitUserMessage` and `steerLoop`, so the facade and the RPC path cannot drift. The verbs are uniform: no extension, shipped or not, holds a grant another lacks. `AgentDefinition.maxModelAttempts` (and the RunSpec override) is the generic per-turn model-attempt budget, reserved durably per turn message id.
- **Model-call budget visibility** — The reservation row is the one count; everything a reader or the model sees is a reading of it (`SessionOperationStorage.modelAttemptsUsed`), never a second counter. Each `StreamEnded` of a budgeted turn carries the receipt `modelAttempts: { used, limit }` (`ModelAttempts` in `domain/agent.ts`), read when the step ends, failed and interrupted steps included; it is absent for a turn with no budget. `SessionRuntimeMetrics.turnModelAttempts` folds the newest receipt and clears on `TurnCompleted`, so the next turn starts a budget of its own. At the first step boundary after a call with `MODEL_ATTEMPTS_NOTICE_LEFT` (5) calls or fewer and more than one left (never before the first step, so a small budget's first step reads only the task), the turn appends one durable runtime user line (custom type `model-attempts`, id `<turn>:model-attempts`, details the reading): how many calls are left, that a retry or summary uses one too, that the last call runs with tools off, and to finish or save progress; a new message starts a fresh budget. It is written once and stays in the cached prefix. The last call the budget allows (one left at the boundary, the first step for a budget of 1) runs as the step limit's last step does (`maxSteps`): `toolChoice: "none"`, opened by a durable line of the same custom type (id `<turn>:model-attempts-last`) worded as `MAX_STEPS_INSTRUCTION` for the budget, so the turn ends with its answer; a tool call made anyway is refused (`ModelCallBudget`) and the turn is unanswered. When that step is also the step limit's last, only the step limit's line is written. A turn whose next request finds no call left (a budget of 0, or a retry, context summary or credential move inside the last call) fails that step with `Stopped at the model-call budget: N of N model calls used this turn…`, the `ErrorOccurred` text a client, a headless run and a parent's child completion read. Nothing lifts the cap automatically, and no API exists only for a reviewer. The TUI draws the receipt as `N/M model calls` on the turn line, the two lines as `⧗` rows (`K of M model calls left …`, `last of M model calls · tools off …`), and the running turn as `calls N/M`, then `⧗ K of M calls left` near the limit, in the status row's right group.
- **Hooks** — `host.on("systemPrompt" | "turnProjection" | "turnAfter" | "loopOpen" | "wakeDue" | "sessionDeleted" | "toolCall", handler)` registers the seven runtime hooks; each kind is typed by `ExtensionHookSignatures`. `wakeDue` runs when a wake record its extension armed comes due, with `{ sourceId, at, cause }`, and answers a `WakeNext` (`Done`, `At`, `AtStart`); see Durable wakes in `runtime.md`. `loopOpen` takes no input and runs once for each activation of its extension in a branch's loop: when the loop is built in this process (the first operation after a restart, a wake fire, or after the loop closed), beside any turn the build resumed after a restart cut it short; for an extension with branch Resources, again for each new generation of them (an edit, or a disable and enable, builds one), once no older generation of it is alive; for one without, again when it rejoins the loop's newest profile after a profile left it out. The loop is the one owner of activation (the activation section of `runtime/agent-loop.ts`): one activation at a time resolves the newest profile and claims what is due, so state a hook restores into the branch Resources (wake's timers) is restored once, into the generation that keeps it. It is where an extension repairs what a previous process left on the branch: re-arm timers, resume children, report lost work. It runs as the loop's own fiber, with the branch Resources and a non-client opener (it cannot ask). Nothing in it takes the side-mutation permit, which a running turn holds: the profile resolves under the profile cache's place lock and the Resources build under the branch's own lock, so the hooks run beside a turn the open resumed. Each extension's hooks run on a fiber of their own, which holds the profile they read and none of the activation's generations: an extension with branch Resources runs them in the scope of the generation they activated, so they stop when that generation retires, before its Resources release; one without runs them in the loop's scope. So a hook that never returns delays no turn, no other hook, and no other extension's next generation. A follow-up it queues on its own branch starts a turn like any other send, and the operation that opened the loop never waits on it. User extensions register it the same way. `sessionDeleted` runs once for each session a delete removed (`SessionMutations.deleteSessionCascade`: the session and the descendants it spawned; a handoff that continues its thread stays and is not named), after the rows are gone, with that `sessionId`. Each session is heard under the profile of its own cwd, resolved before the delete, so a descendant in another cwd reaches that cwd's extensions; a descendant created after the delete collected its tree is heard under the deleted session's profile. The host context names that session and has a non-client opener. Each extension's handler runs on its own fiber; a failure is logged (`extension.hook.handler.failed`). The delete waits for each handler up to `SESSION_DELETED_HOOK_TIMEOUT` (30 s); a handler past it is interrupted and logged (`extension.hook.session-deleted.timeout`), so a handler that never returns does not hold the delete once the rows are gone. An extension removes there what it keeps for a session outside the database. Hooks, tools, and requests all cross one membrane: `provideExtensionLeaf(frame)` in `runtime/extension-host.ts` reads the run's `CurrentExtensionHostContext` and provides `ExtensionContext`; `turnProjection` receives the agent the turn dispatches (`TurnProjectionInput`). Hook handlers receive event input only and yield `ExtensionContext` or extension-owned service Tags when they need authority. `turnAfter` carries `usage: { known, complete }`: the tokens of the steps that reported usable counts, and whether that is the whole turn (`TurnCompleted.usage` carries a total only when it is complete). A turn a usage limit failed carries `retryAt`, the epoch time the driver says the limit resets (Some only past the retry policy's `maxDelay`, for a turn that was not interrupted; the same time as the turn's `ErrorOccurred.retryAt`). `toolCall` runs in `ToolRunner.runBound` before each call's body, with the call's address (`sessionId`, `branchId`, the turn's opening `messageId`, `toolCallId`, `parentToolCallId` for a call the cell makes), the agent, the tool id, its `readonly` flag and the input; every extension's hook runs at once and the strictest `ToolCallVerdict` wins (see "No permission rules in core; one hook" in `interactions.md`). See `packages/core/src/domain/extension.ts` and `runtime/extension-host.ts`.

Other notes:

- Each tool call reads the stop of its turn (`CurrentTurnStop`, exported by
  the branch-tools entry): `stopped` completes on the turn's interrupt or the
  loop's close, `isStopped` polls it, and `closing` says which. The loop's
  close completes it after it interrupted the turn, as the close stopped
  branch work before. A tool that runs uninterruptibly stops its own work
  there: it cancels and reports what that cost on an interrupt, and records
  nothing on a close, as a crash would, so a restart recovers it. Any other
  tool is interrupted on an interrupt (`stopWithTurn`) and ends with the
  turn on a close. The loop builds one `ModelContextLedger` per branch and
  puts it in the branch's services, so a directive any dispatching tool
  schedules reaches the next step; there is no inert ledger.
- Server, process and branch Resources build extension by extension in
  resolution order, each in its own scope: a profile holds its server and
  process builds as shared builds keyed by what they read (`holdResources`,
  `SharedBuild` in `runtime/extension-host.ts`), and a branch loop builds
  its branch Resources through `buildScopeResources`. Every build
  reads the host's services (`ResourceHostServices`: the extension
  platform, the session database's `SqlClient` and `InteractionStorage`),
  given by value in the profile cache's build context. A server build reads
  nothing else. A process build runs over every server Resource and the
  process Resources the extensions before it built too. A branch
  build reads only its `BranchAddress` (session, branch, cwd, home) and the
  process Resources of its own extension it names
  (`defineResource({ resources })`, `branchBuildContext`); `defineResource`
  bounds the layer's requirements to these, so a build that reads anything
  else does not compile. A layer that fails to build closes
  what it acquired, is logged naming its extension
  (`extension.resource.failed`), and leaves every other extension's Resources
  live. A server or process Resource that fails rejects its extension in
  both phases: its last good version runs, or the profile reports it failed
  at the `startup` phase and holds none of its services. Branch resources follow the
  session's profile (the extensions set up for the session's cwd): each run
  of the loop (a turn, an extension request, the `loopOpen` hooks) resolves
  the profile under the loop's `branchResourceLock` and builds the branch
  Resources the profile needs and the loop does not have yet, so a
  control-plane write never resolves a profile. One build of one extension's
  branch Resources is a generation, named by its build key
  (`branchResourceKeys`): what the build reads, that is its extension's
  identity, or, when it names process Resources, the key those were built
  under. An edit to the extension, or to a process-bearing one before it
  that its named process Resources build over, gives a new generation; an
  edit elsewhere keeps it, with its state. A run holds the generations of
  its profile until it ends, so a turn that started before an edit ends on
  the old services and the next run reads the new ones. A generation holds
  the lease of the newest profile that uses it: a run that keeps a
  generation moves it to its own profile's lease, which holds every service
  the build read (its key says so), and lets go of the old one after the
  lock, so the profile before retires with another extension's old process
  Resources. A generation the newest profile does not use closes when its
  last run ends, outside the lock, newest first, and then lets go of its
  profile lease. That close
  (`closeBranchGenerations`) is the generation's only one, so it cannot stop
  part way: it is uninterruptible, it closes every retired scope though one
  before it fails, and it lets go of each lease whatever the close ends in.
  The last hold on a lease closes it on a fiber of the loop scope, so a run
  does not wait for the profile cache's place lock to end.
  A run's profile-cache lease joins the run's lease scope (it is provided
  inside the loop's runtime context, which carries the Scope of the fiber
  that built the loop), so the old profile retires when the last run and
  generation over it end. The branch services join
  the run's capability context (`turnCapabilityContext`), so every extension
  leaf of the run reads them. A new generation runs its extension's
  `loopOpen` hooks once the generation before it closed (see Hooks). A branch Resource that fails, or that needs a service a
  failed one would have built, is named once per build key in the transcript (an
  `ErrorOccurred` notice with the extension id) and suspends its extension
  for that loop the way a failed process Resource does for the profile
  (`suspendExtensions`): the loop's turns, requests and hooks read the
  registry without it, so none of its tools, requests or hooks is offered or
  dispatched, and the branch's turns run with the others. The turn profile's
  registry is provided inside the profile's capability context, so the
  narrowed registry is the one a turn reads. Release runs in reverse build
  order when the owning scope closes.
- Prompt shaping, input normalization, permission policy, and turn hooks are explicit runtime slots compiled from extension hooks and typed leaves, not generic middleware buckets.

- `createSession` accepts optional `initialPrompt` + `admission` for atomic create-and-send.

## Publishing events

Runtime code yields `EventStore` (`domain/event.ts`) directly. `publish` appends an event and delivers the envelope to subscribers; `append` and `deliver` are also separate so a mutation can append inside its transaction and deliver after commit. The extension `State` facet publishes only `ExtensionStateChanged` on the same store. Publishing is cwd-agnostic; per-cwd extension behavior comes from the turn's profile.

## Extension State

Extension state lives in scoped Effect services/resources and publishes product
events through the normal session event stream. State shared by every place of
one server lives in a server-scope resource, never in a module global.

True actor protocols should be introduced at their owning runtime boundary
using Effect Entity/RPC rather than recreating mailbox, discovery, persistence,
or ask/reply infrastructure inside extension authoring.

**Event-backed client invalidation**:

- Server event publishing appends and broadcasts committed `AgentEvent`s only; it does not synthesize extension invalidation events from registry metadata.
- TUI widgets that derive state from events subscribe with `transport.onSessionEvent` and refetch their typed extension RPC when relevant event tags arrive. `@gent/goal` is an event-backed widget.
- `ExtensionStateChanged` remains available as an explicit, payload-free notification event for extensions that choose to publish it directly.

## Entry rules and extension authority

**Package boundary imports.** Use `@gent/core/extensions/api` for extension authoring. Use `@gent/core/protocol` for shared client schemas, projections, and RPC types. Use `@gent/core/host` for what a host composes (platform, config loader, storage, workspace headers, server root, the scripted model); it loads on a hosted root without Bun. Use `@gent/core/host-bun` for the Bun host: `BunPlatformLive`, `BunSqlite`, `BunHostModules`, `bindBunModules`. Use `@gent/core/test-utils` in tests only; product code never imports it. Each entry re-exports only names with a real consumer; a `host` name needs a product caller, so a name only tests read belongs in `test-utils`. A test outside core arranges host state through `test-utils` operations (`captureTurnTools`, `runtimeHostContext`, `plantToolCallBinding`, `plantInFlightTurn`, `recordInteractionDecision`, `storedEvents`, `staticToolBinding`), never through core's own Tags, and never imports `packages/core/src/` by relative path. Core implementation tests import their owning `packages/core/src/` modules by relative path; a core test that authors a fixture extension takes the authoring names (`defineExtension`, `tool`, `ExtensionHost`, …) from `@gent/core/extensions/api`, as an extension does. Files inside `packages/core/src/` also use relative imports.

**Extension authority.** Extension leaves receive input/event params only. Use `const ctx = yield* ExtensionContext` for host facades (`Session`, `Interaction`, `FileLock`, `Models`, `State`) and extension-owned service Tags for private state. A `tool` or `request` declares where its other services come from: `resources: [MyResource]` names each `defineResource` value whose services it yields (its extension must register each). An extension that owns tables migrates them in a process Resource of its own; the root takes no feature input. A body whose type requires an undeclared service does not compile, and a declaration the extension does not satisfy fails the extension load. The bound is on the required services (`R`), not on the runtime context: `Effect.serviceOption` still reads what the root holds. Files, paths, processes, HTTP, and ids come from the Effect platform services (`FileSystem`, `Path`, `ChildProcessSpawner`, `HttpClient`, `Crypto`), with `runProcess` for commands, `path.resolve(ctx.cwd, p)` for relative paths, and `writeFileAtomic` (`packages/core/src/runtime/gent-platform.ts`, exported from `@gent/core/extensions/api` and `@gent/core/host`) for atomic writes; no facet duplicates an Effect platform service. Shipped extensions never import core internals such as `FileLockService`, `EventStore` or `DecisionModelResolver` — yield the matching `ExtensionContext` facet instead. Every facade verb is uniform: any extension that can yield `ExtensionContext` gets it, including every verb of the `Session` facet (`ExtensionSessionService` in `packages/core/src/domain/extension.ts`), such as `send` with its `delivery` mode `turn`/`queue`/`steer`. Do not add ctx parameters, read/write/capability grants, or privileged builtin registries; a shipped extension is never more privileged than a user extension (the `gent/core-entry-boundary` oxlint rule in `packages/tooling/src/gent-rules.ts` enforces the import side).
