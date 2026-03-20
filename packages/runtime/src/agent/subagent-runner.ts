import { Cause, ServiceMap, Duration, Effect, Layer, Schedule } from "effect"
import {
  AgentSwitched,
  Branch,
  EventStore,
  Session,
  SubagentSucceeded,
  SubagentFailed,
  SubagentError,
  SubagentRunnerService,
  SubagentSpawned,
  type SessionId,
  type BranchId,
} from "@gent/core"
import { Storage, type StorageService } from "@gent/storage"
import { AgentActor } from "./agent-loop"

const collectUsage = (storage: StorageService, sessionId: SessionId) =>
  storage.listEvents({ sessionId }).pipe(
    Effect.map((envelopes) => {
      let input = 0
      let output = 0
      for (const env of envelopes) {
        if (env.event._tag === "StreamEnded" && env.event.usage !== undefined) {
          input += env.event.usage.inputTokens
          output += env.event.usage.outputTokens
        }
      }
      return input > 0 || output > 0 ? { input, output, cost: 0 } : undefined
    }),
    Effect.catchEager(() => Effect.succeed(undefined)),
  )

export class SubagentRunnerConfig extends ServiceMap.Service<
  SubagentRunnerConfig,
  {
    readonly subprocessBinaryPath?: string
    readonly dbPath?: string
    readonly systemPrompt: string
    readonly maxAttempts: number
    readonly retryInitialDelayMs: number
    readonly retryMaxDelayMs: number
    readonly timeoutMs?: number
  }
>()("@gent/runtime/src/agent/subagent-runner/SubagentRunnerConfig") {
  static Live = (config: {
    subprocessBinaryPath?: string
    dbPath?: string
    systemPrompt: string
    maxAttempts?: number
    retryInitialDelayMs?: number
    retryMaxDelayMs?: number
    timeoutMs?: number
  }) =>
    Layer.succeed(SubagentRunnerConfig, {
      subprocessBinaryPath: config.subprocessBinaryPath,
      dbPath: config.dbPath,
      systemPrompt: config.systemPrompt,
      maxAttempts: Math.max(1, config.maxAttempts ?? 1),
      retryInitialDelayMs: Math.max(0, config.retryInitialDelayMs ?? 250),
      retryMaxDelayMs: Math.max(0, config.retryMaxDelayMs ?? 5_000),
      timeoutMs: config.timeoutMs,
    })
}

const createSubagentSession = (
  storage: StorageService,
  params: {
    agent: { name: string }
    prompt: string
    parentSessionId: SessionId
    parentBranchId: BranchId
    cwd: string
  },
) =>
  Effect.gen(function* () {
    const sessionId = Bun.randomUUIDv7() as SessionId
    const branchId = Bun.randomUUIDv7() as BranchId
    const now = new Date()
    const parentSession = yield* storage.getSession(params.parentSessionId)
    const bypass = parentSession?.bypass ?? true

    const session = new Session({
      id: sessionId,
      name: `${params.agent.name}: ${params.prompt.slice(0, 60)}`,
      cwd: params.cwd,
      bypass,
      parentSessionId: params.parentSessionId,
      parentBranchId: params.parentBranchId,
      createdAt: now,
      updatedAt: now,
    })

    const branch = new Branch({
      id: branchId,
      sessionId,
      createdAt: now,
    })

    yield* storage.createSession(session)
    yield* storage.createBranch(branch)

    return { sessionId, branchId, bypass }
  })

export const InProcessRunner: Layer.Layer<
  SubagentRunnerService,
  never,
  Storage | EventStore | AgentActor | SubagentRunnerConfig
> = Layer.effect(
  SubagentRunnerService,
  Effect.gen(function* () {
    const storage = yield* Storage
    const eventStore = yield* EventStore
    const actor = yield* AgentActor
    const runnerConfig = yield* SubagentRunnerConfig

    return {
      run: (params) =>
        createSubagentSession(storage, params).pipe(
          Effect.flatMap(({ sessionId, branchId, bypass }) => {
            const run = Effect.gen(function* () {
              yield* eventStore.publish(
                new SubagentSpawned({
                  parentSessionId: params.parentSessionId,
                  childSessionId: sessionId,
                  agentName: params.agent.name,
                  prompt: params.prompt,
                }),
              )
              yield* eventStore.publish(
                new AgentSwitched({
                  sessionId,
                  branchId,
                  fromAgent: "cowork",
                  toAgent: params.agent.name,
                }),
              )

              const runSubagent = actor.run({
                sessionId,
                branchId,
                agentName: params.agent.name,
                prompt: params.prompt,
                systemPrompt: runnerConfig.systemPrompt,
                bypass,
              })

              const retrySchedule =
                runnerConfig.maxAttempts > 1
                  ? Schedule.modifyDelay(
                      Schedule.both(
                        Schedule.recurs(runnerConfig.maxAttempts - 1),
                        Schedule.exponential(Duration.millis(runnerConfig.retryInitialDelayMs)),
                      ),
                      (_out, duration) =>
                        Effect.succeed(
                          Duration.millis(
                            Math.min(
                              Duration.toMillis(duration as Duration.Duration),
                              runnerConfig.retryMaxDelayMs,
                            ),
                          ),
                        ),
                    )
                  : null

              const runWithRetry =
                retrySchedule === null ? runSubagent : runSubagent.pipe(Effect.retry(retrySchedule))

              const runWithTimeout =
                runnerConfig.timeoutMs === undefined
                  ? runWithRetry
                  : runWithRetry.pipe(
                      Effect.timeoutOrElse({
                        duration: Duration.millis(runnerConfig.timeoutMs),
                        onTimeout: () =>
                          Effect.fail(
                            new SubagentError({
                              message: `Subagent timed out after ${runnerConfig.timeoutMs}ms`,
                            }),
                          ),
                      }),
                    )

              yield* runWithTimeout

              const messages = yield* storage.listMessages(branchId)
              let text = ""
              for (let i = messages.length - 1; i >= 0; i--) {
                const msg = messages[i]
                if (msg === undefined || msg.role !== "assistant") continue
                const part = msg.parts.find((p) => p.type === "text")
                text = part?.text ?? ""
                break
              }

              const usage = yield* collectUsage(storage, sessionId)

              yield* eventStore.publish(
                new SubagentSucceeded({
                  parentSessionId: params.parentSessionId,
                  childSessionId: sessionId,
                  agentName: params.agent.name,
                }),
              )

              return {
                _tag: "success" as const,
                text,
                sessionId,
                agentName: params.agent.name,
                usage,
              }
            })

            return run.pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
                return Effect.gen(function* () {
                  const error = Cause.pretty(cause)
                  yield* eventStore
                    .publish(
                      new SubagentFailed({
                        parentSessionId: params.parentSessionId,
                        childSessionId: sessionId,
                        agentName: params.agent.name,
                      }),
                    )
                    .pipe(
                      Effect.catchEager((e) =>
                        Effect.logWarning("failed to publish subagent event", e),
                      ),
                    )

                  return {
                    _tag: "error" as const,
                    error,
                    sessionId,
                    agentName: params.agent.name,
                  }
                })
              }),
            )
          }),
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
            return Effect.succeed({
              _tag: "error" as const,
              error: Cause.pretty(cause),
              agentName: params.agent.name,
            })
          }),
        ),
    }
  }),
)

export const SubprocessRunner: Layer.Layer<
  SubagentRunnerService,
  never,
  Storage | EventStore | SubagentRunnerConfig
> = Layer.effect(
  SubagentRunnerService,
  Effect.gen(function* () {
    const storage = yield* Storage
    const eventStore = yield* EventStore
    const config = yield* SubagentRunnerConfig

    return {
      run: (params) =>
        createSubagentSession(storage, params).pipe(
          Effect.flatMap(({ sessionId, branchId, bypass }) => {
            const run = Effect.gen(function* () {
              yield* eventStore.publish(
                new SubagentSpawned({
                  parentSessionId: params.parentSessionId,
                  childSessionId: sessionId,
                  agentName: params.agent.name,
                  prompt: params.prompt,
                }),
              )

              const binary = config.subprocessBinaryPath ?? "gent"
              const args = [
                binary,
                "--headless",
                "--session",
                sessionId,
                ...(bypass ? [] : ["--no-bypass"]),
                params.prompt,
              ]

              const proc = Bun.spawn({
                cmd: args,
                cwd: params.cwd,
                stdout: "pipe",
                stderr: "pipe",
                env: {
                  ...Bun.env,
                  ...(config.dbPath !== undefined ? { GENT_DB_PATH: config.dbPath } : {}),
                },
              })

              const [exitCode, stderrText] = yield* Effect.tryPromise({
                try: async () => {
                  const stdoutPromise =
                    proc.stdout !== null
                      ? new Response(proc.stdout).text().catch(() => "")
                      : Promise.resolve("")
                  const stderrPromise =
                    proc.stderr !== null
                      ? new Response(proc.stderr).text().catch(() => "")
                      : Promise.resolve("")
                  const code = await proc.exited
                  await stdoutPromise
                  const err = await stderrPromise
                  return [code, err] as const
                },
                catch: () => [1, "Subprocess failed"] as const,
              })

              if (exitCode !== 0) {
                yield* eventStore
                  .publish(
                    new SubagentFailed({
                      parentSessionId: params.parentSessionId,
                      childSessionId: sessionId,
                      agentName: params.agent.name,
                    }),
                  )
                  .pipe(
                    Effect.catchEager((e) =>
                      Effect.logWarning("failed to publish subagent event", e),
                    ),
                  )

                return {
                  _tag: "error" as const,
                  error:
                    stderrText.length > 0
                      ? stderrText.trim()
                      : `Subprocess exited with code ${exitCode}`,
                  sessionId,
                  agentName: params.agent.name,
                }
              }

              const messages = yield* storage.listMessages(branchId)
              let text = ""
              for (let i = messages.length - 1; i >= 0; i--) {
                const msg = messages[i]
                if (msg === undefined || msg.role !== "assistant") continue
                const part = msg.parts.find((p) => p.type === "text")
                text = part?.text ?? ""
                break
              }

              const usage = yield* collectUsage(storage, sessionId)

              yield* eventStore.publish(
                new SubagentSucceeded({
                  parentSessionId: params.parentSessionId,
                  childSessionId: sessionId,
                  agentName: params.agent.name,
                }),
              )

              return {
                _tag: "success" as const,
                text,
                sessionId,
                agentName: params.agent.name,
                usage,
              }
            })

            return run.pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
                return Effect.gen(function* () {
                  const error = Cause.pretty(cause)
                  yield* eventStore
                    .publish(
                      new SubagentFailed({
                        parentSessionId: params.parentSessionId,
                        childSessionId: sessionId,
                        agentName: params.agent.name,
                      }),
                    )
                    .pipe(
                      Effect.catchEager((e) =>
                        Effect.logWarning("failed to publish subagent event", e),
                      ),
                    )

                  return {
                    _tag: "error" as const,
                    error,
                    sessionId,
                    agentName: params.agent.name,
                  }
                })
              }),
            )
          }),
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
            return Effect.succeed({
              _tag: "error" as const,
              error: Cause.pretty(cause),
              agentName: params.agent.name,
            })
          }),
        ),
    }
  }),
)
