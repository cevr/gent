# Planify: Wave 7 — Pre-Migration Hardening

## Context

Wave 6 implementation completed through commit `cad345ba` (C17 closeout:
`FileLockService` refcount-bounded eviction) and was gated. The W6 receipt
is archived at `plans/WAVE-6.md`.

The W6 closing recursive verification (nine lanes at `cad345ba`) surfaced
a punch list of P1/P2 findings beyond the Lane 9 architectural finding
about `Resource.machine`. The full list lives at
`~/.claude/projects/-Users-cvr-Developer-personal-gent/memory/project_w7_findings.md`.

Most findings target surfaces that **survive** the upcoming actor-primitive
redesign (W9) and surface-collapse (W10). Brand leaks on `domain/driver.ts`,
domain back-imports, server hardening, and test gap closure are debt today
that will still be debt after W10. Letting them age while three architectural
waves churn the substrate around them means another year of accumulation on
top.

A subset of findings target surfaces that **die** in W10 (intent default fix,
`CapabilityId`/`ProjectionId` brands, `ReadOnlyTag` privacy). Those are
explicitly **skipped** in W7 — fixing brand leaks on a primitive that is
being deleted is wasted work.

**Wave 7 is the pre-migration hardening pass.** It lands surface-independent
findings against the W6 substrate before the architectural work begins. The
plan is not complete until every batch below is implemented, gated, and
reviewed once.

## Roadmap

W7 is one wave in a six-wave program:

- **W7 (this file)** — pre-migration hardening: brand leaks, domain
  back-imports, server hardening, test gap closure, low/cleanup tail.
  Surfaces W10 collapses are explicitly skipped.
- **`plans/WAVE-8.md`** — agent-loop simplification: drop `effect-machine`
  from `agent-loop.ts` + `agent-loop.state.ts`; replace FSM driver with
  plain `Effect.gen` + `Ref<Phase>`; collapse duplicated state Refs.
  ~800 LOC deletion. Grounded in `plans/AGENT-LOOP-COMPARISON.md`.
- **`plans/WAVE-9.md`** — actor primitive foundation: introduce
  `domain/actor.ts` (`ActorRef<M>`, `Behavior`, `ActorContext`,
  `ServiceKey<M>`, `tell`, `ask`, `Receptionist`, persistence). No
  migrations — foundation work only.
- **`plans/WAVE-10.md`** — full migration + extension surface collapse:
  migrate all 7 `Resource.machine` sites + `executor/actor`; fold
  `ProjectionContribution` into actor `view`; introduce per-bucket
  inline handlers (`tools` / `commands` / `keybinds` / `rpc`); delete
  `Capability` / `Intent` / `Projection` / `Resource.machine` /
  `MachineEngine` / `runtime.*` slots / `subscriptions`. `effect-machine`
  the library survives in `auto` and `executor/actor` (genuine FSMs);
  `MachineEngine` the host dies.
- **`plans/WAVE-11.md`** — `needs: [Tag, ...]`-derived concurrency +
  read-safety; central `LOCK_REGISTRY` with fail-closed validation.
- **`plans/WAVE-12.md`** — 9-lane recursive verification audit on the
  fully settled W7+W8+W9+W10+W11 substrate. Closeout receipt.

## Scope

- **In**: P1 brand leaks (`SessionId`, `ToolCallId`, `AgentName` on
  `domain/driver.ts` + `domain/agent.ts`); generic P2 brands (`ProviderId`,
  `ActorId`, `InteractionRequestId`, `ExtensionId` — surfaces survive W10);
  domain back-imports (`ProviderError`, `StorageError` on `domain/driver.ts`
  - `domain/session-mutations.ts`); `DEFAULT_AGENT_NAME` adoption in TUI
    fallbacks; `ServerIdentity` non-optional in `RpcHandlerDeps` (eliminates
    `Effect.die`); `SessionMutationsService` parallel-surface deletion;
    `cwdPulseCache` eviction wiring; test gap closure (`Effect.timeout`
    sweeps on three runtime test files; TTL/size-cap eviction tests;
    `Layer.build(AppServicesLive)` smoke test; provider cause-preservation
    tests; concurrent-write storage tests; `migrateForeignKeyConstraints`
    interrupt-restores-PRAGMA test; `deleteSession` cascade race test;
    `sanitizeFts5Query` unit tests; pure-function tests for
    `resolveAgentDriver`, `getDurableAgentRunSessionId`, exhaustive event
    helpers, `makeRunSpec`, `copyMessageToBranch`); low/cleanup tail (dead
    `bypass` column drop in next FK rebuild; `getSessionDetail` N+1 →
    `IN (...)` + group in memory; `Bun.spawn` rationale comment at
    `agent-runner.ts:1160`; `latestInputTokens` consolidation into
    `agentStore.metrics`; shared `task-tools/refs.ts` for de-duplicated
    `ref(TaskCreateRequest)` derivations; `tags` schemas → `NonEmptyString`;
    `as` cast comment in `streamImpl` overload at `provider.ts:656-659`;
    `resolveModel` test stub type hole at
    `tests/providers/provider-auth.test.ts:18,46,55`).
- **Out (Wave 8)**: agent-loop simplification.
- **Out (Wave 9)**: actor primitive scaffolding.
- **Out (Wave 10)**: extension surface collapse, `Resource.machine`
  deletion, `Capability`/`Projection` deletion, intent default fix
  (field deleted), `CapabilityId`/`ProjectionId` brands (surfaces
  deleted), `ReadOnlyTag` (brand deleted).
- **Out (Wave 11)**: `needs: [Tag, ...]` work.
- **Out**: cosmetic refactors not in the W6 audit punch list;
  package-policy reintroduction.

## Constraints

- Correctness over pragmatism. Personal library; no shims, no parallel
  APIs, no deprecation cycles.
- Each commit compiles and passes `bun run gate`.
- Sub-commits allowed inside any C-batch with blast radius > 20 files.
  Each sub-commit must compile and pass gate.
- One review subagent per implementation commit (per-commit Codex review
  for drift detection).
- High-blast-radius commits (`C1`, `C8`) also run `bun run test:e2e`.
- Apply-tier delegation per CLAUDE.md: design-tier authors brand passes
  - first test of each pattern; apply-tier subagents handle the
    recipe-execution tail (e.g., the `Effect.timeout` sweep).

## Applicable Skills

`architecture`, `effect-v4`, `test`, `code-style`, `bun`, `planify`

## Gate Command

`bun run gate`

---

## Implementation Batches

Order: brand passes first (highest user-impact P1s), then domain
back-imports (decouple domain from infra), then server hardening, then
test gap closure (apply-tier-friendly), then low/cleanup tail.

### Commit 1: `refactor(domain): brand SessionId, ToolCallId, AgentName across driver + agent surfaces`

**Why C1 first**: P1 brand leaks. `domain/driver.ts:131`
`ProviderAuthorizeContext.sessionId: string` accepts any string; same
for `TurnEvent.{ToolCall,ToolStarted,ToolCompleted,ToolFailed}.toolCallId`
at `domain/driver.ts:214,219,224,228`; same for
`resolveAgentDriver(overrides?: Record<string, DriverRef>)` at
`domain/agent.ts:135`. Branding closes typed-id contracts at the
boundary the actor migration will touch in W10.

**Files**: `packages/core/src/domain/driver.ts`,
`packages/core/src/domain/agent.ts`, every consumer that constructs
these schemas (call sites of `ProviderAuthorizeContext`, `TurnEvent.*`,
`resolveAgentDriver`); tests cover roundtrip + cross-id assignment is a
type error.

**Verification**: `bun run gate` + `bun run test:e2e`.

**Cites**: `make-impossible-states-unrepresentable`,
`fail-with-typed-errors`.

### Commit 2: `refactor(domain): generic P2 brand pass — ProviderId, ActorId, InteractionRequestId, ExtensionId`

**Why C2**: surfaces survive W10. `Model.provider` →
`ProviderId` (`domain/model.ts:27`); new `ActorId` brand applied across
`event.ts:175,182,188`; new `InteractionRequestId` across
`event.ts:137,145` + `interaction-request.ts:45,57`; new `ExtensionId`
on `extension.ts` + consumers.

**Skipped from the original list**: `CapabilityId` and `ProjectionId`
brands — those surfaces die in W10. Doing them now is wasted work.

**Files**: schema definitions + all decode/construct sites; tests cover
each brand.

**Verification**: `bun run gate`.

**Cites**: `make-impossible-states-unrepresentable`.

### Commit 3: `refactor(domain): eliminate domain back-imports — ProviderError, StorageError`

**Why C3**: `domain/driver.ts:40` imports `ProviderError` from infra;
`domain/session-mutations.ts:5` imports `StorageError`. Domain layer
should not depend on infra. Either move the error tags into domain or
parameterize the schemas with opaque type params. Domain-purity matters
because W10's surface collapse will re-shape every domain consumer; we
want the domain layer free of infra-coupling first.

**Files**: `packages/core/src/domain/driver.ts`,
`packages/core/src/domain/session-mutations.ts`, error definitions
(probably create `domain/provider-error.ts`,
`domain/storage-error.ts`); update infra side to import from domain
(re-export for back-compat is fine since infra is the consumer).

**Verification**: `bun run gate`.

**Cites**: `small-interface-deep-implementation`,
`migrate-callers-then-delete-legacy-apis`.

### Commit 4: `fix(server): ServerIdentity non-optional in RpcHandlerDeps`

**Why C4**: `rpc-handler-groups/server.ts:8` carries `Effect.die` for the
`ServerIdentity` missing case. Making the field non-optional eliminates
the defect path. Resolves Lane 5 vs Lane 8 cross-conflict from W6 audit.

**Files**: `packages/core/src/server/rpc-handler-groups/server.ts` and
the `RpcHandlerDeps` definition; update construction sites to provide
the field; remove `Effect.die`.

**Verification**: `bun run gate`.

**Cites**: `fail-with-typed-errors`,
`make-impossible-states-unrepresentable`.

### Commit 5: `refactor(server): delete SessionMutationsService parallel surface`

**Why C5**: `server/session-commands.ts:407-616` duplicates
`SessionCommands.Live` handlers via a parallel `SessionMutationsService`
surface. Will drift since dedup logic is on `SessionCommands` only.
Delete the parallel surface; route any external consumer through
`SessionCommands` or `dispatch(...)`.

**Files**: `packages/core/src/server/session-commands.ts` (delete the
service shape), every call site of `SessionMutationsService.*` (route
through `SessionCommands`); tests.

**Verification**: `bun run gate`.

**Cites**: `subtract-before-you-add`, `derive-dont-sync`.

### Commit 6: `fix(server): wire cwdPulseCache eviction to SessionProfileCache invalidation`

**Why C6**: `server/event-publisher.ts:241` reads `cwdPulseCache` but
nothing invalidates it on `SessionProfileCache` mutation. Stale pulse
data on cwd switch. Hook eviction into the existing
`SessionProfileCache` invalidation point.

**Files**: `packages/core/src/server/event-publisher.ts`, wherever
`SessionProfileCache` invalidation lives (`session-profile-cache.ts` or
similar); test covers cwd-switch invalidation.

**Verification**: `bun run gate`.

**Cites**: `derive-dont-sync`, `bound-resources-self-evict`.

### Commit 7: `fix(tui): adopt DEFAULT_AGENT_NAME in client context fallbacks`

**Why C7**: `apps/tui/src/client/context.tsx:285,867` uses bare strings
where `DEFAULT_AGENT_NAME` constant should be referenced. Cosmetic but
it's a brand-leak surface and lands cleanly with the C1 brand work.

**Files**: `apps/tui/src/client/context.tsx`.

**Verification**: `bun run gate`.

**Cites**: `make-impossible-states-unrepresentable`.

### Commit 8: `test(runtime): close deterministic test gaps — Effect.timeout sweeps + missing coverage`

**Why C8**: 64 missing-`Effect.timeout` test bodies and ~12 missing
deterministic tests from W6 audit. Apply-tier delegation.

**Sub-commits permitted** (~80 test bodies):

- **C8.1**: design-tier writes the `Effect.timeout` recipe + 1 worked
  example per file; one TTL-eviction test as the reference for the
  eviction-test pattern.
- **C8.2**: apply-tier subagent applies the `Effect.timeout` sweep to
  remaining 63 bodies in `tests/runtime/agent-runner.test.ts` (15
  bodies, lines 261, 324, 420, 476, 529, 584, 651, 742, 795, 874,
  948, 1017, 1067, 1237, 1309), `tests/runtime/external-turn.test.ts`
  (26 bodies, 0 timeouts today), `tests/runtime/session-runtime.test.ts`
  (23 bodies, 3 timeouts today).
- **C8.3**: design-tier writes the missing-coverage tests:
  size-cap eviction (>1024 distinct requestIds);
  `Layer.build(AppServicesLive)` smoke test (catches
  `SessionRuntimeTerminator` unsatisfied); provider cause-preservation
  tests for `Provider.generate` and `Stream.catch`; OTel span test on
  `Provider.stream`; concurrent-write storage tests
  (`createSession`/`appendEvent`/`createMessage` races);
  `migrateForeignKeyConstraints` interrupt-restores-PRAGMA test;
  `deleteSession` cascade race test; `sanitizeFts5Query` unit tests;
  headless retry uses same `sendRequestId` test;
  ephemeral-scope cleanup-on-interrupt test (`runEphemeralAgent`);
  parent-MemoMap-omission regression test (`composer.ts:354`);
  `terminateSessionMachineRuntime` storage-failure fail-closed test;
  pure-function tests for `resolveAgentDriver`,
  `getDurableAgentRunSessionId`, exhaustive event helpers,
  `makeRunSpec`, `copyMessageToBranch`.

**Skipped from the original list**: `CAPABILITY_REF` privacy test,
`ref()` throws-on-tool/action test — both target dies in W10.

**Files**: `packages/core/tests/runtime/*.test.ts`,
`packages/core/tests/storage/*.test.ts`,
`packages/core/tests/providers/*.test.ts`,
`packages/core/tests/domain/*.test.ts`.

**Verification**: `bun run gate` + `bun run test:e2e` (final
sub-commit).

**Cites**: every brain principle the tests exercise (recorded
per test).

### Commit 9: `chore(domain,storage,runtime): low/cleanup tail`

**Why C9**: low-priority cleanups. Bundle as one commit since each is
small and the surfaces don't overlap.

**Items**:

- Drop dead `bypass INTEGER` column on `sessions` table in next FK
  rebuild (`sqlite-storage.ts:606,620,882,898`).
- `getSessionDetail` N+1 → `IN (...)` + group in memory
  (`sqlite-storage.ts:1610-1657`).
- `Bun.spawn` rationale comment at `agent-runner.ts:1160` (justified by
  process-group `kill -pid`).
- `latestInputTokens` consolidation into `agentStore.metrics`.
- Shared `task-tools/refs.ts` for de-duplicated `ref(TaskCreateRequest)`
  derivations.
- `tags` schemas → `NonEmptyString` (`domain/agent.ts:171`,
  `extension.ts:124`).
- Comment the `as` cast in `streamImpl` overload return at
  `provider.ts:656-659`.
- Fix `resolveModel: () => ({})` typecheck-despite-missing-`layer`-field
  type hole at `tests/providers/provider-auth.test.ts:18,46,55`.

**Files**: per item.

**Verification**: `bun run gate`.

**Cites**: per item.

---

W7 closes when the W6 audit punch list (minus W10-deleted-target items)
is empty against HEAD and gate is green. **`plans/WAVE-8.md`** is the
next wave: agent-loop simplification.
