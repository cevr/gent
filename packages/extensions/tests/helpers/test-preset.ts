/**
 * The shipped extensions as E2E presets for extension tests. The builtin
 * agents extension contributes the agents, so `agents` stays empty.
 */
import { BuiltinExtensions } from "@gent/extensions"

import { CellExtension } from "../../src/cell.js"
import type { E2ELayerConfig } from "@gent/core/test-utils"

/** The shipped composition: every builtin extension, the agents and the cell among them. */
export const shippedPreset = {
  agents: [],
  extensionInputs: BuiltinExtensions,
} satisfies Pick<E2ELayerConfig, "agents" | "extensionInputs">

/**
 * Native tool surface for tool-behavior tests. Without the cell builtin the
 * model calls host tools directly; the same bound execution path serves cells.
 */
export const e2ePreset = {
  agents: [],
  extensionInputs: BuiltinExtensions.filter(
    (extension) => extension.manifest.id !== CellExtension.manifest.id,
  ),
} satisfies Pick<E2ELayerConfig, "agents" | "extensionInputs">
