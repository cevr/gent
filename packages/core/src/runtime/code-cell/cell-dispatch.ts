import { Effect, Option, Predicate } from "effect"
import { CurrentToolCall } from "../agent/current-tool-call.js"
import {
  CurrentAgentLoopTurnProfile,
  runAgentLoopTurnProfile,
} from "../agent/agent-loop.turn-profile.js"
import { AgentLoopError } from "../agent/agent-loop.state.js"
import { buildCellCatalog } from "./cell-catalog.js"
import { CellExecution } from "./cell-execution.js"
import { CellOperationHost } from "./cell-kernel.js"
import { withCellOperationReceipts } from "./cell-operation-receipt.js"
import { makeCellToolHost, requireCellHostBranch } from "./cell-tool-host.js"
import { CurrentCellToolOperation } from "./current-cell-tool-operation.js"

/** Execute the current recorded outer call, never a call address supplied by cell code. */
export const dispatchCell = Effect.fn("CellExecution.dispatch")(function* () {
  if (Option.isSome(yield* Effect.serviceOption(CurrentCellToolOperation))) {
    return yield* new AgentLoopError({
      message: "A cell cannot invoke another outer cell as a host tool",
    })
  }
  const execution = yield* Effect.serviceOption(CellExecution)
  if (Option.isNone(execution)) {
    return yield* new AgentLoopError({ message: "Cell execution requires a branch-owned runtime" })
  }
  const call = yield* Effect.serviceOption(CurrentToolCall)
  const profile = yield* Effect.serviceOption(CurrentAgentLoopTurnProfile)
  if (Option.isNone(call) || Option.isNone(profile)) {
    return yield* new AgentLoopError({ message: "Cell execution requires a recorded turn call" })
  }
  const cell = call.value
  const current = profile.value
  const turnPublication = current.turnPublication
  if (Predicate.isUndefined(turnPublication)) {
    return yield* new AgentLoopError({ message: "Cell execution requires a live turn publication" })
  }
  const params = {
    cell,
    toolBindings: call.value.toolBindings,
    catalog: yield* buildCellCatalog(call.value.toolBindings),
    profile: { ...current, turnPublication },
  }
  yield* requireCellHostBranch(params)
  const result = yield* execution.value
    .run(cell)
    .pipe(Effect.provideService(CellOperationHost, makeCellToolHost(params)))
  return yield* runAgentLoopTurnProfile(params.profile)(withCellOperationReceipts(cell, result))
})
