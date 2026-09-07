import { Effect, Option, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { InteractionPendingError } from "../../domain/interaction-request.js"
import { StorageError } from "../../domain/storage-error.js"
import { CellExecutionStorage } from "../../storage/cell-execution-storage.js"
import {
  CellToolOperationStorage,
  CellToolOperationId,
} from "../../storage/cell-tool-operation-storage.js"
import { InteractionStorage } from "../../storage/interaction-storage.js"
import { ToolCallId, ToolId } from "../../domain/ids.js"
import { CellToolCallSuspended } from "./cell-kernel.js"
import { requireCellHostBranch, resumeCellToolOperation } from "./cell-tool-host.js"

const RecoveredOperation = Schema.TaggedUnion({
  Completed: { operationId: CellToolOperationId, result: Prompt.ToolResultPart },
  Unknown: { operationId: CellToolOperationId, toolCallId: ToolCallId, toolName: ToolId },
})

/** The branch owner calls this only after cell execution has stopped. No source replay. */
export const recoverCellExecution = Effect.fn("CellExecution.recover")(function* (
  params: Pick<Parameters<typeof resumeCellToolOperation>[0], "cell" | "profile">,
) {
  yield* requireCellHostBranch(params)
  const operations = yield* CellToolOperationStorage
  const cells = yield* CellExecutionStorage
  const interactions = yield* InteractionStorage
  const outer = yield* cells
    .get(params.cell)
    .pipe(
      Effect.flatMap(
        Effect.fromOption(() => new StorageError({ message: "Cell has not been admitted" })),
      ),
    )
  if (outer._tag === "Completed") return outer.result
  const records = yield* operations.listForCell(params.cell)
  const pending = yield* interactions.listPending(params.cell)
  for (const { key, operation } of records) {
    if (operation.state._tag !== "Waiting") continue
    const requestId = operation.state.requestId
    const request = Option.fromUndefinedOr(pending.find((record) => record.requestId === requestId))
    if (Option.isNone(request))
      return yield* new StorageError({
        message: "Cell approval request is missing during recovery",
      })
    if (Option.isNone(Option.fromUndefinedOr(request.value.decisionJson)))
      return yield* new CellToolCallSuspended({
        operationId: key.operationId,
        toolCallId: operation.toolCallId,
        pending: new InteractionPendingError({
          requestId,
          sessionId: params.cell.sessionId,
          branchId: params.cell.branchId,
        }),
      })
    yield* resumeCellToolOperation({ ...params, operationId: key.operationId, requestId })
  }
  const latest = yield* operations.listForCell(params.cell)
  const outcomes = latest.map(({ key, operation }) => {
    if (operation.state._tag === "Completed")
      return RecoveredOperation.cases.Completed.make({
        operationId: key.operationId,
        result: operation.state.result,
      })
    return RecoveredOperation.cases.Unknown.make({
      operationId: key.operationId,
      toolCallId: operation.toolCallId,
      toolName: operation.binding.toolId,
    })
  })
  const result = Prompt.toolResultPart({
    id: params.cell.toolCallId,
    name: "cell",
    isFailure: true,
    providerExecuted: false,
    result: {
      error:
        "The cell worker state was lost. Its source was not replayed. Unrecorded operation effects may have occurred.",
      stateLost: true,
      operations: outcomes,
    },
  })
  yield* cells.complete(params.cell, result)
  return result
})
