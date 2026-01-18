import { Effect, Schema } from "effect"
import { defineTool } from "@gent/core"
import * as fs from "node:fs/promises"
import * as path from "node:path"

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
    })
  ),
  limit: Schema.optional(
    Schema.Number.annotations({
      description: "Maximum number of lines to read",
    })
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
  description:
    "Read file contents. Returns numbered lines. Use offset/limit for large files.",
  params: ReadParams,
  execute: Effect.fn("ReadTool.execute")(function* (params) {
    const filePath = path.resolve(params.path)

    const content = yield* Effect.tryPromise({
      try: () => fs.readFile(filePath, "utf-8"),
      catch: (e) =>
        new ReadError({
          message: `Failed to read file: ${e}`,
          path: filePath,
          cause: e,
        }),
    })

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
