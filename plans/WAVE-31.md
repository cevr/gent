# Planify: Wave 31 - Extension Context Authority Closure

## Context

Wave 30 removed several local mini-primitives and upstreamed actor/materialization
DX fixes, but its independent recursive audit found remaining P1s. The shared
shape is authority drift: Gent still exposes multiple ways to access host power
and runtime state even though the target authoring model is ordinary Effect code
that imports constrained facades through `yield* ExtensionContext`.

Wave 31 closes the P1s instead of treating the audit as advisory.

## Scope

**In**

- Make `steer` durably idempotent for retry-after-completion/restart behavior.
- Make `invokeTool` require durable public command identity instead of filling
  missing identity with random ids.
- Remove read/write intent as an authoring or dispatch control plane where
  `ExtensionContext` facades can encode authority in code.
- Remove public process/platform escape hatches from `@gent/core/extensions/api`.
- Remove setup and reaction `ctx`-parameter pockets so extension authors have
  one mental model: yield host facades from Effect context.
- Audit and simplify extension authoring ceremony itself: no capability/read-
  write metadata, no threaded ctx parameters, no privileged builtin/private
  surface when `ExtensionContext` facades can express authority in code.
- Remove builtin/starting-extension privileged registries that bypass the real
  extension graph.
- Tighten platform guardrails so core/extensions are actually protected from
  ambient process facts.
- Fold file-merit P2s that are low-risk and reduce surface while touching nearby
  code.

**Out**

- Feature removal.
- Compatibility shims for old ctx/read-write/private APIs.
- Reintroducing privileged builtin APIs. Builtins remain only the initial
  extension set.
- Solving every `TaggedEnumClass` usage unless the touched surface is already in
  scope.

## Constraints

- Correctness over pragmatism.
- No backwards compatibility.
- High-blast-radius changes must land in sub-commits with gates between them.
- Mechanical caller migrations should be delegated after one worked example if
  they become repetitive.
- Public extension docs must change in the same wave as API changes.
- Final batch must rerun the exact audit lanes below and may close only when no
  P0/P1 remains.

## Applicable Skills

- `effect-v4`
- `architecture`
- `test`
- `planify`
- `cli` for command/diagnostic surfaces touched by public APIs

## Gate Command

- Standard: `bun run gate`
- Actor/runtime/storage: `bun run test:e2e` plus `bun run gate`
- TUI/transport: `bun run smoke` plus `bun run gate`
- API-surface commits: focused surface/guard tests plus `bun run gate`

## Audit Receipts

Independent recursive audit status: no P0 found; P1s remain.

Primary P1 evidence:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:720`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:250`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.state.ts:133`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-helpers.ts:95`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:133`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:699`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:348`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/session-runtime.test.ts:518`
- `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:126`
- `/Users/cvr/Developer/personal/effect-encore/src/actor-mailbox.ts:79`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:40`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:86`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:148`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability.ts:123`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts:16`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts:227`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:298`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts:168`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:223`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:233`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:249`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:211`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-host-context.ts:207`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts:144`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/loader.ts:25`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/activation.ts:32`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/all-agents.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/index.ts:103`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:15`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/log-paths.ts:14`
- `/Users/cvr/Developer/personal/gent/packages/tooling/src/platform-duplication-guards.ts:93`
- `/Users/cvr/Developer/personal/gent/docs/extensions.md:82`
- `/Users/cvr/Developer/personal/gent/docs/extensions.md:119`

Comparison evidence:

- `/Users/cvr/Developer/personal/effect-smol/packages/effect/src/unstable/ai/Tool.ts:1651`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:298`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/specs/tui-plugins.md:93`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/plugin/index.ts:149`

## Commit 1: fix(runtime): require durable command identity

**Status**: Completed in current batch.

**Justification**: A public command that accepts `requestId` must be
durably idempotent, not only deduped while currently queued. Public write
surfaces must require caller identity instead of generating random identities
that turn retries into new commands.

**Principles**

- `make-operations-idempotent`: request identity must survive retries.
- `test-through-public-interfaces`: prove behavior through session commands.

**Changes**

| File                                                                                        | Change                                                                                                      | Lines |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`           | Required `commandId` for `invokeTool`; removed random fallback; dispatch `steer` persisted fire-and-forget. | ~133  |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts`    | Marked `Steer` and `InvokeTool` persisted with deterministic primary keys.                                  | ~278  |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/server/session-idempotency.test.ts` | Added steer retry-after-drain regression so completed commands cannot enqueue again.                        | ~462  |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/session-runtime.test.ts`    | Covered repeated `invokeTool` command id producing one assistant/tool-result/event sequence.                | ~556  |

**Verification**

- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/server/session-idempotency.test.ts -t "steer"`
- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/runtime/session-runtime.test.ts -t "persists tool messages"`
- `bun run typecheck`
- `bun run test:e2e`
- `bun run gate`

## Commit 2: refactor(extensions): remove public process escape hatch

**Status**: Completed in current batch.

**Justification**: `runProcess` and setup-time platform requirements create a
second authority path outside the host-provided `ExtensionContext.Process`
facade.

**Principles**

- `boundary-discipline`: process authority belongs at host edges.
- `small-interface-deep-implementation`: public extension API should expose
  stable facades, not runtime helpers.

**Changes**

| File                                                                                                | Change                                                                           | Lines |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`                            | Stopped exporting `runProcess` and raw host process types.                       | ~223  |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/extension-surface-locks.test.ts` | Locked reduced public API for process runner/platform/error exports.             | ~450  |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/platform-adapter.ts`          | Moved starting-extension host-platform wiring off the public authoring barrel.   | ~1    |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/platform-adapter.ts`           | Moved starting-extension host-platform wiring off the public authoring barrel.   | ~1    |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/sidecar.ts`                    | Kept public import to `isRecord` only; host-platform type is internal.           | ~26   |
| `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`                                                | Documented setup host as facts/probes, not process authority.                    | ~340  |
| `/Users/cvr/Developer/personal/gent/docs/extensions.md`                                             | Documented `ExtensionContext.Process` as the only public process authority path. | ~80   |

**Verification**

- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/extensions/extension-surface-locks.test.ts`
- `bun run typecheck`
- `bun run gate`

## Commit 3: refactor(extensions): remove read-write intent ceremony

**Status**: Completed in current batch.

**Justification**: Request/tool authority should be expressed by available
facades and Effect services, not by a parallel `intent` metadata channel and
runtime denial traps.

**Principles**

- `composition-over-flags`: remove intent as a flag controlling authority.
- `use-the-platform`: use Effect service availability instead of local access
  modes.

**Changes**

| File                                                                                  | Change                                                                                     | Lines |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts`   | Collapsed read/write request inputs into one request shape.                                | ~40   |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability.ts`           | Removed request intent from refs/variants while preserving tool/action Effect AI metadata. | ~67   |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts`   | Removed read-intent denial facade; `ExtensionContext` authority is expressed by services.  | ~16   |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts` | Stopped selecting service facades or matching dispatch by request intent.                  | ~298  |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`   | Removed intent from public request transport and slash-command projections.                | ~206  |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-transport.ts`      | Removed request intent from TUI extension client calls.                                    | ~150  |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/requests.ts`         | Migrated representative request definitions.                                               | ~29   |
| `/Users/cvr/Developer/personal/gent/docs/extensions.md`                               | Updated request docs around `yield* ExtensionContext`, not intent metadata.                | ~120  |

**Verification**

- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/extensions/extension-surface-locks.test.ts packages/core/tests/extensions/capability-host.test.ts`
- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/server/extension-commands-rpc.test.ts`
- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/extensions/tests/todo/todo-rpc.test.ts`
- `bun run typecheck`
- `bun run lint`
- `bun run gate`

## Commit 4: refactor(extensions): make reactions context-provided

**Status**: Completed in current batch.

**Justification**: Reaction handlers still take `ctx` parameters, preserving
the old imperative extension-authoring shape. They should receive input and
yield `ExtensionContext` like tools/requests/actions.

**Principles**

- `redesign-from-first-principles`: apply the single authoring model
  consistently.
- `make-impossible-states-unrepresentable`: remove read-only ctx variants as a
  separate shape.

**Changes**

| File                                                                                             | Change                                                             | Lines |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ----- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts`                       | Change reaction handler types to params-only Effect handlers.      | ~211  |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts` | Provide `ExtensionContext`/narrow services through Effect context. | ~144  |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-host-context.ts`          | Delete read-only host context if no longer needed.                 | ~207  |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto/index.ts`                       | Migrate worked reaction example.                                   | ~256  |
| `/Users/cvr/Developer/personal/gent/docs/extensions.md`                                          | Document event-input-only reactions and `yield* ExtensionContext`. | ~215  |

**Verification**

- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/extensions/extension-reactions.test.ts packages/core/tests/extensions/runtime-reactions.test.ts packages/core/tests/extensions/extension-surface-locks.test.ts`
- `bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/auto/auto.test.ts tests/auto/auto-rpc.test.ts tests/auto/auto-journal-decode.test.ts`
- `bun run typecheck`
- `bun run lint`
- `bun run gate`

## Commit 5: refactor(extensions): make setup facts context-provided

**Justification**: Setup bucket factories still preserve `({ ctx }) => ...`.
Setup should be Effect-shaped too, using a setup facade from context instead of
a parameter.

**Principles**

- `small-interface-deep-implementation`: one small authoring shape beats dual
  setup/runtime APIs.
- `subtract-before-you-add`: remove setup-ctx overloads and migrate callers.

**Changes**

| File                                                                                | Change                                                               | Lines |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`            | Replace `FieldSpec` ctx callback with Effect-context setup services. | ~233  |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts` | Add setup facts to `ExtensionContext` or a focused setup service.    | ~210  |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/skills/index.ts`        | Migrate setup caller.                                                | ~20   |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/memory/index.ts`        | Migrate setup caller.                                                | ~41   |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/librarian/index.ts`     | Migrate setup caller.                                                | ~33   |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto/index.ts`          | Migrate setup caller.                                                | ~265  |
| `/Users/cvr/Developer/personal/gent/docs/extensions.md`                             | Update authoring docs.                                               | ~260  |

**Verification**

- Focused define-extension API tests.
- Shipped extension tests.
- `bun run gate`

## Commit 6: refactor(extensions): remove privileged builtin agent registry

**Justification**: Builtins are only the starting extension set. A parallel
agent registry in `packages/extensions` lets app code bypass user/project
extension resolution and creates drift.

**Principles**

- `one-source-of-truth`: the extension registry owns available agents.
- `boundary-discipline`: TUI should consume transport/profile projections, not
  import builtin registries.

**Changes**

| File                                                                                  | Change                                                                           | Lines |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----- |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/all-agents.ts`            | Delete or inline into real extension contributions.                              | ~1    |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/index.ts`                 | Remove privileged all-agent exports.                                             | ~103  |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx`                  | Stop importing builtin agent registry; read resolved agents from client/profile. | ~15   |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts` | Ensure registry projection is sufficient for TUI needs.                          | ~545  |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`   | Adjust agent projection if needed.                                               | ~312  |

**Verification**

- Focused TUI client tests.
- Focused extension registry tests.
- `bun run smoke`
- `bun run gate`

## Commit 7: test(tooling): enforce platform authority guardrails

**Justification**: Existing platform guardrails miss core/extensions host facts,
so the rule does not enforce the architecture it documents.

**Principles**

- `trust-but-verify-with-guardrails`: make the architecture executable.
- `use-the-platform`: host process facts enter through platform services.

**Changes**

| File                                                                                            | Change                                                                     | Lines |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----- |
| `/Users/cvr/Developer/personal/gent/packages/tooling/src/platform-duplication-guards.ts`        | Extend host-fact violations to protected packages.                         | ~93   |
| `/Users/cvr/Developer/personal/gent/packages/tooling/tests/platform-duplication-guards.test.ts` | Add regression for `packages/extensions/src/bad.ts`.                       | ~546  |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/log-paths.ts`                     | Move any remaining ambient process/fs use behind platform or app boundary. | ~14   |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/utils/format-tool.ts`                          | Use existing runtime/env facade or narrow app-edge exception.              | ~1    |

**Verification**

- Focused tooling guard tests.
- `bun run gate`

## Commit 8: refactor(files): collapse dead command/test boundary files

**Justification**: File splits must earn their existence. Low-risk migration
era boundaries should collapse once their production owner is clear.

**Principles**

- `subtract-before-you-add`: delete files whose only purpose was a migration
  bridge.
- `cohesion-over-file-count`: larger cohesive files are preferable to
  unearned tiny wrappers.

**Changes**

| File                                                                                             | Change                                                                                 | Lines |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ----- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.commands.ts`      | Move surviving `AgentLoopError`/ids to actor-owned files or prove file earns boundary. | ~1    |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop-commands.test.ts`     | Move behavioral coverage to actor/runtime tests or delete if redundant.                | ~1    |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/mcp-codemode-boundary.ts` | Move test-only run boundary into tests or prove production boundary.                   | ~1    |
| `/Users/cvr/Developer/personal/gent/packages/extensions/tests/acp-agents/acp-agents.test.ts`     | Update imports if boundary moves.                                                      | ~20   |

**Verification**

- Focused runtime agent-loop tests.
- Focused ACP agent tests.
- `bun run gate`

## Commit 9: docs(architecture): document single extension authority model

**Justification**: API changes must be reflected in architecture and extension
docs so future work does not recreate ctx/read-write/private escape hatches.

**Principles**

- `make-the-right-thing-easy`: docs should teach the one supported path.
- `boundary-discipline`: document public/internal split precisely.

**Changes**

| File                                                    | Change                                                       | Lines |
| ------------------------------------------------------- | ------------------------------------------------------------ | ----- |
| `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`    | Update extension/platform/registry sections.                 | ~1    |
| `/Users/cvr/Developer/personal/gent/docs/extensions.md` | Rewrite authoring examples around `yield* ExtensionContext`. | ~1    |
| `/Users/cvr/Developer/personal/gent/AGENTS.md`          | Update gotchas if public API/testing instructions change.    | ~1    |

**Verification**

- `bun run gate`

## Final Batch: Independent Recursive Audit

1. How can we simplify and minimize our codebase while maintaining features? how can we reduce code as much as possible? are we using effect properly? are we redeclaring types, schemas, features that effect natively provides via effect/unstable/ai or STM with txQueue etc?
2. are we following the actor model properly?
3. are we using bun/node platform code directly and not creating service layers for maximum portability and testability? GentPlatform etc?
4. is our extension system as minimal yet expressive as can be? compared to other harnesses that i mentioned - expressive enough to implement our current extensions, but more minimal? rearchitetcing completely is acceptable. this codebase is experimental, complete rerwites are fine of our schemas, types, assumptions - correctness, minimalism, is the goal within the effect ecosystem.
5. we own effect-machine, effect-encore, effect-wide-event - can we improve these upstream so that DX is better? are there other libraries we can make to abstract certain concepts that better align with our north star (actor model).
6. do files merit their existence? prefer bigger cohesive files when a split does not encode a real boundary, public entrypoint, platform boundary, independently testable domain, generated fixture, or meaningful multi-import reuse.
7. does the extension authoring experience follow this spirit: it should be simple to author extensions by creating facades over private things through `yield* ExtensionContext`; no ctx parameters, no privileged builtin API, and no capability/read/write ceremony when access can be expressed in code by accessing what is needed from ctx.

Close Wave 31 only after this independent audit reports no P0/P1. If it finds
P1s, synthesize the next wave and continue.
