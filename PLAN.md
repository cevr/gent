# Planify: Recursive Hardening Wave 2

## Context

The final recursive audit at HEAD `189a24b7` found material P2 issues. The
plan is not complete until these findings are fixed, gated, reviewed, and a
fresh eight-point audit reports no P1/P2 findings.

## Scope

- **In**: storage/session lineage invariants, auth failure propagation, legacy
  auth decode compatibility, stream retry semantics, capability request cwd,
  and public-tier regression coverage.
- **Out**: optional P3 cleanup, package-policy removal, and non-material seam
  polish. Those wait until the recursive audit is clean.

## Constraints

- Correctness over expedience.
- Breaking changes are acceptable only with migration or compatibility handling.
- One implementation commit per batch.
- Run `bun run gate` for every batch.
- Run `bun run test:e2e` for high-blast-radius storage/runtime/server batches.
- Run exactly one review subagent per implementation commit.
- If final audit finds any P1/P2, overwrite this file with the next recursive
  Planify plan and continue.

## Applicable Skills

`architecture`, `effect-v4`, `test`, `code-style`, `bun`, `planify`

## Gate Command

`bun run gate`

---

## Audit Findings

| ID  | Severity | Finding                                                                       | Evidence                                                                                                                                                                                                                        |
| --- | -------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | P2       | Capability request handlers receive server launch cwd instead of session cwd. | `packages/core/src/runtime/make-extension-host-context.ts:246-270`, `packages/core/src/server/rpc-handler-groups/extension.ts:72-96`, `packages/core/src/server/transport-contract.ts:342-359`                                  |
| A2  | P2       | OpenAI OAuth callback can falsely succeed with no credentials saved.          | `packages/extensions/src/openai/index.ts:195-197`, `packages/core/src/providers/provider-auth.ts:154`, `packages/core/src/server/rpc-handler-groups/config.ts:134`, `apps/tui/src/routes/auth.tsx:298-343`                      |
| A3  | P2       | Manual auth persistence failures are swallowed at the RPC boundary.           | `packages/core/src/domain/auth-store.ts:95`, `packages/core/src/server/rpc-handler-groups/config.ts:105-116`, `apps/tui/src/routes/auth.tsx:156-186`                                                                            |
| A4  | P2       | Retry wraps stream construction, not stream consumption.                      | `packages/core/src/providers/provider.ts:441-452`, `packages/core/src/runtime/agent/agent-loop.ts:723-751`, `packages/core/src/runtime/agent/agent-loop.ts:1115`, `packages/core/src/runtime/retry.ts:133`                      |
| A5  | P2       | Legacy OAuth auth records decode as API keys after tagged-enum migration.     | `packages/core/src/domain/auth-store.ts:5-61`, `packages/core/src/domain/schema-tagged-enum-class.ts:112`, `packages/core/src/providers/provider.ts:81`, `packages/core/src/runtime/model-registry.ts:207`                      |
| A6  | P2       | Provider auth persistence failures lack public RPC-tier coverage.             | `packages/core/tests/providers/provider-auth.test.ts:143-160`, `packages/core/tests/server/auth-rpc.test.ts:20-32`, `packages/core/src/server/rpcs/auth.ts:33-38`                                                               |
| A7  | P2       | Branch delete corrupts branch ancestry.                                       | `packages/core/src/storage/sqlite-storage.ts:609-617`, `packages/core/src/storage/sqlite-storage.ts:1178-1180`, `packages/core/src/server/session-commands.ts:818-837`, `packages/core/src/server/session-utils.ts:72-81`       |
| A8  | P2       | Branch delete can cascade-delete child sessions without session cleanup.      | `packages/core/src/storage/sqlite-storage.ts:850-852`, `packages/core/src/storage/sqlite-storage.ts:1213-1218`, `packages/core/src/server/session-commands.ts:803-837`, `packages/core/src/runtime/event-store-live.ts:100-106` |
| A9  | P2       | `parentBranchId` can be persisted without `parentSessionId`.                  | `packages/core/src/server/transport-contract.ts:19-23`, `packages/core/src/server/session-commands.ts:442-461`, `packages/core/src/storage/sqlite-storage.ts:850-852`, `packages/core/src/storage/sqlite-storage.ts:1085-1088`  |

---

## Commit 1: `fix(storage): preserve session branch lineage`

**Justification**: Session/branch lineage is durable domain state. Branch
deletion must not silently corrupt ancestry or bypass child-session cleanup.

**Principles**:

- `fix-root-causes`: block invalid deletion at the command/storage boundary.
- `make-invalid-states-unrepresentable`: parent branch/session relationships
  must be explicit and enforced.
- `prove-it-works`: reproduce the broken lineage and child-session cascade
  paths in tests.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                  | Change                                                                                                                | Lines                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `packages/core/src/server/session-commands.ts`        | Reject deleting a branch with child branches or child sessions; validate `parentBranchId` requires `parentSessionId`. | ~442-461, ~803-837   |
| `packages/core/src/storage/sqlite-storage.ts`         | Add storage helpers or constraints needed to detect child branches/sessions without cascade side effects.             | ~609-617, ~1178-1218 |
| `packages/core/tests/server/session-commands.test.ts` | Add command-level tests for child branch deletion, child session deletion, and parent branch without parent session.  | existing             |
| `packages/core/tests/storage/sqlite-storage.test.ts`  | Add storage-level regression tests where the invariant belongs below commands.                                        | existing             |

**Verification**:

- `bun test packages/core/tests/server/session-commands.test.ts packages/core/tests/storage/sqlite-storage.test.ts`
- `bun run gate`
- `bun run test:e2e`

---

## Commit 2: `fix(auth): preserve typed auth failures and legacy oauth`

**Justification**: Auth writes and callbacks are user-visible state changes.
They must fail when persistence fails, and legacy OAuth records must not become
API keys.

**Principles**:

- `typed-errors-over-logs`: persistence failures cross the RPC boundary as
  typed failures, not log-only success.
- `migrate-callers-then-delete-legacy-apis`: old auth records keep their
  semantics after schema migration.
- `make-invalid-states-unrepresentable`: stale OAuth callbacks cannot encode
  success without credentials.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                    | Change                                                                                                                   | Lines    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------- |
| `packages/core/src/domain/auth-store.ts`                | Decode legacy OAuth JSON records explicitly; keep raw string fallback only for raw API keys; use constructor discipline. | ~5-95    |
| `packages/extensions/src/openai/index.ts`               | Return a typed auth failure for missing/stale OAuth callback state instead of success.                                   | ~195-197 |
| `packages/core/src/server/rpc-handler-groups/config.ts` | Let `auth.setKey` and `auth.deleteKey` propagate typed persistence failures.                                             | ~105-116 |
| `packages/core/tests/domain/auth-store.test.ts`         | Add legacy OAuth decode regression and raw API-key fallback coverage.                                                    | existing |
| `packages/core/tests/server/auth-rpc.test.ts`           | Add RPC acceptance tests for manual auth write/delete failures and authorize/callback persistence failures.              | existing |
| `packages/core/tests/providers/provider-auth.test.ts`   | Extend stale callback coverage if needed by provider-level semantics.                                                    | existing |

**Verification**:

- `bun test packages/core/tests/domain/auth-store.test.ts packages/core/tests/server/auth-rpc.test.ts packages/core/tests/providers/provider-auth.test.ts`
- `bun run gate`

---

## Commit 3: `fix(runtime): retry provider stream consumption before output`

**Justification**: Retrying only stream construction misses the real request
failure path. Retry semantics should apply to the provider operation while
avoiding duplicate partial output.

**Principles**:

- `effect-boundaries-own-effects`: the retry boundary must wrap the effectful
  stream consumption, not just a lazy stream value.
- `do-not-lie-about-state`: once model bytes/tool calls are persisted, retrying
  the same turn can duplicate output; retry only before observable output.
- `prove-it-works`: test a retryable stream failure during consumption.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                               | Change                                                                                                                                        | Lines           |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `packages/core/src/runtime/agent/agent-loop.ts`                    | Move retry to the pre-output stream-consumption path or introduce an explicit provider-stream retry helper.                                   | ~723-751, ~1115 |
| `packages/core/src/providers/provider.ts`                          | Preserve retryable provider errors from stream consumption.                                                                                   | ~441-452        |
| `packages/core/tests/runtime/agent-loop.test.ts` or provider tests | Add regression for retryable stream-consumption failure before first output; assert no retry after partial output if that path is observable. | existing        |

**Verification**:

- `bun test packages/core/tests/runtime/agent-loop.test.ts packages/core/tests/providers/provider-resolution.test.ts`
- `bun run gate`
- `bun run test:e2e`

---

## Commit 4: `fix(extensions): use session cwd for capability requests`

**Justification**: Capability handlers are session-scoped. Passing launch cwd
through request paths breaks project-local tools/config in cross-cwd sessions.

**Principles**:

- `single-source-of-truth`: session cwd comes from resolved session runtime
  context, not ambient platform cwd.
- `boundary-honesty`: transport and host-context request paths must carry the
  same `CapabilityCoreContext`.
- `prove-it-works`: tests must assert nested request `ctx.cwd`, not only
  `hostCtx.cwd`.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                                                   | Change                                                                                             | Lines    |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------- |
| `packages/core/src/runtime/make-extension-host-context.ts`                             | Use `runInfo.sessionCwd ?? deps.platform.cwd` when constructing nested capability request context. | ~246-270 |
| `packages/core/src/server/rpc-handler-groups/extension.ts`                             | Resolve and pass session cwd into public `extension.request`.                                      | ~72-96   |
| `packages/core/tests/runtime/session-runtime-context.test.ts`                          | Add regression for nested capability request cwd.                                                  | existing |
| `packages/core/tests/server/extension-commands-rpc.test.ts` or `auth-rpc` style helper | Add RPC acceptance coverage for session cwd in request capability context.                         | existing |

**Verification**:

- `bun test packages/core/tests/runtime/session-runtime-context.test.ts packages/core/tests/server/extension-commands-rpc.test.ts`
- `bun run gate`

---

## Commit 5: `chore(audit): rerun recursive verification`

**Justification**: Completion is observed only when all original target points
are audited fresh and no P1/P2 remains.

**Principles**:

- `prove-it-works`: final status must be backed by gate, e2e, and eight fresh
  audits.
- `guard-the-context-window`: each audit agent owns one target point.
- `fix-root-causes`: material findings become the next plan, not ignored notes.

**Skills**: `planify`, `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File      | Change                                                                                                 | Lines      |
| --------- | ------------------------------------------------------------------------------------------------------ | ---------- |
| `PLAN.md` | Overwrite with either a final verification receipt or a new recursive plan if any audit reports P1/P2. | whole file |

**Verification**:

- `bun run gate`
- `bun run test:e2e`
- eight fresh independent audit agents:
  1. runtime ownership / actor-model clarity
  2. extension API boundaries
  3. Effect-native AI integration
  4. storage model
  5. domain modeling / constructor discipline
  6. suppression debt / boundary discipline
  7. SDK/TUI adapter debt
  8. test taxonomy / behavioral coverage

**Recursive Rule**:

If any audit agent reports a P1/P2 material finding:

1. overwrite `PLAN.md` with a new Planify plan containing those findings and
   commit batches
2. implement those batches with this same gate/review protocol
3. rerun this audit commit

Stop only when all eight fresh audits report no P1/P2 findings.

## End State Checks

- [ ] `bun run gate` is non-mutating and green.
- [ ] `bun run test:e2e` is green.
- [ ] Branch deletion cannot corrupt branch ancestry.
- [ ] Branch deletion cannot cascade-delete child sessions outside the session
      cleanup path.
- [ ] Public session creation cannot persist `parentBranchId` without
      `parentSessionId`.
- [ ] Legacy OAuth auth records decode as OAuth, not API keys.
- [ ] Manual auth persistence failures surface through public RPC.
- [ ] Stale OpenAI OAuth callbacks fail instead of reporting success.
- [ ] Retryable provider stream-consumption failures retry before observable
      output.
- [ ] Capability request handlers receive the session cwd.
- [ ] Final recursive audit reports no P1/P2 findings.

## Current Status

- Recursive audit completed at HEAD `189a24b7`.
- Material P2 findings remain.
- This plan supersedes the previous plan.
- Implementation has not started.
