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
- Remove the stale `TaggedEnumClass` migration batch unless a native Effect
  primitive proves source-compatible with Gent's current constructor and wire-tag
  ergonomics.
- Audit file merit first-class: prefer bigger cohesive files when the smaller
  split does not earn its existence. Collapse extension wrapper files, todo
  operation files, tiny TUI barrels, single-use utils/classes/services, and
  platform-shaped adapters that do not encode a real boundary.
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
- `TaggedEnumClass` was a custom schema primitive exported to extension authors.
  Commit 7 removed that public export; the remaining helper is internal and
  should only be revisited with a source-compatible Effect primitive proof.
- Queue/actor tests lock private effect-encore metadata and internal behavior
  shapes rather than product behavior.
- File-merit audit found extension wrapper files and todo operation files that
  mostly name arrays rather than boundaries.
- Root `PLAN.md`, `AGENTS.md`, and architecture examples contained stale
  public-looking imports or obsolete continuation instructions.

## Commit 1: docs(plan): promote current wave and remove stale import guidance

**Status**: Completed in this wave.

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

**Status**: Completed in this wave.

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

- `rg -n 'apps/cli|packages/tools|GentCore|src-v3|dist-v3' . --glob '!plans/**'`
- `bun run lint`
- `bun run test`
- `bun run gate`

## Commit 3: spike(runtime): prove SessionRuntime entity ownership

**Status**: Completed in this wave.

**Justification**: The final audit found `SessionRuntimeEntity` may be mostly a
second actor facade over the real `AgentLoop` actor. Prove the ownership before
deleting anything.

**Principles**

- `correctness-over-pragmatism`: prove scope/lifecycle semantics before
  removing an actor boundary.
- `small-interface-deep-implementation`: delete mostly-forwarding surfaces.

**Changes**

| File                                                                                     | Change                                                                                             |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`        | Proved no unique branch-local ownership: the entity only forwarded to direct `AgentLoop` dispatch. |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts` | Confirm actor-owned state, routing, redelivery, and execution-id semantics.                        |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/session-runtime.test.ts` | Add or adjust public behavior coverage needed before deletion.                                     |

**Verification**

- Focused session runtime tests.
- `bun run --cwd packages/core typecheck`
- `bun run gate`

## Commit 4: refactor(runtime): collapse SessionRuntime shallow entity

**Status**: Completed in this wave.

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

**Status**: Completed in this wave.

**Justification**: `SessionRuntime` currently owns process-local send-turn maps
and a sleep-poll completion loop while `AgentLoop` already defines operation
ids. One owner should coordinate idempotency and completion.

**Principles**

- `serialize-shared-state-mutations`: shared turn state belongs to one owner.
- `use-the-platform`: use effect-encore execution ids/watch/peek if they own
  the primitive.

**Changes**

| File                                                                                     | Change                                                                                                                                                            |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`        | Deleted process-local send-turn maps and sleep polling; durable request-id sends now dispatch through persisted actor operation ids and wait on the event stream. |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts` | Added persisted `SubmitDurable`, kept ordinary `Submit` live, and provided actor state registry to handler materialization.                                       |
| `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/index.ts`               | Made `RecordingEventStore.subscribe` live so tests match the real event store contract.                                                                           |

**Verification**

- `bun run --cwd packages/core typecheck`
- `bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/runtime/session-runtime.test.ts tests/server/session-idempotency.test.ts tests/runtime/agent/agent-loop.actor.test.ts tests/runtime/external-turn.test.ts`
- `bun run test:e2e`
- `bun run gate`

## Commit 6: refactor(server): consolidate session mutation ownership

**Status**: Completed in this wave.

**Justification**: `SessionCommands` and `SessionMutations` both participate in
branch/session mutation semantics. Request-id persistence should live with the
mutation owner, not beside it.

**Principles**

- `small-interface-deep-implementation`: mutation semantics behind one narrow
  owner.
- `derive-dont-sync`: do not duplicate durable command behavior across RPC and
  extension-host paths.

**Changes**

| File                                                                                                | Change                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/session-mutations.ts`                  | Added optional request-id fields to branch mutation operations.                                                                                                                |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts`                   | Moved branch create/fork/switch bodies and durable operation rows behind `SessionMutations`; kept transport dedup, session creation, sending, and summarization orchestration. |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/server/session-command-persistence.test.ts` | Preserved rollback and mutation validation behavior.                                                                                                                           |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/server/session-idempotency.test.ts`         | Preserved request-id behavior.                                                                                                                                                 |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/server/extension-commands-rpc.test.ts`      | Preserved extension-host mutation behavior.                                                                                                                                    |

**Verification**

- `bun run --cwd packages/core typecheck`
- `bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/server/session-idempotency.test.ts tests/server/session-command-persistence.test.ts tests/server/extension-commands-rpc.test.ts`
- `bun run gate`

## Commit 7: refactor(extensions): split public authoring api from internal authority

**Status**: Completed in this wave.

**Justification**: `@gent/core/extensions/api` is the only public core export
and currently re-exports internal/builtin authority. Public extension authors
should not get private or privileged APIs.

**Principles**

- `boundary-discipline`: raw host/storage/event/test helpers stay internal.
- `small-interface-deep-implementation`: one narrow authoring API.

**Changes**

| File                                                                                                | Change                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`                            | Removed raw events, host process platform, internal schema helpers, file index/lock services, output buffers, state publisher, and capability-access enforcement from the public authoring barrel. |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/extension-surface-locks.test.ts` | Locked the smaller public API with compile-time negative assertions for the removed internal authority.                                                                                            |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/*`                                      | Moved Gent-owned composition code to explicit `@gent/core-internal/*` imports where it still consumes internal authority.                                                                          |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/*`                                      | Moved TUI-owned client extension plumbing to explicit internal imports for transport/client runtime types.                                                                                         |
| `/Users/cvr/Developer/personal/gent/lint/no-direct-env.ts`                                          | Kept public-looking `@gent/core/*` internals forbidden while allowing workspace-owned composition code to use the private `@gent/core-internal/*` lane.                                            |
| `/Users/cvr/Developer/personal/gent/packages/core/package.json`                                     | Reduced the default core shard size from 8 to 4 and raised parallelism from 3 to 4 after Bun repeatedly segfaulted on one 8-file runtime shard.                                                    |

**Verification**

- `bun run --cwd packages/core typecheck`
- `bun run typecheck`
- `bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/extensions/extension-surface-locks.test.ts ../tooling/tests/fixtures.test.ts ../tooling/tests/core-public-exports.test.ts`
- Core test runner shard-size repro with `xargs -n 4 -P 4`
- `bun run lint`
- `bun run gate`

## Commit 8: refactor(tui): route commands through server capabilities

**Status**: Completed in this wave.

**Justification**: Server action/request capabilities already carry slash
metadata. TUI client commands duplicate visibility, permission, and command
semantics.

**Principles**

- `composition-over-flags`: command intent should be one capability primitive.
- `boundary-discipline`: client UI renders commands; server owns command
  authority.

**Changes**

| File                                                                                            | Change                                                                                                                                 |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/action.ts`              | Added action slash trigger metadata so `/review` can route to `review-command` without shadowing the model `review` tool.              |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts`           | Public command dispatch now accepts slash actions as well as slash requests; palette-only actions remain non-invokable.                |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/handoff.ts`                         | Moved `/handoff` prompt enqueueing into a server action capability.                                                                    |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/plan.ts`                            | Moved `/plan` and `/audit` prompt enqueueing into server action capabilities.                                                          |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/review/review-tool.ts`              | Moved `/review` prompt enqueueing into a server action while preserving the `review` model tool id.                                    |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/counsel/counsel-tool.ts`            | Moved `/counsel` prompt enqueueing into a server action while preserving the `counsel` model tool id.                                  |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/research/index.ts`                  | Moved `/research` prompt enqueueing into a server action while preserving the `research` model tool id.                                |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/plan.client.ts`            | Deleted the now-empty client command wrapper.                                                                                          |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/handoff.client.ts`         | Kept only the handoff interaction renderer.                                                                                            |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/tool-renderers.client.tsx` | Removed duplicated `/review`, `/counsel`, and `/research` prompt commands; kept UI-only tool renderers, todo UI, and `/loop`.          |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/server/extension-commands-rpc.test.ts`  | Locked slash action listing, transport dispatch, and queue-follow-up behavior.                                                         |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/capability-host.test.ts`     | Locked direct registry semantics for slash actions, palette-only rejection, and higher-scope action shadowing of lower-scope requests. |
| `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-integration.test.ts`               | Retargeted builtin client loader expectations away from server-owned slash commands.                                                   |
| `/Users/cvr/Developer/personal/gent/packages/tooling/src/suppression-inventory.ts`              | Updated the strict line-number receipt after formatting shifted an existing Effect diagnostic suppression.                             |

**Verification**

- `bun run typecheck`
- `cd packages/core && env -u FORCE_COLOR NO_COLOR=1 bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/extensions/capability-host.test.ts tests/extensions/registry.test.ts tests/extensions/extension-surface-locks.test.ts tests/server/extension-commands-rpc.test.ts`
- `cd apps/tui && env -u FORCE_COLOR NO_COLOR=1 bun test --reporter=dots --preload ../../packages/tooling/src/test-log-preload.ts --preload ./node_modules/@opentui/solid/scripts/preload.ts tests/extension-integration.test.ts`
- `bun run lint`
- `bun run smoke`
- `bun run gate`

## Commit 9: docs(plan): remove stale TaggedEnumClass migration batch

**Status**: Completed in this wave.

**Justification**: Effect v4 exposes `Schema.TaggedUnion` /
`Schema.TaggedStruct`, not a source-compatible `Schema.TaggedEnum` primitive
with the constructor and explicit wire-tag ergonomics Gent's internal helper
currently provides. Commit 7 already removed `TaggedEnumClass` from the public
extension authoring API, which was the P1 boundary leak. Deleting or mass
migrating the internal helper in this wave would be speculative churn.

**Principles**

- `correctness-over-pragmatism`: do not replace persisted/transport schemas
  with a near-match primitive without a worked parity proof.
- `subtract-before-you-add`: remove a stale batch from the wave rather than
  carrying an impossible migration forward.

**Changes**

| File                                                                     | Change                                                                                              |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/plans/WAVE-28.md`                    | Removed the stale “replace TaggedEnumClass with Effect primitives” implementation batch from scope. |
| `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts` | Already no longer exports `TaggedEnumClass`; no code change needed in this batch.                   |

**Verification**

- `rg -n "TaggedEnumClass" packages/core/src/extensions/api.ts`
- `rg -n "TaggedEnum|TaggedUnion|TaggedStruct" node_modules/effect/src/Schema.ts`

## Commit 10: refactor(extensions): collapse thin builtin wrapper files

**Status**: Completed in this wave.

**Justification**: Several extension files mostly name arrays and do not encode
package boundaries. Bigger cohesive files are preferred when the split does not
buy a reader or caller a real boundary.

**Principles**

- `small-interface-deep-implementation`: keep real extension/domain boundaries,
  merge wrappers.
- `subtract-before-you-add`: reduce file count before adding new APIs.

**Changes**

| File                                                                                                | Change                                                                                      |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/index.ts`                               | Own fs, network, session, and interaction builtin composition directly.                     |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/network-tools/index.ts`                 | Deleted the two-tool wrapper.                                                               |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/index.ts`                      | Deleted the shallow resource/tool-array wrapper.                                            |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/session-tools/index.ts`                 | Deleted the wrapper and moved the small system-prompt reaction next to builtin composition. |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/interaction-tools/index.ts`             | Deleted the two-tool wrapper.                                                               |
| `/Users/cvr/Developer/personal/gent/packages/extensions/tests/session-tools.test.ts`                | Import the builtin from the package composition root.                                       |
| `/Users/cvr/Developer/personal/gent/packages/extensions/tests/fs-tools/fs-tools-model-turn.test.ts` | Import the builtin from the package composition root.                                       |

**Verification**

- Before/after file-count and `<=120 LOC` report.
  - Before: 107 extension source files; 51 files `<=120 LOC`.
  - After: 103 extension source files; 46 files `<=120 LOC`.
- `bun run --cwd packages/extensions typecheck`
- `bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/session-tools.test.ts tests/fs-tools/fs-tools-model-turn.test.ts`
- `bun run gate`

## Commit 11: refactor(todo): consolidate todo tool operation files

**Status**: Completed in this wave.

**Justification**: The todo feature’s real boundaries are domain, requests,
storage, and service. One-file-per-operation tool splits do not currently earn
their existence.

**Principles**

- `boundary-discipline`: keep domain/request/storage boundaries; merge shallow
  operation wrappers.
- `test-through-public-interfaces`: retarget tests through registry/RPC where
  possible.

**Changes**

| File                                                                                            | Change                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/tools.ts`                      | Added one cohesive todo tool module for create/list/get/update.                                                                                                         |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/todo-create.ts`                | Deleted one-operation file.                                                                                                                                             |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/todo-get.ts`                   | Deleted one-operation file.                                                                                                                                             |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/todo-list.ts`                  | Deleted one-operation file.                                                                                                                                             |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/todo-update.ts`                | Deleted one-operation file.                                                                                                                                             |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/index.ts`                      | Imports tool contributions from the cohesive module.                                                                                                                    |
| `/Users/cvr/Developer/personal/gent/packages/extensions/tests/todo/todo-tool-execution.test.ts` | Retargeted away from operation-file internals.                                                                                                                          |
| `/Users/cvr/Developer/personal/gent/packages/core/package.json`                                 | Reduced residual core test shard size from 4 to 2 after Bun repeatedly segfaulted on one three/four-file runtime grouping while the same files passed as pairs/singles. |

**Verification**

- Before/after file-count and `<=120 LOC` report.
  - Before: 103 extension source files; 46 files `<=120 LOC`.
  - After: 100 extension source files; 42 files `<=120 LOC`.
- `bun run --cwd packages/extensions typecheck`
- `cd packages/extensions && env -u FORCE_COLOR NO_COLOR=1 bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/todo/todo-tool-execution.test.ts tests/todo/todo-rpc.test.ts`
- `cd packages/core && env -u FORCE_COLOR NO_COLOR=1 bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/runtime/file-index/file-index.test.ts tests/runtime/model-registry.test.ts`
- `cd packages/core && env -u FORCE_COLOR NO_COLOR=1 bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/runtime/context-estimation.test.ts tests/runtime/agent-runner.test.ts`
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
The file-merit lane must ask whether each split earns its existence; bigger
cohesive files are preferred over single-use utils, tiny classes/services, or
wrappers that only name another abstraction. Close only if no P0/P1 remains. If
P0/P1 remains, synthesize the next wave.

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
