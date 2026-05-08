# Planify: Wave 25 — Close W24.6 Recursive P1s

## Context

Wave 24 fixed the known W23 recursive P1s, but W24.6 verification found
remaining blockers at the public transport and background-job terminal
boundaries. Correctness is still the closure condition: no P0/P1 findings.

## Scope

**In**

- Forward branch RPC `requestId` fields through the production handler boundary.
- Add public RPC regressions proving duplicate branch requests converge through
  the real transport handler, not only `SessionCommands`.
- Make background bash terminal state the durable source of truth before
  emitting terminal follow-ups, and replay terminal follow-ups from durable
  state on retry.
- Close TUI e2e import drift from the W24.5 boundary harness rename.
- Wire the orphan helper-file Promise-control fixture into the tooling suite.
- Re-run W24.6 gates and recursive verification.

**Out**

- P2-only upstream DX from W24.6: `TaggedEnumClass` native-schema migration,
  `effect-wide-event` semantic outcomes / peer-only packaging, Encore
  stateful actor DX, and server-root caller platform leak.

## Gate Command

```bash
bun run typecheck && bun run lint && bun run fmt:check && bun run build
```

Behavioral gates:

- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/server/session-idempotency.test.ts`
- `cd packages/extensions && bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/exec-tools/bash-execution.test.ts`
- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/tooling/tests/fixtures.test.ts`
- `bun run --cwd apps/tui test:e2e`
- `bun run smoke`
- `bun run test:e2e`

`bun run test` may still hit the known Bun 1.3.13 signal-5 crash in the
concurrent core xargs shard; if so, focused/package evidence is acceptable.

## P1 Findings

### P1 — Branch RPC Request IDs Are Dropped

The transport contract and TUI provide `requestId` for branch create/switch/fork,
but `rpc-handlers.ts` omits it when calling `SessionCommands`.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:52`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:60`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:70`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:750`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:772`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:804`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:208`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:216`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:224`

### P1 — Background Bash Terminal State And Notification Are Not Convergent

Background completion queues the follow-up before marking the job completed. A
crash between those effects can later reconcile the same job as interrupted.
Queue errors are swallowed before terminal state is persisted, making some
terminal notifications unrecoverable.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:178`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:185`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:190`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:255`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:260`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash-storage.ts:199`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash-storage.ts:202`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash-storage.ts:207`

### P1 — TUI E2E Harness Rename Drift

W24.5 renamed TUI Promise boundary helpers, but integration tests still imported
the deleted `../tests/render-harness` module.

Receipts:

- `/Users/cvr/Developer/personal/gent/apps/tui/integration/app-bootstrap.test.tsx:10`
- `/Users/cvr/Developer/personal/gent/apps/tui/integration/helpers.ts:3`
- `/Users/cvr/Developer/personal/gent/apps/tui/integration/session-feed-boundary.test.tsx:11`
- `/Users/cvr/Developer/personal/gent/apps/tui/integration/session-lifecycle.test.tsx:10`

## Batches

### W25.1 — Public Branch RPC Idempotency

Status: done.

**Justification**: Request-id durability must hold at the public transport
boundary, not only the command service boundary.

**Principles**

- `make-operations-idempotent`
- `test-through-public-interfaces`
- `boundary-discipline`

**Changes**

| File                                                     | Change                                              | Lines    |
| -------------------------------------------------------- | --------------------------------------------------- | -------- |
| `packages/core/src/server/rpc-handlers.ts`               | Thread branch `requestId` into `SessionCommands`    | ~208-230 |
| `packages/core/tests/server/session-idempotency.test.ts` | Add public RPC duplicate branch request regressions | ~1-700   |

**Verification**

- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/server/session-idempotency.test.ts` — 19 pass, 0 fail.
- `bun run typecheck` — pass.
- `bun run lint` — pass, 0 warnings/errors.
- `bun run fmt:check` — pass.

### W25.2 — Durable Background Bash Terminal Replay

Status: done.

**Justification**: Terminal job state must be durable before notification and
retries must converge by replaying deterministic terminal follow-ups.

**Principles**

- `make-operations-idempotent`
- `serialize-shared-state-mutations`
- `terminal-state-exit-safety`

**Changes**

| File                                                          | Change                                                       | Lines            |
| ------------------------------------------------------------- | ------------------------------------------------------------ | ---------------- |
| `packages/extensions/src/exec-tools/bash-storage.ts`          | Return full terminal state for replay                        | ~39-80, ~112-155 |
| `packages/extensions/src/exec-tools/bash.ts`                  | Mark terminal before queueing, replay terminal notifications | ~224-300         |
| `packages/extensions/tests/exec-tools/bash-execution.test.ts` | Add crash-window/retry regression                            | ~266-330         |

**Verification**

- `cd packages/extensions && bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/exec-tools/bash-execution.test.ts` — 9 pass, 0 fail.
- `bun run typecheck` — pass.
- `bun run lint` — pass, 0 warnings/errors.
- `bun run fmt:check` — pass.

### W25.3 — Guardrail Test Closure

Status: done.

**Justification**: Recursive verification found a test harness drift and an
orphaned guardrail fixture. The guardrail suite must prove the exact surface it
claims.

**Principles**

- `prove-it-works`
- `test-through-public-interfaces`

**Changes**

| File                                      | Change                                      | Lines    |
| ----------------------------------------- | ------------------------------------------- | -------- |
| `apps/tui/integration/*.tsx`              | Import explicit boundary harness            | ~1-15    |
| `apps/tui/integration/helpers.ts`         | Import explicit boundary harness            | ~1-5     |
| `packages/tooling/tests/fixtures.test.ts` | Include helper-file Promise-control fixture | ~140-160 |

**Verification**

- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/tooling/tests/fixtures.test.ts` — 30 pass, 0 fail.
- `bun run --cwd apps/tui test:e2e` — 24 pass, 0 fail.
- `bun run typecheck` — pass.
- `bun run lint` — pass, 0 warnings/errors.
- `bun run fmt:check` — pass.

### W25.4 — Recursive Verification

Status: found Wave 26 blockers.

**Justification**: The wave is not done until fresh verification finds no P0/P1.

**Principles**

- `prove-it-works`
- `correctness-over-pragmatism`

**Changes**

| File               | Change                               | Lines      |
| ------------------ | ------------------------------------ | ---------- |
| `plans/WAVE-24.md` | Mark W24.6 as Wave 25 required       | ~330-360   |
| `plans/WAVE-25.md` | Record receipts and closure decision | whole file |

**Verification**

- Re-run W24.6 audit lanes or equivalent focused verification.
- Full gate commands listed above.
- `bun run typecheck && bun run lint && bun run fmt:check && bun run build` — pass.
- `bun run smoke` — pass, headless TUI returned `Hey, what's up?`.
- `bun run test:e2e` — `@gent/tui` 24 pass, `@gent/e2e` 36 pass.
- `bun run test` — pass.
- Fresh verification found extension-owned P1 blockers in task terminal
  transition atomicity, bash failure terminal durability, and helper fixture
  strictness.
- Synthesized `/Users/cvr/Developer/personal/gent/plans/WAVE-26.md`.
