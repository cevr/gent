import { Effect, Layer, Context } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AuthGuard } from "../domain/auth-guard.js"
import { AuthStorage } from "../domain/auth-storage.js"
import { AuthStore } from "../domain/auth-store.js"
import { EventStore } from "../domain/event.js"
import { FileLockService } from "../domain/file-lock.js"
import type { PromptSection } from "../domain/prompt.js"
import { PromptPresenter } from "../domain/prompt-presenter.js"
import type { GentExtension } from "../domain/extension.js"
import { Provider } from "../providers/provider.js"
import { ProviderAuth } from "../providers/provider-auth.js"
import { ApprovalService } from "../runtime/approval-service.js"
import { InProcessRunner, SubprocessRunner } from "../runtime/agent/agent-runner.js"
import { ToolRunner } from "../runtime/agent/tool-runner.js"
import { ResourceManagerLive } from "../runtime/resource-manager.js"
import { ConfigService } from "../runtime/config-service.js"
import { SessionRuntime } from "../runtime/session-runtime.js"
import { resolveProfileRuntime } from "../runtime/profile.js"
import { brandServerScope, ServerProfileService } from "../runtime/scope-brands.js"
import { type ScheduledJobCommand } from "../runtime/extensions/resource-host/schedule-engine.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"
import { Storage, subTagLayers } from "../storage/sqlite-storage.js"
import { InteractionStorage } from "../storage/interaction-storage.js"
import { decodeInteractionParams } from "../domain/interaction-request.js"
import { EventStoreLive } from "../runtime/event-store-live.js"
import { makeEventPublisherRouter } from "./event-publisher.js"
import { SessionProfileCache } from "../runtime/session-profile.js"
import { SessionCwdRegistry } from "../runtime/session-cwd-registry.js"
import { FileIndexLive } from "../runtime/file-index/index.js"

/** Marker service — construction triggers recovery of pending interaction requests */
class InteractionRecoveryTag extends Context.Service<
  InteractionRecoveryTag,
  { readonly recovered: number }
>()("@gent/core/src/server/dependencies/InteractionRecoveryTag") {}

class BasePromptSectionsTag extends Context.Service<
  BasePromptSectionsTag,
  ReadonlyArray<PromptSection>
>()("@gent/core/src/server/dependencies/BasePromptSectionsTag") {}

export interface DependenciesConfig {
  cwd: string
  home: string
  platform: string
  shell?: string
  osVersion?: string
  subprocessBinaryPath?: string
  dbPath?: string
  authFilePath?: string
  authKeyPath?: string
  persistenceMode?: "disk" | "memory"
  providerMode?: "live" | "debug-scripted" | "debug-failing" | "debug-slow"
  disabledExtensions?: ReadonlyArray<string>
  scheduledJobCommand?: ScheduledJobCommand
  /** URL of the shared server. Subprocess children pass --connect to reuse it. */
  sharedServerUrl?: string
  /** Provider layer override. When set, bypasses providerMode string and uses this layer directly.
   *  Must be a fully-provided layer (no requirements, no errors). */
  providerLayerOverride?: Layer.Layer<Provider, never, never>
  /** Extensions to load. Composition roots pass this in. */
  extensions: ReadonlyArray<GentExtension>
}

const scheduledJobEnv = (config: DependenciesConfig): Readonly<Record<string, string>> => ({
  HOME: config.home,
  ...(config.shell !== undefined ? { SHELL: config.shell } : {}),
  ...(config.dbPath !== undefined ? { GENT_DB_PATH: config.dbPath } : {}),
  ...(config.authFilePath !== undefined ? { GENT_AUTH_FILE_PATH: config.authFilePath } : {}),
  ...(config.authKeyPath !== undefined ? { GENT_AUTH_KEY_PATH: config.authKeyPath } : {}),
  ...(config.persistenceMode !== undefined
    ? { GENT_PERSISTENCE_MODE: config.persistenceMode }
    : {}),
  ...(config.providerMode !== undefined ? { GENT_PROVIDER_MODE: config.providerMode } : {}),
})

export const createDependencies = (config: DependenciesConfig) => {
  const runtimePlatformLive = RuntimePlatform.Live({
    cwd: config.cwd,
    home: config.home,
    platform: config.platform,
  })

  const persistenceMode = config.persistenceMode ?? "disk"
  const providerMode = config.providerMode ?? "live"

  const storageLive =
    persistenceMode === "memory"
      ? Storage.MemoryWithSql()
      : Storage.LiveWithSql(config.dbPath ?? ".gent/data.db")
  // Base event store: raw storage-backed publish/subscribe storage
  const baseEventStoreLive =
    persistenceMode === "memory" ? EventStore.Memory : Layer.provide(EventStoreLive, storageLive)

  const authStorageLive = AuthStorage.LiveSystem({
    serviceName: "gent",
    ...(config.authFilePath !== undefined ? { filePath: config.authFilePath } : {}),
    ...(config.authKeyPath !== undefined ? { keyPath: config.authKeyPath } : {}),
  })
  const authStoreLive = Layer.provide(AuthStore.Live, authStorageLive)

  const configServiceLive = Layer.provide(ConfigService.Live, runtimePlatformLive)

  // Resolve and build the profile runtime once. Server startup and per-cwd
  // profile cache now share the same profile runtime helper.
  const profileLayers = Layer.unwrap(
    Effect.gen(function* () {
      const runtime = yield* resolveProfileRuntime({
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
      const baseSectionsLayer = Layer.succeed(BasePromptSectionsTag, runtime.baseSections)
      // Publish a typed ServerProfile so downstream consumers (e.g. agent-runner)
      // can construct an EphemeralProfile via RuntimeComposer without forging
      // the brand themselves. Only this composition root may call
      // brandServerScope (lint-fenced).
      const serverProfileLayer = Layer.succeed(
        ServerProfileService,
        brandServerScope({ cwd: runtime.profile.cwd, resolved: runtime.profile.resolved }),
      )
      return Layer.mergeAll(
        Layer.succeedContext(runtime.layerContext),
        baseSectionsLayer,
        serverProfileLayer,
      )
    }),
  )
  // Extension registry needs storageLive for SqlClient (extension task layers use it)
  // and ConfigService + RuntimePlatform + platform services for profile resolution.
  const extensionRegistryLive = Layer.provide(
    profileLayers,
    Layer.mergeAll(storageLive, configServiceLive, runtimePlatformLive),
  )
  const modelRegistryLive = Layer.provide(
    ModelRegistry.Live,
    Layer.mergeAll(runtimePlatformLive, extensionRegistryLive, authStoreLive),
  )
  const authDeps = Layer.merge(authStoreLive, extensionRegistryLive)
  const authGuardLive = Layer.provide(AuthGuard.Live, authDeps)
  const providerAuthLive = Layer.provide(ProviderAuth.Live, authDeps)
  const fileLockServiceLive = FileLockService.layer

  let providerLive = Layer.provide(Provider.Live, authDeps)
  if (config.providerLayerOverride !== undefined) {
    providerLive = config.providerLayerOverride
  } else if (providerMode === "debug-scripted") {
    providerLive = Provider.Debug()
  } else if (providerMode === "debug-failing") {
    providerLive = Provider.Failing
  } else if (providerMode === "debug-slow") {
    providerLive = Provider.Debug({ delayMs: 10 })
  }

  // SessionCwdRegistry — fast (sessionId → cwd) cache for the per-cwd
  // EventPublisher router (B11.6c). Registry writes happen at session
  // creation; reads fall back to Storage on cache miss.
  const sessionCwdRegistryLive = Layer.provide(SessionCwdRegistry.Live, storageLive)

  // Per-cwd EventPublisher router — dispatches events through the correct
  // cwd's MachineEngine + pulseTags + SubscriptionEngine. The handle
  // receives the SessionProfileCache after it's constructed (breaks
  // circular dep: EventPublisher → baseServicesLive → allDeps → SessionProfileCache).
  const { handle: publisherRouterHandle, layer: eventPublisherRouterLayer } =
    makeEventPublisherRouter()
  const eventPublisherLive = Layer.provide(
    eventPublisherRouterLayer,
    Layer.mergeAll(
      baseEventStoreLive,
      extensionRegistryLive,
      runtimePlatformLive,
      sessionCwdRegistryLive,
    ),
  )

  const storageSubTags = subTagLayers(storageLive)
  const baseServicesLive = Layer.mergeAll(
    runtimePlatformLive,
    storageLive,
    storageSubTags,
    baseEventStoreLive,
    eventPublisherLive,
    sessionCwdRegistryLive,
    authStorageLive,
    authStoreLive,
    authGuardLive,
    providerAuthLive,
    configServiceLive,
    Layer.provide(modelRegistryLive, FetchHttpClient.layer),
    extensionRegistryLive,
    fileLockServiceLive,
    providerLive,
    Layer.provide(FileIndexLive, runtimePlatformLive),
    FetchHttpClient.layer,
  )

  // ApprovalService — single handler for all interaction types
  const approvalServiceLive = Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const store = yield* InteractionStorage
        return ApprovalService.LiveWithStorage({
          persist: (record) => store.persist(record).pipe(Effect.catchEager(() => Effect.void)),
          resolve: (requestId) =>
            store.resolve(requestId).pipe(Effect.catchEager(() => Effect.void)),
        })
      }),
    ),
    baseServicesLive,
  )

  const promptPresenterLive = Layer.provide(
    PromptPresenter.Live,
    Layer.merge(approvalServiceLive, baseServicesLive),
  )
  const toolRunnerLive = Layer.provide(
    ToolRunner.Live,
    Layer.merge(baseServicesLive, approvalServiceLive),
  )

  const allDeps = Layer.mergeAll(
    baseServicesLive,
    approvalServiceLive,
    toolRunnerLive,
    promptPresenterLive,
    ResourceManagerLive,
  )

  // Recover pending interaction requests from storage.
  // Iterates persisted pending records and calls approvalService.rehydrate()
  // generically — no per-handler dispatch needed.
  const interactionRecoveryLive = Layer.effect(
    InteractionRecoveryTag,
    Effect.gen(function* () {
      const interactionStore = yield* InteractionStorage
      const approvalService = yield* ApprovalService

      const pending = yield* interactionStore.listPending()
      if (pending.length === 0) return { recovered: 0 }

      let recovered = 0
      for (const record of pending) {
        const params = yield* decodeInteractionParams(record.paramsJson).pipe(
          Effect.option,
          Effect.map((opt) => (opt._tag === "Some" ? opt.value : undefined)),
        )
        if (params === undefined) continue
        yield* approvalService
          .rehydrate(record.requestId, params, {
            sessionId: record.sessionId,
            branchId: record.branchId,
          })
          .pipe(Effect.catchEager(() => Effect.void))
        recovered++
      }

      if (recovered > 0) {
        yield* Effect.log(`Recovered ${recovered} pending interaction request(s)`)
      }

      return { recovered }
    }),
  ).pipe(Layer.provide(allDeps))

  // SessionProfileCache — lazy per-cwd extension/config/prompt profiles.
  // After construction, wire the profile cache into the EventPublisher
  // router handle so per-cwd dispatch can resolve profiles.
  const sessionProfileCacheLive = Layer.provide(
    Layer.effectDiscard(
      Effect.gen(function* () {
        const cache = yield* SessionProfileCache
        publisherRouterHandle.profileCache = cache
      }),
    ).pipe(
      Layer.provideMerge(
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
      ),
    ),
    allDeps,
  )

  const sessionRuntimeLive = Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const baseSections = yield* BasePromptSectionsTag
        return SessionRuntime.Live({ baseSections })
      }),
    ),
    Layer.mergeAll(allDeps, sessionProfileCacheLive),
  )

  const allWithRuntime = Layer.mergeAll(allDeps, sessionProfileCacheLive, sessionRuntimeLive)

  const agentRuntimeLive = Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const baseSections = yield* BasePromptSectionsTag
        const runnerConfig = {
          ...(config.subprocessBinaryPath !== undefined && config.subprocessBinaryPath !== ""
            ? { subprocessBinaryPath: config.subprocessBinaryPath }
            : {}),
          ...(config.dbPath !== undefined && config.dbPath !== "" ? { dbPath: config.dbPath } : {}),
          ...(config.sharedServerUrl !== undefined
            ? { sharedServerUrl: config.sharedServerUrl }
            : {}),
          baseSections,
        }
        return config.subprocessBinaryPath !== undefined && config.subprocessBinaryPath !== ""
          ? SubprocessRunner(runnerConfig)
          : InProcessRunner(runnerConfig)
      }),
    ),
    allWithRuntime,
  )

  return Layer.mergeAll(allWithRuntime, agentRuntimeLive, interactionRecoveryLive)
}
