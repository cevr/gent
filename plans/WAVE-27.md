# Planify: Wave 27 - Simplicity And Codebase Reduction

## Context

Gent has converged on the right north stars: actor model, Effect ecosystem, and
platform-owned primitives. The next wave should make the codebase smaller
without reducing the feature set. The goal is not a cosmetic LOC diet. It is to
delete shallow surfaces, custom primitives, duplicated extension/TUI APIs,
stale docs, and tests that preserve wrappers instead of product behavior.

This plan synthesizes five independent audit lanes plus counsel. The recurring
signal is consistent:

- Keep the actor/runtime boundary. It is a structural core, not accidental
  complexity.
- Stop owning primitives Effect, effect-encore, package exports, and public
  test surfaces already own.
- Narrow the extension API so public authoring has no private or privileged
  authority.
- Prefer deletion and absorption into deeper modules over parallel helper
  layers.
- Prefer bigger, cohesive files. Splitting needs to earn its keep through a real
  boundary, ownership seam, public surface, or independently testable domain.
- Close with an independent audit that runs the same audit lanes again, not a
  leading verification prompt.

## Scope

**In**

- Delete stale planning/doc artifacts and duplicated agent instruction files
  when current consumers do not require them.
- Remove shallow forwarding modules, barrels, tombstones, and wrapper services.
- Audit whether files merit their existence; merge tiny utility/class/service
  files back into owning modules when the split is not load-bearing.
- Replace Gent-owned primitives with Effect/effect-encore primitives where the
  behavior is already platform-owned.
- Shrink the public extension authoring API and split private shell authority
  from extension authority.
- Collapse duplicated TUI extension client surfaces and renderer registries.
- Consolidate provider-driver boilerplate and unsupported builtins.
- Make tests more behavioral by deleting direct tests of Effect primitives and
  consolidating duplicated test harness helpers.
- Include spike-gated architecture reductions for workspace scoping,
  SessionRuntime, AgentLoop ops, and event publishing.
- Finish with an independent same-lane audit that prints the audit lanes
  verbatim.

**Out**

- Removing features, changing the stack, or flattening the actor model.
- Compatibility shims that preserve old private APIs for out-of-tree callers.
- DB migrations without an isolation test and a worked example commit first.
- Deleting scheduler durability unless missed-run semantics are re-modeled.

## Constraints

- Preserve current features.
- Preserve actor model as the runtime boundary.
- Use Effect/effect-encore/platform primitives instead of custom primitives when
  they own the behavior.
- No `any` or `as unknown as X` escapes to make simplification compile.
- File splits are not automatically good. A small file must justify itself as a
  real boundary, a generated fixture, a public entrypoint, or a high-churn
  ownership seam.
- Every implementation commit must pass focused tests and then the repo gate
  before the next commit.
- High-blast-radius commits must split into reviewable sub-commits.
- Mechanical migrations after a worked example should be delegated with exact
  rules and stop-on-mismatch instructions.

## Applicable Skills

- `planify` for commit-batched execution and independent final audit.
- `architecture` for module/API boundary decisions.
- `effect-v4` for Effect v4 / STM / service / Schema migration choices.
- `test` for behavioral coverage and public-interface regression placement.
- `code-review` for the final residue/readability pass.

## Gate Command

- Focused gate after each commit: the targeted test commands listed below.
- Standard gate before moving to the next batch: `bun run gate`.
- TUI/transport commits also run `bun run smoke`.
- Runtime/actor/storage commits also run `bun run test:e2e`.

## Research Synthesis

### File Existence Audit Lane

Every batch in this wave includes a file-merit pass. A file earns its existence
when it is at least one of these:

- a public entrypoint or package/subpath boundary;
- a real domain, process, or actor boundary with behavior behind it;
- a generated fixture or external contract mirror;
- a high-churn ownership seam that keeps unrelated change streams apart;
- a test harness whose name describes behavior and whose helpers are shared
  enough to pay for their import surface.

Files that only rename, forward, wrap one function, or isolate a tiny service
because "small files are cleaner" should be merged into the owning module or
deleted. Larger cohesive files are preferred when the split does not buy a
reader, caller, or test a real boundary.

### Strongest Agreed Findings

| Finding                                                                                                                                                                             | Severity | Principle                                                      | File Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public and internal extension APIs are broader than the authoring model needs.                                                                                                      | P1       | small-interface-deep-implementation, boundary-discipline       | `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:63`, `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:226`, `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:284`, `/Users/cvr/Developer/personal/gent/packages/core/tests/server/extension-commands-rpc.test.ts:96`                                                                                                                                  |
| AgentLoop actor ops contain duplicated public/accept pairs.                                                                                                                         | P1       | composition-over-flags, make-impossible-states-unrepresentable | `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:260`, `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:917`, `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:616`                                                                                                                                                                                           |
| TUI client extension artifacts duplicate the server bucket idea with a second tag system.                                                                                           | P1       | small-interface-deep-implementation, subtract-before-you-add   | `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-facets.ts:96`, `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-facets.ts:224`, `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/resolve.ts:313`, `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:295`                                                                                                                                              |
| Client extensions expose raw shell transport authority.                                                                                                                             | P1       | boundary-discipline, small-interface-deep-implementation       | `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-transport.ts:35`, `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-transport.ts:101`, `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/driver.client.ts:26`                                                                                                                                                                                                        |
| Direct STM primitive tests preserve Effect behavior rather than Gent behavior.                                                                                                      | P1       | test-through-public-interfaces, use-the-platform               | `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop-stm-queue.test.ts:1`, `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop-queue.test.ts:45`, `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop-concurrency.test.ts:12`                                                                                                                                                                           |
| Small-file fragmentation needs a file-merit audit before more splitting. A baseline scan found 258 `apps/` and `packages/` source files at 120 LOC or smaller, totaling 14,265 LOC. | P1       | subtract-before-you-add, small-interface-deep-implementation   | `/Users/cvr/Developer/personal/gent/apps/tui/src/utils/truncate.ts`, `/Users/cvr/Developer/personal/gent/apps/server/src/check.ts`, `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/index.ts`, `/Users/cvr/Developer/personal/gent/packages/e2e/src/effect-test-adapters.ts`, `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/platform-adapter.ts`, `/Users/cvr/Developer/personal/gent/packages/extensions/src/bedrock/index.ts` |
| Workspace scoping is re-applied through many storage and actor sites.                                                                                                               | P1 spike | boundary-discipline, small-interface-deep-implementation       | `/Users/cvr/Developer/personal/gent/packages/core/src/server/workspace-rpc.ts`, `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:508`, `/Users/cvr/Developer/personal/gent/packages/core/src/storage/branch-storage.ts`, `/Users/cvr/Developer/personal/gent/packages/core/src/storage/message-storage.ts`                                                                                                                           |
| `SessionRuntime` appears to have two implementation paths.                                                                                                                          | P1 spike | subtract-before-you-add, small-interface-deep-implementation   | `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:399`, `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:1016`, `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:1095`, `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:1102`                                                                                                               |

### Protected Areas

- Do not delete `AgentLoop` as the durable actor. The architecture names it as
  the mailbox/turn/inbox boundary and `SessionRuntime` as the public session
  engine: `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:11`,
  `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:151`.
- Do not delete the extension effect membrane just because it is small. Its
  boundary is real; the target is the `any` hole:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-effect-membrane.ts`.
- Do not delete scheduler durability unless scheduled jobs are split from
  resources with missed-run semantics preserved:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/resource-host/schedule-engine.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/scheduler.test.ts`.

## Commit 1: docs: remove stale planning artifacts

**Justification**: Stale docs are active codebase weight when they point agents
at old package boundaries. Subtracting them makes the current architecture the
only instruction surface.

**Principles**

- `subtract-before-you-add`: delete references with no novel current content.
- `boundary-discipline`: current docs should describe current boundaries.

**Skills**: `documenter`, `code-review`.

**Changes**

| File                                                     | Change                                                                     | Lines          |
| -------------------------------------------------------- | -------------------------------------------------------------------------- | -------------- |
| `/Users/cvr/Developer/personal/gent/TODO.md`             | Delete stale root plan that references old package paths.                  | `7-44`         |
| `/Users/cvr/Developer/personal/gent/RLM-PLAN.md`         | Delete stale root plan that references old package paths.                  | `17-78`        |
| `/Users/cvr/Developer/personal/gent/W10-PHASE-B-PLAN.md` | Delete contradictory old plan.                                             | `3`, `187-222` |
| `/Users/cvr/Developer/personal/gent/.gent/prompts/*`     | Delete empty generated samples only after confirming no script reads them. | all            |

**Verification**

- `rg -n "packages/(server|runtime|storage|tools)" TODO.md RLM-PLAN.md W10-PHASE-B-PLAN.md .gent || true`
- `bun run lint`
- `bun run test`
- `bun run gate`

## Commit 2: docs: collapse duplicate agent instruction files

**Justification**: `CLAUDE.md` duplicates `AGENTS.md` in three places. One
instruction source is smaller and less drift-prone.

**Principles**

- `small-interface-deep-implementation`: one public instruction surface should
  own the content.
- `subtract-before-you-add`: duplicated docs are deletion targets.

**Skills**: `documenter`, `code-review`.

**Changes**

| File                                                         | Change                                                                                             | Lines   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------- |
| `/Users/cvr/Developer/personal/gent/CLAUDE.md`               | Replace duplicate content with a symlink or tiny generated pointer only if supported by consumers. | `1-175` |
| `/Users/cvr/Developer/personal/gent/apps/tui/CLAUDE.md`      | Same as root.                                                                                      | `1-194` |
| `/Users/cvr/Developer/personal/gent/packages/core/CLAUDE.md` | Same as root.                                                                                      | `1-30`  |
| `/Users/cvr/Developer/personal/gent/AGENTS.md`               | Remains the source of truth.                                                                       | `1-175` |
| `/Users/cvr/Developer/personal/gent/apps/tui/AGENTS.md`      | Remains the source of truth.                                                                       | `1-194` |
| `/Users/cvr/Developer/personal/gent/packages/core/AGENTS.md` | Remains the source of truth.                                                                       | `1-30`  |

**Verification**

- Confirm instruction discovery still reads the replacement files.
- `bun run lint`
- `bun run test`
- `bun run gate`

## Commit 3: refactor(core,e2e): delete shallow forwarding modules

**Justification**: Shallow forwarding modules make APIs look deeper than they
are. Use the real modules directly.

**Principles**

- `small-interface-deep-implementation`: delete mostly-forwarding surfaces.
- `subtract-before-you-add`: do not preserve stubs.

**Skills**: `architecture`, `effect-v4`.

**Changes**

| File                                                                          | Change                                                             | Lines  |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------ |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/index.ts`       | Delete runtime barrel and migrate imports to concrete subpaths.    | `1-62` |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/index.ts` | Delete agent barrel and migrate imports.                           | `1-2`  |
| `/Users/cvr/Developer/personal/gent/apps/server/src/debug/session.ts`         | Delete tiny debug forwarding module if no current caller needs it. | `1-21` |
| `/Users/cvr/Developer/personal/gent/packages/e2e/tests/seam-fixture.ts`       | Delete test seam forwarding fixture.                               | `1-8`  |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/client/index.ts`             | Remove client barrel if import migration is mechanical and safe.   | `1-47` |

**Verification**

- `rg -n 'from ".*runtime"|from ".*runtime/agent"|from ".*client"' packages apps`
- `bun run typecheck`
- `bun run lint`
- `bun run test`
- `bun run gate`

## Commit 4: refactor(structure): merge files that do not merit a split

**Justification**: Small files are not a virtue by themselves. A file split
should buy a real boundary, ownership seam, public entrypoint, generated
fixture, or independently understandable domain. Otherwise it increases import
surface, search noise, and architecture weight.

**Principles**

- `small-interface-deep-implementation`: prefer cohesive files with deeper
  implementation over many shallow files.
- `subtract-before-you-add`: merge or delete splits with no novel ownership.
- `boundary-discipline`: keep only boundaries that defend an actual edge.

**Skills**: `architecture`, `code-review`.

**Changes**

| File                                                                                                       | Change                                                                                                          | Lines    |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------- |
| small files baseline                                                                                       | Audit all `apps/` and `packages/` source files at `<=120` LOC. Current baseline: 258 files, 14,265 LOC.         | all      |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/utils/truncate.ts`                                        | Merge into the owning formatter/view module if it has one caller.                                               | all      |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/router/*`                                                 | Collapse the tiny router barrel/types/reducer/context split into one cohesive router module.                    | all      |
| `/Users/cvr/Developer/personal/gent/apps/server/src/check.ts`                                              | Inline into the server entrypoint if it is only a health/check helper.                                          | all      |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/index.ts`                              | Covered by Commit 3; delete tiny barrel.                                                                        | all      |
| `/Users/cvr/Developer/personal/gent/packages/e2e/src/effect-test-adapters.ts`                              | Covered by platform-primitive cleanup; remove if it only renames Effect functions.                              | all      |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/*/index.ts`                                    | Merge extension index files that only re-export one local module, unless they are package entrypoints.          | multiple |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/{counsel,delegate,principles,review}/index.ts` | Move one-tool extension definitions into their owning tool modules.                                             | all      |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/{google,mistral}/index.ts`                     | Move OpenAI-compatible provider instances into the shared compatible-driver module.                             | all      |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/*/platform-adapter.ts`                         | Merge tiny platform adapters into the extension host-facing module unless they protect a real portability edge. | multiple |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/platform-adapter.ts`                | Delete the unused Context.Service wrapper; the Claude SDK only needs a host environment shape.                  | all      |

**Verification**

- Produce a before/after file-count and `<=120 LOC` report.
- `rg -n "from .*index\\.js|from .*platform-adapter\\.js" packages apps`
- `bun run typecheck`
- `bun run lint`
- `bun run test`
- `bun run gate`

## Commit 5: build(core): simplify public export tombstones

**Justification**: Package exports already block unknown subpaths when omitted.
Null tombstones add extra API surface for the tooling guard to preserve.

**Principles**

- `use-the-platform`: use package `exports` behavior directly.
- `small-interface-deep-implementation`: guard the real public surface, not
  tombstone metadata.

**Skills**: `architecture`, `test`.

**Changes**

| File                                                                                    | Change                                                                    | Lines            |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/package.json`                         | Remove redundant `null` tombstones while keeping explicit public exports. | `5-17`           |
| `/Users/cvr/Developer/personal/gent/packages/tooling/src/core-public-exports.ts`        | Enforce only explicit public exports, not explicit nulls.                 | `22-32`, `60-67` |
| `/Users/cvr/Developer/personal/gent/packages/tooling/tests/core-public-exports.test.ts` | Update guard expectations.                                                | `7-165`          |

**Verification**

- A blocked internal subpath import still fails under `tsgo`.
- `bun run typecheck`
- `bun run lint`
- `bun run test`
- `bun run gate`

## Commit 6: test(core): remove platform STM proof and consolidate helpers

**Justification**: Tests should prove Gent behavior through public/product
surfaces, not prove Effect STM semantics directly.

**Principles**

- `test-through-public-interfaces`: test product behavior.
- `use-the-platform`: do not test platform primitives as if Gent owned them.

**Skills**: `test`, `effect-v4`.

**Changes**

| File                                                                                            | Change                                            | Lines    |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------- |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop-stm-queue.test.ts`   | Delete direct STM primitive proof.                | `1-262`  |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop-queue.test.ts`       | Keep/adjust public queue behavior coverage.       | `45-135` |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop-concurrency.test.ts` | Keep/adjust public concurrency behavior coverage. | `12-89`  |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/helpers/test-preset.ts`      | Consolidate duplicate helper.                     | `1-32`   |
| `/Users/cvr/Developer/personal/gent/packages/extensions/tests/helpers/test-preset.ts`           | Consolidate duplicate helper.                     | `1-32`   |
| copied `narrowR` helpers                                                                        | Move to one test utility and migrate call sites.  | multiple |

**Verification**

- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/runtime/agent-loop-queue.test.ts packages/core/tests/runtime/agent-loop-concurrency.test.ts packages/core/tests/runtime/agent-loop-turn-stream.test.ts`
- `bun run test`
- `bun run gate`

## Commit 7: test(tooling): make guard tests data-driven

**Justification**: Guard tests preserve architecture decisions, but repeated
expected objects and migration-shaped fixture names obscure the intent.

**Principles**

- `subtract-before-you-add`: reduce repeated scaffolding.
- `test-through-public-interfaces`: keep the guard behavior, simplify the
  representation.

**Skills**: `test`, `code-review`.

**Changes**

| File                                                                                            | Change                                                       | Lines              |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------ |
| `/Users/cvr/Developer/personal/gent/packages/tooling/tests/platform-duplication-guards.test.ts` | Collapse repeated expectations into data tables.             | `241-520`          |
| `/Users/cvr/Developer/personal/gent/packages/tooling/src/platform-duplication-guards.ts`        | Keep diagnostic source of truth stable.                      | `20-123`           |
| `/Users/cvr/Developer/personal/gent/packages/tooling/tests/fixtures.test.ts`                    | Rename Wave-shaped active fixture names to behavioral names. | `81-85`, `267-280` |

**Verification**

- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/tooling/tests/platform-duplication-guards.test.ts packages/tooling/tests/fixtures.test.ts`
- `bun run lint`
- `bun run gate`

## Commit 8: refactor(runtime): collapse AgentLoop accept operations into public commands

**Justification**: Public/accept op pairs duplicate one mailbox concept. The
actor should expose one command per intent without requiring callers to know
the private `Accept*` phase. In the current SessionRuntime entity path, the
SessionRuntime command boundary owns durability; nested persisted AgentLoop
commands deadlock under the current entity layering and are not the correct
primitive until the SessionRuntime spike lands.

**Principles**

- `composition-over-flags`: one command primitive per intent.
- `make-impossible-states-unrepresentable`: callers cannot choose the wrong op.
- `small-interface-deep-implementation`: absorb accept handling into the actor.

**Skills**: `architecture`, `effect-v4`, `test`.

**Changes**

| File                                                                                     | Change                                                                                           | Lines                           |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts` | Remove `AcceptSubmit`, `AcceptQueueFollowUp`, and `AcceptSteer`; merge handlers into public ops. | `24-32`, `259-316`, `887-911`   |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`        | Stop calling private accept ops.                                                                 | `625-646`, `722-779`, `833-844` |
| `/Users/cvr/Developer/personal/gent/packages/tooling/src/suppression-inventory.ts`       | Re-pin the reviewed `Entity.toLayer` Effect-diagnostic boundary after line drift.                | `210-215`                       |

**Verification**

- `bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/runtime/session-runtime.test.ts tests/server/extension-commands-rpc.test.ts tests/runtime/agent/agent-loop.actor.test.ts`
- `bun run test:e2e`
- `bun run gate`

## Commit 9: refactor(runtime): hide AgentLoop behavior internals

**Justification**: The actor boundary is correct, but the behavior object
exposes refs, queues, semaphores, scope, and lifecycle fields as an internal
service bag. Behavior should own those primitives and expose intent-shaped
operations; callers should not hold mutable handles they can misuse.

**Principles**

- `use-the-platform`: use `TxSubscriptionRef` and `TxQueue` for state and
  worker queue ownership.
- `small-interface-deep-implementation`: expose fewer behavior internals.

**Skills**: `effect-v4`, `architecture`, `test`.

**Changes**

| File                                                                                            | Change                                                                                                                                                                        | Lines                                                          |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts`     | Own the worker `TxQueue`, active-stream ref, close deferred, and scope internally while accepting the actor-owned side-mutation semaphore for cross-generation serialization. | `138-182`, `340-357`, `1103-1318`                              |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts`        | Call behavior intent methods instead of reaching into refs, deferreds, and scopes; keep one actor-owned semaphore across behavior generations after independent review.       | `37-83`, `537-542`, `690-698`, `752-758`, `866-873`, `966-995` |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop-queue.test.ts`       | Close behavior through its public lifecycle API and stop constructing its internal semaphore.                                                                                 | `1-3`, `96-108`, `180-197`                                     |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent/agent-loop.actor.test.ts` | Pin live-only public ops, including `Run`, versus persisted reply commands after independent review caught stale durability wording.                                          | `68-84`, `252-384`                                             |

**Verification**

- `bun run --cwd packages/core typecheck`
- `bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/runtime/agent-loop-queue.test.ts tests/runtime/agent/agent-loop.actor.test.ts tests/runtime/session-runtime.test.ts`
- `bun run test:e2e`
- `bun run gate`

## Commit 10: refactor(runtime): delete AgentLoopBehaviorDeps projection

**Justification**: `AgentLoopBehaviorDeps` re-projects services already in the
Effect context. It is an internal boundary with little behavior.

**Principles**

- `small-interface-deep-implementation`: delete service bags.
- `boundary-discipline`: do not create internal boundaries that merely restate
  available context.

**Skills**: `effect-v4`, `architecture`.

**Changes**

| File                                                                                             | Change                                                                                                                                                     | Lines                             |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior-deps.ts` | Delete Tag and service projection.                                                                                                                         | whole file                        |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts`      | Replace the Tag layer with `makeAgentLoopBehaviorDeps`, a plain Effect factory.                                                                            | `267-339`                         |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts`         | Parameterize actor layers with base sections and close over deps at layer construction, preserving ephemeral storage memoization without a projection Tag. | `461-465`, `690-699`, `1039-1065` |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`                | Depend on the actual actor requirements instead of the deleted projection layer.                                                                           | `268-286`, `1102-1118`            |
| AgentLoop tests using `AgentLoopBehaviorDeps.Live`                                               | Call `AgentLoopTestActor({ baseSections: [] })` or the plain deps factory directly.                                                                        | multiple                          |

**Verification**

- `bun run --cwd packages/core typecheck`
- `bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/runtime/agent-loop-queue.test.ts tests/runtime/agent/agent-loop.actor.test.ts tests/runtime/session-runtime.test.ts tests/runtime/agent-loop-streaming.test.ts tests/runtime/agent-loop-interactions.test.ts tests/runtime/external-turn.test.ts`
- `bun test --preload ../../packages/tooling/src/test-log-preload.ts tests/runtime/agent-runner.test.ts -t "ephemeral helper runs mirror child tool events|ephemeral agent writes to ephemeral storage|ephemeral agent auto-approves interactions|ephemeral agent rebuilds resource"`
- `bun run gate`

## Commit 11: refactor(events): merge event publication into the event log boundary

**Justification**: `EventStore` and `EventPublisher` split append,
broadcast, serialized delivery, and dedupe across shallow interfaces. The
semantics are real; the surface can be smaller.

**Principles**

- `small-interface-deep-implementation`: one event log boundary should own
  publication semantics.
- `correctness-over-pragmatism`: preserve ordered delivery and failure tests.

**Skills**: `architecture`, `effect-v4`, `test`.

**Changes**

| File                                                                                    | Change                                                                                                | Lines                |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/event.ts`                  | Add event-log owned serialized delivery and route memory `publish` through it.                        | `343-395`, `502-535` |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/event-store-live.ts`      | Use the shared serialized delivery primitive in the live event log.                                   | `45-75`              |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/event-publisher.ts`        | Reduce publisher to a compatibility adapter over `EventStore.append/deliver`.                         | `13-95`              |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/domain/event-publisher.test.ts` | Preserve publish/deliver behavior through EventStore-owned delivery semantics.                        | `62-207`             |
| `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/index.ts`              | Add `deliver` to recording event-store fixture.                                                       | `71-95`              |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/ephemeral-root.ts`  | Review fix: route the ephemeral publisher adapter through `EventStore.deliver`, not direct broadcast. | `183-186`            |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-runner.test.ts`   | Regression: duplicate committed delivery from the ephemeral root does not rebroadcast.                | `1132-1185`          |

**Verification**

- `bun run --cwd packages/core typecheck`
- `bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/domain/event-publisher.test.ts tests/runtime/agent-loop-streaming.test.ts tests/runtime/session-runtime.test.ts tests/runtime/external-turn.test.ts`
- `bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/runtime/agent-runner.test.ts tests/domain/event-publisher.test.ts tests/server/session-idempotency.test.ts tests/runtime/session-runtime.test.ts`
- `bun run gate`

## Commit 12: refactor(server): use one request dedup primitive

**Justification**: `SessionCommands` has multiple request caches with the same
`Ref<Map<string, Deferred>>` shape. Use one Effect-owned or tiny shared
primitive.

**Principles**

- `use-the-platform`: prefer `RcMap`, `Effect.cachedFunction`, or a single
  Effect-scoped primitive over repeated maps.
- `composition-over-flags`: one dedup abstraction, many keys.

**Skills**: `effect-v4`, `test`.

**Changes**

| File                                                                              | Change                                                                                | Lines                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts` | Replace five explicit request cache refs with one typed `makeRequestDeduper` factory. | `72-157`, `617-636`, `697-705`, `829-835`, `879-884`, `974-980`, `1050-1055` |

**Verification**

- `bun run --cwd packages/core typecheck`
- `bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/runtime/agent-runner.test.ts tests/domain/event-publisher.test.ts tests/server/session-idempotency.test.ts tests/runtime/session-runtime.test.ts`
- `bun run gate`

## Commit 13: refactor(storage): delete shallow storage services

**Justification**: The old storage transaction file and pending-interaction
reader file are already gone; the remaining shallow surface is the object-shaped
`StorageTransactionService`. A transaction capability is just a function.

**Principles**

- `small-interface-deep-implementation`: delete mostly-forwarding services.
- `boundary-discipline`: JSON decode belongs at the storage boundary that
  returns the value.

**Skills**: `effect-v4`, `architecture`, `test`.

**Changes**

| File                                                                                          | Change                                                                     | Lines                                                   |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts`              | Replace one-method `StorageTransactionService` with a function type.       | `22-38`                                                 |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-helpers.ts`          | Call transaction functions directly from turn helpers.                     | `38`, `65-88`                                           |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts`      | Wrap workspace transaction as a function, not an object.                   | `512-515`                                               |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts`   | Build and call the transaction function directly.                          | `55`, `294-295`, `932-933`                              |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-runner.ts`          | Store runner transactions as functions for durable and subprocess runners. | `63`, `87-88`, `353`, `772-775`, `982-985`              |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts`             | Use a transaction function in mutation and command handlers.               | `33`, `227-243`, `606-607`, `792`, `854`, `916`, `1015` |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-queries.ts`              | Use the same function boundary for snapshot reads.                         | `19`, `66-67`, `140`                                    |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/session-mutations.test.ts` | Update in-memory rollback fixture to the function shape.                   | `24`, `32-49`, `158`, `198`                             |

**Verification**

- `bun run --cwd packages/core typecheck`
- `bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/extensions/session-mutations.test.ts tests/runtime/agent-runner.test.ts tests/runtime/agent-loop-streaming.test.ts tests/runtime/agent-loop-queue.test.ts tests/runtime/agent/agent-loop.actor.test.ts tests/server/session-idempotency.test.ts tests/server/session-commands tests/server/session-queries.test.ts`
- `bun run gate`

## Commit 14: refactor(extensions): hide host-context internals

**Justification**: Extension authors should get one public authoring lane. The
repo guard already forbids `@gent/core-internal` imports from extension sources,
so this batch removes host-context implementation shapes from the public API
without pretending current extensions can tunnel through private paths. Utility
and resource services that current workspace extensions actually require remain
public until a later resource-authority redesign replaces them with
extension-owned resources.

**Principles**

- `small-interface-deep-implementation`: expose the authoring surface, hide
  internal machinery.
- `boundary-discipline`: host-context implementation errors stay internal.

**Skills**: `architecture`, `effect-v4`, `test`.

**Changes**

| File                                                                                                | Change                                                                                                             | Lines               |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`                            | Stop exporting raw host-context error/search-result shapes from the public authoring API.                          | `183-235`           |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/extension-surface-locks.test.ts` | Lock host-context internals out while keeping current extension authoring utilities available through one surface. | `351-394`           |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/*`                                      | Keep workspace extension imports on `@gent/core/extensions/api`; do not bypass the extension import guard.         | see changed imports |

**Follow-up seam**: File locks, file index, extension state pulses, and
capability write checks are still too authoritative for a long-term third-party
extension API. Removing them correctly requires replacing the authority with
extension-owned resources or narrower host capabilities, not reimporting private
core internals.

**Verification**

- `bun run typecheck`
- `bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/extensions/extension-surface-locks.test.ts tests/extensions/define-extension.test.ts tests/server/extension-commands-rpc.test.ts`
- `bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/fs-tools tests/todo tests/auto tests/executor tests/openai tests/anthropic tests/acp-agents tests/artifacts`
- `bun run gate`

## Commit 15: refactor(tui): remove core client facet overload

**Justification**: Core no longer carries an opaque TUI client artifact. The
remaining file-merit residue is in the TUI client module factory itself: a
single-call wrapper and bespoke Schema error class around an already typed
module literal.

**Principles**

- `boundary-discipline`: core and TUI boundaries stay explicit.
- `small-interface-deep-implementation`: one client extension path.

**Skills**: `architecture`, `effect-v4`, `test`.

**Changes**

| File                                                                          | Change                                                                                    | Lines     |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------- |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-facets.ts` | Inline the one-call standalone module wrapper and delete `DefineClientExtensionError`.    | `343-385` |
| `/Users/cvr/Developer/personal/gent/plans/WAVE-27.md`                         | Record that the larger core/client overload removal had already landed before this batch. | `572-599` |

**Verification**

- TUI extension client tests.
- `bun run typecheck`
- `bun run test`
- `bun run smoke`
- `bun run gate`

## Commit 16: refactor(tui): bucket client contributions

**Justification**: Server extension contributions are already bucketed. TUI
should not own a second `_tag` contribution language plus handled-tag registry.

**Principles**

- `subtract-before-you-add`: reuse the existing bucket shape.
- `small-interface-deep-implementation`: remove constructor/registry layers.

**Skills**: `architecture`, `effect-v4`, `test`.

**Changes**

| File                                                                          | Change                                                                    | Lines     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------- |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-facets.ts` | Replace `ClientContribution[]` tagged variants with contribution buckets. | `96-274`  |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/resolve.ts`       | Resolve bucketed contributions; delete `HANDLED_TAGS`.                    | `313-371` |
| `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`      | Keep server bucket model as reference.                                    | `295-323` |
| TUI builtin client modules                                                    | Migrate contribution construction.                                        | multiple  |

**Verification**

- `apps/tui/tests/extensions-resolve.test.ts`
- `apps/tui/tests/extension-effect-setup.test.ts`
- `apps/tui/tests/extension-integration.test.ts`
- `bun run smoke`
- `bun run gate`

## Commit 17: refactor(tui): privatize raw client transport

**Justification**: Public client extensions should use typed request/session
subscription surfaces. Raw SDK client/runtime is shell authority.

**Principles**

- `boundary-discipline`: expose only extension-safe transport.
- `small-interface-deep-implementation`: private shell internals stay private.

**Skills**: `architecture`, `effect-v4`, `test`.

**Changes**

| File                                                                                            | Change                                                                                  | Lines              |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------ |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-transport.ts`                | Remove generic `run` / `cast` from the public typed extension transport.                | `35-58`, `88-96`   |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-services.ts`                 | Move sync-callback Effect runners onto `ClientShell`; session resources receive `cast`. | `35-50`, `126-155` |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/driver.client.ts`          | Use `ClientShell.run` with the narrow driver service instead of transport runner.       | `24-94`            |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/auto.client.ts`            | Use shell runner for cancel and resource refresh.                                       | `32-84`            |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/artifacts.client.ts`       | Pass shell runner into the shared session resource.                                     | `24-39`            |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/tool-renderers.client.tsx` | Pass shell runner into the todo session resource.                                       | `134-154`          |
| `/Users/cvr/Developer/personal/gent/apps/tui/tests/autocomplete-effect-items.test.ts`           | Lock `ClientTransport` to request/session/event authority, not generic runners.         | `197-218`          |

**Verification**

- Driver/autocomplete tests.
- TUI extension integration tests.
- `bun run smoke`
- `bun run gate`

## Commit 18: refactor(tui): share session resource widget plumbing

**Justification**: Auto, Artifacts, and Todo widgets repeat the same
session-keyed state, request, event invalidation, and cleanup pattern.

**Principles**

- `subtract-before-you-add`: extract only the repeated observed workflow.
- `small-interface-deep-implementation`: one deep helper for widget lifecycle.

**Skills**: `react`, `effect-v4`, `test`.

**Changes**

| File                                                                                            | Change                                           | Lines     |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------- |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/context.tsx`                        | Add or expose one session resource facet helper. | `141-198` |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/auto.client.ts`            | Use helper.                                      | `42-114`  |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/artifacts.client.ts`       | Use helper.                                      | `50-103`  |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/tool-renderers.client.tsx` | Use helper for Todo widget.                      | `126-223` |

**Verification**

- Builtin widget tests.
- Extension RPC tests for auto/artifacts/todo.
- `bun run smoke`
- `bun run gate`

## Commit 19: refactor(tui): collapse generic headless renderer registry

**Justification**: Headless rendering already has a generic fallback. Repeating
generic tool names is duplicated registry work.

**Principles**

- `subtract-before-you-add`: delete repeated registrations.
- `small-interface-deep-implementation`: special renderers only where special
  behavior exists.

**Skills**: `test`, `code-review`.

**Changes**

| File                                                                                 | Change                                                                        | Lines     |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | --------- |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/components/tool-renderers/index.ts` | Register a special headless renderer only for bash; other tools use fallback. | `43-65`   |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/headless-tool-renderers.ts`         | Export the bash special renderer and keep the generic fallback as default.    | `67-114`  |
| `/Users/cvr/Developer/personal/gent/apps/tui/tests/headless-runner.test.ts`          | Lock generic fallback behavior for non-special tools.                         | `214-227` |

**Verification**

- Headless rendering tests.
- `bun run smoke`
- `bun run gate`

## Commit 20: refactor(extensions): share compatible provider driver setup

**Status**: Current code already satisfies this lane. Google and Mistral are
constructed through the shared OpenAI-compatible helper, and there are no
separate `src/google` or `src/mistral` provider files left to migrate.

**Justification**: OpenAI-compatible providers should share env/hint/auth and
client-layer setup. One helper owns the common driver shape.

**Principles**

- `subtract-before-you-add`: collapse observed duplication.
- `use-the-platform`: keep provider wiring in one composable Effect layer.

**Skills**: `effect-v4`, `architecture`, `test`.

**Changes**

| File                                                                                     | Evidence                                                                                      | Lines              |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------ |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/openai-compatible-driver.ts` | `makeApiKeyCompatDriver` and `makeApiKeyCompatExtension` own Google/Mistral compatible setup. | `52-123`           |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/openai/index.ts`             | OpenAI API-key path reuses `makeOpenAiCompatResolution` while OAuth remains OpenAI-specific.  | `58-66`, `148-154` |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/index.ts`                    | Builtins import `GoogleExtension` / `MistralExtension` from the shared helper module.         | `12`, `69-70`      |

**Verification**

- Provider-focused tests.
- OpenAI smoke test if credentials are present.
- `bun run test`
- `bun run gate`

## Commit 21: refactor(extensions): drop unsupported bedrock builtin

**Status**: Current code already satisfies the deletion lane. The git-tracked
Bedrock source and dependency are gone; only an empty local directory remained
and was removed during this pass.

**Justification**: A builtin that exists only to throw unsupported is not a
starting extension set; it is a fake API promise.

**Principles**

- `correctness-over-pragmatism`: do not list unsupported features as builtins.
- `subtract-before-you-add`: delete non-functional surface.

**Skills**: `architecture`, `test`.

**Changes**

| Evidence                                                                                | Result                                                                             |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `git ls-files packages/extensions/src/bedrock`                                          | No tracked Bedrock provider remains.                                               |
| `rg -n "bedrock\|Bedrock\|@aws-sdk\|@ai-sdk/amazon-bedrock" packages apps package.json` | No provider/dependency references remain; only principle prose mentions "bedrock". |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/index.ts`                   | Builtins list excludes Bedrock.                                                    |

**Verification**

- `rg -n "bedrock|Bedrock|@aws-sdk|@ai-sdk/amazon-bedrock" packages apps package.json`
- `bun install` if dependency graph changes.
- `bun run typecheck`
- `bun run test`
- `bun run gate`

## Commit 22: refactor(runtime): separate scheduled jobs from resources

**Status**: Current code already satisfies this lane. `ResourceContribution`
contains no schedule fields, `ScheduledJobContribution` lives in its own domain
module, `defineExtension` accepts a `scheduledJobs` bucket, and activation
reconciles scheduled jobs separately after resource startup.

**Justification**: `ResourceContribution` mixes long-lived service lifecycle
with scheduled job declarations. The schedule engine can stay, but scheduled
jobs should be their own extension contribution.

**Principles**

- `small-interface-deep-implementation`: resources should not expose unrelated
  scheduler knobs.
- `make-impossible-states-unrepresentable`: scheduled jobs become explicit.

**Skills**: `architecture`, `effect-v4`, `test`.

**Changes**

| File                                                                                      | Evidence                                                                      | Lines                |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts`                 | Resource contribution has lifecycle fields only; no scheduler fields.         | `55-128`             |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/scheduled-job.ts`            | Scheduled jobs have their own contribution type and constructor.              | `1-24`               |
| `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`                  | `defineExtension` resolves a separate `scheduledJobs` bucket.                 | `287-288`, `409-428` |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/activation.ts`   | Activation reconciles scheduled jobs after process-resource startup.          | `413-440`            |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/memory/index.ts`              | Memory dreaming jobs are declared through `scheduledJobs: MemoryDreamJobs()`. | `35-42`              |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/resource-host.test.ts` | Stale test header updated to describe the separate scheduled-job shape.       | `1-10`               |

**Verification**

- Scheduler tests.
- Memory dreaming tests.
- Extension RPC acceptance tests.
- `bun run gate`

## Commit 23: refactor(executor): use scoped lifecycle replacement

**Status**: Current code already satisfies the scoped replacement lane.
`ExecutorControllerLive` uses `ScopedRef` to replace the in-flight connection
scope, and the remaining `Semaphore` + generation guard is race protection for
disconnect-during-connect, not accidental lifecycle ownership.

**Justification**: Executor connection lifecycle manually tracks gate,
in-flight fiber, generation, read/write, and runtime layers. Effect's scoped
replacement primitive can own much of this.

**Principles**

- `use-the-platform`: use `ScopedRef` or equivalent scoped replacement.
- `small-interface-deep-implementation`: keep the pure actor; shrink the
  lifecycle wrapper.

**Skills**: `effect-v4`, `test`.

**Changes**

| File                                                                                             | Change                                                                                                 | Lines                      |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | -------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/actor.ts`                   | Pure volatile state machine remains cohesive and merits its split from side-effectful lifecycle code.  | `16-27`, `41-56`, `92-143` |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/controller.ts`              | Uses `ScopedRef` for scoped connection replacement; keeps the semaphore/generation guard for ordering. | `72-155`                   |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/executor-integration.test.ts` | Locks disconnect-during-connect so late sidecar completion cannot return the runtime to Ready.         | `560-596`                  |
| `/Users/cvr/Developer/personal/gent/packages/extensions/tests/executor/executor.test.ts`         | Preserves pure transitions and projections.                                                            | `17-162`                   |

**Verification**

- Executor tests.
- Executor RPC/integration tests.
- `bun run test`
- `bun run gate`

## Commit 24: spike(runtime): prove SessionRuntime single implementation

**Status**: The spike found two necessary implementation roles, not duplicate
business logic: the Effect cluster entity hosts the long-lived runtime, and the
`SessionRuntime` service is the typed client facade. The public API no longer
exposes that split; `SessionRuntime.Live` now composes both roles and the old
`LiveWithEntity` / `EntityLive` surface is deleted.

**Justification**: Counsel found two `SessionRuntime` implementation paths. This
is a high-yield deletion only if caller graph and scope ownership prove one path
is redundant.

**Principles**

- `correctness-over-pragmatism`: prove before deleting.
- `subtract-before-you-add`: remove duplicate implementation only after scope
  semantics are known.

**Skills**: `architecture`, `effect-v4`, `test`.

**Changes**

| File                                                                                     | Change                                                                                            | Lines                              |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`        | Keep entity host and client facade as private roles; expose only one `SessionRuntime.Live` layer. | `197-339`, `411-1018`, `1021-1122` |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts`            | Use the single public runtime layer from production wiring.                                       | `308-314`                          |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/ephemeral-root.ts`   | Use the single public runtime layer from ephemeral child runtime wiring.                          | `197-215`                          |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/session-runtime.test.ts` | Keep behavioral runtime coverage on the public layer.                                             | `84-130`                           |
| `/Users/cvr/Developer/personal/gent/packages/tooling/src/platform-duplication-guards.ts` | Keep the agent-runner composition guard aligned to the renamed public layer.                      | `103-108`                          |

**Verification**

- Focused session-runtime tests.
- `bun run test:e2e`
- `bun run gate`

## Commit 25: spike(storage): prove workspace-scoped storage boundary

**Status**: The spike did not find a safe storage-level deletion. Workspace
identity enters at RPC ingress, but long-lived actor entities outlive that RPC
fiber and must restore workspace context from the actor entity id. Storage
predicates remain load-bearing for direct storage calls, entity recovery, and
default-workspace compatibility. The batch adds a public two-workspace RPC
regression instead of weakening the boundary.

**Justification**: Workspace identity is an ingress concern, but current storage
and actor code reapply it at many lower layers. This can delete substantial
boilerplate only if cross-workspace isolation remains structurally proven.

**Principles**

- `boundary-discipline`: workspace identity enters at RPC ingress.
- `small-interface-deep-implementation`: storage callers should not repeat
  tenant predicates.
- `correctness-over-pragmatism`: no workspace shrink without isolation tests.

**Skills**: `architecture`, `effect-v4`, `test`.

**Changes**

| File                                                                                     | Change                                                                                                        | Lines                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/workspace-rpc.ts`           | Keep ingress workspace reference/middleware as request-scope source.                                          | `5-56`                           |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts` | Keep actor `withWorkspace` restoration because actor handlers run from entity id, not the original RPC fiber. | `467-528`, `733-764`, `883-1034` |
| `/Users/cvr/Developer/personal/gent/packages/core/src/storage/session-storage.ts`        | Keep workspace predicates as the durable isolation boundary for session reads/writes.                         | `63-156`                         |
| `/Users/cvr/Developer/personal/gent/packages/core/src/storage/event-storage.ts`          | Keep workspace predicates as the durable isolation boundary for event reads/writes.                           | `71-183`                         |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/server/workspace-rpc.test.ts`    | Add a two-workspace RPC isolation regression through `x-gent-workspace-id`.                                   | `55-84`                          |

**Verification**

- New two-workspace isolation test.
- Storage tests.
- `bun run test`
- `bun run test:e2e`
- `bun run gate`

## Commit 26: refactor(extensions): reuse capability winners for slash command listing

**Justification**: Registry resolution already compiles capability winners.
Slash command listing should not re-iterate tools/actions/requests in a second
shape.

**Principles**

- `subtract-before-you-add`: reuse compiled resolution.
- `small-interface-deep-implementation`: one source of capability precedence.

**Skills**: `architecture`, `test`.

**Changes**

| File                                                                                           | Change                                                               | Lines                |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts`          | Make `listSlashCommands` consume resolved entries/winners.           | `143-188`, `608-640` |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/server/extension-commands-rpc.test.ts` | Preserve public-only slash command behavior and shadowing semantics. | multiple             |

**Verification**

- `packages/core/tests/server/extension-commands-rpc.test.ts`
- `bun run test`
- `bun run gate`

## Commit 27: audit: independent simplicity audit

**Justification**: This is not a verification prompt that leads the auditors
toward the completed work. It is the same independent audit against the same
lanes. If any P0/P1 remains, synthesize the next wave instead of closing.

**Principles**

- `prove-it-works`: close only after independent evidence.
- `correctness-over-pragmatism`: no victory lap when structural findings remain.

**Skills**: `planify`, `architecture`, `effect-v4`, `code-review`.

**Changes**

| File                                                  | Change                                                | Lines        |
| ----------------------------------------------------- | ----------------------------------------------------- | ------------ |
| `/Users/cvr/Developer/personal/gent/plans/WAVE-27.md` | Mark final audit results and follow-up wave decision. | this section |

**Audit lanes to print verbatim**

```text
Audit lane: Architecture, LOC, and file-count reduction

Audit how to shrink /Users/cvr/Developer/personal/gent while preserving the same featureset and current stack. Ground the audit in /Users/cvr/.brain/principles, especially correctness-over-pragmatism, redesign-from-first-principles, subtract-before-you-add, use-the-platform, small-interface-deep-implementation, boundary-discipline, composition-over-flags, make-impossible-states-unrepresentable, and test-through-public-interfaces. North stars: actor model, Effect ecosystem, and use the platform.

Focus on architecture shape, module boundaries, file count, LOC hotspots, shallow forwarding modules, barrels, stale artifacts, duplicated service surfaces, and places where a smaller codebase would be more correct. Compare against /Users/cvr/Developer/personal/gent/ARCHITECTURE.md and the current implementation. Produce P0/P1/P2 findings with absolute file paths and line numbers, risk, estimated deletion, and a commit-batched recommendation. Do not implement.
```

```text
Audit lane: File-merit and split justification

Audit how to shrink /Users/cvr/Developer/personal/gent while preserving the same featureset and current stack. Ground the audit in /Users/cvr/.brain/principles, especially correctness-over-pragmatism, redesign-from-first-principles, subtract-before-you-add, use-the-platform, small-interface-deep-implementation, boundary-discipline, composition-over-flags, make-impossible-states-unrepresentable, and test-through-public-interfaces. North stars: actor model, Effect ecosystem, and use the platform.

Focus on whether files merit their existence. Prefer bigger cohesive files when the split does not encode a real boundary, ownership seam, public entrypoint, generated fixture, independently testable domain, or high-churn isolation point. Audit tiny utils, tiny classes/services, one-method files, barrels, one-line entrypoints, protocol wrappers, platform adapters, test helpers, and extension index files. Produce P0/P1/P2 findings with absolute file paths and line numbers, risk, estimated file/LOC reduction, and a commit-batched recommendation. Do not implement.
```

```text
Audit lane: Effect platform, actor model, and primitive ownership

Audit how to shrink /Users/cvr/Developer/personal/gent while preserving the same featureset and current stack. Ground the audit in /Users/cvr/.brain/principles, especially correctness-over-pragmatism, redesign-from-first-principles, subtract-before-you-add, use-the-platform, small-interface-deep-implementation, boundary-discipline, composition-over-flags, make-impossible-states-unrepresentable, and test-through-public-interfaces. North stars: actor model, Effect ecosystem, and use the platform.

Focus on whether Gent is using Effect and effect-encore properly, whether custom primitives can be replaced by Effect v4 or effect-encore primitives, whether AgentLoop and SessionRuntime follow the actor model, whether STM/TxRef/TxQueue/TxSubscriptionRef can own more state, whether service layers are shallow wrappers over Bun/Node/platform APIs, and whether any `any`/suppression comments signal bad architecture. Produce P0/P1/P2 findings with absolute file paths and line numbers, risk, estimated deletion, and a commit-batched recommendation. Do not implement.
```

```text
Audit lane: Extension API, TUI client API, and harness comparison

Audit how to shrink /Users/cvr/Developer/personal/gent while preserving the same featureset and current stack. Ground the audit in /Users/cvr/.brain/principles, especially correctness-over-pragmatism, redesign-from-first-principles, subtract-before-you-add, use-the-platform, small-interface-deep-implementation, boundary-discipline, composition-over-flags, make-impossible-states-unrepresentable, and test-through-public-interfaces. North stars: actor model, Effect ecosystem, and use the platform.

Focus on whether the extension system is minimal yet expressive, whether there is any private or privileged public extension API, whether builtin extensions are just the starting set, whether client/server extension surfaces duplicate each other, whether the current extensions can be implemented with a smaller API, and whether $repo effect-ts/effect-smol, $repo badlogic/pi-mono, and $repo anomalyco/opencode suggest simpler harness patterns. Produce P0/P1/P2 findings with absolute file paths and line numbers, risk, estimated deletion, and a commit-batched recommendation. Do not implement.
```

```text
Audit lane: Tests, docs, tooling, and behavioral guardrails

Audit how to shrink /Users/cvr/Developer/personal/gent while preserving the same featureset and current stack. Ground the audit in /Users/cvr/.brain/principles, especially correctness-over-pragmatism, redesign-from-first-principles, subtract-before-you-add, use-the-platform, small-interface-deep-implementation, boundary-discipline, composition-over-flags, make-impossible-states-unrepresentable, and test-through-public-interfaces. North stars: actor model, Effect ecosystem, and use the platform.

Focus on whether tests are behavioral, whether test file names mirror code file names where that is the local rule, whether tests duplicate implementation or platform behavior, whether docs/plans/tooling preserve stale architecture, whether suppression comments are warranted or signal bad architecture, and whether guardrails can be stricter with less code. Produce P0/P1/P2 findings with absolute file paths and line numbers, risk, estimated deletion, and a commit-batched recommendation. Do not implement.
```

**Close Criteria**

- Run the five independent audit lanes above as written.
- Synthesize the results into this plan.
- Close only if the final audit finds no remaining P0/P1.
- If P0/P1 remains, create the next wave.
- `bun run gate`
- `bun run smoke`
- `bun run test:e2e`

## Receipts

### Brain Principles

- `/Users/cvr/.brain/principles/correctness-over-pragmatism.md`
- `/Users/cvr/.brain/principles/redesign-from-first-principles.md`
- `/Users/cvr/.brain/principles/subtract-before-you-add.md`
- `/Users/cvr/.brain/principles/use-the-platform.md`
- `/Users/cvr/.brain/principles/small-interface-deep-implementation.md`
- `/Users/cvr/.brain/principles/boundary-discipline.md`
- `/Users/cvr/.brain/principles/composition-over-flags.md`
- `/Users/cvr/.brain/principles/make-impossible-states-unrepresentable.md`
- `/Users/cvr/.brain/principles/test-through-public-interfaces.md`

### Repo Files

- `/Users/cvr/Developer/personal/gent/AGENTS.md:109`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:11`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:151`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:379`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:417`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:452`
- `/Users/cvr/Developer/personal/gent/package.json:9`
- `/Users/cvr/Developer/personal/gent/apps/server/src/check.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/router/context.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/router/index.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/router/router.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/router/types.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/utils/truncate.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/platform-adapter.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/counsel/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/google/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/mistral/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/principles/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/review/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/package.json:5`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/event-publisher.ts:13`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/event.ts:343`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:63`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:226`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:284`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:295`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:404`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:260`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:501`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:508`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:917`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:137`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:342`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:1093`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior-deps.ts:39`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/event-store-live.ts:19`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/activation.ts:413`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-effect-membrane.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:143`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:608`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:399`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:1016`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:1095`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:1102`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts:72`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts:566`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/workspace-rpc.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/storage-transaction.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/interaction-pending-reader.ts`
- `/Users/cvr/Developer/personal/gent/packages/e2e/src/effect-test-adapters.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/domain/event-publisher.test.ts:62`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/define-extension.test.ts:64`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/scheduler.test.ts:32`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop-stm-queue.test.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop-queue.test.ts:45`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop-concurrency.test.ts:12`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent/agent-loop.actor.test.ts:70`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/server/extension-commands-rpc.test.ts:96`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/server/workspace-rpc.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/tooling/src/core-public-exports.ts:22`
- `/Users/cvr/Developer/personal/gent/packages/tooling/src/platform-duplication-guards.ts:20`
- `/Users/cvr/Developer/personal/gent/packages/tooling/tests/core-public-exports.test.ts:7`
- `/Users/cvr/Developer/personal/gent/packages/tooling/tests/fixtures.test.ts:81`
- `/Users/cvr/Developer/personal/gent/packages/tooling/tests/platform-duplication-guards.test.ts:241`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/openai/index.ts:47`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/google/index.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/mistral/index.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/platform-adapter.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/bedrock/index.ts:8`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/index.ts:13`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/controller.ts:23`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/actor.ts:16`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/memory/index.ts:40`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-facets.ts:96`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-facets.ts:224`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-facets.ts:316`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/resolve.ts:313`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-transport.ts:35`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-transport.ts:101`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/auto.client.ts:32`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/auto.client.ts:42`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/artifacts.client.ts:50`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/driver.client.ts:26`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/tool-renderers.client.tsx:126`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/tool-renderers/index.ts:43`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/headless-tool-renderers.ts:89`

### Platform References

- `/Users/cvr/Developer/personal/gent/node_modules/effect/src/TxSubscriptionRef.ts:23`
- `/Users/cvr/Developer/personal/gent/node_modules/effect/src/TxSubscriptionRef.ts:127`
- `/Users/cvr/Developer/personal/gent/node_modules/effect/src/ScopedRef.ts:15`
- `/Users/cvr/Developer/personal/gent/node_modules/effect-encore/README.md:24`
- `/Users/cvr/Developer/personal/gent/node_modules/effect-encore/README.md:77`
- `/Users/cvr/Developer/personal/gent/node_modules/effect-encore/README.md:141`
