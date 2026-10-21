# Runtime

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
  extension hold through `ExtensionContext.Session.holdResident` (a running
  wake monitor). Every hold is scoped, so completion, failure,
  interruption, a fire, or a cancel releases it, and an entity nothing holds
  expires. Each hand-over takes the next hold before the last one ends
  (a wake's send, then its start, then its turn): the switch-on is an
  asynchronous keep-alive message, so a count that reached zero in between
  would let the reaper take a loop whose woken turn is about to start.
  The switch-on is a persisted cluster request (`Cluster/Entity/keepAlive`),
  answered only when the hold ends. A process that dies while a hold stands
  (a hard kill, a Durable Object eviction) leaves it unanswered, and the next
  process's cluster delivers it again at boot: that builds the entity with no
  operation, and the build resumes the turn the hold kept (deferred
  recovery, below). The cluster reads stored messages from the moment
  `Sharding` builds, below the actor, and puts back one for an entity type
  not registered yet; a registration starts no read. So `AgentLoopLiveActor`
  asks for one read (`Sharding.pollStorage`) once it is registered, and the
  redelivery comes at boot, not at the next storage poll (10 s).
- Durable wakes (the `durable wakes` section of `agent-loop.ts`): an
  extension arms a wake record on a branch with
  `ExtensionContext.Session.wakeAt({ sourceId, at? })` and removes it with
  `cancelWake({ sourceId })`. The record lives in `branch_wakes` (migration
  `026_branch_wakes`, keyed by session, branch, extension and `sourceId`,
  with a foreign key to its branch, so a session delete removes it); a
  repeat with the same `sourceId` is one upsert that replaces `at` (no `at`
  keeps the time set), bumps `version` and clears `attempts`. Each record
  has an `incarnation` (the AUTOINCREMENT key, never used again after a
  delete), so a record cancelled and armed again is a new record, though its
  `version` starts at 1 again. A record with no `at` fires only at the next
  server start: it names the start that armed it (`armed_boot`). Each
  server start takes its number from `branch_wake_boots` (`beginBoot`) as
  `BranchWakesLive` builds, below the actor: every arm goes through that
  service, so no loop (a replayed message, a recovered interaction, a client)
  arms a record before the number exists, and every record this process arms
  names it (`BranchWakes.boot`). The verbs are uniform facade
  verbs: the record names the calling extension, and a fire runs that
  extension's one `wakeDue` hook (`host.on("wakeDue", ...)`; package
  validation refuses a second). The wake clock (`branchWakeClockLive`, a
  server fiber above the actor in `server.ts`) has a start pass, which fires
  every start-only record an earlier start armed (`armed_boot` below this
  start's number) and every record whose time passed by the build's wall
  time (`cause: "start"`). A failed read of that set is logged
  (`branch-wake.startup.failed`) and read again with the same bounds, after
  0.5 s, twice as long each time, at most 30 s, until it succeeds; then a
  loop: it reads
  the wall time, fires each record due by then (`cause: "due"`), and sleeps
  until the next record is due or for `WAKE_CLOCK_MAX_SLEEP` (30 s),
  whichever is first; an arm, a cancel or a fire's end ends the sleep. A
  sleep is relative time and every turn reads the wall time again, so a
  forward jump of the system clock fires within 30 s and a backward jump
  fires nothing early. A fire sends the `FireWake` actor operation (not
  persisted; the clock owns the retry), so a passivated branch is built for
  it. The handler answers `Gone` for a terminated session or a branch that
  is gone, opens the loop with `ensureOpen` (recovery stays deferred), holds
  the entity resident, and runs the hook in the branch's profile with a
  non-client opener, beside any turn and with no permit, for at most
  `WAKE_DUE_HOOK_TIMEOUT` (30 s). The hook answers `Done` (the record goes),
  `At` (fire again then) or `AtStart` (fire at the next start). The clock
  applies the answer with one conditional write on the incarnation and the
  version the fire read (`settle`, `reschedule`): a `wakeAt` that landed
  during the fire, or a cancel and a new arm, stands as written. A fire that fails, or a hook past its timeout, counts an attempt
  and fires again after 5 s, twice as long each time, at most 10 minutes
  later (`retry`, guarded the same way). A record whose fire still runs is
  not fired again, and at most 8 fires run at once.
- Deferred recovery: the open of a loop starts no turn. The loop is built
  with `recoveryDeferred` set when it finds work a restart left (a user turn
  in the history with no completion, or a stored queue that wakes on
  recovery); while it is set, `canStartTurnNow` is false and no take
  leaves the queue, so an `ifLatest` line is not admitted, a plain line only
  queues, and the in-flight item keeps its slot and its accepted condition.
  `promoteRecovery` clears it once (`LoopInbox.settleRecovery`) and runs that
  work as the open used to: the cut-short turn, else the queue's next item
  as the queue stands now. The same queue transaction that clears the flag
  reserves that work's start (`startingState`), so a line a `wakeDue` hook
  sent, or any send that races the promotion, queues behind it. The actor's build promotes at once unless a wake
  fire is reaching the entity (`WakeFireOpenings`, a count in this process;
  one runner holds every entity), so a build for an operation or for a
  redelivered keep-alive resumes the turn as before, and a build for a fire
  resumes nothing: no paid turn starts with no user present
  (`NORTH_STAR.md`, fail-closed). A loop reopened after it closed promotes
  at its first ordinary operation (`ensureStarted`); a fire and an
  extension's `listActiveLoops` read open it with `ensureOpen` and leave the
  work deferred. A `wakeDue` hook's sends to its own branch then queue behind
  the cut-short turn.
- Runtime commands resolve an existing `(sessionId, branchId)` target before loop dispatch.

- A session takes its name from its first user message: at a turn end,
  `@gent/session-tools` renames a session that still has
  `DEFAULT_SESSION_NAME` to the first line of its branch's first user
  message (the rename cuts a name to 80 characters between code points and
  trims it), as a thread takes
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
- the tool runner (`runtime/tools.ts`) is the one place that checks a tool call. The turn asks for deferred tool call validation (`toolCallValidation: "deferred"` with `disableToolCallResolution: true`), so the drivers pass each call on as the model wrote it and the reply decodes its parameters as opaque (`patches/README.md`: Effect SDKs). A call whose input the tool's parameters refuse (a wrong type, a missing key) fails as its own result (`Tool '<id>' input failed: …`), and a call to a name no extension registers as `Unknown tool: <id>`. The model reads the result on the next step; the stream does not fail and the step is not retried. A turn that advertises no tool sends no toolkit and no `tools` or `tool_choice`, and a call in its reply fails as `Unknown tool: <id>` too (`a turn that advertises no tool`). The request's tool declarations do not change (`tool declarations on the wire` pins each driver's bytes, and `final step declarations on the wire` the last step's).
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

- Response projection treats token usage as known only when both totals are
  nonnegative safe integers. Missing or invalid totals remain absent, not zero.
  Compaction uses the same conversion and stores reported usage plus model ID in
  the handoff marker's `summarized` details. Failed attempts and crashes before
  marker persistence still need durable attempt accounting; this metadata alone
  does not enforce a budget.
- interactions are cold machine states, not blocked fibers
- machine inspection events are published as diagnostics

Do not rebuild business logic from inspection events. They are receipts, not inputs.

- `TurnCompleted` carries the turn's token totals, summed over its model
  steps. It is absent when any step reported no usage or an unusable count,
  when the turn had no step, and on historical receipts. Explicit zero is
  retained. Run results and child completions read usage from that receipt
  and the answer from the branch's last assistant message; nothing scans the
  event log. These are reported stream totals, not model-attempt accounting.

## Named permits

`runtime/permits.ts` owns `Permits.Live`, one in-memory counting limiter per
server, wired beside `FileLockService` in `createDependencies`. The SDK/server
and `createE2ELayer` share that root. The focused tool harness creates the same
implementation in its host context. This is a required `Context.Service`, with
no default binding.

`with(name, limit, effect)` validates `PermitSpec`: a case-sensitive name of
1–256 characters and a positive integer limit. The first participant fixes the
limit while any holder or waiter exists. A conflicting caller fails with
`PermitLimitMismatch` before running its body. The last release evicts the name;
a later generation can choose another limit. Recursive acquisition of the same
name is unsupported and can deadlock.

Each name has an explicit FIFO queue. Admission, removal, slot reservation and
waiter notification use transactional state. A release reserves the next slot
before waking its waiter, so new callers cannot barge. A finalizer installed
before the interruptible wait removes either the queued waiter or its granted
slot. It runs once on success, failure or interruption. `with` creates an inner
scope: the body's resources close before the permit releases.

The machines command owner uses `ExtensionContext.Permits.with`, while its
separate four-step cap and boot-debt reservations stay extension-owned.
Extensions use `ExtensionContext.Permits.with/list`. Core registers no model
tool. The `permits.list` RPC returns `PermitStatus[]`: name, limit, holders
(`id`, `acquiredAt`, epoch milliseconds) and ordered waiters (`id`, `queuedAt`).
Ids identify individual acquisitions within this server. Inspection provides no
release operation. Table state and order do not survive restart. A fresh table
proves nothing about an external process left by SIGKILL.

Receipts: `tests/runtime/permits.test.ts` covers FIFO, cancellation, grant-time
interruption, scope closure, mismatch, idle eviction and root binding;
`tests/server/permits.test.ts` covers two user-extension profiles sharing one
limit through real RPC requests, with zero model calls.
