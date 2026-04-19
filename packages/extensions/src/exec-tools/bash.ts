import { Effect, Schema } from "effect"
import { tool, OutputBuffer, PermissionRule, saveFullOutput } from "@gent/core/extensions/api"
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
  run_in_background: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Run in background. Returns immediately, notifies when done. Use for long-running commands.",
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

export const BashTool = tool({
  id: "bash",
  resources: ["bash"],
  description:
    "Execute shell command. Use for git, npm, system commands. Prefer dedicated tools for file ops.",
  promptSnippet: "Execute shell commands",
  promptGuidelines: [
    "Use for git, npm, and system commands — not file reads or searches",
    "Never use cat/head/tail/grep/find/ls when dedicated tools exist",
  ],
  permissionRules: [
    new PermissionRule({
      tool: "bash",
      pattern: "git\\s+(add\\s+[-.]|push\\s+--force|reset\\s+--hard|clean\\s+-f)",
      action: "deny",
    }),
    new PermissionRule({ tool: "bash", pattern: "rm\\s+-rf\\s+/", action: "deny" }),
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
      const decision = yield* ctx.interaction.approve({
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

    // Background mode — spawn, fork a watcher, return immediately
    if (params.run_in_background === true) {
      const spawnOpts: Parameters<typeof Bun.spawn>[1] = { stdout: "pipe", stderr: "pipe" }
      if (cwd !== undefined) spawnOpts.cwd = cwd
      const spawnExit = yield* Effect.try({
        try: () => Bun.spawn(["bash", "-c", command], spawnOpts),
        catch: (e) => String(e),
      }).pipe(Effect.exit)
      if (spawnExit._tag === "Failure") {
        return {
          stdout: `Failed to spawn background command: ${spawnExit.cause}`,
          stderr: "",
          exitCode: 1,
        }
      }
      const proc = spawnExit.value

      // Fork a fiber that waits for completion and queues a follow-up
      const bgEffect = Effect.gen(function* () {
        const bgResult = yield* Effect.tryPromise({
          try: async () => {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            const stdoutStream = proc.stdout as ReadableStream<Uint8Array>
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            const stderrStream = proc.stderr as ReadableStream<Uint8Array>
            const [stdout, stderr] = await Promise.all([
              new Response(stdoutStream).text(),
              new Response(stderrStream).text(),
            ])
            const exitCode = await proc.exited
            return { stdout, stderr, exitCode }
          },
          catch: (e) => new BashError({ message: `Background command failed: ${e}`, command }),
        })

        const buf = new OutputBuffer(HEAD_LINES, TAIL_LINES)
        const fullOutput =
          bgResult.stderr.length > 0 ? `${bgResult.stdout}\n${bgResult.stderr}` : bgResult.stdout
        buf.add(fullOutput)
        const formatted = buf.format()

        let outputText = formatted.text
        if (formatted.truncatedLines > 0) {
          const path = yield* saveFullOutput(fullOutput, `bash_bg_${command.slice(0, 40)}`).pipe(
            Effect.orElseSucceed(() => undefined),
          )
          if (path !== undefined) {
            outputText = `${formatted.text}\n\nFull output saved to: ${path}`
          }
        }

        yield* ctx.turn.queueFollowUp({
          content: `Background command completed (exit code ${bgResult.exitCode}):\n\`\`\`\n$ ${command}\n${outputText}\n\`\`\``,
        })
      }).pipe(Effect.catchEager(() => Effect.void))

      yield* bgEffect.pipe(Effect.forkDetach)

      return {
        stdout: `Command started in background: \`${command}\`\nYou will be notified when it completes.`,
        stderr: "",
        exitCode: 0,
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            const stdoutStream = proc.stdout as ReadableStream<Uint8Array>
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            const stderrStream = proc.stderr as ReadableStream<Uint8Array>
            const [stdout, stderr] = await Promise.all([
              new Response(stdoutStream).text(),
              new Response(stderrStream).text(),
            ])
            const exitCode = await proc.exited
            return { stdout, stderr, exitCode }
          },
          catch: (e) =>
            new BashError({
              message: `Failed to execute command: ${e}`,
              command,
            }),
        }).pipe(
          Effect.timeout(timeout),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(
              new BashError({
                message: `Command timed out after ${timeout}ms`,
                command,
              }),
            ),
          ),
        ),
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
