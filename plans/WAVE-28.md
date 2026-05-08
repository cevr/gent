# Planify: Wave 28 - Runtime And Public Surface Subtraction

## Context

Wave 27 reduced several shallow surfaces, but its final independent audit found
remaining P1s. No P0s were reported. The strongest signal is that Gent can still
get smaller by removing duplicated ownership layers and files that do not earn
their split.

The next wave should not be a generic cleanup sweep. It should remove structural
surface area while preserving the same feature set and current stack.

## Scope

**In**

- Collapse stale continuation docs and public-looking import guidance that now
  contradict package exports.
- Prove whether `SessionRuntimeEntity` is a shallow actor over `AgentLoop`; if
  so, delete the extra entity surface.
- Move submission idempotency/completion ownership into the actor or
  effect-encore execution primitive instead of process-local runtime maps.
- Consolidate session mutation ownership so RPC and extension-host mutations
  cannot drift.
- Split the public extension authoring API from builtin/internal authority.
- Unify command semantics so slash/palette commands are server capabilities,
  not duplicated TUI client commands.
- Replace `TaggedEnumClass` with native Effect schema primitives if the worked
  examples preserve wire shape and constructor ergonomics.
- Audit file merit first-class: collapse extension wrapper files, todo
  operation files, tiny TUI barrels, and platform-shaped adapters that do not
  encode a real boundary.
- Replace white-box actor/tool tests with public behavior tests where they lock
  implementation details rather than product contracts.

**Out**

- Feature removal.
- Flattening the actor model.
- Compatibility shims for old private APIs.
- Cosmetic-only renames that do not reduce public surface, file count, or
  ownership duplication.
- Deleting a small file whose split is a real boundary, generated fixture,
  package entrypoint, or external Effect-to-Promise boundary.

## Constraints

- Correctness over pragmatism.
- No `any` / `as unknown as X` escapes to force a simplification through.
- Each commit must pass focused tests and then `bun run gate`.
- Runtime actor/storage batches also run `bun run test:e2e`.
- TUI command/client batches also run `bun run smoke`.
- High-blast-radius migrations must split into reviewable sub-commits.
- Mechanical file moves after a worked example should be delegated.

## Gate Command

- Standard: `bun run gate`
- Runtime/actor/storage: `bun run test:e2e`
- TUI/transport: `bun run smoke`

## Final Audit Summary From Wave 27

All final audit lanes found no P0. They did find P1s:

- `SessionRuntimeEntity` may be a shallow actor wrapper over `AgentLoop`.
- `SessionRuntime` still owns submission idempotency and completion waiting
  outside the actor/effect-encore operation primitive.
- `AgentLoop` uses effect-encore but still owns an internal mini-runtime of
  refs, queue worker, and semaphores.
- `SessionCommands` and `SessionMutations` split durable mutation ownership.
- `@gent/core/extensions/api` is still a privileged internal barrel, not a
  minimal public authoring surface.
- Server action/request slash capabilities and TUI client commands duplicate
  command semantics.
- `TaggedEnumClass` is a custom schema primitive exported to extension authors.
- Queue/actor tests lock private effect-encore metadata and internal behavior
  shapes rather than product behavior.
- File-merit audit found extension wrapper files and todo operation files that
  mostly name arrays rather than boundaries.
- Root `PLAN.md`, `AGENTS.md`, and architecture examples contained stale
  public-looking imports or obsolete continuation instructions.

## Commit 1: docs(plan): promote current wave and remove stale import guidance

**Justification**: The root continuation artifact and instruction examples must
not point agents at superseded waves or public-looking imports that package
exports reject.

**Principles**

- `subtract-before-you-add`: delete stale planning content before adding new
  implementation.
- `boundary-discipline`: docs should teach the real public/internal import
  boundary.

**Changes**

| File                                                    | Change                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `/Users/cvr/Developer/personal/gent/PLAN.md`            | Keep a short pointer to Wave 28 instead of the obsolete Wave 7 plan.                                                     |
| `/Users/cvr/Developer/personal/gent/AGENTS.md`          | Replace stale `@gent/core/domain/*` and `@gent/core/test-utils/*` examples with current public/internal import guidance. |
| `/Users/cvr/Developer/personal/gent/apps/tui/AGENTS.md` | Remove or correct stale public-looking core imports.                                                                     |
| `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`    | Align testing/import examples with package exports and `@gent/core-internal/*`.                                          |

**Verification**

- `rg -n '@gent/core/(domain|runtime|storage|server|test-utils)' AGENTS.md apps/tui/AGENTS.md ARCHITECTURE.md`
- `bun run lint`
- `bun run test`
- `bun run gate`

## Commit 2: docs: delete stale architecture guides

**Justification**: Old maps and migration guides still name packages/apps that
no longer exist. They are not neutral; they are wrong navigation surfaces.

**Principles**

- `subtract-before-you-add`: stale docs with no novel current content should be
  removed.
- `small-interface-deep-implementation`: one current architecture source is
  better than several divergent guides.

**Changes**

| File                                                    | Change                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/CODEMAP.md`         | Delete or replace with a pointer to `ARCHITECTURE.md` if any consumer requires the file. |
| `/Users/cvr/Developer/personal/gent/CODE_GUIDE.md`      | Delete obsolete package guidance.                                                        |
| `/Users/cvr/Developer/personal/gent/MIGRATION-GUIDE.md` | Delete migration-era v3/v4 guidance if no current release workflow consumes it.          |

**Verification**

- `rg -n 'apps/cli|packages/tools|GentCore|src-v3|dist-v3' .`
- `bun run lint`
- `bun run test`
- `bun run gate`

## Commit 3: spike(runtime): prove SessionRuntime entity ownership

**Justification**: The final audit found `SessionRuntimeEntity` may be mostly a
second actor facade over the real `AgentLoop` actor. Prove the ownership before
deleting anything.

**Principles**

- `correctness-over-pragmatism`: prove scope/lifecycle semantics before
  removing an actor boundary.
- `small-interface-deep-implementation`: delete mostly-forwarding surfaces.

**Changes**

| File                                                                                     | Change                                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`        | Map which behavior is unique to `SessionRuntimeEntity` versus direct `AgentLoop` dispatch. |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts` | Confirm actor-owned state, routing, redelivery, and execution-id semantics.                |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/session-runtime.test.ts` | Add or adjust public behavior coverage needed before deletion.                             |

**Verification**

- Focused session runtime tests.
- `bun run --cwd packages/core typecheck`
- `bun run gate`

## Commit 4: refactor(runtime): collapse SessionRuntime shallow entity

**Justification**: If Commit 3 proves the outer entity is a shallow forwarding
surface, remove it and keep `SessionRuntime` as the app service that dispatches
to `AgentLoop`.

**Principles**

- `subtract-before-you-add`: remove the duplicate actor before adding more
  runtime policy.
- `composition-over-flags`: one durable actor owns branch-local turn behavior.

**Changes**

| File                                                                                   | Change                                                                 |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`      | Delete the extra entity role and forward through one service boundary. |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts`          | Update runtime layer wiring.                                           |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/ephemeral-root.ts` | Update child runtime wiring.                                           |
| Runtime tests                                                                          | Keep public behavior, delete private entity-shape assertions.          |

**Verification**

- `bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/runtime/session-runtime.test.ts tests/server/session-idempotency.test.ts`
- `bun run test:e2e`
- `bun run gate`

## Commit 5: refactor(runtime): move submission idempotency to actor ownership

**Justification**: `SessionRuntime` currently owns process-local send-turn maps
and a sleep-poll completion loop while `AgentLoop` already defines operation
ids. One owner should coordinate idempotency and completion.

**Principles**

- `serialize-shared-state-mutations`: shared turn state belongs to one owner.
- `use-the-platform`: use effect-encore execution ids/watch/peek if they own
  the primitive.

**Changes**

| File                                                                                     | Change                                                                                |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`        | Delete `activeSendTurns` and sleep polling if actor/effect-encore can own completion. |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts` | Adjust persisted/live operation semantics if needed.                                  |
| `/Users/cvr/Developer/personal/effect-encore/src/actor.ts`                               | Upstream DX fix if current actor API lacks the right safe wait primitive.             |

**Verification**

- Session idempotency tests.
- Actor restart/redelivery tests if persisted semantics change.
- `bun run test:e2e`
- `bun run gate`

## Commit 6: refactor(server): consolidate session mutation ownership

**Justification**: `SessionCommands` and `SessionMutations` both participate in
branch/session mutation semantics. Request-id persistence should live with the
mutation owner, not beside it.

**Principles**

- `small-interface-deep-implementation`: mutation semantics behind one narrow
  owner.
- `derive-dont-sync`: do not duplicate durable command behavior across RPC and
  extension-host paths.

**Changes**

| File                                                                                          | Change                                                       |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/session-mutations.ts`            | Own the mutation vocabulary and request-id operation policy. |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts`             | Shrink to transport orchestration.                           |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/session-mutations.test.ts` | Preserve extension-host mutation behavior.                   |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/server/session-idempotency.test.ts`   | Preserve request-id behavior.                                |

**Verification**

- Focused session mutation/idempotency tests.
- `bun run gate`

## Commit 7: refactor(extensions): split public authoring api from internal authority

**Justification**: `@gent/core/extensions/api` is the only public core export
and currently re-exports internal/builtin authority. Public extension authors
should not get private or privileged APIs.

**Principles**

- `boundary-discipline`: raw host/storage/event/test helpers stay internal.
- `small-interface-deep-implementation`: one narrow authoring API.

**Changes**

| File                                                                                                | Change                                                                                        |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`                            | Keep minimal authoring symbols; remove builtin/internal exports.                              |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/extension-surface-locks.test.ts` | Lock the smaller public API.                                                                  |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/*`                                      | Move builtins to internal imports or extension-owned services without exposing them publicly. |
| `/Users/cvr/Developer/personal/gent/packages/tooling/tests/core-public-exports.test.ts`             | Add a symbol-level public API inventory if useful.                                            |

**Verification**

- Extension surface locks.
- Extension package tests.
- `bun run typecheck`
- `bun run lint`
- `bun run gate`

## Commit 8: refactor(tui): route commands through server capabilities

**Justification**: Server action/request capabilities already carry slash
metadata. TUI client commands duplicate visibility, permission, and command
semantics.

**Principles**

- `composition-over-flags`: command intent should be one capability primitive.
- `boundary-discipline`: client UI renders commands; server owns command
  authority.

**Changes**

| File                                                                                | Change                                                                          |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/action.ts`  | Ensure server actions can represent current prompt-only commands.               |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts` | Ensure slash requests represent current RPC-backed commands.                    |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/*.client.ts`   | Remove duplicated client command definitions where server capabilities suffice. |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-facets.ts`       | Shrink or delete the client command bucket.                                     |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/resolve.ts`             | Resolve command UI from `extension.listSlashCommands`.                          |

**Verification**

- Command palette tests.
- Extension command RPC tests.
- `bun run smoke`
- `bun run gate`

## Commit 9: refactor(schema): replace TaggedEnumClass with Effect primitives

**Justification**: `TaggedEnumClass` is a custom schema language layered over
Effect schema and exported publicly.

**Principles**

- `use-the-platform`: use native Effect schema/data primitives.
- `correctness-over-pragmatism`: preserve wire shapes with worked examples
  before mass migration.

**Changes**

| File                                                                                      | Change                                                                                 |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/schema-tagged-enum-class.ts` | Delete after migration.                                                                |
| Internal simple users                                                                     | Migrate first: `QueueEntryInfo`, `LoopState`, `SessionRuntimeState`, TUI state events. |
| Persisted/transport users                                                                 | Migrate only after wire-shape tests prove parity.                                      |
| `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`                  | Remove the public export.                                                              |

**Verification**

- Schema roundtrip tests.
- Transport contract tests.
- `bun run typecheck`
- `bun run gate`

## Commit 10: refactor(extensions): collapse thin builtin wrapper files

**Justification**: Several extension files mostly name arrays and do not encode
package boundaries. Bigger cohesive files are preferred when the split does not
buy a reader or caller a real boundary.

**Principles**

- `small-interface-deep-implementation`: keep real extension/domain boundaries,
  merge wrappers.
- `subtract-before-you-add`: reduce file count before adding new APIs.

**Changes**

| File                                                                                | Change                                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/index.ts`               | Own trivial builtin composition directly where appropriate.               |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/network-tools/index.ts` | Merge if still only a two-tool array.                                     |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/index.ts`      | Merge if the extension definition is only a composition wrapper.          |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/plan.ts`                | Merge if it is not an independent boundary.                               |
| Similar thin wrappers                                                               | Audit before deleting; keep real public entrypoints and high-churn seams. |

**Verification**

- Before/after file-count and `<=120 LOC` report.
- Extension tests.
- `bun run gate`

## Commit 11: refactor(todo): consolidate todo tool operation files

**Justification**: The todo feature’s real boundaries are domain, requests,
storage, and service. One-file-per-operation tool splits do not currently earn
their existence.

**Principles**

- `boundary-discipline`: keep domain/request/storage boundaries; merge shallow
  operation wrappers.
- `test-through-public-interfaces`: retarget tests through registry/RPC where
  possible.

**Changes**

| File                                                                                            | Change                                       |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/todo-create.ts`                | Merge into a cohesive todo tool module.      |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/todo-get.ts`                   | Same.                                        |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/todo-list.ts`                  | Same.                                        |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/todo-update.ts`                | Same.                                        |
| `/Users/cvr/Developer/personal/gent/packages/extensions/tests/todo/todo-tool-execution.test.ts` | Retarget away from operation-file internals. |

**Verification**

- Todo extension tests.
- Core RPC acceptance for todo.
- `bun run gate`

## Commit 12: test(runtime): replace actor key tests with public behavior

**Justification**: Some runtime tests assert private `_meta` and exact
effect-encore execution id strings. Keep only tests that protect Gent-visible
behavior.

**Principles**

- `test-through-public-interfaces`: tests should survive internal rewrites.
- `use-the-platform`: do not preserve effect-encore internals as Gent behavior.

**Changes**

| File                                                                                            | Change                                                                                      |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop-queue.test.ts`       | Move queue semantics to public SessionRuntime/RPC behavior where possible.                  |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent/agent-loop.actor.test.ts` | Keep only a narrow actor integration smoke if needed; delete private key-format assertions. |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/server/workspace-rpc.test.ts`           | Extend public isolation/queue coverage if it replaces actor internals.                      |

**Verification**

- Focused runtime tests.
- `bun run test:e2e`
- `bun run gate`

## Commit 13: refactor(tooling): collapse suppression and regex guardrails

**Justification**: Guardrails should be strict, but line-number allowlists and
parallel regex scanners create maintenance surface. Prefer structural lint
rules and local reasoned exceptions.

**Principles**

- `use-the-platform`: use the existing oxlint custom rule substrate where it
  can own the guard.
- `small-interface-deep-implementation`: fewer guardrail systems, same or
  stricter policy.

**Changes**

| File                                                                                     | Change                                                                           |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/tooling/src/suppression-inventory.ts`       | Replace line-number inventory with structural policy if it preserves strictness. |
| `/Users/cvr/Developer/personal/gent/packages/tooling/src/platform-duplication-guards.ts` | Move still-needed bans into custom lint or delete bans covered by exports/types. |
| `/Users/cvr/Developer/personal/gent/lint/no-direct-env.ts`                               | Extend custom rule substrate where appropriate.                                  |
| Tooling tests                                                                            | Preserve zero-carveout behavior with less exact-line churn.                      |

**Verification**

- Tooling tests.
- `bun run lint`
- `bun run gate`

## Final Batch: audit: independent simplicity audit

Run the same final audit lanes from Wave 27, including file-merit and split
justification, without leading the auditors toward the work completed here.
Close only if no P0/P1 remains. If P0/P1 remains, synthesize the next wave.

**Verification**

- Five independent audit lanes.
- `bun run gate`
- `bun run smoke`
- `bun run test:e2e`

## Receipts

- `/Users/cvr/Developer/personal/gent/plans/WAVE-27.md`
- `/Users/cvr/Developer/personal/gent/PLAN.md`
- `/Users/cvr/Developer/personal/gent/AGENTS.md`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/session-mutations.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/schema-tagged-enum-class.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/`
- `/Users/cvr/Developer/personal/effect-encore/src/actor.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/sql/sqlite-node/test/SqlEventLogServerUnencrypted.test.ts`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/index.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts`
