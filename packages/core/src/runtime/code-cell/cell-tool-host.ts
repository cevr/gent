import { Effect, Option } from "effect"
import type { InteractionRequestId } from "../../domain/ids.js"
import { CellToolOperationStorage } from "../../storage/cell-tool-operation-storage.js"
import type { OwnedToolCallAddress } from "../../storage/sqlite/owned-tool-call.js"
import {
  cellOperationBindingIdentity,
  resolveStoredToolBinding,
} from "../agent/tool-binding-resolution.js"
import type { ResolvedToolCapability } from "../agent/tool-runner.js"
import {
  runAgentLoopTurnProfile,
  type LiveAgentLoopTurnProfile,
} from "../agent/agent-loop.turn-profile.js"
import { CellOperationHost } from "./cell-kernel.js"
import { CellEvaluationError } from "./cell-protocol.js"
import { CurrentCellToolOperation } from "./current-cell-tool-operation.js"
import { executeBoundCellTool, cellToolResultValue } from "./cell-tool-call.js"

interface CellToolHostParams {
  readonly cell: OwnedToolCallAddress
  readonly profile: LiveAgentLoopTurnProfile
}

export const requireCellHostBranch = (params: CellToolHostParams) =>
  Effect.gen(function* () {
    if (
      params.profile.turnHostCtx.sessionId !== params.cell.sessionId ||
      params.profile.turnHostCtx.branchId !== params.cell.branchId
    )
      return yield* new CellEvaluationError({
        phase: "execute",
        message: "Cell host belongs to another branch",
        output: "",
      })
  })

/** Resume the selected inner operation, never the outer cell's JavaScript. */
export const resumeCellToolOperation = Effect.fn("CellToolHost.resume")(
  (
    params: CellToolHostParams & {
      readonly operationId: string
      readonly requestId: InteractionRequestId
    },
  ) =>
    runAgentLoopTurnProfile(params.profile)(
      Effect.gen(function* () {
        yield* requireCellHostBranch(params)
        const storage = yield* CellToolOperationStorage
        const key = { cell: params.cell, operationId: params.operationId }
        const stored = yield* storage.get(key)
        const binding = yield* resolveStoredToolBinding({
          sessionId: params.cell.sessionId,
          assistantMessageId: params.cell.assistantMessageId,
          toolCallId: stored.toolCallId,
          binding: stored.binding,
          publication: params.profile.turnPublication,
        })
        const admitted = yield* storage.resume(key, params.requestId)
        const result = yield* executeBoundCellTool({
          request: {
            operationId: params.operationId,
            name: admitted.binding.toolId,
            input: admitted.input,
          },
          toolCallId: admitted.toolCallId,
          binding: Option.some(binding),
        }).pipe(Effect.provideService(CurrentCellToolOperation, key))
        yield* storage.complete(key, result)
        return result
      }),
    ),
)

/** One outer cell's host. The existing publication owns every admitted call. */
export const makeCellToolHost = (
  params: CellToolHostParams & {
    readonly toolBindings: ReadonlyMap<string, ResolvedToolCapability>
  },
): typeof CellOperationHost.Service =>
  CellOperationHost.of({
    call: Effect.fn("CellToolHost.call")((request) =>
      runAgentLoopTurnProfile(params.profile)(
        Effect.gen(function* () {
          yield* requireCellHostBranch(params)
          const storage = yield* CellToolOperationStorage
          const captured = Option.fromUndefinedOr(params.toolBindings.get(request.name))
          if (Option.isNone(captured))
            return yield* new CellEvaluationError({
              phase: "execute",
              message: `Tool ${request.name} is not selected for this turn`,
              output: "",
            })
          const identity = yield* cellOperationBindingIdentity(
            captured.value,
            params.profile.turnPublication,
          )
          if (Option.isNone(identity))
            return yield* new CellEvaluationError({
              phase: "execute",
              message: `Tool ${request.name} has no bindable source identity`,
              output: "",
            })
          const key = { cell: params.cell, operationId: request.operationId }
          const admission = yield* storage.admit({
            ...key,
            binding: identity.value,
            input: request.input,
          })
          if (!admission.admitted) {
            if (admission.operation.state._tag === "Completed")
              return yield* cellToolResultValue(admission.operation.state.result)
            return yield* new CellEvaluationError({
              phase: "execute",
              message:
                "Cell operation has no recorded result. Its effects may have occurred. It was not executed again.",
              output: "",
            })
          }
          const result = yield* executeBoundCellTool({
            request,
            toolCallId: admission.operation.toolCallId,
            binding: captured,
          }).pipe(Effect.provideService(CurrentCellToolOperation, key))
          yield* storage.complete(key, result)
          return yield* cellToolResultValue(result)
        }),
      ).pipe(
        Effect.catchTags({
          StorageError: (cause) =>
            Effect.fail(
              new CellEvaluationError({
                phase: "execute",
                message: `Cell operation storage failed. Its effects may have occurred: ${cause.message}`,
                output: "",
              }),
            ),
          AgentLoopError: (cause) =>
            Effect.fail(
              new CellEvaluationError({
                phase: "execute",
                message: cause.message,
                output: "",
              }),
            ),
        }),
      ),
    ),
  })
