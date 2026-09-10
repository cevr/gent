import { Context } from "effect"
import type { CellToolOperationKey } from "./cell-tool-operation-storage.js"

/** Host-owned address of the admitted inner operation. Never supplied by cell code. */
export class CurrentCellToolOperation extends Context.Service<
  CurrentCellToolOperation,
  CellToolOperationKey
>()("@gent/extensions/src/cell/current-cell-tool-operation/CurrentCellToolOperation") {}
