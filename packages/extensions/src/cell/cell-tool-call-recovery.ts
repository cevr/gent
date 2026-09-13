/**
 * The cell's answer to core's crash-recovery question.
 *
 * A cell that was mid-flight when the process died left receipts: an outer
 * admission, and one row per inner call. Those settle the call without running
 * it again. A tool call that is not a cell, or a cell that was never admitted,
 * is re-issued instead.
 */

import { ToolCallId } from "@gent/core/extensions/api"
import {
  CurrentAgentLoopTurnProfile,
  type InteractionStorage,
  ToolCallRecoveryError,
  ToolCallRecoveryOutcome,
  ToolCallRecoveryService,
} from "@gent/core/extensions/branch-tools"
import { Effect, Layer, Option } from "effect"
import { CellExecutionStorage } from "./cell-execution-storage.js"
import type { CellToolOperationStorage } from "./cell-tool-operation-storage.js"
import { recoverCellExecution } from "./cell-recovery.js"
import { CELL_TOOL_ID } from "./cell-tool.js"

export const cellToolCallRecovery = Layer.effect(
  ToolCallRecoveryService,
  Effect.gen(function* () {
    const cells = yield* CellExecutionStorage
    // `recoverCellExecution` reads the cell's own storage. The layer already
    // has it, so capture it once here; the service's Effect then requires only
    // the per-turn profile, which the loop supplies at the call.
    const cellContext = yield* Effect.context<
      CellToolOperationStorage | CellExecutionStorage | InteractionStorage
    >()
    const recover = (input: Parameters<typeof recoverCellExecution>[0]) =>
      Effect.provide(recoverCellExecution(input), cellContext)
    return ToolCallRecoveryService.of({
      recover: Effect.fn("CellToolCallRecovery.recover")(function* (params) {
        if (params.toolCall.name !== CELL_TOOL_ID)
          return ToolCallRecoveryOutcome.cases.NotRecovered.make({})
        const cell = {
          sessionId: params.sessionId,
          branchId: params.branchId,
          assistantMessageId: params.assistantMessageId,
          toolCallId: ToolCallId.make(params.toolCall.id),
        }
        const saved = yield* cells
          .get(cell)
          .pipe(
            Effect.mapError(
              (cause) => new ToolCallRecoveryError({ message: "Cannot read the receipt", cause }),
            ),
          )
        // Never admitted: nothing ran, so re-issue rather than settle.
        if (Option.isNone(saved)) return ToolCallRecoveryOutcome.cases.NotRecovered.make({})
        const profile = yield* CurrentAgentLoopTurnProfile
        return yield* recover({ cell, profile }).pipe(
          Effect.map((result) => ToolCallRecoveryOutcome.cases.Settled.make({ result })),
          Effect.catchTag("CellToolCallSuspended", (suspended) =>
            Effect.succeed(
              ToolCallRecoveryOutcome.cases.Suspended.make({
                requestId: suspended.pending.requestId,
              }),
            ),
          ),
          Effect.mapError(
            (cause) => new ToolCallRecoveryError({ message: "Recovery failed", cause }),
          ),
        )
      }),
    })
  }),
)
