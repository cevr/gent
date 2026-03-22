import { Cause, ServiceMap, Duration, Effect, Layer } from "effect"
import {
  AgentSwitched,
  EventStore,
  SubagentSucceeded,
  SubagentFailed,
  SubagentSpawned,
} from "../../domain/event.js"
import { SubagentError, SubagentRunnerService, type SubagentToolCall } from "../../domain/agent.js"
import { Session, Branch } from "../../domain/message.js"
import type { SessionId, BranchId } from "../../domain/ids.js"
import { Storage, type StorageService } from "../../storage/sqlite-storage.js"
import { AgentActor } from "./agent-loop"

interface ChildMetadata {
  usage?: { input: number; output: number }
  toolCalls?: ReadonlyArray<SubagentToolCall>
}

const collectChildMetadata = (storage: StorageService, sessionId: SessionId) =>
  storage.listEvents({ sessionId }).pipe(
    Effect.map((envelopes) => {
      let input = 0
      let output = 0
      const started = new Map<string, { toolName: string; args: Record<string, unknown> }>()
      const toolCalls: SubagentToolCall[] = []

      for (const env of envelopes) {
        switch (env.event._tag) {
          case "StreamEnded":
            if (env.event.usage !== undefined) {
              input += env.event.usage.inputTokens
              output += env.event.usage.outputTokens
            }
            break
          case "ToolCallStarted":
            started.set(env.event.toolCallId, {
              toolName: env.event.toolName,
              args: (env.event.input ?? {}) as Record<string, unknown>,
            })
            break
          case "ToolCallSucceeded":
          case "ToolCallCompleted": {
            const info = started.get(env.event.toolCallId)
            toolCalls.push({
              toolName: info?.toolName ?? env.event.toolName,
              args: info?.args ?? {},
              isError: env.event._tag === "ToolCallCompleted" ? env.event.isError : false,
            })
            break
          }
          case "ToolCallFailed": {
            const info = started.get(env.event.toolCallId)
            toolCalls.push({
              toolName: info?.toolName ?? env.event.toolName,
              args: info?.args ?? {},
              isError: true,
            })
            break
          }
        }
      }

      const result: ChildMetadata = {}
      if (input > 0 || output > 0) result.usage = { input, output }
      if (toolCalls.length > 0) result.toolCalls = toolCalls
      return result
    }),
    Effect.catchEager((e) =>
      Effect.logWarning("failed to collect subagent metadata", e).pipe(
        Effect.as({} as ChildMetadata),
      ),
    ),
  )

export class SubagentRunnerConfig extends ServiceMap.Service<
  SubagentRunnerConfig,
  {
    readonly subprocessBinaryPath?: string
    readonly dbPath?: string
    readonly systemPrompt: string
    readonly timeoutMs?: number
  }
>()("@gent/runtime/src/agent/subagent-runner/SubagentRunnerConfig") {
  static Live = (config: {
    subprocessBinaryPath?: string
    dbPath?: string
    systemPrompt: string
    timeoutMs?: number
  }) =>
    Layer.succeed(SubagentRunnerConfig, {
      subprocessBinaryPath: config.subprocessBinaryPath,
      dbPath: config.dbPath,
      systemPrompt: config.systemPrompt,
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
                  toolCallId: params.toolCallId,
                  branchId: params.parentBranchId,
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
                ...(params.overrides?.modelId !== undefined
                  ? { modelId: params.overrides.modelId }
                  : {}),
                ...(params.overrides?.allowedActions !== undefined
                  ? { overrideAllowedActions: [...params.overrides.allowedActions] }
                  : {}),
                ...(params.overrides?.allowedTools !== undefined
                  ? { overrideAllowedTools: [...params.overrides.allowedTools] }
                  : {}),
                ...(params.overrides?.deniedTools !== undefined
                  ? { overrideDeniedTools: [...params.overrides.deniedTools] }
                  : {}),
                ...(params.overrides?.reasoningEffort !== undefined
                  ? { overrideReasoningEffort: params.overrides.reasoningEffort }
                  : {}),
                ...(params.overrides?.systemPromptAddendum !== undefined
                  ? { overrideSystemPromptAddendum: params.overrides.systemPromptAddendum }
                  : {}),
              })

              // No actor-level retry — replays non-idempotent tool calls.
              // Provider-level retry stays in runtime/src/retry.ts (transient, same process).
              const runWithTimeout =
                runnerConfig.timeoutMs === undefined
                  ? runSubagent
                  : runSubagent.pipe(
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

              const meta = yield* collectChildMetadata(storage, sessionId)

              yield* eventStore.publish(
                new SubagentSucceeded({
                  parentSessionId: params.parentSessionId,
                  childSessionId: sessionId,
                  agentName: params.agent.name,
                  toolCallId: params.toolCallId,
                  branchId: params.parentBranchId,
                }),
              )

              return {
                _tag: "success" as const,
                text,
                sessionId,
                agentName: params.agent.name,
                usage: meta.usage,
                toolCalls: meta.toolCalls,
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
                        toolCallId: params.toolCallId,
                        branchId: params.parentBranchId,
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
                  toolCallId: params.toolCallId,
                  branchId: params.parentBranchId,
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
                      toolCallId: params.toolCallId,
                      branchId: params.parentBranchId,
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

              const meta = yield* collectChildMetadata(storage, sessionId)

              yield* eventStore.publish(
                new SubagentSucceeded({
                  parentSessionId: params.parentSessionId,
                  childSessionId: sessionId,
                  agentName: params.agent.name,
                  toolCallId: params.toolCallId,
                  branchId: params.parentBranchId,
                }),
              )

              return {
                _tag: "success" as const,
                text,
                sessionId,
                agentName: params.agent.name,
                usage: meta.usage,
                toolCalls: meta.toolCalls,
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
                        toolCallId: params.toolCallId,
                        branchId: params.parentBranchId,
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
