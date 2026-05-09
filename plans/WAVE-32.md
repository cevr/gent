# Planify: Wave 32 - Extension Authoring Contract Closure

## Context

Wave 31 landed the large extension-authority cleanup, but its independent final
audit found current P1s. The actor/idempotency lanes are clean; the remaining
blocker is authoring-contract drift: one reaction still receives ctx, some
shipped extensions bypass `defineExtension`, platform guardrails miss a Bun
import form, and the public barrel still exposes host-ish services directly.

Wave 32 closes those findings before the simplification audit may pass.

## Scope

**In**

- Remove the remaining public `turnProjection(ctx)` reaction shape.
- Make shipped extensions use the same `defineExtension` authoring path as
  user/project extensions where possible.
- Tighten platform guardrails for direct Bun imports in core/extensions.
- Remove read/write intent ceremony from public tool/action metadata where Effect
  AI annotations already express provider-facing behavior.
- Remove or internalize public host-service exports from
  `@gent/core/extensions/api`, replacing them with `ExtensionContext` facades or
  extension-owned resources.
- Update docs and surface-lock tests with the final API.
- Rerun the exact independent audit lanes from Wave 31.

**Out**

- Rewriting the full tool/capability storage model unless needed to remove
  P1 authoring ceremony.
- Solving all `TaggedEnumClass` debt; that remains P2 unless it becomes part of
  a touched P1 surface.
- Removing legitimate app-boundary Node/Bun usage outside core/extensions.

## Constraints

- Correctness over pragmatism.
- No backwards compatibility for ctx/read-write/private authoring shapes.
- Commit boundaries stay reviewable and gated.
- Mechanical extension migrations may be delegated after the first worked
  example.
- Wave 32 cannot close until a fresh independent audit reports no P0/P1.

## Applicable Skills

- `planify`
- `effect-v4`
- `architecture`
- `test`

## Gate Command

- Standard: `bun run gate`
- Platform guard commits: `bun packages/tooling/src/check-guardrails.ts` plus
  focused tooling tests and `bun run gate`
- Extension API commits: focused extension surface/reaction tests plus
  `bun run gate`

## Audit Receipts

Fresh final audit status for Wave 31: no P0; P1s remain.

Primary P1 evidence:

- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:255`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:282`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts:210`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/memory/index.ts:43`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/index.ts:222`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/index.ts:229`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/index.ts:22`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/index.ts:23`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/librarian/repo-explorer.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/librarian/repo-explorer.ts:49`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:42`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:148`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability.ts:78`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:213`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/extension-surface-locks.test.ts:500`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/edit.ts:147`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/write.ts:40`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/read-service.ts:17`

Independent audit no-finding evidence for actor/idempotency:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:136`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:239`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:420`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/server/session-idempotency.test.ts:463`

Comparison evidence:

- `/Users/cvr/Developer/personal/effect-smol/packages/effect/src/unstable/ai/Tool.ts:1637`
- `/Users/cvr/Developer/personal/effect-smol/packages/effect/src/Schema.ts:4506`
- `/Users/cvr/Developer/personal/effect-smol/packages/effect/src/Schema.ts:4704`

## Commit 1: refactor(extensions): make turn projections context-provided

**Status**: Completed in current batch.

**Justification**: `turnProjection(ctx)` is the last public reaction pocket that
threads host context by parameter. Extension reactions should be ordinary Effect
programs that yield `ExtensionContext`.

**Principles**

- `redesign-from-first-principles`: one authoring shape everywhere.
- `effect-v4/no-context-params`: yield context rather than passing it.

**Changes**

| File                                                                                                   | Change                                                                         | Lines |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ----- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts`                             | Change `turnProjection` to a nullary Effect handler; keep turn facts internal. | ~255  |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts`                    | Add optional turn facts to `ExtensionContext`.                                 | ~190  |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts`       | Provide `ExtensionContext` to projection reactions instead of passing ctx.     | ~210  |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-helpers.ts`                   | Pass host + projection facts into compiled reaction runtime.                   | ~468  |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/memory/index.ts`                           | Migrate memory projection to `() => projectMemoryVaultTurn()`.                 | ~43   |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/memory/projection.ts`                      | Read `cwd` from `yield* ExtensionContext`.                                     | ~85   |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/extension-turn-projections.test.ts` | Update compiled projection tests to call the runtime-owned reaction context.   | ~1    |
| `/Users/cvr/Developer/personal/gent/packages/extensions/tests/memory/projection.test.ts`               | Provide `ExtensionContext` explicitly in focused memory projection tests.      | ~1    |
| `/Users/cvr/Developer/personal/gent/packages/extensions/tests/skills/skills-rpc.test.ts`               | Update skill projection coverage to the nullary handler shape.                 | ~1    |

**Verification**

- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/extensions/extension-turn-projections.test.ts packages/core/tests/extensions/extension-reactions.test.ts packages/extensions/tests/memory/projection.test.ts`
- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/extensions/extension-turn-projections.test.ts packages/core/tests/extensions/extension-reactions.test.ts packages/extensions/tests/memory/projection.test.ts packages/extensions/tests/skills/skills-rpc.test.ts`
- `bun run lint`
- `bun run typecheck`
- `bun run gate`

## Commit 2: refactor(extensions): make shipped setup use defineExtension

**Justification**: Builtins are only the starting extension set. They should not
use raw `GentExtension`/`setup(ctx)` authoring paths unavailable to user/project
extensions.

**Principles**

- `small-interface-deep-implementation`: one public factory absorbs setup shape.
- `boundary-discipline`: host facts stay in `ExtensionSetupContext`.

**Changes**

| File                                                                                         | Change                                                                | Lines |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----- |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/index.ts`             | Convert raw setup to `defineExtension` with setup facts from context. | ~222  |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/index.ts`               | Convert raw setup to `defineExtension`.                               | ~22   |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/define-extension.test.ts` | Lock no shipped raw setup escape hatch if feasible.                   | ~1    |

**Verification**

- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/extensions/tests/acp-agents/acp-agents.test.ts packages/extensions/tests/executor/executor-rpc.test.ts packages/core/tests/extensions/define-extension.test.ts`
- `bun run typecheck`
- `bun run gate`

## Commit 3: test(tooling): ban direct bun imports in core extensions

**Justification**: The platform guard caught global `Bun` member usage but missed
`import { $ } from "bun"`, allowing shipped extensions to shell out outside host
facades.

**Principles**

- `use-the-platform`: platform-owned process execution should use the host
  facade or Effect platform service.
- `trust-but-verify-with-guardrails`: make the architecture executable.

**Changes**

| File                                                                                            | Change                                                          | Lines |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----- |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/librarian/repo-explorer.ts`         | Replace Bun shell token lookup with `ExtensionContext.Process`. | ~1    |
| `/Users/cvr/Developer/personal/gent/packages/tooling/src/platform-duplication-guards.ts`        | Ban `from "bun"` in protected core/extensions files.            | ~145  |
| `/Users/cvr/Developer/personal/gent/packages/tooling/tests/platform-duplication-guards.test.ts` | Add regression for `import { $ } from "bun"`.                   | ~588  |

**Verification**

- `bun packages/tooling/src/check-guardrails.ts`
- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/tooling/tests/platform-duplication-guards.test.ts packages/extensions/tests/librarian/*.test.ts`
- `bun run gate`

## Commit 4: refactor(extensions): remove read-write tool intent ceremony

**Justification**: Provider-facing read/destructive behavior belongs in Effect AI
annotations; host authority belongs in `ExtensionContext` and services. Gent
should not expose a parallel read/write authoring axis.

**Principles**

- `subtract-before-you-add`: remove flags before adding abstractions.
- `use-the-platform`: Effect AI already models tool annotations.

**Changes**

| File                                                                               | Change                                                           | Lines |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts`   | Replace `intent` with provider annotations such as `readonly`.   | ~42   |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/action.ts` | Remove action intent storage if not required by transport.       | ~37   |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability.ts`        | Remove tool/action intent from the generic capability schema.    | ~78   |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/*.ts`         | Migrate read-only metadata to the new provider annotation shape. | ~1    |
| `/Users/cvr/Developer/personal/gent/docs/extensions.md`                            | Remove public `intent` guidance.                                 | ~180  |

**Verification**

- focused capability/registry/tool-runner tests
- `bun run typecheck`
- `bun run gate`

## Commit 5: refactor(extensions): collapse public host service exports

**Justification**: Public extension authors should not import host service Tags
directly from the barrel. Host-owned authority should sit behind
`ExtensionContext`; extension-owned authority should live in resource services.

**Principles**

- `small-interface-deep-implementation`: hide host service plumbing behind a
  small facade.
- `boundary-discipline`: only public facades cross extension boundaries.

**Changes**

| File                                                                                                | Change                                                                                                            | Lines |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`                            | Remove `FileIndex`, `FileLockService`, `ExtensionStatePublisher`, `OutputBuffer` exports or replace with facades. | ~213  |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts`                 | Add any minimal `ExtensionContext` facades needed by shipped extensions.                                          | ~190  |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/*.ts`                          | Migrate direct host imports to `ExtensionContext` facades or internal imports.                                    | ~1    |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/extension-surface-locks.test.ts` | Lock the smaller barrel.                                                                                          | ~500  |

**Verification**

- focused extension surface/fs-tools tests
- `bun run typecheck`
- `bun run gate`

## Commit 6: docs(architecture): close extension authoring contract

**Justification**: The docs must describe the actual final API, not the intended
API after code catches up.

**Principles**

- `make-the-right-thing-easy`: examples should teach the only supported path.
- `boundary-discipline`: docs should name the public/internal split.

**Changes**

| File                                                    | Change                                                           | Lines |
| ------------------------------------------------------- | ---------------------------------------------------------------- | ----- |
| `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`    | Update projection/setup/platform/public barrel sections.         | ~360  |
| `/Users/cvr/Developer/personal/gent/docs/extensions.md` | Remove stale intent/service-export guidance and update examples. | ~80   |
| `/Users/cvr/Developer/personal/gent/AGENTS.md`          | Add guardrail notes if API/testing instructions change.          | ~48   |
| `/Users/cvr/Developer/personal/gent/plans/WAVE-32.md`   | Mark implementation receipts complete.                           | ~1    |

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

Close Wave 32 only after this independent audit reports no P0/P1. If it finds
P1s, synthesize the next wave and continue.
