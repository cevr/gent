import { Effect, Schema, FileSystem, Path } from "effect"
import { defineTool } from "@gent/core/domain/tool.js"
import { FileLockService } from "@gent/core/domain/file-lock.js"
import { FileTracker } from "@gent/runtime"

// Write Tool Error

export class WriteError extends Schema.TaggedErrorClass<WriteError>()("WriteError", {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Write Tool Params

export const WriteParams = Schema.Struct({
  path: Schema.String.annotate({
    description: "Absolute path to file to write",
  }),
  content: Schema.String.annotate({
    description: "Content to write to file",
  }),
})

// Write Tool Result

export const WriteResult = Schema.Struct({
  path: Schema.String,
  bytesWritten: Schema.Number,
})

// Write Tool

export const WriteTool = defineTool({
  name: "write",
  concurrency: "serial",
  description: "Write content to file. Creates directories if needed.",
  params: WriteParams,
  execute: Effect.fn("WriteTool.execute")(function* (params, ctx) {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const tracker = yield* FileTracker
    const fileLock = yield* FileLockService

    const filePath = pathService.resolve(params.path)

    return yield* fileLock.withLock(
      filePath,
      Effect.gen(function* () {
        const dir = pathService.dirname(filePath)

        // Read existing content for undo tracking (empty string if new file)
        const existingContent = yield* fs
          .readFileString(filePath)
          .pipe(Effect.catch(() => Effect.succeed("")))

        // Ensure directory exists
        yield* fs.makeDirectory(dir, { recursive: true }).pipe(
          Effect.mapError(
            (e) =>
              new WriteError({
                message: `Failed to create directory: ${e.message}`,
                path: dir,
                cause: e,
              }),
          ),
        )

        // Snapshot for undo support
        yield* tracker.snapshot(filePath, existingContent, params.content, ctx.toolCallId)

        yield* fs.writeFileString(filePath, params.content).pipe(
          Effect.mapError(
            (e) =>
              new WriteError({
                message: `Failed to write file: ${e.message}`,
                path: filePath,
                cause: e,
              }),
          ),
        )

        return {
          path: filePath,
          bytesWritten: Buffer.byteLength(params.content, "utf-8"),
        }
      }),
    )
  }),
})
