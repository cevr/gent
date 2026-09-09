# Actor operation reduction: RecordToolResult and InvokeTool

Date: 2026-09-09
Status: landed

## What was removed

Two actor operations, their handlers, their protocol field blocks, and one
helper that became dead once the last handler went:

| Surface                               | Location                 | Lines |
| ------------------------------------- | ------------------------ | ----- |
| `RecordToolResult` handler            | `agent-loop.handlers.ts` | ~30   |
| `InvokeTool` handler                  | `agent-loop.handlers.ts` | ~74   |
| Both field blocks + operation entries | `agent-loop.protocol.ts` | ~48   |
| `recordToolResult`                    | `turn-persistence.ts`    | 67    |

Net: 4 files, +108 / -658.

## Why they were safe to remove

Both were vestigial. Git history shows the facade wrappers were demoted
earlier with "zero production callers", but the actor operations themselves
were left behind:

- `edd6d8b0 refactor(session-runtime): demote SessionRuntime.invokeTool`
- `975cf3eb refactor(session-runtime): demote recordToolResult to actor surface`

Typecheck confirms the only remaining consumer was
`tests/runtime/agent-loop/actor-command.test.ts`.

## The complication, and how it was resolved

Four of the eight tests in that file used `RecordToolResult` as a _vehicle_ to
exercise general actor concurrency, not to test the operation:

- serialization of side mutations per session
- a side mutation waiting for the active turn's mutation owner
- `TerminateBranch` interrupting a turn while a side mutation waits
- rollback of the tool message when the durable event append fails

Deleting the operation would have deleted that coverage with it.

`RequestExtension` turned out to be the correct home. Its handler ends in the
_identical_ pipe:

```ts
}).pipe(handle.withSideMutation, Effect.ensuring(drainWake(handle)))
```

At HEAD there were exactly three `withSideMutation` sites — `RecordToolResult`,
`InvokeTool`, and `RequestExtension`. The first two are gone; the third is a
live production path (`session-runtime.ts:603`). Migrating the concurrency
tests onto it makes them assert the permit against a path production actually
uses, which is stronger than what they tested before.

Three tests migrated. Two were dropped as operation-specific rather than
actor-general (`InvokeTool` refusing interactive approval; `InvokeTool`'s own
dedupe). One more was dropped for a reason worth recording separately.

## A wrong assumption the migration caught

The migrated dedupe test failed: the capability ran twice for one `commandId`.

Investigation showed the original `recordToolResult` dedupe was never
actor-level. It came from a deterministic `MessageId` derived from the
`commandId`, so a repeat call rewrote the same row idempotently. The old test
asserted "one tool message, one event" — a property of the removed function,
not a promise the actor makes.

The migrated assertion was therefore unfounded, and the test was dropped rather
than bent to pass. `RecordToolResult` keyed its actor `primaryKey` on
`toolCallId`; `RequestExtension` keys on `commandId` — they were never the same
mechanism.

## Proof the surviving coverage is real

Per the standing rule that a regression test must be shown to fail when its
protection is removed, `handle.withSideMutation` was stripped from the one
remaining site and the suite re-run:

```
(fail) side-mutation commands are serialized per session
(fail) a side mutation waits for the active turn mutation owner
(fail) TerminateBranch interrupts an active turn while a side mutation is waiting
1 pass, 3 fail
```

Restored: 4 pass, 0 fail. Full gate green (build, lint, typecheck, tests).

## Note on the cascade

Removing the handlers made `recordToolResult` dead, but _not_ `invokeTool` —
that one retains a live test consumer at `interactions.test.ts:972`, so it
stays. Dead-code cascades are worth following, but only as far as the evidence
actually reaches.
