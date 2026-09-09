/**
 * The storage tags a dispatching tool needs carried through the loop context.
 *
 * A dispatching tool runs other tools inside itself, so its storage has to
 * travel with the turn. Core's requirement unions name this alias rather than
 * the tags behind it, so adding, splitting, or removing one of them never
 * edits core.
 */

import type { CellExecutionStorage } from "./cell-execution-storage.js"
import type { CellNamespaceStorage } from "./cell-namespace-storage.js"
import type { CellToolOperationStorage } from "./cell-tool-operation-storage.js"

export type DispatchingToolStorage =
  | CellExecutionStorage
  | CellNamespaceStorage
  | CellToolOperationStorage
