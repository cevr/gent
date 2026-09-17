# gent agent loop — architecture review (read-only)

Scope: `packages/core/src/runtime/agent/`, 8,368 lines, 28 files.
Repo: `/Users/cvr/Developer/personal/.rifts/gent/loop-architecture` at `1c3322ce`.
Goal: simpler, less code, more scannable, every capability kept.
Rules: effect-native, actor model, lean core, fully extensible.

## Standing refusals honored

The 2026-09-15 ledger forbids re-proposing extraction of the replay/resume path
(`plans/architecture-loop-2026-09-15.md:1032-1049`): the region reads `scope`
ten times and six closure locals, so extraction threads dependencies back as
parameters, which the no-context-params rule forbids. That is a failed deletion
test and a future pass must not re-propose it.

The 2026-09-17 ledger rejects L7 (process-local result cache), L10 (admission
encoded four ways), L12 (`systemPrompt` hook), L13 (child result built twice).

Every candidate below is in-place dedup or shape change inside the existing
closure. None proposes a new module, except #12, which follows two independent
prior-art implementations rather than inventing a seam.

## Where the weight is

The directory is not uniformly bloated. `turn-window.ts` (193 lines, one
export), `branch-tool-feature.ts` (89, binds three things that only work
together), `turn-interruption.ts` (86), and `turn-ledger.ts` (83) are genuinely
deep modules. C17 in the prior ledger already carved `turn-source.ts` and
`turn-window.ts` out of the factory, and both have direct unit tests.

Weight sits in three files, 38% of the directory:

| File                           | Lines | Comment lines |
| ------------------------------ | ----- | ------------- |
| `agent-loop.turn-execution.ts` | 1,426 | 148 (10%)     |
| `agent-loop.actor.ts`          | 946   | 167 (17%)     |
| `agent-loop.behavior.ts`       | 826   | 79 (9%)       |

`agent-loop.turn-execution.ts` is the gravity well: one closure at
`:199-1426` holding 20 mutually-referencing helpers behind a one-method
interface (`runTurn`). It is the single production consumer of `turn-source.ts`,
`turn-tool-execution.ts`, and most of `agent-loop.utils.ts`.

## Ranked candidates

### 1. Step address re-derived 13 times — low risk, ~35 lines

Files: `agent-loop.turn-execution.ts:334, 439, 452, 469, 489, 517, 518, 579,
679, 680, 1049, 1282`.

Problem: `(messageId, step)` is threaded as two parameters and expanded into the
same two message ids at 13 sites. `assistantMessageIdForTurn` is called 11
times, `toolResultMessageIdForTurn` 6 times, mostly adjacent:

```
:334  const toolResultMessageId = toolResultMessageIdForTurn(params.messageId, params.step)
:335  const assistantMessageId  = assistantMessageIdForTurn(params.messageId, params.step)
:517  assistantMessageId:  assistantMessageIdForTurn(params.messageId, step),
:518  toolResultMessageId: toolResultMessageIdForTurn(params.messageId, step),
:679  toolResultMessageId: toolResultMessageIdForTurn(params.messageId, responseStep),
:680  assistantMessageId:  assistantMessageIdForTurn(params.messageId, responseStep),
```

Change: one `stepAddress(messageId, step)` returning
`{ assistant, toolResult }`. Pass the address value, not the pair. The three
call sites that use a different step (`responseStep`, `pendingStep`) become
visibly different instead of silently so.

Risk: low. Pure renaming of a derived value; no behavior touched.

Proving test: `tests/runtime/agent-loop/turn-resume.test.ts`,
`tool-outcome-recording.test.ts`. Both assert on the exact derived ids.

### 2. `resolveTurnContext` called with a byte-identical argument object twice — low risk, ~14 lines

Files: `agent-loop.turn-execution.ts:849-856` and `:1165-1172`.

Problem: the two calls are character-for-character identical — same six fields,
same order, same sources (`params.state`, `scope`, `params.turnProfile`):

```
resolveTurnContext({
  agentOverride: params.state.agentOverride,
  runSpec:       params.state.runSpec,
  branchId:      scope.branchId,
  sessionId:     scope.sessionId,
  baseSections:  params.turnProfile.turnBaseSections,
  interactive:   params.state.interactive,
})
```

`resolveTurnContext` has exactly two production call sites repo-wide, and both
are these.

Change: one closure local `resolveForState(state, turnProfile)`. The two callers
(`resolveReplayHostBindings`, `runTurnStep`) then differ only in what they do
with the result, which is the actual difference between them.

Risk: low. Identical inputs cannot diverge.

Proving test: `tests/runtime/agent-loop-max-steps.test.ts:142` pins the
unknown-agent path where the function returns `undefined` after publishing
`ErrorOccurred`; `agent-loop/interactions.test.ts` covers the replay caller.

### 3. Actor lifecycle is three Refs kept consistent by hand — med risk, ~45 lines

Files: `agent-loop.actor.ts:263` (`closed`), `:300` (`handleRef`), `:301`
(`startupExitRef`), written at `:307-308, 582, 590-591, 625, 631`, read together
at `:648-663`.

Problem: three Refs encode one lifecycle state. They are always read together
under `startupSemaphore`, and correctness depends on a hand-maintained write
order that only a comment enforces:

```
:625  yield* Ref.set(startupExitRef, Option.some(exit))
:627  // `startupExitRef` are visible. `ensureStarted` reads `closed`
:631  yield* Ref.set(closed, false)      // flipped LAST, deliberately
```

Three comment blocks totalling ~25 lines (`:292-299`, `:430-437`, `:640-647`)
exist to explain which combinations are legal and why the order matters. The
illegal states are representable; only prose prevents them.

Change: one `Ref<LoopLifecycle>` as a tagged union —
`Closed` / `Open{handle}` / `Failed{cause}`. A single atomic write replaces the
ordered triple. `ensureStarted` becomes a match. The ordering comments become
unrepresentable states and delete themselves.

Risk: med. Touches the startup and rebuild path. Deserves its own commit.

Proving test: `tests/runtime/agent-loop/recovery-race.test.ts` (the suite that
exists because of this exact race), `actor-command.test.ts`,
`turn-lifetime.test.ts`.

### 4. `Object.assign` conditional-field building — low risk, ~22 lines

Files: `agent-loop.turn-execution.ts:767-784` (`completionFields`), `:815-828`
(`wideEventFields`); also `agent-loop.state.ts:147`, `agent-loop.behavior.ts:229`.

Problem: four blocks build optional schema fields by mutation, because
`TurnCompleted` declares them `Schema.optional` (`domain/event.ts:123, 125, 133,
138`):

```
if (params.turnInterrupted) { Object.assign(completionFields, { interrupted: true }) }
if (params.unanswered)      { Object.assign(completionFields, { unanswered: true }) }
if (metrics.steps > 0 && metrics.usageKnown) { Object.assign(completionFields, { usage: ... }) }
```

Change: `omitUndefined` already exists at `domain/guards.ts:42` and is already
used for exactly this in `turn-resolve.ts:71`. Build the object once, filter it
once. Twenty-two lines become roughly eight, and the fields become visible in
one literal rather than assembled across a page.

Risk: low. `omitUndefined` is the established idiom in this codebase.

Proving test: `tests/runtime/agent-loop/session-metrics-fold.test.ts`,
`agent-loop-empty-final-step.test.ts` (which exists because a missing
`unanswered` flag made `gent -H` exit 0 having printed nothing).

### 5. `executeToolsWithInteraction` wraps its only caller — low risk, ~23 lines

Files: `agent-loop.turn-execution.ts:713-725` (wrapper), `:323-331`
(`executeTools`, whose sole call site is `:722`).

Problem: a pass-through that restates the 7-field parameter type verbatim and
adds two pipe stages:

```
const executeToolsWithInteraction = (params: { /* 7 fields, retyped */ }) =>
  executeTools(params).pipe(
    Effect.as(Option.none<ToolInteractionPending>()),
    Effect.catchIf(Schema.is(ToolInteractionPending), (pending) => Effect.succeedSome(pending)),
  )
```

`executeTools` has exactly one caller: this wrapper. The parameter type is
written twice for one path.

Change: fold the `catchIf` into `executeTools` and delete the wrapper. Both real
callers (`:1063`, `:1270`) already want the `Option` shape.

Risk: low. One call path, one shape.

Proving test: `tests/runtime/agent-loop/interactions.test.ts` (the pending
interaction path), `tests/runtime/tool-runner.test.ts:183`.

### 6. Eight identical error-mapping blocks — low risk, ~30 lines

Files: `agent-loop.entity-id.ts:83`, `agent-loop.behavior.ts:181, 600`,
`agent-loop.actor.ts:538, 693, 748`, `agent-loop.turn-execution.ts:1007, 1339`.

Problem: eight sites repeat the same shape, most spread over 4-6 lines:

```
Effect.mapError((cause) => new AgentLoopError({ message: "...", cause }))
```

Change: one `asAgentLoopError(message)` helper. The precedent is in this same
directory — `agent-runner.ts:62-66` already defines `toAgentRunError` /
`asAgentRunError` for exactly this, and uses it as a trailing `Effect.fn`
argument at seven call sites.

Risk: low. Error type and message text unchanged at every site.

Proving test: any loop test. Failures stay typed identically; `AgentLoopError`
is matched by `Schema.is` at `agent-loop.actor.ts:158, 277` and
`agent-loop.behavior.ts:485`.

### 7. History-explaining comments — low risk, ~35 lines

Files: `agent-loop.actor.ts:292-299, 430-437, 640-647`;
`agent-loop.behavior.ts:470, 495, 529`; `agent-loop.state.ts:313-314, 499-503`;
`agent-loop.actor.ts:4-7, 20`.

Problem: roughly 35 lines narrate refactor history rather than current
behavior — "were plain `let` bindings before C13.1", "Replaces the
per-(sessionId, branchId) hand-rolled fiber map", "Replaces the `effect-machine`
`State()` / `Machine` driver from pre-", "Stand-in for the legacy
`service.queueFollowUp`", "(C5.2 counsel)". `agent-loop.actor.ts` is 17%
comments, the highest in the directory.

This also violates the project's own rule: active source should describe product
behavior, not migration history.

Change: delete the archaeology, keep the invariant sentences. Candidate 3 makes
most of the `actor.ts` blocks moot, so do it after.

Risk: low. Comments only.

Proving test: none needed.

### 8. Three exports with one in-directory caller each — low risk, ~3 lines

Files: `agent-loop.utils.ts:77` (`continuationMessageIdForTurn`), `:87`
(`finalStepMessageIdForTurn`), `:93` (`toolCallsFromMessage`).

Problem: each has exactly one call site, all inside
`agent-loop.turn-execution.ts` (`:1136`, `:1208`, `:902` and `:931`). Zero
external production consumers, zero test hits. `agent-loop.utils.ts` as a whole
has no production importer outside this directory.

Change: strip `export`. Per the established practice, demote in bulk and let the
compiler adjudicate: typecheck names any real consumer, lint names the truly
dead.

Risk: low.

Proving test: `bun run typecheck` plus `bun run lint`.

### 9. `staticToolEntries` exported for one sibling call — low risk, ~2 lines

Files: `tool-runner.ts:247` (definition), `:270` (internal self-call);
sole external caller `turn-resolve.ts:173`.

Problem: four references repo-wide. Zero tests, zero apps, zero other packages.
The `export` exists to serve one call from a sibling file in the same directory.

Change: drop the `export` and move the function beside its caller, or keep it in
place unexported if the self-call at `:270` justifies the location.

Risk: low.

Proving test: `bun run typecheck`.

### 10. `ToolRunner.Test` is reachable only from tests — med risk, ~9 lines

Files: `tool-runner.ts:421-429` (`static Test`), `:383-398` (`runTestTool`).

Problem: 36 references. Thirty-four are test files; the two in `src/` are
`test-utils/extension-harness.ts:68` and `test-utils/e2e-layer.ts:171`, both
test infrastructure. No product code reaches it.

The project rule says: every service exposes a `Live` layer; add a `Test` layer
only when there is a real alternative implementation worth a Tag. `runTestTool`
publishes started/completed events and returns a `null` result — a stub, not an
alternative implementation.

Change: move to `test-utils`, or accept it and add a guard so the next pass does
not re-litigate.

Risk: med. Thirty-four test sites use it, and some use it only as a vehicle.

Proving test: run the deletion test first — disable it and see which of the 34
sites genuinely need the stub versus inherit it. Migrate vehicle-only sites
before removing the surface.

### 11. Turn-level `interactive` is a tri-state with one production writer — med risk, ~10 lines

Files: `agent-loop.state.ts:41, 292`, `agent-loop.protocol.ts:51`,
`turn-resolve.ts:119`, `agent-loop.actor.ts:446`, `session-runtime.ts:100`.

Problem: declared `Schema.optional(Schema.Boolean)` in five places. The only
production writer anywhere is `agent-runner.ts:306` (`interactive: false`, the
child-spawn path). No production code writes `true`; `apps/` never writes it at
all. Both terminal readers test only for `=== false`
(`runtime/extensions/registry.ts:474`, `packages/extensions/src/index.ts:100`),
so `true` and `undefined` are already indistinguishable in production.

Caveat that cost me a wrong hypothesis: there are **two unrelated `interactive`
fields**. The tool-metadata one (`domain/capability.ts:58`, written
`interactive: true` at `packages/extensions/src/interaction-tools/ask-user.ts:71`)
is genuinely two-valued and earns its keep. This candidate concerns only the
turn-level field.

Change: make it non-optional two-state, or rename it to what it means
(`headless`, `nonInteractive`) so the `=== false` readers stop reading as a
double negative.

Risk: med. Wire-schema field on a persisted actor payload; test helpers inject
values production never injects.

Proving test: `tests/runtime/extensions/registry.test.ts:649`,
`tests/runtime/agent-loop/queue.test.ts`.

### 12. Queue concern spread across four files with no owner — high risk, ~80 net lines

Files: `agent-loop.behavior.ts:169-414` (`makeAgentLoopQueue`, 246 lines),
`agent-loop.state.ts:35-283` (queue algebra, 249 lines),
`agent-loop.actor.ts:452-531` and `:688-800` (admission and wake, 193 lines),
`agent-loop.turn-execution.ts:1088-1114` (step-boundary delivery, 27 lines).
About 715 lines of one concern.

Problem: no single module owns the queue. Admission, steering, follow-ups,
batching, the durable checkpoint, and the wake decision are split across the
actor, the behavior, the state algebra, and the turn executor. The
`holdsMessage` predicate at `agent-loop.actor.ts:133-142` has to consult five
separate places to answer one question.

Both peers that implement durable steering give it a dedicated module:

- opencode: `packages/core/src/session/inbox.ts`, 550 lines, one `Service` tag,
  about eight verbs, one SQLite table whose `delivery` column distinguishes
  `"queue"` from `"steer"` (`inbox.ts:44-48`, `sql.ts:125`).
- codex: `codex-rs/core/src/session/input_queue.rs`, 659 lines, with explicit
  deliver-now versus defer-to-next-turn (`:213`, `:236`).

Two independent implementations converging on one module is the strongest
structural evidence in this review.

Change: consolidate behind one `LoopInbox` interface mirroring `SessionInbox`.
Net reduction is modest; the win is locality and one place to reason about
admission.

Risk: high. Touches the durable queue and the admission race that L10 and the
`startingState` reservation already guard.

Proving test: full `tests/runtime/agent-loop/queue.test.ts`,
`admission-withdrawal.test.ts`, `primary-key-dedup.test.ts`,
`recovery-race.test.ts`.

## Prior-art shape

Refs actually read: opencode `v2` @ `a5b3802ca3fcb95331fb56f3532c2b28b293b7ca`;
pi-mono `pico` @ `fde6d778f80eea81153d14221c20064ba6f648b9`; openai/codex at the
cached commit.

| Loop           | Main loop file                                              | Lines (main / core / full)                 | What it omits that gent has                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pi-mono `pico` | `packages/agent/src/agent-loop.ts` (`runLoop` `:162-279`)   | 118 / 857 / 1,946 (4 files)                | No persistence of any kind. No durable turn record, no crash resume, no tool replay, no max-steps ceiling, no in-turn continuation retry. Has steering (in-memory poll at three points) and two in-memory queues.                                                                                                                                                           |
| opencode `v2`  | `packages/core/src/session/runner/llm.ts`                   | 378 / 1,944 (8 files) / 5,064 (16 files)   | No durable step position — `Continuation = { step }` is an in-memory return value (`runner/index.ts:20`). No tool replay: orphans are settled as failed (`llm.ts:332-355`). No process-local tool-result cache. Has a durable inbox, a soft max-steps ceiling, two continuation mechanisms, and a durable claim row with a resume budget of 10 (`execution/restart.ts:33`). |
| openai/codex   | `codex-rs/core/src/session/turn.rs` (`run_turn` `:164-786`) | 3,054 / 4,942 (6 files) / 8,891 (13 files) | No max-steps ceiling at all; the stated position is that compaction makes one unnecessary (`turn.rs:614`). No durable step position. No tool replay. Has the strongest interrupt path: a model-visible history marker plus an explicit `flush_rollout()` before `TurnAborted` (`tasks/mod.rs:924-932`).                                                                     |

Two framing corrections worth recording, because both cut against gent looking
like an outlier:

- The fair comparison to gent's 8,368 is opencode's 5,064 (16 files, durable
  layer included) and codex's 8,891 (13 files). Codex is larger than gent. The
  tight `runner/` core of 1,944 is a different measurement, not a better one.
- `pico` is not a stripped minimal harness. It is the full pi-mono monorepo
  merged from `main` at `01528e2`. Its loop is minimal relative to the other
  two, and it achieves that by omitting all persistence.

### Three findings that bear on gent's design

1. **No one persists a step position.** All three keep the step counter in
   memory. opencode and codex both durably record _that_ a turn was in flight,
   then replay the transcript and re-enter at step 1 with a synthetic nudge —
   `CONTINUE_AFTER_SERVER_RESTART` (`restart.ts:15`) and the interrupted-turn
   history marker (`tasks/mod.rs:100-116`) respectively.
2. **No one replays in-flight tool calls.** opencode is most explicit: it marks
   them failed at drain start rather than attempting recovery.
3. **Only opencode has a max-steps ceiling**, and it is soft — tool definitions
   stay in the request to preserve the provider's cached prefix, `toolChoice`
   becomes `"none"`, and a 16-line prompt demands a text-only summary
   (`runner/max-steps.ts`). Gent's behavior matches this exactly, and the
   comment at `agent-loop.turn-execution.ts:1202` already cites it.

Gent's `TurnRecord` plus tool replay is therefore a real differentiator, not
accidental complexity — consistent with L6 (partial) and L7 (rejected). It is
also the main reason `agent-loop.turn-execution.ts` is 1,426 lines against
opencode's 378. I am not proposing to remove it.

But the peers suggest a third option neither ledger entry considered: keep the
durable turn record, drop the _step-position precision_, and resume from the
transcript with a nudge. That would collapse `resolveTurnPosition`
(`:881-961`, 81 lines) and much of `resumeTurn` (`:963-1079`, 117 lines). It is
a capability trade, not a reduction, so it is a decision for the owner rather
than a cleanup commit.

## The three I would do first

**First commit — candidates 1, 2, and 4 together.** About 70 lines out of
`agent-loop.turn-execution.ts`, all low risk, all covered by existing tests, no
new concepts and no new files. They make the largest file scan better without
touching a seam.

**Second commit — candidate 3 alone.** The highest-leverage change in the
directory: 45 lines and roughly 25 lines of race-condition commentary disappear
because the illegal states stop being representable. It touches the startup
path, so it deserves isolation and a `recovery-race.test.ts` run of its own.

**Third — candidates 6 and 7 together.** One error helper plus the comment
sweep, about 65 lines. Do candidate 7 after candidate 3, since 3 deletes the
reason most of those `actor.ts` comments exist.

Hold candidate 12 until the first three land. It is the right end state and two
independent prior-art implementations prove the shape, but at roughly 715 lines
across four files it is a three-to-five commit project, not a cleanup.

Candidates 8 and 9 are near-free and can ride along with any of the above.
Candidates 10 and 11 need a deletion test run first.
