# Test fold — packages/extensions

`packages/extensions/src` is flat: 24 `.ts` concern files plus `skills/`.
Tests therefore fold to a flat `packages/extensions/tests/<concern>.test.ts`,
one file per source concern. Every `tests/<dir>/` directory disappears.

Before: 83 test files, 17,875 lines, 551 tests, `bun run test` 11.19 s.

## Map

| Target (`tests/…`)             | Source concern (`src/…`)  | Folded sources                                                                                                                                                                                            |
| ------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acp-agents.test.ts`           | `acp-agents.ts`           | `acp-agents/acp-agents.test.ts`, `acp-agents/protocol.test.ts`, `acp-agents/response-finish.test.ts`, `acp-agents/transcript.test.ts`, `acp-agents/update-mapping.test.ts`, `acp-agents/fake-acp-peer.ts` |
| `agents-view.test.ts`          | `agents-view.ts`          | `agents-view/agents-view-rpc.test.ts`, `agents-view/projection.test.ts`                                                                                                                                   |
| `agents.test.ts`               | `agents.ts`               | `agents.test.ts` (kept), `fs-tools/fs-tools-model-turn.test.ts`                                                                                                                                           |
| `anthropic.test.ts`            | `anthropic.ts`            | all ten `anthropic/*.test.ts`                                                                                                                                                                             |
| `btw.test.ts`                  | `btw.ts`                  | `btw/side-question.test.ts`                                                                                                                                                                               |
| `cell-protocol.test.ts`        | `cell-protocol.ts`        | `cell/cell-protocol.test.ts`, `cell/cell-snapshot.test.ts`                                                                                                                                                |
| `cell-worker-boundary.test.ts` | `cell-worker-boundary.ts` | `cell/cell-worker.test.ts`, `cell/bun-cell-evaluator.test.ts`                                                                                                                                             |
| `cell.test.ts`                 | `cell.ts`                 | the remaining fifteen `cell/*.test.ts` plus `cell/cell-worker-fixture.ts`                                                                                                                                 |
| `compaction.test.ts`           | `compaction.ts`           | `compaction/model-compaction.test.ts`, `compaction/model-compaction-rpc.test.ts`                                                                                                                          |
| `delegate.test.ts`             | `delegate.ts`             | all nine `delegate/*.test.ts`                                                                                                                                                                             |
| `exec-tools.test.ts`           | `exec-tools.ts`           | `exec-tools/bash.test.ts`, `exec-tools/bash-execution.test.ts`, `exec-tools/exec-tools-rpc.test.ts`                                                                                                       |
| `fs-tools.test.ts`             | `fs-tools.ts`             | `fs-tools/read.test.ts`, `write`, `edit`, `grep`, `file-index`                                                                                                                                            |
| `goal.test.ts`                 | `goal.ts`                 | `goal/goal.test.ts`, `goal/goal-store.test.ts`, `goal/goal-stream-failure.test.ts`                                                                                                                        |
| `handoff.test.ts`              | `handoff.ts`              | `handoff.test.ts` (kept), `handoff/handoff-rpc.test.ts`                                                                                                                                                   |
| `index.test.ts`                | `index.ts`                | `starting-extensions.test.ts`, `tool-schema.test.ts`                                                                                                                                                      |
| `interaction-tools.test.ts`    | `interaction-tools.ts`    | `interaction-tools/ask-user.test.ts`, `prompt`, `interaction-tools-rpc`                                                                                                                                   |
| `network-tools.test.ts`        | `network-tools.ts`        | `network-tools/websearch.test.ts`                                                                                                                                                                         |
| `openai.test.ts`               | `openai.ts`               | all four `openai/*.test.ts`                                                                                                                                                                               |
| `providers.test.ts`            | `providers.ts`            | `openai-compatible-providers.test.ts`                                                                                                                                                                     |
| `session-tools.test.ts`        | `session-tools.ts`        | `session-tools.test.ts` (kept), `session-tools/read-session.test.ts`, `session-tools/session-tools-rpc.test.ts`                                                                                           |
| `skills.test.ts`               | `skills.ts`               | `skills/skills.test.ts`, `skills/skills-rpc.test.ts`, `skills/bundled-skills.test.ts`                                                                                                                     |
| `wake.test.ts`                 | `wake.ts`                 | `wake/wake.test.ts`, `wake/wake-store.test.ts`                                                                                                                                                            |
| `workflows.test.ts`            | `workflows.ts`            | `workflows.test.ts` (kept)                                                                                                                                                                                |

## Cross-cutting placement

- `fs-tools/fs-tools-model-turn.test.ts` imports `src/agents.js` and
  `src/index.js`, not `src/fs-tools.ts`. It exercises the agent tool grant, so
  it folds into `agents.test.ts`.
- `cell/cell-child-foreground.test.ts`, `cell/cell-lifetime.test.ts` and
  `cell/cell-recovery.test.ts` also import `src/delegate.js`; the cell is the
  subject, so they fold into `cell.test.ts`.
- `cell/turn-prompt-sections.test.ts` and
  `cell/model-context-directives.test.ts` exercise `CellTool` prompt and
  model-context contributions; they fold into `cell.test.ts`.
- `tool-schema.test.ts` walks the shipped preset from `src/index.ts`; it folds
  into `index.test.ts` beside `starting-extensions.test.ts`.
- Each `anthropic/*` and `openai/*` test also imports `src/providers.js` for
  the shared provider types. The provider under test owns the file, so only
  `openai-compatible-providers.test.ts` (Google and Mistral) becomes
  `providers.test.ts`.

## Helper modules (rule 6)

- `tests/helpers/test-preset.ts` — 25 importers, stays.
- `tests/helpers/tool-event.ts` — 7 importers, stays.
- `tests/helpers/builtin-agents.ts` — 3 importers (`session-tools`,
  `delegate` ×2) plus `helpers/test-preset.ts`, stays.
- `tests/helpers/external-wire.ts` — 4 importers across three targets, stays.
- `tests/run-effect-boundary.ts` — 2 importers (`anthropic`, `openai`), stays.
- `tests/helpers/scoped-temp-dir.ts` — 0 importers, dead; deleted.
- `tests/acp-agents/fake-acp-peer.ts` — 1 importer, folds into
  `acp-agents.test.ts`.
- `tests/cell/cell-worker-fixture.ts` — 8 importers, all inside the `cell`
  group, folds into `cell.test.ts`.

## Rule 4

No test file uses `mock.module`, `setSystemTime`, a `process.env` write, or a
top-level `beforeAll`/`afterAll`/`afterEach`. There is no rule-4 exception.

## Renames (rule 3)

Hoisted — the two copies were the same declaration, so one was kept:

- `decodeWire`, `encodeWire`, `WireRecord` — `acp-agents/protocol` dropped its
  copy; `acp-agents/fake-acp-peer` keeps it.
- `encodeAlarms` — `wake/wake-store` dropped its copy; `wake/wake` keeps it.
- `ctx`, `ToolLayer` — `fs-tools/write` dropped its copies; `fs-tools/read`
  keeps them. Four imports `write` no longer needs were dropped with them.
- `promptText` — `compaction/model-compaction-rpc` dropped its copy; the
  unused `Predicate` import went with it.
- `FAR_FUTURE_MS` — `openai/openai-extension-driver` dropped its copy.
- `JsonRecordSchema`, `JsonRecord` — `anthropic/anthropic-keychain-transform`
  dropped its copies; `anthropic-keychain-client` keeps them.
- `platformLayer` — five `cell/*` files dropped their copies; `cell/cell-process`
  keeps it.
- `now` — `cell/code-cell-execution-storage` dropped its copy.

Renamed with the section stem — the copies differed:

| Old                                | New                                  | File                                     |
| ---------------------------------- | ------------------------------------ | ---------------------------------------- |
| `ToolLayer`                        | `ToolLayerGrep`                      | `fs-tools/grep`                          |
| `ctx`                              | `ctxGrep`                            | `fs-tools/grep`                          |
| `PlatformLayer`                    | `PlatformLayerFileIndex`             | `fs-tools/file-index`                    |
| `JsonRecordSchema`                 | `JsonRecordSchemaDriver`             | `anthropic/anthropic-extension-driver`   |
| `JsonRecord`                       | `JsonRecordDriver`                   | `anthropic/anthropic-extension-driver`   |
| `makeCreds`                        | `makeCredsKeychain`                  | `anthropic/anthropic-keychain-transform` |
| `runWithTestClock`                 | `runWithTestClockKeychain`           | `anthropic/anthropic-keychain-transform` |
| `testPlatformLayer`                | `testPlatformLayerCredentialService` | `anthropic/anthropic-credential-service` |
| `sessionId`, `branchId`, `request` | `…ToolCall`                          | `cell/cell-tool-call`                    |
| `sessionId`, `branchId`            | `…ContextHost`                       | `cell/cell-context-host`                 |
| `request`, `cell`                  | `…ToolHost`                          | `cell/cell-tool-host`                    |
| `request`, `cell`                  | `…OperationStorage`                  | `cell/code-cell-tool-operation-storage`  |
| `CapturedRequest`                  | `CapturedRequestCodexTransform`      | `openai/openai-codex-transform`          |

Other edits the fold needed:

- `cell/cell-process` imported `buildCellWorker as buildWorker` from the folded
  fixture. The alias is gone; the file now calls `buildCellWorker`.
- Nine files imported `describe`/`test`/`it`/`expect` from `bun:test` while a
  fold sibling took them from `effect-bun-test`. They now all use
  `effect-bun-test`. Two of them (`anthropic-keychain`, `anthropic-oauth-refresh`,
  `anthropic-signing`) ran sync bodies through `it()`; those bodies now use
  `test()`, because `effect-bun-test`'s plain `it()` is inert.
- Specifier mismatches that would duplicate an identifier after the merge:
  `delegate-rpc` and `goal` take `SessionId`/`BranchId` from
  `@gent/core-internal/domain/ids`; `cell-default-surface` takes
  `AgentDefinition`/`AgentName` from `@gent/core-internal/domain/agent.js`;
  `turn-prompt-sections` takes `tool` from `@gent/core/extensions/api`;
  `fs-tools-model-turn` uses the `.js` specifier suffix.
- `packages/tooling/tests/export-consumers.test.ts` names
  `packages/extensions/tests/fs-tools/edit.test.ts` in a synthetic fixture. The
  string now names `packages/extensions/tests/fs-tools.test.ts`.

## Fold-tool gaps found

- The tool rewrites `import` specifiers but not a runtime path string. The cell
  worker fixture builds its worker from
  `new URL("../../src/cell-worker-boundary.ts", import.meta.url)`. The fold
  moved the file up one directory and left the string, so 34 cell tests failed.
  Fixed by hand to `"../src/cell-worker-boundary.ts"`.
- The collision check reads declarations only. An `interface CapturedRequest`
  in one section against a `type CapturedRequest` _import_ in another passed
  the dry run and failed typecheck (TS2440).

## After

23 test files, 17,831 lines, 551 tests. `bun run test` ran three times:
23.7 s cold, then 13.0 s and 13.3 s.

The pass count and the `expect()` count both hold: 551 pass / 1,816 expect
calls before and after.

Wall time grew from 11.2 s to about 13 s. `bun test --parallel=3` schedules one
worker per file, so 83 files overlapped more than 23 do. No single file is near
the 60 s limit: the longest is `cell.test.ts` at 13.9 s on its own, then
`delegate.test.ts` at 5.8 s. No split was needed (rule 9).

`bun run gate` passes. It failed twice first, each time on
`packages/core/tests/runtime/run-process.test.ts`, which timed out at 10 s. That
test is outside this diff: its last change is `853a067c`, and it runs in 0.35 s
on its own. Turbo starts every package's suite at once and each asks for three
workers, so a real-process test can starve. Rerun the gate before you treat such
a failure as yours.
