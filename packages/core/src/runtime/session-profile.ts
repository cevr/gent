/**
 * SessionProfile — per-cwd profile for shared server mode.
 *
 * Each unique session cwd gets its own extension discovery, config, prompt sections,
 * and registry. Profiles are lazily initialized on first access and cached.
 */

import { Context, Effect, FileSystem, Layer, Path, Ref, type Scope } from "effect"
import { BuiltinExtensions } from "../extensions/index.js"
import type { LoadedExtension } from "../domain/extension.js"
import type { PromptSection } from "../domain/prompt.js"
import {
  type ExtensionRegistryService,
  type ResolvedExtensions,
  resolveExtensions,
  ExtensionRegistry,
} from "./extensions/registry.js"
import {
  setupBuiltinExtensions,
  setupDiscoveredExtensions,
  reconcileLoadedExtensions,
} from "./extensions/activation.js"
import { discoverExtensions } from "./extensions/loader.js"
import { readDisabledExtensions } from "./extensions/disabled.js"
import { buildBasePromptSections } from "../server/system-prompt.js"
import { ConfigService } from "./config-service.js"
import type { ScheduledJobCommand } from "./extensions/scheduler.js"

// ── SessionProfile ──

export interface SessionProfile {
  readonly cwd: string
  readonly extensions: ReadonlyArray<LoadedExtension>
  readonly resolved: ResolvedExtensions
  readonly registryService: ExtensionRegistryService
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
    FileSystem.FileSystem | Path.Path | ConfigService | Scope.Scope
  > =>
    Layer.effect(
      SessionProfileCache,
      Effect.gen(function* () {
        const cacheRef = yield* Ref.make<Map<string, SessionProfile>>(new Map())
        const configService = yield* ConfigService
        const fs = yield* FileSystem.FileSystem
        const pathSvc = yield* Path.Path

        // Capture platform services as a layer so initProfile can use functions
        // that require FileSystem | Path from the Effect context
        const platformLayer = Layer.mergeAll(
          Layer.succeed(FileSystem.FileSystem, fs),
          Layer.succeed(Path.Path, pathSvc),
        )

        const initProfile = (cwd: string) =>
          Effect.gen(function* () {
            // 1. Read disabled extensions for this cwd
            const disabledSet = yield* readDisabledExtensions({
              home: config.home,
              cwd,
              extra: config.disabledExtensions,
            })

            // 2. Discover project extensions
            const userExtensionsDir = pathSvc.join(config.home, ".gent", "extensions")
            const projectExtensionsDir = pathSvc.join(cwd, ".gent", "extensions")
            const discovery = yield* discoverExtensions({
              userDir: userExtensionsDir,
              projectDir: projectExtensionsDir,
            }).pipe(
              Effect.catchEager((error) =>
                Effect.logWarning("session-profile.extension.discovery.failed").pipe(
                  Effect.annotateLogs({ error: String(error), cwd }),
                  Effect.as({ loaded: [] as const, skipped: [] as const }),
                ),
              ),
            )

            // 3. Setup extensions
            const externalSetup = yield* setupDiscoveredExtensions({
              extensions: discovery.loaded,
              cwd,
              home: config.home,
              disabled: disabledSet,
            })

            const builtinSetup = yield* setupBuiltinExtensions({
              extensions: BuiltinExtensions,
              cwd,
              home: config.home,
              disabled: disabledSet,
            })

            // 4. Reconcile
            const reconciled = yield* reconcileLoadedExtensions({
              extensions: [...builtinSetup.active, ...externalSetup.active],
              failedExtensions: [...builtinSetup.failed, ...externalSetup.failed],
              home: config.home,
              command: config.scheduledJobCommand,
              env: config.scheduledJobEnv,
            })

            for (const failed of reconciled.resolved.failedExtensions) {
              yield* Effect.logWarning("session-profile.extension.failed").pipe(
                Effect.annotateLogs({
                  extensionId: failed.manifest.id,
                  phase: failed.phase,
                  error: failed.error,
                  cwd,
                }),
              )
            }

            // 5. Build registry service from resolved
            const resolved = reconciled.resolved
            const registryLayer = ExtensionRegistry.fromResolved(resolved)
            const registryCtx = yield* Layer.build(registryLayer)
            const registryService = Context.get(registryCtx, ExtensionRegistry)

            // 6. Build base prompt sections for this cwd
            const instructions = yield* configService.loadInstructions(cwd)
            const isGitRepo = yield* fs.exists(pathSvc.join(cwd, ".git"))
            const extensionSections = yield* registryService.listPromptSections()

            const coreSections = buildBasePromptSections({
              cwd,
              platform: config.platform,
              shell: config.shell,
              osVersion: config.osVersion,
              isGitRepo,
              customInstructions: instructions,
            })

            // Merge: extension sections shadow core by id
            const sectionMap = new Map(coreSections.map((s) => [s.id, s]))
            for (const s of extensionSections) {
              sectionMap.set(s.id, s)
            }
            const baseSections = [...sectionMap.values()]

            const profile: SessionProfile = {
              cwd,
              extensions: resolved.extensions,
              resolved,
              registryService,
              baseSections,
              instructions,
            }

            yield* Effect.logInfo("session-profile.initialized").pipe(
              Effect.annotateLogs({
                cwd,
                extensionCount: resolved.extensions.length,
                sectionCount: baseSections.length,
              }),
            )

            return profile
          }).pipe(Effect.provide(platformLayer), Effect.orDie)

        const resolve: SessionProfileCacheService["resolve"] = (cwd) =>
          Effect.gen(function* () {
            // Check cache first
            const cache = yield* Ref.get(cacheRef)
            const existing = cache.get(cwd)
            if (existing !== undefined) return existing

            // Initialize profile with a fresh scope for extension lifecycle
            const profile = yield* initProfile(cwd).pipe(Effect.scoped)

            yield* Ref.update(cacheRef, (m) => {
              const next = new Map(m)
              next.set(cwd, profile)
              return next
            })

            return profile
          })

        const peek: SessionProfileCacheService["peek"] = (cwd) =>
          Ref.get(cacheRef).pipe(Effect.map((cache) => cache.get(cwd)))

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
