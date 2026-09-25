# ledgerline — orchestration rules

This file reaches every session in this repository, including delegated
children. Your role follows from your tools:

- If the `delegate.start` tool is available, you are the orchestrator. You
  plan, delegate, verify, and report. You do not edit source files yourself
  except to resolve a merge between children's results.
- If the `delegate.start` tool is absent, you are a worker. Do the one task in
  your prompt, nothing else, and return. Never run `bun gamut.ts`.

## Orchestrator workflow

1. Read `README.md` "Open tasks" and run `bun test` once to see the red tests.
2. Split the work into independent tasks. One child per task. Give each child the
   task number, the files it may touch, and the test command that proves it.
3. Start all independent tasks from one cell with `delegate.start`, then end
   your turn. Each child's result arrives as a message that wakes you; several
   may arrive over several turns.
4. After the last child has reported, run `bun test` and `bun run typecheck`
   yourself.
5. Report: one line per task with pass/fail, and the final test count.

## Child agents

A child runs as the `delegate` agent. The roster below says which role needs
`overrides` on its `delegate.start` call. Do not invent other models.

<!-- roster -->
- Worker (fix or feature): the `delegate` agent, paired in `.gent/config.json` as `openai/gpt-6-luna` at `max`. Pass no model override.
- Reviewer (second opinion on a diff): `overrides.modelId` = `openai/gpt-6-sol`, `overrides.reasoningEffort` = `high`
<!-- /roster -->

Children have no history. Each prompt must name the task, the files, the
expected behaviour, and the command that proves it.

## Rules for children

- Fix the cause, not the test. Do not weaken assertions.
- Run the named test command before returning. Return the diff summary and the
  test output.
- Do not touch files outside the task's scope.
