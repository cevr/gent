import { Context, Effect, FileSystem, Layer, Path } from "effect"
import {
  ExtensionContext,
  type ExtensionServiceError,
  type ExtensionContextService,
} from "@gent/core/extensions/api"

type ListFilesEffect = ReturnType<ExtensionContextService["Files"]["listFiles"]>

interface FsReadShape {
  readonly resolve: Path.Path["resolve"]
  readonly stat: FileSystem.FileSystem["stat"]
  readonly readFileString: FileSystem.FileSystem["readFileString"]
  readonly listFiles: (params: {
    readonly cwd: string
    readonly waitForScanMs?: number
  }) => Effect.Effect<
    ListFilesEffect extends Effect.Effect<infer A, unknown, unknown> ? A : never,
    ExtensionServiceError,
    ExtensionContext
  >
}

export class FsRead extends Context.Service<FsRead, FsReadShape>()(
  "@gent/extensions/src/fs-tools/read-service/FsRead",
) {
  static Live: Layer.Layer<FsRead, never, FileSystem.FileSystem | Path.Path> = Layer.effect(
    FsRead,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      return {
        resolve: path.resolve,
        stat: fs.stat,
        readFileString: fs.readFileString,
        listFiles: (params) =>
          Effect.gen(function* () {
            const ctx = yield* ExtensionContext
            return yield* ctx.Files.listFiles(params)
          }),
      } satisfies FsReadShape
    }),
  )
}
