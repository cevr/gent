/**
 * The source run's preload (`apps/tui/bunfig.toml`): OpenTUI's Solid JSX
 * transform behind a content-addressed disk cache, so a launch runs Babel only
 * for a `.tsx` file whose text it has not transformed before.
 *
 * A result is keyed by the lockfile, which pins the transform's packages, and
 * by the file's path and text: an edit or an upgrade misses. The cache lives
 * in `$XDG_CACHE_HOME/gent/solid-transform/<lockfile digest>/` (else under
 * `~/.cache`); the first launch after a lockfile change removes the
 * directories of other digests that gained no entry for a month, since other
 * checkouts share the root. A cache that cannot be made or written costs only
 * speed: the launch transforms uncached. The compiled binary transforms at
 * build time and never reads it. The Bun plugin's callbacks are this file's
 * Promise edge.
 */
// oxlint-disable-next-line effect/noNodeBuiltinImport -- a preload registers its Bun plugin itself; Effect has no plugin service
import { plugin } from "bun"
import { Clock, Config, Duration, Effect, FileSystem, ManagedRuntime, Option, Path } from "effect"
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

/** Another lockfile's directory that gained no entry for this long is removed. */
const UNUSED_CACHE_AGE = Duration.days(30)

/**
 * The cache directory for this lockfile, made once per launch. None when it
 * cannot be made: the launch then transforms every file, uncached.
 */
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
    yield* fs.makeDirectory(directory, { recursive: true })
    // Other checkouts share the root: only a directory no launch wrote to for a month goes.
    const now = yield* Clock.currentTimeMillis
    const others = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []))
    yield* Effect.forEach(
      others.filter((name) => name !== digest),
      (name) =>
        Effect.gen(function* () {
          const other = path.join(root, name)
          const modified = Option.match((yield* fs.stat(other)).mtime, {
            onNone: () => now,
            onSome: (mtime) => mtime.getTime(),
          })
          if (now - modified < Duration.toMillis(UNUSED_CACHE_AGE)) return
          yield* fs.remove(other, { recursive: true })
        }).pipe(Effect.ignore),
    )
  }
  return directory
}).pipe(Effect.option)

const runtime = ManagedRuntime.make(BunPlatformLive)
const cache = runtime.runPromise(openCache)

/** The file's transformed text: from the cache, or from the transform, then stored. */
const transformed = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const platform = yield* GentPlatform
    const directory = yield* Effect.promise(() => cache)
    const code = yield* fs.readFileString(file)
    const cached = Option.map(directory, (dir) =>
      path.join(dir, `${platform.hash("sha256", `${file}\0${code}`)}.js`),
    )
    if (Option.isSome(cached)) {
      const hit = yield* fs.readFileString(cached.value).pipe(Effect.option)
      if (Option.isSome(hit)) return hit.value
    }
    // The module registry keeps the loaded transform, so each miss imports it again cheaply.
    const { transformSolidSource } = yield* loadTransform
    const contents = yield* Effect.promise(() =>
      transformSolidSource(code, { filename: file, moduleName: SOLID_RUNTIME }),
    )
    // A result that cannot be stored costs only the next launch a transform.
    if (Option.isSome(cached)) yield* writeFileAtomic(cached.value, contents).pipe(Effect.ignore)
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
