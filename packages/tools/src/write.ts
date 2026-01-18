import { Effect, Schema } from "effect"
import { defineTool } from "@gent/core"
import * as fs from "node:fs/promises"
import * as path from "node:path"

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
  description: "Write content to file. Creates directories if needed.",
  params: WriteParams,
  execute: Effect.fn("WriteTool.execute")(function* (params) {
    const filePath = path.resolve(params.path)
    const dir = path.dirname(filePath)

    // Ensure directory exists
    yield* Effect.tryPromise({
      try: () => fs.mkdir(dir, { recursive: true }),
      catch: (e) =>
        new WriteError({
          message: `Failed to create directory: ${e}`,
          path: dir,
          cause: e,
        }),
    })

    yield* Effect.tryPromise({
      try: () => fs.writeFile(filePath, params.content, "utf-8"),
      catch: (e) =>
        new WriteError({
          message: `Failed to write file: ${e}`,
          path: filePath,
          cause: e,
        }),
    })

    return {
      path: filePath,
      bytesWritten: Buffer.byteLength(params.content, "utf-8"),
    }
  }),
})
