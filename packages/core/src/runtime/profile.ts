/**
 * RuntimeProfileResolver — single discover/setup/reconcile pipeline used by
 * every composition root that needs to *discover* extensions.
 *
 * Three callers build the same `{ registry, state-runtime, event-bus }` shape
 * via the same `buildExtensionLayers` substrate:
 *
 *   1. Server startup (`packages/core/src/server/dependencies.ts`)
 *      → calls `resolveRuntimeProfile` + `buildExtensionLayers`
 *   2. Per-cwd profile cache (`packages/core/src/runtime/session-profile.ts`)
 *      → calls `resolveRuntimeProfile` + `buildExtensionLayers`
 *   3. Ephemeral child runs (`packages/core/src/runtime/agent/agent-runner.ts`)
 *      → forwards parent's already-resolved `ExtensionRegistry` (same cwd, no
 *        rediscovery needed) + calls `buildExtensionLayers(registry.getResolved())`
 *
 * All three end up with the same registry/state-runtime/event-bus shape —
 * no more drift like the per-cwd path silently dropping bus subscriptions
 * and no more drift between ephemeral and server runtimes.
 *
 * Per `subtract-before-you-add` and `foundational-thinking`: collapse parallel
 * construction paths into a single substrate; downstream code becomes obvious.
 *
 * @module
 */

import { Effect, FileSystem, Layer, Path, type Scope } from "effect"
import type { ExtensionInput } from "../domain/extension-package.js"
import {
  type PromptSection,
  type PromptSectionInput,
  isDynamicPromptSection,
} from "../domain/prompt.js"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { extractBusSubscriptions } from "../domain/contribution.js"
import { ExtensionEventBus } from "./extensions/event-bus.js"
import { ExtensionRegistry, type ResolvedExtensions } from "./extensions/registry.js"
import { DriverRegistry } from "./extensions/driver-registry.js"
import { WorkflowRuntime } from "./extensions/workflow-runtime.js"
import { ExtensionTurnControl } from "./extensions/turn-control.js"
import {
  collectProcessLayers,
  collectSubscriptions,
  SubscriptionEngine,
} from "./extensions/resource-host/index.js"
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
import { buildBasePromptSections } from "../server/system-prompt.js"
import { ConfigService } from "./config-service.js"

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
  readonly extensions: ReadonlyArray<ExtensionInput>
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
 * Use `compileBaseSections(profile)` to get the merged static section array
 * (resolves dynamic sections via the surrounding Effect runtime).
 */
export interface RuntimeProfile {
  readonly cwd: string
  readonly resolved: ResolvedExtensions
  readonly coreSections: ReadonlyArray<PromptSection>
  readonly extensionSectionInputs: ReadonlyArray<PromptSectionInput>
  readonly instructions: string
  readonly scheduledJobFailures: ReadonlyArray<SchedulerFailure>
}

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
    // `resolveExtensions` (project > user > builtin, matching the registry's
    // `listPromptSections` output). Keep them as `PromptSectionInput` (possibly
    // dynamic) — resolution happens later inside the extension-services runtime
    // so dynamic sections like `Skills`'s prompt can read services from their
    // own `setup.layer`.
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
  Effect.gen(function* () {
    const resolved = yield* Effect.forEach(profile.extensionSectionInputs, (section) =>
      isDynamicPromptSection(section)
        ? Effect.map(
            section.resolve,
            (content): PromptSection => ({
              id: section.id,
              content,
              priority: section.priority,
            }),
          )
        : Effect.succeed(section),
    )
    const sectionMap = new Map(profile.coreSections.map((s) => [s.id, s]))
    for (const s of resolved) sectionMap.set(s.id, s)
    return [...sectionMap.values()]
  }) as Effect.Effect<ReadonlyArray<PromptSection>, never, never>

/**
 * Build the extension-side layers (registry, state runtime, event bus,
 * extension-contributed services) from a resolved profile.
 *
 * Used by the server composition root, the per-cwd cache, and the ephemeral
 * child-run path. Ephemeral runs forward the parent's already-resolved
 * `ResolvedExtensions` (same cwd) instead of re-discovering, but they then
 * call this same builder so the wiring shape is identical.
 */
export const buildExtensionLayers = (resolved: ResolvedExtensions) => {
  // Process-scope Resource layers — the only path for extension-contributed
  // services after C3.2. cwd / session / branch Resources are routed through
  // the per-cwd / ephemeral composers (added in later commits).
  const resourceProcessLayers = collectProcessLayers(resolved.extensions)

  const busSubscriptions = resolved.extensions.flatMap((ext) =>
    extractBusSubscriptions(ext.contributions),
  )

  // Resource subscriptions — register on the new `SubscriptionEngine`
  // (parallel to the legacy `ExtensionEventBus`). C3.6 unifies both.
  const resourceSubscriptions = collectSubscriptions(resolved.extensions)

  const extensionRuntimeLive = WorkflowRuntime.Live(resolved.extensions).pipe(
    Layer.provideMerge(ExtensionTurnControl.Live),
  )

  const baseLayers = Layer.mergeAll(
    ExtensionRegistry.fromResolved(resolved),
    DriverRegistry.fromResolved({
      modelDrivers: resolved.modelDrivers,
      externalDrivers: resolved.externalDrivers,
    }),
    extensionRuntimeLive,
    ExtensionEventBus.withSubscriptions(busSubscriptions),
    SubscriptionEngine.withSubscriptions(resourceSubscriptions),
  )

  if (resourceProcessLayers.length === 0) return baseLayers
  return Layer.mergeAll(baseLayers, ...resourceProcessLayers)
}
