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

Status: implemented, awaiting recursive verification.

Work:

- Extract the single composition factory.
- Rewire server dependencies, profile build, ephemeral runner, and test harnesses
  to use it.
- Remove duplicate parent-service extraction where the factory can own it.

Implementation notes:

- Server/per-cwd profile paths and ephemeral child paths already shared
  `buildExtensionLayers`; the remaining duplication was lifecycle ownership.
- Ephemeral child runtimes now call `buildExtensionLayers(resolved, {
lifecycle: "skip" })`: child resource services still rebuild against child
  storage, but process resource `start`/`stop` hooks remain owned by profile
  resolution.
- Added a regression proving an ephemeral child can use a resource-backed tool
  without rerunning the resource `start` hook.

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

Status: blocked by recursive audit P1s at `d1953406`; remediation in progress.

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

Recursive findings to close:

- P1: shipped extensions still had a duplicated process runner and direct
  process helper ownership under `packages/extensions/src/run-process.ts`.
  Status: implemented in sub-batch W22.6 by moving process execution to
  `ExtensionSetupContext.host` / `ToolCapabilityContext.host` as
  `host.runProcess(...)`, deleting the extension runner, and preserving
  host-owned implementation in core.
- P1: `@gent/core` package exports still expose internal runtime/storage/server
  subpaths as package-public API, even though the extension contract says
  authors use `@gent/core/extensions/api`.
- P1: read-intent RPC/tool execution still provides broad service context and
  relies on voluntary write checks by write-capable services.
- P1: retried `message.send` only deduplicates `requestId` in process memory,
  not across crash/restart.
  Status: implemented in sub-batch W22.7 by deriving the runtime command/message
  id from `requestId` when no explicit command id is supplied.
- P1: interaction approvals are acknowledged in memory before the human
  decision itself is durable.
  Status: implemented in sub-batch W22.8 by storing `decision_json` on pending
  interaction rows before actor wake and replaying stored decisions during
  startup recovery.
- P1: `ModelResolver` builds Effect AI model layers in a scope, extracts
  `LanguageModel.Service`, and returns the raw service outside the layer
  lifetime.
  Status: implemented in sub-batch W22.9 by resolving live provider models in
  the caller/stream scope instead of a closed local scope.
- P1: several extension services defect operational storage/file failures with
  `Effect.orDie` instead of returning typed service/tool errors.

### W22.6 — Host Process Primitive

Status: committed and pushed in `f732ab10`.

Work:

- Add `ExtensionHostPlatform.runProcess` as the public host-owned process action.
- Route extension setup and tool execution contexts through the same host view.
- Migrate shipped workflow, Anthropic, and executor call sites.
- Delete `packages/extensions/src/run-process.ts`.

Validation:

- `bun run typecheck`
- `bun run lint`
- Focused extension/core boundary tests

### W22.7 — Durable Message Request Idempotency

Status: committed and pushed in `91648ac0`.

Work:

- Convert `sendUserMessage.requestId` into a deterministic actor command id when
  callers do not supply an explicit `commandId`.
- Let the existing durable message id and actor operation primary key collapse
  retried sends across runtime/server cache boundaries.
- Guard in-flight duplicate sends by durable user message id so concurrent
  retries wait for the owner turn instead of calling the model twice.
- Preserve explicit `commandId` as the stronger caller-owned idempotency key.

Validation:

- `cd packages/core && bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/runtime/session-runtime.test.ts`

### W22.8 — Durable Interaction Decisions

Status: committed and pushed in `5738e82e`.

Work:

- Add a storage-backed `decision_json` field for pending interaction requests.
- Persist the human decision before waking the actor.
- Resolve the interaction row only after the tool consumes the durable decision.
- During startup recovery, re-present unanswered prompts and replay stored
  decisions into the waiting actor without showing a duplicate prompt.

Validation:

- `cd packages/core && bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/server/interaction-commands.test.ts tests/domain/interaction-request.test.ts tests/storage/sqlite-session-storage.test.ts`
- `bun run typecheck`
- `bun run lint`

### W22.9 — Scoped Model Resolution

Status: committed and pushed in `df79e0ef`.

Work:

- Make live `ModelResolver.resolve(...)` require the caller scope and build
  provider model layers into that scope with `Layer.buildWithScope`.
- Resolve model streams inside `Stream.unwrap(...)` so the provider layer lives
  for stream consumption, not just construction.
- Wrap non-stream branch summary model usage in `Effect.scoped`.
- Move provider-resolution tests to scoped tests so the lifetime requirement is
  visible in the type surface.

Validation:

- `cd packages/core && bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/providers/provider-resolution.test.ts tests/runtime/session-runtime.test.ts tests/server/session-command-persistence.test.ts`
- `bun run typecheck`
- `bun run lint`

### W22.10 — Read-Intent Runtime Membrane

Status: committed and pushed in `b1d6e2c3`.

Work:

- Apply `ReadOnlyBrand` as a runtime marker through `withReadOnly(...)`.
- Derive a filtered read-only capability context from profile extension layers.
- Execute read-intent RPCs and read-intent tools in that filtered context using
  `Effect.updateContext(...)`, so write-capable services are absent rather than
  merely denied by voluntary `requireCapabilityWrite(...)` calls.
- Keep read-only service values available to read handlers and tool bodies.
- Move fs read tools behind a branded `FsRead` extension resource so read tools
  no longer yield raw `FileSystem` / `Path` / `FileIndex` host services.

Validation:

- `cd packages/core && bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/runtime/tool-runner.test.ts tests/server/extension-commands-rpc.test.ts tests/extensions/extension-surface-locks.test.ts`
- `bun run typecheck`
- `bun run lint`
- `bun run fmt:check`

### W22.11 — Extension-Owned Need Labels

Status: implemented, awaiting subcommit.

Work:

- Remove the core `LOCK_REGISTRY` list of product/extension resource names.
- Keep `ToolNeeds.read(...)` / `ToolNeeds.write(...)` as the authoring helper
  for read/write conflict labels, but make labels opaque strings instead of
  a core-maintained union.
- Remove `LOCK_REGISTRY` from `@gent/core/extensions/api` and add a compile
  lock so the public extension surface cannot depend on a central registry.

Validation:

- `cd packages/core && bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/extensions/extension-surface-locks.test.ts tests/runtime/resource-manager.test.ts tests/domain/capability-ref.test.ts`
- `bun run typecheck`
- `bun run lint`
- `bun run fmt:check`
