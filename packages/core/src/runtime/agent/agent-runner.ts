import {
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Schema,
  Stream,
} from "effect"
import { withWideEvent, WideEvent, agentRunBoundary } from "../wide-event-boundary"
import {
  AgentSwitched,
  AgentRunSucceeded,
  AgentRunFailed,
  AgentRunSpawned,
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
  resolveRunPersistence,
  type AgentRunResult,
  type AgentRunToolCall,
  type AgentPersistence,
  type RunSpec,
  RunSpecSchema,
} from "../../domain/agent.js"
import { Session, Branch, type Message } from "../../domain/message.js"
import { SessionId, BranchId } from "../../domain/ids.js"
import type { ToolCallId } from "../../domain/ids.js"
import { Storage, type StorageService } from "../../storage/sqlite-storage.js"
import { ExtensionRegistry, type ExtensionRegistryService } from "../extensions/registry.js"
import { SessionRuntime } from "../session-runtime.js"
import { ToolRunner } from "./tool-runner.js"
import { Provider } from "../../providers/provider.js"
import { SubscriptionEngine } from "../extensions/resource-host/subscription-engine.js"
import { PromptPresenter } from "../../domain/prompt-presenter.js"
import { ApprovalService } from "../approval-service.js"
import { EventStoreLive } from "../event-store-live.js"
import { ResourceManagerLive } from "../resource-manager.js"
import { RuntimePlatform } from "../runtime-platform.js"
import { ConfigService } from "../config-service.js"
import { buildExtensionLayers } from "../profile.js"
import { ServerProfileService, type ServerProfile } from "../scope-brands.js"
import { RuntimeComposer } from "../composer.js"
import { runWithBuiltLayer } from "../run-with-built-layer.js"
import type { PromptSection } from "../../domain/prompt.js"

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

const normalizeRunSpec = (runSpec: RunSpec | undefined): RunSpec | undefined => {
  if (runSpec === undefined) return undefined
  const overrides = runSpec.overrides
  const normalizedOverrides =
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
        }
  return {
    ...(runSpec.persistence !== undefined ? { persistence: runSpec.persistence } : {}),
    ...(normalizedOverrides !== undefined ? { overrides: normalizedOverrides } : {}),
    ...(runSpec.tags !== undefined ? { tags: overrideArray(runSpec.tags) } : {}),
    ...(runSpec.parentToolCallId !== undefined
      ? { parentToolCallId: runSpec.parentToolCallId }
      : {}),
  }
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

      const sessionId = SessionId.make(Bun.randomUUIDv7())
      const branchId = BranchId.make(Bun.randomUUIDv7())
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
      AgentRunSpawned.make({
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
      AgentRunSucceeded.make({
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
        AgentRunFailed.make({
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

/**
 * Build the layer for an ephemeral child run via {@link RuntimeComposer}.
 *
 * Reuses `buildExtensionLayers` (the same builder used by server / per-cwd) so
 * registry/state-runtime/event-bus shape stays identical — extensions don't
 * "see" a different runtime when invoked from a child agent. Local-only
 * concerns (in-memory storage, auto-resolve approval, prompt presenter, loop
 * services) are declared via `.own(...)` so the composer derives the
 * parent-omit set from the same list — no hand-maintained `Context.omit`
 * drift bug.
 */
const buildEphemeralLayer = (params: {
  config: AgentRunnerConfig
  parentServices: Context.Context<never>
  parentProfile: ServerProfile
  extensionRegistry: ExtensionRegistryService
}) => {
  const resolved = params.extensionRegistry.getResolved()
  const extensionLayers = buildExtensionLayers(resolved)
  const parentService = <S>(tag: Context.Key<unknown, S>): S =>
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    Context.get(params.parentServices as Context.Context<unknown>, tag)

  const storageLayer = Storage.MemoryWithSql()
  const eventStoreLayer = Layer.provide(EventStoreLive, storageLayer)
  const approvalLayer = ApprovalService.LiveAutoResolve
  const parentRuntimePlatformLayer = Layer.succeed(RuntimePlatform, parentService(RuntimePlatform))
  const parentFileSystemLayer = Layer.succeed(
    FileSystem.FileSystem,
    parentService(FileSystem.FileSystem),
  )
  const parentPathLayer = Layer.succeed(Path.Path, parentService(Path.Path))
  const parentProviderLayer = Layer.succeed(Provider, parentService(Provider))
  const parentConfigLayer = Layer.succeed(ConfigService, parentService(ConfigService))
  const promptPresenterLayer = Layer.provide(
    PromptPresenter.Live,
    Layer.mergeAll(
      approvalLayer,
      parentRuntimePlatformLayer,
      parentFileSystemLayer,
      parentPathLayer,
    ),
  )

  // Ephemeral child sessions are synthetic. Persist local events so the
  // child loop can complete, but do not run local extension reduction on
  // those synthetic session ids; mirrored parent observers handle the
  // subset of child events that should escape.
  const eventPublisherLayer = Layer.effect(
    EventPublisher,
    Effect.gen(function* () {
      const baseEventStore = yield* EventStore
      return EventPublisher.of({
        append: (event) => baseEventStore.append(event),
        deliver: (envelope) => baseEventStore.broadcast(envelope),
        publish: (event) => baseEventStore.publish(event),
        terminateSession: () => Effect.void,
      })
    }),
  ).pipe(Layer.provide(eventStoreLayer))
  const toolRunnerLayer = Layer.provideMerge(
    ToolRunner.Live,
    Layer.mergeAll(approvalLayer, extensionLayers, parentRuntimePlatformLayer),
  )
  const sessionRuntimeLayer = SessionRuntime.Live({
    baseSections: params.config.baseSections ?? [],
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        storageLayer,
        eventPublisherLayer,
        toolRunnerLayer,
        ResourceManagerLive,
        extensionLayers,
        parentProviderLayer,
        parentConfigLayer,
      ),
    ),
  )
  // withOverrides maps each named field to ALL Tags that should be omitted
  // from the parent (e.g., storage → Storage + 6 sub-Tags). This makes
  // the sub-Tag problem structural — adding a new sub-Tag updates one
  // mapping in the compositor, not every callsite.
  const composed = RuntimeComposer.ephemeral({
    parent: params.parentProfile,
    parentServices: params.parentServices,
  })
    .withOverrides({
      storage: storageLayer,
      eventStore: eventStoreLayer,
      eventPublisher: eventPublisherLayer,
      approval: approvalLayer,
      promptPresenter: promptPresenterLayer,
      resourceManager: ResourceManagerLive,
      toolRunner: toolRunnerLayer,
      sessionRuntime: sessionRuntimeLayer,
    })
    .merge(extensionLayers)
    .build()

  return composed.layer
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
  parentProfile: ServerProfile
  parentSessionId: SessionId
  parentBranchId: BranchId
  toolCallId?: ToolCallId
  cwd: string
  agentName: string
  prompt: string
  runSpec?: RunSpec
  persistence: AgentPersistence
  parentBaseEventStore: EventStoreService
  notifyMirroredEventObservers: (event: AgentEvent) => Effect.Effect<void>
}) => {
  const sessionId = SessionId.make(Bun.randomUUIDv7())
  const branchId = BranchId.make(Bun.randomUUIDv7())
  const normalizedRunSpec = params.runSpec
  // The composer derives the parent-omit set from its `.own(...)`
  // declarations — the 14-item hand-maintained list is gone; adding a new
  // owned service requires editing only one place (`buildEphemeralLayer`).
  const ephemeralLayer = buildEphemeralLayer({
    config: params.runnerConfig,
    parentServices: params.parentServices,
    parentProfile: params.parentProfile,
    extensionRegistry: params.extensionRegistry,
  })

  const runWithTimeout = <R>(effect: Effect.Effect<void, AgentRunError, R>) =>
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

  const childRun = Effect.gen(function* () {
    const localStorage = yield* Storage
    const localEventStore = yield* EventStore
    const localEventPublisher = yield* EventPublisher
    const sessionRuntime = yield* SessionRuntime
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
      AgentSwitched.make({
        sessionId,
        branchId,
        fromAgent: DEFAULT_AGENT_NAME,
        toAgent: params.agentName,
      }),
    )

    return yield* Effect.gen(function* () {
      const runSpec: RunSpec | undefined =
        params.toolCallId !== undefined
          ? { ...(normalizedRunSpec ?? {}), parentToolCallId: params.toolCallId }
          : normalizedRunSpec
      yield* runWithTimeout(
        sessionRuntime.runPrompt({
          sessionId,
          branchId,
          agentName: params.agentName,
          prompt: params.prompt,
          interactive: false,
          ...(runSpec !== undefined ? { runSpec } : {}),
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
  })

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

    // Ephemeral child run is its own composition root — provide the per-run
    // layer (in-memory storage, auto-resolve approval, fresh SessionRuntime) and
    // wrap in `Effect.scoped` so the layer's resources release deterministically
    // when the child finishes/interrupts.
    //
    // `RuntimeComposer.build()` already wraps the merged layer in
    // `Layer.fresh` and strips `Layer.CurrentMemoMap` from the forwarded
    // parent context, so child-local layers are constructed against the
    // ephemeral dependencies instead of being reused from the parent's
    // memo map.
    const result = yield* runWithBuiltLayer(ephemeralLayer)(childRun).pipe(Effect.scoped)

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
  | Storage
  | EventStore
  | EventPublisher
  | SessionRuntime
  | ExtensionRegistry
  | Provider
  | ServerProfileService
> =>
  Layer.effect(
    AgentRunnerService,
    Effect.gen(function* () {
      const storage = yield* Storage
      const baseEventStore = yield* EventStore
      const eventPublisher = yield* EventPublisher
      const sessionRuntime = yield* SessionRuntime
      const extensionRegistry = yield* ExtensionRegistry
      const busOpt = yield* Effect.serviceOption(SubscriptionEngine)
      // Server-scoped parent profile — type-level proof of origin for the
      // composer's `RuntimeComposer.ephemeral({ parent, ... })` call below.
      const parentProfile = yield* ServerProfileService

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
          AgentSwitched.make({
            sessionId: params.sessionId,
            branchId: params.branchId,
            fromAgent: DEFAULT_AGENT_NAME,
            toAgent: params.agentName,
          }),
        )

      const runWithTimeout = <R>(effect: Effect.Effect<void, AgentRunError, R>) =>
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
          const persistence = resolveRunPersistence(params.runSpec)
          const normalizedRunSpec = normalizeRunSpec(params.runSpec)
          const toolCallId = params.runSpec?.parentToolCallId

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
              parentProfile,
              parentSessionId: params.parentSessionId,
              parentBranchId: params.parentBranchId,
              toolCallId,
              cwd: params.cwd,
              agentName: params.agent.name,
              prompt: params.prompt,
              runSpec: normalizedRunSpec,
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
                  toolCallId,
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

                const durableRunSpec: RunSpec | undefined =
                  toolCallId !== undefined
                    ? { ...(normalizedRunSpec ?? {}), parentToolCallId: toolCallId }
                    : normalizedRunSpec
                yield* runWithTimeout(
                  sessionRuntime.runPrompt({
                    sessionId,
                    branchId,
                    agentName: params.agent.name,
                    prompt: params.prompt,
                    interactive: false,
                    ...(durableRunSpec !== undefined ? { runSpec: durableRunSpec } : {}),
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
                  toolCallId,
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
                  toolCallId,
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
  Storage | EventStore | EventPublisher | ExtensionRegistry | Provider | ServerProfileService
> =>
  Layer.effect(
    AgentRunnerService,
    Effect.gen(function* () {
      const storage = yield* Storage
      const baseEventStore = yield* EventStore
      const eventPublisher = yield* EventPublisher
      const extensionRegistry = yield* ExtensionRegistry
      const busOpt = yield* Effect.serviceOption(SubscriptionEngine)
      // Server-scoped parent profile — type-level proof of origin for the
      // composer's `RuntimeComposer.ephemeral({ parent, ... })` call below.
      const parentProfile = yield* ServerProfileService

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
          const persistence = resolveRunPersistence(params.runSpec)
          const toolCallId = params.runSpec?.parentToolCallId
          if (persistence === "ephemeral") {
            return runEphemeralAgent({
              runnerConfig: config,
              shared,
              extensionRegistry,
              parentServices,
              parentProfile,
              parentSessionId: params.parentSessionId,
              parentBranchId: params.parentBranchId,
              toolCallId,
              cwd: params.cwd,
              agentName: params.agent.name,
              prompt: params.prompt,
              runSpec: params.runSpec,
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
                  toolCallId,
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
                // Merge parentToolCallId into runSpec for subprocess
                const subprocessRunSpec: RunSpec | undefined =
                  toolCallId !== undefined
                    ? { ...(params.runSpec ?? {}), parentToolCallId: toolCallId }
                    : params.runSpec
                const runSpecJson =
                  subprocessRunSpec !== undefined
                    ? Schema.encodeSync(Schema.fromJsonString(RunSpecSchema))(subprocessRunSpec)
                    : undefined
                const args = [
                  binary,
                  "--headless",
                  "--session",
                  sessionId,
                  ...(config.sharedServerUrl !== undefined
                    ? ["--connect", config.sharedServerUrl]
                    : []),
                  ...(runSpecJson !== undefined ? ["--run-spec", runSpecJson] : []),
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
                    Bun.spawn(args, {
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
                    toolCallId,
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
                  toolCallId,
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
                  toolCallId,
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
