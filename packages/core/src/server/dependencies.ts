import { Cause, Effect, FileSystem, Layer, Path, ServiceMap } from "effect"
import { AuthGuard } from "../domain/auth-guard.js"
import { AuthStorage } from "../domain/auth-storage.js"
import { AuthStore } from "../domain/auth-store.js"
import type {
  FailedExtension,
  InteractionHandlerType,
  LoadedExtension,
  ScheduledJobFailureInfo,
} from "../domain/extension.js"
import { EventStore } from "../domain/event.js"
import { FileLockService } from "../domain/file-lock.js"
import { HandoffHandler, PromptHandler } from "../domain/interaction-handlers.js"
import { Permission, PermissionRule } from "../domain/permission.js"
import { PromptPresenter } from "../domain/prompt-presenter.js"
import { Skills } from "../domain/skills.js"
import { DebugFailingProvider, DebugProvider } from "../debug/provider.js"
import { BuiltinExtensions } from "../extensions/index.js"
import { Provider } from "../providers/provider.js"
import { ProviderAuth } from "../providers/provider-auth.js"
import { AgentLoop } from "../runtime/agent/agent-loop.js"
import { InProcessRunner, SubprocessRunner } from "../runtime/agent/agent-runner.js"
import { ToolRunner } from "../runtime/agent/tool-runner.js"
import { LocalActorProcessLive } from "../runtime/actor-process.js"
import { ConfigService } from "../runtime/config-service.js"
import { discoverExtensions, setupExtension } from "../runtime/extensions/loader.js"
import {
  activateLoadedExtensions,
  setupBuiltinExtensions,
  validateLoadedExtensions,
} from "../runtime/extensions/activation.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { ExtensionStateRuntime } from "../runtime/extensions/state-runtime.js"
import { ExtensionTurnControl } from "../runtime/extensions/turn-control.js"
import { ExtensionEventBus } from "../runtime/extensions/event-bus.js"
import {
  reconcileScheduledJobs,
  type ScheduledJobCommand,
} from "../runtime/extensions/scheduler.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"
import { Storage } from "../storage/sqlite-storage.js"
import { InteractionStorage } from "../storage/interaction-storage.js"
import { AskUserHandler } from "../tools/ask-user.js"
import { EventStoreLive } from "./event-store.js"
import { EventPublisherLive } from "./event-publisher.js"
import { buildBasePromptSections } from "./system-prompt.js"
import type { InteractionRequestType } from "../domain/interaction-request.js"

/** Marker service — construction triggers recovery of pending interaction requests */
class InteractionRecoveryTag extends ServiceMap.Service<
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
  skillsDirs?: ReadonlyArray<string>
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

      const external: LoadedExtension[] = []
      const failedExtensions: FailedExtension[] = []
      for (const discoveredExtension of discovery.loaded) {
        if (disabledSet.has(discoveredExtension.extension.manifest.id)) continue
        const exit = yield* setupExtension(discoveredExtension, config.cwd, config.home).pipe(
          Effect.exit,
        )
        if (exit._tag === "Failure") {
          const error = String(Cause.squash(exit.cause))
          yield* Effect.logWarning("extension.setup.failed").pipe(
            Effect.annotateLogs({
              extensionId: discoveredExtension.extension.manifest.id,
              error,
            }),
          )
          failedExtensions.push({
            manifest: discoveredExtension.extension.manifest,
            kind: discoveredExtension.kind,
            sourcePath: discoveredExtension.sourcePath,
            phase: "setup",
            error,
          })
          continue
        }
        external.push(exit.value)
      }

      const builtinSetup = yield* setupBuiltinExtensions({
        extensions: BuiltinExtensions,
        cwd: config.cwd,
        home: config.home,
        disabled: disabledSet,
      })
      for (const failed of builtinSetup.failed) {
        yield* Effect.logWarning("extension.setup.failed").pipe(
          Effect.annotateLogs({
            extensionId: failed.manifest.id,
            error: failed.error,
          }),
        )
      }
      failedExtensions.push(...builtinSetup.failed)

      const allExtensions = [...builtinSetup.active, ...external]
      const validated = yield* validateLoadedExtensions(allExtensions)
      for (const failed of validated.failed) {
        yield* Effect.logWarning("extension.validation.failed").pipe(
          Effect.annotateLogs({
            extensionId: failed.manifest.id,
            error: failed.error,
          }),
        )
      }
      failedExtensions.push(...validated.failed)

      const activated = yield* activateLoadedExtensions(validated.active)
      for (const failed of activated.failed) {
        yield* Effect.logWarning("extension.startup.failed").pipe(
          Effect.annotateLogs({
            extensionId: failed.manifest.id,
            error: failed.error,
          }),
        )
      }
      failedExtensions.push(...activated.failed)

      const scheduledJobFailures = yield* reconcileScheduledJobs({
        extensions: activated.active,
        home: config.home,
        command: config.scheduledJobCommand,
        env: scheduledJobEnv(config),
      })
      for (const failure of scheduledJobFailures) {
        yield* Effect.logWarning("extension.scheduled-job.failed").pipe(
          Effect.annotateLogs({
            extensionId: failure.extensionId,
            jobId: failure.jobId,
            error: failure.error,
          }),
        )
      }
      const scheduledJobFailuresByExtension = new Map<
        string,
        ReadonlyArray<ScheduledJobFailureInfo>
      >()
      for (const failure of scheduledJobFailures) {
        const existing = scheduledJobFailuresByExtension.get(failure.extensionId) ?? []
        scheduledJobFailuresByExtension.set(failure.extensionId, [
          ...existing,
          { jobId: failure.jobId, error: failure.error },
        ])
      }

      // Collect extension-provided layers (setup.layer — default phase)
      const extensionLayers = activated.active
        .filter((ext) => ext.setup.layer !== undefined)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((ext) => ext.setup.layer as Layer.Layer<any>)

      // Collect bus subscriptions from extensions
      const busSubscriptions = activated.active.flatMap((ext) =>
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

      const extensionRuntimeLive = ExtensionStateRuntime.Live(activated.active).pipe(
        Layer.provideMerge(ExtensionTurnControl.Live),
      )

      const baseLayers = Layer.mergeAll(
        ExtensionRegistry.LiveWithFailures(
          activated.active,
          failedExtensions,
          scheduledJobFailuresByExtension,
        ),
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
  const skillsLive = Skills.Live({
    cwd: config.cwd,
    globalDir: `${config.home}/.gent/skills`,
    claudeSkillsDir: `${config.home}/.claude/skills`,
    extraDirs: config.skillsDirs,
  })
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
    skillsLive,
    extensionRegistryLive,
    fileLockServiceLive,
    providerLive,
  )

  const builtinDenyRules = [
    new PermissionRule({
      tool: "bash",
      pattern: "git\\s+(add\\s+[-.]|push\\s+--force|reset\\s+--hard|clean\\s+-f)",
      action: "deny",
    }),
    new PermissionRule({ tool: "bash", pattern: "rm\\s+-rf\\s+/", action: "deny" }),
  ]

  const permissionLive = Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const configService = yield* ConfigService
        const rules = yield* configService.getPermissionRules()
        return Permission.Live([...builtinDenyRules, ...rules], "allow")
      }),
    ),
    baseServicesLive,
  )
  const baseWithPermission = Layer.merge(baseServicesLive, permissionLive)

  // Interaction handler layers — resolved from extension registry with builtin fallback.
  const resolveHandlerLayer = <A, R>(
    type: InteractionHandlerType,
    fallback: Layer.Layer<A, never, R>,
  ) =>
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const registry = yield* ExtensionRegistry
          const h = yield* registry.getInteractionHandler(type)
          return (h?.layer ?? fallback) as Layer.Layer<A, never, R>
        }),
      ),
      baseWithPermission,
    )
  const interactionHandlersLive = Layer.mergeAll(
    resolveHandlerLayer("ask-user", AskUserHandler.Live),
    resolveHandlerLayer("prompt", PromptHandler.Live),
    resolveHandlerLayer("handoff", HandoffHandler.Live),
  )
  const promptPresenterLive = Layer.provide(
    PromptPresenter.Live,
    Layer.merge(interactionHandlersLive, baseWithPermission),
  )
  const toolRunnerLive = Layer.provide(
    ToolRunner.Live,
    Layer.merge(baseWithPermission, interactionHandlersLive),
  )

  const allDeps = Layer.mergeAll(
    baseWithPermission,
    interactionHandlersLive,
    toolRunnerLive,
    promptPresenterLive,
  )

  // Recover pending interaction requests from storage.
  // Dispatches each record to the appropriate handler's rehydrate method,
  // which re-creates the deferred and re-publishes the event so clients
  // re-present dialogs.
  const interactionRecoveryLive = Layer.effect(
    InteractionRecoveryTag,
    Effect.gen(function* () {
      const interactionStore = yield* InteractionStorage
      const promptHandler = yield* PromptHandler
      const handoffHandler = yield* HandoffHandler
      const askUserHandler = yield* AskUserHandler

      const pending = yield* interactionStore.listPending()
      if (pending.length === 0) return { recovered: 0 }

      const handlers: Record<
        InteractionRequestType,
        (record: (typeof pending)[number]) => Effect.Effect<void>
      > = {
        prompt: (r) => promptHandler.rehydrate(r).pipe(Effect.catchEager(() => Effect.void)),
        handoff: (r) => handoffHandler.rehydrate(r).pipe(Effect.catchEager(() => Effect.void)),
        "ask-user": (r) => askUserHandler.rehydrate(r).pipe(Effect.catchEager(() => Effect.void)),
      }

      let recovered = 0
      for (const record of pending) {
        const handler = handlers[record.type]
        if (handler !== undefined) {
          yield* handler(record)
          recovered++
        }
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
        const skills = yield* Skills
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const configService = yield* ConfigService

        const customInstructions = yield* configService.loadInstructions(config.cwd)
        const availableSkills = yield* skills.list()
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
          skills: availableSkills,
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
