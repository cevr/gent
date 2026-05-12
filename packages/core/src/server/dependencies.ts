import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { SingleRunner } from "effect/unstable/cluster"
import { FetchHttpClient } from "effect/unstable/http"
import type { LanguageModel } from "effect/unstable/ai"
import { ChildProcessSpawner as ProcessSpawner } from "effect/unstable/process"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { AgentRunnerService } from "../domain/agent.js"
import { Auth, AuthGuard } from "../domain/auth.js"
import { EventStore, EventStoreError } from "../domain/event.js"
import { EventPublisherLive, type EventPublisher } from "../domain/event-publisher.js"
import type { PromptSection } from "../domain/prompt.js"
import { FileLockService } from "../domain/file-lock.js"
import type { Permission } from "../domain/permission.js"
import { PromptPresenterLive } from "../runtime/prompt-presenter-live.js"
import type { GentExtension } from "../domain/extension.js"
import { GentPlatform } from "../runtime/gent-platform.js"
import { ModelResolver } from "../providers/model-resolver.js"
import { ProviderAuth } from "../providers/provider-auth.js"
import { DebugSlowLanguageModelDelayMs, LanguageModelLayers } from "../test-utils/language-model.js"
import { ApprovalService } from "../runtime/approval-service.js"
import { InProcessRunner, SubprocessRunner } from "../runtime/agent/agent-runner.js"
import { ToolRunner } from "../runtime/agent/tool-runner.js"
import { ConfigService } from "../runtime/config-service.js"
import { SessionRuntime } from "../runtime/session-runtime.js"
import { resolveProfileRuntime } from "../runtime/profile.js"
import { type ScheduledJobCommand } from "../runtime/extensions/resource-host/schedule-engine.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { RuntimeEnvironment } from "../runtime/runtime-environment.js"
import { SqliteStorage } from "../storage/sqlite-storage.js"
import { InteractionStorage } from "../storage/interaction-storage.js"
import {
  decodeInteractionDecision,
  decodeInteractionParams,
} from "../domain/interaction-request.js"
import { EventStoreLive } from "../runtime/event-store-live.js"
import { SessionCommands } from "./session-commands.js"
import {
  SessionProfileCache,
  sessionProfileFromRuntime,
  type SessionProfile,
} from "../runtime/session-profile.js"
import { FileIndexLive, type FileIndex } from "../runtime/file-index/index.js"

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
export class BootstrapError extends Schema.TaggedErrorClass<BootstrapError>()("BootstrapError", {
  seed: Schema.Literals(["launchSessionProfile", "baseSections"]),
}) {
  override get message(): string {
    return this.seed === "launchSessionProfile"
      ? "Launch session profile seed was not initialized"
      : "Base prompt sections were not initialized"
  }
}

export interface DependenciesConfig {
  cwd: string
  home: string
  platform: string
  shell?: string
  osVersion?: string
  subprocessBinaryPath?: string
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
  /** URL of the shared server. Subprocess children pass --connect to reuse it. */
  sharedServerUrl?: string
  /** Language model layer override. When set, bypasses providerMode string and uses this layer directly.
   *  Must be a fully-provided layer (no requirements, no errors). */
  languageModelLayerOverride?: Layer.Layer<LanguageModel.LanguageModel, never, never>
  /** Extensions to load. Composition roots pass this in. */
  extensions: ReadonlyArray<GentExtension<ChildProcessSpawner | GentPlatform>>
  /** Internal composition-root knobs used by tests to preset the production root. */
  overrides?: DependencyOverrides
}

const scheduledJobEnv = (config: DependenciesConfig): Readonly<Record<string, string>> => ({
  HOME: config.home,
  ...(config.shell !== undefined ? { SHELL: config.shell } : {}),
  ...(config.dbPath !== undefined ? { GENT_DB_PATH: config.dbPath } : {}),
  ...(config.authDirectory !== undefined ? { GENT_AUTH_DIRECTORY: config.authDirectory } : {}),
  ...(config.persistenceMode !== undefined
    ? { GENT_PERSISTENCE_MODE: config.persistenceMode }
    : {}),
  ...(config.providerMode !== undefined ? { GENT_PROVIDER_MODE: config.providerMode } : {}),
})

const makeBaseEventStoreLayer = (
  eventStoreMode: DependencyOverrides["eventStoreMode"] | undefined,
  persistenceMode: "disk" | "memory",
) => {
  if (eventStoreMode === "memory") return EventStore.Memory
  if (eventStoreMode === "storage-backed") return EventStoreLive
  return persistenceMode === "memory" ? EventStore.Memory : EventStoreLive
}

const platformServicesLive = Layer.mergeAll(
  Layer.effect(FileSystem.FileSystem, Effect.service(FileSystem.FileSystem)),
  Layer.effect(Path.Path, Effect.service(Path.Path)),
  Layer.effect(
    ProcessSpawner.ChildProcessSpawner,
    Effect.service(ProcessSpawner.ChildProcessSpawner),
  ),
  Layer.effect(GentPlatform, Effect.service(GentPlatform)),
)

const makeStorageLayer = (config: DependenciesConfig, persistenceMode: "disk" | "memory") =>
  persistenceMode === "memory"
    ? SqliteStorage.MemoryWithSql()
    : SqliteStorage.LiveWithSql(config.dbPath ?? ".gent/data.db")

const makeClusterRunnerLayer = (persistenceMode: "disk" | "memory") =>
  SingleRunner.layer({
    runnerStorage: persistenceMode === "memory" ? "memory" : "sql",
  })

const makeProfileRuntimeInputs = (config: DependenciesConfig) => ({
  cwd: config.cwd,
  home: config.home,
  platform: config.platform,
  ...(config.shell !== undefined ? { shell: config.shell } : {}),
  ...(config.osVersion !== undefined ? { osVersion: config.osVersion } : {}),
  extensions: config.extensions,
  ...(config.disabledExtensions !== undefined
    ? { disabledExtensions: config.disabledExtensions }
    : {}),
  ...(config.scheduledJobCommand !== undefined
    ? { scheduledJobCommand: config.scheduledJobCommand }
    : {}),
  scheduledJobEnv: scheduledJobEnv(config),
})

const makeProfileLayers = <A, E, R>(
  config: DependenciesConfig,
  resolverDeps: Layer.Layer<A, E, R>,
  onResolved: (runtime: Parameters<typeof sessionProfileFromRuntime>[0]) => void,
) =>
  Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const runtime = yield* resolveProfileRuntime(makeProfileRuntimeInputs(config))
        onResolved(runtime)
        return Layer.succeedContext(runtime.layerContext)
      }),
    ),
    resolverDeps,
  )

const makeAuthLayer = (config: DependenciesConfig, authDirectory: string) =>
  config.overrides?.authLayer ?? Auth.Live(authDirectory)

const makeConfigServiceLayer = (
  config: DependenciesConfig,
  runtimeEnvironmentLive: Layer.Layer<RuntimeEnvironment>,
) =>
  config.overrides?.configServiceLayer ?? Layer.provide(ConfigService.Live, runtimeEnvironmentLive)

const makeModelRegistryLayer = <A, E, R>(
  config: DependenciesConfig,
  liveDeps: Layer.Layer<A, E, R>,
) => config.overrides?.modelRegistryLayer ?? Layer.provide(ModelRegistry.Live, liveDeps)

const makeModelResolverLayer = <A, E, R>(
  config: DependenciesConfig,
  providerMode: NonNullable<DependenciesConfig["providerMode"]>,
  authDeps: Layer.Layer<A, E, R>,
) => {
  if (config.languageModelLayerOverride !== undefined) {
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
  override: DependencyOverrides["toolRunnerLayer"] | undefined,
  liveDeps: Layer.Layer<A, E, R>,
) => override ?? Layer.provide(ToolRunner.Live, liveDeps)

const optionalPermissionLayer = (override: DependencyOverrides["permissionLayer"] | undefined) =>
  override === undefined ? [] : [override]

const makeFileIndexLayer = (
  override: DependencyOverrides["fileIndexLayer"] | undefined,
  runtimeEnvironmentLive: Layer.Layer<RuntimeEnvironment>,
) => override ?? Layer.provide(FileIndexLive, runtimeEnvironmentLive)

const makeApprovalServiceLayer = <A, E, R>(
  override: DependencyOverrides["approvalLayer"] | undefined,
  baseServicesLive: Layer.Layer<A, E, R>,
) => {
  if (override !== undefined) {
    return Layer.provide(override, baseServicesLive)
  }
  return Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const store = yield* InteractionStorage
        return ApprovalService.LiveWithStorage({
          persist: (record) =>
            store.persist(record).pipe(
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
  getLaunchProfileSeed: () => SessionProfile | undefined,
  allDeps: Layer.Layer<A, E, R>,
) => {
  const override = config.overrides?.sessionProfileCacheLayer
  if (override !== undefined) return override
  return Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const launchProfileSeed = getLaunchProfileSeed()
        if (launchProfileSeed === undefined) {
          return yield* new BootstrapError({ seed: "launchSessionProfile" })
        }
        return SessionProfileCache.Live({
          home: config.home,
          platform: config.platform,
          shell: config.shell,
          osVersion: config.osVersion,
          disabledExtensions: config.disabledExtensions,
          scheduledJobCommand: config.scheduledJobCommand,
          scheduledJobEnv: scheduledJobEnv(config),
          extensions: config.extensions,
          initialProfiles: [launchProfileSeed],
        })
      }),
    ),
    allDeps,
  )
}

const makeSessionRuntimeLayer = <A, E, R>(
  getBaseSectionsSeed: () => ReadonlyArray<PromptSection> | undefined,
  runtimeDeps: Layer.Layer<A, E, R>,
) =>
  Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const baseSectionsSeed = getBaseSectionsSeed()
        if (baseSectionsSeed === undefined) {
          return yield* new BootstrapError({ seed: "baseSections" })
        }
        return SessionRuntime.Live({ baseSections: baseSectionsSeed })
      }),
    ),
    runtimeDeps,
  )

const makeAgentRuntimeLayer = <A, E, R>(
  config: DependenciesConfig,
  getBaseSectionsSeed: () => ReadonlyArray<PromptSection> | undefined,
  allWithRuntime: Layer.Layer<A, E, R>,
) => {
  const override = config.overrides?.agentRunnerLayer
  if (override !== undefined) return override
  return Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const baseSectionsSeed = getBaseSectionsSeed()
        if (baseSectionsSeed === undefined) {
          return yield* new BootstrapError({ seed: "baseSections" })
        }
        const runnerConfig = {
          ...(config.subprocessBinaryPath !== undefined && config.subprocessBinaryPath !== ""
            ? { subprocessBinaryPath: config.subprocessBinaryPath }
            : {}),
          ...(config.dbPath !== undefined && config.dbPath !== "" ? { dbPath: config.dbPath } : {}),
          ...(config.sharedServerUrl !== undefined
            ? { sharedServerUrl: config.sharedServerUrl }
            : {}),
          baseSections: baseSectionsSeed,
        }
        return config.subprocessBinaryPath !== undefined && config.subprocessBinaryPath !== ""
          ? SubprocessRunner(runnerConfig)
          : InProcessRunner(runnerConfig)
      }),
    ),
    allWithRuntime,
  )
}

export const createDependencies = (config: DependenciesConfig) => {
  let launchSessionProfileSeed: SessionProfile | undefined
  let baseSectionsSeed: ReadonlyArray<PromptSection> | undefined
  const runtimeEnvironmentLive = RuntimeEnvironment.Live({
    cwd: config.cwd,
    home: config.home,
    platform: config.platform,
  })

  const persistenceMode = config.persistenceMode ?? "disk"
  const providerMode = config.providerMode ?? "live"

  const storageLive = makeStorageLayer(config, persistenceMode)
  const clusterRunnerLive = makeClusterRunnerLayer(persistenceMode)
  // Base event store: raw storage-backed publish/subscribe storage
  const baseEventStoreLive = makeBaseEventStoreLayer(
    config.overrides?.eventStoreMode,
    persistenceMode,
  )

  // Auth lives in `~/.gent/auth/` (one URL-encoded file per provider).
  // The composition root owns FileSystem/Path; this dependency graph only
  // describes that Auth needs platform capabilities.
  const authDirectory = config.authDirectory ?? `${config.home}/.gent/auth`
  const authLive = makeAuthLayer(config, authDirectory)

  const configServiceLive = makeConfigServiceLayer(config, runtimeEnvironmentLive)

  // Resolve and build the launch cwd profile runtime once. Server startup and
  // SessionProfileCache share this same profile so cwd-scoped resources have a
  // single owner.
  const extensionRegistryLive = makeProfileLayers(
    config,
    Layer.mergeAll(configServiceLive, runtimeEnvironmentLive),
    (runtime) => {
      const profile = sessionProfileFromRuntime(runtime)
      launchSessionProfileSeed = profile
      baseSectionsSeed = runtime.baseSections
    },
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
      fileLockServiceLive,
      modelResolverLive,
      ...optionalPermissionLayer(config.overrides?.permissionLayer),
      makeFileIndexLayer(config.overrides?.fileIndexLayer, runtimeEnvironmentLive),
      ...(config.overrides?.extraLayers ?? []),
      FetchHttpClient.layer,
    ),
    storageLive,
  )

  // ApprovalService — single handler for all interaction types
  const approvalServiceLive = makeApprovalServiceLayer(
    config.overrides?.approvalLayer,
    baseServicesLive,
  )

  const promptPresenterLive = Layer.provide(
    PromptPresenterLive,
    Layer.merge(approvalServiceLive, baseServicesLive),
  )
  const toolRunnerLive = makeToolRunnerLayer(
    config.overrides?.toolRunnerLayer,
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
        const params = yield* decodeInteractionParams(record.paramsJson).pipe(
          Effect.option,
          Effect.map((opt) => (opt._tag === "Some" ? opt.value : undefined)),
        )
        if (params === undefined) continue
        const decision =
          record.decisionJson === undefined
            ? undefined
            : yield* decodeInteractionDecision(record.decisionJson).pipe(
                Effect.option,
                Effect.map((opt) => (opt._tag === "Some" ? opt.value : undefined)),
              )
        yield* approvalService
          .rehydrate(
            record.requestId,
            params,
            {
              sessionId: record.sessionId,
              branchId: record.branchId,
            },
            decision,
          )
          .pipe(Effect.catchEager(() => Effect.void))
        if (decision !== undefined) {
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

  // SessionProfileCache — lazy per-cwd extension/config/prompt profiles.
  const sessionProfileCacheLive = makeSessionProfileCacheLayer(
    config,
    () => launchSessionProfileSeed,
    allDeps,
  )

  const sessionRuntimeLive = makeSessionRuntimeLayer(
    () => baseSectionsSeed,
    Layer.mergeAll(allDeps, sessionProfileCacheLive),
  )

  const sessionMutationsLive = Layer.provide(
    SessionCommands.SessionMutationsLive,
    Layer.merge(allDeps, sessionRuntimeLive),
  )

  const allWithRuntime = Layer.mergeAll(
    allDeps,
    sessionProfileCacheLive,
    sessionMutationsLive,
    sessionRuntimeLive,
  )

  const agentRuntimeLive = makeAgentRuntimeLayer(config, () => baseSectionsSeed, allWithRuntime)

  return Layer.mergeAll(
    allWithRuntime,
    agentRuntimeLive,
    Layer.provide(interactionRecoveryLive, allWithRuntime),
  )
}
