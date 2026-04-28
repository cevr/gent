import { Duration, Effect, Exit, Schema, Scope, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import {
  tool,
  ToolNeeds,
  OutputBuffer,
  PermissionRule,
  saveFullOutput,
  type SessionId,
} from "@gent/core/extensions/api"
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
export function injectGitTrailers(cmd: string, sessionId: SessionId): string {
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

const decodeUtf8 = (chunks: Iterable<Uint8Array>): string => {
  const decoder = new TextDecoder()
  let out = ""
  for (const chunk of chunks) out += decoder.decode(chunk)
  return out
}

/**
 * Spawn `bash -c <command>` and collect stdout, stderr, exit code.
 * Scope owns the spawn finalizer — closing the scope kills the process
 * group via SIGTERM with SIGKILL fallback after SIGKILL_DELAY_MS.
 */
const runBashCommand = (command: string, cwd: string | undefined) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make("bash", ["-c", command], {
      ...(cwd !== undefined ? { cwd } : {}),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      forceKillAfter: Duration.millis(SIGKILL_DELAY_MS),
    })
    const [exitCode, stdoutChunks, stderrChunks] = yield* Effect.all(
      [handle.exitCode, Stream.runCollect(handle.stdout), Stream.runCollect(handle.stderr)],
      { concurrency: "unbounded" },
    )
    return {
      stdout: decodeUtf8(stdoutChunks),
      stderr: decodeUtf8(stderrChunks),
      exitCode: Number(exitCode),
    }
  })

// Bash Tool

export const BashTool = tool({
  id: "bash",
  needs: [ToolNeeds.write("process")],
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

    // Background mode — fork a fiber that spawns, collects, and queues
    // a follow-up. The spawn lives in the forked fiber's scope, so the
    // tool can return immediately while the watcher runs to completion.
    // Failures are surfaced through queueFollowUp instead of being
    // silently swallowed.
    if (params.run_in_background === true) {
      const queueBgFailure = (message: string) =>
        ctx.session
          .queueFollowUp({
            content: `Background command failed:\n\`\`\`\n$ ${command}\n${message}\n\`\`\``,
          })
          .pipe(Effect.catchEager(() => Effect.void))

      const bgEffect = Effect.gen(function* () {
        const bgResult = yield* runBashCommand(command, cwd).pipe(
          Effect.scoped,
          Effect.catchTag("PlatformError", (e) =>
            Effect.fail(
              new BashError({ message: `Background command failed: ${e.message}`, command }),
            ),
          ),
        )

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

        yield* ctx.session.queueFollowUp({
          content: `Background command completed (exit code ${bgResult.exitCode}):\n\`\`\`\n$ ${command}\n${outputText}\n\`\`\``,
        })
      }).pipe(
        Effect.catchTag("BashError", (e) => queueBgFailure(e.message)),
        Effect.catchCause((cause) => queueBgFailure(`Internal error: ${cause.toString()}`)),
      )

      yield* bgEffect.pipe(Effect.forkDetach)

      return {
        stdout: `Command started in background: \`${command}\`\nYou will be notified when it completes.`,
        stderr: "",
        exitCode: 0,
      }
    }

    // Sync mode — spawn into an explicit scope so on timeout we can
    // fork-and-forget the scope-close (which fires SIGTERM/SIGKILL via
    // the spawn finalizer) instead of awaiting forceKillAfter on the
    // calling fiber. Matches the prior killGracefully fire-and-forget
    // semantics: tool returns immediately on timeout, kill happens async.
    const spawnScope = yield* Scope.make()
    const closeSpawnScope = Scope.close(spawnScope, Exit.void).pipe(Effect.ignore)
    const result = yield* runBashCommand(command, cwd).pipe(
      Scope.provide(spawnScope),
      Effect.timeoutOrElse({
        duration: Duration.millis(timeout),
        orElse: () =>
          Effect.forkDetach(closeSpawnScope).pipe(
            Effect.andThen(
              Effect.fail(
                new BashError({ message: `Command timed out after ${timeout}ms`, command }),
              ),
            ),
          ),
      }),
      Effect.ensuring(closeSpawnScope),
      Effect.catchTag("PlatformError", (e) =>
        Effect.fail(new BashError({ message: `Failed to execute command: ${e.message}`, command })),
      ),
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
