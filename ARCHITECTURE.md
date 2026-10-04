# Gent Architecture

Minimal agent harness. Effect-first. Small seams. One owner per concern.

## Core Model

`gent` is organized around six nouns:

- `Server` — process-wide services only: storage, auth stores, platform, transport wiring, connection tracking.
- `Profile` — cwd-scoped extension graph: drivers, hooks, resources, capability leaves.
- `SessionRuntime` — the single public session engine: inbox, queue, checkpoint, watch state, turn orchestration.
- `Tool` / `Request` — independent callable leaves for model tools and typed extension RPC. Requests with a `slash:` block also surface as human slash commands.
- `Resource` — long-lived scoped services and extension-owned state.
- `Hook` — `systemPrompt`, `turnProjection`, `turnAfter`, `loopOpen`, and `sessionDeleted` handlers registered with `host.on` for prompt, policy, turn follow-up, branch repair after a restart, and cleanup after a session delete.

Everything else is adapter code around those nouns.

## Rules

Numbered invariants. Each carries the file that enforces it, so a reviewer can
check the claim instead of trusting it. A change that breaks an invariant
updates this list in the same commit.

1. **Effect-native end to end.** No `Promise<` in an extension surface; no
   `async`/`await` in tests. Receipts: `packages/core/tests/extensions/api.test.ts`
   (the extension surface rejects a Promise at compile time) and `.oxlintrc.json`
   (`effect/noAsyncFunction`, `effect/noPromiseChainsInTests`).
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
7. **Approvals are one-shot and fail closed.** A call that asks asks once
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
    step, writes nothing. A turn runs at one effort: a level set while it
    runs takes effect at the next turn (`atTurnEffort`), where a Claude
    effort marker takes effect too (from the next user turn; a marker after a
    tool result would wait past the reply, so such a change sends the plain
    request). Each step's `StreamEnded.reasoningLevel` receipt
    names the effort that step was sent at, after the clamp; a step that
    named no level to a model that reasons writes `reasoningDefault`
    instead, so "sent at the model's default" reads apart from "unknown"
    (a row with neither, as rows written before, is unknown). Each request
    hands the drivers those receipts per earlier assistant run
    (`ProviderHints.reasoningHistory`, `"default"` for a default run). A
    driver that knows the model's default level (`markerDefaultEffort` on
    the Claude models that take markers) reads a default run at that
    level and keeps the top level as the first run sent it, no effort named
    for a default run. A driver whose wire can change the
    effort inside the conversation rebuilds that change from the receipts on
    every request, so the cached prefix stays byte-identical: Claude models
    that take per-message effort get an `output_config` system marker under
    the mid-conversation beta, GPT-6 and later on the Responses wire get a
    `configuration_update` item, and the top-level effort stays at the effort
    before the first change. Any other model, or a history it cannot carry,
    sends the plain request. On a Claude model whose thinking cannot turn off
    (Fable 5, Mythos, Opus 5.5), `/effort off` sends the lowest effort with
    the adaptive thinking every other level sends: an effort change the
    conversation carries, which the status row and the receipt name. Under
    `/effort auto` the level changes only where it keeps the cache. On a
    warm cache core asks the driver the turn dispatches through whether it
    carries each change from this history (`ModelDriverContribution.carriesEffort`,
    reached through `ModelResolver.carriesEffort`): the router is offered
    only the held level and the levels the driver carries, and with none
    of those the level holds and no classifier is asked. A cold cache
    writes the prefix again anyway, so every level is offered
    (`admitEfforts` and `routeEffort` in `packages/core/src/runtime/turn.ts`). Receipts: `modelChangeNotice` and
    `assistantRunEfforts` in `packages/core/src/runtime/model-context.ts`,
    `readKnownSteps` in `packages/core/src/runtime/turn.ts`, `effortCarrier`
    in `packages/extensions/src/providers.ts`, `withEffortMarkers` in
    `packages/extensions/src/anthropic.ts`, `withEffortUpdates` in
    `packages/extensions/src/openai.ts`.
12. **Tool guidance lives on the tool and follows the active tool list.**
    `promptGuidelines` are deduped per turn from the post-policy tools only.
    Receipt: `buildTurnPromptSections` in
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
    `FileLock`, `Models`, `State`). An atomic write has one owner, `writeFileAtomic` in
    `packages/core/src/runtime/gent-platform.ts`; core config, extensions
    (through `@gent/core/extensions/api`) and the TUI (through
    `@gent/core/host`) all call it. Host facts core cannot get from
    Effect (OS info, executable path, home directory, whether the process is
    the compiled binary) stay on `GentPlatform`.
    The lint holds the edge outside the platform impl, the adapters, the
    tooling and test code: `effect/noGlobals` and `effect/noNodeBuiltinImport`
    ban `Bun.*`, the `bun` and `crypto` modules, `process.execPath`, `kill`,
    `pid` and `platform`, and `os.homedir`, `hostname` and `release`, read as
    a global or through an import, and in core and shipped-extension source
    also `process.cwd` and the `os` and `url` modules. `effect/noGlobals`
    follows each global through
    `globalThis`, computed members and local aliases, and `effect/noReflectGet`
    holds `Reflect.get`. `effect/noModulePathFacts` keeps every file, tests
    included, from reading a file path off the host's `import.meta` path
    facts (`dir`, `dirname`, `filename`, `path`), off the `.pathname` of a
    `new URL(…, import.meta.url)`, or off a cut of the module URL; Effect
    `Path.fromFileUrl` reads the URL.
    `effect/noPlatformLayerOutsideEntry` keeps the Bun platform layers in the
    platform entry files, and reports a platform module or member a file
    exports.
    The TUI session controller owns screen state, views render and dispatch;
    app-specific UI facets live at the app edge. Receipts:
    `packages/core/src/runtime/gent-platform.ts`,
    `packages/core/src/domain/extension.ts`, `apps/tui/src/session.tsx`,
    `apps/tui/src/app.tsx`, `.oxlintrc.json`.
16. **RPC is the application transport.** No parallel REST surface. Receipt:
    `packages/core/src/server/rpc.ts`.

17. **Context leaves the window as a handoff, never as a loss.** When the
    window overflows or the model asks, the history before the newest user
    message is summarised into one durable user-role marker that names the
    session, the branch, and the id range it replaced; every replaced message
    stays readable from the cell through `context.history` and `context.read`.
    The marker leans on that discovery, not on a long summary: it lists the
    user's messages (by origin: what a client sent, an extension's message that
    names the user's words in `userText` (a `/btw` question), and the branch's
    first message, its task) by id with a one-line preview, oldest first so the
    original task is always there (12 at most, then how many more), tells
    the model to read the task and any message its next step depends on
    before it continues, and carries a summary of at most 150 words.
    When the newest turn alone overflows, the handoff anchors inside the turn
    at a step boundary and keeps the newest steps that fit half the budget.
    A summary that cannot be produced (empty, oversized, failed, or blocked
    by the provider) degrades to truncation with a visible notice. The budget is the smaller of the model's input cap
    (`Model.inputLimit`, from models.dev `limit.input`) and its window less
    the output reserve. The reserve is the model's output cap
    (`Model.outputLimit`, from models.dev `limit.output`) up to 32k, and at
    most a quarter of the window (`outputReserveTokens`). The same number is
    the output cap each step's request asks for (`ProviderHints.maxTokens`),
    so input within the budget plus the reply never passes the window. The
    estimate is chars/4. When the last step's reply is
    still in the window, the messages before that reply count at least as much
    as that step's reported input, less the system and tool size its own
    request carried (`StreamEnded.requestOverheadTokens`). Its output never
    counts. The TUI's `ctx N%` and `context.status().percent` divide that
    estimate by the budget the projection records (`availableInputTokens`),
    so both read 100% where the window hands off, also when the input cap is
    below the window. A session with no projection yet reads the last step's
    input against `modelInputCeilingTokens` (`@gent/core/protocol`): the
    window less the output reserve, never past the input cap, the same
    ceiling the turn's budget uses. The client hydrates the totals from the
    snapshot (`foldSessionMetrics`) and applies each live event to them with
    the same step (`stepSessionMetrics`, `@gent/core/protocol`), so the gauge
    moves at a step's `ModelContextProjected` and no step re-reads the snapshot.
    The resolved model and reasoning the footer shows are read again on a
    settings change and once at a turn's end (`TurnCompleted`), since a turn
    reads the project config again and no event reports a config edit.
    A request the provider refuses as too long (`RetryPolicy.contextOverflow`,
    one pattern list in `packages/core/src/domain/driver.ts`; the byte cap
    `request_too_large` is not an overflow) hands the window off once and runs
    the step again. The step drops the history, or the summary of an earlier
    handoff when nothing else is left. A second refusal fails the turn with an
    error that says so. A reply the provider stops because the window filled
    (Anthropic's `model_context_window_exceeded`) is cut and a refusal both:
    its text stays, a continuation asks for the rest, and that step hands the
    window off first. Effect AI maps that stop reason to `"unknown"` and keeps
    no copy, so the driver reports the raw word through `ProviderStopReason`,
    which the loop provides to each step's stream. An `"unknown"` finish alone
    is a finished answer.
    A turn whose first call would resend a large window after the provider's
    prompt cache lapsed hands the window off first, anchored at the new
    prompt, when a summary call and a small window cost well under a cold
    resend. The owner (Pass 30): "for the auto-compaction, we should probably
    only autocompact after a certain treshold - how many tokens we would be
    sending to refresh the cache for example. something like if its over 150k
    tokens or something its better to compact, or measure against the amount
    of tokens the handoff would generate as well". One cost rule decides,
    `coldHandoffPays` (`@gent/core/protocol`, read by the loop and the TUI's
    label). It prices only the history the handoff replaces: N tokens, the
    window before the new prompt, at the projection's estimate
    (`ModelContextProjection.historyTokens`). The new prompt is sent either
    way, so neither side counts it. The history is at least 150k tokens (half
    the budget when that is smaller, so a small-window model still can), and
    the handoff costs at most half the resend. The label reads the history
    as the last step's projected window, at least that step's reported
    input less its request overhead, as the loop counts the same messages;
    it leaves out that step's reply. The resend is N tokens at the catalog cache-write
    price of the lifetime the request asks for (`cacheWriteRate`; the input
    price where no write is priced). The handoff is the summary call,
    `min(N, 32,768)` input tokens (`COMPACTION_SUMMARY_INPUT_TOKENS`, prompt
    included) at the input price and its 384-token output cap
    (`COMPACTION_SUMMARY_OUTPUT_TOKENS`) at the output price, plus a
    1,536-token marker written to the cache. The output is priced at the cap,
    not at earlier summaries' recorded size: it is under a tenth of the
    summary call's cost at catalog prices, and the label could not read the
    receipts. The half the rule keeps pays for the detail a 150-word summary
    loses and the reads the model makes back by id. An unpriced model hands
    off on the floor alone. Both numbers are constants: no config surface
    holds a per-session cost policy. At Opus prices (1-hour write 2× input)
    a cold 150k history resends for $1.50 and hands off for $0.19, so the
    floor binds; on a 128k GPT-5.2 Chat window (no write price, output 8×
    input) a 60k history keeps its cache-less resend, since the summary call
    is most of it.
    The model catalog names the cache lifetime (`Model.promptCacheTtlMs`, which
    each driver fills in `listModels`): Anthropic asks for the 1-hour cache on
    every marker, or 5 minutes with `ANTHROPIC_PROMPT_CACHE_TTL=5m`, and OpenAI
    says 30 minutes, as measured. The lifetime runs from the start of the
    branch's last model request (its newest stored `StreamStarted`, or a
    `ProviderRetrying` plus its `delayMs` when the request was retried), since
    the provider refreshes its cache when a request starts. The cache belongs to the
    model of the last request (its newest `StreamEnded.model`): a turn on
    another model never hands off for a cold cache. A model whose catalog entry
    names no lifetime never hands off either, and with no compactor installed
    the window stays whole. The loop sends no keep-alive calls to hold a cache
    warm. The TUI's cache notice reads the same catalog lifetime and the same
    request-start clock, an interrupted request included. Anthropic gives
    every marker of a request the one lifetime, a marker the SDK rendered from
    a message option too, and prices each model's `cacheWrite` at that
    lifetime's multiple of input (2x for 1 hour, 1.25x for 5 minutes).
    Receipts: `packages/core/src/runtime/model-context.ts`,
    `packages/core/src/runtime/turn.ts`,
    `packages/extensions/src/compaction.ts`,
    `packages/extensions/src/anthropic.ts` (`PromptCacheTtl`),
    `apps/tui/src/extensions/cache.client.tsx`.

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
└── tui/       # OpenTUI client over the shared transport contract

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

`@gent/core/protocol` contains shared client schemas, message projections, and the RPC contract. The SDK uses this entry point for client data. It does not expose server storage or runtime service tags. Core implementation files keep relative imports; they do not import through the public protocol entry point.

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

The app services are one layer, `createDependencies` in `packages/core/src/server/server.ts`; no separate app-services layer exists. It is one stack of levels, each provided once to every level above it (host, storage, kernel, launch profile, models, tools, sessions, actor), so each layer in it builds once: Effect memoizes only leaf layers, and a composite named on several paths built once per path. One build of the production root (the shipped extensions, the cell feature, in-memory state) reaches a leaf layer 138 times, memo hits included, counted on 2026-10-01 as the calls to the memo map's `getOrElseMemoize`. The storage entry builds its SQL client once under every repository, and a branch-tool feature's storage is a layer over that client and the interaction storage (`ExtraRepositories`). A test in `packages/core/tests/server/server.test.ts` counts the builds. The SDK builds it in the server scope and hands the context to `buildServerRoutes`; the test harness provides it as a layer.

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
prompt sections over the built resource context. The cache is a required
service of the loop behavior and of the server's session wiring: every turn
resolves its profile through it (`resolveTurnProfile`), so every turn has a
resource generation (`turnGenerationId`) for binding identity and replay, and
no launch-registry fallback exists. A session with no stored cwd resolves the
host cwd's profile as it is when it reads, for its turns, its agent admission
and its route (`resolveRegistryForCwd` in `server/server.ts`). Test roots provide `fixedSessionProfiles(profiles,
fallbackRegistry)` from `test-utils` when they do not need the live cache.
Profile tests use the live cache. The tool test layer uses the production composition root. Neither has a
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
- `server/server.ts` builds the launch cwd's profile in that cache at startup,
  so an extension that fails to load stops the start, and then releases the
  lease: a later edit retires that profile when its last reader ends. An RPC
  that names a session reads that session's profile; one shared lookup
  (`loadSession`) fails it with `NotFoundError` when the session does not
  exist, so no call answers from the launch profile instead. No registry and
  no extension resource service joins the server context. A turn, an extension request and a
  hook read them from their session's profile (for a session with no stored
  cwd, the profile of the host's cwd), the one owner of a turn's services, so
  a project that disables an extension does not see its resources. Driver
  catalog, auth and health callbacks also run under the selected profile's
  resource context. A pending login keeps that context with its profile lease
  until its callbacks finish. Receipt:
  "turn services" in `packages/core/tests/runtime/extension-host.test.ts`.
- Every session-scoped RPC names its session (owner rule). The contract
  (`packages/core/src/server/rpc.ts`) requires `sessionId` on `auth.setKey`,
  `auth.deleteKey`, `auth.listMethods`, `auth.listProviders`, `driver.set`,
  `driver.list` and `model.list`, so a payload that leaves it out is a type
  error at the call site and a decode failure on the wire; no handler has a
  launch-profile branch for a missing session. `extension.listStatus` takes an
  explicit `scope` (`ExtensionStatusScope`: `Session { id }` or `Launch`);
  only `gent doctor`, which has no session, asks for `Launch`. Its tags carry
  no constructor default (plain `Schema.Literal`, not `TaggedStruct`): the RPC
  client builds each payload with the schema's constructor, so a defaulted tag
  would read `{ scope: {} }` as `Launch`. A session that
  stored no cwd runs in the host's cwd, so it reads the launch profile as its
  loop does. `driver.clear` writes the user config and reads no profile, so
  it names no session. Receipt: the `@ts-expect-error` payloads in
  `packages/core/tests/server/rpc.test.ts` ("a session-scoped payload that
  names no session is a type error").

Turn profiles carry the process identity that built them. A process-local tool
binding names that process and is valid only inside it.
Native source-mode approval, public repair, direct-command cleanup, and external
callback limits have focused validation. Full gate and terminal/server E2E pass.
See `plans/live-composition-review.md` for evidence and recovery limits.

Core writes two prompt sections: the environment, once per profile, and the
date, per turn. The date is the local day the session tree's root session
started (`dateSection`), so the cached prefix stays byte-identical past
midnight and a child shares its parent's. A turn on a later day carries
today's local date as a notice after the conversation (`dateNotice`, first
among the turn's notices, never stored). Extensions add sections
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
  runtime-state stream and branch scope close with it. Four things hold the
  entity resident, counted on its one keep-alive switch (first hold on, last
  release off; a failed switch-on takes its count back): a turn, from its
  hand-over to the worker until the worker is done with it, receipt and hooks
  included (the mailbox request can return before the model finishes); a
  re-entrant admission's asked-for start (`wakeAfterPermit`), until the start
  is decided; each watcher of the loop's runtime state
  (`session.watchRuntime`, so an idle client's stream does not end); and each
  extension hold through `ExtensionContext.Session.holdResident` (a pending
  wake alarm or monitor). Every hold is scoped, so completion, failure,
  interruption, a fire, or a cancel releases it, and an entity nothing holds
  expires. Each hand-over takes the next hold before the last one ends
  (a wake's send, then its start, then its turn): the switch-on is an
  asynchronous keep-alive message, so a count that reached zero in between
  would let the reaper take a loop whose woken turn is about to start.
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
- A session takes its name from its first user message: at a turn end,
  `@gent/session-tools` renames a session that still has
  `DEFAULT_SESSION_NAME` to the first line of its branch's first user
  message (the rename cuts a name to 80 characters between code points and
  trims it), as a delegate child takes
  its task. No prompt text asks the model to name a session; `rename_session`
  stays for a rename the user asks for, and a name it gave first wins: the
  automatic rename passes `expectedName`, and the rename's write transaction
  renames only while the stored name is still the default (`renameCurrent`,
  `SessionMutations.renameSession`). A session whose first message has no text
  keeps the default; its history is read once per process, not every turn.
- `Interject` steering never interrupts an open stream. The item is admitted to
  the durable steering queue; a running turn delivers it at its next safe step
  boundary (tool results stored, no stream open) by persisting the interjection
  as a transcript message before the next model call, so the same turn continues.
  A turn that resumes from a parked step (a blocking ask) is at such a boundary
  once the resumed tool results are stored: steering that arrived while it was
  parked joins before the first resumed model request (`resumeTurn`). An
  interrupted turn makes no further model request, so it holds steering back
  as a final step does: the item stays queued and opens the next turn.
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
  A typed rate limit's `retryAfter` replaces the backoff; one longer than the
  policy's `maxDelay` (a usage limit that resets in hours) fails the step
  without a retry. Nothing is inferred from message text.
  After partial output the partial assistant message stays, a durable
  continuation instruction (`<turn>:continuation:<step>`, `customType`
  `continuation`) follows it, and the same turn runs one more model step. Two
  continuations per turn; a further partial failure ends the turn as
  `streamFailed`. A stream failure's `ErrorOccurred` carries the provider
  error's own message.
- A reply the provider blocks (a `content-filter` finish; Anthropic's
  `refusal`) ends the turn with one `ErrorOccurred` ("the provider blocked the
  response") and no continuation: a re-prompt would send the same window to
  the same filter. The text the reply kept stays; a reply with no text ends
  the turn unanswered.
- `Cancel` and `Interrupt` steering can include an expected message ID. Omission
  preserves branch-wide behavior. The worker checks the target before signaling
  and again when resuming an interaction. A local interruption permit serializes
  running-turn cancellation cleanup with turn completion and next-turn selection.
  It is separate from the side-mutation permit held by the running turn, so
  cancellation can stop active work without waiting for that work to finish.
- `RequestExtension` takes the side-mutation permit unless the request declared
  `answersDuringTurn: true`; such a request answers while the turn runs and
  must not need the branch's side-mutation permit. Reads, extension-owned
  writes under their own lock, and the Session facade's queued send, its
  steer and `dequeueFollowUp` qualify: the queue owner serializes those verbs
  separately (a steer from such a request joins the running turn at its next
  step; `questions.answer` relies on it).
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
  reads `AGENTS.md` (or `CLAUDE.md`) from the gent home, each directory from
  the git root down to the project (the project alone outside a git work tree,
  as opencode reads them) and the project-local `.gent/` on every turn and contributes the `project-instructions`
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
- Classifier models (Jev, Clef) are one host verb, not a feature:
  `ExtensionContext.Models.decide({ definition, input, model?, timeoutMs? })`
  answers `effect/ai/Decision` questions about an input in one provider call
  and returns the answering model, the usage and the cost at the catalog's
  price. `Models.available` says whether a call that names no model has a
  credentialed classifier (no catalog read); `Models.classifiers` lists the
  credentialed classifiers, cheapest first and unpriced last. Every
  extension gets the same facet (`makeExtensionModels`, `runtime/provider.ts`,
  built by each host-context provider over `DecisionModelResolver` and read
  against the caller's profile registry). The cell's
  `models.decide(input, decisions, { model })` is one caller: it builds the
  questions (`models.classify`, `models.rate`, `models.probability`) from the
  cell's JSON, and the model composes it with other tools in its own code
  (gate, route, retry). A model router is another (virtual models, below).
  A driver serves classifiers through the
  optional `resolveDecisionModel` beside `resolveModel` and lists them with
  `Model.kind: "classifier"`, so they share its id, auth, env credential and
  catalog; the TUI picker leaves them out, and the turn refuses one by name
  (`ModelContextCapabilityFailure.ClassifierModel`) before any chat
  `resolveModel`, whichever agent, config or override named it. A driver
  declares `resolveDecisionModel` only when it lists a classifier, so the
  cell shows its `models.decide` guideline when such a driver has a stored or
  env credential, with no catalog read.
  `DecisionModelResolver`
  (`runtime/provider.ts`, in the loop's runtime services; no extension
  imports it) picks the named
  catalog classifier. With none named it takes a classifier whose driver has a
  stored or env credential: a `-latest` alias first (drivers are ordered by
  extension id, so the order cannot pick it), else the first listed. It fails
  readably naming the variables when none has a credential; a driver defect
  while the model is resolved or built fails that call, not the cell. One call
  has 60 s from resolve to answer (`DECIDE_DEADLINE_MS`; the cell may ask for
  less with `timeoutMs`), since the watchdog pauses during host calls. The
  reply carries the provider's token usage: the runtime keeps no spend record
  for a tool's own model call. Like `context.*`, a decide call leaves no
  receipt and a recovered cell does not repeat it. Three drivers serve
  classifiers through `@effect/ai-typesafe`: `typesafe` (`TYPESAFE_API_KEY` or a stored
  key; `jev-latest`, `jev-preview`, `jev-1.13.0`), OpenCode Zen (the OpenCode key
  and session headers at `https://opencode.ai/zen/v1`; `jev-1.13`,
  `jev-1.13-free`) and Cloudflare (`clef`, `clef-flash`: the Cloudflare
  token, the System One request sent to the account's Workers AI run path
  `/accounts/{account}/ai/run/@cf/cloudflare/{model}` with the gateway header
  when a gateway id is set; the answer may come bare or inside the Workers AI
  envelope `{result, success, errors}`, and an envelope with `success: false`
  fails with its first error's message). Clef and the Zen Jev models come
  from the models.dev decision list (`api.json?type=decision`); TypeSafe's
  three direct ids are not on models.dev, so its driver keeps them as local
  entries in the catalog's shape. Receipts:
  `packages/extensions/src/cell.ts` (models host),
  `packages/extensions/src/typesafe.ts`, `packages/extensions/src/cloudflare.ts`
  (Clef decisions section), `packages/core/src/domain/driver.ts`.
- Virtual models (owner, Pass 30: "the virtual router should be some sort of
  json, with models that have a reason or description"). A `modelRouter`
  contribution (`ModelRouterContribution`, `domain/driver.ts`) serves ids
  `<router id>/<name>` that name no model: each is a list of choices (a
  model, an effort, or both, with the `reason` a classifier reads) and a
  default. The catalog lists one as `Model.kind: "virtual"` under its label;
  one the router reports as a problem, or one whose choice names a router, is
  a catalog failure (extension health lists it under the router's
  extension), and a turn on it fails with `ErrorOccurred` naming why.
  The turn routes once, before its first request (`routeTurn`,
  `runtime/turn.ts`, model-routing section): it calls `route` with the
  model-visible messages, each choice's catalog entry (none for a model the
  catalog does not list or whose driver has no sign-in `/auth` lists as
  ready: `ModelResolver.signedIn`, the `listAuthProviders` row), and the model the
  branch last ran on with whether its prompt cache is warm and the history
  tokens a switch writes again (`estimateHistoryTokens`, the estimate
  `coldHandoffPays` reads). It records the pick as `ModelRouted` (selected,
  model, choice, effort, reason, fallback, classifier, cost, duration) and
  runs the turn on it. Every later step, a replay and a recovered turn read
  the recorded event; nothing routes again. A route that fails, dies, takes
  over 10 s or picks a choice the turn cannot run falls back to the current
  model when it is a choice, else the default; a turn never fails on its
  route. With no choice signed in, the router is not asked (no classifier
  call): the turn falls back the same way among the listed choices, the
  reason names each provider with no sign-in, and that provider's sign-in
  error stops the request, as on a model selected by hand. The turn routes only where the request ends on the user's input: at
  a later step (the selection changed mid-turn) or on a history that ends on
  an assistant message (Anthropic 4.6 and later refuse that prefill) it keeps
  the model the branch runs on. Routing writes nothing the model reads: it
  happens before the model-change check, so a routed switch writes the notice
  a hand switch writes and sends the same bytes, and the earlier model's
  reasoning goes back as text only (`toPromptMessages`). The router's
  classifier calls go through the run's own `ExtensionContext.Models`; their
  cost lands on the event and the session's cost, and the turn's ledger
  charges it once per turn, a recovered turn too (`noteRoute`). The auth gate asks for the
  driver of a virtual model's default choice (`routeCredentialDriver`).
  The shipped router (`packages/extensions/src/router.ts`, `@gent/router`)
  reads `routers` from `~/.gent/config.json` and from a trusted project's
  `.gent/config.json` (by name over the user's) when the extensions load; a
  bad entry (two `default` choices, no choices, a name with `/`) is a
  problem with its reason. It asks one classifier (the entry's `classifier`,
  else the cheapest credentialed one) which choice's reason fits the latest
  request (head and tail, 3,000 characters, with the end of the request
  before it; 4,000 at most) and holds a warm model unless the switch pays: a
  stronger choice needs confidence 0.6; a cheaper one must cost less on the
  turn with the history written to its cache (the cache-write rate of the
  lifetime it asks for) than staying costs with the history read. A pick on
  the current model is no switch, whatever its effort: the route's effort
  is the turn's requested level (`applyTurnRoute`: the session's own level,
  else the route's, else the agent's), the step's receipt records it after
  the clamp, and a change of it alone rides the in-conversation effort
  carrier like any other effort change. The session metrics keep the newest
  route (`SessionRuntimeMetrics.routed`); while the session runs on that
  virtual model the TUI status row names both (`Auto → Claude Sonnet 5
(anthropic)`; a row too narrow for it takes the short form `Auto → Sonnet
5`, after the debug mark and the cwd gave way), shows the level in the
  same order after the routed model's clamp, and reads the context gauge
  against the routed model's window. The effort picker lists the routed
  model's levels, and its `default` row names the route's level.
- The effort router (`/effort auto`) is the same router concept, with no
  second classifier verb. A `modelRouter` may carry `effort`: a virtual
  model whose choices each set an effort and name no model. The catalog does
  not list it and a session cannot select it; the first registered router
  with one serves it (`servedEffortRouter`, `runtime/provider.ts`), and a
  problem with it is a catalog failure under the router's extension, as for
  a virtual model. On a session on auto, the turn asks it once per user
  turn, at step 1, after a model route (`routeEffort`, `runtime/turn.ts`,
  effort-routing section). The model facts come from the model the turn
  dispatches to (`modelDriver.contextModelId`: a `driverOverride` reads its
  own catalog entry), and the receipts name the model the session asked
  for. It offers only the choices that model runs at their own level
  (`effectiveEffort` returns the level unchanged), so the levels filter to
  what the model accepts. It never routes for a child (a child keeps its
  own effort), nor on a history that ends on an assistant message, nor on a
  model with no reasoning. On a warm cache a choice is offered only at the
  held level or where the driver carries the change from this history
  (`ModelDriverContribution.carriesEffort`: the Anthropic driver where
  `takesEffortMarkers` and the thinking plan stays the same, the OpenAI
  driver where `takesConfigurationUpdates`; both rebuild the previous
  request's plan and admit the change only where the new request keeps its
  top-level effort and its earlier changes, `keepsEffortPrefix` in
  `packages/extensions/src/providers.ts`, so on OpenAI no change follows a
  run at the provider default); with no such choice the level
  holds and no classifier is asked, and the receipt says why. A cold cache
  or a first turn offers every level (decided by the cache-rate north star:
  a driver fact asked per transition, with a receipt, over a static model
  flag). A hold is a decision, not a fallback; `fallback: true` marks only a
  router that failed or picked a choice the turn cannot run, and then the
  turn keeps the exact level the branch ran at, `max` and the model's
  default included, though no choice names it. Under a virtual model whose
  router also serves the effort router, the model route's call carries the
  effort choices (`ModelRouteInput.effort`, each choice with a model of the
  route's choices that takes it), and the router answers both in one
  classifier call (`ModelRouteDecision.effort`): two receipts, one charge on
  the model route (decided by the cost north star). A router that answers no
  `effort` leaves core to ask the effort router alone; when a combined call
  fails, the effort route falls back too, with the same reason, and nothing
  is asked again. The pick is recorded as `ModelRouted` with `effortOnly: true` (an
  additive, optional field). Once that receipt is stored, a replay and a
  recovered turn run at it, charge it and ask nothing, whether or not an
  effort router still serves. A process that dies after the classifier
  answered and before the receipt was stored asks again on recovery, and the
  first call's cost is not recorded. Its classifier cost lands on the event,
  the session's cost and the turn's ledger, as a model route's does; the
  ledger keys a route by turn, kind and router, so a model route and an
  effort route of one name are each charged. The effort route's
  level wins over a model route choice's level: auto is the session's own
  setting (the `applyTurnRoute` order). With no effort router served, auto
  runs at the agent's level and records nothing. The shipped router serves
  the `routers.effort` config entry, else built-in choices (low, medium,
  high, xhigh, each with a reason; default high, the main agent's level); a
  bad `effort` entry serves none and is reported. The session metrics keep
  the newest effort route apart from the model route
  (`SessionRuntimeMetrics.effortRouted`), and the TUI status row reads
  `auto → high` (short form `auto→high`, the last label to give way). After
  a route that fell back, the `/effort` picker's `auto` row reads
  `routes fall back: <reason>` (no classifier signed in, a failed call).
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
- Alarms and monitors (`@gent/wake`) live in `<data dir>/wakes/<branchId>.json` (`resolveDataDir(ctx.home)`: `GENT_DATA_DIR`, else `~/.gent`; `ctx.home` is the OS home); timers are branch-scoped. One branch lifecycle permit serializes durable publication, timer installation, re-arm and cancellation; waiting for it is interruptible, then the transfer completes. Cancellation releases the file lock before waiting for stopped timers. `wake` fires at a time, and again every `everySeconds` when it repeats (the stored due time advances on each fire; ticks missed while the process was down fold into one fire); `monitor` polls a shell command on an interval until it exits 0 or its stdout matches `until`, or its deadline passes. Both write the entry, capture the session facade of their call, and fork work into the branch resource scope that queues a user-role `wake` message (`details: { outcome, note, firedAt }`; `fired` is an alarm, `matched`/`timed-out` a monitor). In `wake` mode (default) the line carries `wake: true` and starts a turn on an idle loop; a line the session refuses (a full follow-up queue, for one) is logged (`wake.fire.refused`) and stored as a `notice` entry instead, so the fire is not lost. In `notify` mode no line is queued (a queued follow-up always runs a turn on a branch with history): the fire stores a `notice` entry in the same file and pulses the tray; `turnProjection` (every step) reads the notices into a `# Notices` turn notice, and `turnAfter` clears exactly the notices in `readNotices`, the ones an answered turn's steps showed (a lost process shows them again), so a failed, interrupted or unanswered turn keeps them, and a notice written after the last step read the file waits for the next turn; `wake.cancel` dismisses one unread. A settled one-shot fire removes its entry; an interrupt (branch close, shutdown) leaves the row for the next re-arm; a repeat only ends on cancel. `wake.cancel` interrupts one timer by id, or every pending one on the branch, and drops the entries; the resource keeps fibers by id for that. Branch resources start without an `ExtensionContext`, so after a branch close or a server restart the stored entries get their timers back when the branch's loop opens (the `loopOpen` hook re-arms them under the branch file's lock, the lock a fire takes to drop its entry, so a fire that ends during a re-arm is not armed and fired again; past-due alarms fire at once, and a past-due `notify` alarm leaves its notice without a turn). Opening the session is enough; no message is needed. The TUI collapses a `wake` row to `◷ alarm fired · <note>` or `◉ monitor matched · <note>`, and a wake tray under the status line lists pending entries from the `wake.pending` request with their cadence and `(notify)` when the fire starts no turn; the model reads the same entries with the `wake.list` tool, in ISO times like the `wake` and `monitor` results (a tool and a request cannot share an id inside one extension). The status bar shows only `ctx N%`; the messages the projection omitted show on the live window in the `/thread` pane.
- The `bash` tool passes the command unchanged to Bash in both foreground and supervised background modes. Only its explicit `cwd` parameter resolves against the session directory; Bash owns `cd`, expansion, escaping, operators and exit status. The shared process scope still owns the entire process group.
- Background shell jobs (`@gent/exec-tools`, `bash` with `run_in_background`) keep one row each in the `background_bash_jobs` table and run in a process-scoped resource. A finished job queues its terminal notice (`bash:<toolCallId>:complete` or `:failure`, custom type `background-bash`), which wakes the branch. The notice carries the head and tail of the output within `maximumModelToolResultChars`. The output streams whole, from the job's start, to `<data dir>/background-bash/<sessionId>/<branchId>/calls/<digest>.txt`, and a notice that cuts it names that file for the read tool; the filename is the SHA-256 digest of the full JSON-encoded call id, and the separate `calls` directory protects paths earlier builds emitted. Each new claim stores its exact `output_file` pointer in the same transaction as the job, before its file opens. Retries, replay and turn notices use that pointer even when the file is absent; only earlier rows whose pointer is NULL use the sanitized layout. The start stub is the only tool result the call stores, so `context.read` of the call id cannot reach the output. The job rows stay when the session is deleted; its files go (below). The terminal update sets `undelivered_at` atomically with the outcome; accepted follow-up admission clears it. An interruption before admission or a refused send (a full follow-up queue, for one, logged as `exec-tools.background.follow-up.refused`) keeps that pending mark: every step reads the branch's unread undelivered jobs into a `# Background commands finished` turn notice with each outcome and the head and tail of its output (2,000 characters; a cut output names its file the same way; a row from a build before that bound holds more, and its cut names the job's file when the file exists, with nothing written), cleared by `notice_read_at` like an interrupted job. A later accepted send of the same job (the replay of a `Terminal` claim, for one) clears `undelivered_at`, so the model does not get the result twice. A job that cannot finish becomes `interrupted`: its fiber marks the row when it is stopped (server stop, or its resource closed), and a new process marks rows an earlier process left running. Nothing is reattached. A server that crashes runs no finalizer, so a job's process can outlive it: each running job records its pid and its start time (`pid` and `process_start_id`, optional columns; `ps -o lstart=` in the C locale and UTC) beside its output, and before the supervisor takes new work the next process stops each recorded process group (SIGTERM, then SIGKILL after 3 seconds) and marks the job stopped once no process of the group runs: the group of a leader that still has that start time, and the group of a leader that exited while descendants kept its group id (the system reuses no pid that names a live group). A pid that another process now holds is left alone, since its old group is gone. A row with no recorded process (a build before the columns, or a crash before the record) or a group that would not stop is marked as possibly still running, and its notice line says so. An interrupted job wakes nobody: opening a session must not spend a turn with no user present. `turnProjection` (every step) reads the branch's interrupted jobs whose row has no `notice_read_at` into a `# Interrupted background commands` turn notice, which says the jobs stopped before they finished (a server restart or a reload, without naming one), names a job's output file only when the file holds output (else it says no output was saved, or that the job wrote none), and tells the model to report them and to start one again only when the user asks; `turnAfter` sets `notice_read_at` on exactly the jobs in `readNotices`, the ones an answered turn's steps showed, so a failed, interrupted or unanswered turn keeps them. A repeated start of an interrupted call queues nothing. A table from before the column keeps its interrupted jobs unread: the earlier code told a branch only when its loop opened, so a job shows once more at worst and is never lost. Two processes that add the column at once both start: a failed add reads the table again. A session nobody sends to is not told.
- A foreground `bash` call and each `monitor` check run through the same spawn as a background job (`spawnBashCommand` in `packages/extensions/src/exec-tools.ts`), so no command holds its whole output in server memory. Each stream comes back whole up to 262,144 characters; past that the stored result keeps each stream's head and tail around a marker that counts the middle. A foreground call's output then goes whole to its call's file under `<data dir>/background-bash/`, which the result names in `outputFile`, with the length in `outputChars`; the file opens only once the output passes that bound, so a short output never touches the disk. A call that times out or is interrupted returns no pointer and removes its file. `context.read` of the call id pages the stored result, not the file. A monitor check keeps no file: its `until` regex tests the stdout data it kept, never the display text with its marker: the whole stdout, or the head and the tail of a longer one, each apart. The files live under `<data dir>/background-bash/<sessionId>/`; the extension's `sessionDeleted` hook removes that directory for each session a delete removed.
- Persistent goals (`@gent/goal`) live in `<data dir>/goals/<branchId>.json`. After every uninterrupted turn while a goal is active, the goal `turnAfter` hook charges the turn's usage to the goal (a turn that started before the goal existed is charged only its time since the goal's creation, by `turnAfter`'s `startedAtMs`) and queues a `goal-context` user message; a spent token budget flips the goal to `budget_limited` instead. Goal controls answer during a turn. One extension-owned branch permit covers persisted changes and queue admission/removal, so a resume during work replaces its pending continuation at turn end. Pause preserves state and removes pending work; its optional `pausedTurnStartedAtMs` marker charges the turn already in flight once, then disappears. Later unrelated turns leave paused state untouched. Interrupting a turn pauses its goal. Resume retains identity and usage; an exhausted allowance always needs a fresh budget. Clear, cancel and stop remove the goal without completing it. Only the `goal` tool's `complete` action marks it achieved. The TUI collapses `goal-context` rows to one line unless full detail is on.
- Foreground runs persist a child session/branch and can be revisited with `read_session`. Private runs leave no session behind; they return text/usage/tool-call metadata only.
- grep and monitor share the scoped regex worker in `packages/extensions/src/regex-matcher.ts`: `searchLines` splits grep's file text inside the worker; its caller splits only after the reply to format hits. `searchPieces` searches a monitor's retained stdout pieces apart. The scope owns its worker, Blob URL and pending replies; timeout or cancellation ends CPU-bound matching. A monitor's shell and matcher share its deadline; a matching timeout keeps the command's last output and reports that matching did not complete. JavaScriptCore can give up and report a miss despite a later match. The worker counts a miss taking over 50 ms as undecided, the existing grep contract; this heuristic also counts some real slow misses. A monitor keeps that reason and waits to its deadline instead of treating uncertainty as an ordinary miss. No matching worker is needed when completion depends only on the command's exit code.
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
what the call asked for the way the turn reports its result (a child's task
turn: its reply, which its completion carries; a later turn: `session.send`),
and that no message can grant it: the reader acts on the report, or a user
prompts the session directly.

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
- **An answer goes to its owner.** The owner of a request is the tool call that asked and the index of that ask in the call's run; the row stores both (`owner_tool_call_id`, `owner_occurrence`, nullable for older rows). A branch shows one request at a time. Other owners queue in the order they asked, and a call that asks the same question never takes another call's answer. A call ends when one of its runs ends without parking. A run that parks continues its call: the answers it kept and the answer to the question it parked on stay for its next run, also when that answer comes before the run ends, so the parked turn finds it and goes on. An answer whose call ends without taking it is settled as abandoned, so the next owner asks. A run's end is one state transition, and it always wakes the calls that wait for their turn. A dispatching tool's inner call (a cell) waits for the slot while the open request's owner still runs, and is refused when that owner parked; after a crash it resumes by its request id. An answer matches its question as well as its owner; a changed question asks again, for a dispatching owner too. A call keeps the answers it took (row status `taken`) until it ends, so a call that asks twice takes both, also across a restart. Only a tool call the loop runs can ask natively; an ask with no call and no dispatching owner is refused.
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
- **No permission rules.** A tool call that asks the user asks once through the durable approval request (`ApprovalService`); the answer is not saved, and a request with no answerer fails closed. Core has no rule schema, no rule storage, and no `permission.*` RPC.

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
a second agent engine or persistence owner. After a fault, the next cell
replaces the worker and restores the namespace the last good cell saved;
`reset: true` is only the model's way to discard that namespace. Each kernel
stops after three failed launches in a row by default, failed starts included. Close cancels active work and waits for its
cleanup. The Gent policy bridge and other platform isolation remain unfinished.

The `@gent/extensions` build compiles `src/cell-worker-boundary.ts` into `dist/gent-cell`.
Turbo builds that declared dependency before the TUI copies the worker into
`bin/gent-cell` beside `bin/gent`. `@gent/extensions` owns the worker build; the TUI only
packages it. The worker embeds Bun and needs no external Bun executable. Its
compile options disable automatic dotenv, bunfig, tsconfig, and package.json
loading. Both binaries compile to ESM bytecode, so a start does not parse
the embedded bundle (`bin/gent` 0.41 s to 0.05 s before its first module
runs; the worker 36 ms to 18 ms to its `Ready` frame); the bytecode belongs to
the Bun each binary embeds. The process launcher uses this artifact as both its runtime
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
A terminated session opens no loop: each operation that would start one
(a submit, a queued follow-up, an extension request, a mutation) checks the
termination marker first and fails with `Session terminated`, and an actor
built for a terminated session skips its eager open. So a send after a delete
or a terminate runs no `loopOpen` hook and builds no branch Resources.
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
the output. A failed call's summary is the head of its error text
(`summarizeToolResult` in `domain/message.ts`), not of the JSON that carries
it; rows stored before keep their clipped JSON, and the TUI still reads them. Recovery resolves each completed operation's recorded binding the
way a resume does; a binding that no longer resolves keeps the head of the
output. The TUI
nests live inner calls under the cell, counts them in the compact tree, and shows
receipts in the `cell` renderer. The headless runner indents nested calls, and
declines every interaction unless `--approve-all` is set (`apps/tui/AGENTS.md`).

When policy selects `cell` for a native model turn, only `cell` is advertised.
ResolvedTurnContext keeps separate model and host binding maps. Both derive from
the same policy result. The full host map supplies cell callbacks and recovery;
the outer map cannot directly dispatch unadvertised host tools. A model that
calls such a tool, or any other tool its profile registers but the turn did not
advertise (a denied one), reads a failed result (`Unknown tool: <id>`) and the
turn goes on: the reply decodes against every registered tool, while the
request's `toolChoice` (`oneOf`, the advertised names) keeps its declarations
as they were (`runtime/turn.ts`). A name no extension registers still fails the
step's stream, as Effect AI cannot decode it. Tool discovery
returns the selected declaration's input schema and usage guidelines. External
drivers and turns that do not select `cell` keep their existing tool surface.
Cancellation saves a failed outer receipt without replaying source. An active
worker loses state, and the next cell replaces it and restores the namespace the
last good cell saved; a cell stopped before evaluation
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
encoder (with its tagged-JSON codec), the error renderer and the value display
live in `cell-value.ts` and share one value reader that never runs cell code
attached to a value: it reads data descriptors, runs only host getters (those
of every global error type, taken at load, compared by identity), never
touches a Proxy (Bun's `util.types.isProxy`), reads built-ins by brand
(`util.types`) and reads their slots through getters saved at load. A value
it cannot read that way (a cell getter, a Proxy, an object where a string
belongs) is omitted as `unsupported`; the worker and the rest of the namespace
stay. The worker runs in full Bun in the host's realm, so a cell can also
replace a built-in the worker itself calls (`Map.prototype.set`,
`Object.prototype.toJSON`, the global `Reflect` or `Symbol`, an iterator
prototype). The worker does not defend each call against that. At load it
takes a baseline of the built-ins' descriptors: the ECMAScript constructors
and namespaces on `globalThis` with `TextEncoder` and `TextDecoder`, their
prototypes, and the intrinsics only syntax reaches (%TypedArray%, the iterator
prototypes, the generator prototypes). `putBackBuiltins` compares every
descriptor, prototype and extensibility with that baseline and puts back what
changed. The Effect runtime calls a promise's `then` and Array `push` and
`pop` as soon as cell code returns, so the put-back runs in the same turn as
the cell's return or throw, inside the evaluation thunk. A cell's promise is
awaited only when `util.types.isPromise` says the realm made it, through the
`then` saved at load (`whenSettled`), and its callbacks put back before the
fiber resumes. The put-back runs again before the display and the snapshot,
as a timer the cell left can change a built-in between cells, and in the
process's uncaught handler and the report, before an error is queued and
rendered. The cell's result names what was put back. A change the realm
refuses to undo (a built-in a cell made not configurable, an object it froze)
goes back as `unrestored` (additive, optional, on the Evaluated, Failed,
Snapshot and Reset frames): the kernel then replaces the worker, and the next
cell restores the namespace saved before it. A snapshot that fails for any
reason marks the kernel for that same recovery (`recoveryPending`), and the
host adds that failure to the cell's display: what the cell bound is not
kept. The encoder stops a
binding at a running UTF-8 byte budget: each value charges at least its
encoded size, a string longer than the budget is refused uncounted, and the
exact size comes from `Buffer.byteLength` saved at load, so a 5 MB string or
a 100 000-item array is omitted as `too-large` without being read to its end.
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
and an uncaught report (`displayValue`) follows the shape of `util.inspect`
(`depth: 4`, 100 items, 8192 characters, no custom inspection) through the
reader, with a plainer layout: strings always take single quotes and are not
split at newlines, and a list packs its items onto lines of at most 80
characters instead of aligned columns. Where `inspect` would run cell code it
shows a marker instead: `[Proxy]` for a Proxy, `[Object: unreadable
prototype]` for a Proxy on the prototype chain, `[Getter]` for an accessor,
and it never reads a `Symbol.toStringTag` getter.
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
`cell`, the cell extension's `systemPrompt` hook adds a `## Host Tools` section.
Its heading is the one place that explains the discovery calls
(`tools.search`, `tools(id)`); the cell guidelines do not
repeat it. The section has one signature line per selected host tool: its callable path, an input
type and a result type rendered from the JSON Schema, and the first line of its
prompt snippet or description (`- tools.wake.cancel(input?: { wakeId?:
string }): Promise<{ cancelled: string[] }> // Cancel a pending alarm ...`). Nested objects
inline while short and otherwise render as `object`. The signature lines take
at most `HOST_TOOL_CATALOG_BUDGET` (8,000) characters (`renderHostToolCatalog`).
A top-level id (read, edit, write, bash, grep, ...) is a host tool the model
calls most, so it lists first; then each namespace (a dotted id's parent path,
`mcp.github` for `mcp.github.search`) lists whole, in id order, while it fits.
A namespace past the budget collapses to `- tools.mcp.github.*: 42 tools (a, b,
…)` while that line fits; a namespace whose line does not fit is counted in one
last line, `- N more namespaces (M tools), listed by tools.search(query)`, and
top-level ids past the budget share one `- more tools:` line. Every line counts
against the budget, with a fixed reserve for the two tail lines, so the listing
never exceeds it. Ids order by UTF-16 code unit (`compareIds` in
`cell-protocol.ts`), never by locale. The text depends only on the tool set, so
the cached prompt prefix stays byte-stable while the set does. The section is rebuilt each turn, so live composition changes reach
the model as ordinary instruction changes. `cell.ts` builds the data half from
the same selected map: name, description, guidelines, the actual Effect AI
input schema (derived once with the signature; a schema that cannot be
derived is `{}`), the rendered signature line, and its one-line summary,
hashed over its encoding. `dispatchCell` hands it to the cell host. The kernel
sends only its listing (id, signature line, summary) inside `Evaluate`, and
only when the hash differs from what the current worker holds, so the frame
stays small with hundreds of tools; it keeps the whole catalog and clears that
memory when a replacement worker starts, so the first cell on a new worker
carries the listing. A listing past the 1 MiB frame fails the cell with the
tool count named. The worker keeps the listing beside the namespace: `reset`
clears bindings, not the listing, and a snapshot never contains it.

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
read that returns the tool as a function carrying its `id` and `signature`.
It reaches an id with a reserved segment, which the prompt renders as
`tools("read.then")(input)`. The function is thenable: `await tools(id)` sends
a `Describe` frame and the kernel answers from the catalog it kept with the
tool's `{ id, description, guidelines, parameters, signature }`. Neither
records an operation receipt or grants execution permission. The root also holds
two discovery functions (`toolDiscoveryKeys`). `tools.search(query, { namespace,
limit, offset }?)` returns one page, `{ items: { id, description }[], total,
hasMore, nextOffset }`, 20 items by default. It splits camelCase and
`_ . / : -`, weighs the whole id over its last segment, its namespace and the
one-line summary, adds exact, prefix and phrase bonuses, drops an id that matches
fewer than all distinct words of a one- or two-word query (60% of a longer one;
a repeated word counts once) unless
the whole query appears in a field, and breaks ties by id in code-unit order
(`searchCatalog` in `cell-worker-boundary.ts`). `namespace` keeps the ids under
that prefix, and an empty query lists them by id. `tools(id).signature`
holds the rendered signature line. Both are
local, and their results arrive as cell output, so discovery
never changes the prompt. An id whose first segment is `search`
renders and is reached as `tools("search.x")`. A call with no
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

File discovery is owned by the `@gent/fs-tools` extension, not core. `packages/extensions/src/fs-tools.ts` holds one stateless `listFiles` function over the platform services and one listing rule: an ignore authority decides which files grep may read. Inside a git work tree the authority is git: `git ls-files -z -t --cached --others --exclude-standard` below the search path, so every git exclude source applies; a sparse checkout's skip-worktree entries are dropped before the 100,000-file bound, and a name that is not valid UTF-8 is counted in grep's `unreadable` field. A git that does not answer within 10 seconds fails the search and asks for a narrower path; the walk does not stand in for it, because it misses `info/exclude` and the global excludes. A tracked path under a directory that is now a symbolic link is not listed. Outside a work tree a `FileSystem` walk reads each `.gitignore` from the search root down by gitignore(5); a test checks that matcher against real git. An ignored target named explicitly (`dist/`) is walked from its own root. No listing follows a symbolic link. grep reads 16 files at a time and reports matches in path order; it decodes a UTF-16 file by its byte order mark, skips binary files (a NUL byte in the first 8 KB), skips and counts files over 10 MB in `oversized`, and cuts a line over 500 characters around the match without splitting a surrogate pair. read, write, edit and grep decode a file once: a strict decode fails exactly when the bytes are not valid in the file's encoding, and only then does the replacing decode run and the text count as `lossy`. read streams a UTF-8 file over 4 MB in 1 MB chunks: it counts every line and decodes only the lines it shows, so its `lossy` covers those lines. read cuts a line over 2,000 characters with a `[N chars cut]` marker. The listing holds no state, so there is no Tag and no resource. The TUI's `@` popup reads the same listing through the read request `FilesRpc.List` (paths relative to the session cwd, sorted), so a user can name exactly the files the model can search. fff (`@ff-labs/fff-bun`) ranks them: it scans the session's directory, keeps its own pick frecency under `~/.gent/fff`, and the popup keeps only the listed paths, paging through fff's ranking until it holds 50 or has read five pages of 200; when the five pages run out first, the shared autocomplete matcher fills the rest from the listing. The listing and a read in flight are keyed by session, so a switch never ranks the session it left. Where fff cannot run, the shared autocomplete matcher ranks the listing. Core has no file-index concept, and there is no `ExtensionContext.Files` facet: tools yield `FileSystem` and `Path`.

### MCP servers (mcp)

The `@gent/mcp` extension (`packages/extensions/src/mcp.ts`) turns every
configured MCP server into host tools with the id `mcp.<server>.<tool>`, so
the cell reaches them as `await tools.mcp.<server>.<tool>(input)` and each
call runs the host tool path: permission, events, operation receipt, and
recovery. It uses only `@gent/core/extensions/api`, the client subpaths of
`@modelcontextprotocol/sdk`, and its `types.js` (the protocol error class and
the loose result schema); core has no MCP concept. The one Promise edge, the
`fetch` function an OAuth transport takes, lives in `mcp-boundary.ts`. Config
is the `mcpServers` object Claude Code, Cursor, and opencode share, in
`~/.gent/mcp.json` and, for a project root `trustedProjects` names, in
`<project>/.gent/mcp.json` (a project entry wins by name). Each entry decodes on
its own: one that does not decode is `misconfigured` with the schema issue as
its reason, and the file's other servers still run. A `command` entry
runs over stdio with the process's flat environment, empty values included and
read in one pass at the first setup, its own `env` winning (its stderr is ignored, so it never
draws on the TUI). A `url` entry sends its
`headers`; its `type` picks the transport: `http` (or `streamable-http`) and
`sse` pin one, and `auto`, the default, tries streamable HTTP and then SSE
when the server answers 400, 404, 405, 406, 415, 422 or 501 (never on 401 or
403, which SSE would refuse too). Strings expand `${NAME}` and
`${NAME:-default}`, and a value is taken literally; an entry whose variable is
unset is skipped with a warning. A stdio `cwd` resolves against the session's
cwd.

A `url` entry without its own `Authorization` header signs in with OAuth, all
inside the extension. `/mcp login <server>` runs the SDK's `auth()` with a
provider that never opens a browser: it registers the client, starts a
loopback listener on 127.0.0.1 for the redirect, and presents the
authorization URL. The listener's scope is a child of the extension's from
its creation: a login start that fails or is interrupted closes it, and a
start that succeeds hands it to the finishing fiber in one uninterruptible
step. Before `auth()`, the login sends one request with no token and keeps the
`resource_metadata` URL its 401 names in `WWW-Authenticate`; discovery starts
there, so a server whose metadata is off the well-known path is found. A
process fiber waits up to five minutes for the redirect,
exchanges the code, and lists the tools into the cache, so no turn waits on a
browser. A browser on another machine cannot reach the loopback listener, so
`/mcp login <server> <address>` hands the pending login the redirect address
the browser shows; it goes through the listener's checks (path, the login's
state, the server's refusal). The login lives in `<data dir>/mcp-auth.json` (mode 0600, written
with `writeFileAtomic`), keyed by server name and URL, with that metadata URL.
A token that expires within 60 seconds is refreshed before the dial. The
transport's `fetch` answers each 401 or 403 before the SDK sees it: a 401 on
`initialize`, `notifications/initialized`, `ping`, `tools/list` or the stream
`GET` refreshes the token (discovery starting from the metadata URL that 401
names) and sends that request once more; any other refusal, a `tools/call`
included, fails with "the <server> MCP server needs a login: run /mcp login
<server>". So a call is never sent twice. Every refresh and every stored login
holds the login file's one lock, `<data dir>/mcp-auth.json.lock` (created with
`wx`, removed when done, taken over when older than 30 seconds), so two gent
processes that write different logins never drop each other's token. A
refresh reads the login again under the lock: when another refresh, in this
process or another, already stored a new token, it uses that token and never
redeems the spent refresh token. The token request and the stored login are
one step that is not interrupted, and its requests end within 20 seconds: a
dial that times out, or a request the SDK aborts, waits for it, so a rotated
token is always stored and the lock never outlives its 30 seconds. Only the
wait between tries to take the lock can be interrupted: a lock a holder
created is always removed.

Setup reads each server's tool list from `<data dir>/mcp-catalog.json`, keyed
by the SHA-256 digest of the entry as it runs (its expanded values, for a
`url` entry its configured `type`, with `http` and `streamable-http` one
value, and for stdio the resolved directory its `cwd` names), so an edited
entry or a changed variable lists again. An entry from a project's
`.gent/mcp.json` belongs to that project and always keys with the session
directory, so two projects' `bun run mcp` (or `http://localhost:3000/mcp`) are
two servers. A user-file stdio entry whose command or arguments name a
relative path (`./server.ts`, `src/x.js`, `server.py`, or a flag value such as
`--config=./x.json`) also keys with the session directory, so two projects'
`./server.ts` are two servers. Any other user-file entry that names no `cwd`
keys without it, so a new project does not spawn every server at setup. A
relist on the first
connection corrects the cache for the next session; the capabilities a
session registered stay as its setup listed them. The file holds only the
digest, the server's `initialize` instructions and a `listedAt` stamp, never a
token. On a miss setup connects once and lists; every server setup listed, and
every cached entry it read whose stamp is over a day old, goes to the cache in
one write, stamped now. A write drops each entry stamped over 14 days ago. A server
that cannot list is logged and contributes nothing. `tools/list` goes out with
the SDK's loose result schema and each entry decodes on its own: an entry the
spec's tool shape refuses is skipped with a warning, and a `null` description
counts as none. So the SDK keeps no output validators, and the tool checks
structured content itself.

Calls share one process Resource (`McpClients`): an `RcMap` opens a server's
connection on its first call and closes it after five idle minutes, and a
failed connect is dropped from the map, so the next call connects again. A
connection is dropped when its transport closes and when a call on it fails in
the transport; a JSON-RPC error leaves it open, and a close that takes over two
seconds is abandoned. A call that carried an `Mcp-Session-Id` on a reused
connection and was answered 404 (the server forgot the session, so it ran
nothing) is sent once more on a new connection; a 404 without a session
leaves the connection open and is not sent again. A 401 or 403 on a call
drops the connection and marks the server `expired`, or `logged-out` when
the entry signs in with OAuth and has no stored login.
The tools are listed again when a connection opens, when the server sends
`notifications/tools/list_changed`, and when it answers a call as an unknown
tool. One server's lists run one at a time, so an older list never lands
last: a list that differs is written to the cache (under one permit), so the
next session registers it, and a call to a tool the server no longer lists
fails with a message naming the stale catalog. An empty or failed relist keeps
the cached tools. The current session keeps the tools it registered; replacing
them live needs a host seam.

The read-only `mcp.status` host tool and the `/mcp` slash command report each
server's transport, tool count, connection, and health: `healthy` (listed or
connected), `expired` (the server refused the credential; the reason names
`/mcp login`), `logged-out` (the server refused an OAuth entry that has no
stored login; the reason names `/mcp login`), `misconfigured` (the entry cannot run: it does not decode, or names an unset variable),
`degraded` (a connect, list or call failed in the transport), or `unknown`
(read from the cache, not yet connected). With no server configured, only
`/mcp` is registered, and it says where to add one.

Each tool's input schema is imported from its JSON Schema (patterns ignored),
so the host checks input and the catalog shows its types. A tool with an
`outputSchema` has that type as its output: its result is the
`structuredContent`, and content that does not match the schema, or none,
fails the call. A result of text alone is its joined text, and one of
`structuredContent` alone (its text only repeating it) is that value; any
other result is an object of `structuredContent`, `text`, the other blocks as
`content`, and `omitted`, beside a `note`. `omitted` names each image, audio,
or blob block with its MIME type and size; the cell never receives the bytes.
Each such block is written once to `<data dir>/mcp-blobs/<sha256>.<ext>` (the
extension from its MIME type, else `bin`) and its entry gains that `path`; a
block over 20 MiB is not written and has no path. A save that finds its file
already there sets the file's modification time to now, and writes it again
when it is gone. The first save in a process removes the blob files last
written over 14 days ago, checking each file's modification time right before
it removes it, so a file a save just reused stays. `isError` fails the call as
`{ error }`. Server and tool names become id segments in the tool id grammar:
runs of `[A-Za-z0-9-]` joined by one `_`, no `_` at either end, and the wire
name `mcp__<server>__<tool>` within 64 characters (a server takes at most 20).
Names that clean to one segment all stay: in code-unit order of the original
names, the first keeps it and the next take `_2`, `_3`, and so on. Many MCP tools collapse in the prompt catalog by
the host tool catalog budget; the model reaches them with `tools.search` and
`tools(id)`.

App entrypoints bind concrete Bun/OS behavior:

- `apps/tui/src/main.tsx`

Production rule:

- `apps/tui/src/main.tsx` resolves a server via `Gent.server()` + `Gent.client()`
- `--connect <url>` attaches to a remote server via `Gent.client({ url })`
- `gent server start` (`apps/tui/src/ops.ts`) runs a standalone durable server in the foreground. Its flags (`--port`, `--isolate`, `--mock`) are the one way to choose how it launches; the environment names only where its data lives (`GENT_DATA_DIR`, `GENT_AUTH_DIRECTORY`). A signal stops it with exit 130 (SIGINT) or 143 (SIGTERM).
- Every listener gent opens binds `127.0.0.1`, never every interface (Bun's default when no hostname is given): the server's RPC (`LISTEN_HOST` in `packages/sdk/src/server.ts`, the address it binds and the url it names), the OpenAI browser login's redirect listener (`packages/extensions/src/openai.ts`) and the MCP one (`packages/extensions/src/mcp.ts`). The RPC has no auth and runs bash, so a peer on the LAN or the tailnet that reached it would run commands as the owner. A server on another machine is reached only through a tunnel: `ssh -L 3000:127.0.0.1:3000 <host>`, then `--connect http://127.0.0.1:3000/rpc`. Receipts: "the owned server listens on loopback only" in `packages/sdk/tests/server.test.ts` and "the redirect listener answers on loopback and refuses another address" in `packages/extensions/tests/openai.test.ts`; each also sends a request to the host's own non-loopback IPv4 address (the test preload lets a request to this machine's interface addresses through) and expects it refused.

## Shared Server Discovery

`packages/sdk/src/discovery.ts` owns shared-server discovery: the data paths, the build fingerprint, the lock, and the decision to attach or to start. The server root that composes the server stack (`packages/sdk/src/server.ts`: the shipped extensions, the dependency graph, the HTTP listener) is a separate module that `resolveServer` imports only when this process builds a server; a launch that attaches, and a command that only reads the data directory, never evaluate it (an attach launch to its composer, median of 7 interleaved runs: compiled 278 ms to 194 ms, source 704 ms to 490 ms). `packages/sdk/tests/index.test.ts` imports the SDK entry in a fresh process and fails when a module of the shipped extensions, the server root or the OpenTelemetry SDK loads. Two files sit beside `data.db` in the data directory (`GENT_DATA_DIR`, else `~/.gent`):

- `server.lock.db` is the kernel lock. The owning server holds an exclusive SQLite lock on it (`BEGIN EXCLUSIVE`, `busy_timeout` 0) for the life of its scope. The OS releases it when the process exits. A server is alive exactly when this lock cannot be taken, so a crash, a reboot, or a reused pid cannot leave a live-looking lock, and two concurrent starts give one owner: the other waits for the owner's entry and attaches.
- `server.lock` is the discovery entry the owner writes once it listens: url, pid, and the identity tuple. Clients attach only after `/_gent/identity` confirms the full tuple. An entry whose kernel lock is free names a server that is gone. Only the holder of the kernel lock removes the entry, whatever server it names: under the lock, the entry is the holder's own or a gone server's. Taking the lock (`serverLock.hold`, by a start, by `gent storage reset`, or by `gent server stop`) removes that entry at once, so a start that waits on the new owner never probes it, and a server removes its own entry before its scope releases the lock. `gent server stop` sends SIGTERM only after the identity probe; `--all` removes an entry whose kernel lock is free by taking the lock and letting it go, and when a new owner holds the lock first, the entry is the new owner's and stays. `gent storage reset` takes the kernel lock as a server start does (`serverLock.hold`) and holds it from the first look at the database files to the last move, so no server opens them mid-move; it refuses while a server holds the lock.

A start that finds a confirmed server of another build on the database fails with a message that names its pid; it never signals it. `gent server stop` is the explicit way to stop it. The build fingerprint (`buildFingerprint` in `packages/sdk/src/discovery.ts`, read once per start, so the lock entry and the identity endpoint name one build) is the binary's mtime for the compiled gent, wherever it is installed (`GentPlatform.compiled`, the one reader of the build's `__GENT_COMPILED__` define, which the cell reads too), and the checkout's git hash for a source run. A build neither names is `unknown`, and `unknown` matches no build, itself included: such a start never attaches.

A fixed port (`gent server start --port`) changes only the attach decision. A SQLite server on a fixed port still takes the kernel lock and writes its entry, so the TUI finds and attaches to it; it never attaches to another server itself, and fails with the holder's pid when the database is owned. The standalone server runs until a signal stops it: there is no idle shutdown and no shared launch mode.

`packages/sdk/src/discovery.ts` resolves SQLite-backed clients through this single shared server record. Workspace isolation comes from the `x-gent-workspace-id` RPC header and workspace-prefixed AgentLoop actor entity IDs, not from per-workspace server processes.

E2E coverage that needs process boundaries uses focused server-process fixtures; transport contract tests run through the in-process direct transport.

## TUI

TUI is a client over the shared contract, not a parallel app.

The session feed uses the durable input-message and step identity for each assistant message. The protocol exports the shared answer-ID rule. Stream chunks update that message only. Tool events locate their owning message by call or assistant ID, including late child results. Historical streams without IDs receive one local ID per stream.

The split region is a canvas: the footer's base (the composer, the status row, and the activity row while it carries content) and the transcript's last rows, the live tail. OpenTUI's split footer draws only its own region buffer (`getSplitPinnedRenderOffset` and the `footerHeight` setter in `@opentui/core` 0.5.14 `renderer.ts`): a region that grows at the terminal's bottom scrolls the rows above it into the terminal's scrollback, and one that shrinks keeps its top row, so the rows it gave up stay blank. So growing UI never grows the region. The slash suggestions, a docked pane and every other `PickerFrame` dock in the footer and cover the tail's last rows (`NativeTranscript` cuts the tail off at the footer); while one is open the footer's base stays the height it had before (`paneOpen`, from `useDockPaneOpen`), and closing it shows the covered rows again. In a long session the region takes all its rows (`regionMax`, the terminal less two rows), and the tail keeps the rows the region shows at the smallest base since the last replay (`footerFloor`), so a base that shrinks (the activity row going when a turn ends) shows kept rows, never blank ones; rows the region holds beyond the tail sit above it, under history, never between the tail and the composer. The transcript rows above the canvas go to terminal scrollback in transcript order. While a turn runs only a whole final item moves: a streamed answer (a `draft`) waits for the stored answer that replaces it, a queued follow-up and a pending retry wait, and a message waits while one of its calls runs. A tool group is one run of calls across the steps of a turn (`projectToolRuns`; reasoning and blank text pass, answer text, a user message, a session row or an ask end it), drawn at the message that holds its first call: that message waits until the run has ended, and its fingerprint holds the run's calls, so a run that grows after history took its top rows replays the transcript. Once no turn runs every item is final, and the top rows of an item move too (`ScrollbackSurface.commitRows` with a row range; the live view cuts those rows off the item, `partialRows`), so every transcript row is in scrollback or on screen, once. Rows leave the live view only once scrollback has taken them: a write OpenTUI refuses (the geometry changed under it) puts the rows and the region back, and a later pass writes them; so do rows drawn from an item that changed while they settled (`stillOffered`). An item that changes after history took its top rows replays the transcript: history is immutable. A whole item whose highlight does not settle in three tries, and every whole item at exit, commits as plain text (`PlainHistoryContext`: headings without their marks, code and quote bodies as text), never as raw markdown or blank rows. The plain layout has other rows than the live view, so rows of an item the live view shows in part (its top rows, or the rest once history holds them) commit as drawn on the last try and at exit. At the terminal's bottom the region shrinks only by the rows a commit moves into history: the commit shrinks it first, then writes the rows into the space they left. A commit ends on its last row, with no trailing newline: OpenTUI counts the empty row a newline leaves as history, so on a short screen the region would start a row under the rows. A region above the bottom (a short session) has the terminal's own empty rows under it: it shrinks to what it wants, and a tall pane grows it into those rows. Transcript rows keep the terminal's last column free (`FREE_LAST_COLUMN`): OpenTUI writes a committed row and then erases to the line's end, which in a terminal with a pending wrap erases a full-width row's last cell (a table's right border). Answer tables keep a grid, fit their content within the answer and pad each cell by one column (`ANSWER_TABLE`). A return from the alternate screen (the palette, a picker that holds the composer, the expanded transcript) replays nothing: the terminal kept its own screen, and the region takes back the rows it left, so the shell's lines above gent stay. After the return's first frame the region takes the rows the footer and the live tail want; the tail keeps its measure behind the overlay, so a turn that ended behind a picker shows its last rows. OpenTUI, patched (`patches/README.md`), keeps the split's history state for the screen the alternate one covers: a return at the same size takes back the region's row (a short session's top row too) and the column the last history row ends on, so the next commit starts under that row, not over it; and the terminal setup's reserved rows start at the region's top row, so they push no row into scrollback. Unpatched, the return seeds the split from the cursor at column 0: the next commit overwrites the last history row, and a short session's screen goes to scrollback a second time. A replay (a resize, a disclosure change, an item changed in history, `/clear`, a later transcript for another session or branch) writes history again from the top, so its reset clears the terminal's saved lines too (`resetHistory`): scrollback cannot drop some rows and keep others, and the copy it held would show each row twice. Only the first transcript keeps the shell's lines, as nothing of gent is above it. Exit and SIGINT, SIGTERM or SIGHUP leave the terminal the same way (`leaveTerminal`; the renderer is created without its own listener for those signals, `exitSignals`, which would destroy it before the flush): every item the live view still holds commits (over the alternate screen, the palette, a pane that holds the composer or the expanded transcript, the region first takes back the rows it left), a turn in flight as drawn and as plain text (`flushTranscriptForExit`, bounded at 1.5 s), then the renderer is destroyed, which is created with `clearOnShutdown: false`: the destroy clears only the split region, and the turns stay on screen above the shell prompt. An answer's ` ```mermaid ` fence draws as its own markdown block (`useDiagramCodeBlocks` in `apps/tui/src/mermaid.ts`, an OpenTUI code-block renderer with beautiful-mermaid behind it): it draws while the fence streams, each statement once it ends (a newline, or a `;` outside a label), and a source that does not draw shows as its code block. beautiful-mermaid loads on the first fence, not at launch (`DiagramLibraryContext`), and an answer with a fence reaches history only once the load has ended (`diagramsDrawable`): the first fence starts one load, which lands as loaded or failed; a failed load lets the fence land as code. The session feed retains the data for disclosure and resize replay. User messages use an OpenTUI heavy left border, so snapshot layout does not depend on a later height callback. Incremental one-shot output remains separate work.

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
apps/tui, packages/sdk
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
- author-facing errors: load, driver, provider-auth, service, process and
  interaction errors that extension code can intentionally return or inspect;
  an error only tests read (the capability errors) stays in core, where core
  tests import it by relative path.

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

One authoring shape: `defineExtension({ id, setup })`. `setup` is an Effect that yields `ExtensionHost` (`packages/core/src/domain/extension.ts`) and calls `host.register(domain, ...values)` for leaves (`tool`, `request`, `resource`, `agent`, `modelDriver`, `apiClass`, `modelRouter`) and `host.on(kind, handler)` for hooks. Setup-time host facts (`cwd`, `home`, `host`) live on the same service; runtime host authority comes from `yield* ExtensionContext`. The domain string IS the discriminator — TypeScript checks the value type per domain at the call site. The loader (`runtime/extension-host.ts`) provides a collecting host, seals the registrations into `ExtensionContributions`, binds requests to the extension id, and runs `validateExtensionPackage` so malformed registrations fail activation instead of dispatch.

There is no flat `Contribution[]` and no `_kind` discriminator. `ExtensionContributions` (`packages/core/src/domain/extension.ts`) is the compiled record consumed by the registry, hook compiler, and profile build; adding a new kind means adding a registration domain and a record field, not a new union arm. Each extension's process resources build once into their own child of the profile scope, which owns acquisition and release.

- **Resource** — `defineResource({ id, scope, layer })`. Start work runs in the layer build and disposal is a finalizer in it. Long-lived state has a stable identity and explicit `scope`; resources build in extension resolution order. `scope` is `"process"` (built once per profile, released when the profile scope closes) or `"branch"` (built per branch loop, released when the loop closes). Stateful extension logic is either a normal scoped service/resource or, for true actor protocols, an Effect Entity/RPC owner at the runtime boundary. See `packages/core/src/domain/extension.ts` and `buildScopeResources` in `runtime/extension-host.ts`.
- **Callable leaves** — `tool(...)` / `request(...)` smart constructors registered under the `tool` and `request` domains. `tool` = model-facing tool; `request` = typed extension RPC, optionally decorated with `slash: { trigger?, name, description, category?, keybind? }` to surface as a human slash command. Handlers receive input only. Host authority comes from the `ExtensionContext` facade (`Session`, `Interaction`, `FileLock`, `Models`, `State`); files, paths, processes, and ids come from the Effect platform services (`FileSystem`, `Path`, `ChildProcessSpawner`, `Crypto`); extension-private authority comes from extension-owned Effect service Tags. The `FileLock` facet wraps the host-internal `FileLockService`, the `Models` facet the `DecisionModelResolver`, and the `State` facet publishes `ExtensionStateChanged` on `EventStore`, so shipped and external extensions share the same surface. See `packages/core/src/domain/capability.ts`; `runtime/extension-host.ts` compiles the model, RPC, and slash registries. A request that fails answers the client with the extension's own reason as the `ExtensionProtocolError` message (a handler's error message, or `"<extension>" has no request "<id>"`), with no loop or runtime wrapper; the TUI shows a failed slash command as `/<name> failed: <reason>` on the status row.
- **Addressed session verbs** — `ExtensionContext.Session` reaches other branches through the same verbs the server uses: `create` (durable-once by `requestId`, optional `historyBranchId` copies the visible rows in, depth admitted by the host), `send` (one user message with a `delivery` mode: `"turn"` starts a turn on another branch with the loop `completion` modes, and the own branch refuses it and points at `"queue"`; `"queue"` is a follow-up keyed by `sourceId`; `"steer"` joins the running turn as an `Interject`), `stop` (writes a `Cancel` steer that stops the running turn, whichever message opened it; `Interrupt` has no writer and only decodes), `stopMessage` (the persisted `StopMessage` actor operation, through `stopMessageOn`: it records the durable cancellation of one message id, so a turn that message opens later starts interrupted, takes back a steer with that id that no step has read, and interrupts the running turn that message opened. A step's join of steers and the take-back hold the same queue permit, so a message is either joined or taken back, never both. It answers true only when this stop reached the message; false when the loop no longer holds it (its turn ended, or a step joined it into a turn another message opened, which runs on) or an earlier interrupt already stops its turn. A steer taken back answers true, unless an earlier stop from the same requesting branch already stops the turn the steer waited to join: the turn's latch records the requester of its first stop, and that stop's caller already reports the branch. A stop that reaches a running turn also takes back, under the interrupt permit, every waiting steer its own requesting branch sent (the `sender` a loop records on a steer into another branch's `Steer` operation and queue item, never a client): the turn's end cannot hand such a steer on as the next turn, so a later stop of that steer reaches nothing and the branch is reported once, however late that stop comes. A `Cancel` steer that names a `messageId` still decodes and runs the same routine), `events` (replay, then the `StreamSynchronized` marker, then live; `from: "now"` skips the replay and starts at the newest stored event), `delete` (cascade), `dequeueFollowUp`, and `holdResident` (a scoped hold that keeps the own branch's loop resident; see Residency). `send` and `stop` are a facade over the unchanged actor operations `SubmitDurable`, `QueueFollowUp`, and `Steer`, except that a `queue` or `steer` into the loop's own branch is admitted re-entrantly inside the caller: a client request's grant is read at admission, while the request provably runs, and a send from a context kept past it is an extension send; the raw `SteerCommand` stays on the RPC contract, not in the extension API. The bodies live in the `agent-loop.client` section of `packages/core/src/domain/agent-loop.ts`; The loop's `sessionControl` calls the queue bodies (`queueFollowUpOn`, `dequeueFollowUpOn`), and both `SessionRuntime` and `sessionControl` call `submitUserMessage` and `steerLoop`, so the facade and the RPC path cannot drift. The verbs are uniform: no extension, shipped or not, holds a grant another lacks. `AgentDefinition.maxModelAttempts` (and the RunSpec override) is the generic per-turn model-attempt budget, reserved durably per turn message id.
- **Hooks** — `host.on("systemPrompt" | "turnProjection" | "turnAfter" | "loopOpen" | "sessionDeleted", handler)` registers the five runtime hooks; each kind is typed by `ExtensionHookSignatures`. `loopOpen` takes no input and runs once each time a branch's loop is built in this process (the first operation after a restart, or after the loop closed), after the loop resumed any turn a restart cut short. It is where an extension repairs what a previous process left on the branch: re-arm timers, resume children, report lost work. It runs as the loop's own fiber, with the branch Resources and a non-client opener (it cannot ask). Nothing in it takes the side-mutation permit, which a running turn holds: the profile resolves under the profile cache's place lock and the Resources build under the branch's own lock, so the hooks run beside a turn the open resumed. Each hook runs on its own fiber, so a hook that never returns delays no turn and no other hook. A follow-up it queues on its own branch starts a turn like any other send, and the operation that opened the loop never waits on it. User extensions register it the same way. `sessionDeleted` runs once for each session a delete removed (`SessionMutations.deleteSessionCascade`: the session and the descendants it spawned; a handoff that continues its thread stays and is not named), after the rows are gone, with that `sessionId`. Each session is heard under the profile of its own cwd, resolved before the delete, so a descendant in another cwd reaches that cwd's extensions; a descendant created after the delete collected its tree is heard under the deleted session's profile. The host context names that session and has a non-client opener. Each extension's handler runs on its own fiber; a failure is logged (`extension.hook.handler.failed`). The delete waits for each handler up to `SESSION_DELETED_HOOK_TIMEOUT` (30 s); a handler past it is interrupted and logged (`extension.hook.session-deleted.timeout`), so a handler that never returns does not hold the delete once the rows are gone. An extension removes there what it keeps for a session outside the database. Hooks, tools, and requests all cross one membrane: `provideExtensionLeaf(frame)` in `runtime/extension-host.ts` reads the run's `CurrentExtensionHostContext` and provides `ExtensionContext`; `turnProjection` receives the agent the turn dispatches (`TurnProjectionInput`). Hook handlers receive event input only and yield `ExtensionContext` or extension-owned service Tags when they need authority. `turnAfter` carries `usage: { known, complete }`: the tokens of the steps that reported usable counts, and whether that is the whole turn (`TurnCompleted.usage` carries a total only when it is complete). See `packages/core/src/domain/extension.ts` and `runtime/extension-host.ts`.
- **Model catalog** — models.dev is the catalog, and core reads it. The owner's direction (Pass 30) replaces the rule that core fetches nothing: "models.dev is integral to discovery of models via providers so we don't really need to hardcode anything, only limiting factor is classes of api's we support", and "snapshotting will be good so we don't constantly ping … we can put that in our sqlite db". `ModelCatalogSource` (`packages/core/src/runtime/provider.ts`, model catalog source section) keeps the two sources, `api.json` (chat models) and `api.json?type=decision` (decision models), as served in the `model_catalog_snapshots` table with their ETags. A read answers from the snapshot at once; a snapshot checked more than an hour ago starts one background `If-None-Match` revalidation (a 304 moves `checked_at` only); only a first read with no row waits on a fetch (10 s). The two sources load apart: `read` waits only for the chat source, so a stored chat snapshot serves a turn or a model list at once while a decision source with no row is fetched; `readWithDecisions` waits for both, and the classifier listing and a turn model the chat catalog does not list read it, so a classifier still runs no turn. There is no bundled snapshot: an offline first start has no catalog, says so, and tries again a minute later. A scripted model (`--debug`, `server start --mock`) runs on `ModelRegistry.Scripted`: the catalog's entry when there is one, else an entry made up from the id with a 1M window, so a scripted turn runs with no catalog. `GENT_MODEL_CATALOG_URL` names a mirror; the test preload points it at a closed local port and refuses every request or connection to a host other than this machine, and a spawned test child reads the fixture from `serveModelCatalogFixture` (`@gent/core/test-utils`). A driver or API class never fetches the catalog: core hands each leaf the entry it needs as input.
- **API class** — the `apiClass` domain takes an `ApiClassContribution` (`packages/core/src/domain/driver.ts`): one wire protocol, named by the models.dev AI SDK packages (`npm`) and `provider.shape` values (`protocols`) it speaks. It turns a catalog entry plus an endpoint (`apiKey`, `baseUrl`, `transformClient`) into an Effect AI model and plans effort, thinking and sampling from the entry's `reasoningOptions` and `temperature`, so one model on two providers gets one request shape. Only the first-party Anthropic and OpenAI drivers carry an effort change inside the conversation (rule 11); the Messages and Responses classes a gateway composes send the plain request, because no gateway names a receipt that it passes the carrier on. Core picks a model's class by its protocol, then its package (`apiClassFor`); a model no class speaks is not listed and does not resolve. The shipped classes are Messages (`@ai-sdk/anthropic`, `packages/extensions/src/anthropic.ts`), Responses (`@ai-sdk/openai`, `openai.ts`) and Chat Completions (`@ai-sdk/openai-compatible`, `providers.ts`).
- **Generic providers** — a models.dev provider that no driver covers (by id or `catalogProvider`), that `disabledProviders` does not name, and whose models some class speaks with tool calling is served with no driver (`runtime/provider.ts`, generic providers section). It is active when it has a stored key, a key env variable from its `env` list, or a config entry; only active providers list their models and show in `/auth`, and the `/auth` search (`auth.listCatalogProviders`) finds the rest. Its sign-in is one API key method; each `${VAR}` in its base URL becomes a prompt, answered from the stored metadata, else the env variable, else a `ProviderAuthError` naming the variable. A variable that begins the URL (Neon's `${NEON_AI_GATEWAY_BASE_URL}/v1`) holds the origin: an absolute https URL with no user, password, query or fragment (no `?` or `#` at all, since URL parsing reads a bare one as empty), kept as typed. Any other variable fills one host label or path segment, percent-encoded and never `.` or `..`, so its value cannot move the key to a host or path the catalog and the user did not type; a filled URL that does not parse, or names a user, fails. The sign-in (`storeSignIn`) applies the same rule (`filledBaseUrl`) to the answers it would store and refuses them with the turn's message; a variable with no answer and no env variable is left to the listing's `missing`. Config `providers.<id>` patches or adds a catalog provider: `name`, `api`, `env`, `headers` (sent on every request), `class` (forces the class) and `models.<id>` (merged field by field into the entry). The registry reads the config fresh on each call (`ExtensionRegistryService.providerConfig`). A generic provider is not a driver: `driver.set` does not take it, and its failures have no owning extension in health.
- **Driver** — the `modelDriver` domain takes a `ModelDriverContribution`: the adapter of one models.dev provider (`catalogProvider`, else its id), naming only what models.dev lacks — auth, an `endpoint`, `overrides` where models.dev is wrong (each with a receipt: Claude Sonnet 4.5's window is 200k, `anthropic.ts`; `gpt-6.1-sol` accepts the `none` effort, `openai.ts`), `aliases` for model names it shipped before models.dev named the model (core resolves one, for a turn's model metadata and its dispatch alike and for `models.decide`, as the name it stands for, through one function, `currentModelName` in `runtime/provider.ts`; lists show only the current names; an alias that equals a name the driver's catalog view lists is ignored, so the real model wins) — and keeping `listModels` or `resolveModel` only when its requests need more than an endpoint (an OAuth reply rewrite, or a model its catalog provider does not list). With no `listModels`, core lists the provider's models a class speaks; with an `endpoint` and no `resolveModel`, core composes the entry, the class and the endpoint. A decision model of the catalog provider runs no turn on either path. The OpenCode driver (`packages/extensions/src/opencode.ts`, ids `opencode` for Zen and `opencode-go` for Go) serves each model on the class its entry names (OpenAI Responses, Anthropic Messages or Chat Completions). The Cloudflare driver (`packages/extensions/src/cloudflare.ts`, id `cloudflare`) sends Chat Completions to Cloudflare's REST API at `https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1` with one Cloudflare API token (`CLOUDFLARE_API_TOKEN` or the stored key); its sign-in asks the account id and an optional AI Gateway id (prompts, env `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_GATEWAY_ID`), and a set gateway id goes on every request as `cf-aig-gateway-id`. It takes a model id as given (`@cf/...` Workers AI models, `author/model` gateway models), reading the models.dev `cloudflare-workers-ai` entry, else the `cloudflare-ai-gateway` entry, for the model's facts, and lists the models.dev `cloudflare-workers-ai` models under its own id, then its Clef classifier models from the models.dev decision list (`cloudflare/@cf/cloudflare/clef`, `cloudflare/@cf/cloudflare/clef-flash`, decision only: chat refuses them; the ids it shipped before, `cloudflare/clef` and `cloudflare/clef-flash`, are aliases of them); a missing account id fails naming `CLOUDFLARE_ACCOUNT_ID` and `/auth`. Every Responses request (the OpenAI driver on both sign-ins, and OpenCode's Responses models) asks for low text verbosity on a model that takes one, as Codex and opencode do (`takesLowVerbosity`, `packages/extensions/src/providers.ts`). A driver may use another driver's sign-in (`credentialFrom`, one hop): core hands it the owner's stored credential, `/auth` lists one row for both and hides the sharer's own methods, and signing out removes the owner's key and any key stored under the sharing driver's own id, which also serves both while the owner has none. A driver naming a sharing driver (a chain or a cycle), or one the profile lacks, keeps its own sign-in. Each driver still falls back to its own env variable, and a row is ready from env only when every driver that needs it has its variable set (`runtime/provider.ts`, shared sign-in section). OpenCode is one sign-in, "OpenCode", stored under `opencode`: one key serves Zen, Go and Go Plus, so the Go driver names `credentialFrom: "opencode"`, keeping its own key method for a profile without Zen; the two catalogs and their model ids stay apart. An API sign-in method may ask `prompts` after the key (`AuthPrompt`: `key`, `label`, `placeholder`, `env`, `optional`), such as an account id: `/auth` asks each in turn on the key line (Esc steps back one field) and `auth.setKey` stores the answers with the key in one record (`metadata`, an additive optional field of the stored `Api` credential and of `ProviderAuthInfo.Api`). `auth.listMethods` leaves out a prompt whose `env` variable is set, and the driver reads the variable when the stored key has no answer. A driver's API methods are alternatives, and a stored key does not name its method: a credential (stored or from env) is ready when one API method has an answer or a set variable for each prompt that is not `optional`. Otherwise it is not ready: `auth.listProviders` reports `hasKey: false` with the unanswered prompt labels of the closest method in `missing`, and `/auth` draws the row as `[api] needs Account ID` (Cloudflare's gateway prompt is `optional`). An agent's `driver` (or a `driverOverrides` config entry) names a model driver; a stored override that names a removed external (ACP) driver decodes as no override and logs one warning per config file. See `packages/core/src/domain/driver.ts`, `domain/agent.ts`, and `runtime/extension-host.ts`.

Other notes:

- Process and branch Resources build through one builder,
  `buildScopeResources` in `runtime/extension-host.ts`: extension by
  extension in resolution order, each in its own child scope, over the
  services the extensions before it built. A layer that fails to build closes
  what it acquired, is logged naming its extension
  (`extension.resource.failed`), and leaves every other extension's Resources
  live. A process Resource that fails rejects its extension: the profile
  reports it failed at the `startup` phase. Branch resources come from the
  session's profile (the extensions set up for the session's cwd) and build on
  the loop's first turn or extension request, so a control-plane write never
  resolves a profile. A branch Resource that fails, or that needs a service a
  failed one would have built, is named once in the transcript (an
  `ErrorOccurred` notice with the extension id) and suspends its extension
  for that loop the way a failed process Resource does for the profile
  (`suspendExtensions`): the loop's turns, requests and hooks read the
  registry without it, so none of its tools, requests or hooks is offered or
  dispatched, and the branch's turns run with the others. The turn profile's
  registry is provided inside the profile's capability context, so the
  narrowed registry is the one a turn reads. Release runs in reverse build
  order when the owning scope closes.
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
- Effort follows the same order. `/effort <level>` (alias `/think`) stores the
  session's level: `off` stores `none`, and `default` clears it, so the run
  overrides, config and agent decide again. `/effort auto` stores `auto`
  (the `reasoning_level` column holds `"auto"`; the session reads it as
  `reasoningAuto: true` with no level, and an older binary reads no level),
  and each user turn asks the effort router for its level (the effort router
  bullet above); `/effort <level>` or `default` leaves auto. The `/effort`
  picker lists `default`, then `auto` and the levels the model accepts (its
  catalog `efforts`; neither for a model with no reasoning); the `default` row names the level without the
  session's own (`defaultReasoningLevel` on the snapshot and on
  `session.get`), so an override does not hide it. The status row shows the effort the model is
  sent, after the clamp to the levels it accepts (`effectiveEffort`,
  `@gent/core/protocol`). While a turn runs it shows the turn's own level:
  each `StreamStarted` names the level its step goes out at (the fields of
  the `StreamEnded` receipt), the metrics fold keeps it as `turnEffort` until
  `TurnCompleted`, and a level set meanwhile shows once the turn completes.
  On auto the row reads `auto → <level>` with the newest effort route's
  level, and `auto` before the first route.
  The change writes no notice and keeps the cache (rule 11).
- `createSession` accepts optional `initialPrompt` + `admission` for atomic create-and-send.

### Publishing events

Runtime code yields `EventStore` (`domain/event.ts`) directly. `publish` appends an event and delivers the envelope to subscribers; `append` and `deliver` are also separate so a mutation can append inside its transaction and deliver after commit. The extension `State` facet publishes only `ExtensionStateChanged` on the same store. Publishing is cwd-agnostic; per-cwd extension behavior comes from the turn's profile.

### TUI Extensions

- Builtins live in `apps/tui/src/extensions/builtins.tsx`; a builtin with its own view keeps its own `apps/tui/src/extensions/*.client.tsx` file
- Each is an `ExtensionClientModule` from `defineClientExtension` — same pipeline as user/project extensions
- Loader (`apps/tui/src/extensions/loader-boundary.ts`) accepts `disabled` list to filter extensions by id before `setup` runs
- Client extensions author against one public entry, `@gent/tui/extensions` (`apps/tui/src/extensions.ts`): `defineClientExtension`, `ClientContext`, the contribution constructors, `sessionQuery` and the rendering kit. A shipped `*.client.tsx` imports the TUI only through that entry.
- One `setup` shape: `Effect<ClientContributions, never, R>`. A setup handles its own failures; a defect is recorded as a load failure. A returned key that is no contribution bucket, or a bucket whose entries lack what the host reads (`CONTRIBUTION_BUCKETS` in `client-facets.ts`), fails that extension by name before the host resolves every extension together, so the healthy ones keep their contributions. The loader reads each known bucket of a setup's result once by property access (a class instance's getter counts), inside that extension's failure, where any throw, a defect included, fails only that extension, and decodes it to new plain data; the shared resolution never reads the extension's own object. Setups yield from the per-provider `clientRuntime`, which provides `FileSystem | Path | ClientContext`. `ClientContext` is the client twin of `ExtensionContext`: one Tag with the `transport`, `shell`, `workspace`, `lifecycle`, and `activity` facets, which a setup yields (`const { transport, shell } = yield* ClientContext`) and never threads as a parameter. There is no imperative `ctx` argument, no sync `(ctx) => Array` arm, and no package wrapper around paired server/client modules: a server extension and its `.client.{ts,tsx}` module are separate artifacts that share an extension id.
- Widgets are transport-only: subscribe to `transport.onSessionEvent` for event-backed invalidation or `transport.onExtensionStateChanged` for explicit extension-state notifications, then call typed extension RPC via `transport.request` for current state. Each widget owns its own Solid signal, keyed on `(sessionId, branchId)` so a stale model from the prior session never renders. See `apps/tui/src/extensions/builtins.tsx` for the canonical pattern.
- `lifecycle.addCleanup` registers Solid `createRoot(dispose)` disposers and event unsubscribes; the provider's `onCleanup` reaps them on unmount, so widget setups leave no detached roots behind.
- `lifecycle.scoped` allocates Effect resources in the client-provider lifetime. The main TUI scope awaits provider disposal before process exit.
- `activity` exposes a reactive view of the active UI session and its working, blocked, idle, or unavailable state. A surface with no activity to report reads `"unknown"`.
- `@gent/herdr` is a built-in client extension. It reports that UI activity through Herdr's local socket when `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID` are present. It sends ordered reports with the session ID and releases its authority on exit. The shared server and child agents do not own this reporter.
- `useExtensionUI()` (`extensions/host.tsx`) is host-side, not extension API: the shell reads the resolved contributions, load failures and `clientRuntime` through it. A widget reads the active session from `transport.currentSession()` or `sessionQuery`.
- Widgets are zero-prop components that self-source from context hooks.
- A throw from extension code the view runs while it draws fails only that extension (`extensions/host.tsx`): each widget renders inside `ExtensionRenderBoundary`, and the host hands out each tool, message and interaction renderer already inside it; each status label's `produce`, notice row source, message `prompt` and message `queueLabel` runs inside `Effect.try`. An autocomplete source's `onOpen` and `items` run inside one cause catch (`runAutocompleteContributions` in `extensions/loader-boundary.ts`): a typed failure of its `items` Effect is one log line and the source stays offered, and a throw or a defect fails its extension like a render throw. The host records `render failed: <reason>` against the extension id, lists it with the failed extensions, drops its widgets, labels, notice rows, renderers and autocomplete sources, and the view stays. A dropped renderer gives its place to the host's own: the default tool row, the runtime's or the plain message row, and `PromptRenderer`, which still answers the ask. The render-throw table in `apps/tui/tests/app.test.tsx` names a case for each contribution bucket, so a new bucket does not compile until it has one.
- An extension draws its own transcript rows with `messageRendererContribution`, keyed by the message's `metadata.customType`. The core transcript names only the runtime's own kinds and falls back to the plain row. Its `queueLabel` names a waiting message of that type in the queue widget (a queue entry carries its message's `metadata`); without one the widget shows the message's first line, and a restore takes the text either way.
- A row that is not a message comes from `noticeRowContribution`: the extension derives it per branch from `transport.onSessionEvent`, and the session view merges it into the transcript by time. Nothing stores it and the model never reads it. The session feed opens without waiting for client extensions; the client keeps what the feed delivered on the branch and hands it to a subscriber that joins late before the live envelopes, so each one sees the branch from its first event. A reconnect repeats envelope ids, which the subscriber skips. A source answers `None` until it can say its rows, and native history commits nothing until every source answers, so a committed row never changes. History holds for a source only 5 s after the client extensions loaded, so a source that never answers cannot hold it for good; after that, history commits without the source. The source is not a failure and stays: a later answer draws its rows among those history has not yet committed.
- `@gent/interaction-tools` (`interaction-tools.client.tsx`) draws the asks of the interaction tools by `metadata.type`: `prompt`, `ask-user` and `handoff`. The ask-user metadata and answer schemas belong to the server extension and come through `@gent/extensions/client`; they check shape only, so a question stored before a call limit still shows its choices. The host keeps the option list and the prompt renderer, its fallback for any other type. The option list reads its free-text row through its keyboard scope (`typedKey`, a paste, and `caretLineEdit` in `ui.tsx`: the `lineEdit` erase keys at the caret, left/right, home/end, delete and ctrl+k as the composer's textarea binds them), so typed text from any row is the free answer and the list works docked under a composer that keeps the focus; a line wider than the row scrolls so the caret stays in view (`caretWindow`); in a `PickerFrame` it fits the rows the frame gives it and leaves the title and key hints to the frame. The extension also draws the background questions of `ask_user_async`: a tray line in the `below-input` slot (`? 1 open question · <label> · assuming <assume> · /answer`; optional parts drop at narrow widths; it hides while a pane is open), read from `questions.open` on a session move, a finished `ask_user_async` call, a message, a turn end and the extension's pulse. `/answer` docks a pane that asks the oldest open question with the option list and the `ask_user` keys: the cursor starts on the assumed option (or on the assumption as its own first row), enter answers, typed text is a free answer, `ctrl+x` arms and a second `ctrl+x` dismisses (the arm belongs to one question: a new question or a close drops it), `esc` closes and the question stays open. A question sent leaves the pane at once; a failed send brings it back with a notice. A `question-answer` message draws as `↳ answered · <question> → <answer>`, the question cut first at narrow widths; while it waits in the queue it shows as `↳ answer · <question>`.
- `@gent/cache` (`cache.client.tsx`) folds a branch's stream, tool, interaction, message and compaction events into prompt-cache misses above a 1,024-token noise floor. Each miss gets a cause over the interval the TTL runs on, from the start of the request that refreshed the cache: a model switch, a changed prefix inside the lifetime the model catalog names (the regression alarm for a moved cache marker), or an expiry during a long response, a tool call, an approval wait, a paused turn, before a child completion, before a wake, or after idle time. The missed tokens fill the step's cache writes first, at the write rate, and the rest paid the input rate; each is priced over the cache-read rate, by the model the runtime priced the step by (`StreamEnded.pricedModel`, which follows a driver override) in `transport.modelCatalog()`. A miss is priced once, when the catalog is there; its row is born with that text. A row shows a miss of 20k tokens or $0.10; the status row shows the branch's `cache waste $X`. The row is telemetry for the reader, not context for the model. The same fold keeps the clock the loop's cold handoff reads: the start of the branch's last request (a retry's when it went out, an interrupted one's too; none after a compaction until the next request) and its model. A right-anchored status label (`anchor: "right"`, before `ctx`) counts the lifetime down: `cache 42m`, minutes rounded up, the warning color in its last fifth, `cache <1m`, then `cache cold`; a model that reports no cache writes caches implicitly, so its catalog lifetime is a measured guess and the count reads `cache ~28m`. A model other than the request's (`transport.selectedModel()`) reads cold at once. A lapsed cache on a window the loop's own cost rule hands off (`coldHandoffPays`, `@gent/core/protocol`, over the catalog entry's price and lifetime) reads `cache cold · next turn compacts`. A slow fiber on the client runtime reads `Clock` every 5 s, so a test clock moves it; a branch that never reported cache activity, or a model whose catalog names no lifetime, shows no timer.

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

**A scripted model checks its own script**: `controls.assertDone` on a
`LanguageModelLayers.sequence` dies when a step's `assertOptions` or
`assertRequest` check failed, not only when steps are left. The failed check
also fails its model call, which a turn reads as a provider error and goes
past, so only `assertDone` makes the test fail on it.

**Banned test control flow**: test files do not use `async`/`await`, Promise chains, raw Promise-returning test bodies, or hook cleanup patterns. Use `it.live` / `it.scopedLive` and scoped Effect resources so finalizers run under the test runtime.

**Names describe behavior**: active test modules are behavior-named. Historical process names belong only in `plans/` and dated audit receipts; a guard (`findProcessNames` in `packages/tooling/src/guards.ts`) refuses a ledger id or a pass name in source and tests.

**Lint strength never drops**: the guards read source through `oxc-parser`, the parser oxlint uses, so a comment, a string and code are told apart as oxlint tells them; a file oxc cannot parse is a finding. When a gent rule retires for an upstream one, its invalid lines stay in `packages/tooling/fixtures/held/`, each marked with the rule that holds it now, and `packages/tooling/tests/gent-rules.test.ts` lints them with the repo's own config. The TUI rule that a reactive scope tracks the session identity, not the record, is the oxlint rule `gent/no-tracked-session-record`.

### Commands

| Command            | Scope                                                 | Measured (Pass 28) |
| ------------------ | ----------------------------------------------------- | ------------------ |
| `bun run test`     | product behavior: core + tui + sdk + fast integration | 1m23s-1m26s        |
| `bun run test:e2e` | PTY e2e + focused server-process lifecycle coverage   | 1m37s-1m46s        |
| `bun run gate`     | typecheck + lint + fmt + build + test                 | 1m23s-1m31s        |

The times are wall clock on the workbox with cached builds, from the Pass 28
receipts in `plans/architecture-loop-2026-09-22.md` (runtime and extension
kernel acceptance). No guard reads them: measure again after a change to the
suite's size.

### Test structure

`packages/core/tests/` mirrors `packages/core/src/`. Implementation tests use relative imports into that source tree. They do not depend on the package entries:

```text
tests/
├── domain/        # agent, agent-loop, capability, event, extension, message, ...
├── extensions/    # api
├── helpers/       # agent-loop (the actor test root), test-preset
├── runtime/       # agent-loop, config, extension-host, model-context, provider, session, tools, turn, ...
├── server/        # rpc, server, workspace-rpc
├── storage/       # schema, storage
└── test-utils/    # index, language-model
```

One test file per source file. No god tests. Names match source owners.

`packages/e2e/tests/` holds only the slow end-to-end suite; in-process contract tests live in each package's `test` task:

- `test:e2e` — PTY TUI tests and focused server-process lifecycle coverage

### Important files

- `packages/core/src/test-utils/harness.ts` — `recordingEventStore`, the
  in-memory event store that keeps each appended event in a `Ref`;
  `baseLocalLayer`, a production-root preset over
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

`@gent/interaction-tools` — `ask_user`, `ask_user_async`, `prompt` and `handoff` tools.

The TUI renders interactions from the typed event feed (`InteractionPresented` etc.) routed by `metadata.type`. Pending interaction storage remains the durable source of truth for crash-safe resume. A branch has at most one open request. A second call that asks in the same step parks on the open one; when the step runs again, it waits until the first call takes its answer (matched by the encoded request), then asks its own question.

`ask_user_async` asks 1–3 questions without the interaction slot and returns at once: each question names the `assume` the model works on until an answer comes, and the result gives each its id (`<toolCallId>:<index>`). It is `interactive`, so a spawned child's non-client turn is not offered it, as it is not offered `ask_user`. The open questions live in `<data dir>/questions/<branchId>.json` (`makeBranchStateStore`; a session delete removes the file). The file holds open rows, and answered rows until their send: an answered question is in the transcript as its answer message, a dismissed one is gone. A replay of the same call, or the same question text asked again, replaces its open row and leaves an answered one as it is; past 8 open questions the oldest drops. Two requests answer during a turn: `questions.open` lists the open rows, and `questions.answer` answers and dismisses them in two writes under the branch file's lock. The first records each answer on its row (`answered: { answer, batch }`, written once and never changed) and removes the dismissed rows; the second (`sendRecordedAnswers`) sends each stored batch as one `Session.send` `"steer"` with `wake: true` and `metadata.customType: "question-answer"` (`details` names each question, its id, assumption and answer), then removes its rows. The steer joins the running turn at its next step, or starts a turn on an idle branch, and it only appends, so the cached prefix stays the same. A batch's `requestId` is `question-answer:` and the SHA-256 of the ids it answers, fixed when it is recorded: a send repeated after a failed removal sends nothing new, and a retry that answers fewer questions adds nothing, so the first answer to each question is the only one the model reads. An id that is not open is skipped. A recorded answer is hidden from the reader, so the send step also runs at each `questions.open` and on `loopOpen`: an answer whose send failed, or that a restart cut short, reaches the model with no new answer from the user. The answer text holds the question, the assumption and the answer, not the id. An answer or a dismiss pulses `State.changed()`. Headless answers nothing: it prints one line per question (`[question <id>: <question> · assuming <assume> · no user, the assumption stands]`), and the row stays open for the TUI.

## Workflow Results

Working values live in the kernel. Durable results are ordinary files. There is no separate result store, result RPC, or count badge. File links refer to the current content, not an immutable revision. A branch fork does not copy a saved plan; adoption requires an explicit file copy.

Workflow commands (`/plan`, `/review`, `/audit`, `/counsel`, `/research`) live in `@gent/workflows` as outcome prompts. They retain no workflow state and impose no fixed child count. The model uses cell bindings and files for working data, and delegates independent work when useful. Final plans, reviews, and audits use atomic writes to `.gent/results/<session>/<branch>/<kind>.md` in the server working directory. Explicit exports are separate files. Empty `/plan` reads that branch-local file without kernel bindings; it does not infer a plan from another branch. A plan saves its result and ends that cell before it requests approval in a separate cell, so the last good namespace precedes suspension. Review and audit prompts allow saving their reports but prohibit source edits; this instruction is not a sandbox boundary.

## Observability

Wide event boundaries (one structured log per unit of work) via `effect-wide-event`:

| Boundary     | Service       | File                    |
| ------------ | ------------- | ----------------------- |
| Agent turn   | `agent-loop`  | `runtime/agent-loop.ts` |
| Tool call    | `tool-runner` | `runtime/tools.ts`      |
| Model stream | `provider`    | `runtime/turn.ts`       |
| RPC request  | `rpc`         | `server/server.ts`      |

Logging conventions:

- Structured annotations: `Effect.logInfo("noun.verb").pipe(Effect.annotateLogs({ key: value }))`
- Never `Effect.logWarning("msg", error)` — always `.pipe(Effect.annotateLogs({ error: String(e) }))`
- Tool-level errors captured via `WideEvent.set({ toolError: "..." })` (value-level, not effect failures)

Log destinations:

- One directory, `<GENT_DATA_DIR or ~/.gent>/logs` (`dataPaths(home).logDir` in `packages/sdk/src/discovery.ts`): logs follow the data directory, so an isolated run keeps its logs beside its database. Startup (`ensureLogDir`) removes gent logs last written more than 14 days ago
- `<hash>-<ts>-server.log` — server-side JSON lines (via the SDK's `GentObservability`)
- `<hash>-<ts>-client.log` — TUI-side JSON lines (`clientLog` and `clientTraceLogger` in `apps/tui/src/client.tsx`); `<hash>` names the cwd, `<ts>` the process start
- Spans go to an OTLP endpoint when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (`GentTracerLive`), and the OpenTelemetry SDK loads only then; no trace file is written

Request-ID correlation: TUI generates a request id with `randomId` (`apps/tui/src/utils.ts`, Effect `Random`) at `sendMessage`/`createSession`, passes via `requestId` field in transport contract. Server threads into log annotations and RPC wide event boundaries.

## Non-Goals

- No cluster/distribution roadmap in this document.
- No compatibility notes for deleted facades.
- No process-purity dogma. Same-process direct transport is fine.

This doc describes the architecture we want to keep, not the migration history we already paid for.

## Bundled guidance

Skills are discovered once per branch resource; an unreadable entry or dangling link in a skills directory is skipped with a warning. Frontmatter is YAML; a missing `name` falls back to the file name, and a missing `description` to the first body paragraph that has text after its heading lines. A skill marked `disable-model-invocation: true` (Claude Code's key) is user-invoked only: the listing names it on one line per directory, with no description, and the model reads it only on its `$name`. Turn prompts list skills under a Local and a Global heading, grouped by skills directory. The model reads these files through the existing read tool or cell runtime. There are no skill search/load model tools. Typed skill RPCs still serve TUI discovery and content access; `$skill`, `$skill:local`, and `$skill:global` retain local-first or explicit-scope selection.

The skills listing goes into every request, so its size is a per-step input cost. The listing names each skills directory once and gives each skill its name and lead sentence (about 110 characters); the file is `<directory>/<name>/SKILL.md` unless the line names another file. The model reads the full text through the same read path: names and paths up front, content on read. On the owner's home this listing is 6.7k characters, against 21.5k for the former listing that gave every skill its full description and absolute path. The measurement that made it the only listing (a $0 Codex run, two prompts, each listing once): the first request of every turn fell from 8,905 to 5,162 input tokens (−42%), turn totals from 52,956 to 32,647, and both listings found the right skill for both prompts (the short listing read a wrong skill first once and corrected itself in the same turn).

Principles ship as an ordinary `principles` skill with Markdown reference files. The skills resource materializes the embedded bundle in a content-addressed directory under `~/.cache/gent/skills/`. It publishes the complete directory by rename, so concurrent profiles do not expose partial files. The separate cell process reads real paths. User global skills override bundled defaults; project skills retain local-first selection. There is no separate principles tool or principle-content registry.

Repository research uses the bundled `repositories` skill and supervised native commands. Git and package tools own authentication, fetches, revision reads, and command errors. Gent has no repository service, repository model tool, or native Git dependency. The skill preserves existing caches and requires exact revision receipts.

Saved-result writes use the existing `write` tool with `atomic: true`. The tool calls `writeFileAtomic` under its existing file lock. A symlink at the path is followed to its target, as a plain write follows it: the target is replaced and the link stays. The content is staged in a hidden sibling file beside the target, synced, then renamed over it; the target keeps its mode. Ordinary completion, failure, and scoped interruption remove the sibling file. Abrupt process death can leave that one hidden file, never a directory, and does not expose a partial destination. This does not claim power-loss durability.

An outer Effect deadline waits for acquisition and finalization: the platform's
file open and close and the writer's staging cleanup cannot be abandoned safely.
A stalled platform operation there can exceed the caller's deadline.
