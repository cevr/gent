import { BunRuntime, BunServices } from "@effect/platform-bun"
import solidTransformPlugin from "@opentui/solid/bun-plugin"
import { Config, Crypto, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"

class BuildError extends Schema.TaggedError<BuildError>()("BuildError", {
  message: Schema.String,
}) {}

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

/** `__GENT_BUILD__`: an object literal the bundler puts where the source names it. */
const encodeBuildDefine = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, version: Schema.String })),
)

const build = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
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
  const id = yield* crypto.randomUUIDv4
  const { version } = yield* fs
    .readFileString(path.join(rootDir, "package.json"))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PackageVersion)))
  const target = yield* compileTarget
  yield* Effect.log(`Compile target: ${Option.getOrElse(target, () => "this host")}`)
  const buildResult = yield* Effect.promise(() =>
    // oxlint-disable-next-line effect/noGlobals -- the build script is its own process entry, and Bun.build has no Effect service
    Bun.build({
      entrypoints: [path.join(rootDir, "src/main.tsx")],
      target: "bun",
      // Bytecode spares every launch the parse of the embedded bundle. It
      // needs ESM output: OpenTUI awaits at module top level.
      format: "esm",
      bytecode: true,
      plugins: [solidTransformPlugin],
      minify: false,
      define: {
        __GENT_BUILD__: encodeBuildDefine({ id, version }),
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
  yield* Effect.log(`Binary built: ${outfile}`)
})

// The layer runs the build once as it is built; the scope closes after it.
BunRuntime.runMain(
  Effect.scoped(Layer.build(Layer.effectDiscard(build).pipe(Layer.provide(BunServices.layer)))),
)
