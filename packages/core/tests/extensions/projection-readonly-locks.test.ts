/**
 * Projection ReadOnly-brand regression locks (compile-time).
 *
 * Type-level only — every `@ts-expect-error` proves that
 * `ProjectionContribution<A, R extends ReadOnlyTag>` rejects write-tagged
 * service identifiers in the R channel at compile time. If TypeScript
 * stops erroring here, the read-only fence has regressed and write
 * capabilities can leak into projections again.
 *
 * Companion to `effect-purity-locks.test.ts`. Wired into the core
 * `typecheck` lock pass via `tsconfig.locks.json` so a regression fails
 * CI loudly.
 *
 * Tied to B11.4 of the gent-v2 substrate cleanup plan.
 */

import { describe, test, expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import {
  defineExtension,
  type ProjectionContribution,
  ProjectionError,
  type ReadOnly,
  type ReadOnlyTag,
  ReadOnlyBrand,
} from "@gent/core/extensions/api"

// A representative WRITE-capable service tag — no `ReadOnly` brand,
// stands in for things like `MachineEngine`, `TaskStorage`,
// `MemoryVault`, the wide `Storage` interface, etc.
class WriteCapableService extends Context.Service<
  WriteCapableService,
  { readonly write: () => Effect.Effect<void> }
>()("@gent/core/tests/projection-readonly-locks/WriteCapableService") {}

// A representative READ-only service tag — branded with `ReadOnly` on
// both the inner shape AND the Tag identifier. Stands in for
// `MachineExecute`, `TaskStorageReadOnly`, `MemoryVaultReadOnly`,
// `InteractionPendingReader`, `Skills`.
interface ReadOnlyShape {
  readonly read: () => Effect.Effect<string>
}
class ReadOnlyService extends Context.Service<ReadOnlyService, ReadOnly<ReadOnlyShape>>()(
  "@gent/core/tests/projection-readonly-locks/ReadOnlyService",
) {
  // The brand on the Tag identifier — required so `yield* ReadOnlyService`
  // produces an `R extends ReadOnlyTag` requirement that satisfies the
  // projection R channel.
  declare readonly [ReadOnlyBrand]: true
}

// Keep the symbol live so tree-shaking doesn't drop the import (the
// `declare readonly [ReadOnlyBrand]: true` above is type-only and would
// otherwise look unused to the bundler).
void ReadOnlyBrand

describe("Projection ReadOnly-brand locks (compile-time)", () => {
  test("Projection R must extend ReadOnlyTag — write-capable Tag rejected", () => {
    // Authoring a projection with the read-only Tag is fine.
    const ok: ProjectionContribution<{ value: string }, ReadOnlyService> = {
      id: "ok",
      query: () =>
        Effect.gen(function* () {
          const svc = yield* ReadOnlyService
          const value = yield* svc.read()
          return { value }
        }),
    }
    void ok

    // @ts-expect-error — write-capable service tag fails the
    // `R extends ReadOnlyTag` constraint on ProjectionContribution.
    const bad: ProjectionContribution<{ value: number }, WriteCapableService> = {
      id: "bad",
      query: () =>
        Effect.gen(function* () {
          const svc = yield* WriteCapableService
          yield* svc.write()
          return { value: 1 }
        }).pipe(Effect.mapError(() => new ProjectionError({ projectionId: "bad", reason: "x" }))),
    }
    void bad

    expect(true).toBe(true)
  })

  test("Projection R = never compiles (no requirements is fine)", () => {
    const empty: ProjectionContribution<{ value: number }> = {
      id: "empty",
      query: () => Effect.succeed({ value: 0 }),
    }
    void empty
    expect(true).toBe(true)
  })

  test("Projection R must extend ReadOnlyTag — bare interface without brand rejected", () => {
    interface UnbrandedShape {
      readonly get: () => Effect.Effect<string>
    }
    class UnbrandedService extends Context.Service<UnbrandedService, UnbrandedShape>()(
      "@gent/core/tests/projection-readonly-locks/UnbrandedService",
    ) {}

    // @ts-expect-error — service Tag whose identifier lacks the `ReadOnlyTag`
    // brand fails the constraint, even if the methods look read-only.
    const bad: ProjectionContribution<{ value: string }, UnbrandedService> = {
      id: "bad-unbranded",
      query: () =>
        Effect.gen(function* () {
          const svc = yield* UnbrandedService
          const value = yield* svc.get()
          return { value }
        }),
    }
    void bad

    expect(true).toBe(true)
  })
})

// Type-level only assertion — `ReadOnly<X> extends ReadOnlyTag` must hold.
// If this stops compiling the brand is structurally broken.
type _AssertReadOnlyExtendsTag = ReadOnly<ReadOnlyShape> extends ReadOnlyTag ? true : false
const _readOnlyExtendsTag: _AssertReadOnlyExtendsTag = true
void _readOnlyExtendsTag

describe("Projection ReadOnly-brand locks — defineExtension boundary", () => {
  test("inline projection in defineExtension({ projections }) is fenced", () => {
    // Read-only projection passes through defineExtension's contextual type.
    const ok = defineExtension({
      id: "@gent/test/readonly-locks-ok",
      projections: [
        {
          id: "ok-inline",
          query: () =>
            Effect.gen(function* () {
              const svc = yield* ReadOnlyService
              const value = yield* svc.read()
              return { value }
            }),
        },
      ],
      resources: [
        {
          scope: "process",
          layer: Layer.empty as Layer.Layer<unknown>,
        },
      ],
    })
    void ok

    // Write-capable Tag in an inline projection passed through
    // defineExtension must fail compile. Counsel B11.4c.review caught
    // that the previous existential `ProjectionContribution<any, any>`
    // erased R, letting writes slide in via inline literals. Tightening
    // `AnyProjectionContribution` to `<any, ReadOnlyTag>` re-arms the
    // fence at the contextual-typing boundary.
    const bad = defineExtension({
      id: "@gent/test/readonly-locks-bad",
      projections: [
        {
          id: "bad-inline",
          query: () =>
            // @ts-expect-error — write-capable Tag fails the
            // `R extends ReadOnlyTag` constraint on
            // `AnyProjectionContribution` (the array element type
            // imposed contextually by `defineExtension({ projections })`).
            Effect.gen(function* () {
              const svc = yield* WriteCapableService
              yield* svc.write()
              return { value: 1 }
            }).pipe(
              Effect.mapError(
                () => new ProjectionError({ projectionId: "bad-inline", reason: "x" }),
              ),
            ),
        },
      ],
      resources: [
        {
          scope: "process",
          layer: Layer.empty as Layer.Layer<unknown>,
        },
      ],
    })
    void bad

    expect(true).toBe(true)
  })
})
