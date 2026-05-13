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
  HashMap,
  Layer,
  Path,
  Scope,
  Semaphore,
  TxRef,
  type Scope as ScopeType,
} from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { GentPlatform } from "./gent-platform.js"
import type { LoadedExtension, GentExtension } from "../domain/extension.js"
import { type PermissionService } from "../domain/permission.js"
import type { PromptSection } from "../domain/prompt.js"
import {
  type ExtensionRegistryService,
  type ResolvedExtensions,
  resolveExtensions,
  ExtensionRegistry,
} from "./extensions/registry.js"
import { DriverRegistry, type DriverRegistryService } from "./extensions/driver-registry.js"
import { ConfigService } from "./config-service.js"
import type { ScheduledJobCommand } from "./extensions/resource-host/schedule-engine.js"
import { resolveProfileRuntime, type RuntimeProfile } from "./profile.js"

const allowAllPermission: PermissionService = {
  check: () => Effect.succeed("allowed"),
}

// ── SessionProfile ──

export interface SessionProfile {
  readonly cwd: string
  readonly extensions: ReadonlyArray<LoadedExtension>
  readonly resolved: ResolvedExtensions
  readonly layerContext: Context.Context<never>
  readonly permissionService: PermissionService
  readonly registryService: ExtensionRegistryService
  readonly driverRegistryService: DriverRegistryService
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
  readonly extensions: ReadonlyArray<GentExtension<ChildProcessSpawner | GentPlatform>>
  readonly initialProfiles?: ReadonlyArray<SessionProfile>
}

export interface SessionProfileCacheService {
  /** Get or lazily create a profile for the given cwd. */
  readonly resolve: (cwd: string) => Effect.Effect<SessionProfile>
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
    | FileSystem.FileSystem
    | Path.Path
    | ChildProcessSpawner
    | ConfigService
    | ScopeType.Scope
    | GentPlatform
  > =>
    Layer.effect(
      SessionProfileCache,
      Effect.gen(function* () {
        const configService = yield* ConfigService
        const fs = yield* FileSystem.FileSystem
        const pathSvc = yield* Path.Path
        const spawner = yield* ChildProcessSpawner
        const platform = yield* GentPlatform
        const initialCache = HashMap.fromIterable(
          (config.initialProfiles ?? []).map(
            (profile) => [pathSvc.resolve(profile.cwd), profile] as const,
          ),
        )
        const cacheRef = yield* TxRef.make(initialCache)
        const initSemaphore = yield* Semaphore.make(1)
        // Capture server scope — extension lifecycle (onShutdown) ties to this
        const serverScope = yield* Scope.Scope

        const platformContext = Context.empty().pipe(
          Context.add(FileSystem.FileSystem, fs),
          Context.add(Path.Path, pathSvc),
          Context.add(ChildProcessSpawner, spawner),
          Context.add(ConfigService, configService),
          Context.add(GentPlatform, platform),
        )

        const initProfile = (cwd: string) =>
          Effect.gen(function* () {
            const runtime = yield* resolveProfileRuntime({
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
            }).pipe(
              Effect.provideService(Scope.Scope, serverScope),
              Effect.provideContext(platformContext),
            )

            const profile = sessionProfileFromRuntime(runtime)

            yield* Effect.logInfo("session-profile.initialized").pipe(
              Effect.annotateLogs({
                cwd: profile.cwd,
                extensionCount: profile.resolved.extensions.length,
                sectionCount: runtime.baseSections.length,
              }),
            )

            return profile
          }).pipe(Effect.provideService(Scope.Scope, serverScope), Effect.orDie)

        const resolve: SessionProfileCacheService["resolve"] = (cwd) =>
          Effect.gen(function* () {
            // Canonicalize before cache lookup
            const canonicalCwd = pathSvc.resolve(cwd)

            // Fast path — no lock needed for cache hits
            const cache = yield* TxRef.get(cacheRef)
            const existing = HashMap.get(cache, canonicalCwd)
            if (existing._tag === "Some") return existing.value

            // Serialize initialization to prevent duplicate profiles for same cwd
            return yield* initSemaphore.withPermits(1)(
              Effect.gen(function* () {
                // Re-check inside critical section
                const current = yield* TxRef.get(cacheRef)
                const found = HashMap.get(current, canonicalCwd)
                if (found._tag === "Some") return found.value

                const profile = yield* initProfile(canonicalCwd)

                yield* TxRef.update(cacheRef, (m) => HashMap.set(m, canonicalCwd, profile))

                return profile
              }),
            )
          })

        return { resolve }
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
          const layerContext = Effect.runSync(
            Layer.build(
              Layer.mergeAll(
                ExtensionRegistry.fromResolved(resolved),
                DriverRegistry.fromResolved({
                  modelDrivers: resolved.modelDrivers,
                  externalDrivers: resolved.externalDrivers,
                }),
              ),
            ).pipe(Effect.scoped),
          )
          const profile: SessionProfile = {
            cwd,
            extensions: [],
            resolved,
            layerContext,
            permissionService: allowAllPermission,
            registryService: Context.get(layerContext, ExtensionRegistry),
            driverRegistryService: Context.get(layerContext, DriverRegistry),
            baseSections: [],
            instructions: "",
          }
          cache.set(cwd, profile)
          return profile
        }),
    })
  }
}

export const sessionProfileFromRuntime = (runtime: {
  readonly profile: RuntimeProfile
  readonly layerContext: Context.Context<never>
  readonly permissionService: PermissionService
  readonly registryService: ExtensionRegistryService
  readonly driverRegistryService: DriverRegistryService
  readonly baseSections: ReadonlyArray<PromptSection>
}): SessionProfile => ({
  cwd: runtime.profile.cwd,
  extensions: runtime.profile.resolved.extensions,
  resolved: runtime.profile.resolved,
  layerContext: runtime.layerContext,
  permissionService: runtime.permissionService,
  registryService: runtime.registryService,
  driverRegistryService: runtime.driverRegistryService,
  baseSections: runtime.baseSections,
  instructions: runtime.profile.instructions,
})
