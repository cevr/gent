import { Crypto, Effect, Encoding, FileSystem, Path, Schema } from "effect"
import { bundledSkillFiles } from "./bundled-sources.js"

/** Materialize bundled documents so the separate cell process can read their paths. */
export const installBundledSkills = Effect.fn("Skills.installBundled")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const manifest = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Array(Schema.Tuple([Schema.String, Schema.String]))),
  )(bundledSkillFiles).pipe(Effect.orDie)
  const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(manifest))
  const parent = path.join(home, ".cache", "gent", "skills")
  const root = path.join(parent, Encoding.encodeHex(digest))
  if (yield* fs.exists(root)) return root
  yield* fs.makeDirectory(parent, { recursive: true })
  yield* Effect.acquireUseRelease(
    fs.makeTempDirectory({ directory: parent, prefix: ".stage-" }),
    (staging) =>
      Effect.gen(function* () {
        for (const [relativePath, content] of bundledSkillFiles) {
          const target = path.join(staging, relativePath)
          yield* fs.makeDirectory(path.dirname(target), { recursive: true })
          yield* fs.writeFileString(target, content)
        }
        yield* fs.rename(staging, root).pipe(
          Effect.catchEager((error) =>
            Effect.gen(function* () {
              // Another profile may have published the same complete bundle.
              if (!(yield* fs.exists(root))) return yield* error
            }),
          ),
        )
      }),
    (staging) => fs.remove(staging, { recursive: true, force: true }).pipe(Effect.orDie),
  )
  return root
})
