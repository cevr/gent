/**
 * RuntimeProfileResolver — single discover/setup/reconcile pipeline used by
 * every composition root that needs to *discover* extensions.
 *
 * Three callers build the same `{ registry, state-runtime, subscription-engine }`
 * shape via the same `buildExtensionLayers` substrate:
 *
 *   1. Server startup (`packages/core/src/server/dependencies.ts`)
 *      → calls `resolveRuntimeProfile` + `buildExtensionLayers`
 *   2. Per-cwd profile cache (`packages/core/src/runtime/session-profile.ts`)
 *      → calls `resolveRuntimeProfile` + `buildExtensionLayers`
 *   3. Ephemeral child runs (`packages/core/src/runtime/agent/agent-runner.ts`)
 *      → forwards parent's already-resolved `ExtensionRegistry` (same cwd, no
 *        rediscovery needed) + calls `buildExtensionLayers(registry.getResolved())`
 *
 * All three end up with the same registry / state-runtime / subscription-engine
 * shape — no more drift like the per-cwd path silently dropping pub/sub
 * subscriptions and no more drift between ephemeral and server runtimes.
 *
 * Per `subtract-before-you-add` and `foundational-thinking`: collapse parallel
 * construction paths into a single substrate; downstream code becomes obvious.
 *
 * @module
 */

import { Context, Effect, FileSystem, Layer, Path, type Scope } from "effect"
import type { GentExtension } from "../domain/extension.js"
import { type PromptSection } from "../domain/prompt.js"
import {
  type PermissionRule,
  type PermissionService,
  compilePermissionRules,
  evaluatePermissionRules,
} from "../domain/permission.js"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ExtensionRegistry, type ResolvedExtensions } from "./extensions/registry.js"
import { DriverRegistry } from "./extensions/driver-registry.js"
import { MachineEngine } from "./extensions/resource-host/machine-engine.js"
import { MachineExecute } from "./extensions/machine-execute.js"
import { ExtensionTurnControl } from "./extensions/turn-control.js"
import {
  buildResourceLayer,
  collectSubscriptions,
  SubscriptionEngine,
} from "./extensions/resource-host/index.js"
import { ActorEngine } from "./extensions/actor-engine.js"
import { ActorHost, ActorHostFailures, type ActorSpawnFailure } from "./extensions/actor-host.js"
import {
  reconcileLoadedExtensions,
  setupBuiltinExtensions,
  setupDiscoveredExtensions,
} from "./extensions/activation.js"
import { discoverExtensions } from "./extensions/loader.js"
import { readDisabledExtensions } from "./extensions/disabled.js"
import type {
  ScheduledJobCommand,
  SchedulerFailure,
} from "./extensions/resource-host/schedule-engine.js"
import { buildBasePromptSections } from "../domain/prompt.js"
import { ConfigService, type ConfigServiceService, type UserConfig } from "./config-service.js"

/**
 * Inputs that fully describe a runtime profile.
 *
 * `cwd` is the only per-call axis; everything else is composition-root configuration
 * (home dir, platform metadata, builtin extensions, scheduler).
 */
export interface RuntimeProfileInputs {
  readonly cwd: string
  readonly home: string
  readonly platform: string
  readonly shell?: string
  readonly osVersion?: string
  readonly extensions: ReadonlyArray<GentExtension>
  readonly disabledExtensions?: ReadonlyArray<string>
  readonly scheduledJobCommand?: ScheduledJobCommand
  readonly scheduledJobEnv?: Readonly<Record<string, string>>
}

/**
 * Output of the resolver — everything a downstream composer needs to wire layers.
 *
 * `coreSections` are the static, environment-derived sections (cwd, platform,
 * git state, custom instructions). `extensionSectionInputs` are the
 * extension-contributed sections in scope-precedence order (project > user > builtin),
 * possibly dynamic — they must be resolved later inside the extension-services
 * runtime so that dynamic resolvers like `Skills`'s prompt section can read their
 * required services.
 *
 * Use `compileBaseSections(profile)` to get the merged static section array.
 * (Dynamic sections — formerly `DynamicPromptSection.resolve` — are now
 * `Projection.prompt(value)` and assembled per-turn, not here.)
 */
export interface RuntimeProfile {
  readonly cwd: string
  readonly resolved: ResolvedExtensions
  readonly coreSections: ReadonlyArray<PromptSection>
  readonly extensionSectionInputs: ReadonlyArray<PromptSection>
  readonly instructions: string
  readonly scheduledJobFailures: ReadonlyArray<SchedulerFailure>
}

const permissionRulesFromConfig = (config: UserConfig) => config.permissions ?? []

export const makeProfilePermissionService = (params: {
  readonly cwd: string
  readonly configService: ConfigServiceService
  readonly extensionRules: ReadonlyArray<PermissionRule>
}): PermissionService => {
  const compiledExtensionRules = compilePermissionRules(params.extensionRules)

  return {
    check: Effect.fn("RuntimeProfile.permission.check")(function* (tool, args) {
      const config = yield* params.configService.get(params.cwd)
      const compiledConfigRules = compilePermissionRules(permissionRulesFromConfig(config))
      return evaluatePermissionRules(
        [...compiledExtensionRules, ...compiledConfigRules],
        tool,
        args,
        "allow",
      )
    }),
    addRule: (rule) => params.configService.addPermissionRule(rule),
    removeRule: (tool, pattern) => params.configService.removePermissionRule(tool, pattern),
    getRules: Effect.fn("RuntimeProfile.permission.getRules")(function* () {
      const config = yield* params.configService.get(params.cwd)
      return [...params.extensionRules, ...permissionRulesFromConfig(config)]
    }),
  }
}

const extensionFailureLogMessage = (phase: "setup" | "validation" | "startup") => {
  if (phase === "setup") return "extension.setup.failed"
  if (phase === "validation") return "extension.validation.failed"
  return "extension.startup.failed"
}

export const logRuntimeProfileFailures = (profile: RuntimeProfile) =>
  Effect.gen(function* () {
    for (const failed of profile.resolved.failedExtensions) {
      const message = extensionFailureLogMessage(failed.phase)
      yield* Effect.logWarning(message).pipe(
        Effect.annotateLogs({
          extensionId: failed.manifest.id,
          phase: failed.phase,
          error: failed.error,
          cwd: profile.cwd,
        }),
      )
    }
    for (const failure of profile.scheduledJobFailures) {
      yield* Effect.logWarning("extension.scheduled-job.failed").pipe(
        Effect.annotateLogs({
          extensionId: failure.extensionId,
          jobId: failure.jobId,
          error: failure.error,
          cwd: profile.cwd,
        }),
      )
    }
  })

/**
 * Run the discover → setup → reconcile → sections pipeline once.
 *
 * The returned `RuntimeProfile` is a pure data record. Caller chooses scope:
 *   - server startup: invoke once at boot, hold for server lifetime.
 *   - per-cwd cache: invoke per unique cwd, cache by canonical path.
 *
 * Ephemeral runs do not call this — they forward `ExtensionRegistry` from
 * the parent (same cwd, no rediscovery needed) and call `buildExtensionLayers`
 * directly on the forwarded `ResolvedExtensions`.
 *
 * Requires `Scope.Scope` because `reconcileLoadedExtensions` registers
 * scope-tied finalizers (extension `onShutdown` and scheduled jobs).
 */
export const resolveRuntimeProfile = (
  inputs: RuntimeProfileInputs,
): Effect.Effect<
  RuntimeProfile,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner | ConfigService | Scope.Scope
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const configService = yield* ConfigService

    const canonicalCwd = path.resolve(inputs.cwd)

    // 1. Disabled set (file-based + caller-provided)
    const disabledSet = yield* readDisabledExtensions({
      home: inputs.home,
      cwd: canonicalCwd,
      extra: inputs.disabledExtensions,
    })

    // 2. Discover external extensions (user + project dirs)
    const userExtensionsDir = path.join(inputs.home, ".gent", "extensions")
    const projectExtensionsDir = path.join(canonicalCwd, ".gent", "extensions")
    const discovery = yield* discoverExtensions({
      userDir: userExtensionsDir,
      projectDir: projectExtensionsDir,
    }).pipe(
      Effect.catchEager((error) =>
        Effect.logWarning("runtime-profile.extension.discovery.failed").pipe(
          Effect.annotateLogs({ error: String(error), cwd: canonicalCwd }),
          Effect.as({ loaded: [] as const, skipped: [] as const }),
        ),
      ),
    )

    if (discovery.skipped.length > 0) {
      yield* Effect.logWarning("runtime-profile.extension.discovery.summary").pipe(
        Effect.annotateLogs({
          loaded: String(discovery.loaded.length),
          skipped: String(discovery.skipped.length),
          cwd: canonicalCwd,
        }),
      )
    }

    // 3. Setup external + builtin extensions
    const externalSetup = yield* setupDiscoveredExtensions({
      extensions: discovery.loaded,
      cwd: canonicalCwd,
      home: inputs.home,
      disabled: disabledSet,
    })
    const builtinSetup = yield* setupBuiltinExtensions({
      extensions: inputs.extensions,
      cwd: canonicalCwd,
      home: inputs.home,
      disabled: disabledSet,
    })

    // 4. Reconcile (validate, run onStartup, register scheduled jobs)
    const reconciled = yield* reconcileLoadedExtensions({
      extensions: [...builtinSetup.active, ...externalSetup.active],
      failedExtensions: [...builtinSetup.failed, ...externalSetup.failed],
      home: inputs.home,
      command: inputs.scheduledJobCommand,
      env: inputs.scheduledJobEnv,
    })

    // 5. Build base prompt sections (core + extension, extensions shadow by id)
    const instructions = yield* configService.loadInstructions(canonicalCwd)
    const isGitRepo = yield* fs
      .exists(path.join(canonicalCwd, ".git"))
      .pipe(Effect.catchEager(() => Effect.succeed(false)))
    const coreSections = buildBasePromptSections({
      cwd: canonicalCwd,
      platform: inputs.platform,
      ...(inputs.shell !== undefined ? { shell: inputs.shell } : {}),
      ...(inputs.osVersion !== undefined ? { osVersion: inputs.osVersion } : {}),
      isGitRepo,
      customInstructions: instructions,
    })

    // Extension prompt sections come pre-merged in scope-precedence order from
    // `resolveExtensions` (project > user > builtin). All static now —
    // `Capability.prompt`. Dynamic sections live on `Projection.prompt`.
    const extensionSectionInputs = [...reconciled.resolved.promptSections.values()]

    return {
      cwd: canonicalCwd,
      resolved: reconciled.resolved,
      coreSections,
      extensionSectionInputs,
      instructions,
      scheduledJobFailures: reconciled.scheduledJobFailures,
    }
  })

/**
 * Resolve the profile's prompt sections into a merged `PromptSection[]`.
 *
 * Must be called inside an Effect runtime where extension-contributed services
 * (e.g. `Skills`) are in scope, since dynamic sections may yield those services
 * in their `resolve` Effect.
 *
 * Extension sections shadow core sections by id.
 */
export const compileBaseSections = (
  profile: RuntimeProfile,
): Effect.Effect<ReadonlyArray<PromptSection>, never, never> =>
  Effect.sync(() => {
    const sectionMap = new Map(profile.coreSections.map((s) => [s.id, s]))
    for (const s of profile.extensionSectionInputs) sectionMap.set(s.id, s)
    return [...sectionMap.values()]
  })

/**
 * Build the extension-side layers (registry, state runtime, pub/sub
 * subscription engine, extension-contributed services) from a resolved profile.
 *
 * Used by the server composition root, the per-cwd cache, and the ephemeral
 * child-run path. Ephemeral runs forward the parent's already-resolved
 * `ResolvedExtensions` (same cwd) instead of re-discovering, but they then
 * call this same builder so the wiring shape is identical.
 */
export const buildExtensionLayers = (resolved: ResolvedExtensions) => {
  // Process-scope Resource layer — services merged in parallel, lifecycle
  // (start/stop) threaded sequentially with reverse-order teardown. cwd /
  // session / branch Resources are routed through the per-cwd / ephemeral
  // composers (added in later commits).
  const resourceLayer = buildResourceLayer(resolved.extensions, "process")

  // Resource subscriptions — single pub/sub host. SubscriptionEngine is
  // both the agent-event fan-out target (`agent:<EventTag>` envelopes
  // emitted by EventPublisher / agent-runner) and the registration sink
  // for `Resource.subscriptions`.
  const resourceSubscriptions = collectSubscriptions(resolved.extensions)

  const extensionRuntimeLive = MachineEngine.Live(resolved.extensions).pipe(
    Layer.provideMerge(ExtensionTurnControl.Live),
  )
  // Project `MachineEngine` onto the read-only `MachineExecute` surface
  // for projection consumers. `MachineExecute` carries the `ReadOnly`
  // brand so projections can't accidentally yield write-capable Tags.
  const machineExecuteLive = MachineExecute.Live.pipe(Layer.provideMerge(extensionRuntimeLive))

  // Actor engine + host: ActorEngine.Live is self-contained (it
  // composes its own Receptionist). ActorHost.fromResolved is a
  // Layer.effectDiscard that walks every extension's `actors` bucket
  // at build time and spawns each Behavior into the engine; spawn
  // lifetime is bound to the host scope so runtime teardown
  // interrupts every actor fiber.
  const actorRuntimeLive = ActorHost.fromResolved(resolved).pipe(
    Layer.provideMerge(ActorEngine.Live),
  )

  const baseLayers = Layer.mergeAll(
    ExtensionRegistry.fromResolved(resolved),
    DriverRegistry.fromResolved({
      modelDrivers: resolved.modelDrivers,
      externalDrivers: resolved.externalDrivers,
    }),
    extensionRuntimeLive,
    machineExecuteLive,
    actorRuntimeLive,
    SubscriptionEngine.withSubscriptions(resourceSubscriptions),
  )

  return Layer.mergeAll(baseLayers, resourceLayer)
}

export const buildProfileRuntime = (params: {
  readonly profile: RuntimeProfile
  readonly configService: ConfigServiceService
}) =>
  Effect.gen(function* () {
    const combinedLayer = buildExtensionLayers(params.profile.resolved).pipe(
      Layer.provide(ExtensionTurnControl.Live),
    )
    const layerContext = yield* Layer.build(combinedLayer)
    const registryService = Context.get(layerContext, ExtensionRegistry)
    const driverRegistryService = Context.get(layerContext, DriverRegistry)
    const extensionStateRuntime = Context.get(layerContext, MachineEngine)
    const subscriptionEngineOpt = Context.getOption(layerContext, SubscriptionEngine)
    const subscriptionEngine =
      subscriptionEngineOpt._tag === "Some" ? subscriptionEngineOpt.value : undefined
    const actorHostFailures = yield* Context.get(layerContext, ActorHostFailures).snapshot
    const permissionService = makeProfilePermissionService({
      cwd: params.profile.cwd,
      configService: params.configService,
      extensionRules: params.profile.resolved.permissionRules,
    })
    const baseSections = yield* Effect.provideContext(
      compileBaseSections(params.profile),
      layerContext,
    )

    return {
      profile: params.profile,
      layerContext,
      permissionService,
      registryService,
      driverRegistryService,
      extensionStateRuntime,
      subscriptionEngine,
      actorHostFailures,
      baseSections,
    }
  })

export const logActorHostFailures = (failures: ReadonlyArray<ActorSpawnFailure>, cwd: string) =>
  Effect.gen(function* () {
    for (const failure of failures) {
      yield* Effect.logWarning("extension.actor.spawn.failed").pipe(
        Effect.annotateLogs({
          extensionId: failure.extensionId,
          error: failure.error,
          cwd,
        }),
      )
    }
  })

export const resolveProfileRuntime = (inputs: RuntimeProfileInputs) =>
  Effect.gen(function* () {
    const configService = yield* ConfigService
    const profile = yield* resolveRuntimeProfile(inputs)
    yield* logRuntimeProfileFailures(profile)
    const built = yield* buildProfileRuntime({ profile, configService })
    yield* logActorHostFailures(built.actorHostFailures, profile.cwd)
    return built
  })
