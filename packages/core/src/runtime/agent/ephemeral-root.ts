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
  readonly parentServices: Context.Context<EphemeralParentServices>
  readonly overrides: EphemeralRuntimeOverrides
  readonly extensionLayers?: Layer.Layer<Provides, unknown, unknown>
}): Layer.Layer<Provides | EphemeralOverrideProvides, EphemeralOverrideError, never> => {
  const parentLayer = Layer.succeedContext(params.parentServices)
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
      : Layer.provideMerge(typedExtensionLayer, Layer.merge(parentLayer, params.overrides.storage))

  const childLayer =
    extensionLayer === undefined ? overridesLayer : Layer.merge(extensionLayer, overridesLayer)

  // Fresh memoization keeps child-owned layer constants, such as in-memory
  // SqliteClient, from aliasing the parent runtime's memoized services.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Provides plus override provides is the local composition output
  return Layer.fresh(Layer.provideMerge(childLayer, parentLayer)) as Layer.Layer<
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
export const makeEphemeralAgentRootLayer = (params: {
  readonly config: EphemeralAgentRootConfig
  readonly parentServices: Context.Context<EphemeralParentServices>
  readonly extensionRegistry: ExtensionRegistryService
}) => {
  const resolved = params.extensionRegistry.getResolved()
  const extensionLayers = buildExtensionLayers(resolved, { lifecycle: "skip" })
  const parentService = <S>(tag: Context.Key<unknown, S>): S =>
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime root owns erased generic boundary
    Context.get(params.parentServices as Context.Context<unknown>, tag)

  const parentRuntimeEnvironmentLayer = Layer.succeed(
    RuntimeEnvironment,
    parentService(RuntimeEnvironment),
  )
  const parentFileSystemLayer = Layer.succeed(
    FileSystem.FileSystem,
    parentService(FileSystem.FileSystem),
  )
  const parentPathLayer = Layer.succeed(Path.Path, parentService(Path.Path))
  const parentModelResolverLayer = Layer.succeed(ModelResolver, parentService(ModelResolver))
  const parentConfigLayer = Layer.succeed(ConfigService, parentService(ConfigService))
  const parentModelRegistryLayer = Layer.succeed(ModelRegistry, parentService(ModelRegistry))
  const parentGentPlatformLayer = Layer.succeed(GentPlatform, parentService(GentPlatform))
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

  return composeEphemeralRuntimeLayer({
    parentServices: params.parentServices,
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
  })
}
