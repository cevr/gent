import { Context, Effect, FileSystem, Layer, Path, type Config } from "effect"
import { SingleRunner } from "effect/unstable/cluster"
import type { SqlClient } from "effect/unstable/sql"
import { EventStore } from "../../domain/event.js"
import { EventPublisher, ExtensionEventSink } from "../../domain/event-publisher.js"
import type { PromptPresenter } from "../../domain/prompt-presenter.js"
import type { PromptSection } from "../../domain/prompt.js"
import type { StorageError } from "../../domain/storage-error.js"
import type { InteractionStorage } from "../../storage/interaction-storage.js"
import type { SearchStorage } from "../../storage/search-storage.js"
import type { BranchStorage } from "../../storage/branch-storage.js"
import type { EventStorage } from "../../storage/event-storage.js"
import type { MessageStorage } from "../../storage/message-storage.js"
import type { RelationshipStorage } from "../../storage/relationship-storage.js"
import type { SessionStorage } from "../../storage/session-storage.js"
import { SqliteStorage } from "../../storage/sqlite-storage.js"
import { ApprovalService } from "../approval-service.js"
import { type ExtensionRegistryService } from "../extensions/registry.js"
import { EventStoreLive } from "../event-store-live.js"
import { GentPlatform } from "../gent-platform.js"
import { ConfigService } from "../config-service.js"
import { ModelRegistry } from "../model-registry.js"
import { ModelResolver } from "../../providers/model-resolver.js"
import { buildExtensionLayers } from "../profile.js"
import { PromptPresenterLive } from "../prompt-presenter-live.js"
import { RuntimeEnvironment } from "../runtime-environment.js"
import { SessionRuntime } from "../session-runtime.js"
import { AgentLoopSessionGovernance } from "./agent-loop.session-governance.js"
import { ToolRunner } from "./tool-runner.js"

export interface EphemeralAgentRootConfig {
  readonly baseSections?: ReadonlyArray<PromptSection>
}

type EphemeralOverrideError = StorageError | Config.ConfigError

export type EphemeralParentServices =
  | RuntimeEnvironment
  | FileSystem.FileSystem
  | Path.Path
  | ModelResolver
  | ConfigService
  | ModelRegistry
  | GentPlatform

type EphemeralStorageProvides =
  | SqlClient.SqlClient
  | SessionStorage
  | BranchStorage
  | MessageStorage
  | EventStorage
  | RelationshipStorage
  | InteractionStorage
  | SearchStorage

type EphemeralOverrideProvides =
  | EphemeralStorageProvides
  | EventStore
  | EventPublisher
  | ExtensionEventSink
  | ApprovalService
  | PromptPresenter
  | ToolRunner
  | AgentLoopSessionGovernance
  | SessionRuntime

type EphemeralExtensionRequires =
  | EphemeralStorageProvides
  | RuntimeEnvironment
  | FileSystem.FileSystem
  | Path.Path
  | ModelResolver
  | ConfigService
  | ModelRegistry

export type EphemeralAgentRootLayerFactory = (params: {
  readonly config: EphemeralAgentRootConfig
  readonly extensionRegistry: ExtensionRegistryService
}) => Layer.Layer<EphemeralOverrideProvides, EphemeralOverrideError, never>

export class EphemeralAgentRootLayerFactoryService extends Context.Service<
  EphemeralAgentRootLayerFactoryService,
  EphemeralAgentRootLayerFactory
>()("@gent/core/src/runtime/agent/ephemeral-root/EphemeralAgentRootLayerFactoryService") {}

interface EphemeralRuntimeOverrides {
  readonly storage: Layer.Layer<EphemeralStorageProvides, StorageError, never>
  readonly eventStore: Layer.Layer<EventStore, EphemeralOverrideError, never>
  readonly eventPublisher: Layer.Layer<
    EventPublisher | ExtensionEventSink,
    EphemeralOverrideError,
    never
  >
  readonly approval: Layer.Layer<ApprovalService, never, never>
  readonly promptPresenter: Layer.Layer<PromptPresenter, never, never>
  readonly toolRunner: Layer.Layer<ToolRunner, never, never>
  readonly sessionGovernance: Layer.Layer<AgentLoopSessionGovernance, never, never>
  readonly sessionRuntime: Layer.Layer<SessionRuntime, EphemeralOverrideError, never>
}

const recoverExtensionLayer = <Provides>(
  layer: Layer.Layer<Provides, unknown, unknown>,
): Layer.Layer<Provides, never, EphemeralExtensionRequires> =>
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit extension-layer recovery membrane
  layer as Layer.Layer<Provides, never, EphemeralExtensionRequires> // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- explicit extension-layer recovery membrane

const composeEphemeralRuntimeLayer = <Provides>(params: {
  readonly parentLayer: Layer.Layer<EphemeralParentServices, never, never>
  readonly overrides: EphemeralRuntimeOverrides
  readonly extensionLayers?: Layer.Layer<Provides, unknown, unknown>
}): Layer.Layer<Provides | EphemeralOverrideProvides, EphemeralOverrideError, never> => {
  const overridesLayer = Layer.mergeAll(
    params.overrides.storage,
    params.overrides.eventStore,
    params.overrides.eventPublisher,
    params.overrides.approval,
    params.overrides.promptPresenter,
    params.overrides.toolRunner,
    params.overrides.sessionGovernance,
    params.overrides.sessionRuntime,
  )

  const typedExtensionLayer =
    params.extensionLayers === undefined
      ? undefined
      : // @effect-diagnostics-next-line anyUnknownInErrorContext:off — heterogeneous upstream shape feeds the recovery membrane
        recoverExtensionLayer<Provides>(params.extensionLayers)
  const extensionLayer =
    typedExtensionLayer === undefined
      ? undefined
      : Layer.provideMerge(
          typedExtensionLayer,
          Layer.merge(params.parentLayer, params.overrides.storage),
        )

  const childLayer =
    extensionLayer === undefined ? overridesLayer : Layer.merge(extensionLayer, overridesLayer)

  // Fresh memoization keeps child-owned layer constants, such as in-memory
  // SqliteClient, from aliasing the parent runtime's memoized services.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Provides plus override provides is the local composition output
  return Layer.fresh(Layer.provideMerge(childLayer, params.parentLayer)) as Layer.Layer<
    Provides | EphemeralOverrideProvides,
    EphemeralOverrideError,
    never
  >
}

/**
 * Child-run composition root.
 *
 * Reuses `buildExtensionLayers` (the same builder used by server / per-cwd) so
 * registry/resource/event-bus shape stays identical. Ephemeral children rebuild
 * resource services against child storage, skip process lifecycle, and override
 * only the child-owned runtime families.
 */
export const makeEphemeralAgentRootLayerFactory: Effect.Effect<
  EphemeralAgentRootLayerFactory,
  never,
  EphemeralParentServices
> = Effect.gen(function* () {
  const runtimeEnvironment = yield* RuntimeEnvironment
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const modelResolver = yield* ModelResolver
  const configService = yield* ConfigService
  const modelRegistry = yield* ModelRegistry
  const gentPlatform = yield* GentPlatform

  const parentRuntimeEnvironmentLayer = Layer.succeed(RuntimeEnvironment, runtimeEnvironment)
  const parentFileSystemLayer = Layer.succeed(FileSystem.FileSystem, fileSystem)
  const parentPathLayer = Layer.succeed(Path.Path, path)
  const parentModelResolverLayer = Layer.succeed(ModelResolver, modelResolver)
  const parentConfigLayer = Layer.succeed(ConfigService, configService)
  const parentModelRegistryLayer = Layer.succeed(ModelRegistry, modelRegistry)
  const parentGentPlatformLayer = Layer.succeed(GentPlatform, gentPlatform)
  const parentLayer = Layer.mergeAll(
    parentRuntimeEnvironmentLayer,
    parentFileSystemLayer,
    parentPathLayer,
    parentModelResolverLayer,
    parentConfigLayer,
    parentModelRegistryLayer,
    parentGentPlatformLayer,
  )

  return (params: {
    readonly config: EphemeralAgentRootConfig
    readonly extensionRegistry: ExtensionRegistryService
  }) => {
    const resolved = params.extensionRegistry.getResolved()
    const extensionLayers = buildExtensionLayers(resolved, { lifecycle: "skip" })
    const storageLayer = SqliteStorage.MemoryWithSql().pipe(Layer.provide(parentGentPlatformLayer))
    const clusterRunnerLayer = Layer.provide(
      SingleRunner.layer({ runnerStorage: "memory" }),
      storageLayer,
    )
    const eventStoreLayer = Layer.provide(EventStoreLive, storageLayer)
    const approvalLayer = ApprovalService.LiveAutoResolve
    const promptPresenterLayer = Layer.provide(
      PromptPresenterLive,
      Layer.mergeAll(
        approvalLayer,
        parentRuntimeEnvironmentLayer,
        parentFileSystemLayer,
        parentPathLayer,
      ),
    )

    // Ephemeral child sessions are synthetic. Persist local events so the child
    // loop can complete, but do not run local extension reduction on those ids;
    // mirrored parent observers handle the subset of child events that escapes.
    const eventPublisherLayer = Layer.effectContext(
      Effect.gen(function* () {
        const baseEventStore = yield* EventStore
        const publisher = EventPublisher.of({
          append: (event) => baseEventStore.append(event),
          deliver: (envelope) => baseEventStore.deliver(envelope),
          publish: (event) => baseEventStore.publish(event),
        })
        return Context.empty().pipe(
          Context.add(EventPublisher, publisher),
          Context.add(ExtensionEventSink, {
            publish: publisher.publish,
          }),
        )
      }),
    ).pipe(Layer.provide(eventStoreLayer))
    const toolRunnerLayer = Layer.provideMerge(
      ToolRunner.Live,
      Layer.mergeAll(approvalLayer, extensionLayers, parentRuntimeEnvironmentLayer),
    )
    const sessionGovernanceLayer = AgentLoopSessionGovernance.Live
    const sessionRuntimeLayer = SessionRuntime.Live({
      baseSections: params.config.baseSections ?? [],
    }).pipe(
      Layer.provide(
        Layer.provideMerge(
          Layer.mergeAll(
            clusterRunnerLayer,
            eventStoreLayer,
            eventPublisherLayer,
            toolRunnerLayer,
            extensionLayers,
            parentModelResolverLayer,
            parentConfigLayer,
            parentModelRegistryLayer,
            sessionGovernanceLayer,
            parentGentPlatformLayer,
          ),
          storageLayer,
        ),
      ),
    )

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extension-provided services are extra outputs; child runtime requires only override provides
    return composeEphemeralRuntimeLayer({
      parentLayer,
      overrides: {
        storage: storageLayer,
        eventStore: eventStoreLayer,
        eventPublisher: eventPublisherLayer,
        approval: approvalLayer,
        promptPresenter: promptPresenterLayer,
        toolRunner: toolRunnerLayer,
        sessionGovernance: sessionGovernanceLayer,
        sessionRuntime: sessionRuntimeLayer,
      },
      extensionLayers,
    }) as Layer.Layer<EphemeralOverrideProvides, EphemeralOverrideError, never>
  }
})
