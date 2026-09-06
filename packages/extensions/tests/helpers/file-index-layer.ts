import { Effect, FileSystem, Layer, Option, Path } from "effect"
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

      return FileIndex.of({
        listFiles: ({ cwd }) =>
          Effect.gen(function* () {
            const entries = yield* fs.readDirectory(cwd, { recursive: true })
            const files = []
            for (const relativePath of entries) {
              const absolutePath = path.join(cwd, relativePath)
              const stat = yield* fs.stat(absolutePath)
              if (stat.type !== "File") continue
              files.push({
                path: absolutePath,
                relativePath,
                fileName: path.basename(relativePath),
                size: Number(stat.size),
                modifiedMs: Option.match(stat.mtime, {
                  onNone: () => 0,
                  onSome: (mtime) => mtime.getTime(),
                }),
              })
            }
            return files
          }).pipe(Effect.orDie),
      })
    }),
  )

const wrapError = (operation: string) => (cause: unknown) => {
  if (cause instanceof Error) {
    return new ExtensionServiceError({
      service: "ExtensionFiles",
      operation,
      message: cause.message,
      cause,
    })
  }
  return new ExtensionServiceError({
    service: "ExtensionFiles",
    operation,
    message: String(cause),
    cause,
  })
}

export const makeTestCtxWithFileIndex: Effect.Effect<TestToolContext, never, FileIndex> =
  Effect.gen(function* () {
    const fileIndex = yield* FileIndex
    const base = testToolContext()
    return {
      ...base,
      Files: {
        ...base.Files,
        listFiles: (params) =>
          fileIndex.listFiles(params).pipe(Effect.mapError(wrapError("listFiles"))),
      },
    }
  })

export const TestExtensionContextWithFileIndex: Layer.Layer<ExtensionContext, never, FileIndex> =
  Layer.effect(ExtensionContext, makeTestCtxWithFileIndex)
