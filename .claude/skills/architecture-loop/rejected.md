# Rejected candidates

A sweep re-proposes one of these only with a new receipt. The full reasons are the ledger rows in `plans/architecture-loop-2026-09-17.md` and `plans/architecture-loop-2026-09-15.md`.

| Candidate                                     | Why it stays                                                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| L7: process-local tool result cache           | its results have durable events but no message row; deletion widens `ToolResultReplayError` to the whole step          |
| L10: admission encoded several ways           | `TxQueue.unbounded` entries cannot be retracted; `holds` needs every form                                              |
| L12: `systemPrompt` hook                      | the only hook after `compileToolPolicy`; the cell needs `hostTools`                                                    |
| L13: child result built twice                 | two different results on exclusive paths                                                                               |
| L6: `TurnRecord` as a cache                   | kept as a cache; the resume cross-checks the messages                                                                  |
| F5: palette into the session overlay          | the palette renders with no session                                                                                    |
| F6: byte cap on the TUI feed                  | the feed is the source for the resize replay                                                                           |
| E3: goal store `Option` wrapper               | changes the on-disk goal file                                                                                          |
| C12: fold `profile.ts`                        | `runtime-profile.test.ts` tests it as a subject                                                                        |
| Two `isClientFile` bodies                     | the TUI must not import core runtime internals for a two-regex predicate                                               |
| Render-local `_tag` unions in `apps/tui/src/` | no wire decode; exemption written in `apps/tui/AGENTS.md`                                                              |
| `effect-wide-event`                           | owner decision: it stays                                                                                               |
| From prior art                                | LLM permission reviewer, static tool table, mutex event queue, unbounded steps, whole-log replay, text-blob compaction |
| Anything that changes a persisted format      | rejected by default; needs an owner decision and a migration                                                           |
