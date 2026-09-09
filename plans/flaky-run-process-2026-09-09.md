# Flaky: `runProcess > surfaces nonzero exit code`

Date: 2026-09-09. Found while committing the session-tree replacement.

## Symptom

`packages/core/tests/utils/run-process.test.ts:18` times out at its 10s
`Effect.timeout` budget. Spawning `/bin/sh -c "exit 7"` should take
milliseconds.

## What is known

- Reproduced twice, both times inside the **lefthook pre-commit** run, which
  executes fmt+lint, typecheck, build and the full suite together.
- Never reproduced in three consecutive standalone `bun run test` runs on the
  same working tree, nor once on a clean HEAD.
- Unrelated to the change under commit (a TUI overlay); the failing test spawns
  a subprocess and touches none of it.

## Hypothesis

Contention, not a test defect. Under the hook, the suite competes with a
concurrent build and typecheck for process slots, and subprocess spawn latency
crosses 10s. The budget assumes an idle machine.

## Not done

No fix attempted — this needs its own measurement (is spawn latency really the
stall, or is the Effect scope waiting on something else?). Raising the timeout
would hide it rather than answer it.

## Workaround in the meantime

Retry the commit; it passes on a subsequent attempt.
