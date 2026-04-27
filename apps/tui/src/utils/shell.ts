/**
 * Shell execution utility with truncation and output saving
 */

import { runProcess } from "@gent/core/utils/run-process"
import { DateTime, FileSystem, Effect, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { homedir } from "os"
import { joinPath } from "../platform/path-runtime"

const MAX_LINES = 2000
const MAX_BYTES = 50 * 1024 // 50KB

export interface ShellResult {
  output: string
  truncated: boolean
  savedPath?: string
}

export class ShellCommandError extends Schema.TaggedErrorClass<ShellCommandError>(
  "ShellCommandError",
)("ShellCommandError", {
  message: Schema.String,
}) {}

/**
 * Execute shell command with truncation
 * If output exceeds limits, saves full output to ~/tool-output/
 */
export const executeShell = (command: string, cwd: string) =>
  Effect.gen(function* () {
    const { stdout, stderr } = yield* runCommand(command, cwd)
    const fullOutput: string = stderr.length > 0 ? `${stdout}\n${stderr}` : stdout

    const lines = fullOutput.split("\n")
    const needsTruncation = lines.length > MAX_LINES || fullOutput.length > MAX_BYTES

    if (!needsTruncation) {
      return { output: fullOutput.trim(), truncated: false }
    }

    const savedPath = yield* saveFullOutput(fullOutput, command)

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

const saveFullOutput = (output: string, command: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const toolOutputDir = joinPath(homedir(), "tool-output")
    yield* fs.makeDirectory(toolOutputDir, { recursive: true })

    const now = yield* DateTime.nowAsDate
    const timestamp = now.toISOString().replace(/[:.]/g, "-")
    const filename = `shell_${timestamp}.txt`
    const filepath = joinPath(toolOutputDir, filename)

    const header = `# Command: ${command}\n# Timestamp: ${now.toISOString()}\n\n`
    yield* fs.writeFileString(filepath, header + output)

    return filepath
  })
