/**
 * External editor support — Ctrl+G opens $VISUAL / $EDITOR / vi
 * with the current textarea content, returning the edited result.
 */

import { Effect, FileSystem, Option, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { runProcess } from "@gent/core-internal/utils/run-process"

export function resolveEditor(
  visual: Option.Option<string>,
  editor: Option.Option<string>,
): string {
  return visual.pipe(
    Option.filter((value) => value.length > 0),
    Option.orElse(() => editor.pipe(Option.filter((value) => value.length > 0))),
    Option.getOrElse(() => "vi"),
  )
}

/** Split editor string into command + args (handles "code --wait", etc.) */
export function parseEditorCommand(editor: string): [string, ...string[]] {
  const parts = editor.trim().split(/\s+/)
  const cmd = Option.fromNullishOr(parts[0])
  if (Option.isNone(cmd) || cmd.value.length === 0) return ["vi"]
  return [cmd.value, ...parts.slice(1)]
}

const EditorProcessOutcome = Schema.TaggedUnion({
  ExitCode: { value: Schema.Finite },
  SpawnError: { message: Schema.String },
})

export type EditorResult =
  | { _tag: "applied"; content: string }
  | { _tag: "cancelled" }
  | { _tag: "error"; message: string }

export const openExternalEditor = (
  currentContent: string,
  suspend: () => void,
  resume: () => void,
  editor: string,
): Effect.Effect<
  EditorResult,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const [cmd, ...args] = parseEditorCommand(editor)

      const tmpFile = yield* fs
        .makeTempFileScoped({ prefix: "gent-edit-", suffix: ".md" })
        .pipe(Effect.result)
      if (tmpFile._tag === "Failure") {
        return {
          _tag: "error",
          message: `Failed to create tmp file: ${tmpFile.failure.message}`,
        }
      }
      const tmpPath = tmpFile.success

      const writeResult = yield* fs.writeFileString(tmpPath, currentContent).pipe(Effect.result)
      if (writeResult._tag === "Failure") {
        return {
          _tag: "error",
          message: `Failed to write tmp file: ${writeResult.failure.message}`,
        }
      }

      yield* Effect.sync(suspend)

      const editorOutcome = yield* runProcess(cmd, [...args, tmpPath], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }).pipe(
        Effect.map((result) =>
          EditorProcessOutcome.cases.ExitCode.make({ value: result.exitCode }),
        ),
        Effect.catchTag("ProcessError", (e) =>
          Effect.succeed(EditorProcessOutcome.cases.SpawnError.make({ message: e.message })),
        ),
        Effect.ensuring(Effect.sync(resume)),
      )

      if (editorOutcome._tag === "SpawnError") {
        return { _tag: "error", message: `Editor failed: ${editorOutcome.message}` }
      }
      if (editorOutcome.value !== 0) {
        return { _tag: "cancelled" }
      }

      const content = yield* fs.readFileString(tmpPath).pipe(Effect.result)
      if (content._tag === "Failure") {
        return { _tag: "error", message: `Failed to read tmp file: ${content.failure.message}` }
      }
      return { _tag: "applied", content: content.success }
    }),
  )
