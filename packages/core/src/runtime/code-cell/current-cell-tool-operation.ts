import { Context } from "effect"
import type { CellToolOperationKey } from "../../storage/cell-tool-operation-storage.js"

/** Host-owned address of the admitted inner operation. Never supplied by cell code. */
export class CurrentCellToolOperation extends Context.Service<
  CurrentCellToolOperation,
  CellToolOperationKey
>()("@gent/core/src/runtime/code-cell/current-cell-tool-operation/CurrentCellToolOperation") {}
