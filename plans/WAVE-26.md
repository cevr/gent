# Planify: Wave 26 — Extension-Owned Terminal Task Closure

## Context

Wave 25 closed the W24.6 public idempotency and guardrail blockers, but fresh
recursive verification at `051a12f6` found remaining extension-owned P1s:
task terminal states were not enforced at the SQLite write boundary, and bash
failure notifications could still emit without durable terminal state.

## Scope

**In**

- Move product task status transition enforcement into `TaskStorage.updateTask`
  so terminal states are checked inside the write transaction.
- Keep product task behavior inside `@gent/task-tools`; core only keeps
  machine/runtime telemetry.
- Require failed background bash terminal state to commit before a failure
  follow-up can be emitted.
- Tighten the helper-module Promise-control fixture with an exact diagnostic
  count.
- Update task ownership docs to match the extension-owned implementation.
- Re-run recursive verification until no P0/P1 remains.

**Out**

- P2-only upstream packaging/docs items from W25 verification.
- Moving residual test files unless they hide a P0/P1 behavior gap.

## P1 Findings

### P1 — Task Stop Can Be Overwritten By Concurrent Completion

`TaskService.update` read the existing task and validated the transition before
calling `TaskStorage.updateTask`. That made `stopped` terminal in the service
model but not at the durable write boundary.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/task-tools/domain.ts:16`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/task-tools/domain.ts:21`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/task-tools-service.ts:196`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/task-tools-storage.ts:338`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:149`

### P1 — Bash Failure Notifications Can Outrun Durable State

The success path persisted terminal state before queueing a follow-up, but
`queueFailure` swallowed `markFailed` errors and still emitted the failure
notification.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:286`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:287`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:290`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash-storage.ts:198`

### P1 — Helper Promise-Control Fixture Was Wired But Loose

The helper-module invalid fixture had no `expectedCount`, so the suite proved
only that at least one violation fired, not that all guarded Promise-control
forms stayed covered.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/tooling/tests/fixtures.test.ts:154`
- `/Users/cvr/Developer/personal/gent/packages/tooling/tests/fixtures.test.ts:157`
- `/Users/cvr/Developer/personal/gent/packages/tooling/fixtures/test-module-control-flow/tests/no-promise-control-flow-in-tests.invalid.module.ts:3`
- `/Users/cvr/Developer/personal/gent/packages/tooling/fixtures/test-module-control-flow/tests/no-promise-control-flow-in-tests.invalid.module.ts:11`

## Batches

### W26.1 — Atomic Task Terminal Transitions

Status: done.

**Changes**

| File                                                                    | Change                                      |
| ----------------------------------------------------------------------- | ------------------------------------------- |
| `packages/extensions/src/task-tools-storage.ts`                         | Validate status transitions inside tx write |
| `packages/extensions/src/task-tools-service.ts`                         | Remove separate service pre-read validation |
| `packages/extensions/tests/task-tools/task-storage-integration.test.ts` | Cover terminal transition write boundary    |

**Verification**

- `cd packages/extensions && bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/task-tools/task-storage-integration.test.ts tests/task-tools/task-service.test.ts tests/exec-tools/bash-execution.test.ts` — 30 pass, 0 fail.
- `bun run typecheck` — pass.

### W26.2 — Durable-First Bash Failure Notifications

Status: done.

**Changes**

| File                                                          | Change                                        |
| ------------------------------------------------------------- | --------------------------------------------- |
| `packages/extensions/src/exec-tools/bash.ts`                  | Do not notify when `markFailed` cannot commit |
| `packages/extensions/tests/exec-tools/bash-execution.test.ts` | Add failed-terminal durable-first regression  |

**Verification**

- `cd packages/extensions && bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/task-tools/task-storage-integration.test.ts tests/task-tools/task-service.test.ts tests/exec-tools/bash-execution.test.ts` — 30 pass, 0 fail.
- `bun run typecheck` — pass.

### W26.3 — Strict Guardrail Fixture And Docs

Status: done.

**Changes**

| File                                      | Change                                    |
| ----------------------------------------- | ----------------------------------------- |
| `packages/tooling/tests/fixtures.test.ts` | Add exact helper fixture diagnostic count |
| `ARCHITECTURE.md`                         | Refresh task ownership docs               |

**Verification**

- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/tooling/tests/fixtures.test.ts` — 30 pass, 0 fail.

### W26.4 — Recursive Verification

Status: done.

**Verification**

- Final verification lanes found no remaining P0/P1 and no further wave
  required.
- `bun run typecheck` — pass.
- `bun run lint` — pass, 0 warnings/errors.
- `bun run fmt:check` — pass.
- `bun run build` — pass.
- `bun run smoke` — pass, headless TUI returned `Hey, what's up?`.
- `bun run test:e2e` — `@gent/tui` 24 pass, `@gent/e2e` 36 pass.
- `bun run test` — pass, including `@gent/extensions` 551 pass and
  `@gent/tooling` 67 pass.
