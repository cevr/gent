/**
 * SessionProfile — per-(workspace,cwd) live profile for shared server mode.
 *
 * Each cache entry is built once. Declarations are loaded, every extension's
 * process resources are built into a scope that closes with the server, and
 * the catalog is staged from the resulting context. An extension whose process
 * resource fails to build is reported as a failed extension and the rest of the
 * profile stays live.
 */

import {
  Cause,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Scope,
  Semaphore,
  type Scope as ScopeType,
} from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { GentPlatform } from "./gent-platform.js"
import type {
  FailedExtension,
  GentExtension,
  ExtensionSetupServices,
  LoadedExtension,
} from "../domain/extension.js"
import { sortExtensionsByScope } from "../domain/extension.js"
import { ProcessGenerationId } from "../domain/ids.js"
import {
  buildResourceLayer,
  collectResourceEntries,
  DriverRegistry,
  ExtensionRegistry,
  resolveExtensions,
  toFailedExtension,
} from "./extension-host.js"
import { ConfigService, type UserConfig } from "./config.js"
import { CurrentWorkspaceId, type WorkspaceId } from "../server/workspace-rpc.js"
import {
  buildSessionProfile,
  loadRuntimeProfileDeclarations,
  type RuntimeProfileInputs,
  type SessionProfile,
} from "./profile.js"

export type { SessionProfile } from "./profile.js"

// ── SessionProfileCache ──

interface SessionProfileCacheConfig {
  readonly home: string
  readonly platform: string
  readonly shell?: string
  readonly osVersion?: string
  readonly disabledExtensions?: ReadonlyArray<string>
  readonly extensions: ReadonlyArray<GentExtension<ExtensionSetupServices>>
}

export interface SessionProfileCacheService {
  /** Get or lazily create a profile for the given cwd. */
  readonly resolve: (cwd: string) => Effect.Effect<SessionProfile>
}

const cacheKey = (workspaceId: WorkspaceId, cwd: string): string => `${workspaceId}\u0000${cwd}`

const effectiveInputs = (
  inputs: RuntimeProfileInputs,
  config: UserConfig,
): RuntimeProfileInputs => {
  const configDisabled = Option.getOrElse(
    Option.fromUndefinedOr(config.disabledExtensions),
    () => [],
  )
  const explicitDisabled = Option.getOrElse(
    Option.fromUndefinedOr(inputs.disabledExtensions),
    () => [],
  )
  return {
    ...inputs,
    disabledExtensions: [...explicitDisabled, ...configDisabled],
  }
}

interface StartedProcessResources {
  readonly active: ReadonlyArray<LoadedExtension>
  readonly failed: ReadonlyArray<FailedExtension>
  readonly context: Context.Context<unknown>
}

/**
 * Build every extension's process resources in resolution order, so a later
 * extension's service wins exactly as it does in the registry. Each extension
 * gets its own child scope so a failed build releases only what it acquired;
 * the extension is then reported as failed at the startup phase instead of
 * taking the whole profile down.
 */
const startProcessResources = (
  extensions: ReadonlyArray<LoadedExtension>,
  baseContext: Context.Context<unknown>,
  profileScope: Scope.Scope,
): Effect.Effect<StartedProcessResources> =>
  Effect.gen(function* () {
    let context = baseContext
    const active: Array<LoadedExtension> = []
    const failed: Array<FailedExtension> = []
    for (const extension of sortExtensionsByScope(extensions)) {
      if (collectResourceEntries([extension], "process").length === 0) {
        active.push(extension)
        continue
      }
      const extensionScope = yield* Scope.fork(profileScope)
      const built = yield* Layer.build(buildResourceLayer([extension], "process")).pipe(
        Effect.provideContext(context),
        Effect.provideService(Scope.Scope, extensionScope),
        Effect.exit,
      )
      if (Exit.isSuccess(built)) {
        context = Context.merge(context, built.value)
        active.push(extension)
        continue
      }
      const error = Cause.pretty(built.cause)
      yield* Scope.close(extensionScope, built)
      yield* Effect.logError("session-profile.resource.failed").pipe(
        Effect.annotateLogs({ extensionId: extension.manifest.id, error }),
      )
      failed.push(toFailedExtension(extension, "startup", error))
    }
    return { active, failed, context }
  })

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
        // Every profile's resources close with this server scope.
        const serverScope = yield* Scope.Scope
        const generationId = ProcessGenerationId.make(yield* platform.randomId)

        const platformServicesContext: Context.Context<unknown> = Context.makeUnsafe<unknown>(
          new Map(),
        ).pipe(
          Context.add(FileSystem.FileSystem, fs),
          Context.add(Path.Path, pathSvc),
          Context.add(ChildProcessSpawner, spawner),
          Context.add(ConfigService, configService),
          Context.add(GentPlatform, platform),
        )

        const profiles = new Map<string, SessionProfile>()
        // The gate only protects creation of per-key locks. Building one cwd
        // must not block unrelated cwd or workspace keys.
        const locks = new Map<string, Semaphore.Semaphore>()
        const lockGate = yield* Semaphore.make(1)
        const lockFor = (key: string) =>
          Effect.gen(function* () {
            const existing = Option.fromNullishOr(locks.get(key))
            if (Option.isSome(existing)) return existing.value
            const created = yield* Semaphore.make(1)
            locks.set(key, created)
            return created
          }).pipe(lockGate.withPermits(1))

        const inputsFor = (cwd: string): RuntimeProfileInputs => ({
          cwd,
          home: config.home,
          platform: config.platform,
          shell: config.shell,
          osVersion: config.osVersion,
          extensions: config.extensions,
          disabledExtensions: config.disabledExtensions,
        })

        const buildProfile = (cwd: string) =>
          Effect.gen(function* () {
            const profileScope = yield* Scope.fork(serverScope)
            return yield* Effect.gen(function* () {
              const userConfig = yield* configService.getFresh(cwd)
              const declarations = yield* loadRuntimeProfileDeclarations(
                effectiveInputs(inputsFor(cwd), userConfig),
              ).pipe(Effect.provideContext(platformServicesContext))
              const started = yield* startProcessResources(
                declarations.extensionDeclarations.active,
                platformServicesContext,
                profileScope,
              )
              const resolved = resolveExtensions(started.active, [
                ...declarations.extensionDeclarations.failed,
                ...started.failed,
              ])
              return yield* buildSessionProfile({
                cwd,
                resolved,
                coreSections: declarations.coreSections,
                resourceContext: started.context,
                generationId,
              })
            }).pipe(
              Effect.provideService(Scope.Scope, profileScope),
              // A failed or interrupted build releases everything it acquired.
              Effect.onError((cause) => Scope.close(profileScope, Exit.failCause(cause))),
            )
          })

        const resolve: SessionProfileCacheService["resolve"] = (cwd) =>
          Effect.gen(function* () {
            const workspaceId = yield* CurrentWorkspaceId
            const canonicalCwd = pathSvc.resolve(cwd)
            const key = cacheKey(workspaceId, canonicalCwd)
            const cached = Option.fromNullishOr(profiles.get(key))
            if (Option.isSome(cached)) return cached.value
            const lock = yield* lockFor(key)
            return yield* Effect.gen(function* () {
              const found = Option.fromNullishOr(profiles.get(key))
              if (Option.isSome(found)) return found.value
              const profile = yield* buildProfile(canonicalCwd).pipe(Effect.orDie)
              profiles.set(key, profile)
              yield* Effect.logInfo("session-profile.initialized").pipe(
                Effect.annotateLogs({
                  cwd: profile.cwd,
                  extensionCount: profile.resolved.extensions.length,
                  sectionCount: profile.baseSections.length,
                }),
              )
              return profile
            }).pipe(lock.withPermits(1))
          })

        return SessionProfileCache.of({ resolve })
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
              resolved,
              layerContext,
              registryService: Context.get(layerContext, ExtensionRegistry),
              driverRegistryService: Context.get(layerContext, DriverRegistry),
              baseSections: [],
              generationId: ProcessGenerationId.make("test"),
            }
            cache.set(cwd, profile)
            return profile
          }),
      }),
    )
  }
}
