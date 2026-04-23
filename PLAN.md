# Planify: Second Post-Simplification Architecture Plan

## Intent

Correctness-first rewrite plan after the first simplification wave.

The previous wave removed the obvious duplication: command dispatch exists, `SessionRuntimeContext` exists, public extension machines no longer expose runtime-only follow-up effects, and `_kind` is policy-locked out of owned source. This plan targets the remaining structural debt.

No feature reduction. Breaking changes are acceptable when paired with migrations. Scope is not a constraint.

## Audit Inputs

Subagents:

- `Sartre`: runtime / actor ownership audit.
- `Linnaeus`: extension system / suppression audit.
- `Pauli`: Effect v4 / effect-smol AI audit.
- `Ampere`: constructors / `_tag` / enum modeling audit.
- `Averroes`: behavioral test audit.

Local sources:

- Brain principles: `/Users/cvr/.brain/principles/*.md`
- Architecture docs: `ARCHITECTURE.md`, `docs/actor-model.md`
- Effect source: `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/{Prompt.ts,Response.ts,Toolkit.ts,Tool.ts,LanguageModel.ts,Chat.ts}`
- Repo scans: suppressions, `kind` / `status` / `_kind`, constructors, tests, provider AI bridge.

## North Stars

- `subtract-before-you-add`: delete duplicate local models before inventing helpers.
- `use-the-platform`: Effect AI `Prompt`, `Response`, `Toolkit`, `LanguageModel`, and `Chat` are the platform for model IO.
- `small-interface-deep-implementation`: public surfaces stay tiny; complexity goes behind owned services.
- `make-impossible-states-unrepresentable`: state variants use constructors and `_tag`, not parallel optional strings.
- `derive-dont-sync`: no duplicated runtime/profile/transport truth.
- `boundary-discipline`: suppressions only at real membranes.
- `test-through-public-interfaces`: behavior contracts first, type/source policy second.
- Actor model: one owner per mutable state island; local supervision; let it crash inside isolated actors; no ambient mutable handles as public API.

## Target Architecture

- `SessionRuntime`: dispatch/read-only public runtime surface. No direct `runOnce` escape hatch.
- `AgentLoop`: internal session actor implementation. It owns loop execution, queue state, interaction state, and turn recovery.
- `ProfileRuntime`: one composition helper for server/cwd/session profile runtime wiring.
- `ResourceHost`: split into service-layer assembly, lifecycle finalization, actor protocol/mailbox runtime, and scheduler/subscription collection.
- `Provider`: speaks Effect AI prompts, response parts, and toolkits at the model boundary.
- `Transcript`: Gent metadata remains Gent-owned; AI conversation content is represented by Effect AI prompt/response parts.
- `Domain`: owned unions use `_tag` constructors. Flat persisted scalars are allowed only when they are truly scalar and have one imported codec.
- `TUI Extensions`: contribution slots are typed by slot, not downcast from `ClientContribution<any>`.
- `Tests`: semantic groups mirror user/runtime contracts; source scans and skipped tests are quarantined or deleted.

## Execution Protocol

Every batch:

1. Implement the batch only.
2. Run `bun run gate`.
3. Commit with the listed conventional commit title, or a narrower sub-commit title if split.
4. Spawn exactly one review subagent against the commit diff and this plan section.
5. Fix all findings before continuing.

Extra rules:

- If a batch touches transport, runtime recovery, process supervision, or stream handoff, also run `bun run test:e2e`.
- If a batch touches 20+ files across subsystems, split into sub-commits inside the batch. Each sub-commit still runs `bun run gate`.
- No compatibility bridges that exist only to avoid migration. Migrate callers, then delete legacy APIs.

## Current Receipts

| Finding                                                   | Receipts                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionRuntime` still leaks `runOnce`                    | `packages/core/src/runtime/session-runtime.ts:176`, `packages/core/src/runtime/session-runtime.ts:432`, `packages/core/src/runtime/agent/agent-runner.ts:896`                                                                                                                                                                                                                            |
| `SessionProfileCache.peek` is dead surface                | `packages/core/src/runtime/session-profile.ts:116`, `packages/core/src/runtime/session-profile.ts:282`, `packages/core/src/runtime/session-profile.ts:335`                                                                                                                                                                                                                               |
| Profile/runtime wiring remains duplicated                 | `packages/core/src/server/dependencies.ts:148`, `packages/core/src/server/dependencies.ts:344`, `packages/core/src/runtime/session-profile.ts:156`, `packages/core/src/runtime/profile.ts:234`                                                                                                                                                                                           |
| Mailbox ownership leaks through ambient service           | `packages/core/src/runtime/extensions/extension-actor-shared.ts:14`, `packages/core/src/runtime/extensions/resource-host/machine-engine.ts:719`, `packages/core/src/runtime/extensions/resource-host/machine-engine.ts:847`                                                                                                                                                              |
| Resource host still has broad erased layer/machine casts  | `packages/core/src/runtime/extensions/resource-host/index.ts:103`, `packages/core/src/runtime/extensions/resource-host/index.ts:115`, `packages/core/src/runtime/extensions/resource-host/index.ts:171`, `packages/core/src/runtime/extensions/resource-host/machine-engine.ts:291`                                                                                                      |
| Effect AI fidelity is lost at provider boundary           | `packages/core/src/providers/provider.ts:266`, `packages/core/src/providers/provider.ts:351`, `packages/core/src/providers/provider.ts:514`, `packages/core/src/providers/provider.ts:582`                                                                                                                                                                                               |
| Gent duplicates AI transcript shapes                      | `packages/core/src/domain/message.ts:13`, `packages/core/src/domain/message.ts:79`, `packages/core/src/storage/sqlite-storage.ts:248`, `packages/core/src/runtime/agent/agent-loop.ts:172`                                                                                                                                                                                               |
| Effect already has prompt/response/toolkit/chat substrate | `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Prompt.ts:1886`, `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Response.ts:369`, `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Toolkit.ts:279`, `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Chat.ts:103` |
| TUI facet resolver downcasts every slot                   | `apps/tui/src/extensions/client-facets.ts:137`, `apps/tui/src/extensions/resolve.ts:21`, `apps/tui/src/extensions/resolve.ts:103`, `apps/tui/src/extensions/context.tsx:79`                                                                                                                                                                                                              |
| Auth has `_tag` plus parallel `type`                      | `packages/core/src/domain/auth-store.ts:5`, `packages/core/src/domain/auth-store.ts:9`, `packages/core/src/domain/auth-store.ts:29`, `packages/core/src/domain/auth-store.ts:58`                                                                                                                                                                                                         |
| Task status is duplicated across schemas/storage/tools    | `packages/core/src/domain/task.ts:8`, `packages/extensions/src/task-tools-storage.ts:37`, `packages/extensions/src/task-tools-service.ts:113`, `packages/extensions/src/task-tools/task-update.ts:5`                                                                                                                                                                                     |
| Transport DTOs restate domain state as string bags        | `packages/core/src/server/transport-contract.ts:194`, `packages/core/src/server/transport-contract.ts:370`, `packages/core/src/server/transport-contract.ts:420`, `packages/core/src/server/transport-contract.ts:450`                                                                                                                                                                   |
| Agent run provenance uses `as never`                      | `packages/extensions/src/plan-tool.ts:128`, `packages/extensions/src/plan-tool.ts:134`, `packages/extensions/src/review/review-tool.ts:239`, `packages/extensions/src/review/review-tool.ts:245`                                                                                                                                                                                         |
| Tests still contain parked or white-box contracts         | `packages/core/tests/runtime/execution-overrides.test.ts:19`, `apps/tui/tests/tui-boundary.test.ts:5`, `packages/core/tests/server/extension-health.test.ts:4`, `packages/core/src/server/rpc-handler-groups/extension.ts:17`                                                                                                                                                            |

---

## Wave 1: Runtime Surface And Profile Ownership

### Batch 1: `refactor(runtime): make session runtime dispatch-only`

**Justification**: `SessionRuntime.runOnce` is a second write ingress. One actor boundary means one command ingress.

**Principles**: `small-interface-deep-implementation`, `make-impossible-states-unrepresentable`, `boundary-discipline`

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/runtime/session-runtime.ts`
- `packages/core/src/runtime/agent/agent-runner.ts`
- `packages/core/tests/runtime/session-runtime.test.ts`
- `packages/core/tests/runtime/agent-runner.test.ts`
- `packages/core/tests/runtime/agent-loop.test.ts`

**Sketch**:

- Remove `runOnce` from `SessionRuntimeService`.
- Keep `AgentLoop.runOnce` internal for local loop implementation if still useful.
- Route `agent-runner.ts` through an internal child-run helper that owns its composition root instead of asking public `SessionRuntime` to run once.
- Convert tests from `sessionRuntime.runOnce(...)` to `dispatch(SendUserMessageCommand)` or direct `AgentLoop` tests where the loop implementation is the target.

**Migration**:

- Internal API break only.
- Replace `SessionRuntimeService["runOnce"]` stubs with dispatch-capable stubs or direct `AgentLoopService` stubs.

**Gate**:

- `bun run gate`
- One subagent review of the commit against this batch before continuing.

### Batch 2: `refactor(runtime): collapse profile runtime wiring`

**Justification**: server startup, cwd profile cache, and profile resolution still know the same wiring details. Profile data and live runtime services should be built by one helper.

**Principles**: `derive-dont-sync`, `subtract-before-you-add`, `fix-root-causes`

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`

**Files**:

- `packages/core/src/runtime/profile.ts`
- `packages/core/src/runtime/session-profile.ts`
- `packages/core/src/runtime/session-runtime-context.ts`
- `packages/core/src/server/dependencies.ts`
- `packages/core/tests/runtime/session-runtime-context.test.ts`

**Sketch**:

- Extract `buildProfileRuntime(...)` or equivalent into `runtime/profile.ts`.
- It returns resolved extensions, registries, driver registry, machine runtime, subscription engine, permission service, base prompt sections, and lifecycle layer context.
- Make server startup and `SessionProfileCache.Live` call the same helper.
- Delete `SessionProfileCache.peek`; no callers, no speculative cache surface.
- Keep scope ownership explicit: server scope for process/cwd resources, ephemeral scope for child runs.

**Migration**:

- Internal API break.
- Replace test fake profiles with the smaller `resolve(...)`-only shape.

**Gate**:

- `bun run gate`
- One subagent review of the commit against this batch before continuing.

### Batch 3: `refactor(runtime): localize machine mailbox ownership`

**Justification**: `CurrentMailboxSession` is a local deadlock guard modeled as ambient context. Actor mailbox ownership belongs inside `MachineEngine`.

**Principles**: `serialize-shared-state-mutations`, `make-impossible-states-unrepresentable`, actor-model state isolation

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/runtime/extensions/extension-actor-shared.ts`
- `packages/core/src/runtime/extensions/resource-host/machine-engine.ts`
- `packages/core/tests/extensions/actor.test.ts`
- `packages/core/tests/extensions/concurrency.test.ts`
- `packages/core/tests/extensions/resource-host.test.ts`

**Sketch**:

- Delete `CurrentMailboxSession`.
- Track current mailbox/session execution in `MachineEngine` local state.
- Preserve nested publish/send deadlock prevention.
- Keep `CurrentExtensionSession` only for the true extension-session context used by event publisher and spawned refs.

**Migration**:

- Internal only.
- Update tests to assert behavior: nested actor publishes do not deadlock, cross-session calls still serialize per owning mailbox.

**Gate**:

- `bun run gate`
- One subagent review of the commit against this batch before continuing.

---

## Wave 2: Extension Runtime Boundaries

### Batch 4: `refactor(extensions): split resource host service lifecycle and actor protocol`

**Justification**: `ResourceHost` currently merges heterogeneous service layers, lifecycle hooks, and machine protocol runtime in one place. That forces broad `any` casts. The casts are a symptom of too many responsibilities.

**Principles**: `boundary-discipline`, `small-interface-deep-implementation`, `fix-root-causes`

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/runtime/extensions/resource-host/index.ts`
- `packages/core/src/runtime/extensions/resource-host/machine-engine.ts`
- `packages/core/src/runtime/extensions/resource-host/schedule-engine.ts`
- `packages/core/src/runtime/extensions/resource-host/subscription-engine.ts`
- `packages/core/src/runtime/extensions/spawn-machine-ref.ts`
- `packages/core/src/runtime/extensions/effect-membrane.ts`
- `packages/core/tests/extensions/resource-host.test.ts`
- `packages/core/tests/extensions/runtime-slots.test.ts`

**Sketch**:

- Split host assembly into explicit modules:
  - service layer collection
  - lifecycle start/stop finalizers
  - resource machine actor protocol
  - subscription/scheduler collectors
- Keep `sealErasedEffect` and `exitErasedEffect` as the only erased-effect membrane.
- Move broad layer erasure to one helper with a narrower signature and a named reason.
- Tighten machine protocol reply decoding so `machine-engine.ts` does not repeat unsafe narrowing at every branch.

**Migration**:

- Internal only.
- Preserve resource scope semantics, lifecycle ordering, failure isolation, and actor status health surface.

**Gate**:

- `bun run gate`
- One subagent review of the commit against this batch before continuing.

### Batch 5: `refactor(extensions): type agent run provenance`

**Justification**: `parentToolCallId as never` is not a boundary. It is missing provenance typing in `ctx.agent.run`.

**Principles**: `make-impossible-states-unrepresentable`, `boundary-discipline`, `encode-lessons-in-structure`

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`

**Files**:

- `packages/core/src/domain/agent.ts`
- `packages/core/src/domain/extension-host-context.ts`
- `packages/core/src/runtime/make-extension-host-context.ts`
- `packages/extensions/src/plan-tool.ts`
- `packages/extensions/src/review/review-tool.ts`
- `packages/core/tests/extensions/plan-tool.test.ts`
- `packages/core/tests/extensions/review/review-tool.test.ts`

**Sketch**:

- Thread branded `ToolCallId` provenance through `AgentRun` / `RunSpec` surfaces.
- Ensure `ctx.agent.run` accepts the current tool-call provenance without casts.
- Delete `as never` in plan and review tools.
- Add a type lock that prevents unbranded string provenance.

**Migration**:

- Internal extension API break if current public types expose `string`.
- Migrate all extension callers in the same batch.

**Gate**:

- `bun run gate`
- One subagent review of the commit against this batch before continuing.

### Batch 6: `refactor(tui): type client extension facets by slot`

**Justification**: TUI client contributions are already `_tag`-discriminated, but the resolver erases components to `any` and downcasts every slot. That is avoidable architecture leakage.

**Principles**: `make-impossible-states-unrepresentable`, `boundary-discipline`, `encode-lessons-in-structure`

**Skills**: `react`, `architecture`, `code-style`, `bun`, `test`

**Files**:

- `apps/tui/src/extensions/client-facets.ts`
- `apps/tui/src/extensions/resolve.ts`
- `apps/tui/src/extensions/context.tsx`
- `apps/tui/src/extensions/builtins/*.tsx`
- `apps/tui/tests/extensions-resolve.test.ts`
- `apps/tui/tests/extension-integration.test.ts`

**Sketch**:

- Split component-bearing contributions by exact prop surface instead of `TComponent = unknown`.
- Replace `ClientContribution<any>` with a concrete union of slot-specific component types.
- Define one `ClientRuntime` type alias instead of `ManagedRuntime<any, never>`.
- Keep dynamic import membrane in `loader-boundary.ts`; make everything after it typed.
- Delete resolver downcasts for renderer/widget/overlay/interaction/composer slots.

**Migration**:

- Breaking TUI extension authoring change.
- Migrate builtins and tests in the same batch.

**Gate**:

- `bun run gate`
- One subagent review of the commit against this batch before continuing.

---

## Wave 3: Effect AI As Canonical Model Boundary

### Batch 7: `refactor(ai): add canonical effect-ai transcript bridge`

**Justification**: Gent persists session metadata, but it should not own a parallel AI conversation language. Effect already owns prompt/response/tool parts.

**Principles**: `use-the-platform`, `subtract-before-you-add`, `boundary-discipline`

**Skills**: `effect-v4`, `architecture`, `repo`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/domain/message.ts`
- `packages/core/src/providers/provider.ts`
- `packages/core/src/providers/ai-transcript.ts` (new)
- `packages/core/src/storage/sqlite-storage.ts`
- `packages/core/tests/providers/provider-resolution.test.ts`
- `packages/core/tests/storage/sqlite-storage.test.ts`
- Effect refs: `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Prompt.ts`, `Response.ts`

**Sketch**:

- Add a bridge module that converts Gent persisted `Message` records to `Prompt.Message` / `Prompt.Prompt`.
- Add reverse helpers where response parts need to become persisted assistant/tool messages.
- Preserve current wire/storage shape in this batch.
- Add round-trip tests for text, reasoning, image media type, tool call, tool result, system messages, metadata-hidden messages.
- Explicitly document which Gent fields are metadata (`kind`, `turnDurationMs`, `MessageMetadata`) and which are AI content.

**Migration**:

- No storage migration yet.
- This is a scaffold batch that makes the invasive migration measurable.

**Gate**:

- `bun run gate`
- One subagent review of the commit against this batch before continuing.

### Batch 8: `refactor(ai): make provider requests speak Effect AI`

**Justification**: `Provider.stream` currently accepts Gent messages, converts by hand, and advertises tools via a handler that always errors. The provider boundary should be an Effect AI boundary.

**Principles**: `use-the-platform`, `small-interface-deep-implementation`, `fix-root-causes`

**Skills**: `effect-v4`, `architecture`, `repo`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/providers/provider.ts`
- `packages/core/src/domain/driver.ts`
- `packages/core/src/domain/capability.ts`
- `packages/core/src/domain/tool-schema.ts`
- `packages/core/src/runtime/agent/agent-loop.ts`
- `packages/extensions/src/{anthropic,openai,mistral,google}/index.ts`
- Effect refs: `LanguageModel.ts`, `Toolkit.ts`, `Tool.ts`

**Sketch**:

- Change primary provider request shape to accept `Prompt.RawInput` or `Prompt.Prompt`.
- Keep a temporary internal adapter from Gent messages while agent loop migrates.
- Replace advertise-only toolkit with a real `Toolkit` builder whose handlers route through Gent tool execution policy or intentionally disables resolution through a typed, named mode.
- Thread provider options that Effect AI already supports instead of custom ad hoc request fields where possible.
- Treat `Provider.generate` as a compatibility wrapper or delete it if no internal call sites remain.

**Migration**:

- Internal API break.
- Migrate all provider callers in the same batch or next batch before deleting compatibility adapter.

**Gate**:

- `bun run gate`
- One subagent review of the commit against this batch before continuing.

### Batch 9: `refactor(ai): replay turns from response parts`

**Justification**: Agent loop manually reconstructs assistant drafts and prompt replay. Effect has `Prompt.fromResponseParts`; use it as the canonical replay primitive.

**Principles**: `derive-dont-sync`, `use-the-platform`, `subtract-before-you-add`

**Skills**: `effect-v4`, `architecture`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/runtime/agent/agent-loop.ts`
- `packages/core/src/runtime/agent/agent-loop.state.ts`
- `packages/core/src/providers/ai-transcript.ts`
- `packages/core/src/storage/sqlite-storage.ts`
- `packages/core/tests/runtime/agent-loop.test.ts`
- `packages/core/tests/runtime/external-turn.test.ts`
- Effect refs: `Prompt.ts:1886`, `Chat.ts:103`, `Chat.ts:358`

**Sketch**:

- Persist enough response-part information to replay assistant/tool turns without bespoke draft reconstruction.
- Use `Prompt.fromResponseParts(...)` for model-history reconstruction.
- Keep event emission and session/branch metadata in Gent; do not hand event-store ownership to Effect Chat.
- Evaluate whether `Chat` can own only per-turn prompt history or whether Gent needs a thin `ChatLike` adapter because of branch/session persistence.

**Migration**:

- Storage migration required if persisted message parts gain response-part metadata.
- Include a decoder that reads old rows and writes new rows on update, or a one-time migration in SQLite startup.

**Gate**:

- `bun run gate`
- `bun run test:e2e`
- One subagent review of the commit against this batch before continuing.

### Batch 10: `refactor(ai): centralize response stream construction`

**Justification**: live provider and debug providers duplicate `Response.StreamPart` construction and usage normalization.

**Principles**: `subtract-before-you-add`, `encode-lessons-in-structure`, `use-the-platform`

**Skills**: `effect-v4`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/providers/provider.ts`
- `packages/core/src/debug/provider.ts`
- `packages/core/src/providers/ai-stream.ts` (new)
- `packages/core/tests/debug/sequence-provider.test.ts`
- `packages/core/tests/providers/provider-auth.test.ts`

**Sketch**:

- Extract constructors for text delta, reasoning delta, tool call, tool result, finish, error, usage conversion.
- Export stream-to-turn-event conversion from the same module.
- Make debug providers and sequence providers use the same stream helpers as live provider.

**Migration**:

- Internal only.

**Gate**:

- `bun run gate`
- One subagent review of the commit against this batch before continuing.

---

## Wave 4: Domain Variants And Constructors

### Batch 11: `refactor(domain): remove parallel discriminators from auth and message state`

**Justification**: `AuthInfo` has `_tag` plus `type`. `MessageInfo.kind` is optional and creates hidden third state. Owned variants need one discriminator.

**Principles**: `make-impossible-states-unrepresentable`, `derive-dont-sync`, `migrate-callers-then-delete-legacy-apis`

**Skills**: `effect-v4`, `architecture`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/domain/auth-store.ts`
- `packages/core/src/domain/auth-method.ts`
- `packages/core/src/domain/auth-guard.ts`
- `packages/core/src/domain/message.ts`
- `packages/core/src/server/transport-contract.ts`
- `packages/core/src/server/session-utils.ts`
- `apps/tui/src/hooks/use-session-feed.ts`
- `apps/tui/src/components/message-list.tsx`
- `packages/core/tests/domain/auth-store.test.ts`
- `packages/core/tests/server/session-queries.test.ts`

**Sketch**:

- Remove `type` from `AuthApi` / `AuthOauth` as the canonical shape.
- Keep legacy auth-file decode that accepts old `{ type: "api" }` / raw key payloads and re-encodes to `_tag`.
- Replace optional message `kind` with a required domain variant or a required canonical scalar with constructor helpers. Prefer `_tag` if the shape carries behavior; keep scalar only if it is pure storage metadata.
- Update transport DTOs and TUI feed adapters to import domain schema instead of restating literals.

**Migration**:

- Auth storage migration from legacy `type` payload to `_tag`.
- Message rows with absent `kind` decode to the canonical regular constructor.

**Gate**:

- `bun run gate`
- One subagent review of the commit against this batch before continuing.

### Batch 12: `refactor(domain): centralize task lifecycle state`

**Justification**: task status is one lifecycle but is repeated across domain, storage, service, tool params, and request schemas.

**Principles**: `derive-dont-sync`, `make-impossible-states-unrepresentable`, `encode-lessons-in-structure`

**Skills**: `effect-v4`, `architecture`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/domain/task.ts`
- `packages/extensions/src/task-tools-storage.ts`
- `packages/extensions/src/task-tools-service.ts`
- `packages/extensions/src/task-tools/task-update.ts`
- `packages/extensions/src/task-tools/requests.ts`
- `packages/extensions/src/task-tools/projection.ts`
- `apps/tui/src/components/task-widget.tsx`
- `packages/core/tests/extensions/task-tools/task-tools.test.ts`
- `packages/core/tests/extensions/task-tools/task-rpc.test.ts`

**Sketch**:

- Make `TaskStatus` the only imported codec for status.
- Replace storage `status: string` and fallback-to-pending decode with schema decode that fails or migrates explicitly.
- Move transition validation onto constructors/functions in `domain/task.ts`.
- Keep DB column text if appropriate; the domain codec owns validation.
- If statuses gain payloads later, promote to `_tag` variants then. Do not fake a tagged union for a scalar just to worship `_tag`.

**Migration**:

- Existing valid status rows stay unchanged.
- Invalid rows fail loudly or migrate through an explicit repair path; no silent `"pending"` fallback.

**Gate**:

- `bun run gate`
- One subagent review of the commit against this batch before continuing.

### Batch 13: `refactor(transport): import domain variants into RPC DTOs`

**Justification**: transport contract restates health, activation, actor status, driver kind, and connection states as local string bags.

**Principles**: `derive-dont-sync`, `boundary-discipline`, `small-interface-deep-implementation`

**Skills**: `effect-v4`, `architecture`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/server/transport-contract.ts`
- `packages/core/src/domain/extension.ts`
- `packages/core/src/domain/driver.ts`
- `packages/core/src/server/extension-health.ts`
- `packages/core/src/server/rpc-handler-groups/extension.ts`
- `apps/tui/src/client/context.tsx`
- `apps/tui/tests/widgets-render.test.tsx`

**Sketch**:

- Move reusable transport-facing state schemas into domain modules or import existing domain schemas.
- Convert conceptual variants with payloads to `_tag` constructors.
- Keep externally dictated flat wire fields flat only where they are true wire protocol, not owned domain state.
- Update TUI consumers to pattern-match domain variants instead of comparing repeated strings where shape differs.

**Migration**:

- RPC breaking change if DTO shapes change.
- Update SDK/TUI callers in the same batch.

**Gate**:

- `bun run gate`
- `bun run test:e2e`
- One subagent review of the commit against this batch before continuing.

### Batch 14: `refactor(domain): standardize schema constructors on make`

**Justification**: the codebase uses both `new X(...)` and factory-style construction for schema-owned values. One construction idiom reduces churn and makes migrations mechanical.

**Principles**: `encode-lessons-in-structure`, `subtract-before-you-add`, `make-impossible-states-unrepresentable`

**Skills**: `effect-v4`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/domain/schema-tagged-enum-class.ts`
- `packages/core/src/domain/*.ts`
- `packages/core/src/runtime/**/*.ts`
- `packages/core/src/server/**/*.ts`
- `packages/extensions/src/**/*.ts`
- `apps/tui/src/**/*.ts`
- `packages/tooling/tests/architecture-policy.test.ts`

**Sketch**:

- Confirm every `Schema.Class` / `TaggedEnumClass` variant exposes a typed `.make`.
- Add missing types to `TaggedEnumClassVariant` if runtime already supports `.make`.
- Migrate schema-owned values to `X.make(...)` / `Enum.Variant.make(...)`.
- Leave platform constructors (`Map`, `Set`, `Date`, `URL`, `Response`, `Error`, `RegExp`, `AbortController`) alone.
- Add a policy test that flags new `new SchemaOwnedClass(...)` call sites outside approved constructor-internal files.

**Migration**:

- Mechanical call-site migration.
- No wire/storage behavior change.

**Gate**:

- `bun run gate`
- One subagent review of the commit against this batch before continuing.

---

## Wave 5: Storage And SQL Boundaries

### Batch 15: `refactor(storage): make sqlite decoding schema-first`

**Justification**: SQLite rows currently reconstruct schema classes manually and sometimes fall back silently. Storage should be a narrow schema decode/encode boundary.

**Principles**: `boundary-discipline`, `prove-it-works`, `fix-root-causes`

**Skills**: `effect-v4`, `architecture`, `repo`, `code-style`, `bun`, `test`

**Files**:

- `packages/core/src/storage/sqlite-storage.ts`
- `packages/core/src/storage/search-storage.ts`
- `packages/core/src/storage/checkpoint-storage.ts`
- `packages/extensions/src/task-tools-storage.ts`
- `packages/core/tests/storage/sqlite-storage.test.ts`
- `packages/core/tests/storage/task-storage.test.ts`
- Effect refs: `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/sql/SqlClient.ts`, `Statement.ts`

**Sketch**:

- Introduce row schemas for persisted records.
- Decode JSON fields through `Schema.fromJsonString(...)` at the boundary.
- Remove silent fallback for invalid enum/status rows unless covered by an explicit migration path.
- Use Effect SQL references/transformers where they delete repeated row mapping, not as cargo cult.
- Keep `bun:sqlite` constraints in mind; verify with Bun tests, not Vitest.

**Migration**:

- Include migrations for auth/message/task transcript shape changes from prior waves.
- Add old-row fixtures to prove backward decode.

**Gate**:

- `bun run gate`
- `bun run test:e2e`
- One subagent review of the commit against this batch before continuing.

---

## Wave 6: Behavioral Test Restructure

### Batch 16: `test(runtime): restore missing runtime and rpc contracts`

**Justification**: skipped tests and pure helper checks are not behavior coverage.

**Principles**: `test-through-public-interfaces`, `prove-it-works`, `encode-lessons-in-structure`

**Skills**: `test`, `effect-v4`, `bun`, `architecture`

**Files**:

- `packages/core/tests/runtime/execution-overrides.test.ts`
- `packages/core/tests/server/extension-health.test.ts`
- `packages/core/tests/server/extension-commands-rpc.test.ts`
- `packages/core/tests/server/session-commands.test.ts`
- `packages/core/tests/server/session-queries.test.ts`
- `packages/core/src/server/rpc-handler-groups/extension.ts`
- `packages/core/tests/extensions/task-tools/task-rpc.test.ts`

**Sketch**:

- Replace skipped `parentToolCallId` coverage with a live assertion through the current public runtime path.
- Add RPC acceptance coverage for `extension.listStatus`, not just pure health summary formatting.
- Consolidate server RPC tests into semantic groups: session lifecycle, auth, extension status/commands, capability request.
- Keep pure helper tests only where the helper is genuinely pure and domain-important.

**Migration**:

- Test-only file moves/renames allowed.
- Preserve all behavior assertions before deleting old one-off files.

**Gate**:

- `bun run gate`
- One subagent review of the commit against this batch before continuing.

### Batch 17: `test(tui): regroup tui tests by behavior surface`

**Justification**: TUI tests are useful but too flat. The directory layout hides which contracts are protected.

**Principles**: `test-through-public-interfaces`, `progressive-disclosure`, `encode-lessons-in-structure`

**Skills**: `react`, `test`, `bun`, `code-style`

**Files**:

- `apps/tui/tests/*.test.ts`
- `apps/tui/tests/*.test.tsx`
- `apps/tui/tests/tui-boundary.test.ts`
- `apps/tui/tests/app-bootstrap.test.ts`
- `apps/tui/tests/headless-runner.test.ts`
- `apps/tui/tests/app-auth.test.tsx`
- `apps/tui/tests/render-harness.tsx`

**Sketch**:

- Group tests by semantic surface: bootstrap/headless, session state, client transport, extensions, command/composer, rendering widgets.
- Delete or replace `tui-boundary.test.ts` source-string assertions with executable startup assertions.
- Keep existing meaningful reducer/render tests, but move them so the path explains the behavior.
- Update imports/helpers after moves.

**Migration**:

- Test-only.
- No product behavior change.

**Gate**:

- `bun run gate`
- One subagent review of the commit against this batch before continuing.

### Batch 18: `test(policy): lock architecture debt from returning`

**Justification**: Once the rewrite deletes debt, policy tests should encode the lesson so it stays deleted.

**Principles**: `encode-lessons-in-structure`, `prove-it-works`, `fix-root-causes`

**Skills**: `test`, `code-style`, `bun`

**Files**:

- `packages/tooling/tests/architecture-policy.test.ts`
- `packages/tooling/tests/suppression-policy.test.ts`
- `packages/core/tests/extensions/extension-surface-locks.test.ts`
- `packages/core/tests/runtime/scope-brands.test.ts`

**Sketch**:

- Add no skipped tests policy unless explicitly allowlisted with expiry.
- Add no white-box source-scan tests outside `packages/tooling/tests`.
- Tighten suppression counts after each suppression-burning wave.
- Add guard against new `kind` / `status` literal unions in owned domain files unless allowlisted as scalar protocol fields.
- Add guard against public `SessionRuntime` write methods other than `dispatch`.

**Migration**:

- Test/policy only.
- Update allowlist docs with exact reasons where debt intentionally remains.

**Gate**:

- `bun run gate`
- One subagent review of the commit against this batch before continuing.

---

## Wave 7: Documentation And Migration Receipts

### Batch 19: `docs(architecture): record second-wave architecture`

**Justification**: architecture changes only stick when future agents know the shape.

**Principles**: `encode-lessons-in-structure`, `progressive-disclosure`, `boundary-discipline`

**Skills**: `architecture`, `documenter`, `effect-v4`, `code-style`, `bun`

**Files**:

- `ARCHITECTURE.md`
- `AGENTS.md`
- `docs/actor-model.md`
- `packages/core/AGENTS.md` if present
- `apps/tui/AGENTS.md`

**Sketch**:

- Document the final runtime ownership model.
- Document Effect AI as the provider transcript boundary.
- Document the extension membrane policy: allowed membranes, disallowed ad hoc casts.
- Document constructor policy: `_tag`, `TaggedEnumClass`, `.make`, and exceptions.
- Document test taxonomy after file moves.

**Migration**:

- Docs only.

**Gate**:

- `bun run gate`
- One subagent review of the commit against this batch before continuing.

### Batch 20: `chore(migrations): publish compatibility cleanup receipts`

**Justification**: Breaking changes are fine only if migrations are explicit and proven.

**Principles**: `migrate-callers-then-delete-legacy-apis`, `prove-it-works`, `outcome-oriented-execution`

**Skills**: `architecture`, `effect-v4`, `bun`, `test`

**Files**:

- `packages/core/src/storage/*`
- `packages/extensions/src/*`
- `packages/sdk/src/*`
- `apps/tui/src/*`
- migration notes under `docs/` if needed

**Sketch**:

- Remove temporary compatibility adapters introduced in earlier waves.
- Add or update migration notes for auth, message transcript, task status, provider request, and RPC DTO changes.
- Verify no deprecated imports remain.
- Run full final verification.

**Migration**:

- Delete legacy adapters only after all callers moved.
- Keep persisted-data decoders for old on-disk data where users may already have rows.

**Gate**:

- `bun run gate`
- `bun run test:e2e`
- One final deep subagent review of the whole wave diff before marking plan complete.
