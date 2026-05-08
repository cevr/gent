# Planify: Wave 22 — Single Platform Boundary And One Runtime Composition Root

## Thesis

The recursive Wave 21 audit at `797030b8` closed the local queue and extension
authority bugs, but Lane D found two architecture P1s that are too structural
to hide inside a bugfix commit. Gent still has more than one owner for host
platform access, and the ephemeral agent runtime still behaves like a second
composition root. Wave 22 exists to subtract those duplicate ownership paths.

Wave 22 is complete only when a fresh five-lane recursive audit reports no
P0/P1. Scope is not a constraint.

## Principles Applied

- `/Users/cvr/.brain/principles/boundary-discipline.md`
- `/Users/cvr/.brain/principles/use-the-platform.md`
- `/Users/cvr/.brain/principles/small-interface-deep-implementation.md`
- `/Users/cvr/.brain/principles/subtract-before-you-add.md`
- `/Users/cvr/.brain/principles/redesign-from-first-principles.md`
- `/Users/cvr/.brain/principles/prove-it-works.md`

## P1 Findings To Close

### P1 — Platform Boundary Leaks

Gent documents `GentPlatform` as the owner for Bun/OS/process access, but
shipped extensions define their own platform adapters over ambient host APIs.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/gent-platform.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/gent-platform.ts:64`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/gent-platform-bun.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/gent-platform-bun.ts:73`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/platform-adapter.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/platform-adapter.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/platform-adapter.ts:1`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:208`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/server/adapter.ts:4`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/server/adapter.bun.ts:5`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/server/adapter.node.ts:1`

Fix direction:

- Promote shared host facts/actions into `GentPlatform` or one deliberately
  small host-capability service.
- Delete extension-local platform adapters unless the behavior is truly
  extension-specific.
- Keep Bun/Node imports in implementation modules owned by the platform layer.
- Strengthen the guard so new active-source ambient `Bun`, `process`, `os`, and
  `node:*` access is reported by boundary class.

### P1 — Ephemeral Runtime Composition Is A Second Root

The production ephemeral path manually extracts parent services, rebuilds
extension layers, and duplicates runner branching. Runtime composition should
have one owning layer factory used by server, profile, tests, and ephemeral
agent runs.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/profile.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/profile.ts:297`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-runner.ts:171`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-runner.ts:596`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-runner.ts:975`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-runner.ts:1184`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts:98`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts:287`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/effect/app-runtime.ts:57`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/effect/bootstrap-runtime.ts:16`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/test/test-harness.ts:320`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/test/test-harness.ts:364`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/in-process-layer.ts:61`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/rpc-harness.ts:58`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/language-model.ts:298`

Fix direction:

- Extract one runtime layer factory with explicit override families.
- Make server/profile/ephemeral/test harnesses call that factory instead of
  reconstructing service subsets manually.
- Keep `buildEphemeralRuntime` as a thin policy caller or delete it.
- Add acceptance tests that compare service availability across server and
  ephemeral runtime paths.

## P2/P3 Follow-Ups

- Extension client boundary is half unified. Decide whether client extensions
  are fully separate or whether `defineExtension({ client })` is the shared
  identity source.
- Docs still describe old extension concepts and private runtime services as
  public. Update `docs/extensions.md`, `ARCHITECTURE.md`, and stale plan text.
- Platform guard naming overpromises. Rename or broaden it so the guard name
  matches what it checks.
- `ModelResolver.Live` should let Effect AI own model identity/lifetime rather
  than extracting a bare `LanguageModel` service from a scoped layer.

## Batches

### W22.1 — Platform Inventory And Host Boundary

Status: implemented, awaiting full wave gate.

Work:

- Inventory active ambient host API usage in `packages/core`, `packages/extensions`,
  `apps/tui`, and `apps/server`.
- Define the small host boundary by reading existing callers first.
- Move shared host facts/actions into the owning platform layer.

Implementation notes:

- `GentPlatform` remains core-internal. Extension-visible host access now flows
  through `ExtensionSetupContext.host`, built from `GentPlatform` by the core
  loader.
- `packages/extensions/src/anthropic`, `packages/extensions/src/acp-agents`,
  and `packages/extensions/src/executor` no longer import
  `@gent/core/runtime/gent-platform` or ambient Bun/Node platform modules.
- The platform duplication lint guard passes against active extension source.

Validation:

- Focused tests for every moved adapter.
- `bun run typecheck`
- `bun run lint`

### W22.2 — Delete Extension Platform Adapters

Status: partially implemented. The ambient host reads are deleted from adapter
implementations; tiny extension-specific projection adapters remain as local
shape translators over `ExtensionSetupContext.host`.

Work:

- Migrate `anthropic`, `acp-agents`, and `executor` adapter call sites.
- Delete adapters that only wrap shared host facts/actions.
- Keep true extension-specific probes local but behind narrow interfaces.

Validation:

- Relevant extension test files.
- `cd packages/extensions && bun run test`
- `bun run gate`

### W22.3 — One Runtime Layer Factory

Work:

- Extract the single composition factory.
- Rewire server dependencies, profile build, ephemeral runner, and test harnesses
  to use it.
- Remove duplicate parent-service extraction where the factory can own it.

Validation:

- Runtime/agent-runner focused tests.
- RPC acceptance harness tests.
- `bun run gate`

### W22.4 — Docs And Guardrails

Work:

- Update `docs/extensions.md` and `ARCHITECTURE.md`.
- Broaden or rename platform guardrails.
- Add tests for the guard itself.

Validation:

- `bun run lint`
- `bun run test`
- `bun run test:e2e`

### W22.5 — Recursive Verification

Work:

- Launch five independent audit lanes against the final Wave 22 HEAD:
  actor/durable queue, extension authority, Effect usage, architecture
  minimization, tests/suppressions.
- Use `~/.brain/principles`,
  `/Users/cvr/.cache/repo/effect-ts/effect-smol`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono`,
  `/Users/cvr/.cache/repo/anomalyco/opencode`,
  `/Users/cvr/Developer/personal/effect-machine`,
  `/Users/cvr/Developer/personal/effect-encore`, and
  `/Users/cvr/Developer/personal/effect-wide-event`.

Validation:

- No P0/P1 findings.
- `bun run gate`
- `bun run test:e2e`
- `bun run smoke`
