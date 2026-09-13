/**
 * Shell execution utility with truncation and output saving
 */

import { saveFullOutput } from "@gent/core-internal/domain/output-buffer.js"
import { runProcess } from "@gent/core-internal/utils/run-process"
import { Effect, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"

const MAX_LINES = 2000
const MAX_BYTES = 50 * 1024 // 50KB

export class ShellCommandError extends Schema.TaggedError<ShellCommandError>(
  "@gent/tui/src/utils/shell/ShellCommandError",
)("ShellCommandError", {
  message: Schema.String,
}) {}

/**
 * Execute shell command with truncation
 * If output exceeds limits, saves the full output next to tool output under /tmp/gent/outputs
 */
export const executeShell = (command: string, cwd: string) =>
  Effect.gen(function* () {
    const { stdout, stderr } = yield* runCommand(command, cwd)
    let fullOutput = stdout
    if (stderr.length > 0) fullOutput = `${stdout}\n${stderr}`

    const lines = fullOutput.split("\n")
    const needsTruncation = lines.length > MAX_LINES || fullOutput.length > MAX_BYTES

    if (!needsTruncation) {
      return { output: fullOutput.trim(), truncated: false }
    }

    const savedPath = yield* saveFullOutput(fullOutput, `shell_${command.slice(0, 40)}`)

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
