import { Context, Effect, Layer, Ref } from "effect"
import { GentPlatform } from "./gent-platform.js"
import { BunGentPlatformLive } from "./gent-platform-bun.js"

export interface IdServiceShape {
  readonly next: Effect.Effect<string>
}

/**
 * @deprecated Use `GentPlatform` directly. `IdService` is kept temporarily
 * during the migration off the standalone Tag and will be removed in
 * C32.7b. Live wiring delegates to `GentPlatform.randomId` and provides
 * `BunGentPlatformLive` itself so existing call sites keep compiling.
 */
export class IdService extends Context.Service<IdService, IdServiceShape>()(
  "@gent/core/src/runtime/id-service/IdService",
) {
  static Live: Layer.Layer<IdService> = Layer.effect(
    IdService,
    Effect.gen(function* () {
      const platform = yield* GentPlatform
      return { next: platform.randomId }
    }),
  ).pipe(Layer.provide(BunGentPlatformLive))

  static Test = (prefix = "id"): Layer.Layer<IdService> =>
    Layer.effect(
      IdService,
      Effect.gen(function* () {
        const counter = yield* Ref.make(0)
        return {
          next: Ref.updateAndGet(counter, (n) => n + 1).pipe(
            Effect.map((n) => `${prefix}-${String(n).padStart(8, "0")}`),
          ),
        }
      }),
    )
}
