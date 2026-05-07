import { describe, expect, test, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Clock, Deferred, Duration, Effect, Fiber, Layer, Ref, Schema, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"
import * as AiError from "effect/unstable/ai/AiError"
import {
  AgentLoop,
  type AgentLoopService,
  type SteerCommand,
} from "../../src/runtime/agent/agent-loop"
import {
  AgentLoop as AgentLoopActor,
  AgentLoopTestActor,
} from "../../src/runtime/agent/agent-loop.actor"
import { AgentLoopBehaviorDeps } from "../../src/runtime/agent/agent-loop.behavior-deps"
import { AgentLoopStateRegistry } from "../../src/runtime/agent/agent-loop.state-registry"
import { AgentLoopSessionGovernance } from "../../src/runtime/agent/agent-loop.session-governance"
import { entityIdOf } from "../../src/runtime/agent/agent-loop.entity-id"
import { ResourceManagerLive } from "../../src/runtime/resource-manager"
import { ModelRegistry } from "../../src/runtime/model-registry"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { resolveExtensions, ExtensionRegistry } from "../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import { RuntimePlatform } from "../../src/runtime/runtime-platform"
import { ConfigService } from "../../src/runtime/config-service"
import { ToolRunner } from "../../src/runtime/agent/tool-runner"
import {
  AgentDefinition,
  AgentName,
  ExternalDriverRef,
  type RunSpec,
} from "@gent/core/domain/agent"
import {
  modelResolverFromProvider,
  Provider,
  finishPart,
  reasoningDeltaPart,
  textDeltaPart,
  toolCallPart,
  type ProviderStreamPart,
} from "@gent/core/providers/provider"
import { textStep, toolCallStep } from "@gent/core/debug/provider"
import type { TextPart } from "@gent/core/domain/message"
import { dateFromMillis, Branch, Message, Session } from "@gent/core/domain/message"
import { AllBuiltinAgents } from "@gent/extensions/all-agents"
import { type ToolCapabilityContext } from "@gent/core/domain/capability/tool"
import {
  getToolId,
  tool,
  ToolNeeds,
  type AnyResourceContribution,
  type ToolToken,
} from "@gent/core/extensions/api"
import { Permission } from "@gent/core/domain/permission"
import {
  EventEnvelope,
  EventId,
  EventStore,
  EventStoreError,
  type AgentEvent,
} from "@gent/core/domain/event"
import { InteractionPendingError } from "@gent/core/domain/interaction-request"
import { ApprovalService } from "../../src/runtime/approval-service"
import { EventPublisher, EventPublisherLive } from "@gent/core/domain/event-publisher"
import { SqliteStorage } from "@gent/core/storage/sqlite-storage"
import { BranchStorage } from "@gent/core/storage/branch-storage"
import { EventStorage } from "@gent/core/storage/event-storage"
import { MessageStorage } from "@gent/core/storage/message-storage"
import { SessionStorage } from "@gent/core/storage/session-storage"
import { SequenceRecorder, RecordingEventStore, ensureStorageParents } from "@gent/core/test-utils"
import { emptyQueueSnapshot } from "@gent/core/domain/queue"
import {
  ActorCommandId,
  BranchId,
  ExtensionId,
  InteractionRequestId,
  MessageId,
  SessionId,
  ToolCallId,
} from "@gent/core/domain/ids"
import {
  assistantDraftFromMessage,
  assistantMessageIdForTurn,
  toolResultMessageIdForTurn,
} from "../../src/runtime/agent/agent-loop.utils"
import type { TurnStreamPart } from "@gent/core/domain/driver"
// ============================================================================
// Shared helpers
// ============================================================================

const makeExtRegistry = (
  tools: ReadonlyArray<ToolToken> = [],
  resources: AnyResourceContribution[] = [],
) => {
  const resolved = resolveExtensions([
    {
      manifest: { id: ExtensionId.make("agents") },
      scope: "builtin" as const,
      sourcePath: "test",
      contributions: {
        agents: AllBuiltinAgents,
        tools,
        resources,
      },
    },
  ])
  return Layer.merge(
    ExtensionRegistry.fromResolved(resolved),
    DriverRegistry.fromResolved({
      modelDrivers: resolved.modelDrivers,
      externalDrivers: resolved.externalDrivers,
    }),
  )
}
const makeMessage = (sessionId: string, branchId: string, text: string) =>
  Message.Regular.make({
    id: `${sessionId}-${branchId}-${text}`,
    sessionId,
    branchId,
    role: "user",
    parts: [Prompt.textPart({ text })],
    createdAt: dateFromMillis(1_767_225_600_000),
  })
const runAgentLoop = (
  _agentLoop: AgentLoopService,
  message: Message,
  options?: {
    readonly agentOverride?: AgentName
    readonly runSpec?: RunSpec
    readonly interactive?: boolean
  },
) =>
  ensureStorageParents({ sessionId: message.sessionId, branchId: message.branchId }).pipe(
    Effect.flatMap(() =>
      Effect.gen(function* () {
        const actorClientFactory = yield* AgentLoopActor.Context
        const ref = yield* actorClientFactory(entityIdOf(message.sessionId, message.branchId))
        yield* ref.execute(
          AgentLoopActor.Run.make({
            message,
            agentOverride: options?.agentOverride,
            runSpec: options?.runSpec,
            interactive: options?.interactive,
          }),
        )
      }),
    ),
  )
const submitAgentLoop = (
  _agentLoop: AgentLoopService,
  message: Message,
  options?: {
    readonly agentOverride?: AgentName
    readonly runSpec?: RunSpec
    readonly interactive?: boolean
  },
) =>
  ensureStorageParents({ sessionId: message.sessionId, branchId: message.branchId }).pipe(
    Effect.flatMap(() =>
      Effect.gen(function* () {
        const actorClientFactory = yield* AgentLoopActor.Context
        const ref = yield* actorClientFactory(entityIdOf(message.sessionId, message.branchId))
        yield* ref.execute(
          AgentLoopActor.Submit.make({
            message,
            agentOverride: options?.agentOverride,
            runSpec: options?.runSpec,
            interactive: options?.interactive,
          }),
        )
      }),
    ),
  )
const steerAgentLoop = (command: SteerCommand) =>
  Effect.gen(function* () {
    const platform = yield* GentPlatform
    const actorClientFactory = yield* AgentLoopActor.Context
    const ref = yield* actorClientFactory(entityIdOf(command.sessionId, command.branchId))
    yield* ref.execute(
      AgentLoopActor.Steer.make({
        commandId: ActorCommandId.make(yield* platform.randomId),
        command,
      }),
    )
  })
const respondAgentLoopInteraction = (input: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly requestId: InteractionRequestId
}) =>
  Effect.gen(function* () {
    const actorClientFactory = yield* AgentLoopActor.Context
    const ref = yield* actorClientFactory(entityIdOf(input.sessionId, input.branchId))
    yield* ref.execute(AgentLoopActor.RespondInteraction.make(input))
  })
const makeLayer = (
  providerLayer: Layer.Layer<Provider>,
  tools: ReadonlyArray<ToolToken> = [],
  resources: AnyResourceContribution[] = [],
) => {
  const deps = Layer.mergeAll(
    SqliteStorage.TestWithSql(),
    providerLayer,
    modelResolverFromProvider(providerLayer),
    makeExtRegistry(tools, resources),
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    EventStore.Memory,
    ToolRunner.Test(),
    BunServices.layer,
    ResourceManagerLive,
    ModelRegistry.Test(),
    GentPlatform.Test(),
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
  return AgentLoop.Live({ baseSections: [] }).pipe(
    Layer.provideMerge(
      AgentLoopTestActor.pipe(Layer.provide(AgentLoopBehaviorDeps.Live({ baseSections: [] }))),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        deps,
        eventPublisherLayer,
        AgentLoopStateRegistry.Live,
        AgentLoopSessionGovernance.Live,
      ),
    ),
  )
}
const makeRecordingLayer = (providerLayer: Layer.Layer<Provider>) => {
  const recorderLayer = SequenceRecorder.Live
  const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
  const deps = Layer.mergeAll(
    SqliteStorage.TestWithSql(),
    providerLayer,
    modelResolverFromProvider(providerLayer),
    makeExtRegistry(),
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    ToolRunner.Test(),
    BunServices.layer,
    ResourceManagerLive,
    ModelRegistry.Test(),
    GentPlatform.Test(),
    recorderLayer,
    eventStoreLayer,
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
  return AgentLoop.Live({ baseSections: [] }).pipe(
    Layer.provideMerge(
      AgentLoopTestActor.pipe(Layer.provide(AgentLoopBehaviorDeps.Live({ baseSections: [] }))),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        deps,
        eventPublisherLayer,
        AgentLoopStateRegistry.Live,
        AgentLoopSessionGovernance.Live,
      ),
    ),
  )
}
/** Scripted provider: returns stream parts from an array, one response per model stream call. */
const scriptedProvider = (
  responses: ReadonlyArray<ReadonlyArray<ProviderStreamPart>>,
): Layer.Layer<Provider> => {
  let index = 0
  return Provider.TestStream(() =>
    Effect.succeed(
      Stream.fromIterable(responses[index++] ?? [finishPart({ finishReason: "stop" })]),
    ),
  )
}
const retryableStreamError = () =>
  AiError.make({
    module: "Test",
    method: "streamText",
    reason: new AiError.RateLimitError({
      retryAfter: Duration.zero,
    }),
  })
const makeLiveToolLayer = (
  providerLayer: Layer.Layer<Provider>,
  tools: ReadonlyArray<ToolToken> = [],
  resources: AnyResourceContribution[] = [],
) => {
  const extRegistry = makeExtRegistry(tools, resources)
  const baseDeps = Layer.mergeAll(
    SqliteStorage.TestWithSql(),
    providerLayer,
    modelResolverFromProvider(providerLayer),
    extRegistry,
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    EventStore.Memory,
    ApprovalService.Test(),
    Permission.Live([], "allow"),
    BunServices.layer,
    ResourceManagerLive,
    ModelRegistry.Test(),
    GentPlatform.Test(),
  )
  const deps = Layer.mergeAll(baseDeps, Layer.provide(ToolRunner.Live, baseDeps))
  const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
  return AgentLoop.Live({ baseSections: [] }).pipe(
    Layer.provideMerge(
      AgentLoopTestActor.pipe(Layer.provide(AgentLoopBehaviorDeps.Live({ baseSections: [] }))),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        deps,
        eventPublisherLayer,
        AgentLoopStateRegistry.Live,
        AgentLoopSessionGovernance.Live,
      ),
    ),
  )
}
const makeCountingEventStore = (eventsRef: Ref.Ref<AgentEvent[]>) =>
  Layer.succeed(EventStore, {
    append: (event: AgentEvent) =>
      Effect.gen(function* () {
        yield* Ref.update(eventsRef, (events) => [...events, event])
        return EventEnvelope.make({
          id: EventId.make(0),
          event,
          createdAt: yield* Clock.currentTimeMillis,
        })
      }),
    broadcast: () => Effect.void,
    publish: (event: AgentEvent) => Ref.update(eventsRef, (events) => [...events, event]),
    subscribe: () => Stream.empty,
    removeSession: () => Effect.void,
  })
const makeLayerWithEvents = (
  providerLayer: Layer.Layer<Provider>,
  eventsRef: Ref.Ref<AgentEvent[]>,
  tools: ReadonlyArray<ToolToken> = [],
) => {
  const deps = Layer.mergeAll(
    SqliteStorage.TestWithSql(),
    providerLayer,
    modelResolverFromProvider(providerLayer),
    makeExtRegistry(tools),
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    makeCountingEventStore(eventsRef),
    ToolRunner.Test(),
    BunServices.layer,
    ResourceManagerLive,
    ModelRegistry.Test(),
    GentPlatform.Test(),
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
  return AgentLoop.Live({ baseSections: [] }).pipe(
    Layer.provideMerge(
      AgentLoopTestActor.pipe(Layer.provide(AgentLoopBehaviorDeps.Live({ baseSections: [] }))),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        deps,
        eventPublisherLayer,
        AgentLoopStateRegistry.Live,
        AgentLoopSessionGovernance.Live,
      ),
    ),
  )
}
const makeLayerWithEventPublisher = (
  providerLayer: Layer.Layer<Provider>,
  eventPublisherLayer: Layer.Layer<EventPublisher>,
) => {
  const deps = Layer.mergeAll(
    SqliteStorage.TestWithSql(),
    providerLayer,
    modelResolverFromProvider(providerLayer),
    makeExtRegistry(),
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    EventStore.Memory,
    ToolRunner.Test(),
    BunServices.layer,
    ResourceManagerLive,
    ModelRegistry.Test(),
    GentPlatform.Test(),
  )
  const providedEventPublisherLayer = Layer.provide(eventPublisherLayer, deps)
  return AgentLoop.Live({ baseSections: [] }).pipe(
    Layer.provideMerge(
      AgentLoopTestActor.pipe(Layer.provide(AgentLoopBehaviorDeps.Live({ baseSections: [] }))),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        deps,
        providedEventPublisherLayer,
        AgentLoopStateRegistry.Live,
        AgentLoopSessionGovernance.Live,
      ),
    ),
  )
}
const parityExternalAgent = AgentDefinition.make({
  name: "test-external-parity" as never,
  driver: ExternalDriverRef.make({ id: "test-parity-driver" }),
})
const makeExternalLayerWithEvents = (
  responseParts: ReadonlyArray<TurnStreamPart>,
  eventsRef: Ref.Ref<AgentEvent[]>,
) => {
  const resolved = resolveExtensions([
    {
      manifest: { id: ExtensionId.make("agents") },
      scope: "builtin" as const,
      sourcePath: "test",
      contributions: {
        agents: AllBuiltinAgents,
      },
    },
    {
      manifest: { id: ExtensionId.make("external-parity") },
      scope: "builtin" as const,
      sourcePath: "test",
      contributions: {
        agents: [parityExternalAgent],
        externalDrivers: [
          {
            id: "test-parity-driver",
            executor: {
              executeTurn: () => Stream.fromIterable(responseParts),
            },
            invalidate: () => Effect.void,
          },
        ],
      },
    },
  ])
  const registryLayer = Layer.merge(
    ExtensionRegistry.fromResolved(resolved),
    DriverRegistry.fromResolved({
      modelDrivers: resolved.modelDrivers,
      externalDrivers: resolved.externalDrivers,
    }),
  )
  const providerLayer = Provider.TestStream(() =>
    Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })])),
  )
  const deps = Layer.mergeAll(
    SqliteStorage.TestWithSql(),
    providerLayer,
    modelResolverFromProvider(providerLayer),
    registryLayer,
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    makeCountingEventStore(eventsRef),
    ToolRunner.Test(),
    BunServices.layer,
    ResourceManagerLive,
    ModelRegistry.Test(),
    GentPlatform.Test(),
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
  return AgentLoop.Live({ baseSections: [] }).pipe(
    Layer.provideMerge(
      AgentLoopTestActor.pipe(Layer.provide(AgentLoopBehaviorDeps.Live({ baseSections: [] }))),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        deps,
        eventPublisherLayer,
        AgentLoopStateRegistry.Live,
        AgentLoopSessionGovernance.Live,
      ),
    ),
  )
}
/** Poll `getState` until the phase matches, with a short sleep between attempts. */
const waitForPhase = (
  agentLoop: AgentLoopService,
  params: {
    sessionId: SessionId
    branchId: BranchId
  },
  runtimeTag: string,
  attempts = 50,
) =>
  Effect.gen(function* () {
    for (let i = 0; i < attempts; i++) {
      const state = yield* agentLoop.getState(params)
      if (state._tag === runtimeTag) return state
      yield* Effect.sleep("1 millis")
    }
    throw new Error(`Timed out waiting for runtime state "${runtimeTag}"`)
  })
// ============================================================================
// streaming
// ============================================================================
describe("run completion", () => {
  test("run returns after a fast turn completes before the caller awaits idle", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* Provider.Sequence([textStep("fast reply")])
      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const sessionId = SessionId.make("fast-run-session")
        const branchId = BranchId.make("fast-run-branch")
        yield* runAgentLoop(agentLoop, makeMessage(sessionId, branchId, "fast")).pipe(
          Effect.timeout("2 seconds"),
        )
        const state = yield* agentLoop.getState({ sessionId, branchId })
        expect(state._tag).toBe("Idle")
      }).pipe(Effect.provide(makeLayer(providerLayer)))
    }).pipe(Effect.runPromise))
})
describe("streaming", () => {
  it.live("concurrent sessions run independently", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
      let calls = 0
      const providerLayer = Provider.TestStream(() => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(gate)
                return finishPart({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => finishPart({ finishReason: "stop" }))),
          )
        }
        return Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })]))
      })
      const layer = makeLayer(providerLayer)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const messageA = makeMessage("s1", "b1", "hello")
          const messageB = makeMessage("s2", "b2", "world")
          const fiberA = yield* Effect.forkChild(runAgentLoop(agentLoop, messageA))
          yield* Deferred.await(firstStarted)
          const fiberB = yield* Effect.forkChild(runAgentLoop(agentLoop, messageB))
          const finishedB = yield* Fiber.join(fiberB).pipe(Effect.timeoutOption("200 millis"))
          expect(finishedB._tag).toBe("Some")
          const statusA = fiberA.pollUnsafe()
          expect(statusA).toBeUndefined()
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiberA)
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("same session/branch serializes loop creation", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
      let calls = 0
      const providerLayer = Provider.TestStream(() => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(gate)
                return finishPart({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => finishPart({ finishReason: "stop" }))),
          )
        }
        return Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })]))
      })
      const delayedEventStorage = Layer.effect(
        EventStorage,
        Effect.gen(function* () {
          const eventStorage = yield* EventStorage
          return {
            ...eventStorage,
            getLatestEvent: (input) =>
              eventStorage.getLatestEvent(input).pipe(Effect.delay("5 millis")),
          }
        }),
      )
      const baseStorageLayer = SqliteStorage.TestWithSql()
      const slowStorage = Layer.provideMerge(delayedEventStorage, baseStorageLayer)
      const deps = Layer.mergeAll(
        slowStorage,
        providerLayer,
        modelResolverFromProvider(providerLayer),
        makeExtRegistry(),
        RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        ConfigService.Test(),
        EventStore.Memory,
        ToolRunner.Test(),
        BunServices.layer,
        ResourceManagerLive,
        ModelRegistry.Test(),
        GentPlatform.Test(),
      )
      const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
      const layer = AgentLoop.Live({ baseSections: [] }).pipe(
        Layer.provideMerge(
          AgentLoopTestActor.pipe(Layer.provide(AgentLoopBehaviorDeps.Live({ baseSections: [] }))),
        ),
        Layer.provideMerge(
          Layer.mergeAll(
            deps,
            eventPublisherLayer,
            AgentLoopStateRegistry.Live,
            AgentLoopSessionGovernance.Live,
          ),
        ),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const fiberA = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeMessage("s1", "b1", "first")),
          )
          yield* Deferred.await(firstStarted)
          const fiberB = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeMessage("s1", "b1", "second")),
          )
          const queuedB = yield* Fiber.join(fiberB).pipe(Effect.timeoutOption("200 millis"))
          expect(queuedB._tag).toBe("Some")
          expect(calls).toBe(1)
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiberA)
          expect(calls).toBe(2)
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("interrupt scoped to session/branch", () =>
    Effect.gen(function* () {
      const gateA = yield* Deferred.make<void>()
      const gateB = yield* Deferred.make<void>()
      const startedA = yield* Deferred.make<void>()
      const startedB = yield* Deferred.make<void>()
      let calls = 0
      const providerLayer = Provider.TestStream(() => {
        calls += 1
        const gate = calls === 1 ? gateA : gateB
        const started = calls === 1 ? startedA : startedB
        return Effect.succeed(
          Stream.fromEffect(
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(gate)
              return finishPart({ finishReason: "stop" })
            }),
          ).pipe(Stream.map(() => finishPart({ finishReason: "stop" }))),
        )
      })
      const layer = makeLayer(providerLayer)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const messageA = makeMessage("s1", "b1", "alpha")
          const messageB = makeMessage("s2", "b2", "beta")
          const fiberA = yield* Effect.forkChild(runAgentLoop(agentLoop, messageA))
          const fiberB = yield* Effect.forkChild(runAgentLoop(agentLoop, messageB))
          yield* Deferred.await(startedA)
          yield* Deferred.await(startedB)
          yield* steerAgentLoop({
            _tag: "Interrupt",
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
          })
          const finishedA = yield* Fiber.join(fiberA).pipe(Effect.timeoutOption("200 millis"))
          expect(finishedA._tag).toBe("Some")
          const statusB = fiberB.pollUnsafe()
          expect(statusB).toBeUndefined()
          yield* Deferred.succeed(gateA, undefined)
          yield* Deferred.succeed(gateB, undefined)
          yield* Fiber.join(fiberB)
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("batches queued messages into one follow-up", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
      let calls = 0
      const providerLayer = Provider.TestStream(() => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(gate)
                return finishPart({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => finishPart({ finishReason: "stop" }))),
          )
        }
        return Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })]))
      })
      const layer = makeLayer(providerLayer)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const messageStorage = yield* MessageStorage
          const first = makeMessage("s1", "b1", "first")
          const second = makeMessage("s1", "b1", "second")
          const third = makeMessage("s1", "b1", "third")
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, first))
          yield* Deferred.await(firstStarted)
          yield* runAgentLoop(agentLoop, second)
          yield* runAgentLoop(agentLoop, third)
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber)
          const messages = yield* messageStorage.listMessages(BranchId.make("b1"))
          const userTexts = messages
            .filter((message) => message.role === "user")
            .map((message) =>
              message.parts
                .filter((part): part is TextPart => part.type === "text")
                .map((part) => part.text)
                .join("\n"),
            )
          expect(userTexts).toEqual(["first", "second\nthird"])
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("publishes StreamStarted and TurnCompleted events", () =>
    Effect.gen(function* () {
      const providerLayer = Provider.TestStream(() =>
        Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })])),
      )
      const layer = makeRecordingLayer(providerLayer)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const recorder = yield* SequenceRecorder
          yield* runAgentLoop(agentLoop, makeMessage("s1", "b1", "inspect me"))
          const calls = yield* recorder.getCalls()
          const publishedEvents = calls
            .filter((call) => call.service === "EventStore" && call.method === "append")
            .map(
              (call) =>
                (
                  call.args as
                    | {
                        _tag?: string
                      }
                    | undefined
                )?._tag,
            )
            .filter((tag): tag is string => tag !== undefined)
          expect(publishedEvents).toContain("StreamStarted")
          expect(publishedEvents).toContain("TurnCompleted")
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("rolls back assistant message when durable MessageReceived append fails", () =>
    Effect.gen(function* () {
      const providerLayer = scriptedProvider([
        [textDeltaPart("not committed"), finishPart({ finishReason: "stop" })],
      ])
      const failingPublisherLayer = Layer.succeed(EventPublisher, {
        append: (event: AgentEvent) =>
          event._tag === "MessageReceived" && event.message.role === "assistant"
            ? Effect.fail(new EventStoreError({ message: "append failed" }))
            : Effect.gen(function* () {
                return EventEnvelope.make({
                  id: EventId.make(0),
                  event,
                  createdAt: yield* Clock.currentTimeMillis,
                })
              }),
        deliver: () => Effect.void,
        publish: () => Effect.void,
      })
      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const messageStorage = yield* MessageStorage
        const message = makeMessage("atomic-assistant-session", "atomic-assistant-branch", "hello")
        const exit = yield* Effect.exit(runAgentLoop(agentLoop, message))
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(exit._tag).toBe("Failure")
        expect(assistant).toBeUndefined()
      }).pipe(Effect.provide(makeLayerWithEventPublisher(providerLayer, failingPublisherLayer)))
    }),
  )
  it.live("rolls back turn duration when TurnCompleted append fails", () =>
    Effect.gen(function* () {
      const providerLayer = scriptedProvider([
        [textDeltaPart("committed before finalize"), finishPart({ finishReason: "stop" })],
      ])
      const failingPublisherLayer = Layer.succeed(EventPublisher, {
        append: (event: AgentEvent) =>
          event._tag === "TurnCompleted"
            ? Effect.fail(new EventStoreError({ message: "append failed" }))
            : Effect.gen(function* () {
                return EventEnvelope.make({
                  id: EventId.make(0),
                  event,
                  createdAt: yield* Clock.currentTimeMillis,
                })
              }),
        deliver: () => Effect.void,
        publish: () => Effect.void,
      })
      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const messageStorage = yield* MessageStorage
        const message = makeMessage("atomic-turn-session", "atomic-turn-branch", "hello")
        const exit = yield* Effect.exit(runAgentLoop(agentLoop, message))
        const user = yield* messageStorage.getMessage(message.id)
        expect(exit._tag).toBe("Failure")
        expect(user?.turnDurationMs).toBeUndefined()
      }).pipe(Effect.provide(makeLayerWithEventPublisher(providerLayer, failingPublisherLayer)))
    }),
  )
  test("persists assistant image parts from provider response streams", () =>
    Effect.gen(function* () {
      const messageStorage = yield* MessageStorage
      const agentLoop = yield* AgentLoop
      const message = makeMessage("image-session", "image-branch", "show image")
      yield* runAgentLoop(agentLoop, message)
      const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
      expect(assistant).toBeDefined()
      expect(assistant?.parts).toEqual([
        Prompt.filePart({
          data: "data:image/png;base64,aGk=",
          mediaType: "image/png",
        }),
      ])
    }).pipe(
      Effect.provide(
        makeLayer(
          scriptedProvider([
            [
              Response.makePart("file", {
                mediaType: "image/png",
                data: new Uint8Array([104, 105]),
              }),
              finishPart({ finishReason: "stop" }),
            ],
          ]),
        ),
      ),
      Effect.runPromise,
    ))
  it.live("interjection runs before queued follow-up with scoped agent override", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
      const providerCalls: Array<{
        model: string
        latestUserText: string
      }> = []
      let streamCount = 0
      const providerLayer = Provider.TestStream((request, options) => {
        const latestUserText = [...Prompt.make(options.prompt).content]
          .reverse()
          .find((message) => message.role === "user")
          ?.content.filter((part): part is Prompt.TextPart => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        providerCalls.push({
          model: request.model,
          latestUserText: latestUserText ?? "",
        })
        streamCount += 1
        if (streamCount === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(gate)
                return finishPart({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => finishPart({ finishReason: "stop" }))),
          )
        }
        return Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })]))
      })
      const layer = makeLayer(providerLayer)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const first = makeMessage("s1", "b1", "first")
          const queued = makeMessage("s1", "b1", "queued")
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, first))
          yield* Deferred.await(firstStarted)
          yield* runAgentLoop(agentLoop, queued)
          yield* steerAgentLoop({
            _tag: "Interject",
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
            message: "steer now",
            agent: AgentName.make("deepwork"),
          })
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber)
          expect(providerCalls.length).toBe(3)
          expect(providerCalls[0]!.latestUserText).toBe("first")
          expect(providerCalls[1]!.latestUserText).toBe("steer now")
          expect(providerCalls[2]!.latestUserText).toBe("queued")
          expect(providerCalls[1]!.model).not.toBe(providerCalls[0]!.model)
          expect(providerCalls[2]!.model).toBe(providerCalls[0]!.model)
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("getQueue reads without draining", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
      let calls = 0
      const providerLayer = Provider.TestStream(() => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(gate)
                return finishPart({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => finishPart({ finishReason: "stop" }))),
          )
        }
        return Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })]))
      })
      const layer = makeLayer(providerLayer)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const first = makeMessage("s1", "b1", "first")
          const queuedA = makeMessage("s1", "b1", "queued a")
          const queuedB = makeMessage("s1", "b1", "queued b")
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, first))
          yield* Deferred.await(firstStarted)
          yield* runAgentLoop(agentLoop, queuedA)
          yield* runAgentLoop(agentLoop, queuedB)
          yield* steerAgentLoop({
            _tag: "Interject",
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
            message: "steer now",
          })
          const snapshot = yield* agentLoop.getQueue({
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
          })
          expect(snapshot.steering).toEqual([
            expect.objectContaining({ _tag: "steering", content: "steer now" }),
          ])
          expect(snapshot.followUp).toEqual([
            expect.objectContaining({ _tag: "follow-up", content: "queued a\nqueued b" }),
          ])
          const secondSnapshot = yield* agentLoop.getQueue({
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
          })
          expect(secondSnapshot).toEqual(snapshot)
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber)
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("flushes queued follow-ups after provider failure", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
      const providerCalls: string[] = []
      let streamCalls = 0
      const providerLayer = Provider.TestStream((_request, options) => {
        const latestUserText =
          Prompt.make(options.prompt)
            .content.slice()
            .reverse()
            .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
            .find(
              (part: unknown): part is Prompt.TextPart =>
                typeof part === "object" &&
                part !== null &&
                (
                  part as {
                    type?: unknown
                  }
                ).type === "text",
            )?.text ?? ""
        providerCalls.push(latestUserText)
        streamCalls += 1
        if (streamCalls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(gate)
                return undefined
              }),
            ).pipe(
              Stream.flatMap(() =>
                Stream.fail(
                  AiError.make({
                    module: "Test",
                    method: "streamText",
                    reason: new AiError.UnknownError({ description: "provider exploded" }),
                  }),
                ),
              ),
            ),
          )
        }
        return Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })]))
      })
      const layer = makeLayer(providerLayer)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const first = makeMessage("s1", "b1", "first")
          const queued = makeMessage("s1", "b1", "queued after failure")
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, first))
          yield* Deferred.await(firstStarted)
          yield* runAgentLoop(agentLoop, queued)
          const snapshotWhileRunning = yield* agentLoop.getQueue({
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
          })
          expect(snapshotWhileRunning.followUp).toEqual([
            expect.objectContaining({ _tag: "follow-up", content: "queued after failure" }),
          ])
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber).pipe(Effect.exit)
          expect(providerCalls).toEqual(["first", "queued after failure"])
          const snapshotAfterFailure = yield* agentLoop.getQueue({
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
          })
          expect(snapshotAfterFailure).toEqual(emptyQueueSnapshot())
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  test("retries retryable provider stream-consumption failures before output", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      let streamCalls = 0
      const providerLayer = Provider.TestStream(() =>
        Effect.sync(() => {
          streamCalls += 1
          if (streamCalls === 1) {
            return Stream.fail(retryableStreamError())
          }
          return Stream.fromIterable([
            textDeltaPart("after retry"),
            finishPart({ finishReason: "stop" }),
          ])
        }),
      )
      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const messageStorage = yield* MessageStorage
        const message = makeMessage("stream-retry-session", "stream-retry-branch", "retry")
        yield* runAgentLoop(agentLoop, message)
        const events = yield* Ref.get(eventsRef)
        const tags = events.map((event) => event._tag)
        expect(streamCalls).toBe(2)
        expect(tags).toContain("ProviderRetrying")
        expect(tags).not.toContain("ErrorOccurred")
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant?.parts).toEqual([Prompt.textPart({ text: "after retry" })])
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
    }).pipe(Effect.runPromise))
  test("retries retryable provider stream-consumption failures after metadata but before output", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      let streamCalls = 0
      const providerLayer = Provider.TestStream(() =>
        Effect.sync(() => {
          streamCalls += 1
          if (streamCalls === 1) {
            return Stream.concat(
              Stream.fromIterable([
                Response.makePart("response-metadata", {
                  id: "response-before-output",
                  modelId: "test",
                  timestamp: undefined,
                  request: undefined,
                }),
                Response.makePart("text-start", { id: "text-before-output" }),
              ]),
              Stream.fail(retryableStreamError()),
            )
          }
          return Stream.fromIterable([
            textDeltaPart("after metadata retry"),
            finishPart({ finishReason: "stop" }),
          ])
        }),
      )
      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const messageStorage = yield* MessageStorage
        const message = makeMessage(
          "stream-metadata-retry-session",
          "stream-metadata-retry-branch",
          "retry",
        )
        yield* runAgentLoop(agentLoop, message)
        const events = yield* Ref.get(eventsRef)
        const tags = events.map((event) => event._tag)
        expect(streamCalls).toBe(2)
        expect(tags).toContain("ProviderRetrying")
        expect(tags).not.toContain("ErrorOccurred")
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant?.parts).toEqual([Prompt.textPart({ text: "after metadata retry" })])
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
    }).pipe(Effect.runPromise))
  test("emits stream failure events after pre-output retries are exhausted", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      let streamCalls = 0
      const providerLayer = Provider.TestStream(() =>
        Effect.sync(() => {
          streamCalls += 1
          return Stream.fail(retryableStreamError())
        }),
      )
      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const messageStorage = yield* MessageStorage
        const message = makeMessage(
          "stream-retry-exhausted-session",
          "stream-retry-exhausted-branch",
          "retry",
        )
        yield* runAgentLoop(agentLoop, message)
        const events = yield* Ref.get(eventsRef)
        const tags = events.map((event) => event._tag)
        expect(streamCalls).toBe(3)
        expect(tags.filter((tag) => tag === "ProviderRetrying")).toHaveLength(2)
        expect(tags).toContain("StreamEnded")
        expect(tags).toContain("ErrorOccurred")
        expect(tags).toContain("TurnCompleted")
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant).toBeUndefined()
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
    }).pipe(Effect.runPromise))
  test("does not retry retryable provider stream failures after partial output", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      let streamCalls = 0
      const providerLayer = Provider.TestStream(() =>
        Effect.sync(() => {
          streamCalls += 1
          if (streamCalls === 1) {
            return Stream.concat(
              Stream.fromIterable([textDeltaPart("partial answer")]),
              Stream.fail(retryableStreamError()),
            )
          }
          return Stream.fromIterable([
            textDeltaPart("duplicate answer"),
            finishPart({ finishReason: "stop" }),
          ])
        }),
      )
      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const messageStorage = yield* MessageStorage
        const message = makeMessage("stream-no-retry-session", "stream-no-retry-branch", "retry")
        yield* runAgentLoop(agentLoop, message)
        const events = yield* Ref.get(eventsRef)
        const tags = events.map((event) => event._tag)
        expect(streamCalls).toBe(1)
        expect(tags).not.toContain("ProviderRetrying")
        expect(tags).toContain("ErrorOccurred")
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant?.parts).toEqual([Prompt.textPart({ text: "partial answer" })])
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
    }).pipe(Effect.runPromise))
  test("native response error parts fail the stream and preserve partial output", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const providerLayer = Provider.TestStream(() =>
        Effect.succeed(
          Stream.fromIterable([
            textDeltaPart("partial answer"),
            Response.makePart("error", { error: new Error("native response part failed") }),
            textDeltaPart("unreachable"),
          ]),
        ),
      )
      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const messageStorage = yield* MessageStorage
        const message = makeMessage("native-error-session", "native-error-branch", "fail natively")
        yield* runAgentLoop(agentLoop, message)
        const events = yield* Ref.get(eventsRef)
        const tags = events.map((event) => event._tag)
        expect(tags).toContain("StreamStarted")
        expect(tags).toContain("StreamChunk")
        expect(tags).toContain("StreamEnded")
        expect(tags).toContain("ErrorOccurred")
        expect(tags).toContain("TurnCompleted")
        const error = events.find((event) => event._tag === "ErrorOccurred")
        expect(error).toEqual(expect.objectContaining({ error: "native response part failed" }))
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant).toBeDefined()
        expect(assistant?.parts).toEqual([Prompt.textPart({ text: "partial answer" })])
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
    }).pipe(Effect.runPromise))
})
// ============================================================================
// concurrency
// ============================================================================
describe("concurrency", () => {
  it.live("serial tool calls do not overlap", () =>
    Effect.gen(function* () {
      const events: string[] = []
      let running = 0
      let maxRunning = 0
      const makeSerialTool = (name: string) =>
        tool({
          id: name,
          // All instances share one write need and therefore cannot overlap.
          needs: [ToolNeeds.write("test-serial")],
          description: `Serial tool ${name}`,
          params: Schema.Struct({}),
          execute: () =>
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                running += 1
                maxRunning = Math.max(maxRunning, running)
                events.push(`start:${name}`)
              })
              yield* Effect.sleep(1)
              yield* Effect.sync(() => {
                events.push(`end:${name}`)
                running -= 1
              })
              return { ok: true }
            }),
        })
      const toolA = makeSerialTool("serial-a")
      const toolB = makeSerialTool("serial-b")
      const layer = makeLiveToolLayer(
        scriptedProvider([
          [
            toolCallPart("serial-a", {}, { toolCallId: ToolCallId.make("tc-1") }),
            toolCallPart("serial-b", {}, { toolCallId: ToolCallId.make("tc-2") }),
            finishPart({ finishReason: "tool-calls" }),
          ],
          [finishPart({ finishReason: "stop" })],
        ]),
        [toolA, toolB],
      )
      yield* Effect.gen(function* () {
        const sessionStorage = yield* SessionStorage
        const branchStorage = yield* BranchStorage
        const loop = yield* AgentLoop
        const now = dateFromMillis(1_767_225_600_000)
        const session = new Session({
          id: SessionId.make("serial-session"),
          name: "Serial Test",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: BranchId.make("serial-branch"),
          sessionId: session.id,
          createdAt: now,
        })
        yield* sessionStorage.createSession(session)
        yield* branchStorage.createBranch(branch)
        yield* loop.runOnce({
          sessionId: session.id,
          branchId: branch.id,
          agentName: AgentName.make("cowork"),
          prompt: "run serial tools",
        })
      }).pipe(Effect.provide(layer))
      expect(maxRunning).toBe(1)
      expect(events.length).toBe(4)
      expect(events[0]?.startsWith("start:")).toBe(true)
      expect(events[1]?.startsWith("end:")).toBe(true)
      expect(events[2]?.startsWith("start:")).toBe(true)
      expect(events[3]?.startsWith("end:")).toBe(true)
      expect(events[0]?.slice("start:".length)).toBe(events[1]?.slice("end:".length))
      expect(events[2]?.slice("start:".length)).toBe(events[3]?.slice("end:".length))
    }),
  )
})
// ============================================================================
// continuation
// ============================================================================
describe("continuation", () => {
  const contSessionId = SessionId.make("cont-test-session")
  const contBranchId = BranchId.make("cont-test-branch")
  let messageSequence = 0
  const makeContMessage = (text: string) =>
    Message.Regular.make({
      id: MessageId.make(`msg-${messageSequence++}`),
      sessionId: contSessionId,
      branchId: contBranchId,
      role: "user",
      parts: [Prompt.textPart({ text })],
      createdAt: dateFromMillis(1_767_225_600_000),
    })
  const echoTool = tool({
    id: "echo",
    description: "Echoes input",
    params: Schema.Struct({ text: Schema.String }),
    execute: (_params) => Effect.succeed({ text: _params.text }),
  })
  test("tool call auto-continues to next LLM call", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* Provider.Sequence([
        toolCallStep("echo", { text: "hello" }),
        textStep("Done with tools."),
      ])
      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        yield* runAgentLoop(agentLoop, makeContMessage("test auto-continue"))
        expect(yield* controls.callCount).toBe(2)
        yield* controls.assertDone()
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }).pipe(Effect.runPromise))
  test("text-only response does not trigger continuation", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* Provider.Sequence([
        textStep("Just text, no tools."),
      ])
      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        yield* runAgentLoop(agentLoop, makeContMessage("text only"))
        expect(yield* controls.callCount).toBe(1)
        yield* controls.assertDone()
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }).pipe(Effect.runPromise))
  test("multi-hop tool calls chain until text response", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* Provider.Sequence([
        toolCallStep("echo", { text: "step 1" }),
        toolCallStep("echo", { text: "step 2" }),
        toolCallStep("echo", { text: "step 3" }),
        textStep("Finally done."),
      ])
      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        yield* runAgentLoop(agentLoop, makeContMessage("multi-hop"))
        expect(yield* controls.callCount).toBe(4)
        yield* controls.assertDone()
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }).pipe(Effect.runPromise))
  test("TurnCompleted fires once per turn, not per step", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* Provider.Sequence([
        toolCallStep("echo", { text: "step 1" }),
        toolCallStep("echo", { text: "step 2" }),
        textStep("Done."),
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        yield* runAgentLoop(agentLoop, makeContMessage("turn-events"))
        expect(yield* controls.callCount).toBe(3)
        const events = yield* Ref.get(eventsRef)
        const turnCompleted = events.filter((e) => e._tag === "TurnCompleted")
        expect(turnCompleted.length).toBe(1)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.runPromise))
  test("interrupt during tool execution stops continuation", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* Provider.Sequence([
        toolCallStep("echo", { text: "step 1" }),
        { ...textStep("Continuation response."), gated: true },
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const fiber = yield* Effect.forkChild(
          runAgentLoop(agentLoop, makeContMessage("interrupt test")),
        )
        yield* controls.waitForCall(1)
        yield* steerAgentLoop({
          _tag: "Interrupt",
          sessionId: contSessionId,
          branchId: contBranchId,
        })
        yield* controls.emitAll(1)
        yield* Fiber.join(fiber)
        expect(yield* controls.callCount).toBe(2)
        const events = yield* Ref.get(eventsRef)
        const turnCompleted = events.filter((e) => e._tag === "TurnCompleted")
        expect(turnCompleted.length).toBe(1)
        const tc = turnCompleted[0] as {
          interrupted?: boolean
        }
        expect(tc.interrupted).toBe(true)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.runPromise))
  test("GUARD: ToolsFinished without interrupt routes to Resolving", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* Provider.Sequence([
        toolCallStep("echo", { text: "tool" }),
        textStep("Continuation reached."),
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        yield* runAgentLoop(agentLoop, makeContMessage("structural guard"))
        expect(yield* controls.callCount).toBe(2)
        yield* controls.assertDone()
        const events = yield* Ref.get(eventsRef)
        expect(events.filter((e) => e._tag === "TurnCompleted").length).toBe(1)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.runPromise))
  test("GUARD: multi-hop persists distinct messages per step", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* Provider.Sequence([
        toolCallStep("echo", { text: "step 1" }),
        toolCallStep("echo", { text: "step 2" }),
        textStep("Final answer."),
      ])
      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const messageStorage = yield* MessageStorage
        const msg = makeContMessage("multi-hop persistence")
        yield* runAgentLoop(agentLoop, msg)
        const a1 = yield* messageStorage.getMessage(assistantMessageIdForTurn(msg.id, 1))
        const t1 = yield* messageStorage.getMessage(toolResultMessageIdForTurn(msg.id, 1))
        expect(a1).toBeDefined()
        expect(t1).toBeDefined()
        expect(a1!.role).toBe("assistant")
        expect(t1!.role).toBe("tool")
        const a2 = yield* messageStorage.getMessage(assistantMessageIdForTurn(msg.id, 2))
        const t2 = yield* messageStorage.getMessage(toolResultMessageIdForTurn(msg.id, 2))
        expect(a2).toBeDefined()
        expect(t2).toBeDefined()
        expect(a2!.role).toBe("assistant")
        expect(t2!.role).toBe("tool")
        const a3 = yield* messageStorage.getMessage(assistantMessageIdForTurn(msg.id, 3))
        const t3 = yield* messageStorage.getMessage(toolResultMessageIdForTurn(msg.id, 3))
        expect(a3).toBeDefined()
        expect(a3!.role).toBe("assistant")
        expect(t3).toBeUndefined()
        expect(new Set([a1!.id, a2!.id, a3!.id]).size).toBe(3)
        expect(new Set([t1!.id, t2!.id]).size).toBe(2)
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }).pipe(Effect.runPromise))
  test("queued follow-up executes normally after interrupt", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* Provider.Sequence([
        toolCallStep("echo", { text: "step 1" }),
        { ...textStep("gated response"), gated: true },
        textStep("follow-up response"),
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const first = makeContMessage("first message")
        const followUp = makeContMessage("follow-up after interrupt")
        // Start first turn — tool call auto-continues to gated step
        yield* Effect.forkChild(runAgentLoop(agentLoop, first))
        // Wait for the gated step (second stream call) to start
        yield* controls.waitForCall(1)
        // Queue a follow-up while step 1 is gated
        yield* runAgentLoop(agentLoop, followUp)
        // Interrupt the current turn. `agentLoop.steer` issues
        // `actor.call(Interrupt)` which is serialized request-reply — by the
        // time it returns, the actor has already set `interruptedRef = true`
        // and signalled the active stream. No additional wait needed.
        yield* steerAgentLoop({
          _tag: "Interrupt",
          sessionId: contSessionId,
          branchId: contBranchId,
        })
        // Release the gated step so the interrupted turn can finalize
        yield* controls.emitAll(1)
        // Wait for the follow-up to complete
        yield* waitForPhase(
          agentLoop,
          { sessionId: contSessionId, branchId: contBranchId },
          "Idle",
          200,
        )
        const events = yield* Ref.get(eventsRef)
        const turnCompleted = events.filter((e) => e._tag === "TurnCompleted")
        // Both turns should have completed
        expect(turnCompleted.length).toBe(2)
        const interruptedTurns = turnCompleted.filter(
          (e) =>
            (
              e as {
                interrupted?: boolean
              }
            ).interrupted === true,
        )
        // First turn was interrupted, second (follow-up) was not
        expect(interruptedTurns.length).toBe(1)
        // Follow-up used the third provider step
        expect(yield* controls.callCount).toBe(3)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.runPromise))
})
describe("turn stream parity", () => {
  test("model and external turns produce the same assistant draft and lifecycle tags", () =>
    Effect.gen(function* () {
      const expectedTags = [
        "MessageReceived",
        "StreamStarted",
        "StreamChunk",
        "StreamEnded",
        "MessageReceived",
        "TurnCompleted",
      ] as const
      const modelEventsRef = yield* Ref.make<AgentEvent[]>([])
      const externalEventsRef = yield* Ref.make<AgentEvent[]>([])
      const modelDraft = yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const messageStorage = yield* MessageStorage
        const message = makeMessage("model-parity-session", "model-parity-branch", "hello")
        yield* runAgentLoop(agentLoop, message)
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant).toBeDefined()
        return assistantDraftFromMessage(assistant!)
      }).pipe(
        Effect.provide(
          makeLayerWithEvents(
            scriptedProvider([
              [
                reasoningDeltaPart("thinking"),
                textDeltaPart("hello from parity"),
                finishPart({
                  finishReason: "stop",
                  usage: { inputTokens: 3, outputTokens: 5 },
                }),
              ],
            ]),
            modelEventsRef,
          ),
        ),
      )
      const externalDraft = yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const messageStorage = yield* MessageStorage
        const message = makeMessage("external-parity-session", "external-parity-branch", "hello")
        yield* runAgentLoop(agentLoop, message, { agentOverride: "test-external-parity" as never })
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant).toBeDefined()
        return assistantDraftFromMessage(assistant!)
      }).pipe(
        Effect.provide(
          makeExternalLayerWithEvents(
            [
              reasoningDeltaPart("thinking"),
              textDeltaPart("hello from parity"),
              finishPart({
                finishReason: "stop",
                usage: { inputTokens: 3, outputTokens: 5 },
              }),
            ],
            externalEventsRef,
          ),
        ),
      )
      expect(modelDraft).toEqual(externalDraft)
      expect((yield* Ref.get(modelEventsRef)).map((event) => event._tag as string)).toEqual([
        ...expectedTags,
      ])
      expect((yield* Ref.get(externalEventsRef)).map((event) => event._tag as string)).toEqual([
        ...expectedTags,
      ])
    }).pipe(Effect.runPromise))
})
// ============================================================================
// interaction
// ============================================================================
describe("interaction", () => {
  const intSessionId = SessionId.make("s-interaction")
  const intBranchId = BranchId.make("b-interaction")
  const makeIntMessage = (text: string) =>
    Message.Regular.make({
      id: `msg-${text}`,
      sessionId: intSessionId,
      branchId: intBranchId,
      role: "user",
      parts: [Prompt.textPart({ text })],
      createdAt: dateFromMillis(1_767_225_600_000),
    })
  const makeInteractionTool = (callCount: Ref.Ref<number>, resolution: Deferred.Deferred<void>) =>
    tool({
      id: "interaction-tool",
      description: "Tool that triggers an interaction",
      needs: [ToolNeeds.write("interaction")],
      params: Schema.Struct({ value: Schema.String }),
      execute: (
        params: {
          value: string
        },
        ctx: ToolCapabilityContext,
      ) =>
        Effect.gen(function* () {
          const count = yield* Ref.getAndUpdate(callCount, (n) => n + 1)
          if (count === 0) {
            return yield* new InteractionPendingError({
              requestId: InteractionRequestId.make("req-test-1"),
              sessionId: ctx.sessionId,
              branchId: ctx.branchId,
            })
          }
          yield* Deferred.succeed(resolution, void 0)
          return { resolved: true, value: params.value }
        }),
    })
  // Stateful provider: first model stream returns a tool call (triggers interaction),
  // subsequent model streams return text only (completes the turn).
  // Without this, the loop re-streams the same tool call 199 times until maxTurnSteps.
  const makeInteractionProviderLayer = () => {
    let streamCall = 0
    return Provider.TestStream(() => {
      const call = streamCall++
      if (call === 0) {
        return Effect.succeed(
          Stream.fromIterable([
            toolCallPart(
              "interaction-tool",
              { value: "test" },
              {
                toolCallId: ToolCallId.make("tc-1"),
              },
            ),
            finishPart({ finishReason: "tool-calls" }),
          ] satisfies ProviderStreamPart[]),
        )
      }
      return Effect.succeed(
        Stream.fromIterable([
          textDeltaPart("done"),
          finishPart({ finishReason: "stop" }),
        ] satisfies ProviderStreamPart[]),
      )
    })
  }
  const makeInteractionRecordingLayer = (
    tools: ReadonlyArray<ToolToken>,
    providerLayer?: Layer.Layer<Provider>,
  ) => {
    const resolvedProviderLayer = providerLayer ?? makeInteractionProviderLayer()
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const baseDeps = Layer.mergeAll(
      SqliteStorage.TestWithSql(),
      resolvedProviderLayer,
      modelResolverFromProvider(resolvedProviderLayer),
      makeExtRegistry(tools),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      ConfigService.Test(),
      ApprovalService.Test(),
      Permission.Live([], "allow"),
      BunServices.layer,
      ResourceManagerLive,
      ModelRegistry.Test(),
      GentPlatform.Test(),
      recorderLayer,
      eventStoreLayer,
    )
    const deps = Layer.mergeAll(baseDeps, Layer.provide(ToolRunner.Live, baseDeps))
    const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
    return AgentLoop.Live({ baseSections: [] }).pipe(
      Layer.provideMerge(
        AgentLoopTestActor.pipe(Layer.provide(AgentLoopBehaviorDeps.Live({ baseSections: [] }))),
      ),
      Layer.provideMerge(
        Layer.mergeAll(
          deps,
          eventPublisherLayer,
          AgentLoopStateRegistry.Live,
          AgentLoopSessionGovernance.Live,
        ),
      ),
    )
  }
  it.live("tool triggers InteractionPendingError and machine parks", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0)
      const resolution = yield* Deferred.make<void>()
      const tool = makeInteractionTool(callCount, resolution)
      const layer = makeInteractionRecordingLayer([tool])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const recorder = yield* SequenceRecorder
          const fiber = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeIntMessage("trigger interaction")),
          )
          const state = yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          expect(state._tag).toBe("WaitingForInteraction")
          expect(yield* Ref.get(callCount)).toBe(1)
          const calls = yield* recorder.getCalls()
          const eventTags = calls
            .filter((c) => c.service === "EventStore" && c.method === "append")
            .map(
              (c) =>
                (
                  c.args as {
                    _tag: string
                  }
                )._tag,
            )
          expect(eventTags).toContain("ToolCallStarted")
          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-test-1"),
          })
          yield* Deferred.await(resolution).pipe(Effect.timeout("5 seconds"))
          expect(yield* Ref.get(callCount)).toBe(2)
          yield* Fiber.join(fiber)
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("stale interaction response does not resume a different pending request", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0)
      const resolution = yield* Deferred.make<void>()
      const tool = makeInteractionTool(callCount, resolution)
      const layer = makeInteractionRecordingLayer([tool])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const fiber = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeIntMessage("stale interaction")),
          )
          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-stale-1"),
          })

          const state = yield* agentLoop.getState({
            sessionId: intSessionId,
            branchId: intBranchId,
          })
          expect(state._tag).toBe("WaitingForInteraction")
          expect(yield* Ref.get(callCount)).toBe(1)
          expect(yield* Deferred.isDone(resolution)).toBe(false)

          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-test-1"),
          })
          yield* Deferred.await(resolution).pipe(Effect.timeout("5 seconds"))
          expect(yield* Ref.get(callCount)).toBe(2)
          yield* Fiber.join(fiber)
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("interrupt during WaitingForInteraction finalizes turn", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0)
      const resolution = yield* Deferred.make<void>()
      const tool = makeInteractionTool(callCount, resolution)
      const layer = makeLiveToolLayer(makeInteractionProviderLayer(), [tool])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const fiber = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeIntMessage("interrupt test")),
          )
          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          yield* steerAgentLoop({
            _tag: "Interrupt",
            sessionId: intSessionId,
            branchId: intBranchId,
          })
          yield* Fiber.join(fiber)
          const stateAfter = yield* agentLoop.getState({
            sessionId: intSessionId,
            branchId: intBranchId,
          })
          expect(stateAfter._tag).toBe("Idle")
          expect(yield* Ref.get(callCount)).toBe(1)
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("respondInteraction is no-op when not in WaitingForInteraction", () =>
    Effect.gen(function* () {
      const providerLayer = Provider.TestStream(() =>
        Effect.succeed(
          Stream.fromIterable([textDeltaPart("hello"), finishPart({ finishReason: "stop" })]),
        ),
      )
      const deps = Layer.mergeAll(
        SqliteStorage.TestWithSql(),
        providerLayer,
        modelResolverFromProvider(providerLayer),
        makeExtRegistry(),
        RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        ConfigService.Test(),
        EventStore.Memory,
        ToolRunner.Test(),
        BunServices.layer,
        ResourceManagerLive,
        ModelRegistry.Test(),
        GentPlatform.Test(),
      )
      const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
      const loopLayer = AgentLoop.Live({ baseSections: [] }).pipe(
        Layer.provideMerge(
          AgentLoopTestActor.pipe(Layer.provide(AgentLoopBehaviorDeps.Live({ baseSections: [] }))),
        ),
        Layer.provideMerge(
          Layer.mergeAll(
            deps,
            eventPublisherLayer,
            AgentLoopStateRegistry.Live,
            AgentLoopSessionGovernance.Live,
          ),
        ),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          yield* runAgentLoop(agentLoop, makeIntMessage("no interaction"))
          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("nonexistent"),
          })
          const state = yield* agentLoop.getState({
            sessionId: intSessionId,
            branchId: intBranchId,
          })
          expect(state._tag).toBe("Idle")
        }).pipe(Effect.provide(loopLayer)),
      )
    }),
  )
  it.live("GUARD: interaction resume executes tool without new LLM call", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0)
      const resolution = yield* Deferred.make<void>()
      const tool = makeInteractionTool(callCount, resolution)
      const providerCallsRef = yield* Ref.make(0)
      let streamCallIndex = 0
      const separateCallProvider = Provider.TestStream(() =>
        Effect.gen(function* () {
          yield* Ref.update(providerCallsRef, (n) => n + 1)
          const idx = streamCallIndex++
          if (idx === 0) {
            return Stream.fromIterable([
              toolCallPart(
                getToolId(tool),
                { value: "guard-test" },
                {
                  toolCallId: ToolCallId.make("tc-guard"),
                },
              ),
              finishPart({ finishReason: "tool-calls" }),
            ] satisfies ProviderStreamPart[])
          }
          return Stream.fromIterable([
            textDeltaPart("interaction resolved"),
            finishPart({ finishReason: "stop" }),
          ] satisfies ProviderStreamPart[])
        }),
      )
      const layer = makeLiveToolLayer(separateCallProvider, [tool])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const fiber = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeIntMessage("guard interaction")),
          )
          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          expect(Ref.getUnsafe(providerCallsRef)).toBe(1)
          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-test-1"),
          })
          yield* Deferred.await(resolution).pipe(Effect.timeout("5 seconds"))
          expect(Ref.getUnsafe(callCount)).toBe(2)
          yield* Fiber.join(fiber)
          expect(Ref.getUnsafe(providerCallsRef)).toBe(2)
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
})
// ============================================================================
// Durable suspension + queue drain regression
// ============================================================================
//
// Verifies the queue-drain behavior justified by the phase-tagged runtime:
// while a turn is `Running`, multiple `submit` calls enqueue and drain in
// submission order after `TurnDone`.
//
// Cites: `make-impossible-states-unrepresentable` (phase-tag invariants),
//        `redesign-from-first-principles` (the current runtime carries the
//        same correctness load as the FSM did).
describe("queue drain regression", () => {
  it.live(
    "multiple submits during a Running turn drain in submission order after TurnDone",
    () =>
      Effect.gen(function* () {
        const drainSessionId = SessionId.make("session-loop-drain")
        const drainBranchId = BranchId.make("branch-loop-drain")
        // Provider gates each turn on a per-turn Deferred so the test can
        // serialize "submit while Running" semantics deterministically.
        // First model stream call is gated by gates[0], second by gates[1], etc.
        // Each call records its index into `streamOrder` and returns a
        // simple text+stop response when its gate resolves.
        const gates = [
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
        ]
        const streamOrder = yield* Ref.make<readonly number[]>([])
        const streamCallRef = yield* Ref.make(0)
        const gatedProvider = Provider.TestStream(() =>
          Effect.gen(function* () {
            const idx = yield* Ref.getAndUpdate(streamCallRef, (n) => n + 1)
            yield* Ref.update(streamOrder, (arr) => [...arr, idx])
            const gate = gates[idx]
            if (gate !== undefined) {
              yield* Deferred.await(gate)
            }
            return Stream.fromIterable([
              textDeltaPart(`turn-${idx}`),
              finishPart({ finishReason: "stop" }),
            ] satisfies ProviderStreamPart[])
          }),
        )
        const deps = Layer.mergeAll(
          SqliteStorage.TestWithSql(),
          gatedProvider,
          modelResolverFromProvider(gatedProvider),
          makeExtRegistry(),
          RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
          ConfigService.Test(),
          EventStore.Memory,
          ToolRunner.Test(),
          BunServices.layer,
          ResourceManagerLive,
          ModelRegistry.Test(),
          GentPlatform.Test(),
        )
        const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
        const layer = AgentLoop.Live({ baseSections: [] }).pipe(
          Layer.provideMerge(
            AgentLoopTestActor.pipe(
              Layer.provide(AgentLoopBehaviorDeps.Live({ baseSections: [] })),
            ),
          ),
          Layer.provideMerge(
            Layer.mergeAll(
              deps,
              eventPublisherLayer,
              AgentLoopStateRegistry.Live,
              AgentLoopSessionGovernance.Live,
            ),
          ),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* AgentLoop
            // `interactive: true` disables follow-up batching in
            // `canBatchQueuedFollowUp` — without it, multiple plain-text
            // user submits collapse into a single combined turn before
            // they ever hit the queue drain.
            const submitOne = (id: string, text: string) =>
              submitAgentLoop(
                agentLoop,
                Message.Regular.make({
                  id: MessageId.make(id),
                  sessionId: drainSessionId,
                  branchId: drainBranchId,
                  role: "user",
                  parts: [Prompt.textPart({ text })],
                  createdAt: dateFromMillis(1_767_225_600_000),
                }),
                { interactive: true },
              )
            // Submit turn #0; wait until the provider's model stream has
            // actually been entered (parked on gate[0]). Phase transitions
            // to Running before model streaming starts, so we poll on
            // streamCallRef instead.
            yield* submitOne("msg-drain-0", "first")
            for (let i = 0; i < 200; i++) {
              if ((yield* Ref.get(streamCallRef)) >= 1) break
              yield* Effect.sleep("1 millis")
            }
            expect(yield* Ref.get(streamCallRef)).toBe(1)
            // Submit #1, #2, #3 while #0 is still parked. They MUST
            // enqueue (Running → Running re-enter) — they cannot start
            // a new model stream until #0's gate releases.
            yield* submitOne("msg-drain-1", "second")
            yield* submitOne("msg-drain-2", "third")
            yield* submitOne("msg-drain-3", "fourth")
            // Confirm model streaming was not re-entered.
            expect(yield* Ref.get(streamCallRef)).toBe(1)
            // Release all gates. Drain proceeds: #0 → #1 → #2 → #3.
            yield* Deferred.succeed(gates[0]!, void 0)
            yield* Deferred.succeed(gates[1]!, void 0)
            yield* Deferred.succeed(gates[2]!, void 0)
            yield* Deferred.succeed(gates[3]!, void 0)
            // Wait for full drain: stream call count must reach 4 and
            // loop returns to Idle.
            yield* waitForPhase(
              agentLoop,
              { sessionId: drainSessionId, branchId: drainBranchId },
              "Idle",
            )
            const finalCount = yield* Ref.get(streamCallRef)
            expect(finalCount).toBe(4)
            const order = yield* Ref.get(streamOrder)
            expect(order).toEqual([0, 1, 2, 3])
          }).pipe(Effect.provide(layer)),
        )
      }),
    15000,
  )
})
