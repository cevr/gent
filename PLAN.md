# Planify: Current-State First-Principles Rewrite Plan

## Intent

Replace the stale post-simplification plan with one grounded in the codebase as it exists now.

Goal: maximal simplicity, expressiveness, composability, and actor-model clarity. No feature reduction. Breaking changes are acceptable when paired with migrations. Correctness over pragmatism.

Current worktree note:

- There is an unfinished AI transcript refactor already in the worktree. Treat it as input, not as assumed architecture truth.

## Scope

- **In**: runtime ownership, extension API boundaries, Effect AI integration, storage model, domain modeling, suppression debt, SDK/TUI adapter debt, test taxonomy.
- **Out**: feature cuts, cosmetic renames without structural payoff, PR workflow.

## Constraints

- Straight to `main`. No PR.
- No compatibility bridges kept around just to avoid migrations.
- Every migration must preserve the feature set while allowing wire/storage/API breaks where they simplify the architecture.
- Each batch is commit-gated and review-gated before continuing.

## Applicable Skills

- `architecture`
- `effect-v4`
- `code-style`
- `bun`
- `test`
- `react`
- `repo`

## Gate Command

- `bun run gate`

## Review Protocol

Every batch:

1. Implement the batch only.
2. Run `bun run gate`.
3. If the batch touches transport, runtime supervision, stream handoff, storage, or TUI route flow, also run `bun run test:e2e`.
4. Commit with the listed conventional commit message, or a narrower sub-commit inside the batch if blast radius demands it.
5. Spawn exactly one review subagent against the commit diff and the matching batch section in this plan.
6. Fix all findings before continuing.

Extra rules:

- If a batch touches 20+ files across multiple subsystems, split into reviewable sub-commits inside the batch.
- `migrate-callers-then-delete-legacy-apis` still applies. Temporary bridges are allowed only when they are part of the same batch’s migration and deleted before the batch closes.
- Suppressions are allowed only at explicit membranes with a reason.

## North Stars

- `redesign-from-first-principles`: redesign around the requirement as if we knew it on day one.
- `subtract-before-you-add`: delete duplicate local models before adding helpers.
- `small-interface-deep-implementation`: narrower public seams, deeper owned modules.
- `derive-dont-sync`: one source of truth for runtime/profile/transcript state.
- `make-impossible-states-unrepresentable`: use `_tag`, tagged unions, and constructors instead of string bags and option clusters.
- `boundary-discipline`: keep unsafe casts and suppressions only at real membranes.
- `serialize-shared-state-mutations`: one owner per mutable state island.
- `use-the-platform`: prefer `effect-smol` AI, SQL, and persistence primitives over Gent-owned shadows.
- `test-through-public-interfaces`: behavior via public seams first, source-policy tests quarantined as policy tests.
- actor model: isolated owners, no ambient mutable handles, let it crash inside supervised boundaries.

## Audit Inputs

Brain principles:

- `/Users/cvr/.brain/principles/redesign-from-first-principles.md`
- `/Users/cvr/.brain/principles/subtract-before-you-add.md`
- `/Users/cvr/.brain/principles/derive-dont-sync.md`
- `/Users/cvr/.brain/principles/make-impossible-states-unrepresentable.md`
- `/Users/cvr/.brain/principles/boundary-discipline.md`
- `/Users/cvr/.brain/principles/test-through-public-interfaces.md`
- `/Users/cvr/.brain/principles/correctness-over-pragmatism.md`
- `/Users/cvr/.brain/principles/serialize-shared-state-mutations.md`
- `/Users/cvr/.brain/principles/small-interface-deep-implementation.md`
- `/Users/cvr/.brain/principles/use-the-platform.md`
- `/Users/cvr/.brain/principles/fix-root-causes.md`

Subagent audits:

- Runtime / actor ownership: Aquinas
- Effect v4 / AI / storage: Feynman
- Suppressions / unsafe casts: Peirce
- `_tag` / constructors / enums: Aristotle
- Tests / taxonomy: Singer

Core local receipts:

- `ARCHITECTURE.md`
- `package.json`
- `packages/core/src/runtime/session-runtime.ts`
- `packages/core/src/runtime/agent/agent-loop.ts`
- `packages/core/src/runtime/session-runtime-context.ts`
- `packages/core/src/runtime/profile.ts`
- `packages/core/src/runtime/session-profile.ts`
- `packages/core/src/runtime/extensions/resource-host/machine-engine.ts`
- `packages/core/src/extensions/api.ts`
- `packages/core/src/domain/extension.ts`
- `packages/core/src/domain/message.ts`
- `packages/core/src/providers/ai-transcript.ts`
- `packages/core/src/providers/provider.ts`
- `packages/core/src/storage/sqlite-storage.ts`
- `packages/core/src/storage/search-storage.ts`
- `packages/core/src/domain/schema-tagged-enum-class.ts`
- `packages/tooling/tests/architecture-policy.test.ts`
- `packages/tooling/tests/suppression-policy.test.ts`
- `apps/tui/tests/*`
- `packages/core/tests/*`

Upstream Effect receipts:

- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Prompt.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Response.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Toolkit.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/LanguageModel.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Chat.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/sql/SqlClient.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/persistence/Persistence.ts`

## Initial Audit Receipts

These receipts are historical inputs used to write the batches below. They are
kept to show the trail, not as a description of the final codebase.

| Finding                                                                                                                          | Receipts                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MachineEngine` still mixes lifecycle, mailbox ownership, and protocol execution                                                 | `packages/core/src/runtime/extensions/resource-host/machine-engine.ts:50-53,583-624,704-755,788-815`                                                                                                                                                                                                                                                |
| Public extension surface is too broad and mixed with runtime internals                                                           | `packages/core/src/extensions/api.ts:65-268,272-504`, `packages/core/src/domain/extension.ts:257-382`                                                                                                                                                                                                                                               |
| Runtime/profile resolution still leaks as optional bags and duplicated projections                                               | `packages/core/src/runtime/session-runtime-context.ts:18-34,72-177`, `packages/core/src/runtime/profile.ts:92-99,335-378`, `packages/core/src/runtime/session-profile.ts:52-64,117-200`, `packages/core/src/server/dependencies.ts:106-140,303-315`                                                                                                 |
| `AgentLoop` still exposes a broad quasi-public control plane                                                                     | `packages/core/src/runtime/agent/agent-loop.ts:1607-1687`, `packages/core/src/runtime/session-runtime.ts:176-193,281-511`, `ARCHITECTURE.md:138-157`                                                                                                                                                                                                |
| AI transcript boundary is still largely Gent-owned instead of Prompt/Response-native                                             | `packages/core/src/domain/message.ts:13-83`, `packages/core/src/providers/ai-transcript.ts:65-540`, upstream `Prompt.ts:1845-1883`, `Response.ts:1403-1609`                                                                                                                                                                                         |
| Multi-step writes are not structurally transactional                                                                             | `packages/core/src/storage/sqlite-storage.ts:623-646`, `packages/core/src/runtime/agent/agent-loop.ts:207,1019`, upstream `SqlClient.ts:182`                                                                                                                                                                                                        |
| Message storage is blob-first; shared chunk reuse is impossible                                                                  | `packages/core/src/storage/sqlite-storage.ts:321,447,623`, `packages/core/src/storage/search-storage.ts:73`                                                                                                                                                                                                                                         |
| Extension placement still uses `kind` where the concept is really `scope`                                                        | `packages/core/src/domain/extension.ts:29,90`, `packages/core/src/runtime/extensions/loader.ts:159`, `packages/core/src/runtime/extensions/activation.ts:37`, `apps/tui/src/extensions/discovery.ts:13`, `apps/tui/src/extensions/resolve.ts:23`                                                                                                    |
| Remaining owned enum bags are still stringly modeled                                                                             | `packages/core/src/domain/queue.ts:5`, `packages/core/src/domain/message.ts:79`, `packages/core/src/server/transport-contract.ts:194`, `apps/tui/src/hooks/use-session-feed.ts:61`, `packages/extensions/src/executor/sidecar.ts:67`, `packages/core/src/domain/resource.ts:122`                                                                    |
| Several suppressions are legitimate membranes, but TUI registries, schema builders, and SDK proxies are architectural type holes | `apps/tui/src/atom-solid/registry.ts:6-76,113-126`, `apps/tui/src/atom-solid/solid.ts:18-46`, `apps/tui/src/atom-solid/atom.ts:40,73`, `packages/core/src/domain/extension-protocol.ts:161-346`, `packages/core/src/domain/schema-tagged-enum-class.ts:149-411`, `packages/sdk/src/client.ts:239-245,297-404`, `packages/sdk/src/server.ts:251-282` |
| Test taxonomy is honest in core RPC acceptance paths, weak in TUI shape-lock tests and policy tests mixed with product behavior  | `apps/tui/tests/router.test.ts:152,179`, `apps/tui/tests/tui-boundary.test.ts:5`, `packages/core/tests/runtime/session-runtime.test.ts:73,156,215`, `packages/core/tests/runtime/agent-runner.test.ts:140,214`, `packages/tooling/tests/architecture-policy.test.ts:48`, `packages/tooling/tests/suppression-policy.test.ts:34`                     |

## Target Architecture

- `SessionRuntime` is the only public session engine.
- `AgentLoop` is an internal actor implementation, not a second runtime surface.
- `SessionEnvironment` is a resolved, required runtime record. No post-boundary option bags.
- Extension authoring API is separate from runtime/internal protocol APIs.
- `MachineEngine` is split into lifecycle manager, mailbox executor, and protocol executor.
- AI transcript modeling is canonical `Prompt` / `Response` / `Toolkit` / `LanguageModel`.
- Storage mutations are transactional by default.
- Message content is content-addressed and chunked; search stays a projection.
- Owned unions use `_tag`; extension placement uses `scope`; constructors prefer `.make` where it simplifies use.
- Suppressions exist only at explicit membranes.
- Tests are grouped by behavior and public seam; policy/source-scan tests are labeled as policy.

---

## Wave 1: Vocabulary And Runtime Boundaries

### Batch 1: `refactor(extensions): rename extension kind to scope`

**Justification**: The model is lying. This field is placement/scope, not “kind”.

**Principles**: `make-impossible-states-unrepresentable`, `small-interface-deep-implementation`, `fix-root-causes`

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/domain/extension.ts`
- `packages/core/src/runtime/extensions/loader.ts`
- `packages/core/src/runtime/extensions/activation.ts`
- `packages/core/src/server/transport-contract.ts`
- `apps/tui/src/extensions/discovery.ts`
- `apps/tui/src/extensions/resolve.ts`
- `packages/core/tests/extensions/*`
- `apps/tui/tests/extensions-resolve.test.ts`

**Sketch**:

- Rename owned extension placement fields from `kind` to `scope`.
- Migrate server DTOs, SDK/TUI consumers, and tests in the same batch.
- Keep external boundary `kind` fields only where they belong to foreign protocols.

**Migration**:

- Transport contract break included in this batch.
- Update all SDK/TUI call sites and extension fixtures before closing the batch.

**Gate**:

- `bun run gate`
- `bun run test:e2e`
- one review subagent against the commit diff and this batch

### Batch 2: `refactor(extensions): split authoring api from runtime internals`

**Justification**: The public extension surface is too broad. Authoring should not import runtime internals by accident.

**Principles**: `small-interface-deep-implementation`, `boundary-discipline`, `subtract-before-you-add`

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/extensions/api.ts`
- `packages/core/src/domain/extension.ts`
- `packages/core/src/runtime/extensions/*`
- `packages/extensions/src/*`
- `packages/core/tests/extensions/extension-surface-locks.test.ts`

**Sketch**:

- Create a narrow public authoring module: define extension/resource/capability constructors, read-only fences, authoring types.
- Move runtime actor protocol, machine refs, tool runner internals, and runtime-only context tags behind internal paths.
- Update builtin extensions to consume the narrow surface only.

**Migration**:

- Break internal imports aggressively.
- Add or update architecture policy tests to lock the new boundary.

**Gate**:

- `bun run gate`
- one review subagent against the commit diff and this batch

### Batch 3: `refactor(runtime): collapse session runtime context into session environment`

**Justification**: Optional bags after the boundary are synchronized ambiguity.

**Principles**: `derive-dont-sync`, `make-impossible-states-unrepresentable`, `fix-root-causes`

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/runtime/session-runtime-context.ts`
- `packages/core/src/runtime/profile.ts`
- `packages/core/src/runtime/session-profile.ts`
- `packages/core/src/server/dependencies.ts`
- `packages/core/tests/runtime/session-runtime-context.test.ts`
- `packages/core/tests/runtime/session-profile.test.ts`

**Sketch**:

- Replace option-heavy context shapes with a resolved `SessionEnvironment`.
- Make “not yet resolved” a discriminated state before the boundary, not inside the environment.
- Ensure server startup and per-cwd cache both build the same resolved environment helper.

**Migration**:

- Replace callers that probe optional fields with environment construction or explicit resolution branches.

**Gate**:

- `bun run gate`
- one review subagent against the commit diff and this batch

### Batch 4: `refactor(runtime): hide agent loop behind session runtime`

**Justification**: `AgentLoop` is an implementation detail wearing a service costume.

**Principles**: `small-interface-deep-implementation`, actor-model ownership, `boundary-discipline`

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/runtime/agent/agent-loop.ts`
- `packages/core/src/runtime/session-runtime.ts`
- `packages/core/src/runtime/agent/agent-runner.ts`
- `packages/core/tests/runtime/agent-loop.test.ts`
- `packages/core/tests/runtime/session-runtime.test.ts`
- `packages/core/tests/runtime/agent-runner.test.ts`

**Sketch**:

- Shrink `AgentLoopService` to the minimum internal surface.
- Move public orchestration calls through `SessionRuntime`.
- Delete or localize internal methods that exist only for tests or helper runners.

**Migration**:

- Rewrite tests to target either `SessionRuntime` public behavior or a deliberately internal agent-loop harness.

**Gate**:

- `bun run gate`
- `bun run test:e2e`
- one review subagent against the commit diff and this batch

### Batch 5: `refactor(extensions): split machine engine into lifecycle mailbox protocol`

**Justification**: Ambient mailbox state is a symptom of one module owning too much.

**Principles**: `serialize-shared-state-mutations`, actor-model ownership, `small-interface-deep-implementation`

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/runtime/extensions/resource-host/machine-engine.ts`
- `packages/core/src/runtime/extensions/resource-host/index.ts`
- `packages/core/src/runtime/extensions/resource-host/machine-protocol.ts`
- `packages/core/src/runtime/extensions/spawn-machine-ref.ts`
- `packages/core/tests/extensions/actor.test.ts`
- `packages/core/tests/extensions/concurrency.test.ts`
- `packages/core/tests/extensions/resource-host.test.ts`

**Sketch**:

- Split `MachineEngine` into lifecycle manager, mailbox executor, and protocol executor.
- Remove `CurrentMailboxSession` ambient reentrancy handling.
- Keep serialization inside mailbox-owned state and prove nested sends do not deadlock.

**Migration**:

- Internal only.
- Preserve actor lifecycle, error isolation, and current runtime semantics.

**Gate**:

- `bun run gate`
- `bun run test:e2e`
- one review subagent against the commit diff and this batch

---

## Wave 2: Effect-Native AI And Storage

### Batch 6: `refactor(ai): canonicalize transcript on prompt response toolkit`

**Justification**: Gent is still shadowing Effect AI primitives.

**Principles**: `use-the-platform`, `subtract-before-you-add`, `derive-dont-sync`

**Skills**: `architecture`, `effect-v4`, `repo`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/domain/message.ts`
- `packages/core/src/providers/ai-transcript.ts`
- `packages/core/src/providers/provider.ts`
- `packages/core/src/runtime/agent/agent-loop.ts`
- `packages/core/tests/providers/ai-transcript.test.ts`
- `packages/core/tests/runtime/agent-loop.test.ts`

**Sketch**:

- Make `Prompt` / `Response` the canonical transcript AST.
- Keep Gent-owned metadata only where the platform does not model it.
- Replace bespoke transcript normalization with a thin bridge for hidden-message filtering, storage projection, and UI projection.
- Lean fully into `Toolkit` / `LanguageModel` instead of parallel local tool abstractions at the provider boundary.

**Migration**:

- Break internal transcript helpers freely.
- Update persisted reconstruction and prompt assembly in the same batch.

**Gate**:

- `bun run gate`
- `bun run test:e2e`
- one review subagent against the commit diff and this batch

### Batch 7: `refactor(storage): make runtime writes transactional`

**Justification**: Multi-step writes without transactions are correctness debt.

**Principles**: `serialize-shared-state-mutations`, `correctness-over-pragmatism`, `fix-root-causes`

**Skills**: `effect-v4`, `architecture`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/storage/sqlite-storage.ts`
- `packages/core/src/runtime/agent/agent-loop.ts`
- `packages/core/src/runtime/event-store-live.ts`
- `packages/extensions/src/task-tools-storage.ts`
- `packages/core/tests/storage/sqlite-storage.test.ts`
- `packages/core/tests/runtime/agent-loop.test.ts`

**Sketch**:

- Wrap all multi-statement persistent mutations in `SqlClient.withTransaction`.
- Audit message persistence, session updates, event emission persistence, and extension-owned storage writes.
- Add failure-path tests that prove no partial writes survive.

**Migration**:

- No external API break.
- Structural persistence semantics change only.

**Gate**:

- `bun run gate`
- `bun run test:e2e`
- one review subagent against the commit diff and this batch

### Batch 8: `refactor(storage): introduce shared content chunks`

**Justification**: Blob-first message storage blocks reuse, dedupe, and AI-native content projection.

**Principles**: `derive-dont-sync`, `use-the-platform`, `subtract-before-you-add`

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/storage/sqlite-storage.ts`
- `packages/core/src/storage/search-storage.ts`
- `packages/core/src/domain/message.ts`
- `packages/core/src/providers/ai-transcript.ts`
- `packages/core/tests/storage/sqlite-storage.test.ts`
- `packages/core/tests/providers/ai-transcript.test.ts`

**Sketch**:

- Add chunk tables and message-to-chunk ordering refs.
- Backfill existing `messages.parts` rows into chunks.
- Keep FTS as a projection over reconstructed message text, not as source of truth.
- Delete the legacy row/blob path once reads are migrated.

**Migration**:

- Include schema migration and backfill in the batch.
- Preserve transcript reconstruction and search behavior end to end.

**Gate**:

- `bun run gate`
- `bun run test:e2e`
- one review subagent against the commit diff and this batch

### Batch 9: `refactor(provider): tighten provider typing and caches`

**Justification**: Provider layer `any` is unforced slop at a central boundary.

**Principles**: `boundary-discipline`, `fix-root-causes`, `correctness-over-pragmatism`

**Skills**: `effect-v4`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/providers/provider.ts`
- `packages/core/src/runtime/model-registry.ts`
- `packages/core/tests/providers/provider-resolution.test.ts`
- `packages/core/tests/runtime/model-registry.test.ts`

**Sketch**:

- Delete `_debugFailingProviderCache: any`.
- Fix helper signatures that force local unsafe casts.
- Lock the provider boundary with typed tests, not suppressions.

**Migration**:

- Internal only.

**Gate**:

- `bun run gate`
- one review subagent against the commit diff and this batch

---

## Wave 3: Domain Modeling And Constructor Discipline

### Batch 10: `refactor(model): convert owned event bags to tagged unions`

**Justification**: `kind` bags keep leaking into the UI and transport.

**Principles**: `make-impossible-states-unrepresentable`, `small-interface-deep-implementation`, `subtract-before-you-add`

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/domain/queue.ts`
- `packages/core/src/domain/message.ts`
- `packages/core/src/server/transport-contract.ts`
- `apps/tui/src/hooks/use-session-feed.ts`
- `apps/tui/src/components/session-event-label.ts`
- `packages/extensions/src/executor/sidecar.ts`
- `packages/core/tests/*session*`

**Sketch**:

- Convert `SessionEvent`, `PortProbe`, and `QueueEntryInfo` to tagged unions.
- Remove dead-weight singleton discriminators such as `ResourceSchedule.target.kind`.
- Keep foreign protocol `kind` fields untouched unless Gent owns the shape.

**Migration**:

- Transport break is included here.
- Update TUI feed/render logic and runtime tests in the same batch.

**Gate**:

- `bun run gate`
- `bun run test:e2e`
- one review subagent against the commit diff and this batch

### Batch 11: `refactor(model): model interjections explicitly`

**Justification**: `Message.kind` is a baggy escape hatch for one special case.

**Principles**: `make-impossible-states-unrepresentable`, `derive-dont-sync`, `fix-root-causes`

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/domain/message.ts`
- `packages/core/src/server/transport-contract.ts`
- `packages/core/src/runtime/agent/agent-loop.state.ts`
- `packages/core/src/runtime/agent/agent-loop.ts`
- `apps/tui/src/hooks/use-session-feed.ts`
- `packages/core/tests/runtime/agent-loop.test.ts`
- `apps/tui/tests/widgets-render.test.tsx`

**Sketch**:

- Replace interjection marker fields with an explicit tagged message/session-event model.
- Remove `kind` from message DTOs if the distinction can be derived from variant shape.
- Keep transcript rendering behavior unchanged.

**Migration**:

- Included transport and projection updates.

**Gate**:

- `bun run gate`
- `bun run test:e2e`
- one review subagent against the commit diff and this batch

### Batch 12: `refactor(domain): prefer explicit constructors over schema mutation hacks`

**Justification**: Mutating schemas/functions into pseudo-constructors creates type holes.

**Principles**: `boundary-discipline`, `small-interface-deep-implementation`, `fix-root-causes`

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/domain/ids.ts`
- `packages/core/src/domain/agent.ts`
- `packages/core/src/domain/event.ts`
- `packages/extensions/src/task-tools-service.ts`
- `packages/extensions/src/openai/index.ts`
- `packages/extensions/src/anthropic/index.ts`
- `apps/tui/src/extensions/builtins/driver.client.ts`
- `packages/core/tests/domain/*`

**Sketch**:

- Replace schema/function mutation patterns with explicit constructor helpers.
- Prefer `.make` at call sites where it removes `new` noise and clarifies intent.
- Keep `new` only where class identity or post-construction behavior matters.

**Migration**:

- Mechanical call-site migration in the same batch.

**Gate**:

- `bun run gate`
- one review subagent against the commit diff and this batch

### Batch 13: `refactor(domain): simplify schema and protocol builder substrate`

**Justification**: Some suppressions are symptoms of over-clever schema metaprogramming.

**Principles**: `subtract-before-you-add`, `boundary-discipline`, `correctness-over-pragmatism`

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/domain/schema-tagged-enum-class.ts`
- `packages/core/src/domain/extension-protocol.ts`
- `packages/core/src/domain/contribution.ts`
- `packages/core/tests/domain/schema-tagged-enum-class.test.ts`
- `packages/core/tests/domain/extension-protocol.test.ts`

**Sketch**:

- Split descriptors from constructor behavior where `Object.assign` and erased casts are doing too much work.
- Simplify or replace the metaprogramming substrate if the type holes are structural.
- Preserve `_tag`-locked modeling and author ergonomics.

**Migration**:

- Update all internal callers and surface-lock tests inside the batch.

**Gate**:

- `bun run gate`
- one review subagent against the commit diff and this batch

---

## Wave 4: SDK, TUI, And Suppression Hygiene

### Batch 14: `refactor(sdk): collapse proxy adapters into typed transports`

**Justification**: SDK proxy wrappers are a recurring cast factory.

**Principles**: `boundary-discipline`, `small-interface-deep-implementation`, `fix-root-causes`

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`

**Files**:

- `packages/sdk/src/client.ts`
- `packages/sdk/src/server.ts`
- `packages/sdk/src/server-registry.ts`
- `packages/sdk/src/local-supervisor.ts`
- `packages/core/src/server/transport-contract.ts`
- `packages/core/tests/server/*`

**Sketch**:

- Collapse proxy/wrapper layers into smaller typed transport clients.
- Remove `Context.Context<unknown>`-style widening at the adapter seam.
- Keep one transport contract, one typed adapter model.

**Migration**:

- Update TUI/client consumers in the same batch.

**Gate**:

- `bun run gate`
- `bun run test:e2e`
- one review subagent against the commit diff and this batch

### Batch 15: `refactor(tui): replace erased ui registries with typed registries`

**Justification**: `atom-solid` registry erasure is not a membrane; it is internal debt.

**Principles**: `make-impossible-states-unrepresentable`, `boundary-discipline`, `fix-root-causes`

**Skills**: `react`, `architecture`, `effect-v4`, `code-style`, `bun`, `test`

**Files**:

- `apps/tui/src/atom-solid/registry.ts`
- `apps/tui/src/atom-solid/solid.ts`
- `apps/tui/src/atom-solid/atom.ts`
- `apps/tui/src/theme/context.tsx`
- `apps/tui/src/routes/session-controller.ts`
- `apps/tui/src/components/composer.tsx`
- `apps/tui/src/utils/format-error.ts`
- `apps/tui/tests/*`

**Sketch**:

- Replace root `Context.Context<any>` erasure with typed registries or smaller service maps.
- Delete local casts that are really controller/modeling bugs.
- Keep UI behavior unchanged while making the type surface honest.

**Migration**:

- TUI-internal only.

**Gate**:

- `bun run gate`
- `bun run test:e2e`
- one review subagent against the commit diff and this batch

### Batch 16: `chore(policy): tighten suppression accounting`

**Justification**: Debt you do not count will reproduce.

**Principles**: `boundary-discipline`, `fix-root-causes`, `prove-it-works`

**Skills**: `code-style`, `bun`, `test`

**Files**:

- `packages/tooling/tests/suppression-policy.test.ts`
- `packages/tooling/tests/architecture-policy.test.ts`
- targeted source files from deleted-suppression list

**Sketch**:

- Expand suppression accounting to cover generic `eslint-disable` forms.
- Require an inline reason on every new suppression outside whitelisted membrane files.
- Delete the easy non-membrane suppressions identified in the audit.

**Migration**:

- Policy/test only, plus local cleanup.

**Gate**:

- `bun run gate`
- one review subagent against the commit diff and this batch

---

## Wave 5: Test Taxonomy And Behavioral Coverage

### Batch 17: `test(policy): separate policy tests from product behavior`

**Justification**: Policy tests are useful, but they should not masquerade as behavioral coverage.

**Principles**: `test-through-public-interfaces`, `derive-dont-sync`, `small-interface-deep-implementation`

**Skills**: `test`, `bun`, `code-style`

**Files**:

- `packages/tooling/tests/*`
- `apps/tui/tests/tui-boundary.test.ts`
- test task wiring in `package.json` / workspace package manifests as needed

**Sketch**:

- Move source-scan and architecture-policy tests into an explicit policy bucket or task.
- Remove or replace `tui-boundary.test.ts`.
- Make the test taxonomy honest in names and scripts.

**Migration**:

- Update scripts and CI expectations in the same batch.

**Gate**:

- `bun run gate`
- one review subagent against the commit diff and this batch

### Batch 18: `test(tui): consolidate route behavior suites`

**Justification**: TUI tests are over-sharded around internal state transitions.

**Principles**: `test-through-public-interfaces`, `subtract-before-you-add`, `fix-root-causes`

**Skills**: `react`, `test`, `bun`, `code-style`

**Files**:

- `apps/tui/tests/router.test.ts`
- `apps/tui/tests/session-state.test.ts`
- `apps/tui/tests/session-ui-state.test.ts`
- `apps/tui/tests/session-tree-state.test.ts`
- `apps/tui/tests/command-palette-state.test.ts`
- `apps/tui/tests/command-palette-render.test.tsx`
- `apps/tui/tests/composer-interaction-state.test.ts`
- `apps/tui/tests/prompt-search-flow.test.ts`
- `apps/tui/tests/prompt-search-render.test.tsx`
- `apps/tui/tests/app-auth.test.tsx`
- `apps/tui/tests/auth-route.test.tsx`

**Sketch**:

- Delete constructor-shape and tiny reducer tests that do not prove user-visible behavior.
- Merge state-only suites into route/render behavior suites.
- Add one real route-flow test covering auth gating, prompt search, and session switching through the UI.

**Migration**:

- Test-only.

**Gate**:

- `bun run gate`
- `bun run test:e2e`
- one review subagent against the commit diff and this batch

### Batch 19: `test(runtime): replace white-box runtime assertions with public-contract tests`

**Justification**: Event order and collaborator stubs are not the primary contract.

**Principles**: `test-through-public-interfaces`, `prove-it-works`, `fix-root-causes`

**Skills**: `test`, `effect-v4`, `bun`, `code-style`

**Files**:

- `packages/core/tests/runtime/session-runtime.test.ts`
- `packages/core/tests/runtime/agent-runner.test.ts`
- `packages/core/tests/server/interaction-commands.test.ts`
- `packages/core/tests/server/session-commands.test.ts`
- `packages/core/tests/server/extension-commands-rpc.test.ts`
- `packages/core/tests/extensions/skills/skills-rpc.test.ts`

**Sketch**:

- Replace stub-heavy internal wiring assertions with acceptance tests through `SessionRuntime`, RPC handlers, and extension seams.
- Keep direct actor/runtime tests only where the internal boundary itself is the subject.
- Add failure-path tests for interaction resume, helper-agent dispatch, and runtime persistence where the public contract depends on them.

**Migration**:

- Test-only.

**Gate**:

- `bun run gate`
- `bun run test:e2e`
- one review subagent against the commit diff and this batch

---

## Wave 6: Recursive Final Verification

### Batch 20: `chore(audit): run recursive final architecture verification`

**Justification**: A correctness-first rewrite is not done when the planned commits are done. It is done when fresh adversarial audits stop finding structural debt worth acting on.

**Principles**: `prove-it-works`, `correctness-over-pragmatism`, `fix-root-causes`, `redesign-from-first-principles`

**Skills**: `architecture`, `effect-v4`, `test`, `bun`, `repo`

**Files**:

- `PLAN.md`
- any files implicated by the fresh audit receipts
- audit outputs and policy/test files as needed

**Sketch**:

- Re-run the same multi-slice audit pattern used to create this plan:
  - runtime / actor ownership
  - Effect v4 / AI / storage leverage
  - suppressions / unsafe casts
  - `_tag` / constructors / enum modeling
  - tests / behavioral taxonomy
- Synthesize findings against the end-state checks in this plan.
- If audits find real debt:
  - append or replace remaining batches in `PLAN.md`
  - implement the highest-leverage fixes
  - re-run gate + review
  - repeat this verification batch again
- If audits find nothing material:
  - mark the plan complete
  - leave a final receipt summary in `PLAN.md` or successor architecture docs

**Recursive rule**:

- This batch is intentionally self-reentering.
- Any non-trivial finding from the verification audits creates follow-up implementation batches before the plan may be considered done.
- After those follow-up batches land, run this verification batch again.
- Stop only when fresh audits produce no material findings, only acceptable residual risks, or purely optional polish.

**Material finding threshold**:

- architecture still exposes duplicate sources of truth
- public APIs still leak internals
- owned unions still use string bags where `_tag` modeling would simplify callers
- suppressions exist outside justified membranes
- tests still lock internals instead of behavior
- Effect/platform primitives are still being shadowed by Gent-owned duplicates

**Migration**:

- Whatever the verification audits surface. No artificial scope cap.

**Gate**:

- `bun run gate`
- `bun run test:e2e`
- one review subagent against the verification diff and this batch

### Batch 20.1: `refactor(prompt): move prompt helpers to the domain boundary`

**Justification**: Fresh Batch 20 audit found pure prompt helpers living under `server/system-prompt`, with runtime modules and the public extension API importing that server module. Boundary rot. Small, real, worth fixing.

**Principles**: `small-interface-deep-implementation`, `boundary-discipline`, `fix-root-causes`

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/domain/prompt.ts`
- `packages/core/src/server/system-prompt.ts`
- `packages/core/src/extensions/api.ts`
- `packages/core/src/runtime/profile.ts`
- `packages/core/src/runtime/agent/agent-loop.ts`
- `packages/core/src/runtime/agent/agent-loop.utils.ts`
- `packages/core/src/runtime/agent/agent-runner.ts`
- `packages/core/tests/domain/prompt.test.ts`
- `packages/core/tests/extensions/acp-system-prompt-slot.test.ts`
- `packages/tooling/policy/architecture-policy.test.ts`

**Sketch**:

- Move `buildBasePromptSections`, `buildSystemPrompt`, `compileSystemPrompt`, and section marker helpers to `domain/prompt`.
- Delete the server prompt module instead of leaving a compatibility bridge.
- Update runtime, extension API, and tests to import the domain prompt surface.
- Add policy coverage so extension API and runtime modules cannot import server prompt internals again.

**Gate**:

- `bun run gate`
- `bun run test:e2e`
- one review subagent against the commit diff and this batch

### Batch 20.2: `test(runtime): restore runSpec provenance acceptance coverage`

**Justification**: Fresh Batch 20 audit found a skipped `parentToolCallId` contract test. Skipped tests are not coverage; this one protects run provenance through the public `message.send` path.

**Principles**: `test-through-public-interfaces`, `prove-it-works`, `fix-root-causes`

**Skills**: `test`, `effect-v4`, `bun`, `code-style`

**Files**:

- `packages/core/tests/server/session-commands.test.ts`
- `packages/core/tests/runtime/execution-overrides.test.ts`

**Sketch**:

- Replace the skipped placeholder with a public `message.send` acceptance test.
- Use a projection probe to prove `runSpec.parentToolCallId` reaches turn context through RPC, session runtime, and agent loop prompt assembly.
- Keep `execution-overrides.test.ts` focused on RunSpec serialization.

**Gate**:

- `bun run gate`
- one review subagent against the commit diff and this batch

---

## End State Checks

The plan is done only when all of these are true:

- [x] `SessionRuntime` is the only public session engine.
- [x] Extension authoring imports do not pull runtime internals.
- [x] `MachineEngine` mailbox ownership is structural, not ambient.
- [x] Transcript modeling is `Prompt` / `Response` native.
- [x] Multi-step storage writes are transactional.
- [x] Shared content chunks back the transcript without feature loss.
- [x] Extension placement uses `scope`, not `kind`.
- [x] Owned state unions use `_tag` where the shape is genuinely variant-based.
- [x] Non-membrane suppressions identified in the audit are gone or policy-accounted at explicit membranes.
- [x] TUI and runtime tests are behavior-first; policy tests are explicitly policy tests.
- [x] A fresh recursive audit pass finds no material structural issues left to batch.

## Final Verification Receipt

Final implementation commits:

- `f651d336` `refactor(prompt): move helpers to domain boundary`
- `838941db` `test(policy): broaden prompt boundary guard`
- `c0be9507` `test(runtime): restore runSpec provenance coverage`

Fresh audit commands:

- `rg "test\\.skip|describe\\.skip|it\\.skip|\\.only\\(" packages/core/tests apps/tui/tests packages/e2e/tests packages/tooling -n`
- `rg "server/system-prompt|@gent/core/server|from \"\\.\\./server|from \"\\.\\./\\.\\./server|from \"\\.\\./\\.\\./\\.\\./server" packages/core/src packages/core/tests packages/extensions/src apps/tui/src packages/sdk/src packages/tooling -n`
- `rg "_kind|kind:" packages/core/src packages/extensions/src apps/tui/src packages/sdk/src -n`
- `rg "@ts-expect-error|@ts-ignore|eslint-disable|@effect-diagnostics-next-line|as unknown as|as never|as any" packages/core/src packages/extensions/src apps/tui/src packages/sdk/src packages/core/tests -n`
- `rg "legacy|compat|migration window|dual-shape|TODO|FIXME|placeholder|temporary|until" packages/core/src packages/extensions/src apps/tui/src packages/sdk/src -n`
- `rg "SessionRuntimeService\\[\\\"runPrompt\\\"\\]|sessionRuntimeStub|build.*RpcHandlers|AgentLoop\\.Test|runOnce\\(" packages/core/tests -n`
- `rg "content_address|content-address|chunk|message_chunks|MessageChunk|chunked|partJsons|message_parts|parts_json" packages/core/src packages/core/tests -n`
- `rg "transaction|withTransaction|sql\\.withTransaction|BEGIN|COMMIT|ROLLBACK" packages/core/src/storage packages/core/src/runtime -n`
- `rg "ExtensionPackage" apps/tui packages -n`

Audit result:

- No skipped or focused tests remain.
- No `server/system-prompt` boundary import remains; prompt helpers now live in `packages/core/src/domain/prompt.ts`.
- Remaining `kind` usages are foreign protocol fields, scalar storage/wire fields, or local UI diff metadata; owned extension placement uses `scope`.
- Suppressions remain policy-accounted and concentrated at explicit schema/runtime/SDK/TUI membranes.
- Message parts are backed by `content_chunks` / `message_chunks`, with legacy blob backfill covered.
- Multi-step message and deletion writes use `sql.withTransaction`.
- Remaining direct `runOnce` usage is in tests whose subject is the agent loop implementation, not the public session runtime.
- The deprecated TUI `ExtensionPackage.tui` compatibility alias was removed after final review; `rg "ExtensionPackage" apps/tui packages -n` returns no matches.

Final gate:

- `bun run gate`
- `bun run test:e2e`
- one review subagent against the final verification diff
