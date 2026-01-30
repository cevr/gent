import { Effect, Schema } from "effect"
import { FileSystem, Path } from "@effect/platform"
import { defineTool } from "@gent/core"

// Write Tool Error

export class WriteError extends Schema.TaggedError<WriteError>()("WriteError", {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Write Tool Params

export const WriteParams = Schema.Struct({
  path: Schema.String.annotations({
    description: "Absolute path to file to write",
  }),
  content: Schema.String.annotations({
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
  execute: Effect.fn("WriteTool.execute")(function* (params) {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path

    const filePath = pathService.resolve(params.path)
    const dir = pathService.dirname(filePath)

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
})
