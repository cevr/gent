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
import type { GentExtension, LoadedExtension } from "../domain/extension.js"
import { type PermissionService } from "../domain/permission.js"
import type { PromptSection } from "../domain/prompt.js"
import {
  type ExtensionRegistryService,
  type ResolvedExtensions,
  resolveExtensions,
  ExtensionRegistry,
} from "./extensions/registry.js"
import { DriverRegistry, type DriverRegistryService } from "./extensions/driver-registry.js"
import { ActorEngine, type ActorEngineService } from "./extensions/actor-engine.js"
import { Receptionist, type ReceptionistService } from "./extensions/receptionist.js"
import {
  MachineEngine,
  type MachineEngineService,
} from "./extensions/resource-host/machine-engine.js"
import { type SubscriptionEngineService } from "./extensions/resource-host/subscription-engine.js"
import { ExtensionTurnControl } from "./extensions/turn-control.js"
import { ConfigService } from "./config-service.js"
import type { ScheduledJobCommand } from "./extensions/resource-host/schedule-engine.js"
import { resolveProfileRuntime } from "./profile.js"
import { runWithBuiltLayer } from "./run-with-built-layer.js"
import { ActorPersistenceStorage } from "../storage/actor-persistence-storage.js"

const allowAllPermission: PermissionService = {
  check: () => Effect.succeed("allowed"),
  addRule: () => Effect.void,
  removeRule: () => Effect.void,
  getRules: () => Effect.succeed([]),
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
  readonly extensionStateRuntime: MachineEngineService
  readonly actorEngine: ActorEngineService
  readonly receptionist: ReceptionistService
  /** Per-cwd subscription bus. Used by EventPublisher router for per-cwd dispatch. */
  readonly subscriptionEngine: SubscriptionEngineService | undefined
  readonly baseSections: ReadonlyArray<PromptSection>
  readonly instructions: string
  /**
   * Pulse index: event `_tag` → extension IDs that declared `pulseTags`.
   * Pinned to the profile so it shares lifecycle with `registryService` —
   * a separate cache could go stale if the profile is ever re-resolved.
   */
  readonly pulseByTag: ReadonlyMap<string, ReadonlySet<string>>
}

/**
 * Build the pulseByTag index from an extension registry's resolved set.
 * Maps event `_tag` → set of extension IDs that declared `pulseTags`.
 */
export const buildPulseIndex = (
  registryService: ExtensionRegistryService,
): Map<string, Set<string>> => {
  const pulseByTag = new Map<string, Set<string>>()
  const resolved = registryService.getResolved()
  for (const ext of resolved.extensions) {
    const tags = ext.contributions.pulseTags ?? []
    for (const tag of tags) {
      const set = pulseByTag.get(tag) ?? new Set<string>()
      set.add(ext.manifest.id)
      pulseByTag.set(tag, set)
    }
  }
  return pulseByTag
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
  readonly extensions: ReadonlyArray<GentExtension>
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
    | ActorPersistenceStorage
    | ScopeType.Scope
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
        const actorPersistenceStorage = yield* ActorPersistenceStorage
        // Capture server scope — extension lifecycle (onShutdown) ties to this
        const serverScope = yield* Scope.Scope

        // Capture platform services as a layer so initProfile can use functions
        // that require FileSystem | Path | ChildProcessSpawner | ConfigService from
        // the Effect context (profile resolution loads instructions via ConfigService).
        // ActorPersistenceStorage is captured here so the per-cwd profile build
        // (which now wires the durable actor surface) can resolve it without
        // pulling Storage into every callsite of `resolveProfileRuntime`.
        const platformLayer = Layer.mergeAll(
          Layer.succeed(FileSystem.FileSystem, fs),
          Layer.succeed(Path.Path, pathSvc),
          Layer.succeed(ChildProcessSpawner, spawner),
          Layer.succeed(ConfigService, configService),
          Layer.succeed(ActorPersistenceStorage, actorPersistenceStorage),
        )

        const initProfile = (cwd: string) =>
          Effect.gen(function* () {
            // Resolve and build the profile runtime in one place. Server startup
            // uses the same helper; this cache only chooses the cwd and scope.
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
            }).pipe(Effect.provideService(Scope.Scope, serverScope))

            const { profile: profileData } = runtime

            const profile: SessionProfile = {
              cwd: profileData.cwd,
              extensions: profileData.resolved.extensions,
              resolved: profileData.resolved,
              layerContext: runtime.layerContext,
              permissionService: runtime.permissionService,
              registryService: runtime.registryService,
              driverRegistryService: runtime.driverRegistryService,
              extensionStateRuntime: runtime.extensionStateRuntime,
              actorEngine: runtime.actorEngine,
              receptionist: runtime.receptionist,
              subscriptionEngine: runtime.subscriptionEngine,
              baseSections: runtime.baseSections,
              instructions: profileData.instructions,
              pulseByTag: buildPulseIndex(runtime.registryService),
            }

            yield* Effect.logInfo("session-profile.initialized").pipe(
              Effect.annotateLogs({
                cwd: profileData.cwd,
                extensionCount: profileData.resolved.extensions.length,
                sectionCount: runtime.baseSections.length,
              }),
            )

            return profile
          }).pipe(
            runWithBuiltLayer(platformLayer),
            Effect.provideService(Scope.Scope, serverScope),
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
                MachineEngine.fromExtensions([]).pipe(Layer.provide(ExtensionTurnControl.Live)),
                ActorEngine.Live,
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
            extensionStateRuntime: Context.get(layerContext, MachineEngine),
            actorEngine: Context.get(layerContext, ActorEngine),
            receptionist: Context.get(layerContext, Receptionist),
            subscriptionEngine: undefined,
            baseSections: [],
            instructions: "",
            pulseByTag: new Map(),
          }
          cache.set(cwd, profile)
          return profile
        }),
    })
  }
}
