import { Effect, Schema, FileSystem, Path } from "effect"
import { defineTool } from "@gent/core/domain/tool.js"
import { FileLockService } from "@gent/core/domain/file-lock.js"
import { FileTracker } from "@gent/core/runtime/file-tracker.js"

// Undo Edit Tool Error

export class UndoEditError extends Schema.TaggedErrorClass<UndoEditError>()("UndoEditError", {
  message: Schema.String,
  path: Schema.String,
}) {}

// Undo Edit Tool Params

export const UndoEditParams = Schema.Struct({
  path: Schema.String.annotate({
    description: "Absolute path to file to undo the most recent edit for",
  }),
})

// Undo Edit Tool

export const UndoEditTool = defineTool({
  name: "undo_edit",
  concurrency: "serial",
  description:
    "Undo the most recent edit or write to a file. Only works for changes made in the current session.",
  params: UndoEditParams,
  execute: Effect.fn("UndoEditTool.execute")(function* (params) {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const tracker = yield* FileTracker
    const fileLock = yield* FileLockService

    const filePath = pathService.resolve(params.path)

    return yield* fileLock.withLock(
      filePath,
      Effect.gen(function* () {
        const change = yield* tracker.restore(filePath)

        if (change === undefined) {
          return yield* new UndoEditError({
            message: "No recorded changes to undo for this file",
            path: filePath,
          })
        }

        // Verify current file content matches what we expect (the "after" state)
        const currentContent = yield* fs.readFileString(filePath).pipe(
          Effect.mapError(
            () =>
              new UndoEditError({
                message: "Failed to read file",
                path: filePath,
              }),
          ),
        )

        if (currentContent !== change.after) {
          // File was modified since tracked change — restore anyway but warn
          yield* fs.writeFileString(filePath, change.before).pipe(
            Effect.mapError(
              () =>
                new UndoEditError({
                  message: "Failed to restore file",
                  path: filePath,
                }),
            ),
          )
          return {
            path: filePath,
            restored: true,
            warning: "File was modified since tracked change. Restored to pre-edit state anyway.",
          }
        }

        yield* fs.writeFileString(filePath, change.before).pipe(
          Effect.mapError(
            () =>
              new UndoEditError({
                message: "Failed to restore file",
                path: filePath,
              }),
          ),
        )

        return {
          path: filePath,
          restored: true,
        }
      }),
    )
  }),
})
