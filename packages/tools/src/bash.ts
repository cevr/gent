import { Effect, Schema } from "effect"
import { defineTool } from "@gent/core"

// Bash Tool Error

export class BashError extends Schema.TaggedError<BashError>()("BashError", {
  message: Schema.String,
  command: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  stderr: Schema.optional(Schema.String),
}) {}

// Bash Tool Params

export const BashParams = Schema.Struct({
  command: Schema.String.annotations({
    description: "Shell command to execute",
  }),
  timeout: Schema.optional(
    Schema.Number.annotations({
      description: "Timeout in milliseconds (default: 120000, max: 600000)",
    })
  ),
  cwd: Schema.optional(
    Schema.String.annotations({
      description: "Working directory for command execution",
    })
  ),
})

// Bash Tool Result

export const BashResult = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Number,
})

// Bash Tool

export const BashTool = defineTool({
  name: "bash",
  description:
    "Execute shell command. Use for git, npm, system commands. Prefer dedicated tools for file ops.",
  params: BashParams,
  execute: Effect.fn("BashTool.execute")(function* (params) {
    const timeout = Math.min(params.timeout ?? 120000, 600000)

    const result = yield* Effect.tryPromise({
      try: async () => {
        const spawnOpts: Parameters<typeof Bun.spawn>[1] = {
          stdout: "pipe",
          stderr: "pipe",
        }
        if (params.cwd) spawnOpts.cwd = params.cwd
        const proc = Bun.spawn(["bash", "-c", params.command], spawnOpts)

        const timeoutId = setTimeout(() => proc.kill(), timeout)

        try {
          const stdoutStream = proc.stdout as ReadableStream<Uint8Array>
          const stderrStream = proc.stderr as ReadableStream<Uint8Array>
          const [stdout, stderr] = await Promise.all([
            new Response(stdoutStream).text(),
            new Response(stderrStream).text(),
          ])
          const exitCode = await proc.exited

          return { stdout, stderr, exitCode }
        } finally {
          clearTimeout(timeoutId)
        }
      },
      catch: (e) =>
        new BashError({
          message: `Failed to execute command: ${e}`,
          command: params.command,
        }),
    })

    // Truncate output if too long
    const maxLen = 30000
    const truncate = (s: string) =>
      s.length > maxLen ? s.slice(0, maxLen) + "\n... (truncated)" : s

    return {
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
      exitCode: result.exitCode,
    }
  }),
})
