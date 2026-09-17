# Architecture loop, second run (2026-09-17 →)

Goal: run the architecture review on each package until no findings, against
opencode-v2, pi, openai/codex, prime-agent, exo and deepseek-harness. The loop
comes first: simpler, less code, scannable. Rules: effect-native, actor model,
lean core, fully extensible. The first run is `architecture-loop-2026-09-15.md`;
its refusals stand unless this file gives new evidence.

Work happens on the rift `loop-architecture`. Prior-art clones: the
2026-09-13 scratchpad, plus `codex` at `b0659c5` in this session's scratchpad.

## Baseline

`packages/core/src/runtime/agent/` is 8,431 lines at `1c3322ce`.

## Loop candidates

Sources: my own read of the spine, and three surveys (codex; opencode-v2 + pi;
prime + exo + deepseek). A candidate is listed only when two readers agree or
the code proves it.

| #   | Candidate                                                               | Status                                                                                                                                             |
| --- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | `invokeTool` has no production caller                                   | done `b38af2f4`                                                                                                                                    |
| L2  | Test-only and single-valued names in the tool path                      | done `42d333f8` (only the single-valued `origin` held up)                                                                                          |
| L3  | `SwitchAgent` has no sender; `currentAgent` rides the loop state for it | done `4c74c24d`                                                                                                                                    |
| L4  | `runtimeState` and `snapshot` read one ref; the double read is dead     | done `1ecadc3e`                                                                                                                                    |
| L5  | An interrupted step can persist a tool call with no result              | done `0d987793`                                                                                                                                    |
| L6  | `TurnRecord` is a non-transactional cache of the messages               | partial `bc9aa0c1`: the record is not in the step transaction; the resume now cross-checks the messages. The cache stays                           |
| L7  | The process-local result cache repeats the durable tool events          | rejected: the cached results have durable events but no message row; deletion widens `ToolResultReplayError` to the whole step                     |
| L8  | `saveCheckpoint` writes a queue that did not change                     | done `8ec7a1eb`                                                                                                                                    |
| L9  | Turn state lives at loop scope and is reset by hand in four places      | done `858f1721` (`turn-ledger.ts`); the other loop-scope state is load-bearing                                                                     |
| L10 | Admission is encoded four ways because the mailbox is unbounded         | rejected: the cause is `TxQueue.unbounded` at `agent-loop.behavior.ts:647`, whose entries cannot be retracted; `holdsMessage` needs all five forms |
| L11 | The spine reads bottom-up: flags, wrappers, `Object.assign`             | done `eab23ce5`: the four mutable flags are gone                                                                                                   |
| L12 | `systemPrompt` hook repeats `turnProjection.promptSections`             | rejected: `systemPrompt` is the only hook after `compileToolPolicy`, and the cell needs `hostTools`                                                |
| L13 | The child result is built twice                                         | rejected: two different results (typed `AgentRunResult` vs a prose message), exclusive paths                                                       |

## Live gamut findings (sol-luna, `/private/tmp/gent-gamut-0917`, pane `wZ:p1A`)

| #   | Finding                                                                                                                                                                                                                                         | Status                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| G1  | Reasoning text renders raw `**Title**`; `message-list.tsx:386` prints it as plain italic                                                                                                                                                        | open, after the TUI branch merges                                                                        |
| G2  | An interrupt during a foreground `delegate` leaves its children running with no owner: the next turn cannot await them and falls back to a file monitor                                                                                         | done: each tool call races the turn's interrupt latch; a foreground child is interrupted with its caller |
| G3  | Interrupt during a tool, then a new message: the next turn ran (L5 path holds live)                                                                                                                                                             | verified                                                                                                 |
| G4  | The terminal keeps no scrollback: with a live view taller than the screen the footer owns every row, each commit is written at row 1 and the same frame's footer paint erases it (raw pty bytes: 23 commits, all at `ESC[1;1H`, 0 history rows) | agent on rift `arch-scrollback`                                                                          |
| G5  | `gent resume` opened a child session (the Task 6 worker), not the root the user ran                                                                                                                                                             | done: `apps/tui/src/app-bootstrap.ts` skips delegate children on resume                                  |
| G6  | `apps/tui/scripts/build.ts:59` re-points the global `gent` symlink at whichever checkout ran the gate                                                                                                                                           | with G4                                                                                                  |
| G7  | The orchestrator cannot message a running child (user request 2026-09-17)                                                                                                                                                                       | done: `agent-child` `send` steers the child; steering at an answered step joins the turn                 |
| G8  | Second gamut: `send` reached the Task 2 child live (it added the requested test; 18 pass). The orchestrator set alarms to wait for background children, and one fired stale after they finished                                                 | done: the `delegate` description says a background result starts a turn by itself                        |
| G4  | Scrollback fix verified live after the merge (`ff185983`): pane history went from 5 rows to 150 on `gent resume`                                                                                                                                | verified                                                                                                 |
| G9  | A turn failure prints `Cause.pretty` with every stack frame into the transcript (150 rows for one `StorageError`); `agent-loop.worker.ts:75`                                                                                                    | done `f571125b`: the event carries the cause-chain messages; frames go to the log                        |
| G10 | Rift binaries open the real `~/.gent/data.db`. Migration `020_drop_message_search_index` ran there, so any binary older than `arch-core` now fails every message write with `no such table: messages_fts`                                       | open: merge to main closes it; consider a per-rift `GENT_HOME`                                           |
| G11 | A foreground child that was interrupted, lost its stream, or never answered still returned `Success` (found by the `arch-loop` agent)                                                                                                           | done `cb82d5cb`                                                                                          |

## fx survey (vercel-labs/fx), adopt list

| #   | Candidate                                                                        | Status                                                                                                                                            |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Settle-then-capture probe and grid in `packages/e2e/src/pty-fixture.ts`          | done `724820c9`: `settleAndCapture` + `@xterm/headless` grid                                                                                      |
| F2  | Scrollback-ownership invariants on top of F1                                     | done `d47b11c9`: three scrollback tests; all fail with the reserve set to 0                                                                       |
| F3  | Byte tape (stdout, stdin, resize) with replay                                    | parked: new capability, not a reduction                                                                                                           |
| F4  | `MAX_TURN_STEPS` and `maximumModelToolResultChars` on `UserConfig`               | done (steps): `AgentDefinition.maxSteps` + run override                                                                                           |
| F5  | Palette folded into `SessionOverlayState` (`session.tsx:237` has a second owner) | rejected: the palette is app-level. `apps/tui/src/app.tsx:54` renders it with no session, so the session overlay cannot own it                    |
| F6  | Byte cap on the retained TUI feed (`use-session-feed.ts:248,279`)                | rejected: the feed is the source for the resize replay (`requestReplay`); a cap would shorten replayed history, and no growth problem is measured |

Rejected from fx: LLM permission reviewer, static tool table, mutex event
queue, unbounded steps, whole-log replay, text-blob compaction.

## Pass 2 (read-only sweeps, then agents on `arch-core2` and `arch-apps2`)

| #   | Candidate                                                                                         | Status                                         |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| C1  | `ProcessRunner` is a pass-through Tag over `runProcess`; every union already names the spawner    | agent `arch-core2`                             |
| C2  | Server identity declared three times (`server-identity.ts`, `server-routes.ts`, `rpcs.ts`)        | agent `arch-core2`                             |
| C3  | `packages/core/src/test-utils/` is outside the dead-export guard; three dead names                | agent `arch-core2`                             |
| E1  | Two cell output buffers with different tail policy; an error at the end of long output is dropped | agent `arch-apps2`                             |
| E2  | `anthropic/oauth.ts` is a re-export barrel                                                        | agent `arch-apps2`                             |
| E3  | Goal store `optional` to `Option` wrapper                                                         | rejected: changes the on-disk goal file format |
| E4  | `handoff-tool.ts` has one importer                                                                | agent `arch-apps2`                             |
| T1  | Two owners for the branch picker's visibility                                                     | agent `arch-apps2`, probe first                |
| T2  | `latestInputTokens` and `contextMetrics` are one value in two signals                             | agent `arch-apps2`                             |
| T3  | `main.tsx` holds five admin subcommands; HOME read written five times                             | agent `arch-apps2`                             |
| T4  | `agents-view.client.tsx` holds the tray and the pane                                              | agent `arch-apps2`                             |
| S1  | `spawnIdleServer` and `spawnServerOnPort` differ by three lines                                   | agent `arch-apps2`                             |
| S2  | The dead-export guard scans nothing under `apps/`; 92 file-local exports in `apps/tui/src/`       | agent `arch-apps2`                             |

Cleared with receipts in pass 2: storage sub-tags, RPC handlers, `dependencies.ts`
wiring, one-adapter seams (all guarded), SDK wrappers, tooling guards, e2e fixtures.
Noted, not changed: `dbPath` has two defaults (`packages/sdk/src/server.ts:263`
absolute, `packages/core/src/server/dependencies.ts:126` relative); only test
compositions reach the core default.

### Pass 2, the loop (`plans/loop-review-pass2-2026-09-17.md`)

Candidates P1 to P11 (step address, duplicate `resolveTurnContext` call, actor
lifecycle as one tagged Ref, `Object.assign` field building, a one-caller
wrapper, eight error-mapping blocks, history comments, single-caller exports,
`ToolRunner.Test`, the tri-state `interactive`) are with the agent on
`arch-loop2`. P12 (one `LoopInbox` module for about 715 lines of queue code
spread over four files; opencode `inbox.ts` and codex `input_queue.rs` both have
this shape) waits until P1 to P11 land.

Owner decision, not taken: no prior art persists a step position or replays
in-flight tool calls. Dropping exact mid-turn resume for "replay the transcript
and nudge" would remove about 200 lines of `agent-loop.turn-execution.ts`. It is
a capability trade, so it stays.

Measured sizes: pi `runLoop` 118 lines (no persistence); opencode v2 5,064 lines
with its durable layer; codex 8,891; gent 8,368.
