import {
  Cause,
  type Context,
  DateTime,
  Duration,
  Effect,
  Fiber,
  Layer,
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
import { Branch, Session } from "../../domain/message.js"
import { BranchStorage } from "../../storage/branch-storage.js"
import { EventStorage } from "../../storage/event-storage.js"
import { SessionStorage } from "../../storage/session-storage.js"
import type { ExtensionRegistryService } from "../extensions/registry.js"
import { SessionRuntime } from "../session-runtime.js"
import { agentRunBoundary, WideEvent, withWideEvent } from "../wide-event-boundary"
import type { AgentRunnerConfig } from "./agent-runner.config.js"
import {
  publishAgentRunFailed,
  publishAgentRunSpawned,
  publishAgentRunSucceeded,
} from "./agent-runner.durable.js"
import { loadAgentRunSuccessData, saveAgentRunOutput } from "./agent-runner.metadata.js"
import { handleAgentRunFailure } from "./agent-runner.run-spec.js"
import { makeEphemeralAgentRootLayer, type EphemeralParentServices } from "./ephemeral-root.js"

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

export const runEphemeralAgent = (params: {
  runnerConfig: AgentRunnerConfig
  parentServices: Context.Context<EphemeralParentServices>
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
      publishAgentRunFailed,
    ),
    Effect.catchCause(handleUnexpectedFailure),
  )
}
