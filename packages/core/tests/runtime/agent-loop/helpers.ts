import type { LanguageModel } from "effect/unstable/ai"
import { BunServices } from "@effect/platform-bun"
import { Clock, Duration, Effect, Layer, Ref, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as AiError from "effect/unstable/ai/AiError"
import type {
  AgentLoopError,
  SessionRuntimeState,
} from "../../../src/runtime/agent/agent-loop.state"
import type { SteerCommand } from "../../../src/domain/steer"
import {
  AgentLoop as AgentLoopActor,
  AgentLoopTestActor,
} from "../../../src/runtime/agent/agent-loop.actor"
import { AgentLoopSessionGovernance } from "../../../src/runtime/agent/agent-loop.session-governance"
import { entityIdOf } from "../../../src/runtime/agent/agent-loop.entity-id"
import { ResourceManagerLive } from "../../../src/runtime/resource-manager"
import { ModelRegistry } from "../../../src/runtime/model-registry"
import { GentPlatform } from "../../../src/runtime/gent-platform"
import { ExtensionRegistry, resolveExtensions } from "../../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../../src/runtime/extensions/driver-registry"
import { RuntimeEnvironment } from "../../../src/runtime/runtime-environment"
import { ConfigService } from "../../../src/runtime/config-service"
import { ToolRunner } from "../../../src/runtime/agent/tool-runner"
import {
  AgentDefinition,
  type AgentName,
  ExternalDriverRef,
  type RunSpec,
} from "@gent/core-internal/domain/agent"
import {
  finishPart,
  LanguageModelLayers,
  type LanguageModelStreamPart,
} from "@gent/core-internal/test-utils/language-model"
import { ModelResolver } from "@gent/core-internal/providers/model-resolver"
import { dateFromMillis, Message } from "@gent/core-internal/domain/message"
import { AllBuiltinAgents } from "../../../../extensions/tests/helpers/builtin-agents.js"
import { type AnyResourceContribution, type ToolCapability } from "@gent/core/extensions/api"
import { Permission } from "@gent/core-internal/domain/permission"
import {
  EventEnvelope,
  EventId,
  EventStore,
  type AgentEvent,
} from "@gent/core-internal/domain/event"
import { ApprovalService } from "../../../src/runtime/approval-service"
import type { EventPublisher } from "@gent/core-internal/domain/event-publisher"
import { EventPublisherLive } from "@gent/core-internal/domain/event-publisher"
import { SqliteStorage, type StorageError } from "@gent/core-internal/storage/sqlite-storage"
import type { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import type { SessionStorage } from "@gent/core-internal/storage/session-storage"
import {
  RecordingEventStore,
  SequenceRecorder,
  ensureStorageParents,
} from "@gent/core-internal/test-utils"
import type { QueueSnapshot } from "@gent/core-internal/domain/queue"
import type { BranchId, InteractionRequestId, SessionId } from "@gent/core-internal/domain/ids"
import { ActorCommandId, ExtensionId, MessageId } from "@gent/core-internal/domain/ids"
import type { TurnStreamPart } from "@gent/core-internal/domain/driver"
import { DefaultWorkspaceId } from "@gent/core-internal/server/workspace-rpc"
// ============================================================================
// Shared helpers
// ============================================================================

export const makeExtRegistry = (
  tools: ReadonlyArray<ToolCapability> = [],
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
export const makeMessage = (sessionId: SessionId, branchId: BranchId, text: string) =>
  Message.cases.regular.make({
    id: MessageId.make(`${sessionId}-${branchId}-${text}`),
    sessionId,
    branchId,
    role: "user",
    parts: [Prompt.textPart({ text })],
    createdAt: dateFromMillis(1_767_225_600_000),
  })
export interface AgentLoopService {
  readonly runOnce: (input: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly agentName: AgentName
    readonly prompt: string
    readonly interactive?: boolean
    readonly runSpec?: RunSpec
  }) => Effect.Effect<void, AgentLoopError | StorageError, BranchStorage | SessionStorage>
  readonly getQueue: (input: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
  }) => Effect.Effect<QueueSnapshot, AgentLoopError>
  readonly getState: (input: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
  }) => Effect.Effect<SessionRuntimeState, AgentLoopError>
}
export const makeAgentLoopService = Effect.gen(function* () {
  const actorClientFactory = yield* AgentLoopActor.Context
  const platform = yield* GentPlatform
  const refFor = (sessionId: SessionId, branchId: BranchId) =>
    actorClientFactory(entityIdOf(DefaultWorkspaceId, sessionId, branchId))
  return {
    runOnce: (input) =>
      Effect.gen(function* () {
        const message = Message.cases.regular.make({
          id: MessageId.make(yield* platform.randomId),
          sessionId: input.sessionId,
          branchId: input.branchId,
          role: "user",
          parts: [Prompt.textPart({ text: input.prompt })],
          createdAt: dateFromMillis(1_767_225_600_000),
        })
        yield* ensureStorageParents({ sessionId: input.sessionId, branchId: input.branchId })
        const ref = yield* refFor(input.sessionId, input.branchId)
        yield* ref.execute(
          AgentLoopActor.Run.make({
            workspaceId: DefaultWorkspaceId,
            message,
            agentOverride: input.agentName,
            runSpec: input.runSpec,
            interactive: input.interactive,
          }),
        )
      }),
    getQueue: (input) =>
      Effect.gen(function* () {
        const ref = yield* refFor(input.sessionId, input.branchId)
        return yield* ref.execute(
          AgentLoopActor.GetQueue.make({
            ...input,
            workspaceId: DefaultWorkspaceId,
            commandId: ActorCommandId.make(yield* platform.randomId),
          }),
        )
      }),
    getState: (input) =>
      Effect.gen(function* () {
        const ref = yield* refFor(input.sessionId, input.branchId)
        return yield* ref.execute(
          AgentLoopActor.GetState.make({
            ...input,
            workspaceId: DefaultWorkspaceId,
            commandId: ActorCommandId.make(yield* platform.randomId),
          }),
        )
      }),
  } satisfies AgentLoopService
})
export const runAgentLoop = (
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
        const ref = yield* actorClientFactory(
          entityIdOf(DefaultWorkspaceId, message.sessionId, message.branchId),
        )
        yield* ref.execute(
          AgentLoopActor.Run.make({
            workspaceId: DefaultWorkspaceId,
            message,
            agentOverride: options?.agentOverride,
            runSpec: options?.runSpec,
            interactive: options?.interactive,
          }),
        )
      }),
    ),
  )
export const submitAgentLoop = (
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
        const ref = yield* actorClientFactory(
          entityIdOf(DefaultWorkspaceId, message.sessionId, message.branchId),
        )
        yield* ref.execute(
          AgentLoopActor.Submit.make({
            workspaceId: DefaultWorkspaceId,
            message,
            agentOverride: options?.agentOverride,
            runSpec: options?.runSpec,
            interactive: options?.interactive,
          }),
        )
      }),
    ),
  )
export const steerAgentLoop = (command: SteerCommand) =>
  Effect.gen(function* () {
    const actorClientFactory = yield* AgentLoopActor.Context
    const ref = yield* actorClientFactory(
      entityIdOf(DefaultWorkspaceId, command.sessionId, command.branchId),
    )
    yield* ref.execute(
      AgentLoopActor.Steer.make({
        workspaceId: DefaultWorkspaceId,
        commandId: ActorCommandId.make(command.requestId),
        command,
      }),
    )
  })
export const respondAgentLoopInteraction = (input: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly requestId: InteractionRequestId
}) =>
  Effect.gen(function* () {
    const actorClientFactory = yield* AgentLoopActor.Context
    const ref = yield* actorClientFactory(
      entityIdOf(DefaultWorkspaceId, input.sessionId, input.branchId),
    )
    yield* ref.execute(
      AgentLoopActor.RespondInteraction.make({ ...input, workspaceId: DefaultWorkspaceId }),
    )
  })
export const makeLayer = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  tools: ReadonlyArray<ToolCapability> = [],
  resources: AnyResourceContribution[] = [],
) => {
  const deps = Layer.mergeAll(
    SqliteStorage.TestWithSql(),
    providerLayer,
    ModelResolver.fromLanguageModel(providerLayer),
    makeExtRegistry(tools, resources),
    RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    EventStore.Memory,
    ToolRunner.Test(),
    BunServices.layer,
    ResourceManagerLive,
    ModelRegistry.Test(),
    GentPlatform.Test(),
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
  return AgentLoopTestActor({ baseSections: [] }).pipe(
    Layer.provideMerge(Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live)),
  )
}
export const makeRecordingLayer = (providerLayer: Layer.Layer<LanguageModel.LanguageModel>) => {
  const recorderLayer = SequenceRecorder.Live
  const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
  const deps = Layer.mergeAll(
    SqliteStorage.TestWithSql(),
    providerLayer,
    ModelResolver.fromLanguageModel(providerLayer),
    makeExtRegistry(),
    RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
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
  return AgentLoopTestActor({ baseSections: [] }).pipe(
    Layer.provideMerge(Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live)),
  )
}
/** Scripted provider: returns stream parts from an array, one response per model stream call. */
export const scriptedProvider = (
  responses: ReadonlyArray<ReadonlyArray<LanguageModelStreamPart>>,
): Layer.Layer<LanguageModel.LanguageModel> => {
  let index = 0
  return LanguageModelLayers.testStream(() =>
    Effect.succeed(
      Stream.fromIterable(responses[index++] ?? [finishPart({ finishReason: "stop" })]),
    ),
  )
}
export const retryableStreamError = () =>
  AiError.make({
    module: "Test",
    method: "streamText",
    reason: new AiError.RateLimitError({
      retryAfter: Duration.zero,
    }),
  })
export const makeLiveToolLayer = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  tools: ReadonlyArray<ToolCapability> = [],
  resources: AnyResourceContribution[] = [],
) => {
  const extRegistry = makeExtRegistry(tools, resources)
  const baseDeps = Layer.mergeAll(
    SqliteStorage.TestWithSql(),
    providerLayer,
    ModelResolver.fromLanguageModel(providerLayer),
    extRegistry,
    RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
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
  return AgentLoopTestActor({ baseSections: [] }).pipe(
    Layer.provideMerge(Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live)),
  )
}
export const makeCountingEventStore = (eventsRef: Ref.Ref<AgentEvent[]>) =>
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
    deliver: () => Effect.void,
    publish: (event: AgentEvent) => Ref.update(eventsRef, (events) => [...events, event]),
    subscribe: () => Stream.empty,
    removeSession: () => Effect.void,
  })
export const makeLayerWithEvents = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  eventsRef: Ref.Ref<AgentEvent[]>,
  tools: ReadonlyArray<ToolCapability> = [],
) => {
  const deps = Layer.mergeAll(
    SqliteStorage.TestWithSql(),
    providerLayer,
    ModelResolver.fromLanguageModel(providerLayer),
    makeExtRegistry(tools),
    RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    makeCountingEventStore(eventsRef),
    ToolRunner.Test(),
    BunServices.layer,
    ResourceManagerLive,
    ModelRegistry.Test(),
    GentPlatform.Test(),
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
  return AgentLoopTestActor({ baseSections: [] }).pipe(
    Layer.provideMerge(Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live)),
  )
}
export const makeLayerWithEventPublisher = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  eventPublisherLayer: Layer.Layer<EventPublisher>,
) => {
  const deps = Layer.mergeAll(
    SqliteStorage.TestWithSql(),
    providerLayer,
    ModelResolver.fromLanguageModel(providerLayer),
    makeExtRegistry(),
    RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    EventStore.Memory,
    ToolRunner.Test(),
    BunServices.layer,
    ResourceManagerLive,
    ModelRegistry.Test(),
    GentPlatform.Test(),
  )
  const providedEventPublisherLayer = Layer.provide(eventPublisherLayer, deps)
  return AgentLoopTestActor({ baseSections: [] }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(deps, providedEventPublisherLayer, AgentLoopSessionGovernance.Live),
    ),
  )
}
export const parityExternalAgent = AgentDefinition.make({
  name: "test-external-parity" as never,
  driver: ExternalDriverRef.make({ id: "test-parity-driver" }),
})
export const makeExternalLayerWithEvents = (
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
  const providerLayer = LanguageModelLayers.testStream(() =>
    Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })])),
  )
  const deps = Layer.mergeAll(
    SqliteStorage.TestWithSql(),
    providerLayer,
    ModelResolver.fromLanguageModel(providerLayer),
    registryLayer,
    RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    makeCountingEventStore(eventsRef),
    ToolRunner.Test(),
    BunServices.layer,
    ResourceManagerLive,
    ModelRegistry.Test(),
    GentPlatform.Test(),
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
  return AgentLoopTestActor({ baseSections: [] }).pipe(
    Layer.provideMerge(Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live)),
  )
}
/** Poll `getState` until the phase matches, with a short sleep between attempts. */
export const waitForPhase = (
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
