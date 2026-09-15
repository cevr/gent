import { Predicate, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { SingleRunner } from "effect/unstable/cluster"
import { FetchHttpClient } from "effect/unstable/http"
import type { LanguageModel } from "effect/unstable/ai"
import { ChildProcessSpawner as ProcessSpawner } from "effect/unstable/process"
import type { AgentRunnerService } from "../domain/agent.js"
import { Auth, AuthGuard } from "../domain/auth.js"
import { EventPublisherLive, type EventPublisher } from "../domain/event-publisher.js"
import type { PromptSection } from "../domain/prompt.js"
import { FileLockService } from "../domain/file-lock.js"
import type { GentExtension, ExtensionSetupServices } from "../domain/extension.js"
import { GentPlatform } from "../runtime/gent-platform.js"
import { ModelResolver } from "../providers/model-resolver.js"
import { ProviderAuth } from "../providers/provider-auth.js"
import { ApprovalService } from "../runtime/approval-service.js"
import { InProcessRunner } from "../runtime/agent/agent-runner.js"
import { ChildCompletionDelivery } from "../runtime/agent/child-completion.js"
import { AgentLoopLiveActor } from "../runtime/agent/agent-loop.actor.js"
import { AgentLoopSessionGovernance } from "../runtime/agent/agent-loop.session-governance.js"
import { ToolRunner } from "../runtime/agent/tool-runner.js"
import { ConfigService } from "../runtime/config-service.js"
import { SessionRuntime } from "../runtime/session-runtime.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { RuntimeEnvironment } from "../runtime/runtime-environment.js"
import { SqliteStorage } from "../storage/sqlite-storage.js"
import { InteractionStorage } from "../storage/interaction-storage.js"
import {
  CurrentBranchToolFeature,
  type BranchToolFeature,
} from "../runtime/agent/branch-tool-feature.js"
import {
  decodeInteractionDecision,
  decodeInteractionParams,
  type ApprovalDecision,
} from "../domain/interaction-request.js"
import { EventStoreLive } from "../runtime/event-store-live.js"
import { SessionMutationsLive } from "./session-mutations-live.js"
import { SessionProfileCache } from "../runtime/session-profile.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { DriverRegistry } from "../runtime/extensions/driver-registry.js"
import { ProcessRunnerLive } from "../runtime/run-process.js"
import { CurrentWorkspaceId, workspaceIdForCwd } from "./workspace-rpc.js"

interface DependencyOverrides {
  readonly authLayer?: Layer.Layer<Auth>
  readonly approvalLayer?: Layer.Layer<
    ApprovalService,
    never,
    EventPublisher | GentPlatform | InteractionStorage
  >
  readonly configServiceLayer?: Layer.Layer<ConfigService>
  readonly modelRegistryLayer?: Layer.Layer<ModelRegistry>
  readonly toolRunnerLayer?: Layer.Layer<ToolRunner>
  readonly agentRunnerLayer?: Layer.Layer<AgentRunnerService>
  readonly sessionProfileCacheLayer?: Layer.Layer<SessionProfileCache>
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
  disabledExtensions?: ReadonlyArray<string>
  /** Language model layer override. When set, replaces the auth-backed live resolver.
   *  Must be a fully-provided layer (no requirements, no errors). */
  languageModelLayerOverride?: Layer.Layer<LanguageModel.LanguageModel, never, never>
  /** Extensions to load. Composition roots pass this in. */
  extensions: ReadonlyArray<GentExtension<ExtensionSetupServices>>
  /**
   * The branch-tool feature this deployment ships — its migrations, storage,
   * and per-branch factory as one value. Required, not defaulted: a root that
   * ships a stateful tool surface and forgets this would get a tool that
   * fails on first use, and a default would hide that until run time. A
   * deployment whose tools are all stateless passes `noBranchTools`.
   */
  branchTools: BranchToolFeature<never>
  /** Internal composition-root knobs used by tests to preset the production root. */
  overrides?: DependencyOverrides
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
  const branchTools = config.branchTools
  if (persistenceMode === "memory")
    return SqliteStorage.MemoryWithSql(branchTools.storage, branchTools.migrations)
  const dbPath = Option.getOrElse(Option.fromUndefinedOr(config.dbPath), () => ".gent/data.db")
  return SqliteStorage.LiveWithSql(dbPath, branchTools.storage, branchTools.migrations)
}

const makeClusterRunnerLayer = (persistenceMode: "disk" | "memory") => {
  let runnerStorage: "memory" | "sql" = "sql"
  if (persistenceMode === "memory") runnerStorage = "memory"
  return SingleRunner.layer({ runnerStorage })
}

const makeModelResolverLayer = <A, E, R>(
  config: DependenciesConfig,
  authDeps: Layer.Layer<A, E, R>,
) =>
  Option.match(Option.fromUndefinedOr(config.languageModelLayerOverride), {
    onNone: () => Layer.provide(ModelResolver.Live, authDeps),
    onSome: ModelResolver.fromLanguageModel,
  })

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

  const storageLive = makeStorageLayer(config, persistenceMode)
  const clusterRunnerLive = makeClusterRunnerLayer(persistenceMode)
  // Snapshots and event replay must share a cursor, including in-memory SQLite.
  const baseEventStoreLive = EventStoreLive

  // Auth lives in `~/.gent/auth/` (one URL-encoded file per provider).
  // The composition root owns FileSystem/Path; this dependency graph only
  // describes that Auth needs platform capabilities.
  const authDirectory = Option.getOrElse(
    Option.fromUndefinedOr(config.authDirectory),
    () => `${config.home}/.gent/auth`,
  )
  const authLive = config.overrides?.authLayer ?? Auth.Live(authDirectory)

  const configServiceLive =
    config.overrides?.configServiceLayer ??
    Layer.provide(ConfigService.Live, runtimeEnvironmentLive)

  // SessionProfileCache is the sole live profile owner. The launch registry
  // resolves its profile through that same cache entry instead of building a
  // startup-only resource layer beside the cache.
  const sessionProfileCacheLive =
    config.overrides?.sessionProfileCacheLayer ??
    Layer.provide(
      SessionProfileCache.Live({
        home: config.home,
        platform: config.platform,
        shell: config.shell,
        osVersion: config.osVersion,
        disabledExtensions: config.disabledExtensions,
        extensions: config.extensions,
      }),
      Layer.mergeAll(configServiceLive, runtimeEnvironmentLive, platformServicesLive),
    )

  const extensionRegistryLive = Layer.provideMerge(
    Layer.unwrap(
      Effect.gen(function* () {
        const cache = yield* SessionProfileCache
        // Same derivation the client used for its `x-gent-workspace-id`
        // header; a second one here would split the workspace silently.
        const launchWorkspaceId = workspaceIdForCwd(config.cwd)
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
    Layer.merge(storageLive, Layer.merge(sessionProfileCacheLive, platformServicesLive)),
  )
  const modelRegistryLive =
    config.overrides?.modelRegistryLayer ??
    Layer.provide(
      ModelRegistry.Live,
      Layer.mergeAll(runtimeEnvironmentLive, extensionRegistryLive, authLive),
    )
  const authDeps = Layer.mergeAll(authLive, extensionRegistryLive)
  const authGuardLive = Layer.provide(AuthGuard.Live, authDeps)
  const providerAuthLive = Layer.provide(ProviderAuth.Live, authDeps)
  const fileLockServiceLive = FileLockService.layer

  const modelResolverLive = makeModelResolverLayer(config, authDeps)

  const eventPublisherLive = EventPublisherLive
  const eventServicesLive = Layer.provideMerge(eventPublisherLive, baseEventStoreLive)

  const baseServicesLive = Layer.provideMerge(
    Layer.mergeAll(
      // The app names the branch-tool feature it ships. The loop builds its
      // layer without knowing what it is.
      Layer.succeed(CurrentBranchToolFeature, config.branchTools),
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
      fileLockServiceLive,
      AgentLoopSessionGovernance.Live,
      modelResolverLive,
      ...Option.getOrElse(Option.fromUndefinedOr(config.overrides?.extraLayers), () => []),
      FetchHttpClient.layer,
    ),
    storageLive,
  )

  // ApprovalService — single handler for all interaction types
  const approvalServiceLive = Layer.provide(
    config.overrides?.approvalLayer ?? ApprovalService.Live,
    baseServicesLive,
  )

  const toolRunnerLive =
    config.overrides?.toolRunnerLayer ??
    Layer.provide(ToolRunner.Live, Layer.merge(baseServicesLive, approvalServiceLive))

  const allDeps = Layer.mergeAll(baseServicesLive, approvalServiceLive, toolRunnerLive)

  // Recover pending interaction requests from storage by rehydrating the
  // approval presenter state. The actor mailbox owns cold turn replay; this
  // startup pass only restores the transport-facing prompt surface.
  const interactionRecoveryLive = Layer.effectDiscard(
    Effect.gen(function* () {
      const interactionStore = yield* InteractionStorage
      const approvalService = yield* ApprovalService
      const sessionRuntime = yield* SessionRuntime

      const workspaces = yield* interactionStore.listPendingWorkspaces
      for (const workspaceId of workspaces) {
        yield* Effect.gen(function* () {
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
        }).pipe(Effect.provideService(CurrentWorkspaceId, workspaceId))
      }
    }),
  )

  const sessionRuntimeLive = Layer.provide(SessionRuntime.Client, allDeps)

  const sessionMutationsLive = Layer.provide(
    SessionMutationsLive,
    Layer.merge(allDeps, sessionRuntimeLive),
  )

  const allWithRuntime = Layer.mergeAll(allDeps, sessionMutationsLive, sessionRuntimeLive)

  const agentRuntimeLive =
    config.overrides?.agentRunnerLayer ??
    Layer.provide(
      InProcessRunner.pipe(Layer.provideMerge(ChildCompletionDelivery.Live)),
      allWithRuntime,
    )
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
