# Gent Architecture

Minimal agent harness. Effect-first. Small seams. One owner per concern.

## Core Model

`gent` is organized around six nouns:

- `Server` — process-wide services only: storage, auth stores, platform, transport wiring, connection tracking.
- `Profile` — cwd-scoped extension graph: drivers, hooks, resources, capability leaves.
- `SessionRuntime` — the single public session engine: inbox, queue, checkpoint, watch state, turn orchestration.
- `Tool` / `Request` — independent callable leaves for model tools and typed extension RPC. Requests with a `slash:` block also surface as human slash commands.
- `Resource` — long-lived scoped services and extension-owned state.
- `Hook` — `systemPrompt`, `turnProjection`, `turnAfter`, `loopOpen`, `sessionDeleted`, and `toolCall` handlers registered with `host.on` for prompt, policy, turn follow-up, branch repair after a restart, cleanup after a session delete, and a verdict on each tool call before it runs.

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
   It has one hook: `toolCall` gives each call a verdict (allow, ask, deny)
   before it runs, and the strictest verdict wins. Rules live in an
   extension (`@gent/guard`, off until a config enables it).
   Receipts: `packages/core/src/runtime/extension-host.ts`,
   `packages/core/src/runtime/tools.ts` (the gate),
   `packages/core/src/domain/interaction.ts`.
8. **Each model step is classified once.** The stream fold produces a
   `StepOutcome`; persistence and the continue/stop/run-tools policy are
   exhaustive matches on it, and the tag travels on `StreamEnded.outcome`.
   Receipts: `classifyStep` in
   `packages/core/src/runtime/turn.ts`,
   `packages/core/src/domain/event.ts`.
9. **Retry policy belongs to the driver.** The loop re-runs a step; the
   driver says which failures are transient and when a retry can succeed
   (`retryAt`). Receipts:
   `RetryPolicy` in `packages/core/src/domain/driver.ts`,
   `packages/core/src/runtime/provider.ts`.
10. **Tool results are bounded before the model sees them.** At most 8,000
    characters inline (head and tail); the rest is paged through
    `context.read`. Receipt: `maximumModelToolResultChars` in
    `packages/core/src/runtime/model-context.ts`.
    A tool image travels by reference: the stored result holds a
    `ToolImage`, and each request reads its bytes from the blob store and
    sends them in a user message right after the tool results (Anthropic
    merges it into the tool results' user turn; Responses and Chat Completions
    take it as a user message after the tool output). A model the catalog
    says reads no images (`Model.imageInput` false), or an image whose blob is
    gone, gets one fixed line instead. Every text that stands for an image
    depends only on the image, its tool and the model, so a request prefix
    stays the same bytes. The estimate counts each image at the cost the
    model's API class names (`Model.imageCost`): Anthropic's
    `w*h/750` with no cap (it bounds the high-resolution models), OpenAI's tiles or 32-pixel patches by model at the
    `high` detail, which each OpenAI image part names
    (`Model.imagePartOptions`) so the estimate and the request agree. A model
    of a class that names no cost counts the highest of every shipped cost
    (`KNOWN_IMAGE_COSTS`; a test holds each shipped class to it). Images are
    bounded too: a request carries
    at most the newest 20 and about 12 MB of base64 (`Model.imageLimit`, from
    the API class: Chat Completions takes 5 and 4 MB), and past either it
    leaves out its oldest images five at a time, each as a fixed line. So
    the prefix changes only at the 21st and 26th image, never at each
    one, and the stored session never changes. The store fits each image
    to one fixed profile when a tool saves it, not to each model: 2,000
    pixels a side and 3.75 MiB, scaled with its aspect ratio kept and its
    original size recorded (`originalWidth`, `originalHeight`), which the
    image's line names with the factors that map coordinates back, one for
    each side when they differ. Every size is of the upright image (a JPEG
    its EXIF orientation turns is stored turned), and a colour profile an
    encode carries at more than a quarter of the byte limit is left out of
    that encode, so only undecodable bytes fail
    (the prior arts' settled entry "Tool image scaling" holds why). Receipts:
    A cell result carries the images its code shows, through the same
    projection (see the cell section). Receipts:
    `toolImagePrompt`, `toolImagesToDrop` and `toPrompt` in
    `packages/core/src/runtime/model-context.ts`; `saveToolImage` in
    `packages/core/src/runtime/tool-image.ts`.
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
    processes, ids, and HTTP through the Effect platform services
    (`FileSystem`, `Path`, `ChildProcessSpawner`, `Crypto`, `HttpClient`) and resolve
    relative paths against `ctx.cwd`; `runProcess` is the one command helper.
    `ExtensionPlatformServices` names that set with `GentPlatform`, and
    `extensionPlatformServicesLive` re-provides it: the server root and the
    tool test harness (`runToolWithCtx`) build an extension's platform through
    that one layer.
    No `ExtensionContext` facet duplicates an Effect platform service; the
    facets are host authority only (`Session`, `Interaction`,
    `FileLock`, `Models`, `Extensions`, `State`). An atomic write has one owner, `writeFileAtomic` in
    `packages/core/src/runtime/gent-platform.ts`; core config, extensions
    (through `@gent/core/extensions/api`) and the TUI (through
    `@gent/core/host`) all call it. Host facts core cannot get from
    Effect (OS info, executable path, home directory, the build the process
    runs) and the image codec (`transcodeImage`, `Bun.Image`) stay on
    `GentPlatform`.
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
18. **A leaf requires only the services it is given.** `tool` and `request`
    bound the services their `execute` may require (`LeafServices`):
    `ExtensionContext`, `ExtensionPlatformServices`, the core services the
    branch-tools entry exports (`BranchToolHostServices`), and the services
    of the resources the leaf names in `resources`. A body that requires any
    other service does not compile. A type argument that grants services makes its declaration
    required, so a typed input cannot grant a service without the value that
    provides it. Only a tuple type proves which resources a value holds, so
    an array type (`ReadonlyArray<typeof Counter>`) grants nothing; the
    factories infer an inline `resources: [Counter]` as a tuple. The bound is on the type: it limits the services `execute`
    requires (its `R`). It does not hide the runtime context, so
    `Effect.serviceOption` still reads a service the root holds
    (`registry_probe` in `packages/core/tests/server/rpc.test.ts`). The
    resource services derive from each `defineResource` value; there is no
    hand-written list. `defineResource` bounds its layer the same way: the
    host's services every build gets (`ResourceHostServices`: the platform,
    `SqlClient`, `InteractionStorage`), and for a branch Resource its
    `BranchAddress` and the services of the process Resources it names in
    `resources`; a type argument that grants a branch Resource services
    makes its `resources` required, as for a leaf. Package validation fails an extension that does not
    register the resource definition a leaf or a branch Resource names; the
    check is by identity, so another definition under the same id fails too.
    A process Resource names none, and a branch Resource names only process
    Resources. An extension that owns tables creates and migrates them in a
    process Resource over the host's `SqlClient`, under a migration table of
    its own; core's migration chain builds only the kernel's tables, and the
    root takes no feature input. The cell is the shipped case
    (`CellStorageResource`, `CellKernelResource`), and a user extension has
    the same two declarations. Receipts:
    `packages/core/src/domain/capability.ts` (`tool`, `request`),
    `packages/core/src/domain/extension.ts` (`defineResource`,
    `RequiredDeclarations`, `validateLeafResources`), `packages/extensions/src/cell.ts`,
    `packages/core/tests/extensions/api.test.ts`,
    `packages/core/tests/runtime/extension-host.test.ts`,
    `packages/extensions/tests/cell-receipts.test.ts` (cell tables).

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
- **A hosted root loses cluster request ids.** Effect's `SqlMessageStorage`
  reads its 64-bit snowflake ids under `SqlClient.SafeIntegers`, which
  `@effect/sql-sqlite-do` cannot honour: a Durable Object's SQL API returns
  each integer as a JavaScript number. A reply then names its request by the
  id's nearest double, so most keep-alives stay unprocessed and an awaited
  persisted request does not return to its caller (the loop still runs it).
  `hosted-storage.test.ts` states this behaviour. The fix is upstream (read
  the ids as text); gent does not fork the message storage.
- **Compaction is measured on long sessions only by hand.** The handoff
  count (`ModelContextProjected.compacted`) after the spill comes from gamut
  runs, not from a test; the receipt in
  `plans/core-extension-reduction-receipt.md` records the last measurement.

## Package Map

```text
apps/
├── tui/       # OpenTUI client over the shared transport contract
└── site/      # gent.cvr.im: landing page and install.sh, an Alchemy stack on Railway

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

The app services are one layer, `createDependencies` in `packages/core/src/server/server.ts`; no separate app-services layer exists. It is one stack of levels, each provided once to every level above it (host, storage, kernel, launch profile, models, tools, sessions, actor), so each layer in it builds once: Effect memoizes only leaf layers, and a composite named on several paths built once per path. One build of the production root (the shipped extensions, in-memory state) reaches a leaf layer 154 times, memo hits included, counted on 2026-10-05 as the calls to the memo map's `getOrElseMemoize`. The storage entry builds its SQL client once under every repository; the root takes no other storage, and an extension's tables belong to its own process Resource. The root's `StateLocation` names the client: `Disk` (a SQLite file) and `Memory` open a Bun SQLite connection and set its PRAGMAs in that client layer; `Hosted` takes a `Layer<SqlClient>` that the host opens and owns (a Durable Object's storage through `@effect/sql-sqlite-do`), and the root sets no PRAGMA on it. Storage init is portable DDL under the generic `Migrator` for all three. A SQL list binds as one JSON parameter through `sqlInList` (`storage.ts`, exported to extensions from `@gent/core/extensions/api`), never as one parameter per item through `sql.in` (a guard), because a hosted SQLite refuses more than 100 bound parameters. One runner owns a root's storage on every host (the SDK server holds the database's kernel lock), so the cluster's shard locks live in memory (`SingleRunner` with `runnerStorage: "memory"`) and a boot writes no lock row. `packages/core/tests/server/hosted-storage.test.ts` runs the root on Durable-Object-shaped storage. A test in `packages/core/tests/server/server.test.ts` counts the builds. The SDK builds it in the server scope, builds the RPC handlers over it once, and hands the handler context to `buildServerRoutes` and to its in-process clients, so one request deduper and one login-lease map serve both transports; the test harness provides it as a layer.

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
on disk, what the config files hold). Each resolve reads the config and lists
the user and project extension directories as they are now, under the place's
lock, so an edit to `disabledExtensions` and an added, fixed or edited
extension file reach the next turn and the next session without a restart.
An extension reads its own config keys at setup (`@gent/guard`,
`@gent/router`), and `UserConfig` decodes only core's keys, so the key holds
the hash of `FreshConfig.fingerprint` too: every key of the user and project
config files as canonical JSON, the disabled list left out (the key holds its
effect, the set of extensions), a missing file the same as `{}`, and a file
that cannot be read `unreadable`. An edit to any other key builds a new
profile for the next turn, a turn that holds the old one keeps its lease, and
a write of the same keys keeps the profile. A profile is built from one read
of the config: the extension scan and every setup run over
`configSnapshotFileSystem` (`runtime/config.ts`), which answers `exists` and
`readFile` of the two config files from `FreshConfig.files`, the read the key
was taken from, and sends every other path and operation to the platform. So
an edit that lands between the read and a setup does not reach the build, and
a file the read could not read fails again for each setup, never reads as
missing. Resource builds and leaves read the live files. Each extension entry (a file,
or a directory's index) is built with every module it imports by a relative
path into one module (`GentPlatform.bundleModule`, `Bun.build` with package
imports external), and its version is the built module's hash. The platform
serves the build at the entry's path with the version in the query
(`serveModule`), so a new version is imported afresh, the same version comes
from Bun's module cache, and a package import still resolves from the entry's
directory. The cache keeps each entry's last build with a stat stamp and a
content hash of every input (`buildExtensionModule`, `ModuleGraphs`, exported
from `@gent/core/host`, so the TUI's client loader builds through the same
code with its own bundler): a resolve with no
input touched costs a stat of each and reads no input (about 1.5 ms for the
scan); a save of the same bytes reads and hashes the inputs and builds nothing;
an edit builds again (about 10 ms; the first build of a process about 70 ms).
An in-place save sets the mtime before it copies the bytes, so a stamp whose
mtime is within one tick of the file clock (`RACY_STAMP_MILLIS`, two seconds
for FAT and HFS+) is kept as racy and the bytes decide, in a load and in the
client's stale check alike (git's racy-git rule).
A build is kept only when it is coherent: it read the inputs whose stats and
bytes were taken before it, and their stats and bytes after it are the same, so
a save during a build is never kept as the new version, even one that puts the
earlier bytes back (A, then B, then A: the inode and mtime moved). A build that found an import not known before it, or
that a save overlapped, builds again with what it found (the first build of an
entry with relative imports builds twice); after three tries the build runs
that resolve and is not kept. A failed build is never reused, so a relative
module created later is found; it keeps the last good build and records the
stats, taken before it, of every module the entry was known to read
(`extensionModuleChanged`), so a fix to a broken imported module is a change
to look at. An untrusted project's
files are listed, not built. Project trust comes from
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
end, a branch Resource built over it holds it while it lives, and a query holds
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
retires. The build key of an extension's process Resources names that context
as it started: the place, then the identity (scope, id, source, file version
from `LoadedExtension.version`) of each resource-bearing extension that
started before it, then its own (`startProcessResources`). A last good
version that runs in place of a version that failed to start is named by its
own version, in its key and in the key of each build over it, so a Resource
built over one version is never shared by a profile that runs another. A
branch Resource keys on what its build reads (`branchResourceKeys`). A reload (`SessionProfileCacheService.reload`, which the
`Extensions` facet calls) adds a count per (place, extension id) to the file
stamp, so the next resolve misses the cached profile, runs every setup again,
and keeps each Resource whose build key it shares; the counts live in memory
only. The cache keeps, per (place, scope, source path), the last version of
each user and project extension the place's current profile ran (`lastGood`).
A new version that fails `load`, `setup` or `validation`
(`loadRuntimeProfileDeclarations`), or whose process Resources fail at
`startup` (`buildScopeResources` `fallback`), runs that last good version in
its place, marked with the failure (`LoadedExtension.reloadFailed`); it keeps
the Resources the profile before it built, by their build key. A last good
version runs only in a set it is valid in: one whose contributions collide
with the set's fails as its new version did, and the set validates again
without it, so it never takes down an extension whose new version is good.
The profile key names the versions it decided by: the entry key adds to the
declaration key (`profileKey`) the last good version under the key of each
extension whose new version failed (`consultedLastGood`), named by scope and
source, since a user and a project extension can share an id; a fallback the
set rejected, and a failure with no last good version, count too. A profile
serves a resolve only while each of those is still the last good one
(`runsCurrentLastGood`), so a profile a turn still holds never brings an older
version back, nor keeps a failure that a newer last good version would fill. Health reports such an extension `Degraded` with an
`ActivationFailed` issue that carries the optional `runningVersion`, and the
facet reports it `Active` with the optional `reloadFailed`: both fields are
optional on the wire, so an older client reads a failed activation. A deleted
file, a disabled id and an untrusted project keep nothing. Branch Resources
have no fallback yet. An extension the disabled list names is reported `disabled`
(`resolveExtensions` takes it as a third list): `ExtensionHealth.Disabled` on
the wire, in the optional `disabledExtensions` field of both snapshot cases.
The TUI reads `extension.listStatus` again at each `TurnCompleted` of the
session in view (the turn resolved the extensions from their files) and on an
extension's pulse; the connection widget names a failed reload's running
version (`<id>: <error>; version <12 hex> still runs`), and `gent doctor`
names it too and lists the disabled ids (`Disabled: <ids>`).
The `Extensions` facet (`status`, `reload`) reads and reloads the session's
profile. The shipped `@gent/extension-admin` gives both to the agent
(`extensions.status`, `extensions.reload`), with four verbs over public entries
only: `enable` and `disable` edit a scope's `disabledExtensions` under
`FileLock` with `writeFileAtomic` and refuse a file that does not decode as a
`UserConfig` (exported from the extension API for this), keeping every raw key;
`add` copies a file or directory into a scope's extensions directory through a
hidden staging directory, and `remove` moves one into its own new directory
(an exclusive create) under the data directory's `extension-trash`, so no
remove replaces another, and deletes the source only after a whole copy when
a rename cannot cross file systems. The four ask once
(`Interaction.approve`) after their reads and before their write, so the tool
that runs again after the ask writes once; a headless run declines. `project`
needs a trusted project; trust stays the user's step. `resume` queues one
follow-up on the tool's own branch, which runs on the profile the change made.
The `/extensions` pane's two requests (`ExtensionAdminRpc`) make the same
changes without an ask, since the pane is the user's own act: a toggle off
writes the narrowest config that holds the session (the trusted project's,
else the user's), a toggle on takes the id from every config that names it.
No verb installs npm or git packages, and no watcher exists: the scan at each
turn start is the one apply point.
`buildSessionProfile` then stages the `ExtensionRegistry` and the base
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
binding names that process and is valid only inside it. A tool of a user or
project extension file binds to the file's version instead (`version:<hash>`,
`sourceRevisionFor` in `runtime/tools.ts`): after a restart the same bytes
replay, an edited file fails with `SourceMismatch`. Each profile also has a
revision, a short hash of what its extensions put in the request prefix
(`modelSurface`: each model tool in request order, with its name, description,
input and result schemas, prompt lines and whether it asks the user, then each
agent), not of their code: a body edit or a reload keeps it. What a hook
computes per turn (a turn projection's sections, a system-prompt rewrite) is
not a profile property and is not in it; a miss from it stays `PrefixChanged`. Every
`StreamStarted` of a turn names it (`profileRevision`, optional), so the cache
fold of the TUI names a prefix miss between two revisions `ExtensionsChanged`,
not a regression. The binding keeps the code identity; the revision keeps
only what the model reads.
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
  `Session` facade (the calling session is the parent; it names
  `parentBranchId`), then `send`ing the
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
- A thread is the sessions that share one thread key (`sessionThread`:
  `sessions.thread_id`, else the session's own id), in creation order; its
  key is its first session's id and its current session is the newest. A
  handoff (`continueThread`) joins its parent's thread and every other create
  starts one; no table, registry or field records a thread. The model opens
  unrelated work with `thread.start` (`@gent/session-tools`, `── threads ──`):
  a session spawned under the starter (so spawn depth applies) with its own
  key, the starter's agent, admission, model and reasoning, a run spec of at
  most 32 model attempts, and fresh context, whose task is its first turn
  (`Session.send` `turn`, `completion: "admission"`, metadata `customType:
"thread-task"`, a first line that says its replies go to the user and not
  to the starter). The ids come from the tool call (`thread:<id>` for the
  create, `thread-start:<id>` for the send), so a repeated call is one
  thread. A thread never reports to its starter: nothing lands on the
  starter's branch, so its cached prefix holds and no paid turn reads a
  result it did not ask for; work whose result the starter needs is a
  delegate child. The thread tools act for the caller's thread, not its
  session: after a handoff the new session owns what the older one started.
  `thread.list` reads the caller's thread tree (`listSessions({ thread })`:
  every session with the caller's thread key and every session below any of
  them, so a deleted first session, whose handoffs stay detached, loses none
  of the rest; the agents view reads a `root` the same way), groups it by
  key, and keeps the groups whose first session any
  session of the caller's thread spawned, with each one's status from
  `listActiveLoops`, its current session, and the current session's latest
  reply (one line, or 4,000 characters head and tail for one named thread);
  `read_session` reads the rest and `session.send` messages the current
  session. `thread.stop` stops each working loop of such a thread and
  refuses any other. One thread runs at most four threads over all its
  sessions: the count and the start it admits hold one process permit
  (`ThreadStarts`), and a start past the cap deletes the session it made and
  names the four. A thread's first message has `customType: "thread-task"`
  and a delegate child's `"child-task"`; the transcript shows only the task
  under a `thread · task` or `delegate · task` header. The
  starter's interrupt does not stop a thread, and a thread's unattended turns
  decline their asks (`turnCanAsk`). A delegate child is denied
  `thread.start`. The `# Sessions` prompt section shows its `thread.*` lines
  only to an agent that may call `thread.start`.
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
  `Interrupted` and the call does not run again. A tool that keeps durable
  receipts settles its own pending calls first: `tool({ recover })` runs once
  per pending call of that tool that has no result (stored, or kept by the
  process beside a parked sibling), as a leaf of its extension under the turn
  profile, and answers `Settled` (the result its receipt gives), `Suspended`
  (the turn parks on that request), or `NotRecovered` (the rules above). Each
  tool answers only for its own calls, so tools of several extensions settle
  in one step. The binding replay rules then decide whether a parked call can
  run again or fails.
- Narrow retry: `retryProviderCall` retries transient provider failures with
  bounded exponential backoff plus jitter, and only before observable output.
  The policy lives on the `ModelDriverContribution` (`retry: RetryPolicy`),
  because the driver knows its own overload and rate-limit shapes; the loop
  only re-runs the step. Transient means the provider library's typed
  `AiError` says so, or a mid-stream error event matches the driver's
  `transientStreamEvent` schema (Anthropic names a `type`, OpenAI a `code`).
  The driver's `RetryPolicy.retryAt` says when a retry can succeed, in epoch
  milliseconds: the latest of the times it knows (`latestReset`), so a short
  generic retry-after never shortens a usage limit's own reset. The times are
  the typed `retry-after` (`retryAfterAt`, the default) and, decoded by
  schema from the answer of a rate-limited request only (`rateLimitResponse`;
  a refused request can carry the same headers), the ChatGPT 429
  `usage_limit_reached` body's `resets_at` (or `resets_in_seconds`) and the
  latest reset among the spent limits the `x-ratelimit-*` (OpenAI) or
  `anthropic-ratelimit-*` (Anthropic) headers report (`spentLimitsReset`; a
  limit with some left does not hold the retry). That time replaces the
  backoff; one more than the policy's
  `maxDelay` away (a usage limit that resets in hours) fails the step without
  a retry, and the turn reports it (`limitResetAt`): `ErrorOccurred.retryAt`
  (optional, so an older row decodes) and `TurnAfterInput.retryAt` (in
  memory, for a turn that failed and was not interrupted; a turn that fails
  before it runs begins its own ledger, so it never names the turn before
  it). The TUI error row
  ends its first line with the wall-clock reset. Nothing is inferred from
  message text.
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
- the tool runner (`runtime/tools.ts`) is the one place that checks a tool call. The drivers pass each call on as the model wrote it and the reply decodes its parameters as opaque (`patches/README.md`: `effect@4.0.0` and the three driver SDKs), so a call whose input the tool's parameters refuse (a wrong type, a missing key) fails as its own result (`Tool '<id>' input failed: …`), and a call to a name no extension registers as `Unknown tool: <id>`. The model reads the result on the next step; the stream does not fail and the step is not retried. A turn that advertises no tool sends no toolkit and no `tools` or `tool_choice`, and a call in its reply fails as `Unknown tool: <id>` too (`a turn that advertises no tool`). The request's tool declarations do not change (`tool declarations on the wire` pins each driver's bytes, and `final step declarations on the wire` the last step's).
- `convertTools` (`runtime/tools.ts`) declares a tool whose parameters encode to an object with no keys (`Schema.Struct({})`, as `mcp.status`) with the object root `{"type":"object","properties":{},"required":[],"additionalProperties":false}`, for every driver and for every extension's tool. Effect's JSON Schema reads such a schema as any value but `null`: the OpenAI codecs refuse it, so each request that advertised the tool failed, and the Anthropic codec declared `{}`. A tool whose parameters encode to an object that takes keys it does not name (an index signature: a `Schema.Record`, a struct with rest, an MCP input schema without `additionalProperties: false`, or the MCP `AnyInput` fallback) declares its own JSON Schema as an open object (`additionalProperties` holds the value schema) with `strict: false`, for every driver and every extension's tool. The codecs encode such an object as an array of `[key, value]` pairs: the OpenAI codecs refused it, so each request that advertised the tool failed before it was sent, and the Anthropic codec declared an array root. Strict mode needs `additionalProperties: false` on each object, so a strict declaration would tell the model that the tool takes no other key. Effect's `Tool.EmptyParams` form (string keys with `never` values) stays on the codec. Each other tool's declaration is the codec's, as before (`tools that take any key on the wire`). The tool runner decodes a call with the tool's own schema.
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
  optional `summarized` range) that status and the TUI read. Core owns its
  one recogniser, `contextWindowOf` (`@gent/core/extensions/api` and
  `protocol`): a marker the runtime wrote, its type and its decoded details,
  reads as its anchor, summary and notice; the type alone or a copied notice
  reads as nothing. No compactor names the type by value. A window that
  every compactor fails degrades to truncation with a visible notice. The request names the
  agent whose window it compacts (`agentName`), so a project compactor can
  serve one agent and fail with `ModelCompactionError` for the others.
  Installed compactors form one chain in scope order, project, then user, then
  builtin (`chainCompactors`, joined where the host merges each extension's
  Resource services): the first summary wins, a `ModelCompactionError` hands
  the window to the next compactor, and with none left the window is
  truncated. A compactor runs with the `ExtensionContext` a tool call of its
  extension on the compacted branch gets: the merge wraps each extension's
  compactor before it joins the chain (`ownedCompactor`), and each call runs
  `provideExtensionLeaf` with the owner's id over the turn's host context and
  the compacted agent. So `ctx.State.changed()` and `ctx.Session.send` name
  the owner, and `ctx.cwd` is the session's cwd: a user-scope compactor or a
  process resource that profiles share needs no cwd captured at setup, and
  the request carries no cwd. The marker's notice
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
  session created through the addressed `Session` facade verbs (`create`,
  whose parent is always the calling session, with `parentBranchId`; `send`,
  `stop`, `events`, `delete`). The
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
  overrides for model, reasoning, tool and path narrowing, and added instructions, and
  a `context` of `fresh` (the child sees only its todo) or `fork` (the child is
  created with `historyBranchId` = the caller's branch, so it starts from the
  caller's current context window). A history copy is settled first: a tool
  call with no result in the source, such as the `delegate.start` call that is
  making the fork, is left out with its step, and a result whose call the
  window cut away is left out too, or the child's first projection would
  reject the group. `delegate.start` always denies the child the delegation
  tools and `thread.start`: fan-out is the caller's decision, a project prompt that
  addresses "the orchestrator" reaches children too, and a child does bounded
  work for its parent, not unrelated work of its own. Parents read child output through `read_session` on the
  returned session/branch IDs. The session is the only copy of a child's
  output; the completion message carries the outcome and a preview.
- Snapshot children: `delegate.start` takes `isolation` (`shared`, the
  default, or `snapshot`). `@gent/workspaces` (`packages/extensions/src/workspaces.ts`)
  owns the copies and uses only the public extension API, `runProcess` and
  the platform services. A path-confined parent run bounds its snapshot
  child by its scopes in the parent's cwd, so the child's file calls in its
  copy are refused (decided in the narrow-only batch, Round 6, on least
  authority): core has no copy relation, and moving a parent's relative
  entries into whatever cwd a create names would let a confined run reach
  any directory by naming it. Core has no workspace concept: the seam is
  `Session.create({ cwd })`, and the child's profile is the copy's.
  - The backend: `rift rpc` with `copyAll` (one snapshot, an exact copy) only
    when the origin is a rift workspace on btrfs. Everywhere else, and for any
    rift failure, a detached `git worktree` under `<data dir>/workspaces/worktrees/`
    with the origin's working tree checked out unstaged. gent never asks rift
    for a filtered copy: rift's filter drops names such as `build` even when
    git tracks them. The start result notes why a copy is a worktree.
  - Hooks: gent sends `hooks: false`, so rift runs no `precreate` in the
    origin. gent reads `.rift.toml` with `Bun.TOML.parse`, checks it as rift
    does (`version = 1`, only the four hook lists, a non-empty `run`), and runs
    the `postcreate` steps in the copy with the `RIFT_*` variables. rift reads
    `version` as a `u32`, and `Bun.TOML.parse` reads `1.0` as the number 1, so
    gent also reads the `version` token as written in the root table: a TOML
    float or a string runs no step, and the start note says why. Every git
    command gent runs sets `core.hooksPath=/dev/null` and turns automatic
    maintenance off, so gent's plumbing runs no hook in the origin
    (`packages/extensions/src/git-plumbing.ts`, the one runner of gent's
    git commands, which fails with git's last line as `GitError`). rift itself
    still adds `/.rift` to the origin's `.git/info/exclude`.
  - Identity: the name is `child-<12 hex>` of a SHA-256 over the parent
    session, the parent branch, the start's request id and the resolved
    origin. A repeated start with all four adopts its copy; any other start
    gets its own. A copy bound to one child session is never bound to another,
    and a session whose index names one copy is never bound to another. The
    delegate's `Session.create` request id is a SHA-256 of the same parent
    session, parent branch and tool call, and the child's first message is
    `delegate-start:<child session id>`: core keeps one session per request id
    and one message per id, so two parents whose tool calls share an id get
    two children.
  - Records: `<data dir>/workspaces/<name>.json`, under the extension file
    lock, written as `creating` before gent makes anything. The record names
    the real directory that holds the copy (`root`: gent's worktrees
    directory, or the rift storage) and the copy's real path in it; a rift
    record also keeps the copy's rift id (its `.rift`). After the copy exists
    gent writes an ownership marker (`gent-workspace`) into the copy's git
    directory: a SHA-256 of the identity digest, the copy's real path, the
    backend and the rift id. gent proves the git directory without following
    a link: a rift copy's `.git` is a directory in it; a worktree's `.git` is
    a file whose `gitdir` resolves into the origin's `.git/worktrees/`; git
    must name the same top level and git directory. A link or a directory at
    the marker's place is refused; the marker goes to a new file beside it
    and a rename puts it in place, so a link that a whole-tree copy brought
    along is never written through. Then gent runs the hooks, captures the
    base (the copy after its hooks, as one commit on a private index), writes
    it into the record, and makes `refs/gent/base/<name>` (in the origin for
    a worktree, in the copy for rift) with compare-and-swap from absent;
    `ready` comes last. gent adopts, collects or removes a copy only when the
    record and the marker agree and the copy's real path lies in the
    directory its backend owns; never a path that is, holds or lies in the
    origin. A directory it cannot prove is kept, and the call says so. A
    crash recovers by phase: `creating` with nothing there is made again; a
    marked half-made worktree is removed and made again (its base ref goes
    only from the recorded base); a half-made rift copy is retained.
  - `retained`: a record that gent keeps with its copy and never adopts,
    collects or removes; the record says why. Every rift copy ends here, and
    so does a copy whose base ref was already there, or a rift copy that a
    later step of its making could not finish. Manual removal of a retained
    copy comes with W2 (the copy list, confirmed by the user).
  - Merge-back is a branch, never a merge. At each child turn end the copy's
    tree goes on `refs/heads/gent/<name>` of the origin as one commit over the
    base. A worktree shares the origin's objects; for a rift copy gent fetches
    the commit by id into no ref (`--no-write-fetch-head`, then `cat-file -e`
    proves the commit is there). Then `update-ref` moves the branch. gent
    writes no other ref of the origin. gent moves or deletes the branch
    only with compare-and-swap from the commit it last wrote (the record keeps
    `tip`, and `nextTip` for a write in flight). A branch someone else moved,
    or one a worktree has checked out, stays as it is: the completion says so,
    and the work stays in the copy. A turn is collected once: the delegate's
    completion reads the collect of the child's start turn. The completion
    names the branch and a diffstat in its text and in `details.workspace`. No
    model call.
  - Lifetime is the child session's. The delegate's admission scope closes
    after the registry write. When the admission fails or is interrupted,
    storage decides, not what the fiber saw: core can store the session and
    then be interrupted before `Session.create` returns. The finalizer lists
    the parent's sessions (`listSessions({ thread })`) for a child of this
    parent branch whose cwd is in the copy (the copy's path is named by the
    start's identity). A stored child gets the copy (bound); no stored child
    releases it; a list that fails keeps it. `sessionDeleted` collects and
    ends the copy under one lock; a collect that fails or leaves the work in
    the copy keeps the copy and its record. A worktree copy is removed with
    `git worktree remove` (one that fails keeps the copy; no recursive
    delete), and its base ref goes only from the recorded base: a moved base
    ref keeps the copy and the ref. gent never removes a rift copy: rift's
    remove runs `preremove` and then trashes the whole subtree, so a copy
    made from it in between goes too, and no `rift rpc` request refuses a copy
    with descendants in one step. A rift copy is collected and then
    `retained`. gent prunes nothing by age; a copy of a session that is not
    deleted stays. The branch outlives the copy.
  - The session index (`<data dir>/workspaces/sessions/<session id>`) holds
    the bound copy's name, so a turn end of a session with no copy reads one
    missing file. A delete whose index was lost reads every record.
  - Refusals: a cwd outside git or with no commit, under 2 GB free where the
    copy goes, and free space that `df` does not report. The four-child cap is
    checked before a copy is made. Making a copy can be interrupted; only the
    record and marker writes are masked.
  - A copy is not a sandbox: the child's `bash` and cell still reach every
    path. Project trust (`trustedProjects`, `isProjectExtensionDirectoryTrusted`)
    is keyed by directory and does not follow the copy: the child's profile
    lists the copy's project extensions and does not build them until the
    owner trusts the copy's directory. No core change makes it follow.
- The TUI agents pane lists children through `AgentsViewRpc.ListAgents` and
  refreshes on the delegate's and session-tools' `ExtensionStateChanged`
  pulses (`thread.start` sends the second), matched by
  `DELEGATE_EXTENSION_ID` and `SESSION_TOOLS_EXTENSION_ID`. Completion rows read the completion message's
  details. Core publishes no `AgentRun*` events.
- `ListAgents` lists one row per thread: `buildRowTree` folds the sessions of
  one `sessionThread` key (a handoff chain) into one row with the newest
  session's ids, name and liveness, the most active session's status, the
  first session's start, parent and side-thread mark, and the additive
  `sessions` field (the member ids, oldest first, when there are two or
  more) and `thread` field (the key, which a handoff keeps).
  `parentSessionId` stays the stored parent; the tree nests a child of an
  older session under its thread's row through the members, and the TUI
  does the same through `sessions`. A `root` stands for its thread: the
  listing reads the subtree of the root's thread key, so a handoff's tray
  holds what the sessions it continues started. The activity watchers follow
  the loops before the fold. The pane shows
  `N sessions` in the right column (a narrow pane drops the side-thread mark
  first), marks the row current when the shell is on any of its sessions,
  and a second Ctrl+X deletes each session of the thread, newest first, since
  a session delete keeps a same-thread handoff.
- The tray adds `done · <name>` after its `working` rows (three rows at most,
  the rest counted) for a side thread that a listing showed running and a
  later one idle while the shell was not on it, in the subtree of the shell's
  thread. The thread the shell is on counts as seen too, so a finish the
  reader watched inside the thread is no done row back at its starter; a done
  row is made only for a descendant. The controller keeps that state outside any component, keyed by
  thread key, and changes it only for a reply `sessionQuery` keeps
  (`accepted`). Opening the thread, its next turn on any of its sessions, or
  its absence from a whole listing of the root it finished under (no filter)
  clears it; a filtered listing never does. A delegate child gets none: its completion lands in
  its parent's transcript, and its row carries the additive `delegate` flag
  (its admission names the `delegate` agent).
- Child session nesting depth is admitted on the `session.create` command path
  (`admitChildSessionDepth`). Missing or incomplete ancestry is an error, not
  root depth; a parent at the depth limit cannot spawn. Only spawn edges count:
  a handoff (`continueThread`) keeps its parent's thread, is not admitted, and
  keeps its parent's depth.
- Two shipped agents: `main`, the orchestrator, and `delegate`, registered by the delegate extension as the agent every child runs as. A child inherits neither its caller's agent nor its model, only its caller run's bound (its tools and paths never exceed its parent run's): its model and effort come from the `delegate` definition, reshaped by `agents.delegate` in `.gent/config.json`, and a call's RunSpec overrides (model, effort, prompt addendum) win over both, while its `tools` and `paths` only narrow the definition. The `delegate` agent holds `["*", "!delegate.start", "!delegate.cancel", "!delegate.list", "!thread.start"]`; a call's `tools` narrow those patterns, so it cannot hand a child delegation back. That config entry is where a pairing such as fable → opus or opus → sonnet is declared.
- `/btw` (`@gent/btw`) forks the branch: `btw.fork` creates a child session with `historyBranchId` set to this branch, so the fork starts from this branch's context window and runs as the session's own agent with its tools — a parallel session, not a side channel. Nothing it does lands on the branch it forked from until the user merges it. The copy keeps a request the session is still working on, because a question is usually about it; so each question goes to the fork under a header (`forkQuestionText`, `customType: "btw-question"`) that names the session it forked from, says a request with no answer above is that session's work and not the fork's, and asks for changes only when the question does. Without it a fork opened mid-turn took the session's task as its own and did it again in the same working tree. The pane and the fork's transcript row show the question without the header (`forkQuestionBody`). The pane asks it through `btw.ask` and reads it through `btw.progress` (turns after the fork point plus the reply streaming now, folded from the fork's event stream by a process resource). Each state pulse the follower sends is a stored event on the branch and a re-read of the fork in the open pane, so a fork event that leaves the pane's view as it was pulses nothing, and streamed text pulses at once and then at most once per 250 ms, with the last change always pulsed; Enter on an empty ask line opens the fork as the shell's session, which is `switchSession`, because the fork already is one; `ctrl+o` keeps its one meaning, the transcript's detail level. The open fork per branch is process state; the fork itself is durable and listed with every other child session. `btw.merge` posts one message to the branch (`customType: "btw-merge"`) that names the fork session, its first own message and its last reply by id, with no reply text and no summary call: the branch's model reads the fork with `read_session` from that message when it needs it, so the merge appends a few lines and the cached prefix holds. It is a `steer` with `wake`: a running turn takes it at its next step with no turn of its own, and an idle branch starts the turn the user asked for (a queued follow-up always costs its own turn; a parked steer answers after the user's next message). Its request id is a digest of the fork and the reply, so a repeat posts nothing (`merged: false`) and a later reply merges again. A merge with no open fork, while the fork answers, or before its first reply is refused. The fork stays open and durable after a merge; `/btw` reopens it. In the TUI pane `ctrl+s` merges; its hint shows only once the fork has answered, and the key refuses with a notice before then. A merge closes the pane it was asked from: an answer that lands after the reader switched session, or closed and reopened the pane, leaves the pane in view alone. The fork's name is one line (`forkName` folds whitespace), since the pinned label reads it from the merge's first line. The branch draws the merge as one collapsed row, `↳ merged btw · <question> → <reply>`, queues it as `↳ btw merge · <question>`, and pins it as `merged <fork name>`.
- Alarms and monitors (`@gent/wake`) live in `<data dir>/wakes/<branchId>.json` (`resolveDataDir(ctx.home)`: `GENT_DATA_DIR`, else `~/.gent`; `ctx.home` is the OS home); timers are branch-scoped. One branch lifecycle permit serializes durable publication, timer installation, re-arm and cancellation; waiting for it is interruptible, then the transfer completes. Cancellation releases the file lock before waiting for stopped timers. `wake` fires at a time, and again every `everySeconds` when it repeats (the stored due time advances on each fire; ticks missed while the process was down fold into one fire); `monitor` polls a shell command on an interval until it exits 0 or its stdout matches `until`, or its deadline passes. Both write the entry, capture the session facade of their call, and fork work into the branch resource scope that queues a user-role `wake` message (`details: { outcome, note, firedAt }`; `fired` is an alarm, `matched`/`timed-out` a monitor). In `wake` mode (default) the line carries `wake: true` and starts a turn on an idle loop; a line the session refuses (a full follow-up queue, for one) is logged (`wake.fire.refused`) and stored as a `notice` entry instead, so the fire is not lost. In `notify` mode no line is queued (a queued follow-up always runs a turn on a branch with history): the fire stores a `notice` entry in the same file and pulses the tray; `turnProjection` (every step) reads the notices into a `# Notices` turn notice, and `turnAfter` clears exactly the notices in `readNotices`, the ones an answered turn's steps showed (a lost process shows them again), so a failed, interrupted or unanswered turn keeps them, and a notice written after the last step read the file waits for the next turn; `wake.cancel` dismisses one unread. A settled one-shot fire removes its entry; an interrupt (branch close, shutdown) leaves the row for the next re-arm; a repeat only ends on cancel. `wake.cancel` interrupts one timer by id, or every pending one on the branch, and drops the entries; the resource keeps fibers by id for that. Branch resources start without an `ExtensionContext`, so after a branch close or a server restart the stored entries get their timers back when the branch's loop opens (the `loopOpen` hook re-arms them under the branch file's lock, the lock a fire takes to drop its entry, so a fire that ends during a re-arm is not armed and fired again; past-due alarms fire at once, and a past-due `notify` alarm leaves its notice without a turn). Opening the session is enough; no message is needed. The TUI collapses a `wake` row to `◷ alarm fired · <note>` or `◉ monitor matched · <note>`, and a wake tray under the status line lists pending entries from the `wake.pending` request with their cadence and `(notify)` when the fire starts no turn; the model reads the same entries with the `wake.list` tool, in ISO times like the `wake` and `monitor` results (a tool and a request cannot share an id inside one extension). The `wake.dismiss` request cancels one entry by id or dismisses one notice, for a client. Auto-resume is an alarm too, opt-in by the user's own `~/.gent/config.json` only (`{ "wake": { "autoResume": { "maxResumes": 3 } } }`; a project file cannot spend the user's money): a `turnAfter` with `retryAt` (a usage limit that resets within 24 h) stores an alarm with an optional `resume` key (`attempt`, `maxResumes`, `resetAt`, the stopped turn's `messageId`; an earlier binary reads a plain alarm), id `resume:<messageId>:<resetAt>` so a repeated turn end stores one, due 30 s after the reset. The attempt comes from the branch's events (`Session.events` up to the marker): the turns a usage limit stopped (a `streamFailed` receipt after an `ErrorOccurred` with `retryAt`) since the last answered receipt, the current one included; an interrupt, a turn that gave up or another failure neither counts nor starts the count again, so a user's own message that the limit stops is the next attempt, and only an answer resets it. Past `maxResumes` (default 3) the turn stores a `notice` instead. A spawned session stores none: its completion carries the error to its parent. A branch whose newest client message carries `metadata.unattended` (a headless run sends `message.send` with `unattended: true`) stores none either: nobody watches the turn a resume would start, and with no row a later fire or re-arm (the server stays up, or a later process opens the branch) has nothing to run. The branch keeps one resume, the latest turn's: every `turnAfter` drops a pending resume another turn armed, so a message the user sends takes its place. The fire queues its line with `ifLatest: <the stopped turn's opener>`, so the loop admits it and starts its turn in one step under its queue permit, or not at all: a message the user sent or a steer they parked since the stop, a queued follow-up, or a turn that runs takes the resume's place, and no send lands between a read and the queue. The row goes either way. The fire holds the alarms' lifecycle permit, as `wake.dismiss` does, so a dismiss during the fire finds no row and answers `dismissed: []`, and the TUI reports `auto-resume already fired`. A fire more than 10 minutes past due (gent was not running at the reset, or the machine slept) stores a `notice` and starts no turn; else it queues one user message, "The usage limit reset at <ISO>. Continue the task where it stopped.", with `details.resume`. A resume never re-runs the failed step: it appends one message, so the cached prefix holds. The TUI tray shows a pending resume first, before the 3-row cap, as `↻ resume at <clock> · in <countdown> · <attempt>/<max> · esc cancels`, and a resume notice as its note and the reset clock; the fired row reads `↻ resumed after the usage limit reset · attempt N`. Esc on an empty idle composer cancels the pending resume through the wake client's `stoppableContribution`, which sends `wake.dismiss`; any client extension can contribute a stoppable. The status bar shows only `ctx N%`; the messages the projection omitted show on the live window in the `/thread` pane.
- The `bash` tool passes the command unchanged to Bash in both foreground and supervised background modes. Only its explicit `cwd` parameter resolves against the session directory; Bash owns `cd`, expansion, escaping, operators and exit status. The shared process scope still owns the entire process group.
- Background shell jobs (`@gent/exec-tools`, `bash` with `run_in_background`) keep one row each in the `background_bash_jobs` table and run in a process-scoped resource. A finished job queues its terminal notice (`bash:<toolCallId>:complete` or `:failure`, custom type `background-bash`), which wakes the branch. The notice carries the head and tail of the output within `maximumModelToolResultChars`. The output streams whole, from the job's start, to `<data dir>/background-bash/<sessionId>/<branchId>/calls/<digest>.txt`, and a notice that cuts it names that file for the read tool; the filename is the SHA-256 digest of the full JSON-encoded call id, and the separate `calls` directory protects paths earlier builds emitted. Each new claim stores its exact `output_file` pointer in the same transaction as the job, before its file opens. Retries, replay and turn notices use that pointer even when the file is absent; only earlier rows whose pointer is NULL use the sanitized layout. The start stub is the only tool result the call stores, so `context.read` of the call id cannot reach the output. The job rows stay when the session is deleted; its files go (below). The terminal update sets `undelivered_at` atomically with the outcome; accepted follow-up admission clears it. An interruption before admission or a refused send (a full follow-up queue, for one, logged as `exec-tools.background.follow-up.refused`) keeps that pending mark: every step reads the branch's unread undelivered jobs into a `# Background commands finished` turn notice with each outcome and the head and tail of its output (2,000 characters; a cut output names its file the same way; a row from a build before that bound holds more, and its cut names the job's file when the file exists, with nothing written), cleared by `notice_read_at` like an interrupted job. A later accepted send of the same job (the replay of a `Terminal` claim, for one) clears `undelivered_at`, so the model does not get the result twice. A job that cannot finish becomes `interrupted`: its fiber marks the row when it is stopped (server stop, or its resource closed), and a new process marks rows an earlier process left running. Nothing is reattached. A server that crashes runs no finalizer, so a job's process can outlive it: each running job records its pid and its start time (`pid` and `process_start_id`, optional columns; `ps -o lstart=` in the C locale and UTC) beside its output, and before the supervisor takes new work the next process stops each recorded process group (SIGTERM, then SIGKILL after 3 seconds) and marks the job stopped once no process of the group runs: the group of a leader that still has that start time, and the group of a leader that exited while descendants kept its group id (the system reuses no pid that names a live group). A pid that another process now holds is left alone, since its old group is gone. A row with no recorded process (a build before the columns, or a crash before the record) or a group that would not stop is marked as possibly still running, and its notice line says so. An interrupted job wakes nobody: opening a session must not spend a turn with no user present. `turnProjection` (every step) reads the branch's interrupted jobs whose row has no `notice_read_at` into a `# Interrupted background commands` turn notice, which says the jobs stopped before they finished (a server restart or a reload, without naming one), names a job's output file only when the file holds output (else it says no output was saved, or that the job wrote none), and tells the model to report them and to start one again only when the user asks; `turnAfter` sets `notice_read_at` on exactly the jobs in `readNotices`, the ones an answered turn's steps showed, so a failed, interrupted or unanswered turn keeps them. A repeated start of an interrupted call queues nothing. A table from before the column keeps its interrupted jobs unread: the earlier code told a branch only when its loop opened, so a job shows once more at worst and is never lost. Two processes that add the column at once both start: a failed add reads the table again. A session nobody sends to is not told.
- A foreground `bash` call and each `monitor` check run through the same spawn as a background job (`spawnBashCommand` in `packages/extensions/src/exec-tools.ts`), so no command holds its whole output in server memory. Each stream comes back whole up to 262,144 characters; past that the stored result keeps each stream's head and tail around a marker that counts the middle. A foreground call's output then goes whole to its call's file under `<data dir>/background-bash/`, which the result names in `outputFile`, with the length in `outputChars`; the file opens only once the output passes that bound, so a short output never touches the disk. A call that times out or is interrupted returns no pointer and removes its file. `context.read` of the call id pages the stored result, not the file. A monitor check keeps no file: its `until` regex tests the stdout data it kept, never the display text with its marker: the whole stdout, or the head and the tail of a longer one, each apart. The files live under `<data dir>/background-bash/<sessionId>/`; the extension's `sessionDeleted` hook removes that directory for each session a delete removed.
- Persistent goals (`@gent/goal`) live in `<data dir>/goals/<branchId>.json`. After every uninterrupted turn while a goal is active, the goal `turnAfter` hook charges the turn's usage to the goal (a turn that started before the goal existed is charged only its time since the goal's creation, by `turnAfter`'s `startedAtMs`) and queues a `goal-context` user message; a spent token budget flips the goal to `budget_limited` instead. Goal controls answer during a turn. One extension-owned branch permit covers persisted changes and queue admission/removal, so a resume during work replaces its pending continuation at turn end. Pause preserves state and removes pending work; its optional `pausedTurnStartedAtMs` marker charges the turn already in flight once, then disappears. Later unrelated turns leave paused state untouched. Interrupting a turn pauses its goal. Resume retains identity and usage; an exhausted allowance always needs a fresh budget. Clear, cancel and stop remove the goal without completing it. Only the `goal` tool's `complete` action marks it achieved. The TUI collapses `goal-context` rows to one line unless full detail is on.
- Foreground runs persist a child session/branch and can be revisited with `read_session`. Private runs leave no session behind; they return text/usage/tool-call metadata only. `read_session` with `fromMessageId` reads only the branch that holds that message, from it on: a fork's own turns without the history it copied, which its reader already holds. A message the session does not have fails the call.
- grep and monitor share the scoped regex worker in `packages/extensions/src/regex-matcher.ts`: `searchLines` splits grep's file text inside the worker; its caller splits only after the reply to format hits. `searchPieces` searches a monitor's retained stdout pieces apart. The scope owns its worker, Blob URL and pending replies; timeout or cancellation ends CPU-bound matching. A monitor's shell and matcher share its deadline; a matching timeout keeps the command's last output and reports that matching did not complete. JavaScriptCore can give up and report a miss despite a later match. The worker counts a miss taking over 50 ms as undecided, the existing grep contract; this heuristic also counts some real slow misses. A monitor keeps that reason and waits to its deadline instead of treating uncertainty as an ordinary miss. No matching worker is needed when completion depends only on the command's exit code.
- `TurnCompleted` carries the turn's token totals, summed over its model
  steps. It is absent when any step reported no usage or an unusable count,
  when the turn had no step, and on historical receipts. Explicit zero is
  retained. Run results and child completions read usage from that receipt
  and the answer from the branch's last assistant message; nothing scans the
  event log. These are reported stream totals, not model-attempt accounting.

### Turn checkpoints

`@gent/checkpoints` (`packages/extensions/src/checkpoints.ts`) records the
work tree at the start and the end of each turn, so a user can review what a
turn changed and take it back. It sends the model nothing: no tool, no prompt
section, no notice. Core has no checkpoint concept.

- Capture: the start is the first `toolCall` hook of a turn for a tool that
  declares a side effect (not `readonly`), before that call runs. The hook
  always answers `Allow` and only captures; a failed capture is logged, never
  an ask. Calls of one step wait for the same capture (a per-turn memo in a
  process Resource, the capture forked in its scope). A turn that reads only
  or calls no tool captures nothing. The end is the `turnAfter` hook, only for
  a turn with a start. A tree capture catches every writer: the file tools,
  bash, the cell, MCP tools. A recovered turn finds its start ref and captures
  no second one.
- Cost on the gate: a profile whose cwd is outside a git work tree, or in a
  gent workspace copy (its git directory holds the `gent-workspace` marker)
  whose store does not exist, registers no capture hook, so its calls stay
  unjudged. Elsewhere in a git work tree every call is
  judged: a top-level call keeps its `Allow` in memory (stored only in a park
  write that happens anyway), and a cell operation stores it in its operation
  record (one more SQLite transaction per cell operation).
- Who captures: a session that is not spawned always does; a spawned one (a
  delegate child, a `/btw` fork) only where the work tree's store exists, so a
  snapshot child in its own copy pays nothing.
- Store: one private bare git repository per work tree,
  `<data dir>/checkpoints/<16 hex of sha256(realpath of the git top)>/`, with
  a `worktree` file that names the top. gent writes no ref, object or index
  entry into the user's repository, and reads it with no optional lock and no
  `core.fsmonitor` program (the user's config stays for those reads: its
  excludes file decides what git ignores). Every store command runs as
  `--git-dir=<store> --work-tree=<top>` with the quiet git settings, no user
  or system config (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`,
  and no inherited `-c` values), `core.fsync=objects,reference`, no eol or
  filter conversion (`--attr-source` is the empty tree,
  `core.attributesFile=/dev/null`, `GIT_ATTR_NOSYSTEM=1`), and gent's own
  identity. `git init` takes an empty template directory and no
  `GIT_TEMPLATE_DIR`, so no template's hook, config or `info/attributes`
  reaches the store. Every path goes to git NUL-terminated (`-z`,
  `--pathspec-file-nul`) or as an argument after `--`, and comes back
  NUL-terminated: no channel reads a quoted name as a C string. A store write
  holds `FileLock` on `<store>/index`. Captured: tracked and untracked files
  that git does not ignore, and files the user's repository tracks though an
  ignore rule names them; not captured: untracked files over 2 MiB (the commit
  counts them in `Gent-Skipped`) and the files of a nested repository (a
  gitlink).
- Record: the refs are the only record. `refs/checkpoints/<session>/<branch>/<turn>/{start,end}`
  (each part the hex of the id, created only once); the commit trailers carry
  `Gent-Kind`, `Gent-Session`, `Gent-Branch`, `Gent-Turn`, `Gent-At`
  (milliseconds, strictly increasing per store) and `Gent-Skipped`. An end
  commit's parent is its start. A revert's refs are
  `refs/reverts/<session>/<branch>/<request>/{before,target,done}` (see
  Revert). One `for-each-ref` reads the timeline.
- Reads (both `answersDuringTurn`): `checkpoints.list` gives the branch's
  turns newest first (`#1` is the newest; openers are user messages that are
  not runtime rows), each `captured`, `open` or `none` with its
  `diff --shortstat` (one `git log --shortstat` for all); a turn a fork copied
  finds its checkpoints by its `createdAt` up the branch's parents.
  `checkpoints.patch` gives turn `#n` as a git patch (`--binary`, no external
  diff or textconv), cut at 10 MB; a first `#` line names other sessions,
  outside this session's lineage (it and the sessions below it), whose turns
  overlapped it.
- Revert: `checkpoints.revert` (not `answersDuringTurn`, so it waits for the
  branch's turn and holds its side-mutation permit while it writes) takes
  `{ requestId, action, overwrite? }`. `Turn { n, conversation }` takes the
  work tree back to before turn `#n`: the paths that this session's lineage
  changed since that turn's start, each to its content at the start, and
  nothing else. The store's marks since the start cut the time into
  intervals; an interval a lineage span (or a lineage revert) covers is the
  lineage's, one no lineage span covers is someone else's (the user, another
  session, a job left running), and one both cover is both's. A path the
  lineage changed that someone else changed too is a conflict, and so is a
  path to write that is on disk but not in the capture of now (ignored, or
  untracked over 2 MiB). A conflict refuses the revert and names the paths;
  `overwrite` writes them. Another loop that works in the same work tree (a
  top that holds or is held by this one) refuses it too, by name, id and
  status. `conversation` also forks the branch with `Session.forkBranch` at
  the message before the turn (a first turn has none and refuses); the
  answer names the new branch. Each interval's paths count on their own (a
  change and its reversal in two intervals are both seen). The write
  refuses on doubt. Before any record, something in the way refuses, by
  name, and `overwrite` does not pass it: an ancestor of a path to write that
  is a link or a file (git would replace it), a directory where a file goes,
  a special file; an entry the write itself removes first is not in the way.
  The other-loop check runs again under the store lock, just before the
  capture of now. The write is `before` (the capture of now, with each path
  to write as its bytes on disk, hashed into the store with no filter,
  whatever the capture excludes: undo returns all it overwrote), `target`
  (the tree to write, built in a scratch index with no `--replace`; on a
  conversation revert it carries `Gent-Result-Branch`), the files, then
  `done`, under `refs/reverts/<session>/<branch>/<request>/`. The files: on
  a finish, each path must hold its `before` (to write), its `target` (a
  stopped run wrote it), or nothing while `before` holds it (a stop moved it
  aside); any other content is a later edit, and the finish refuses and names
  it. Only the paths not at their target are examined for what stands in the
  way. Each of those holding a file or a link moves aside first, by rename
  in its own directory to `.gent-aside-<16 hex of sha256(request)>-<16 hex of
sha256(path)>`; what moved is hashed into the store, and an aside whose
  bytes `before` lacks moves the `before` ref (old value checked) to a commit
  of the amended tree with the same message, parent the old `before`; only
  then does the aside go. So the bytes the revert takes are the bytes it
  keeps, an edit made after the last check included: the answer names such a
  path in `kept`, and undo returns it. An emptied directory goes by `rmdir`,
  which removes only an empty one. `checkout-index --prefix` writes each path
  the target holds into `.gent-write-<16 hex of sha256(request)>/` at the
  top, and each goes to its path by `link` (a link by `symlink`), which never
  replaces an entry. Then each path must hold its target, or the request
  fails and the revert stays unfinished. Recovery: a stop leaves each aside
  or its bytes in `before`, and maybe the write directory (store copies
  only); a finish or an undo of the unfinished revert first takes each aside
  into `before` by its fixed name and removes the write directory. A writer
  that keeps a file open and writes after the rename writes to the aside, out
  of reach. A repeat by `requestId` answers
  again from its refs, or finishes one a stop cut short after its `target`;
  one with a `before` alone wrote nothing, so its record goes and it runs
  again. `Undo` reverts the newest revert of the branch (or of the revert
  that made it): the paths it wrote, back to its `before`; a path changed
  since its target is a conflict. `Finish` writes an unfinished revert; with
  `overwrite` it writes over later edits too, and its `before` keeps them for
  undo. `checkpoints.list` names the newest revert as `undo`
  (with its file count) once done, or `unfinished` without its `done`. A
  refusal is an answer (`Refused { reason, conflicts }`), not an error.
- Client: `/diff turn [n]` is a target of `@gent/git`'s `/diff` (see the TUI
  extensions). `/revert` (`apps/tui/src/extensions/checkpoints.client.tsx`,
  one of the `builtinClientModules`) is a docked pane over `checkpoints.list`: one row per turn, newest first,
  `#n · prompt · +a -d in k files · 12m` (a narrow row drops the age, then
  cuts the prompt); a turn with no checkpoint says why and cannot be chosen.
  An undo row, or a finish and an undo row for a revert a stop cut short,
  sits on top. `enter` reverts files and conversation and moves the shell to
  the new branch (`shell.switchSession`); `f` reverts files only; after a
  refusal over paths, `o` sends the same request again with `overwrite`.
  Each press is a new `requestId`. The pane refuses at once while the session
  in view runs a turn (`activity` is `working`): the revert would otherwise
  wait for the turn's end with no word. The prompt does not go back to the
  composer: the client facets have no composer verb.
- Retention: a process fiber, started by the first `loopOpen` for a data
  directory, runs a pass a minute later and then daily: it removes a store
  whose work tree is gone, deletes refs whose `Gent-At` is over 30 days old,
  and runs `gc` when it deleted a ref or the store's last collection (the
  `gent-gc` file, epoch ms) is a day old. git's default prune grace (two
  weeks) keeps the objects of a capture that runs at the same time, so a
  collection takes no lock. `sessionDeleted` deletes the session's refs from
  its work tree's store, then collects in the process scope.

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
rule. Session lineage has two edges in one column pair: a spawn edge (a
parent and a new thread) carries authority, and a handoff edge (a parent and
the same thread) carries provenance and its predecessor's bound. Deleting a
session deletes the same way (`deleteSession`, `deletionSet`): the session,
what it spawned and each spawn's own handoffs go. In a root thread (its first
session has no parent, or is gone), a handoff that continues the deleted
session stays, detached from its parent, and its runtime is not stopped: it
is the conversation the user kept. In a spawned thread it goes too: kept, it
would lose its parent and so its parent run's bound, and become an unbounded
root. Child sessions stored before `bded8dce` carry their parent's
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
`Session.send` stamps its own id and removes `fromClient`. A client that no user
watches (the headless runner) sends `message.send` with `unattended: true`; the
server keeps it as `metadata.unattended` beside `fromClient`, and an
extension's `Session.send` removes it with the origin. It changes no ask:
headless answers asks itself. One exception keeps
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
  then the cell's turn-stop watcher sees the close and ends the cell, which
  records nothing, as a crash would; after a restart the request is
  rehydrated, the turn resumes on it (the cell's recover suspends), and an
  answer runs the waiting operation once; the cell then reports its worker
  state as lost
```

**Event-driven UI.** The `@gent/interaction-tools` extension emits typed interaction events (`InteractionPresented` and friends on the session stream) and the client renders those directly. The source of truth is the storage row plus the durable interaction events (`derive-do-not-create-states`).

Key properties:

- **No blocked fiber for a native call.** `WaitingForInteraction` is a cold state — no background turn work. The machine is checkpointed and survives restarts. Only an owned call (a cell's inner call) waits in place, because its dispatcher cannot replay its source.
- **The first answer wins.** `storeResolution` is the one check on a reply. `InteractionStorage.decide` stores only when the row has no answer, and memory keeps the same rule. A retried reply with the same answer succeeds. While the answer is stored and not yet taken, the retry wakes the loop and publishes `InteractionResolved` again, because the first attempt may have failed after the store and the wake is idempotent by request id. After the call took the answer, the retry does nothing (the socket client retries transient errors); a different one fails with `InteractionDecisionConflictError`, so a late approval cannot flip a decline. A reply to a request that closed with no answer is refused. A reply reaches only the branch it names: `InteractionStorage.decide` writes and reads back only that session branch's row, so another branch's request, open or answered, is refused as a mismatch.
- **Crash-safe resume.** `rehydrate()` rebuilds the in-memory context lookup and re-publishes the event. If the process dies before wake, `listOpen()` in `InteractionStorage` provides the open requests for recovery: pending ones, and `taken` ones whose call still keeps the answer.
- **An answer goes to its owner.** The owner of a request is the tool call that asked and the index of that ask in the call's run; the row stores both (`owner_tool_call_id`, `owner_occurrence`, nullable for older rows). A branch shows one request at a time. Other owners queue in the order they asked, and a call that asks the same question never takes another call's answer. A call ends when one of its runs ends without parking. A run that parks continues its call: the answers it kept and the answer to the question it parked on stay for its next run, also when that answer comes before the run ends, so the parked turn finds it and goes on. An answer whose call ends without taking it is settled as abandoned, so the next owner asks. A run's end is one state transition, and it always wakes the calls that wait for their turn. The branch's slot follows the row, and storage keeps at most one pending row per branch: a request that closes (taken, settled, abandoned, or ended with its turn) holds the slot as `closing` until its row stops being pending, and only then can the next call claim the slot and store its row. A storage write that fails is not swallowed: the interaction owner logs it (`interaction.take-failed`, `interaction.resolve-failed`), gives the failure to its caller where one can take it, and keeps the slot as `unsettled`, because the row can still be pending. Any later write that closes that row frees the slot: the cleanup of the call that took the answer, the end of the turn, or the next ask, which writes the row again before it looks again. A dispatching tool's inner call (a cell) waits for the slot while the open request's owner still runs, and is refused when that owner parked; after a crash it resumes by its request id. An answer matches its question as well as its owner; a changed question asks again, for a dispatching owner too. A call keeps the answers it took (row status `taken`) until it ends, so a call that asks twice takes both, also across a restart. Only a tool call the loop runs can ask natively; an ask with no call and no dispatching owner is refused.
- **A request lives no longer than its turn.** A turn that ends without parking settles its open request and its kept answers, and publishes `InteractionResolved` with `dismissed: true` for a dialog nobody answered. A turn its loop stops (a close or the loop scope's teardown, at shutdown) has not ended: the loop marks the stop before it interrupts the turn, and the turn then keeps its requests and their answers for the restart, whatever the shape of its exit's cause. A user's cancel never sets that mark. A cancel sets the turn's interrupt latch even while the loop is parked, and an answer that arrived while a sibling call still ran resumes the turn as soon as it parks.
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
- **No permission rules in core; one hook.** A tool call that asks the user asks once through the durable approval request (`ApprovalService`); the answer is not saved, and a request with no answerer fails closed. Core has no rule schema, no rule storage, and no `permission.*` RPC. It has the `toolCall` hook: before a call runs (a call of the model, or one the cell's code makes, since both go through `ToolRunner.runBound`), every extension's hook gives a `ToolCallVerdict` (`Allow`, `Ask { reason }`, `Deny { reason }`; `domain/capability.ts`). The strictest verdict wins (deny over ask over allow), and a hook that fails answers `Ask`. `Ask` is one approval request through the same `ApprovalService`, so a turn with no answerer (headless without `--approve-all`) declines. A denied or declined call does not run: the model reads a failed tool result that names the reason, and the turn goes on. With no hook the gate reads nothing and the call runs as before: the requests keep their bytes. The gate runs inside the tool's handler, after the input decodes and before the body, so a hook reads the input the body runs with (a field the parameters drop is not there), and a call whose input does not decode fails as before with no judgement. A call is judged once. A top-level call that parks keeps its verdict in its turn record (`PendingToolCall.verdict` and `gate`, both optional); a cell operation keeps them in its operation record. The verdict is stored with its gate `pending` before the call asks or runs, and an approved `Ask` is stored `passed` before the call goes on (and before the tool's own approval asks); a store that fails fails the call, which does not run. A resumed call applies the kept verdict: a `passed` gate does not ask again (the skipped ask keeps its place in the call's count, so the tool's own approval takes its stored answer), and a `pending` `Ask` asks the same question again and takes the stored answer. An absent gate reads as `pending`. A call that was allowed and ran is never run again. The shipped `@gent/guard` (`packages/extensions/src/guard.ts`) holds the rules, and it registers no hook until a config holds a `guard` entry. The shipped `@gent/checkpoints` registers a hook that always answers `Allow` and captures a turn's start, only in a profile whose cwd is in a git work tree (see Turn checkpoints).

Files: `domain/interaction.ts` (InteractionPendingError, makeInteractionService), `runtime/extension-host.ts` (ApprovalService), `storage/storage.ts` (InteractionStorage, the pending read seam), `domain/agent-loop.ts` (WaitingForInteraction), `runtime/agent-loop.ts` (respond orchestration).

## Platform Boundaries

Core runtime should not reach for ambient process state unless the app shell is the real owner.

The Bun cell implementation in `packages/extensions/src/cell.ts` is the shipped model
execution surface. Its extension section registers the `@gent/cell` tool and selects it
through the ordinary `turnProjection` hook. The agent's `tools` patterns are
authoritative (`AgentDefinition.admitsTool`, the one predicate, read by
`compileToolPolicy` and every extension that selects its own tool): the agent
gets exactly the tools they admit, and no extension adds one, so the cell is
the surface only for an agent that admits it; any other agent keeps its own
tools as the model surface. `ToolPolicyFragment.modelSet` narrows
the final admitted host tools for model calls. The last explicit set wins; an
empty set advertises no tools. It cannot restore unknown, denied, or filtered
interactive tools. Without a set, the model receives the admitted tools directly.
The cell extension also renders its catalog through `systemPrompt`, whose
`hostTools` input contains the admitted host bindings' capabilities. `getToolPrompt`
exposes catalog text without the private execution metadata. Projection hooks see
the dispatched agent (config `agents[name]` and run overrides applied) with its
own `driver`; a config `driverOverrides` entry routes the model call only.

Agents are one schema, `AgentDefinition` (`domain/agent.ts`), written two ways:
an extension registers one (`host.register("agent", ...)`), and the config
`agents` key writes one in JSON as an agent patch, the definition's fields
without `name`, all optional (`Struct.omit` of the class fields, not a copy).
A config entry decodes through `AuthoredAgentPatch`, which refuses a key the
schema does not name and names the agent and the key. A turn reads the config
through `ConfigService.getFresh` and does not run while the user or project
file for its cwd does not load (`resolveTurnContext` publishes an
`ErrorOccurred` naming each file and ends the turn, as for an unknown agent):
the stand-in for a failed file (the last user file that loaded, an empty
project file) could drop a `tools` restriction. Config never widens an agent.
Health, providers and the route a client reads keep the lenient read.
`AgentDefinition`'s every authoring constructor (`new`, `make`, `makeEffect`,
`makeOption`) refuses a key the schema does not name (`refusedAgentKeys`).
The roster (`resolveAgentRoster`) is the extension agents with each config
entry of their name applied, plus a new agent for each entry that names none.
A patch replaces the fields it names; `systemPromptAddendum` appends. A field
resolves project entry > user entry > extension (`mergeAgentPatches` in
`mergeConfigs`), and a run's `RunSpec.overrides` (`StoredRunOverrides`, a pick of the patch) wins
over all (`resolveSessionAgent`), so a workspace pins its orchestrator model
under `main` and its children's model under `delegate`, and a `delegate.start`
call can still pick a different model and effort for one child. A run's
`tools` and `paths` do not replace: they narrow (least authority; the
resolved definition is the bound its author set). The bound is a resolution
result, never part of a definition: `resolveSessionAgent` gives the reshaped
definition (routing reads it for the model and driver), and
`bindSessionAgent` gives the `SessionAgent`, a subclass of
`AgentDefinition` that carries a `RunBound` beside the fields: tool pattern
lists a tool must pass, every one, and path scopes, each with the cwd its
entries resolve against, a file tool call must lie in, every one. The lists
are the definition's, the run's, then every parent run's: an ordered pattern
list cannot write the intersection of two others, so they stay apart.
`admitsTool` and `pathScopes()` answer for the run. The turn binds its
dispatch agent (`resolveTurnContext`), and `Session.getAgent` returns the
bound agent, so hooks, `compileToolPolicy` and the file tools all read the
run. No author builds a `SessionAgent`: `AgentDefinition.make` refuses a
`bound` key, and `StoredAgentDefinition` refuses to encode one, so
`driver.list` sends only definitions, and a client that decodes one admits
what the server admits. A child never exceeds its parent run. A spawned
session's bound includes its parent run's whole bound, resolved again at
each turn and each file call (`resolveParentBound`, `resolveSessionBound`
in `extension-host.ts`), not copied at admission: a parent agent narrowed
later narrows its child at the child's next call, and a link retargeted
since admission is judged where it points at the call. A handoff is no spawn
(no depth level), but it runs under its predecessor's parent bound:
`resolveParentBound` climbs the handoff edges to the session that started
the thread and takes that spawn's parent run bound (none for a root thread),
and `admitRun` checks a handoff's named run `paths` against it, as for a
spawn. The handoff keeps its predecessor's admission unless it names one. A
predecessor that cannot be read, or a parent cycle, fails closed. Fail closed: a parent row that cannot be read,
a parent cwd whose config does not load, or a parent agent gone from its
roster is a `ParentBoundError` naming the parent session and agent; a create
of a child is refused with it, the child's turn ends with it as an
`ErrorOccurred`, and `Session.getAgent` fails with it, so a file call fails.
A session's own agent gone from its roster, or a session that cannot be read,
fails the same way: `Session.getAgent` fails with `SessionAgentError` naming
the session and agent, never returns a parent bound alone or no bound, so a
file call in a response that was streaming when the agent left is refused.
`getAgent` has no empty answer: no caller can read an unknown agent as
unbounded. A create that names run `paths` for an agent the roster lacks
(the default one included) is refused (`NotFoundError`).
Authority follows the creating run, not the input: the `ExtensionContext`
`Session.create` takes no `parentSessionId`, and the new session's parent is
always the calling session (`runInfo.sessionId`), so a tool in a bounded run
cannot make a root session or name a wider parent to leave its chain; a
`parentBranchId` of another session is refused (`admitParent`). A client's
`session.create` (the user) still names its parent, and only a client sets
`continueThread`, so only the user makes a handoff. An extension's reach is
its run's: `Session.delete` and the `historyBranchId` of `Session.create`
take only a session in the caller's thread or spawned below it
(`getThreadTree`); any other is refused with `SessionReachError`, so a tool in
a child cannot delete its parent or a sibling, or copy their history.
Session create (`admitRun` in `server.ts`, before the storage transaction)
also refuses, early and by name, a run `paths` entry that an agent scope or
a parent run scope does not reach with at least its access
(`RunPathRefusedError`; a dropped entry would change the run's meaning),
with links resolved at the check (`resolveLinks`, `pathWithin` and
`scopeReaches`, the predicates the file tools use). The stored form does not
change: an old row's `tools`, `paths` or old tool lists narrow when they
resolve. The turn,
`driver.list`, agent admission and the `Session.getAgent` facet all read the
roster the same way. `tools` is ordered patterns over tool ids: `*` matches
any run of characters, dots included; `!` takes tools back; the last match
decides; no match leaves a tool out; no list admits every tool. `paths`
(`{ path, access }`, a bare string a write entry, relative to the session cwd)
confines the shipped file tools: `fs-tools` reads the agent through
`ctx.Session.getAgent()` and refuses a target outside the entries of any of
its `pathScopes()` (`PathScopeError`) after links and `..` resolve, each
scope's entries against that scope's cwd; `read` and `grep` accept any
entry, `write` and `edit` only a write entry. It is not a sandbox: bash and the
cell are not confined. One reader owns the encoded agent (`readStoredPatch`): it
reads config entries (`AuthoredAgentPatch`), `sessions.admission_json`
(`StoredRunOverrides`) and `driver.list` (`StoredAgentDefinition`), with the
keys before `tools` (`allowedTools`, `deniedTools`, `modelId`), and prefers
the new ones. A `deniedTools` list alone keeps an internal
`legacyTools` edit that the merge resolves against the inherited tools (they
minus those ids); an `allowedTools` list alone replaces and keeps the
inherited denials; both replace. An explicit `tools` replaces. A stored row
and a wire reply get the new keys and also the old ones
(`writeStoredPatch`), so the previous gent, SDK and TUI read them the same
way: `model` also as `modelId`, patterns the old lists
can express as those lists, and any other patterns as `allowedTools: []`, so
an old reader holds no tool rather than every tool. `paths` has no old form:
an old reader drops it. A config entry writes back the keys its author used
(`writeAuthoredPatch`), and a config write keeps an unchanged field's raw
JSON, so a config file never gains keys for an older gent. A `delegate.start`
call writes `RunOverrides`, the new keys only: the model-facing schema names
nothing else, and an old or unknown key fails the call with a message that
names the key to use. Stored and wire readers stay tolerant of unknown keys;
authoring is strict: a config entry, `AgentDefinition.make` and
`new AgentDefinition` refuse a key the schema does not name, so TypeScript
that still passes `allowedTools` fails to load rather than run with every tool. Each turn reads the config files as
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
packages it. The worker embeds Bun and needs no external Bun executable. The
compile options of both binaries disable automatic dotenv, bunfig, tsconfig,
and package.json loading: one shared server serves many projects, so the
directory gent starts in sets nothing for it, and the worker inherits the
host's environment. A user who wants a key from a file sets it in the shell
or with `/auth`. Both binaries compile to ESM bytecode, so a start does not parse
the embedded bundle (`bin/gent` 0.41 s to 0.05 s before its first module
runs; the worker 36 ms to 18 ms to its `Ready` frame); the bytecode belongs to
the Bun each binary embeds. The process launcher uses this artifact as both its runtime
and worker path. Turbo caches core's `dist` output and both TUI binaries. The
TUI task hashes its build script. Run the root build for dependency ordering.
This is a packaged worker, not a daemon or a new session owner.
The cell owns where its worker lives: `cellWorkerLaunch` in `cell.ts` selects it
without opening it. The compiled host runs the `gent-cell` beside its real
executable: `GentPlatform.execPath` is the real path, resolved once as the
process starts, so a host launched through an install's link finds its own
version's worker, and a link switched to another version while it runs does
not pair it with that version's worker. A source run
executes this checkout's `src/cell-worker-boundary.ts` with the running Bun, so it
never launches a stale built worker and needs no build first. The two are the
`Compiled` and `Script` cases of `CellWorker`. A script worker starts with
`--config=/dev/null --no-env-file`, the source-run match for the compiled
worker's disabled bunfig and dotenv autoload, so a project preload or `.env`
never runs inside the worker. The worker starts in its session's working
directory: the loop resolves it once per branch with `sessionWorkingDirectory`
(the stored session cwd, else the host's, the same rule as
`ExtensionContext.cwd`) and puts it in the branch's `BranchAddress`, which
the cell kernel Resource reads. The TUI
build names itself with one define, `__GENT_BUILD__` (`{ id, version }`: a
fresh id per build and the version of `apps/tui/package.json`). It has two
readers: `GentPlatform.build` (`Compiled` with the id and version, else
`Source`), by which the cell picks its worker and discovery names the build,
and the builtin extensions, whose artifact identity is `build:<id>`. The CLI's
`--version` reads the same `apps/tui/package.json`, which the bundle carries.
`GENT_COMPILE_TARGET` (a turbo build env input) names the Bun runtime both
compiles embed, such as `bun-linux-x64-baseline`; unset, each embeds the
host's.
The actor section of `runtime/agent-loop.ts` allocates a child of the actor scope for each loop rebuild.
It publishes the loop handle before it transfers scope ownership. Failure or
interruption during construction closes that child immediately. A build that
starts cleanly starts the loop's `loopOpen` activations in the loop scope, after
the recovered turn (if any) started; closing the loop interrupts them. Loops are
lazy: no startup pass rebuilds them, so a session nobody opens runs no
`loopOpen` until a client or another loop reaches it (a snapshot is enough).
A terminated session opens no loop: each operation that would start one
(a submit, a queued follow-up, an extension request, a mutation) checks the
termination marker first and fails with `Session terminated`, and an actor
built for a terminated session skips its eager open. So a send after a delete
or a terminate runs no `loopOpen` hook and builds no branch Resources.
The cell owns its state through two Resources it registers, as any extension
can. `CellStorageResource` (process scope) builds `CellStorage` and the
`RetainedBindings` projection over the session database: it runs the cell's
own migrations, recorded in `cell_migrations`, so its ids never meet core's
chain. Migration `1_cell_tables` creates `cell_executions`,
`cell_tool_operations` and `cell_namespaces` only where they are missing, with
the columns, keys and checks they had as migrations 012-014 of core's chain; a
database from that time keeps those three ids in `gent_storage_migrations`,
and core never reuses them. A database opened earlier without the cell gets
the tables when the cell first loads. `CellKernelResource` (branch scope)
names the storage and reads `BranchAddress`; it builds `CellExecution`, so
each branch owns a separate service and lazy worker, and closing the branch's
generation closes that worker. Its build key holds only the cell's own process
key (`branchResourceKeys`), so an edit to an extension the cell does not read
keeps the worker and its function bindings. The `cell` tool names both, and
its `recover` settles a cell a crash left in flight. Source runs have no
build artifact, so builtin tools carry no durable identity there; cells record a
`ProcessLocal` binding that names the live resource generation instead. Such an
operation resumes only inside that generation and is rejected with
`SourceMismatch` after a restart or replacement. Compiled hosts keep durable
artifact identities. The cell body runs uninterruptibly and forks one watcher
per call on `CurrentTurnStop`: an interrupt cancels the cell, which signals
active evaluation and waits for cleanup, so the result reports what the cancel
cost; a close stops it and records nothing. Cells queued before cancellation
cannot evaluate, and a cell whose turn already stopped (`isStopped`) does not
start.

A cell shows a tool image to the model the way it shows text: an object
tagged `ToolImage` (a `saveToolImage` result, an entry of an MCP result's
`images`) in the value of its last expression or in a `console` output
call's arguments goes to the model as an image after the cell's result. The
worker finds each where the display reads (`shownToolImages` in
`cell-value.ts`): a plain object or an array, own data properties only, at a
depth and position the display shows, so the search runs no cell code. It
sends each image's data fields on the `Evaluated` frame
(`CellEvaluation.images`, additive and optional; a result stored before it
decodes as it was). The host keeps those that decode as a `ToolImage`, with
only the schema's fields, and stores them in the result, so the request
projection sends them as it sends a native tool's image, and the blob store
keeps their files; there is no second image path. An image the cell only
binds, or an inner call returns that the cell does not show, stays out: an
image is paid in every later request of the session (a 1280x800 screenshot
is about 1,400 tokens at Anthropic's `w*h/750`), so only the code decides which images the model needs. A cell result
carries at most 5 (`maximumCellImages`): each image once, the newest shown,
as the last screenshot is the state the cell ended on, and the display names
how many it left out. Five is the smallest per-request bound of a shipped
API class (Chat Completions) and the step at which a request leaves out its
oldest images, so one cell never makes a request drop the images it just
sent. A failed cell carries none. Prime Agent and Codex's `exec` code mode
take an explicit helper (`attach_image`, `image(...)`) because their display
is text; opencode's code mode sends every image a nested call returns
(`PRIOR_ARTS.md`).

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
as they were (`runtime/turn.ts`). A name no extension registers reads the same
failed result: the drivers pass a call to an undeclared name on, and the reply
decodes it with opaque parameters (`patches/README.md`). Tool discovery
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
  executable path, ids, hashing, the image codec, and OS info. Time comes from Effect's `Clock`,
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
cwd, after its variables expand.

A `plugin` entry runs a server that another tool's plugin ships, such as
Codex's computer use, and an update of the plugin needs no edit:

```json
{
  "mcpServers": {
    "computer-use": {
      "plugin": "~/.codex/plugins/cache/openai-bundled/unified-computer-use",
      "server": "cua_repl"
    }
  }
}
```

Each setup reads the entry `server` from the `.mcp.json` in the `plugin`
directory. When that directory has no `.mcp.json`, the entry reads the
version directory that Codex runs (`active_plugin_version` in Codex's
`core-plugin-common/src/installed.rs`): `local` when it is there, else the
newest subdirectory by semantic version (by text when a name is not one).
Only a name of ASCII letters, digits, `.`, `+`, `_` and `-` counts. The file's
servers are its `mcpServers` object, else its top-level object, as Codex and
Claude Code read them. `plugin` expands `${NAME}`, a leading `~` is the home
directory, and a relative path resolves against the session's cwd. The named
server is a `command` or `url` entry and runs as one, with the rules of the
plugin's own tool: `${PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}` expand to the
plugin root (the directory of the `.mcp.json`), and a stdio server gets both
in its environment; a stdio server runs in its `cwd` resolved against the
root, else in the root; and a `command` that starts with `./` or `../`
resolves against that directory. The `enabled` and `timeoutMs` of the `plugin`
entry apply. The entry keys with its plugin root, so a new version lists
again. A missing directory, no `.mcp.json`, a file that is not a JSON object,
no server of that name, or a server entry that does not decode makes the
entry `misconfigured` with the reason, and the other servers still run. gent
reads a plugin only when an entry names it.

Computer use can click and type in any app, so its tools must ask before they
run. A `@gent/guard` rule (see `docs/extensions.md`) in `~/.gent/config.json`
asks before each call of the server's tools, from the model or from the cell;
rules come before the pass for read-only tools:

```json
{ "guard": { "rules": [{ "tool": "mcp.computer-use.*", "effect": "ask" }] } }
```

An MCP image reaches the model as an image on a native call, and through
the cell when the cell shows it: `const shot = await
tools.mcp["computer-use"].js(...); shot` (or `shot.images[0]`, or a
`console.log` of it) sends the screenshot after the cell's result, as the
cell section says. A cell that reads only the text of a result sends no
image.

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
last: a list that differs is written to the cache (under one permit), and a
call to a tool the server no longer lists fails with a message naming the
stale catalog. An empty or failed relist keeps the cached tools. After the
write, the pool reloads the extension (`ctx.Extensions.reload`) in each place
a loop opened in: each loop's `loopOpen` hook hands the pool its place's
reload, and reloads at once when a list since its setup read the cache
already changed it. The reloaded setup registers the cached list, so the next
turn there offers the new tools; only then does the server's state (and
`/mcp`) take the new list. A place with no open loop catches up when a loop
opens there: the open's reload lands after the profile the open resolved, so
that place's first turn may still run on the list it had.

The read-only `mcp.status` host tool and the `/mcp` slash command report each
server's transport, tool count, connection, and health: `healthy` (listed or
connected), `expired` (the server refused the credential; the reason names
`/mcp login`), `logged-out` (the server refused an OAuth entry that has no
stored login; the reason names `/mcp login`), `misconfigured` (the entry cannot run: it does not decode, names an unset variable, or names a plugin server that cannot be read),
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
`content`, `images`, and `omitted`, beside a `note`. An image block the tool
image store takes (`saveToolImage`: PNG, JPEG, GIF or WebP, scaled to fit)
is a `ToolImage` in `images`, so the model sees it after the call's result as
it sees any tool image, and its entry names the `path` of the image's
content-addressed file (`toolImageFile`), which cell code reads; a typed tool returns only its `structuredContent`, so
its images are dropped. `omitted` names each other image, audio, or blob
block with its MIME type and size; the cell never receives the bytes.
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

A start that finds a confirmed server of another build on the database fails with a message that names its pid; it never signals it. `gent server stop` is the explicit way to stop it. The build fingerprint (`buildFingerprint` in `packages/sdk/src/discovery.ts`, read once per start, so the lock entry and the identity endpoint name one build) is `<version>+<build id>` for the compiled gent, wherever it is installed (`GentPlatform.build`, read from the build's `__GENT_BUILD__` define), and the checkout's git hash for a source run. A file's mtime names no build: an archive or a package keeps the mtimes it was packed with, so two versions' binaries can share one. A build neither names is `unknown`, and `unknown` matches no build, itself included: such a start never attaches.

A fixed port (`gent server start --port`) changes only the attach decision. A SQLite server on a fixed port still takes the kernel lock and writes its entry, so the TUI finds and attaches to it; it never attaches to another server itself, and fails with the holder's pid when the database is owned. The standalone server runs until a signal stops it: there is no idle shutdown and no shared launch mode.

`packages/sdk/src/discovery.ts` resolves SQLite-backed clients through this single shared server record. Workspace isolation comes from the `x-gent-workspace-id` RPC header and workspace-prefixed AgentLoop actor entity IDs, not from per-workspace server processes.

E2E coverage that needs process boundaries uses focused server-process fixtures; transport contract tests run through the in-process direct transport.

## Distribution

gent ships as one pair of compiled files, `gent` and `gent-cell`, per platform: `darwin-arm64`, `darwin-x64`, `linux-x64` and `linux-arm64` (glibc). The pair stays together: `gent` starts the cell worker from the directory of its real executable.

- **Release.** `.github/workflows/release.yml` runs on a `v<version>` tag that matches `apps/tui/package.json`. Each platform builds on its own runner, because `bun install` puts only that platform's OpenTUI and fff libraries on disk and the build embeds them; x64 embeds Bun's baseline runtime (`GENT_COMPILE_TARGET`), which runs without AVX2. macOS signs the pair ad hoc. Each runner runs the release smoke, then packs `gent-<platform>.tar.gz`. The last job adds `install.sh`, writes `SHA256SUMS` over the archives and `install.sh`, and drafts the GitHub release; every action is pinned to a full commit SHA; the owner checks the draft and publishes it. https://gent.cvr.im/install.sh serves the latest release's `install.sh`.
- **Release smoke.** `packages/e2e/src/release-smoke.ts <dir>` runs a built pair the way an install runs it: no Bun on `PATH`, no keys, a model catalog address that refuses, a scratch home. It checks `--version` against the manifest and `--help`, reports the median `--version` start, runs a scripted turn whose steps are cells through a link in another directory, loads a user TypeScript extension and one with its own `node_modules`, refuses an import that nothing binds, and proves that the working directory's `.env` sets nothing. `bun run test:e2e` runs it on the local build ("passes the release smoke" in `apps/tui/tests/headless-cli-exit.test.ts`), so each change proves the script.
- **Install.** `curl -fsSL https://gent.cvr.im/install.sh | sh` runs `install.sh` (POSIX `sh`, at the repo root). It refuses Windows and musl, picks the arm64 build under Rosetta, resolves the latest release from the redirect of `<releases>/latest` (or takes `--version`), downloads `gent-<platform>.tar.gz` and `SHA256SUMS` from https://github.com/cevr/gent/releases (`GENT_RELEASES_URL` names a mirror), checks the digest, and runs the new `gent --version` before anything points at it. The layout, under `${XDG_DATA_HOME:-~/.local/share}/gent`, is `versions/<version>/{gent,gent-cell}`, the current link `gent -> versions/<version>/gent`, and `~/.local/bin/gent` linked once to that current link. The current link changes by one rename of a link made under a temporary name. One install at a time holds `<root>/.lock` (a `mkdir` lock directory with the owner's PID; no waiter takes it over, because no check tells a crashed owner from a live one or a reused PID for certain: after 60 seconds a waiter stops nonzero and names the lock, its PID, and that a person removes it when no install runs) from reading the current version through placing, switching and pruning, so two updates never interleave a switch and a prune. A version directory never changes once it is in place: a reinstall reuses a directory whose pair is byte-identical (`cmp`), and puts any other pair under a fresh name, `<version>_<suffix>`, so the directory the current link names is never moved. A running gent keeps the version it started from, because it resolves its real path at start, and marks it in use: a compiled gent in an install writes `<version>/.in-use/<pid>` at start and removes it at exit (`markVersionInUse` in `apps/tui/src/ops.ts`, opened by `apps/tui/src/main.tsx`). Each install keeps the version it places, the one it replaces, and every version with a live marker (`kill -0`), removes stale markers, and removes the other versions. Marker and prune meet in a handshake with no lock at start: prune moves a candidate aside in one rename (`versions/.prune-<version>-<pid>`), looks for markers again, and puts the version back when it finds a live one; a starting gent writes its marker (never recreating a removed directory), then checks that its `gent` and `gent-cell` are still in place, and refuses to start ("this version of gent was removed during start; run gent again") when they are not, or when the marker cannot be written. Either prune sees the marker or the gent sees its pair gone. It adds `~/.local/bin` to `PATH` in the login shell's startup file only when `PATH` lacks it (`--no-modify-path` skips that), and reports another `gent` earlier on `PATH`. `--from <dir>` installs a local pair as `dev-<first 12 hex of the SHA-256 of its gent>`; `bun run install:global` is `install.sh --from bin`, so a dev install and a release install share one layout. Receipts: `apps/tui/tests/install.test.ts`, against a release host on loopback.
- **Upgrade.** `gent upgrade [version]` (`upgradeInstall` in `apps/tui/src/ops.ts`) runs only when asked; gent never checks for a new version at launch. It finds its channel from `GentPlatform.execPath`. Under `<XDG_DATA_HOME>/gent/versions/<version>/gent` it resolves the version (asked for, or the redirect of `<releases>/latest`), downloads that release's `install.sh`, checks it against the release's `SHA256SUMS` like any other asset, and runs it with `sh` (`--version <v> --no-modify-path`, `XDG_DATA_HOME` set to the root's parent, `GENT_RELEASES_URL` set to the release host). `install.sh` is the one owner of placing, switching and pruning; the upgrade keeps no copy of them. The version asked for, or the latest, that the running build already is gives "Already at". Under a `node_modules` tree it changes nothing and names the package manager as the way to upgrade. A source run (`GentPlatform.build` is `Source`) and any other path are refused with the install command. Its last line says that a gent of the old version that still runs keeps its server, so a new launch on the same database fails until that gent closes or `gent server stop` stops it.

## TUI

TUI is a client over the shared contract, not a parallel app.

The session feed uses the durable input-message and step identity for each assistant message. The protocol exports the shared answer-ID rule. Stream chunks update that message only. Tool events locate their owning message by call or assistant ID, including late child results. Historical streams without IDs receive one local ID per stream.

The split region is a canvas: the footer's base (the composer, the status row, and the activity row while it carries content) and the transcript's last rows, the live tail. OpenTUI's split footer draws only its own region buffer (`getSplitPinnedRenderOffset` and the `footerHeight` setter in `@opentui/core` 0.5.14 `renderer.ts`): a region that grows at the terminal's bottom scrolls the rows above it into the terminal's scrollback (OpenTUI, patched, scrolls with line feeds at the screen's last row: its own `CSI S` scroll drops the rows in xterm.js and xterm without saving them), and one that shrinks keeps its top row, so the rows it gave up stay blank. So growing UI never grows the region. The slash suggestions, a docked pane and every other `PickerFrame` dock in the footer and cover the tail's last rows (`NativeTranscript` cuts the tail off at the footer); while one is open the footer's base stays the height it had before (`paneOpen`, from `useDockPaneOpen`), and closing it shows the covered rows again. In a long session the region takes all its rows (`regionMax`, the terminal less two rows), and the tail shows the rows the region holds over the footer's base as it is now. A base that grows (the activity row and the tray row as a turn starts) moves the tail's top rows into history, so no final row hides behind it while the turn runs. A base that shrinks (the activity row going when a turn ends) leaves its rows blank above the tail, under history, until the tail grows into them (the turn's end adds its `Worked for` row), and so does a tail that shrinks after history took its top rows (a tool run that folds into its group row); rows the region holds beyond the tail never sit between the tail and the composer. Blank rows that sit inside an item (history holds its top rows, the tail the rest) and stay for 300 ms replay the transcript (`watchGap`): scrollback takes no row back, and the replay writes the item whole again. The transcript rows above the canvas go to terminal scrollback in transcript order. Only a final item moves, whole or its top rows, while a turn runs too: a streamed answer (a `draft`) waits for the stored answer that replaces it, a queued follow-up and a pending retry wait, and a message waits while one of its calls runs. A tool group is one run of calls across the steps of a turn (`projectToolRuns`; reasoning and blank text pass, answer text, a user message, a session row or an ask end it), drawn at the message that holds its first call: that message waits until the run has ended, and its fingerprint holds the run's calls and the reasoning it took, so a run that grows after history took its top rows replays the transcript. The run takes the reasoning before its first call only from that call's own message, as an earlier message may already be in history. Every block draws at the level of the `ctrl+o` ladder (`DisclosureLevel`: collapsed, one head line and one line a failure; preview, a tree of one line a child; full, the bodies), extension message rows too (`MessageRowProps.disclosure`); a level change replays history, and a block in the live tail (the connection notice) needs none (`apps/tui/AGENTS.md`). The top rows of a final item move when the rest of it still fits (`ScrollbackSurface.commitRows` with a row range; the live view cuts those rows off the item, `partialRows`). Once no turn runs every item is final, so every transcript row is in scrollback or on screen, once. A cut item draws only inside the live view: OpenTUI, patched (`patches/README.md`), crops a box's border to the scissor of the boxes around it, with the box's own geometry and titles, so a prompt that history cuts draws its rail only beside its own rows, not on the rows above the tail. Rows leave the live view only once scrollback has taken them: a write OpenTUI refuses (the geometry changed under it) puts the rows and the region back, and a later pass writes them; so do rows drawn from an item that changed while they settled (`stillOffered`). An item that changes after history took its top rows replays the transcript: history is immutable. A whole item whose highlight does not settle in three tries, and every whole item at exit, commits as plain text (`PlainHistoryContext`: headings without their marks, code and quote bodies as text), never as raw markdown or blank rows. The plain layout has other rows than the live view, so rows of an item the live view shows in part (its top rows, or the rest once history holds them) commit as drawn on the last try and at exit. At the terminal's bottom the region shrinks only by the rows a commit moves into history: the commit shrinks it first, then writes the rows into the space they left. A commit ends on its last row, with no trailing newline: OpenTUI counts the empty row a newline leaves as history, so on a short screen the region would start a row under the rows. A region above the bottom (a short session) has the terminal's own empty rows under it: it shrinks to what it wants, and a tall pane grows it into those rows. Transcript rows keep the terminal's last column free (`FREE_LAST_COLUMN`): OpenTUI writes a committed row and then erases to the line's end, which in a terminal with a pending wrap erases a full-width row's last cell (a table's right border). Answer tables keep a grid, fit their content within the answer and pad each cell by one column (`ANSWER_TABLE`). A return from the alternate screen (the palette, a picker that holds the composer, the expanded transcript) replays nothing: the terminal kept its own screen, and the region takes back the rows it left, so the shell's lines above gent stay. After the return's first frame the region takes the rows the footer and the live tail want; the tail keeps its measure behind the overlay, so a turn that ended behind a picker shows its last rows. OpenTUI, patched (`patches/README.md`), keeps the split's history state for the screen the alternate one covers: a return at the same size takes back the region's row (a short session's top row too) and the column the last history row ends on, so the next commit starts under that row, not over it; and the terminal setup's reserved rows start at the region's top row, so they push no row into scrollback. Unpatched, the return seeds the split from the cursor at column 0: the next commit overwrites the last history row, and a short session's screen goes to scrollback a second time. A replay (a resize, a disclosure change, an item changed in history, `/clear`, a later transcript for another session or branch) writes history again from the top, so its reset clears the terminal's saved lines too (`resetHistory`): scrollback cannot drop some rows and keep others, and the copy it held would show each row twice. Only the first transcript keeps the shell's lines, as nothing of gent is above it. Exit and SIGINT, SIGTERM or SIGHUP leave the terminal the same way (`leaveTerminal`; the renderer is created without its own listener for those signals, `exitSignals`, which would destroy it before the flush): every item the live view still holds commits (over the alternate screen, the palette, a pane that holds the composer or the expanded transcript, the region first takes back the rows it left), a turn in flight as drawn and as plain text (`flushTranscriptForExit`, bounded at 1.5 s), then the renderer is destroyed, which is created with `clearOnShutdown: false`: the destroy clears only the split region, and the turns stay on screen above the shell prompt. An answer's ` ```mermaid ` fence draws as its own markdown block (`useDiagramCodeBlocks` in `apps/tui/src/mermaid.ts`, an OpenTUI code-block renderer with beautiful-mermaid behind it): it draws while the fence streams, each statement once it ends (a newline, or a `;` outside a label), and a source that does not draw shows as its code block. beautiful-mermaid loads on the first fence, not at launch (`DiagramLibraryContext`), and an answer with a fence reaches history only once the load has ended (`diagramsDrawable`): the first fence starts one load, which lands as loaded or failed; a failed load lets the fence land as code. The session feed retains the data for disclosure and resize replay. User messages use an OpenTUI heavy left border, so snapshot layout does not depend on a later height callback. Incremental one-shot output remains separate work.

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

One authoring shape: `defineExtension({ id, setup })`. `setup` is an Effect that yields `ExtensionHost` (`packages/core/src/domain/extension.ts`) and calls `host.register(domain, ...values)` for leaves (`tool`, `request`, `resource`, `agent`, `modelDriver`, `apiClass`, `modelRouter`) and `host.on(kind, handler)` for hooks. Setup-time host facts (`cwd`, `home`, `host`) live on the same service; runtime host authority comes from `yield* ExtensionContext`. The domain string IS the discriminator — TypeScript checks the value type per domain at the call site. Bun loads a user `.ts` extension with no type check, so `register` also checks the domain at run time: an unknown one, such as the bucket name in `register("tools", t)`, fails the load with a message that names it, the near miss, and the domains. The loader (`runtime/extension-host.ts`) provides a collecting host, seals the registrations into `ExtensionContributions`, binds requests to the extension id, and runs `validateExtensionPackage` so malformed registrations fail activation instead of dispatch.

There is no flat `Contribution[]` and no `_kind` discriminator. `ExtensionContributions` (`packages/core/src/domain/extension.ts`) is the compiled record consumed by the registry, hook compiler, and profile build; adding a new kind means adding a registration domain and a record field, not a new union arm. Each extension's process resources build once into their own child of the profile scope, which owns acquisition and release.

- **Resource** — `defineResource({ id, scope, layer })`. Start work runs in the layer build and disposal is a finalizer in it. Long-lived state has a stable identity and explicit `scope`; resources build in extension resolution order. `scope` is `"process"` (built once per profile, released when the profile scope closes) or `"branch"` (built per branch loop, released when the loop closes). Stateful extension logic is either a normal scoped service/resource or, for true actor protocols, an Effect Entity/RPC owner at the runtime boundary. See `packages/core/src/domain/extension.ts` and `buildScopeResources` in `runtime/extension-host.ts`.
- **Callable leaves** — `tool(...)` / `request(...)` smart constructors registered under the `tool` and `request` domains. `tool` = model-facing tool; `request` = typed extension RPC, optionally decorated with `slash: { trigger?, name, description, category?, keybind? }` to surface as a human slash command. Handlers receive input only. Host authority comes from the `ExtensionContext` facade (`Session`, `Interaction`, `FileLock`, `Models`, `State`); files, paths, processes, and ids come from the Effect platform services (`FileSystem`, `Path`, `ChildProcessSpawner`, `Crypto`); extension-private authority comes from extension-owned Effect service Tags. The `FileLock` facet wraps the host-internal `FileLockService`, the `Models` facet the `DecisionModelResolver`, and the `State` facet publishes `ExtensionStateChanged` on `EventStore`, so shipped and external extensions share the same surface. See `packages/core/src/domain/capability.ts`; `runtime/extension-host.ts` compiles the model, RPC, and slash registries. A request that fails answers the client with the extension's own reason as the `ExtensionProtocolError` message (a handler's error message, or `"<extension>" has no request "<id>"`), with no loop or runtime wrapper; the TUI shows a failed slash command as `/<name> failed: <reason>` on the status row.
- **Addressed session verbs** — `ExtensionContext.Session` reaches other branches through the same verbs the server uses: `create` (durable-once by `requestId`, optional `historyBranchId` copies the visible rows in, depth admitted by the host), `forkBranch` (a branch of the run's own session that holds the messages up to `atMessageId`, the rewind the client's `branch.fork` makes, over the same `SessionMutations.forkSessionBranch`; durable-once by `requestId`; the old branch keeps every message and the active branch does not move), `send` (one user message with a `delivery` mode: `"turn"` starts a turn on another branch with the loop `completion` modes, and the own branch refuses it and points at `"queue"`; `"queue"` is a follow-up keyed by `sourceId`, and with `ifLatest: <messageId>` a conditional one: `LoopInbox.admit` admits it only while the loop can start a turn, its queue is empty (no parked steer, follow-up or item in flight) and that id is still the branch's newest step (`latestStep`: the newest user-role message that is not a runtime row or a joined steer), and then reserves the start at once (`admitAndBegin` on the own branch, so a caller that holds the side-mutation permit does not wait for the start), all under the queue permit; the same transaction stores the item in the queue's in-flight slot, because an accepted line is a promise: the caller may forget its own record (`@gent/wake` drops its alarm row) as soon as `send` returns, so a restart before the turn stores its message runs the item once from that slot (`wantsWakeOnRecovery`, or `incompleteUserTurn` once the message is stored), with no new test of `ifLatest`, and the turn clears the slot when it stores the message; otherwise it admits nothing, as a repeat does; `"steer"` joins the running turn as an `Interject`), `stop` (writes a `Cancel` steer that stops the running turn, whichever message opened it; `Interrupt` has no writer and only decodes), `stopMessage` (the persisted `StopMessage` actor operation, through `stopMessageOn`: it records the durable cancellation of one message id, so a turn that message opens later starts interrupted, takes back a steer with that id that no step has read, and interrupts the running turn that message opened. A step's join of steers and the take-back hold the same queue permit, so a message is either joined or taken back, never both. It answers true only when this stop reached the message; false when the loop no longer holds it (its turn ended, or a step joined it into a turn another message opened, which runs on) or an earlier interrupt already stops its turn. A steer taken back answers true, unless an earlier stop from the same requesting branch already stops the turn the steer waited to join: the turn's latch records the requester of its first stop, and that stop's caller already reports the branch. A stop that reaches a running turn also takes back, under the interrupt permit, every waiting steer its own requesting branch sent (the `sender` a loop records on a steer into another branch's `Steer` operation and queue item, never a client): the turn's end cannot hand such a steer on as the next turn, so a later stop of that steer reaches nothing and the branch is reported once, however late that stop comes. A `Cancel` steer that names a `messageId` still decodes and runs the same routine), `events` (replay, then the `StreamSynchronized` marker, then live; `from: "now"` skips the replay and starts at the newest stored event), `delete` (cascade), `dequeueFollowUp`, and `holdResident` (a scoped hold that keeps the own branch's loop resident; see Residency). `send` and `stop` are a facade over the unchanged actor operations `SubmitDurable`, `QueueFollowUp`, and `Steer`, except that a `queue` or `steer` into the loop's own branch is admitted re-entrantly inside the caller: a client request's grant is read at admission, while the request provably runs, and a send from a context kept past it is an extension send; the raw `SteerCommand` stays on the RPC contract, not in the extension API. The bodies live in the `agent-loop.client` section of `packages/core/src/domain/agent-loop.ts`; The loop's `sessionControl` calls the queue bodies (`queueFollowUpOn`, `dequeueFollowUpOn`), and both `SessionRuntime` and `sessionControl` call `submitUserMessage` and `steerLoop`, so the facade and the RPC path cannot drift. The verbs are uniform: no extension, shipped or not, holds a grant another lacks. `AgentDefinition.maxModelAttempts` (and the RunSpec override) is the generic per-turn model-attempt budget, reserved durably per turn message id.
- **Hooks** — `host.on("systemPrompt" | "turnProjection" | "turnAfter" | "loopOpen" | "sessionDeleted" | "toolCall", handler)` registers the six runtime hooks; each kind is typed by `ExtensionHookSignatures`. `loopOpen` takes no input and runs once for each activation of its extension in a branch's loop: when the loop is built in this process (the first operation after a restart, or after the loop closed), after the loop resumed any turn a restart cut short; for an extension with branch Resources, again for each new generation of them (an edit, or a disable and enable, builds one), once no older generation of it is alive; for one without, again when it rejoins the loop's newest profile after a profile left it out. The loop is the one owner of activation (the activation section of `runtime/agent-loop.ts`): one activation at a time resolves the newest profile and claims what is due, so state a hook restores into the branch Resources (wake's timers) is restored once, into the generation that keeps it. It is where an extension repairs what a previous process left on the branch: re-arm timers, resume children, report lost work. It runs as the loop's own fiber, with the branch Resources and a non-client opener (it cannot ask). Nothing in it takes the side-mutation permit, which a running turn holds: the profile resolves under the profile cache's place lock and the Resources build under the branch's own lock, so the hooks run beside a turn the open resumed. Each extension's hooks run on a fiber of their own, which holds the profile they read and none of the activation's generations: an extension with branch Resources runs them in the scope of the generation they activated, so they stop when that generation retires, before its Resources release; one without runs them in the loop's scope. So a hook that never returns delays no turn, no other hook, and no other extension's next generation. A follow-up it queues on its own branch starts a turn like any other send, and the operation that opened the loop never waits on it. User extensions register it the same way. `sessionDeleted` runs once for each session a delete removed (`SessionMutations.deleteSessionCascade`: the session and the descendants it spawned; a handoff that continues its thread stays and is not named), after the rows are gone, with that `sessionId`. Each session is heard under the profile of its own cwd, resolved before the delete, so a descendant in another cwd reaches that cwd's extensions; a descendant created after the delete collected its tree is heard under the deleted session's profile. The host context names that session and has a non-client opener. Each extension's handler runs on its own fiber; a failure is logged (`extension.hook.handler.failed`). The delete waits for each handler up to `SESSION_DELETED_HOOK_TIMEOUT` (30 s); a handler past it is interrupted and logged (`extension.hook.session-deleted.timeout`), so a handler that never returns does not hold the delete once the rows are gone. An extension removes there what it keeps for a session outside the database. Hooks, tools, and requests all cross one membrane: `provideExtensionLeaf(frame)` in `runtime/extension-host.ts` reads the run's `CurrentExtensionHostContext` and provides `ExtensionContext`; `turnProjection` receives the agent the turn dispatches (`TurnProjectionInput`). Hook handlers receive event input only and yield `ExtensionContext` or extension-owned service Tags when they need authority. `turnAfter` carries `usage: { known, complete }`: the tokens of the steps that reported usable counts, and whether that is the whole turn (`TurnCompleted.usage` carries a total only when it is complete). A turn a usage limit failed carries `retryAt`, the epoch time the driver says the limit resets (Some only past the retry policy's `maxDelay`, for a turn that was not interrupted; the same time as the turn's `ErrorOccurred.retryAt`). `toolCall` runs in `ToolRunner.runBound` before each call's body, with the call's address (`sessionId`, `branchId`, the turn's opening `messageId`, `toolCallId`, `parentToolCallId` for a call the cell makes), the agent, the tool id, its `readonly` flag and the input; every extension's hook runs at once and the strictest `ToolCallVerdict` wins (see "No permission rules in core; one hook"). See `packages/core/src/domain/extension.ts` and `runtime/extension-host.ts`.
- **Model catalog** — models.dev is the catalog, and core reads it. The owner's direction (Pass 30) replaces the rule that core fetches nothing: "models.dev is integral to discovery of models via providers so we don't really need to hardcode anything, only limiting factor is classes of api's we support", and "snapshotting will be good so we don't constantly ping … we can put that in our sqlite db". `ModelCatalogSource` (`packages/core/src/runtime/provider.ts`, model catalog source section) keeps the two sources, `api.json` (chat models) and `api.json?type=decision` (decision models), as served in the `model_catalog_snapshots` table with their ETags. A read answers from the snapshot at once; a snapshot checked more than an hour ago starts one background `If-None-Match` revalidation (a 304 moves `checked_at` only); only a first read with no row waits on a fetch (10 s). The two sources load apart: `read` waits only for the chat source, so a stored chat snapshot serves a turn or a model list at once while a decision source with no row is fetched; `readWithDecisions` waits for both, and the classifier listing and a turn model the chat catalog does not list read it, so a classifier still runs no turn. There is no bundled snapshot: an offline first start has no catalog, says so, and tries again a minute later. A scripted model (`--debug`, `server start --mock`) runs on `ModelRegistry.Scripted`: the catalog's entry when there is one, else an entry made up from the id with a 1M window, so a scripted turn runs with no catalog. `GENT_MODEL_CATALOG_URL` names a mirror; the test preload points it at a closed local port and refuses every request or connection to a host other than this machine, and a spawned test child reads the fixture from `serveModelCatalogFixture` (`@gent/core/test-utils`). A driver or API class never fetches the catalog: core hands each leaf the entry it needs as input.
- **API class** — the `apiClass` domain takes an `ApiClassContribution` (`packages/core/src/domain/driver.ts`): one wire protocol, named by the models.dev AI SDK packages (`npm`) and `provider.shape` values (`protocols`) it speaks. It turns a catalog entry plus an endpoint (`apiKey`, `baseUrl`, `transformClient`) into an Effect AI model and plans effort, thinking and sampling from the entry's `reasoningOptions` and `temperature`, so one model on two providers gets one request shape. Only the first-party Anthropic and OpenAI drivers carry an effort change inside the conversation (rule 11); the Messages and Responses classes a gateway composes send the plain request, because no gateway names a receipt that it passes the carrier on. Core picks a model's class by its protocol, then its package (`apiClassFor`); a model no class speaks is not listed and does not resolve. The shipped classes are Messages (`@ai-sdk/anthropic`, `packages/extensions/src/anthropic.ts`), Responses (`@ai-sdk/openai`, `openai.ts`) and Chat Completions (`@ai-sdk/openai-compatible`, `providers.ts`).
- **Generic providers** — a models.dev provider that no driver covers (by id or `catalogProvider`), that `disabledProviders` does not name, and whose models some class speaks with tool calling is served with no driver (`runtime/provider.ts`, generic providers section). It is active when it has a stored key, a key env variable from its `env` list, or a config entry; only active providers list their models and show in `/auth`, and the `/auth` search (`auth.listCatalogProviders`) finds the rest. Its sign-in is one API key method; each `${VAR}` in its base URL becomes a prompt, answered from the stored metadata, else the env variable, else a `ProviderAuthError` naming the variable. A variable that begins the URL (Neon's `${NEON_AI_GATEWAY_BASE_URL}/v1`) holds the origin: an absolute https URL with no user, password, query or fragment (no `?` or `#` at all, since URL parsing reads a bare one as empty), kept as typed. Any other variable fills one host label or path segment, percent-encoded and never `.` or `..`, so its value cannot move the key to a host or path the catalog and the user did not type; a filled URL that does not parse, or names a user, fails. The sign-in (`storeSignIn`) applies the same rule (`filledBaseUrl`) to the answers it would store and refuses them with the turn's message; a variable with no answer and no env variable is left to the listing's `missing`. Config `providers.<id>` patches or adds a catalog provider: `name`, `api`, `env`, `headers` (sent on every request), `class` (forces the class) and `models.<id>` (merged field by field into the entry). The registry reads the config fresh on each call (`ExtensionRegistryService.providerConfig`). A generic provider is not a driver: `driver.set` does not take it, and its failures have no owning extension in health.
- **Driver** — the `modelDriver` domain takes a `ModelDriverContribution`: the adapter of one models.dev provider (`catalogProvider`, else its id), naming only what models.dev lacks — auth, an `endpoint`, `overrides` where models.dev is wrong (each with a receipt: Claude Sonnet 4.5's window is 200k, `anthropic.ts`; `gpt-6.1-sol` accepts the `none` effort, `openai.ts`), `aliases` for model names it shipped before models.dev named the model (core resolves one, for a turn's model metadata and its dispatch alike and for `models.decide`, as the name it stands for, through one function, `currentModelName` in `runtime/provider.ts`; lists show only the current names; an alias that equals a name the driver's catalog view lists is ignored, so the real model wins) — and keeping `listModels` or `resolveModel` only when its requests need more than an endpoint (an OAuth reply rewrite, or a model its catalog provider does not list). With no `listModels`, core lists the provider's models a class speaks; with an `endpoint` and no `resolveModel`, core composes the entry, the class and the endpoint. A decision model of the catalog provider runs no turn on either path. The OpenCode driver (`packages/extensions/src/opencode.ts`, ids `opencode` for Zen and `opencode-go` for Go) serves each model on the class its entry names (OpenAI Responses, Anthropic Messages or Chat Completions). The Cloudflare driver (`packages/extensions/src/cloudflare.ts`, id `cloudflare`) sends Chat Completions to Cloudflare's REST API at `https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1` with one Cloudflare API token (`CLOUDFLARE_API_TOKEN` or the stored key); its sign-in asks the account id and an optional AI Gateway id (prompts, env `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_GATEWAY_ID`), and a set gateway id goes on every request as `cf-aig-gateway-id`. It takes a model id as given (`@cf/...` Workers AI models, `author/model` gateway models), reading the models.dev `cloudflare-workers-ai` entry, else the `cloudflare-ai-gateway` entry, for the model's facts, and lists the models.dev `cloudflare-workers-ai` models under its own id, then its Clef classifier models from the models.dev decision list (`cloudflare/@cf/cloudflare/clef`, `cloudflare/@cf/cloudflare/clef-flash`, decision only: chat refuses them; the ids it shipped before, `cloudflare/clef` and `cloudflare/clef-flash`, are aliases of them); a missing account id fails naming `CLOUDFLARE_ACCOUNT_ID` and `/auth`. Every Responses request (the OpenAI driver on both sign-ins, and OpenCode's Responses models) asks for low text verbosity on a model that takes one, as Codex and opencode do (`takesLowVerbosity`, `packages/extensions/src/providers.ts`). A driver may use another driver's sign-in (`credentialFrom`, one hop): core hands it the owner's stored credential, `/auth` lists one row for both and hides the sharer's own methods, and signing out removes the owner's key and any key stored under the sharing driver's own id, which also serves both while the owner has none. A driver naming a sharing driver (a chain or a cycle), or one the profile lacks, keeps its own sign-in. Each driver still falls back to its own env variable, and a row is ready from env only when every driver that needs it has its variable set (`runtime/provider.ts`, shared sign-in section). OpenCode is one sign-in, "OpenCode", stored under `opencode`: one key serves Zen, Go and Go Plus, so the Go driver names `credentialFrom: "opencode"`, keeping its own key method for a profile without Zen; the two catalogs and their model ids stay apart. An API sign-in method may ask `prompts` after the key (`AuthPrompt`: `key`, `label`, `placeholder`, `env`, `optional`), such as an account id: `/auth` asks each in turn on the key line (Esc steps back one field) and `auth.setKey` stores the answers with the key in one record (`metadata`, an additive optional field of the stored `Api` credential and of `ProviderAuthInfo.Api`). `auth.listMethods` leaves out a prompt whose `env` variable is set, and the driver reads the variable when the stored key has no answer. A driver's API methods are alternatives, and a stored key does not name its method: a credential (stored or from env) is ready when one API method has an answer or a set variable for each prompt that is not `optional`. Otherwise it is not ready: `auth.listProviders` reports `hasKey: false` with the unanswered prompt labels of the closest method in `missing`, and `/auth` draws the row as `[api] needs Account ID` (Cloudflare's gateway prompt is `optional`). An agent's `driver` (or a `driverOverrides` config entry) names a model driver; a stored override that names a removed external (ACP) driver decodes as no override and logs one warning per config file. See `packages/core/src/domain/driver.ts`, `domain/agent.ts`, and `runtime/extension-host.ts`.

- **Credential slots** — auth keeps the legacy default file/body unchanged and stores named labels under `.slots/<encoded-provider>/<label>` (runtime/provider.ts). CredentialSlot is a constrained nonsecret label (domain/driver.ts); omitted slots mean default. All labels share the existing provider semaphore and cross-process lock. One-hop credential owners and legacy aliases are looked up per label; a refresh closes over the physical key and label, and sign-out removes only that label through aliases. providers.<id>.authOrder is optional, nonempty and distinct; conflicting alias orders fail at the provider boundary. This checkpoint validates orders but does not activate automatic recovery. RPC authorization holds its original method-provider, credential owner, label, inputs and persistence closure through its profile lease; missing leases fail closed. OAuth methods can ask provider-owned prompts. AuthMethod.credentialTarget optionally limits a method to default or named credentials; omission preserves either target. The authorization owner checks the immutable label, and the current default /auth picker filters indexed choices without changing their original RPC positions. Anthropic's named directory import reads only the explicit absolute directory's .credentials.json and stores a one-time Gent-owned copy; later Claude Code rotation can require reimport. Its named refresh uses the selected store entry and direct OAuth only, never a primary keychain/source reread or the legacy paid CLI refresh. The default Claude Code path retains that legacy behavior. Existing profile-local Anthropic/OpenAI credential cells and OpenAI account-bound reasoning state are partitioned by label. Auth summaries expose labels, auth type, source and availability, never token or directory data. Receipts: core/tests/runtime/provider.test.ts, core/tests/server/rpc.test.ts and extensions/tests/{anthropic,openai}.test.ts.

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
- Process and branch Resources build through one builder,
  `buildScopeResources` in `runtime/extension-host.ts`: extension by
  extension in resolution order, each in its own child scope. Every build
  reads the host's services (`ResourceHostServices`: the extension
  platform, the session database's `SqlClient` and `InteractionStorage`),
  given by value in the profile cache's build context. A process build runs
  over the process Resources the extensions before it built too. A branch
  build reads only its `BranchAddress` (session, branch, cwd, home) and the
  process Resources of its own extension it names
  (`defineResource({ resources })`, `branchBuildContext`); `defineResource`
  bounds the layer's requirements to these, so a build that reads anything
  else does not compile. A layer that fails to build closes
  what it acquired, is logged naming its extension
  (`extension.resource.failed`), and leaves every other extension's Resources
  live. A process Resource that fails rejects its extension: the profile
  reports it failed at the `startup` phase. Branch resources follow the
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
- Loader (`apps/tui/src/extensions/loader-boundary.ts`) reads the place of the session in view on each load and each look (`sessionPlace`): the project directory and the configs' `disabledExtensions` of that session's cwd, resolved as the server resolves it (`ClientWorkspace.sessionCwd`), so the client loads the project the server loads and the configs the `/extensions` pane writes, whatever directory the TUI was launched in. It filters extensions by id before `setup` runs
- One loader per provider (`makeTuiExtensionLoader`) keeps the live set between loads (C7). Each file builds through the server's coherent build (`buildExtensionModule`, with the client bundler and its own `ModuleGraphs`): a load keeps an extension whose file and the files its build read have their last stats (`fileVersion`), or whose new build is the same code (the version is the built code's sha256; the client names bind under one prefix per loader, so the same files build the same text); it sets up a changed one from its new version and ends the old one's lifetime; it ends the lifetime of a removed or disabled one. A new version that does not build, import or set up keeps the last good one, and the failure (`…; version <12 hex> still runs`) joins the failures. The last good one runs on only under its own id: a new version with another id that fails setup brings it back only while its id is not disabled and no other extension of the load holds that id in its scope (`mayRunOn`). A version that failed to import or set up is not imported again: its failure stands over every load (`FailedAttempt`) until the file builds to another version, is removed, or its id is disabled; a disabled id's failure is not reported, also for an extension that never set up. A failed build runs again on each load, so its failure stands the same way. The host shows the new set first and ends the replaced lifetimes after. A kept extension hands back the same widget components, and the host keys its widgets on the component, so a reload leaves them mounted with their state. It loads again when the shell asks (`shell.reloadExtensions`, the `/extensions` pane's `r`) and at each `TurnCompleted` of the session in view when a look at the stats finds a client file added, removed or saved, or another disabled list (`stale`), and on a move to a session in another directory: the turn's end is when the server applies a changed file too. One look runs at a time.
- Client extensions author against one public entry, `@gent/tui/extensions` (`apps/tui/src/extensions.ts`): `defineClientExtension`, `ClientContext`, the contribution constructors, `sessionQuery` and the rendering kit. A shipped `*.client.tsx` imports the TUI only through that entry.
- One `setup` shape: `Effect<ClientContributions, never, R>`. A setup handles its own failures; a defect is recorded as a load failure. A returned key that is no contribution bucket, or a bucket whose entries lack what the host reads (`CONTRIBUTION_BUCKETS` in `client-facets.ts`), fails that extension by name before the host resolves every extension together, so the healthy ones keep their contributions. The loader reads each known bucket of a setup's result once by property access (a class instance's getter counts), inside that extension's failure, where any throw, a defect included, fails only that extension, and decodes it to new plain data; the shared resolution never reads the extension's own object. Setups yield from the per-provider `clientRuntime`, which provides `FileSystem | Path | ChildProcessSpawner | ClientContext`: every client extension, shipped or not, reaches files, paths and processes as a server extension does (rule 15), and runs a command through `runProcess`. `ClientContext` is the client twin of `ExtensionContext`: one Tag with the `transport`, `shell`, `workspace`, `lifecycle`, and `activity` facets, which a setup yields (`const { transport, shell } = yield* ClientContext`) and never threads as a parameter. There is no imperative `ctx` argument, no sync `(ctx) => Array` arm, and no package wrapper around paired server/client modules: a server extension and its `.client.{ts,tsx}` module are separate artifacts that share an extension id.
- `shell.handover(effect)` hands the terminal to a program that draws on it (a diff viewer, an editor): the renderer suspends, the effect runs, and the renderer resumes when the effect ends, however it ends. The host's own editor (ctrl+g, Edit in a review prompt) runs through the same verb, and one semaphore holds it, so two programs never draw at once and the renderer never resumes under a program still running (`makeHandover` in `apps/tui/src/os.ts`). The terminal's signal keys go to the program, as for a program a shell runs: every process the effect spawns joins gent's process group, the terminal's foreground group (`detached: false`; the spawner's default puts a child in a session of its own, where ctrl+c never reaches it), and gent takes its SIGINT and SIGQUIT listeners off until the terminal is back, as POSIX `system()` and git's editor launch ignore those two. The process runs a signal's listeners later than it takes the signal, in the order the signals came, so a ctrl+c the program ended on may still wait when its end is seen: before gent's listeners and the renderer's go back, the handover sends itself SIGURG (ignored by default, heard by nothing else) and waits up to 1 s for it, which runs after every signal before it. The listeners are held inside the suspended span, so the renderer's own (OpenTUI's ctrl+\ exit listener, which suspend takes off and resume puts back) never hear that mark or go on twice. A wrapper that relays signals to gent (a `timeout`, a script runner) can still deliver one after the mark. Ctrl+z keeps its default, so the shell stops gent and the program together and `fg` resumes both. In gent's group a child has no group of its own, so the spawner's group kill reaches only that child: an interrupt stops each process the effect spawned (SIGTERM, then SIGKILL after its `forceKillAfter`) and waits for it, and a process that child started lives on. A handover therefore spawns every program it runs itself, the pager pipeline of `@gent/git` included. The handover runs in a fiber of the holder's own scope, not of its caller (a command or a key runs on a fiber gent's exit does not reach); interrupting the caller interrupts it too. The root makes the holder with the renderer (`main.tsx`) and hands its verb to `ExtensionUIProvider`; gent's exit, on SIGTERM, SIGHUP, SIGINT outside a handover or the reader's quit, closes the holder before it leaves the terminal (`holdUntilRendererDestroyed`): every handover is interrupted and awaited, its programs stopped and its renderer resumed, so no program outlives gent on a terminal that stays open, and the live view moves into history from a running renderer (a renderer destroyed while suspended writes `[snapshot WxH]` placeholders in place of the rows).
- Widgets are transport-only: subscribe to `transport.onSessionEvent` for event-backed invalidation or `transport.onExtensionStateChanged` for explicit extension-state notifications, then call typed extension RPC via `transport.request` for current state. Each widget owns its own Solid signal, keyed on `(sessionId, branchId)` so a stale model from the prior session never renders. See `apps/tui/src/extensions/builtins.tsx` for the canonical pattern.
- `lifecycle` is the extension's own lifetime: the loader forks one scope per extension from the client runtime's scope and provides a `ClientContext` with that lifecycle around the setup. `lifecycle.addCleanup` registers Solid `createRoot(dispose)` disposers and event unsubscribes; they run in order when a reload replaces or removes the extension, or when the provider unmounts, so widget setups leave no detached roots behind. A cleanup registered after the lifetime ended runs at once.
- `lifecycle.scoped` allocates Effect resources in the extension's lifetime; they are released after its cleanups ran. The main TUI scope awaits provider disposal before process exit.
- `activity.snapshot` exposes the focused UI session's working, blocked, idle, or unavailable state. A surface with no activity to report reads `"unknown"`. Any client extension may add a reactive snapshot with `activity.include(readSnapshot)` and register its returned cleanup with its own `lifecycle.addCleanup`. A known ask wins over work: focused blocked stays blocked, and matching-session blocked activity promotes idle, working or unknown focus to blocked. Without a known ask, working and unknown focus stay unchanged; idle derives working, then unknown. The agents controller contributes the current thread's transitive descendants, including children of handoff members, from its complete listings. Both the server thread fold and descendant reader retain waiting before working, then unknown live status before idle. The controller owns initial and identity-change reads without a tray, and its existing clock retries missing knowledge until a complete inactive or empty result stops polling. A filtered pane adds one unfiltered subtree read on the same coalesced request and 2-second clock; unfiltered listings serve both views. Missing live status, a failed read and a session or branch switch report unknown, never a stale idle.
- `@gent/herdr` is a built-in client extension. It reports that UI activity through Herdr's local socket when `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID` are present. It sends ordered reports with the session ID and releases its authority on exit. The shared server and child agents do not own this reporter.
- `useExtensionUI()` (`extensions/host.tsx`) is host-side, not extension API: the shell reads the resolved contributions, load failures and `clientRuntime` through it. A widget reads the active session from `transport.currentSession()` or `sessionQuery`.
- Widgets are zero-prop components that self-source from context hooks.
- A throw from extension code the view runs while it draws fails only that extension (`extensions/host.tsx`): each widget renders inside `ExtensionRenderBoundary`, and the host hands out each tool, message and interaction renderer already inside it; each status label's `produce`, notice row source, message `prompt` and message `queueLabel` runs inside `Effect.try`. An autocomplete source's `onOpen` and `items` run inside one cause catch (`runAutocompleteContributions` in `extensions/loader-boundary.ts`): a typed failure of its `items` Effect is one log line and the source stays offered, and a throw or a defect fails its extension like a render throw. The host records `render failed: <reason>` against the extension id, lists it with the failed extensions, drops its widgets, labels, notice rows, renderers and autocomplete sources, and the view stays. A dropped renderer gives its place to the host's own: the default tool row, the runtime's or the plain message row, and `PromptRenderer`, which still answers the ask. The render-throw table in `apps/tui/tests/app.test.tsx` names a case for each contribution bucket, so a new bucket does not compile until it has one.
- An extension draws its own transcript rows with `messageRendererContribution`, keyed by the message's `metadata.customType`. The core transcript names only the runtime's own kinds and falls back to the plain row. Its `queueLabel` names a waiting message of that type in the queue widget (a queue entry carries its message's `metadata`); without one the widget shows the message's first line, and a restore takes the text either way.
- A row that is not a message comes from `noticeRowContribution`: the extension derives it per branch from `transport.onSessionEvent`, and the session view merges it into the transcript by time. Nothing stores it and the model never reads it. The session feed opens without waiting for client extensions; the client keeps what the feed delivered on the branch and hands it to a subscriber that joins late before the live envelopes, so each one sees the branch from its first event. A reconnect repeats envelope ids, which the subscriber skips. A source answers `None` until it can say its rows, and native history commits nothing until every source answers, so a committed row never changes. History holds for a source only 5 s after the client extensions loaded, so a source that never answers cannot hold it for good; after that, history commits without the source. The source is not a failure and stays: a later answer draws its rows among those history has not yet committed.
- `@gent/interaction-tools` (`interaction-tools.client.tsx`) draws the asks of the interaction tools by `metadata.type`: `prompt`, `ask-user` and `handoff`. The ask-user metadata and answer schemas belong to the server extension and come through `@gent/extensions/client`; they check shape only, so a question stored before a call limit still shows its choices. The host keeps the option list and the prompt renderer, its fallback for any other type. The option list reads its free-text row through its keyboard scope (`typedKey`, a paste, and `caretLineEdit` in `ui.tsx`: the `lineEdit` erase keys at the caret, left/right, home/end, delete and ctrl+k as the composer's textarea binds them), so typed text from any row is the free answer and the list works docked under a composer that keeps the focus; a line wider than the row scrolls so the caret stays in view (`caretWindow`); in a `PickerFrame` it fits the rows the frame gives it and leaves the title and key hints to the frame. The extension also draws the background questions of `ask_user_async`: a tray line in the `below-input` slot (`? 1 open question · <label> · assuming <assume> · /answer`; optional parts drop at narrow widths; it hides while a pane is open), read from `questions.open` on a session move, a finished `ask_user_async` call, a message, a turn end and the extension's pulse. `/answer` docks a pane that asks the oldest open question with the option list and the `ask_user` keys: the cursor starts on the assumed option (or on the assumption as its own first row), enter answers, typed text is a free answer, `ctrl+x` arms and a second `ctrl+x` dismisses (the arm belongs to one question: a new question or a close drops it), `esc` closes and the question stays open. A question sent leaves the pane at once; a failed send brings it back with a notice. A `question-answer` message draws as `↳ answered · <question> → <answer>`, the question cut first at narrow widths; while it waits in the queue it shows as `↳ answer · <question>`.
- `@gent/cache` (`cache.client.tsx`) folds a branch's stream, tool, interaction, message and compaction events into prompt-cache misses above a 1,024-token noise floor. Each miss gets a cause over the interval the TTL runs on, from the start of the request that refreshed the cache: a model switch, a changed prefix inside the lifetime the model catalog names (the regression alarm for a moved cache marker; named `ExtensionsChanged`, "cache miss after an extension change", when the two requests' `StreamStarted.profileRevision` differ), or an expiry during a long response, a tool call, an approval wait, a paused turn, before a child completion, before a wake, or after idle time. The missed tokens fill the step's cache writes first, at the write rate, and the rest paid the input rate; each is priced over the cache-read rate, by the model the runtime priced the step by (`StreamEnded.pricedModel`, which follows a driver override) in `transport.modelCatalog()`. A miss is priced once, when the catalog is there; its row is born with that text. A row shows a miss of 20k tokens or $0.10; the status row shows the branch's `cache waste $X`. The row is telemetry for the reader, not context for the model. The same fold keeps the clock the loop's cold handoff reads: the start of the branch's last request (a retry's when it went out, an interrupted one's too; none after a compaction until the next request) and its model. A right-anchored status label (`anchor: "right"`, before `ctx`) counts the lifetime down: `cache 42m`, minutes rounded up, the warning color in its last fifth, `cache <1m`, then `cache cold`; a model that reports no cache writes caches implicitly, so its catalog lifetime is a measured guess and the count reads `cache ~28m`. A model other than the request's (`transport.selectedModel()`) reads cold at once. A lapsed cache on a window the loop's own cost rule hands off (`coldHandoffPays`, `@gent/core/protocol`, over the catalog entry's price and lifetime) reads `cache cold · next turn compacts`. A slow fiber on the client runtime reads `Clock` every 5 s, so a test clock moves it; a branch that never reported cache activity, or a model whose catalog names no lifetime, shows no timer.
- `@gent/extension-admin` (`extension-admin.client.tsx`) draws the `/extensions` pane from the server extension's `extensions.pane.status` request: a row per extension with its scope, its state and, after a failed reload, the version that still runs; a narrow row drops the version, then the scope. `space` turns a row off or on and `r` reloads it through the pane's own requests, which never ask; each change pulses the extension's state (`State.changed`), so the health line reads again, and the pane calls `shell.reloadExtensions` so the client set follows. The pane runs one change at a time, in key order, each on the row's status as the change before it left it (read again with `extensions.pane.status`), so `space` then `r` on an extension that is off turns it on, then sets it up; the replies of keys pressed while a change ran show together on the row, a refusal included. `enter` shows a failure's whole text.
- `@gent/git` (`git.client.tsx`) shows the checkout of the session in view on the status row: the branch with its ahead and behind counts (`main ↑2 ↓1`, `detached @1a2b3c4`, an unborn branch by its name) and the files changed against its base (`HEAD`, or the empty tree on an unborn branch), untracked ones included, with their line counts (`3 files +120 -31`, short form `+120 -31`). It reads git in `workspace.sessionCwd` through `runProcess`, every read read only (`--no-optional-locks -c diff.autoRefreshIndex=false`: `git diff` refreshes a file whose time moved and writes the index, `post-index-change` hook included, even under `--no-optional-locks`): `git status --porcelain=v2 --branch -z --untracked-files=all`, then `git diff --numstat -z --no-ext-diff --no-textconv <base>` (the base is `HEAD`, or on an unborn branch the empty tree of the repository's object format, which `rev-parse --show-object-format` names, so staged and unstaged lines count alike), then the lines of up to 200 untracked files of at most 512 KiB through `FileSystem`. So a read never takes `index.lock` from the agent's own `git commit`; `--no-ext-diff --no-textconv` keep repository config from choosing a program. A read runs on a session or branch move, on a write to `HEAD`, `index`, `MERGE_HEAD`, `ORIG_HEAD` or `FETCH_HEAD` in the checkout's git directory (a 200 ms debounced watch), 1 s after the last of a burst of tool calls, and at a turn's end or a message, one at a time (`sessionQuery`). It does not poll: an edit made in another program shows at the next trigger. A directory outside git, or no `git` on `PATH`, shows no labels; a read that fails or times out (5 s) keeps the last labels. The branch's pull request comes from `gh pr view --json` (8 s timeout, prompts off): `#123 ✓` when its checks pass, `#123 ✗` (the `error` color) when one failed, `#123 …` while one runs, `#123 draft`, `merged` or `closed`; it gives way first on a narrow row. It is asked again only when the root, the branch, the upstream or the ahead/behind counts move (a commit, a push, a pull, a fetch, a checkout), never for an edit, and never for a detached head or an unborn branch; each answer keeps the key it was asked for, so a branch move never shows the last branch's request. A branch with no request, or a checkout with no GitHub remote, shows none. No `gh` on `PATH` (the spawn finds no program) hides the label for the extension's life; `gh` that is not signed in or fails keeps the last answer. `/git` opens a docked pane (`PickerFrame`): its title names the branch, the upstream (which goes first on a narrow pane) and the totals, then one row per changed file (`M  path  +12 -3`, the path cut from its start) and one row for the pull request (`#123 Title · open · checks ✓ · review required`, `· open · ✓` when narrow); its note row names the last read's failure, such as `gh is not signed in · gh auth login`. Opening it reads the checkout and the request again. Enter on a row reviews it and leaves the pane open; esc or ctrl+c closes it. A review hands the terminal over (`shell.handover`): a file row runs `hunk diff --watch <base> -- <path>` in the checkout's root (with no base, hunk compares the index with the work tree and leaves a staged change out), the request row writes `gh pr diff` to a temp file and runs `hunk patch <file>`, so the reader's own `gh` sign-in reads a private request. `/diff` reviews the work tree in the session's directory, `/diff <paths>` those paths, `/diff pr` the request, and `/diff turn [n]` what turn `#n` of the branch in view changed (the newest with no number; `pr`, `turn` and `turn <n>` shadow paths of those names), as `@gent/checkpoints` answers it (`checkpoints.patch`, so `gent --connect` reviews a turn too); its refusal (no checkpoint, no git, the extension off) goes to the status row. The request's patch and a turn's share one path (`showPatch`): a temp file for `hunk patch`, or the git pager, read before the handover. When the spawn finds no `hunk`, the review pages the patch with the reader's git pager, and the status row says `hunk not found · using the git pager` once; gent never installs hunk. gent picks the pager as git does for `git diff` (`git var GIT_PAGER`, with a `pager.diff` that names a program in as `core.pager`; `pager.diff=false`, `cat` or nothing is `cat`), gives it `LESS=FRX` and `LV=-c` when they are unset, and colors the patch as git would for a pager (`git config --get-colorbool color.diff true`, and `color.pager`). The pager and each program that writes the patch are gent's own children, the patch piped through gent into the pager's stdin, so an interrupt stops and awaits them all before the renderer resumes (`git --paginate` and `gh pr diff` would start the pager as their own child, out of reach). A pager setting of words runs as that program; one with shell syntax runs in `sh -c`, as git runs it, and what that shell starts is the shell's. The work tree's patch is `git diff <base> [-- paths]`, then for each file `git ls-files --others --exclude-standard --full-name` lists, `git diff --no-index -- /dev/null <path>` at the checkout's root, one after the other: no object, no index write and no hook. Their errors go to the pager with the patch, as `git --paginate` sends them; a patch program that ends on a signal (the reader's ctrl+c reaches it, in the terminal's group) ends the patch there, as it ends `git --paginate`, and the pager reads to the end. The request's patch is `gh pr diff --color=never` for hunk and `--color=<git's choice>` for the pager; a turn's patch comes plain from the server, so the pager shows it uncolored. A program that exits with a code other than 0 or 141 (a pager quit early) is named on the status row; a program that ends on a signal (the reader's ctrl+c or ctrl+\ reaches it) is not, and the host's editor reads it as a cancelled edit. `gh` and `hunk` are optional programs on `PATH`, never dependencies: the TUI tests run them from a path that does not exist unless a test names a stand-in (`testPlatformLayer`), and the PTY tests run `gh` signed out. The host reads no git: it names the cwd label `repo/sub` from the project root a stat walk for `.git` finds (`projectRoot` in `workspace.tsx`).

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

`packages/core/tests/` mirrors `packages/core/src/`. A test imports the modules it tests, and every other core module, by relative path into that source tree. A test that authors a fixture extension takes the authoring names (`defineExtension`, `tool`, `ExtensionHost`, …) from `@gent/core/extensions/api`, as any extension does; the entry resolves to the same source file (`packages/core/package.json`), so module identity is the same. `tests/extensions/api.test.ts` also reads the entry as the public surface it checks:

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

Extension authoring uses the bundled `extensions` skill: where extensions live, a template, the test loop through `extensions.status`, and the `@gent/extension-admin` verbs. There is no scaffold verb; the agent writes the file with the file tools.

Saved-result writes use the existing `write` tool with `atomic: true`. The tool calls `writeFileAtomic` under its existing file lock. A symlink at the path is followed to its target, as a plain write follows it: the target is replaced and the link stays. The content is staged in a hidden sibling file beside the target, synced, then renamed over it; the target keeps its mode. Ordinary completion, failure, and scoped interruption remove the sibling file. Abrupt process death can leave that one hidden file, never a directory, and does not expose a partial destination. This does not claim power-loss durability.

An outer Effect deadline waits for acquisition and finalization: the platform's
file open and close and the writer's staging cleanup cannot be abandoned safely.
A stalled platform operation there can exceed the caller's deadline.
