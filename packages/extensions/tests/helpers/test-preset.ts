/**
 * Test preset — provides extension config for core integration tests.
 * Imports from @gent/extensions so test-utils don't need to.
 */
import { Layer, Path } from "effect"
import { tmpdir } from "node:os"
import { BunFileSystem } from "@effect/platform-bun"
import { BuiltinExtensions } from "@gent/extensions"
import { CellExtension } from "@gent/core-internal/runtime/code-cell/cell-extension"
import { AllBuiltinAgents } from "./builtin-agents.js"
import { GitReader } from "../../src/librarian/index.js"
import { Test as MemoryVaultTest } from "../../src/memory/vault.js"
import type { E2ELayerConfig } from "@gent/core-internal/test-utils/e2e-layer"
import type { ToolTestLayerConfig } from "@gent/core-internal/test-utils/extension-harness"

let memoryVaultLayerIndex = 0

const memoryVaultTestLayer = () =>
  MemoryVaultTest(`${tmpdir()}/gent-e2e-${process.pid}-${memoryVaultLayerIndex++}`).pipe(
    Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer)),
  )

/** The shipped composition: core's cell builtin plus the extension builtins. */
export const shippedPreset = {
  agents: AllBuiltinAgents,
  extensionInputs: [CellExtension, ...BuiltinExtensions],
  layerOverrides: {
    "@gent/memory": memoryVaultTestLayer,
  },
} satisfies Pick<E2ELayerConfig, "agents" | "extensionInputs" | "layerOverrides">

/**
 * Native tool surface for tool-behavior tests. Without the cell builtin the
 * model calls host tools directly; the same bound execution path serves cells.
 */
export const e2ePreset = {
  agents: AllBuiltinAgents,
  extensionInputs: BuiltinExtensions,
  layerOverrides: {
    "@gent/memory": memoryVaultTestLayer,
  },
} satisfies Pick<E2ELayerConfig, "agents" | "extensionInputs" | "layerOverrides">

export const toolPreset = {
  agents: AllBuiltinAgents,
  extraLayers: [GitReader.Test],
} satisfies Pick<ToolTestLayerConfig, "agents" | "extraLayers">
