import { Effect, FileSystem, Path, Schema } from "effect"
import { UserConfig } from "../config-service.js"

const TrustConfig = Schema.fromJsonString(
  Schema.Struct({ trustedProjects: UserConfig.fields.trustedProjects }),
)

/** Only user configuration can authorize project module execution. */
export const isProjectExtensionDirectoryTrusted = Effect.fn("ExtensionLoader.projectTrust")(
  function* (directories: { readonly userDir: string; readonly projectDir: string }) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return yield* Effect.gen(function* () {
      const configPath = path.resolve(directories.userDir, "../config.json")
      const config = yield* fs
        .readFileString(configPath)
        .pipe(Effect.flatMap(Schema.decodeEffect(TrustConfig)))
      const projectRoot = yield* fs.realPath(path.resolve(directories.projectDir, "../.."))
      return (config.trustedProjects ?? []).includes(projectRoot)
    }).pipe(Effect.orElseSucceed(() => false))
  },
)
