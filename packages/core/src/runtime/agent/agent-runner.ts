import {
  Cause,
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  ManagedRuntime,
  Schema,
  Stream,
} from "effect"
import type { Context } from "effect"
import { withWideEvent, WideEvent, agentRunBoundary } from "../wide-event-boundary"
import {
  AgentSwitched,
  AgentRunSucceeded,
  AgentRunFailed,
  AgentRunSpawned,
  BaseEventStore,
  EventStore,
  getEventBranchId,
  getEventSessionId,
  type AgentEvent,
  type EventStoreService,
  type EventEnvelope,
} from "../../domain/event.js"
import { EventPublisher, type EventPublisherService } from "../../domain/event-publisher.js"
import {
  DEFAULT_MAX_AGENT_RUN_DEPTH,
  AgentRunError,
  AgentRunnerService,
  DEFAULT_AGENT_NAME,
  resolveAgentPersistence,
  type AgentRunResult,
  type AgentRunToolCall,
  type AgentPersistence,
  type AgentExecutionOverrides,
  AgentExecutionOverridesSchema,
} from "../../domain/agent.js"
import { Session, Branch, type Message } from "../../domain/message.js"
import { SessionId, BranchId } from "../../domain/ids.js"
import type { ToolCallId } from "../../domain/ids.js"
import { Storage, type StorageService } from "../../storage/sqlite-storage.js"
import { AgentLoop } from "./agent-loop"
import { ExtensionRegistry, type ExtensionRegistryService } from "../extensions/registry.js"
import { ToolRunner } from "./tool-runner.js"
import type { Provider } from "../../providers/provider.js"
import { ExtensionStateRuntime } from "../extensions/state-runtime.js"
import { ExtensionEventBus } from "../extensions/event-bus.js"
import { ExtensionTurnControl } from "../extensions/turn-control.js"
import { PromptPresenter } from "../../domain/prompt-presenter.js"
import { ApprovalService } from "../approval-service.js"
import { EventStoreLive } from "../event-store-live.js"
import { EventPublisherLive } from "../../server/event-publisher.js"
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
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
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
  /** URL of the shared server. Subprocess children pass --connect <url> to reuse it. */
  readonly sharedServerUrl?: string
}

const latestAssistantContent = (messages: ReadonlyArray<Message>) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg === undefined || msg.role !== "assistant") continue
    const text = msg.parts.find((p) => p.type === "text")?.text ?? ""
    const reasoning = msg.parts
      .filter((p) => p.type === "reasoning")
      .map((p) => (p as { text: string }).text)
      .join("\n")
    return { text, reasoning }
  }
  return { text: "", reasoning: "" }
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
    const { text, reasoning } = latestAssistantContent(messages)
    const meta = yield* collectChildMetadata(params.storage, params.sessionId)
    return {
      ...buildAgentRunSuccess({
        text: text.length > 0 ? text : reasoning,
        sessionId: params.sessionId,
        agentName: params.agentName,
        meta,
        persistence: params.persistence,
      }),
      reasoning,
    }
  })

const saveAgentRunOutput = (result: {
  text: string
  reasoning: string
  agentName: string
  sessionId: SessionId
}) =>
  Effect.gen(function* () {
    const fullContent = [
      result.reasoning.length > 0 ? `## Reasoning\n\n${result.reasoning}\n\n` : "",
      `## Response\n\n${result.text}`,
    ]
      .filter(Boolean)
      .join("")

    if (fullContent.length === 0) return undefined

    const fs = yield* Effect.serviceOption(FileSystem.FileSystem)
    if (fs._tag === "None") return undefined

    const ts = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-")
    const dir = "/tmp/gent/outputs"
    yield* fs.value.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore)
    const safe = result.agentName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)
    const filepath = `${dir}/${safe}_${result.sessionId.slice(0, 13)}_${ts}.md`
    const header = `# ${result.agentName} — ${result.sessionId}\n\n`
    return yield* fs.value.writeFileString(filepath, header + fullContent).pipe(
      Effect.as(filepath as string | undefined),
      Effect.orElseSucceed((): string | undefined => undefined),
    )
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

const makeSharedRunnerHelpers = (
  storage: StorageService,
  eventPublisher: EventPublisherService,
) => {
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

      const sessionId = SessionId.of(Bun.randomUUIDv7())
      const branchId = BranchId.of(Bun.randomUUIDv7())
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
    childBranchId: BranchId
    agentName: string
    prompt: string
  }) =>
    eventPublisher.publish(
      new AgentRunSpawned({
        parentSessionId: params.parentSessionId,
        childSessionId: params.sessionId,
        agentName: params.agentName,
        prompt: params.prompt,
        toolCallId: params.toolCallId,
        branchId: params.parentBranchId,
        childBranchId: params.childBranchId,
      }),
    )

  const publishAgentRunSucceeded = (params: {
    parentSessionId: SessionId
    parentBranchId: BranchId
    toolCallId?: ToolCallId
    sessionId: SessionId
    agentName: string
    usage?: { input: number; output: number; cost?: number }
    preview?: string
    savedPath?: string
  }) =>
    eventPublisher.publish(
      new AgentRunSucceeded({
        parentSessionId: params.parentSessionId,
        childSessionId: params.sessionId,
        agentName: params.agentName,
        toolCallId: params.toolCallId,
        branchId: params.parentBranchId,
        usage: params.usage,
        preview: params.preview,
        savedPath: params.savedPath,
      }),
    )

  const publishAgentRunFailed = (params: {
    parentSessionId: SessionId
    parentBranchId: BranchId
    toolCallId?: ToolCallId
    sessionId: SessionId
    agentName: string
  }) =>
    eventPublisher
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

const buildEphemeralLayer = (params: {
  config: AgentRunnerConfig
  parentServices: Context.Context<never>
  extensionRegistry: ExtensionRegistryService
}) => {
  const parentLayer = Layer.succeedContext(params.parentServices)

  const resolved = params.extensionRegistry.getResolved()

  // Ephemeral storage (in-memory SQLite — discarded after run)
  const storageLayer = Storage.MemoryWithSql()
  const eventStoreLayer = Layer.provide(EventStoreLive, storageLayer)

  // Extension runtime — rebuilt locally to avoid cross-wiring parent's TurnControl
  const extensionTurnControlLayer = ExtensionTurnControl.Live
  const extensionStateRuntimeLayer = ExtensionStateRuntime.Live(resolved.extensions).pipe(
    Layer.provide(extensionTurnControlLayer),
  )

  // Bus subscriptions for local extension actor routing
  const busSubscriptions = resolved.extensions.flatMap((ext) =>
    (ext.setup.busSubscriptions ?? []).map((sub) => ({
      pattern: sub.pattern,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      handler: sub.handler as (envelope: {
        channel: string
        payload: unknown
        sessionId?: string
        branchId?: string
      }) => void | Promise<void>,
    })),
  )
  const extensionEventBusLayer = ExtensionEventBus.withSubscriptions(busSubscriptions)

  // Non-interactive approval (auto-approve all, cancel ask-user)
  const approvalLayer = ApprovalService.LiveAutoResolve

  // Event publisher on ephemeral storage — must include bus so extension subscriptions fire
  const eventPublisherLayer = Layer.provide(
    EventPublisherLive,
    Layer.mergeAll(eventStoreLayer, extensionStateRuntimeLayer, extensionEventBusLayer),
  )

  // PromptPresenter built on auto-resolve ApprovalService — parent first so local approval wins
  const promptPresenterLayer = Layer.provide(
    PromptPresenter.Live,
    Layer.mergeAll(parentLayer, approvalLayer),
  )

  // Extension-contributed layers (forwarded from parent — these are startup-built, typically read-only)
  const extensionLayers = resolved.extensions
    .filter((ext) => ext.setup.layer !== undefined)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
    .map((ext) => ext.setup.layer as Layer.Layer<any>)

  // Registry (forwarded from parent — read-only resolved data)
  const registryLayer = Layer.succeed(ExtensionRegistry, params.extensionRegistry)

  // Core deps for AgentLoop + ToolRunner
  const coreDeps = Layer.mergeAll(
    storageLayer,
    eventStoreLayer,
    eventPublisherLayer,
    registryLayer,
    extensionStateRuntimeLayer,
    extensionTurnControlLayer,
    extensionEventBusLayer,
    approvalLayer,
    promptPresenterLayer,
  )

  // ToolRunner rebuilt locally — parent first so local coreDeps (ApprovalService, Storage, etc.) win
  const toolRunnerLayer = Layer.provide(ToolRunner.Live, Layer.merge(parentLayer, coreDeps))

  const allDeps = Layer.mergeAll(coreDeps, toolRunnerLayer)
  const loopLayer = AgentLoop.Live({ baseSections: params.config.baseSections ?? [] }).pipe(
    Layer.provide(Layer.merge(parentLayer, allDeps)),
  )

  // Parent first — local overrides (storage, events, approval, loop) take precedence
  const base = Layer.mergeAll(parentLayer, allDeps, loopLayer)
  if (extensionLayers.length === 0) return base
  let result = base
  for (const extLayer of extensionLayers) {
    result = Layer.provideMerge(extLayer, result)
  }
  return result
}

const shouldMirrorEphemeralChildEvent = (event: AgentEvent): boolean => {
  switch (event._tag) {
    case "StreamStarted":
    case "StreamEnded":
    case "ToolCallStarted":
    case "ToolCallSucceeded":
    case "ToolCallFailed":
      return true
    default:
      return false
  }
}

const runEphemeralAgent = (params: {
  runnerConfig: AgentRunnerConfig
  shared: ReturnType<typeof makeSharedRunnerHelpers>
  extensionRegistry: ExtensionRegistryService
  parentServices: Context.Context<never>
  parentSessionId: SessionId
  parentBranchId: BranchId
  toolCallId?: ToolCallId
  cwd: string
  agentName: string
  prompt: string
  overrides?: AgentExecutionOverrides
  persistence: AgentPersistence
  parentBaseEventStore: EventStoreService
  notifyMirroredEventObservers: (event: AgentEvent) => Effect.Effect<void>
}) => {
  const sessionId = SessionId.of(Bun.randomUUIDv7())
  const branchId = BranchId.of(Bun.randomUUIDv7())
  const normalizedOverrides = normalizeOverrides(params.overrides)
  const ephemeralLayer = buildEphemeralLayer({
    config: params.runnerConfig,
    parentServices: params.parentServices,
    extensionRegistry: params.extensionRegistry,
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
  const ephemeralRuntime = ManagedRuntime.make(ephemeralLayer as Layer.Layer<any>)

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
      childBranchId: branchId,
      agentName: params.agentName,
      prompt: params.prompt,
    })

    const result = yield* Effect.acquireUseRelease(
      Effect.succeed(ephemeralRuntime),
      (runtime) =>
        Effect.promise(() =>
          runtime.runPromiseExit(
            Effect.gen(function* () {
              const localStorage = yield* Storage
              const localEventStore = yield* EventStore
              const localEventPublisher = yield* EventPublisher
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

              const mirrorFiber = yield* Effect.forkChild(
                localEventStore.subscribe({ sessionId }).pipe(
                  Stream.runForEach((envelope) =>
                    shouldMirrorEphemeralChildEvent(envelope.event)
                      ? params.parentBaseEventStore.publish(envelope.event).pipe(
                          Effect.tap(() => params.notifyMirroredEventObservers(envelope.event)),
                          Effect.catchEager(() => Effect.void),
                        )
                      : Effect.void,
                  ),
                  Effect.catchEager(() => Effect.void),
                ),
              )
              yield* localEventPublisher.publish(
                new AgentSwitched({
                  sessionId,
                  branchId,
                  fromAgent: DEFAULT_AGENT_NAME,
                  toAgent: params.agentName,
                }),
              )

              return yield* Effect.gen(function* () {
                const runOverrides =
                  params.toolCallId !== undefined
                    ? { ...normalizedOverrides, parentToolCallId: params.toolCallId }
                    : normalizedOverrides
                yield* runWithTimeout(
                  localLoop.runOnce({
                    sessionId,
                    branchId,
                    agentName: params.agentName,
                    prompt: params.prompt,
                    interactive: false,
                    ...(runOverrides !== undefined ? { overrides: runOverrides } : {}),
                  }),
                )

                return yield* loadAgentRunSuccessData({
                  storage: localStorage,
                  branchId,
                  sessionId,
                  agentName: params.agentName,
                  persistence: params.persistence,
                })
              }).pipe(Effect.ensuring(Fiber.interrupt(mirrorFiber)))
            }),
          ),
        ).pipe(
          Effect.flatMap((exit) =>
            Exit.isFailure(exit) ? Effect.failCause(exit.cause) : Effect.succeed(exit.value),
          ),
        ),
      (runtime) => Effect.promise(() => runtime.dispose()).pipe(Effect.orDie),
    )

    // Save full output to disk (runs in parent context where FileSystem is available)
    const savedPath = yield* saveAgentRunOutput({
      text: result.text,
      reasoning: result.reasoning,
      agentName: params.agentName,
      sessionId,
    })

    const preview = result.text.length > 200 ? result.text.slice(0, 200) + "…" : result.text

    yield* params.shared.publishAgentRunSucceeded({
      parentSessionId: params.parentSessionId,
      parentBranchId: params.parentBranchId,
      toolCallId: params.toolCallId,
      sessionId,
      agentName: params.agentName,
      usage: result.usage,
      preview,
      savedPath,
    })

    yield* WideEvent.set({
      usage: result.usage,
      toolCallCount: result.toolCalls?.length ?? 0,
    })

    return { ...result, savedPath }
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
  Storage | BaseEventStore | EventStore | EventPublisher | AgentLoop | ExtensionRegistry | Provider
> =>
  Layer.effect(
    AgentRunnerService,
    Effect.gen(function* () {
      const storage = yield* Storage
      const baseEventStore = yield* BaseEventStore
      const eventPublisher = yield* EventPublisher
      const loop = yield* AgentLoop
      const extensionRegistry = yield* ExtensionRegistry
      const busOpt = yield* Effect.serviceOption(ExtensionEventBus)

      // Capture full parent context — no manual enumeration needed
      const parentServices = yield* Effect.context()

      const shared = makeSharedRunnerHelpers(storage, eventPublisher)
      const notifyMirroredEventObservers = (event: AgentEvent) => {
        const sessionId = getEventSessionId(event)
        const branchId = getEventBranchId(event)
        return Effect.all(
          [
            busOpt._tag === "Some" && sessionId !== undefined
              ? busOpt.value.emit({
                  channel: `agent:${event._tag}`,
                  payload: event,
                  sessionId,
                  branchId,
                })
              : Effect.void,
          ],
          { discard: true },
        )
      }
      const publishAgentSwitch = (params: {
        sessionId: SessionId
        branchId: BranchId
        agentName: string
      }) =>
        eventPublisher.publish(
          new AgentSwitched({
            sessionId: params.sessionId,
            branchId: params.branchId,
            fromAgent: DEFAULT_AGENT_NAME,
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
              parentServices,
              parentSessionId: params.parentSessionId,
              parentBranchId: params.parentBranchId,
              toolCallId: params.toolCallId,
              cwd: params.cwd,
              agentName: params.agent.name,
              prompt: params.prompt,
              overrides: params.overrides,
              persistence,
              parentBaseEventStore: baseEventStore,
              notifyMirroredEventObservers,
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
                  childBranchId: branchId,
                  agentName: params.agent.name,
                  prompt: params.prompt,
                })
                yield* publishAgentSwitch({
                  sessionId,
                  branchId,
                  agentName: params.agent.name,
                })

                const durableRunOverrides =
                  params.toolCallId !== undefined
                    ? { ...normalizedOverrides, parentToolCallId: params.toolCallId }
                    : normalizedOverrides
                yield* runWithTimeout(
                  loop.runOnce({
                    sessionId,
                    branchId,
                    agentName: params.agent.name,
                    prompt: params.prompt,
                    interactive: false,
                    ...(durableRunOverrides !== undefined
                      ? { overrides: durableRunOverrides }
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
                const savedPath = yield* saveAgentRunOutput({
                  text: result.text,
                  reasoning: result.reasoning,
                  agentName: params.agent.name,
                  sessionId,
                })
                const preview =
                  result.text.length > 200 ? result.text.slice(0, 200) + "…" : result.text
                yield* shared.publishAgentRunSucceeded({
                  parentSessionId: params.parentSessionId,
                  parentBranchId: params.parentBranchId,
                  toolCallId: params.toolCallId,
                  sessionId,
                  agentName: params.agent.name,
                  usage: result.usage,
                  preview,
                  savedPath,
                })

                yield* WideEvent.set({
                  usage: result.usage,
                  toolCallCount: result.toolCalls?.length ?? 0,
                })

                return { ...result, savedPath }
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
  Storage | BaseEventStore | EventStore | EventPublisher | ExtensionRegistry | Provider
> =>
  Layer.effect(
    AgentRunnerService,
    Effect.gen(function* () {
      const storage = yield* Storage
      const baseEventStore = yield* BaseEventStore
      const eventPublisher = yield* EventPublisher
      const extensionRegistry = yield* ExtensionRegistry
      const busOpt = yield* Effect.serviceOption(ExtensionEventBus)

      // Capture full parent context — no manual enumeration needed
      const parentServices = yield* Effect.context()

      const shared = makeSharedRunnerHelpers(storage, eventPublisher)
      const notifyMirroredEventObservers = (event: AgentEvent) => {
        const sessionId = getEventSessionId(event)
        const branchId = getEventBranchId(event)
        return Effect.all(
          [
            busOpt._tag === "Some" && sessionId !== undefined
              ? busOpt.value.emit({
                  channel: `agent:${event._tag}`,
                  payload: event,
                  sessionId,
                  branchId,
                })
              : Effect.void,
          ],
          { discard: true },
        )
      }

      return {
        run: (params) => {
          const persistence = resolveAgentPersistence(params.agent, params.persistence)
          if (persistence === "ephemeral") {
            return runEphemeralAgent({
              runnerConfig: config,
              shared,
              extensionRegistry,
              parentServices,
              parentSessionId: params.parentSessionId,
              parentBranchId: params.parentBranchId,
              toolCallId: params.toolCallId,
              cwd: params.cwd,
              agentName: params.agent.name,
              prompt: params.prompt,
              overrides: params.overrides,
              persistence,
              parentBaseEventStore: baseEventStore,
              notifyMirroredEventObservers,
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
                  childBranchId: branchId,
                  agentName: params.agent.name,
                  prompt: params.prompt,
                })

                // Capture trace context for subprocess propagation
                const currentSpan = yield* Effect.currentParentSpan.pipe(
                  Effect.orElseSucceed(() => undefined),
                )

                const binary = config.subprocessBinaryPath ?? "gent"
                // Merge parentToolCallId into overrides for subprocess
                const subprocessOverrides: AgentExecutionOverrides | undefined =
                  params.toolCallId !== undefined
                    ? { ...params.overrides, parentToolCallId: params.toolCallId }
                    : params.overrides
                const overridesJson =
                  subprocessOverrides !== undefined
                    ? Schema.encodeSync(Schema.fromJsonString(AgentExecutionOverridesSchema))(
                        subprocessOverrides,
                      )
                    : undefined
                const args = [
                  binary,
                  "--headless",
                  "--session",
                  sessionId,
                  ...(config.sharedServerUrl !== undefined
                    ? ["--connect", config.sharedServerUrl]
                    : []),
                  ...(overridesJson !== undefined ? ["--execution-overrides", overridesJson] : []),
                  params.prompt,
                ]

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
                        ...(config.sharedServerUrl !== undefined
                          ? { GENT_SHARED_SERVER_URL: config.sharedServerUrl }
                          : {}),
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
                const savedPath = yield* saveAgentRunOutput({
                  text: result.text,
                  reasoning: result.reasoning,
                  agentName: params.agent.name,
                  sessionId,
                })
                const preview =
                  result.text.length > 200 ? result.text.slice(0, 200) + "…" : result.text
                yield* shared.publishAgentRunSucceeded({
                  parentSessionId: params.parentSessionId,
                  parentBranchId: params.parentBranchId,
                  toolCallId: params.toolCallId,
                  sessionId,
                  agentName: params.agent.name,
                  usage: result.usage,
                  preview,
                  savedPath,
                })

                yield* WideEvent.set({
                  usage: result.usage,
                  toolCallCount: result.toolCalls?.length ?? 0,
                })

                return { ...result, savedPath }
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
