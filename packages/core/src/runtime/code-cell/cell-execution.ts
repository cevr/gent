import {
  Context,
  Deferred,
  Effect,
  type FileSystem,
  Layer,
  Option,
  type Path,
  Predicate,
  Ref,
  Schema,
  Scope,
  Semaphore,
} from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import * as Prompt from "effect/unstable/ai/Prompt"
import { BranchId, MessageId, SessionId, ToolCallId } from "../../domain/ids.js"
import { StorageError } from "../../domain/storage-error.js"
import { CellExecutionStorage } from "../../storage/cell-execution-storage.js"
import { CellNamespaceStorage } from "../../storage/cell-namespace-storage.js"
import {
  CellKernelError,
  type CellOperationHost,
  type CellToolCallSuspended,
  openCellKernel,
} from "./cell-kernel.js"
import { CellProcessError } from "./cell-process.js"
import {
  type CellEvaluation,
  CellEvaluationError,
  type CellRestoreReport,
} from "./cell-protocol.js"
import { GentPlatform } from "../gent-platform.js"

export class CellExecutionIncomplete extends Schema.TaggedError<CellExecutionIncomplete>()(
  "CellExecutionIncomplete",
  {
    sessionId: SessionId,
    branchId: BranchId,
    assistantMessageId: MessageId,
    toolCallId: ToolCallId,
    message: Schema.String,
  },
) {}

const CellFailure = Schema.Union([CellEvaluationError, CellKernelError, CellProcessError])
const isPassThrough = Predicate.or(
  Predicate.isTagged("CellToolCallSuspended"),
  Predicate.isTagged("StorageError"),
)
type Kernel = Effect.Success<ReturnType<typeof openCellKernel>>

export interface CellExecutionService {
  readonly run: (call: {
    readonly assistantMessageId: MessageId
    readonly toolCallId: ToolCallId
  }) => Effect.Effect<
    Prompt.ToolResultPart,
    StorageError | CellExecutionIncomplete | CellToolCallSuspended,
    CellOperationHost
  >
  readonly reset: Effect.Effect<void, CellKernelError>
  readonly cancel: Effect.Effect<void>
}

/** One branch scope owns admission and a lazily acquired kernel. Host authority stays per call. */
export class CellExecution extends Context.Service<CellExecution, CellExecutionService>()(
  "@gent/core/src/runtime/code-cell/cell-execution/CellExecution",
) {
  /** The platform selects the installed worker. Acquisition stays lazy. */
  static Branch = (address: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly interruptedRef: Ref.Ref<boolean>
  }) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const binaryPath = yield* platform.cellWorkerPath
        return CellExecution.Live({ ...address, binaryPath, workerPath: binaryPath })
      }),
    )

  static Live = (
    input: Parameters<typeof openCellKernel>[0] & {
      readonly sessionId: SessionId
      readonly branchId: BranchId
      readonly interruptedRef?: Ref.Ref<boolean>
    },
  ) =>
    Layer.effect(
      CellExecution,
      Effect.gen(function* () {
        const storage = yield* CellExecutionStorage
        const namespaces = yield* CellNamespaceStorage
        const scope = yield* Effect.scope
        const platform = yield* Effect.context<
          FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
        >()
        const permit = yield* Semaphore.make(1)
        let cancellationEpoch = 0
        let active = Option.none<Deferred.Deferred<never, CellKernelError>>()
        const cancelled = () =>
          new CellKernelError({
            reason: "cancelled",
            message: "Cell cancelled. Its effects may have occurred; its source was not replayed.",
            diagnostics: "",
            stateLost: true,
          })
        let kernel = Option.none<Kernel>()
        let startupAttempts = 0
        // Set when the worker reported state loss; the next run replaces it and restores.
        let recoveryPending = false
        // Report for the first evaluation after a host-owned restore.
        let restoreReport = Option.none<CellRestoreReport>()
        const namespaceAddress = { sessionId: input.sessionId, branchId: input.branchId }
        /** Put the last good namespace back into a fresh worker. Missing values are named. */
        const restoreNamespace = Effect.fn("CellExecution.restoreNamespace")(function* (
          current: Kernel,
        ) {
          const saved = yield* namespaces.get(namespaceAddress)
          if (Option.isNone(saved)) return
          const restored = yield* current.restore(saved.value.bindings)
          // An empty namespace has nothing to report.
          if (restored.length === 0 && saved.value.omitted.length === 0) return
          restoreReport = Option.some({ restored, omitted: saved.value.omitted })
        })
        /** Keep the namespace after each good cell. A failed snapshot only loses recency. */
        const saveNamespace = Effect.fn("CellExecution.saveNamespace")(function* (current: Kernel) {
          yield* current.snapshot.pipe(
            Effect.flatMap((snapshot) => namespaces.set(namespaceAddress, snapshot)),
            Effect.catch((error) =>
              Effect.logWarning("Cell namespace snapshot failed").pipe(
                Effect.annotateLogs({ error: String(error) }),
              ),
            ),
          )
        })
        const getKernel = Effect.fn("CellExecution.getKernel")(function* () {
          if (Option.isSome(kernel)) return kernel.value
          const remainingReplacements = (input.maximumReplacements ?? 3) - startupAttempts
          if (remainingReplacements < 0) {
            return yield* new CellProcessError({
              phase: "launch",
              message: "Cell worker startup attempt limit reached",
              diagnostics: "",
            })
          }
          startupAttempts++
          return yield* Effect.uninterruptibleMask((restore) =>
            restore(
              openCellKernel({ ...input, maximumReplacements: remainingReplacements }).pipe(
                Effect.provideContext(platform),
                Scope.provide(scope),
              ),
            ).pipe(
              Effect.tap((opened) =>
                Effect.sync(() => {
                  kernel = Option.some(opened)
                }),
              ),
              Effect.tap((opened) => restoreNamespace(opened)),
            ),
          )
        })
        /** Reset on request clears the saved namespace; reset after loss restores it. */
        const prepare = Effect.fn("CellExecution.prepare")(function* (
          current: Kernel,
          reset: boolean,
        ) {
          if (reset) {
            yield* current.reset
            yield* namespaces.clear(namespaceAddress)
            recoveryPending = false
            restoreReport = Option.none()
            return
          }
          if (!recoveryPending) return
          yield* current.reset
          recoveryPending = false
          yield* restoreNamespace(current)
        })
        const evaluated = (value: CellEvaluation): CellEvaluation => {
          if (Option.isNone(restoreReport)) return value
          const report = restoreReport.value
          restoreReport = Option.none()
          return { ...value, restored: report }
        }
        const run = Effect.fn("CellExecution.run")(function* (
          call: Parameters<CellExecutionService["run"]>[0],
          runEpoch: number,
        ) {
          const address = { ...call, sessionId: input.sessionId, branchId: input.branchId }
          const admission = yield* storage.claim(address)
          if (admission._tag === "Completed") return admission.result
          if (admission._tag === "Incomplete") {
            return yield* new CellExecutionIncomplete({
              ...address,
              message:
                "The cell has no recorded result. Its effects may have occurred. Its source was not replayed.",
            })
          }
          const signal = yield* Deferred.make<never, CellKernelError>()
          active = Option.some(signal)
          const evaluate = Effect.gen(function* () {
            if (
              cancellationEpoch !== runEpoch ||
              (input.interruptedRef && (yield* Ref.get(input.interruptedRef)))
            )
              return yield* new CellEvaluationError({
                phase: "execute",
                message: "Cell did not start because execution was cancelled.",
                output: "",
              })
            return yield* getKernel()
          })
          const result = yield* evaluate.pipe(
            Effect.flatMap((current) =>
              Effect.gen(function* () {
                yield* prepare(current, admission.reset === true)
                const value = yield* current.evaluate(admission.code)
                yield* saveNamespace(current)
                return evaluated(value)
              }),
            ),
            Effect.raceFirst(Deferred.await(signal)),
            Effect.ensuring(
              Effect.sync(() => {
                active = Option.none()
              }),
            ),
            Effect.matchEffect({
              onSuccess: (value) =>
                Effect.succeed(
                  Prompt.toolResultPart({
                    id: call.toolCallId,
                    name: "cell",
                    result: value,
                    isFailure: false,
                    providerExecuted: false,
                  }),
                ),
              onFailure: (
                error,
              ): Effect.Effect<Prompt.ToolResultPart, StorageError | CellToolCallSuspended> => {
                // A suspended cell loses its worker like any kernel failure: the next
                // run restores the last good namespace instead of demanding a reset.
                if (error._tag === "CellToolCallSuspended") recoveryPending = true
                if (isPassThrough(error)) return Effect.fail(error)
                if (error._tag !== "CellEvaluationError") recoveryPending = true
                return Schema.encodeEffect(CellFailure)(error).pipe(
                  Effect.mapError(
                    (cause) =>
                      new StorageError({ message: "Failed to encode cell failure", cause }),
                  ),
                  Effect.map((value) =>
                    Prompt.toolResultPart({
                      id: call.toolCallId,
                      name: "cell",
                      result: value,
                      isFailure: true,
                      providerExecuted: false,
                    }),
                  ),
                )
              },
            }),
          )
          yield* storage.complete(address, result)
          return result
        })
        const reset = Effect.fn("CellExecution.reset")(function* () {
          if (Option.isSome(kernel)) yield* kernel.value.reset
          yield* namespaces.clear(namespaceAddress).pipe(Effect.orDie)
          recoveryPending = false
          restoreReport = Option.none()
        })
        const cancel = Effect.fn("CellExecution.cancel")(function* () {
          cancellationEpoch++
          if (Option.isSome(active)) yield* Deferred.fail(active.value, cancelled())
          yield* Semaphore.withPermit(permit, Effect.void)
        })
        return CellExecution.of({
          run: (call) =>
            Effect.suspend(() => Semaphore.withPermit(permit, run(call, cancellationEpoch))),
          reset: Semaphore.withPermit(permit, reset()),
          cancel: cancel().pipe(Effect.uninterruptible),
        })
      }),
    )
}
