import {
  Cause,
  type Context,
  DateTime,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  type Path,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import type { SqlClient } from "effect/unstable/sql"
import { runProcess } from "../../utils/run-process.js"
import { withWideEvent, WideEvent, agentRunBoundary } from "../wide-event-boundary"
import {
  AgentSwitched,
  AgentRunSucceeded,
  AgentRunFailed,
  AgentRunSpawned,
  EventStore,
  StreamEnded,
  StreamStarted,
  ToolCallFailed,
  ToolCallStarted,
  ToolCallSucceeded,
  type AgentEvent,
  type EventStoreService,
  type EventEnvelope,
} from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import {
  DEFAULT_MAX_AGENT_RUN_DEPTH,
  AgentRunError,
  AgentRunnerService,
  AgentRunResult,
  DEFAULT_AGENT_NAME,
  makeRunSpec,
  resolveRunPersistence,
  type AgentName,
  type AgentRunToolCall,
  type AgentPersistence,
  type RunSpec,
  RunSpecSchema,
} from "../../domain/agent.js"
import { Session, Branch, type Message } from "../../domain/message.js"
import {
  messagePartsReasoningLines,
  messagePartsTextLines,
} from "../../domain/message-part-projection.js"
import { SessionId, BranchId } from "../../domain/ids.js"
import type { ToolCallId } from "../../domain/ids.js"
import { SessionStorage } from "../../storage/session-storage.js"
import { BranchStorage } from "../../storage/branch-storage.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { EventStorage } from "../../storage/event-storage.js"
import { RelationshipStorage } from "../../storage/relationship-storage.js"
import { makeStorageTransaction } from "../../storage/sqlite-storage.js"
import { ExtensionRegistry, type ExtensionRegistryService } from "../extensions/registry.js"
import { GentPlatform } from "../gent-platform.js"
import { SessionRuntime } from "../session-runtime.js"
import type { ModelResolver } from "../../providers/model-resolver.js"
import type { RuntimeEnvironment } from "../runtime-environment.js"
import type { ConfigService } from "../config-service.js"
import type { ModelRegistry } from "../model-registry.js"
import type { PromptSection } from "../../domain/prompt.js"
import { makeEphemeralAgentRootLayer } from "./ephemeral-root.js"

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
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime internal owns erased generic boundary
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
    const text = messagePartsTextLines(msg.parts)[0] ?? ""
    const reasoning = messagePartsReasoningLines(msg.parts).join("\n")
    return { text, reasoning }
  }
  return { text: "", reasoning: "" }
}

const withAgentRunFailureHandling = <E, R, R2>(
  effect: Effect.Effect<AgentRunResult, E, R>,
  params: {
    parentSessionId: SessionId
    parentBranchId: BranchId
    toolCallId?: ToolCallId
    sessionId: SessionId
    agentName: AgentName
    persistence: AgentPersistence
    spanName: string
  },
  publishFailed: (params: {
    parentSessionId: SessionId
    parentBranchId: BranchId
    toolCallId?: ToolCallId
    sessionId: SessionId
    agentName: AgentName
  }) => Effect.Effect<void, never, R2>,
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
        return AgentRunResult.cases.error.make({
          error,
          sessionId: params.sessionId,
          agentName: params.agentName,
          persistence: params.persistence,
        })
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

const collectChildMetadata = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const eventStorage = yield* EventStorage
    return yield* eventStorage.listEvents({ sessionId }).pipe(
      Effect.map((envelopes) => {
        const state = createChildMetadataAccumulator()
        for (const env of envelopes) applyChildMetadataEnvelope(state, env)
        return finalizeChildMetadata(state)
      }),
      Effect.catchEager((e) =>
        Effect.logWarning("failed to collect agent-run metadata").pipe(
          Effect.annotateLogs({ error: String(e) }),
          Effect.as<ChildMetadata>({}),
        ),
      ),
    )
  })

const loadAgentRunSuccessData = (params: {
  branchId: BranchId
  sessionId: SessionId
  agentName: AgentName
  persistence: AgentPersistence
}) =>
  Effect.gen(function* () {
    const messageStorage = yield* MessageStorage
    const messages = yield* messageStorage.listMessages(params.branchId)
    const { text, reasoning } = latestAssistantContent(messages)
    const meta = yield* collectChildMetadata(params.sessionId)
    const success = AgentRunResult.cases.success.make({
      text: text.length > 0 ? text : reasoning,
      sessionId: params.sessionId,
      agentName: params.agentName,
      persistence: params.persistence,
      usage: meta.usage,
      toolCalls: meta.toolCalls,
    })
    return { success, reasoning }
  })

const saveAgentRunOutput = (result: {
  text: string
  reasoning: string
  agentName: AgentName
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
export const getSessionDepth = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const relationshipStorage = yield* RelationshipStorage
    return yield* relationshipStorage.getSessionAncestors(sessionId).pipe(
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
  })

const createDurableAgentRunSession = (params: {
  agent: { name: AgentName }
  prompt: string
  parentSessionId: SessionId
  parentBranchId: BranchId
  toolCallId?: ToolCallId
  cwd: string
}) =>
  Effect.gen(function* () {
    const sessionStorage = yield* SessionStorage
    const branchStorage = yield* BranchStorage
    const eventPublisher = yield* EventPublisher
    const platform = yield* GentPlatform
    const storageTransaction = yield* makeStorageTransaction

    const parentDepth = yield* getSessionDepth(params.parentSessionId)
    if (parentDepth >= DEFAULT_MAX_AGENT_RUN_DEPTH) {
      return yield* new AgentRunError({
        message: `Agent run depth limit reached (max ${DEFAULT_MAX_AGENT_RUN_DEPTH}). Cannot spawn "${params.agent.name}" — parent session is already at depth ${parentDepth}.`,
      })
    }

    const sessionId = SessionId.make(yield* platform.randomId)
    const branchId = BranchId.make(yield* platform.randomId)
    const now = yield* DateTime.nowAsDate

    const committed = yield* storageTransaction(
      Effect.gen(function* () {
        yield* sessionStorage.createSession(
          new Session({
            id: sessionId,
            name: `${params.agent.name}: ${params.prompt.slice(0, 60)}`,
            cwd: params.cwd,
            parentSessionId: params.parentSessionId,
            parentBranchId: params.parentBranchId,
            activeBranchId: branchId,
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* branchStorage.createBranch(
          new Branch({
            id: branchId,
            sessionId,
            createdAt: now,
          }),
        )
        const envelope = yield* eventPublisher.append(
          AgentRunSpawned.make({
            parentSessionId: params.parentSessionId,
            childSessionId: sessionId,
            agentName: params.agent.name,
            prompt: params.prompt,
            toolCallId: params.toolCallId,
            branchId: params.parentBranchId,
            childBranchId: branchId,
          }),
        )
        return { envelope }
      }),
    )
    yield* eventPublisher.deliver(committed.envelope)

    return { sessionId, branchId }
  })

const publishAgentRunSpawned = (params: {
  parentSessionId: SessionId
  parentBranchId: BranchId
  toolCallId?: ToolCallId
  sessionId: SessionId
  childBranchId: BranchId
  agentName: AgentName
  prompt: string
}) =>
  Effect.gen(function* () {
    const eventPublisher = yield* EventPublisher
    yield* eventPublisher.publish(
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
  })

const publishAgentRunSucceeded = (params: {
  parentSessionId: SessionId
  parentBranchId: BranchId
  toolCallId?: ToolCallId
  sessionId: SessionId
  agentName: AgentName
  usage?: { input: number; output: number; cost?: number }
  preview?: string
  savedPath?: string
}) =>
  Effect.gen(function* () {
    const eventPublisher = yield* EventPublisher
    yield* eventPublisher.publish(
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
  })

const publishAgentRunFailed = (params: {
  parentSessionId: SessionId
  parentBranchId: BranchId
  toolCallId?: ToolCallId
  sessionId: SessionId
  agentName: AgentName
}) =>
  Effect.gen(function* () {
    const eventPublisher = yield* EventPublisher
    yield* eventPublisher
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
  })

const reparentEphemeralChildEvent = (
  event: AgentEvent,
  parentSessionId: SessionId,
  parentBranchId: BranchId,
): AgentEvent => {
  switch (event._tag) {
    case "StreamStarted":
      return StreamStarted.make({ sessionId: parentSessionId, branchId: parentBranchId })
    case "StreamEnded":
      return StreamEnded.make({
        sessionId: parentSessionId,
        branchId: parentBranchId,
        ...(event.usage !== undefined ? { usage: event.usage } : {}),
        ...(event.interrupted !== undefined ? { interrupted: event.interrupted } : {}),
      })
    case "ToolCallStarted":
      return ToolCallStarted.make({
        sessionId: parentSessionId,
        branchId: parentBranchId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(event.input !== undefined ? { input: event.input } : {}),
      })
    case "ToolCallSucceeded":
      return ToolCallSucceeded.make({
        sessionId: parentSessionId,
        branchId: parentBranchId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
        ...(event.output !== undefined ? { output: event.output } : {}),
      })
    case "ToolCallFailed":
      return ToolCallFailed.make({
        sessionId: parentSessionId,
        branchId: parentBranchId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
        ...(event.output !== undefined ? { output: event.output } : {}),
      })
    default:
      return event
  }
}

const runEphemeralAgent = (params: {
  runnerConfig: AgentRunnerConfig
  parentServices: Context.Context<never>
  parentSessionId: SessionId
  parentBranchId: BranchId
  toolCallId?: ToolCallId
  cwd: string
  agentName: AgentName
  prompt: string
  runSpec?: RunSpec
  persistence: AgentPersistence
  parentBaseEventStore: EventStoreService
  notifyMirroredEventObservers: (event: AgentEvent) => Effect.Effect<void>
  sessionId: SessionId
  branchId: BranchId
  extensionRegistry: ExtensionRegistryService
}) => {
  const { sessionId, branchId } = params
  const normalizedRunSpec = params.runSpec
  const mirroredChildEventTags = new Set<AgentEvent["_tag"]>([
    "StreamStarted",
    "StreamEnded",
    "ToolCallStarted",
    "ToolCallSucceeded",
    "ToolCallFailed",
  ])
  const ephemeralLayer = makeEphemeralAgentRootLayer({
    config: params.runnerConfig,
    parentServices: params.parentServices,
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
    return Effect.succeed(
      AgentRunResult.cases.error.make({
        error: Cause.pretty(cause),
        agentName: params.agentName,
        persistence: params.persistence,
      }),
    )
  }

  const childRun = Effect.gen(function* () {
    const localSessionStorage = yield* SessionStorage
    const localBranchStorage = yield* BranchStorage
    const localEventStorage = yield* EventStorage
    const localEventStore = yield* EventStore
    const localEventPublisher = yield* EventPublisher
    const sessionRuntime = yield* SessionRuntime
    const now = yield* DateTime.nowAsDate
    const mirroredEnvelopeIds = yield* Ref.make<ReadonlySet<EventEnvelope["id"]>>(new Set())

    yield* localSessionStorage.createSession(
      new Session({
        id: sessionId,
        name: `${params.agentName}: ${params.prompt.slice(0, 60)}`,
        cwd: params.cwd,
        createdAt: now,
        updatedAt: now,
      }),
    )
    yield* localBranchStorage.createBranch(
      new Branch({
        id: branchId,
        sessionId,
        createdAt: now,
      }),
    )

    const mirrorEnvelope = (envelope: EventEnvelope) =>
      Ref.modify(mirroredEnvelopeIds, (current) => {
        if (current.has(envelope.id)) return [false, current] as const
        const next = new Set(current)
        next.add(envelope.id)
        return [true, next] as const
      }).pipe(
        Effect.flatMap((shouldMirror) =>
          shouldMirror
            ? Effect.sync(() =>
                reparentEphemeralChildEvent(
                  envelope.event,
                  params.parentSessionId,
                  params.parentBranchId,
                ),
              ).pipe(
                Effect.flatMap((event) =>
                  params.parentBaseEventStore
                    .publish(event)
                    .pipe(Effect.tap(() => params.notifyMirroredEventObservers(event))),
                ),
                Effect.catchEager(() => Effect.void),
              )
            : Effect.void,
        ),
      )

    const mirrorFiber = yield* Effect.forkChild(
      localEventStore.subscribe({ sessionId }).pipe(
        Stream.filter((envelope) => mirroredChildEventTags.has(envelope.event._tag)),
        Stream.runForEach(mirrorEnvelope),
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
          ? makeRunSpec({
              persistence: normalizedRunSpec?.persistence,
              overrides: normalizedRunSpec?.overrides,
              tags: normalizedRunSpec?.tags,
              parentToolCallId: params.toolCallId,
            })
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

      const result = yield* loadAgentRunSuccessData({
        branchId,
        sessionId,
        agentName: params.agentName,
        persistence: params.persistence,
      })
      const persistedEvents = yield* localEventStorage.listEvents({ sessionId })
      yield* Effect.forEach(
        persistedEvents.filter((envelope) => mirroredChildEventTags.has(envelope.event._tag)),
        mirrorEnvelope,
        { discard: true },
      )
      return result
    }).pipe(Effect.ensuring(Fiber.interrupt(mirrorFiber)))
  })

  const run = Effect.gen(function* () {
    yield* WideEvent.set({ childSessionId: sessionId })

    yield* publishAgentRunSpawned({
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
    // `makeEphemeralAgentRootLayer()` wraps the merged layer in `Layer.fresh` so the
    // child gets its own memo map; otherwise the parent runtime's memo could
    // alias child-owned in-memory storage.
    // Build the ephemeral layer into a fresh scope, then provide its context
    // to childRun. Equivalent to Effect.provide(ephemeralLayer) + scoped, but
    // built explicitly so layer lifetime stays visible at the call site.
    const { success, reasoning } = yield* Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const ephemeralContext = yield* Layer.buildWithScope(ephemeralLayer, scope)
      return yield* childRun.pipe(Effect.provideContext(ephemeralContext))
    }).pipe(Effect.scoped)

    // Save full output to disk (runs in parent context where FileSystem is available)
    const savedPath = yield* saveAgentRunOutput({
      text: success.text,
      reasoning,
      agentName: params.agentName,
      sessionId,
    })

    const preview = success.text.length > 200 ? success.text.slice(0, 200) + "…" : success.text

    yield* publishAgentRunSucceeded({
      parentSessionId: params.parentSessionId,
      parentBranchId: params.parentBranchId,
      toolCallId: params.toolCallId,
      sessionId,
      agentName: params.agentName,
      usage: success.usage,
      preview,
      savedPath,
    })

    yield* WideEvent.set({
      usage: success.usage,
      toolCallCount: success.toolCalls?.length ?? 0,
    })

    return AgentRunResult.cases.success.make({
      ...success,
      savedPath,
    })
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
    publishAgentRunFailed,
  ).pipe(Effect.catchCause(handleUnexpectedFailure))
}

export const InProcessRunner = (
  runnerConfig: AgentRunnerConfig,
): Layer.Layer<
  AgentRunnerService,
  never,
  | SessionStorage
  | BranchStorage
  | MessageStorage
  | EventStorage
  | RelationshipStorage
  | SqlClient.SqlClient
  | EventStore
  | EventPublisher
  | SessionRuntime
  | ExtensionRegistry
  | ModelResolver
  | RuntimeEnvironment
  | FileSystem.FileSystem
  | Path.Path
  | ConfigService
  | ModelRegistry
  | ChildProcessSpawner.ChildProcessSpawner
  | GentPlatform
> =>
  Layer.effect(
    AgentRunnerService,
    Effect.gen(function* () {
      const baseEventStore = yield* EventStore
      const eventPublisher = yield* EventPublisher
      const sessionRuntime = yield* SessionRuntime
      const extensionRegistry = yield* ExtensionRegistry

      // Snapshot layer-build context so the `run` method can resolve Tags
      // that helpers yield inside (createDurableAgentRunSession,
      // loadAgentRunSuccessData, publishAgentRunSucceeded, publishAgentRunFailed).
      // Without this snapshot, helper requirements leak through the returned
      // Effect and break the `AgentRunner` interface contract.
      const runtimeContext = yield* Effect.context<
        | SessionStorage
        | BranchStorage
        | MessageStorage
        | EventStorage
        | RelationshipStorage
        | SqlClient.SqlClient
        | EventPublisher
        | GentPlatform
        | FileSystem.FileSystem
      >()
      const parentServices = yield* Effect.context<never>()

      const platform = yield* GentPlatform
      const notifyMirroredEventObservers = (_event: AgentEvent) => Effect.void
      const publishAgentSwitch = (params: {
        sessionId: SessionId
        branchId: BranchId
        agentName: AgentName
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
            return Effect.succeed(
              AgentRunResult.cases.error.make({
                error: Cause.pretty(cause),
                agentName: params.agent.name,
                persistence,
              }),
            )
          }

          if (persistence === "ephemeral") {
            return Effect.gen(function* () {
              const sessionId = SessionId.make(yield* platform.randomId)
              const branchId = BranchId.make(yield* platform.randomId)
              return yield* runEphemeralAgent({
                runnerConfig,
                parentServices,
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
                sessionId,
                branchId,
                extensionRegistry,
              })
            }).pipe(Effect.provideContext(runtimeContext))
          }

          return createDurableAgentRunSession({ ...params, toolCallId })
            .pipe(
              Effect.flatMap(({ sessionId, branchId }) => {
                const run = Effect.gen(function* () {
                  yield* WideEvent.set({ childSessionId: sessionId })

                  yield* publishAgentSwitch({
                    sessionId,
                    branchId,
                    agentName: params.agent.name,
                  })

                  const durableRunSpec: RunSpec | undefined =
                    toolCallId !== undefined
                      ? makeRunSpec({
                          persistence: normalizedRunSpec?.persistence,
                          overrides: normalizedRunSpec?.overrides,
                          tags: normalizedRunSpec?.tags,
                          parentToolCallId: toolCallId,
                        })
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

                  const { success, reasoning } = yield* loadAgentRunSuccessData({
                    branchId,
                    sessionId,
                    agentName: params.agent.name,
                    persistence,
                  })
                  const savedPath = yield* saveAgentRunOutput({
                    text: success.text,
                    reasoning,
                    agentName: params.agent.name,
                    sessionId,
                  })
                  const preview =
                    success.text.length > 200 ? success.text.slice(0, 200) + "…" : success.text
                  yield* publishAgentRunSucceeded({
                    parentSessionId: params.parentSessionId,
                    parentBranchId: params.parentBranchId,
                    toolCallId,
                    sessionId,
                    agentName: params.agent.name,
                    usage: success.usage,
                    preview,
                    savedPath,
                  })

                  yield* WideEvent.set({
                    usage: success.usage,
                    toolCallCount: success.toolCalls?.length ?? 0,
                  })

                  return AgentRunResult.cases.success.make({ ...success, savedPath })
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
                  publishAgentRunFailed,
                )
              }),
              Effect.catchCause(handleUnexpectedFailure),
            )
            .pipe(Effect.provideContext(runtimeContext))
        },
      }
    }),
  )

export const SubprocessRunner = (
  config: AgentRunnerConfig,
): Layer.Layer<
  AgentRunnerService,
  never,
  | SessionStorage
  | BranchStorage
  | MessageStorage
  | EventStorage
  | RelationshipStorage
  | SqlClient.SqlClient
  | EventStore
  | EventPublisher
  | ExtensionRegistry
  | ModelResolver
  | RuntimeEnvironment
  | FileSystem.FileSystem
  | Path.Path
  | ConfigService
  | ModelRegistry
  | ChildProcessSpawner.ChildProcessSpawner
  | GentPlatform
> =>
  Layer.effect(
    AgentRunnerService,
    Effect.gen(function* () {
      const baseEventStore = yield* EventStore
      const extensionRegistry = yield* ExtensionRegistry
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      // Snapshot layer-build context so the `run` method can resolve Tags that
      // helpers yield inside. Without this, helper requirements leak into the
      // `run` method's R-channel and break the `AgentRunner` interface.
      const runtimeContext = yield* Effect.context<
        | SessionStorage
        | BranchStorage
        | MessageStorage
        | EventStorage
        | RelationshipStorage
        | SqlClient.SqlClient
        | EventPublisher
        | GentPlatform
        | FileSystem.FileSystem
      >()
      const parentServices = yield* Effect.context<never>()

      const platform = yield* GentPlatform
      const notifyMirroredEventObservers = (_event: AgentEvent) => Effect.void

      return {
        run: (params) => {
          const persistence = resolveRunPersistence(params.runSpec)
          const toolCallId = params.runSpec?.parentToolCallId
          if (persistence === "ephemeral") {
            return Effect.gen(function* () {
              const sessionId = SessionId.make(yield* platform.randomId)
              const branchId = BranchId.make(yield* platform.randomId)
              return yield* runEphemeralAgent({
                runnerConfig: config,
                parentServices,
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
                sessionId,
                branchId,
                extensionRegistry,
              })
            }).pipe(Effect.provideContext(runtimeContext))
          }

          return createDurableAgentRunSession({ ...params, toolCallId }).pipe(
            Effect.flatMap(({ sessionId, branchId }) => {
              const run = Effect.gen(function* () {
                yield* WideEvent.set({ childSessionId: sessionId })

                // Capture trace context for subprocess propagation
                const currentSpan = yield* Effect.currentParentSpan.pipe(
                  Effect.orElseSucceed(() => undefined),
                )

                const binary = config.subprocessBinaryPath ?? "gent"
                // Merge parentToolCallId into runSpec for subprocess
                const subprocessRunSpec: RunSpec | undefined =
                  toolCallId !== undefined
                    ? makeRunSpec({
                        persistence: params.runSpec?.persistence,
                        overrides: params.runSpec?.overrides,
                        tags: params.runSpec?.tags,
                        parentToolCallId: toolCallId,
                      })
                    : params.runSpec
                const runSpecJson =
                  subprocessRunSpec !== undefined
                    ? yield* Schema.encodeEffect(Schema.fromJsonString(RunSpecSchema))(
                        subprocessRunSpec,
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
                  ...(runSpecJson !== undefined ? ["--run-spec", runSpecJson] : []),
                  params.prompt,
                ]

                const parentEnv = yield* platform.env
                const env: Record<string, string | undefined> = {
                  ...parentEnv,
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
                }

                const [exitCode, stderrText] = yield* runProcess(binary, args.slice(1), {
                  cwd: params.cwd,
                  env,
                  stdout: "pipe",
                  stderr: "pipe",
                }).pipe(
                  Effect.map(
                    (result) => [result.exitCode, result.stderr] as readonly [number, string],
                  ),
                  Effect.catchTag("ProcessError", () =>
                    Effect.succeed([1, "Subprocess failed"] as readonly [number, string]),
                  ),
                  Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                )

                if (exitCode !== 0) {
                  yield* publishAgentRunFailed({
                    parentSessionId: params.parentSessionId,
                    parentBranchId: params.parentBranchId,
                    toolCallId,
                    sessionId,
                    agentName: params.agent.name,
                  })

                  return AgentRunResult.cases.error.make({
                    error:
                      stderrText.length > 0
                        ? stderrText.trim()
                        : `Subprocess exited with code ${exitCode}`,
                    sessionId,
                    agentName: params.agent.name,
                    persistence,
                  })
                }

                const { success, reasoning } = yield* loadAgentRunSuccessData({
                  branchId,
                  sessionId,
                  agentName: params.agent.name,
                  persistence,
                })
                const savedPath = yield* saveAgentRunOutput({
                  text: success.text,
                  reasoning,
                  agentName: params.agent.name,
                  sessionId,
                })
                const preview =
                  success.text.length > 200 ? success.text.slice(0, 200) + "…" : success.text
                yield* publishAgentRunSucceeded({
                  parentSessionId: params.parentSessionId,
                  parentBranchId: params.parentBranchId,
                  toolCallId,
                  sessionId,
                  agentName: params.agent.name,
                  usage: success.usage,
                  preview,
                  savedPath,
                })

                yield* WideEvent.set({
                  usage: success.usage,
                  toolCallCount: success.toolCalls?.length ?? 0,
                })

                return AgentRunResult.cases.success.make({ ...success, savedPath })
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
                publishAgentRunFailed,
              )
            }),
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
              return Effect.succeed(
                AgentRunResult.cases.error.make({
                  error: Cause.pretty(cause),
                  agentName: params.agent.name,
                  persistence,
                }),
              )
            }),
            Effect.provideContext(runtimeContext),
          )
        },
      }
    }),
  )
