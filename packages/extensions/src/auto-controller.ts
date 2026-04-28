import { Context, Effect, Layer, Schema } from "effect"
import {
  ActorEngine,
  Receptionist,
  ReadOnlyBrand,
  type ReadOnly,
  withReadOnly,
} from "@gent/core/extensions/api"
import { AutoMsg, AutoService } from "./auto-actor-protocol.js"
import type { AutoSnapshotReply } from "./auto-protocol.js"

export class AutoActorUnavailable extends Schema.TaggedErrorClass<AutoActorUnavailable>()(
  "AutoActorUnavailable",
  {
    operation: Schema.String,
  },
) {}

type StartInput = {
  readonly goal: string
  readonly maxIterations?: number
}

type ToggleInput = {
  readonly goal?: string
  readonly maxIterations?: number
}

interface AutoReadShape {
  readonly snapshot: () => Effect.Effect<AutoSnapshotReply, AutoActorUnavailable>
  readonly isActive: () => Effect.Effect<boolean, AutoActorUnavailable>
}

interface AutoWriteShape extends AutoReadShape {
  readonly start: (input: StartInput) => Effect.Effect<void, AutoActorUnavailable>
  readonly requestHandoff: (content: string) => Effect.Effect<void, AutoActorUnavailable>
  readonly cancel: () => Effect.Effect<void, AutoActorUnavailable>
  readonly toggle: (input: ToggleInput) => Effect.Effect<void, AutoActorUnavailable>
}

export class AutoRead extends Context.Service<AutoRead, ReadOnly<AutoReadShape>>()(
  "@gent/auto/AutoRead",
) {
  declare readonly [ReadOnlyBrand]: true
}

export class AutoWrite extends Context.Service<AutoWrite, AutoWriteShape>()(
  "@gent/auto/AutoWrite",
) {}

export const AutoControllerLive: Layer.Layer<
  AutoRead | AutoWrite,
  never,
  ActorEngine | Receptionist
> = Layer.unwrap(
  Effect.gen(function* () {
    const engine = yield* ActorEngine
    const receptionist = yield* Receptionist

    const findRef = receptionist.findOne(AutoService)
    const requireRef = (operation: string) =>
      Effect.gen(function* () {
        const ref = yield* findRef
        if (ref === undefined) return yield* new AutoActorUnavailable({ operation })
        return ref
      })

    const snapshot = Effect.gen(function* () {
      const ref = yield* requireRef("snapshot")
      return yield* engine.ask(ref, AutoMsg.GetSnapshot.make({}))
    }).pipe(Effect.mapError(() => new AutoActorUnavailable({ operation: "snapshot" })))

    const write = {
      snapshot: () => snapshot,
      isActive: () => snapshot.pipe(Effect.map((state) => state.active)),
      start: (input) =>
        Effect.gen(function* () {
          const ref = yield* requireRef("start")
          yield* engine.tell(ref, AutoMsg.StartAuto.make(input))
        }),
      requestHandoff: (content) =>
        Effect.gen(function* () {
          const ref = yield* requireRef("requestHandoff")
          yield* engine.tell(ref, AutoMsg.RequestHandoff.make({ content }))
        }),
      cancel: () =>
        Effect.gen(function* () {
          const ref = yield* requireRef("cancel")
          yield* engine.tell(ref, AutoMsg.CancelAuto.make({}))
        }),
      toggle: (input) =>
        Effect.gen(function* () {
          const ref = yield* requireRef("toggle")
          yield* engine.tell(ref, AutoMsg.ToggleAuto.make(input))
        }),
    } satisfies AutoWriteShape

    const read = withReadOnly({
      snapshot: write.snapshot,
      isActive: write.isActive,
    } satisfies AutoReadShape)

    return Layer.merge(Layer.succeed(AutoWrite, write), Layer.succeed(AutoRead, read))
  }),
)
