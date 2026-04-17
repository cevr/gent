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
})
