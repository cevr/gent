# Resource host: do generations, leases, and retire modes still earn their place?

Date: 2026-09-09
Status: verdict — keep all three. Candidate rejected.

## The question

After moving skills to `branch` scope, only two process-scoped resources
remain:

| Resource                           | Scope   |
| ---------------------------------- | ------- |
| `@gent/btw/runs`                   | process |
| `@gent/exec-tools/background-bash` | process |
| `@gent/skills/service`             | branch  |

The resource host is 4,051 lines across 11 files. Two long-lived services is a
thin justification for three concepts, so each was audited separately.

## Generations — keep

Not confined to the host. `tool-binding-resolution.ts` uses `generationId` to
gate durable tool-binding resume: a tool call may only resume inside the
generation that created its binding (`:64`, `:119`, `:192`).

Without generations there is no way to tell a resumed durable tool call that
its underlying service was replaced by a config reload. This is a correctness
property, not bookkeeping.

## Leases — keep

174 lines — the smallest file in the host. Implements the admission/drain/
cancel primitive (`closeAdmission`, `awaitDrained`, `cancel`) that both retire
paths are built on. Removing it would require reimplementing it.

## Retire modes — keep (candidate rejected)

This was the most promising candidate and the one I expected to remove.

`retireMode: "cancel"` has **zero production callers** — production passes
`"drain"` at both sites (`live-profile.ts:606`, `:763`). Only two tests use
`"cancel"`. That is the same signature as the three actor operations removed
earlier today.

Reading `closeGeneration` (`resource-graph-host.ts:475-500`) first suggested
redundancy: the drain path _already_ calls `previous.leases.cancel` twice — on
drain failure, and when `shutdownRequested` wins the race. It looked like
`"cancel"` was a shortcut that merely skipped the race.

**That reading was wrong, and the test proved it.** Disabling the branch:

```ts
if (false) {          // was: if (retireMode === "cancel")
  yield* previous.leases.cancel
} else {
```

produces:

```
(fail) resource graph host > cancels admitted use before replacement when requested [5000.00ms]
16 pass, 1 fail
```

A 5-second timeout: the drain path blocks on the in-flight lease
(`Effect.never`) because nothing requested shutdown. The two paths have
different _triggers_ — `"cancel"` interrupts on demand; the drain path only
cancels when shutdown fires or drain itself fails. Deleting the mode would
remove a capability, not a duplicate.

Reverted; tree clean.

## Method note

Zero production callers is a hypothesis, not a verdict. It was correct for
`RecordToolResult`, `InvokeTool`, and `Interrupt` — each turned out to delegate
to something another live operation already called. It was wrong here.

The distinguishing test is not "who calls this?" but "if I delete it, does an
existing capability still cover the behavior?" That question is answered by
disabling the code and running the suite, not by reading call counts.

Fifth rejected candidate, consistent with the note in `edd2964a`.
