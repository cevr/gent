/**
 * Test preset — provides extension config for core integration tests.
 * Imports from @gent/extensions so test-utils don't need to.
 */
import { BuiltinExtensions, CellBranchTools } from "@gent/extensions"

export { ModelContextCompactorLive } from "../../src/compaction.js"
import { CELL_EXTENSION_ID } from "../../src/cell.js"
import { AllBuiltinAgents } from "./builtin-agents.js"
import type { E2ELayerConfig } from "@gent/core/test-utils"

/**
 * The shipped composition: every builtin extension, and the branch-tool
 * feature the cell surface among them runs on. Named together because a
 * `cell` tool whose storage and kernel are missing fails on first use.
 */
export const shippedPreset = {
  agents: AllBuiltinAgents,
  extensionInputs: BuiltinExtensions,
  branchTools: CellBranchTools,
} satisfies Pick<E2ELayerConfig, "agents" | "extensionInputs" | "branchTools">

/**
 * Native tool surface for tool-behavior tests. Without the cell builtin the
 * model calls host tools directly; the same bound execution path serves cells.
 */
export const e2ePreset = {
  agents: AllBuiltinAgents,
  extensionInputs: BuiltinExtensions.filter(
    (extension) => extension.manifest.id !== CELL_EXTENSION_ID,
  ),
} satisfies Pick<E2ELayerConfig, "agents" | "extensionInputs">
