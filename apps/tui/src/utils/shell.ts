/**
 * Shell execution utility with an inline output cap and a spill file.
 *
 * The composer's `!cmd` shell puts its output straight into a chat message, so
 * the inline copy has to stay small. A command that overruns the cap writes its
 * whole output under the gent data directory and the notice names that file, so
 * nothing the reader ran is lost to the cap.
 */

import { runProcess } from "@gent/core-internal/runtime/run-process"
import { DateTime, Effect, FileSystem, Option, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { homedir } from "os"
import { joinPath } from "../platform/path-runtime"

const MAX_LINES = 2000
const MAX_BYTES = 50 * 1024 // 50KB

/** Spill files live beside the rest of the gent data, not in a temp directory. */
export const shellOutputDirectory = (home: string = homedir()): string =>
  joinPath(home, ".gent", "shell-output")

export class ShellCommandError extends Schema.TaggedError<ShellCommandError>(
  "@gent/tui/src/utils/shell/ShellCommandError",
)("ShellCommandError", {
  message: Schema.String,
}) {}

/**
 * Execute a shell command, capped at MAX_LINES lines and MAX_BYTES bytes.
 * The caller sees `truncated` when the cap drops output, and `savedPath` names
 * the file holding the whole of it.
 */
export const executeShell = (command: string, cwd: string) =>
  Effect.gen(function* () {
    const { stdout, stderr } = yield* runCommand(command, cwd)
    let fullOutput = stdout
    if (stderr.length > 0) fullOutput = `${stdout}\n${stderr}`

    const lines = fullOutput.split("\n")
    const needsTruncation = lines.length > MAX_LINES || fullOutput.length > MAX_BYTES

    if (!needsTruncation) {
      return { output: fullOutput.trim(), truncated: false, savedPath: Option.none<string>() }
    }

    const savedPath = yield* saveFullOutput(command, fullOutput)

    let truncated: string = fullOutput
    if (lines.length > MAX_LINES) {
      truncated = lines.slice(0, MAX_LINES).join("\n")
    }
    if (truncated.length > MAX_BYTES) {
      truncated = truncated.slice(0, MAX_BYTES)
    }

    return {
      output: truncated.trim(),
      truncated: true,
      savedPath,
    }
  })

/**
 * Writes the whole output beside the rest of the gent data. A write that fails
 * costs the reader the spill file, not the command they just ran, so the
 * failure reports as an absent path rather than a failed shell.
 */
const saveFullOutput = (
  command: string,
  output: string,
): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = shellOutputDirectory()
    yield* fs.makeDirectory(directory, { recursive: true })
    const now = yield* DateTime.nowAsDate
    const stamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-")
    const filePath = joinPath(directory, `shell_${stamp}.txt`)
    const header = `# Command: ${command}\n# Timestamp: ${now.toISOString()}\n\n`
    yield* fs.writeFileString(filePath, header + output)
    return Option.some(filePath)
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("shell.spill-write-failed").pipe(
        Effect.annotateLogs({ cause: String(cause) }),
        Effect.as(Option.none<string>()),
      ),
    ),
  )

const runCommand = (
  command: string,
  cwd: string,
): Effect.Effect<
  { stdout: string; stderr: string },
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  runProcess("bash", ["-c", command], { cwd, stdout: "pipe", stderr: "pipe" }).pipe(
    Effect.map((r) => ({ stdout: r.stdout, stderr: r.stderr })),
    Effect.orDie,
  )
