# Machines

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
    `machine_steps` (at the machines' own schema version). Every
    write compares and sets the row's `seq`. A run's visits and its saved
    values are a fold over its steps (`foldSteps`), never a column: a
    state's visit count is the highest visit its `Dispatched` actions name
    (or its `Finished`), a `Granted` step is one visit past the cap, and a
    `Saved` step is the value a visit left for `{{<state>.*}}` and
    `{{all.<state>}}`. A read folds the stored steps, a commit folds its new
    ones, and `machine.status` leaves `Saved` steps out of its view. A step records the action it
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
    `interrupted`. A round too big for its thread stops on size: a thread
    state's optional `oversize` (`{ windows, to }`) moves the run to `to`
    once the tokens of the round's own work that left its context reach
    `windows` times the model's window. The size is
    `thread_rounds.handed_off_tokens` against `window_tokens` (threads.md),
    kept on `RoundEnded.handedOffTokens` and `windowTokens`; an unknown
    window never stops. The check runs before the account wait, the
    dead-worker retry and the no-verdict ask, and `RoundEnded.verdict`
    keeps the model's own word. The move is `Moved { by: "oversize", note }`;
    the note names the verdict, the size against the limit and the fix
    (replan the work into smaller units). The next state reads it as
    `{{visit.note}}` (empty after any other move; an empty slot between two
    spaces leaves one), and `{{visit.<other>}}` fails the definition. A
    definition with no `oversize` never stops on size. A size stop counts
    as a failed visit and in its model's quality (`oversize`). A round with no free lane is queued by its send and the
    driver waits for its end as for any open round (a role pick: below). A
    round the account
    refuses as spent (`LaneUnavailable`, at start or send) or whose worker
    died at a usage limit (the round's `retryAt`,
    stored in `thread_rounds.retry_at` and read from the turn's
    `ErrorOccurred` when a reconcile records the end; a `none` round ends
    there, where a `starter` round waits on its own row: threads.md) waits: the run commits
    a `Waiting` step (`lane` or `quota`) and `Round.notBefore`, its driver
    drops its hold, re-arms the run's record at that time
    on each activation, and sleeps. At the time it sends the same round; a
    quota death reruns on a new thread under a new key. Neither spends a
    visit or the dead-worker retry, and a second refusal moves the time.
    The driver removes `notBefore` only when it commits the resumed dispatch.
  - A role names a pinned `model` (and `effort`) or a config `role`
    ([models.md](models.md)), not both; with neither, the agent's model. A
    thread state's first switch that holds (a slot like
    `plan.reply.path` reads `is`, through visit `visits`) runs another config role. A role `against`
    another skips the maker of that role's last round and unknown makers.
    `machine.start` refuses a role (a switch's too) the config lacks, or one against another
    with one maker; a pick left with no choice fails the run. A round runs
    the first choice whose lane `Threads.admitSend` admits under its send
    key, at its effort: in the role's order, or with `rank: "cheapest"` by
    spend per accepted unit (`efficientOrder`), read at pick time from the machine's newest 40 ended runs. A run's
    spend is every round of it, each role's, at its model's fitted quota
    weight (`accounts.lanes`); a round with no price counts its tokens at
    the fuel reference prices, and a run with a round that kept neither is
    not measured. A run whose final state accepts its work (`accepts`,
    default true) is one unit. Each model that ran rounds of the config role (`RoundEnded.configRole`) in a
    run takes the run's spend and unit at its share of those rounds; a run
    weighs half as much as one 10 runs newer. A model is scored in the
    narrowest scope it has runs in: the run's project (`Accounts.project`,
    kept on `Started`) and the input's `domain`, else the project, else the
    machine. A run's project (`ConfigService.project`) is the nearest
    `.git` root at or above its cwd, named by its `origin` after
    `insteadOf` rewrites (a clone, a worktree and a rift share it), else
    that root's real path. A model with no measured run goes first (list order), then the
    lowest score, one with no unit last. When the role's last 9 runs in
    the first model's scope ran it alone, the runner-up goes first to be
    measured again. Deleting the function leaves the list's order. The role's
    thread is tried first while a choice names its model and effort, to keep its cache; another pick, a switch's too, starts a thread that
    becomes the role's. With every choice refused, the round waits (`lane`) until
    the first frees; another role is never a fallback. With none admitted
    and one not refused, the round sends on the first such choice and waits
    in its lane queue (`Round.queuedOn`, `queuedAt`). Ten minutes on
    (`PATIENCE`), still queued (`Threads.laneQueued`, `Accounts.waiting`),
    it moves when its role has a choice of another maker than that
    model's and the ones it left before (`avoid`). The move commits that
    maker as the round's `leaving` first, then the queue decides
    (`Threads.withdrawQueued`, `Accounts.withdraw`, under the queue's lock):
    a round withdrawn (marked stopped before the queue decides, so it never
    runs) is replaced by a new round, with a `Repicked` step, that picks
    with those makers left out, on a new thread; a round its grant reached
    first keeps its place and runs. A restart, or a step that died, finishes
    a `leaving` round the same way, and a stopped one counts as withdrawn.
    A retry or a rerun of the visit keeps `avoid`; a new visit starts
    without it. With no such choice, or once its lane came, it keeps its place. Every `RoundEnded`
    step keeps the role, the thread's model, and the turn's `costUsd` and
    tokens; `Finished` keeps whether its state accepts. Quality is
    shown, not picked on: `machine.status` and `MachinesRpc.Quality` (by a
    session of a round thread) count per state and model, over the
    machine's runs, the rounds, dead ones, priced cost, verdicts, the
    check (`pass`/`fail`) and gate (`green`/`red`) moves after each round,
    and the rounds a run its final state accepted took. A verdict is the model's own word,
    counted as itself (`constructor` included). The owner is woken only by an ask (`machine-ask`), a final
    state or a failure (`machine-end`), each a queued message under a
    source id the queue drops a repeat of, at a delivery place saved first.
  - Answers check in one order: an answered ask is decided by its answer
    (the same choice and note again is admitted, any other conflicts), an
    ask never answered and no longer current is stale, a choice not offered
    is invalid, and a choice whose required file is missing or incomplete
    is unmet (below). At most four commands run at once in one server
    (`MAX_ACTIVE_MACHINE_COMMANDS`): a `run` state takes a permit before its
    `Dispatched` commit (and before a named permit's wait) and gives it back
    at the driver's next read after the exit, the stop or the ask commits. A
    poke (a stop, an answer) takes a run out of the permit's wait, so a stop
    settles without waiting for a permit. Rounds take no permit and no count
    caps them: an account with quota readings paces its rounds by its lane,
    and one with none (an API key) admits every round. A
    command killed by a crash asks `interrupted` and never runs again, so an
    asking run and a restart hold no permit. Named command limits use
    `ExtensionContext.Permits.with`, shared with every participating caller
    in this server. The command captures only the permit facade and holds
    it through its process scope's cleanup. An omitted limit means 1; a
    conflicting live limit becomes a typed `MachineFault` and a recorded
    failed run before spawn. This does not change the command cap. A stop first arms a separate
    start-only `machine-stop:<run>` record, then commits and kicks the host.
    This record survives a crash before the kick, even while the run's main
    record names a future quota reset. Settlement removes both records. A
    waiting driver rereads the committed run after arming its timer, before
    sleeping, so a stale arm cannot hide a committed stop.
  - An `ask` state's optional `requires` (`{ choices, after, file, headings }`)
    makes some answers wait for a file. A visit the run entered by one of
    `after` owes the file: the move's verdict (`Moved.verdict`, kept on a
    round's verdict move and on an answer that chose a thread state's
    verdict), else its `by` (`exhausted` for any cap). The debt is in the
    run's memo (`RunMemo.owed`, folded from the steps): an ask dispatched
    with its requirement adds its state, an answer that met it
    (`Moved.met: true`) removes it, and while it is owed every visit of that
    ask owes the file, whatever edge entered it. On a visit that owes it,
    the ask's dispatch records the file resolved from the run's cwd and the
    SHA-256 of its text, or none, in the pending `Ask` action and its
    `Dispatched` step (`AppliedRequirement`), so the record survives a
    restart. The ask names the file, its headings and the choices it guards,
    in its text and in its details (`requires`), and an answer in `choices`
    is refused (`unmet`, the run stays at the ask) until the file's digest
    differs from the recorded one and it has non-blank text under each
    heading (a markdown heading of any level, case-insensitive, read
    trimmed, up to the next heading). No clock: a touched or copied stale
    file is refused. The refusal names the file and each gap: `no file`,
    `unchanged since the ask`, `no heading X`, `nothing under X`. A visit
    that owes the file with no record refuses the guarded answer and names
    the missing record. `machine.define` refuses a `choices` entry that is
    not a key of `on`, an `after` entry that is neither a move kind
    (`exhausted`, `oversize`, `verdict`, `pass`, `fail`, `error`, `green`,
    `red`, `answer`) nor a verdict some thread state's `on` names, and a
    heading with a space at either end; it checks `file`'s slots. The run's
    memo keeps its last `Moved` step (`lastMove`), which also gives
    `{{visit.note}}`. The orchestrate machines' decide requires
    `{{input.dir}}/diagnosis.md`, with Premise and Counterexample, before
    `changes`, `replan` or `rewrite` at a cap (`exhausted`) or after a
    `stuck` verdict: each starts a new direction, which could rest on the
    premise that failed. A size stop (its note is the diagnosis), a check
    error and an ordinary decide owe none unless an earlier visit's debt is
    unpaid, and `fix`, `merge`, `drop` and `recheck` never need it. The
    planner and the implementor read diagnosis.md first when the unit dir
    holds one, and a rewrite's new unit dir gets a copy (the orchestrator
    recipe).
  - An `integrate` state pushes the run's head through the integration gate
    and moves by `on.green` or `on.red` (Integration gate in `shipped-extensions.md`).
    The visit pins the head its cwd had when entered
    (`PendingAction.Integrate.head`) and pushes that commit, so a crash
    after a rebase never pushes an unchecked head. With `on.restack`, a push
    refused for a moved ref restacks: `git fetch` of the ref, then
    `git rebase` onto it. A clean rebase moves by `restack`
    (`GateOutcome.restacked`, from, to and onto) to a state that checks the
    new head again (the orchestrate machines go back to `gate`, whose
    receipt key now differs); a head that already contains the ref but
    differs from the pinned one (a rebase before a crash) counts as
    restacked too. A conflicting rebase is aborted and moves by `conflict`
    to `on.conflict`, or `on.red` without it (`GateOutcome.conflict`, the
    unmerged files and git's output); a rebase already in progress is a
    conflict and is not aborted. A fetch that fails waits and retries, as
    an unreachable remote does. `on.conflict` without `on.restack` is
    refused. The orchestrate machines send a conflict to `resume`, where
    the implementor rebases and resolves.
  - An integrate state's `via` (a template; empty or `push` pushes) set to
    `pr` merges through a pull request a person approves, for a repository
    whose ref takes no push. The visit force-pushes its pinned head to the
    run's own branch `gent/<run>` (never a person's branch), finds the open
    PR from it on the ref or opens one titled by the head's subject, and
    records the PR in `PendingAction.Integrate.pr` with one `Waiting` step,
    reason `pr`. A crash between the open and the record finds the same PR.
    Then it reads the PR (`gh pr view`) every 2 minutes under the run's own
    record, with no step, no permit and no model turn: a review takes
    minutes to days, so 2 minutes adds little, and 30 reads an hour stay
    far under GitHub's 5,000 requests an hour. A merged PR (by a person or
    by the run) moves by `green` (`GateOutcome.merged`); changes requested,
    a closed PR or a head the run did not push move by `declined` to
    `on.declined` (default `on.red`), the move's note quoting the reviews;
    a failed check moves by `red` (`GateOutcome.checks`). Approved, green
    and mergeable, the run merges by the repository's method (squash, then
    rebase, then merge) with `--match-head-commit`, so a head pushed after
    the read never lands. A conflicting PR restacks with `on.restack`
    (then the next visit force-pushes the new head to the same PR) and takes
    `on.conflict` (default `on.red`) without it; a PR only behind its ref
    restacks with `on.restack` and waits for a person without it. The run's
    status stays `running` while it waits: the open PR on the pending action
    is the wait, since a new run status would change the `machine_runs`
    table's check, and a schema version change drops every run. A literal
    `via` other than `push` or `pr` is refused at define, and a rendered one
    at start. The orchestrate machines take `via` from `input.via` and send
    `declined` to `decide`. The run deletes no branch after a merge.
  - A definition can ship files (`files`, a name to its text, each at most
    64,000 characters), so a check travels with the definition, not with a
    project. A `run` state names one as `{{files.<name>}}`: each command
    writes the definition's files to its own scoped temp directory, renders
    the slot as that file's path, and removes the directory when the command
    ends; a failed write fails the command. `{{bun}}` renders gent's own
    executable as Bun (`env BUN_BE_BUN=1 '<GentPlatform.execPath>'`), so a
    shipped TypeScript file runs on the runtime that runs the server, with
    no Bun on the PATH. `machine.define` refuses both slots outside a `run`
    state, a file name the definition does not ship and a `{{bun.<x>}}`,
    and `files` and `bun` are reserved state names (the other heads are
    `input`, `visit` and `all`).
  - A `run` state moves by its command's end: exit 0 takes `on.pass`.
    Without `on.error`, any other end takes `on.fail`. With it, exit 1
    takes `on.fail` and any other end (exit 2 or more, a timeout, a command
    that did not start) takes `on.error`, with a `Moved` note for the
    target's `{{visit.note}}`: `Check error: the <state> command exited
    <n>|timed out after <s> seconds|did not start, so it gave no verdict`
    and the output's last 1,000 characters. An error move is not a check
    move: the quality tally counts it as neither `pass` nor `fail`. A run
    state with `screen: true` (the orchestrate machines' repeat-test check)
    screens before a review: its pass (and its SKIP, which exits 0) judges
    no round, keeps `Moved.judged: false`, counts in no model's `checks` and
    leaves the rounds since the last check to the next check that judges
    (the merge gate); its fail judges those rounds as any check's fail does
    and clears them, since a wrong test is the implementor's own failure.
    Runs recorded before `screen` counted every repeat-check pass and fail
    as a judging check, so older quality history mixes the two rules.
  - A `run` state with `reuse` (`{ env? }`) keeps its passes as receipts in
    `machine_receipts` (at their own schema version, `@gent/machines/receipts`,
    so a change to them leaves the runs alone; the newest 500 stay). The key
    is four parts: the commit `git rev-parse HEAD` names; the SHA-256 of the
    command as rendered, a shipped file by its content's digest and
    `{{visit}}` as 0; the SHA-256 of the platform, release, gent build, cwd,
    `PATH` and each variable `reuse.env` names, as `env -0` prints them (what
    the command inherits); and the tree `git add -A` then `git write-tree`
    give in a copy of the index, so a change, a new file and a deletion that
    git does not ignore are inputs, and the checkout's index is untouched.
    Before the command (and its named permit), a kept pass at the key ends
    the visit as exit 0 with the kept output: `CommandEnded.reused` and
    `reused: true` in the `Saved` value, no process, no log. A pass is kept
    only when the key reads the same after it, so a command that changed the
    checkout (a log inside it, a formatter) keeps none. A red, a timeout and
    a start failure are never kept: a flake would trap the run. No
    repository or no commit gives no key, and the command runs. Files
    written inside the checkout count, so keep logs outside it or ignored;
    `machine.define` writes `.gent/machines/`, which a project that does not
    ignore it sees as a new input. The orchestrate machines' merge gate has
    `reuse: {}`; the implementor's own gate is a bash call, not a machine
    command, and keeps nothing.
  - The orchestrate machines' `repeats` state (`fix-repeats` in the light
    one) runs the shipped `repeat-tests.ts` (`packages/extensions/src`,
    embedded by a Bun text import) as `{{bun}} "{{files.repeat-tests.ts}}"
    "{{input.dir}}"`. Each Blocker or Major of the last findings that says
    `repeat of rN <id>` needs a line in the newest request:
    `Repeat test: rN <id> <test file>... -- <command> :: <test name>`.
    Every heading resets the section; only `Blocker(s)` and `Major(s)` block.
    In clean worktrees under `<unit dir>/repeat-check/`, which each check
    clears first (a killed check's too), with the lock file's packages
    installed, the command must exit 1 to 125 at the head the last review
    saw (its `Head` line in that round's record), with the test files from
    the new head, and exit 0 at the new head, its output naming the test
    both times. Verdicts: PASS or SKIP (no repeat) exit 0 to `review`;
    FAIL exits 1 to `fix`, a counted round; ERROR (git, an install, a
    runner that could not start, an unknown reviewed head, a crash) exits 2
    to `decide`, which counts nothing and offers `recheck`. Each check
    writes `round-N-repeat-check.md` and its logs under
    `repeat-check-N-evidence/`. The children's environment drops
    `BUN_BE_BUN`, and `CLAUDECODE`, `AGENT` and `REPL_ID`, under which
    `bun test` hides the names of passing tests.
  - A client reads runs as a session of the owner's thread:
    `MachinesRpc.Status` (`run-status`, `gent ctl status --run`, what
    `machine.status` gives), `MachinesRpc.Runs` (`run-list`) and
    `MachinesRpc.Page` (`run-page`), and stops one with `MachinesRpc.Stop`
    (`run-stop`, the stop `machine.stop` asks). `Page` gives the run's
    row (status, machine, start, pending action) and its `trail` from step
    `since` on: one `StateVisit` per visit of a state, oldest first, keyed
    by its first step (`seq`): its start and end, the thread and model of
    its newest round, its rounds and their priced cost, whether the last
    round ended with no verdict, its outcome (the verdict, the answer, a
    check's `pass`/`fail`, a gate's `green`/`red`, `exhausted`, or
    `stopped`/`failed` for the visit a stop or a failure ended) and the
    state it moved to. `next` is the next read's `since`: the open visit's
    first step, else the step after the run's last. A visit before it never
    changes, so a reader keeps its trail and each read folds only the open
    visit's steps (`visitSteps` over `since` to the run's `seq`); the page
    reads no other run's log and no outcome tally. A refused visit (a move
    off a state out of rounds) and a final state's visit take their number
    from the run's memo. The model's tool has no trail: its steps say the same.
    The TUI agents pane lists the shell's thread's runs (each active one,
    then the three newest ended) above its sessions; Enter opens a run's
    page, one row per visit with its model, outcome, cost and age under the
    run's totals, where Enter opens a visit's round thread and a double
    Ctrl+X stops an active run (`agents.client.tsx`, the run page in
    `threads.md`). The TUI's lanes band
    (`machines.client.tsx`, under the status line) shows the server's free
    lanes (`accounts.lanes`, the rows `gent ctl lanes --line` prints), then
    each active run as `<machine> <state> r<visits> <age>`, with
    `· wait <clock>` while its round waits for its account. It hides with no
    reading and no active run, and reads again on `TurnCompleted`, on a
    reconnect and every 30 s. A run's age, the peer's age and whether a
    `wait` clock falls today read the server's now
    (`ClientTransport.serverNow`): a run's start is the server's time, and a
    client never subtracts a server time from its own clock.
