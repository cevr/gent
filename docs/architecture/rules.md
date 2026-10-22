# Rules

Numbered invariants. Each carries the file that enforces it, so a reviewer can
check the claim instead of trusting it. A change that breaks an invariant
updates this list, and its one-line form in `ARCHITECTURE.md`, in the same
commit.

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
    (the prior art's settled entry "Tool image scaling" holds why). Receipts:
    A cell result carries the images its code shows, through the same
    projection (see `cell.md`). Receipts:
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
    effort marker takes effect too (a marker right after a user turn with
    new input applies to its reply, so the cached prefix holds; one after a
    turn of tool results only would wait past the reply, so such a change
    goes at the top level instead). Each step's `StreamEnded.reasoningLevel` receipt
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
    Receipt: `packages/extensions/src/threads.ts` (a `starter` round's end).
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
    `FileLock`, `Models`, `Accounts`, `Extensions`, `State`). An atomic write has one owner, `writeFileAtomic` in
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
    no copy, so the driver reports the raw word through `ProviderReport`,
    which the loop provides to each step's stream. An `"unknown"` finish alone
    is a finished answer.
    A turn whose first call would resend a large window after the provider's
    prompt cache lapsed hands the window off first, anchored at the new
    prompt, when a summary call and a small window cost well under a cold
    resend. One cost rule decides,
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
    says 30 minutes, as measured. A spawned child asks for the shorter child
    lifetime (`Model.childPromptCacheTtlMs`) unless its agent keeps the
    session cache (`AgentDefinition.promptCache: "session"`); either way it
    is never routed. The lifetime runs from the start of the
    branch's last model request (its newest stored `StreamStarted`, or a
    `ProviderRetrying` plus its `delayMs` when the request was retried), since
    the provider refreshes its cache when a request starts. The cache belongs to the
    model of the last request (its newest `StreamEnded.model`): a turn on
    another model never hands off for a cold cache. A model whose catalog entry
    names no lifetime never hands off either, and with no compactor installed
    the window stays whole. The loop sends no keep-alive calls to hold a cache
    warm. Each request names its session as the cache key and its turn (the
    turn message id) as `ProviderHints.turnKey`. Over ChatGPT sign-in OpenAI
    sends the key as the `session-id` header and both in `client_metadata`,
    and sends the route a turn's first answer names (`x-codex-turn-state`)
    back on that turn's later requests, on the same account only, as Codex
    does: without it a step can land on a backend that holds none of the
    turn's prefix. The TUI's cache notice reads the same catalog lifetime and the same
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
    A server or process Resource names none, and a branch Resource names
    only process Resources. An extension that owns tables creates and migrates them in a
    server or process Resource over the host's `SqlClient`, under a migration table of
    its own; core's migration chain builds only the kernel's tables, and the
    root takes no feature input. The cell is the shipped process case
    (`CellStorageResource`, `CellKernelResource`), and a user extension has
    the same two declarations; the threads' round table is the server case
    (`ThreadsResource`, `thread_migrations`). Receipts:
    `packages/core/src/domain/capability.ts` (`tool`, `request`),
    `packages/core/src/domain/extension.ts` (`defineResource`,
    `RequiredDeclarations`, `validateLeafResources`), `packages/extensions/src/cell.ts`,
    `packages/core/tests/extensions/api.test.ts`,
    `packages/core/tests/runtime/extension-host.test.ts`,
    `packages/extensions/tests/cell-receipts.test.ts` (cell tables).

## Known gaps

Kept here so the next pass starts from them, not from a fresh survey. Each
names the decision that left it open.

- **Typed fan-in for children (ledger A3) is rejected, not open.** A
  `thread.start` returns at admission and a `starter` round's end arrives
  as a user message that wakes the starter, with `thread.list` for
  inspection and `read_session` for the transcript. The model never blocks on a child, as in prime-agent;
  a `collect` would add a blocking surface the owner rejected.
  Reopen only if a run shows a child result needed inside a later cell
  before its message lands.
- **The agents view keeps a server half.** The live catalog
  (`ExtensionContext.Session.listActiveLoops`) and the stored catalog (`session.list`, `packages/core/src/server/rpc.ts`) differ after a
  restart; folding the view into the client would need a core RPC or one
  snapshot read per session per tick. Rejected as R6 in the same ledger.
- **A boot with both a cut-short turn and a due wake on one branch.** The
  cluster's redelivery of the turn's keep-alive and the wake clock's start
  pass both build the branch's entity, and the cluster gives no signal when
  its redelivery is done. When the keep-alive builds it first, the turn
  resumes at boot; when the fire does, the turn waits, deferred, for the next
  ordinary operation. Neither order runs a turn twice or loses one.
- **Compaction is measured on long sessions only by hand.** The handoff
  count (`ModelContextProjected.compacted`) after the spill comes from gamut
  runs, not from a test; the receipt in
  `plans/core-extension-reduction-receipt.md` records the last measurement.
