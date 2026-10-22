# Interactions (Cold Pattern)

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
(`isSpawnedSession`) has a parent and starts its own thread: a started thread
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
root. A top-level or handoff session's user watches every turn there, so its
wake, monitor, thread round-end and slash-command turns ask. In a spawned
session, only a turn a client opened asks (a user who prompts or steers the
child); a turn its parent's `thread.start`, `thread.send` or `session.send`, a wake or a
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
(`RuntimeUserMessageType` in `domain/message.ts`) would make recovery skip the
turn, so both are removed; an extension keeps its own custom types, a client
sets none. A
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
- **An answer goes to its owner.** The owner of a request is the tool call that asked and the index of that ask in the call's run; the row stores both (`owner_tool_call_id`, `owner_occurrence`, null for an ask with no owning call). A branch shows one request at a time. Other owners queue in the order they asked, and a call that asks the same question never takes another call's answer. A call ends when one of its runs ends without parking. A run that parks continues its call: the answers it kept and the answer to the question it parked on stay for its next run, also when that answer comes before the run ends, so the parked turn finds it and goes on. An answer whose call ends without taking it is settled as abandoned, so the next owner asks. A run's end is one state transition, and it always wakes the calls that wait for their turn. The branch's slot follows the row, and storage keeps at most one pending row per branch: a request that closes (taken, settled, abandoned, or ended with its turn) holds the slot as `closing` until its row stops being pending, and only then can the next call claim the slot and store its row. A storage write that fails is not swallowed: the interaction owner logs it (`interaction.take-failed`, `interaction.resolve-failed`), gives the failure to its caller where one can take it, and keeps the slot as `unsettled`, because the row can still be pending. Any later write that closes that row frees the slot: the cleanup of the call that took the answer, the end of the turn, or the next ask, which writes the row again before it looks again. A dispatching tool's inner call (a cell) waits for the slot while the open request's owner still runs, and is refused when that owner parked; after a crash it resumes by its request id. An answer matches its question as well as its owner; a changed question asks again, for a dispatching owner too. A call keeps the answers it took (row status `taken`) until it ends, so a call that asks twice takes both, also across a restart. Only a tool call the loop runs can ask natively; an ask with no call and no dispatching owner is refused.
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
- **No permission rules in core; one hook.** A tool call that asks the user asks once through the durable approval request (`ApprovalService`); the answer is not saved, and a request with no answerer fails closed. Core has no rule schema, no rule storage, and no `permission.*` RPC. It has the `toolCall` hook: before a call runs (a call of the model, or one the cell's code makes, since both go through `ToolRunner.runBound`), every extension's hook gives a `ToolCallVerdict` (`Allow`, `Ask { reason }`, `Deny { reason }`; `domain/capability.ts`). The strictest verdict wins (deny over ask over allow), and a hook that fails answers `Ask`. `Ask` is one approval request through the same `ApprovalService`, so a turn with no answerer (headless without `--approve-all`) declines. A denied or declined call does not run: the model reads a failed tool result that names the reason, and the turn goes on. With no hook the gate reads nothing and the call runs as before: the requests keep their bytes. The gate runs inside the tool's handler, after the input decodes and before the body, so a hook reads the input the body runs with (a field the parameters drop is not there), and a call whose input does not decode fails as before with no judgement. A call is judged once. A top-level call that parks keeps its verdict in its turn record (`PendingToolCall.verdict` and `gate`, both optional); a cell operation keeps them in its operation record. The verdict is stored with its gate `pending` before the call asks or runs, and an approved `Ask` is stored `passed` before the call goes on (and before the tool's own approval asks); a store that fails fails the call, which does not run. A resumed call applies the kept verdict: a `passed` gate does not ask again (the skipped ask keeps its place in the call's count, so the tool's own approval takes its stored answer), and a `pending` `Ask` asks the same question again and takes the stored answer. An absent gate reads as `pending`. A call that was allowed and ran is never run again. The shipped `@gent/guard` (`packages/extensions/src/guard.ts`) holds the rules, and it registers no hook until a config holds a `guard` entry. The shipped `@gent/checkpoints` registers a hook that always answers `Allow` and captures a turn's start, only in a profile whose cwd is in a git work tree (see `checkpoints.md`).

Files: `domain/interaction.ts` (InteractionPendingError, makeInteractionService), `runtime/extension-host.ts` (ApprovalService), `storage/storage.ts` (InteractionStorage, the pending read seam), `domain/agent-loop.ts` (WaitingForInteraction), `runtime/agent-loop.ts` (respond orchestration).

## Interaction Tools Extension

`@gent/interaction-tools` — `ask_user`, `ask_user_async`, `prompt` and `handoff` tools.

The TUI renders interactions from the typed event feed (`InteractionPresented` etc.) routed by `metadata.type`. Pending interaction storage remains the durable source of truth for crash-safe resume. A branch has at most one open request. A second call that asks in the same step parks on the open one; when the step runs again, it waits until the first call takes its answer (matched by the encoded request), then asks its own question.

`ask_user_async` asks 1–3 questions without the interaction slot and returns at once: each question names the `assume` the model works on until an answer comes, and the result gives each its id (`<toolCallId>:<index>`). It is `interactive`, so a spawned child's non-client turn is not offered it, as it is not offered `ask_user`. The open questions live in `<data dir>/questions/<branchId>.json` (`makeBranchStateStore`; a session delete removes the file). The file holds open rows, and answered rows until their send: an answered question is in the transcript as its answer message, a dismissed one is gone. A replay of the same call, or the same question text asked again, replaces its open row and leaves an answered one as it is; past 8 open questions the oldest drops. Two requests answer during a turn: `questions.open` lists the open rows, and `questions.answer` answers and dismisses them in two writes under the branch file's lock. The first records each answer on its row (`answered: { answer, batch }`, written once and never changed) and removes the dismissed rows; the second (`sendRecordedAnswers`) sends each stored batch as one `Session.send` `"steer"` with `wake: true` and `metadata.customType: "question-answer"` (`details` names each question, its id, assumption and answer), then removes its rows. The steer joins the running turn at its next step, or starts a turn on an idle branch, and it only appends, so the cached prefix stays the same. A batch's `requestId` is `question-answer:` and the SHA-256 of the ids it answers, fixed when it is recorded: a send repeated after a failed removal sends nothing new, and a retry that answers fewer questions adds nothing, so the first answer to each question is the only one the model reads. An id that is not open is skipped. A recorded answer is hidden from the reader, so the send step also runs at each `questions.open` and on `loopOpen`: an answer whose send failed, or that a restart cut short, reaches the model with no new answer from the user. The answer text holds the question, the assumption and the answer, not the id. An answer or a dismiss pulses `State.changed()`. Headless answers nothing: it prints one line per question (`[question <id>: <question> · assuming <assume> · no user, the assumption stands]`), and the row stays open for the TUI.
