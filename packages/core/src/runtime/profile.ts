/**
 * RuntimeProfileResolver — single activation pipeline used by every composition root.
 *
 * Three callers historically built the same `{ resolved extensions, prompt sections,
 * scheduled jobs }` shape independently:
 *
 *   1. Server startup (`packages/core/src/server/dependencies.ts`)
 *   2. Per-cwd profile cache (`packages/core/src/runtime/session-profile.ts`)
 *   3. Ephemeral child runs (`packages/core/src/runtime/agent/agent-runner.ts`)
 *
 * Every drift between these paths surfaced as a runtime gotcha (e.g. ephemeral runs
 * silently using parent storage because layer precedence flipped). This module is the
 * one resolver — every caller uses it and the only differences left are scope
 * (server-lifetime vs per-cwd vs per-run) and downstream layer composition.
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
import { ExtensionEventBus } from "./extensions/event-bus.js"
import { ExtensionRegistry, type ResolvedExtensions } from "./extensions/registry.js"
import { ExtensionStateRuntime } from "./extensions/state-runtime.js"
import { ExtensionTurnControl } from "./extensions/turn-control.js"
import {
  reconcileLoadedExtensions,
  setupBuiltinExtensions,
  setupDiscoveredExtensions,
} from "./extensions/activation.js"
import { discoverExtensions } from "./extensions/loader.js"
import { readDisabledExtensions } from "./extensions/disabled.js"
import type { ScheduledJobCommand, SchedulerFailure } from "./extensions/scheduler.js"
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
 *   - ephemeral run: not used here; ephemeral runs forward an already-resolved
 *     `ExtensionRegistry` from the parent and do not re-discover.
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
 * Used by the server composition root. Ephemeral runs in
 * `runtime/agent/agent-runner.ts` build a similar shape but forward the
 * registry from the parent (read-only) rather than rebuilding it; that
 * intentional divergence is documented at the call site.
 */
export const buildExtensionLayers = (resolved: ResolvedExtensions) => {
  const extensionLayers = resolved.extensions
    .filter((ext) => ext.setup.layer !== undefined)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
    .map((ext) => ext.setup.layer as Layer.Layer<any>)

  const busSubscriptions = resolved.extensions.flatMap((ext) =>
    (ext.setup.busSubscriptions ?? []).map((sub) => ({
      pattern: sub.pattern,
      handler: sub.handler,
    })),
  )

  const extensionRuntimeLive = ExtensionStateRuntime.Live(resolved.extensions).pipe(
    Layer.provideMerge(ExtensionTurnControl.Live),
  )

  const baseLayers = Layer.mergeAll(
    ExtensionRegistry.fromResolved(resolved),
    extensionRuntimeLive,
    ExtensionEventBus.withSubscriptions(busSubscriptions),
  )

  if (extensionLayers.length === 0) return baseLayers
  return Layer.mergeAll(baseLayers, ...extensionLayers)
}
