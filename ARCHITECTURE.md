# Gent Architecture

Minimal agent harness. Effect-first. Small seams. One owner per concern.

## Core Model

`gent` is organized around six nouns:

- `Server` — process-wide services only: storage, auth stores, platform, transport wiring, connection tracking.
- `Profile` — cwd-scoped extension graph: drivers, hooks, resources, capability leaves.
- `SessionRuntime` — the single public session engine: inbox, queue, checkpoint, watch state, turn orchestration.
- `Tool` / `Request` — independent callable leaves for model tools and typed extension RPC. Requests with a `slash:` block also surface as human slash commands.
- `Resource` — long-lived scoped services and extension-owned state.
- `Hook` — `systemPrompt`, `turnProjection`, and `turnAfter` handlers registered with `host.on` for prompt, policy, and turn follow-up.

Everything else is adapter code around those nouns.

## Rules

Numbered invariants. Each carries the file that enforces it, so a reviewer can
check the claim instead of trusting it. A change that breaks an invariant
updates this list in the same commit.

1. **Effect-native end to end.** No `Promise<` in an extension surface; no
   `async`/`await` in tests. Receipts: `packages/core/tests/extensions/api.test.ts`
   (the extension surface rejects a Promise at compile time) and `.oxlintrc.json`
   (`effect/noAsyncFunction`, `gent/no-promise-control-flow-in-tests`).
2. **One actor per (workspace, session, branch).** The agent loop is an
   effect-encore entity; every session mutation crosses its mailbox.
   Receipts: `packages/core/src/runtime/agent-loop.ts`,
   `packages/core/src/domain/agent-loop.ts`.
3. **Everything is an extension of the loop.** Core registers zero tools;
   drivers, tools, requests, resources, hooks, and TUI facets arrive through the
   extension API. Receipts: `packages/core/src/extensions/api.ts`,
   `packages/extensions/src/index.ts`.
4. **Schema-first transport contract.** Every RPC input and output is a
   Schema; thin adapters carry it. Receipts:
   `packages/core/src/server/rpc.ts`.
5. **Event and projection commit together.** A session mutation writes its
   row and its events in one transaction, so a reader never sees one without
   the other. Receipt: `transactWithEvents` in
   `packages/core/src/server/server.ts`.
6. **Tool calls replay from durable bindings.** A resumed turn re-delivers a
   tool result from `tool_call_bindings`; it never re-runs the tool.
   Receipts: `packages/core/src/storage/storage.ts`,
   `packages/core/src/runtime/tools.ts`.
7. **Approvals are one-shot and fail closed.** A guarded call asks once
   through the durable interaction request; nothing is saved; no answerer
   means no. Core has no rule schema, rule storage, or `permission.*` RPC.
   Receipts: `packages/core/src/runtime/extension-host.ts`,
   `packages/core/src/domain/interaction.ts`.
8. **Each model step is classified once.** The stream fold produces a
   `StepOutcome`; persistence and the continue/stop/run-tools policy are
   exhaustive matches on it, and the tag travels on `StreamEnded.outcome`.
   Receipts: `classifyStep` in
   `packages/core/src/runtime/turn.ts`,
   `packages/core/src/domain/event.ts`.
9. **Retry policy belongs to the driver.** The loop re-runs a step; the
   driver says which failures are transient and how long to wait. Receipts:
   `RetryPolicy` in `packages/core/src/domain/driver.ts`,
   `packages/core/src/runtime/provider.ts`.
10. **Tool results are bounded before the model sees them.** At most 8,000
    characters inline (head and tail); the rest is paged through
    `context.read`. Receipt: `maximumModelToolResultChars` in
    `packages/core/src/runtime/model-context.ts`.
11. **A model change is a durable user-role notice the loop writes.** The
    settings update only records the choice. At each step boundary the loop
    compares the model the branch last ran on or was told it continues with
    (its last `StreamEnded`, or the last model-change notice) with the model
    this step resolves; when they differ it
    writes one `model-change` message, and that step reads it. The id names
    both models, so a replay after a further switch writes the right one. A
    turn under an agent or run-spec model override writes none; the turn after
    it notices the change back. An effort change, or a branch with no settled
    step, writes nothing. Receipts: `modelChangeNotice` in
    `packages/core/src/runtime/model-context.ts`, `lastKnownModel` in
    `packages/core/src/runtime/turn.ts`.
12. **Tool guidance lives on the tool and follows the active tool list.**
    `promptGuidelines` are deduped per turn from the post-policy tools only.
    Receipts: `buildTurnPromptSections` in
    `packages/core/src/runtime/turn.ts`,
    `packages/core/src/runtime/turn.ts`.
13. **The cell runs in full Bun.** No sandbox, no interpreter; network reads,
    HTML parsing, and past-session queries happen in the cell. Receipt:
    `packages/extensions/src/cell.ts`.
14. **A child's completion arrives as a user message, never a tool result.**
    Receipt: `packages/extensions/src/delegate.ts`.
15. **Platform edges stay explicit.** Extensions reach files, paths,
    processes, and ids through the Effect platform services
    (`FileSystem`, `Path`, `ChildProcessSpawner`, `Crypto`) and resolve
    relative paths against `ctx.cwd`; `runProcess` is the one command helper.
    No `ExtensionContext` facet duplicates an Effect platform service; the
    facets are host authority only (`Session`, `Interaction`,
    `FileLock`, `State`). An atomic write has one owner, `writeFileAtomic` in
    `packages/core/src/runtime/gent-platform.ts`; core config, extensions
    (through `@gent/core/extensions/api`) and the TUI (through
    `@gent/core/host`) all call it. Host facts core cannot get from
    Effect (OS info, executable path, home directory) stay on `GentPlatform`.
    The TUI session controller owns screen state, views render and dispatch;
    app-specific UI facets live at the app edge. Receipts:
    `packages/core/src/runtime/gent-platform.ts`,
    `packages/core/src/domain/extension.ts`, `apps/tui/src/session.tsx`,
    `apps/tui/src/app.tsx`.
16. **RPC is the application transport.** No parallel REST surface. Receipt:
    `apps/server/src/`.

17. **Context leaves the window as a handoff, never as a loss.** When the
    window overflows or the model asks, the history before the newest user
    message is summarised into one durable user-role marker that names the
    session, the branch, and the id range it replaced; every replaced message
    stays readable from the cell through `context.history` and `context.read`.
    When the newest turn alone overflows, the handoff anchors inside the turn
    at a step boundary and keeps the newest steps that fit half the budget.
    A summary that cannot be produced degrades to truncation with a visible
    notice. The budget is the smaller of the model's input cap
    (`Model.inputLimit`, from models.dev `limit.input`) and its window less
    the output reserve. The estimate is chars/4. When the last step's reply is
    still in the window, the messages before that reply count at least as much
    as that step's reported input, less the system and tool size its own
    request carried (`StreamEnded.requestOverheadTokens`). Its output never
    counts.
    A request the provider refuses as too long (`RetryPolicy.contextOverflow`,
    one pattern list in `packages/core/src/domain/driver.ts`; the byte cap
    `request_too_large` is not an overflow) hands the window off once and runs
    the step again. The step drops the history, or the summary of an earlier
    handoff when nothing else is left. A second refusal fails the turn with an
    error that says so.
    Receipts: `packages/core/src/runtime/model-context.ts`,
    `packages/core/src/runtime/turn.ts`,
    `packages/extensions/src/compaction.ts`.

### Known gaps

Kept here so the next pass starts from them, not from a fresh survey. Each
names the decision that left it open.

- **Typed fan-in for children (ledger A3) is rejected, not open.** A
  `delegate.start` returns at admission and the child's completion arrives
  as a user message that wakes the parent (gamut run 34: six starts in one
  cell, six wakes), with `delegate.list` for inspection and `read_session`
  for the transcript. The model never blocks on a child, as in prime-agent;
  a `collect` would add a blocking surface the owner rejected on 2026-09-18.
  Reopen only if a run shows a child result needed inside a later cell
  before its message lands.
- **The agents view keeps a server half.** The live catalog
  (`ExtensionContext.Session.listActiveLoops`) and the stored catalog (`session.list`, `packages/core/src/server/rpc.ts`) differ after a
  restart; folding the view into the client would need a core RPC or one
  snapshot read per session per tick. Rejected as R6 in the same ledger.
- **Compaction is measured on long sessions only by hand.** The handoff
  count (`ModelContextProjected.compacted`) after the spill comes from gamut
  runs, not from a test; the receipt in
  `plans/core-extension-reduction-receipt.md` records the last measurement.

## Package Map

```text
apps/
├── tui/       # OpenTUI client over the shared transport contract
└── server/    # HTTP + RPC adapter over the same app services

packages/
├── core/          # entries: extensions/api, extensions/branch-tools, protocol, host, test-utils
│   ├── domain/    # Schemas, ids, events, service tags, pure domain helpers
│   ├── storage/   # Storage tags, schema ownership, SQLite assembler, focused repositories
│   ├── runtime/   # SessionRuntime, agent-loop internals, provider stack and scripted model
│   ├── extensions/# api.ts public extension surface
│   ├── server/    # transport contract, handlers, commands, queries, startup wiring
│   └── test-utils/# test layers, recorders, fixtures
├── extensions/    # shipped extension set
└── sdk/           # direct + RPC transports over one client contract
```

`@gent/core/protocol` contains shared client schemas, message projections, and the RPC contract. The SDK uses this entry point for client data. It does not expose server storage or runtime service tags. Core implementation files keep relative imports; they do not import through the public protocol entry point. The private alias remains while host and test consumers move to supported contracts.

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

Default `gent` resolves a shared server via `Gent.server({ cwd, state: Gent.state.sqlite() })`. SQLite-backed local clients share one server per database, decided by the lock files beside `data.db` (see Shared Server Discovery); workspace routing is carried by the `x-gent-workspace-id` RPC header. Topology derives from configuration: `Gent.state.memory()` for in-process owned, `Gent.state.sqlite()` for shared local server, `Gent.client({ url })` for remote.

## Transport Boundary

Source of truth:

- `packages/core/src/server/rpc.ts`

That module owns:

- client-facing types
- queue/session/message projections
- contract semantics

Adapters:

- `packages/sdk/src/client.ts`
- `packages/core/src/server/rpc.ts`
- `packages/core/src/server/server.ts`

Rule:

- no client-specific DTO remodeling
- no parallel application contract surfaces
- handlers and adapters derive from the same contract types

## App Services

The app surface is split by concern:

- `SessionMutations` (`packages/core/src/domain/extension.ts`; `SessionMutationsLive` in `packages/core/src/server/server.ts`) — every durable session/branch mutation, including `createSession`; request-id-bearing mutations replay their durable operation row and collapse concurrent same-request fibers in-process
- `SessionQueries`
- `InteractionCommands`

`message.send` request-id dedup lives in `server/server.ts` next to the handler; the runtime keys the actor command on the same request id.

The app services are one layer, `createDependencies` in `packages/core/src/server/server.ts`; no separate app-services layer exists. The SDK builds it in the server scope and hands the context to `buildServerRoutes`; the test harness provides it as a layer.

`packages/core/src/server/server.ts` owns startup wiring:

- runtime platform
- storage/event store
- auth/config/model registry
- provider stack
- extension loading and live Profile ownership
- actor/runtime services

It is the composition boundary. Not the domain boundary.

### Runtime Profile

`packages/core/src/runtime/extension-host.ts` owns the shared profile pipeline.
`loadRuntimeProfileDeclarations` discovers extensions, runs trusted setup,
validates declarations, and loads the core prompt sections. It does not build
Resource layers. Trusted setup can still perform its own effects; this is not a
sandbox boundary.

`SessionProfileCache` builds one profile per (workspace, cwd, set of
extensions the config leaves active or failed, versions of the extension files
on disk). Each resolve reads the config and lists the user and project
extension directories as they are now, under the place's lock, so an edit to
`disabledExtensions` and an added, fixed or edited extension file reach the
next turn and the next session without a restart; a file is imported under its
version (mtime, size, inode), so Bun's module cache does not serve the old one.
A directory extension's version is its index file's. Project trust comes from
`isProjectExtensionDirectoryTrusted` (`runtime/config.ts`), the reader the TUI's
client-extension loader calls too: it reads `trustedProjects` from the user
config file as it is now, and a file that does not decode trusts no project.
Launched from home, the project's `.gent` is the user's, so there is no project
scope: `hasProjectScope` (`runtime/config.ts`) keeps the config read, the
extension scan and the TUI loader from reading `~/.gent` a second time. A
list that leaves the
same extensions, such as one that names an unknown id, finds the profile
already built. Finding or building the profile, its lease and making it
current are one step no interrupt can split. `resolve` takes a
lease in the caller's scope: a turn and an extension request hold it until they
end, a branch loop holds it while its branch Resources live, and a query holds
it for its read. The newest profile of a (workspace, cwd) stays cached; a
superseded one closes its scope when its last lease is released. It builds
every extension's process-scope resources in resolution order, each in its own
scope, and reports an extension whose layer fails as failed at the startup
phase. An extension's process resources are shared by every profile of the
place that builds them over the same context: the same resource-bearing
extensions before it, and itself (id, source, file version). So a profile
rebuilt for a config edit keeps the resources the edit leaves alone, and their
state with them (an open `/btw` fork, the agents-view watchers, a running
background job); a resource closes when the last profile that holds it
retires. `buildSessionProfile` then stages the `ExtensionRegistry` and the base
prompt sections over the built resource context. Profile tests use the live
cache. The tool test layer uses the production composition root. Neither has a
separate activation implementation.

The production server uses one live profile owner:

- `runtime/extension-host.ts` owns entries by workspace, canonical cwd and
  disabled list. Each
  entry is built once: declarations load, every extension's process resources
  build into a child of the server scope, and `buildSessionProfile` stages the
  catalog from that context. An extension whose process resource fails to build
  is reported as failed at the `startup` phase; the rest of the profile stays
  live. There is no reconciler, publication, or admission lease. Gent owns
  resource identity, configuration and graph policy; Effect owns Context,
  Layer, Scope and finalization; effect-encore owns durable actor commands and
  recovery. Test roots
  (`createE2ELayer`) set `failOnExtensionFailure`, so a failed extension is a
  defect that names it; `allowFailedExtensions: true` keeps a failure-path
  test running. The harness loads every `extensionInputs`/`extensions` entry
  at builtin scope; a scope test builds its profile from `LoadedExtension`s
  and passes it as `sessionProfileCacheLayer`.
- `server/server.ts` selects the launch profile from that cache.

Turn profiles carry the process identity that built them. A process-local tool
binding names that process and is valid only inside it.
Native source-mode approval, public repair, direct-command cleanup, and external
callback limits have focused validation. Full gate and terminal/server E2E pass.
See `plans/live-composition-review.md` for evidence and recovery limits.

Core writes two prompt sections: the environment, once per profile, and the
local date, per turn (a profile outlives midnight; the date changes the cached
prefix at most once a day). Extensions add sections
only from `turnProjection` hooks, which run each turn inside the extension
service context.

A `turnProjection` hook returns standing content as `promptSections` and
show-until-read content as `notices` (`TurnNotice`: id, content, keys). The
system prompt holds only the sections, so it stays byte-identical while a
notice comes and goes. Core places the turn's notices after the
conversation, as one system message at the end of each step's request, and
stores none (`toPrompt` in `runtime/model-context.ts`). The Anthropic driver
sends it as a `<host-context-update>` user message, which takes no cache
marker, so the tail marker stays on the last conversation block; the OpenAI
driver sends it as a developer message after the conversation, so the prefix
it caches is unchanged. The message opens with "Host status for this turn,
not a message from the user." Both drivers send it in a role below the
system prompt, so a user instruction wins over a notice; the opening line
keeps the model from reading host facts as the user speaking. A notice with
blank content is dropped, so it is never recorded as shown. The turn ledger records the keys each step's request
carried, per extension; `turnAfter` hands an extension back its own keys as
`readNotices` when the turn answered, and an empty set for an interrupted,
failed or unanswered turn. The marks live in the turn's memory: a turn a
restart cut short shows its notices again.

## Runtime

Core orchestration lives in:

- `packages/core/src/runtime/session.ts`
- `packages/core/src/runtime/agent-loop.ts`
- `packages/core/src/domain/agent-loop.ts`
- `packages/core/src/runtime/turn.ts`
- `packages/core/src/runtime/model-context.ts`

Shape:

- `SessionRuntime` is the single public session engine.
- `AgentLoop` is an actor-backed internal control plane. There is no public
  `AgentLoop` service facade; `runtime/session.ts` talks to the actor in
  `agent-loop.ts` directly. The actor entity id includes
  `(workspaceId, sessionId, branchId)`.
- Residency (`AgentLoopResidency` in `agent-loop.ts`): the cluster reaper
  passivates an entity idle past `entityMaxIdleTime` (one minute), and its
  runtime-state stream and branch scope close with it. Three things hold the
  entity resident, counted on its one keep-alive switch (first hold on, last
  release off; a failed switch-on takes its count back): a running turn (the
  mailbox request can return before the model finishes), each watcher of the
  loop's runtime state (`session.watchRuntime`, so an idle client's stream
  does not end), and each extension hold through
  `ExtensionContext.Session.holdResident` (a pending wake alarm or monitor).
  Every hold is scoped, so completion, failure, interruption, a fire, or a
  cancel releases it, and an entity nothing holds expires.
- Runtime commands resolve an existing `(sessionId, branchId)` target before loop dispatch.
- The `@gent/delegate` extension is the helper-agent boundary, built only on the public extension API. Every child is a session in the one runtime, created through the addressed `Session` facade verbs. The delegate owns its own child registry on disk; core carries no runner and no child-run events.
- Child admission uses one shared ancestry check on the `session.create` command
  path (`admitChildSessionDepth`). Missing or incomplete ancestry is an error,
  not root depth. A parent at the depth limit cannot spawn. This check is not a
  concurrency or token budget.
- The `@gent/delegate` extension admits a child by creating a session through the
  `Session` facade with `parentSessionId`/`parentBranchId`, then `send`ing the
  child's first message. `delegate.start` returns the handle at admission,
  keyed by the host tool call id so a replayed call finds its child, and never
  the answer: the model does not block on a child. The delegate reserves at
  most four unfinished children per parent branch, counted from its own on-disk
  registry, not live actors.
- The delegate keeps one child registry per parent branch as a JSON file under
  `<data dir>/delegates/<branchId>.json` (the data directory, `resolveDataDir`:
  `GENT_DATA_DIR`, else `~/.gent`). `delegate.list` reads it; the delegate
  reconciles it when the parent's loop opens (`loopOpen`), on the parent's
  first turn in the process, and on every read, so a caller that died between
  the child's receipt and delivery leaves a child the registry still resolves,
  never a running one nobody delivers. Reconcile re-sends the start of a child
  with no receipt. The repeat admits nothing new, but a durable `turn` send
  reads the target's state first, which opens its loop, so a child the
  previous process stopped mid-turn resumes and its completion wakes the
  parent. Without that, a restart left the child stuck and counting toward the
  cap.
- One writer settles a child's completion. The delegate's `turnAfter` hook on
  the child branch delivers every receipt as one idempotent follow-up message
  on the parent branch (metadata `customType: "child-completion"`, `wake` set
  so a parent with no prior turn still starts one). Nothing waits on a child.
- The same hook, read on the parent side, cascades an interrupt: when a turn
  ends interrupted, every child it started and had not heard from is settled
  as interrupted and then stopped with `Session.stopMessage` on its start
  message, outside the registry lock, so a parent Escape stops the whole
  subtree and no completion message wakes the parent the user just
  interrupted. A child turn that completed before the stop reached it still
  holds its loop while its hooks run, so the stop answers true for it too;
  its own hook delivers the completion over the claim, and reconcile does
  when that hook failed. A failed stop hands the row back. The hook's child,
  parent and notice steps each fail alone. The settled row keeps a stop notice (`stopNoticeAt`, additive optional): the
  delegate's `turnProjection` reads such rows into a `# Stopped children`
  turn notice (one line per child, newest first, at most eight, then a
  count), as `@gent/wake` does for a `notify` fire. `turnAfter` removes
  exactly the rows in `readNotices`, which an answered turn hands back; a
  notice the turn did not show, because its read failed or the cap left it
  out, stays. The stop starts no turn; the parent's next turn,
  whoever starts it, knows the children are not running. The notice asks the
  model to tell the user which children stopped and to start one again only
  when the user asks: the user's interrupt stopped them.
  Prime-agent does not cascade a turn abort; opencode does, and the gamut
  testbed's six children editing files after an Escape decided it.
  This cascade is the delegate's and covers the runs `delegate.start` opened;
  the turns a `session.send` opened are `@gent/session-tools`' cascade (below).
- `delegate.cancel` stops the child's start message through the facade
  (`Session.stopMessage`); a finished child is a no-op.
- Every session can message another: `session.send` (`@gent/session-tools`)
  takes a session id or `parent` and steers an `Interject` with `wake` onto
  the receiver's active branch, carrying `customType: "session-message"` and
  `details.from` (sender id, sender branch id, name, relation). The message
  id is `interjectionMessageId(requestId)`, exported from
  `@gent/core/extensions/api`, so a sender can name what it sent. A send to a
  child is recorded in memory (process resource, keyed by child session and
  message id), and the sender's interrupted turn stops each recorded message
  with `Session.stopMessage`; only a stop that answers true becomes a
  `# Stopped child turns` notice, read and cleared as the delegate's is. A
  failed stop is logged and the record stays for the next interrupt. The
  record drops a message when its turn ends, when a step joins it into
  another turn (`turnAfter`'s `joinedMessageIds`), when a stop settles it,
  and when the sender's answered turn finds the child session gone; a
  restart forgets it. A correction taken back from a child turn the
  delegate's cascade already stops is the delegate's news: `stopMessage`
  answers false for it, so the child is named once. A running receiver reads it at
  its next step; an idle one wakes and answers in a turn of its own. This is
  the child-to-parent channel (a blocked child asks instead of guessing) and
  the parent-to-child correction in one verb; there is no separate
  `delegate.send`. Delivery is not bound to the delegate registry, so a
  message to a finished child wakes it for another turn and no second
  completion follows. A message from a child adds a line saying the child is
  still running and this is not its completion. The TUI draws the row as a
  muted sender line (`» from your parent "name" · <id>`, the name cut at 32
  terminal columns on a grapheme) over the text; `sessionMessageBody` removes
  the header, with or without the child line, so older rows render the same.
  Full detail shows the header the model reads.
- `Interject` steering never interrupts an open stream. The item is admitted to
  the durable steering queue; a running turn delivers it at its next safe step
  boundary (tool results stored, no stream open) by persisting the interjection
  as a transcript message before the next model call, so the same turn continues.
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
  projection. Ambiguous side effects are not replayed. When a turn resumes, a
  pending call runs again only if its last run parked on an interaction: the
  turn record marks it `parked` (an optional field on its pending entry) as
  soon as the call parks, while its siblings may still run, so an answer given
  before a restart is taken; the mark clears before the call runs again. A mark
  or a clear that cannot be written fails the step. Any other pending call was cut
  short while it ran; the model reads a failed result with reason
  `Interrupted` and the call does not run again (a cell with a receipt still
  settles from it first). The binding replay rules then decide whether a
  parked call can run again or fails.
- Narrow retry: `retryProviderCall` retries transient provider failures with
  bounded exponential backoff plus jitter, and only before observable output.
  The policy lives on the `ModelDriverContribution` (`retry: RetryPolicy`),
  because the driver knows its own overload and rate-limit shapes; the loop
  only re-runs the step. Transient means the provider library's typed
  `AiError` says so, or a mid-stream error event matches the driver's
  `transientStreamEvent` schema (Anthropic names a `type`, OpenAI a `code`).
  A typed rate limit's `retryAfter` replaces the backoff. Nothing is inferred
  from message text.
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
- `RequestExtension` takes the side-mutation permit unless the request declared
  `answersDuringTurn: true`; such a request answers while the turn runs and
  must not change the branch's loop state.
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
  receipt commits with turn duration. This flag reports a failed turn only (a
  broken model stream or a failed turn phase), not task success or a complete
  child outcome. Actor Idle is not completion proof.
- Every admitted turn ends with exactly one `TurnCompleted`. A turn phase that
  fails (a storage write, a profile resolve) publishes `ErrorOccurred`, then
  `completeFailedTurn` appends the receipt with `streamFailed: true`, and the
  turn's `turnAfter` hooks run once after it, under the turn's profile. It
  shares the receipt and hook steps with `finalizeTurn` (`appendTurnReceipt`,
  `emitTurnAfter` in `turn.ts`). The stored turn duration is the receipt's
  mark, so a failure after `finalizeTurn` stored it appends no second receipt
  and runs no second hook. As on a normal turn, the receipt and hooks run
  outside the interrupt permit; only the hand-over to the next item takes it,
  so a hook may stop its own branch and a Cancel meanwhile stops this turn. `ErrorOccurred` with `notice: true` is a notice the
  turn goes on past (a compaction that fell back to truncation); a client ends
  the turn on `TurnCompleted`, never on `ErrorOccurred`.
- New turn-stream start/end receipts include the user-message ID and model-step
  number. Model, failure, and interruption paths keep that identity.
  Historical receipts can omit it and must not be treated
  as exact per-turn budget evidence. Token-budget enforcement remains unfinished;
  compaction invokes a separate model and needs accounting within the same policy.
- Context compaction is a seam, not a core feature. The loop checks the window,
  and with no `ModelContextCompactor` process resource installed it truncates
  and reports the omission. The `@gent/compaction` extension installs the
  summariser; core keeps only the window marker shape (`context-window`,
  optional `summarized` range) that status and the TUI read. A compactor that
  fails degrades to truncation with a visible notice. The marker's notice
  names the session id, the branch id, and the replaced id range so the model
  can page the replaced history from the cell.
- Project instructions are an extension, not a profile field. `@gent/agents`
  reads `AGENTS.md` (or `CLAUDE.md`) from the gent home, the project and the
  project-local `.gent/` on every turn and contributes the `project-instructions`
  prompt section at priority 70 beside the persona sections. Launched from home
  (`hasProjectScope` is false), the project-local `.gent/` is the gent home and
  is read once. Core builds no
  instruction text and the profile carries none; an edit to `AGENTS.md` reaches
  the next turn.
- The system prompt has two parts. Sections below `AGENT_PROMPT_PRIORITY`
  (`packages/core/src/domain/capability.ts`: persona, boundaries,
  environment, date, project instructions, skills) are the part a session
  shares with its children, byte for byte, whatever tools each has; the
  agent's own sections (tool list, tool guidelines, the cell guide, sessions and children
  guidance, an agent addendum) and what `systemPrompt` hooks append (the host
  tool list, session naming) follow. The turn sends the parts as two system
  blocks (`systemPromptBlocks`), and the Anthropic driver marks the end of the
  shared one on the API-key path, so a fresh child with its parent's tool set
  reads it from its parent's cache entry (the tool definitions come first in
  the cached prefix, so a child with other tools reads none of it).
- Tool-result spill: the model sees at most 8,000 characters of any tool
  result (head plus tail); the stored message and its events keep the full
  result, and the bounded result carries a `read` locator for
  `context.read(toolCallId, { offset, limit })`. The bounded result keeps the
  result's shape with each long string cut, so the provider encodes the text
  once; only a result of many short strings is cut as JSON text.
  Context pressure drops before compaction ever runs.
- The cell subsumes host tools the Bun runtime already provides: `fetch` for
  network reads and `bun:sqlite` on the data directory's `data.db` for past sessions. No
  `webfetch` or `search_sessions` tool ships; `read_session` stays as the
  parent-to-child output seam.
- Response projection treats token usage as known only when both totals are
  nonnegative safe integers. Missing or invalid totals remain absent, not zero.
  Compaction uses the same conversion and stores reported usage plus model ID in
  the handoff marker's `summarized` details. Failed attempts and crashes before
  marker persistence still need durable attempt accounting; this metadata alone
  does not enforce a budget.
- interactions are cold machine states, not blocked fibers
- machine inspection events are published as diagnostics

Do not rebuild business logic from inspection events. They are receipts, not inputs.

### Agent Runs

- The `@gent/delegate` extension owns child runs. It is built only on the
  public extension API — no core runner, no privileged seam. Every child is a
  session created through the addressed `Session` facade verbs (`create` with
  `parentSessionId`/`parentBranchId`, `send`, `stop`, `events`, `delete`). The
  delegate keeps its own child registry as one JSON file per parent branch under
  `<data dir>/delegates/<branchId>.json`, so a `delegate.list` survives restarts
  without any `durable_operations` row.
- Completion has one writer: the delegate's `turnAfter` hook on the child
  branch delivers every receipt as one ordinary user message on the parent
  branch (metadata `customType: "child-completion"`) with the outcome and a
  bounded preview, and the message wakes the parent. Nothing waits on a child.
  A turn that ended badly also carries the error it ended on (the last
  non-notice `ErrorOccurred` since the previous receipt, one line of at most
  1,000 characters) in the text and in the optional `details.error`, so a
  parent tells a sign-in that will fail again from a flake.
  Lazy reconcile covers the crash window between the
  receipt and the hook: the delegate reconciles its registry when the parent's
  loop opens, on its first turn, and on every `delegate.list`, so a caller that died mid-op leaves a
  child the registry still resolves, never a running one nobody delivers.
- The delegate ships three ordinary tools: `delegate.start`,
  `delegate.cancel`, `delegate.list`; messaging a child is `session.send`. A child's first message opens with `Task from your parent session <id>.` and says where its final reply goes, so the child does not take a bare instruction for an injection. `delegate.start` accepts RunSpec
  overrides for model, reasoning, tool selection, and added instructions, and
  a `context` of `fresh` (the child sees only its todo) or `fork` (the child is
  created with `historyBranchId` = the caller's branch, so it starts from the
  caller's current context window). A history copy is settled first: a tool
  call with no result in the source, such as the `delegate.start` call that is
  making the fork, is left out with its step, and a result whose call the
  window cut away is left out too, or the child's first projection would
  reject the group. `delegate.start` always denies the child the delegation
  tools: fan-out is the caller's decision, and a project prompt that
  addresses "the orchestrator" reaches children too. Parents read child output through `read_session` on the
  returned session/branch IDs. The session is the only copy of a child's
  output; the completion message carries the outcome and a preview.
- The TUI agents pane lists children through `AgentsViewRpc.ListAgents` and
  refreshes on the delegate's `ExtensionStateChanged` pulses, matched by
  `DELEGATE_EXTENSION_ID`. Completion rows read the completion message's
  details. Core publishes no `AgentRun*` events.
- Child session nesting depth is admitted on the `session.create` command path
  (`admitChildSessionDepth`). Missing or incomplete ancestry is an error, not
  root depth; a parent at the depth limit cannot spawn. Only spawn edges count:
  a handoff (`continueThread`) keeps its parent's thread, is not admitted, and
  keeps its parent's depth.
- Two shipped agents: `main`, the orchestrator, and `delegate`, registered by the delegate extension as the agent every child runs as. A child inherits nothing from its caller: its model and effort come from the `delegate` definition, reshaped by `agents.delegate` in `.gent/config.json`, and a call's RunSpec overrides (model, tools, prompt addendum) win over both. That config entry is where a pairing such as fable → opus or opus → sonnet is declared.
- `/btw` (`@gent/btw`) forks the branch: `btw.fork` creates a child session with `historyBranchId` set to this branch, so the fork starts from this branch's context window and runs as the session's own agent with its tools — a parallel session, not a side channel. Nothing it does lands on the branch it forked from. The copy keeps a request the session is still working on, because a question is usually about it; so each question goes to the fork under a header (`forkQuestionText`, `customType: "btw-question"`) that names the session it forked from, says a request with no answer above is that session's work and not the fork's, and asks for changes only when the question does. Without it a fork opened mid-turn took the session's task as its own and did it again in the same working tree. The pane and the fork's transcript row show the question without the header (`forkQuestionBody`). The pane asks it through `btw.ask` and reads it through `btw.progress` (turns after the fork point plus the reply streaming now, folded from the fork's event stream by a process resource). Each state pulse the follower sends is a stored event on the branch and a re-read of the fork in the open pane, so a fork event that leaves the pane's view as it was pulses nothing, and streamed text pulses at once and then at most once per 250 ms, with the last change always pulsed; `^o` opens the fork as the shell's session, which is `switchSession`, because the fork already is one. The open fork per branch is process state; the fork itself is durable and listed with every other child session.
- Alarms and monitors (`@gent/wake`) live in `<data dir>/wakes/<branchId>.json` (`resolveDataDir(ctx.home)`: `GENT_DATA_DIR`, else `~/.gent`; `ctx.home` is the OS home); timers are branch-scoped. `wake` fires at a time, and again every `everySeconds` when it repeats (the stored due time advances on each fire; ticks missed while the process was down fold into one fire); `monitor` polls a shell command on an interval until it exits 0 or its stdout matches `until`, or its deadline passes. Both write the entry, capture the session facade of their call, and fork work into the branch resource scope that queues a user-role `wake` message (`details: { outcome, note, firedAt }`; `fired` is an alarm, `matched`/`timed-out` a monitor). In `wake` mode (default) the line carries `wake: true` and starts a turn on an idle loop; a line the session refuses (a full follow-up queue, for one) is logged (`wake.fire.refused`) and stored as a `notice` entry instead, so the fire is not lost. In `notify` mode no line is queued (a queued follow-up always runs a turn on a branch with history): the fire stores a `notice` entry in the same file and pulses the tray; `turnProjection` (every step) reads the notices into a `# Notices` turn notice, and `turnAfter` clears exactly the notices in `readNotices`, the ones an answered turn's steps showed (a lost process shows them again), so a failed, interrupted or unanswered turn keeps them, and a notice written after the last step read the file waits for the next turn; `wake.cancel` dismisses one unread. A settled one-shot fire removes its entry; an interrupt (branch close, shutdown) leaves the row for the next re-arm; a repeat only ends on cancel. `wake.cancel` interrupts one timer by id, or every pending one on the branch, and drops the entries; the resource keeps fibers by id for that. Branch resources start without an `ExtensionContext`, so after a branch close or a server restart the stored entries get their timers back when the branch's loop opens (the `loopOpen` hook re-arms them under the branch file's lock, the lock a fire takes to drop its entry, so a fire that ends during a re-arm is not armed and fired again; past-due alarms fire at once, and a past-due `notify` alarm leaves its notice without a turn). Opening the session is enough; no message is needed. The TUI collapses a `wake` row to `◷ alarm fired · <note>` or `◉ monitor matched · <note>`, and a wake tray under the status line lists pending entries from the `wake.pending` request with their cadence and `(notify)` when the fire starts no turn; the model reads the same entries with the `wake.list` tool, in ISO times like the `wake` and `monitor` results (a tool and a request cannot share an id inside one extension). The status bar shows only `ctx N%`; the messages the projection omitted show on the live window in the `/thread` pane.
- Background shell jobs (`@gent/exec-tools`, `bash` with `run_in_background`) keep one row each in the `background_bash_jobs` table and run in a process-scoped resource. A finished job queues its terminal notice (`bash:<toolCallId>:complete` or `:failure`), which wakes the branch. The notice carries the head and tail of the output within `maximumModelToolResultChars`. An output it cuts is written whole, once, to `<data dir>/background-bash/<sessionId>/<branchId>/<toolCallId>.txt`, and the notice names that file for the read tool; the start stub is the only tool result the call stores, so `context.read` of the call id cannot reach the output. The files are kept like the job rows. When the session refuses that message (a full follow-up queue, for one), the refusal is logged (`exec-tools.background.follow-up.refused`) and the row gets `undelivered_at`: every step reads the branch's unread undelivered jobs into a `# Background commands finished` turn notice with each outcome and the head and tail of its output (2,000 characters; a cut output names its file the same way), cleared by `notice_read_at` like an interrupted job. A later accepted send of the same job (the replay of a `Terminal` claim, for one) clears `undelivered_at`, so the model does not get the result twice. A job that cannot finish becomes `interrupted`: its fiber marks the row when it is stopped (server stop, or its resource closed), and a new process marks rows an earlier process left running. The process died with the job, so nothing is reattached. An interrupted job wakes nobody: opening a session must not spend a turn with no user present. `turnProjection` (every step) reads the branch's interrupted jobs whose row has no `notice_read_at` into a `# Interrupted background commands` turn notice, which tells the model to report them and to start one again only when the user asks; `turnAfter` sets `notice_read_at` on exactly the jobs in `readNotices`, the ones an answered turn's steps showed, so a failed, interrupted or unanswered turn keeps them. A repeated start of an interrupted call queues nothing. A table from before the column keeps its interrupted jobs unread: the earlier code told a branch only when its loop opened, so a job shows once more at worst and is never lost. Two processes that add the column at once both start: a failed add reads the table again. A session nobody sends to is not told.
- Persistent goals (`@gent/goal`) live in `<data dir>/goals/<branchId>.json`. After every uninterrupted turn while a goal is active, the goal `turnAfter` hook charges the turn's usage to the goal (a turn that started before the goal existed is charged only its time since the goal's creation, by `turnAfter`'s `startedAtMs`) and queues a `goal-context` user message; a spent token budget flips the goal to `budget_limited` instead. Only the `goal` tool's `complete` action ends a goal. The TUI collapses `goal-context` rows to one line unless full detail is on.
- Foreground runs persist a child session/branch and can be revisited with `read_session`. Private runs leave no session behind; they return text/usage/tool-call metadata only.
- `TurnCompleted` carries the turn's token totals, summed over its model
  steps. It is absent when any step reported no usage or an unusable count,
  when the turn had no step, and on historical receipts. Explicit zero is
  retained. Run results and child completions read usage from that receipt
  and the answer from the branch's last assistant message; nothing scans the
  event log. These are reported stream totals, not model-attempt accounting.

### Interactions (Cold Pattern)

Session snapshots and event replay use the same storage-backed event service,
including when SQLite runs in memory. `EventStore.Memory` is an explicit test
override, not the default for in-memory application sessions. This keeps the
snapshot cursor aligned with replayed navigation and interaction events.

Slow-client policy: the session PubSub registry in `domain/event.ts` gives each session one sliding
PubSub of event ids, not envelopes. Publishing never waits for a subscriber, so a
stalled client cannot block tool execution. `makeCursorReplayStream` opens the
subscription first, drains the durable store from the subscriber's cursor, and
drains again on every notification burst. Lost or coalesced notifications cost
one extra read, never an event, and replay and live delivery share one ordered
source, so there is no replay/live race. Both `EventStoreLive` and
`EventStore.Memory` use this path; `tests/domain/event.test.ts`
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
replay also requires a trusted, unchanged saved tool binding.

Whether a turn can ask comes from its session and its origin, not from a
stored flag (`turnCanAsk` in `domain/message.ts`): a turn can ask unless its
session was spawned and no client opened it. A spawned session
(`isSpawnedSession`) has a parent and starts its own thread: a delegate child
or a `/btw` fork. A handoff has a parent too, but it joins the parent's
thread, so it is the user's own conversation; spawn depth counts the same
rule. Deleting a session deletes the same way (`deleteSession`): the session,
what it spawned and each spawn's own handoffs go; a handoff that continues the
deleted session's thread stays, detached from its parent, and its runtime is
not stopped. Child sessions stored before `bded8dce` carry their parent's
thread, so they read as handoffs: they ask, do not count toward spawn depth,
and survive a parent delete (accepted in the pass-10 ledger). A top-level or handoff session's user watches every turn there, so its
wake, monitor, delegate-completion and slash-command turns ask. In a spawned
session, only a turn a client opened asks (a user who prompts or steers the
child); a turn its parent's `delegate.start` or `session.send`, a wake or a
monitor opened declines. `btw` opens each fork turn with `Session.send`, so a
fork turn declines too: the `/btw` pane shows the fork's reply, not its
approvals. The origin is trusted: the server stamps
`metadata.fromClient` on every message a client sends (`message.send`, a
session's initial prompt, a `steer.command` interjection) over whatever the
client set, and removes a client-supplied `extensionId`; an extension's
`Session.send` stamps its own id and removes `fromClient`. One exception keeps
a slash command a user types in a spawned child able to ask: while a client's
extension request runs, a message it sends to the request's own branch keeps
the client origin. A send to any other branch, or one made after the request
ended, is an extension send. Every extension gets the same rule. Neither
boundary passes the loop's marks: `joinedTurn` and a runtime custom type
(`continuation`, `steering`, ...) would make recovery skip the turn, so both
are removed; an extension keeps its own custom types, a client sets none. A child row stored
before the stamp existed has no origin, so its turn declines on recovery. A
declined turn's `approve` answers at once, and the tools that ask the user are
withheld. The loop reads the fact from the turn's opening message and the
stored session, so it survives a restart. The decline's notes say to report
the command the way the turn reports its result (a child's task turn: its
reply, which its completion carries; a later turn: `session.send`), and that
no message can grant it: the reader runs the command, or a user prompts the
session directly. The bash and monitor blocks carry those notes.

An inner call of a dispatching tool (a cell) is the exception: its dispatcher
cannot replay its source, so the call waits for its answer in place through the
`InteractionOwnership` seam, and the other inner calls keep running. The turn
stays Running while the dialog is open. A native call that asks while such a
call's question is open waits for the slot, then asks its own question. A call
that asks after a sibling parked with an answered question parks behind that
answer; the sibling takes it when the step runs again. A source-only tool
without durable identity can resume in the same loaded generation, but not after
an unsupported restart or replacement.

```text
native call: tool calls ctx.Interaction.approve({ text, metadata? })
  → ApprovalService.present() checks for a stored answer (cold resume)
    → if found: takes it, returns { approved, notes?, editedContent? }
    → if not: persists to InteractionStorage, publishes InteractionPresented
      → InteractionPendingError thrown
        → machine parks in WaitingForInteraction (cold, no turn fiber)

inner call of a cell (owned ask: `CurrentInteractionOwner` provided, which
the interaction service reads itself)
  → waits for the slot while the open request's owner still runs
    (refused with InteractionSlotBusyError when that owner parked: it would
    never free the slot)
  → persists through InteractionOwnership (operation → Waiting), publishes
    InteractionPresented
  → waits in place for the answer; the turn stays Running, siblings run on
  → answer: InteractionOwnership.take (operation → Started), request settles,
    the cell code gets the answer and continues

client responds via respondInteraction RPC
  → storeResolution(branch, requestId, { approved, notes?, editedContent? })
    → first answer wins: storage keeps it with one conditional UPDATE and
      memory keeps the same rule; the same answer again stores nothing, a
      different one fails with InteractionDecisionConflictError
    → the same answer again while it is stored and not yet taken wakes the
      loop and publishes InteractionResolved again (a first attempt may have
      failed after the store); once taken, it does nothing
    → a request the branch does not show and that keeps no answer (a wrong
      id, another branch's request, one closed without an answer) fails with
      InteractionRequestMismatchError
    → parked native call: machine receives InteractionResponded
      → WaitingForInteraction → ExecutingTools
        → tool re-runs, calls ctx.Interaction.approve(), takes the answer
    → owned call waiting in place: takes the answer at once

cancel while an owned call waits: the cell cancels, its call ends, the turn
  ends and dismisses the dialog (InteractionResolved dismissed: true)
loop close (server stop) while an owned call waits: the turn is interrupted,
  then BranchToolWork.stop ends the cell and records nothing, as a crash
  would; after a restart the request is rehydrated, the turn resumes on it
  (cell recovery suspends), and an answer runs the waiting operation once;
  the cell then reports its worker state as lost
```

**Event-driven UI.** The `@gent/interaction-tools` extension emits typed interaction events (`InteractionPresented` and friends on the session stream) and the client renders those directly. The source of truth is the storage row plus the durable interaction events (`derive-do-not-create-states`).

Key properties:

- **No blocked fiber for a native call.** `WaitingForInteraction` is a cold state — no background turn work. The machine is checkpointed and survives restarts. Only an owned call (a cell's inner call) waits in place, because its dispatcher cannot replay its source.
- **The first answer wins.** `storeResolution` is the one check on a reply. `InteractionStorage.decide` stores only when the row has no answer, and memory keeps the same rule. A retried reply with the same answer succeeds. While the answer is stored and not yet taken, the retry wakes the loop and publishes `InteractionResolved` again, because the first attempt may have failed after the store and the wake is idempotent by request id. After the call took the answer, the retry does nothing (the socket client retries transient errors); a different one fails with `InteractionDecisionConflictError`, so a late approval cannot flip a decline. A reply to a request that closed with no answer is refused. A reply reaches only the branch it names: `InteractionStorage.decide` writes and reads back only that session branch's row, so another branch's request, open or answered, is refused as a mismatch.
- **Crash-safe resume.** `rehydrate()` rebuilds the in-memory context lookup and re-publishes the event. If the process dies before wake, `listOpen()` in `InteractionStorage` provides the open requests for recovery: pending ones, and `taken` ones whose call still keeps the answer.
- **An answer goes to its owner.** The owner of a request is the tool call that asked and the index of that ask in the call's run; the row stores both (`owner_tool_call_id`, `owner_occurrence`, nullable for older rows). A branch shows one request at a time. Other owners queue in the order they asked, and a call that asks the same question never takes another call's answer. An answer whose owner ends its run without taking it is settled as abandoned, so the next owner asks. A dispatching tool's inner call (a cell) waits for the slot while the open request's owner still runs, and is refused when that owner parked; after a crash it resumes by its request id. An answer matches its question as well as its owner; a changed question asks again, for a dispatching owner too. A call keeps the answers it took (row status `taken`) until it ends, so a call that asks twice takes both, also across a restart. Only a tool call the loop runs can ask natively; an ask with no call and no dispatching owner is refused.
- **A request lives no longer than its turn.** A turn that ends without parking settles its open request and its kept answers, and publishes `InteractionResolved` with `dismissed: true` for a dialog nobody answered. A cancel sets the turn's interrupt latch even while the loop is parked, and an answer that arrived while a sibling call still ran resumes the turn as soon as it parks.
- **Exact replay.** Resume uses the saved assistant message, call ID, input, and
  binding. Completed sibling results are reused with their structured values.
  Only unfinished calls execute again. A pending call can repeat work before its
  interaction point; authors must make that work safe to repeat. This is not an
  exactly-once guarantee for arbitrary external effects.
- **Invalid replay.** Changed bindings and corrupt completed-result data fail
  explicitly. A paired failed result keeps later model turns usable. A corrupt
  completed result does not give permission to repeat the tool.
- **One binding policy.** `runtime/tools.ts` owns
  current capture, durable lookup, identity checks, and invalid local-binding
  cleanup for native and direct tool adapters. A missing durable row
  permits only a same-process, same-generation capability with no durable
  identity. A local copy cannot replace a missing durable row. Dynamic durable
  markers cannot replay. Each adapter owns result persistence and interaction
  handling.
  `resolveStoredToolBinding` validates an already-owned durable identity without
  reading an assistant-message binding row. Native replay uses this same check.
  Inner-operation storage can use it without synthetic transcript tool calls.
  Its caller must verify receipt ownership.
- **No permission rules.** A tool that guards a call asks once through the durable approval request (`ApprovalService`); the answer is not saved, and a request with no answerer fails closed. Core has no rule schema, no rule storage, and no `permission.*` RPC.

Files: `domain/interaction.ts` (InteractionPendingError, makeInteractionService), `runtime/extension-host.ts` (ApprovalService), `storage/storage.ts` (InteractionStorage, the pending read seam), `domain/agent-loop.ts` (WaitingForInteraction), `runtime/agent-loop.ts` (respond orchestration).

## Platform Boundaries

Core runtime should not reach for ambient process state unless the app shell is the real owner.

The Bun cell implementation in `packages/extensions/src/cell.ts` is the shipped model
execution surface. Its extension section registers the `@gent/cell` tool and selects it
through the ordinary `turnProjection` hook. `ToolPolicyFragment.modelSet` narrows
the final admitted host tools for model calls. The last explicit set wins; an
empty set advertises no tools. It cannot restore unknown, denied, or filtered
interactive tools. Without a set, the model receives the admitted tools directly.
The cell extension also renders its catalog through `systemPrompt`, whose
`hostTools` input contains the admitted host bindings' capabilities. `getToolPrompt`
exposes catalog text without the private execution metadata. Projection hooks see
the dispatched agent (config `agents[name]` and run overrides applied) with its
own `driver`; a config `driverOverrides` entry routes the model call only. `.gent/config.json` `agents`
reshapes an agent per name (`modelId`, `reasoningEffort`, `contextLength`, tool lists, prompt
addendum); project entries shadow user entries and a run's `RunSpec.overrides`
shadows both, so a workspace pins its orchestrator model under `main` and its
children's model under `delegate`, and a `delegate.start` call can still pick a
different model and effort for one child. Each turn reads the config files as
they are then, so an edit reaches the next turn without a restart. The loop has no `cell` name rule
for selection or allow lists. The server root still composes the extension before
the extension package builtins; its branch lifetime and worker build still belong
to core. Test presets that exercise host tools directly omit it.
The kernel section of `cell.ts` owns serialized evaluate/reset operations,
evaluation deadlines, host-call dispatch, and worker disposal. Each evaluation
receives its host service from the caller's Effect context. Worker faults lose
working state; ordinary cell errors preserve it. No cell is automatically replayed.
The process section of `cell.ts` owns the worker process and its bounded pipes. The worker runs
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

The `@gent/extensions` build compiles `src/cell-worker-boundary.ts` into `dist/gent-cell`.
Turbo builds that declared dependency before the TUI copies the worker into
`bin/gent-cell` beside `bin/gent`. `@gent/extensions` owns the worker build; the TUI only
packages it. The worker embeds Bun and needs no external Bun executable. Its
compile options disable automatic dotenv, bunfig, tsconfig, and package.json
loading. The process launcher uses this artifact as both its runtime
and worker path. Turbo caches core's `dist` output and both TUI binaries. The
TUI task hashes its build script. Run the root build for dependency ordering.
This is a packaged worker, not a daemon or a new session owner.
The cell owns where its worker lives: `cellWorkerLaunch` in `cell.ts` selects it
without opening it. The compiled host runs its sibling `gent-cell`. A source run
executes this checkout's `src/cell-worker-boundary.ts` with the running Bun, so it
never launches a stale built worker and needs no build first. The two are the
`Compiled` and `Script` cases of `CellWorker`. A script worker starts with
`--config=/dev/null --no-env-file`, the source-run match for the compiled
worker's disabled bunfig and dotenv autoload, so a project preload or `.env`
never runs inside the worker. The worker starts in its session's working
directory: the loop resolves it once per branch with `sessionWorkingDirectory`
(the stored session cwd, else the host's, the same rule as
`ExtensionContext.cwd`) and gives it to the branch-tool layer as `cwd`. The TUI
build sets the compiled-host marker `__GENT_COMPILED__` explicitly.
The actor section of `runtime/agent-loop.ts` allocates a child of the actor scope for each loop rebuild.
It publishes the loop handle before it transfers scope ownership. Failure or
interruption during construction closes that child immediately. A build that
starts cleanly forks the extensions' `loopOpen` hooks into the loop scope, after
the recovered turn (if any) started; closing the loop interrupts them. Loops are
lazy: no startup pass rebuilds them, so a session nobody opens runs no
`loopOpen` until a client or another loop reaches it (a snapshot is enough).
The loop behavior in `runtime/agent-loop.ts` uses this supplied scope to build `CellExecution.Branch`
and supplies the service to turn execution. Each branch owns a separate service and lazy
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
`parentToolCallId` naming the cell. The operation receipt section of `cell.ts` attaches compact
receipts (`tool`, `outcome`, `summary`) to the saved cell result whenever a cell
made inner calls, so the transcript keeps effects visible after reload. A
receipt summary, like the `summary` on a terminal tool event, comes from the
tool's optional `summary(input, output)` over wire values when the tool has one
(read, write, edit, grep and bash do); otherwise, or when it throws, the head of
the output. Recovery resolves each completed operation's recorded binding the
way a resume does; a binding that no longer resolves keeps the head of the
output. The TUI
nests live inner calls under the cell, counts them in the compact tree, and shows
receipts in the `cell` renderer. The headless runner indents nested calls, and
declines every interaction unless `--approve-all` is set (`apps/tui/AGENTS.md`).

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

The execution storage section of `cell.ts` provides outer cell admission in the existing
SQLite database. A claim must refer to one `cell` call in an assistant message
owned by the current workspace, session, and branch. Only the first claim returns
the stored source for evaluation. Repeat claims return the saved tool result or
`Incomplete`; that state does not prove a live worker and never permits another
evaluation. Results are immutable. Receipts cascade with their assistant message.
Admission rejects a caller-owned SQL transaction so its claim commits before
external effects start. Cell execution must remain outside SQL transactions.
`cell.ts` joins this store to the real kernel. Each
layer fixes one session and branch. It serializes admission, evaluation, result
storage, and reset. It opens a worker only after a fresh claim. Saved results and
incomplete claims do not start a worker. Initial startup failures consume the
same bounded replacement budget as later worker failures. Interruption leaves
the claim incomplete; the next call reports a typed unknown outcome without
running the source again. A saved result does not restore VM working state.
Inner operation bindings and durable approvals use the stores described below.

The namespace section of `cell.ts` keeps the top-level bindings of the last good
cell per branch (`cell_namespaces`) and restores them into a replacement worker;
the first result after a restore names what came back and what was omitted.
A binding is a global the cell added, or a worker global it rebound, deleted or
redefined with other flags (the worker keeps each global's starting descriptor
and compares value, accessors and flags), so `prompt` or `performance` declared
by a cell is saved, reported and reset like a new name. `tools` and `context`
are the host's: the worker installs them once per realm as accessors that are
not configurable, with a setter that throws, so a cell that declares, assigns,
deletes or redefines either fails or is refused, and neither can be lost. A
reset puts every global back as the worker found it; the Reset reply names
(additive, optional `unrestored`) any global the realm refused to remove or
put back, such as one a cell made not configurable, and the kernel then
replaces the worker, so a reset never leaves a global behind.
The worker reads each binding from its property descriptor, so a snapshot
never calls a global accessor (it is omitted as a function). The snapshot
encoder, the error renderer and the value display share one value reader in
`cell-value.ts` that never runs cell code: it reads data descriptors, runs
only host getters (those of every global error type, taken at load, compared
by identity), never touches a Proxy (Bun's `util.types.isProxy`), and reads
built-ins by brand (`util.types`). Every function it calls is saved at load
and called with the saved `Reflect.apply`: no method through a value or a
prototype at call time, no iterator, spread or `push` (lists grow through the
saved `Reflect.defineProperty` with a descriptor that has no prototype), and
a bigint or number becomes text through the abstract `String`. A value it
cannot read that way (a cell getter, a Proxy, an object where a string
belongs) is omitted as `unsupported`; the worker and the rest of the namespace
stay. Out of the reader's reach: Effect builds its `Option` and `Result` data
by assignment, and the worker's Effect runtime, error renderer string work and
JSON frames use the shared intrinsics; a cell that plants a setter on
`Object.prototype` or rewrites those stalls the worker, and the host replaces
a worker that stops answering.
A result's `bindings` names only the bindings its cell added or bound to
another value (compared by `Object.is`), and `bindingCount` (additive,
optional) counts the whole namespace: every result stays in the history, so a
full list on each would grow with cells times bindings. A result stored before
`bindingCount` lists every binding. A thrown value renders through the same
reader, one part at a time: its name and message, its detail (each inner
`BuildMessage` of a split syntax error keeps its position), and its cause. A
part that cannot be read gives a fixed text in its place and the other parts
stand; a thrown value whose prototype chain holds a Proxy gives one fixed
text. The display of a logged or returned value, a thrown non-Error, a cause
and an uncaught report (`displayValue`) follows `util.inspect` (`depth: 4`, 100
items, 8192 characters, no custom inspection) through the reader. Where
`inspect` would run cell code it shows a marker instead: `[Proxy]` for a
Proxy, `[Object: unreadable prototype]` for a Proxy on the prototype chain,
`[Getter]` for an accessor, and it never reads a `Symbol.toStringTag` getter.
A nested error shows as `[Name: message]` without its stack; an object lists
at most 100 properties, and one display formats at most 20 000 values.
The first kernel start of a branch with no saved namespace fixes its starting
namespace in its own row. For the opening branch (the oldest) of a handoff
session (a parent, not spawned: `isSpawnedSession`), that is a copy of the one
its parent saved on `parentBranchId`, and the report carries
`previousSession`; for every other branch it is empty. The copy is one hop and
happens once: neither side sees the other's later writes, and a parent that
saves only later is not inherited. The cell reads the session and its
branches through `ExtensionContext.Session` (`getSession`, `listBranches`). A
worker is kept only after its restore succeeds; a failed restore closes it,
and the next cell starts a clean one. A delegate child or `/btw` fork starts
empty. A reset saves an empty namespace, so a later restart inherits nothing.

`runtime/tools.ts` carries the transcript-owned call address
and the turn's selected tool bindings.
The shared turn dispatcher supplies it for each bound tool invocation, including
explicit tool invocation. `cell.ts` uses that address
and the current turn profile to enter branch-owned cell execution.
It does not search messages or accept a call address from model input. It rejects
an inner host operation that attempts to dispatch another outer cell. Missing
branch ownership or recorded turn context returns an `AgentLoopError`, not a
missing-service defect. The RPC test catches a nested-dispatch rejection inside
the worker and verifies that the attempted source did not change retained state.
The RPC lifetime test uses this adapter and checks two identical sources in one model
response. Each source runs once and receives a distinct result receipt.
`cell.ts` declares the cell tool and is exercised by
this RPC test. It returns saved
JSON success data or fails with the public `ToolResultFailure` type. The normal
tool runner preserves that failure's JSON data and still supplies transcript
identity itself. The type cannot select a call ID or tool name. Permission checks
and preflight hooks still run before execution. An inner call that asks waits
for its answer in place: sibling calls keep running, and the cell code continues
with the approved result or the declined failure. The approval RPC tests check
allow, deny, a sibling that finishes while the dialog is open, and a native call
beside the cell, through the real compiled worker. Only a lost worker leaves an
operation waiting; recovery then returns the saved operation results in a
failed outer result with visible worker state loss.

The input schema in `cell.ts` accepts optional `reset: true`. Admission
reads this flag from the stored assistant call. After a fresh claim commits, the
branch execution permit covers reset and evaluation together. Completed or
incomplete calls do not reset the worker. A repeated reset call returns its saved
result without clearing newer working state. Cancellation checks run before reset.
Reset uses the existing worker reset and bounded replacement path; it does not
replay old source or erase operation receipts.

A cell script can finish before its host calls settle: a rejected
`Promise.all` leaves the other calls in flight. The worker ends the cell only
after the last pending call has a reply, then reports the script's own result,
so the host never sees a cell end with orphaned calls and never tears down
work those calls admitted.

Fresh cell host calls select only from the supplied turn bindings. They do not
search the full extension registry by name. Thus an agent-denied tool cannot be
reached through a cell, and a newly registered replacement cannot replace the
captured capability. The host still enters the current turn profile and checks
permissions before execution. The RPC lifetime test verifies a registered but
agent-denied tool receives no calls. Catalog discovery must use this selected
set. Default cutover must retain a host binding set when the advertised model
surface narrows to `cell`; it cannot reuse a cell-only advertised map for discovery.

The catalog is instruction plus data, not a tool. When the surface narrows to
`cell`, the cell extension's `systemPrompt` hook adds a `## Host Tools` section
with one signature line per selected host tool: its callable path, an input
type and a result type rendered from the JSON Schema, and the first line of its
prompt snippet or description (`- tools.wake.cancel(input?: { wakeId?:
string }): Promise<{ cancelled: string[] }> // Cancel a pending alarm ...`). Nested objects
inline while short and otherwise render as `object`. The section is rebuilt
each turn, so live composition changes reach the model as ordinary instruction
changes. `cell.ts` builds the data half from the same selected map: name,
description, guidelines, and the actual Effect AI input schema, hashed over its
encoding. `dispatchCell` hands it to the cell host; the kernel sends it inside
`Evaluate` only when the hash differs from what the current worker holds, and
clears that memory when a replacement worker starts, so the first cell on a new
worker carries the full catalog. The worker keeps the catalog beside the
namespace: `reset` clears bindings, not the catalog, and a snapshot never
contains it.

Inside the cell `tools` is a namespace over that catalog: every selected id is
a callable path, split on `.` (`delegate.start` is `tools.delegate.start(input)`,
`must-not-run` is `tools["must-not-run"](input)`). Each node is a Proxy that
reads the current catalog, so one node can be a tool and a namespace at once
(`tools.wake(...)` and `tools.wake.cancel(...)`). A call sends the id itself as
the host call name, so operation receipts and replay key on the tool id. An
unknown path throws and names the three closest ids. A key JavaScript reads on
its own or defines on a function (`then`, `toJSON`, `constructor`, `call`,
`name`, ...; `reservedToolSegments` in `cell-protocol.ts`) keeps its JavaScript
meaning and never names a tool, so `await`, `JSON.stringify`, and inspection
never call one. `tools(id)` is the one lookup by string: a local synchronous
read that returns the tool as a function carrying its catalog entry (`id`,
`description`, `guidelines`, `parameters`). It reaches an id with a reserved
segment, which the prompt renders as `tools("read.then")(input)`; it records
no operation receipt and grants no execution permission. A call with no
argument sends `{}`; the signature marks `input?` only when the schema accepts
`{}`. Enums past eight literals, and input or result types past 300 characters,
render as their outer shape; a test holds every shipped tool's result under
that bound, so the cell code reads each result whole. The RPC lifetime test
checks the namespace keys and a host schema through the compiled worker, and
that a later cell without a catalog still describes the tool. An agent-denied
tool and the outer `cell` are absent from the namespace.

Tool dispatch accepts separate outer and host binding maps. Normal turns supply
the selected map for both. Recovery validates pending outer calls against their
saved binding identities. If an outer cell was never admitted, recovery also
resolves the current agent policy to obtain its host set. It does not limit that
set to pending outer call names or search the unrestricted registry. If current
policy removes `cell`, the replay dispatcher receives no outer cell binding and
returns a failure without executing it. Already admitted cells still use saved
operation recovery and never evaluate their source again.

`cell.ts` adapts one already-bound host call to
`ToolRunner.runBound`. It does not resolve a missing binding by name. The caller still owns the durable operation
receipt. Execution returns the original tool result.
A separate result conversion runs after persistence and maps failures to cell errors.
An inner call never parks the turn: it waits for its answer in place. A call
that parks anyway fails closed as a cell error. Only recovery suspends: an
operation a lost worker left waiting, with no answer yet, parks the turn on its
request. Durable inner operation resume uses the recorded host below; suspension
never authorizes cell replay.

The tool operation storage section of `cell.ts` records inner operations under an
admitted outer cell in the same SQLite database. The operation's input, tool
binding, and derived tool-call ID are immutable. Its state is Started, Waiting,
Resuming, or Completed. Repeated admission never grants another execution.
Resume requires the exact waiting request and a valid saved approval decision.
It commits Resuming before tool execution; that state cannot be reclaimed after
a crash. A call that takes its answer (in place, or on resume) returns its
operation to Started before the request settles, so its next ask starts fresh. A unique request link prevents two operations from sharing an approval.
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

`cell.ts` joins fresh inner-operation admission to
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
`CellToolOperationStorage.listForToolCall` provides the durable recovery input for
that integration. It checks workspace, session, branch, and the admitted outer
call. It returns all operation receipts without granting another execution.
The branch phase is held in memory; queue storage persists the in-flight item,
not the complete Running state. Recovery must use stored cell receipts rather
than depend on a new field in that transient phase.

`cell.ts` builds the paired outer result after the
branch owner has stopped cell execution. It preserves undecided approvals,
resumes only waiting operations with saved decisions, and reuses completed
receipts. Started or Resuming operations remain unknown; recovery does not
execute them again. Its saved outer result reports lost worker state and lists
completed tool results separately from unknown operations. Repeated recovery
returns that result. This adapter has no evaluator call. Callers must not run
recovery beside an active cell.

`runtime/turn.ts` routes admitted saved cell calls through this
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
  executable path, ids, hashing, and OS info. Time comes from Effect's `Clock`,
  so a test can drive it.
- `RuntimeEnvironment` carries launch/session configuration values:
  `cwd`, `home`, and platform name.
- tracer/logger services
- file system / path / OS services

### File listing (fs-tools)

File discovery is owned by the `@gent/fs-tools` extension, not core. `packages/extensions/src/fs-tools.ts` holds one stateless `listFiles` function over the platform services and one listing rule: an ignore authority decides which files grep may read. Inside a git work tree the authority is git: `git ls-files -z -t --cached --others --exclude-standard` below the search path, so every git exclude source applies; a sparse checkout's skip-worktree entries are dropped before the 100,000-file bound, and a name that is not valid UTF-8 is counted in grep's `unreadable` field. A git that does not answer within 10 seconds fails the search and asks for a narrower path; the walk does not stand in for it, because it misses `info/exclude` and the global excludes. A tracked path under a directory that is now a symbolic link is not listed. Outside a work tree a `FileSystem` walk reads each `.gitignore` from the search root down by gitignore(5); a test checks that matcher against real git. An ignored target named explicitly (`dist/`) is walked from its own root. No listing follows a symbolic link. grep reads 16 files at a time and reports matches in path order; it decodes a UTF-16 file by its byte order mark, skips binary files (a NUL byte in the first 8 KB), skips and counts files over 10 MB in `oversized`, and cuts a line over 500 characters around the match without splitting a surrogate pair. The listing holds no state, so there is no Tag and no resource. The TUI's `@` popup reads the same listing through the read request `FilesRpc.List` (paths relative to the session cwd, sorted), so a user can name exactly the files the model can search. fff (`@ff-labs/fff-bun`) ranks them: it scans the session's directory, keeps its own pick frecency under `~/.gent/fff`, and the popup keeps only the listed paths, paging through fff's ranking until it holds 50 or has read five pages of 200; when the five pages run out first, the shared autocomplete matcher fills the rest from the listing. The listing and a read in flight are keyed by session, so a switch never ranks the session it left. Where fff cannot run, the shared autocomplete matcher ranks the listing. Core has no file-index concept, and there is no `ExtensionContext.Files` facet: tools yield `FileSystem` and `Path`.

App entrypoints bind concrete Bun/OS behavior:

- `apps/tui/src/main.tsx`
- `apps/server/src/main.ts`

Production rule:

- `apps/tui/src/main.tsx` resolves a server via `Gent.server()` + `Gent.client()`
- `--connect <url>` attaches to a remote server via `Gent.client({ url })`
- `apps/server/src/main.ts` is the standalone durable server boundary

## Shared Server Discovery

`packages/sdk/src/server.ts` owns shared-server discovery. Two files sit beside `data.db` in the data directory (`GENT_DATA_DIR`, else `~/.gent`):

- `server.lock.db` is the kernel lock. The owning server holds an exclusive SQLite lock on it (`BEGIN EXCLUSIVE`, `busy_timeout` 0) for the life of its scope. The OS releases it when the process exits. A server is alive exactly when this lock cannot be taken, so a crash, a reboot, or a reused pid cannot leave a live-looking lock, and two concurrent starts give one owner: the other waits for the owner's entry and attaches.
- `server.lock` is the discovery entry the owner writes once it listens: url, pid, and the identity tuple. Clients attach only after `/_gent/identity` confirms the full tuple. An entry whose endpoint confirms the tuple counts as alive even when the kernel lock is free (a server from before the kernel lock), and a start probes it after it takes the lock, before it replaces the entry. `gent server stop` sends SIGTERM only after the same probe; `--all` removes an entry whose kernel lock is free and whose endpoint does not answer, and holds the kernel lock through that removal so a new owner's entry is never deleted.

A start that finds a confirmed server of another build on the database fails with a message that names its pid; it never signals it. `gent server stop` is the explicit way to stop it.

A fixed port (`apps/server`, `GENT_PORT`) changes only the attach decision. A SQLite server on a fixed port still takes the kernel lock and writes its entry, so the TUI finds and attaches to it; it never attaches to another server itself, and fails with the holder's pid when the database is owned. The standalone server runs until a signal stops it: there is no idle shutdown and no shared launch mode.

`packages/sdk/src/server.ts` resolves SQLite-backed clients through this single shared server record. Workspace isolation comes from the `x-gent-workspace-id` RPC header and workspace-prefixed AgentLoop actor entity IDs, not from per-workspace server processes.

The old SDK worker supervisor and worker-http transport are deleted. E2E coverage that needs process boundaries uses focused server-process fixtures; transport contract tests run through the in-process direct transport.

## TUI

TUI is a client over the shared contract, not a parallel app.

The session feed uses the durable input-message and step identity for each assistant message. The protocol exports the shared answer-ID rule. Stream chunks update that message only. Tool events locate their owning message by call or assistant ID, including late child results. Historical streams without IDs receive one local ID per stream.

The native transcript sends whole completed items to terminal scrollback when the live view overflows. An item stays entirely in scrollback or entirely in the live view; the TUI does not split it by row. The session feed retains the data for disclosure and resize replay. User messages use an OpenTUI heavy left border, so snapshot layout does not depend on a later height callback. Streaming still stays in the live view until the turn settles. Incremental one-shot output remains separate work.

Production shape:

- local mode: one process owns renderer, runtime, storage, and reconnect UX under one root scope
- remote mode: TUI shell attaches to an external server boundary and rehydrates from transport state
- reconnect logic rehydrates from runtime state, not UI guesses

Main boundaries:

- `apps/tui/src/client.tsx` for client/session/event state
- `apps/tui/src/session.tsx` for session-screen orchestration
- `apps/tui/src/extensions/client-facets.ts` for TUI-owned extension facets
- route state machines for modal/session surfaces
- components like `composer.tsx` and `message-list.tsx` as presentation + local interaction

Rules:

- one screen-level owner for session state
- one keyboard owner per route surface
- overlays/composer flows modeled explicitly
- renderer tests cover critical capture/focus paths

## Extensions

Extension shape lives in:

- `packages/core/src/extensions/api.ts` — public authoring surface (`defineExtension` + smart-constructor re-exports)
- `packages/core/src/domain/extension.ts` — `ExtensionContributions` typed-bucket carrier (core primitives only)
- `packages/core/src/domain/extension.ts` — server contract (`GentExtension`, `ExtensionSetupServices`)
- `apps/tui/src/extensions.ts` — public client authoring surface (`@gent/tui/extensions`); every shipped client extension imports the TUI only through it
- `apps/tui/src/extensions/client-facets.ts` — TUI-owned client facet model
- `packages/core/src/runtime/extension-host.ts` — server registry
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
  `@gent/core/extensions/branch-tools` and `effect`, bound by the server loader
  (`extensionEntryModules`, `runtime/extension-host.ts`) and by the TUI loader.
- The peers the shipped extensions import: `BuiltinExtensionModules` in
  `@gent/extensions`, bound by the SDK server root before it loads extensions.
  It holds each `effect/*` and `@effect/*` specifier that
  `packages/extensions/src/` or `examples/extensions/` imports, and no other.
  `packages/extensions/tests/index.test.ts` derives that set from the sources
  and fails when the map differs, so a shipped extension never reads a module
  a user extension cannot. A user extension is as capable as a shipped one.
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

### Extension API Inventory

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
- author-facing errors: capability, provider-auth, agent-run, and typed
  transition errors that extension code can intentionally return or inspect.

Everything else is builtin/internal:

- raw runtime host context and hook plumbing (`ExtensionHostContext`,
  permission/context message internals);
- storage, event publisher, event store, session mutation services, and
  interaction pending readers;
- runtime/platform services (`GentPlatform`, `ToolRunner`);
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

For the full authoring guide, see [docs/extensions.md](docs/extensions.md). Example extensions in [examples/extensions/](examples/extensions/).

### Server Extensions

One authoring shape: `defineExtension({ id, setup })`. `setup` is an Effect that yields `ExtensionHost` (`packages/core/src/domain/extension.ts`) and calls `host.register(domain, ...values)` for leaves (`tool`, `request`, `resource`, `agent`, `modelDriver`) and `host.on(kind, handler)` for hooks. Setup-time host facts (`cwd`, `home`, `host`) live on the same service; runtime host authority comes from `yield* ExtensionContext`. The domain string IS the discriminator — TypeScript checks the value type per domain at the call site. The loader (`runtime/extension-host.ts`) provides a collecting host, seals the registrations into `ExtensionContributions`, binds requests to the extension id, and runs `validateExtensionPackage` so malformed registrations fail activation instead of dispatch.

There is no flat `Contribution[]` and no `_kind` discriminator. `ExtensionContributions` (`packages/core/src/domain/extension.ts`) is the compiled record consumed by the registry, hook compiler, and profile build; adding a new kind means adding a registration domain and a record field, not a new union arm. Each extension's process resources build once into their own child of the profile scope, which owns acquisition and release.

- **Resource** — `defineResource({ id, scope, layer })`. Start work runs in the layer build and disposal is a finalizer in it. Long-lived state has a stable identity and explicit `scope`; resources build in extension resolution order. `scope` is `"process"` (built once per profile, released when the profile scope closes) or `"branch"` (built per branch loop, released when the loop closes). Stateful extension logic is either a normal scoped service/resource or, for true actor protocols, an Effect Entity/RPC owner at the runtime boundary. See `packages/core/src/domain/extension.ts` and `buildResourceLayer` in `runtime/extension-host.ts`.
- **Callable leaves** — `tool(...)` / `request(...)` smart constructors registered under the `tool` and `request` domains. `tool` = model-facing tool; `request` = typed extension RPC, optionally decorated with `slash: { trigger?, name, description, category?, keybind? }` to surface as a human slash command. Handlers receive input only. Host authority comes from the `ExtensionContext` facade (`Session`, `Interaction`, `FileLock`, `State`); files, paths, processes, and ids come from the Effect platform services (`FileSystem`, `Path`, `ChildProcessSpawner`, `Crypto`); extension-private authority comes from extension-owned Effect service Tags. The `FileLock` facet wraps the host-internal `FileLockService`, and the `State` facet publishes `ExtensionStateChanged` on `EventStore`, so shipped and external extensions share the same surface. See `packages/core/src/domain/capability.ts`; `runtime/extension-host.ts` compiles the model, RPC, and slash registries.
- **Addressed session verbs** — `ExtensionContext.Session` reaches other branches through the same verbs the server uses: `create` (durable-once by `requestId`, optional `historyBranchId` copies the visible rows in, depth admitted by the host), `send` (one user message with a `delivery` mode: `"turn"` starts a turn on another branch with the loop `completion` modes, and the own branch refuses it and points at `"queue"`; `"queue"` is a follow-up keyed by `sourceId`; `"steer"` joins the running turn as an `Interject`), `stop` (writes a `Cancel` steer that stops the running turn, whichever message opened it; `Interrupt` has no writer and only decodes), `stopMessage` (the persisted `StopMessage` actor operation, through `stopMessageOn`: it records the durable cancellation of one message id, so a turn that message opens later starts interrupted, takes back a steer with that id that no step has read, and interrupts the running turn that message opened. A step's join of steers and the take-back hold the same queue permit, so a message is either joined or taken back, never both. It answers true only when this stop reached the message; false when the loop no longer holds it (its turn ended, or a step joined it into a turn another message opened, which runs on) or an earlier interrupt already stops its turn. A steer taken back answers true, unless an earlier stop from the same requesting branch already stops the turn the steer waited to join: the turn's latch records the requester of its first stop, and that stop's caller already reports the branch. A `Cancel` steer that names a `messageId` still decodes and runs the same routine), `events` (replay, then the `StreamSynchronized` marker, then live; `from: "now"` skips the replay and starts at the newest stored event), `delete` (cascade), `dequeueFollowUp`, and `holdResident` (a scoped hold that keeps the own branch's loop resident; see Residency). `send` and `stop` are a facade over the unchanged actor operations `SubmitDurable`, `QueueFollowUp`, and `Steer`, except that a `queue` or `steer` into the loop's own branch is admitted re-entrantly inside the caller: a client request's grant is read at admission, while the request provably runs, and a send from a context kept past it is an extension send; the raw `SteerCommand` stays on the RPC contract, not in the extension API. The bodies live in the `agent-loop.client` section of `packages/core/src/domain/agent-loop.ts`; The loop's `sessionControl` calls the queue bodies (`queueFollowUpOn`, `dequeueFollowUpOn`), and both `SessionRuntime` and `sessionControl` call `submitUserMessage` and `steerLoop`, so the facade and the RPC path cannot drift. The verbs are uniform: no extension, shipped or not, holds a grant another lacks. `AgentDefinition.maxModelAttempts` (and the RunSpec override) is the generic per-turn model-attempt budget, reserved durably per turn message id.
- **Hooks** — `host.on("systemPrompt" | "turnProjection" | "turnAfter" | "loopOpen", handler)` registers the four runtime hooks; each kind is typed by `ExtensionHookSignatures`. `loopOpen` takes no input and runs once each time a branch's loop is built in this process (the first operation after a restart, or after the loop closed), after the loop resumed any turn a restart cut short. It is where an extension repairs what a previous process left on the branch: re-arm timers, resume children, report lost work. It runs as the loop's own fiber, with the branch Resources and a non-client opener (it cannot ask). Nothing in it takes the side-mutation permit, which a running turn holds: the profile resolves under the profile cache's place lock and the Resources build under the branch's own lock, so the hooks run beside a turn the open resumed. Each hook runs on its own fiber, so a hook that never returns delays no turn and no other hook. A follow-up it queues on its own branch starts a turn like any other send, and the operation that opened the loop never waits on it. User extensions register it the same way. Hooks, tools, and requests all cross one membrane: `provideExtensionLeaf(frame)` in `runtime/extension-host.ts` reads the run's `CurrentExtensionHostContext` and provides `ExtensionContext`; `turnProjection` receives the agent the turn dispatches (`TurnProjectionInput`). Hook handlers receive event input only and yield `ExtensionContext` or extension-owned service Tags when they need authority. `turnAfter` carries `usage: { known, complete }`: the tokens of the steps that reported usable counts, and whether that is the whole turn (`TurnCompleted.usage` carries a total only when it is complete). See `packages/core/src/domain/extension.ts` and `runtime/extension-host.ts`.
- **Driver** — the `modelDriver` domain takes a `ModelDriverContribution`. Model drivers provide LLM provider layers + auth and list their own catalog (`listModels(auth)`; core concatenates every driver's list and fetches nothing — the shipped drivers read models.dev through the catalog section of `packages/extensions/src/providers.ts`, cached on disk for a day). An agent's `driver` (or a `driverOverrides` config entry) names a model driver; a stored override that names a removed external (ACP) driver decodes as no override and logs one warning per config file. See `packages/core/src/domain/driver.ts`, `domain/agent.ts`, and `runtime/extension-host.ts`.

Other notes:

- A process Resource layer that fails to build rejects its extension: the
  profile reports it failed at the `startup` phase, closes what that layer
  acquired, and keeps its siblings live. Branch resources come from the
  session's profile (the extensions set up for the session's cwd) and build
  together on the loop's first turn or extension request, so a control-plane
  write never resolves a profile, and a branch resource that fails to build
  fails that loop, not one extension. Release runs in reverse build order when the owning
  scope closes.
- Prompt shaping, input normalization, permission policy, and turn hooks are explicit runtime slots compiled from extension hooks and typed leaves, not generic middleware buckets.
- The agent is a session property. `Session.admission` (agent, run spec;
  `sessions.admission_json`, migration 023) is fixed at creation,
  and every turn of the session runs under it: the first, a wake, a queued
  follow-up, a steer that starts a turn, and a recovered turn after a restart.
  `resolveSessionRoute` (`runtime/turn.ts`) resolves it once for the turn,
  the snapshot (`SessionSnapshot.agent`) and the auth check. No queue item,
  steering command, turn record or loop state carries an agent. A handoff
  (`continueThread`) keeps its parent's admission unless it names one. A row
  stored while admission carried `interactive` still decodes; the key is
  ignored and dropped on the next write.
- Model precedence: the session's `/model` setting, then the admission's run
  overrides, then config `agents[name]`, then the agent definition.
- `createSession` accepts optional `initialPrompt` + `admission` for atomic create-and-send.

### Publishing events

Runtime code yields `EventStore` (`domain/event.ts`) directly. `publish` appends an event and delivers the envelope to subscribers; `append` and `deliver` are also separate so a mutation can append inside its transaction and deliver after commit. The extension `State` facet publishes only `ExtensionStateChanged` on the same store. Publishing is cwd-agnostic; per-cwd extension behavior comes from the turn's profile.

### TUI Extensions

- Builtins live in `apps/tui/src/extensions/builtins.tsx`; a builtin with its own view keeps its own `apps/tui/src/extensions/*.client.tsx` file
- Each is an `ExtensionClientModule` from `defineClientExtension` — same pipeline as user/project extensions
- Loader (`apps/tui/src/extensions/loader-boundary.ts`) accepts `disabled` list to filter extensions by id before `setup` runs
- Client extensions author against one public entry, `@gent/tui/extensions` (`apps/tui/src/extensions.ts`): `defineClientExtension`, `ClientContext`, the contribution constructors, `sessionQuery` and the rendering kit. A shipped `*.client.tsx` imports the TUI only through that entry.
- One `setup` shape: `Effect<ClientContributions, never, R>`. A setup handles its own failures; a defect is recorded as a load failure. Setups yield from the per-provider `clientRuntime`, which provides `FileSystem | Path | ClientContext`. `ClientContext` is the client twin of `ExtensionContext`: one Tag with the `transport`, `shell`, `workspace`, `lifecycle`, and `activity` facets, which a setup yields (`const { transport, shell } = yield* ClientContext`) and never threads as a parameter. There is no imperative `ctx` argument, no sync `(ctx) => Array` arm, and no package wrapper around paired server/client modules: a server extension and its `.client.{ts,tsx}` module are separate artifacts that share an extension id.
- Widgets are transport-only: subscribe to `transport.onSessionEvent` for event-backed invalidation or `transport.onExtensionStateChanged` for explicit extension-state notifications, then call typed extension RPC via `transport.request` for current state. Each widget owns its own Solid signal, keyed on `(sessionId, branchId)` so a stale model from the prior session never renders. See `apps/tui/src/extensions/builtins.tsx` for the canonical pattern.
- `lifecycle.addCleanup` registers Solid `createRoot(dispose)` disposers and event unsubscribes; the provider's `onCleanup` reaps them on unmount, so widget setups leave no detached roots behind.
- `lifecycle.scoped` allocates Effect resources in the client-provider lifetime. The main TUI scope awaits provider disposal before process exit.
- `activity` exposes a reactive view of the active UI session and its working, blocked, idle, or unavailable state. A surface with no activity to report reads `"unknown"`.
- `@gent/herdr` is a built-in client extension. It reports that UI activity through Herdr's local socket when `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID` are present. It sends ordered reports with the session ID and releases its authority on exit. The shared server and child agents do not own this reporter.
- `useExtensionUI()` (`extensions/host.tsx`) is host-side, not extension API: the shell reads the resolved contributions, load failures and `clientRuntime` through it. A widget reads the active session from `transport.currentSession()` or `sessionQuery`.
- Widgets are zero-prop components that self-source from context hooks.
- An extension draws its own transcript rows with `messageRendererContribution`, keyed by the message's `metadata.customType`. The core transcript names only the runtime's own kinds and falls back to the plain row.
- A row that is not a message comes from `noticeRowContribution`: the extension derives it per branch from `transport.onSessionEvent`, and the session view merges it into the transcript by time. Nothing stores it and the model never reads it. The session feed opens without waiting for client extensions; the client keeps what the feed delivered on the branch and hands it to a subscriber that joins late before the live envelopes, so each one sees the branch from its first event. A reconnect repeats envelope ids, which the subscriber skips. A source answers `None` until it can say its rows, and native history commits nothing until every source answers, so a committed row never changes. History holds for a source only 5 s after the client extensions loaded, so a source that never answers cannot hold it for good; after that, history commits without the source. The source is not a failure and stays: a later answer draws its rows among those history has not yet committed.
- `@gent/cache` (`cache.client.tsx`) folds a branch's stream, tool, interaction, message and compaction events into prompt-cache misses above a 1,024-token noise floor. Each miss gets a cause over the interval the TTL runs on, from the start of the request that refreshed the cache: a model switch, a changed prefix inside the 5-minute TTL (the regression alarm for a moved cache marker), or an expiry during a long response, a tool call, an approval wait, a paused turn, before a child completion, before a wake, or after idle time. The missed tokens fill the step's cache writes first, at the write rate, and the rest paid the input rate; each is priced over the cache-read rate, by the model the runtime priced the step by (`StreamEnded.pricedModel`, which follows a driver override) in `transport.modelCatalog()`. A miss is priced once, when the catalog is there; its row is born with that text. A row shows a miss of 20k tokens or $0.10; the status row shows the branch's `cache waste $X`. The row is telemetry for the reader, not context for the model.

### Extension State

Extension state lives in scoped Effect services/resources and publishes product
events through the normal session event stream.

True actor protocols should be introduced at their owning runtime boundary
using Effect Entity/RPC rather than recreating mailbox, discovery, persistence,
or ask/reply infrastructure inside extension authoring.

**Event-backed client invalidation**:

- Server event publishing appends and broadcasts committed `AgentEvent`s only; it does not synthesize extension invalidation events from registry metadata.
- TUI widgets that derive state from events subscribe with `transport.onSessionEvent` and refetch their typed extension RPC when relevant event tags arrive. `@gent/goal` is an event-backed widget.
- `ExtensionStateChanged` remains available as an explicit, payload-free notification event for extensions that choose to publish it directly.

## Testing

Use the smallest honest boundary:

- pure helpers: unit tests
- transport/app services: Effect tests
- TUI render/capture: OpenTUI renderer tests
- runtime ordering/turn semantics: recording layers + runtime tests

**Banned test primitives**: `Provider.Test`, provider-wrapper statics, and `EventStore.Test` are deleted. Use `LanguageModelLayers.debug()` / `LanguageModelLayers.sequence([...])` from `@gent/core/test-utils` for model mocking and `EventStore.Memory` for in-memory event stores.

**Banned test control flow**: test files do not use `async`/`await`, Promise chains, raw Promise-returning test bodies, or hook cleanup patterns. Use `it.live` / `it.scopedLive` and scoped Effect resources so finalizers run under the test runtime.

**Names describe behavior**: active test modules are behavior-named. Historical process names belong only in `plans/` and dated audit receipts.

### Commands

| Command            | Scope                                                 | Target  |
| ------------------ | ----------------------------------------------------- | ------- |
| `bun run test`     | product behavior: core + tui + sdk + fast integration | ~2-4s   |
| `bun run test:e2e` | PTY e2e + focused server-process lifecycle coverage   | ~50-70s |
| `bun run gate`     | typecheck + lint + fmt + build + test                 | ~15s    |

### Test structure

`packages/core/tests/` mirrors `packages/core/src/`. Implementation tests use relative imports into that source tree. They do not depend on the package entries:

```text
tests/
├── domain/        # auth, agent, event, message, skills, ...
├── extensions/    # api, registry, compile-tool-policy, hooks, loader, ...
├── providers/     # provider, provider-auth, provider-resolution, anthropic-keychain
├── runtime/       # session-runtime, agent-loop, retry, agent-runner, tool-runner, ...
├── server/        # rpcs, session-queries, system-prompt
├── storage/       # sqlite-storage and the focused sub-storages
└── test-utils/    # sequence
```

One test file per source file. No god tests. Names match source owners.

`packages/e2e/tests/` holds only the slow end-to-end suite; in-process contract tests live in each package's `test` task:

- `test:e2e` — PTY TUI tests and focused server-process lifecycle coverage

### Important files

- `packages/core/src/test-utils/index.ts` — `SequenceRecorder` and the
  recording layers; `baseLocalLayer`, a production-root preset over
  `createDependencies` with in-memory SQLite, storage-backed events, debug
  providers, and test service overrides; `createE2ELayer`, a preset that keeps
  real `ToolRunner.Live`, extension setup/resource startup, event publishing,
  and interaction recovery while expressing test
  storage/provider/auth/approval differences through dependency overrides; and
  `createRpcHarness`, the thin RPC acceptance helper that chains
  `createE2ELayer` → `createRpcClient` (the in-process RPC client,
  `makeInProcessClient` in `packages/core/src/server/server.ts`) → seeded
  `session.create`
- `packages/core/src/test-utils/language-model.ts` — `LanguageModelLayers.debug`, `sequence`, `signal`, `failing` + stream-part helpers
- `apps/tui/tests/render-harness-boundary.tsx` — TUI render test harness

## Interaction Tools Extension

`@gent/interaction-tools` — `ask_user` and `prompt` tools.

The TUI renders interactions from the typed event feed (`InteractionPresented` etc.) routed by `metadata.type`. Pending interaction storage remains the durable source of truth for crash-safe resume. A branch has at most one open request. A second guarded call in the same step parks on the open one; when the step runs again, it waits until the first call takes its answer (matched by the encoded request), then asks its own question.

## Workflow Results

Working values live in the kernel. Durable results are ordinary files. There is no separate result store, result RPC, or count badge. File links refer to the current content, not an immutable revision. A branch fork does not copy a saved plan; adoption requires an explicit file copy.

Workflow commands (`/plan`, `/review`, `/audit`, `/counsel`, `/research`) live in `@gent/workflows` as outcome prompts. They retain no workflow state and impose no fixed child count. The model uses cell bindings and files for working data, and delegates independent work when useful. Final plans, reviews, and audits use atomic writes to `.gent/results/<session>/<branch>/<kind>.md` in the server working directory. Explicit exports are separate files. Empty `/plan` reads that branch-local file without kernel bindings; it does not infer a plan from another branch. A plan saves its result and ends that cell before it requests approval in a separate cell, so the last good namespace precedes suspension. Review and audit prompts allow saving their reports but prohibit source edits; this instruction is not a sandbox boundary.

## Observability

Wide event boundaries (one structured log per unit of work) via `effect-wide-event`:

| Boundary     | Service       | File                    |
| ------------ | ------------- | ----------------------- |
| Agent turn   | `agent-loop`  | `runtime/agent-loop.ts` |
| Tool call    | `tool-runner` | `runtime/tools.ts`      |
| Model stream | `model`       | `runtime/agent-loop.ts` |
| RPC request  | `rpc`         | `server/server.ts`      |

Logging conventions:

- Structured annotations: `Effect.logInfo("noun.verb").pipe(Effect.annotateLogs({ key: value }))`
- Never `Effect.logWarning("msg", error)` — always `.pipe(Effect.annotateLogs({ error: String(e) }))`
- Tool-level errors captured via `WideEvent.set({ toolError: "..." })` (value-level, not effect failures)

Log destinations:

- One directory, `/tmp/gent/logs/`, or `<GENT_DATA_DIR>/logs` when `GENT_DATA_DIR` is set (`resolveLogDir` in `packages/sdk/src/server.ts`), so an isolated run keeps its logs beside its database
- `<hash>-<ts>-server.log` — server-side JSON lines (via the SDK's `GentObservability`)
- `<hash>-<ts>-client.log` — TUI-side JSON lines (`clientLog` and `clientTraceLogger` in `apps/tui/src/client.tsx`); `<hash>` names the cwd, `<ts>` the process start
- Spans go to an OTLP endpoint when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (`GentTracerLive`); no trace file is written

Request-ID correlation: TUI generates `crypto.randomUUID()` at `sendMessage`/`createSession`, passes via `requestId` field in transport contract. Server threads into log annotations and RPC wide event boundaries.

## Non-Goals

- No cluster/distribution roadmap in this document.
- No compatibility notes for deleted facades.
- No process-purity dogma. Same-process direct transport is fine.

This doc describes the architecture we want to keep, not the migration history we already paid for.

## Bundled guidance

Skills are discovered once per branch resource; an unreadable entry or dangling link in a skills directory is skipped with a warning. Frontmatter is YAML; a missing `name` falls back to the file name. Turn prompts list skills under a Local and a Global heading, grouped by skills directory. The model reads these files through the existing read tool or cell runtime. There are no skill search/load model tools. Typed skill RPCs still serve TUI discovery and content access; `$skill`, `$skill:local`, and `$skill:global` retain local-first or explicit-scope selection.

The skills listing goes into every request, so its size is a per-step input cost. The listing names each skills directory once and gives each skill its name and lead sentence (about 110 characters); the file is `<directory>/<name>/SKILL.md` unless the line names another file. The model reads the full text through the same read path: names and paths up front, content on read. On the owner's home this listing is 6.7k characters, against 21.5k for the former listing that gave every skill its full description and absolute path. The measurement that made it the only listing (a $0 Codex run, two prompts, each listing once): the first request of every turn fell from 8,905 to 5,162 input tokens (−42%), turn totals from 52,956 to 32,647, and both listings found the right skill for both prompts (the short listing read a wrong skill first once and corrected itself in the same turn).

Principles ship as an ordinary `principles` skill with Markdown reference files. The skills resource materializes the embedded bundle in a content-addressed directory under `~/.cache/gent/skills/`. It publishes the complete directory by rename, so concurrent profiles do not expose partial files. The separate cell process reads real paths. User global skills override bundled defaults; project skills retain local-first selection. There is no separate principles tool or principle-content registry.

Repository research uses the bundled `repositories` skill and supervised native commands. Git and package tools own authentication, fetches, revision reads, and command errors. Gent has no repository service, repository model tool, or native Git dependency. The skill preserves existing caches and requires exact revision receipts.

Saved-result writes use the existing `write` tool with `atomic: true`. The file facade writes a scoped temporary file on the destination filesystem, then renames it over the destination under the tool's existing file lock. Atomic mode replaces a symlink entry and preserves its target; default writes retain ordinary follow-symlink behavior. Atomic replacement creates a new inode with temporary-file permissions. Ordinary completion, failure, and scoped interruption clean temporary files. Abrupt process death can leave a staging directory, but does not expose a partial destination. This does not claim power-loss durability.
