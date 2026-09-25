import { Config, Effect, type FileSystem, Layer, Path } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import type { CatalogSource } from "../../src/providers.js"

const platformLayer = Layer.merge(BunFileSystem.layer, Path.layer)

/**
 * One empty home for this test file's drivers, and the platform services they
 * read it through. A driver pointed here finds no cache, which is what these
 * tests want: they exercise `resolveModel` and the auth methods, never
 * `listModels`.
 *
 * The home is a path inside the test process's own `HOME`, the temp home the
 * shared test preload makes and removes in a global `afterAll` after the
 * process's last test. Nothing makes it: a missing directory holds no cache,
 * and whatever a driver writes there goes with the process's home. (A process
 * `exit` handler does not run under `bun test`, so it could not remove it.)
 */
const source = Effect.runSync(
  Effect.gen(function* () {
    const path = yield* Path.Path
    const home = path.join(yield* Config.string("HOME"), "no-catalog")
    const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
    return { home, platform } satisfies CatalogSource
  }).pipe(Effect.provide(platformLayer), Effect.orDie),
)

/**
 * A `CatalogSource` for a test that exercises a driver's `resolveModel` or its
 * auth methods rather than its catalog.
 */
export const testCatalogSource = (): CatalogSource => source
