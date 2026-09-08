/**
 * Test preset — provides extension config for core integration tests.
 * Imports from @gent/extensions so test-utils don't need to.
 */
import { BuiltinExtensions } from "@gent/extensions"
import { CellExtension } from "@gent/core-internal/runtime/code-cell/cell-extension"
import { AllBuiltinAgents } from "./builtin-agents.js"
import type { E2ELayerConfig } from "@gent/core-internal/test-utils/e2e-layer"
import type { ToolTestLayerConfig } from "@gent/core-internal/test-utils/extension-harness"

/** The shipped composition: core's cell builtin plus the extension builtins. */
export const shippedPreset = {
  agents: AllBuiltinAgents,
  extensionInputs: [CellExtension, ...BuiltinExtensions],
} satisfies Pick<E2ELayerConfig, "agents" | "extensionInputs">

/**
 * Native tool surface for tool-behavior tests. Without the cell builtin the
 * model calls host tools directly; the same bound execution path serves cells.
 */
export const e2ePreset = {
  agents: AllBuiltinAgents,
  extensionInputs: BuiltinExtensions,
} satisfies Pick<E2ELayerConfig, "agents" | "extensionInputs">

export const toolPreset = {
  agents: AllBuiltinAgents,
} satisfies Pick<ToolTestLayerConfig, "agents" | "extraLayers">
