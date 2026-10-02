import { Config, Effect, type FileSystem, Layer, Path, type Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { BunFileSystem } from "@effect/platform-bun"
import { type CatalogSource, modelsDevCatalog } from "../../src/providers.js"
import { encodeExternalJson } from "./external-wire.js"

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
// oxlint-disable-next-line effect/noEffectRunInTests -- A driver takes the source as a plain value where a test builds it; the module builds it once at load.
const source = Effect.runSync(
  Effect.gen(function* () {
    const path = yield* Path.Path
    const home = path.join(yield* Config.String("HOME"), "no-catalog")
    const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
    return { home, platform } satisfies CatalogSource
  }).pipe(Effect.provide(platformLayer), Effect.orDie),
)

/**
 * A `CatalogSource` for a test that exercises a driver's `resolveModel` or its
 * auth methods rather than its catalog.
 */
export const testCatalogSource = (): CatalogSource => source

/** An HTTP client that answers the models.dev fetch with `payload`. */
const catalogHttpLayer = (payload: Schema.Json) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(encodeExternalJson(payload), { status: 200 }),
        ),
      ),
    ),
  )

/**
 * Seed `home`'s catalog with `payload`, a models.dev document. The catalog
 * keeps one load per home and writes it to the home's cache, so a driver
 * whose `listModels` reads `home` gets the fixture and fetches nothing. A
 * payload that parses to no model is a broken fixture: the catalog keeps no
 * empty load, and the next read would fetch.
 */
export const seedCatalog = Effect.fn("test.seedCatalog")(function* (
  home: string,
  payload: Schema.Json,
) {
  const models = yield* modelsDevCatalog(home).pipe(
    Effect.provide(Layer.merge(catalogHttpLayer(payload), platformLayer)),
  )
  if (models.length === 0) return yield* Effect.die("the catalog fixture holds no model")
  return models
})
