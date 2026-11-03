import { BunCrypto, BunRuntime, BunServices } from "@effect/platform-bun"
import solidTransformPlugin from "@opentui/solid/bun-plugin"
import { Config, Effect, FileSystem, Layer, Option, Path, Result, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { GentReleaseFacts } from "@gent/core/host"
import { captureRelease } from "@gent/core/host-bun"

class BuildError extends Schema.TaggedError<BuildError, { readonly brand: unique symbol }>()(
  "BuildError",
  {
    message: Schema.String,
  },
) {}

/** The version field of `apps/tui/package.json`: the gent version. */
const PackageVersion = Schema.fromJsonString(Schema.Struct({ version: Schema.NonEmptyString }))

/**
 * The release builds each platform on its own runner and names the Bun
 * runtime to embed (x64 takes the baseline build, which runs on CPUs without
 * AVX2). Unset, the build embeds the host's own runtime. The cell worker's
 * build reads the same variable (`packages/extensions/package.json`).
 */
const compileTarget = Config.option(
  Config.Literals(
    [
      "bun-darwin-arm64",
      "bun-darwin-x64",
      "bun-darwin-x64-baseline",
      "bun-linux-arm64",
      "bun-linux-x64",
      "bun-linux-x64-baseline",
    ],
    "GENT_COMPILE_TARGET",
  ),
)

/**
 * Effect's `NodeWS` is `export * from "ws"`, and `ws` is a Bun built-in that
 * the bundle keeps external. Bun 1.4 emits that star re-export with no binding
 * for the module: the binary throws `ws is not defined` as it loads
 * (`NodeSocketServer`, reached through the `@effect/platform-bun` namespace
 * that extensions import). Named re-exports bind. The names are the ones both
 * the `ws` package and Bun's built-in export; Effect reads `WebSocketServer`.
 */
const namedWsReexports: Bun.BunPlugin = {
  name: "named-ws-reexports",
  setup(builder) {
    builder.onLoad(
      { filter: /[/\\]@effect[/\\]platform-node-shared[/\\]dist[/\\]NodeWS\.js$/ },
      () => ({
        contents: `export { createWebSocketStream, extension, Receiver, Sender, subprotocol, WebSocket, WebSocketServer } from "ws"\n`,
        loader: "js",
      }),
    )
  },
}

/**
 * `__GENT_BUILD__`: an object literal the bundler puts where the source
 * names it. `release` names the release the build compiles
 * (`captureRelease`): its commit, clean flag and checkout. A dev build
 * never links to another process; a build with no git embeds none.
 */
const encodeBuildDefine = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      version: Schema.String,
      release: Schema.optionalKey(GentReleaseFacts),
    }),
  ),
)

/** Whether two reads of the checkout name one release, fact by fact. */
const sameRelease = (one: typeof GentReleaseFacts.Type, other: typeof GentReleaseFacts.Type) =>
  one.commit === other.commit && one.clean === other.clean && one.checkout === other.checkout

/** Capture, report and embed the release in one build step. */
export const buildRelease = Effect.fn("Build.release")(function* (
  directory: string,
  identity: { readonly id: string; readonly version: string },
) {
  const captured = yield* Effect.result(captureRelease(directory))
  yield* Effect.log(
    Result.match(captured, {
      onFailure: ({ reason }) => `Release: none (${reason})`,
      onSuccess: ({ commit, clean }) => {
        if (clean) return `Release: ${commit} clean`
        return `Release: ${commit} dirty`
      },
    }),
  )
  const release = Result.getSuccess(captured)
  const define = encodeBuildDefine({
    ...identity,
    ...Option.match(release, { onNone: () => ({}), onSome: (facts) => ({ release: facts }) }),
  })
  return { release, define }
})

const build = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* SecureRandom.SecureRandom
  const rootDir = path.resolve(yield* path.fromFileUrl(new URL("..", import.meta.url)))
  const binDir = path.join(rootDir, "bin")

  yield* Effect.log("Building gent...")
  yield* fs.makeDirectory(binDir, { recursive: true })

  // Turbo builds the declared extensions dependency before packaging this app;
  // the cell ships as a sibling binary the runtime resolves by name. Run this
  // script through the root build (`bun run build`), or it packages whatever
  // worker the last turbo build left.
  const cellWorker = path.join(rootDir, "../../packages/extensions/dist/gent-cell")
  if (!(yield* fs.exists(cellWorker))) {
    return yield* new BuildError({
      message: `No cell worker at ${cellWorker}. Run \`bun run build\` from the repo root: turbo builds @gent/extensions first.`,
    })
  }
  yield* fs.copyFile(cellWorker, path.join(binDir, "gent-cell"))

  yield* Effect.log("Transforming Solid JSX, bundling, and compiling to binary...")
  const outfile = path.join(binDir, "gent")
  // The build names itself: a fresh id per build and the version this app's
  // package.json ships as. Discovery attaches only to a server of the same
  // build, and the builtin extensions name their artifact by the id.
  const id = yield* crypto.uuidV4()
  const { version } = yield* fs
    .readFileString(path.join(rootDir, "package.json"))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PackageVersion)))
  // The release is read here, from the checkout the build compiles; with no git the build embeds none,
  // and its links match no other machine.
  const main = path.join(rootDir, "src/main.tsx")
  const { release, define } = yield* buildRelease(rootDir, { id, version })
  const target = yield* compileTarget
  yield* Effect.log(`Compile target: ${Option.getOrElse(target, () => "this host")}`)
  const buildResult = yield* Effect.promise(() =>
    // oxlint-disable-next-line effect/noGlobals -- the build script is its own process entry, and Bun.build has no Effect service
    Bun.build({
      entrypoints: [main],
      target: "bun",
      // Bytecode spares every launch the parse of the embedded bundle. It
      // needs ESM output: OpenTUI awaits at module top level.
      format: "esm",
      bytecode: true,
      plugins: [namedWsReexports, solidTransformPlugin],
      minify: false,
      define: {
        __GENT_BUILD__: define,
      },
      compile: {
        ...Option.match(target, { onNone: () => ({}), onSome: (name) => ({ target: name }) }),
        outfile,
        // One shared server serves many projects, so the directory gent starts
        // in sets nothing for it: no `.env`, `bunfig.toml`, `tsconfig.json` or
        // `package.json` is read from it. The cell worker inherits this
        // environment, so its own build turns the same loads off.
        autoloadDotenv: false,
        autoloadBunfig: false,
        autoloadTsconfig: false,
        autoloadPackageJson: false,
        // An extension resolves only the entries the loaders bind. Without this,
        // an unbound package (`@gent/core/host`, a typo) is fetched from the npm
        // registry at import time.
        execArgv: ["--no-install"],
      },
    }),
  )
  if (!buildResult.success) {
    return yield* new BuildError({
      message: ["Build failed:", ...buildResult.logs.map(String)].join("\n"),
    })
  }
  // The checkout changed while the build ran: the binary may hold code its release does not.
  const after = Result.getSuccess(yield* Effect.result(captureRelease(rootDir)))
  const moved = Option.exists(
    release,
    (before) => !Option.exists(after, (now) => sameRelease(now, before)),
  )
  if (moved) {
    return yield* new BuildError({
      message: "The checkout changed while gent built. Build again.",
    })
  }
  yield* Effect.log(`Binary built: ${outfile}`)
})

// The layer runs the build once as it is built; the scope closes after it.
if (import.meta.main) {
  BunRuntime.runMain(
    Effect.scoped(
      Layer.build(
        Layer.effectDiscard(build).pipe(
          Layer.provide(Layer.merge(BunServices.layer, BunCrypto.layerSecureRandom)),
        ),
      ),
    ),
  )
}
