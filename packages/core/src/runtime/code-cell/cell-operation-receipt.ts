import { Effect, Option, Schema } from "effect"
import type * as Prompt from "effect/unstable/ai/Prompt"
import { ToolCallId } from "../../domain/ids.js"
import { summarizeToolOutput } from "../../domain/tool-output.js"
import {
  CellToolOperationStorage,
  type CellToolOperation,
} from "../../storage/cell-tool-operation-storage.js"
import type { OwnedToolCallAddress } from "../../storage/sqlite/owned-tool-call.js"

/** Compact record of one admitted inner call. It stays in the saved cell result. */
export const CellOperationReceipt = Schema.Struct({
  toolCallId: ToolCallId,
  tool: Schema.String,
  outcome: Schema.Literals(["succeeded", "failed", "incomplete"]),
  summary: Schema.String,
})
export type CellOperationReceipt = typeof CellOperationReceipt.Type

export const CELL_OPERATIONS_KEY = "operations"

const decodeJsonObject = Schema.decodeUnknownOption(Schema.JsonObject)
const encodeReceipts = Schema.encodeSync(Schema.Array(CellOperationReceipt))

const receiptFor = (operation: CellToolOperation): CellOperationReceipt => {
  if (operation.state._tag !== "Completed") {
    return {
      toolCallId: operation.toolCallId,
      tool: operation.binding.toolId,
      outcome: "incomplete",
      summary: "",
    }
  }
  let outcome: CellOperationReceipt["outcome"] = "succeeded"
  if (operation.state.result.isFailure) outcome = "failed"
  return {
    toolCallId: operation.toolCallId,
    tool: operation.binding.toolId,
    outcome,
    summary: summarizeToolOutput(operation.state.result),
  }
}

/**
 * Attach inner-operation receipts to a saved cell result. The transcript keeps
 * effects visible after reload. Cells without inner calls stay unchanged.
 */
export const withCellOperationReceipts = Effect.fn("CellOperationReceipt.attach")(function* (
  cell: OwnedToolCallAddress,
  result: Prompt.ToolResultPart,
) {
  const storage = yield* CellToolOperationStorage
  const operations = yield* storage.listForCell(cell)
  if (operations.length === 0) return result
  const value = decodeJsonObject(result.result)
  if (Option.isNone(value)) return result
  const receipts = encodeReceipts(operations.map((entry) => receiptFor(entry.operation)))
  return { ...result, result: { ...value.value, [CELL_OPERATIONS_KEY]: receipts } }
})
