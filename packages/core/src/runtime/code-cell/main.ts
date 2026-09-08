/* oxlint-disable effect/noGlobals, gent/no-bun-outside-adapter -- The worker entry owns its process descriptors through Bun. */
import { BunRuntime } from "@effect/platform-bun"
import { Effect, Layer, Predicate, Semaphore, Stream } from "effect"
import { CellWorkerEnvironment } from "./bun-evaluator-boundary.js"
import { cellRequestFd, cellResponseFd } from "./cell-process.js"
import {
  CellProtocolError,
  cellOutputBoundary,
  decodeCellRequest,
  encodeCellResponse,
  makeCellFrameReader,
} from "./cell-protocol.js"
import { CellWorkerTransport, runCellWorker } from "./cell-worker.js"

/** Frames use dedicated descriptors so cell code keeps stdout and stderr for itself. */
const DescriptorTransport = Layer.effect(
  CellWorkerTransport,
  Effect.gen(function* () {
    const outputPermit = yield* Semaphore.make(1)
    const ioError = (cause: unknown) => new CellProtocolError({ message: String(cause) })
    const requestBytes = Stream.fromReadableStream({
      evaluate: () => Bun.file(cellRequestFd).stream(),
      onError: ioError,
    })
    const responses = Bun.file(cellResponseFd)
    // The callback fires once the stream handed the marker to the OS, so everything the
    // cell wrote to the same stream before it is already in the pipe.
    const writeMarker = (stream: NodeJS.WriteStream, marker: string) =>
      Effect.callback<void, CellProtocolError>((resume) => {
        stream.write(marker, (error) => {
          if (Predicate.isNotNullish(error)) resume(Effect.fail(ioError(error)))
          else resume(Effect.void)
        })
      })
    const writeAll = (bytes: Uint8Array) =>
      Effect.tryPromise({
        try: () => Bun.write(responses, bytes),
        catch: ioError,
      }).pipe(Effect.asVoid)
    return CellWorkerTransport.of({
      requests: Stream.suspend(() => {
        const reader = makeCellFrameReader()
        return requestBytes.pipe(
          Stream.mapEffect(reader.push),
          Stream.flatMap(Stream.fromIterable),
          Stream.mapEffect(decodeCellRequest),
          Stream.concat(Stream.fromEffect(reader.end).pipe(Stream.drain)),
        )
      }),
      endCellOutput: Effect.fn("CellWorkerTransport.endCellOutput")((cellId) => {
        const marker = cellOutputBoundary(cellId)
        return Effect.all(
          [writeMarker(process.stdout, marker), writeMarker(process.stderr, marker)],
          { concurrency: "unbounded", discard: true },
        )
      }),
      send: Effect.fn("CellWorkerTransport.send")((response) =>
        Semaphore.withPermit(
          outputPermit,
          encodeCellResponse(response).pipe(Effect.flatMap(writeAll)),
        ),
      ),
    })
  }),
)

// The parent launches this entry with the request and response descriptors attached.
BunRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(
        Layer.merge(
          DescriptorTransport,
          Layer.succeed(
            CellWorkerEnvironment,
            CellWorkerEnvironment.of({ workingDirectory: process.cwd() }),
          ),
        ),
      )
      yield* Effect.provideContext(runCellWorker, services)
    }),
  ),
)
