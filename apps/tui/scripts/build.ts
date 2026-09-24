import { BunRuntime, BunServices } from "@effect/platform-bun"
import solidTransformPlugin from "@opentui/solid/bun-plugin"
import { Crypto, Effect, FileSystem, Layer, Path, Schema } from "effect"

class BuildError extends Schema.TaggedError<BuildError>()("BuildError", {
  message: Schema.String,
}) {}

const build = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const rootDir = path.join(import.meta.dir, "..")
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
  const artifactId = yield* crypto.randomUUIDv4
  const buildResult = yield* Effect.promise(() =>
    Bun.build({
      entrypoints: [path.join(rootDir, "src/main.tsx")],
      target: "bun",
      plugins: [solidTransformPlugin],
      minify: false,
      define: {
        __GENT_COMPILED__: "true",
        __GENT_BUILTIN_ARTIFACT_ID__: `"build:${artifactId}"`,
      },
      compile: {
        target: "bun-darwin-arm64",
        outfile,
        autoloadBunfig: false,
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
