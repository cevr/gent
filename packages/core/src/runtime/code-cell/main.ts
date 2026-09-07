import { BunRuntime, BunStdio } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { CellWorkerTransport, runCellWorker } from "./cell-worker.js"

// The parent must launch this entry inside the configured process isolation boundary.
BunRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(
        CellWorkerTransport.Live.pipe(Layer.provide(BunStdio.layer)),
      )
      yield* Effect.provideContext(runCellWorker, services)
    }),
  ),
)
