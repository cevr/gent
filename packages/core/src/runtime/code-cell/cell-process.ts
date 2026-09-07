import { Deferred, Effect, FileSystem, Path, Queue, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { makeMacosCellSandboxProfile } from "./cell-sandbox.js"
import {
  type CellRequest,
  type CellResponse,
  decodeCellResponse,
  encodeCellRequest,
  makeCellFrameReader,
} from "./cell-protocol.js"

export class CellProcessError extends Schema.TaggedError<CellProcessError>()("CellProcessError", {
  phase: Schema.Literals(["launch", "io", "exit"]),
  message: Schema.String,
  diagnostics: Schema.String,
}) {}

/** The caller owns an immutable trusted worker artifact and the returned process scope.
 * No unsandboxed fallback exists. Linux needs its own launch policy.
 */
export const openMacosCellProcess = Effect.fn("CellProcess.openMacos")(function* (input: {
  readonly binaryPath: string
  readonly workerPath: string
  readonly readinessTimeoutMs?: number
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
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
  const profile = yield* makeMacosCellSandboxProfile({ binaryPath, workerPath }).pipe(
    Effect.mapError(launchError),
  )
  const handle = yield* ChildProcess.make(
    "/usr/bin/sandbox-exec",
    ["-p", profile, binaryPath, workerPath],
    {
      cwd: path.dirname(workerPath),
      env: {},
      extendEnv: false,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      forceKillAfter: "1 second",
    },
  ).pipe(Effect.mapError(launchError))

  const diagnosticBytes = new Uint8Array(8192)
  let diagnosticLength = 0
  const diagnostics = () => new TextDecoder().decode(diagnosticBytes.subarray(0, diagnosticLength))
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
    Stream.run(handle.stdin),
    Effect.mapError(ioError),
    Effect.catchCause((cause) => Deferred.failCause(failure, cause)),
    Effect.forkScoped,
  )
  yield* handle.stderr.pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        const retained = chunk.subarray(0, diagnosticBytes.length - diagnosticLength)
        diagnosticBytes.set(retained, diagnosticLength)
        diagnosticLength += retained.length
      }),
    ),
    Effect.mapError(ioError),
    Effect.catchCause((cause) => Deferred.failCause(failure, cause)),
    Effect.forkScoped,
  )

  const responses = Stream.suspend(() => {
    const reader = makeCellFrameReader()
    return handle.stdout.pipe(
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
    isRunning: handle.isRunning.pipe(Effect.mapError(ioError)),
    exitCode: handle.exitCode.pipe(Effect.mapError(ioError)),
    send: Effect.fn("CellProcess.send")(function* (request: CellRequest) {
      if (yield* Deferred.isDone(failure)) return yield* Deferred.await(failure)
      const bytes = yield* encodeCellRequest(request).pipe(Effect.mapError(ioError))
      const accepted = yield* Queue.offer(outbound, bytes).pipe(
        Effect.raceFirst(Deferred.await(failure)),
      )
      if (!accepted) return yield* closedError()
    }),
    stop,
  }
})
