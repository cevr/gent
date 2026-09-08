import { Deferred, Effect, FileSystem, Option, Queue, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import {
  type CellRequest,
  type CellResponse,
  decodeCellResponse,
  encodeCellRequest,
  makeCellFrameReader,
  makeCellOutputScanner,
  type CellOutputSegment,
  maximumCellDisplayLength,
} from "./cell-protocol.js"

export class CellProcessError extends Schema.TaggedError<CellProcessError>()("CellProcessError", {
  phase: Schema.Literals(["launch", "io", "exit"]),
  message: Schema.String,
  diagnostics: Schema.String,
}) {}

/** Worker-to-host frames travel on this descriptor; the worker owns stdout for cell output. */
export const cellResponseFd = 3
/** Host-to-worker frames travel on this descriptor. */
export const cellRequestFd = 4

/** Keeps the first `limit` characters and counts the rest. */
const makeOutputBuffer = (limit: number) => {
  let text = ""
  let omitted = 0
  const read = () => {
    if (omitted === 0) return text
    return `${text}\n... [${omitted} characters omitted] ...`
  }
  return {
    append: (chunk: string) => {
      const room = Math.max(0, limit - text.length)
      text += chunk.slice(0, room)
      omitted += Math.max(0, chunk.length - room)
    },
    read,
    take: () => {
      const result = read()
      text = ""
      omitted = 0
      return result
    },
  }
}

/** The caller owns an immutable trusted worker artifact and the returned process scope.
 * The worker runs with the host's working directory, environment, and OS permissions,
 * the same authority the bash tool already grants. Protocol frames use dedicated
 * descriptors so cell code that writes to stdout cannot corrupt them.
 */
export const openCellProcess = Effect.fn("CellProcess.open")(function* (input: {
  readonly binaryPath: string
  readonly workerPath: string
  readonly readinessTimeoutMs?: number
}) {
  const fs = yield* FileSystem.FileSystem
  const launchError = (cause: unknown) =>
    new CellProcessError({ phase: "launch", message: String(cause), diagnostics: "" })
  const readinessTimeoutMs = input.readinessTimeoutMs ?? 5000
  if (!Number.isSafeInteger(readinessTimeoutMs) || readinessTimeoutMs <= 0) {
    return yield* launchError("Cell readiness timeout must be a positive integer")
  }
  const binaryPath = yield* fs.realPath(input.binaryPath).pipe(Effect.mapError(launchError))
  const workerPath = yield* fs.realPath(input.workerPath).pipe(Effect.mapError(launchError))
  for (const file of [binaryPath, workerPath]) {
    const info = yield* fs.stat(file).pipe(Effect.mapError(launchError))
    if (info.type !== "File") return yield* launchError("Cell launch requires regular files")
  }
  const handle = yield* ChildProcess.make(binaryPath, [workerPath], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    additionalFds: {
      [`fd${cellResponseFd}`]: { type: "output" },
      [`fd${cellRequestFd}`]: { type: "input" },
    },
    forceKillAfter: "1 second",
  }).pipe(Effect.mapError(launchError))

  const diagnosticsBuffer = makeOutputBuffer(8192)
  const diagnostics = () => diagnosticsBuffer.read()
  const ioError = (cause: unknown) =>
    new CellProcessError({ phase: "io", message: String(cause), diagnostics: diagnostics() })
  const failure = yield* Deferred.make<never, CellProcessError>()
  const ready = yield* Deferred.make<boolean, CellProcessError>()
  const incoming = yield* Queue.make<CellResponse, CellProcessError>({ capacity: 8 })
  const outbound = yield* Queue.make<Uint8Array>({ capacity: 8 })
  const closedError = () =>
    new CellProcessError({
      phase: "exit",
      message: "Cell worker closed",
      diagnostics: diagnostics(),
    })
  yield* Effect.addFinalizer(() =>
    Deferred.fail(failure, closedError()).pipe(
      Effect.andThen(Queue.shutdown(outbound)),
      Effect.andThen(Queue.shutdown(incoming)),
    ),
  )
  yield* handle.exitCode.pipe(
    Effect.mapError(
      (cause) =>
        new CellProcessError({ phase: "exit", message: String(cause), diagnostics: diagnostics() }),
    ),
    Effect.flatMap(() => Effect.fail(closedError())),
    Effect.catchCause((cause) => Deferred.failCause(failure, cause)),
    Effect.forkScoped,
  )

  yield* Stream.fromQueue(outbound).pipe(
    Stream.run(handle.getInputFd(cellRequestFd)),
    Effect.mapError(ioError),
    Effect.catchCause((cause) => Deferred.failCause(failure, cause)),
    Effect.forkScoped,
  )
  // Worker stdout and stderr carry cell output, never protocol frames. Each Evaluate
  // carries an unpredictable token; the worker ends the cell with a boundary carrying
  // that token on both streams before its result frame. Text before both boundaries
  // belongs to the cell. Text after them is dropped when the next Evaluate is sent,
  // and text after that belongs to the next cell.
  const cellOutput = makeOutputBuffer(maximumCellDisplayLength)
  const endedStreams = new Set<string>()
  let expectedToken = Option.none<string>()
  let finished = Option.none<{ readonly token: string; readonly text: string }>()
  let outputClosed = false
  let waiter = Option.none<{
    readonly token: string
    readonly deferred: Deferred.Deferred<string, CellProcessError>
  }>()
  const beginCell = (token: string) => {
    cellOutput.take()
    endedStreams.clear()
    expectedToken = Option.some(token)
    finished = Option.none()
  }
  const settle = (token: string) =>
    Effect.suspend(() => {
      const text = cellOutput.take()
      endedStreams.clear()
      expectedToken = Option.none()
      if (Option.isSome(waiter) && waiter.value.token === token) {
        return Deferred.succeed(waiter.value.deferred, text)
      }
      finished = Option.some({ token, text })
      return Effect.void
    })
  const readOutput = (name: string, bytes: Stream.Stream<Uint8Array, unknown>) => {
    const decoder = new TextDecoder()
    const scanner = makeCellOutputScanner(() => {
      if (endedStreams.has(name)) return Option.none()
      return expectedToken
    })
    const consume = (segment: CellOutputSegment) =>
      Effect.gen(function* () {
        diagnosticsBuffer.append(segment.text)
        cellOutput.append(segment.text)
        if (Option.isNone(segment.boundary)) return
        endedStreams.add(name)
        if (endedStreams.size === 2) yield* settle(segment.boundary.value)
      })
    return bytes.pipe(
      Stream.mapEffect((chunk) =>
        Effect.forEach(scanner.push(decoder.decode(chunk, { stream: true })), consume, {
          discard: true,
        }),
      ),
      Stream.concat(
        Stream.fromEffect(
          Effect.suspend(() => consume({ text: scanner.end(), boundary: Option.none() })),
        ),
      ),
    )
  }
  const closeOutput = Effect.suspend(() => {
    outputClosed = true
    return Option.match(waiter, {
      onNone: () => Effect.void,
      onSome: (active) => Deferred.fail(active.deferred, closedError()),
    })
  })
  yield* Stream.merge(
    readOutput("stdout", handle.stdout),
    readOutput("stderr", handle.stderr),
  ).pipe(
    Stream.runDrain,
    Effect.mapError(ioError),
    Effect.catchCause((cause) => Deferred.failCause(failure, cause)),
    Effect.ensuring(closeOutput),
    Effect.forkScoped,
  )
  const takeOutput = Effect.fn("CellProcess.takeOutput")(function* (token: string) {
    if (Option.isSome(finished)) {
      const ready = finished.value
      finished = Option.none()
      if (ready.token !== token) return yield* ioError("Unexpected cell output boundary")
      return ready.text
    }
    if (outputClosed) return yield* closedError()
    const deferred = yield* Deferred.make<string, CellProcessError>()
    waiter = Option.some({ token, deferred })
    // The process failure is terminal for every waiter, present or future.
    return yield* Deferred.await(deferred).pipe(
      Effect.raceFirst(Deferred.await(failure)),
      Effect.ensuring(
        Effect.sync(() => {
          waiter = Option.none()
        }),
      ),
    )
  })

  const responses = Stream.suspend(() => {
    const reader = makeCellFrameReader()
    return handle.getOutputFd(cellResponseFd).pipe(
      Stream.mapEffect(reader.push),
      Stream.flatMap(Stream.fromIterable),
      Stream.mapEffect(decodeCellResponse),
      Stream.concat(Stream.fromEffect(reader.end).pipe(Stream.drain)),
      Stream.mapError(ioError),
      Stream.concat(
        Stream.suspend(() =>
          Stream.fail(
            new CellProcessError({
              phase: "exit",
              message: "Cell worker pipe closed",
              diagnostics: diagnostics(),
            }),
          ),
        ),
      ),
      Stream.interruptWhen(Deferred.await(failure)),
    )
  })

  let receivedReady = false
  yield* responses.pipe(
    Stream.runForEach((response) =>
      Effect.gen(function* () {
        if (!receivedReady) {
          if (response._tag !== "Ready")
            return yield* launchError("Cell worker did not send Ready first")
          receivedReady = true
          yield* Deferred.succeed(ready, true)
        } else if (response._tag === "Ready") {
          return yield* ioError("Cell worker sent Ready twice")
        }
        yield* Queue.offer(incoming, response)
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.all([
        Deferred.failCause(ready, cause),
        Deferred.failCause(failure, cause),
        Queue.failCause(incoming, cause),
      ]),
    ),
    Effect.forkScoped,
  )

  const stop = Effect.gen(function* () {
    if (yield* handle.isRunning.pipe(Effect.mapError(ioError))) {
      // kill waits for the exit event; signal termination has no numeric exit code.
      yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.mapError(ioError))
    }
    yield* Deferred.fail(failure, closedError())
    yield* Queue.shutdown(outbound)
  })
  yield* Deferred.await(ready).pipe(
    Effect.timeoutOrElse({
      duration: readinessTimeoutMs,
      orElse: () =>
        Effect.fail(
          new CellProcessError({
            phase: "launch",
            message: "Cell worker readiness timed out",
            diagnostics: diagnostics(),
          }),
        ),
    }),
    Effect.onError(() => stop.pipe(Effect.orDie)),
  )

  return {
    pid: handle.pid,
    responses: Stream.fromQueue(incoming),
    diagnostics: Effect.sync(diagnostics),
    /** Output the worker wrote during the cell, once both streams passed its boundary. */
    takeOutput,
    isRunning: handle.isRunning.pipe(Effect.mapError(ioError)),
    exitCode: handle.exitCode.pipe(Effect.mapError(ioError)),
    send: Effect.fn("CellProcess.send")(function* (request: CellRequest) {
      if (yield* Deferred.isDone(failure)) return yield* Deferred.await(failure)
      // Output nobody claimed, such as late writes from a process a cell spawned, is dropped here.
      if (request._tag === "Evaluate") beginCell(request.outputToken)
      const bytes = yield* encodeCellRequest(request).pipe(Effect.mapError(ioError))
      const accepted = yield* Queue.offer(outbound, bytes).pipe(
        Effect.raceFirst(Deferred.await(failure)),
      )
      if (!accepted) return yield* closedError()
    }),
    stop,
  }
})
