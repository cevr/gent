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
- Persisted formats: this plan is exempt, with no compatibility kept (owner, 2026-10-11; see P1b).
- One concern per file: `threads.ts`, `machines.ts`, each with section banners.
- Child sessions cache 5 minutes unless their agent keeps the session cache: worker threads are the long-lived case and keep it.
- Ambiguous side effects are never replayed: a crashed command becomes an `ask` (P3).

## Primitives

### P1. Threads take rounds: `@gent/session-tools` threads, moved to `packages/extensions/src/threads.ts`

The worker primitive is the existing **thread**, improved, not a new "seat" concept (owner, 2026-10-11). A thread already is a child session the starter lists and stops, and its key, the first session's id, survives handoffs. That is what a long-lived worker needs: when its context fills, it hands off and keeps its address. Today a thread is fire-and-forget: it runs as the starter, its replies go to the user, and nothing wakes the starter. It gains:

- **`thread.start({ task?, name?, model?, effort?, cwd?, instructions?, tools?, agent?, notify?, account? })`**. Defaults are chosen for the cleanest surface; today's behaviour need not survive (no compatibility, see P1b).
  - With no `task` it opens a thread and sends nothing (a worker waiting for its first round).
  - `agent` picks a registered agent. gent registers **`worker`**: `promptCache: "session"`, and tools that deny `thread.start`, `thread.stop`, `machine.*` and `delegate.*`. Owner rule: a long-lived seat that waits between turns keeps the session cache.
  - The `worker` agent's first request is lean: its own tool list and a short system prompt, with no user-level instructions, skills index or MCP tools it does not use. Measured in Claude Code (vperf2, 2026-10-20): the lean `orchestrate-worker` agent starts at a 37k-token floor against 79k for a full-harness agent. A worker's context is the harness's largest repeated cost, so stage 1's acceptance gains a check: the `worker` agent's first request is under 20k tokens (guess for the target), read from the round's recorded usage. Measured in gent (2026-10-21, the capture preload of `docs/architecture/efficiency.md`, no paid call): a `worker` thread's first request is 16.3 KB in an empty directory and 38.1 KB in the gent checkout, about 4k and 9.5k tokens (inferred at 4 bytes a token). It holds one tool (`cell`, 308 B), a 12.4 KB cell and session prompt, and the project's `AGENTS.md` (21.5 KB here). The target holds. Found in the same run: a headless `--model` does not reach a `worker` thread, which fails with `No model is set for agent "worker"` unless `thread.start` names a model or the config sets one.
  - `instructions` becomes the run's `systemPromptAddendum`. The create's `requestId` is `thread:` and a SHA-256 digest of the calling session, branch and tool call id: a request id is matched across the workspace, and a tool call id is unique only in its session.
- **`thread.send({ thread, message, reply?, notify? })`** returns `{ round }` at admission, addressed by the thread key, so it reaches the thread's current session after a handoff. It uses `delivery: "turn"`, `commandId: "thread-round:<toolCallId>"` and `completion: "admission"`.
  - A thread runs one round at a time.
  - Only the starter's thread may send.
  - A retry under the same request id returns the admitted round before the busy refusal applies.
- **`notify`**:
  - `"user"`, today's default: replies go to the user, and nothing wakes the starter.
  - `"starter"`: the round's end queues `{ delivery: "queue", wake: true, sourceId: "thread-round-end:<round>" }` to the starter with a one-line summary.
  - `"none"`: only through the service, for machines.
- **Round end**: a `turnAfter` hook matches the round's commandId and records `{ text, reply, interrupted, streamFailed, usage, endedAt }` in `thread_rounds`. It publishes the end to the `Threads` service's subscribers (one feed per server: the threads' resource is a server-scope resource, `defineResource({ scope: "server" })`, shared by every place), then notifies as the round's mode says. A send that fails releases its round only on the thread's refusal (`FollowUpQueueFull`); any other failure keeps it for its turn's end or a later re-send. `loopOpen` reconciles a round that ended while the server was down, as delegate's `turnEnd` does.
- **`thread.round({ round })`** reads a result. `thread.list` and `thread.stop` stay, and `stop` also closes an open round.
- **The `Threads` service** (a Tag, as `Workspaces` is) carries `start`, `send({ ..., notify })`, `round`, `stop`, and the round-end subscription, for machines.
- **The running-thread cap** (4) counts threads with an open round, and config can raise it: `threads.maxRunning` in the user's own `~/.gent/config.json` (a project file cannot spend the user's money).
- **Delegate folds into threads** in stage 1b (P1b).

### P1b. Delegate folds into threads

A delegate child is a thread: one round on the `delegate` agent, ending with a wake to its starter, and optionally run on a snapshot copy with the parent's history forked in. So `delegate.*` goes, and the thread surface takes the options it alone had:

| `delegate` today                                                   | After the fold                                                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `delegate.start({ task, overrides, isolation: "snapshot", fork })` | `thread.start({ task, agent: "delegate", notify: "starter", workspace: { snapshot: true }, fork: true, model?, effort?, ... })` |
| `delegate.list` (`completed` is a turn receipt)                    | `thread.list`, with each thread's open and last round                                                                           |
| `delegate.cancel`                                                  | `thread.stop`                                                                                                                   |
| the per-branch JSON registry (`makeBranchStateStore`)              | `thread_rounds`                                                                                                                 |
| `CHILD_TOOL_DENIALS`                                               | the `delegate` agent's tool denials: `thread.start`, `thread.stop`, `machine.*`                                                 |
| 4 unfinished children per branch, and 4 running threads            | one cap: open rounds per starter branch                                                                                         |
| completion message `customType: "child-completion"`                | `customType: "thread-round-end"`, one renderer for every round end                                                              |

- **No compatibility** (owner, 2026-10-11: gent has had little use). Registry files, tool names, `customType`s and thread defaults change freely, with no migration, shim or fallback renderer. This plan is exempt from the owner rule on additive-only persisted formats.
- **Commits**, each green on the gate:
  1. threads gain `agent`, `workspace.snapshot`, `fork` and the starter completion, with delegate's tests ported;
  2. `delegate.ts` and its tools go, and core references move (`agent.ts`, `capability.ts`, `message.ts`, `server.ts`, `provider.ts`);
  3. the TUI: `delegate.client.tsx` becomes thread rendering;
  4. prompts and docs: the cell guideline, `@gent/workflows` outcome prompts, the bundled `cost-aware-delegation` reference, the counsel recipe, the gamut testbed, `ARCHITECTURE.md`, `PRIOR_ART.md`, `docs/extensions.md`, `docs/architecture/*`.

### P2. Rounds as values

- **Structured reply**: `thread.send`'s optional `reply` describes the value the round must return. The thread answers with the tool `thread.reply({ value })`. The tool is offered to every agent at all times, not only during a round that asks: a tool list that changed per round would change the request's tools and break the thread's cached prompt, so the tool stays and refuses a call when no open round on the caller's branch asked for a value. Its last call becomes the round's `reply`; a round that ends without one records `reply: null` and says so in the summary. Validate against a JSON Schema only if gent already carries a validator; otherwise store the value as JSON.
- **Usage**: every round records its usage and cost, so a program can budget by them. Usage keeps the token classes apart (input, output, cache read, cache write) and the cache-read share, since the owner's target is "99.9% cache reads" (2026-10-20). A round's usage is also its fuel (P5b), counted as lanes counts it.

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
- **Status without asking.** The owner asked for status 13 times in one bible-tools run, and the Claude Code orchestrate runs got a status mod for the same reason (dotfiles `claude/mods/status`: the pool and each run's active units on the status line). gent shows it as data, not a model turn: a TUI band with the pool's free lanes (P5b) and each active run's state, round and age, from `machine.list`; and a control CLI, `gent ctl status|runs|stop|answer`, over the same RPC, so a script or another host reads a run with no session open.
- **A quota death is a wait.** A worker that dies at a usage limit gives no verdict (the skill's `stuck(quota)`). The run keeps its state and moves to a wait until the account's reset (`retryAt` from P5b), then reruns the step fresh. It never counts toward `maxVisits`.
- **Natural `await` code**: deferred. If the owner wants it later, it compiles to these persisted states, since a snapshot cannot hold an async stack (`cell-value.ts:845`).

### P4. Named permits

A server-wide counting limiter, so two gates never run at once across sessions. Today's overload, load 655, is the reason for it.

- Core: `ExtensionContext.Permits.with(name, limit, effect)`, a once-per-server service beside `FileLockService`, with permits released when the scope closes and waiters ordered first in, first out. `permits.list` shows the holders.
- `bash` takes an optional `permit: { name, limit }`, held for the run, background runs included.

### P5. Accounts

- **A run spec pins one credential slot** (`RunSpec.credentialSlot`, not a stored run override): the turn, its handoff summary and its no-agent child walk only that slot, and a refused pin fails the turn. `thread.start` takes an `account`.
- **A named Anthropic credential links a Claude Code config directory**: its keychain service `Claude Code-credentials-<first 8 hex of sha256(config dir)>` on macOS (`-3ef2928b` for `$HOME/.claude2` on this laptop), its `.credentials.json` elsewhere. Each refresh is written back with compare-and-swap, and gent's credential store holds the rotation until it lands.

### P5b. Lanes in gent: the pool decides before a thread starts

gent needs no proxy: it is its own harness, and its providers already spread turns across accounts (stage 0). lanes ([lanes.md](lanes.md), a separate repo, `cevr/lanes`) is the proxy for Claude Code, which gent cannot control (owner, 2026-10-21). gent takes lanes' ideas into its own account spread:

- **Admission before start.** A proxy can refuse a request only after the agent has started, and that is how agents died in the vperf2 runs. So `thread.start` and a machine's `thread` state ask the account spread for a lane first, and get `LaneUnavailable{ retryAt, free, reason }` at free 0. The thread fails at admission with that error; a machine waits until `retryAt`. The lane is released when the thread's round ends or the thread stops. In Claude Code the same check is a `PreToolUse` hook on `Agent` (dotfiles `claude/hooks/guard-agent.ts`, on `budget.ts` today; lanes P4 later).
- **Fuel, not agent counts.** A lane is sized by fuel (lanes amendment r3): tokens weighted by class and model, with a learned fuel-per-percent rate for each quota window, from each response's usage and the utilization headers the drivers already read. `lanes = floor(min over windows of sustainable)`. One bridge reading (2026-10-20, measured): about 3.4 M fuel per agent-hour, cache reads half of it; seven accounts give about 250 agent-hours a week. So every saving in a worker's context (P1) and in cache misses (P2) is a lane gained.
- **Logins stay fresh.** gent's credential store (P5) refreshes each account ahead of expiry with one call in flight and writes the token back before use (lanes §3.2), so an idle account never needs a new login.
- **Shared accounts.** gent and Claude Code (through lanes) spend from the same accounts. Each sees the other only as utilization that moves with no fuel of its own: lanes' outside spend. Both read the headers, so the free count stays right, and the fuel fit drops outside segments.

#### P5b design (2026-10-21)

Two independent sketches (Claude, Codex) against `27a38b795`, kept in the session scratchpad as `p5b-sketch-claude.md` and `p5b-sketch-codex.md`. Both found that the drivers read no utilization header today (`anthropic.ts:3036-3039` says the plan's reset headers are not read), so the plan's "the drivers already read" was wrong. Decisions:

- **Owner:** core `CredentialPlacement`, the one module that sees every turn on every account. A new `ExtensionContext.Accounts` facade (`admit`, `lanes`), wired in all three composition roots, so a user extension admits as threads do. Threads admit inside `admitRound`; machines reach it only through `Threads`. `threads.maxRunning` stays.
- **A refused start leaves nothing:** no session, snapshot or round (Codex). The order inside `admitRound` is the implementor's, under that test.
- **Readings:** one widened per-step driver reporter (`ProviderStopReason` → `ProviderReport { stopReason, quota }`), not a second service. Anthropic OAuth decodes `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset,status}` (names from [lanes.md](lanes.md):54) on every 2xx and 429. A live header capture on a scratch `GENT_DATA_DIR` comes before the decoder. OpenAI waits for its names.
- **Fuel:** list-price cost from `calculateCost`, scaled so one reference input token is one fuel; class and model ratios are the r3 prior. Unknown usage is unknown, never zero. Class token sums are stored for a later weight fit.
- **Capacity:** per account, the minimum over its windows, then summed over the pool (Codex: a pooled minimum alone invents a lane when account A has only weekly room and B only 5-hour room). No reading yet means `capacity: none`: admission passes and only the cap binds.
- **Holding a lane (Claude):** nothing durable holds one. A lane is a session whose turn is open on the provider, plus an in-memory reservation from admission to that turn's start. A SIGKILL clears both; a resumed turn counts again when its loop opens (closing the gap the Claude sketch calls R-e). Durable leases with a reaper were rejected: a lease leaks until its TTL, and the turn is already the durable truth.
- **Release before the round end is heard:** `placement.release` moves ahead of `emitTurnAfter` in `finalizeTurn` and `completeFailedTurn`; the `onExit` release stays as a backstop. Today `turnAfter` publishes the round end while the lane is still held (`turn.ts:5482` vs `:6561`).
- **The lane does not pick the account.** Stage 0 still places at the first request, cache-aware; a `rejected` reading holds that account in placement.
- **Persistence:** the server-wide ledger `credential-usage.json` gains optional `segments`, `readings` and `burn`; an old file decodes with none, and an old binary drops them.
- **Machines:** a refused lane or a quota death writes `Waiting{ state, until, reason }` and `Round.notBefore`, arms `Session.wakeAt`, drops residency while waiting, and spends no visit. Threads stores the round's `retryAt` (additive migration).
- **Surfaces:** a core `accounts.lanes` RPC; `gent ctl lanes` (a core noun, no session); a below-input band with free lanes and each active run.
- **Commits:** (1) readings, fuel per percent, `accounts.lanes` reported but not enforced; (2) `Accounts.admit`, `LaneUnavailable`, the early release, threads admission; (3) machine waits; (4) band and `gent ctl lanes`. Review after 2 and after 4.

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

## Status (2026-10-21)

- **Merged:** stage 0 (account spread, `a690a2f85`, 2026-10-17: one review round, fix `ba6392700`), stage 1 (`540190243` and its fixes), stage 1b (`bffe148f5`), stage 2 (`e154a0db3`, `cf8526afe`), stage 3 (machines, `637ab3cad`..`722f913fb`, 2026-10-21).
- **Stage 3 receipts:** the facts, probes and Codex rounds are in [machines-design.md](machines-design.md) ("Commit 5 facts"). Durable branch wakes (`@gent/wake`), deferred recovery, typed thread refusals and a recorded command process are in core and extensions; four e2e tests SIGKILL a host and count executions in files outside SQLite. The restart test found a gent startup defect: the agent-loop actor registered after the cluster's first storage read, so a cut turn with no client call waited for the 10 s poll. The actor layer now polls once after registration (`722f913fb`). Effect's `registerEntity` does not reopen the storage-read latch; filed upstream as Effect-TS/effect#9717.
- **Open from stage 3:** the headless `--model` does not reach a worker thread (a worker started from `gent -H` needs `model` in `thread.start`).
- **Stage 0 review fixes:** a pool keeps in step with its order on rename and removal; a pool must be inside its order, or that sign-in fails; a rate limit or unsupported model holds the account for that model only; handoff summaries count toward load; `CredentialPlacement` is a required service in every root; the ledger stores session ids, so a restart counts a session once; nothing is written unless a sign-in spreads. Skipped: marking a session live at dispatch (a burst must see each earlier placement).
- **baton is gone** (not installed). The `orchestrate` skill now routes Claude Code and Codex background agents, and its machine has moved past this plan's `track` example: a `plan` state with a planner, a `stuck` verdict, a failure cap of 3 that sends the unit to `decide` for a rewrite, and a dead worker (usage limit, no hand-back, empty review) that gives no verdict. Stage 3's schema and stage 5's target follow the skill, not baton.
- **Orchestrate skill rules since 2026-10-21** (dotfiles `a1ab5bb`), which stage 5's machine takes over: the plan names what the owner opens after round 1; bulk model work with no tools runs as a Batch API script, not as agents; a sketch unit (one sketch per model family) comes before a new seam; integrate is green only when the pushed commit's CI is green, and nothing else merges while main is red (gent's own CI was red from 2026-09-25 to 2026-10-18 while merges went on); a spike's verdict goes into `NORTH_STAR.md`, `PRIOR_ART.md` Settled or an ADR.
- **Shared seam:** the warm pre-lapse handoff (compute a handoff before the prompt cache lapses on an idle branch) needs what P3 liveness needs: wake a passivated branch at a time, or after a restart, with no user message. Stage 3's design review designs one core verb for both.

## Stages

0. **Land account spread.** Done 2026-10-17 at `a690a2f85`.

Each stage gets a Rift, a branch, the gate, then `/counsel-review`, at most two rounds. Then a merge to `main` by hand.

1. **P1 and P2, step mode.** Done when:
   - the `createRpcHarness` acceptance passes on `LanguageModelLayers.sequence`: start two worker threads, then send, round end, wake, `thread.round`, a second round with a `reply`, and `thread.stop`;
   - a restart in the middle of a round loses no round end;
   - a send to a busy thread is refused, and a retried send returns its round; a round reaches the thread's new session after a handoff;
   - the gate is green.
     1b. **P1b, the delegate fold.** Done when every ported delegate test passes on threads, `git grep -E 'delegate\.(start|list|cancel)'` finds only plans, research and stored-transcript fixtures, and the gate is green.
2. **P5 accounts: pin + linked directories + thread account.** Done when a linked `personal` slot resolves from its directory's keychain service, a thread with `account: "personal"` runs on it, and nothing changes for the default slot. The keychain read is tested with a fake `security` spawner.
3. **P3 machines.** Done 2026-10-21 at `722f913fb`. A design-mode counsel review of the core activation seam and the schema comes first. Done when:
   - a track machine runs implement, review with changes, implement, review accepted, verify and decide on fake models, with no owner turn between rounds;
   - a server restart in the middle of a round reruns no completed round, and the run continues once activated;
   - a command interrupted by a crash moves the run to `ask`;
   - a stale or conflicting answer is refused.
4. **P4 permits and P6 workspace binding.** P4 also holds a `main-red` permit: integrate takes it while the pushed commit's CI runs, and a red result keeps it until a fix is green.
   4b. **P5b lanes in the account spread.** Done when a thread start at free 0 fails at admission with `LaneUnavailable`, a machine waits until `retryAt` and then runs the step, a lane is released at round end, the account spread reports fuel per percent for each window, and the TUI band shows free lanes.
5. **The library.** An `/orchestrate` outcome prompt in `@gent/workflows`, and the `orchestrate` skill's machine (plan, implement, review, verify, decide) as a machine definition. One real unit runs end to end in gent, with no Claude Code or Codex background agent.

## Risks

- R1. Reviewer quality is gent's to improve. When the first real units show a reviewer missing a Blocker the owner catches, the fix goes into gent: the `worker` agent's prompt, its tools, or the model and effort settings.
- R2. Expressiveness: a data machine cannot express every branch. The escape is an `ask` to the orchestrator, which costs a model turn. Watch how often real runs take it.
- R3. Liveness after a restart depends on the core activation seam (P3). Until it lands, a run resumes when its owner's loop next opens.
- R4. Bulk work through threads. bible-tools ran about 600 full-harness page-reader agents for work that needed no tools. A thread is the wrong primitive for that: a cell's model call, or a batch job, does it at a fraction of the context. Watch for machines whose `thread` states call no tools.
- R5. Two pools on one set of accounts. gent's account spread and lanes each see the other as outside spend, so a burst from both at once can overrun an account until the headers catch up. Watch for 429s that neither pool predicted.
