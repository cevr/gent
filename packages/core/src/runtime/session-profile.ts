/**
 * SessionProfile — per-cwd profile for shared server mode.
 *
 * Each unique session cwd gets its own extension discovery, config, prompt sections,
 * and registry. Profiles are lazily initialized on first access and cached.
 * Profile scope is tied to the server's scope — extension lifecycle (onStartup/onShutdown)
 * survives as long as the server does.
 */

import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Ref,
  Scope,
  Semaphore,
  type Scope as ScopeType,
} from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { ExtensionInput } from "../domain/extension-package.js"
import type { LoadedExtension } from "../domain/extension.js"
import type { PromptSection } from "../domain/prompt.js"
import {
  type ExtensionRegistryService,
  type ResolvedExtensions,
  resolveExtensions,
  ExtensionRegistry,
} from "./extensions/registry.js"
import { DriverRegistry, type DriverRegistryService } from "./extensions/driver-registry.js"
import {
  MachineEngine,
  type MachineEngineService,
} from "./extensions/resource-host/machine-engine.js"
import { ExtensionTurnControl } from "./extensions/turn-control.js"
import { ConfigService } from "./config-service.js"
import type { ScheduledJobCommand } from "./extensions/resource-host/schedule-engine.js"
import { buildExtensionLayers, compileBaseSections, resolveRuntimeProfile } from "./profile.js"

// ── SessionProfile ──

export interface SessionProfile {
  readonly cwd: string
  readonly extensions: ReadonlyArray<LoadedExtension>
  readonly resolved: ResolvedExtensions
  readonly registryService: ExtensionRegistryService
  readonly driverRegistryService: DriverRegistryService
  readonly extensionStateRuntime: MachineEngineService
  readonly baseSections: ReadonlyArray<PromptSection>
  readonly instructions: string
}

// ── SessionProfileCache ──

export interface SessionProfileCacheConfig {
  readonly home: string
  readonly platform: string
  readonly shell?: string
  readonly osVersion?: string
  readonly disabledExtensions?: ReadonlyArray<string>
  readonly scheduledJobCommand?: ScheduledJobCommand
  readonly scheduledJobEnv?: Readonly<Record<string, string>>
  readonly extensions: ReadonlyArray<ExtensionInput>
}

export interface SessionProfileCacheService {
  /** Get or lazily create a profile for the given cwd. */
  readonly resolve: (cwd: string) => Effect.Effect<SessionProfile>
  /** Get the profile for a cwd if already initialized, without triggering init. */
  readonly peek: (cwd: string) => Effect.Effect<SessionProfile | undefined>
}

export class SessionProfileCache extends Context.Service<
  SessionProfileCache,
  SessionProfileCacheService
>()("@gent/core/src/runtime/session-profile/SessionProfileCache") {
  static Live = (
    config: SessionProfileCacheConfig,
  ): Layer.Layer<
    SessionProfileCache,
    never,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner | ConfigService | ScopeType.Scope
  > =>
    Layer.effect(
      SessionProfileCache,
      Effect.gen(function* () {
        const cacheRef = yield* Ref.make<Map<string, SessionProfile>>(new Map())
        const initSemaphore = yield* Semaphore.make(1)
        const configService = yield* ConfigService
        const fs = yield* FileSystem.FileSystem
        const pathSvc = yield* Path.Path
        const spawner = yield* ChildProcessSpawner
        // Capture server scope — extension lifecycle (onShutdown) ties to this
        const serverScope = yield* Scope.Scope

        // Capture platform services as a layer so initProfile can use functions
        // that require FileSystem | Path | ChildProcessSpawner | ConfigService from
        // the Effect context (resolveRuntimeProfile loads instructions via ConfigService).
        const platformLayer = Layer.mergeAll(
          Layer.succeed(FileSystem.FileSystem, fs),
          Layer.succeed(Path.Path, pathSvc),
          Layer.succeed(ChildProcessSpawner, spawner),
          Layer.succeed(ConfigService, configService),
        )

        const initProfile = (cwd: string) =>
          Effect.gen(function* () {
            // 1. Resolve runtime profile (discover, setup, reconcile, build sections)
            //    Provided server scope so extension onShutdown + scheduled jobs survive.
            const profileData = yield* resolveRuntimeProfile({
              cwd,
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
              ...(config.scheduledJobEnv !== undefined
                ? { scheduledJobEnv: config.scheduledJobEnv }
                : {}),
            }).pipe(Effect.provideService(Scope.Scope, serverScope))

            const { cwd: canonicalCwd, resolved, instructions } = profileData

            for (const failed of resolved.failedExtensions) {
              yield* Effect.logWarning("session-profile.extension.failed").pipe(
                Effect.annotateLogs({
                  extensionId: failed.manifest.id,
                  phase: failed.phase,
                  error: failed.error,
                  cwd: canonicalCwd,
                }),
              )
            }

            // 2. Build extension layers via the shared helper — same shape as
            //    server startup. Includes registry, state runtime, subscription
            //    engine (with extension subscriptions), and extension `setup.layer`s.
            //    `buildExtensionLayers` requires `ExtensionTurnControl`; provide
            //    it locally then build inside the captured server scope.
            const combinedLayer = buildExtensionLayers(resolved).pipe(
              Layer.provide(ExtensionTurnControl.Live),
            )

            const combinedCtx = yield* Layer.build(combinedLayer).pipe(
              Effect.provideService(Scope.Scope, serverScope),
            )
            const registryService = Context.get(combinedCtx, ExtensionRegistry)
            const driverRegistryService = Context.get(combinedCtx, DriverRegistry)
            const stateRuntime = Context.get(combinedCtx, MachineEngine)

            // Compile base sections inside the built layer's runtime so any
            // dynamic prompt section (e.g. `Skills`) can read its required
            // services from extension `setup.layer`s now in scope.
            // strictEffectProvide:off is intentional — `combinedCtx` is the
            // resolved ServiceMap from `Layer.build` above, not a freshly
            // constructed sub-layer. This is the documented pattern for
            // running an Effect inside an already-built scope.
            const baseSections = yield* compileBaseSections(profileData).pipe(
              // @effect-diagnostics-next-line strictEffectProvide:off
              Effect.provide(Layer.succeedContext(combinedCtx)),
            )

            const profile: SessionProfile = {
              cwd: canonicalCwd,
              extensions: resolved.extensions,
              resolved,
              registryService,
              driverRegistryService,
              extensionStateRuntime: stateRuntime,
              baseSections,
              instructions,
            }

            yield* Effect.logInfo("session-profile.initialized").pipe(
              Effect.annotateLogs({
                cwd: canonicalCwd,
                extensionCount: resolved.extensions.length,
                sectionCount: baseSections.length,
              }),
            )

            return profile
          }).pipe(
            // @effect-diagnostics-next-line strictEffectProvide:off
            Effect.provide(platformLayer),
            Effect.orDie,
          )

        const resolve: SessionProfileCacheService["resolve"] = (cwd) =>
          Effect.gen(function* () {
            // Canonicalize before cache lookup
            const canonicalCwd = pathSvc.resolve(cwd)

            // Fast path — no lock needed for cache hits
            const cache = yield* Ref.get(cacheRef)
            const existing = cache.get(canonicalCwd)
            if (existing !== undefined) return existing

            // Serialize initialization to prevent duplicate profiles for same cwd
            return yield* initSemaphore.withPermits(1)(
              Effect.gen(function* () {
                // Re-check inside critical section
                const current = yield* Ref.get(cacheRef)
                const found = current.get(canonicalCwd)
                if (found !== undefined) return found

                const profile = yield* initProfile(canonicalCwd)

                yield* Ref.update(cacheRef, (m) => {
                  const next = new Map(m)
                  next.set(canonicalCwd, profile)
                  return next
                })

                return profile
              }),
            )
          })

        const peek: SessionProfileCacheService["peek"] = (cwd) =>
          Ref.get(cacheRef).pipe(Effect.map((cache) => cache.get(pathSvc.resolve(cwd))))

        return { resolve, peek }
      }),
    )

  static Test = (profiles?: Map<string, SessionProfile>): Layer.Layer<SessionProfileCache> => {
    const cache = profiles ?? new Map<string, SessionProfile>()
    return Layer.succeed(SessionProfileCache, {
      resolve: (cwd) =>
        Effect.sync(() => {
          const existing = cache.get(cwd)
          if (existing !== undefined) return existing
          // Return a minimal profile for tests
          const resolved = resolveExtensions([])
          const profile: SessionProfile = {
            cwd,
            extensions: [],
            resolved,
            registryService: Context.get(
              Effect.runSync(
                Layer.build(ExtensionRegistry.fromResolved(resolved)).pipe(Effect.scoped),
              ),
              ExtensionRegistry,
            ),
            driverRegistryService: Context.get(
              Effect.runSync(
                Layer.build(
                  DriverRegistry.fromResolved({
                    modelDrivers: resolved.modelDrivers,
                    externalDrivers: resolved.externalDrivers,
                  }),
                ).pipe(Effect.scoped),
              ),
              DriverRegistry,
            ),
            extensionStateRuntime: Context.get(
              Effect.runSync(
                Layer.build(
                  MachineEngine.fromExtensions([]).pipe(Layer.provide(ExtensionTurnControl.Live)),
                ).pipe(Effect.scoped),
              ),
              MachineEngine,
            ),
            baseSections: [],
            instructions: "",
          }
          cache.set(cwd, profile)
          return profile
        }),
      peek: (cwd) => Effect.succeed(cache.get(cwd)),
    })
  }
}
