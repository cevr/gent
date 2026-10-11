# Kernel orchestration: design

Replaces [tracks-extension.md](tracks-extension.md) (owner, 2026-10-10). The workbox stage 1 of `@gent/tracks` is scrapped unmerged.

## Goal

The owner's loops (an implementor, a reviewer and a verifier per unit, verdict-driven rounds, a gate, merges) run in gent with no orchestration extension. gent ships **primitives**; the orchestrator model **composes** them in the cell kernel, the way `@gent/workflows` are outcome prompts over cell bindings and files. Routing is a state machine the model defines as data; judgment stays with the model. baton keeps running until stage 5 replaces it.

Prime Intellect's Rust rewrite of Prime Agent (2026-10-09, <https://www.primeintellect.ai/blog/prime-agent-rust>) ran this shape with over 2,000 agents:

- a root orchestrator that writes no product code;
- a planner, an implementer in its own worktree, a reviewer on a different model in a separate context, and a verifier that builds and tests in a fresh sandbox;
- failed review or verification goes back to the implementer with the findings; a merge needs both to pass.

They are generalising it into "a factory of finite state machines, so workflows like this one can be defined once, reused, and updated". P3 is that factory.

A track, once every primitive exists:

```js
await tools.machine.define({
  name: "track",
  threads: {
    impl: { model: "anthropic/claude-opus-5-5", effort: "medium" },
    rev: { model: "openai/gpt-6.1-sol", effort: "high" },
  },
  start: "implement",
  states: {
    implement: {
      thread: "impl",
      say: "Implement {{input.spec}}. Fix: {{review.findings}} {{verify.output}}",
      next: "review",
    },
    review: {
      thread: "rev",
      say: "Review {{input.branch}} against {{input.spec}}",
      on: { accepted: "verify", changes: "implement" },
      maxVisits: 4,
      exhausted: "decide",
    },
    verify: { run: "bun run gate", permit: "gate", on: { pass: "decide", fail: "implement" } },
    decide: {
      ask: "Merge {{input.branch}}? Review: {{review}}. Gate: {{verify}}",
      on: { merge: "done", replan: "implement", drop: "done" },
    },
    done: { final: true },
  },
})
const run = await tools.machine.start({ machine: "track", input: { spec, branch, cwd: rift } })
```

The orchestrator starts one run per unit, orders units by their dependencies, and answers `ask` states. Until P3 lands, the same loop runs one step per cell: `thread.send` returns a round handle, the round's end wakes the orchestrator, and its next cell reads `thread.round` and decides. Both modes share P1 and P2.

## Owner rules this design keeps

- Children wake, never block: no host call holds a turn open for a round. A wait is a durable program's suspension or a wake message.
- Lean core: every primitive is an extension on `@gent/core/extensions/api`, except where core lacks the capability (P4's server-wide permits, P5's credential pin), and then core gains a general verb, not a feature.
- Persisted formats change only additively.
- One concern per file: `threads.ts`, `machines.ts`, each with section banners.
- Child sessions cache 5 minutes unless their agent keeps the session cache: worker threads are the long-lived case and keep it.
- Ambiguous side effects are never replayed: a crashed command becomes an `ask` (P3).

## Primitives

### P1. Threads take rounds: `@gent/session-tools` threads, moved to `packages/extensions/src/threads.ts`

The worker primitive is the existing **thread**, improved, not a new "seat" concept (owner, 2026-10-11). A thread already is a child session the starter lists and stops, and its key, the first session's id, survives handoffs. That is what a long-lived worker needs: when its context fills, it hands off and keeps its address. Today a thread is fire-and-forget: it runs as the starter, its replies go to the user, and nothing wakes the starter. It gains:

- **`thread.start({ task?, name?, model?, effort?, cwd?, instructions?, tools?, agent?, notify?, account? })`**. Every new field is optional, and the defaults are today's behaviour.
  - With no `task` it opens a thread and sends nothing (a worker waiting for its first round).
  - `agent` picks a registered agent. gent registers **`worker`**: `promptCache: "session"`, and tools that deny `thread.start`, `thread.stop`, `machine.*` and `delegate.*`. Owner rule: a long-lived seat that waits between turns keeps the session cache.
  - `instructions` becomes the run's `systemPromptAddendum`. The create's `requestId` stays `thread:<toolCallId>`.
- **`thread.send({ thread, message, reply?, notify? })`** returns `{ round }` at admission, addressed by the thread key, so it reaches the thread's current session after a handoff. It uses `delivery: "turn"`, `commandId: "thread-round:<toolCallId>"` and `completion: "admission"`.
  - A thread runs one round at a time.
  - Only the starter's thread may send.
  - A retry under the same request id returns the admitted round before the busy refusal applies.
- **`notify`**:
  - `"user"`, today's default: replies go to the user, and nothing wakes the starter.
  - `"starter"`: the round's end queues `{ delivery: "queue", wake: true, sourceId: "thread-round-end:<round>" }` to the starter with a one-line summary.
  - `"none"`: only through the service, for machines.
- **Round end**: a `turnAfter` hook matches the round's commandId and records `{ text, reply, interrupted, streamFailed, usage, endedAt }` in `thread_rounds`. It publishes the end to the `Threads` service's subscribers, then notifies as the round's mode says. `loopOpen` reconciles a round that ended while the server was down, as delegate's `turnEnd` does.
- **`thread.round({ round })`** reads a result. `thread.list` and `thread.stop` stay, and `stop` also closes an open round.
- **The `Threads` service** (a Tag, as `Workspaces` is) carries `start`, `send({ ..., notify })`, `round`, `stop`, and the round-end subscription, for machines.
- **The running-thread cap** (4) counts threads with an open round, and config can raise it.
- **Delegate folds into threads** in stage 1b (P1b).

### P1b. Delegate folds into threads

A delegate child is a thread: one round on the `delegate` agent, ending with a wake to its starter, and optionally run on a snapshot copy with the parent's history forked in. So `delegate.*` goes, and the thread surface takes the options it alone had:

| `delegate` today                                                   | After the fold                                                                                                                   |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `delegate.start({ task, overrides, isolation: "snapshot", fork })` | `thread.start({ task, agent: "delegate", notify: "starter", workspace: { snapshot: true }, fork: true, model?, effort?, ... })`  |
| `delegate.list` (`completed` is a turn receipt)                    | `thread.list`, with each thread's open and last round                                                                            |
| `delegate.cancel`                                                  | `thread.stop`                                                                                                                    |
| the per-branch JSON registry (`makeBranchStateStore`)              | `thread_rounds`                                                                                                                  |
| `CHILD_TOOL_DENIALS`                                               | the `delegate` agent's tool denials: `thread.start`, `thread.stop`, `machine.*`                                                  |
| 4 unfinished children per branch, and 4 running threads            | one cap: open rounds per starter branch                                                                                          |
| completion message `customType: "child-completion"`                | unchanged: a `notify: "starter"` round end uses the same `customType`, so stored transcripts and the TUI renderer read as before |

- **Persisted format**: the delegate registry files stop being read or written, and their state moves to `thread_rounds`. This is the one non-additive change in the plan, and the owner asked for it (2026-10-11). Personal library, no shims: a delegate child unfinished at the upgrade does not report back, so finish or cancel children before upgrading. Stored sessions, messages and the completion `customType` are untouched.
- **Old transcripts** keep their `delegate.start` calls. A resumed turn re-delivers results from `tool_call_bindings` and never reruns a tool, so they read as before.
- **Commits**, each green on the gate:
  1. threads gain `agent`, `workspace.snapshot`, `fork` and the starter completion, with delegate's tests ported;
  2. `delegate.ts` and its tools go, and core references move (`agent.ts`, `capability.ts`, `message.ts`, `server.ts`, `provider.ts`);
  3. the TUI: `delegate.client.tsx` becomes thread rendering;
  4. prompts and docs: the cell guideline, `@gent/workflows` outcome prompts, the bundled `cost-aware-delegation` reference, the counsel recipe, the gamut testbed, `ARCHITECTURE.md`, `PRIOR_ART.md`, `docs/extensions.md`, `docs/architecture/*`.

### P2. Rounds as values

- **Structured reply**: `thread.send`'s optional `reply` describes the value the round must return. For that round the thread gets the tool `thread.reply({ value })`. Its last call becomes the round's `reply`; a round that ends without one records `reply: null` and says so in the summary. Validate against a JSON Schema only if gent already carries a validator; otherwise store the value as JSON.
- **Usage**: every round records its usage and cost, so a program can budget by them.

### P3. Machines: `@gent/machines`, `packages/extensions/src/machines.ts`

A machine is a state machine defined as data. A host interpreter runs it outside any turn, with persisted state and event-driven steps. Counsel's design gate (2026-10-11, `/tmp/counsel/gent-kernel-orch-6e040dec/20261011-002120-claude-to-codex-df8a77/codex.md`) rejected replaying program source (the earlier option B) for five blockers:

- content keys hide divergence instead of detecting it;
- re-evaluating full Bun source repeats effects outside the journal;
- a call with no owning turn is refused (`ToolRunner`, `packages/core/src/runtime/tools.ts:1100`);
- a round's wake starts an owner model turn, so it cannot double as the program's resume signal;
- an answer keyed only by program cannot reject a stale retry.

A machine avoids each of them:

- **Definition**: plain data, checked by an Effect Schema, with no functions.
  - `threads`: a role name mapped to a P1 thread spec (model, effort, instructions, agent).
  - `states`, each one of four kinds:
    - `thread`: a round on that role's thread. Its `say` template is filled from the run's context, and the round's `thread.reply` value names the transition: `next` must be one of the state's `on` keys.
    - `run`: a command spawned by the extension, optionally under a P4 permit. Exit 0 takes `pass`, anything else `fail`, and its output tail is saved into the context.
    - `ask`: queues a question to the owner with the allowed answers, and waits.
    - `final`.
  - `maxVisits` with `exhausted` caps a loop. `fresh: true` on a thread state starts a new thread for each visit: Prime's verifier, with no memory of earlier rounds.
  - A template reads `{{input.*}}` and `{{<state>.*}}`, the last reply saved under each state's name. There is no expression language: a branch the data cannot express is an `ask`.
  - `machine.define` writes the definition to `.gent/machines/<name>.json` in the project, so machines are defined once, reviewed, reused and edited like code. A run snapshots its definition when it starts.
- **Execution**: state C with no source replay.
  - `machine_runs`: the current state, the context as JSON, visit counts, status, and the pending action.
  - `machine_steps`: an append-only log, from which status and audit read.
  - Before dispatching, a step records its next action. Recovery reads that action's receipt:
    - a thread round recovers by its request id, since P1 makes `thread.send` idempotent on it;
    - a command that was running at a crash is ambiguous and is never rerun: the run moves to `ask` with "interrupted".
- **Authority**: a machine calls no tools. It drives threads through the `Threads` service with `notify: "none"`, so a round's end moves the machine and starts no owner turn. It spawns commands through the platform's `ChildProcessSpawner` in the run's cwd. So it needs no turn-free tool authority, and approvals do not arise. The machine's power is exactly what its states declare.
- **Ask and answer**: `machine.answer({ run, askId, choice, note? })`. The ask is persisted before it is delivered, through an outbox with a deduplicated `sourceId`. An identical retry succeeds; a different answer to the same ask, or an answer to an ask that has moved on, is refused. The answer returns at admission, and the step runs after it.
- **Liveness** (Counsel blocker 4, verified: gent has no server-start hook, and an idle loop is put to sleep after one minute):
  - While a run has an open action it holds the owner branch resident, through `Session.holdResident`.
  - After a restart, the extension activates only its own active runs. That needs one generic core seam, `BranchActivation.activate({ sessionId, branchId })` or an extension start hook. Stage 3's design review picks one. A sweep of every unopened session stays rejected.
- **Tools**: `machine.define`, `machine.start({ machine, input })` (returns `{ run }` at admission), `machine.answer`, `machine.status({ run })`, `machine.list`, `machine.stop`. The owner is woken only by an `ask`, a run reaching `final`, or a run failing.
- **Natural `await` code**: deferred. If the owner wants it later, it compiles to these persisted states, since a snapshot cannot hold an async stack (`cell-value.ts:845`).

### P4. Named permits

A server-wide counting limiter, so two gates never run at once across sessions. Today's overload, load 655, is the reason for it.

- Core: `ExtensionContext.Permits.with(name, limit, effect)`, a once-per-server service beside `FileLockService`, with permits released when the scope closes and waiters ordered first in, first out. `permits.list` shows the holders.
- `bash` takes an optional `permit: { name, limit }`, held for the run, background runs included.

### P5. Accounts

- **The `~/.claude2` login lives in the keychain**, under `Claude Code-credentials-<first 8 hex of sha256(config dir)>`. On this laptop that is `-3ef2928b` for `$HOME/.claude2`, and there is no `.credentials.json`. The directory import reads that service on darwin and the file elsewhere. Write-back goes to the same entry.
- **A thread pins its credential slot**: `account` becomes a run override, `credentialSlot`. This is an additive, optional key in `RUN_OVERRIDE_KEYS`, read by the credential order ahead of `authOrder`.

### P6. A thread binds its workspace at start

`thread.start({ workspace: { rift: { from?, name } } | { path } })` makes or attaches the copy, runs its `postcreate` hooks, and binds the thread to it before the agent starts. `thread.stop({ thread, removeWorkspace? })` removes a Rift copy it made. Both reuse `@gent/workspaces` `locate` and `acquire`. This follows T3's `t3_thread_launch` `workspaceStrategy`: a worktree made from inside the task prompt does not move the binding. Today Rifts are never removed, and there is no standalone create.

## Compared with T3 Code orchestration V2 (pingdotgg/t3code `5f7294d4`, docs/orchestration-v2)

- **Taken from T3**:
  - the workspace is bound at start (P6);
  - reviewers and verifiers default to `fresh` in machines, with a findings ledger carried in the context. T3 starts a new `delegate_task` each review round, Prime separates verification from the generator, and a reviewer's input is mostly a new diff each round, so a fresh reviewer loses little cache;
  - round messages carry provenance metadata (an agent wrote them), as T3's `creationSource` does.
- **Not taken**:
  - blocking `wait` modes, which break "children wake, never block";
  - caller-supplied `clientRequestId`, since gent derives ids from the tool call;
  - routing as model turns, the cost machines remove.
- **Native harnesses, not taken**: T3 drives each vendor's own harness (Claude through the Agent SDK, Codex through its app server). gent is the harness (owner, 2026-10-11), so every worker runs on gent's own drivers.
- **Where gent is ahead**:
  - state machines;
  - an outbox from day one (T3 tracks it as a follow-up);
  - derived idempotency on every verb (T3's launch has no retry key);
  - structured round replies;
  - a thread key that survives handoffs.

## Stages

Each stage gets a Rift, a branch, the gate, then `/counsel-review`, at most two rounds. Then a merge to `main` by hand.

1. **P1 and P2, step mode.** Done when:
   - the `createRpcHarness` acceptance passes on `LanguageModelLayers.sequence`: start two worker threads, then send, round end, wake, `thread.round`, a second round with a `reply`, and `thread.stop`;
   - a restart in the middle of a round loses no round end;
   - a send to a busy thread is refused, and a retried send returns its round; a round reaches the thread's new session after a handoff;
   - the gate is green.
     1b. **P1b, the delegate fold.** Done when every ported delegate test passes on threads, `git grep -E 'delegate\.(start|list|cancel)'` finds only plans, research and stored-transcript fixtures, and the gate is green.
2. **P5 accounts.** Done when an imported `personal` slot resolves from the keychain service, a thread with `account: "personal"` runs on it, and nothing changes for the default slot. The keychain read is tested with a fake `security` spawner.
3. **P3 machines.** A design-mode counsel review of the core activation seam and the schema comes first. Done when:
   - a track machine runs implement, review with changes, implement, review accepted, verify and decide on fake models, with no owner turn between rounds;
   - a server restart in the middle of a round reruns no completed round, and the run continues once activated;
   - a command interrupted by a crash moves the run to `ask`;
   - a stale or conflicting answer is refused.
4. **P4 permits and P6 workspace binding.**
5. **The library and baton's retirement.** An `/orchestrate` outcome prompt in `@gent/workflows` and the track program as a cell snippet. One real unit runs end to end.

## Risks

- R1. Reviewer quality is gent's to improve. When the first real units show a reviewer missing a Blocker the owner catches, the fix goes into gent: the `worker` agent's prompt, its tools, or the model and effort settings.
- R2. Expressiveness: a data machine cannot express every branch. The escape is an `ask` to the orchestrator, which costs a model turn. Watch how often real runs take it.
- R3. Liveness after a restart depends on the core activation seam (P3). Until it lands, a run resumes when its owner's loop next opens.
