# Threads and agent runs

## Threads in the runtime

- Threads (`threads.ts`, under `@gent/session-tools`) are the helper-agent boundary, built only on the public extension API. Every thread is a session in the one runtime, created through the addressed `Session` facade verbs. Threads keep their rounds in their own table (`thread_rounds`); core carries no runner and no child-run events.

- `thread.start` admits a thread by creating a session through the `Session`
  facade (the calling session is the parent; it names `parentBranchId`),
  then admitting its task as the first round. It returns the handle at
  admission, keyed by the host tool call id so a replayed call finds its
  thread, and never the answer: the model does not block on a thread. The
  running cap and the round table are described under threads (below).
- The starter's interrupt cascades to the `starter` rounds whose end would
  wake it: when a turn ends interrupted, its branch's `turnAfter` claims each
  open `starter` round its thread sent whose wake lands on that branch
  (marked stopped, with `stop_notice_at`), then stops the round's turn,
  queued or running, so a starter Escape stops the whole subtree (a thread
  stopped this way ends its own turn interrupted, and cascades in turn) and
  no round end wakes the starter the user just interrupted. A `user` or
  `none` round runs on: it is the user's side thread, or a service's. A
  round's turn that completed before the stop reached it ends uninterrupted,
  and its end takes the claim back and wakes the starter as any other. A
  failed stop hands the claim back and invalidates the reconcile marks. Each
  round stops on its own, eight at a time. The rows that keep a stop notice
  are read by the threads' `turnProjection` into a `# Stopped threads` turn
  notice (one line per thread, newest stop first, at most eight, then a
  count), as `@gent/wake` does for a `notify` fire (migration
  `2_thread_round_stop_notices`). `turnAfter` clears exactly the rounds in
  `readNotices`, which an answered turn hands back; a notice the turn did not
  show, because its read failed or the cap left it out, stays. The stop
  starts no turn; the starter's next turn, whoever starts it, knows the
  threads are not running. The notice asks the model to tell the user which
  threads stopped and to send them work again only when the user asks: the
  user's interrupt stopped them. Prime-agent does not cascade a turn abort;
  opencode does, and the gamut testbed's six children editing files after an
  Escape decided it. This cascade covers the rounds `thread.start` and
  `thread.send` opened; the turns a `session.send` opened are
  `@gent/session-tools`' own cascade (below).
- Every session can message another: `session.send` (`@gent/session-tools`)
  takes a session id or `parent` and steers an `Interject` with `wake` onto
  the receiver's active branch, carrying `customType: "session-message"` and
  `details.from` (sender id, sender branch id, name, relation). The message
  id is `interjectionMessageId(requestId)`, exported from
  `@gent/core/extensions/api`, so a sender can name what it sent. A send to a
  child is recorded in memory (process resource, keyed by child session and
  message id), and the sender's interrupted turn stops each recorded message
  with `Session.stopMessage`; only a stop that answers true becomes a
  `# Stopped child turns` notice, read and cleared as the threads' is. A
  failed stop is logged and the record stays for the next interrupt. The
  record drops a message when its turn ends, when a step joins it into
  another turn (`turnAfter`'s `joinedMessageIds`), when a stop settles it,
  and when the sender's answered turn finds the child session gone; a
  restart forgets it. A correction waiting in a thread's round turn that the
  threads' cascade already stops is the threads' news: that stop runs first
  in the same `turnAfter`, `stopMessage` then answers false for the
  correction, and the thread is named once, under `# Stopped threads`. A running receiver reads it at
  its next step; an idle one wakes and answers in a turn of its own. This is
  the child-to-parent channel (a blocked child asks instead of guessing) and
  the parent-to-child correction in one verb; work for a thread goes as a
  round (`thread.send`). Delivery is not bound to the round table, so a
  message to a thread whose round ended wakes it for another turn and no
  second round end follows. A message from a child adds a line saying a
  thread's answer arrives as its own round-end message and this is not one. The TUI draws the row as a
  muted sender line (`» from your parent "name" · <id>`, the name cut at 32
  terminal columns on a grapheme) over the text; `sessionMessageBody` removes
  the header, with or without the child line, so older rows render the same.
  Full detail shows the header the model reads.
- A thread is the sessions that share one thread key (`sessionThread`:
  `sessions.thread_id`, else the session's own id), in creation order; its
  key is its first session's id and its current session is the newest. A
  handoff (`continueThread`) joins its parent's thread and every other create
  starts one; no registry or field records a thread's members. Threads live
  in `packages/extensions/src/threads.ts` and register under
  `@gent/session-tools`, so their messages carry that extension id.
  `thread.start({ task?, name?, agent?, model?, effort?, account?, cwd?,
  instructions?, tools?, notify?, workspace?, fork? })` makes a session spawned under the
  starter (so spawn depth applies) with its own key and fresh context, or the
  starter's current context window with `fork` (the create's
  `historyBranchId`). A named agent is that agent wholly, with its own model
  and effort from its definition and config; with none, the thread runs the
  starter's agent and admission, model and reasoning. `model` and `effort`
  win over either; the run spec holds at most 32 model attempts;
  `instructions` add to the run's `systemPromptAddendum` and `tools` narrow
  it, keeping `thread.reply`. `account` (a credential label from /auth) pins
  every round of the thread to that credential (`RunSpec.credentialSlot`): a
  named agent's thread runs on none unless the call names one, and a thread
  with no agent keeps its starter's pin, which `account` replaces. The start
  does not check the label's sign-in; the first turn fails closed with the
  resolver's message, and a handoff keeps the pin with the admission. `workspace` names
  where the thread works, in place of `cwd`, and a start that names both is refused
  before any thread starts (`workspaces.md`). The create's request id is
  `thread:` and 32 hex of SHA-256 over the caller's session, branch and tool
  call id (a request id is matched across the workspace, a tool call id only
  in its session), so a repeated call is one thread. With no `task` the
  thread waits; with one, the task is its first round. The shipped `worker`
  agent (`promptCache: "session"`, denied `thread.start`, `thread.stop` and
  `machine.*`) is the long-lived thread that takes rounds; the shipped
  `delegate` agent (the same denials) is the one-round subagent, started with
  a task and `notify: "starter"`.
  - A round is one turn on the thread's current session, so it reaches the
    thread after a handoff: `thread.send({ thread, message, reply?, notify?
    })` returns `{ round, number }` at admission (`Session.send` `turn`,
    `completion: "admission"`, command and message id
    `thread-round:<round>`, metadata `customType: "thread-round"` with
    `details.round`, `details.createdBy: "agent"` and the starter). The
    round id is `round-` and 16 hex of SHA-256 over the caller's session,
    branch and tool call id: a tool call id is unique only in its session.
    A thread runs one round at a time, and only the thread that started it
    sends to it. A send the thread's loop refuses (a full follow-up queue:
    `Session.send` fails with `FollowUpQueueFull` itself, not wrapped)
    drops its round, so the thread is not held busy; the loop keeps the
    refusal under the round's command id, and a repeat gets it again. Any
    other send failure proves nothing (a reply lost after the loop admitted
    the turn, a concurrent repeat refused as already processing), so the
    round stays: its turn's end records it, and a retry or the starter's
    reconcile sends a turn that never arrived. A retry under the same key is handed its round before the
    busy refusal; it re-sends only a round whose message never reached the
    branch. A repeat of a round's command (`completion: "admission"`)
    admits nothing new and returns at once; it does not wait for the turn.
  - `thread_rounds` (one table in the server's database; its migrations are
    recorded in `thread_migrations`, apart from core's chain) keeps each round: its thread key, the
    session and branch it ran on, the sender and the sender's thread key,
    the reply it asked for, `notify`, and once it ends the text, the last
    `thread.reply` value, the turn's flags, its error, its usage and cost,
    and when its end was delivered. The thread's `turnAfter` hook matches the
    open round's message id (or a message joined into the turn), records the
    end (the first writer wins), then delivers it: `notify: "user"` (the
    default) tells nobody, the user reads the thread; `"starter"` queues a
    wake to the starter thread's current session that carries the answer
    (a header that names the thread, its agent, the round and its outcome,
    then the round's text, then how to read the rest) and the details its
    row draws (`ThreadRoundEndDetails`: flags, tool counts, last calls,
    time, bill, error, and a snapshot thread's work), saved on the row
    before the first wake is sent, so a delivery after a crash and a handoff
    goes where the first one went; a saved place whose session was deleted
    since is replaced, once, by the starter thread's current place
    (compare-and-swap on the saved session) (`sourceId:
    "thread-round-end:<round>"`, `customType: "thread-round-end"`); `"none"`
    is the service's own. The one writer that marks it delivered publishes it
    to `Threads.subscribeRoundEnds`: one feed per server, since the threads'
    resource is a server resource, and a thread started with `cwd` runs in
    another place than its starter. A `loopOpen` reconciles the rounds a
    branch sent or ran whose end is undelivered: a recorded end is
    delivered, a turn with a receipt is recorded from its history
    (`child-turns.ts`), and a round with neither is
    re-sent from the starter's side, whether or not the thread's loop is
    open: the repeat admits a round that was never sent and resumes one cut
    short, and a full queue's refusal drops the round as at admission. Each
    round settles on its own: one that fails is logged with its id
    (`threads.reconcile.round-failed`) and the rest go on. The
    wake's source id makes a second delivery a no-op. A branch's turns
    reconcile too (`turnProjection`): once per branch per process, and again
    after any threads hook step failed, since a failure invalidates every
    branch's mark. A round whose thread session was deleted while no process
    ran is dropped, as the delete hook would have.
  - `thread.round({ round })` reads a round the caller's thread sent: open,
    or ended with its text, reply (null when none was given), flags and
    usage. `thread.reply({ value })` keeps a JSON value on the open round of
    the caller's branch when the round asked for one; the last call wins, and
    no schema validates it. It is offered to every agent at all times and
    refuses a call when no open round there asked for a value: a tool list
    that changed per round would change the request and break the thread's
    cached prompt. The `Threads` service (a Tag other extensions
    read with `Effect.serviceOption`, as threads read `Workspaces`) carries
    `start`, `send`, `round`, `stop` and `subscribeRoundEnds`; the
    subscription is in memory, so after a restart a consumer reads its rows.
    A send it refuses fails with `ThreadBusy` (the open round), with
    `ThreadsOverCap` (the threads at the running cap), with
    `LaneUnavailable` (the account has no lane: `Busy` or `Spent`, with its
    `retryAt`), or with the thread loop's `FollowUpQueueFull`, so a sender
    that is not a model turn waits on the first three and fails on the rest;
    the tools wrap the first three in a `ThreadError` with the same words,
    which is the text the model reads.
    A deleted session's `sessionDeleted` drops the rounds it ran; the rounds
    it sent stay, since the starter's thread owns them and its handoffs read
    and hear them.
  - The thread tools act for the caller's thread, not its session: after a
    handoff the new session owns what the older one started. `thread.list`
    reads the caller's thread tree (`listSessions({ thread })`: every session
    with the caller's thread key and every session below any of them, so a
    deleted first session, whose handoffs stay detached, loses none of the
    rest; the agents view reads a `root` the same way), groups it by key, and
    keeps the groups whose first session any session of the caller's thread
    spawned, with each one's status from `listActiveLoops`, its open round,
    its last ended round (`lastRound`: number and flags, so a starter reads
    whether it was interrupted, stopped or failed), its current session,
    the account that session runs on (`account`, its label, and
    `placement`: `pinned`, `assigned` or `walked`; flat, so the row's type
    renders whole within the cell's signature bound; folded by
    `sessionAccount` from one read of that branch's events per call, so a
    call costs the listed branches' histories), and the current session's
    latest reply (one line,
    or 4,000 characters head and tail for one named thread); `read_session`
    reads the rest. `thread.stop` stops each working loop of such a thread,
    closes its open round as stopped (no wake), and refuses any other
    thread. The stopped turn's own `turnAfter` records the round, with its
    text and its bill: the stop marks the round stopped, stops the turn, and
    waits for that end (up to 10 s, and not at all for a round already
    ended); a turn that already ended is recorded from its receipt, and a
    round whose turn never reached the branch closes as interrupted with no
    bill. A turn that reached the branch and holds out past the wait (an
    uninterruptible tool finishing its own work) keeps its round open,
    stopped, and its own end records it with its bill. A `loopOpen` closes a stopped round whose
    turn never reached the branch, when the stop died before closing it; for
    one whose turn did, the starter's side asks the stop again (a new request
    id), which opens the thread's loop and stops the resumed turn, so the
    round closes when only the starter opens.
  - One thread runs at most four threads with an open round over all its
    sessions, or as many as the user's own `~/.gent/config.json` sets
    (`{ "threads": { "maxRunning": 8 } }`; a project file cannot, as each
    running thread spends the user's money): the count is read under one permit per server
    before a start makes its session, so a start with a task past the cap
    makes no session and names the threads that run, and again in the claim's
    transaction, the read the table holds to. Both reads count the starts
    still preparing (in memory, from the permit to the claim), so two starts
    cannot each pass and one be refused after its copy is made. Under the same permit, after
    the cap, the account admits the round (`ExtensionContext.Accounts.admit`,
    keyed by the round's message id, with the thread session's cwd, admission
    and model): a full account refuses it as `Busy`, a spent one (capacity 0) as `Spent`, and a start it refuses makes no session and no copy (a
    workspace start asks before its copy too). A start's order: resolve
    the place (`Workspaces.locate`), admit the cap and the lane, hold the
    lane (`Accounts.hold`, so setup hooks longer than the lane's 2 minutes
    do not lapse it), copy and run the hooks, create the session, bind,
    claim the round, send. Every refusal comes before the copy. An account whose capacity is
    not read admits every round; the caller's own running turn holds no lane
    against it. A retry under the round's key finds its round before the
    account is asked, so it gets the round it was admitted even while the
    account is full. A round that opens no turn of its own gives its lane
    back at once (`Accounts.cancel`): one that joins the thread's running
    turn, one the thread refuses as busy, one whose create or claim fails,
    one whose follow-up queue is full, and a snapshot start whose copy fails
    after it was admitted. Its lane frees when the round's turn ends, before
    its `turnAfter` hooks, so a round sent as an end is heard finds the lane
    free (credentials.md, Account lanes). The transcript shows a round's message without its
    source line on a muted `» task from session` row (another session wrote
    it, so it never takes the reader's rail). The starter's interrupt stops
    only its `starter` rounds (the cascade above); a `user` thread runs on,
    and a thread's unattended turns decline their asks (`turnCanAsk`). A
    `delegate` or `worker` thread is denied `thread.start`. The `#
    Sessions` prompt section shows its `thread.*` lines only to an agent that
    may call `thread.start`.
- Machines (`machines.ts`, `@gent/machines`) run a state machine defined as
  data with no owner turn between its steps, built only on the public
  extension API, the `Threads` service and the core wake seam. A definition
  (`machine.define`, written to `.gent/machines/<name>.json`) names thread
  roles and `thread`, `run`, `integrate`, `ask` and `final` states; `machine.define`
  lists every problem at once, a cycle of `exhausted` edges among them.
  `machine.start` snapshots the definition into a run (`run-` and 16 hex of
  SHA-256 over the caller's session, branch and tool call id) and returns at
  admission.
  - A run is one row in `machine_runs` and an append-only log in
    `machine_steps` (their own migrations, in `machine_migrations`). Every
    write compares and sets the row's `seq`. A step records the action it
    dispatches before it dispatches it (`Dispatched`), and the action's
    receipt once it has one (`Recorded`: a round's thread and id, a
    command's process), so a restart never repeats an ambiguous effect: a
    round is sent again under the same key (`machine:<run>:<seq>`, the same
    round), and a command no fiber of this process runs becomes an
    `interrupted` ask, never a second run.
  - One driver fiber per run, in the host branch's `MachineDrivers`, moves
    it: it holds the branch resident while the run is running, and leaves
    only from a settled row it read again under the lock that starts
    drivers. The run's core record `machine-run:<run>` (no time) stays while
    the run is active, so each server start activates the host; an answer
    or a stop from any session commits, then fires the record now. A round
    goes out with `notify: "none"`; its `thread.reply` value, decoded, names
    the next state. A dead worker or no verdict runs the round once more on
    a new thread, then asks `no-verdict`; a round stopped from outside asks
    `interrupted`. A round the account refuses (`LaneUnavailable`, at start
    or send) or whose worker died at a usage limit (the round's `retryAt`,
    stored in `thread_rounds.retry_at` and read from the turn's
    `ErrorOccurred` when a reconcile records the end) waits: the run commits
    a `Waiting` step (`lane` or `quota`) and `Round.notBefore`, its driver
    drops its step permit and its hold, re-arms the run's record at that time
    on each activation, and sleeps. At the time it sends the same round; a
    quota death reruns on a new thread under a new key. Neither spends a
    visit or the dead-worker retry, and a second refusal moves the time. A
    server start gives a waiting round no crash-debt ticket, even past its
    deadline. The driver removes `notBefore` only after taking a permit and
    committing the resumed dispatch. The owner is woken only by an ask (`machine-ask`), a final
    state or a failure (`machine-end`), each a queued message under a
    source id the queue drops a repeat of, at a delivery place saved first.
  - Answers check in one order: an answered ask is decided by its answer
    (the same choice and note again is admitted, any other conflicts), an
    ask never answered and no longer current is stale, a choice not offered
    is invalid. At most four rounds and commands run at once in one server
    (`MAX_ACTIVE_MACHINE_STEPS`); the runs that held one when the server
    stopped take the first permits as tickets. Named command limits use
    `ExtensionContext.Permits.with`, shared with every participating caller
    in this server. The command captures only the permit facade and holds
    it through its process scope's cleanup. An omitted limit means 1; a
    conflicting live limit becomes a typed `MachineFault` and a recorded
    failed run before spawn. This does not change the step cap or its debt
    reservations. A stop first arms a separate
    start-only `machine-stop:<run>` record, then commits and kicks the host.
    This record survives a crash before the kick, even while the run's main
    record names a future quota reset. Settlement removes both records. A
    waiting driver rereads the committed run after arming its timer, before
    sleeping, so a stale arm cannot hide a committed stop.
  - An `integrate` state pushes the run's head through the integration gate
    and moves by `on.green` or `on.red` (Integration gate in `shipped-extensions.md`).
  - A client reads runs as a session of the owner's thread:
    `MachinesRpc.Status` (`run-status`, `gent ctl status --run`) and
    `MachinesRpc.Runs` (`run-list`). The TUI's lanes band
    (`machines.client.tsx`, under the status line) shows the server's free
    lanes (`accounts.lanes`, the rows `gent ctl lanes --line` prints), then
    each active run as `<machine> <state> r<visits> <age>`, with
    `· wait <clock>` while its round waits for its account. It hides with no
    reading and no active run, and reads again on `TurnCompleted`, on a
    reconnect and every 30 s.

## Agent runs

- Threads (`threads.ts`, under `@gent/session-tools`) own child runs. They
  are built only on the public extension API — no core runner, no
  privileged seam. Every thread is a session created through the addressed
  `Session` facade verbs (`create`, whose parent is always the calling
  session, with `parentBranchId`; `send`, `stop`, `events`, `delete`). The
  rounds live in the server's `thread_rounds` table, so a `thread.list`
  survives restarts without any `durable_operations` row.
- A round's end has one writer: the thread's `turnAfter` hook records it, and
  a `starter` round's end goes as one ordinary user message to the starter
  (metadata `customType: "thread-round-end"`) that carries the answer, and
  the message wakes the starter. Nothing waits on a thread. A turn that
  ended badly also carries the error it ended on (the last non-notice
  `ErrorOccurred` since the previous receipt, one line of at most 1,000
  characters) in the text and in the optional `details.error`, so a starter
  tells a sign-in that will fail again from a flake. Reconcile covers the
  crash window between the receipt and the hook (threads, above).
- The thread tools are ordinary tools: `thread.start`, `thread.send`,
  `thread.list`, `thread.round`, `thread.reply` and `thread.stop`; a
  correction to a running thread is `session.send`. A round's message opens
  with `Round <n> from session <id>.` and says where its final reply goes, so
  the thread does not take a bare instruction for an injection. A `starter`
  round's text keeps the subagent's guidance: its final text is the result,
  a blocked turn ends with its question as that text, and any later turn
  (a wake, a monitor, a goal, a message) reports with `session.send` to
  `parent`. `thread.start` takes `model`, `effort`, `account` (the pinned
  credential), `tools` (narrowing) and
  `instructions`, and `fork` (the thread is created with `historyBranchId` =
  the caller's branch, so it starts from the caller's current context
  window). A history copy is settled first: a tool call with no result in
  the source, such as the `thread.start` call that is making the fork, is
  left out with its step, and a result whose call the window cut away is
  left out too, or the thread's first projection would reject the group. The
  `delegate` and `worker` agents deny `thread.start` and `thread.stop`:
  fan-out is the starter's decision, a project prompt that addresses "the
  orchestrator" reaches threads too, and a thread does bounded work for its
  starter, not unrelated work of its own. A thread's session name, which the
  tray, the sessions pane and its round-end row head with, is the start's
  optional `name` on one line (at most 80 units), else the first clause of
  its task's title in whole words, at most 32 units (`Check the greeting
  files`); never the agent's name, since many threads run as `delegate`, and
  never the default session name, which marks a session its first message
  still names: a candidate equal to it gives way to the whole title line
  (`childSessionName` in `session-names.ts`), with `thread` when no name is
  left. Starters read thread output through `read_session` or
  `thread.round`. The session is the only copy of a thread's output; the
  round end carries the outcome and the answer.
- Thread workspaces: `thread.start` takes `workspace` (`{ snapshot: true }`,
  `{ rift: { name, from? } }` or `{ path }`) in place of `cwd`. The places,
  their backends, records, collect, lifetime and refusals are in
  `workspaces.md`; read it when you change `@gent/workspaces` or where a
  thread works.
- The TUI agents pane lists children through `AgentsViewRpc.ListAgents` and
  refreshes on session-tools' `ExtensionStateChanged` pulses (a thread's
  start, interrupt and round end each send one), matched by
  `SESSION_TOOLS_EXTENSION_ID`. Round-end rows read the round-end message's
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
- The tray draws one row per running child, its glyph the state: the
  `◇◈◆` pulse, then `<name> · <doing>` (the name in the info colour), with no state word. `<doing>` is the
  child's newest running call in the live line's words (`Reading src/loader.ts`,
  a cell's `Reading 2 files`), else its last streamed line: `ListAgents`
  sends the line as `activity` and the call as the wire-only `runningCall`
  (the tool and its bounded command, path, pattern or cell source), and the
  TUI words it, so the server holds no copy of the TUI's vocabulary. The
  tray adds `◆ <name>` after its running rows (three rows at most, the rest
  counted as `+N more`) for a side thread that a listing showed running and a
  later one idle while the shell was not on it, in the subtree of the shell's
  thread. The thread the shell is on counts as seen too, so a finish the
  reader watched inside the thread is no done row back at its starter; a done
  row is made only for a descendant. The controller keeps that state outside any component, keyed by
  thread key, and changes it only for a reply `sessionQuery` keeps
  (`accepted`). Opening the thread, its next turn on any of its sessions, or
  its absence from a whole listing of the root it finished under (no filter)
  clears it; a filtered listing never does. A thread whose latest round
  reports to its starter (`notify: "starter"`) gets none: its round end lands
  in the starter's transcript, and its row carries the additive
  `reportsToStarter` flag, read from its rounds.
- The Sessions pane is the agent command center, docked like every pane.
  `sectionOf` puts a live loop under `needs` (the wire section widened
  additively) when it waits on the reader: its status is
  `WaitingForInteraction`, or its branch holds open background questions
  (`ask_user_async`, read through `openQuestionCount` from the questions
  store; a store it cannot read counts none). The row carries the count as
  the wire-only `openQuestions`, and a thread's row sums its members'.
  Sections order `needs`, `running`, `idle`, `inactive`; the glyph's shape
  says the state (`●` needs you, the `◇◈◆` pulse running, `○` idle, `·`
  inactive) and a needs row says why (`waiting for an answer`, `1 open
  question`). The title counts each state there is (`Sessions · 1 needs you
  · 2 running`). From 100 terminal columns a details column (40% of the
  width, ruled off in `border`) shows the selected row: name, state, `model ·
  effort`, turns · cost · time, cwd, what it does now or the head of its
  last answer, and its task. The detail is the one per-row snapshot read
  (`ExtensionAgentDetail` gains `effort`, `firstPrompt` and `lastAnswer`);
  under 100 columns the one-line detail stays. While the session in view
  is a child (its row names a parent), the extension's status label reads
  `↳ child <name> · ← sessions`, derived from the latest listing. The
  name is cut at a whole word to 16 columns (what a 100-column row leaves
  it), and on a narrow row the child label gives way whole before the way
  back and the cwd, so it never costs the reader either.
- Child session nesting depth is admitted on the `session.create` command path
  (`admitChildSessionDepth`). Missing or incomplete ancestry is an error, not
  root depth; a parent at the depth limit cannot spawn. Only spawn edges count:
  a handoff (`continueThread`) keeps its parent's thread, is not admitted, and
  keeps its parent's depth. This check is not a concurrency or token budget.
- Three shipped agents: `main`, the orchestrator; and two registered by threads (`threads.ts`): `worker`, the long-lived thread that takes rounds, and `delegate`, the one-round subagent a `thread.start` names with `agent: "delegate"`. A thread that names an agent inherits neither its starter's agent nor its model, only its starter run's bound (its tools and paths never exceed its starter run's): its model and effort come from the named definition, reshaped by `agents.delegate` (or that agent's entry) in `.gent/config.json`, and the start's `model`, `effort` and `instructions` win over both, while its `tools` only narrow the definition. The `delegate` agent holds `["*", "!thread.start", "!thread.stop", "!machine.*"]`; a start's `tools` narrow those patterns, so it cannot hand a thread delegation back. That config entry is where a pairing such as fable → opus or opus → sonnet is declared.

- Foreground runs persist a child session/branch and can be revisited with `read_session`. Private runs leave no session behind; they return text/usage/tool-call metadata only. `read_session` with `fromMessageId` reads only the branch that holds that message, from it on: a fork's own turns without the history it copied, which its reader already holds. A message the session does not have fails the call.
