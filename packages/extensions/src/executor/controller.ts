import { Context, Effect, Layer, Schema, Stream } from "effect"
import {
  ActorEngine,
  Receptionist,
  ReadOnlyBrand,
  type ReadOnly,
  withReadOnly,
} from "@gent/core/extensions/api"
import { ExecutorMsg, ExecutorService, ExecutorState, projectSnapshot } from "./actor.js"
import type { ExecutorSnapshotReply } from "./protocol.js"

interface ExecutorReadShape {
  readonly snapshot: () => Effect.Effect<ExecutorSnapshotReply>
}

interface ExecutorWriteShape extends ExecutorReadShape {
  readonly connect: (cwd: string) => Effect.Effect<void>
  readonly disconnect: () => Effect.Effect<void>
}

export class ExecutorRead extends Context.Service<ExecutorRead, ReadOnly<ExecutorReadShape>>()(
  "@gent/executor/ExecutorRead",
) {
  declare readonly [ReadOnlyBrand]: true
}

export class ExecutorWrite extends Context.Service<ExecutorWrite, ExecutorWriteShape>()(
  "@gent/executor/ExecutorWrite",
) {}

export const ExecutorControllerLive: Layer.Layer<
  ExecutorRead | ExecutorWrite,
  never,
  ActorEngine | Receptionist
> = Layer.unwrap(
  Effect.gen(function* () {
    const engine = yield* ActorEngine
    const receptionist = yield* Receptionist

    const findRef = receptionist.findOne(ExecutorService)
    const snapshot = Effect.gen(function* () {
      const ref = yield* findRef
      if (ref === undefined) return { status: "idle" as const }
      const states = yield* Stream.runCollect(engine.subscribeState(ref).pipe(Stream.take(1)))
      const state = Array.from(states)[0]
      if (state === undefined) return { status: "idle" as const }
      if (!Schema.is(ExecutorState)(state)) return { status: "idle" as const }
      return projectSnapshot(state)
    })

    const write = {
      snapshot: () => snapshot,
      connect: (cwd) =>
        Effect.gen(function* () {
          const ref = yield* findRef
          if (ref === undefined) return
          yield* engine.tell(ref, ExecutorMsg.Connect.make({ cwd }))
        }),
      disconnect: () =>
        Effect.gen(function* () {
          const ref = yield* findRef
          if (ref === undefined) return
          yield* engine.tell(ref, ExecutorMsg.Disconnect.make({}))
        }),
    } satisfies ExecutorWriteShape

    const read = withReadOnly({
      snapshot: write.snapshot,
    } satisfies ExecutorReadShape)

    return Layer.merge(Layer.succeed(ExecutorWrite, write), Layer.succeed(ExecutorRead, read))
  }),
)
