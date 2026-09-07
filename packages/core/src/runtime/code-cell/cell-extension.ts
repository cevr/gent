import { ExtensionId } from "../../domain/ids.js"
import { defineExtension } from "../../extensions/api.js"
import { CellTool } from "./cell-tool.js"

export const CELL_EXTENSION_ID = ExtensionId.make("@gent/cell")

/**
 * The default model execution surface. When this builtin is registered, a native
 * model turn advertises only `cell`; host tools stay callable inside the cell
 * through the turn's bound identities, and the kernel's local `tools.search` and
 * `tools.describe` read the catalog the host ships with each changed turn.
 * Core owns this registration because the turn resolver owns the `cell` surface rule.
 */
export const CellExtension = defineExtension({
  id: CELL_EXTENSION_ID,
  tools: [CellTool],
})
