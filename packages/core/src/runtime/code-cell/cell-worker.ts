import { Context, Deferred, Effect, Option, Predicate, type Schema, Stream } from "effect"
import { CellHost, makeBunCellEvaluator } from "./bun-evaluator-boundary.js"
import {
  CellEvaluationError,
  CellProtocolError,
  type CellRequest,
  CellResponse,
  maximumPendingCellCalls,
  maximumCallsPerCell,
} from "./cell-protocol.js"

export class CellWorkerTransport extends Context.Service<
  CellWorkerTransport,
  {
    readonly requests: Stream.Stream<CellRequest, CellProtocolError>
    readonly send: (response: CellResponse) => Effect.Effect<void, CellProtocolError>
  }
>()("@gent/core/src/runtime/code-cell/cell-worker/CellWorkerTransport") {}

const isHostReply = Predicate.or(
  Predicate.isTagged("HostSucceeded"),
  Predicate.isTagged("HostFailed"),
)

/** Runs only inside the isolated child process. The parent owns process termination. */
export const runCellWorker = Effect.scoped(
  Effect.gen(function* () {
    const transport = yield* CellWorkerTransport
    const fatal = yield* Deferred.make<never, CellProtocolError>()
    const pending = new Map<string, Deferred.Deferred<Schema.Json, CellEvaluationError>>()
    let activeCell = Option.none<string>()
    let operationSequence = 0
    let cellCalls = 0
    const callError = (message: string) =>
      new CellEvaluationError({ phase: "execute", message, output: "" })

    yield* Effect.addFinalizer(() =>
      Effect.forEach(pending.values(), Deferred.interrupt, { discard: true }),
    )

    const kernel = yield* makeBunCellEvaluator.pipe(
      Effect.provideService(CellHost, {
        call: Effect.fn("CellWorker.call")(function* (name, input) {
          if (Option.isNone(activeCell)) return yield* callError("No active cell")
          if (pending.size >= maximumPendingCellCalls || cellCalls >= maximumCallsPerCell) {
            return yield* callError("Cell host-call limit exceeded")
          }
          const cellId = activeCell.value
          const operationId = String(++operationSequence)
          cellCalls++
          const reply = yield* Deferred.make<Schema.Json, CellEvaluationError>()
          pending.set(operationId, reply)
          return yield* transport
            .send(CellResponse.cases.HostCall.make({ cellId, operationId, name, input }))
            .pipe(
              Effect.mapError((error) => callError(error.message)),
              Effect.andThen(Deferred.await(reply)),
              Effect.ensuring(Effect.sync(() => pending.delete(operationId))),
            )
        }),
      }),
    )

    // Leaving the realm clean matters when several workers share one test process.
    yield* Effect.addFinalizer(() => kernel.reset)

    const receive = Effect.fn("CellWorker.receive")(function* (request: CellRequest) {
      if (isHostReply(request)) {
        const reply = Option.fromUndefinedOr(pending.get(request.operationId))
        if (!Option.contains(activeCell, request.cellId) || Option.isNone(reply)) {
          return yield* new CellProtocolError({ message: "Stale or unknown cell host reply" })
        }
        pending.delete(request.operationId)
        if (request._tag === "HostSucceeded") {
          yield* Deferred.succeed(reply.value, request.value)
        } else {
          yield* Deferred.fail(reply.value, callError(request.message))
        }
        return
      }
      if (Option.isSome(activeCell)) {
        return yield* new CellProtocolError({ message: "A cell is already active" })
      }
      if (request._tag === "Reset") {
        yield* kernel.reset
        yield* transport.send(CellResponse.cases.Reset.make({ requestId: request.requestId }))
        return
      }
      if (request._tag === "Snapshot") {
        const snapshot = yield* kernel.snapshot
        yield* transport.send(
          CellResponse.cases.Snapshot.make({ requestId: request.requestId, snapshot }),
        )
        return
      }
      if (request._tag === "Restore") {
        const bindings = yield* kernel
          .restore(request.bindings)
          .pipe(Effect.mapError((error) => new CellProtocolError({ message: error.message })))
        yield* transport.send(
          CellResponse.cases.Restored.make({ requestId: request.requestId, bindings }),
        )
        return
      }
      if (Predicate.isNotUndefined(request.catalog)) yield* kernel.setCatalog(request.catalog.tools)
      activeCell = Option.some(request.cellId)
      cellCalls = 0
      yield* kernel.evaluate(request.source).pipe(
        Effect.match({
          onFailure: (error) => CellResponse.cases.Failed.make({ cellId: request.cellId, error }),
          onSuccess: (result) =>
            CellResponse.cases.Evaluated.make({ cellId: request.cellId, result }),
        }),
        Effect.flatMap((response) => {
          if (pending.size > 0) {
            return Effect.fail(
              new CellProtocolError({ message: "Cell ended with pending host calls" }),
            )
          }
          activeCell = Option.none()
          return transport.send(response)
        }),
        Effect.catchCause((cause) => Deferred.failCause(fatal, cause)),
        Effect.forkScoped,
      )
    })

    yield* transport.send(CellResponse.cases.Ready.make({ version: 1 }))
    yield* transport.requests.pipe(
      Stream.runForEach(receive),
      Effect.raceFirst(Deferred.await(fatal)),
    )
  }),
)
