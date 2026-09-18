import type { LanguageModel } from "effect/unstable/ai"
import { BunServices } from "@effect/platform-bun"
import { Predicate, Clock, Duration, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as AiError from "effect/unstable/ai/AiError"
import {
  AgentLoopError,
  type SessionRuntimeState,
} from "../../../src/runtime/agent/agent-loop.state"
import {
  AgentDefinition,
  AgentName,
  ExternalDriverRef,
  ModelId,
  type RunSpec,
  type SteerCommand,
} from "../../../src/domain/agent"
import {
  AgentLoop as AgentLoopActor,
  AgentLoopTestActor,
} from "../../../src/runtime/agent/agent-loop.actor"
import { AgentLoopSessionGovernance } from "../../../src/runtime/agent/agent-loop.session-governance"
import { entityIdOf } from "../../../src/runtime/agent/agent-loop.entity-id"
import { ModelRegistry } from "../../../src/runtime/model-registry"
import { GentPlatform } from "../../../src/runtime/gent-platform"
import { ExtensionRegistry, resolveExtensions } from "../../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../../src/runtime/extensions/driver-registry"
import { RuntimeEnvironment } from "../../../src/runtime/runtime-environment"
import { ConfigService } from "../../../src/runtime/config-service"
import { noBranchTools, ToolRunner } from "../../../src/runtime/agent/tools"
import {
  finishPart,
  LanguageModelLayers,
  type LanguageModelStreamPart,
} from "../../../src/test-utils/language-model"
import { ModelResolver } from "../../../src/providers/model-resolver"
import { dateFromMillis, Message, type QueueSnapshot } from "../../../src/domain/message"
import { AllBuiltinAgents } from "../../../../extensions/tests/helpers/builtin-agents.js"
import { type ToolCapability } from "@gent/core/extensions/api"
import type { AnyResourceContribution } from "../../../src/domain/extension"
import {
  type AgentEvent,
  EventEnvelope,
  EventId,
  type EventPublisher,
  EventPublisherLive,
  EventStore,
} from "../../../src/domain/event"
import { ApprovalService } from "../../../src/runtime/approval-service"
import { SqliteStorage, type StorageError } from "../../../src/storage/sqlite-storage"
import { BranchStorage } from "../../../src/storage/branch-storage"
import { SessionStorage } from "../../../src/storage/session-storage"
import {
  RecordingEventStore,
  SequenceRecorder,
  ensureStorageParents,
} from "../../../src/test-utils"
import type { BranchId, InteractionRequestId, SessionId } from "../../../src/domain/ids"
import { ActorCommandId, ExtensionId, MessageId } from "../../../src/domain/ids"
import type { TurnStreamPart } from "../../../src/domain/driver"
import { DefaultWorkspaceId } from "../../../src/server/workspace-rpc"
// ============================================================================
// Shared helpers
// ============================================================================

/** A second registered agent for tests that switch or override the current agent. */
export const helperAgent = AgentDefinition.make({
  name: AgentName.make("helper"),
  model: ModelId.make("openai/gpt-5.4-mini"),
})

export const makeExtRegistry = (
  tools: ReadonlyArray<ToolCapability> = [],
  resources: AnyResourceContribution[] = [],
) => {
  const resolved = resolveExtensions([
    {
      manifest: { id: ExtensionId.make("agents") },
      scope: "builtin",
      sourcePath: "test",
      contributions: {
        agents: [...AllBuiltinAgents, helperAgent],
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
const ensureAgentLoopStorageParents = (input: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}) =>
  ensureStorageParents(input).pipe(
    Effect.mapError(
      (cause) =>
        new AgentLoopError({
          message: `Failed to ensure storage parents for ${input.sessionId}/${input.branchId}`,
          cause,
        }),
    ),
  )
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
  const sessionStorage = yield* SessionStorage
  const branchStorage = yield* BranchStorage
  const refFor = (sessionId: SessionId, branchId: BranchId) =>
    actorClientFactory(entityIdOf(DefaultWorkspaceId, sessionId, branchId))
  const ensureParents = (input: { readonly sessionId: SessionId; readonly branchId: BranchId }) =>
    ensureStorageParents(input).pipe(
      Effect.provideService(SessionStorage, sessionStorage),
      Effect.provideService(BranchStorage, branchStorage),
      Effect.mapError(
        (cause) =>
          new AgentLoopError({
            message: `Failed to ensure storage parents for ${input.sessionId}/${input.branchId}`,
            cause,
          }),
      ),
    )
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
        let payload = {
          workspaceId: DefaultWorkspaceId,
          message,
          agentOverride: input.agentName,
          // Actor operation payloads require optional fields explicitly.
          // oxlint-disable-next-line effect/noNullish -- Actor operation payload requires this optional field explicitly.
          runSpec: input.runSpec,
          // oxlint-disable-next-line effect/noNullish -- Actor operation payload requires this optional field explicitly.
          interactive: input.interactive,
        }
        if (Predicate.isNotUndefined(input.runSpec))
          payload = { ...payload, runSpec: input.runSpec }
        if (Predicate.isNotUndefined(input.interactive))
          payload = { ...payload, interactive: input.interactive }
        yield* ref.execute(AgentLoopActor.SubmitAndWait.make(payload))
      }),
    getQueue: (input) =>
      Effect.gen(function* () {
        yield* ensureParents(input)
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
        yield* ensureParents(input)
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
        const payload = {
          workspaceId: DefaultWorkspaceId,
          message,
          // Actor operation payloads require optional fields explicitly.
          // oxlint-disable-next-line effect/noNullish -- Actor operation payload requires this optional field explicitly.
          agentOverride: options?.agentOverride,
          // oxlint-disable-next-line effect/noNullish -- Actor operation payload requires this optional field explicitly.
          runSpec: options?.runSpec,
          // oxlint-disable-next-line effect/noNullish -- Actor operation payload requires this optional field explicitly.
          interactive: options?.interactive,
        }
        yield* ref.execute(AgentLoopActor.SubmitAndWait.make(payload))
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
        const payload = {
          workspaceId: DefaultWorkspaceId,
          message,
          // Actor operation payloads require optional fields explicitly.
          // oxlint-disable-next-line effect/noNullish -- Actor operation payload requires this optional field explicitly.
          agentOverride: options?.agentOverride,
          // oxlint-disable-next-line effect/noNullish -- Actor operation payload requires this optional field explicitly.
          runSpec: options?.runSpec,
          // oxlint-disable-next-line effect/noNullish -- Actor operation payload requires this optional field explicitly.
          interactive: options?.interactive,
        }
        yield* ref.execute(AgentLoopActor.Submit.make(payload))
      }),
    ),
  )
export const steerAgentLoop = (command: SteerCommand) =>
  Effect.gen(function* () {
    yield* ensureAgentLoopStorageParents(command)
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
    yield* ensureAgentLoopStorageParents(input)
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
    SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
    providerLayer,
    ModelResolver.fromLanguageModel(providerLayer),
    makeExtRegistry(tools, resources),
    RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    EventStore.Memory,
    ToolRunner.Test(),
    ApprovalService.Test(),
    BunServices.layer,
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
    SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
    providerLayer,
    ModelResolver.fromLanguageModel(providerLayer),
    makeExtRegistry(),
    RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    ToolRunner.Test(),
    ApprovalService.Test(),
    BunServices.layer,
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
    SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
    providerLayer,
    ModelResolver.fromLanguageModel(providerLayer),
    extRegistry,
    RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    EventStore.Memory,
    ApprovalService.Test(),
    BunServices.layer,
    ModelRegistry.Test(),
    GentPlatform.Test(),
  )
  const deps = Layer.mergeAll(baseDeps, Layer.provide(ToolRunner.Live, baseDeps))
  const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
  const actorLayer = AgentLoopTestActor({ baseSections: [] }).pipe(
    Layer.provideMerge(Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live)),
  )
  return actorLayer
}
export const makeCountingEventStore = (eventsRef: Ref.Ref<AgentEvent[]>) =>
  Layer.effect(
    EventStore,
    Effect.gen(function* () {
      const idRef = yield* Ref.make(0)
      return EventStore.of({
        append: (event: AgentEvent) =>
          Effect.gen(function* () {
            const id = yield* Ref.modify(idRef, (n) => [n + 1, n + 1])
            yield* Ref.update(eventsRef, (events) => [...events, event])
            return EventEnvelope.make({
              id: EventId.make(id),
              event,
              createdAt: yield* Clock.currentTimeMillis,
            })
          }),
        deliver: () => Effect.void,
        publish: (event: AgentEvent) => Ref.update(eventsRef, (events) => [...events, event]),
        subscribe: () => Stream.empty,
        removeSession: () => Effect.void,
      })
    }),
  )
export const makeLayerWithEvents = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  eventsRef: Ref.Ref<AgentEvent[]>,
  tools: ReadonlyArray<ToolCapability> = [],
) => {
  const deps = Layer.mergeAll(
    SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
    providerLayer,
    ModelResolver.fromLanguageModel(providerLayer),
    makeExtRegistry(tools),
    RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    makeCountingEventStore(eventsRef),
    ToolRunner.Test(),
    ApprovalService.Test(),
    BunServices.layer,
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
    SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
    providerLayer,
    ModelResolver.fromLanguageModel(providerLayer),
    makeExtRegistry(),
    RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    EventStore.Memory,
    ToolRunner.Test(),
    ApprovalService.Test(),
    BunServices.layer,
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
  name: AgentName.make("test-external-parity"),
  driver: ExternalDriverRef.make({ id: "test-parity-driver" }),
})
export const makeExternalLayerWithEvents = (
  responseParts: ReadonlyArray<TurnStreamPart>,
  eventsRef: Ref.Ref<AgentEvent[]>,
) => {
  const resolved = resolveExtensions([
    {
      manifest: { id: ExtensionId.make("agents") },
      scope: "builtin",
      sourcePath: "test",
      contributions: {
        agents: AllBuiltinAgents,
      },
    },
    {
      manifest: { id: ExtensionId.make("external-parity") },
      scope: "builtin",
      sourcePath: "test",
      contributions: {
        agents: [parityExternalAgent],
        externalDrivers: [
          {
            id: "test-parity-driver",
            executor: {
              executeTurn: () => Stream.fromIterable(responseParts),
            },
            invalidate: Effect.void,
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
    SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
    providerLayer,
    ModelResolver.fromLanguageModel(providerLayer),
    registryLayer,
    RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    makeCountingEventStore(eventsRef),
    ToolRunner.Test(),
    ApprovalService.Test(),
    BunServices.layer,
    ModelRegistry.Test(),
    GentPlatform.Test(),
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
  return AgentLoopTestActor({ baseSections: [] }).pipe(
    Layer.provideMerge(Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live)),
  )
}
/** A `waitFor` deadline expiring. Typed so a timeout fails its own test. */
export class AgentLoopTestTimeout extends Schema.TaggedError<AgentLoopTestTimeout>()(
  "@gent/core/tests/runtime/agent-loop/AgentLoopTestTimeout",
  { description: Schema.String, timeoutMs: Schema.Finite },
) {}

/**
 * Poll `check` until it yields a value, or the deadline passes.
 *
 * Bounded by wall clock rather than a fixed number of attempts: an attempt
 * budget is not a timeout. Under load each iteration takes far longer than the
 * sleep between them, so a 50-attempt budget expires in milliseconds on an idle
 * machine and in seconds on a busy one — which made this helper give up early
 * whenever the suite ran alongside a build.
 *
 * Fails rather than dies, so a timeout surfaces as the failing test's own error
 * instead of escaping as an unhandled defect if the fiber outlives the test.
 */
export const waitFor = <A, E, R>(
  check: () => Effect.Effect<Option.Option<A>, E, R>,
  description: string,
  timeout: Duration.Input = "5 seconds",
) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(timeout)
    for (;;) {
      const result = yield* check()
      if (Option.isSome(result)) return result.value
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* new AgentLoopTestTimeout({
          description,
          timeoutMs: Duration.toMillis(timeout),
        })
      }
      // gent/no-sleep: allow polling primitive — this IS the waitFor helper other tests use instead of sleep
      yield* Effect.sleep("1 millis")
    }
  })

export const waitForPhase = (
  agentLoop: AgentLoopService,
  params: {
    sessionId: SessionId
    branchId: BranchId
  },
  runtimeTag: string,
  timeout: Duration.Input = "5 seconds",
) =>
  waitFor(
    () =>
      Effect.gen(function* () {
        const state = yield* agentLoop.getState(params)
        if (state._tag === runtimeTag) {
          return Option.some(state)
        }
        return Option.none()
      }),
    `runtime state "${runtimeTag}"`,
    timeout,
  )
// ============================================================================
