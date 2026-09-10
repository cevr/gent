/**
 * The storage tags the cell needs, as one name.
 *
 * The cell runs other tools inside itself, so all three tables travel with the
 * turn together. Core does not name them: it carries whatever the branch tool
 * layer builds, so adding, splitting, or removing one of these never edits
 * core.
 */

import type { CellExecutionStorage } from "./cell-execution-storage.js"
import type { CellNamespaceStorage } from "./cell-namespace-storage.js"
import type { CellToolOperationStorage } from "./cell-tool-operation-storage.js"

export type DispatchingToolStorage =
  | CellExecutionStorage
  | CellNamespaceStorage
  | CellToolOperationStorage
