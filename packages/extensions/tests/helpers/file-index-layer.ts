import { Effect, FileSystem, Layer, Path } from "effect"
import { FileIndex } from "@gent/core-internal/domain/file-index"
import {
  ExtensionContext,
  ExtensionServiceError,
} from "@gent/core-internal/domain/extension-services"
import {
  testToolContext,
  type TestToolContext,
} from "@gent/core-internal/test-utils/extension-harness"

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

const wrapError = (operation: string) => (cause: unknown) =>
  new ExtensionServiceError({
    service: "ExtensionFiles",
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  })

export const makeTestCtxWithFileIndex: Effect.Effect<TestToolContext, never, FileIndex> =
  Effect.gen(function* () {
    const fileIndex = yield* FileIndex
    const base = testToolContext()
    return {
      ...base,
      Files: {
        listFiles: (params) =>
          fileIndex.listFiles(params).pipe(Effect.mapError(wrapError("listFiles"))),
        searchFiles: (params) =>
          fileIndex.searchFiles(params).pipe(Effect.mapError(wrapError("searchFiles"))),
        trackSelection: fileIndex.trackSelection,
      },
    }
  })

export const TestExtensionContextWithFileIndex: Layer.Layer<ExtensionContext, never, FileIndex> =
  Layer.effect(ExtensionContext, makeTestCtxWithFileIndex)
