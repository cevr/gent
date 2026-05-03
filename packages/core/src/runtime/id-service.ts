import { Context, Effect, Layer, Ref } from "effect"
import { randomId } from "./id-service-adapter.js"

export interface IdServiceShape {
  readonly next: Effect.Effect<string>
}

export class IdService extends Context.Service<IdService, IdServiceShape>()(
  "@gent/core/src/runtime/id-service/IdService",
) {
  static Live: Layer.Layer<IdService> = Layer.succeed(IdService, {
    next: Effect.sync(randomId),
  })

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
