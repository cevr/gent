import { Effect, Schema } from "effect"
import { defineTool } from "../../domain/tool.js"
import { OutputBuffer, saveFullOutput } from "../../domain/output-buffer.js"
import { classify } from "./bash-guardrails.js"

// Bash Tool Error

export class BashError extends Schema.TaggedErrorClass<BashError>()("BashError", {
  message: Schema.String,
  command: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  stderr: Schema.optional(Schema.String),
}) {}

// Bash Tool Params

export const BashParams = Schema.Struct({
  command: Schema.String.annotate({
    description: "Shell command to execute",
  }),
  timeout: Schema.optional(
    Schema.Number.annotate({
      description: "Timeout in milliseconds (default: 120000, max: 600000)",
    }),
  ),
  cwd: Schema.optional(
    Schema.String.annotate({
      description: "Working directory for command execution",
    }),
  ),
})

// Bash Tool Result

export const BashResult = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Number,
})

const HEAD_LINES = 50
const TAIL_LINES = 50
const SIGKILL_DELAY_MS = 3000

/**
 * Detect `cd dir && cmd` or `cd dir; cmd` and split into cwd + command.
 * Models often emit this despite instructions to use the cwd param.
 */
export function splitCdCommand(cmd: string): { cwd: string; command: string } | null {
  const match = cmd.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)\s*(.+)$/s)
  if (match === null) return null
  const cwd = match[1] ?? match[2] ?? match[3] ?? ""
  const command = match[4] ?? ""
  return cwd.length > 0 && command.length > 0 ? { cwd, command } : null
}

/**
 * Inject --trailer on git commit commands for session traceability.
 */
export function injectGitTrailers(cmd: string, sessionId: string): string {
  if (!/\bgit\s+commit\b/.test(cmd)) return cmd
  if (/--trailer/.test(cmd)) return cmd
  return cmd.replace(/\bgit\s+commit\b/, `git commit --trailer "Session-Id: ${sessionId}"`)
}

/**
 * Strip trailing & to prevent background jobs escaping tool control.
 */
export function stripBackground(cmd: string): string {
  return cmd.replace(/\s*&\s*$/, "")
}

/**
 * SIGTERM → wait → SIGKILL. Targets process group via negative PID.
 */
function killGracefully(proc: { pid: number; kill: (signal?: number) => void }): void {
  try {
    // SIGTERM to process group
    process.kill(-proc.pid, "SIGTERM")
  } catch {
    // already dead or no access
    return
  }

  setTimeout(() => {
    try {
      process.kill(-proc.pid, 0) // existence check
      process.kill(-proc.pid, "SIGKILL")
    } catch {
      // already dead
    }
  }, SIGKILL_DELAY_MS)
}

// Bash Tool

export const BashTool = defineTool({
  name: "bash",
  action: "exec",
  concurrency: "serial",
  description:
    "Execute shell command. Use for git, npm, system commands. Prefer dedicated tools for file ops.",
  promptSnippet: "Execute shell commands",
  promptGuidelines: [
    "Use for git, npm, and system commands — not file reads or searches",
    "Never use cat/head/tail/grep/find/ls when dedicated tools exist",
  ],
  params: BashParams,
  execute: Effect.fn("BashTool.execute")(function* (params, ctx) {
    const timeout = Math.min(params.timeout ?? 120000, 600000)

    // Strip background operator
    let command = stripBackground(params.command)

    // Inject git commit trailers for session traceability
    command = injectGitTrailers(command, ctx.sessionId)

    // Split cd + command patterns into cwd + command
    let cwd = params.cwd
    const split = splitCdCommand(command)
    if (split !== null) {
      cwd = split.cwd
      command = split.command
    }

    // Guardrail check — ephemeral, not persisted through Permission service
    const risk = classify(command)
    if (risk.level !== "safe") {
      const decision = yield* ctx.approve({
        text: `This command is classified as ${risk.level}: ${risk.reason}\n\n\`${command}\`\n\nAllow execution?`,
        metadata: { type: "bash-guardrail", level: risk.level },
      })
      if (!decision.approved) {
        return {
          stdout: `Command blocked: ${risk.reason}`,
          stderr: "",
          exitCode: 1,
        }
      }
    }

    const result = yield* Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          const spawnOpts: Parameters<typeof Bun.spawn>[1] = {
            stdout: "pipe",
            stderr: "pipe",
          }
          if (cwd !== undefined) spawnOpts.cwd = cwd
          return Bun.spawn(["bash", "-c", command], spawnOpts)
        },
        catch: (e) =>
          new BashError({
            message: `Failed to spawn command: ${e}`,
            command,
          }),
      }),
      (proc) =>
        Effect.tryPromise({
          try: async () => {
            const timeoutId = setTimeout(() => killGracefully(proc), timeout)
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
              command,
            }),
        }),
      (proc) => Effect.sync(() => killGracefully(proc)),
    )

    // Use OutputBuffer for head+tail truncation
    const buf = new OutputBuffer(HEAD_LINES, TAIL_LINES)
    const fullOutput =
      result.stderr.length > 0 ? `${result.stdout}\n${result.stderr}` : result.stdout
    buf.add(fullOutput)
    const formatted = buf.format()

    // Save full output when truncated
    let fullOutputPath: string | undefined
    if (formatted.truncatedLines > 0) {
      fullOutputPath = yield* saveFullOutput(fullOutput, `bash_${command.slice(0, 40)}`).pipe(
        Effect.orElseSucceed(() => undefined),
      )
    }

    let stdout = formatted.text
    if (formatted.truncatedLines > 0 && fullOutputPath !== undefined) {
      stdout = `${formatted.text}\n\nFull output saved to: ${fullOutputPath}`
    }

    return {
      stdout,
      stderr: "",
      exitCode: result.exitCode,
    }
  }),
})
