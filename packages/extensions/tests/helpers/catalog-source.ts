import { Effect, Exit, type FileSystem, Layer, Path, Scope } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { makeTempDirectoryScoped } from "@gent/core-internal/test-utils/language-model"
import type { CatalogSource } from "../../src/models-dev.js"

const platformLayer = Layer.merge(BunFileSystem.layer, Path.layer)

/**
 * One empty home for this test file's drivers, and the platform services they
 * read it through. A driver pointed here finds no cache, which is what these
 * tests want: they exercise `resolveModel` and the auth methods, never
 * `listModels`.
 *
 * The scope is closed when the test process exits, which removes the
 * directory. `makeTempDirectoryScoped` is `mkdtempSync` under an
 * `acquireRelease`, so building it and the platform context is synchronous.
 */
const scope = Scope.makeUnsafe()

const source = Effect.runSync(
  Effect.gen(function* () {
    const home = yield* makeTempDirectoryScoped("gent-no-catalog-")
    const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
    return { home, platform } satisfies CatalogSource
    // oxlint-disable-next-line effect/noInlineProvide -- This helper composes the platform layer it captures.
  }).pipe(Effect.provide(platformLayer), Scope.provide(scope)),
)

process.on("exit", () => {
  Effect.runSync(Scope.close(scope, Exit.void))
})

/**
 * A `CatalogSource` for a test that exercises a driver's `resolveModel` or its
 * auth methods rather than its catalog.
 */
export const testCatalogSource = (): CatalogSource => source
