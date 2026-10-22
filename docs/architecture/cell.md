# Cell

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

The loop has no `cell` name rule
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
starts cleanly starts the loop's `loopOpen` activations in the loop scope;
the actor's build then resumes the turn a restart cut short (if any, and not
for a wake fire, see Deferred recovery in `runtime.md`); closing the loop interrupts them.
Loops are lazy: only three things build one with no client, the cluster's
redelivery of a turn's keep-alive, the wake clock's fire of a record on the
branch, and another loop's operation, so a session nobody opens and nothing
wakes runs no `loopOpen` until a client or another loop reaches it (a
snapshot is enough).
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
(`PRIOR_ART.md`).

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
declines every interaction unless `--approve-all` is set (`apps/tui/docs/cli.md`).

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
and the next cell starts a clean one. A started thread or `/btw` fork starts
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
a callable path, split on `.` (`thread.start` is `tools.thread.start(input)`,
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
`{}`. Enums past eight literals, and input or result types past 320 characters,
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
