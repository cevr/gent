import { Cause, DateTime, Duration, Effect, Layer } from "effect"
import { withWideEvent, WideEvent, subagentBoundary } from "../wide-event-boundary"
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
  DEFAULT_MAX_SUBAGENT_DEPTH,
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

export interface SubagentRunnerConfig {
  readonly subprocessBinaryPath?: string
  readonly dbPath?: string
  readonly systemPrompt: string
  readonly timeoutMs?: number
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

/** Compute nesting depth of a session from its persisted parent chain. Root sessions have depth 0. */
export const getSessionDepth = (sessionId: SessionId, storage: StorageService) =>
  storage.getSessionAncestors(sessionId).pipe(
    // ancestors includes the session itself at index 0, then parents
    Effect.map((ancestors) => Math.max(0, ancestors.length - 1)),
    // Fail closed: if we can't read ancestry, refuse to spawn rather than allow unbounded recursion
    Effect.mapError(
      () =>
        new SubagentError({
          message: `Cannot determine session depth for "${sessionId}" — refusing to spawn subagent.`,
        }),
    ),
  )

const makeSharedRunnerHelpers = (storage: StorageService, eventStore: EventStoreService) => {
  const collectChildMetadata = (sessionId: SessionId): Effect.Effect<ChildMetadata> =>
    storage.listEvents({ sessionId }).pipe(
      Effect.map((envelopes) => {
        const state = createChildMetadataAccumulator()
        for (const env of envelopes) applyChildMetadataEnvelope(state, env)
        return finalizeChildMetadata(state)
      }),
      Effect.catchEager((e) =>
        Effect.logWarning("failed to collect subagent metadata").pipe(
          Effect.annotateLogs({ error: String(e) }),
          Effect.as({}),
        ),
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
      const parentDepth = yield* getSessionDepth(params.parentSessionId, storage)
      if (parentDepth >= DEFAULT_MAX_SUBAGENT_DEPTH) {
        return yield* new SubagentError({
          message: `Subagent depth limit reached (max ${DEFAULT_MAX_SUBAGENT_DEPTH}). Cannot spawn "${params.agent.name}" — parent session is already at depth ${parentDepth}.`,
        })
      }

      const sessionId = Bun.randomUUIDv7() as SessionId
      const branchId = Bun.randomUUIDv7() as BranchId
      const now = yield* DateTime.nowAsDate

      yield* storage.createSession(
        new Session({
          id: sessionId,
          name: `${params.agent.name}: ${params.prompt.slice(0, 60)}`,
          cwd: params.cwd,
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

      return { sessionId, branchId }
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
      .pipe(
        Effect.catchEager((e) =>
          Effect.logWarning("failed to publish subagent event").pipe(
            Effect.annotateLogs({ error: String(e) }),
          ),
        ),
      )

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

export const InProcessRunner = (
  runnerConfig: SubagentRunnerConfig,
): Layer.Layer<SubagentRunnerService, never, Storage | EventStore | AgentActor> =>
  Layer.effect(
    SubagentRunnerService,
    Effect.gen(function* () {
      const storage = yield* Storage
      const eventStore = yield* EventStore
      const actor = yield* AgentActor
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
            Effect.flatMap(({ sessionId, branchId }) => {
              const run = Effect.gen(function* () {
                yield* WideEvent.set({ childSessionId: sessionId })

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
                          orElse: () =>
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

                yield* WideEvent.set({
                  usage: result.usage,
                  toolCallCount: result.toolCalls?.length ?? 0,
                })

                return result
              }).pipe(withWideEvent(subagentBoundary(params.agent.name, params.parentSessionId)))

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

export const SubprocessRunner = (
  config: SubagentRunnerConfig,
): Layer.Layer<SubagentRunnerService, never, Storage | EventStore> =>
  Layer.effect(
    SubagentRunnerService,
    Effect.gen(function* () {
      const storage = yield* Storage
      const eventStore = yield* EventStore
      const shared = makeSharedRunnerHelpers(storage, eventStore)

      return {
        run: (params) =>
          shared.createSubagentSession(params).pipe(
            Effect.flatMap(({ sessionId, branchId }) => {
              const run = Effect.gen(function* () {
                yield* WideEvent.set({ childSessionId: sessionId })

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
                const args = [binary, "--headless", "--session", sessionId, params.prompt]

                const killSubprocess = (proc: Bun.Subprocess) => {
                  try {
                    // Kill process group (negative PID) to clean up descendants
                    process.kill(-proc.pid, "SIGTERM")
                  } catch {
                    try {
                      proc.kill()
                    } catch {
                      // already dead
                    }
                  }
                }

                const [exitCode, stderrText] = yield* Effect.acquireUseRelease(
                  Effect.sync(() =>
                    Bun.spawn({
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
                    }),
                  ),
                  (proc) =>
                    Effect.tryPromise({
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
                    }),
                  (proc) => Effect.sync(() => killSubprocess(proc)),
                )

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

                yield* WideEvent.set({
                  usage: result.usage,
                  toolCallCount: result.toolCalls?.length ?? 0,
                })

                return result
              }).pipe(withWideEvent(subagentBoundary(params.agent.name, params.parentSessionId)))

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
