/** Profile declarations, catalog assembly, and isolated child resource wiring. */

import { Context, DateTime, Effect, FileSystem, Layer, Path, Predicate } from "effect"
import type { GentExtension, ExtensionSetupServices } from "../domain/extension.js"
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
import {
  buildResourceLayer,
  buildResourceServiceLayer,
} from "./extensions/resource-host/resource-layer.js"
import {
  setupExtensions,
  validateLoadedExtensions,
  type ExtensionActivationResult,
} from "./extensions/activation.js"
import { discoverExtensions, type DiscoveredExtension } from "./extensions/loader.js"
import { readDisabledExtensions } from "./extensions/disabled.js"
import { environmentSection } from "../domain/prompt.js"
import { ConfigService, type ConfigServiceService, type UserConfig } from "./config-service.js"
import type { ProcessRunner } from "./run-process.js"
import type { ProcessGenerationId } from "../domain/process-generation.js"

/**
 * Inputs that fully describe a runtime profile.
 *
 * `cwd` is the only per-call axis; everything else is composition-root configuration
 * (home dir, platform metadata, builtin extensions).
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
}

/**
 * Heterogeneous services contributed by authored process resources. The host
 * membrane owns this erased context instead of naming a closed-world service
 * union here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Resource services are heterogeneous at this explicit host membrane.
type RuntimeProfileServiceContext = Context.Context<any>

/** Services and immutable prompt inputs built for one session. */
export interface SessionProfile {
  readonly cwd: string
  readonly resolved: ResolvedExtensions
  readonly layerContext: RuntimeProfileServiceContext
  readonly permissionService: PermissionService
  readonly registryService: ExtensionRegistryService
  readonly driverRegistryService: DriverRegistryService
  readonly baseSections: ReadonlyArray<PromptSection>
  /**
   * Identity of the process that built this profile. A process-local tool
   * binding is replayable only inside it.
   */
  readonly generationId: ProcessGenerationId
}

/**
 * Extension declarations and prompt inputs loaded before process resources are
 * acquired.
 *
 * Extension setup is trusted code and can perform its own ordinary effects.
 * This boundary only guarantees that it does not build Resource layers,
 * invoke Resource start/stop hooks.
 */
interface RuntimeProfileDeclarations {
  readonly cwd: string
  readonly config: UserConfig
  readonly extensionDeclarations: ExtensionActivationResult
  readonly resolved: ResolvedExtensions
  readonly coreSections: ReadonlyArray<PromptSection>
  readonly extensionSectionInputs: ReadonlyArray<PromptSection>
}

const permissionRulesFromConfig = (config: UserConfig) => config.permissions ?? []

const makeProfilePermissionService = (params: {
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
      )
    }),
  }
}

/**
 * Load extension declarations and static prompt inputs for a runtime profile.
 *
 * This function performs discovery, trusted extension setup, validation, and
 * prompt input loading. It does not build Resource layers or invoke Resource
 * lifecycle hooks. The returned declarations are consumed by the profile cache
 * before resource acquisition.
 */
export const loadRuntimeProfileDeclarations = (
  inputs: RuntimeProfileInputs,
): Effect.Effect<
  RuntimeProfileDeclarations,
  never,
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner
  | ConfigService
  | GentPlatform
  | ProcessRunner
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

    // 3. Setup builtin + external extensions
    const setup = yield* setupExtensions({
      extensions: [
        ...inputs.extensions.map((extension): DiscoveredExtension => ({
          extension,
          scope: "builtin",
          sourcePath: "builtin",
        })),
        ...discovery.loaded,
      ],
      cwd: canonicalCwd,
      home: inputs.home,
      disabled: disabledSet,
    })

    // 4. Validate declarations without acquiring process resources.
    const extensionDeclarations = yield* validateLoadedExtensions(setup.active)
    const declarations: ExtensionActivationResult = {
      active: extensionDeclarations.active,
      failed: [...setup.failed, ...extensionDeclarations.failed],
    }
    const resolved = resolveExtensions(declarations.active, declarations.failed)

    // 5. Build base prompt sections (core writes the environment; extensions shadow by id)
    const isGitRepo = yield* fs
      .exists(path.join(canonicalCwd, ".git"))
      .pipe(Effect.catchEager(() => Effect.succeed(false)))
    const date = DateTime.formatIsoDateUtc(yield* DateTime.now)
    const coreSections = [
      environmentSection({
        cwd: canonicalCwd,
        platform: inputs.platform,
        date,
        shell: inputs.shell,
        osVersion: inputs.osVersion,
        isGitRepo,
      }),
    ]

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
    }
  })

/**
 * Build the extension-side layers (registry, state runtime, extension-contributed
 * services) from a resolved profile.
 *
 * Ephemeral children forward the parent's declarations and rebuild private
 * services with lifecycle disabled. Live profiles build resources per
 * extension and call buildProfileCatalog instead. Direct test fixtures can own
 * a scoped layer.
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
 * Build a session profile from a context whose resources are already built.
 * This function only assembles services. It never invokes a resource layer.
 */
export const buildSessionProfile = (params: {
  readonly cwd: string
  readonly resolved: ResolvedExtensions
  readonly coreSections: ReadonlyArray<PromptSection>
  readonly configService: ConfigServiceService
  readonly resourceContext: Context.Context<unknown>
  readonly configOverride?: UserConfig
  readonly generationId: ProcessGenerationId
}) =>
  Effect.gen(function* () {
    // Every resource is already built. Supplying that immutable context here is
    // the only resource-side operation in staging.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- The host membrane erases heterogeneous resource services at this boundary.
    const resourceLayer: Layer.Layer<any, never, never> = Layer.succeedContext(
      params.resourceContext,
    )
    const baseLayers = Layer.mergeAll(
      ExtensionRegistry.fromResolved(params.resolved),
      DriverRegistry.fromResolved({
        modelDrivers: params.resolved.modelDrivers,
        externalDrivers: params.resolved.externalDrivers,
      }),
    )
    const layerContext = yield* Layer.build(Layer.provideMerge(resourceLayer, baseLayers))
    const permissionService = makeProfilePermissionService({
      cwd: params.cwd,
      configService: params.configService,
      extensionRules: params.resolved.permissionRules,
      configOverride: params.configOverride,
    })
    // Extension sections shadow core sections by id.
    const sectionMap = new Map(params.coreSections.map((s) => [s.id, s]))
    for (const s of params.resolved.promptSections.values()) sectionMap.set(s.id, s)
    return {
      cwd: params.cwd,
      resolved: params.resolved,
      layerContext,
      permissionService,
      registryService: Context.get(layerContext, ExtensionRegistry),
      driverRegistryService: Context.get(layerContext, DriverRegistry),
      baseSections: [...sectionMap.values()],
      generationId: params.generationId,
    } satisfies SessionProfile
  })
