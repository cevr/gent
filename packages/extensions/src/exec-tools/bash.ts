import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
  type Fiber,
  type FileSystem,
  type Path,
} from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process"
import {
  tool,
  ToolNeeds,
  OutputBuffer,
  PermissionRule,
  saveFullOutput,
  type SessionId,
  type ToolCapabilityContext,
} from "@gent/core/extensions/api"
import { classify } from "./bash-guardrails.js"
import {
  BackgroundBashStorage,
  type BackgroundBashTerminalState,
  type BackgroundBashJobKeyFields,
  type BackgroundBashStorageError,
} from "./bash-storage.js"

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
  timeout: Schema.optionalKey(
    Schema.Number.annotate({
      description: "Timeout in milliseconds (default: 120000, max: 600000)",
    }),
  ),
  cwd: Schema.optionalKey(
    Schema.String.annotate({
      description: "Working directory for command execution",
    }),
  ),
  run_in_background: Schema.optionalKey(
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

type BackgroundBashJobKey = string

interface BackgroundBashState {
  readonly active: ReadonlyMap<BackgroundBashJobKey, Fiber.Fiber<void>>
  readonly completed: ReadonlySet<BackgroundBashJobKey>
}

interface BackgroundBashJob {
  readonly command: string
  readonly cwd: string | undefined
  readonly ctx: ToolCapabilityContext
}

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

const backgroundJobKey = (ctx: ToolCapabilityContext): BackgroundBashJobKey =>
  `${ctx.sessionId}:${ctx.branchId}:${ctx.toolCallId}`

const backgroundJobKeyFields = (ctx: ToolCapabilityContext): BackgroundBashJobKeyFields => ({
  sessionId: ctx.sessionId,
  branchId: ctx.branchId,
  toolCallId: ctx.toolCallId,
})

const markJobCompleted = (state: BackgroundBashState, key: BackgroundBashJobKey) => {
  const active = new Map(state.active)
  active.delete(key)
  const completed = new Set(state.completed)
  completed.add(key)
  return { active, completed } satisfies BackgroundBashState
}

const targetStillExists = (ctx: ToolCapabilityContext) =>
  Effect.gen(function* () {
    const session = yield* ctx.session.getSession().pipe(Effect.orElseSucceed(() => undefined))
    if (session === undefined) return false
    const branches = yield* ctx.session.listBranches().pipe(Effect.orElseSucceed(() => []))
    return branches.some((branch) => branch.id === ctx.branchId)
  })

const queueBackgroundFollowUp = (params: {
  readonly ctx: ToolCapabilityContext
  readonly sourceId: string
  readonly content: string
}) =>
  Effect.gen(function* () {
    if (!(yield* targetStillExists(params.ctx))) return
    yield* params.ctx.session
      .queueFollowUp({
        sourceId: params.sourceId,
        content: params.content,
      })
      .pipe(Effect.catchEager(() => Effect.void))
  })

const queueTerminalFollowUp = (ctx: ToolCapabilityContext, state: BackgroundBashTerminalState) => {
  const command = state.command
  const message = state.message ?? ""
  if (state.status === "completed") {
    const exitCode = state.exitCode ?? 0
    return queueBackgroundFollowUp({
      ctx,
      sourceId: `bash:${ctx.toolCallId}:complete`,
      content: `Background command completed (exit code ${exitCode}):\n\`\`\`\n$ ${command}\n${message}\n\`\`\``,
    })
  }
  return queueBackgroundFollowUp({
    ctx,
    sourceId: `bash:${ctx.toolCallId}:failure`,
    content: `Background command failed:\n\`\`\`\n$ ${command}\n${message}\n\`\`\``,
  })
}

export interface BackgroundBashSupervisorService {
  readonly start: (
    job: BackgroundBashJob,
  ) => Effect.Effect<
    void,
    BackgroundBashStorageError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  >
}

export class BackgroundBashSupervisor extends Context.Service<
  BackgroundBashSupervisor,
  BackgroundBashSupervisorService
>()("@gent/extensions/src/exec-tools/bash/BackgroundBashSupervisor") {}

export const BackgroundBashSupervisorLive: Layer.Layer<
  BackgroundBashSupervisor,
  never,
  BackgroundBashStorage
> = Layer.effect(
  BackgroundBashSupervisor,
  Effect.gen(function* () {
    const storage = yield* BackgroundBashStorage
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void).pipe(Effect.asVoid))
    const gate = yield* Semaphore.make(1)
    const state = yield* Ref.make<BackgroundBashState>({
      active: new Map(),
      completed: new Set(),
    })

    const runBackgroundJob = Effect.fn("BackgroundBashSupervisor.runBackgroundJob")(function* (
      job: BackgroundBashJob,
    ) {
      const bgResult = yield* runBashCommand(job.command, job.cwd).pipe(
        Effect.scoped,
        Effect.catchTag("PlatformError", (e) =>
          Effect.fail(
            new BashError({
              message: `Background command failed: ${e.message}`,
              command: job.command,
            }),
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
        const path = yield* saveFullOutput(fullOutput, `bash_bg_${job.command.slice(0, 40)}`).pipe(
          Effect.orElseSucceed(() => undefined),
        )
        if (path !== undefined) {
          outputText = `${formatted.text}\n\nFull output saved to: ${path}`
        }
      }

      yield* storage.markCompleted(backgroundJobKeyFields(job.ctx), {
        exitCode: bgResult.exitCode,
        message: outputText,
      })
      yield* queueTerminalFollowUp(job.ctx, {
        status: "completed",
        command: job.command,
        exitCode: bgResult.exitCode,
        message: outputText,
      })
    })

    const queueFailure = (job: BackgroundBashJob, message: string) =>
      storage.markFailed(backgroundJobKeyFields(job.ctx), message).pipe(
        Effect.catchEager(() => Effect.void),
        Effect.andThen(
          queueTerminalFollowUp(job.ctx, { status: "failed", command: job.command, message }),
        ),
      )

    const start = (job: BackgroundBashJob) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const key = backgroundJobKey(job.ctx)
          const current = yield* Ref.get(state)
          if (current.completed.has(key) || current.active.has(key)) return
          const claim = yield* storage.claimStart({
            ...backgroundJobKeyFields(job.ctx),
            command: job.command,
            cwd: job.cwd,
          })
          if (claim._tag === "AlreadyRunning") return
          if (claim._tag === "Terminal") {
            yield* queueTerminalFollowUp(job.ctx, claim.state)
            yield* Ref.update(state, (s) => markJobCompleted(s, key))
            return
          }

          const started = yield* Deferred.make<void>()
          const jobContext = yield* Effect.context<
            ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
          >()
          const fiber = yield* Deferred.await(started).pipe(
            Effect.andThen(runBackgroundJob(job)),
            Effect.catchTag("BashError", (e) => queueFailure(job, e.message)),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : queueFailure(job, `Internal error: ${Cause.pretty(cause)}`),
            ),
            Effect.ensuring(Ref.update(state, (s) => markJobCompleted(s, key))),
            Effect.provideContext(jobContext),
            Effect.forkIn(scope),
          )

          yield* Ref.update(state, (s) => {
            const active = new Map(s.active)
            active.set(key, fiber)
            return { ...s, active }
          })
          yield* Deferred.succeed(started, undefined)
        }),
      )

    return { start }
  }),
)

// Bash Tool

export const BashTool = tool({
  id: "bash",
  needs: [ToolNeeds.write("process"), ToolNeeds.write("interaction"), ToolNeeds.write("session")],
  destructive: true,
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
  output: BashResult,
  execute: Effect.fn("BashTool.execute")(function* (
    params: typeof BashParams.Type,
    ctx: ToolCapabilityContext,
  ) {
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

    // Background mode — hand the process to the process-scoped supervisor.
    // The tool returns immediately; the resource owns process lifetime and
    // completion follow-up.
    if (params.run_in_background === true) {
      const supervisor = yield* BackgroundBashSupervisor
      yield* supervisor.start({ command, cwd, ctx })

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
