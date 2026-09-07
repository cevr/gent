import { Predicate, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { SingleRunner } from "effect/unstable/cluster"
import { FetchHttpClient } from "effect/unstable/http"
import type { LanguageModel } from "effect/unstable/ai"
import { ChildProcessSpawner as ProcessSpawner } from "effect/unstable/process"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { AgentRunnerService } from "../domain/agent.js"
import type { AgentRunnerConfig } from "../runtime/agent/agent-runner.js"
import { Auth, AuthGuard } from "../domain/auth.js"
import { DynamicExtensionRegistry } from "../domain/dynamic-extension-registry.js"
import { EventStore, EventStoreError } from "../domain/event.js"
import { EventPublisherLive, type EventPublisher } from "../domain/event-publisher.js"
import type { PromptSection } from "../domain/prompt.js"
import { CanonicalCwd } from "../domain/resource-graph-state.js"
import type { ResourceGraphStatusState } from "../domain/resource-graph-state.js"
import { FileLockService } from "../domain/file-lock.js"
import type { Permission } from "../domain/permission.js"
import { PromptPresenterLive } from "../runtime/prompt-presenter-live.js"
import type { GentExtension } from "../domain/extension.js"
import { GentPlatform } from "../runtime/gent-platform.js"
import { ModelResolver } from "../providers/model-resolver.js"
import { ProviderAuth } from "../providers/provider-auth.js"
import { DebugSlowLanguageModelDelayMs, LanguageModelLayers } from "../test-utils/language-model.js"
import { ApprovalService } from "../runtime/approval-service.js"
import { InProcessRunner } from "../runtime/agent/agent-runner.js"
import { AgentLoopLiveActor } from "../runtime/agent/agent-loop.actor.js"
import { AgentLoopSessionGovernance } from "../runtime/agent/agent-loop.session-governance.js"
import { ToolRunner } from "../runtime/agent/tool-runner.js"
import { ConfigService } from "../runtime/config-service.js"
import { SessionRuntime } from "../runtime/session-runtime.js"
import { type ScheduledJobCommand } from "../runtime/extensions/resource-host/schedule-engine.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { RuntimeEnvironment } from "../runtime/runtime-environment.js"
import { SqliteStorage } from "../storage/sqlite-storage.js"
import { InteractionStorage } from "../storage/interaction-storage.js"
import { CellToolOperationStorage } from "../storage/cell-tool-operation-storage.js"
import { CurrentCellToolOperation } from "../runtime/code-cell/current-cell-tool-operation.js"
import { ResourceGraphStorage } from "../storage/resource-graph-storage.js"
import {
  decodeInteractionDecision,
  decodeInteractionParams,
  type ApprovalDecision,
} from "../domain/interaction-request.js"
import { EventStoreLive } from "../runtime/event-store-live.js"
import { SessionCommands } from "./session-commands.js"
import { SessionProfileCache } from "../runtime/session-profile.js"
import {
  ResourceGraphCommandService,
  ResourceGraphDispatch,
  ResourceGraphOwnerUnavailableError,
} from "../runtime/extensions/resource-host/resource-graph-command.js"
import {
  ResourceGraphActorLive,
  ResourceGraphApplyError,
  ResourceGraphDesiredApplier,
} from "../runtime/extensions/resource-host/resource-graph-entity.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { DriverRegistry } from "../runtime/extensions/driver-registry.js"
import { FileIndexLive, type FileIndex } from "../runtime/file-index/index.js"
import { ProcessRunnerLive } from "../utils/run-process.js"
import { CurrentWorkspaceId, WorkspaceId } from "./workspace-rpc.js"

export interface DependencyOverrides {
  readonly eventStoreMode?: "default" | "storage-backed" | "memory"
  readonly authLayer?: Layer.Layer<Auth>
  readonly approvalLayer?: Layer.Layer<ApprovalService, never, EventPublisher | GentPlatform>
  readonly configServiceLayer?: Layer.Layer<ConfigService>
  readonly modelRegistryLayer?: Layer.Layer<ModelRegistry>
  readonly permissionLayer?: Layer.Layer<Permission>
  readonly toolRunnerLayer?: Layer.Layer<ToolRunner>
  readonly agentRunnerLayer?: Layer.Layer<AgentRunnerService>
  readonly sessionProfileCacheLayer?: Layer.Layer<SessionProfileCache>
  readonly fileIndexLayer?: Layer.Layer<FileIndex>
  readonly extraLayers?: ReadonlyArray<Layer.Layer<never>>
}

/**
 * Wiring contract failure — fires only when a Layer that depends on a
 * pre-resolved seed (the launch SessionProfile or base prompt sections)
 * is materialized before the resolver Layer that populates the seed.
 *
 * In a correctly wired composition this is unreachable; surfacing it as
 * a typed error means the failure channel of the bootstrap layer carries
 * an explicit `BootstrapError` instead of an opaque defect.
 */
export class BootstrapError extends Schema.TaggedError<BootstrapError>()("BootstrapError", {
  seed: Schema.Literals(["launchSessionProfile", "baseSections"]),
}) {
  override get message(): string {
    if (this.seed === "launchSessionProfile") {
      return "Launch session profile seed was not initialized"
    }
    return "Base prompt sections were not initialized"
  }
}

export interface DependenciesConfig {
  cwd: string
  home: string
  platform: string
  shell?: string
  osVersion?: string
  dbPath?: string
  /**
   * Directory for the on-disk auth store. One URL-encoded file per
   * provider. Defaults to `${home}/.gent/auth`.
   */
  authDirectory?: string
  persistenceMode?: "disk" | "memory"
  providerMode?: "live" | "debug-scripted" | "debug-failing" | "debug-slow"
  disabledExtensions?: ReadonlyArray<string>
  scheduledJobCommand?: ScheduledJobCommand
  /** Language model layer override. When set, bypasses providerMode string and uses this layer directly.
   *  Must be a fully-provided layer (no requirements, no errors). */
  languageModelLayerOverride?: Layer.Layer<LanguageModel.LanguageModel, never, never>
  /** Extensions to load. Composition roots pass this in. */
  extensions: ReadonlyArray<GentExtension<ChildProcessSpawner | GentPlatform>>
  /** Internal composition-root knobs used by tests to preset the production root. */
  overrides?: DependencyOverrides
}

interface ScheduledJobEnvironment {
  [key: string]: string
}

type ScheduledJobEnvironmentEntry = readonly [string, Option.Option<string>]

const scheduledJobEnv = (config: DependenciesConfig): ScheduledJobEnvironment => {
  const env: ScheduledJobEnvironment = { HOME: config.home }
  const entries: ReadonlyArray<ScheduledJobEnvironmentEntry> = [
    ["SHELL", Option.fromNullishOr(config.shell)],
    ["GENT_DB_PATH", Option.fromNullishOr(config.dbPath)],
    ["GENT_AUTH_DIRECTORY", Option.fromNullishOr(config.authDirectory)],
    ["GENT_PERSISTENCE_MODE", Option.fromNullishOr(config.persistenceMode)],
    ["GENT_PROVIDER_MODE", Option.fromNullishOr(config.providerMode)],
  ]
  for (const [key, value] of entries) {
    if (Option.isSome(value)) env[key] = value.value
  }
  return env
}

const makeBaseEventStoreLayer = (
  eventStoreMode: Option.Option<NonNullable<DependencyOverrides["eventStoreMode"]>>,
) => {
  if (Option.isSome(eventStoreMode) && eventStoreMode.value === "memory") return EventStore.Memory
  // Snapshots and event replay must share a cursor, including in-memory SQLite.
  return EventStoreLive
}

const childProcessSpawnerLive = Layer.effect(
  ProcessSpawner.ChildProcessSpawner,
  Effect.service(ProcessSpawner.ChildProcessSpawner),
)

const platformServicesLive = Layer.provideMerge(
  Layer.mergeAll(
    Layer.effect(FileSystem.FileSystem, Effect.service(FileSystem.FileSystem)),
    Layer.effect(Path.Path, Effect.service(Path.Path)),
    ProcessRunnerLive,
    Layer.effect(GentPlatform, Effect.service(GentPlatform)),
  ),
  childProcessSpawnerLive,
)

const makeStorageLayer = (config: DependenciesConfig, persistenceMode: "disk" | "memory") => {
  if (persistenceMode === "memory") return SqliteStorage.MemoryWithSql()
  const dbPath = Option.getOrElse(Option.fromUndefinedOr(config.dbPath), () => ".gent/data.db")
  return SqliteStorage.LiveWithSql(dbPath)
}

const makeClusterRunnerLayer = (persistenceMode: "disk" | "memory") => {
  let runnerStorage: "memory" | "sql" = "sql"
  if (persistenceMode === "memory") runnerStorage = "memory"
  return SingleRunner.layer({ runnerStorage })
}

const makeAuthLayer = (config: DependenciesConfig, authDirectory: string) => {
  const override = config.overrides?.authLayer
  if (!Predicate.isUndefined(override)) return override
  return Auth.Live(authDirectory)
}

const makeConfigServiceLayer = (
  config: DependenciesConfig,
  runtimeEnvironmentLive: Layer.Layer<RuntimeEnvironment>,
) => {
  const override = config.overrides?.configServiceLayer
  if (!Predicate.isUndefined(override)) return override
  return Layer.provide(ConfigService.Live, runtimeEnvironmentLive)
}

const makeModelRegistryLayer = <A, E, R>(
  config: DependenciesConfig,
  liveDeps: Layer.Layer<A, E, R>,
) => {
  const override = config.overrides?.modelRegistryLayer
  if (!Predicate.isUndefined(override)) return override
  return Layer.provide(ModelRegistry.Live, liveDeps)
}

const makeModelResolverLayer = <A, E, R>(
  config: DependenciesConfig,
  providerMode: NonNullable<DependenciesConfig["providerMode"]>,
  authDeps: Layer.Layer<A, E, R>,
) => {
  if (!Predicate.isUndefined(config.languageModelLayerOverride)) {
    return ModelResolver.fromLanguageModel(config.languageModelLayerOverride)
  }
  if (providerMode === "debug-scripted") {
    return ModelResolver.fromLanguageModel(LanguageModelLayers.debug())
  }
  if (providerMode === "debug-failing") {
    return ModelResolver.fromLanguageModel(LanguageModelLayers.failing)
  }
  if (providerMode === "debug-slow") {
    return ModelResolver.fromLanguageModel(
      LanguageModelLayers.debug({ delayMs: DebugSlowLanguageModelDelayMs }),
    )
  }
  return Layer.provide(ModelResolver.Live, authDeps)
}

const makeToolRunnerLayer = <A, E, R>(
  override: Option.Option<NonNullable<DependencyOverrides["toolRunnerLayer"]>>,
  liveDeps: Layer.Layer<A, E, R>,
) => Option.getOrElse(override, () => Layer.provide(ToolRunner.Live, liveDeps))

const optionalPermissionLayer = (
  override: Option.Option<NonNullable<DependencyOverrides["permissionLayer"]>>,
) =>
  Option.match(override, {
    onNone: () => [],
    onSome: (value) => [value],
  })

const makeFileIndexLayer = (
  override: Option.Option<NonNullable<DependencyOverrides["fileIndexLayer"]>>,
  runtimeEnvironmentLive: Layer.Layer<RuntimeEnvironment>,
) => Option.getOrElse(override, () => Layer.provide(FileIndexLive, runtimeEnvironmentLive))

const makeApprovalServiceLayer = <A, E, R>(
  override: Option.Option<NonNullable<DependencyOverrides["approvalLayer"]>>,
  baseServicesLive: Layer.Layer<A, E, R>,
) => {
  if (Option.isSome(override)) {
    return Layer.provide(override.value, baseServicesLive)
  }
  return Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const store = yield* InteractionStorage
        const operations = yield* CellToolOperationStorage
        return ApprovalService.LiveWithStorage({
          persist: (record) =>
            Effect.gen(function* () {
              const operation = yield* Effect.serviceOption(CurrentCellToolOperation)
              if (Option.isSome(operation)) {
                yield* operations.suspend(operation.value, record)
              } else {
                yield* store.persist(record)
              }
            }).pipe(
              Effect.asVoid,
              Effect.mapError(
                (cause) =>
                  new EventStoreError({
                    message: "Failed to persist interaction request",
                    cause,
                  }),
              ),
            ),
          resolve: (requestId) =>
            store.resolve(requestId).pipe(Effect.catchEager(() => Effect.void)),
          decide: (requestId, decisionJson) =>
            store.decide(requestId, decisionJson).pipe(
              Effect.mapError(
                (cause) =>
                  new EventStoreError({
                    message: "Failed to persist interaction decision",
                    cause,
                  }),
              ),
            ),
        })
      }),
    ),
    baseServicesLive,
  )
}

const makeSessionProfileCacheLayer = <A, E, R>(
  config: DependenciesConfig,
  resolverDeps: Layer.Layer<A, E, R>,
) => {
  const override = config.overrides?.sessionProfileCacheLayer
  if (!Predicate.isUndefined(override)) {
    // Test profile overrides do not own a live graph host. Keep the required
    // service explicit so a durable graph command fails with a typed reason.
    const unsupportedApplier = Layer.succeed(
      ResourceGraphDesiredApplier,
      ResourceGraphDesiredApplier.of({
        prepare: () =>
          Effect.fail(
            new ResourceGraphApplyError({
              phase: "prepare",
              message: "SessionProfileCache override does not support durable graph application",
            }),
          ),
        validate: () =>
          Effect.fail(
            new ResourceGraphApplyError({
              phase: "validate",
              message: "SessionProfileCache override does not support durable graph application",
            }),
          ),
        applyDesired: () =>
          Effect.fail(
            new ResourceGraphApplyError({
              phase: "apply",
              message: "SessionProfileCache override does not support durable graph application",
            }),
          ),
      }),
    )
    return Layer.provideMerge(unsupportedApplier, override)
  }
  return Layer.provide(
    SessionProfileCache.Live({
      home: config.home,
      platform: config.platform,
      shell: config.shell,
      osVersion: config.osVersion,
      disabledExtensions: config.disabledExtensions,
      scheduledJobCommand: config.scheduledJobCommand,
      scheduledJobEnv: scheduledJobEnv(config),
      extensions: config.extensions,
    }),
    resolverDeps,
  )
}

const makeAgentRuntimeLayer = <A, E, R>(
  config: DependenciesConfig,
  getBaseSectionsSeed: () => Option.Option<ReadonlyArray<PromptSection>>,
  allWithRuntime: Layer.Layer<A, E, R>,
) => {
  const override = config.overrides?.agentRunnerLayer
  if (!Predicate.isUndefined(override)) return override
  return Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const baseSectionsSeed = getBaseSectionsSeed()
        if (Option.isNone(baseSectionsSeed)) {
          return yield* new BootstrapError({ seed: "baseSections" })
        }
        const runnerConfig: AgentRunnerConfig = {
          baseSections: baseSectionsSeed.value,
        }
        return InProcessRunner(runnerConfig)
      }),
    ),
    allWithRuntime,
  )
}

export const createDependencies = (config: DependenciesConfig) => {
  let baseSectionsSeed = Option.none<ReadonlyArray<PromptSection>>()
  const runtimeEnvironmentLive = RuntimeEnvironment.Live({
    cwd: config.cwd,
    home: config.home,
    platform: config.platform,
  })

  const persistenceMode: NonNullable<DependenciesConfig["persistenceMode"]> = Option.getOrElse(
    Option.fromUndefinedOr(config.persistenceMode),
    () => "disk",
  )
  const providerMode: NonNullable<DependenciesConfig["providerMode"]> = Option.getOrElse(
    Option.fromUndefinedOr(config.providerMode),
    () => "live",
  )

  const storageLive = makeStorageLayer(config, persistenceMode)
  const clusterRunnerLive = makeClusterRunnerLayer(persistenceMode)
  // Base event store: raw storage-backed publish/subscribe storage
  const baseEventStoreLive = makeBaseEventStoreLayer(
    Option.fromUndefinedOr(config.overrides?.eventStoreMode),
  )

  // Auth lives in `~/.gent/auth/` (one URL-encoded file per provider).
  // The composition root owns FileSystem/Path; this dependency graph only
  // describes that Auth needs platform capabilities.
  const authDirectory = Option.getOrElse(
    Option.fromUndefinedOr(config.authDirectory),
    () => `${config.home}/.gent/auth`,
  )
  const authLive = makeAuthLayer(config, authDirectory)

  const configServiceLive = makeConfigServiceLayer(config, runtimeEnvironmentLive)

  // SessionProfileCache is the sole live profile owner. The launch registry
  // resolves its profile through that same cache entry instead of building a
  // startup-only resource layer beside the cache.
  const sessionProfileCacheLive = makeSessionProfileCacheLayer(
    config,
    Layer.mergeAll(configServiceLive, runtimeEnvironmentLive, platformServicesLive),
  )

  // One durable graph actor stack owns the Encore client, mailbox, and the
  // cache-backed live applier. Startup recovery dispatches every persisted
  // owner, including rows already marked applied, so each process reacquires
  // its live scopes through SessionProfileCache.
  const resourceGraphClusterLive = Layer.provideMerge(clusterRunnerLive, storageLive)
  const resourceGraphActorLive = Layer.provide(
    ResourceGraphActorLive,
    Layer.merge(resourceGraphClusterLive, sessionProfileCacheLive),
  )
  const resourceGraphDispatchLive = Layer.provideMerge(
    ResourceGraphDispatch.Live,
    resourceGraphActorLive,
  )
  const resourceGraphCommandLive = Layer.provide(
    ResourceGraphCommandService.Live,
    Layer.merge(resourceGraphDispatchLive, storageLive),
  )
  const extensionRegistryLive = Layer.provideMerge(
    Layer.unwrap(
      Effect.gen(function* () {
        const commandService = yield* ResourceGraphCommandService
        const cache = yield* SessionProfileCache
        const resourceGraphStorage = yield* ResourceGraphStorage
        const path = yield* Path.Path
        const platform = yield* GentPlatform
        const launchCwd = CanonicalCwd.make(path.resolve(config.cwd))
        const launchWorkspaceId = WorkspaceId.make(platform.hash("sha256", launchCwd))
        const recovery = yield* commandService.recoverAllAndAwaitReport
        const durable = yield* resourceGraphStorage
          .get({ workspaceId: launchWorkspaceId, cwd: launchCwd })
          .pipe(Effect.provideService(CurrentWorkspaceId, launchWorkspaceId))
        const durableOption = Option.fromUndefinedOr(durable)
        const launchRecovery = Option.fromUndefinedOr(
          recovery.outcomes.find(
            (outcome) =>
              outcome.request.workspaceId === launchWorkspaceId &&
              outcome.request.cwd === launchCwd,
          ),
        )
        if (
          Option.isSome(durableOption) &&
          (Option.isNone(launchRecovery) ||
            Option.isSome(launchRecovery.value.error) ||
            !launchRecovery.value.applying ||
            !launchRecovery.value.settled ||
            Option.isNone(launchRecovery.value.status) ||
            launchRecovery.value.status.value.state !== "applied")
        ) {
          const toUnavailableState = (
            state: ResourceGraphStatusState,
          ): "pending" | "applying" | "failed" => {
            if (state === "applied") return "applying"
            return state
          }
          const recoveryStatus = Option.flatMap(launchRecovery, (outcome) => outcome.status)
          const statusForError = Option.orElse(recoveryStatus, () => durableOption)
          const unavailableState: "pending" | "applying" | "failed" = Option.match(statusForError, {
            onNone: () => "applying",
            onSome: (status) => toUnavailableState(status.state),
          })
          const recoveryError = Option.flatMap(launchRecovery, (outcome) => outcome.error)
          const recoveryFailureMessage = Option.flatMap(recoveryStatus, (status) =>
            Option.fromUndefinedOr(status.failure?.message),
          )
          const durableFailureMessage = Option.flatMap(durableOption, (status) =>
            Option.fromUndefinedOr(status.failure?.message),
          )
          return yield* new ResourceGraphOwnerUnavailableError({
            workspaceId: launchWorkspaceId,
            cwd: launchCwd,
            state: unavailableState,
            message: Option.getOrElse(recoveryError, () =>
              Option.getOrElse(recoveryFailureMessage, () =>
                Option.getOrElse(
                  durableFailureMessage,
                  () =>
                    "The saved resource graph did not complete recovery; repair it before launching this cwd",
                ),
              ),
            ),
          })
        }
        yield* Option.match(Option.fromUndefinedOr(durable), {
          onNone: () => Effect.void,
          onSome: (status) => {
            if (status.state === "applied") return Effect.void
            return Effect.fail(
              new ResourceGraphOwnerUnavailableError({
                workspaceId: launchWorkspaceId,
                cwd: launchCwd,
                state: status.state,
                message:
                  status.failure?.message ??
                  "The saved resource graph is unavailable; repair it before launching this cwd",
              }),
            )
          },
        })
        const profile = yield* cache
          .resolve(config.cwd)
          .pipe(Effect.provideService(CurrentWorkspaceId, launchWorkspaceId))
        baseSectionsSeed = Option.some(profile.baseSections)
        // `SessionProfile.layerContext` carries dynamically acquired resource
        // services, so its type intentionally cannot enumerate every service
        // contributed by an extension. Keep the stable registry services
        // explicit at this package boundary while retaining that context at
        // runtime for extension consumers.
        return Layer.mergeAll(
          Layer.succeed(ExtensionRegistry, profile.registryService),
          Layer.succeed(DriverRegistry, profile.driverRegistryService),
          Layer.succeedContext(profile.layerContext),
        )
      }),
    ),
    Layer.merge(
      resourceGraphCommandLive,
      Layer.merge(storageLive, Layer.merge(sessionProfileCacheLive, platformServicesLive)),
    ),
  )
  const modelRegistryLive = makeModelRegistryLayer(
    config,
    Layer.mergeAll(runtimeEnvironmentLive, extensionRegistryLive, authLive),
  )
  const authDeps = Layer.mergeAll(authLive, extensionRegistryLive)
  const authGuardLive = Layer.provide(AuthGuard.Live, authDeps)
  const providerAuthLive = Layer.provide(ProviderAuth.Live, authDeps)
  const fileLockServiceLive = FileLockService.layer

  const modelResolverLive = makeModelResolverLayer(config, providerMode, authDeps)

  const eventPublisherLive = EventPublisherLive
  const eventServicesLive = Layer.provideMerge(eventPublisherLive, baseEventStoreLive)

  const baseServicesLive = Layer.provideMerge(
    Layer.mergeAll(
      platformServicesLive,
      runtimeEnvironmentLive,
      clusterRunnerLive,
      eventServicesLive,
      authLive,
      authGuardLive,
      providerAuthLive,
      configServiceLive,
      Layer.provide(modelRegistryLive, FetchHttpClient.layer),
      extensionRegistryLive,
      DynamicExtensionRegistry.Live,
      fileLockServiceLive,
      AgentLoopSessionGovernance.Live,
      modelResolverLive,
      ...optionalPermissionLayer(Option.fromUndefinedOr(config.overrides?.permissionLayer)),
      makeFileIndexLayer(
        Option.fromUndefinedOr(config.overrides?.fileIndexLayer),
        runtimeEnvironmentLive,
      ),
      ...Option.getOrElse(Option.fromUndefinedOr(config.overrides?.extraLayers), () => []),
      FetchHttpClient.layer,
    ),
    storageLive,
  )

  // ApprovalService — single handler for all interaction types
  const approvalServiceLive = makeApprovalServiceLayer(
    Option.fromUndefinedOr(config.overrides?.approvalLayer),
    baseServicesLive,
  )

  const promptPresenterLive = Layer.provide(
    PromptPresenterLive,
    Layer.merge(approvalServiceLive, baseServicesLive),
  )
  const toolRunnerLive = makeToolRunnerLayer(
    Option.fromUndefinedOr(config.overrides?.toolRunnerLayer),
    Layer.merge(baseServicesLive, approvalServiceLive),
  )

  const allDeps = Layer.mergeAll(
    baseServicesLive,
    approvalServiceLive,
    toolRunnerLive,
    promptPresenterLive,
  )

  // Recover pending interaction requests from storage by rehydrating the
  // approval presenter state. The actor mailbox owns cold turn replay; this
  // startup pass only restores the transport-facing prompt surface.
  const interactionRecoveryLive = Layer.effectDiscard(
    Effect.gen(function* () {
      const interactionStore = yield* InteractionStorage
      const approvalService = yield* ApprovalService
      const sessionRuntime = yield* SessionRuntime

      const pending = yield* interactionStore.listPending()
      if (pending.length === 0) return

      let recovered = 0
      for (const record of pending) {
        const params = yield* decodeInteractionParams(record.paramsJson).pipe(Effect.option)
        if (Option.isNone(params)) continue
        let decision = Option.none<ApprovalDecision>()
        if (!Predicate.isUndefined(record.decisionJson)) {
          decision = yield* decodeInteractionDecision(record.decisionJson).pipe(Effect.option)
        }
        yield* approvalService
          .rehydrate(
            record.requestId,
            params.value,
            {
              sessionId: record.sessionId,
              branchId: record.branchId,
            },
            Option.getOrUndefined(decision),
          )
          .pipe(Effect.catchEager(() => Effect.void))
        if (Option.isSome(decision)) {
          yield* sessionRuntime
            .respondInteraction({
              sessionId: record.sessionId,
              branchId: record.branchId,
              requestId: record.requestId,
            })
            .pipe(Effect.catchEager(() => Effect.void))
        }
        recovered++
      }

      if (recovered > 0) {
        yield* Effect.log(`Recovered ${recovered} pending interaction request(s)`)
      }
    }),
  )

  const sessionRuntimeLive = Layer.provide(SessionRuntime.Client, allDeps)

  const sessionMutationsLive = Layer.provide(
    SessionCommands.SessionMutationsLive,
    Layer.merge(allDeps, sessionRuntimeLive),
  )

  const allWithRuntime = Layer.mergeAll(allDeps, sessionMutationsLive, sessionRuntimeLive)

  const agentRuntimeLive = makeAgentRuntimeLayer(config, () => baseSectionsSeed, allWithRuntime)
  const runtimeWithHandlers = Layer.provideMerge(
    Layer.unwrap(
      Effect.gen(function* () {
        if (Option.isNone(baseSectionsSeed))
          return yield* new BootstrapError({ seed: "baseSections" })
        return AgentLoopLiveActor({ baseSections: baseSectionsSeed.value })
      }),
    ),
    Layer.merge(allWithRuntime, agentRuntimeLive),
  )
  return Layer.merge(
    runtimeWithHandlers,
    Layer.provide(interactionRecoveryLive, runtimeWithHandlers),
  )
}
