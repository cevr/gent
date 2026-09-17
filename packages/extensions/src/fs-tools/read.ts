import { Effect, Schema } from "effect"
import { ExtensionContext, tool } from "@gent/core/extensions/api"

// Read Tool Error

export class ReadError extends Schema.TaggedError<ReadError>()("ReadError", {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Read Tool Params

export const ReadParams = Schema.Struct({
  path: Schema.String.annotate({
    description: "Absolute path to file to read",
  }),
  offset: Schema.optionalKey(
    Schema.Finite.annotate({
      description: "Line number to start reading from (1-indexed)",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Finite.annotate({
      description: "Maximum number of lines to read",
    }),
  ),
})

// Read Tool Result

export const ReadResult = Schema.Struct({
  content: Schema.String,
  path: Schema.String,
  lineCount: Schema.Finite,
  truncated: Schema.Boolean,
  /** The 1-indexed line to pass as `offset` to continue. Absent when the read reached the end. */
  nextOffset: Schema.optional(Schema.Finite),
})

// Read Tool — authored through the typed `tool(...)` factory, which lowers
// directly to a Capability.

export const ReadTool = tool({
  id: "read",
  readonly: true,
  description:
    "Read file contents. Returns numbered lines. Use offset/limit for large files. A truncated result carries nextOffset — pass it back as offset to continue from the next unread line.",
  promptSnippet: "Read file contents with line numbers",
  params: ReadParams,
  output: ReadResult,
  execute: Effect.fn("ReadTool.execute")(function* (params) {
    const ctx = yield* ExtensionContext

    const filePath = ctx.Files.resolve(params.path)

    // Check if path is a directory
    const stat = yield* ctx.Files.stat(filePath).pipe(
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
        message: `Cannot read directory. Use bash ls to list directory contents.`,
        path: filePath,
      })
    }

    const content = yield* ctx.Files.read(filePath).pipe(
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

    const truncated = endIndex < lines.length

    return {
      content: numberedContent,
      path: filePath,
      lineCount: totalLines,
      truncated,
      // A truncated read names the next unread line so the caller continues
      // without a gap; a complete read leaves the key out entirely.
      ...(truncated && { nextOffset: endIndex + 1 }),
    }
  }),
})
