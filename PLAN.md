# Planify: Recursive Audit Hardening Plan

## Context

The previous post-audit plan was executed through Batch 23 and the final
recursive audit batch was started at HEAD `ef27bc1f`. The audit did not clear.
Five of the eight original target points still produced P1/P2 structural
findings. Per the recursive rule, this file is overwritten with the next
execution contract.

This plan is based on:

- the completed commit history through `ef27bc1f`
- eight fresh independent audit agents, one per original target point
- direct source reads of the cited files
- brain vault principles loaded from `/Users/cvr/.brain/principles.md` and the
  relevant linked principle files

Goal: finish the original simplification work by fixing the remaining structural
issues. No feature cuts. Correctness over expedience. Breaking changes are
allowed when callers and tests migrate in the same wave.

## Scope

- **In**: runtime queue ownership, storage integrity, agent child-session
  atomicity, extension persistence failure semantics, package export
  boundaries, builtin extension privilege membrane, extension health modeling,
  driver event constructors, final recursive audit.
- **Out**: cosmetic renames, compatibility bridges kept for comfort, PR
  workflow, P3 polish unless it exposes a structural fault.

## Constraints

- Work lands in commit batches. Each batch must be independently gated.
- Gate every batch with `bun run gate`.
- Run `bun run test:e2e` for batches touching runtime ownership, storage/event
  durability, supervisor/lifecycle, transport contracts, or package boundaries
  that affect e2e consumers.
- Run exactly one review subagent per batch after the commit is created.
- If review finds real issues, fix them before moving to the next batch.
- If a batch grows past 20 files or crosses multiple subsystems, split it into
  reviewable sub-commits without asking.
- Migrate callers and delete legacy APIs in the same wave.
- No TODO placeholders. No `any` or `as unknown as X` to escape types.
- Final verification is recursive: if material findings remain, overwrite this
  file again and continue.

## Applicable Skills

- `planify`
- `architecture`
- `effect-v4`
- `code-style`
- `bun`
- `test`

## Gate Command

```bash
bun run gate
```

High-risk batches additionally run:

```bash
bun run test:e2e
```

## Principle Grounding

| Principle                                 | Application                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `serialize-shared-state-mutations`        | Queue/session mutations need one structural owner, not multiple callers mutating refs/storage directly.      |
| `make-operations-idempotent`              | Crash/retry points must converge without orphan rows, half-created child sessions, or stale extension state. |
| `boundary-discipline`                     | Public package exports and builtin membranes must not leak internal server/storage/runtime services.         |
| `small-interface-deep-implementation`     | Builtin extensions need a narrow event-publish facade, not full `EventPublisher`.                            |
| `make-impossible-states-unrepresentable`  | Health transport DTOs should not encode contradictory status bags.                                           |
| `migrate-callers-then-delete-legacy-apis` | Export-map and DTO migrations must move callers and remove the old broad path in one wave.                   |
| `use-the-platform`                        | SQLite FK enforcement belongs in SQLite, not in hand-rolled cleanup assumptions.                             |
| `prove-it-works`                          | Each fix gets direct tests for the failure mode, not confidence from typecheck alone.                        |
| `test-through-public-interfaces`          | Behavioral tests should exercise RPC/runtime/transport surfaces where callers observe the bug.               |
| `fix-root-causes`                         | The plan fixes owning boundaries, not single call sites.                                                     |

## Research Synthesis

### Audit Results

| Point                                    | Result   | Summary                                                                                                                                      |
| ---------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| runtime ownership / actor-model clarity  | Material | Queue mutations still bypass the serialized session owner. Session mutations remain split across server commands and extension host context. |
| extension API boundaries                 | Material | Core export map still exposes broad internals. Builtin membrane exports full `EventPublisher`.                                               |
| Effect-native AI integration             | Clean    | Provider/toolkit typing and Prompt/Response boundary now hold.                                                                               |
| storage model                            | Material | SQLite FKs are declared but not enforced. Durable agent child sessions are not atomic. Extension state persistence failures are swallowed.   |
| domain modeling / constructor discipline | Material | Health transport DTOs remain status bags. External driver TurnEvent producers bypass constructors.                                           |
| suppression debt / boundary discipline   | Material | Suppression policy is strong, but server internals remain wildcard-exported.                                                                 |
| SDK/TUI adapter debt                     | Clean    | Local supervisor, typed widgets, and atom registry ownership now hold.                                                                       |
| test taxonomy / behavioral coverage      | Clean    | CI/gate/e2e scripts execute claimed suites; route flow and lifecycle coverage are live.                                                      |

### Material Findings

| Severity | Finding                                                   | Evidence                                                                                                                                                                                                       |
| -------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Queue mutations still bypass the session mutation owner.  | `packages/core/src/runtime/agent/agent-loop.ts:2223-2229,2769-2777,2864-2880,3106-3116`; `packages/core/src/runtime/session-runtime.ts:296-389`; `packages/core/tests/runtime/session-runtime.test.ts:513-650` |
| P1       | SQLite foreign keys are not enforced.                     | `packages/core/src/storage/sqlite-storage.ts:518-651,1290-1361`; direct audit probe showed `PRAGMA foreign_keys = 0`, orphan rows insert, and delete leaves children.                                          |
| P2       | Session mutations still have multiple direct owners.      | `packages/core/src/server/session-commands.ts:256-303,403-423`; `packages/core/src/runtime/make-extension-host-context.ts:298-314,384-407`; `packages/core/tests/extensions/session-mutations.test.ts:253-340` |
| P2       | Durable child agent sessions are not atomic.              | `packages/core/src/runtime/agent/agent-runner.ts:350-367,873-886`                                                                                                                                              |
| P2       | Extension state persistence failures are swallowed.       | `packages/core/src/runtime/extensions/spawn-machine-ref.ts:90-114`; `packages/core/src/server/event-publisher.ts:73-96,162-169`                                                                                |
| P2       | Core export map bypasses extension/server boundaries.     | `packages/core/package.json:5-35`; `tsconfig.json:15-40`; `packages/tooling/policy/architecture-policy.test.ts:166-234,300-391`                                                                                |
| P2       | Builtin membrane exports overpowered `EventPublisher`.    | `packages/extensions/internal/builtin.ts:1-8`; `packages/core/src/domain/event-publisher.ts:5`; `packages/core/src/server/event-publisher.ts:60-169`                                                           |
| P2       | Extension health transport DTOs permit impossible states. | `packages/core/src/server/transport-contract.ts:531-568`; `packages/core/src/server/extension-health.ts:4-72`; `packages/core/tests/server/extension-health.test.ts:7-134`                                     |
| P2       | Driver `TurnEvent` producers bypass constructors.         | `packages/extensions/src/acp-agents/executor.ts:78-120,241-249`; `packages/core/src/domain/driver.ts:199-247,307-337`; `packages/core/tests/domain/schema-tagged-enum-class.test.ts:187-203`                   |

### Clean Areas

- Effect-native AI integration is not carried forward.
- SDK/TUI adapter debt is not carried forward.
- CI/e2e/test taxonomy is not carried forward.
- Suppression location accounting is not carried forward, except for adding
  boundary-policy coverage where package exports remain too broad.

## Execution Protocol

For every commit below:

1. Invoke listed skills.
2. Implement only that batch.
3. Run `bun run gate`.
4. Run `bun run test:e2e` when listed.
5. Commit with the listed conventional commit message.
6. Run exactly one review subagent against the commit diff and this section.
7. Fix real findings before moving on.

---

## Commit 1: `fix(storage): enforce sqlite referential integrity`

**Justification**: The schema declares FK and cascade semantics, but SQLite is
not enforcing them. The durable model is lying.

**Principles**:

- `use-the-platform`: use SQLite FK enforcement instead of hand-maintained assumptions.
- `make-operations-idempotent`: deletes and retries must converge without orphan rows.
- `prove-it-works`: add direct storage tests for FK mode, orphan rejection, and cascade behavior.

**Skills**: `bun`, `effect-v4`, `test`, `code-style`

**Changes**:

| File                                                 | Change                                                                                                                           | Lines                  |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `packages/core/src/storage/sqlite-storage.ts`        | Enable `PRAGMA foreign_keys = ON` for every SQLite connection before schema use; keep it active for test and file-backed layers. | ~1290-1361             |
| `packages/core/tests/storage/sqlite-storage.test.ts` | Add tests for `PRAGMA foreign_keys`, orphan branch/message/event rejection, and delete cascade for sessions.                     | existing storage tests |

**Verification**:

- `bun test packages/core/tests/storage/sqlite-storage.test.ts`
- `bun run gate`
- `bun run test:e2e`

---

## Commit 2: `fix(runtime): serialize queue mutations through session owner`

**Justification**: Same-session queue mutation still has direct ref/checkpoint
paths outside the serialized owner.

**Principles**:

- `serialize-shared-state-mutations`: queue mutation must have one structural owner.
- `make-operations-idempotent`: checkpoint updates must not lose queued work under concurrency.
- `test-through-public-interfaces`: prove via session/runtime command paths, not ref inspection only.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                  | Change                                                                                                                               | Lines                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `packages/core/src/runtime/agent/agent-loop.ts`       | Route follow-up queueing, interject queueing, and drain through the same serialized mutation owner used by tool result/invoke flows. | ~2223-2229, ~2769-2880, ~3106-3116 |
| `packages/core/src/runtime/session-runtime.ts`        | Ensure public command entry points use the serialized runtime path consistently.                                                     | ~296-389                           |
| `packages/core/tests/runtime/session-runtime.test.ts` | Add concurrency tests for follow-up queueing, interject queueing, and drain ordering against a running turn.                         | ~513-650                           |

**Verification**:

- `bun test packages/core/tests/runtime/session-runtime.test.ts`
- `bun run gate`
- `bun run test:e2e`

---

## Commit 3: `fix(server): unify session mutation ownership`

**Justification**: Session mutation writes still live in both `SessionCommands`
and extension host context, with non-atomic storage + publish paths for active
branch/name/settings changes.

**Principles**:

- `serialize-shared-state-mutations`: session state mutation needs one command owner.
- `small-interface-deep-implementation`: extension host should call a narrow session command facade, not duplicate storage/event choreography.
- `migrate-callers-then-delete-legacy-apis`: move extension callers and remove duplicated mutation logic in one wave.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                       | Change                                                                                                                         | Lines                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| `packages/core/src/server/session-commands.ts`             | Expose narrow internal mutation operations that own active branch, rename/settings, create/fork transaction + event semantics. | ~137-151, ~256-303, ~403-423   |
| `packages/core/src/runtime/make-extension-host-context.ts` | Replace duplicate direct storage/event mutation logic with calls into the session command owner.                               | ~222-237, ~298-345, ~384-438   |
| `packages/core/tests/extensions/session-mutations.test.ts` | Add rollback/failure tests for extension switch/settings/rename paths, matching create/fork coverage.                          | ~253-340                       |
| `packages/core/tests/server/session-commands.test.ts`      | Lock command-owner behavior for active branch and settings mutations.                                                          | existing session command tests |

**Verification**:

- `bun test packages/core/tests/extensions/session-mutations.test.ts packages/core/tests/server/session-commands.test.ts`
- `bun run gate`
- `bun run test:e2e`

---

## Commit 4: `fix(runtime): persist agent spawn atomically`

**Justification**: Durable child agent sessions can be created without the
corresponding parent event and with missing active branch data.

**Principles**:

- `make-operations-idempotent`: crash points during child spawn must converge.
- `serialize-shared-state-mutations`: child session/branch/event belongs in one durable transition.
- `prove-it-works`: add failure-injection coverage for the partial-spawn point.

**Skills**: `effect-v4`, `architecture`, `test`, `code-style`, `bun`

**Changes**:

| File                                               | Change                                                                                                                                 | Lines                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `packages/core/src/runtime/agent/agent-runner.ts`  | Create durable child session, branch, active branch state, and `AgentRunSpawned` event in one transaction or delegated atomic command. | ~350-367, ~873-886          |
| `packages/core/tests/runtime/agent-runner.test.ts` | Add rollback test for spawn event failure and assert durable child active branch is set.                                               | existing agent-runner tests |

**Verification**:

- `bun test packages/core/tests/runtime/agent-runner.test.ts`
- `bun run gate`
- `bun run test:e2e`

---

## Commit 5: `fix(extensions): fail transitions when state persistence fails`

**Justification**: Persistent extension actors currently advance in-memory state
and pulse clients even when durable state save fails.

**Principles**:

- `make-operations-idempotent`: restart must observe the same state live clients saw.
- `fix-root-causes`: do not log-and-continue through failed durability.
- `prove-it-works`: simulate save failure and assert no successful transition pulse.

**Skills**: `effect-v4`, `architecture`, `test`, `code-style`, `bun`

**Changes**:

| File                                                        | Change                                                                                          | Lines                                |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------ |
| `packages/core/src/runtime/extensions/spawn-machine-ref.ts` | Propagate `saveExtensionState` failures through the transition path instead of swallowing them. | ~90-114                              |
| `packages/core/tests/extensions/persistence.test.ts`        | Add persistence-failure tests for actor state, emitted pulses, and recovery semantics.          | ~53-325                              |
| `packages/core/tests/extensions/concurrency.test.ts`        | Adjust expectations if failed persistence changes transition/error ordering.                    | existing extension concurrency tests |

**Verification**:

- `bun test packages/core/tests/extensions/persistence.test.ts packages/core/tests/extensions/concurrency.test.ts`
- `bun run gate`
- `bun run test:e2e`

---

## Commit 6: `refactor(extensions): narrow builtin event membrane`

**Justification**: Builtin extensions need event publishing capability, not full
`EventPublisher` control over append/deliver/termination.

**Principles**:

- `small-interface-deep-implementation`: expose the minimum builtin privilege.
- `boundary-discipline`: builtin-only membrane should not leak app service internals.
- `migrate-callers-then-delete-legacy-apis`: move callers off full `EventPublisher` and block regressions.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                  | Change                                                                                    | Lines              |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------ |
| `packages/extensions/internal/builtin.ts`             | Replace full `EventPublisher` export with a narrow builtin event sink/facade.             | ~1-8               |
| `packages/core/src/extensions/internal.ts`            | Define or export the narrow builtin capability from the core internal membrane if needed. | ~18-47             |
| `packages/extensions/src/task-tools/*`                | Migrate builtin callers to the narrow event sink.                                         | discovered callers |
| `packages/tooling/policy/architecture-policy.test.ts` | Add policy coverage forbidding full `EventPublisher` through the builtin membrane.        | ~300-391           |

**Verification**:

- `bun test packages/tooling/policy/architecture-policy.test.ts packages/core/tests/extensions/extension-surface-locks.test.ts packages/core/tests/extensions/concurrency.test.ts`
- `bun run gate`

---

## Commit 7: `refactor(core): close internal package export wildcards`

**Justification**: Broad `@gent/core/server/*`, storage, provider, and domain
wildcards make internal boundaries advisory. Runtime wildcard closure already
worked; server/storage/provider/domain need the same discipline with an allowlist.

**Principles**:

- `boundary-discipline`: consumers must not import server/storage/provider internals as public API.
- `small-interface-deep-implementation`: package exports should expose stable capabilities, not source tree topology.
- `migrate-callers-then-delete-legacy-apis`: migrate monorepo callers before removing broad paths.

**Skills**: `architecture`, `effect-v4`, `code-style`, `test`, `bun`

**Changes**:

| File                                                  | Change                                                                                                                         | Lines                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| `packages/core/package.json`                          | Replace broad `./server/*`, `./storage/*`, `./providers/*`, and overbroad `./domain/*` with explicit public allowlist exports. | ~5-35                   |
| `tsconfig.json`                                       | Mirror the allowlist or remove wildcard workspace paths that bypass package boundaries.                                        | ~15-40                  |
| `apps/*`, `packages/*` imports                        | Migrate affected consumers to approved subpaths, relative internal imports, or new public entrypoints.                         | discovered by typecheck |
| `packages/tooling/policy/architecture-policy.test.ts` | Add policy coverage for server/storage/provider/domain export allowlists.                                                      | ~166-234, ~300-391      |

**Verification**:

- `bun run typecheck`
- `bun test packages/tooling/policy/architecture-policy.test.ts`
- `bun run gate`
- `bun run test:e2e`

---

## Commit 8: `refactor(server): tag extension health transport states`

**Justification**: Extension health transport DTOs are still status bags that can
encode contradictory lifecycle states.

**Principles**:

- `make-impossible-states-unrepresentable`: health states need tagged variants, not loose optional field bags.
- `migrate-callers-then-delete-legacy-apis`: migrate transport, SDK/TUI consumers, and tests in one wave.
- `test-through-public-interfaces`: health must be verified at RPC/transport projection points.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                  | Change                                                             | Lines                   |
| ----------------------------------------------------- | ------------------------------------------------------------------ | ----------------------- |
| `packages/core/src/server/transport-contract.ts`      | Replace extension health status bags with tagged transport states. | ~531-568                |
| `packages/core/src/server/extension-health.ts`        | Project runtime lifecycle state into the new tagged DTOs.          | ~4-72                   |
| `packages/sdk/src/client.ts` and TUI health consumers | Migrate type consumers to tagged health states.                    | discovered by typecheck |
| `packages/core/tests/server/extension-health.test.ts` | Add impossible-state and projection tests for tagged health.       | ~7-134                  |

**Verification**:

- `bun test packages/core/tests/server/extension-health.test.ts`
- `bun run gate`
- `bun run test:e2e`

---

## Commit 9: `refactor(drivers): construct turn events at producer boundaries`

**Justification**: `TurnEvent` constructors exist, but primary external driver
producers still return raw `_tag` object literals.

**Principles**:

- `make-impossible-states-unrepresentable`: constructor classes preserve event domain identity.
- `boundary-discipline`: external adapter output should enter the domain through constructors.
- `fix-root-causes`: lock constructor use at producer boundaries, not only in tests.

**Skills**: `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                          | Change                                                                              | Lines                        |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------- |
| `packages/extensions/src/acp-agents/executor.ts`              | Replace raw `TurnEvent` object literals with `TurnEvent.cases.*.make` constructors. | ~78-120, ~241-249            |
| `packages/extensions/src/acp-agents/claude-code-executor.ts`  | Migrate any raw turn-event production if present.                                   | ~49-133                      |
| `packages/core/tests/runtime/external-turn.test.ts`           | Assert constructor-backed events still flow through external turns.                 | existing external turn tests |
| `packages/core/tests/domain/schema-tagged-enum-class.test.ts` | Keep constructor/identity lock coverage aligned.                                    | ~187-203                     |

**Verification**:

- `bun test packages/core/tests/runtime/external-turn.test.ts packages/core/tests/domain/schema-tagged-enum-class.test.ts`
- `bun run gate`

---

## Commit 10: `chore(audit): recursively verify original plan targets`

**Justification**: Completion requires a fresh audit across the same original
targets after the new fixes land.

**Principles**:

- `prove-it-works`: completion is observed, not inferred.
- `fix-root-causes`: any material finding becomes a new plan, not a footnote.
- `redesign-from-first-principles`: if the remaining shape is still wrong, rewrite around reality.

**Skills**: `planify`, `architecture`, `effect-v4`, `bun`, `test`, `code-style`

**Changes**:

| File             | Change                                                                         | Lines               |
| ---------------- | ------------------------------------------------------------------------------ | ------------------- |
| `PLAN.md`        | Overwrite with either final verification receipt or a new remaining-work plan. | whole file          |
| implicated files | Only if the audit finds material issues that must be fixed before completion.  | discovered by audit |

**Verification**:

- `bun run gate`
- `bun run test:e2e`
- eight fresh independent audit agents, one per original point:
  1. runtime ownership / actor-model clarity
  2. extension API boundaries
  3. Effect-native AI integration
  4. storage model
  5. domain modeling / constructor discipline
  6. suppression debt / boundary discipline
  7. SDK/TUI adapter debt
  8. test taxonomy / behavioral coverage

**Recursive Rule**:

If any audit agent reports a material finding:

1. overwrite `PLAN.md` with a new Planify plan containing those findings and
   commit batches
2. implement those batches with the same gate/review protocol
3. rerun this audit commit

Stop only when all eight fresh audits report no P1/P2 structural findings.

## End State Checks

- [ ] SQLite FK enforcement is active for every storage layer.
- [ ] Orphan branch/message/event rows cannot be inserted.
- [ ] Session delete cascades or explicitly deletes children with tests.
- [ ] Queue mutations are serialized through one same-session owner.
- [ ] Extension and server session mutations share one command owner.
- [ ] Durable child agent spawn is atomic with its parent event.
- [ ] Extension actor state save failure fails the transition.
- [ ] Builtin extension membrane exposes only narrow event publishing.
- [ ] Core package exports no broad server/storage/provider/internal domain wildcards.
- [ ] Policy locks export allowlists and builtin membrane width.
- [ ] Extension health transport states are tagged and cannot encode contradictions.
- [ ] External driver `TurnEvent` producers use constructors.
- [ ] `bun run gate` is green.
- [ ] `bun run test:e2e` is green.
- [ ] Final recursive audit reports no P1/P2 findings.

## Current Status

- Recursive audit completed at HEAD `ef27bc1f`.
- Material findings remain, so this plan supersedes the previous one.
- No implementation batches from this plan have started yet.
