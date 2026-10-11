# Kernel orchestration: design

Replaces [tracks-extension.md](tracks-extension.md) (owner, 2026-10-10). The workbox stage 1 of `@gent/tracks` is scrapped unmerged.

## Goal

The owner's loops (implementor and reviewer per unit, verdict-driven rounds, a gate, merges) run in gent with no orchestration extension. gent ships **primitives**; the orchestrator model **composes** them as cell programs, the way `@gent/workflows` are outcome prompts over cell bindings and files. Routing is code the model writes; judgment stays with the model. baton keeps running until stage 5 replaces it.

A track, once every primitive exists:

```js
const impl = await tools.seat.open({
  name: "impl",
  model: "anthropic/claude-opus-5-5",
  effort: "medium",
  cwd: rift,
})
const rev = await tools.seat.open({
  name: "rev",
  model: "openai/gpt-6.1-sol",
  effort: "high",
  cwd: rift,
  account: "default",
})
let work = await tools.seat.turn({ seat: impl.seat, message: `Build round 1: ${spec}` })
for (let round = 1; ; round++) {
  const review = await tools.seat.turn({
    seat: rev.seat,
    message: `Review round ${round}`,
    reply: "verdict: accepted | changes, findings[]",
  })
  if (review.reply?.verdict === "accepted") return review
  if (round === 3) return tools.program.ask({ question: `Stuck after 3 rounds`, context: review })
  work = await tools.seat.turn({
    seat: impl.seat,
    message: `Fix: ${JSON.stringify(review.reply.findings)}`,
  })
}
```

`seat.turn` only resolves inside a durable program (P3). Until P3 lands, the same loop runs one step per cell: `seat.send` returns a round handle, the round's end wakes the orchestrator, and its next cell reads `seat.round` and decides. Both modes share P1 and P2.

## Owner rules this design keeps

- Children wake, never block: no host call holds a turn open for a round. A wait is a durable program's suspension or a wake message.
- Lean core: every primitive is an extension on `@gent/core/extensions/api`, except where core lacks the capability (P4's server-wide permits, P5's credential pin), and then core gains a general verb, not a feature.
- Persisted formats change only additively.
- One concern per file: `seats.ts`, `programs.ts`, each with section banners.
- Child sessions cache 5 minutes unless their agent keeps the session cache: seats are the long-lived case and keep it.
- Ambiguous side effects are never replayed (P3's reattach rule).

## Primitives

### P1. Seats: `@gent/seats`, `packages/extensions/src/seats.ts`

A seat is a durable child session that takes many rounds.

- **Agent `seat`**, registered by the extension: `promptCache: "session"`, and tools that deny `seat.*`, `program.*`, `delegate.*` and `thread.start` (as `CHILD_TOOL_DENIALS` does in `delegate.ts`). Builtin, so every cwd's profile knows it.
- **`seat.open({ name, model, effort?, cwd?, instructions?, tools?, account? })`** returns `{ seat, sessionId, branchId }` at admission. It calls `ctx.Session.create` with `modelId`, `reasoningLevel`, `admission: { agent: "seat", runSpec: { overrides: { systemPromptAddendum, tools } } }`, the cwd, and `requestId: "seat:<toolCallId>"`, which is deterministic inside a cell. It sends no first message. `account` waits for P5. A row goes in `seats`.
- **`seat.send({ seat, message, reply? })`** returns `{ round }` at admission, with `delivery: "turn"`, `commandId: "seat-round:<toolCallId>"` and `completion: "admission"`. A seat runs one round at a time: a send while a round is open is refused, and the refusal names that round. Only the session that opened a seat may send to it.
- **Round end**: a `turnAfter` hook matches `messageId` to an open round's commandId. It records `{ text, reply, interrupted, streamFailed, usage, endedAt }` in `seat_rounds`, then queues `{ delivery: "queue", wake: true, sourceId: "seat-round-end:<round>" }` to the opener's branch with a one-line summary and the round id. `loopOpen` reconciles a round that ended while the server was down, by the same `TurnCompleted` fold delegate's `turnEnd` uses.
- **`seat.round({ round })`** returns the stored result. **`seat.list()`** lists the opener's seats with each seat's open round. **`seat.close({ seat })`** stops an open round and marks the seat closed. The session stays readable.
- Storage: a process Resource owns `seats` and `seat_rounds` (`CREATE TABLE IF NOT EXISTS`, as `exec-tools.ts` does).

### P2. Rounds as values

- **Structured reply**: `seat.send`'s optional `reply` describes the value the round must return. For that round the seat gets the tool `seat.reply({ value })`. Its last call becomes the round's `reply`; a round that ends without one records `reply: null` and says so in the summary. Validate against a JSON Schema only if gent already carries a validator; otherwise store the value as JSON.
- **Usage**: every round records its usage and cost, so a program can budget by them.

### P3. Durable programs: `program.*` (design gate before building)

A program is cell source that runs outside any turn, survives deadlines, worker faults and restarts, and wakes the model only through `program.ask` or when it finishes.

Recommended shape, the survey's option B over option A's journal:

- `program.start({ source, name })` returns a handle at admission. A branch Resource runs the program in its own worker. Its host calls go through a journal, `program_operations`, keyed by a **content key**: tool id, canonical input, and that pair's occurrence number. A content key survives `Promise.all` reordering; reply order does not.
- **Replay**: after a fault or restart, the runner re-evaluates the source from the start. A completed operation answers from the journal and runs nothing. A `Started` operation reattaches only through a tool that declares itself idempotent on its call id (`seat.send`, `seat.open`, `delegate.start`). Any other `Started` operation fails the program with `Interrupted` and wakes the model. Ambiguous effects are never replayed.
- **Determinism**: the program receives a journaled `now()` and `random()`, and the guideline asks for pure code between tool calls. Divergence fails fast, by the existing immutability check: same key, different binding.
- **`seat.turn`** is `seat.send`, then a journaled wait on the round's end. A program waiting on a round holds no turn, and the runner re-arms the wait on `loopOpen`.
- **`program.ask({ question, context })`** queues a wake message to the owning branch and suspends. The model answers with `program.answer({ program, value })`, which resolves the journaled ask on replay. **`program.list`** and **`program.stop`** complete the set.
- **Open question for the gate**: turn-free host authority. Today a host call needs the turn's profile, bindings and the assistant message (the FK). A program needs a host whose bindings come from the branch profile at the time of the call, with receipts keyed to the program rather than to a message.
- **Rejected**: replaying cells in place inside a turn (option A), because it holds the turn for hours, breaking "children wake, never block". The reducer `step(state, event)` (option C) keeps the no-replay rule but is not the natural `await` loop the model writes. It stays the fallback if the gate rejects B.

### P4. Named permits

A server-wide counting limiter, so two gates never run at once across sessions. Today's overload, load 655, is the reason for it.

- Core: `ExtensionContext.Permits.with(name, limit, effect)`, a once-per-server service beside `FileLockService`, with permits released when the scope closes and waiters ordered first in, first out. `permits.list` shows the holders.
- `bash` takes an optional `permit: { name, limit }`, held for the run, background runs included.

### P5. Accounts

- **The `~/.claude2` login lives in the keychain**, under `Claude Code-credentials-<first 8 hex of sha256(config dir)>`. On this laptop that is `-3ef2928b` for `$HOME/.claude2`, and there is no `.credentials.json`. The directory import reads that service on darwin and the file elsewhere. Write-back goes to the same entry.
- **A seat pins its credential slot**: `account` becomes a run override, `credentialSlot`. This is an additive, optional key in `RUN_OVERRIDE_KEYS`, read by the credential order ahead of `authOrder`.

### P6. Workspaces as tools

`workspace.create({ name, from? })` makes a Rift copy and runs the `postcreate` hooks, and `workspace.remove({ name })` removes one: both on `@gent/workspaces`, reusing `locate` and `acquire`. Today Rifts are never removed, and there is no standalone create.

## Stages

Each stage gets a Rift, a branch, the gate, then `/counsel-review`, at most two rounds. Then a merge to `main` by hand.

1. **P1 and P2, step mode.** Done when:
   - the `createRpcHarness` acceptance passes on `LanguageModelLayers.sequence`: open two seats, then send, round end, wake, `seat.round`, a second round with a `reply`, and `seat.close`;
   - a restart in the middle of a round loses no round end;
   - a send to a busy seat is refused;
   - the gate is green.
2. **P5 accounts.** Done when an imported `personal` slot resolves from the keychain service, a seat with `account: "personal"` runs on it, and nothing changes for the default slot. The keychain read is tested with a fake `security` spawner.
3. **P3 design gate, then build.** A design-mode counsel review of P3 comes first. Done when a program survives a server restart in the middle of `seat.turn` with no rerun of a completed round, when an ask wakes the model, and when its answer resumes the program.
4. **P4 and P6.**
5. **The library and baton's retirement.** An `/orchestrate` outcome prompt in `@gent/workflows` and the track program as a cell snippet. One real unit runs end to end, with a Codex pane under baton as a shadow reviewer for the first two units.

## Risks

- R1. Reviewer quality on gent's OpenAI path versus Codex CLI: the shadow run in stage 5 measures it.
- R2. Program determinism: the model writes the program. Divergence must fail loudly and wake the model, never guess.
- R3. Laziness: a branch nobody opens never runs `loopOpen`, so a program waiting on a round must also be re-armed by the round's own wake to its owner.
