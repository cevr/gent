import { Effect, Layer, Schema } from "effect"
import { SingleRunner } from "effect/unstable/cluster"
import { FetchHttpClient } from "effect/unstable/http"
import { Auth, AuthGuard } from "../domain/auth.js"
import { EventStore, EventStoreError } from "../domain/event.js"
import { FileLockService } from "../domain/file-lock.js"
import type { PromptSection } from "../domain/prompt.js"
import { PromptPresenterLive } from "../runtime/prompt-presenter-live.js"
import type { GentExtension } from "../domain/extension.js"
import { DebugSlowProviderDelayMs, Provider } from "../providers/provider.js"
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
import { BunGentPlatformLive, BunPlatformLive } from "../runtime/gent-platform-bun.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"
import { SqliteStorage } from "../storage/sqlite-storage.js"
import { InteractionStorage } from "../storage/interaction-storage.js"
import { decodeInteractionParams } from "../domain/interaction-request.js"
import { EventStoreLive } from "../runtime/event-store-live.js"
import { EventPublisherLive } from "../domain/event-publisher.js"
import { SessionCommands } from "./session-commands.js"
import {
  SessionProfileCache,
  sessionProfileFromRuntime,
  type SessionProfile,
} from "../runtime/session-profile.js"
import { FileIndexLive } from "../runtime/file-index/index.js"

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
  ...(config.authDirectory !== undefined ? { GENT_AUTH_DIRECTORY: config.authDirectory } : {}),
  ...(config.persistenceMode !== undefined
    ? { GENT_PERSISTENCE_MODE: config.persistenceMode }
    : {}),
  ...(config.providerMode !== undefined ? { GENT_PROVIDER_MODE: config.providerMode } : {}),
})

export const createDependencies = (config: DependenciesConfig) => {
  let launchSessionProfileSeed: SessionProfile | undefined
  let baseSectionsSeed: ReadonlyArray<PromptSection> | undefined
  const runtimePlatformLive = RuntimePlatform.Live({
    cwd: config.cwd,
    home: config.home,
    platform: config.platform,
  })

  const persistenceMode = config.persistenceMode ?? "disk"
  const providerMode = config.providerMode ?? "live"

  const storageLive =
    persistenceMode === "memory"
      ? SqliteStorage.MemoryWithSql()
      : SqliteStorage.LiveWithSql(config.dbPath ?? ".gent/data.db")
  const clusterRunnerLive = Layer.provide(
    SingleRunner.layer({
      runnerStorage: persistenceMode === "memory" ? "memory" : "sql",
    }),
    storageLive,
  )
  // Base event store: raw storage-backed publish/subscribe storage
  const baseEventStoreLive =
    persistenceMode === "memory" ? EventStore.Memory : Layer.provide(EventStoreLive, storageLive)

  // Auth lives in `~/.gent/auth/` (one URL-encoded file per provider).
  // `Auth.Live` requires FileSystem + Path; `BunPlatformLive` bundles
  // `BunServices.layer` (which provides them) with `BunGentPlatformLive`.
  const authDirectory = config.authDirectory ?? `${config.home}/.gent/auth`
  const authLive = Layer.provide(Auth.Live(authDirectory), BunPlatformLive)

  const configServiceLive = Layer.provide(ConfigService.Live, runtimePlatformLive)

  // Resolve and build the launch cwd profile runtime once. Server startup and
  // SessionProfileCache share this same profile so cwd-scoped resources have a
  // single owner.
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
      const profile = sessionProfileFromRuntime(runtime)
      launchSessionProfileSeed = profile
      baseSectionsSeed = runtime.baseSections
      // Publish a typed ServerProfile so downstream consumers (e.g. agent-runner)
      // can construct an EphemeralProfile through the runtime builder without
      // forging the brand themselves. Only this composition root may call
      // brandServerScope (lint-fenced).
      const serverProfileLayer = Layer.succeed(
        ServerProfileService,
        brandServerScope({ cwd: profile.cwd, resolved: profile.resolved }),
      )
      return Layer.mergeAll(Layer.succeedContext(runtime.layerContext), serverProfileLayer)
    }),
  )
  // Extension registry needs storageLive for SqlClient (extension task layers use it)
  // and ConfigService + RuntimePlatform + platform services for profile resolution.
  const extensionRegistryLive = Layer.provide(
    profileLayers,
    Layer.mergeAll(storageLive, configServiceLive, runtimePlatformLive, BunGentPlatformLive),
  )
  const modelRegistryLive = Layer.provide(
    ModelRegistry.Live,
    Layer.mergeAll(runtimePlatformLive, extensionRegistryLive, authLive),
  )
  const authDeps = Layer.mergeAll(authLive, extensionRegistryLive)
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
    providerLive = Provider.Debug({ delayMs: DebugSlowProviderDelayMs })
  }

  const eventPublisherLive = Layer.provide(EventPublisherLive, baseEventStoreLive)

  const baseServicesLive = Layer.mergeAll(
    runtimePlatformLive,
    BunGentPlatformLive,
    storageLive,
    clusterRunnerLive,
    baseEventStoreLive,
    eventPublisherLive,
    authLive,
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
        })
      }),
    ),
    baseServicesLive,
  )

  const promptPresenterLive = Layer.provide(
    PromptPresenterLive,
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

  // Recover pending interaction requests from storage by rehydrating the
  // approval presenter state. The actor mailbox owns cold turn replay; this
  // startup pass only restores the transport-facing prompt surface.
  const interactionRecoveryLive = Layer.effectDiscard(
    Effect.gen(function* () {
      const interactionStore = yield* InteractionStorage
      const approvalService = yield* ApprovalService

      const pending = yield* interactionStore.listPending()
      if (pending.length === 0) return

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
    }),
  ).pipe(Layer.provide(allDeps))

  // SessionProfileCache — lazy per-cwd extension/config/prompt profiles.
  const sessionProfileCacheLive = Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const launchProfile = launchSessionProfileSeed
        if (launchProfile === undefined) {
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
          initialProfiles: [launchProfile],
        })
      }),
    ),
    allDeps,
  )

  const sessionRuntimeLive = Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const baseSections = baseSectionsSeed
        if (baseSections === undefined) {
          return yield* new BootstrapError({ seed: "baseSections" })
        }
        return SessionRuntime.LiveWithEntity({ baseSections })
      }),
    ),
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

  const agentRuntimeLive = Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const baseSections = baseSectionsSeed
        if (baseSections === undefined) {
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
