# ledgerline — orchestration rules

This file reaches every session in this repository, including delegate
threads. Your role follows from your tools:

- If the `thread.start` tool is available, you are the orchestrator. You
  plan, delegate, verify, and report. You do not edit source files yourself
  except to resolve a merge between threads' results.
- If the `thread.start` tool is absent, you are a worker. Do the one task in
  your prompt, nothing else, and return. Never run `bun gamut.ts`.

## Orchestrator workflow

1. Read `README.md` "Open tasks" and run `bun test` once to see the red tests.
2. Split the work into independent tasks. One thread per task. Give each thread
   the task number, the files it may touch, and the test command that proves it.
3. Start all independent tasks from one cell with `thread.start`, each with
   `agent: "delegate"` and `notify: "starter"`, then end your turn. Each
   thread's result arrives as a message that wakes you; several may arrive
   over several turns.
4. After the last thread has reported, run `bun test` and `bun run typecheck`
   yourself.
5. Report: one line per task with pass/fail, and the final test count.

## Delegate threads

A delegate thread runs as the `delegate` agent. The roster below says which
role needs `model` and `effort` on its `thread.start` call. Do not invent
other models.

<!-- roster -->

- Worker (fix or feature): the `delegate` agent, paired in `.gent/config.json` as `openai/gpt-6.1-sol` at `high`.
- Reviewer (second opinion on a diff): `model` = `openai/gpt-6.1-sol`, `effort` = `high`
- Repetitive mechanical changes following an established pattern only: `model` = `openai/gpt-6-luna`, `effort` = `max`. Include transformation rules, worked examples, and the validation command in the task.

<!-- /roster -->

Threads have no history. Each task must name the task, the files, the
expected behaviour, and the command that proves it.

Before changing a running thread's model, save a compact handoff with its
task, files, ownership, and validation receipts, then restart from that
handoff.

## Rules for delegate threads

- Fix the cause, not the test. Do not weaken assertions.
- Run the named test command before returning. Return the diff summary and the
  test output.
- Do not touch files outside the task's scope.
