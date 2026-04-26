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
import { Effect, Layer, Context, type Scope } from "effect"
import {
  type CwdProfile,
  type EphemeralProfile,
  type ServerProfile,
  ServerProfileService,
} from "../../src/runtime/scope-brands"
import { RuntimeComposer, ownService } from "../../src/runtime/composer"
import { runWithBuiltLayer } from "../../src/runtime/run-with-built-layer"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { SessionStorage } from "@gent/core/storage/session-storage"
import { BranchStorage } from "@gent/core/storage/branch-storage"
import { MessageStorage } from "@gent/core/storage/message-storage"
import { EventStorage } from "@gent/core/storage/event-storage"
import { RelationshipStorage } from "@gent/core/storage/relationship-storage"
import { ExtensionStateStorage } from "@gent/core/storage/extension-state-storage"
import { InteractionPendingReader } from "@gent/core/storage/interaction-pending-reader"
import { BuiltinEventSink, EventPublisher } from "@gent/core/domain/event-publisher"

class FakeService extends Context.Service<FakeService, { readonly value: number }>()(
  "@gent/core/tests/scope-brands/FakeService",
) {}

describe("scope brand type fences", () => {
  test("RuntimeComposer.ephemeral rejects a CwdProfile parent", () => {
    // Build a fake parent context (any context for the call shape; the
    // brand check happens on the `parent` field).
    const parentServices = Context.empty() as Context.Context<never>

    // Valid: ServerProfile is accepted.
    const serverParent = {
      cwd: "/tmp",
      resolved: { kinds: {} } as never,
      __brand: undefined as never,
    } as ServerProfile
    const okBuilder = RuntimeComposer.ephemeral({ parent: serverParent, parentServices })
    expect(okBuilder).toBeDefined()

    // Invalid: CwdProfile is structurally distinct (different brand).
    const cwdParent = {
      cwd: "/tmp",
      resolved: { kinds: {} } as never,
      __brand: undefined as never,
    } as CwdProfile
    // @ts-expect-error — CwdProfile cannot satisfy `parent: ServerProfile`
    const _bad = RuntimeComposer.ephemeral({ parent: cwdParent, parentServices })
    void _bad
  })

  test("RuntimeComposer.ephemeral rejects an EphemeralProfile parent", () => {
    const parentServices = Context.empty() as Context.Context<never>
    const ephemeralParent = {
      cwd: "/tmp",
      resolved: { kinds: {} } as never,
      __brand: undefined as never,
    } as EphemeralProfile
    // @ts-expect-error — EphemeralProfile cannot satisfy `parent: ServerProfile`
    const _bad = RuntimeComposer.ephemeral({ parent: ephemeralParent, parentServices })
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

  test("composer's owned service identifier is in the built layer's `Provides` channel", () => {
    const parentServices = Context.empty() as Context.Context<never>
    const serverParent = {
      cwd: "/tmp",
      resolved: { kinds: {} } as never,
      __brand: undefined as never,
    } as ServerProfile

    const fakeLayer = Layer.succeed(FakeService, { value: 42 })
    const composed = RuntimeComposer.ephemeral({ parent: serverParent, parentServices })
      .own(ownService(FakeService, fakeLayer))
      .build()

    // Type-only assertion: the resulting layer's `Provides` channel
    // includes `FakeService`. If the composer dropped the type
    // accumulation, this satisfaction check would fail to compile.
    const _typed: Layer.Layer<FakeService, never, never> = composed.layer
    void _typed
    expect(composed.profile.cwd).toBe("/tmp")
  })

  test("runWithBuiltLayer satisfies the built layer's services and leaves only scope", () => {
    const fakeLayer = Layer.succeed(FakeService, { value: 42 })
    const consumer = Effect.gen(function* () {
      const service = yield* FakeService
      return service.value
    })

    const provided = runWithBuiltLayer(fakeLayer)(consumer)
    const _typed: Effect.Effect<number, never, Scope.Scope> = provided
    void _typed

    return Effect.runPromise(Effect.scoped(provided)).then((value) => {
      expect(value).toBe(42)
    })
  })

  test("withOverrides omits Storage sub-Tags from parent context", () => {
    // Construct a parent context with Storage + SessionStorage +
    // InteractionPendingReader. After withOverrides({ storage: ... }),
    // the parent's versions must be stripped — the child's in-memory
    // layer should win, and InteractionPendingReader from the parent
    // (which is bound to the parent's interaction store) must NOT
    // leak through. Otherwise ephemeral subagents read parent's
    // durable interactions while writing to a fresh in-memory store.
    return Effect.runPromise(
      Effect.gen(function* () {
        // Build a parent with a sentinel Storage + SessionStorage
        // + InteractionPendingReader.
        const sentinelStorage = { sentinel: "parent-storage" } as never
        const sentinelSession = { sentinel: "parent-session" } as never
        const sentinelPending = { sentinel: "parent-pending" } as never
        const parentServices = Context.empty().pipe(
          Context.add(Storage, sentinelStorage),
          Context.add(SessionStorage, sentinelSession),
          Context.add(InteractionPendingReader, sentinelPending),
        ) as Context.Context<never>

        const serverParent = {
          cwd: "/tmp",
          resolved: { kinds: {} } as never,
          __brand: undefined as never,
        } as ServerProfile

        const childStorageLayer = Layer.succeed(Storage, { sentinel: "child-storage" } as never)

        const composed = RuntimeComposer.ephemeral({ parent: serverParent, parentServices })
          .withOverrides({ storage: childStorageLayer })
          .build()

        // Resolve Storage from the composed layer — should be the child's
        const result = yield* Effect.gen(function* () {
          return yield* Storage
        }).pipe(Effect.provide(composed.layer))

        // Should be child's, not parent's
        expect((result as unknown as { sentinel: string }).sentinel).toBe("child-storage")

        // All 6 sub-Tags should NOT be present (omitted from parent,
        // not provided by child's layer). The child only provided
        // Storage, not the sub-Tags. The key test: sub-Tags from the
        // PARENT were stripped by the OVERRIDE_TAG_SETS omit-set.
        const omitted = (r: { _tag: string }) => expect(r._tag).toBe("None")
        omitted(yield* Effect.serviceOption(SessionStorage).pipe(Effect.provide(composed.layer)))
        omitted(yield* Effect.serviceOption(BranchStorage).pipe(Effect.provide(composed.layer)))
        omitted(yield* Effect.serviceOption(MessageStorage).pipe(Effect.provide(composed.layer)))
        omitted(yield* Effect.serviceOption(EventStorage).pipe(Effect.provide(composed.layer)))
        omitted(
          yield* Effect.serviceOption(RelationshipStorage).pipe(Effect.provide(composed.layer)),
        )
        omitted(
          yield* Effect.serviceOption(ExtensionStateStorage).pipe(Effect.provide(composed.layer)),
        )
        omitted(
          yield* Effect.serviceOption(InteractionPendingReader).pipe(
            Effect.provide(composed.layer),
          ),
        )
      }),
    )
  })

  test("withOverrides treats EventPublisher and BuiltinEventSink as one override family", () => {
    return Effect.runPromise(
      Effect.gen(function* () {
        const parentPublisher = EventPublisher.of({
          append: () => Effect.die("parent append should be omitted"),
          deliver: () => Effect.die("parent deliver should be omitted"),
          publish: () => Effect.die("parent publish should be omitted"),
          terminateSession: () => Effect.die("parent terminate should be omitted"),
        })
        const parentServices = Context.empty().pipe(
          Context.add(EventPublisher, parentPublisher),
          Context.add(BuiltinEventSink, {
            publish: () => Effect.die("parent builtin sink should be omitted"),
          }),
        ) as Context.Context<never>

        const serverParent = {
          cwd: "/tmp",
          resolved: { kinds: {} } as never,
          __brand: undefined as never,
        } as ServerProfile

        const childPublisher = EventPublisher.of({
          append: () => Effect.die("child append is unused"),
          deliver: () => Effect.void,
          publish: () => Effect.void,
          terminateSession: () => Effect.void,
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

        const composed = RuntimeComposer.ephemeral({ parent: serverParent, parentServices })
          .withOverrides({ eventPublisher: childEventPublisherLayer })
          .build()

        const { publisher, sink } = yield* Effect.gen(function* () {
          const publisher = yield* EventPublisher
          const sink = yield* BuiltinEventSink
          return { publisher, sink }
        }).pipe(Effect.provide(composed.layer))

        expect(publisher).toBe(childPublisher)
        expect(sink.publish).toBe(childPublisher.publish)
      }),
    )
  })

  test("Layer.fresh + MemoMap omission produces a fresh build per ephemeral composition", () => {
    // Regression for the load-bearing pair documented in composer.ts:346-389:
    //   (a) `Layer.CurrentMemoMap` is omitted from forwarded parent context
    //   (b) the merged layer is wrapped in `Layer.fresh`
    // If either is dropped, a layer that the parent already memoised (same
    // Layer object identity) replays the parent's instance into the child
    // — defeating ephemeral isolation.
    //
    // Setup: a single Layer.effect builder with an observable side effect.
    // Build it inside a parent scope (memoising it in the parent's MemoMap),
    // then via the composer in a child scope. The builder must run twice.
    return Effect.runPromise(
      Effect.gen(function* () {
        let buildCount = 0
        const sharedLayer = Layer.effect(
          FakeService,
          Effect.sync(() => {
            buildCount += 1
            return { value: buildCount }
          }),
        )

        // Parent build — populates parent's MemoMap with sharedLayer.
        const parentValue = yield* Effect.gen(function* () {
          return (yield* FakeService).value
        }).pipe(Effect.provide(sharedLayer))
        expect(parentValue).toBe(1)
        expect(buildCount).toBe(1)

        // Forward parent context (would carry MemoMap if not stripped).
        // We simulate this by capturing parent context and feeding it
        // into the composer as `parentServices`.
        const parentServices = yield* Effect.context<never>()

        const serverParent = {
          cwd: "/tmp",
          resolved: { kinds: {} } as never,
          __brand: undefined as never,
        } as ServerProfile

        // Compose with the SAME sharedLayer object as an override.
        const composed = RuntimeComposer.ephemeral({ parent: serverParent, parentServices })
          .own(ownService(FakeService, sharedLayer))
          .build()

        const childValue = yield* Effect.gen(function* () {
          return (yield* FakeService).value
        }).pipe(Effect.provide(composed.layer))

        // If MemoMap-omission OR Layer.fresh broke, buildCount would
        // remain 1 and childValue would be 1 (replayed). With both
        // working, the builder runs again under the child's fresh scope.
        expect(buildCount).toBe(2)
        expect(childValue).toBe(2)
      }),
    )
  })

  test("provide(layer) leaves a missing-service requirement in `R` for unprovided consumers", () => {
    // This is the type-level guarantee the composer claims: a consumer that
    // requires a service NOT in `Provides` has its `R` channel left
    // unsatisfied. Effect's `provide` subtracts only the layer's `Success`
    // channel from the consumer's `R`.
    const parentServices = Context.empty() as Context.Context<never>
    const serverParent = {
      cwd: "/tmp",
      resolved: { kinds: {} } as never,
      __brand: undefined as never,
    } as ServerProfile

    const fakeLayer = Layer.succeed(FakeService, { value: 42 })
    const composed = RuntimeComposer.ephemeral({ parent: serverParent, parentServices })
      .own(ownService(FakeService, fakeLayer))
      .build()

    class OtherService extends Context.Service<OtherService, { readonly other: string }>()(
      "@gent/core/tests/scope-brands/OtherService",
    ) {}

    // Consumer requires OtherService, which the composer's layer does NOT
    // provide. After `Effect.provide(composed.layer)`, R must still contain
    // OtherService.
    const consumer = Effect.gen(function* () {
      const o = yield* OtherService
      return o.other
    })
    const provided = consumer.pipe(Effect.provide(composed.layer))

    // Type-only: the resulting effect must still require OtherService.
    const _typed: Effect.Effect<string, never, OtherService> = provided
    void _typed

    // @ts-expect-error — pretending the requirement is gone fails to compile
    const _bad: Effect.Effect<string, never, never> = provided
    void _bad
  })
})
