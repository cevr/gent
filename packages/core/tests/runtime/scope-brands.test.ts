/**
 * Type-level tests for scope brands.
 *
 * Each `// @ts-expect-error` proves a cross-scope or proof-of-origin
 * violation is caught at compile time. Removing the brand from the
 * relevant API would silently flip these to "unused expect-error", and
 * `bun run typecheck` would fail — so the file doubles as a guardrail.
 *
 * Suppression note: the few casts in this file are deliberate test-fixture
 * debt. Production scope-brand escapes are fenced by `gent/brand-constructor-callers`
 * and `gent/no-scope-brand-cast`.
 */
import { describe, test, expect } from "bun:test"
import { Effect, Exit, Layer, Context, Scope, type Config } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  type CwdProfile,
  type EphemeralProfile,
  type ServerProfile,
  ServerProfileService,
} from "../../src/runtime/scope-brands"
import { buildEphemeralRuntime, type EphemeralRuntimeOverrides } from "../../src/runtime/composer"
import { runWithBuiltLayer } from "../../src/runtime/run-with-built-layer"
import { SessionStorage } from "@gent/core/storage/session-storage"
import { BranchStorage } from "@gent/core/storage/branch-storage"
import { MessageStorage } from "@gent/core/storage/message-storage"
import { EventStorage } from "@gent/core/storage/event-storage"
import { RelationshipStorage } from "@gent/core/storage/relationship-storage"
import { StorageTransaction } from "../../src/storage/storage-transaction"
import { CheckpointStorage } from "@gent/core/storage/checkpoint-storage"
import { InteractionStorage } from "@gent/core/storage/interaction-storage"
import { InteractionPendingReader } from "@gent/core/storage/interaction-pending-reader"
import { SearchStorage } from "@gent/core/storage/search-storage"
import { BuiltinEventSink, EventPublisher } from "@gent/core/domain/event-publisher"
import { EventStore } from "@gent/core/domain/event"
import { ApprovalService } from "../../src/runtime/approval-service"
import { PromptPresenter } from "../../src/domain/prompt-presenter"
import { ResourceManager } from "../../src/runtime/resource-manager"
import { ToolRunner } from "../../src/runtime/agent/tool-runner"
import { SessionRuntime } from "../../src/runtime/session-runtime"
import { RuntimePlatform, type RuntimePlatformShape } from "../../src/runtime/runtime-platform"
import { ConfigService, type ConfigServiceService } from "../../src/runtime/config-service"
import type { StorageError } from "../../src/domain/storage-error"

class FakeService extends Context.Service<FakeService, { readonly value: number }>()(
  "@gent/core/tests/runtime/scope-brands.test/FakeService",
) {}

type RuntimeBuildError = StorageError | Config.ConfigError
type LayerError<L> = L extends Layer.Layer<unknown, infer E, unknown> ? E : never
type IsEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type ExpectTrue<T extends true> = T

describe("scope brand type fences", () => {
  const serverParent = {
    cwd: "/tmp",
    resolved: { kinds: {} } as never,
    __brand: undefined as never,
  } as ServerProfile

  const parentServices = Context.empty() as Context.Context<never>

  const storageOverride = () =>
    Layer.mergeAll(
      Layer.succeed(SqlClient.SqlClient, { sentinel: "child-sql" } as never),
      Layer.succeed(SessionStorage, { sentinel: "child-session" } as never),
      Layer.succeed(BranchStorage, { sentinel: "child-branch" } as never),
      Layer.succeed(MessageStorage, { sentinel: "child-message" } as never),
      Layer.succeed(EventStorage, { sentinel: "child-event" } as never),
      Layer.succeed(RelationshipStorage, { sentinel: "child-relationship" } as never),
      Layer.succeed(StorageTransaction, { sentinel: "child-transaction" } as never),
      Layer.succeed(CheckpointStorage, { sentinel: "child-checkpoint" } as never),
      Layer.succeed(InteractionStorage, { sentinel: "child-interaction" } as never),
      Layer.succeed(InteractionPendingReader, { sentinel: "child-pending" } as never),
      Layer.succeed(SearchStorage, { sentinel: "child-search" } as never),
    )

  const baseOverrides = () => ({
    storage: storageOverride(),
    eventStore: Layer.succeed(EventStore, { sentinel: "child-event-store" } as never),
    eventPublisher: Layer.effectContext(
      Effect.succeed(
        Context.empty().pipe(
          Context.add(EventPublisher, { sentinel: "child-publisher" } as never),
          Context.add(BuiltinEventSink, { sentinel: "child-sink" } as never),
        ),
      ),
    ),
    approval: Layer.succeed(ApprovalService, { sentinel: "child-approval" } as never),
    promptPresenter: Layer.succeed(PromptPresenter, { sentinel: "child-presenter" } as never),
    resourceManager: Layer.succeed(ResourceManager, { sentinel: "child-resource" } as never),
    toolRunner: Layer.succeed(ToolRunner, { sentinel: "child-tool-runner" } as never),
    sessionRuntime: Layer.succeed(SessionRuntime, { sentinel: "child-session-runtime" } as never),
  })

  test("buildEphemeralRuntime rejects a CwdProfile parent", () => {
    // Build a fake parent context (any context for the call shape; the
    // brand check happens on the `parent` field).
    const okRuntime = buildEphemeralRuntime({
      parent: serverParent,
      parentServices,
      overrides: baseOverrides(),
    })
    expect(okRuntime).toBeDefined()

    // Invalid: CwdProfile is structurally distinct (different brand).
    const cwdParent = {
      cwd: "/tmp",
      resolved: { kinds: {} } as never,
      __brand: undefined as never,
    } as CwdProfile
    const _bad = buildEphemeralRuntime({
      // @ts-expect-error — CwdProfile cannot satisfy `parent: ServerProfile`
      parent: cwdParent,
      parentServices,
      overrides: baseOverrides(),
    })
    void _bad
  })

  test("buildEphemeralRuntime rejects an EphemeralProfile parent", () => {
    const ephemeralParent = {
      cwd: "/tmp",
      resolved: { kinds: {} } as never,
      __brand: undefined as never,
    } as EphemeralProfile
    const _bad = buildEphemeralRuntime({
      // @ts-expect-error — EphemeralProfile cannot satisfy `parent: ServerProfile`
      parent: ephemeralParent,
      parentServices,
      overrides: baseOverrides(),
    })
    void _bad
  })

  test("ServerProfileService.Test layer is constructable for tests", () => {
    const layer = ServerProfileService.Test("/test-cwd")
    expect(layer).toBeDefined()
    return Effect.runPromise(
      Effect.gen(function* () {
        const profile = yield* ServerProfileService
        expect(profile.cwd).toBe("/test-cwd")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("explicit override service identifiers are in the built layer's `Provides` channel", () => {
    const storageLayer = storageOverride()
    const composed = buildEphemeralRuntime({
      parent: serverParent,
      parentServices,
      overrides: { ...baseOverrides(), storage: storageLayer },
    })

    // Type-only assertion: the resulting layer's `Provides` channel
    // includes focused storage. If the explicit runtime builder dropped the override
    // family type, this satisfaction check would fail to compile.
    const _typed: Layer.Layer<SessionStorage, RuntimeBuildError, never> = composed.layer
    void _typed
    const _errorChannel: ExpectTrue<IsEqual<LayerError<typeof composed.layer>, RuntimeBuildError>> =
      true
    void _errorChannel
    const _overrides: EphemeralRuntimeOverrides = baseOverrides()
    void _overrides
    expect(composed.profile.cwd).toBe("/tmp")
  })

  test("ephemeral storage override rejects layers missing focused storage services", () => {
    const _badOverrides: EphemeralRuntimeOverrides = {
      ...baseOverrides(),
      // @ts-expect-error — storage override must provide the full child-owned storage family
      storage: Layer.empty,
    }
    void _badOverrides
  })

  test("ephemeral extension layers receive child-owned SqlClient and parent services", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        class ExtensionSqlProbe extends Context.Service<
          ExtensionSqlProbe,
          {
            readonly sql: unknown
            readonly platform: RuntimePlatformShape
            readonly config: ConfigServiceService
          }
        >()("@gent/core/tests/runtime/scope-brands.test/ExtensionSqlProbe") {}

        const parentSql = { sentinel: "parent-sql" } as never
        const parentPlatform = RuntimePlatform.of({
          cwd: "/parent-cwd",
          home: "/parent-home",
          platform: "parent-platform",
        })
        const parentConfig: ConfigServiceService = {
          get: () => Effect.succeed({} as never),
          set: () => Effect.void,
          getPermissionRules: () => Effect.succeed([]),
          addPermissionRule: () => Effect.void,
          removePermissionRule: () => Effect.void,
          setDriverOverride: () => Effect.void,
          clearDriverOverride: () => Effect.void,
          loadInstructions: () => Effect.succeed("parent instructions"),
        }
        const parentServicesWithDependencies = Context.empty().pipe(
          Context.add(SqlClient.SqlClient, parentSql),
          Context.add(RuntimePlatform, parentPlatform),
          Context.add(ConfigService, parentConfig),
        ) as Context.Context<never>

        const extensionLayer = Layer.effect(
          ExtensionSqlProbe,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const platform = yield* RuntimePlatform
            const config = yield* ConfigService
            return { sql, platform, config }
          }),
        )

        const composed = buildEphemeralRuntime({
          parent: serverParent,
          parentServices: parentServicesWithDependencies,
          overrides: baseOverrides(),
          extensionLayers: extensionLayer,
        })

        const probe = yield* Layer.build(composed.layer).pipe(
          Effect.scoped,
          Effect.map((ctx) => Context.get(ctx, ExtensionSqlProbe)),
        )

        expect((probe.sql as { sentinel: string }).sentinel).toBe("child-sql")
        expect(probe.platform.platform).toBe("parent-platform")
        expect(yield* probe.config.loadInstructions("/tmp")).toBe("parent instructions")
      }),
    ))

  test("runWithBuiltLayer satisfies the built layer's services and leaves only scope", () => {
    const fakeLayer = Layer.succeed(FakeService, { value: 42 })
    const consumer = Effect.gen(function* () {
      const service = yield* FakeService
      return service.value
    })

    const provided = runWithBuiltLayer(fakeLayer)(consumer)
    const _typed: Effect.Effect<number, never, Scope.Scope> = provided
    void _typed

    return Effect.runPromise(
      Effect.gen(function* () {
        const value = yield* Effect.scoped(provided)
        expect(value).toBe(42)
      }),
    )
  })

  test("ephemeral storage override replaces focused storage sub-Tags", () =>
    // Construct a parent context with SessionStorage + InteractionPendingReader.
    // After the storage override family is applied, the parent's versions must
    // be stripped. Otherwise ephemeral subagents read parent durable
    // interactions while writing to a fresh in-memory store.
    Effect.runPromise(
      Effect.gen(function* () {
        const sentinelSession = { sentinel: "parent-session" } as never
        const sentinelPending = { sentinel: "parent-pending" } as never
        const parentServices = Context.empty().pipe(
          Context.add(SessionStorage, sentinelSession),
          Context.add(InteractionPendingReader, sentinelPending),
        ) as Context.Context<never>

        const childStorageLayer = storageOverride()

        const composed = buildEphemeralRuntime({
          parent: serverParent,
          parentServices,
          overrides: { ...baseOverrides(), storage: childStorageLayer },
        })

        const session = yield* Layer.build(composed.layer).pipe(
          Effect.scoped,
          Effect.map((ctx) => Context.get(ctx, SessionStorage)),
        )
        expect((session as unknown as { sentinel: string }).sentinel).toBe("child-session")

        const pending = yield* Layer.build(composed.layer).pipe(
          Effect.scoped,
          Effect.map((ctx) => Context.get(ctx, InteractionPendingReader)),
        )
        expect((pending as unknown as { sentinel: string }).sentinel).toBe("child-pending")
      }),
    ))

  test("ephemeral event publisher override treats EventPublisher and BuiltinEventSink as one family", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const parentPublisher = EventPublisher.of({
          append: () => Effect.die("parent append should be omitted"),
          deliver: () => Effect.die("parent deliver should be omitted"),
          publish: () => Effect.die("parent publish should be omitted"),
        })
        const parentServices = Context.empty().pipe(
          Context.add(EventPublisher, parentPublisher),
          Context.add(BuiltinEventSink, {
            publish: () => Effect.die("parent builtin sink should be omitted"),
          }),
        ) as Context.Context<never>

        const childPublisher = EventPublisher.of({
          append: () => Effect.die("child append is unused"),
          deliver: () => Effect.void,
          publish: () => Effect.void,
        })
        const childEventPublisherLayer = Layer.effectContext(
          Effect.succeed(
            Context.empty().pipe(
              Context.add(EventPublisher, childPublisher),
              Context.add(BuiltinEventSink, {
                publish: childPublisher.publish,
              }),
            ),
          ),
        )

        const composed = buildEphemeralRuntime({
          parent: serverParent,
          parentServices,
          overrides: { ...baseOverrides(), eventPublisher: childEventPublisherLayer },
        })

        const { publisher, sink } = yield* Effect.gen(function* () {
          const publisher = yield* EventPublisher
          const sink = yield* BuiltinEventSink
          return { publisher, sink }
        }).pipe(Effect.provide(composed.layer))

        expect(publisher).toBe(childPublisher)
        expect(sink.publish).toBe(childPublisher.publish)
      }),
    ))

  test("ephemeral runtime layer attaches override-layer finalizers to the build scope", () =>
    // Contract: `Effect.scoped` at the runner site is load-bearing only
    // because the explicit runtime builder attaches override-layer finalizers
    // to whatever scope `Layer.buildWithScope` is invoked with.
    // Asserting the scope-close ↔ finalizer-runs invariant directly: if the
    // builder's `Layer.fresh` wrapper, override flow, or merge order
    // ever stripped finalizers, the in-memory storage / event-store /
    // approval-service handles would leak across ephemeral runs.
    Effect.runPromise(
      Effect.gen(function* () {
        const events: Array<string> = []
        const scopedSessionLayer = Layer.effect(
          SessionStorage,
          Effect.gen(function* () {
            events.push("acquired")
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                events.push("finalized")
              }),
            )
            return { sentinel: "child-storage" } as never
          }),
        )
        const scopedStorageLayer = Layer.merge(storageOverride(), scopedSessionLayer)

        const composed = buildEphemeralRuntime({
          parent: serverParent,
          parentServices,
          overrides: { ...baseOverrides(), storage: scopedStorageLayer },
        })

        // Build under an explicit scope, then close it. Acquisition runs at
        // build; the finalizer must run at scope close. If the runtime builder
        // dropped finalizers anywhere along the build path, only "acquired"
        // would land.
        const scope = yield* Scope.make()
        yield* Layer.buildWithScope(composed.layer, scope)
        expect(events).toEqual(["acquired"])
        yield* Scope.close(scope, Exit.succeed(void 0))
        expect(events).toEqual(["acquired", "finalized"])
      }).pipe(Effect.timeout("2 seconds")),
    ))

  test("provide(layer) leaves a missing-service requirement in `R` for unprovided consumers", () => {
    // This is the type-level guarantee the runtime builder claims: a consumer
    // that requires a service NOT in `Provides` has its `R` channel left
    // unsatisfied. Effect's `provide` subtracts only the layer's `Success`
    // channel from the consumer's `R`.
    const storageLayer = storageOverride()
    const composed = buildEphemeralRuntime({
      parent: serverParent,
      parentServices,
      overrides: { ...baseOverrides(), storage: storageLayer },
    })

    class OtherService extends Context.Service<OtherService, { readonly other: string }>()(
      "@gent/core/tests/runtime/scope-brands.test/OtherService",
    ) {}

    // Consumer requires OtherService, which the runtime builder's layer does NOT
    // provide. After `Effect.provide(composed.layer)`, R must still contain
    // OtherService.
    const consumer = Effect.gen(function* () {
      const o = yield* OtherService
      return o.other
    })
    const provided = consumer.pipe(Effect.provide(composed.layer))

    // Type-only: the resulting effect must still require OtherService.
    const _typed: Effect.Effect<string, RuntimeBuildError, OtherService> = provided
    void _typed

    expect(composed.profile.cwd).toBe("/tmp")
  })

  test("ephemeral runtime strips the parent memo map from forwarded context", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test reaches internal Effect layer key
        const memoKey = Layer.CurrentMemoMap as unknown as Context.Key<unknown, unknown>
        const parentMemo = { sentinel: "parent-memo-map" }
        const parentServicesWithMemo = Context.add(
          parentServices,
          memoKey,
          parentMemo as never,
        ) as Context.Context<never>

        const composed = buildEphemeralRuntime({
          parent: serverParent,
          parentServices: parentServicesWithMemo,
          overrides: baseOverrides(),
        })

        const memo = yield* Effect.serviceOption(memoKey).pipe(Effect.provide(composed.layer))
        expect(memo._tag).toBe("Some")
        if (memo._tag === "Some") {
          expect(memo.value).not.toBe(parentMemo)
        }
      }),
    ))
})
