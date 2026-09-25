import type { LanguageModel } from "effect/unstable/ai"
import { BunServices } from "@effect/platform-bun"
import { Clock, Duration, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as AiError from "effect/unstable/ai/AiError"
import {
  AgentLoop as AgentLoopActor,
  AgentLoopError,
  type FollowUpQueueFull,
  entityIdOf,
  type SessionRuntimeState,
  type StopRequester,
} from "../../src/domain/agent-loop"
import { AgentDefinition, AgentName, type Model, ModelId } from "../../src/domain/agent"
import { AgentLoopSessionGovernance, AgentLoopTestActor } from "../../src/runtime/agent-loop"
import {
  ModelRegistry,
  type ModelResolver,
  finishPart,
  type LanguageModelStreamPart,
} from "../../src/runtime/provider"
import { GentPlatform } from "../../src/runtime/gent-platform"
import {
  ApprovalService,
  ExtensionRegistry,
  resolveExtensions,
} from "../../src/runtime/extension-host"
import { ConfigService, RuntimeEnvironment } from "../../src/runtime/config"
import { noBranchTools, ToolRunner } from "../../src/runtime/tools"
import { LanguageModelLayers } from "../../src/test-utils/language-model"
import {
  dateFromMillis,
  Message,
  type QueueSnapshot,
  type SteerCommand,
  type SessionAdmission,
} from "../../src/domain/message"
import { testAgents } from "../helpers/test-preset"
import { type ToolCapability } from "@gent/core/extensions/api"
import type { AnyResourceContribution } from "../../src/domain/extension"
import { type AgentEvent, EventEnvelope, EventId, EventStore } from "../../src/domain/event"
import { BranchStorage, SessionStorage, type StorageError } from "../../src/storage/storage"
import {
  RecordingEventStore,
  SequenceRecorder,
  ensureStorageParents,
  testSqliteStorage,
} from "../../src/test-utils/harness"
import {
  type BranchId,
  type InteractionRequestId,
  type SessionId,
  ActorCommandId,
  ExtensionId,
  MessageId,
} from "../../src/domain/ids"
import { DefaultWorkspaceId } from "../../src/server/workspace-rpc"
import { omitUndefined } from "../../src/domain/guards"
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
        agents: [...testAgents, helperAgent],
        tools,
        resources,
      },
    },
  ])
  return ExtensionRegistry.fromResolved(resolved)
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
interface AgentLoopService {
  readonly runOnce: (input: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly prompt: string
  }) => Effect.Effect<
    void,
    AgentLoopError | FollowUpQueueFull | StorageError,
    BranchStorage | SessionStorage
  >
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
        yield* ref.execute(
          AgentLoopActor.SubmitAndWait.make({ workspaceId: DefaultWorkspaceId, message }),
        )
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
  /** The agent the session runs as; set when the test's first turn creates it. */
  admission?: SessionAdmission,
) =>
  ensureStorageParents({
    sessionId: message.sessionId,
    branchId: message.branchId,
    ...omitUndefined({ admission }),
  }).pipe(
    Effect.flatMap(() =>
      Effect.gen(function* () {
        const actorClientFactory = yield* AgentLoopActor.Context
        const ref = yield* actorClientFactory(
          entityIdOf(DefaultWorkspaceId, message.sessionId, message.branchId),
        )
        yield* ref.execute(
          AgentLoopActor.SubmitAndWait.make({ workspaceId: DefaultWorkspaceId, message }),
        )
      }),
    ),
  )
export const submitAgentLoop = (
  _agentLoop: AgentLoopService,
  message: Message,
  /** The agent the session runs as; set when the test's first turn creates it. */
  admission?: SessionAdmission,
) =>
  ensureStorageParents({
    sessionId: message.sessionId,
    branchId: message.branchId,
    ...omitUndefined({ admission }),
  }).pipe(
    Effect.flatMap(() =>
      Effect.gen(function* () {
        const actorClientFactory = yield* AgentLoopActor.Context
        const ref = yield* actorClientFactory(
          entityIdOf(DefaultWorkspaceId, message.sessionId, message.branchId),
        )
        yield* ref.execute(AgentLoopActor.Submit.make({ workspaceId: DefaultWorkspaceId, message }))
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
/** Stop what one message opens; true when the stop reached it. */
export const stopAgentLoopMessage = (input: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly messageId: MessageId
  readonly requestId: string
  /** The asking branch; a raw client stop names none. */
  readonly requester?: StopRequester
}) =>
  Effect.gen(function* () {
    yield* ensureAgentLoopStorageParents(input)
    const actorClientFactory = yield* AgentLoopActor.Context
    const ref = yield* actorClientFactory(
      entityIdOf(DefaultWorkspaceId, input.sessionId, input.branchId),
    )
    return yield* ref.execute(
      AgentLoopActor.StopMessage.make({
        workspaceId: DefaultWorkspaceId,
        sessionId: input.sessionId,
        branchId: input.branchId,
        commandId: ActorCommandId.make(input.requestId),
        messageId: input.messageId,
        requester: input.requester,
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
/** Where a test root's turns get their model: a scripted stream, or a resolver over drivers. */
type ActorTestModel =
  | { readonly provider: Layer.Layer<LanguageModel.LanguageModel> }
  | { readonly resolver: Layer.Layer<ModelResolver> }

const actorTestModelLayer = (model: ActorTestModel) => {
  if ("resolver" in model) return model.resolver
  return Layer.merge(model.provider, LanguageModelLayers.resolver(model.provider))
}

/**
 * The actor test root: the loop actor over real storage, an in-memory event
 * store and the test registry. Each option replaces one piece; `overrides`
 * merges last, so it wins over any service the root already provides.
 */
export const actorTestRoot = <S = never, ES = never, X = never, EX = never>(
  params: ActorTestModel & {
    readonly storage?: Layer.Layer<S, ES>
    readonly overrides?: Layer.Layer<X, EX>
    readonly registry?: Layer.Layer<ExtensionRegistry>
    readonly eventStore?: Layer.Layer<EventStore>
    readonly models?: ReadonlyArray<Model>
    readonly toolRunner?: typeof ToolRunner.Live
  },
) => {
  const baseDeps = Layer.mergeAll(
    params.storage ?? testSqliteStorage(noBranchTools.storage, noBranchTools.migrations),
    actorTestModelLayer(params),
    params.registry ?? makeExtRegistry(),
    RuntimeEnvironment.Live({ cwd: "/tmp", home: "/nonexistent/gent-test-home" }),
    ConfigService.Test(),
    params.eventStore ?? EventStore.Memory,
    ApprovalService.Test(),
    BunServices.layer,
    ModelRegistry.Test(params.models),
    GentPlatform.Test(),
    params.overrides ?? Layer.empty,
  )
  const deps = Layer.mergeAll(
    baseDeps,
    Layer.provide(params.toolRunner ?? ToolRunner.Test(), baseDeps),
  )
  return AgentLoopTestActor({ baseSections: [] }).pipe(
    Layer.provideMerge(Layer.mergeAll(deps, AgentLoopSessionGovernance.Live)),
  )
}
export const makeLayer = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  tools: ReadonlyArray<ToolCapability> = [],
  resources: AnyResourceContribution[] = [],
) => actorTestRoot({ provider: providerLayer, registry: makeExtRegistry(tools, resources) })
export const makeRecordingLayer = (providerLayer: Layer.Layer<LanguageModel.LanguageModel>) => {
  const recorderLayer = SequenceRecorder.Live
  return actorTestRoot({
    provider: providerLayer,
    eventStore: RecordingEventStore.pipe(Layer.provide(recorderLayer)),
    overrides: recorderLayer,
  })
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
  eventStoreLayer: Layer.Layer<EventStore> = EventStore.Memory,
) =>
  actorTestRoot({
    provider: providerLayer,
    registry: makeExtRegistry(tools, resources),
    eventStore: eventStoreLayer,
    toolRunner: ToolRunner.Live,
  })
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
) =>
  actorTestRoot({
    provider: providerLayer,
    registry: makeExtRegistry(tools),
    eventStore: makeCountingEventStore(eventsRef),
  })
/** The actor root over a substitute event store, for a test about a failing append or delivery. */
export const makeLayerWithEventStore = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  eventStoreLayer: Layer.Layer<EventStore>,
) => actorTestRoot({ provider: providerLayer, eventStore: eventStoreLayer })
/** A `waitFor` deadline expiring. Typed so a timeout fails its own test. */
class AgentLoopTestTimeout extends Schema.TaggedError<AgentLoopTestTimeout>()(
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
