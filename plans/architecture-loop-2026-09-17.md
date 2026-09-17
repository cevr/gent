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

| #   | Candidate                                                               | Status             |
| --- | ----------------------------------------------------------------------- | ------------------ |
| L1  | `invokeTool` has no production caller                                   | done `b38af2f4`    |
| L2  | Test-only and single-valued names in the tool path                      | open               |
| L3  | `SwitchAgent` has no sender; `currentAgent` rides the loop state for it | open               |
| L4  | `runtimeState` and `snapshot` read one ref; the double read is dead     | open               |
| L5  | An interrupted step can persist a tool call with no result              | done `0d987793`    |
| L6  | `TurnRecord` is a non-transactional cache of the messages               | open               |
| L7  | The process-local result cache repeats the durable tool events          | open, probe first  |
| L8  | `saveCheckpoint` writes a queue that did not change                     | open               |
| L9  | Turn state lives at loop scope and is reset by hand in four places      | open               |
| L10 | Admission is encoded four ways because the mailbox is unbounded         | open, highest risk |
| L11 | The spine reads bottom-up: flags, wrappers, `Object.assign`             | open               |
| L12 | `systemPrompt` hook repeats `turnProjection.promptSections`             | open               |
| L13 | The child result is built twice                                         | open               |

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
| G9  | A turn failure prints `Cause.pretty` with every stack frame into the transcript (150 rows for one `StorageError`); `agent-loop.worker.ts:75`                                                                                                    | open, after `arch-loop` merges                                                                           |
| G10 | Rift binaries open the real `~/.gent/data.db`. Migration `020_drop_message_search_index` ran there, so any binary older than `arch-core` now fails every message write with `no such table: messages_fts`                                       | open: merge to main closes it; consider a per-rift `GENT_HOME`                                           |

## fx survey (vercel-labs/fx), adopt list

| #   | Candidate                                                                        | Status                                                                                                                                            |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Settle-then-capture probe and grid in `packages/e2e/src/pty-fixture.ts`          | open                                                                                                                                              |
| F2  | Scrollback-ownership invariants on top of F1                                     | open                                                                                                                                              |
| F3  | Byte tape (stdout, stdin, resize) with replay                                    | parked: new capability, not a reduction                                                                                                           |
| F4  | `MAX_TURN_STEPS` and `maximumModelToolResultChars` on `UserConfig`               | done (steps): `AgentDefinition.maxSteps` + run override                                                                                           |
| F5  | Palette folded into `SessionOverlayState` (`session.tsx:237` has a second owner) | rejected: the palette is app-level. `apps/tui/src/app.tsx:54` renders it with no session, so the session overlay cannot own it                    |
| F6  | Byte cap on the retained TUI feed (`use-session-feed.ts:248,279`)                | rejected: the feed is the source for the resize replay (`requestReplay`); a cap would shorten replayed history, and no growth problem is measured |

Rejected from fx: LLM permission reviewer, static tool table, mutex event
queue, unbounded steps, whole-log replay, text-blob compaction.
