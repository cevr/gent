/**
 * Test preset — provides extension config for core integration tests.
 * Imports from @gent/extensions so test-utils don't need to.
 */
import { Layer, Path } from "effect"
import { tmpdir } from "node:os"
import { BunFileSystem } from "@effect/platform-bun"
import { BuiltinExtensions, AllBuiltinAgents } from "@gent/extensions"
import { GitReader } from "../../src/librarian/index.js"
import { Test as MemoryVaultTest } from "../../src/memory/vault.js"
import type { E2ELayerConfig } from "@gent/core-internal/test-utils/e2e-layer"
import type { ToolTestLayerConfig } from "@gent/core-internal/test-utils/extension-harness"

let memoryVaultLayerIndex = 0

const memoryVaultTestLayer = () =>
  MemoryVaultTest(`${tmpdir()}/gent-e2e-${process.pid}-${memoryVaultLayerIndex++}`).pipe(
    Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer)),
  ) as Layer.Layer<never>

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
