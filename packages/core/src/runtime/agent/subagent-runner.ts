import { Cause, ServiceMap, Duration, Effect, Layer } from "effect"
import {
  AgentSwitched,
  EventStore,
  type EventStoreService,
  type EventEnvelope,
  SubagentSucceeded,
  SubagentFailed,
  SubagentSpawned,
} from "../../domain/event.js"
import {
  SubagentError,
  SubagentRunnerService,
  type SubagentToolCall,
  type AgentExecutionOverrides,
} from "../../domain/agent.js"
import { Session, Branch, type Message } from "../../domain/message.js"
import type { SessionId, BranchId, ToolCallId } from "../../domain/ids.js"
import { Storage, type StorageService } from "../../storage/sqlite-storage.js"
import { AgentActor } from "./agent-loop"

interface ChildMetadata {
  usage?: { input: number; output: number }
  toolCalls?: ReadonlyArray<SubagentToolCall>
}

interface ChildMetadataAccumulator {
  input: number
  output: number
  started: Map<string, { toolName: string; args: Record<string, unknown> }>
  toolCalls: SubagentToolCall[]
}

const createChildMetadataAccumulator = (): ChildMetadataAccumulator => ({
  input: 0,
  output: 0,
  started: new Map<string, { toolName: string; args: Record<string, unknown> }>(),
  toolCalls: [],
})

const appendFinishedToolCall = (
  state: ChildMetadataAccumulator,
  toolCallId: ToolCallId,
  toolName: string,
  isError: boolean,
) => {
  const info = state.started.get(toolCallId)
  state.toolCalls.push({
    toolName: info?.toolName ?? toolName,
    args: info?.args ?? {},
    isError,
  })
}

const applyChildMetadataEnvelope = (state: ChildMetadataAccumulator, env: EventEnvelope) => {
  switch (env.event._tag) {
    case "StreamEnded":
      if (env.event.usage !== undefined) {
        state.input += env.event.usage.inputTokens
        state.output += env.event.usage.outputTokens
      }
      return
    case "ToolCallStarted":
      state.started.set(env.event.toolCallId, {
        toolName: env.event.toolName,
        args: (env.event.input ?? {}) as Record<string, unknown>,
      })
      return
    case "ToolCallSucceeded":
      appendFinishedToolCall(state, env.event.toolCallId, env.event.toolName, false)
      return
    case "ToolCallCompleted":
      appendFinishedToolCall(state, env.event.toolCallId, env.event.toolName, env.event.isError)
      return
    case "ToolCallFailed":
      appendFinishedToolCall(state, env.event.toolCallId, env.event.toolName, true)
      return
  }
}

const finalizeChildMetadata = (state: ChildMetadataAccumulator): ChildMetadata => ({
  ...(state.input > 0 || state.output > 0
    ? { usage: { input: state.input, output: state.output } }
    : {}),
  ...(state.toolCalls.length > 0 ? { toolCalls: state.toolCalls } : {}),
})

export class SubagentRunnerConfig extends ServiceMap.Service<
  SubagentRunnerConfig,
  {
    readonly subprocessBinaryPath?: string
    readonly dbPath?: string
    readonly systemPrompt: string
    readonly timeoutMs?: number
  }
>()("@gent/core/src/runtime/agent/subagent-runner/SubagentRunnerConfig") {
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

const latestAssistantText = (messages: ReadonlyArray<Message>) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg === undefined || msg.role !== "assistant") continue
    const part = msg.parts.find((p) => p.type === "text")
    return part?.text ?? ""
  }
  return ""
}

const buildSubagentSuccess = (params: {
  text: string
  sessionId: SessionId
  agentName: string
  meta: ChildMetadata
}) => ({
  _tag: "success" as const,
  text: params.text,
  sessionId: params.sessionId,
  agentName: params.agentName,
  usage: params.meta.usage,
  toolCalls: params.meta.toolCalls,
})

const withSubagentFailureHandling = <E, R>(
  effect: Effect.Effect<
    | {
        _tag: "success"
        text: string
        sessionId: SessionId
        agentName: string
        usage?: { input: number; output: number }
        toolCalls?: ReadonlyArray<SubagentToolCall>
      }
    | {
        _tag: "error"
        error: string
        sessionId: SessionId
        agentName: string
      },
    E,
    R
  >,
  params: {
    parentSessionId: SessionId
    parentBranchId: BranchId
    toolCallId?: ToolCallId
    sessionId: SessionId
    agentName: string
    spanName: string
  },
  publishFailed: (params: {
    parentSessionId: SessionId
    parentBranchId: BranchId
    toolCallId?: ToolCallId
    sessionId: SessionId
    agentName: string
  }) => Effect.Effect<void, never>,
) =>
  effect.pipe(
    Effect.withSpan(params.spanName, {
      attributes: { agentName: params.agentName },
    }),
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
      return Effect.gen(function* () {
        const error = Cause.pretty(cause)
        yield* publishFailed(params)
        return {
          _tag: "error" as const,
          error,
          sessionId: params.sessionId,
          agentName: params.agentName,
        }
      })
    }),
  )

const overrideArray = <A>(values: ReadonlyArray<A> | undefined) =>
  values === undefined ? undefined : [...values]

const buildRunInputOverrides = (overrides: AgentExecutionOverrides | undefined) => ({
  ...(overrides?.modelId !== undefined ? { modelId: overrides.modelId } : {}),
  ...(overrides?.allowedActions !== undefined
    ? { overrideAllowedActions: overrideArray(overrides.allowedActions) }
    : {}),
  ...(overrides?.allowedTools !== undefined
    ? { overrideAllowedTools: overrideArray(overrides.allowedTools) }
    : {}),
  ...(overrides?.deniedTools !== undefined
    ? { overrideDeniedTools: overrideArray(overrides.deniedTools) }
    : {}),
  ...(overrides?.reasoningEffort !== undefined
    ? { overrideReasoningEffort: overrides.reasoningEffort }
    : {}),
  ...(overrides?.systemPromptAddendum !== undefined
    ? { overrideSystemPromptAddendum: overrides.systemPromptAddendum }
    : {}),
  ...(overrides?.tags !== undefined ? { tags: overrideArray(overrides.tags) } : {}),
})

const makeSharedRunnerHelpers = (storage: StorageService, eventStore: EventStoreService) => {
  const collectChildMetadata = (sessionId: SessionId): Effect.Effect<ChildMetadata> =>
    storage.listEvents({ sessionId }).pipe(
      Effect.map((envelopes) => {
        const state = createChildMetadataAccumulator()
        for (const env of envelopes) applyChildMetadataEnvelope(state, env)
        return finalizeChildMetadata(state)
      }),
      Effect.catchEager((e) =>
        Effect.logWarning("failed to collect subagent metadata", e).pipe(Effect.as({})),
      ),
    )

  const createSubagentSession = (params: {
    agent: { name: string }
    prompt: string
    parentSessionId: SessionId
    parentBranchId: BranchId
    cwd: string
  }) =>
    Effect.gen(function* () {
      const sessionId = Bun.randomUUIDv7() as SessionId
      const branchId = Bun.randomUUIDv7() as BranchId
      const now = new Date()
      const parentSession = yield* storage.getSession(params.parentSessionId)
      const bypass = parentSession?.bypass ?? true

      yield* storage.createSession(
        new Session({
          id: sessionId,
          name: `${params.agent.name}: ${params.prompt.slice(0, 60)}`,
          cwd: params.cwd,
          bypass,
          parentSessionId: params.parentSessionId,
          parentBranchId: params.parentBranchId,
          createdAt: now,
          updatedAt: now,
        }),
      )
      yield* storage.createBranch(
        new Branch({
          id: branchId,
          sessionId,
          createdAt: now,
        }),
      )

      return { sessionId, branchId, bypass }
    })

  const publishSubagentSpawned = (params: {
    parentSessionId: SessionId
    parentBranchId: BranchId
    toolCallId?: ToolCallId
    sessionId: SessionId
    agentName: string
    prompt: string
  }) =>
    eventStore.publish(
      new SubagentSpawned({
        parentSessionId: params.parentSessionId,
        childSessionId: params.sessionId,
        agentName: params.agentName,
        prompt: params.prompt,
        toolCallId: params.toolCallId,
        branchId: params.parentBranchId,
      }),
    )

  const publishSubagentSucceeded = (params: {
    parentSessionId: SessionId
    parentBranchId: BranchId
    toolCallId?: ToolCallId
    sessionId: SessionId
    agentName: string
  }) =>
    eventStore.publish(
      new SubagentSucceeded({
        parentSessionId: params.parentSessionId,
        childSessionId: params.sessionId,
        agentName: params.agentName,
        toolCallId: params.toolCallId,
        branchId: params.parentBranchId,
      }),
    )

  const publishSubagentFailed = (params: {
    parentSessionId: SessionId
    parentBranchId: BranchId
    toolCallId?: ToolCallId
    sessionId: SessionId
    agentName: string
  }) =>
    eventStore
      .publish(
        new SubagentFailed({
          parentSessionId: params.parentSessionId,
          childSessionId: params.sessionId,
          agentName: params.agentName,
          toolCallId: params.toolCallId,
          branchId: params.parentBranchId,
        }),
      )
      .pipe(Effect.catchEager((e) => Effect.logWarning("failed to publish subagent event", e)))

  const loadSubagentSuccessData = (branchId: BranchId, sessionId: SessionId, agentName: string) =>
    Effect.gen(function* () {
      const messages = yield* storage.listMessages(branchId)
      const text = latestAssistantText(messages)
      const meta = yield* collectChildMetadata(sessionId)
      return buildSubagentSuccess({ text, sessionId, agentName, meta })
    })

  return {
    collectChildMetadata,
    createSubagentSession,
    publishSubagentSpawned,
    publishSubagentSucceeded,
    publishSubagentFailed,
    loadSubagentSuccessData,
  }
}

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
    const shared = makeSharedRunnerHelpers(storage, eventStore)
    const publishAgentSwitch = (params: {
      sessionId: SessionId
      branchId: BranchId
      agentName: string
    }) =>
      eventStore.publish(
        new AgentSwitched({
          sessionId: params.sessionId,
          branchId: params.branchId,
          fromAgent: "cowork",
          toAgent: params.agentName,
        }),
      )

    return {
      run: (params) =>
        shared.createSubagentSession(params).pipe(
          Effect.flatMap(({ sessionId, branchId, bypass }) => {
            const run = Effect.gen(function* () {
              yield* shared.publishSubagentSpawned({
                parentSessionId: params.parentSessionId,
                parentBranchId: params.parentBranchId,
                toolCallId: params.toolCallId,
                sessionId,
                agentName: params.agent.name,
                prompt: params.prompt,
              })
              yield* publishAgentSwitch({
                sessionId,
                branchId,
                agentName: params.agent.name,
              })

              const runSubagent = actor.run({
                sessionId,
                branchId,
                agentName: params.agent.name,
                prompt: params.prompt,
                systemPrompt: runnerConfig.systemPrompt,
                bypass,
                ...buildRunInputOverrides(params.overrides),
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
              const result = yield* shared.loadSubagentSuccessData(
                branchId,
                sessionId,
                params.agent.name,
              )
              yield* shared.publishSubagentSucceeded({
                parentSessionId: params.parentSessionId,
                parentBranchId: params.parentBranchId,
                toolCallId: params.toolCallId,
                sessionId,
                agentName: params.agent.name,
              })
              return result
            })

            return withSubagentFailureHandling(
              run,
              {
                parentSessionId: params.parentSessionId,
                parentBranchId: params.parentBranchId,
                toolCallId: params.toolCallId,
                sessionId,
                agentName: params.agent.name,
                spanName: "SubagentRunner.inProcess",
              },
              shared.publishSubagentFailed,
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
    const shared = makeSharedRunnerHelpers(storage, eventStore)

    return {
      run: (params) =>
        shared.createSubagentSession(params).pipe(
          Effect.flatMap(({ sessionId, branchId, bypass }) => {
            const run = Effect.gen(function* () {
              yield* shared.publishSubagentSpawned({
                parentSessionId: params.parentSessionId,
                parentBranchId: params.parentBranchId,
                toolCallId: params.toolCallId,
                sessionId,
                agentName: params.agent.name,
                prompt: params.prompt,
              })

              // Capture trace context for subprocess propagation
              const currentSpan = yield* Effect.currentParentSpan.pipe(
                Effect.orElseSucceed(() => undefined),
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
                  ...(currentSpan !== undefined
                    ? {
                        GENT_TRACE_ID: currentSpan.traceId,
                        GENT_PARENT_SPAN_ID: currentSpan.spanId,
                      }
                    : {}),
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
                yield* shared.publishSubagentFailed({
                  parentSessionId: params.parentSessionId,
                  parentBranchId: params.parentBranchId,
                  toolCallId: params.toolCallId,
                  sessionId,
                  agentName: params.agent.name,
                })

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

              const result = yield* shared.loadSubagentSuccessData(
                branchId,
                sessionId,
                params.agent.name,
              )
              yield* shared.publishSubagentSucceeded({
                parentSessionId: params.parentSessionId,
                parentBranchId: params.parentBranchId,
                toolCallId: params.toolCallId,
                sessionId,
                agentName: params.agent.name,
              })
              return result
            })

            return withSubagentFailureHandling(
              run,
              {
                parentSessionId: params.parentSessionId,
                parentBranchId: params.parentBranchId,
                toolCallId: params.toolCallId,
                sessionId,
                agentName: params.agent.name,
                spanName: "SubagentRunner.subprocess",
              },
              shared.publishSubagentFailed,
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
