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
| L5  | An interrupted step can persist a tool call with no result              | open, test first   |
| L6  | `TurnRecord` is a non-transactional cache of the messages               | open               |
| L7  | The process-local result cache repeats the durable tool events          | open, probe first  |
| L8  | `saveCheckpoint` writes a queue that did not change                     | open               |
| L9  | Turn state lives at loop scope and is reset by hand in four places      | open               |
| L10 | Admission is encoded four ways because the mailbox is unbounded         | open, highest risk |
| L11 | The spine reads bottom-up: flags, wrappers, `Object.assign`             | open               |
| L12 | `systemPrompt` hook repeats `turnProjection.promptSections`             | open               |
| L13 | The child result is built twice                                         | open               |
