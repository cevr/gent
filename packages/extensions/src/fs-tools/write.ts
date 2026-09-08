import { Effect, Schema } from "effect"
import { ExtensionContext, tool } from "@gent/core/extensions/api"

// Write Tool Error

export class WriteError extends Schema.TaggedError<WriteError>()("WriteError", {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Write Tool Params

export const WriteParams = Schema.Struct({
  atomic: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Write a sibling temporary file, then rename it over the path. Use for saved results. Replaces a symlink itself; does not change the symlink target. Creates a new file inode with temporary-file permissions. Default false keeps normal write behavior.",
    }),
  ),
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
  bytesWritten: Schema.Finite,
})

// Write Tool

export const WriteTool = tool({
  id: "write",
  destructive: true,
  description: "Write content to file. Creates directories if needed.",
  promptSnippet: "Create or overwrite files",
  promptGuidelines: ["Read before writing", "Prefer edit for partial changes"],
  params: WriteParams,
  output: WriteResult,
  execute: Effect.fn("WriteTool.execute")(function* (params) {
    const ctx = yield* ExtensionContext

    const filePath = ctx.Files.resolve(params.path)

    return yield* ctx.FileLock.withLock(
      filePath,
      Effect.gen(function* () {
        const dir = ctx.Files.dirname(filePath)

        // Ensure directory exists
        yield* ctx.Files.makeDirectory(dir, { recursive: true }).pipe(
          Effect.mapError(
            (e) =>
              new WriteError({
                message: `Failed to create directory: ${e.message}`,
                path: dir,
                cause: e,
              }),
          ),
        )

        yield* ctx.Files.write(filePath, params.content, { atomic: params.atomic }).pipe(
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
