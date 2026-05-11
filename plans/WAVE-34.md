# Planify: Wave 34 — Upstream DX + Yield-Don't-Thread Closure

## Context

Wave 33 closed the runtime-layer yield-don't-thread sweep at field-level
granularity and removed the dead surface behind the extension-author contract
(HEAD `c65bab27`). Two classes of debt were intentionally deferred:

1. **Deferred C12 — effect-encore upstream DX.** Five paper-cuts that compound
   across every gent call site (typed actor state, sender-context bundle,
   per-handler context builder, entityId codec, `waitForState`). Counsel
   classified C12 as 3 yellow / 2 green and recommended sequencing it as a
   separate wave because it is upstream public-API design, not the closing
   commit of "Runtime Authority Closure". See WAVE-33.md:605-645.

2. **W33 final-audit P1s.** The 8-lane audit at HEAD `b01ca9e1` reported P0s
   (closed in C13.1–C13.8.1) plus a residual P1 set, the largest of which is
   the `hostDeps`/`sessionStorage` bag in `session-runtime-context.ts` — the
   "next granularity" of yield-don't-thread after the field-level sweep. See
   WAVE-33.md:687-694.

Wave 34 closes both before the next independent audit may pass.

## Scope

**In**

- Land the five upstream `effect-encore` DX changes in counsel-recommended
  order: `waitForState`, `SenderContext` bundle, typed actor state,
  `entityIdCodec` / `fromEntity({ key })`, `Actor.toLayer({ withScope })`.
- Migrate the corresponding gent call sites onto the new encore surface and
  delete the hand-rolled equivalents (~60 lines in `agent-loop.actor.ts`,
  generics in `session-runtime.ts`, polling in test helpers, entity-id codec).
- Migrate `session-runtime-context.ts` off the `hostDeps` /
  `sessionStorage` parameter bag onto `yield* Tag`; surface requirements on
  `R`.
- Migrate `event.ts:367` and `acp-agents/protocol.ts:141` from `Queue` to
  `TxQueue` for STM-native composition with the rest of the runtime.
- Promote `Ref<Map<...>>` sites in `runtime/agent/agent-loop.session-governance.ts`,
  `runtime/session-profile.ts`, and `runtime/file-index/fallback-adapter.ts` to
  `TxRef<HashMap<...>>` for STM atomicity. `resource-manager.ts` already uses
  `ReadonlyMap` + `TxReentrantLock`; review for the same treatment.
- Replace `performance.timeOrigin + performance.now()` in `runtime/retry.ts:166`
  with `Clock.currentTimeMillis`.
- Replace `Effect.runSync(Effect.cached(...))` top-level eager eval in
  `server/build-fingerprint.ts:53-54` with `Layer.effect` +
  `Effect.cachedWithTTL`.
- Collapse the `acp-agents/index.ts` dual-path: `buildAcpContributions`
  returns a full contributions bag but `makeAcpAgentsExtension` re-declares
  `agents`/`reactions` literally. Pick one path; delete the other.
- Demote `resolveDualModelPair` from first-class registry method + `Agent`
  facade + `ExtensionAgent` facet to a pure helper over
  `listAgents()`. Delete the method body, both facade entries, both test
  stubs, and the host-error wrapper.
- Rerun the same 8-lane independent audit (verbatim).

**Out**

- Re-opening the field-level yield-don't-thread sweep closed in W33-C1.
- Touching the actor protocol, persistence model, or extension-author
  surface contract.
- App-boundary Node/Bun usage in `apps/tui` / `apps/server`.
- Tagged-union literal hand-rolls in already-correct schemas (no new sites
  observed; locks in `extension-surface-locks.test.ts` cover regressions).

## Constraints

- Correctness over pragmatism.
- No backwards compatibility for the dual-path `acp-agents` extension,
  `hostDeps` bag, or Queue/TxQueue split — personal library, single
  consumer.
- Upstream `effect-encore` changes ship first per item, then the gent
  migration follows in the same commit pair (encore commit → gent commit).
  Each gent commit compiles + passes `bun run gate` standalone.
- High-blast-radius commits split into reviewable sub-commits.
- Counsel after each commit per `feedback_counsel_after_batch`; one revision
  round per `feedback_one_revision_per_commit`.
- Wave 34 cannot close until a fresh independent 8-lane audit reports no
  P0/P1.

## Applicable Skills

- `planify`
- `effect-v4`
- `architecture`
- `test`

## Gate Command

- Standard: `bun run gate`
- Encore-bridging commits: `bun run --cwd ../effect-encore test` (or the
  encore library's gate) + gent `bun run gate`
- Audit-closing commits: focused tests for the affected runtime surface +
  `bun run gate`

## Audit Receipts (carried from W33 final, HEAD `c65bab27`)

### Upstream library DX (Lane 5, deferred from W33-C12)

- `effect-encore`: `getState`/`watchState` lose actor state type; gent
  re-supplies 4 generics at every call site
  (`packages/core/src/runtime/session-runtime.ts:441-456`).
- `effect-encore`: producer-side ops require raw cluster Tags
  (`MessageStorage`, `ActorAddressResolver`, `Sharding`) instead of one
  `Actor.SenderContext` bundle
  (`packages/core/src/runtime/session-runtime.ts:196-217`).
- `effect-encore`: per-handler entityId-decode + storage-facade rewrap is
  hand-rolled (~60 lines) — no `Actor.toLayer({ withScope })`
  (`packages/core/src/runtime/agent/agent-loop.actor.ts:449-516`).
- `effect-encore`: multi-key entityId codec is hand-rolled with collision-
  prone `:` separator
  (`packages/core/src/runtime/agent/agent-loop.entity-id.ts`).
- `effect-encore`: no `Actor.waitForState(predicate)` — gent polls in test
  helpers
  (`packages/core/tests/runtime/agent-loop/helpers.ts:469-486`).

### Yield-don't-thread next granularity (Lane 8 P1)

- `packages/core/src/runtime/session-runtime-context.ts:65-183` —
  `ResolveSessionEnvironmentParams` carries `sessionStorage`/`hostDeps`
  service bag; functions return `Effect<…, never>` yet call
  `params.sessionStorage.getSession(…)`.

### STM alignment (Lane 1 P1)

- `packages/core/src/domain/event.ts:367` — `Queue.unbounded<EventDeliveryJob>`
  should be `TxQueue.unbounded`.
- `packages/extensions/src/acp-agents/protocol.ts:141` —
  `Queue.unbounded<string>` write queue should be `TxQueue.unbounded`.
- `packages/core/src/runtime/agent/agent-loop.session-governance.ts:32` —
  `Ref<Map<string, ReadonlySet<SessionId>>>` should be
  `TxRef<HashMap<…>>` (or `TxRef<HashSet<…>>` keyed differently).
- `packages/core/src/runtime/session-profile.ts:104` —
  `Ref<Map<string, SessionProfile>>` cache should be `TxRef<HashMap<…>>`
  or `Effect.cachedWithTTL`.
- `packages/core/src/runtime/file-index/fallback-adapter.ts:19` —
  `Ref<ReadonlyMap<string, ReadonlyArray<PathMatcher>>>` should be
  `TxRef<HashMap<…>>`.

### Platform / Clock alignment (Lane 3 P1)

- `packages/core/src/runtime/retry.ts:166` —
  `performance.timeOrigin + performance.now()` should be
  `yield* Clock.currentTimeMillis`.
- `packages/core/src/server/build-fingerprint.ts:53-54` —
  `Effect.runSync(Effect.cached(…))` module-top eager eval should be
  `Layer.effect` + `Effect.cachedWithTTL`.

### Extension minimalism residual (Lane 4 P1)

- `packages/extensions/src/acp-agents/index.ts:226-316` —
  `buildAcpContributions` returns a full contributions bag, but
  `makeAcpAgentsExtension` re-declares `agents`/`reactions` literally and
  only delegates `resources`/`externalDrivers`. Dead-codey dual-path.
- `packages/core/src/runtime/extensions/registry.ts:512-514,552-580` —
  `resolveDualModelPair` is a 30-line method on `ExtensionRegistryService`
  for what is `listAgents()` + 2 name lookups + an array slice. Plumbed
  through `Agent` facade (`extension-host-context.ts:60,83`),
  `ExtensionAgent` facet (`extension-services.ts:112,285`),
  `make-extension-host-context.ts:470-473` host-error wrapper, and two test
  stubs (`extension-harness.ts:188`, `extension-host-context.ts:22`). Six
  surfaces deep for one pure function over already-exposed agent data.

## Commit 1: feat(encore): `Actor.waitForState` predicate-driven wait

**Justification**: Gent test helpers poll actor state. Counsel-recommended
first item for W34 because it is additive (no migration risk) and unblocks
the gent helper deletion. Sequencing: easiest item first builds momentum and
exercises the encore release flow before higher-blast-radius API changes.

**Changes** (in `/Users/cvr/Developer/personal/effect-encore/`):

| Library change                            | Change                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Actor.waitForState(entityId, predicate)` | Streams state updates via the existing watch primitive; resolves on first matching snapshot. No timeout option — callers compose `Effect.timeout` if they need one |
| New entry in encore public barrel         | Exports `waitForState`                                                                                                                                             |

After upstream lands, gent migrates:

| Gent site                                                   | Change                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/core/tests/runtime/agent-loop/helpers.ts:469-486` | Replace `waitForPhase` polling helper body with `Actor.waitForState` |

**Verification**

- `effect-encore` library tests (`bun run --cwd ../effect-encore test`)
- Gent: `bun run gate` (helper deletion must not regress agent-loop tests)

## Commit 2: feat(encore): `Actor.SenderContext` requirement bundle

**Justification**: Gent's producer-side ops (`sendUserMessage`, `respondInteraction`)
list `MessageStorage | ActorAddressResolver | Sharding` in their `R` channel
verbatim. Counsel flagged this as the second-easiest item: a type alias
bundle, no runtime change, but it cleans up every producer-call site.

**Changes** (in `/Users/cvr/Developer/personal/effect-encore/`):

| Library change                                           | Change                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| `Actor.SenderContext` exported type alias                | `type SenderContext = MessageStorage \| ActorAddressResolver \| Sharding` |
| Producer-op signatures (`Actor.send`, `Actor.ask`, etc.) | Replace inline union with `SenderContext` in `R`                          |

After upstream lands, gent migrates:

| Gent site                                                       | Change                                                                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/runtime/session-runtime.ts:196-217`          | Replace inline `MessageStorage \| ActorAddressResolver \| Sharding` requirement annotations with `Actor.SenderContext` |
| All `SessionRuntime` method signatures with sender requirements | Same replacement                                                                                                       |

**Verification**

- Encore: `bun run --cwd ../effect-encore test`
- Gent: `bun run gate`

## Commit 3: feat(encore): typed actor state on `defineActor` / `fromEntity`

**Justification**: `getState`/`watchState` currently return `unknown`-ish
state; gent re-supplies 4 generics at every call site. Counsel-recommended
third item because it is a public-API contract change but doesn't reshape
how actors are constructed.

**Changes** (in `/Users/cvr/Developer/personal/effect-encore/`):

| Library change                                                                                          | Change                      |
| ------------------------------------------------------------------------------------------------------- | --------------------------- |
| `defineActor` / `Actor.fromEntity` carry optional `state: { schema: Schema<State>; error?: Schema<E> }` | Typed registration contract |
| `Actor.getState(entityId): Effect<State, E \| ActorNotFound>`                                           | Inferred return             |
| `Actor.watchState(entityId): Stream<State, E \| ActorNotFound>`                                         | Inferred return             |

After upstream lands, gent migrates:

| Gent site                                              | Change                                                                            |
| ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `packages/core/src/runtime/session-runtime.ts:441-456` | Drop the 4 generics at `getState`/`watchState`; inherit from the actor definition |
| `agent-loop.actor.ts` definitions                      | Supply `state: { schema: AgentLoopState }` at `defineActor`/`fromEntity`          |

**Verification**

- Encore: `bun run --cwd ../effect-encore test`
- Gent: `bun run gate`

## Commit 4: feat(encore): `Actor.entityIdCodec` + `fromEntity({ key })`

**Justification**: Gent's hand-rolled multi-key entityId codec uses a `:`
separator that can collide if any field contains `:`. Counsel recommended
landing the codec helper before deciding on `fromEntity({ key })` so
production tests cover collision-safety on the helper alone first.

**Changes** (in `/Users/cvr/Developer/personal/effect-encore/`):

| Library change                               | Change                                                               |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `Actor.entityIdCodec(schema: Schema<Tuple>)` | Typed codec that preserves field boundaries; collision-safe encoding |
| `Actor.fromEntity({ key: Schema<Tuple> })`   | Typed multi-key entity construction; uses the codec internally       |

After upstream lands, gent migrates:

| Gent site                                                 | Change                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/core/src/runtime/agent/agent-loop.entity-id.ts` | Delete hand-rolled codec module; replace with `Actor.entityIdCodec(AgentLoopEntityKey)` re-export |
| All `agentLoopActor.entityId(…)` call sites               | Use typed `fromEntity({ key })` constructor                                                       |

**Verification**

- Encore: `bun run --cwd ../effect-encore test` with focused codec round-trip
  - collision-safety property tests
- Gent: `bun run gate`

## Commit 5: feat(encore): `Actor.toLayer({ withScope })` per-handler scope builder

**Justification**: Gent's `agent-loop.actor.ts:449-516` is ~60 lines of
hand-rolled per-handler entityId-decode + storage-facade rewrap. Counsel
sequenced this last because it changes `toLayer` semantics and gent's
ephemeral wiring — needs the typed state (C3) + codec (C4) landed first so
the new `withScope` signature can refer to typed primitives.

**Changes** (in `/Users/cvr/Developer/personal/effect-encore/`):

| Library change                                                                        | Change                                                                                                  |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `Actor.toLayer({ withScope: (address: ActorAddress<Key>) => Effect<Context<S>, …> })` | Per-actor-instance scope context builder                                                                |
| Layer composition contract                                                            | Built context merges with the layer-provided baseline; addresses typed by the entity key schema from C4 |

After upstream lands, gent migrates:

| Gent site                                                          | Change                                                                                                            |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/runtime/agent/agent-loop.actor.ts:449-516`      | Replace the 60-line block with `Actor.toLayer({ withScope: (address) => makeBranchContext(address) })`; one-liner |
| `packages/core/src/runtime/agent/agent-runner.ts` ephemeral wiring | Verify the parent-context-snapshot pattern still composes; adjust if `withScope` changes layer-memoization        |

**Verification**

- Encore: `bun run --cwd ../effect-encore test` with focused `withScope`
  layer-composition tests
- Gent: `bun run gate` + targeted agent-loop runtime tests

## Commit 6: refactor(runtime): yield session-storage + extension-host deps in session-runtime-context

**Justification**: Largest residual yield-don't-thread debt from the W33
final audit. `ResolveSessionEnvironmentParams` carries
`sessionStorage`/`hostDeps` as parameter fields; functions yield
context-resolvable tags from those fields instead of from `R`. This is the
"next granularity" beyond the field-level sweep that W33-C1 closed.

**Changes**:

| Site                                                                                                  | Change                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/runtime/session-runtime-context.ts:65-91`                                          | Delete `hostDeps` field from `MakeExtensionEnvironmentParams` and `ResolveSessionEnvironmentParams`. `extensionRegistry`/`capabilityContext` yield via `ExtensionRegistry` / `CapabilityContext` Tags inside the function body. |
| `packages/core/src/runtime/session-runtime-context.ts:119-127`                                        | Delete `sessionStorage` field from `ResolveSessionEnvironmentParams`. `resolveExistingSessionBranch` / `resolveSessionEnvironment` yield `yield* SessionStorage` inside; surface in `R`.                                        |
| `packages/core/src/runtime/session-runtime-context.ts:130-183`                                        | All callers (`resolveSessionEnvironmentForExistingSession`, etc.) update to drop the field; `R` channel widens to include `SessionStorage \| ExtensionRegistry \| …`.                                                           |
| Callers (`server/session-commands.ts`, `runtime/session-runtime.ts`, `runtime/agent/agent-runner.ts`) | Drop the parameter-bag construction; let the `R` channel surface the requirement and resolve at the layer boundary.                                                                                                             |

**Sub-commits** (high-blast-radius — see `feedback_subcommit_high_blast`):

- C6.1 — drop `sessionStorage` field; yield `SessionStorage` inside.
- C6.2 — drop `hostDeps` field; yield `ExtensionRegistry` / `CapabilityContext` / etc. inside.
- C6.3 — caller-side cleanup; verify no remaining param-bag threading.

**Verification per sub-commit**

- `bun run gate`
- Focused: `bun run test packages/core/tests/runtime/session-runtime-context.test.ts`
  (or equivalent)

## Commit 7: refactor(runtime): `Queue` → `TxQueue` for STM-native event + ACP write queues

**Justification**: Both call sites compose downstream with STM (`TxRef`,
`TxQueue` in the publisher fiber); the legacy `Queue` adds an interop hop.
Mechanical migration; not a correctness bug at HEAD, but the project leans
`TxQueue` for new code.

**Changes**:

| Site                                                 | Change                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/domain/event.ts:367`              | `Queue.unbounded<EventDeliveryJob>` → `TxQueue.unbounded<EventDeliveryJob>`; update consumer offer/take call sites |
| `packages/extensions/src/acp-agents/protocol.ts:141` | `Queue.unbounded<string>` write queue → `TxQueue.unbounded<string>`                                                |

**Verification**

- `bun run gate`
- Focused: event-store + acp-agents acceptance tests must pass under
  interruption (existing coverage)

## Commit 8: refactor(runtime): `Ref<Map>` → `TxRef<HashMap>` for STM atomicity

**Justification**: Three runtime sites use `Ref<Map<…>>` copy-on-write where
the rest of the runtime composes via STM. Promoting to `TxRef<HashMap>`
gives STM-atomic compound updates and removes the copy-on-write idiom.

**Changes**:

| Site                                                                  | Change                                                                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/runtime/agent/agent-loop.session-governance.ts:32` | `Ref<Map<string, ReadonlySet<SessionId>>>` → `TxRef<HashMap<string, HashSet<SessionId>>>`                                |
| `packages/core/src/runtime/session-profile.ts:104`                    | `Ref<Map<string, SessionProfile>>` cache → `TxRef<HashMap<…>>` (or `Effect.cachedWithTTL` if the cache is single-source) |
| `packages/core/src/runtime/file-index/fallback-adapter.ts:19`         | `Ref<ReadonlyMap<string, ReadonlyArray<PathMatcher>>>` → `TxRef<HashMap<string, ReadonlyArray<PathMatcher>>>`            |

**Sub-commits**:

- C8.1 — `agent-loop.session-governance.ts`
- C8.2 — `session-profile.ts`
- C8.3 — `file-index/fallback-adapter.ts`

**Verification per sub-commit**

- `bun run gate`

## Commit 9: refactor(runtime): replace `performance.timeOrigin` with `Clock.currentTimeMillis`

**Justification**: One-line platform alignment. `performance.timeOrigin +
performance.now()` reaches around the Effect `Clock` service that the rest
of the runtime composes with (and that `TestClock.layer()` shims in tests).

**Changes**:

| Site                                     | Change                                                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/runtime/retry.ts:166` | `const nowMs = performance.timeOrigin + performance.now()` → `const nowMs = yield* Clock.currentTimeMillis` (function becomes a generator if not already) |

**Verification**

- `bun run gate`
- Focused: retry tests must be `TestClock`-controllable post-change (existing
  pattern from `LanguageModelLayers.debug({ delayMs })`)

## Commit 10: refactor(server): move `build-fingerprint` off module-top `runSync`

**Justification**: `Effect.runSync(Effect.cached(...))` at module top is
fragile — it eagerly evaluates at import time, races with platform setup,
and is invisible to Effect's tracing/scope. Move to `Layer.effect` +
`Effect.cachedWithTTL` so the fingerprint is a regular service.

**Changes**:

| Site                                                  | Change                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/server/build-fingerprint.ts:53-54` | Drop `export const computeLocalFingerprint = Effect.runSync(Effect.cached(...))`. Replace with a `BuildFingerprint` service Tag + `Layer.effect` that constructs `Effect.cachedWithTTL(computeLocalFingerprintUncached, "1 hour")`. Update the single importer to `yield* BuildFingerprint`. |

**Verification**

- `bun run gate`
- Focused: fingerprint identity stable across multiple yields (covered by
  `Effect.cached`/`cachedWithTTL` semantics)

## Commit 11: refactor(extensions): collapse `acp-agents` dual-path extension definition

**Justification**: `buildAcpContributions` returns a full contributions bag
but `makeAcpAgentsExtension` re-declares `agents`/`reactions` literally and
only delegates `resources`/`externalDrivers`. Dual-path is dead-codey:
either the contributions bag is the source of truth, or the literal
declaration is. Pick one.

**Changes**:

| Site                                                     | Change                                                                                                                                                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/extensions/src/acp-agents/index.ts:226-316`    | Pick the literal-declaration path (matches every other shipped extension's `defineExtension` shape); inline `buildAcpContributions`'s body into `makeAcpAgentsExtension`. Delete `buildAcpContributions`. |
| (Alternative if the contributions-bag path is preferred) | Delete the literal re-declarations in `makeAcpAgentsExtension`; spread the contributions bag into `defineExtension`.                                                                                      |

Decision is single-call-site, made at commit time after re-reading both
paths — no design ambiguity worth surfacing.

**Verification**

- `bun run gate`
- Focused: acp-agents acceptance tests + the extension surface lock test in
  `packages/core/tests/extensions/extension-surface-locks.test.ts`

## Commit 12: refactor(extensions): demote `resolveDualModelPair` to a pure helper

**Justification**: `resolveDualModelPair` is plumbed through six surfaces
(`ExtensionRegistryService` method body, `Agent` facade, `ExtensionAgent`
facet, `make-extension-host-context.ts` host-error wrapper, two test stubs)
for what is `listAgents()` + 2 name lookups + an array slice over data the
registry already exposes. First-class registry methods are reserved for ops
that need privileged access to resolved-extension state; this one doesn't.

**Changes**:

| Site                                                                                                                                                         | Change                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New `packages/extensions/src/internal/resolve-dual-model-pair.ts` (or `packages/core/src/domain/agent-pair.ts` if shared with `auth.ts`)                     | Pure helper: `resolveDualModelPair(agents: ReadonlyArray<AgentDefinition>): Effect<[ModelId, ModelId], NoModeledAgentsError>`. Same algorithm as the current method body. Plain function over already-resolved data; no service Tag. |
| `packages/core/src/runtime/extensions/registry.ts:512-514,552-580`                                                                                           | Delete `resolveDualModelPair` from `ExtensionRegistryService` interface and `fromResolved` implementation.                                                                                                                           |
| `packages/core/src/domain/extension-host-context.ts:60,83`                                                                                                   | Delete `resolveDualModelPair` from `Agent` host service shape.                                                                                                                                                                       |
| `packages/core/src/domain/extension-services.ts:112,285`                                                                                                     | Delete `resolveDualModelPair` from `ExtensionAgent` facet.                                                                                                                                                                           |
| `packages/core/src/runtime/make-extension-host-context.ts:470-473`                                                                                           | Delete the host-error wrapper.                                                                                                                                                                                                       |
| `packages/core/src/test-utils/extension-harness.ts:188`, `extension-host-context.ts:22`                                                                      | Delete the test stubs.                                                                                                                                                                                                               |
| 5 tool consumers — `plan-tool.ts:135`, `review/review-tool.ts:250`, `research/research-tool.ts:155`, `counsel/counsel-tool.ts:79`, `audit/audit-tool.ts:224` | Replace `yield* ctx.Agent.resolveDualModelPair()` with `const agents = yield* ctx.Agent.listAgents(); const [a, b] = yield* resolveDualModelPair(agents)`.                                                                           |
| `packages/core/src/domain/auth.ts:260`                                                                                                                       | Same migration: yield `extensionRegistry.listAgents()`, call the helper.                                                                                                                                                             |
| Error surface                                                                                                                                                | `ExtensionRegistryError`'s `"resolveDualModelPair"` op variant deletes; new helper surfaces `NoModeledAgentsError` (or reuses an existing schema-error). Update `auth.ts:260` `Effect.exit` handling to the new error type.          |

**Verification**

- `bun run gate`
- Focused: review-tool / plan-tool acceptance tests (both depend on the pair
  helper); auth-guard tests for the modified `requiredProviders` branch.

## Final Batch: Independent Recursive Audit

Same 8 lanes as Wave 32 / Wave 33 final batch (verbatim — DO NOT alter the
questions), **plus one new lane (lane 9) introduced in Wave 34**:

1. How can we simplify and minimize our codebase while maintaining features? how can we reduce code as much as possible? are we using effect properly? are we redeclaring types, schemas, features that effect natively provides via effect/unstable/ai or STM with txQueue etc?
2. are we following the actor model properly?
3. are we using bun/node platform code directly and not creating service layers for maximum portability and testability? GentPlatform etc?
4. is our extension system as minimal yet expressive as can be? compared to other harnesses that i mentioned - expressive enough to implement our current extensions, but more minimal? rearchitetcing completely is acceptable. this codebase is experimental, complete rerwites are fine of our schemas, types, assumptions - correctness, minimalism, is the goal within the effect ecosystem.
5. we own effect-machine, effect-encore, effect-wide-event - can we improve these upstream so that DX is better? are there other libraries we can make to abstract certain concepts that better align with our north star (actor model).
6. do files merit their existence? prefer bigger cohesive files when a split does not encode a real boundary, public entrypoint, platform boundary, independently testable domain, generated fixture, or meaningful multi-import reuse.
7. does the extension authoring experience follow this spirit: it should be simple to author extensions by creating facades over private things through `yield* ExtensionContext`; no ctx parameters, no privileged builtin API, and no capability/read/write ceremony when access can be expressed in code by accessing what is needed from ctx.
8. are any helpers, resource layers, or service factories accepting Effect-context-resolvable values (ExtensionContext, ExtensionContext.Process, ExtensionProcess, ExtensionSession, FileSystem, etc.) as **parameters** instead of yielding them from context? Threading context as parameters is a P1 — services and helpers must yield via `yield* Tag` and surface the requirement in their `R` channel.
9. what have we promoted to first class that should just be composed from primitives? walk every service Tag, registry method, host-context facade entry, and `ExtensionContext` facet (`ExtensionAgent`, `ExtensionSession`, `ExtensionFiles`, `ExtensionState`, `ExtensionFileLock`, `ExtensionInteraction`, `ExtensionProcess`) and ask: does this method need privileged access to internal state, or is it a pure function over data the surface already exposes? If it's the latter, it should be a plain helper that calls `listX()` / `getY()` and composes — not a method baked into the service contract. Plumbing a one-line helper through six surfaces (interface → impl → facade → facet → host-error wrapper → test stub) is a P0 against the "composable primitives" north star (see `~/.brain/principles/composition-over-flags.md`, `~/.brain/principles/small-interface-deep-implementation.md`, `~/.brain/principles/subtract-before-you-add.md`). The C12 demotion of `resolveDualModelPair` is the worked example; assume more exist.

Run all 9 lanes as parallel Explore agents. Consolidate full P0/P1 punch
list when all report. Close Wave 34 only after the audit reports no P0/P1; if
it finds P1s, synthesize Wave 35 and continue.
