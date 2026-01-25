import { Effect, Schema } from "effect"
import { FileSystem, Path } from "@effect/platform"
import { defineTool } from "@gent/core"

// Read Tool Error

export class ReadError extends Schema.TaggedError<ReadError>()("ReadError", {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Read Tool Params

export const ReadParams = Schema.Struct({
  path: Schema.String.annotations({
    description: "Absolute path to file to read",
  }),
  offset: Schema.optional(
    Schema.Number.annotations({
      description: "Line number to start reading from (1-indexed)",
    }),
  ),
  limit: Schema.optional(
    Schema.Number.annotations({
      description: "Maximum number of lines to read",
    }),
  ),
})

// Read Tool Result

export const ReadResult = Schema.Struct({
  content: Schema.String,
  path: Schema.String,
  lineCount: Schema.Number,
  truncated: Schema.Boolean,
})

// Read Tool

export const ReadTool = defineTool({
  name: "read",
  description: "Read file contents. Returns numbered lines. Use offset/limit for large files.",
  params: ReadParams,
  execute: Effect.fn("ReadTool.execute")(function* (params) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const filePath = path.resolve(params.path)

    // Check if path is a directory
    const stat = yield* fs.stat(filePath).pipe(
      Effect.mapError(
        (e) =>
          new ReadError({
            message: `Path does not exist: ${filePath}`,
            path: filePath,
            cause: e,
          }),
      ),
    )

    if (stat.type === "Directory") {
      return yield* new ReadError({
        message: `Cannot read directory. Use glob or bash ls to list directory contents.`,
        path: filePath,
      })
    }

    const content = yield* fs.readFileString(filePath).pipe(
      Effect.mapError(
        (e) =>
          new ReadError({
            message: `Failed to read file: ${e.message}`,
            path: filePath,
            cause: e,
          }),
      ),
    )

    const lines = content.split("\n")
    const totalLines = lines.length
    const offset = params.offset ?? 1
    const limit = params.limit ?? 2000

    const startIndex = Math.max(0, offset - 1)
    const endIndex = Math.min(lines.length, startIndex + limit)
    const selectedLines = lines.slice(startIndex, endIndex)

    // Format with line numbers
    const maxLineNumWidth = String(endIndex).length
    const numberedContent = selectedLines
      .map((line, i) => {
        const lineNum = String(startIndex + i + 1).padStart(maxLineNumWidth)
        return `${lineNum}\t${line}`
      })
      .join("\n")

    return {
      content: numberedContent,
      path: filePath,
      lineCount: totalLines,
      truncated: endIndex < lines.length,
    }
  }),
})
