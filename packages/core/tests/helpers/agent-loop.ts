import type { LanguageModel } from "effect/ai"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer, type Ref } from "effect"
import * as Prompt from "effect/ai/Prompt"
import {
  AgentLoop as AgentLoopActor,
  AgentLoopError,
  entityIdOf,
  type SessionRuntimeState,
} from "../../src/domain/agent-loop"
import { AgentDefinition, AgentName, type Model, ModelId } from "../../src/domain/agent"
import { AgentLoopSessionGovernance, AgentLoopTestActor } from "../../src/runtime/agent-loop"
import {
  Auth,
  DecisionModelResolver,
  ModelRegistry,
  type ModelResolver,
} from "../../src/runtime/provider"
import { GentPlatform } from "../../src/runtime/gent-platform"
import {
  ApprovalService,
  ExtensionRegistry,
  resolveExtensions,
} from "../../src/runtime/extension-host"
import { ConfigService, RuntimeEnvironment } from "../../src/runtime/config"
import { ToolRunner } from "../../src/runtime/tools"
import {
  dateFromMillis,
  Message,
  type QueueSnapshot,
  type RequesterBranch,
  type SteerCommand,
  type SessionAdmission,
} from "../../src/domain/message"
import { testAgents } from "./test-preset"
import { type ToolCapability } from "@gent/core/extensions/api"
import type { AnyResourceContribution } from "../../src/domain/extension"
import { type AgentEvent, EventStore } from "../../src/domain/event"
import { BranchStorage, SessionStorage } from "../../src/storage/storage"
import {
  ensureStorageParents,
  fixedSessionProfiles,
  fixtureModelCatalogSource,
  LanguageModelLayers,
  recordingEventStore,
  testSqliteStorage,
  waitFor,
} from "../../src/test-utils/harness"
import {
  type BranchId,
  type InteractionRequestId,
  type SessionId,
  ActorCommandId,
  ExtensionId,
  MessageId,
  DefaultWorkspaceId,
} from "../../src/domain/ids"
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
    ensureAgentLoopStorageParents(input).pipe(
      Effect.provideService(SessionStorage, sessionStorage),
      Effect.provideService(BranchStorage, branchStorage),
    )
  return {
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
/** `sender` is the other branch an `Interject` came from; a client's steer names none. */
export const steerAgentLoop = (command: SteerCommand, sender?: RequesterBranch) =>
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
        sender,
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
  readonly requester?: RequesterBranch
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
 * store and the test registry. Every cwd's profile serves that registry, as
 * the launch profile does in production. Each option replaces one piece;
 * `overrides` merges last, so it wins over any service the root already
 * provides.
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
  const registry = params.registry ?? makeExtRegistry()
  const baseDeps = Layer.mergeAll(
    params.storage ?? testSqliteStorage,
    actorTestModelLayer(params),
    registry,
    fixedSessionProfiles(new Map(), registry),
    RuntimeEnvironment.Live({
      cwd: "/nonexistent/gent-test-cwd",
      home: "/nonexistent/gent-test-home",
    }),
    ConfigService.Test(),
    params.eventStore ?? EventStore.Memory,
    ApprovalService.Test(),
    BunServices.layer,
    ModelRegistry.Test(params.models),
    DecisionModelResolver.Live.pipe(
      Layer.provide(Auth.Test()),
      Layer.provide(fixtureModelCatalogSource),
    ),
    GentPlatform.Test(),
    params.overrides ?? Layer.empty,
  )
  const deps = Layer.mergeAll(
    baseDeps,
    Layer.provide(params.toolRunner ?? ToolRunner.Test(), baseDeps),
  )
  return AgentLoopTestActor.pipe(
    Layer.provideMerge(Layer.mergeAll(deps, AgentLoopSessionGovernance.Live)),
  )
}
export const makeLayer = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  tools: ReadonlyArray<ToolCapability> = [],
  resources: AnyResourceContribution[] = [],
) => actorTestRoot({ provider: providerLayer, registry: makeExtRegistry(tools, resources) })
export const makeLayerWithEvents = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  eventsRef: Ref.Ref<AgentEvent[]>,
  tools: ReadonlyArray<ToolCapability> = [],
) =>
  actorTestRoot({
    provider: providerLayer,
    registry: makeExtRegistry(tools),
    eventStore: recordingEventStore(eventsRef),
  })
/** The actor root over a substitute event store, for a test about a failing append or delivery. */
export const makeLayerWithEventStore = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  eventStoreLayer: Layer.Layer<EventStore>,
) => actorTestRoot({ provider: providerLayer, eventStore: eventStoreLayer })
/** Poll the loop's state until its phase is `runtimeTag`. */
export const waitForPhase = (
  agentLoop: AgentLoopService,
  params: {
    sessionId: SessionId
    branchId: BranchId
  },
  runtimeTag: SessionRuntimeState["_tag"],
  timeout: Duration.Input = "5 seconds",
) =>
  waitFor(
    agentLoop.getState(params),
    (state) => state._tag === runtimeTag,
    Duration.toMillis(timeout),
    `runtime state "${runtimeTag}"`,
  )
// ============================================================================
