/**
 * Test preset — provides extension config for core integration tests.
 * Imports from @gent/extensions so test-utils don't need to.
 */
import type { Layer } from "effect"
import { tmpdir } from "node:os"
import { BuiltinExtensions, AllBuiltinAgents } from "@gent/extensions"
import { GitReader } from "@gent/extensions/librarian/git-reader.js"
import { Test as MemoryVaultTest } from "@gent/extensions/memory/vault.js"
import type { E2ELayerConfig } from "@gent/core/test-utils/e2e-layer"
import type { ToolTestLayerConfig } from "@gent/core/test-utils/extension-harness"

const memoryVaultTestLayer = () =>
  MemoryVaultTest(`${tmpdir()}/gent-e2e-${Date.now()}`) as Layer.Layer<never>

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
