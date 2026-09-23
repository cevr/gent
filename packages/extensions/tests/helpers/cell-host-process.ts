/**
 * A host process for worker lifetime tests: it opens one cell worker, starts
 * the cell source from argv, and waits. The test kills this process, never the
 * worker, so the worker loses its host the way it does when a host crashes.
 * The worker script and cell source arrive as CELL_WORKER_SCRIPT and CELL_SOURCE.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Config, Effect } from "effect"
import { CellWorker, openCellProcess } from "../../src/cell.js"
import { CellRequest } from "../../src/cell-protocol.js"

BunRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const scriptPath = yield* Config.string("CELL_WORKER_SCRIPT")
      const source = yield* Config.string("CELL_SOURCE")
      const worker = yield* openCellProcess({
        worker: CellWorker.cases.Script.make({ runtimePath: process.execPath, scriptPath }),
        cwd: process.cwd(),
      })
      yield* worker.send(
        CellRequest.cases.Evaluate.make({
          cellId: "orphan-cell",
          outputToken: "orphan-output",
          source,
        }),
      )
      return yield* Effect.never
    }),
  ).pipe(Effect.provide(BunServices.layer)),
)
