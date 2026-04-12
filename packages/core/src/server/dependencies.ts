import { Effect, FileSystem, Layer, Path, Context } from "effect"
import { AuthGuard } from "../domain/auth-guard.js"
import { AuthStorage } from "../domain/auth-storage.js"
import { AuthStore } from "../domain/auth-store.js"
import { EventStore } from "../domain/event.js"
import { FileLockService } from "../domain/file-lock.js"
import { Permission } from "../domain/permission.js"
import { PromptPresenter } from "../domain/prompt-presenter.js"
import { DebugFailingProvider, DebugProvider } from "../debug/provider.js"
import { BuiltinExtensions } from "../extensions/index.js"
import { Provider } from "../providers/provider.js"
import { ProviderAuth } from "../providers/provider-auth.js"
import { AgentLoop } from "../runtime/agent/agent-loop.js"
import { ApprovalService } from "../runtime/approval-service.js"
import { InProcessRunner, SubprocessRunner } from "../runtime/agent/agent-runner.js"
import { ToolRunner } from "../runtime/agent/tool-runner.js"
import { LocalActorProcessLive } from "../runtime/actor-process.js"
import { ConfigService } from "../runtime/config-service.js"
import { discoverExtensions } from "../runtime/extensions/loader.js"
import {
  reconcileLoadedExtensions,
  setupDiscoveredExtensions,
  setupBuiltinExtensions,
} from "../runtime/extensions/activation.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { ExtensionStateRuntime } from "../runtime/extensions/state-runtime.js"
import { ExtensionTurnControl } from "../runtime/extensions/turn-control.js"
import { ExtensionEventBus } from "../runtime/extensions/event-bus.js"
import { type ScheduledJobCommand } from "../runtime/extensions/scheduler.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"
import { Storage } from "../storage/sqlite-storage.js"
import { InteractionStorage } from "../storage/interaction-storage.js"
import { decodeInteractionParams } from "../domain/interaction-request.js"
import { EventStoreLive } from "../runtime/event-store-live.js"
import { EventPublisherLive } from "./event-publisher.js"
import { buildBasePromptSections } from "./system-prompt.js"

/** Marker service — construction triggers recovery of pending interaction requests */
class InteractionRecoveryTag extends Context.Service<
  InteractionRecoveryTag,
  { readonly recovered: number }
>()("@gent/core/src/server/dependencies/InteractionRecoveryTag") {}

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
}

import { readDisabledExtensions } from "../runtime/extensions/disabled.js"

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

const extensionFailureLogMessage = (phase: "setup" | "validation" | "startup") => {
  if (phase === "setup") return "extension.setup.failed"
  if (phase === "validation") return "extension.validation.failed"
  return "extension.startup.failed"
}

const makeExtensionLayers = (config: DependenciesConfig) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path
      const disabledSet = yield* readDisabledExtensions({
        home: config.home,
        cwd: config.cwd,
        extra: config.disabledExtensions,
      })

      const userExtensionsDir = path.join(config.home, ".gent", "extensions")
      const projectExtensionsDir = path.join(config.cwd, ".gent", "extensions")
      const discovery = yield* discoverExtensions({
        userDir: userExtensionsDir,
        projectDir: projectExtensionsDir,
      }).pipe(
        Effect.catchEager((error) =>
          Effect.logWarning("extension.discovery.failed").pipe(
            Effect.annotateLogs({ error: String(error) }),
            Effect.as({ loaded: [] as const, skipped: [] as const }),
          ),
        ),
      )

      if (discovery.skipped.length > 0) {
        yield* Effect.logWarning("extension.discovery.summary").pipe(
          Effect.annotateLogs({
            loaded: String(discovery.loaded.length),
            skipped: String(discovery.skipped.length),
          }),
        )
      }

      const externalSetup = yield* setupDiscoveredExtensions({
        extensions: discovery.loaded,
        cwd: config.cwd,
        home: config.home,
        disabled: disabledSet,
      })

      const builtinSetup = yield* setupBuiltinExtensions({
        extensions: BuiltinExtensions,
        cwd: config.cwd,
        home: config.home,
        disabled: disabledSet,
      })
      const reconciled = yield* reconcileLoadedExtensions({
        extensions: [...builtinSetup.active, ...externalSetup.active],
        failedExtensions: [...builtinSetup.failed, ...externalSetup.failed],
        home: config.home,
        command: config.scheduledJobCommand,
        env: scheduledJobEnv(config),
      })
      for (const failed of reconciled.resolved.failedExtensions) {
        const message = extensionFailureLogMessage(failed.phase)
        yield* Effect.logWarning(message).pipe(
          Effect.annotateLogs({
            extensionId: failed.manifest.id,
            error: failed.error,
          }),
        )
      }
      for (const failure of reconciled.scheduledJobFailures) {
        yield* Effect.logWarning("extension.scheduled-job.failed").pipe(
          Effect.annotateLogs({
            extensionId: failure.extensionId,
            jobId: failure.jobId,
            error: failure.error,
          }),
        )
      }

      // Collect extension-provided layers (setup.layer — default phase)
      const extensionLayers = reconciled.resolved.extensions
        .filter((ext) => ext.setup.layer !== undefined)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((ext) => ext.setup.layer as Layer.Layer<any>)

      // Collect bus subscriptions from extensions
      const busSubscriptions = reconciled.resolved.extensions.flatMap((ext) =>
        (ext.setup.busSubscriptions ?? []).map((sub) => ({
          pattern: sub.pattern,
          handler: sub.handler as (envelope: {
            channel: string
            payload: unknown
            sessionId?: string
            branchId?: string
          }) => void | Promise<void>,
        })),
      )

      const extensionRuntimeLive = ExtensionStateRuntime.Live(reconciled.resolved.extensions).pipe(
        Layer.provideMerge(ExtensionTurnControl.Live),
      )

      const baseLayers = Layer.mergeAll(
        ExtensionRegistry.fromResolved(reconciled.resolved),
        extensionRuntimeLive,
        ExtensionEventBus.withSubscriptions(busSubscriptions),
      )

      if (extensionLayers.length === 0) return baseLayers
      return Layer.mergeAll(baseLayers, ...extensionLayers)
    }),
  )

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
  // Extension registry needs storageLive for SqlClient (extension task layers use it)
  const extensionRegistryLive = Layer.provide(makeExtensionLayers(config), storageLive)
  const modelRegistryLive = Layer.provide(
    ModelRegistry.Live,
    Layer.mergeAll(runtimePlatformLive, extensionRegistryLive, authStoreLive),
  )
  const authDeps = Layer.merge(authStoreLive, extensionRegistryLive)
  const authGuardLive = Layer.provide(AuthGuard.Live, authDeps)
  const providerAuthLive = Layer.provide(ProviderAuth.Live, authDeps)
  const fileLockServiceLive = FileLockService.layer

  let providerLive = Layer.provide(Provider.Live, authDeps)
  if (providerMode === "debug-scripted") providerLive = DebugProvider()
  else if (providerMode === "debug-failing") providerLive = DebugFailingProvider
  else if (providerMode === "debug-slow") providerLive = DebugProvider({ delayMs: 10 })

  const eventPublisherLive = Layer.provide(
    EventPublisherLive,
    Layer.merge(baseEventStoreLive, extensionRegistryLive),
  )

  const baseServicesLive = Layer.mergeAll(
    runtimePlatformLive,
    storageLive,
    baseEventStoreLive,
    eventPublisherLive,
    authStorageLive,
    authStoreLive,
    authGuardLive,
    providerAuthLive,
    configServiceLive,
    modelRegistryLive,
    extensionRegistryLive,
    fileLockServiceLive,
    providerLive,
  )

  const permissionLive = Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const configService = yield* ConfigService
        const extensionRegistry = yield* ExtensionRegistry
        const [configRules, extensionRules] = yield* Effect.all([
          configService.getPermissionRules(),
          extensionRegistry.listPermissionRules(),
        ])
        return Permission.Live([...extensionRules, ...configRules], "allow")
      }),
    ),
    baseServicesLive,
  )
  const baseWithPermission = Layer.merge(baseServicesLive, permissionLive)

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
    baseWithPermission,
  )

  const promptPresenterLive = Layer.provide(
    PromptPresenter.Live,
    Layer.merge(approvalServiceLive, baseWithPermission),
  )
  const toolRunnerLive = Layer.provide(
    ToolRunner.Live,
    Layer.merge(baseWithPermission, approvalServiceLive),
  )

  const allDeps = Layer.mergeAll(
    baseWithPermission,
    approvalServiceLive,
    toolRunnerLive,
    promptPresenterLive,
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

  const agentRuntimeLive = Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const configService = yield* ConfigService

        const customInstructions = yield* configService.loadInstructions(config.cwd)
        const isGitRepo = yield* fs.exists(path.join(config.cwd, ".git"))
        const registry = yield* ExtensionRegistry
        const extensionSections = yield* registry.listPromptSections()

        // Merge base + extension-contributed sections. Extension sections shadow base by id.
        const coreSections = buildBasePromptSections({
          cwd: config.cwd,
          platform: config.platform,
          shell: config.shell,
          osVersion: config.osVersion,
          isGitRepo,
          customInstructions,
        })
        const sectionMap = new Map(coreSections.map((s) => [s.id, s]))
        for (const s of extensionSections) {
          sectionMap.set(s.id, s)
        }
        const baseSections = [...sectionMap.values()]
        const runnerConfig = {
          ...(config.subprocessBinaryPath !== undefined && config.subprocessBinaryPath !== ""
            ? { subprocessBinaryPath: config.subprocessBinaryPath }
            : {}),
          ...(config.dbPath !== undefined && config.dbPath !== "" ? { dbPath: config.dbPath } : {}),
          baseSections,
        }
        const agentLoopLive = AgentLoop.Live({ baseSections })
        const agentRunnerLive =
          config.subprocessBinaryPath !== undefined && config.subprocessBinaryPath !== ""
            ? SubprocessRunner(runnerConfig)
            : InProcessRunner(runnerConfig).pipe(Layer.provideMerge(agentLoopLive))

        return Layer.mergeAll(agentLoopLive, agentRunnerLive)
      }),
    ),
    allDeps,
  )

  // Wake checkpointed agent loops on startup so in-flight turns resume
  // without waiting for a client to open the session.
  // Checkpoint restore is lazy — triggered by findOrRestoreLoop when a
  // client opens a session. No eager wake on startup.

  const allWithRuntime = Layer.mergeAll(allDeps, agentRuntimeLive)

  const actorProcessLive = Layer.provide(LocalActorProcessLive, allWithRuntime)
  return Layer.mergeAll(allWithRuntime, actorProcessLive, interactionRecoveryLive)
}
