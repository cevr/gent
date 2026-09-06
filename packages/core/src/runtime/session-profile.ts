/**
 * SessionProfile — per-(workspace,cwd) live profile for shared server mode.
 *
 * Each cache entry owns one ResourceGraphHost. The host owns resources and
 * publication scopes for that entry until the server scope closes.
 */

import {
  Context,
  Effect,
  Exit,
  FileSystem,
  HashMap,
  Layer,
  Option,
  Path,
  Scope,
  Schema,
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
import { ConfigService, type ConfigLoadError } from "./config-service.js"
import type { ScheduledJobCommand } from "./extensions/resource-host/schedule-engine.js"
import { CronRuntime } from "./extensions/resource-host/schedule-engine.js"
import { ProcessRunner } from "../utils/run-process.js"
import { CurrentWorkspaceId, type WorkspaceId } from "../server/workspace-rpc.js"
import {
  makeRuntimeProfileOwner,
  makeRuntimeProfileOwnerHost,
  type LiveRuntimeProfile,
  isRuntimeProfilePreparedDesired,
  type RuntimeProfileOwner,
} from "./live-profile.js"
import {
  ResourceGraphApplyError,
  ResourceGraphDesiredApplier,
  type ResourceGraphDesiredApplication,
  type ResourceGraphDesiredApplierService,
  type ResourceGraphPrepared,
} from "./extensions/resource-host/resource-graph-entity.js"
import type {
  ResourceGraphHost,
  ResourceGraphHostError,
  ResourceGraphRetireMode,
  ResourceGraphPublication,
} from "./extensions/resource-host/resource-graph-host.js"
import type {
  RuntimeProfile,
  RuntimeProfileCatalog,
  RuntimeProfileInputs,
  RuntimeProfileServiceContext,
} from "./profile.js"
import type { ResourceGraphSnapshot } from "../domain/resource-graph-state.js"

const allowAllPermission: PermissionService = {
  check: () => Effect.succeed("allowed"),
}

// ── SessionProfile ──

export interface SessionProfile {
  readonly cwd: string
  readonly extensions: ReadonlyArray<LoadedExtension>
  readonly resolved: ResolvedExtensions
  /**
   * Legacy context view. New callers must enter `publication.run` before
   * using resource services so retirement can wait for active work.
   */
  readonly layerContext: RuntimeProfileServiceContext
  readonly permissionService: PermissionService
  readonly registryService: ExtensionRegistryService
  readonly driverRegistryService: DriverRegistryService
  readonly baseSections: ReadonlyArray<PromptSection>
  readonly instructions: string
  /** Authority for entering this profile's resource context. */
  readonly publication?: ResourceGraphPublication<RuntimeProfileCatalog>
  /** JSON-safe desired graph used by durable repair and restart recovery. */
  readonly resourceGraphSnapshot?: ResourceGraphSnapshot
}

/** A profile returned by SessionProfileCache.Live always owns a publication. */
export interface LiveSessionProfile extends SessionProfile {
  readonly publication: ResourceGraphPublication<RuntimeProfileCatalog>
  readonly resourceGraphSnapshot: ResourceGraphSnapshot
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
}

export interface SessionProfileCacheService {
  /** Get or lazily create a profile for the given cwd. */
  readonly resolve: (cwd: string) => Effect.Effect<SessionProfile>
  /**
   * Load target declarations without publishing or acquiring resources.
   * An unknown cwd is not retained in the live cache.
   */
  readonly preview: (cwd: string) => Effect.Effect<ResourceGraphSnapshot, ResourceGraphApplyError>
  /** Reload declarations and publish a new catalog when semantic inputs change. */
  readonly refresh: (
    cwd: string,
    options?: { readonly retireMode?: ResourceGraphRetireMode },
  ) => Effect.Effect<SessionProfile, ConfigLoadError | ResourceGraphHostError>
  /** Return the current publication without initializing the cwd. */
  readonly current: (cwd: string) => Effect.Effect<Option.Option<SessionProfile>>
  /** Require an active publication without reviving a retired generation. */
  readonly requireCurrent: (
    cwd: string,
  ) => Effect.Effect<SessionProfile, SessionProfileUnavailableError>
}

/** No active publication is available for an already-known cache key. */
export class SessionProfileUnavailableError extends Schema.TaggedError<SessionProfileUnavailableError>()(
  "SessionProfileUnavailableError",
  {
    workspaceId: Schema.String,
    cwd: Schema.String,
    message: Schema.String,
  },
) {}

interface ProfileCacheEntry {
  readonly owner: RuntimeProfileOwner
}

const cacheKey = (workspaceId: WorkspaceId, cwd: string): string => `${workspaceId}\u0000${cwd}`

export class SessionProfileCache extends Context.Service<
  SessionProfileCache,
  SessionProfileCacheService
>()("@gent/core/src/runtime/session-profile/SessionProfileCache") {
  static Live = (
    config: SessionProfileCacheConfig,
  ): Layer.Layer<
    SessionProfileCache | ResourceGraphDesiredApplier,
    never,
    | FileSystem.FileSystem
    | Path.Path
    | ChildProcessSpawner
    | ConfigService
    | ScopeType.Scope
    | GentPlatform
  > =>
    Layer.effectContext(
      Effect.gen(function* () {
        const configService = yield* ConfigService
        const fs = yield* FileSystem.FileSystem
        const pathSvc = yield* Path.Path
        const spawner = yield* ChildProcessSpawner
        const platform = yield* GentPlatform
        const processRunner = yield* ProcessRunner
        const schedulerRuntime = yield* Effect.serviceOption(CronRuntime)
        const cacheRef = yield* TxRef.make(HashMap.empty<string, ProfileCacheEntry>())
        // The global lock only protects creation of per-key locks. Profile
        // discovery and graph reconciliation must not block unrelated cwd or
        // workspace keys.
        const initSemaphore = yield* Semaphore.make(1)
        const keyLocksRef = yield* TxRef.make(HashMap.empty<string, Semaphore.Semaphore>())
        // The host finalizer is attached to this server scope.
        const serverScope = yield* Scope.Scope

        const platformContext: Context.Context<unknown> = Context.makeUnsafe(new Map())
        const platformServicesContext = platformContext.pipe(
          Context.add(FileSystem.FileSystem, fs),
          Context.add(Path.Path, pathSvc),
          Context.add(ChildProcessSpawner, spawner),
          Context.add(ConfigService, configService),
          Context.add(GentPlatform, platform),
          Context.add(ProcessRunner, processRunner),
        )

        const inputsFor = (cwd: string): RuntimeProfileInputs => ({
          cwd,
          home: config.home,
          platform: config.platform,
          shell: config.shell,
          osVersion: config.osVersion,
          extensions: config.extensions,
          disabledExtensions: config.disabledExtensions,
          scheduledJobCommand: config.scheduledJobCommand,
          scheduledJobEnv: config.scheduledJobEnv,
        })

        const rememberEntry = (
          key: string,
          entry: ProfileCacheEntry,
        ): Effect.Effect<ProfileCacheEntry> =>
          Effect.uninterruptible(
            TxRef.update(cacheRef, (current) => HashMap.set(current, key, entry)).pipe(
              Effect.as(entry),
            ),
          )

        const makeOwner = (): Effect.Effect<
          {
            readonly owner: RuntimeProfileOwner
            readonly host: ResourceGraphHost<RuntimeProfileCatalog>
          },
          never,
          never
        > =>
          makeRuntimeProfileOwnerHost({
            baseContext: platformServicesContext,
          }).pipe(
            Effect.provideService(Scope.Scope, serverScope),
            Effect.provideService(GentPlatform, platform),
            Effect.map((host) => ({
              host,
              owner: makeRuntimeProfileOwner({
                host,
                configService,
                fileSystem: fs,
                path: pathSvc,
                platform,
                childProcessSpawner: spawner,
                schedulerRuntime: Option.getOrUndefined(schedulerRuntime),
              }),
            })),
          )

        const initProfile = (key: string, cwd: string) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const initialized = yield* makeOwner()
              const { host, owner } = initialized
              // Keep declaration loading and graph staging interruptible. Once
              // the host has published, the masked tail owns the handoff to
              // the cache and cannot orphan a live host between return and
              // insertion.
              const runtime = yield* restore(owner.refresh(inputsFor(cwd))).pipe(Effect.exit)
              if (Exit.isFailure(runtime)) {
                yield* host.shutdown.pipe(Effect.ignore)
                return yield* Effect.failCause(runtime.cause)
              }
              const profile = sessionProfileFromLiveRuntime(runtime.value)
              yield* Effect.logInfo("session-profile.initialized").pipe(
                Effect.annotateLogs({
                  cwd: profile.cwd,
                  extensionCount: profile.resolved.extensions.length,
                  sectionCount: profile.baseSections.length,
                }),
              )
              // The host and cache insertion share this masked handoff. The
              // owner cannot become live without an entry that can find it.
              return yield* rememberEntry(key, { owner })
            }),
          ).pipe(Effect.provideService(Scope.Scope, serverScope))

        const lockFor = (key: string) =>
          Effect.gen(function* () {
            const locks = yield* TxRef.get(keyLocksRef)
            const existing = HashMap.get(locks, key)
            if (existing._tag === "Some") return existing.value
            const created = yield* Semaphore.make(1)
            yield* TxRef.update(keyLocksRef, (current) => HashMap.set(current, key, created))
            return created
          }).pipe(initSemaphore.withPermits(1))

        const provideKeyLock =
          (key: string) =>
          <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
            lockFor(key).pipe(Effect.flatMap((lock) => effect.pipe(lock.withPermits(1))))

        const initOwner = (key: string) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              const initialized = yield* makeOwner()
              return yield* rememberEntry(key, { owner: initialized.owner })
            }),
          ).pipe(Effect.provideService(Scope.Scope, serverScope))

        const currentProfile = (entry: ProfileCacheEntry, workspaceId: WorkspaceId, cwd: string) =>
          entry.owner.current.pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new SessionProfileUnavailableError({
                      workspaceId,
                      cwd,
                      message: "Session profile has no active publication",
                    }),
                  ),
                onSome: (runtime) => Effect.succeed(sessionProfileFromLiveRuntime(runtime)),
              }),
            ),
          )

        const resolve: SessionProfileCacheService["resolve"] = (cwd) =>
          Effect.gen(function* () {
            const workspaceId = yield* CurrentWorkspaceId
            const canonicalCwd = pathSvc.resolve(cwd)
            const key = cacheKey(workspaceId, canonicalCwd)
            const cache = yield* TxRef.get(cacheRef)
            const existing = HashMap.get(cache, key)
            if (existing._tag === "Some") {
              return yield* currentProfile(existing.value, workspaceId, canonicalCwd).pipe(
                Effect.orDie,
              )
            }

            return yield* Effect.gen(function* () {
              const current = yield* TxRef.get(cacheRef)
              const found = HashMap.get(current, key)
              if (found._tag === "Some") {
                return yield* currentProfile(found.value, workspaceId, canonicalCwd).pipe(
                  Effect.orDie,
                )
              }
              const remembered = yield* initProfile(key, canonicalCwd).pipe(Effect.orDie)
              return yield* currentProfile(remembered, workspaceId, canonicalCwd).pipe(Effect.orDie)
            }).pipe(provideKeyLock(key))
          })

        const refresh: SessionProfileCacheService["refresh"] = (cwd, options) =>
          Effect.gen(function* () {
            const workspaceId = yield* CurrentWorkspaceId
            const canonicalCwd = pathSvc.resolve(cwd)
            const key = cacheKey(workspaceId, canonicalCwd)
            return yield* Effect.gen(function* () {
              const current = yield* TxRef.get(cacheRef)
              const existing = HashMap.get(current, key)
              if (existing._tag === "None") {
                const remembered = yield* initProfile(key, canonicalCwd)
                return yield* currentProfile(remembered, workspaceId, canonicalCwd).pipe(
                  Effect.orDie,
                )
              }
              const runtime = yield* existing.value.owner.refresh(
                inputsFor(canonicalCwd),
                options?.retireMode,
              )
              return sessionProfileFromLiveRuntime(runtime)
            }).pipe(provideKeyLock(key))
          })

        const preview: SessionProfileCacheService["preview"] = (cwd) =>
          Effect.gen(function* () {
            const workspaceId = yield* CurrentWorkspaceId
            const canonicalCwd = pathSvc.resolve(cwd)
            const key = cacheKey(workspaceId, canonicalCwd)
            return yield* Effect.gen(function* () {
              const cache = yield* TxRef.get(cacheRef)
              const existing = HashMap.get(cache, key)
              if (existing._tag === "Some") {
                return yield* existing.value.owner.preview(inputsFor(canonicalCwd))
              }

              // A preview must not create an unpublished cache entry. Such an
              // entry would make a later resolve observe an owner with no live
              // publication and would poison the first-use path.
              const initialized = yield* makeOwner()
              return yield* initialized.owner
                .preview(inputsFor(canonicalCwd))
                .pipe(Effect.ensuring(initialized.host.shutdown.pipe(Effect.ignore)))
            }).pipe(provideKeyLock(key))
          })

        const current: SessionProfileCacheService["current"] = (cwd) =>
          Effect.gen(function* () {
            const workspaceId = yield* CurrentWorkspaceId
            const canonicalCwd = pathSvc.resolve(cwd)
            const cache = yield* TxRef.get(cacheRef)
            const existing = HashMap.get(cache, cacheKey(workspaceId, canonicalCwd))
            if (existing._tag === "None") return Option.none()
            return yield* existing.value.owner.current.pipe(
              Effect.map(Option.map(sessionProfileFromLiveRuntime)),
            )
          })

        const requireCurrent: SessionProfileCacheService["requireCurrent"] = (cwd) =>
          Effect.gen(function* () {
            const workspaceId = yield* CurrentWorkspaceId
            const canonicalCwd = pathSvc.resolve(cwd)
            const cache = yield* TxRef.get(cacheRef)
            const existing = HashMap.get(cache, cacheKey(workspaceId, canonicalCwd))
            const entry = yield* Effect.fromOption(
              existing,
              () =>
                new SessionProfileUnavailableError({
                  workspaceId,
                  cwd: canonicalCwd,
                  message: "Session profile is not initialized",
                }),
            )
            return yield* currentProfile(entry, workspaceId, canonicalCwd)
          })

        const ownerFor = (
          request: ResourceGraphDesiredApplication,
        ): Effect.Effect<RuntimeProfileOwner, ResourceGraphApplyError> =>
          Effect.gen(function* () {
            const key = cacheKey(request.receipt.workspaceId, request.receipt.cwd)
            const cache = yield* TxRef.get(cacheRef)
            const entry = HashMap.get(cache, key)
            if (entry._tag === "Some") return entry.value.owner
            const remembered = yield* initOwner(key)
            return remembered.owner
          }).pipe(provideKeyLock(cacheKey(request.receipt.workspaceId, request.receipt.cwd)))

        const desiredApplier: ResourceGraphDesiredApplierService = {
          prepare: (request) =>
            ownerFor(request).pipe(
              Effect.flatMap((owner) =>
                owner.prepareDesired(request, inputsFor(String(request.receipt.cwd))),
              ),
            ),
          validate: (prepared: ResourceGraphPrepared) => {
            if (!isRuntimeProfilePreparedDesired(prepared)) {
              return Effect.fail(
                new ResourceGraphApplyError({
                  phase: "validate",
                  message: "Prepared resource graph belongs to a different profile owner",
                }),
              )
            }
            return prepared.owner.validateDesired(prepared)
          },
          applyDesired: (prepared: ResourceGraphPrepared, admit) => {
            if (!isRuntimeProfilePreparedDesired(prepared)) {
              return Effect.fail(
                new ResourceGraphApplyError({
                  phase: "apply",
                  message: "Prepared resource graph belongs to a different profile owner",
                }),
              )
            }
            return prepared.owner.applyDesired(prepared, admit)
          },
        }
        const cacheService = SessionProfileCache.of({
          resolve,
          preview,
          refresh,
          current,
          requireCurrent,
        })
        return Context.empty().pipe(
          Context.add(SessionProfileCache, cacheService),
          Context.add(ResourceGraphDesiredApplier, desiredApplier),
        )
      }),
    )

  static Test = (profiles?: Map<string, SessionProfile>): Layer.Layer<SessionProfileCache> => {
    const cache = Option.getOrElse(
      Option.fromUndefinedOr(profiles),
      () => new Map<string, SessionProfile>(),
    )
    return Layer.succeed(
      SessionProfileCache,
      SessionProfileCache.of({
        resolve: (cwd) =>
          Effect.sync(() => {
            const existing = Option.fromUndefinedOr(cache.get(cwd))
            if (Option.isSome(existing)) return existing.value
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
        preview: () =>
          Effect.fail(
            new ResourceGraphApplyError({
              phase: "prepare",
              message: "SessionProfileCache.Test does not support graph preview",
            }),
          ),
        refresh: () => Effect.die("SessionProfileCache.Test does not support refresh"),
        current: (cwd) => Effect.sync(() => Option.fromUndefinedOr(cache.get(cwd))),
        requireCurrent: (cwd) =>
          Effect.flatMap(
            Effect.sync(() => Option.fromUndefinedOr(cache.get(cwd))),
            (profile) =>
              Effect.fromOption(
                profile,
                () =>
                  new SessionProfileUnavailableError({
                    workspaceId: "test",
                    cwd,
                    message: "Session profile is not initialized",
                  }),
              ),
          ),
      }),
    )
  }
}

interface SessionProfileRuntime {
  readonly profile: RuntimeProfile
  readonly layerContext: RuntimeProfileServiceContext
  readonly permissionService: PermissionService
  readonly registryService: ExtensionRegistryService
  readonly driverRegistryService: DriverRegistryService
  readonly baseSections: ReadonlyArray<PromptSection>
  readonly publication?: ResourceGraphPublication<RuntimeProfileCatalog>
  readonly resourceGraphSnapshot?: ResourceGraphSnapshot
}

export function sessionProfileFromRuntime(
  runtime: SessionProfileRuntime & {
    readonly publication: ResourceGraphPublication<RuntimeProfileCatalog>
    readonly resourceGraphSnapshot: ResourceGraphSnapshot
  },
): LiveSessionProfile
export function sessionProfileFromRuntime(runtime: SessionProfileRuntime): SessionProfile
export function sessionProfileFromRuntime(runtime: SessionProfileRuntime): SessionProfile {
  return {
    cwd: runtime.profile.cwd,
    extensions: runtime.profile.resolved.extensions,
    resolved: runtime.profile.resolved,
    layerContext: runtime.layerContext,
    permissionService: runtime.permissionService,
    registryService: runtime.registryService,
    driverRegistryService: runtime.driverRegistryService,
    baseSections: runtime.baseSections,
    instructions: runtime.profile.instructions,
    publication: runtime.publication,
    resourceGraphSnapshot: runtime.resourceGraphSnapshot,
  }
}

export const sessionProfileFromLiveRuntime = (runtime: LiveRuntimeProfile): LiveSessionProfile =>
  sessionProfileFromRuntime({
    ...runtime.publication.value,
    publication: runtime.publication,
    resourceGraphSnapshot: runtime.desired.snapshot,
  })
