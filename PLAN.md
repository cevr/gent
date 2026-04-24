# Planify: Recursive Hardening Wave 3

## Context

Wave 2 implementation completed and was gated, including the fresh final audit.
That audit still found material P2 issues. This plan supersedes Wave 2 and is
not complete until the batches below are implemented, gated, reviewed, and the
fresh eight-point recursive audit reports no P1/P2 findings.

Current verification before this rewrite:

- `bun run gate` green at HEAD `37eedee1`.
- `bun run test:e2e` green at HEAD `37eedee1`.
- Eight fresh audit agents completed. Runtime ownership, Effect AI integration,
  and domain modeling were clean for P1/P2. Storage, extension boundaries,
  auth boundary behavior, SDK/TUI auth behavior, and public test coverage still
  reported P2 findings.

## Scope

- **In**: auth storage fail-closed behavior, auth error propagation, session-cwd
  auth UI calls, extension request session/branch validation, profile-scoped
  capability service provision, SQLite lineage constraints, recursive session
  cleanup, and missing public RPC regression coverage.
- **Out**: optional P3 cleanup, package-policy removal, and docs-only drift.
  Package-policy removal waits until recursive audit is clean.

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

| ID  | Severity | Finding                                                                                                      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | -------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1  | P2       | Auth file parse/decrypt/schema failures collapse to an empty store, so the next write can erase credentials. | `packages/core/src/domain/auth-storage.ts:366`, `packages/core/src/domain/auth-storage.ts:380`, `packages/core/src/domain/auth-storage.ts:410-429`                                                                                                                                                                                                                                                                       |
| B2  | P2       | `AuthGuard.listProviders` discards typed auth read/decode failures before SDK/TUI callers can surface them.  | `packages/core/src/domain/auth-store.ts:86-94`, `packages/core/src/domain/auth-guard.ts:131-133`, `apps/tui/src/routes/auth.tsx:95`                                                                                                                                                                                                                                                                                      |
| B3  | P2       | Auth overlay drops active session context and can resolve project auth against launch cwd.                   | `packages/core/src/domain/auth-guard.ts:24-41`, `packages/core/src/server/rpc-handler-groups/config.ts:97`, `apps/tui/src/app-bootstrap.ts:177`, `apps/tui/src/routes/session-controller.ts:188`, `apps/tui/src/routes/auth.tsx:37`, `apps/tui/src/routes/auth.tsx:82`, `apps/tui/src/routes/auth.tsx:224`                                                                                                               |
| B4  | P2       | Profile-scoped resource services are not provided when running profile capabilities.                         | `packages/core/src/runtime/profile.ts:340-360`, `packages/core/src/runtime/session-profile.ts:52-63`, `packages/core/src/runtime/session-profile.ts:141-152`, `packages/core/src/runtime/session-runtime-context.ts:63-74`, `packages/core/src/runtime/make-extension-host-context.ts:261`, `packages/core/src/server/rpc-handler-groups/extension.ts:84`, `packages/core/src/runtime/extensions/capability-host.ts:259` |
| B5  | P2       | Public `extension.request` accepts missing/deleted sessions and falls back to launch cwd.                    | `packages/core/src/server/transport-contract.ts:342-351`, `packages/core/src/server/rpc-handlers.ts:61-76`, `packages/core/src/server/rpc-handler-groups/extension.ts:81-93`, `apps/tui/src/extensions/client-transport.ts:210`                                                                                                                                                                                          |
| B6  | P2       | Public `extension.request` trusts caller-supplied branch ownership.                                          | `packages/core/src/server/rpc-handler-groups/extension.ts:81-92`, `packages/core/src/server/transport-contract.ts:351`, `packages/extensions/src/task-tools/requests.ts:145-150`, `packages/core/src/server/session-queries.ts:133-134`                                                                                                                                                                                  |
| B7  | P2       | SQLite still allows `parent_branch_id` without `parent_session_id` through direct SQL.                       | `packages/core/src/storage/sqlite-storage.ts:590-604`, `packages/core/src/storage/sqlite-storage.ts:858-872`, `packages/core/src/storage/sqlite-storage.ts:1109`, `packages/core/src/storage/sqlite-storage.ts:1562`, `packages/core/src/storage/sqlite-storage.ts:1273`                                                                                                                                                 |
| B8  | P2       | Parent session delete cascades child sessions durably but cleans runtime state only for the root session.    | `packages/core/src/storage/sqlite-storage.ts:1190`, `packages/core/tests/storage/sqlite-storage.test.ts:364`, `packages/core/src/server/session-commands.ts:323-332`, `packages/core/src/server/session-commands.ts:832-843`, `packages/core/src/runtime/extensions/resource-host/machine-engine.ts:276`, `packages/core/src/domain/event.ts:538`, `packages/core/src/runtime/session-cwd-registry.ts:107`               |
| B9  | P2       | `session.create` lacks public RPC-tier coverage for `parentBranchId` without `parentSessionId`.              | `packages/core/src/server/transport-contract.ts:19`, `packages/core/src/server/rpc-handler-groups/session.ts:40`, `packages/core/src/server/session-commands.ts:452`, `packages/core/tests/server/session-commands.test.ts:460`, `packages/core/tests/storage/sqlite-storage.test.ts:240`, `packages/core/tests/server/session-queries.test.ts:162`                                                                      |

---

## Commit 1: `fix(auth): fail closed on auth storage read errors`

**Justification**: Auth credentials are durable user state. Corrupt or
undecryptable auth data must stop writes, not masquerade as an empty store.

**Principles**:

- `fix-root-causes`: preserve the boundary error instead of treating corruption
  as missing data.
- `boundary-discipline`: file/decrypt/schema failures are storage-boundary
  errors and must cross the service boundary typed.
- `prove-it-works`: reproduce fail-open writes and AuthGuard swallowing errors.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                              | Change                                                                                        | Lines    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------- |
| `packages/core/src/domain/auth-storage.ts`        | Remove catch-all empty fallback for decrypt/read failures; keep missing/empty files as empty. | ~330-380 |
| `packages/core/src/domain/auth-guard.ts`          | Propagate typed auth read failures from `listProviders` instead of converting to no key.      | ~124-150 |
| `packages/core/tests/domain/auth-storage.test.ts` | Add regression for corrupt/encrypted-file read blocking `set` and `delete`.                   | existing |
| `packages/core/tests/server/auth-rpc.test.ts`     | Add public RPC regression that auth read/decode failure surfaces to callers.                  | existing |

**Verification**:

- `bun test packages/core/tests/domain/auth-storage.test.ts packages/core/tests/server/auth-rpc.test.ts`
- `bun run gate`

---

## Commit 2: `fix(tui): carry session context through auth overlay`

**Justification**: Auth method selection is project-cwd sensitive. The TUI
overlay must query and persist auth through the active session context rather
than launch-cwd defaults or synthetic session ids.

**Principles**:

- `single-source-of-truth`: session cwd comes from the active session, not a
  synthetic id.
- `test-through-public-interfaces`: exercise the same TUI auth surface a caller
  uses.

**Skills**: `architecture`, `effect-v4`, `react`, `test`, `code-style`, `bun`

**Changes**:

| File                                        | Change                                                                                     | Lines    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ | -------- |
| `apps/tui/src/routes/auth.tsx`              | Accept/thread active `sessionId` into `listProviders`, `authorize`, and callback handling. | ~37-224  |
| `apps/tui/src/routes/session-controller.ts` | Pass the active session id into the auth overlay route.                                    | ~188     |
| `apps/tui/src/app-bootstrap.ts`             | Preserve startup/session auth-gate behavior while avoiding synthetic session context.      | ~177     |
| `apps/tui/tests` or `apps/tui/integration`  | Add regression for auth overlay calling `auth.listProviders` with active session id.       | existing |

**Verification**:

- targeted TUI auth tests, discovered during implementation
- `bun run gate`
- `bun run test:e2e`

---

## Commit 3: `fix(extensions): enforce session boundary for capability requests`

**Justification**: Public and nested capability requests execute inside a
session boundary. Missing sessions, cross-session branches, and missing
profile-scoped services are boundary violations.

**Principles**:

- `boundary-discipline`: validate session/branch ownership at the RPC boundary.
- `small-interface-deep-implementation`: capability effects should receive the
  complete profile runtime context through one narrow dispatch surface.
- `make-impossible-states-unrepresentable`: request context must not encode a
  branch that does not belong to the session.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                          | Change                                                                                                             | Lines    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------- |
| `packages/core/src/runtime/session-profile.ts`                | Preserve profile `layerContext` or equivalent capability execution context on `SessionProfile`.                    | ~52-152  |
| `packages/core/src/runtime/session-runtime-context.ts`        | Thread profile execution context into active bindings/host context creation.                                       | ~63-105  |
| `packages/core/src/runtime/make-extension-host-context.ts`    | Run nested capability requests with the profile execution context and session cwd.                                 | ~246-270 |
| `packages/core/src/server/rpc-handler-groups/extension.ts`    | Reject missing sessions; verify branch belongs to session; run transport-public capabilities with profile context. | ~72-109  |
| `packages/core/tests/runtime/session-runtime-context.test.ts` | Add regression for profile-scoped service availability in nested capability requests.                              | existing |
| `packages/core/tests/server/extension-commands-rpc.test.ts`   | Add RPC regressions for missing session, cross-session branch, and profile service availability.                   | existing |

**Verification**:

- `bun test packages/core/tests/runtime/session-runtime-context.test.ts packages/core/tests/server/extension-commands-rpc.test.ts`
- `bun run gate`
- `bun run test:e2e`

---

## Commit 4: `fix(storage): harden session lineage cleanup`

**Justification**: Durable session lineage and runtime state must agree. Direct
SQL cannot create impossible parent shapes, and deleting a parent session must
clean every descendant session runtime boundary it deletes durably.

**Principles**:

- `make-impossible-states-unrepresentable`: enforce parent branch/session
  pairing in SQLite, not only service code.
- `serialize-shared-state-mutations`: session deletion owns all descendant
  cleanup before durable rows disappear.
- `prove-it-works`: cover direct SQL and command-level recursive cleanup.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                  | Change                                                                                                    | Lines              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------ |
| `packages/core/src/storage/sqlite-storage.ts`         | Add/migrate a `CHECK (parent_branch_id IS NULL OR parent_session_id IS NOT NULL)` constraint on sessions. | ~590-604, ~858-872 |
| `packages/core/src/storage/sqlite-storage.ts`         | Add/read helper for descendant sessions, or reuse existing child-session traversal safely.                | ~1190, ~1562       |
| `packages/core/src/server/session-commands.ts`        | Clean runtime/event/cwd state for all descendant sessions deleted by a parent-session delete.             | ~323-332, ~832-843 |
| `packages/core/tests/storage/sqlite-storage.test.ts`  | Add direct-SQL invariant regression and migration/repair coverage where needed.                           | existing           |
| `packages/core/tests/server/session-commands.test.ts` | Add command-level recursive cleanup regression with child sessions.                                       | existing           |

**Verification**:

- `bun test packages/core/tests/storage/sqlite-storage.test.ts packages/core/tests/server/session-commands.test.ts`
- `bun run gate`
- `bun run test:e2e`

---

## Commit 5: `test(server): cover parent branch session create boundary`

**Justification**: The original finding targeted public session creation. The
public RPC layer needs a regression so transport/schema/handler drift cannot
silently bypass command invariants.

**Principles**:

- `test-through-public-interfaces`: assert through `client.session.create`.
- `prove-it-works`: lock the public failure shape, not only storage/command internals.

**Skills**: `test`, `effect-v4`, `code-style`, `bun`

**Changes**:

| File                                                                               | Change                                                                            | Lines    |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------- |
| `packages/core/tests/server/session-queries.test.ts` or `session-commands.test.ts` | Add `Gent.test(...).client.session.create({ parentBranchId })` failure assertion. | existing |

**Verification**:

- targeted server test for session RPC create
- `bun run gate`

---

## Commit 6: `chore(audit): rerun recursive verification`

**Justification**: Completion is observed only when all original target points
and the new P2 points are audited fresh and no P1/P2 remains.

**Principles**:

- `prove-it-works`: final status must be backed by gate, e2e, and fresh audits.
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
- [ ] Auth storage read/decode failures fail closed and cannot erase credentials.
- [ ] AuthGuard surfaces typed auth read/decode failures to public callers.
- [ ] TUI auth overlay carries active session context for project-cwd auth.
- [ ] Capability requests reject missing sessions.
- [ ] Capability requests reject branch/session mismatches.
- [ ] Profile-scoped capability effects receive profile resource services.
- [ ] SQLite rejects `parent_branch_id` without `parent_session_id`.
- [ ] Parent session delete cleans descendant runtime/event/cwd state.
- [ ] Public `session.create` rejects `parentBranchId` without `parentSessionId`.
- [ ] Final recursive audit reports no P1/P2 findings.

## Current Status

- Wave 2 implementation completed through commit `37eedee1`.
- Fresh recursive audit found material P2 findings B1-B9.
- This plan supersedes Wave 2.
- Implementation of this wave has not started.
