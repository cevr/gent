import {
  Context,
  Deferred,
  Effect,
  Exit,
  Latch,
  FileSystem,
  Option,
  Path,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { InteractionPendingError } from "../../domain/interaction-request.js"
import { ToolCallId } from "../../domain/ids.js"
import { CellProcessError, openCellProcess } from "./cell-process.js"
import {
  type CellCatalog,
  CellEvaluationError,
  CellRequest,
  type CellResponse,
  maximumCallsPerCell,
  maximumCellSourceLength,
  maximumPendingCellCalls,
} from "./cell-protocol.js"
import type { CellSnapshot, SnapshotBinding } from "./cell-snapshot.js"

/** Supplied by the caller for each evaluation. Only the catalog is retained in the worker. */
export class CellOperationHost extends Context.Service<
  CellOperationHost,
  {
    /** Selected host tools for `tools.search` and `tools.describe`. Absent leaves the worker's catalog unchanged. */
    readonly catalog?: CellCatalog
    readonly call: (
      request: Extract<CellResponse, { _tag: "HostCall" }>,
    ) => Effect.Effect<Schema.Json, CellEvaluationError | CellToolCallSuspended>
  }
>()("@gent/core/src/runtime/code-cell/cell-kernel/CellOperationHost") {}

/** Host control signal. It must never become a catchable error inside cell code. */
export class CellToolCallSuspended extends Schema.TaggedError<CellToolCallSuspended>()(
  "CellToolCallSuspended",
  {
    operationId: Schema.NonEmptyString,
    toolCallId: ToolCallId,
    pending: InteractionPendingError,
  },
) {}

export class CellKernelError extends Schema.TaggedError<CellKernelError>()("CellKernelError", {
  reason: Schema.Literals([
    "timeout",
    "cancelled",
    "protocol",
    "process",
    "closed",
    "recovery-required",
    "replacement-limit",
  ]),
  message: Schema.String,
  diagnostics: Schema.String,
  stateLost: Schema.Literal(true),
}) {}

const KernelStatus = Schema.Literals(["ready", "lost", "closed"])

/** One worker at a time. Only explicit reset can replace a failed worker. */
export const openCellKernel = Effect.fn("CellKernel.open")(function* (input: {
  readonly binaryPath: string
  readonly workerPath: string
  readonly readinessTimeoutMs?: number
  readonly evaluationTimeoutMs?: number
  readonly maximumReplacements?: number
}) {
  const timeoutMs = input.evaluationTimeoutMs ?? 30000
  const maximumReplacements = input.maximumReplacements ?? 3
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return yield* new CellProcessError({
      phase: "launch",
      message: "Cell evaluation timeout must be a positive integer",
      diagnostics: "",
    })
  }
  if (!Number.isSafeInteger(maximumReplacements) || maximumReplacements < 0) {
    return yield* new CellProcessError({
      phase: "launch",
      message: "Cell replacement limit must be a non-negative integer",
      diagnostics: "",
    })
  }
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const ownerScope = yield* Scope.fork(yield* Effect.scope)
  let status: typeof KernelStatus.Type = "lost"
  yield* Scope.addFinalizer(
    ownerScope,
    Effect.sync(() => {
      status = "closed"
    }),
  )
  const openWorker = Effect.fn("CellKernel.openWorker")(() =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(ownerScope)
        const dispose = Scope.close(scope, Exit.void)
        const process = yield* restore(
          openCellProcess(input).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Scope.provide(scope),
            Effect.tap((child) => child.responses.pipe(Stream.runHead)),
          ),
        ).pipe(Effect.onError(() => dispose))
        return { ...process, dispose }
      }),
    ),
  )
  let child = yield* openWorker().pipe(Effect.onError(() => Scope.close(ownerScope, Exit.void)))
  status = "ready"
  const permit = yield* Semaphore.make(1)
  const shutdown = yield* Deferred.make<never, CellKernelError>()
  let replacements = 0
  let sequence = 0
  // Catalog delta: the worker keeps the last catalog, so only a changed hash travels. A
  // replacement worker starts empty and receives the full catalog on its first cell.
  let workerCatalogHash = Option.none<string>()
  const isClosed = () => status === "closed"
  const failure = (reason: CellKernelError["reason"], message: string) =>
    Effect.map(
      child.diagnostics,
      (diagnostics) => new CellKernelError({ reason, message, diagnostics, stateLost: true }),
    ).pipe(Effect.flatMap(Effect.fail))
  const processError = (error: CellProcessError) =>
    new CellKernelError({
      reason: "process",
      message: error.message,
      diagnostics: error.diagnostics,
      stateLost: true,
    })
  const close = Effect.fn("CellKernel.close")(function* () {
    status = "closed"
    yield* Deferred.fail(
      shutdown,
      new CellKernelError({
        reason: "closed",
        message: "Cell kernel is closed",
        diagnostics: yield* child.diagnostics,
        stateLost: true,
      }),
    )
    yield* Semaphore.withPermit(permit, Scope.close(ownerScope, Exit.void))
  })
  const discard = Effect.fn("CellKernel.discard")(function* () {
    if (status !== "closed") status = "lost"
    yield* child.stop.pipe(Effect.ensuring(child.dispose))
  })
  const deadline = {
    duration: timeoutMs,
    orElse: () => failure("timeout", "Cell deadline exceeded; working state was lost"),
  }

  const evaluate = Effect.fn("CellKernel.evaluate")(function* (source: string) {
    if (status === "closed") return yield* failure("closed", "Cell kernel is closed")
    if (status === "lost") {
      return yield* failure("recovery-required", "Working state was lost; reset before evaluating")
    }
    if (source.length > maximumCellSourceLength) {
      return yield* new CellEvaluationError({
        phase: "source",
        message: "Cell source exceeds the length limit",
        output: "",
      })
    }
    const host = yield* CellOperationHost
    const cellId = String(++sequence)
    const catalog = Option.fromUndefinedOr(host.catalog).pipe(
      Option.filter((next) => !Option.contains(workerCatalogHash, next.hash)),
    )
    const response = yield* Effect.scoped(
      Effect.gen(function* () {
        const result = yield* Deferred.make<
          Extract<CellResponse, { _tag: "Evaluated" | "Failed" }>,
          CellKernelError | CellToolCallSuspended
        >()
        const seen = new Set<string>()
        const pending = new Set<string>()
        // The deadline bounds worker compute only. Host operations own their bounds
        // (tool timeouts, approvals), so the clock stops while one is pending and a
        // fresh compute stretch starts when the worker gets its reply.
        const idle = yield* Latch.make(true)
        const busy = yield* Latch.make(false)
        const watchdog: Effect.Effect<never, CellKernelError> = Effect.gen(function* () {
          while (true) {
            yield* idle.await
            const timedOut = yield* busy.await.pipe(
              Effect.as(false),
              Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed(true) }),
            )
            if (timedOut) return yield* deadline.orElse()
          }
        })
        const receive = Effect.fn("CellKernel.receive")(function* (frame: CellResponse) {
          if (
            frame._tag === "Ready" ||
            frame._tag === "Reset" ||
            frame._tag === "Snapshot" ||
            frame._tag === "Restored" ||
            frame.cellId !== cellId
          ) {
            return yield* failure("protocol", "Unexpected cell response")
          }
          if (frame._tag === "HostCall") {
            if (
              seen.has(frame.operationId) ||
              seen.size >= maximumCallsPerCell ||
              pending.size >= maximumPendingCellCalls
            ) {
              return yield* failure("protocol", "Duplicate or excessive cell host call")
            }
            seen.add(frame.operationId)
            pending.add(frame.operationId)
            yield* idle.close
            yield* busy.open
            yield* host.call(frame).pipe(
              Effect.map((value) =>
                CellRequest.cases.HostSucceeded.make({
                  cellId,
                  operationId: frame.operationId,
                  value,
                }),
              ),
              Effect.catchTag("CellEvaluationError", (error) =>
                Effect.succeed(
                  CellRequest.cases.HostFailed.make({
                    cellId,
                    operationId: frame.operationId,
                    message: error.message,
                  }),
                ),
              ),
              Effect.flatMap((reply) => {
                pending.delete(frame.operationId)
                return child.send(reply).pipe(Effect.mapError(processError))
              }),
              Effect.tap(() => {
                if (pending.size > 0) return Effect.void
                return busy.close.pipe(Effect.andThen(idle.open))
              }),
              Effect.catchCause((cause) => Deferred.failCause(result, cause)),
              Effect.forkScoped,
            )
            return
          }
          if (pending.size > 0) {
            return yield* failure("protocol", "Cell ended with pending host operations")
          }
          yield* Deferred.succeed(result, frame)
        })
        yield* child.responses.pipe(
          Stream.mapError(processError),
          Stream.runForEach(receive),
          Effect.catchCause((cause) => Deferred.failCause(result, cause)),
          Effect.forkScoped,
        )
        // Output that arrived before this cell belongs to no one; drop it.
        yield* child.takeOutput
        yield* child
          .send(
            CellRequest.cases.Evaluate.make({
              cellId,
              source,
              catalog: Option.getOrUndefined(catalog),
            }),
          )
          .pipe(Effect.mapError(processError))
        if (Option.isSome(catalog)) workerCatalogHash = Option.some(catalog.value.hash)
        const frame = yield* Deferred.await(result).pipe(Effect.raceFirst(watchdog))
        // The worker writes output before its result frame, but the two pipes are read by
        // separate fibers. One event-loop turn lets output already in the pipe land first.
        yield* Effect.sleep("1 millis")
        return { frame, output: yield* child.takeOutput }
      }),
    ).pipe(Effect.onError(() => discard().pipe(Effect.orDie)))
    // Prime-style result text: process output first, then the cell's own display.
    const withOutput = (display: string) =>
      [response.output.trimEnd(), display].filter((text) => text.length > 0).join("\n")
    if (response.frame._tag === "Failed") {
      return yield* new CellEvaluationError({
        phase: response.frame.error.phase,
        message: response.frame.error.message,
        output: withOutput(response.frame.error.output),
      })
    }
    return { ...response.frame.result, display: withOutput(response.frame.result.display) }
  })

  const reset = Effect.fn("CellKernel.reset")(function* () {
    if (status === "closed") return yield* failure("closed", "Cell kernel is closed")
    if (status === "lost") {
      if (replacements >= maximumReplacements) {
        return yield* failure("replacement-limit", "Cell worker replacement limit reached")
      }
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          replacements++
          workerCatalogHash = Option.none()
          child = yield* restore(openWorker()).pipe(Effect.mapError(processError))
          // close can run while the replacement is starting. Never restore a closed owner.
          if (isClosed()) return yield* failure("closed", "Cell kernel closed during replacement")
          status = "ready"
        }),
      )
    }
    const requestId = String(++sequence)
    yield* Effect.gen(function* () {
      yield* child.send(CellRequest.cases.Reset.make({ requestId }))
      const response = yield* child.responses.pipe(Stream.runHead)
      if (
        Option.isNone(response) ||
        response.value._tag !== "Reset" ||
        response.value.requestId !== requestId
      ) {
        return yield* failure("protocol", "Unexpected cell reset response")
      }
    }).pipe(
      Effect.catchTag("CellProcessError", (error) => Effect.fail(processError(error))),
      Effect.timeoutOrElse(deadline),
      Effect.onError(() => discard().pipe(Effect.orDie)),
    )
  })

  /** One control request with one matching reply, while no cell is active. */
  const control = Effect.fn("CellKernel.control")(function* <A>(
    make: (requestId: string) => CellRequest,
    read: (response: CellResponse, requestId: string) => Option.Option<A>,
  ) {
    if (status === "closed") return yield* failure("closed", "Cell kernel is closed")
    if (status === "lost") {
      return yield* failure("recovery-required", "Working state was lost; reset before evaluating")
    }
    const requestId = String(++sequence)
    return yield* Effect.gen(function* () {
      yield* child.send(make(requestId))
      const response = yield* child.responses.pipe(Stream.runHead)
      const value = Option.flatMap(response, (frame) => read(frame, requestId))
      if (Option.isNone(value))
        return yield* failure("protocol", "Unexpected cell control response")
      return value.value
    }).pipe(
      Effect.catchTag("CellProcessError", (error) => Effect.fail(processError(error))),
      Effect.timeoutOrElse(deadline),
      Effect.onError(() => discard().pipe(Effect.orDie)),
    )
  })
  const snapshot = control(
    (requestId) => CellRequest.cases.Snapshot.make({ requestId }),
    (frame, requestId): Option.Option<CellSnapshot> => {
      if (frame._tag === "Snapshot" && frame.requestId === requestId)
        return Option.some(frame.snapshot)
      return Option.none()
    },
  )
  const restore = (bindings: ReadonlyArray<SnapshotBinding>) =>
    control(
      (requestId) => CellRequest.cases.Restore.make({ requestId, bindings }),
      (frame, requestId): Option.Option<ReadonlyArray<string>> => {
        if (frame._tag === "Restored" && frame.requestId === requestId)
          return Option.some(frame.bindings)
        return Option.none()
      },
    )

  const guarded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Semaphore.withPermit(permit, effect.pipe(Effect.raceFirst(Deferred.await(shutdown))))
  return {
    evaluate: (source: string) => guarded(evaluate(source)),
    snapshot: guarded(snapshot),
    restore: (bindings: ReadonlyArray<SnapshotBinding>) => guarded(restore(bindings)),
    reset: guarded(reset()),
    close: close().pipe(Effect.uninterruptible),
  }
})
