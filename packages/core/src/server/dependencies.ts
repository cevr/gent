import { Effect, FileSystem, Layer, Path, Ref, ServiceMap } from "effect"
import { AuthGuard } from "../domain/auth-guard.js"
import { AuthStorage } from "../domain/auth-storage.js"
import { AuthStore } from "../domain/auth-store.js"
import type { InteractionHandlerType, LoadedExtension } from "../domain/extension.js"
import {
  BaseEventStore,
  EventStore,
  type AgentEvent,
  getEventBranchId,
  getEventSessionId,
} from "../domain/event.js"
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
import {
  discoverExtensions,
  setupExtension,
  validateExtensions,
} from "../runtime/extensions/loader.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { ExtensionStateRuntime } from "../runtime/extensions/state-runtime.js"
import { ExtensionTurnControl } from "../runtime/extensions/turn-control.js"
import { ExtensionEventBus } from "../runtime/extensions/event-bus.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"
import { Storage } from "../storage/sqlite-storage.js"
import { InteractionStorage } from "../storage/interaction-storage.js"
import { AskUserHandler } from "../tools/ask-user.js"
import { EventStoreLive } from "./event-store.js"
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
}

const loadBuiltinExtensions = (cwd: string, home: string): LoadedExtension[] =>
  BuiltinExtensions.map((extension) => ({
    manifest: extension.manifest,
    kind: "builtin" as const,
    sourcePath: "builtin",
    setup: Effect.runSync(extension.setup({ cwd, source: "builtin", home })),
  }))

import { readDisabledExtensions } from "../runtime/extensions/disabled.js"

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
      for (const discoveredExtension of discovery.loaded) {
        if (disabledSet.has(discoveredExtension.extension.manifest.id)) continue
        const loaded = yield* setupExtension(discoveredExtension, config.cwd, config.home).pipe(
          Effect.catchEager((error) =>
            Effect.logWarning("extension.setup.failed").pipe(
              Effect.annotateLogs({
                extensionId: discoveredExtension.extension.manifest.id,
                error: error.message,
              }),
              Effect.as(undefined),
            ),
          ),
        )
        if (loaded !== undefined) external.push(loaded)
      }

      const builtins = loadBuiltinExtensions(config.cwd, config.home).filter(
        (ext) => !disabledSet.has(ext.manifest.id),
      )
      const allExtensions = [...builtins, ...external]

      // Validate — same-scope collisions are fatal
      yield* validateExtensions(allExtensions)

      // Run extension onStartup hooks (fire-and-forget, no service requirements)
      for (const ext of allExtensions) {
        if (ext.setup.onStartup !== undefined) {
          yield* ext.setup.onStartup.pipe(
            Effect.catchEager((error) =>
              Effect.logWarning("extension.onStartup.failed").pipe(
                Effect.annotateLogs({ extensionId: ext.manifest.id, error: String(error) }),
              ),
            ),
          )
        }
      }

      // Register extension onShutdown hooks as scope finalizers
      for (const ext of allExtensions) {
        if (ext.setup.onShutdown !== undefined) {
          const shutdown = ext.setup.onShutdown
          yield* Effect.addFinalizer(() =>
            shutdown.pipe(
              Effect.catchEager((error) =>
                Effect.logWarning("extension.onShutdown.failed").pipe(
                  Effect.annotateLogs({ extensionId: ext.manifest.id, error: String(error) }),
                ),
              ),
            ),
          )
        }
      }

      // Collect extension-provided layers (setup.layer — default phase)
      const extensionLayers = allExtensions
        .filter((ext) => ext.setup.layer !== undefined)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((ext) => ext.setup.layer as Layer.Layer<any>)

      // Collect bus subscriptions from extensions
      const busSubscriptions = allExtensions.flatMap((ext) =>
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

      const baseLayers = Layer.mergeAll(
        ExtensionRegistry.Live(allExtensions),
        ExtensionStateRuntime.Live(allExtensions),
        ExtensionEventBus.withSubscriptions(busSubscriptions),
      )

      if (extensionLayers.length === 0) return baseLayers
      return Layer.mergeAll(baseLayers, ...extensionLayers)
    }),
  )

/**
 * ReducingEventStore wraps the BaseEventStore with extension state machine reduction.
 * On every publish, it:
 * 1. Delegates to BaseEventStore.publish (raw storage)
 * 2. Feeds the event to ExtensionStateRuntime.reduce
 * 3. If any machine changed state, publishes UI snapshots through BaseEventStore
 *
 * Re-entrance guard: a Ref tracks whether any reduce is in progress. If publish
 * is called while reduce is running, the nested publish skips reduce. This
 * prevents deadlocks from re-entrant semaphore acquisition in getOrSpawnActors.
 *
 * Note: this is a process-wide guard, not fiber-scoped. The inspector's
 * combineInspectors fans out to child fibers (concurrency: "unbounded"), so the
 * re-entrant MachineInspected publish comes from a different fiber than the
 * parent reduce. A fiber-ID guard misses this. The process-wide Ref is correct
 * because:
 * - Extension reduction is already serialized per session via spawnSemaphore
 * - Cross-session reduce suppression is safe (reduce is idempotent — the
 *   next publish for that session will catch up)
 * - This guard is temporary — Batch 4 decouples reduce from publish entirely
 */
export const makeReducingEventStore = Layer.effect(
  EventStore,
  Effect.gen(function* () {
    const base = yield* BaseEventStore
    const stateRuntime = yield* ExtensionStateRuntime
    const busOpt = yield* Effect.serviceOption(ExtensionEventBus)
    const bus = busOpt._tag === "Some" ? busOpt.value : undefined
    const reduceDepth = yield* Ref.make(0)

    return {
      publish: (event: AgentEvent) =>
        base.publish(event).pipe(
          Effect.tap(() => {
            const sessionId = getEventSessionId(event)
            if (sessionId === undefined) return Effect.void

            return Ref.get(reduceDepth).pipe(
              Effect.flatMap((depth) => {
                if (depth > 0) {
                  return Effect.logDebug("re-entrant reduce skipped").pipe(
                    Effect.annotateLogs({ event: event._tag, depth }),
                  )
                }

                const branchId = getEventBranchId(event)
                return Ref.update(reduceDepth, (d: number) => d + 1).pipe(
                  Effect.andThen(
                    stateRuntime.publish(event, { sessionId, branchId }).pipe(
                      Effect.tap((changed) => {
                        if (!changed || branchId === undefined) return Effect.void
                        return stateRuntime.getUiSnapshots(sessionId, branchId).pipe(
                          Effect.tap((snapshots) =>
                            Effect.forEach(snapshots, (snapshot) => base.publish(snapshot), {
                              concurrency: "unbounded",
                            }),
                          ),
                          Effect.catchEager(() => Effect.void),
                        )
                      }),
                      Effect.catchDefect(() => Effect.void),
                      // Notify observers after reduction (fire-and-forget)
                      Effect.tap(() => stateRuntime.notifyObservers(event)),
                      // Publish agent event to bus
                      Effect.tap(() => {
                        if (bus === undefined) return Effect.void
                        return bus
                          .emit({
                            channel: `agent:${event._tag}`,
                            payload: event,
                            sessionId,
                            branchId,
                          })
                          .pipe(Effect.catchEager(() => Effect.void))
                      }),
                    ),
                  ),
                  Effect.ensuring(Ref.update(reduceDepth, (d: number) => d - 1)),
                )
              }),
            )
          }),
        ),
      subscribe: base.subscribe,
      removeSession: base.removeSession,
    }
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
  // Base event store: raw storage-backed publisher (provides both BaseEventStore and EventStore initially)
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

  // ReducingEventStore wraps BaseEventStore with extension reduce.
  // It requires BaseEventStore + ExtensionStateRuntime (from extensionRegistryLive).
  const reducingEventStoreLive = Layer.provide(
    makeReducingEventStore,
    Layer.merge(baseEventStoreLive, extensionRegistryLive),
  )

  const baseServicesLive = Layer.mergeAll(
    runtimePlatformLive,
    storageLive,
    baseEventStoreLive,
    reducingEventStoreLive,
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

  const turnControlLive = Layer.provide(
    ExtensionTurnControl.Live,
    Layer.merge(allDeps, agentRuntimeLive),
  )
  const allWithRuntime = Layer.mergeAll(allDeps, agentRuntimeLive, turnControlLive)

  const actorProcessLive = Layer.provide(LocalActorProcessLive, allWithRuntime)
  return Layer.mergeAll(allWithRuntime, actorProcessLive, interactionRecoveryLive)
}
