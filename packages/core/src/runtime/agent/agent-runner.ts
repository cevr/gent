import { Cause, DateTime, Duration, Effect, Layer } from "effect"
import { withWideEvent, WideEvent, agentRunBoundary } from "../wide-event-boundary"
import {
  AgentSwitched,
  AgentRunSucceeded,
  AgentRunFailed,
  AgentRunSpawned,
  EventStore,
  type EventStoreService,
  type EventEnvelope,
} from "../../domain/event.js"
import {
  DEFAULT_MAX_AGENT_RUN_DEPTH,
  AgentRunError,
  AgentRunnerService,
  resolveAgentPersistence,
  type AgentRunResult,
  type AgentRunToolCall,
  type AgentPersistence,
  type AgentExecutionOverrides,
} from "../../domain/agent.js"
import { Session, Branch, type Message } from "../../domain/message.js"
import type { SessionId, BranchId, ToolCallId } from "../../domain/ids.js"
import { Storage, type StorageService } from "../../storage/sqlite-storage.js"
import { AgentLoop } from "./agent-loop"
import { ExtensionRegistry, type ExtensionRegistryService } from "../extensions/registry.js"
import { ToolRunner, type ToolRunnerService } from "./tool-runner.js"
import { Provider, type ProviderService } from "../../providers/provider.js"
import {
  ExtensionStateRuntime,
  type ExtensionStateRuntimeService,
} from "../extensions/state-runtime.js"
import { EventStoreLive } from "../event-store-live.js"
import type { PromptSection } from "../../server/system-prompt.js"

interface ChildMetadata {
  usage?: { input: number; output: number }
  toolCalls?: ReadonlyArray<AgentRunToolCall>
}

interface ChildMetadataAccumulator {
  input: number
  output: number
  started: Map<string, { toolName: string; args: Record<string, unknown> }>
  toolCalls: AgentRunToolCall[]
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

export interface AgentRunnerConfig {
  readonly subprocessBinaryPath?: string
  readonly dbPath?: string
  readonly timeoutMs?: number
  readonly baseSections?: ReadonlyArray<PromptSection>
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

const buildAgentRunSuccess = (params: {
  text: string
  sessionId: SessionId
  agentName: string
  meta: ChildMetadata
  persistence: AgentPersistence
}) => ({
  _tag: "success" as const,
  text: params.text,
  sessionId: params.sessionId,
  agentName: params.agentName,
  persistence: params.persistence,
  usage: params.meta.usage,
  toolCalls: params.meta.toolCalls,
})

const withAgentRunFailureHandling = <E, R>(
  effect: Effect.Effect<
    AgentRunResult | { _tag: "error"; error: string; sessionId: SessionId; agentName: string },
    E,
    R
  >,
  params: {
    parentSessionId: SessionId
    parentBranchId: BranchId
    toolCallId?: ToolCallId
    sessionId: SessionId
    agentName: string
    persistence: AgentPersistence
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
          persistence: params.persistence,
        }
      })
    }),
  )

const overrideArray = <A>(values: ReadonlyArray<A> | undefined) =>
  values === undefined ? undefined : [...values]

const normalizeOverrides = (overrides: AgentExecutionOverrides | undefined) =>
  overrides === undefined
    ? undefined
    : {
        ...(overrides.modelId !== undefined ? { modelId: overrides.modelId } : {}),
        ...(overrides.allowedActions !== undefined
          ? { allowedActions: overrideArray(overrides.allowedActions) }
          : {}),
        ...(overrides.allowedTools !== undefined
          ? { allowedTools: overrideArray(overrides.allowedTools) }
          : {}),
        ...(overrides.deniedTools !== undefined
          ? { deniedTools: overrideArray(overrides.deniedTools) }
          : {}),
        ...(overrides.reasoningEffort !== undefined
          ? { reasoningEffort: overrides.reasoningEffort }
          : {}),
        ...(overrides.systemPromptAddendum !== undefined
          ? { systemPromptAddendum: overrides.systemPromptAddendum }
          : {}),
        ...(overrides.tags !== undefined ? { tags: overrideArray(overrides.tags) } : {}),
      }

const collectChildMetadata = (
  storage: StorageService,
  sessionId: SessionId,
): Effect.Effect<ChildMetadata> =>
  storage.listEvents({ sessionId }).pipe(
    Effect.map((envelopes) => {
      const state = createChildMetadataAccumulator()
      for (const env of envelopes) applyChildMetadataEnvelope(state, env)
      return finalizeChildMetadata(state)
    }),
    Effect.catchEager((e) =>
      Effect.logWarning("failed to collect agent-run metadata").pipe(
        Effect.annotateLogs({ error: String(e) }),
        Effect.as({}),
      ),
    ),
  )

const loadAgentRunSuccessData = (params: {
  storage: StorageService
  branchId: BranchId
  sessionId: SessionId
  agentName: string
  persistence: AgentPersistence
}) =>
  Effect.gen(function* () {
    const messages = yield* params.storage.listMessages(params.branchId)
    const text = latestAssistantText(messages)
    const meta = yield* collectChildMetadata(params.storage, params.sessionId)
    return buildAgentRunSuccess({
      text,
      sessionId: params.sessionId,
      agentName: params.agentName,
      meta,
      persistence: params.persistence,
    })
  })

/** Compute nesting depth of a session from its persisted parent chain. Root sessions have depth 0. */
export const getSessionDepth = (sessionId: SessionId, storage: StorageService) =>
  storage.getSessionAncestors(sessionId).pipe(
    // ancestors includes the session itself at index 0, then parents
    Effect.map((ancestors) => Math.max(0, ancestors.length - 1)),
    // Fail closed: if we can't read ancestry, refuse to spawn rather than allow unbounded recursion
    Effect.mapError(
      () =>
        new AgentRunError({
          message: `Cannot determine session depth for "${sessionId}" — refusing to start agent run.`,
        }),
    ),
  )

const makeSharedRunnerHelpers = (storage: StorageService, eventStore: EventStoreService) => {
  const createAgentRunSession = (params: {
    agent: { name: string }
    prompt: string
    parentSessionId: SessionId
    parentBranchId: BranchId
    cwd: string
  }) =>
    Effect.gen(function* () {
      const parentDepth = yield* getSessionDepth(params.parentSessionId, storage)
      if (parentDepth >= DEFAULT_MAX_AGENT_RUN_DEPTH) {
        return yield* new AgentRunError({
          message: `Agent run depth limit reached (max ${DEFAULT_MAX_AGENT_RUN_DEPTH}). Cannot spawn "${params.agent.name}" — parent session is already at depth ${parentDepth}.`,
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

  const publishAgentRunSpawned = (params: {
    parentSessionId: SessionId
    parentBranchId: BranchId
    toolCallId?: ToolCallId
    sessionId: SessionId
    agentName: string
    prompt: string
  }) =>
    eventStore.publish(
      new AgentRunSpawned({
        parentSessionId: params.parentSessionId,
        childSessionId: params.sessionId,
        agentName: params.agentName,
        prompt: params.prompt,
        toolCallId: params.toolCallId,
        branchId: params.parentBranchId,
      }),
    )

  const publishAgentRunSucceeded = (params: {
    parentSessionId: SessionId
    parentBranchId: BranchId
    toolCallId?: ToolCallId
    sessionId: SessionId
    agentName: string
  }) =>
    eventStore.publish(
      new AgentRunSucceeded({
        parentSessionId: params.parentSessionId,
        childSessionId: params.sessionId,
        agentName: params.agentName,
        toolCallId: params.toolCallId,
        branchId: params.parentBranchId,
      }),
    )

  const publishAgentRunFailed = (params: {
    parentSessionId: SessionId
    parentBranchId: BranchId
    toolCallId?: ToolCallId
    sessionId: SessionId
    agentName: string
  }) =>
    eventStore
      .publish(
        new AgentRunFailed({
          parentSessionId: params.parentSessionId,
          childSessionId: params.sessionId,
          agentName: params.agentName,
          toolCallId: params.toolCallId,
          branchId: params.parentBranchId,
        }),
      )
      .pipe(
        Effect.catchEager((e) =>
          Effect.logWarning("failed to publish agent-run event").pipe(
            Effect.annotateLogs({ error: String(e) }),
          ),
        ),
      )

  return {
    createAgentRunSession,
    publishAgentRunSpawned,
    publishAgentRunSucceeded,
    publishAgentRunFailed,
  }
}

const NoopExtensionStateRuntime: ExtensionStateRuntimeService = {
  publish: () => Effect.succeed(false),
  deriveAll: () => Effect.succeed([]),
  send: () => Effect.die("ephemeral agent runs do not support extension command sends"),
  ask: () => Effect.die("ephemeral agent runs do not support extension requests"),
  getUiSnapshots: () => Effect.succeed([]),
  terminateAll: () => Effect.void,
  notifyObservers: () => Effect.void,
}

const buildEphemeralLoopLayer = (params: {
  config: AgentRunnerConfig
  extensionRegistry: ExtensionRegistryService
  provider: ProviderService
  toolRunner: ToolRunnerService
}) => {
  const storageLayer = Storage.MemoryWithSql()
  const eventStoreLayer = Layer.provide(EventStoreLive, storageLayer)
  const deps = Layer.mergeAll(
    storageLayer,
    eventStoreLayer,
    Layer.succeed(ExtensionRegistry, params.extensionRegistry),
    Layer.succeed(ExtensionStateRuntime, NoopExtensionStateRuntime),
    Layer.succeed(Provider, params.provider),
    Layer.succeed(ToolRunner, params.toolRunner),
  )
  const loopLayer = AgentLoop.Live({ baseSections: params.config.baseSections ?? [] }).pipe(
    Layer.provide(deps),
  )
  return Layer.mergeAll(deps, loopLayer)
}

const runEphemeralAgent = (params: {
  runnerConfig: AgentRunnerConfig
  shared: ReturnType<typeof makeSharedRunnerHelpers>
  extensionRegistry: ExtensionRegistryService
  provider: ProviderService
  toolRunner: ToolRunnerService
  parentSessionId: SessionId
  parentBranchId: BranchId
  toolCallId?: ToolCallId
  cwd: string
  agentName: string
  prompt: string
  overrides?: AgentExecutionOverrides
  persistence: AgentPersistence
}) => {
  const sessionId = Bun.randomUUIDv7() as SessionId
  const branchId = Bun.randomUUIDv7() as BranchId
  const normalizedOverrides = normalizeOverrides(params.overrides)
  const ephemeralLayer = buildEphemeralLoopLayer({
    config: params.runnerConfig,
    extensionRegistry: params.extensionRegistry,
    provider: params.provider,
    toolRunner: params.toolRunner,
  })

  const runWithTimeout = (effect: Effect.Effect<void, AgentRunError>) =>
    params.runnerConfig.timeoutMs === undefined
      ? effect
      : effect.pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(params.runnerConfig.timeoutMs),
            orElse: () =>
              Effect.fail(
                new AgentRunError({
                  message: `Agent run timed out after ${params.runnerConfig.timeoutMs}ms`,
                }),
              ),
          }),
        )

  const handleUnexpectedFailure = (cause: Cause.Cause<unknown>) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
    return Effect.succeed({
      _tag: "error" as const,
      error: Cause.pretty(cause),
      agentName: params.agentName,
      persistence: params.persistence,
    })
  }

  const run = Effect.gen(function* () {
    yield* WideEvent.set({ childSessionId: sessionId })

    yield* params.shared.publishAgentRunSpawned({
      parentSessionId: params.parentSessionId,
      parentBranchId: params.parentBranchId,
      toolCallId: params.toolCallId,
      sessionId,
      agentName: params.agentName,
      prompt: params.prompt,
    })

    const result = yield* Effect.gen(function* () {
      const localStorage = yield* Storage
      const localEventStore = yield* EventStore
      const localLoop = yield* AgentLoop
      const now = yield* DateTime.nowAsDate

      yield* localStorage.createSession(
        new Session({
          id: sessionId,
          name: `${params.agentName}: ${params.prompt.slice(0, 60)}`,
          cwd: params.cwd,
          createdAt: now,
          updatedAt: now,
        }),
      )
      yield* localStorage.createBranch(
        new Branch({
          id: branchId,
          sessionId,
          createdAt: now,
        }),
      )
      yield* localEventStore.publish(
        new AgentSwitched({
          sessionId,
          branchId,
          fromAgent: "cowork",
          toAgent: params.agentName,
        }),
      )

      yield* runWithTimeout(
        localLoop.runOnce({
          sessionId,
          branchId,
          agentName: params.agentName,
          prompt: params.prompt,
          interactive: false,
          ...(normalizedOverrides !== undefined ? { overrides: normalizedOverrides } : {}),
        }),
      )

      return yield* loadAgentRunSuccessData({
        storage: localStorage,
        branchId,
        sessionId,
        agentName: params.agentName,
        persistence: params.persistence,
      })
    }).pipe(Effect.provide(ephemeralLayer))

    yield* params.shared.publishAgentRunSucceeded({
      parentSessionId: params.parentSessionId,
      parentBranchId: params.parentBranchId,
      toolCallId: params.toolCallId,
      sessionId,
      agentName: params.agentName,
    })

    yield* WideEvent.set({
      usage: result.usage,
      toolCallCount: result.toolCalls?.length ?? 0,
    })

    return result
  }).pipe(withWideEvent(agentRunBoundary(params.agentName, params.parentSessionId)))

  return withAgentRunFailureHandling(
    run,
    {
      parentSessionId: params.parentSessionId,
      parentBranchId: params.parentBranchId,
      toolCallId: params.toolCallId,
      sessionId,
      agentName: params.agentName,
      persistence: params.persistence,
      spanName: "AgentRunner.inProcess.ephemeral",
    },
    params.shared.publishAgentRunFailed,
  ).pipe(Effect.catchCause(handleUnexpectedFailure))
}

export const InProcessRunner = (
  runnerConfig: AgentRunnerConfig,
): Layer.Layer<
  AgentRunnerService,
  never,
  Storage | EventStore | AgentLoop | ExtensionRegistry | Provider | ToolRunner
> =>
  Layer.effect(
    AgentRunnerService,
    Effect.gen(function* () {
      const storage = yield* Storage
      const eventStore = yield* EventStore
      const loop = yield* AgentLoop
      const extensionRegistry = yield* ExtensionRegistry
      const provider = yield* Provider
      const toolRunner = yield* ToolRunner
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

      const runWithTimeout = (effect: Effect.Effect<void, AgentRunError>) =>
        runnerConfig.timeoutMs === undefined
          ? effect
          : effect.pipe(
              Effect.timeoutOrElse({
                duration: Duration.millis(runnerConfig.timeoutMs),
                orElse: () =>
                  Effect.fail(
                    new AgentRunError({
                      message: `Agent run timed out after ${runnerConfig.timeoutMs}ms`,
                    }),
                  ),
              }),
            )

      return {
        run: (params) => {
          const persistence = resolveAgentPersistence(params.agent, params.persistence)
          const normalizedOverrides = normalizeOverrides(params.overrides)

          const handleUnexpectedFailure = (cause: Cause.Cause<unknown>) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
            return Effect.succeed({
              _tag: "error" as const,
              error: Cause.pretty(cause),
              agentName: params.agent.name,
              persistence,
            })
          }

          if (persistence === "ephemeral") {
            return runEphemeralAgent({
              runnerConfig,
              shared,
              extensionRegistry,
              provider,
              toolRunner,
              parentSessionId: params.parentSessionId,
              parentBranchId: params.parentBranchId,
              toolCallId: params.toolCallId,
              cwd: params.cwd,
              agentName: params.agent.name,
              prompt: params.prompt,
              overrides: params.overrides,
              persistence,
            })
          }

          return shared.createAgentRunSession(params).pipe(
            Effect.flatMap(({ sessionId, branchId }) => {
              const run = Effect.gen(function* () {
                yield* WideEvent.set({ childSessionId: sessionId })

                yield* shared.publishAgentRunSpawned({
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

                yield* runWithTimeout(
                  loop.runOnce({
                    sessionId,
                    branchId,
                    agentName: params.agent.name,
                    prompt: params.prompt,
                    interactive: false,
                    ...(normalizedOverrides !== undefined
                      ? { overrides: normalizedOverrides }
                      : {}),
                  }),
                )

                const result = yield* loadAgentRunSuccessData({
                  storage,
                  branchId,
                  sessionId,
                  agentName: params.agent.name,
                  persistence,
                })
                yield* shared.publishAgentRunSucceeded({
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
              }).pipe(withWideEvent(agentRunBoundary(params.agent.name, params.parentSessionId)))

              return withAgentRunFailureHandling(
                run,
                {
                  parentSessionId: params.parentSessionId,
                  parentBranchId: params.parentBranchId,
                  toolCallId: params.toolCallId,
                  sessionId,
                  agentName: params.agent.name,
                  persistence,
                  spanName: "AgentRunner.inProcess",
                },
                shared.publishAgentRunFailed,
              )
            }),
            Effect.catchCause(handleUnexpectedFailure),
          )
        },
      }
    }),
  )

export const SubprocessRunner = (
  config: AgentRunnerConfig,
): Layer.Layer<
  AgentRunnerService,
  never,
  Storage | EventStore | ExtensionRegistry | Provider | ToolRunner
> =>
  Layer.effect(
    AgentRunnerService,
    Effect.gen(function* () {
      const storage = yield* Storage
      const eventStore = yield* EventStore
      const extensionRegistry = yield* ExtensionRegistry
      const provider = yield* Provider
      const toolRunner = yield* ToolRunner
      const shared = makeSharedRunnerHelpers(storage, eventStore)

      return {
        run: (params) => {
          const persistence = resolveAgentPersistence(params.agent, params.persistence)
          if (persistence === "ephemeral") {
            return runEphemeralAgent({
              runnerConfig: config,
              shared,
              extensionRegistry,
              provider,
              toolRunner,
              parentSessionId: params.parentSessionId,
              parentBranchId: params.parentBranchId,
              toolCallId: params.toolCallId,
              cwd: params.cwd,
              agentName: params.agent.name,
              prompt: params.prompt,
              overrides: params.overrides,
              persistence,
            })
          }

          return shared.createAgentRunSession(params).pipe(
            Effect.flatMap(({ sessionId, branchId }) => {
              const run = Effect.gen(function* () {
                yield* WideEvent.set({ childSessionId: sessionId })

                yield* shared.publishAgentRunSpawned({
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
                  yield* shared.publishAgentRunFailed({
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
                    persistence,
                  }
                }

                const result = yield* loadAgentRunSuccessData({
                  storage,
                  branchId,
                  sessionId,
                  agentName: params.agent.name,
                  persistence,
                })
                yield* shared.publishAgentRunSucceeded({
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
              }).pipe(withWideEvent(agentRunBoundary(params.agent.name, params.parentSessionId)))

              return withAgentRunFailureHandling(
                run,
                {
                  parentSessionId: params.parentSessionId,
                  parentBranchId: params.parentBranchId,
                  toolCallId: params.toolCallId,
                  sessionId,
                  agentName: params.agent.name,
                  persistence,
                  spanName: "AgentRunner.subprocess",
                },
                shared.publishAgentRunFailed,
              )
            }),
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
              return Effect.succeed({
                _tag: "error" as const,
                error: Cause.pretty(cause),
                agentName: params.agent.name,
                persistence,
              })
            }),
          )
        },
      }
    }),
  )
