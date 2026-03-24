import { Effect, FileSystem, Layer, Path, ServiceMap } from "effect"
import { AuthGuard } from "../domain/auth-guard.js"
import { AuthStorage } from "../domain/auth-storage.js"
import { AuthStore } from "../domain/auth-store.js"
import type { LoadedExtension } from "../domain/extension.js"
import { EventStore } from "../domain/event.js"
import { FileLockService } from "../domain/file-lock.js"
import { HandoffHandler, PermissionHandler, PromptHandler } from "../domain/interaction-handlers.js"
import { Permission } from "../domain/permission.js"
import { PromptPresenter } from "../domain/prompt-presenter.js"
import { Skills } from "../domain/skills.js"
import { DebugFailingProvider, DebugProvider, DebugSlowProvider } from "../debug/provider.js"
import { BuiltinExtensions } from "../extensions/index.js"
import { Provider } from "../providers/provider.js"
import { ProviderAuth } from "../providers/provider-auth.js"
import { ProviderFactory } from "../providers/provider-factory.js"
import { AgentActor, AgentLoop } from "../runtime/agent/agent-loop.js"
import {
  InProcessRunner,
  SubagentRunnerConfig,
  SubprocessRunner,
} from "../runtime/agent/subagent-runner.js"
import { ClusterSingleLive, type ClusterStorage } from "../runtime/cluster-layer.js"
import { ToolRunner } from "../runtime/agent/tool-runner.js"
import {
  ClusterActorTransportLive,
  DurableActorProcessLive,
  LocalActorProcessLive,
  SessionActorEntityLocalLive,
} from "../runtime/actor-process.js"
import { ConfigService } from "../runtime/config-service.js"
import { discoverExtensions, setupExtension } from "../runtime/extensions/loader.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { ExtensionStateRuntime } from "../runtime/extensions/state-runtime.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"
import { SqliteClientLive } from "../runtime/sql-client.js"
import { TaskService } from "../runtime/task-service.js"
import { Storage } from "../storage/sqlite-storage.js"
import { AskUserHandler } from "../tools/ask-user.js"
import { EventStoreLive } from "./event-store.js"
import { buildBasePromptSections, compileSystemPrompt } from "./system-prompt.js"
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
  subprocessBinaryPath?: string
  dbPath?: string
  authFilePath?: string
  authKeyPath?: string
  skillsDirs?: ReadonlyArray<string>
  persistenceMode?: "disk" | "memory"
  providerMode?: "live" | "debug-scripted" | "debug-failing" | "debug-slow"
  actorRuntime?: "local" | "cluster"
  clusterDbPath?: string
  clusterStorage?: ClusterStorage
}

const loadBuiltinExtensions = (cwd: string): LoadedExtension[] =>
  BuiltinExtensions.map((extension) => ({
    manifest: extension.manifest,
    kind: "builtin" as const,
    sourcePath: "builtin",
    setup: Effect.runSync(extension.setup({ cwd, config: undefined as never, source: "builtin" })),
  }))

const makeExtensionLayers = (config: DependenciesConfig) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path
      const userExtensionsDir = path.join(config.home, ".gent", "extensions")
      const projectExtensionsDir = path.join(config.cwd, ".gent", "extensions")
      const discovered = yield* discoverExtensions({
        userDir: userExtensionsDir,
        projectDir: projectExtensionsDir,
      }).pipe(Effect.catchEager(() => Effect.succeed([] as const)))

      const external: LoadedExtension[] = []
      for (const discoveredExtension of discovered) {
        const loaded = yield* setupExtension(discoveredExtension, config.cwd).pipe(
          Effect.catchEager((error) =>
            Effect.logWarning(
              `Failed to load extension ${discoveredExtension.extension.manifest.id}: ${error.message}`,
            ).pipe(Effect.as(undefined)),
          ),
        )
        if (loaded !== undefined) external.push(loaded)
      }

      const allExtensions = [...loadBuiltinExtensions(config.cwd), ...external]
      return Layer.merge(
        ExtensionRegistry.Live(allExtensions),
        ExtensionStateRuntime.Live(allExtensions),
      )
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
  const actorRuntime = config.actorRuntime ?? "local"

  const storageLive =
    persistenceMode === "memory" ? Storage.Memory() : Storage.Live(config.dbPath ?? ".gent/data.db")
  const eventStoreLive =
    persistenceMode === "memory" ? EventStore.Memory : Layer.provide(EventStoreLive, storageLive)

  const authStorageLive = AuthStorage.LiveSystem({
    serviceName: "gent",
    ...(config.authFilePath !== undefined ? { filePath: config.authFilePath } : {}),
    ...(config.authKeyPath !== undefined ? { keyPath: config.authKeyPath } : {}),
  })
  const authStoreLive = Layer.provide(AuthStore.Live, authStorageLive)
  const authGuardLive = Layer.provide(AuthGuard.Live, authStoreLive)
  const providerAuthLive = Layer.provide(ProviderAuth.Live, authStoreLive)

  const configServiceLive = Layer.provide(ConfigService.Live, runtimePlatformLive)
  const modelRegistryLive = Layer.provide(ModelRegistry.Live, runtimePlatformLive)
  const skillsLive = Skills.Live({
    cwd: config.cwd,
    globalDir: `${config.home}/.gent/skills`,
    claudeSkillsDir: `${config.home}/.claude/skills`,
    extraDirs: config.skillsDirs,
  })
  const extensionRegistryLive = makeExtensionLayers(config)
  const fileLockServiceLive = FileLockService.layer

  const providerFactoryLive = Layer.provide(ProviderFactory.Live, authStoreLive)
  let providerLive = Layer.provide(Provider.Live, providerFactoryLive)
  if (providerMode === "debug-scripted") providerLive = DebugProvider
  else if (providerMode === "debug-failing") providerLive = DebugFailingProvider
  else if (providerMode === "debug-slow") providerLive = DebugSlowProvider

  const baseServicesLive = Layer.mergeAll(
    runtimePlatformLive,
    storageLive,
    eventStoreLive,
    authStorageLive,
    authStoreLive,
    authGuardLive,
    providerAuthLive,
    configServiceLive,
    modelRegistryLive,
    skillsLive,
    extensionRegistryLive,
    fileLockServiceLive,
    providerFactoryLive,
    providerLive,
  )

  const permissionLive = Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const configService = yield* ConfigService
        const rules = yield* configService.getPermissionRules()
        return Permission.Live(rules, "ask")
      }),
    ),
    baseServicesLive,
  )
  const baseWithPermission = Layer.merge(baseServicesLive, permissionLive)

  const askUserHandlerLive = Layer.provide(AskUserHandler.Live, baseWithPermission)
  const permissionHandlerLive = Layer.provide(PermissionHandler.Live, baseWithPermission)
  const toolRunnerLive = Layer.provide(
    ToolRunner.Live,
    Layer.merge(baseWithPermission, permissionHandlerLive),
  )
  const promptHandlerLive = Layer.provide(PromptHandler.Live, baseWithPermission)
  const promptPresenterLive = Layer.provide(
    PromptPresenter.Live,
    Layer.merge(promptHandlerLive, baseWithPermission),
  )
  const handoffHandlerLive = Layer.provide(HandoffHandler.Live, baseWithPermission)

  const allDeps = Layer.mergeAll(
    baseWithPermission,
    askUserHandlerLive,
    permissionHandlerLive,
    toolRunnerLive,
    promptHandlerLive,
    promptPresenterLive,
    handoffHandlerLive,
  )

  // Recover pending interaction requests from storage.
  // Dispatches each record to the appropriate handler's rehydrate method,
  // which re-creates the deferred and re-publishes the event so clients
  // re-present dialogs.
  const interactionRecoveryLive = Layer.effect(
    InteractionRecoveryTag,
    Effect.gen(function* () {
      const storage = yield* Storage
      const permissionHandler = yield* PermissionHandler
      const promptHandler = yield* PromptHandler
      const handoffHandler = yield* HandoffHandler
      const askUserHandler = yield* AskUserHandler

      const pending = yield* storage.listPendingInteractionRequests()
      if (pending.length === 0) return { recovered: 0 }

      const handlers: Record<
        InteractionRequestType,
        (record: (typeof pending)[number]) => Effect.Effect<void>
      > = {
        permission: (r) =>
          permissionHandler.rehydrate(r).pipe(Effect.catchEager(() => Effect.void)),
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
        const baseSections = buildBasePromptSections({
          cwd: config.cwd,
          platform: config.platform,
          isGitRepo,
          customInstructions,
          skills: availableSkills,
        })
        const systemPrompt = compileSystemPrompt(baseSections)

        const agentActorLive = AgentActor.Live
        const subagentRunnerConfigLive = SubagentRunnerConfig.Live({
          systemPrompt,
          ...(config.subprocessBinaryPath !== undefined && config.subprocessBinaryPath !== ""
            ? { subprocessBinaryPath: config.subprocessBinaryPath }
            : {}),
          ...(config.dbPath !== undefined && config.dbPath !== "" ? { dbPath: config.dbPath } : {}),
        })
        const subagentRunnerLive =
          config.subprocessBinaryPath !== undefined && config.subprocessBinaryPath !== ""
            ? SubprocessRunner.pipe(Layer.provideMerge(subagentRunnerConfigLive))
            : InProcessRunner.pipe(
                Layer.provideMerge(agentActorLive),
                Layer.provideMerge(subagentRunnerConfigLive),
              )

        return Layer.mergeAll(
          AgentLoop.Live({ baseSections }),
          agentActorLive,
          subagentRunnerConfigLive,
          subagentRunnerLive,
        )
      }),
    ),
    allDeps,
  )

  const taskServiceLive = Layer.provide(TaskService.Live, Layer.merge(allDeps, agentRuntimeLive))
  const allWithRuntime = Layer.mergeAll(allDeps, agentRuntimeLive, taskServiceLive)

  if (actorRuntime === "cluster") {
    const clusterSqliteLive = SqliteClientLive({
      filename:
        config.clusterDbPath ?? (persistenceMode === "memory" ? ":memory:" : ".gent/cluster.db"),
    })
    const clusterRuntimeLive = ClusterSingleLive({
      runnerStorage: config.clusterStorage ?? (persistenceMode === "memory" ? "memory" : "sql"),
    }).pipe(Layer.provide(clusterSqliteLive))
    const entityLive = SessionActorEntityLocalLive.pipe(
      Layer.provide(allWithRuntime),
      Layer.provideMerge(clusterRuntimeLive),
    )
    const clusterSupportLive = Layer.merge(clusterRuntimeLive, entityLive)
    const actorTransportLive = Layer.provide(ClusterActorTransportLive, clusterSupportLive)
    const actorProcessLive = Layer.provide(
      DurableActorProcessLive,
      Layer.merge(allWithRuntime, actorTransportLive),
    )
    return Layer.mergeAll(
      allWithRuntime,
      clusterSupportLive,
      actorProcessLive,
      interactionRecoveryLive,
    )
  }

  const actorProcessLive = Layer.provide(LocalActorProcessLive, allWithRuntime)
  return Layer.mergeAll(allWithRuntime, actorProcessLive, interactionRecoveryLive)
}
