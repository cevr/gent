/** Profile declarations, catalog assembly, and isolated child resource wiring. */

import { Context, DateTime, Effect, FileSystem, Layer, Path } from "effect"
import type { GentExtension, ExtensionSetupServices } from "../domain/extension.js"
import { environmentSection, type PromptSection } from "../domain/capability.js"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { GentPlatform } from "./gent-platform.js"
import {
  ExtensionRegistry,
  type ExtensionRegistryService,
  type ResolvedExtensions,
} from "./extensions/registry.js"
import { DriverRegistry, type DriverRegistryService } from "./extensions/driver-registry.js"
import {
  setupExtensions,
  validateLoadedExtensions,
  type ExtensionActivationResult,
} from "./extensions/activation.js"
import { discoverExtensions, type DiscoveredExtension } from "./extensions/loader.js"
import { GENT_CONFIG_DIRECTORY } from "./extensions/disabled.js"
import type { ProcessGenerationId } from "../domain/ids.js"

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
  /**
   * Every extension this profile must not activate. The caller has already
   * merged the user and project config into it, so this loader reads no
   * config file of its own.
   */
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
  readonly extensionDeclarations: ExtensionActivationResult
  readonly coreSections: ReadonlyArray<PromptSection>
}

export const loadRuntimeProfileDeclarations = (
  inputs: RuntimeProfileInputs,
): Effect.Effect<
  RuntimeProfileDeclarations,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner | GentPlatform
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const canonicalCwd = path.resolve(inputs.cwd)

    // 1. Disabled set, already merged by the caller
    const disabledSet = new Set(inputs.disabledExtensions ?? [])

    // 2. Discover external extensions (user + project dirs)
    const userExtensionsDir = path.join(inputs.home, GENT_CONFIG_DIRECTORY, "extensions")
    const projectExtensionsDir = path.join(canonicalCwd, GENT_CONFIG_DIRECTORY, "extensions")
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

    return {
      extensionDeclarations: declarations,
      coreSections,
    }
  })

/**
 * Build a session profile from a context whose resources are already built.
 * This function only assembles services. It never invokes a resource layer.
 */
export const buildSessionProfile = (params: {
  readonly cwd: string
  readonly resolved: ResolvedExtensions
  readonly coreSections: ReadonlyArray<PromptSection>
  readonly resourceContext: Context.Context<unknown>
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
    // Extension sections shadow core sections by id.
    const sectionMap = new Map(params.coreSections.map((s) => [s.id, s]))
    for (const s of params.resolved.promptSections.values()) sectionMap.set(s.id, s)
    return {
      cwd: params.cwd,
      resolved: params.resolved,
      layerContext,
      registryService: Context.get(layerContext, ExtensionRegistry),
      driverRegistryService: Context.get(layerContext, DriverRegistry),
      baseSections: [...sectionMap.values()],
      generationId: params.generationId,
    } satisfies SessionProfile
  })
