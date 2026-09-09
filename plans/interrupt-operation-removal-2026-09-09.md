# Removing the Interrupt actor operation

Date: 2026-09-09
Status: landed

## Audit that found it

After removing `RecordToolResult` and `InvokeTool`, I counted production call
sites for all fifteen remaining actor operations:

| Operation          | src   | tests |
| ------------------ | ----- | ----- |
| Submit             | 1     | 1     |
| SubmitAndWait      | 1     | 0     |
| SubmitDurable      | 1     | 0     |
| Run                | 1     | 4     |
| QueueFollowUp      | 1     | 0     |
| Steer              | 1     | 1     |
| **Interrupt**      | **0** | **2** |
| RespondInteraction | 1     | 2     |
| DrainQueue         | 1     | 0     |
| RemoveFollowUp     | 1     | 0     |
| GetQueue           | 2     | 1     |
| GetState           | 1     | 8     |
| GetMetrics         | 1     | 0     |
| RequestExtension   | 1     | 1     |
| TerminateBranch    | 1     | 1     |

Exactly one operation had zero production callers. The other fourteen are
live — no further removals available on this axis.

## Why Interrupt was redundant

Interruption is very much a live product feature, so a zero call count is not
by itself sufficient. Tracing the real path:

- The user-facing cancel path is `SessionRuntime.steer` with a `Cancel`
  command (`agent-runner.durable.ts:442`), delivered as the `Steer` operation
  (`session-runtime.ts:547`).
- Stream teardown is a _separate_ mechanism entirely — `interruptedRef` plus
  `signalActiveStreamInterrupt` in `agent-loop.worker.ts`, reached through
  `handle.interruptActiveStream`. Untouched by this change.

The `Interrupt` operation was a thin adapter that hardcoded
`_tag: "Cancel"` and called `applySteer` — the same function `Steer` calls.
Both handlers converged on it (`agent-loop.handlers.ts:845` and `:860`).
Two doors, one room, and production only ever used the other door.

## The test, and why it did not migrate

The one `Interrupt` test asserted that a 129-character `commandId` surfaces a
decode failure as `AgentLoopError("Invalid interrupt command")`.

That is a property of the adapter, and specifically of a type mismatch it
introduced:

- `ActorCommandId` is unconstrained (`domain/ids.ts:33`)
- `RequestId` caps at 128 characters (`domain/ids.ts:42`)

`Interrupt` reused `commandId` as `requestId`, so a value that was legal for
the field it arrived in became illegal once re-decoded inside the handler.
`Steer` has no such mismatch: it carries `requestId` inside its already-decoded
`SteerCommand`, so the RPC boundary validates it before the handler runs.

So the test was not covering a property worth keeping — it was covering a
defect the adapter created. Removing the adapter removes both. This is the same
shape as the `recordToolResult` dedupe assertion from the previous commit:
an assertion that looks general but is actually about the thing being deleted.

## Verification

- Full gate green (build, lint, typecheck, tests); no test failures repo-wide.
- `streaming.test.ts` and `session-runtime.test.ts` — which exercise `Cancel`
  steers against a live turn — pass unchanged, confirming cancellation still
  works through the surviving path.
- Live headless run executes a cell and replies.

Net: 3 files, +1 / -135.

## Cascade

`SteerCommand` became unused in `agent-loop.handlers.ts` — the adapter's
in-handler decode was its only consumer there. Two test helpers
(`materializeActorCommand`, `createSessionBranchWithIds`) also went dead.
