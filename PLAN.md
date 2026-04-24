# Planify: Post-Audit Hardening Plan

## Context

The previous plan was marked complete, but a fresh independent audit across the
original target points found material remaining debt. The old completion receipt
is therefore superseded.

This plan is the new execution contract. It is based on:

- the completed commit history through supervisor hardening
- the eight-point independent audit just run
- fresh reads of project scripts and the cited source files
- brain vault principles loaded from `/Users/cvr/.brain/principles.md` and all
  linked principle files

Goal: finish the original simplification work by fixing the remaining structural
issues, not by declaring them future work. Correctness over local convenience.
Breaking changes are allowed when migrations/tests are included.

## Scope

- **In**: gate integrity, e2e coverage, actor/runtime failure semantics,
  storage/event atomicity, extension API boundaries, Effect-native AI typing,
  domain modeling, suppression policy, SDK/TUI adapter erasure, route-flow
  coverage, recursive final audit.
- **Out**: feature cuts, compatibility bridges kept only for comfort,
  cosmetic renames without structural payoff, PR workflow.

## Constraints

- Work lands in commit batches. Each commit must be independently gated.
- Gate every commit with `bun run gate`.
- Also run `bun run test:e2e` for commits touching CI/e2e wiring, runtime
  supervision, storage/event durability, transport, SDK worker behavior, or TUI
  route flow.
- One review subagent per commit batch after the commit is created.
- If a batch grows past 20 files or crosses multiple subsystems, split it into
  smaller sub-commits without asking.
- No feature cuts. No TODO placeholders. No `any` or `as unknown as X` to escape
  types.
- Remove legacy APIs in the same migration wave that migrates callers.
- Final verification is recursive: if material findings remain, overwrite this
  file with the new findings and continue.

## Applicable Skills

- `planify`
- `architecture`
- `effect-v4`
- `code-style`
- `bun`
- `test`
- `react` for TUI route/adapter work
- `repo` only if Effect upstream behavior must be checked against source

## Gate Command

```bash
bun run gate
```

High-risk batches additionally run:

```bash
bun run test:e2e
```

## Principle Grounding

| Principle                                | Application                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `prove-it-works`                         | CI/test scripts must execute the suites they claim to execute. No orphaned e2e files.     |
| `test-through-public-interfaces`         | Runtime, transport, and TUI coverage must exercise caller-visible seams.                  |
| `serialize-shared-state-mutations`       | Session/branch/message/event mutations need a single owner or transaction boundary.       |
| `make-operations-idempotent`             | Lifecycle and supervisor paths must converge after crashes/retries.                       |
| `boundary-discipline`                    | Runtime internals, unsafe casts, and unknown parsing belong at explicit membranes only.   |
| `small-interface-deep-implementation`    | Public SDK/extension/session surfaces should be narrow; complexity stays behind the seam. |
| `make-impossible-states-unrepresentable` | Driver, message, and extension lifecycle states should be tagged states, not bags.        |
| `use-the-platform`                       | Prefer Effect Prompt/Response/Toolkit and SQL transaction primitives over Gent shadows.   |
| `fix-root-causes`                        | Suppression counts, missing scripts, and skipped/orphaned tests get structural guards.    |
| `redesign-from-first-principles`         | Do not bolt patches onto the stale architecture; reshape the owning boundary.             |

## Research Synthesis

### Audit Points

These are the original plan targets and the slices that the final audit must
repeat:

1. runtime ownership / actor-model clarity
2. extension API boundaries
3. Effect-native AI integration
4. storage model
5. domain modeling / constructor discipline
6. suppression debt / boundary discipline
7. SDK/TUI adapter debt
8. test taxonomy / behavioral coverage

### Material Findings

| Severity | Finding                                                                                          | Evidence                                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | CI references a missing script.                                                                  | `.github/workflows/ci.yml:25`, `package.json:9-22`                                                                                                                                     |
| P1       | `server-lifecycle.test.ts` is not run by `test` or `test:e2e`.                                   | `packages/e2e/package.json:7-8`, `packages/e2e/tests/server-lifecycle.test.ts:154,280,328`                                                                                             |
| P1       | Checkpoint persistence failures are swallowed.                                                   | `packages/core/src/runtime/agent/agent-loop.ts:1824-1830`                                                                                                                              |
| P1       | Extension mailbox workers can die permanently after a job failure.                               | `packages/core/src/runtime/extensions/resource-host/machine-mailbox.ts:35-45`                                                                                                          |
| P1       | Session create/fork writes can leave partial persistent state.                                   | `packages/core/src/server/session-commands.ts:167-178,301-315`, `packages/core/src/runtime/make-extension-host-context.ts:340,402`                                                     |
| P1       | Message writes and event publishes are not atomic.                                               | `packages/core/src/runtime/agent/agent-loop.ts:237-247,1293-1295`, `packages/core/src/runtime/session-runtime.ts:411-423`                                                              |
| P1       | Builtin extensions still bypass the authoring boundary through `core-internal`.                  | `packages/extensions/src/core-internal.ts:11-21`                                                                                                                                       |
| P1       | Unsafe suppression policy misses important rule reasons and exact location accounting.           | `packages/tooling/policy/suppression-policy.test.ts:316-328,404-429`                                                                                                                   |
| P2       | Public commands bypass actor serialization for tool result/invoke flows.                         | `packages/core/src/runtime/session-runtime.ts:392-460`                                                                                                                                 |
| P2       | Runtime internals remain package-addressable through `./runtime/*`.                              | `packages/core/package.json:19-22`                                                                                                                                                     |
| P2       | Provider stream/tool typing erases Effect toolkit types.                                         | `packages/core/src/providers/provider.ts:131,164-177,218-252`                                                                                                                          |
| P2       | Gent message parts remain persisted/canonical enough to shadow Effect Prompt/Response.           | `packages/core/src/domain/message.ts:14-58`, `packages/core/src/runtime/agent/agent-loop.ts:1037-1045`                                                                                 |
| P2       | Driver category drifts between `_tag` and `kind`.                                                | `packages/core/src/domain/agent.ts:33-44`, `packages/core/src/domain/driver.ts:56-60`, `packages/core/src/server/transport-contract.ts:459-465`                                        |
| P2       | `MessageReceived` erases interjection identity.                                                  | `packages/core/src/domain/message.ts:92-101`, `packages/core/src/runtime/agent/agent-loop.ts:856-862`                                                                                  |
| P2       | Extension actor health states permit illegal field combinations.                                 | `packages/core/src/domain/extension.ts:76-88`                                                                                                                                          |
| P2       | SDK local supervisor still routes through erased proxy calls.                                    | `packages/sdk/src/local-supervisor.ts:56-78`                                                                                                                                           |
| P2       | TUI extension widgets still parse `unknown` manually instead of using typed extension transport. | `apps/tui/src/extensions/builtins/tasks.client.tsx:34-49,88-95`, `apps/tui/src/extensions/builtins/auto.client.ts:75-79`, `apps/tui/src/extensions/builtins/artifacts.client.ts:24-32` |
| P2       | `atom-solid` registry still has root type erasure.                                               | `apps/tui/src/atom-solid/solid.ts:23-27`, `apps/tui/src/atom-solid/registry.ts:118-143`                                                                                                |
| P2       | Worker streaming contracts are direct-only.                                                      | `packages/e2e/tests/event-stream-direct.test.ts:6-12`, `packages/e2e/tests/live-event-direct.test.ts:5`, `packages/e2e/tests/watch-state-direct.test.ts:6`                             |
| P2       | TUI route-flow coverage is split across reducer/direct-context tests, not one real UI flow.      | `apps/tui/tests/router.test.ts:5-80`, `apps/tui/tests/app-auth.test.tsx:286-302,408-414`                                                                                               |

### Open Questions

None requiring user input. The findings point to structural fixes.

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

## Commit 1: `fix(ci): wire integration and e2e scripts correctly`

**Justification**: CI is claiming an integration gate that does not exist.

**Principles**:

- `prove-it-works`: the CI command must exist and run the intended suite.
- `fix-root-causes`: repair script topology, not just the workflow line.

**Skills**: `bun`, `test`, `code-style`

**Changes**:

| File                        | Change                                                                  | Lines  |
| --------------------------- | ----------------------------------------------------------------------- | ------ |
| `package.json`              | Add or rename root integration/e2e scripts so CI and local gates agree. | ~9-22  |
| `.github/workflows/ci.yml`  | Replace missing script call with the real verified command.             | ~22-26 |
| `packages/e2e/package.json` | Align package scripts with root script names.                           | ~6-8   |

**Verification**:

- `bun run gate`
- `bun run test:e2e`
- `bun run test:integration` if retained as a root script

---

## Commit 2: `test(e2e): restore server lifecycle coverage`

**Justification**: WS lifecycle/reconnect behavior is protected by an orphaned
test file. Orphaned tests are ornamental. Nice vase, no water.

**Principles**:

- `prove-it-works`: e2e suite must execute the lifecycle file.
- `test-through-public-interfaces`: lifecycle coverage belongs at subprocess/transport level.

**Skills**: `bun`, `test`, `code-style`

**Changes**:

| File                                          | Change                                                                              | Lines  |
| --------------------------------------------- | ----------------------------------------------------------------------------------- | ------ |
| `packages/e2e/package.json`                   | Include `tests/server-lifecycle.test.ts` in `test:e2e` or a named lifecycle script. | ~6-8   |
| `packages/e2e/tests/server-lifecycle.test.ts` | Fix any assumptions exposed by actually running the file.                           | ~1-360 |
| `package.json`                                | Ensure root e2e command covers the package script.                                  | ~9-22  |

**Verification**:

- `bun run gate`
- `bun run test:e2e`

---

## Commit 3: `test(e2e): cover worker streaming transport`

**Justification**: Direct-only stream coverage misses the worker transport path
that users actually exercise through the supervisor.

**Principles**:

- `test-through-public-interfaces`: exercise the worker transport contract, not just direct harnesses.
- `prove-it-works`: stream replay, live events, and watch state need real worker coverage.

**Skills**: `bun`, `test`, `code-style`

**Changes**:

| File                                             | Change                                                | Lines   |
| ------------------------------------------------ | ----------------------------------------------------- | ------- |
| `packages/e2e/tests/event-stream-direct.test.ts` | Rename or generalize to include worker-http cases.    | ~1-80   |
| `packages/e2e/tests/live-event-direct.test.ts`   | Add worker transport case or shared transport matrix. | ~1-80   |
| `packages/e2e/tests/watch-state-direct.test.ts`  | Add worker transport case or shared transport matrix. | ~1-80   |
| `packages/e2e/tests/transport-harness.ts`        | Extend harness support only if needed.                | ~90-130 |

**Verification**:

- `bun run gate`
- `bun run test:e2e`

---

## Commit 4: `fix(runtime): fail runs on checkpoint persistence failure`

**Justification**: Durable actor checkpoint failure cannot be a warning if the
machine commit is treated as successful.

**Principles**:

- `make-operations-idempotent`: crash/retry semantics require knowing persistence failed.
- `fix-root-causes`: do not log-and-continue across a durability boundary.

**Skills**: `effect-v4`, `architecture`, `test`, `bun`, `code-style`

**Changes**:

| File                                             | Change                                                                                           | Lines                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ---------------------- |
| `packages/core/src/runtime/agent/agent-loop.ts`  | Stop swallowing checkpoint save/remove failures; propagate typed failure to the owning boundary. | ~1808-1830             |
| `packages/core/tests/runtime/agent-loop.test.ts` | Add failure-path coverage for checkpoint persistence.                                            | relevant runtime tests |
| `packages/core/tests/runtime/helpers/*`          | Add test storage/checkpoint fixture only if needed.                                              | helper area            |

**Verification**:

- `bun run gate`
- `bun run test:e2e`

---

## Commit 5: `fix(extensions): keep mailbox workers alive after job failure`

**Justification**: A mailbox worker that logs and exits leaves a live session
slot with no consumer. Actor model, but with the actor quietly gone. Haunted
queue. Bad.

**Principles**:

- `serialize-shared-state-mutations`: mailbox ownership must remain structurally alive.
- `make-operations-idempotent`: failed jobs must not poison future jobs.

**Skills**: `effect-v4`, `architecture`, `test`, `bun`, `code-style`

**Changes**:

| File                                                                    | Change                                                                             | Lines           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------- |
| `packages/core/src/runtime/extensions/resource-host/machine-mailbox.ts` | Contain per-job failures inside the loop or respawn/clear dead slots deliberately. | ~35-90          |
| `packages/core/tests/extensions/concurrency.test.ts`                    | Prove a failed mailbox job does not kill later same-session work.                  | extension tests |
| `packages/core/tests/extensions/resource-host.test.ts`                  | Add lifecycle regression if harness better fits here.                              | extension tests |

**Verification**:

- `bun run gate`
- `bun run test:e2e`

---

## Commit 6: `refactor(storage): transact session create and fork flows`

**Justification**: Session, branch, registry, message copy, and event publication
cannot each pretend to be independent when the user sees one operation.

**Principles**:

- `serialize-shared-state-mutations`: one mutation boundary for one logical command.
- `make-operations-idempotent`: retries must not depend on partial leftovers.

**Skills**: `effect-v4`, `architecture`, `test`, `bun`, `code-style`

**Changes**:

| File                                                         | Change                                                                | Lines              |
| ------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------ |
| `packages/core/src/server/session-commands.ts`               | Wrap create/fork persistence in a transaction-aware command boundary. | ~150-190, ~293-315 |
| `packages/core/src/runtime/make-extension-host-context.ts`   | Apply the same boundary to extension-created/forked sessions.         | ~330-410           |
| `packages/core/tests/server/session-commands.test.ts`        | Add failure-path rollback coverage.                                   | server tests       |
| `packages/core/tests/runtime/extension-host-context.test.ts` | Add extension create/fork rollback coverage if existing harness fits. | runtime tests      |

**Verification**:

- `bun run gate`
- `bun run test:e2e`

---

## Commit 7: `refactor(runtime): make message and event persistence atomic`

**Justification**: Persisting a message and publishing its durable event are one
observable state change.

**Principles**:

- `serialize-shared-state-mutations`: message/event mutation must share a commit boundary.
- `derive-dont-sync`: events and stored messages cannot diverge.

**Skills**: `effect-v4`, `architecture`, `test`, `bun`, `code-style`

**Changes**:

| File                                                  | Change                                                                  | Lines                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------ |
| `packages/core/src/runtime/agent/agent-loop.ts`       | Atomic message + event paths for user, assistant, turn-completed flows. | ~225-247, ~848-862, ~1286-1300 |
| `packages/core/src/runtime/session-runtime.ts`        | Atomic tool-result + event path.                                        | ~392-423                       |
| `packages/core/src/runtime/event-store-live.ts`       | Expose or compose transaction-aware durable event append.               | ~1-80                          |
| `packages/core/tests/runtime/agent-loop.test.ts`      | Add rollback/divergence tests.                                          | runtime tests                  |
| `packages/core/tests/runtime/session-runtime.test.ts` | Add tool-result atomicity coverage.                                     | runtime tests                  |

**Verification**:

- `bun run gate`
- `bun run test:e2e`

---

## Commit 8: `refactor(runtime): serialize command-side mutations through session ownership`

**Justification**: Tool result and invoke flows still mutate around the actor
queue. One session should have one mutation owner.

**Principles**:

- `serialize-shared-state-mutations`: public commands should enter the same serialized path.
- `small-interface-deep-implementation`: callers should not assemble runtime phases manually.

**Skills**: `effect-v4`, `architecture`, `test`, `bun`, `code-style`

**Changes**:

| File                                                      | Change                                                                               | Lines                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------ |
| `packages/core/src/runtime/session-runtime.ts`            | Route `RecordToolResult` and `InvokeTool` through a serialized session command path. | ~392-460                 |
| `packages/core/src/runtime/agent/agent-loop.ts`           | Add narrow internal command/event if actor ownership belongs here.                   | affected command section |
| `packages/core/tests/runtime/session-runtime.test.ts`     | Prove ordering against concurrent command submission.                                | runtime tests            |
| `packages/core/tests/server/interaction-commands.test.ts` | Acceptance coverage through public RPC/server path if applicable.                    | server tests             |

**Verification**:

- `bun run gate`
- `bun run test:e2e`

---

## Commit 9: `chore(exports): close runtime internal package paths`

**Justification**: Blocking one exact agent-loop path while exporting
`./runtime/*` is theater.

**Principles**:

- `boundary-discipline`: internals should not be package-addressable.
- `small-interface-deep-implementation`: public surface area is a contract tax.

**Skills**: `architecture`, `effect-v4`, `bun`, `code-style`, `test`

**Changes**:

| File                                                  | Change                                                                             | Lines                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------- |
| `packages/core/package.json`                          | Replace broad `./runtime/*` export with narrow approved runtime subpaths.          | ~5-26                   |
| `packages/tooling/policy/architecture-policy.test.ts` | Lock the narrowed export shape.                                                    | policy tests            |
| affected package imports                              | Migrate any legitimate callers to public APIs or explicit internal test harnesses. | discovered by typecheck |

**Verification**:

- `bun run gate`

---

## Commit 10: `refactor(extensions): design builtin runtime effect surface`

**Justification**: Builtins need internal privileges, but the current bridge
hands them broad core internals.

**Principles**:

- `small-interface-deep-implementation`: expose the minimal builtin-only power.
- `boundary-discipline`: privileged effects need an explicit membrane.

**Skills**: `architecture`, `effect-v4`, `bun`, `code-style`, `test`

**Changes**:

| File                                                             | Change                                                    | Lines                  |
| ---------------------------------------------------------------- | --------------------------------------------------------- | ---------------------- |
| `packages/core/src/extensions/api.ts`                            | Keep public authoring surface narrow.                     | public extension API   |
| `packages/core/src/extensions/internal.ts`                       | Split runtime-only effects from broad internal exports.   | internal extension API |
| `packages/core/src/domain/extension.ts`                          | Adjust types only if needed for explicit builtin effects. | extension domain       |
| `packages/core/tests/extensions/extension-surface-locks.test.ts` | Assert public authors cannot reach runtime effects.       | extension tests        |

**Verification**:

- `bun run gate`

---

## Commit 11: `refactor(extensions): migrate builtins off core-internal bridge`

**Justification**: The bridge is the leak. Migrate callers, then delete it.

**Principles**:

- `migrate-callers-then-delete-legacy-apis`: no long-lived dual path.
- `boundary-discipline`: builtins import only the explicit privileged surface.

**Skills**: `architecture`, `effect-v4`, `bun`, `code-style`, `test`

**Changes**:

| File                                                      | Change                                               | Lines            |
| --------------------------------------------------------- | ---------------------------------------------------- | ---------------- |
| `packages/extensions/src/core-internal.ts`                | Delete or reduce to a final narrow builtin membrane. | ~1-57            |
| `packages/extensions/src/auto.ts`                         | Migrate off broad bridge.                            | import/use sites |
| `packages/extensions/src/auto-projection.ts`              | Migrate off broad bridge.                            | import/use sites |
| `packages/extensions/src/interaction-tools/projection.ts` | Migrate off broad bridge.                            | import/use sites |
| `packages/extensions/src/task-tools/requests.ts`          | Migrate off broad bridge.                            | import/use sites |

**Verification**:

- `bun run gate`
- split further if more builtin files are touched

---

## Commit 12: `test(policy): lock extension boundary after bridge removal`

**Justification**: If the bridge was possible once, it will grow back unless
the boundary is executable.

**Principles**:

- `encode-lessons-in-structure`: put the lesson in policy, not prose.
- `fix-root-causes`: prevent the category, not one import.

**Skills**: `architecture`, `bun`, `test`, `code-style`

**Changes**:

| File                                                             | Change                                                                                                                       | Lines                |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `packages/tooling/policy/architecture-policy.test.ts`            | Forbid `packages/extensions` from importing `packages/core/src/extensions/internal` except approved membrane if one remains. | policy tests         |
| `packages/core/tests/extensions/extension-surface-locks.test.ts` | Lock public authoring exports.                                                                                               | extension tests      |
| `packages/extensions/src/*`                                      | Remove any leftover bridge imports found by policy.                                                                          | discovered by policy |

**Verification**:

- `bun run gate`

---

## Commit 13: `refactor(provider): preserve Effect toolkit typing`

**Justification**: Provider streams currently erase tool identity to
`Record<string, AiTool.Any>`. That discards useful type information at the
central AI boundary.

**Principles**:

- `use-the-platform`: use Effect Toolkit/LanguageModel typing instead of local erasure.
- `boundary-discipline`: convert at the edge, not through the provider core.

**Skills**: `effect-v4`, `architecture`, `repo`, `bun`, `test`, `code-style`

**Changes**:

| File                                                        | Change                                                               | Lines                    |
| ----------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------ |
| `packages/core/src/providers/provider.ts`                   | Make toolkit/request/stream typing preserve tool map where possible. | ~131, ~164-177, ~218-252 |
| `packages/core/tests/providers/provider-resolution.test.ts` | Add compile/runtime coverage for typed tool conversion.              | provider tests           |
| `packages/core/src/domain/contribution.ts`                  | Adjust capability typing only if needed.                             | contribution model       |

**Verification**:

- `bun run gate`
- consult Effect source if signatures are ambiguous

---

## Commit 14: `refactor(ai): make Prompt and Response the transcript source`

**Justification**: Gent-owned message parts should be storage/UI projections,
not the canonical model IO AST.

**Principles**:

- `use-the-platform`: Prompt/Response already model AI conversation parts.
- `derive-dont-sync`: derive Gent projections from canonical AI data.

**Skills**: `effect-v4`, `architecture`, `repo`, `bun`, `test`, `code-style`

**Changes**:

| File                                                  | Change                                                                        | Lines              |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------ |
| `packages/core/src/domain/message.ts`                 | Clarify/store projection-only message part role.                              | ~14-58             |
| `packages/core/src/providers/ai-transcript.ts`        | Move normalization around Prompt/Response.                                    | transcript helpers |
| `packages/core/src/runtime/agent/agent-loop.ts`       | Stop converting Response parts back into canonical runtime state prematurely. | ~1037-1045         |
| `packages/core/tests/providers/ai-transcript.test.ts` | Cover Prompt/Response roundtrips and storage projection.                      | provider tests     |

**Verification**:

- `bun run gate`
- `bun run test:e2e`

---

## Commit 15: `refactor(driver): unify driver category on tagged refs`

**Justification**: `DriverRef` uses `_tag`, while errors and transport use
`kind`. Owned category vocabulary should have one shape.

**Principles**:

- `make-impossible-states-unrepresentable`: category is a variant.
- `name-events-not-setters`: names should describe domain facts consistently.

**Skills**: `effect-v4`, `architecture`, `bun`, `test`, `code-style`

**Changes**:

| File                                                | Change                                                                             | Lines          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------- |
| `packages/core/src/domain/agent.ts`                 | Keep `DriverRef` as canonical tagged model.                                        | ~33-44         |
| `packages/core/src/domain/driver.ts`                | Replace owned `kind` category with `_tag` or tagged error variants.                | ~56-60         |
| `packages/core/src/server/transport-contract.ts`    | Migrate owned driver DTO category to tagged shape or explicit boundary projection. | ~459-465       |
| `apps/tui/src/extensions/builtins/driver.client.ts` | Remove heuristic reconstruction from hyphenated strings.                           | driver widget  |
| driver tests                                        | Update transport/domain expectations.                                              | relevant tests |

**Verification**:

- `bun run gate`
- `bun run test:e2e`

---

## Commit 16: `refactor(events): preserve interjection identity`

**Justification**: `MessageReceived` loses whether the message was a regular
user message or an interjection, forcing downstream compensation.

**Principles**:

- `make-impossible-states-unrepresentable`: event payload should carry the true variant.
- `derive-dont-sync`: UI should not refetch to recover identity the event erased.

**Skills**: `effect-v4`, `architecture`, `bun`, `test`, `code-style`

**Changes**:

| File                                            | Change                                                                 | Lines           |
| ----------------------------------------------- | ---------------------------------------------------------------------- | --------------- |
| `packages/core/src/domain/message.ts`           | Ensure message variant is explicit and reusable.                       | ~92-101         |
| `packages/core/src/domain/event.ts`             | Add message variant/type to `MessageReceived` or split event variants. | event schema    |
| `packages/core/src/runtime/agent/agent-loop.ts` | Publish correct variant for queued/interjection messages.              | ~856-862        |
| `apps/tui/src/hooks/use-session-feed.ts`        | Remove compensating refetch logic if no longer needed.                 | feed projection |
| event/session tests                             | Update acceptance assertions.                                          | relevant tests  |

**Verification**:

- `bun run gate`
- `bun run test:e2e`

---

## Commit 17: `refactor(extensions): model actor health as lifecycle states`

**Justification**: Optional `error`, `restartCount`, and `failurePhase` fields
allow invalid combinations. Lifecycle state should own its fields.

**Principles**:

- `make-impossible-states-unrepresentable`: each lifecycle state carries only valid data.
- `derive-dont-sync`: health summaries project from state, not parallel flags.

**Skills**: `effect-v4`, `architecture`, `bun`, `test`, `code-style`

**Changes**:

| File                                             | Change                                                               | Lines                |
| ------------------------------------------------ | -------------------------------------------------------------------- | -------------------- |
| `packages/core/src/domain/extension.ts`          | Replace `ExtensionActorStatusInfo` bag with tagged lifecycle states. | ~76-88               |
| `packages/core/src/server/transport-contract.ts` | Mirror valid lifecycle states at transport boundary.                 | extension health DTO |
| `packages/core/src/server/extension-health.ts`   | Build tagged states directly.                                        | health projection    |
| extension health tests                           | Prove impossible states cannot be constructed.                       | relevant tests       |

**Verification**:

- `bun run gate`

---

## Commit 18: `chore(policy): require reasons for unsafe suppressions`

**Justification**: `no-unsafe-type-assertion` and `no-explicit-any` are exactly
the suppressions that need receipts.

**Principles**:

- `boundary-discipline`: unsafe code requires named membranes.
- `fix-root-causes`: make the policy reject reasonless unsafe escapes.

**Skills**: `bun`, `test`, `code-style`

**Changes**:

| File                                                    | Change                                                    | Lines              |
| ------------------------------------------------------- | --------------------------------------------------------- | ------------------ |
| `packages/tooling/policy/suppression-policy.test.ts`    | Add unsafe assertion/explicit any to required reason set. | ~316-328           |
| `apps/tui/src/atom-solid/registry.ts`                   | Add/remove reasons as policy forces.                      | suppression sites  |
| `packages/extensions/src/interaction-tools/ask-user.ts` | Add/remove reasons as policy forces.                      | suppression sites  |
| other surfaced source files                             | Fix root type hole or add explicit membrane reason.       | discovered by gate |

**Verification**:

- `bun run gate`

---

## Commit 19: `chore(policy): make suppression accounting location-exact`

**Justification**: Category/rule totals let debt move around invisibly.

**Principles**:

- `encode-lessons-in-structure`: exact source inventory beats broad buckets.
- `prove-it-works`: policy must catch replacement debt, not just net-new totals.

**Skills**: `bun`, `test`, `code-style`

**Changes**:

| File                                                 | Change                                                               | Lines                      |
| ---------------------------------------------------- | -------------------------------------------------------------------- | -------------------------- |
| `packages/tooling/policy/suppression-policy.test.ts` | Track approved suppressions by file + line/rule or stable local key. | ~40-60, ~190-220, ~404-429 |
| `packages/tooling/policy/*`                          | Include tooling source in scan roots if it can carry suppressions.   | policy area                |
| approved suppression sites                           | Update reasons/keys after policy shape changes.                      | discovered by policy       |

**Verification**:

- `bun run gate`

---

## Commit 20: `refactor(sdk): remove erased local supervisor proxy`

**Justification**: `ReadonlyArray<unknown>` routing in `local-supervisor` is a
type hole in the SDK path most likely to handle worker disconnects.

**Principles**:

- `boundary-discipline`: disconnected behavior should be typed per RPC shape.
- `small-interface-deep-implementation`: hide reconnect complexity behind a narrow typed adapter.

**Skills**: `effect-v4`, `architecture`, `bun`, `test`, `code-style`

**Changes**:

| File                                    | Change                                                                                 | Lines          |
| --------------------------------------- | -------------------------------------------------------------------------------------- | -------------- |
| `packages/sdk/src/local-supervisor.ts`  | Replace erased proxy routing with typed method table or generated flat client adapter. | ~45-84         |
| `packages/sdk/src/namespaced-client.ts` | Adjust helper shape if needed.                                                         | client helpers |
| `packages/sdk/tests/supervisor.test.ts` | Cover disconnected stream and effect methods without proxy erasure.                    | sdk tests      |

**Verification**:

- `bun run gate`
- `bun run test:e2e`

---

## Commit 21: `refactor(tui): route extension widgets through typed transport`

**Justification**: The typed helper exists; widgets bypass it and hand-parse
`unknown`.

**Principles**:

- `boundary-discipline`: decode at extension transport boundary once.
- `small-interface-deep-implementation`: widgets consume typed client capabilities.

**Skills**: `react`, `effect-v4`, `architecture`, `bun`, `test`, `code-style`

**Changes**:

| File                                                   | Change                                                            | Lines            |
| ------------------------------------------------------ | ----------------------------------------------------------------- | ---------------- |
| `apps/tui/src/extensions/client-transport.ts`          | Make `askExtension` the standard typed request path.              | transport helper |
| `apps/tui/src/extensions/builtins/tasks.client.tsx`    | Replace manual task parsing with typed transport/protocol schema. | ~34-49, ~88-95   |
| `apps/tui/src/extensions/builtins/auto.client.ts`      | Remove unsafe reply cast.                                         | ~75-79           |
| `apps/tui/src/extensions/builtins/artifacts.client.ts` | Replace manual artifact parsing with typed protocol.              | ~24-32           |
| widget tests                                           | Cover decoded success/failure paths through UI/client seam.       | relevant tests   |

**Verification**:

- `bun run gate`
- `bun run test:e2e`

---

## Commit 22: `refactor(tui): make atom registry type ownership explicit`

**Justification**: The registry context currently lets callers assert any
service set. That is not a framework membrane; it is internal dishonesty.

**Principles**:

- `make-impossible-states-unrepresentable`: registry/service requirements should be encoded.
- `boundary-discipline`: any unavoidable cast must live at one explicit provider edge.

**Skills**: `react`, `architecture`, `bun`, `test`, `code-style`

**Changes**:

| File                                  | Change                                                                        | Lines     |
| ------------------------------------- | ----------------------------------------------------------------------------- | --------- |
| `apps/tui/src/atom-solid/solid.ts`    | Replace `Registry<unknown>` context assertion with typed provider/hook model. | ~23-45    |
| `apps/tui/src/atom-solid/registry.ts` | Remove or isolate cached instance casts.                                      | ~118-143  |
| `apps/tui/src/atom-solid/atom.ts`     | Adjust atom/service type definitions if required.                             | atom core |
| `apps/tui/tests/*atom*`               | Add registry type/behavior coverage if existing tests are thin.               | TUI tests |

**Verification**:

- `bun run gate`
- `bun run test:e2e`

---

## Commit 23: `test(tui): consolidate route flow coverage`

**Justification**: Reducer tests and direct context calls do not prove the user
route flow works.

**Principles**:

- `test-through-public-interfaces`: drive auth, prompt search, and branch switch through UI behavior.
- `subtract-before-you-add`: delete tiny shape-lock tests once covered by behavior.

**Skills**: `react`, `bun`, `test`, `code-style`

**Changes**:

| File                                             | Change                                                                                              | Lines                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- | --------------------- |
| `apps/tui/tests/app-auth.test.tsx`               | Extend into one route flow covering auth gate, prompt search, and session/branch switch through UI. | ~286-302, ~408-414    |
| `apps/tui/tests/router.test.ts`                  | Delete or reduce reducer-only coverage after behavior test owns the contract.                       | ~1-80                 |
| `apps/tui/tests/command-palette-render.test.tsx` | Merge session switching coverage if this is the better public seam.                                 | command palette tests |
| `apps/tui/src/routes/branch-picker.tsx`          | Touch only if test exposes inaccessible behavior.                                                   | ~136-141              |

**Verification**:

- `bun run gate`
- `bun run test:e2e`

---

## Commit 24: `chore(audit): recursively verify original plan targets`

**Justification**: The plan is complete only when fresh independent audits of
the same target points stop finding significant issues.

**Principles**:

- `prove-it-works`: completion requires direct verification, not confidence.
- `fix-root-causes`: material findings become new batches, not footnotes.
- `redesign-from-first-principles`: if the audit shows the architecture is still wrong, rewrite the plan around the real shape.

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

Stop only when all eight fresh audits report no P1/P2 structural findings. P3
polish may be recorded as residual risk, but not used to block completion unless
it indicates a hidden architectural fault.

## End State Checks

- [ ] CI runs only scripts that exist.
- [ ] `bun run test:e2e` executes server lifecycle/reconnect coverage.
- [ ] Worker streaming behavior is covered, not just direct streaming.
- [ ] Checkpoint persistence failures fail the owning runtime operation.
- [ ] Mailbox worker failure does not leave a dead live slot.
- [ ] Session create/fork and extension create/fork flows do not leave partial persistent state.
- [ ] Message persistence and durable event append are atomic for one observable transition.
- [ ] Public command mutations are serialized through one session owner.
- [ ] Runtime internals are not exported through broad package wildcards.
- [ ] Builtin extension privileges use a narrow explicit membrane, not `core-internal`.
- [ ] Provider/toolkit typing preserves Effect platform types where possible.
- [ ] Prompt/Response are the canonical AI transcript model; Gent messages are projection/storage/UI data.
- [ ] Owned driver categories use one tagged vocabulary.
- [ ] `MessageReceived` preserves interjection identity.
- [ ] Extension actor health cannot represent illegal lifecycle states.
- [ ] Unsafe suppressions require local reasons and location-exact accounting.
- [ ] SDK local supervisor has no erased proxy routing.
- [ ] TUI extension widgets use typed transport decoding.
- [ ] `atom-solid` registry type ownership is explicit.
- [ ] TUI route behavior is covered by one real UI flow.
- [ ] The final recursive audit overwrites this file until no significant findings remain.

## Current Status

- Plan rewritten from the fresh audit findings.
- No implementation batches from this plan have started yet.
