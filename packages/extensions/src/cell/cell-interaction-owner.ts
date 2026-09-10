/**
 * The cell as the owner of its inner calls' interactions.
 *
 * An approval raised inside a cell belongs to that operation's receipt, so it
 * survives a crash with the operation rather than with the branch. This maps
 * the cell's operation key onto the host-facing `InteractionOwnership` seam so
 * core can route the interaction without knowing what a cell is.
 */

import { EventStoreError, type InteractionOwnership } from "@gent/core/extensions/branch-tools"
import { Effect } from "effect"
import type {
  CellToolOperationKey,
  CellToolOperationStorageService,
} from "./cell-tool-operation-storage.js"

export const cellInteractionOwner = (
  key: CellToolOperationKey,
  storage: CellToolOperationStorageService,
): InteractionOwnership => ({
  sessionId: key.cell.sessionId,
  branchId: key.cell.branchId,
  persist: (record) =>
    storage
      .suspend(key, record)
      .pipe(
        Effect.mapError(
          (cause) =>
            new EventStoreError({ message: "Failed to persist interaction request", cause }),
        ),
      ),
  // `Started` has raised no interaction yet, so a fresh one begins. `Resuming`
  // is mid-approval and replays the id it recorded. Any other state was never
  // admitted to ask.
  resumeRequestId: storage.get(key).pipe(
    Effect.mapError(
      (cause) => new EventStoreError({ message: "Cannot read the interaction owner", cause }),
    ),
    Effect.flatMap((operation) => {
      if (operation.state._tag === "Started") return Effect.succeedNone
      if (operation.state._tag === "Resuming") return Effect.succeedSome(operation.state.requestId)
      return new EventStoreError({ message: "The owning call cannot take an interaction" })
    }),
  ),
})
