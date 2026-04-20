/**
 * Type-level tests for scope brands.
 *
 * Each `// @ts-expect-error` proves a cross-scope or proof-of-origin
 * violation is caught at compile time. Removing the brand from the
 * relevant API would silently flip these to "unused expect-error", and
 * `bun run typecheck` would fail — so the file doubles as a guardrail.
 */
import { describe, test, expect } from "bun:test"
import { Effect, Layer, Context } from "effect"
import {
  type CwdProfile,
  type EphemeralProfile,
  type ServerProfile,
  ServerProfileService,
} from "@gent/core/runtime/scope-brands"
import { RuntimeComposer, ownService } from "@gent/core/runtime/composer"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { SessionStorage } from "@gent/core/storage/session-storage"

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

  test("withOverrides omits Storage sub-Tags from parent context", () => {
    // Construct a parent context with Storage + SessionStorage.
    // After withOverrides({ storage: ... }), the parent's versions
    // must be stripped — the child's in-memory layer should win.
    return Effect.runPromise(
      Effect.gen(function* () {
        // Build a parent with a sentinel Storage + SessionStorage
        const sentinelStorage = { sentinel: "parent-storage" } as never
        const sentinelSession = { sentinel: "parent-session" } as never
        const parentServices = Context.empty().pipe(
          Context.add(Storage, sentinelStorage),
          Context.add(SessionStorage, sentinelSession),
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

        // SessionStorage should NOT be present (omitted from parent,
        // not provided by child's layer). The child only provided
        // Storage, not SessionStorage. The key test: SessionStorage
        // from the PARENT was stripped by the omit-set.
        const sessionResult = yield* Effect.gen(function* () {
          return yield* Effect.serviceOption(SessionStorage)
        }).pipe(Effect.provide(composed.layer))

        // Parent's SessionStorage was omitted, child didn't provide it
        expect(sessionResult._tag).toBe("None")
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
