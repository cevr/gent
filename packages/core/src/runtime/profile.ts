/** Profile declarations, catalog assembly, and isolated child resource wiring. */

import { Context, DateTime, Effect, FileSystem, Layer, Path, Predicate } from "effect"
import type { GentExtension, ExtensionSetupServices } from "../domain/extension.js"
import type { ResourceGraphPublication } from "./extensions/resource-host/resource-graph-host.js"
import { type PromptSection } from "../domain/prompt.js"
import {
  type PermissionRule,
  type PermissionService,
  compilePermissionRules,
  evaluatePermissionRules,
} from "../domain/permission.js"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { GentPlatform } from "./gent-platform.js"
import {
  ExtensionRegistry,
  resolveExtensions,
  type ExtensionRegistryService,
  type ResolvedExtensions,
} from "./extensions/registry.js"
import { DriverRegistry, type DriverRegistryService } from "./extensions/driver-registry.js"
import { buildResourceLayer, buildResourceServiceLayer } from "./extensions/resource-host/index.js"
import {
  setupBuiltinExtensions,
  setupDiscoveredExtensions,
  validateLoadedExtensions,
  type ExtensionActivationResult,
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
  readonly extensions: ReadonlyArray<GentExtension<ExtensionSetupServices>>
  /** Fresh config supplied by an explicit refresh. */
  readonly config?: UserConfig
  readonly disabledExtensions?: ReadonlyArray<string>
  readonly scheduledJobCommand?: ScheduledJobCommand
  readonly scheduledJobEnv?: Readonly<Record<string, string>>
}

/**
 * Output of the resolver — everything a downstream composer needs to wire layers.
 *
 * `coreSections` are the static, environment-derived sections (cwd, platform,
 * git state, custom instructions). `extensionSectionInputs` are static
 * extension-contributed sections in scope-precedence order (project > user >
 * builtin).
 *
 * Use `compileBaseSections(profile)` to get the merged static section array.
 * (Dynamic sections are assembled per-turn by extension hooks, not here.)
 */
export interface RuntimeProfile {
  readonly cwd: string
  readonly resolved: ResolvedExtensions
  readonly coreSections: ReadonlyArray<PromptSection>
  readonly extensionSectionInputs: ReadonlyArray<PromptSection>
  readonly instructions: string
  readonly scheduledJobFailures: ReadonlyArray<SchedulerFailure>
}

/**
 * Heterogeneous services contributed by authored process resources. The host
 * membrane owns this erased context; callers use the publication boundary to
 * enter it instead of naming a closed-world service union here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Resource services are heterogeneous at this explicit host membrane.
export type RuntimeProfileServiceContext = Context.Context<any>

/** Services and immutable profile data staged from one graph publication. */
export interface RuntimeProfileCatalog {
  readonly profile: RuntimeProfile
  readonly layerContext: RuntimeProfileServiceContext
  readonly permissionService: PermissionService
  readonly registryService: ExtensionRegistryService
  readonly driverRegistryService: DriverRegistryService
  readonly baseSections: ReadonlyArray<PromptSection>
}

export type RuntimeProfilePublication = ResourceGraphPublication<RuntimeProfileCatalog>

/**
 * Extension declarations and prompt inputs loaded before process resources are
 * acquired.
 *
 * Extension setup is trusted code and can perform its own ordinary effects.
 * This boundary only guarantees that it does not build Resource layers,
 * invoke Resource start/stop hooks, or reconcile scheduled jobs.
 */
export interface RuntimeProfileDeclarations {
  readonly cwd: string
  readonly config: UserConfig
  readonly extensionDeclarations: ExtensionActivationResult
  readonly resolved: ResolvedExtensions
  readonly coreSections: ReadonlyArray<PromptSection>
  readonly extensionSectionInputs: ReadonlyArray<PromptSection>
  readonly instructions: string
}

const permissionRulesFromConfig = (config: UserConfig) => config.permissions ?? []

export const makeProfilePermissionService = (params: {
  readonly cwd: string
  readonly configService: ConfigServiceService
  readonly extensionRules: ReadonlyArray<PermissionRule>
  readonly configOverride?: UserConfig
}): PermissionService => {
  const compiledExtensionRules = compilePermissionRules(params.extensionRules)

  return {
    check: Effect.fn("RuntimeProfile.permission.check")(function* (tool, args) {
      let config: UserConfig
      if (Predicate.isUndefined(params.configOverride)) {
        config = yield* params.configService.get(params.cwd)
      } else {
        config = params.configOverride
      }
      const compiledConfigRules = compilePermissionRules(permissionRulesFromConfig(config))
      return evaluatePermissionRules(
        [...compiledExtensionRules, ...compiledConfigRules],
        tool,
        args,
        "allow",
      )
    }),
  }
}

/**
 * Load extension declarations and static prompt inputs for a runtime profile.
 *
 * This function performs discovery, trusted extension setup, validation, and
 * prompt input loading. It does not build Resource layers, invoke Resource
 * lifecycle hooks, or reconcile scheduled jobs. The returned declarations are
 * consumed by the live Profile owner before resource acquisition.
 */
export const loadRuntimeProfileDeclarations = (
  inputs: RuntimeProfileInputs,
): Effect.Effect<
  RuntimeProfileDeclarations,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner | ConfigService | GentPlatform
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const configService = yield* ConfigService

    const canonicalCwd = path.resolve(inputs.cwd)
    const config = inputs.config ?? (yield* configService.get(canonicalCwd))

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
          Effect.as({ loaded: [], skipped: [] }),
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

    // 4. Validate declarations without acquiring process resources.
    const extensionDeclarations = yield* validateLoadedExtensions([
      ...builtinSetup.active,
      ...externalSetup.active,
    ])
    const declarations: ExtensionActivationResult = {
      active: extensionDeclarations.active,
      failed: [...builtinSetup.failed, ...externalSetup.failed, ...extensionDeclarations.failed],
    }
    const resolved = resolveExtensions(declarations.active, declarations.failed)

    // 5. Build base prompt sections (core + extension, extensions shadow by id)
    const instructions = yield* configService.loadInstructions(canonicalCwd)
    const isGitRepo = yield* fs
      .exists(path.join(canonicalCwd, ".git"))
      .pipe(Effect.catchEager(() => Effect.succeed(false)))
    const date = DateTime.formatIsoDateUtc(yield* DateTime.now)
    const coreSections = buildBasePromptSections({
      cwd: canonicalCwd,
      platform: inputs.platform,
      date,
      shell: inputs.shell,
      osVersion: inputs.osVersion,
      isGitRepo,
      customInstructions: instructions,
    })

    // Extension prompt sections come pre-merged in scope-precedence order from
    // `resolveExtensions` (project > user > builtin). Dynamic sections are
    // assembled per-turn by extension hooks.
    const extensionSectionInputs = [...resolved.promptSections.values()]

    return {
      cwd: canonicalCwd,
      config,
      extensionDeclarations: declarations,
      resolved,
      coreSections,
      extensionSectionInputs,
      instructions,
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
 * Build the extension-side layers (registry, state runtime, extension-contributed
 * services) from a resolved profile.
 *
 * Ephemeral children forward the parent's declarations and rebuild private
 * services with lifecycle disabled. Live profiles use the graph host and
 * buildProfileCatalog instead. Direct test fixtures can own a scoped layer.
 */
export const buildExtensionLayers = (
  resolved: ResolvedExtensions,
  options?: {
    readonly lifecycle?: "run" | "skip"
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous extension Resource services are intentionally erased at this host membrane
): Layer.Layer<any, never, never> => {
  // Child runs rebuild private resource values without process lifecycle hooks.
  const resourceLayer = (() => {
    if (options?.lifecycle === "skip") {
      return buildResourceServiceLayer(resolved.extensions, "process")
    }
    return buildResourceLayer(resolved.extensions, "process")
  })()

  const baseLayers = Layer.mergeAll(
    ExtensionRegistry.fromResolved(resolved),
    DriverRegistry.fromResolved({
      modelDrivers: resolved.modelDrivers,
      externalDrivers: resolved.externalDrivers,
    }),
  )

  // Resource layers may declare `R` deps on services from `baseLayers`
  // (e.g. `ExtensionRegistry` / `DriverRegistry`). `Layer.mergeAll`
  // does NOT cross-wire siblings, so
  // we feed `baseLayers` into the resource layer via `provideMerge` —
  // resource deps are satisfied AND base outputs stay in the result.
  return Layer.provideMerge(resourceLayer, baseLayers)
}

/**
 * Build a profile catalog from a context already acquired by ResourceGraphHost.
 * This function only assembles services. It never invokes a resource layer.
 */
export const buildProfileCatalog = (params: {
  readonly profile: RuntimeProfile
  readonly configService: ConfigServiceService
  readonly resourceContext: Context.Context<unknown>
  readonly configOverride?: UserConfig
}) =>
  Effect.gen(function* () {
    // The live graph host has already built every resource. Supplying its
    // immutable context here is the only resource-side operation in staging.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- The host membrane erases heterogeneous resource services at this boundary.
    const resourceLayer: Layer.Layer<any, never, never> = Layer.succeedContext(
      params.resourceContext,
    )
    const baseLayers = Layer.mergeAll(
      ExtensionRegistry.fromResolved(params.profile.resolved),
      DriverRegistry.fromResolved({
        modelDrivers: params.profile.resolved.modelDrivers,
        externalDrivers: params.profile.resolved.externalDrivers,
      }),
    )
    const layerContext = yield* Layer.build(Layer.provideMerge(resourceLayer, baseLayers))
    const registryService = Context.get(layerContext, ExtensionRegistry)
    const driverRegistryService = Context.get(layerContext, DriverRegistry)
    const permissionService = makeProfilePermissionService({
      cwd: params.profile.cwd,
      configService: params.configService,
      extensionRules: params.profile.resolved.permissionRules,
      configOverride: params.configOverride,
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
      baseSections,
    } satisfies RuntimeProfileCatalog
  })
