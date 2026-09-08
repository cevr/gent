import {
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Scope,
  Stream,
} from "effect"
import {
  AgentRunError,
  AgentRunResult,
  DEFAULT_AGENT_NAME,
  makeRunSpec,
  type AgentName,
  type AgentPersistence,
  type RunSpec,
} from "../../domain/agent.js"
import {
  AgentSwitched,
  EventStore,
  StreamEnded,
  StreamStarted,
  ToolCallFailed,
  ToolCallStarted,
  ToolCallSucceeded,
  type AgentEvent,
  type EventEnvelope,
  type EventStoreService,
} from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import type { BranchId, SessionId, ToolCallId } from "../../domain/ids.js"
import { Branch, type Message, Session } from "../../domain/message.js"
import { BranchStorage } from "../../storage/branch-storage.js"
import { EventStorage } from "../../storage/event-storage.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { SessionStorage } from "../../storage/session-storage.js"
import type { ExtensionRegistryService } from "../extensions/registry.js"
import { SessionRuntime } from "../session-runtime.js"
import { agentRunBoundary, WideEvent, withWideEvent } from "../wide-event-boundary"
import type { AgentRunnerConfig } from "./agent-runner.config.js"
import { type DurableAgentRunRuntime } from "./agent-runner.durable.js"
import { loadAgentRunSuccessData, type AgentRunMetadataRuntime } from "./agent-runner.metadata.js"
import { handleAgentRunFailure } from "./agent-runner.run-spec.js"
import { EphemeralAgentRootLayerFactoryService } from "./ephemeral-root.js"

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
        usage: event.usage,
        interrupted: event.interrupted,
      })
    case "ToolCallStarted":
      return ToolCallStarted.make({
        sessionId: parentSessionId,
        branchId: parentBranchId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        parentToolCallId: event.parentToolCallId,
        assistantMessageId: event.assistantMessageId,
      })
    case "ToolCallSucceeded":
      return ToolCallSucceeded.make({
        sessionId: parentSessionId,
        branchId: parentBranchId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        summary: event.summary,
        output: event.output,
        resultJson: event.resultJson,
        parentToolCallId: event.parentToolCallId,
        assistantMessageId: event.assistantMessageId,
      })
    case "ToolCallFailed":
      return ToolCallFailed.make({
        sessionId: parentSessionId,
        branchId: parentBranchId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        summary: event.summary,
        output: event.output,
        resultJson: event.resultJson,
        parentToolCallId: event.parentToolCallId,
        assistantMessageId: event.assistantMessageId,
      })
    default:
      return event
  }
}

export const runEphemeralAgent = (params: {
  runnerConfig: AgentRunnerConfig
  durableRuntime: DurableAgentRunRuntime
  metadataRuntime: AgentRunMetadataRuntime
  parentSessionId: SessionId
  parentBranchId: BranchId
  toolCallId?: ToolCallId
  cwd: string
  agentName: AgentName
  prompt: string
  runSpec?: RunSpec
  /** Parent branch history copied into the child before its prompt; empty for a fresh start. */
  seedMessages: ReadonlyArray<Message>
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
  const timeoutMs = Option.fromUndefinedOr(params.runnerConfig.timeoutMs)
  const runWithTimeout = <R>(effect: Effect.Effect<void, AgentRunError, R>) =>
    timeoutMs.pipe(
      Option.match({
        onNone: () => effect,
        onSome: (timeout) =>
          effect.pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(timeout),
              orElse: () =>
                Effect.fail(
                  new AgentRunError({
                    message: `Agent run timed out after ${timeout}ms`,
                  }),
                ),
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
    const localMessageStorage = yield* MessageStorage
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
    // The child's storage is its own, so the parent's message ids stay valid here.
    yield* Effect.forEach(
      params.seedMessages,
      (message) => localMessageStorage.createMessage({ ...message, sessionId, branchId }),
      { discard: true },
    )

    const mirrorEnvelope = (envelope: EventEnvelope) =>
      Ref.modify(mirroredEnvelopeIds, (current) => {
        if (current.has(envelope.id)) return [false, current]
        const next = new Set(current)
        next.add(envelope.id)
        return [true, next]
      }).pipe(
        Effect.flatMap((shouldMirror) => {
          if (!shouldMirror) return Effect.void
          return Effect.sync(() =>
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
        }),
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
      const runSpec = Option.fromUndefinedOr(params.toolCallId).pipe(
        Option.match({
          onNone: () => Option.fromUndefinedOr(normalizedRunSpec),
          onSome: (parentToolCallId) =>
            Option.some(
              makeRunSpec({
                persistence: normalizedRunSpec?.persistence,
                overrides: normalizedRunSpec?.overrides,
                tags: normalizedRunSpec?.tags,
                parentToolCallId,
              }),
            ),
        }),
      )
      yield* runWithTimeout(
        sessionRuntime.runPrompt({
          sessionId,
          branchId,
          agentName: params.agentName,
          prompt: params.prompt,
          interactive: false,
          runSpec: Option.getOrUndefined(runSpec),
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
    const makeEphemeralAgentRootLayer = yield* EphemeralAgentRootLayerFactoryService
    const ephemeralLayer = makeEphemeralAgentRootLayer({
      config: params.runnerConfig,
      extensionRegistry: params.extensionRegistry,
    })

    yield* WideEvent.set({ childSessionId: sessionId })

    yield* params.durableRuntime.publishAgentRunSpawned({
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
    // Build the ephemeral layer into a fresh scope, then run childRun under
    // that context alone. The child is its own composition root: the caller's
    // fiber context carries per-operation services of the parent turn (the
    // current cell operation, the parent's entity address), and merging it in
    // would make the child's cell refuse to run as a nested outer cell.
    const { success, reasoning } = yield* Effect.gen(function* () {
      const scope = yield* Scope.Scope
      // The layer build captures the fiber context for actor handler builds,
      // so it runs under an empty context as well.
      const ephemeralContext = yield* Layer.buildWithScope(ephemeralLayer, scope).pipe(
        Effect.updateContext((_: Context.Context<never>) => Context.empty()),
      )
      return yield* childRun.pipe(
        Effect.updateContext((_: Context.Context<never>) => ephemeralContext),
      )
    }).pipe(Effect.scoped)

    // Save full output to disk (runs in parent context where FileSystem is available)
    const savedPath = yield* params.metadataRuntime.saveAgentRunOutput({
      text: success.text,
      reasoning,
      agentName: params.agentName,
      sessionId,
    })

    let preview = success.text
    if (success.text.length > 200) preview = success.text.slice(0, 200) + "…"

    yield* params.durableRuntime.publishAgentRunSucceeded({
      parentSessionId: params.parentSessionId,
      parentBranchId: params.parentBranchId,
      toolCallId: params.toolCallId,
      sessionId,
      agentName: params.agentName,
      usage: success.usage,
      preview,
      savedPath: Option.getOrUndefined(savedPath),
    })

    yield* WideEvent.set({
      usage: success.usage,
      toolCallCount: success.toolCalls?.length ?? 0,
    })

    return AgentRunResult.cases.success.make({
      ...success,
      savedPath: Option.getOrUndefined(savedPath),
    })
  }).pipe(withWideEvent(agentRunBoundary(params.agentName, params.parentSessionId)))

  return run.pipe(
    handleAgentRunFailure(
      {
        parentSessionId: params.parentSessionId,
        parentBranchId: params.parentBranchId,
        toolCallId: params.toolCallId,
        sessionId,
        agentName: params.agentName,
        persistence: params.persistence,
        spanName: "AgentRunner.inProcess.ephemeral",
      },
      params.durableRuntime.publishAgentRunFailed,
    ),
    Effect.catchCause(handleUnexpectedFailure),
  )
}
