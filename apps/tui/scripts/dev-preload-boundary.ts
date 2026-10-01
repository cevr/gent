/**
 * The source run's preload (`apps/tui/bunfig.toml`): OpenTUI's Solid JSX
 * transform behind a content-addressed disk cache, so a launch runs Babel only
 * for a `.tsx` file whose text it has not transformed before.
 *
 * A result is keyed by the lockfile, which pins the transform's packages, and
 * by the file's path and text: an edit or an upgrade misses. The cache lives
 * in `$XDG_CACHE_HOME/gent/solid-transform/<lockfile digest>/` (else under
 * `~/.cache`); the first launch after a lockfile change removes the
 * directories of other digests. The compiled binary transforms at build time
 * and never reads it. The Bun plugin's callbacks are this file's Promise edge.
 */
// oxlint-disable-next-line effect/noNodeBuiltinImport -- a preload registers its Bun plugin itself; Effect has no plugin service
import { plugin } from "bun"
import { Config, Effect, FileSystem, ManagedRuntime, Option, Path } from "effect"
import { BunPlatformLive, GentPlatform, writeFileAtomic } from "@gent/core/host"

/** Raise it when this file changes what a cached result holds. */
const CACHE_FORMAT = "1"

/** The JSX runtime the TUI's components import, as the stock preload names it. */
const SOLID_RUNTIME = "@opentui/solid"

/** A source `.jsx`/`.tsx` file outside `node_modules`, as the stock preload matches it. */
const SOURCE_FILE = /^(?!.*[/\\]node_modules[/\\]).*\.[cm]?[jt]sx(?:[?#].*)?$/

/** Solid's server builds, which Bun resolves, and the client builds beside them the TUI renders with. */
const SOLID_CLIENT_BUILDS = [
  {
    filter: /[/\\]node_modules[/\\]solid-js[/\\]dist[/\\]server\.js(?:[?#].*)?$/,
    client: "solid.js",
  },
  {
    filter: /[/\\]node_modules[/\\]solid-js[/\\]store[/\\]dist[/\\]server\.js(?:[?#].*)?$/,
    client: "store.js",
  },
]

interface SolidTransformModule {
  readonly transformSolidSource: (
    code: string,
    options: { readonly filename: string; readonly moduleName: string },
  ) => Promise<string>
}

/** The module path without the query or hash Bun may append. */
const filePath = (modulePath: string) => modulePath.replace(/[?#].*$/, "")

/**
 * OpenTUI's transform, loaded on the first miss: Babel is large, and a warm
 * cache never needs it. The package exports only its plugin, so the
 * transform is read from beside it.
 */
const loadTransform = Effect.promise(
  (): Promise<SolidTransformModule> =>
    // oxlint-disable-next-line effect/noDynamicImports -- Babel loads only when a file misses the cache
    import(new URL("./solid-transform.js", import.meta.resolve("@opentui/solid/bun-plugin")).href),
)

/** The cache directory for this lockfile, made once per launch, and the transform behind it. */
const openCache = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const platform = yield* GentPlatform
  const home = yield* platform.homeDirectory
  const cacheHome = yield* Config.option(Config.String("XDG_CACHE_HOME")).pipe(
    Effect.map(Option.getOrElse(() => path.join(home, ".cache"))),
  )
  const root = path.join(cacheHome, "gent", "solid-transform")
  const lockfile = yield* path.fromFileUrl(new URL("../../../bun.lock", import.meta.url))
  const digest = platform.hash("sha256", `${CACHE_FORMAT}\0${yield* fs.readFileString(lockfile)}`)
  const directory = path.join(root, digest)
  if (!(yield* fs.exists(directory))) {
    const stale = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []))
    yield* Effect.forEach(stale, (name) =>
      fs.remove(path.join(root, name), { recursive: true }).pipe(Effect.ignore),
    )
    yield* fs.makeDirectory(directory, { recursive: true })
  }
  return { directory, transform: yield* Effect.cached(loadTransform) }
})

const runtime = ManagedRuntime.make(BunPlatformLive)
const cache = runtime.runPromise(openCache)

/** The file's transformed text: from the cache, or from the transform, then stored. */
const transformed = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const platform = yield* GentPlatform
    const { directory, transform } = yield* Effect.promise(() => cache)
    const code = yield* fs.readFileString(file)
    const cached = path.join(directory, `${platform.hash("sha256", `${file}\0${code}`)}.js`)
    const hit = yield* fs.readFileString(cached).pipe(Effect.option)
    if (Option.isSome(hit)) return hit.value
    const { transformSolidSource } = yield* transform
    const contents = yield* Effect.promise(() =>
      transformSolidSource(code, { filename: file, moduleName: SOLID_RUNTIME }),
    )
    // A result that cannot be stored costs only the next launch a transform.
    yield* writeFileAtomic(cached, contents).pipe(Effect.ignore)
    return contents
  })

/** Solid's client build in place of the server build at `file`. */
const clientBuild = (file: string, client: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return yield* fs.readFileString(path.join(path.dirname(file), client))
  })

const asModule = (text: string) => ({ contents: text, loader: "js" as const })

plugin({
  name: "gent-solid-transform-cache",
  setup: (build) => {
    for (const { filter, client } of SOLID_CLIENT_BUILDS) {
      build.onLoad({ filter }, (args) =>
        runtime.runPromise(Effect.map(clientBuild(filePath(args.path), client), asModule)),
      )
    }
    build.onLoad({ filter: SOURCE_FILE }, (args) =>
      runtime.runPromise(Effect.map(transformed(filePath(args.path)), asModule)),
    )
  },
})
