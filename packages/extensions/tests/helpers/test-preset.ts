/**
 * The shipped extensions as E2E presets for extension tests. The builtin
 * agents extension contributes the agents, so `agents` stays empty.
 */
import { BuiltinExtensions, CellBranchTools } from "@gent/extensions"

export { ModelContextCompactorLive } from "../../src/compaction.js"
import { CELL_EXTENSION_ID } from "../../src/cell.js"
import type { E2ELayerConfig } from "@gent/core/test-utils"

/**
 * The shipped composition: every builtin extension (the agents among them), and the branch-tool
 * feature the cell surface among them runs on. Named together because a
 * `cell` tool whose storage and kernel are missing fails on first use.
 */
export const shippedPreset = {
  agents: [],
  extensionInputs: BuiltinExtensions,
  branchTools: CellBranchTools,
} satisfies Pick<E2ELayerConfig, "agents" | "extensionInputs" | "branchTools">

/**
 * Native tool surface for tool-behavior tests. Without the cell builtin the
 * model calls host tools directly; the same bound execution path serves cells.
 */
export const e2ePreset = {
  agents: [],
  extensionInputs: BuiltinExtensions.filter(
    (extension) => extension.manifest.id !== CELL_EXTENSION_ID,
  ),
} satisfies Pick<E2ELayerConfig, "agents" | "extensionInputs">
