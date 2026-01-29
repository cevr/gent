/**
 * Shell execution utility with truncation and output saving
 */

import { Command, FileSystem } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { Effect, Stream } from "effect"
import { homedir } from "os"
import { join } from "path"

const MAX_LINES = 2000
const MAX_BYTES = 50 * 1024 // 50KB

export interface ShellResult {
  output: string
  truncated: boolean
  savedPath?: string
}

/**
 * Execute shell command with truncation
 * If output exceeds limits, saves full output to ~/tool-output/
 */
export const executeShell = (command: string, cwd: string) =>
  Effect.gen(function* () {
    const { stdout, stderr } = yield* runCommand(command, cwd)
    const fullOutput = stderr.length > 0 ? `${stdout}\n${stderr}` : stdout

    const lines = fullOutput.split("\n")
    const needsTruncation = lines.length > MAX_LINES || fullOutput.length > MAX_BYTES

    if (!needsTruncation) {
      return { output: fullOutput.trim(), truncated: false }
    }

    const savedPath = yield* saveFullOutput(fullOutput, command)

    let truncated = fullOutput
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

const runCommand = (command: string, cwd: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cmd = Command.make("bash", "-c", command).pipe(Command.workingDirectory(cwd))
      const process = yield* Command.start(cmd)
      const [stdout, stderr] = yield* Effect.all(
        [readStream(process.stdout), readStream(process.stderr)],
        { concurrency: "unbounded" },
      )
      yield* process.exitCode
      return { stdout, stderr }
    }),
  )

const readStream = (stream: Stream.Stream<Uint8Array, PlatformError>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold("", (acc, chunk) => acc + chunk),
  )

const saveFullOutput = (output: string, command: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const toolOutputDir = join(homedir(), "tool-output")
    yield* fs.makeDirectory(toolOutputDir, { recursive: true })

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    const filename = `shell_${timestamp}.txt`
    const filepath = join(toolOutputDir, filename)

    const header = `# Command: ${command}\n# Timestamp: ${new Date().toISOString()}\n\n`
    yield* fs.writeFileString(filepath, header + output)

    return filepath
  })
