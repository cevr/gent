import { Context, Effect, FileSystem, Layer, Path } from "effect"
import {
  FileIndex,
  FileIndexError,
  ReadOnlyBrand,
  type FileIndexService,
  type ReadOnly,
  withReadOnly,
} from "@gent/core/extensions/api"

interface FsReadShape {
  readonly resolve: Path.Path["resolve"]
  readonly stat: FileSystem.FileSystem["stat"]
  readonly readFileString: FileSystem.FileSystem["readFileString"]
  readonly listFiles: FileIndexService["listFiles"]
}

export class FsRead extends Context.Service<FsRead, ReadOnly<FsReadShape>>()(
  "@gent/extensions/src/fs-tools/read-service/FsRead",
) {
  declare readonly [ReadOnlyBrand]: true

  static Live: Layer.Layer<FsRead, never, FileSystem.FileSystem | Path.Path> = Layer.effect(
    FsRead,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const fileIndex = yield* Effect.serviceOption(FileIndex)
      return withReadOnly({
        resolve: path.resolve,
        stat: fs.stat,
        readFileString: fs.readFileString,
        listFiles: (params) =>
          fileIndex._tag === "Some"
            ? fileIndex.value.listFiles(params)
            : Effect.fail(
                new FileIndexError({
                  message: "File index service unavailable",
                  cwd: params.cwd,
                }),
              ),
      } satisfies FsReadShape)
    }),
  )
}
