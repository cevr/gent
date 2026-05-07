import { Effect, FileSystem, Layer, Path } from "effect"
import { FileIndex } from "@gent/core/extensions/api"

export const TestFileIndexLive: Layer.Layer<FileIndex, never, FileSystem.FileSystem | Path.Path> =
  Layer.effect(
    FileIndex,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      return {
        listFiles: ({ cwd }) =>
          Effect.gen(function* () {
            const entries = yield* fs.readDirectory(cwd, { recursive: true }).pipe(Effect.orDie)
            const files = []
            for (const relativePath of entries) {
              const absolutePath = path.join(cwd, relativePath)
              const stat = yield* fs.stat(absolutePath).pipe(Effect.orDie)
              if (stat.type !== "File") continue
              files.push({
                path: absolutePath,
                relativePath,
                fileName: path.basename(relativePath),
                size: Number(stat.size),
                modifiedMs: stat.mtime._tag === "Some" ? stat.mtime.value.getTime() : 0,
              })
            }
            return files
          }),
        searchFiles: () => Effect.succeed([]),
        trackSelection: () => Effect.void,
      }
    }),
  )
