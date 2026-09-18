import { Effect, type FileSystem, Layer, Path } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import type { CatalogSource } from "../../src/models-dev.js"

/**
 * A `CatalogSource` for a test that exercises a driver's `resolveModel` or its
 * auth methods rather than its catalog. The home points wherever the test
 * says; nothing is read unless the test runs `listModels`.
 */
export const testCatalogSource = (home: string): CatalogSource => ({
  home,
  platform: Effect.runSync(
    Effect.context<FileSystem.FileSystem | Path.Path>().pipe(
      // oxlint-disable-next-line effect/noInlineProvide -- This helper composes the platform layer it captures.
      Effect.provide(Layer.merge(BunFileSystem.layer, Path.layer)),
    ),
  ),
})
