import { Effect, Schema } from "effect"
import { FileSystem, Path } from "@effect/platform"
import { defineTool } from "@gent/core"

// Edit Tool Error

export class EditError extends Schema.TaggedError<EditError>()("EditError", {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Edit Tool Params

export const EditParams = Schema.Struct({
  path: Schema.String.annotations({
    description: "Absolute path to file to edit",
  }),
  oldString: Schema.String.annotations({
    description: "Exact string to replace",
  }),
  newString: Schema.String.annotations({
    description: "Replacement string",
  }),
  replaceAll: Schema.optional(
    Schema.Boolean.annotations({
      description: "Replace all occurrences (default: false)",
    }),
  ),
})

// Edit Tool Result

export const EditResult = Schema.Struct({
  path: Schema.String,
  replacements: Schema.Number,
})

// Edit Tool

export const EditTool = defineTool({
  name: "edit",
  description:
    "Edit file by replacing exact string matches. Fails if oldString not found or not unique (unless replaceAll).",
  params: EditParams,
  execute: Effect.fn("EditTool.execute")(function* (params) {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path

    const filePath = pathService.resolve(params.path)

    const content = yield* fs.readFileString(filePath).pipe(
      Effect.mapError(
        (e) =>
          new EditError({
            message: `Failed to read file: ${e.message}`,
            path: filePath,
            cause: e,
          }),
      ),
    )

    // Count occurrences
    const occurrences = content.split(params.oldString).length - 1

    if (occurrences === 0) {
      return yield* new EditError({
        message: "oldString not found in file",
        path: filePath,
      })
    }

    if (occurrences > 1 && !params.replaceAll) {
      return yield* new EditError({
        message: `oldString found ${occurrences} times. Use replaceAll to replace all, or provide more context for unique match.`,
        path: filePath,
      })
    }

    const newContent = params.replaceAll
      ? content.split(params.oldString).join(params.newString)
      : content.replace(params.oldString, params.newString)

    yield* fs.writeFileString(filePath, newContent).pipe(
      Effect.mapError(
        (e) =>
          new EditError({
            message: `Failed to write file: ${e.message}`,
            path: filePath,
            cause: e,
          }),
      ),
    )

    return {
      path: filePath,
      replacements: params.replaceAll ? occurrences : 1,
    }
  }),
})
