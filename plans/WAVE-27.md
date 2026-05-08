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

| File                                                                               | Change                                                                                                          | Lines    |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------- |
| small files baseline                                                               | Audit all `apps/` and `packages/` source files at `<=120` LOC. Current baseline: 258 files, 14,265 LOC.         | all      |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/utils/truncate.ts`                | Merge into the owning formatter/view module if it has one caller.                                               | all      |
| `/Users/cvr/Developer/personal/gent/apps/server/src/check.ts`                      | Inline into the server entrypoint if it is only a health/check helper.                                          | all      |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/index.ts`      | Covered by Commit 3; delete tiny barrel.                                                                        | all      |
| `/Users/cvr/Developer/personal/gent/packages/e2e/src/effect-test-adapters.ts`      | Covered by platform-primitive cleanup; remove if it only renames Effect functions.                              | all      |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/*/index.ts`            | Merge extension index files that only re-export one local module, unless they are package entrypoints.          | multiple |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/*/platform-adapter.ts` | Merge tiny platform adapters into the extension host-facing module unless they protect a real portability edge. | multiple |

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

## Commit 8: refactor(runtime): collapse AgentLoop accept operations into durable commands

**Justification**: Public/accept op pairs duplicate one mailbox concept. The
actor should own durable commands without requiring callers to know the private
`Accept*` phase.

**Principles**

- `composition-over-flags`: one command primitive per intent.
- `make-impossible-states-unrepresentable`: callers cannot choose the wrong op.
- `small-interface-deep-implementation`: absorb accept handling into the actor.

**Skills**: `architecture`, `effect-v4`, `test`.

**Changes**

| File                                                                                            | Change                                                                                                   | Lines                           |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts`        | Remove `AcceptSubmit`, `AcceptQueueFollowUp`, and `AcceptSteer`; merge handlers into public durable ops. | `260-424`, `917-1078`           |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`               | Stop calling private accept ops.                                                                         | `616-649`, `673-786`, `837-853` |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent/agent-loop.actor.test.ts` | Rewrite op idempotency tests around public command behavior.                                             | `70-206`                        |

**Verification**

- Focused actor/session-runtime tests.
- `bun run test`
- `bun run test:e2e`
- `bun run gate`

## Commit 9: refactor(runtime): hide AgentLoop mutable internals behind STM entity state

**Justification**: The actor boundary is correct, but the behavior object
exposes refs, queues, semaphores, scope, and lifecycle fields as an internal
service bag. STM should own the state transition primitive more deeply.

**Principles**

- `use-the-platform`: use `TxSubscriptionRef`, `TxRef`, and `TxQueue` for
  atomic state/queue updates.
- `small-interface-deep-implementation`: expose fewer behavior internals.

**Skills**: `effect-v4`, `architecture`, `test`.

**Changes**

| File                                                                                        | Change                                                                                    | Lines                                        |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts` | Collapse exposed mutable fields and move queue transactions behind one STM-backed module. | `137-184`, `342-442`, `464-552`, `1093-1286` |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.state.ts`    | Keep pure state transition ownership.                                                     | `32-259`                                     |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/agent-loop-queue-state.ts`     | Keep durable queue schema.                                                                | `5-17`                                       |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop-queue.test.ts`   | Preserve public queue behavior tests.                                                     | multiple                                     |

**Verification**

- Focused queue, interaction, actor, and session-runtime tests.
- `bun run test`
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

| File                                                                                             | Change                                                            | Lines     |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | --------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior-deps.ts` | Delete Tag and service projection.                                | `39-134`  |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts`         | Yield services in the actor/behavior construction path.           | `501-550` |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts`      | Accept only the real behavior inputs.                             | `232-267` |
| AgentLoop tests using `AgentLoopBehaviorDeps.Live`                                               | Migrate to higher public runtime helpers or a smaller test layer. | multiple  |

**Verification**

- `bun run typecheck`
- `bun run test`
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

| File                                                                                    | Change                                                      | Lines                |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/event.ts`                  | Absorb publish/subscribe semantics into event log boundary. | `343-354`, `442-523` |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/event-store-live.ts`      | Keep one live event-log implementation.                     | `19-125`             |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/event-publisher.ts`        | Delete or reduce to private implementation detail.          | `13-29`, `69-144`    |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/domain/event-publisher.test.ts` | Preserve behavior tests under event log naming.             | `62-194`             |

**Verification**

- Event publishing tests.
- Session command/runtime tests.
- `bun run test`
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

| File                                                                                        | Change                                                      | Lines                                       |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts`           | Replace five request caches with one keyed dedup primitive. | `72-128`, `566-633`, `693-742`, `1050-1077` |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/server/session-idempotency.test.ts` | Preserve in-flight request dedup behavior.                  | multiple                                    |

**Verification**

- Focused session idempotency tests.
- `bun run test`
- `bun run gate`

## Commit 13: refactor(storage): delete shallow storage services

**Justification**: `StorageTransaction` and `InteractionPendingReader` are
mostly one-method wrappers. Move the behavior to the boundary that owns it.

**Principles**

- `small-interface-deep-implementation`: delete mostly-forwarding services.
- `boundary-discipline`: JSON decode belongs at the storage boundary that
  returns the value.

**Skills**: `effect-v4`, `architecture`, `test`.

**Changes**

| File                                                                                         | Change                                                                  | Lines              |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------ |
| `/Users/cvr/Developer/personal/gent/packages/core/src/storage/storage-transaction.ts`        | Delete wrapper; use `sql.withTransaction` at the real storage boundary. | all                |
| `/Users/cvr/Developer/personal/gent/packages/core/src/storage/interaction-pending-reader.ts` | Delete wrapper; move decode into interaction storage.                   | all                |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-helpers.ts`         | Update transaction dependency.                                          | `38-66`            |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/ephemeral-root.ts`       | Update omitted override types.                                          | `46-60`            |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-runner.ts`         | Update transaction dependency.                                          | `63-90`, `751-981` |

**Verification**

- `bun run typecheck`
- `bun run test`
- `bun run gate`

## Commit 14: refactor(extensions): narrow public authoring api

**Justification**: Extension authors should get a small expressive API, not
private capability writers or privileged host internals.

**Principles**

- `small-interface-deep-implementation`: expose the authoring surface, hide
  internal machinery.
- `boundary-discipline`: private capability writes stay internal.

**Skills**: `architecture`, `effect-v4`, `test`.

**Changes**

| File                                                                                                | Change                                                                                                           | Lines                          |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`                            | Move internal/full-power exports to explicit internal subpaths; keep `defineExtension` and typed buckets public. | `63-254`, `284-324`, `404-419` |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/extension-surface-locks.test.ts` | Lock public authoring exports.                                                                                   | all                            |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/define-extension.test.ts`        | Update authoring API expectations.                                                                               | `64-72`                        |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/server/extension-commands-rpc.test.ts`      | Keep private authority export guard.                                                                             | `96-100`                       |

**Verification**

- Extension surface tests.
- `bun run typecheck`
- `bun run test`
- `bun run gate`

## Commit 15: refactor(tui): remove core client facet overload

**Justification**: Core should not carry an opaque TUI client artifact. TUI
client modules are the client extension API.

**Principles**

- `boundary-discipline`: core and TUI boundaries stay explicit.
- `small-interface-deep-implementation`: one client extension path.

**Skills**: `architecture`, `effect-v4`, `test`.

**Changes**

| File                                                                                 | Change                                                     | Lines                |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------- | -------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`             | Remove `client?: Client` and overloads.                    | `284-294`, `404-419` |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-facets.ts`        | Remove `UnifiedClientExtension` lowering path.             | `316-356`            |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/auto.client.ts` | Use standalone `defineClientExtension("@gent/auto", ...)`. | `32-34`              |
| `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-client-facets.test.ts`  | Update tests around standalone client modules.             | `6-39`               |

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

| File                                                                                   | Change                                                                             | Lines              |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------ |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-transport.ts`       | Split public extension transport from private shell transport.                     | `35-49`, `101-175` |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/driver.client.ts` | Replace raw client/runtime use with a narrow driver request or shell-only service. | `26-97`            |
| `/Users/cvr/Developer/personal/gent/apps/tui/tests/autocomplete-effect-items.test.ts`  | Preserve visible driver/autocomplete behavior.                                     | multiple           |

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

| File                                                                                 | Change                                                                   | Lines    |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | -------- |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/components/tool-renderers/index.ts` | Keep UI renderer registry as source for UI-only components.              | `43-66`  |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/headless-tool-renderers.ts`         | Keep only special headless renderers; generic fallback handles the rest. | `89-134` |

**Verification**

- Headless rendering tests.
- `bun run smoke`
- `bun run gate`

## Commit 20: refactor(extensions): share compatible provider driver setup

**Justification**: OpenAI-compatible providers repeat the same env/hint/auth
and client-layer setup. One helper should own the common driver shape.

**Principles**

- `subtract-before-you-add`: collapse observed duplication.
- `use-the-platform`: keep provider wiring in one composable Effect layer.

**Skills**: `effect-v4`, `architecture`, `test`.

**Changes**

| File                                                                          | Change                                         | Lines    |
| ----------------------------------------------------------------------------- | ---------------------------------------------- | -------- |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/openai/index.ts`  | Extract/share compat driver setup.             | `47-88`  |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/google/index.ts`  | Use shared compat setup.                       | `1-67`   |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/mistral/index.ts` | Use shared compat setup.                       | `1-67`   |
| Provider tests                                                                | Preserve OpenAI/Google/Mistral setup behavior. | multiple |

**Verification**

- Provider-focused tests.
- OpenAI smoke test if credentials are present.
- `bun run test`
- `bun run gate`

## Commit 21: refactor(extensions): drop unsupported bedrock builtin

**Justification**: A builtin that exists only to throw unsupported is not a
starting extension set; it is a fake API promise.

**Principles**

- `correctness-over-pragmatism`: do not list unsupported features as builtins.
- `subtract-before-you-add`: delete non-functional surface.

**Skills**: `architecture`, `test`.

**Changes**

| File                                                                          | Change                                                       | Lines         |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------- |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/bedrock/index.ts` | Delete unsupported provider.                                 | `8-27`        |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/index.ts`         | Remove Bedrock registration/export.                          | `13`, `80-84` |
| `/Users/cvr/Developer/personal/gent/package.json`                             | Remove unused Bedrock dependency if no other import remains. | `47-56`       |

**Verification**

- `rg -n "bedrock|Bedrock|@aws-sdk|@ai-sdk/amazon-bedrock" packages apps package.json`
- `bun install` if dependency graph changes.
- `bun run typecheck`
- `bun run test`
- `bun run gate`

## Commit 22: refactor(runtime): separate scheduled jobs from resources

**Justification**: `ResourceContribution` mixes long-lived service lifecycle
with scheduled job declarations. The schedule engine can stay, but scheduled
jobs should be their own extension contribution.

**Principles**

- `small-interface-deep-implementation`: resources should not expose unrelated
  scheduler knobs.
- `make-impossible-states-unrepresentable`: scheduled jobs become explicit.

**Skills**: `architecture`, `effect-v4`, `test`.

**Changes**

| File                                                                                                       | Change                                                           | Lines                                |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------ |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts`                                  | Remove schedule fields from resource contribution.               | `1-18`, `36-57`, `61-107`, `141-155` |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/activation.ts`                    | Reconcile scheduled jobs through a separate contribution bucket. | `413-434`                            |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/resource-host/schedule-engine.ts` | Preserve durable schedule runtime.                               | `50-309`                             |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/memory/index.ts`                               | Move memory dreaming jobs to scheduled-job contribution.         | `40-45`                              |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/scheduler.test.ts`                      | Preserve durable schedule behavior.                              | `32-208`                             |

**Verification**

- Scheduler tests.
- Memory dreaming tests.
- Extension RPC acceptance tests.
- `bun run gate`

## Commit 23: refactor(executor): use scoped lifecycle replacement

**Justification**: Executor connection lifecycle manually tracks gate,
in-flight fiber, generation, read/write, and runtime layers. Effect's scoped
replacement primitive can own much of this.

**Principles**

- `use-the-platform`: use `ScopedRef` or equivalent scoped replacement.
- `small-interface-deep-implementation`: keep the pure actor; shrink the
  lifecycle wrapper.

**Skills**: `effect-v4`, `test`.

**Changes**

| File                                                                                     | Change                                                               | Lines                      |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/actor.ts`           | Keep pure volatile state machine.                                    | `16-27`, `41-56`, `92-143` |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/controller.ts`      | Replace manual connect/disconnect lifecycle with scoped replacement. | `23-34`, `50-66`, `70-193` |
| `/Users/cvr/Developer/personal/gent/packages/extensions/tests/executor/executor.test.ts` | Preserve transitions and views.                                      | `17-162`                   |

**Verification**

- Executor tests.
- Executor RPC/integration tests.
- `bun run test`
- `bun run gate`

## Commit 24: spike(runtime): prove SessionRuntime single implementation

**Justification**: Counsel found two `SessionRuntime` implementation paths. This
is a high-yield deletion only if caller graph and scope ownership prove one path
is redundant.

**Principles**

- `correctness-over-pragmatism`: prove before deleting.
- `subtract-before-you-add`: remove duplicate implementation only after scope
  semantics are known.

**Skills**: `architecture`, `effect-v4`, `test`.

**Changes**

| File                                                                                     | Change                                                                                                                   | Lines                         |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`        | Map callers of `makeLiveSessionRuntime` and `makeEntityClientSessionRuntime`; delete one only if scoped semantics match. | `399`, `1016`, `1095`, `1102` |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/session-runtime.test.ts` | Add/adjust scope ownership regression before deletion.                                                                   | multiple                      |

**Verification**

- Focused session-runtime tests.
- `bun run test:e2e`
- `bun run gate`

## Commit 25: spike(storage): prove workspace-scoped storage boundary

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

| File                                                                                     | Change                                                                              | Lines                 |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/workspace-rpc.ts`           | Keep ingress workspace reference/middleware as source.                              | all                   |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts` | Reduce `withWorkspace` wrappers only after worked storage example proves isolation. | `508-550`, `772-1072` |
| `/Users/cvr/Developer/personal/gent/packages/core/src/storage/event-storage.ts`          | Worked example for workspace-scoped query boundary.                                 | multiple              |
| `/Users/cvr/Developer/personal/gent/packages/core/src/storage/*-storage.ts`              | Delegate mechanical migration after the worked example.                             | multiple              |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/server/workspace-rpc.test.ts`    | Add two-workspace isolation regression if missing.                                  | multiple              |

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
- `/Users/cvr/Developer/personal/gent/apps/tui/src/utils/truncate.ts`
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
