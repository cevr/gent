import { Cause, Effect } from "effect"
import type { FileSystem, Path, Scope } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type {
  FailedExtension,
  FailedExtensionPhase,
  LoadedExtension,
} from "../../domain/extension.js"
import { type ExtensionInput, resolveExtensionInput } from "../../domain/extension-package.js"
import { resolveExtensions, type ResolvedExtensions } from "./registry.js"
import type { DiscoveredExtension } from "./loader.js"
import { setupExtension } from "./loader.js"
import {
  reconcileScheduledJobs,
  type ScheduledJobCommand,
  type SchedulerFailure,
} from "./scheduler.js"

export interface ExtensionActivationResult {
  readonly active: ReadonlyArray<LoadedExtension>
  readonly failed: ReadonlyArray<FailedExtension>
}

export interface ExtensionReconciliationResult {
  readonly resolved: ResolvedExtensions
  readonly scheduledJobFailures: ReadonlyArray<SchedulerFailure>
}

const toFailedExtension = (
  ext: {
    manifest: LoadedExtension["manifest"]
    kind: LoadedExtension["kind"]
    sourcePath: string
  },
  phase: FailedExtensionPhase,
  error: string,
): FailedExtension => ({
  manifest: ext.manifest,
  kind: ext.kind,
  sourcePath: ext.sourcePath,
  phase,
  error,
})

const formatFailure = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { readonly message: unknown }).message)
    : String(error)

export const setupBuiltinExtensions = (params: {
  readonly extensions: ReadonlyArray<ExtensionInput>
  readonly cwd: string
  readonly home: string
  readonly disabled: ReadonlySet<string>
}): Effect.Effect<
  ExtensionActivationResult,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const active: LoadedExtension[] = []
    const failed: FailedExtension[] = []

    for (const input of params.extensions) {
      const extension = resolveExtensionInput(input)
      if (params.disabled.has(extension.manifest.id)) {
        yield* Effect.logDebug("extension.setup.skipped.disabled").pipe(
          Effect.annotateLogs({ extensionId: extension.manifest.id, kind: "builtin" }),
        )
        continue
      }

      const discovered = {
        extension,
        kind: "builtin" as const,
        sourcePath: "builtin",
      }

      const exit = yield* setupExtension(discovered, params.cwd, params.home).pipe(Effect.exit)
      if (exit._tag === "Success") {
        active.push(exit.value)
        yield* Effect.logDebug("extension.setup.ok").pipe(
          Effect.annotateLogs({
            extensionId: extension.manifest.id,
            kind: "builtin",
            hasActor: exit.value.setup.actor !== undefined,
            hasLayer: exit.value.setup.layer !== undefined,
            tools: exit.value.setup.tools?.length ?? 0,
          }),
        )
      } else {
        const error = formatFailure(Cause.squash(exit.cause))
        failed.push(
          toFailedExtension(
            { manifest: extension.manifest, kind: "builtin", sourcePath: "builtin" },
            "setup",
            error,
          ),
        )
        yield* Effect.logWarning("extension.setup.failed").pipe(
          Effect.annotateLogs({
            extensionId: extension.manifest.id,
            kind: "builtin",
            error,
          }),
        )
      }
    }

    return { active, failed }
  })

export const setupDiscoveredExtensions = (params: {
  readonly extensions: ReadonlyArray<DiscoveredExtension>
  readonly cwd: string
  readonly home: string
  readonly disabled: ReadonlySet<string>
}): Effect.Effect<
  ExtensionActivationResult,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const active: LoadedExtension[] = []
    const failed: FailedExtension[] = []

    for (const discovered of params.extensions) {
      if (params.disabled.has(discovered.extension.manifest.id)) {
        yield* Effect.logDebug("extension.setup.skipped.disabled").pipe(
          Effect.annotateLogs({
            extensionId: discovered.extension.manifest.id,
            kind: discovered.kind,
          }),
        )
        continue
      }

      const exit = yield* setupExtension(discovered, params.cwd, params.home).pipe(Effect.exit)
      if (exit._tag === "Success") {
        active.push(exit.value)
        yield* Effect.logDebug("extension.setup.ok").pipe(
          Effect.annotateLogs({
            extensionId: discovered.extension.manifest.id,
            kind: discovered.kind,
            hasActor: exit.value.setup.actor !== undefined,
            hasLayer: exit.value.setup.layer !== undefined,
            tools: exit.value.setup.tools?.length ?? 0,
          }),
        )
      } else {
        const error = formatFailure(Cause.squash(exit.cause))
        failed.push(
          toFailedExtension(
            {
              manifest: discovered.extension.manifest,
              kind: discovered.kind,
              sourcePath: discovered.sourcePath,
            },
            "setup",
            error,
          ),
        )
        yield* Effect.logWarning("extension.setup.failed").pipe(
          Effect.annotateLogs({
            extensionId: discovered.extension.manifest.id,
            kind: discovered.kind,
            sourcePath: discovered.sourcePath,
            error,
          }),
        )
      }
    }

    return { active, failed }
  })

const extensionKey = (ext: Pick<LoadedExtension, "kind" | "manifest" | "sourcePath">) =>
  `${ext.kind}:${ext.manifest.id}:${ext.sourcePath}`

const formatConflicts = (
  label: string,
  scope: LoadedExtension["kind"],
  key: string,
  extensions: ReadonlyArray<LoadedExtension>,
) =>
  `Ambiguous ${label} "${key}" in scope "${scope}" across ${extensions
    .map((ext) => `"${ext.manifest.id}"`)
    .join(", ")}`

export const collectValidationFailures = (
  extensions: ReadonlyArray<LoadedExtension>,
): ReadonlyMap<string, { ext: LoadedExtension; errors: ReadonlyArray<string> }> => {
  const failures = new Map<string, { ext: LoadedExtension; errors: string[] }>()

  const addFailure = (ext: LoadedExtension, error: string) => {
    const key = extensionKey(ext)
    const current = failures.get(key)
    if (current === undefined) {
      failures.set(key, { ext, errors: [error] })
      return
    }
    if (!current.errors.includes(error)) current.errors.push(error)
  }

  const idsByScope = new Map<LoadedExtension["kind"], Map<string, LoadedExtension[]>>()
  for (const ext of extensions) {
    const scopeMap = idsByScope.get(ext.kind) ?? new Map<string, LoadedExtension[]>()
    const sameId = scopeMap.get(ext.manifest.id) ?? []
    sameId.push(ext)
    scopeMap.set(ext.manifest.id, sameId)
    idsByScope.set(ext.kind, scopeMap)
  }
  for (const [scope, scopeMap] of idsByScope) {
    for (const [id, sameId] of scopeMap) {
      if (sameId.length <= 1) continue
      const error = `Duplicate extension id "${id}" in scope "${scope}"`
      for (const ext of sameId) addFailure(ext, error)
    }
  }

  const collectScopedCollisions = <T>(
    extract: (setup: LoadedExtension["setup"]) => ReadonlyArray<T> | undefined,
    getKey: (item: T) => string,
    label: string,
  ) => {
    const byScope = new Map<LoadedExtension["kind"], Map<string, LoadedExtension[]>>()
    for (const ext of extensions) {
      const scopeMap = byScope.get(ext.kind) ?? new Map<string, LoadedExtension[]>()
      const seen = new Set<string>()
      for (const item of extract(ext.setup) ?? []) {
        const key = getKey(item)
        if (seen.has(key)) continue
        seen.add(key)
        const existing = scopeMap.get(key) ?? []
        existing.push(ext)
        scopeMap.set(key, existing)
      }
      byScope.set(ext.kind, scopeMap)
    }

    for (const [scope, scopeMap] of byScope) {
      for (const [key, sameKey] of scopeMap) {
        if (sameKey.length <= 1) continue
        const error = formatConflicts(label, scope, key, sameKey)
        for (const ext of sameKey) addFailure(ext, error)
      }
    }
  }

  collectScopedCollisions(
    (setup) => setup.tools,
    (tool) => tool.name,
    "tool",
  )
  collectScopedCollisions(
    (setup) => setup.agents,
    (agent) => agent.name,
    "agent",
  )
  collectScopedCollisions(
    (setup) => setup.providers,
    (provider) => provider.id,
    "provider",
  )
  collectScopedCollisions(
    (setup) => setup.promptSections,
    (section) => section.id,
    "prompt section",
  )

  return failures
}

export const validateLoadedExtensions = (
  extensions: ReadonlyArray<LoadedExtension>,
): Effect.Effect<ExtensionActivationResult> =>
  Effect.sync(() => {
    const failures = collectValidationFailures(extensions)
    if (failures.size === 0) return { active: [...extensions], failed: [] }

    const active: LoadedExtension[] = []
    const failed: FailedExtension[] = []
    for (const ext of extensions) {
      const failure = failures.get(extensionKey(ext))
      if (failure === undefined) {
        active.push(ext)
        continue
      }
      failed.push(toFailedExtension(ext, "validation", failure.errors.join("; ")))
    }
    return { active, failed }
  })

export const activateLoadedExtensions = (
  extensions: ReadonlyArray<LoadedExtension>,
): Effect.Effect<ExtensionActivationResult, never, Scope.Scope> =>
  Effect.gen(function* () {
    const active: LoadedExtension[] = []
    const failed: FailedExtension[] = []

    for (const ext of extensions) {
      if (ext.setup.onStartup !== undefined) {
        const exit = yield* ext.setup.onStartup.pipe(Effect.exit)
        if (exit._tag === "Failure") {
          const error = formatFailure(Cause.squash(exit.cause))
          failed.push(toFailedExtension(ext, "startup", error))
          continue
        }
      }

      if (ext.setup.onShutdown !== undefined) {
        const shutdown = ext.setup.onShutdown
        yield* Effect.addFinalizer(() => shutdown.pipe(Effect.catchCause(() => Effect.void)))
      }

      active.push(ext)
    }

    return { active, failed }
  })

const groupScheduledJobFailures = (
  failures: ReadonlyArray<SchedulerFailure>,
): ReadonlyMap<string, ReadonlyArray<{ jobId: string; error: string }>> => {
  const byExtension = new Map<string, Array<{ jobId: string; error: string }>>()
  for (const failure of failures) {
    const existing = byExtension.get(failure.extensionId) ?? []
    existing.push({ jobId: failure.jobId, error: failure.error })
    byExtension.set(failure.extensionId, existing)
  }
  return byExtension
}

export const reconcileLoadedExtensions = (params: {
  readonly extensions: ReadonlyArray<LoadedExtension>
  readonly failedExtensions?: ReadonlyArray<FailedExtension>
  readonly home: string
  readonly command: ScheduledJobCommand | undefined
  readonly env?: Readonly<Record<string, string>>
  readonly schedulerRuntime?: Parameters<typeof reconcileScheduledJobs>[0]["runtime"]
}): Effect.Effect<
  ExtensionReconciliationResult,
  never,
  Scope.Scope | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const validated = yield* validateLoadedExtensions(params.extensions)
    const activated = yield* activateLoadedExtensions(validated.active)
    const scheduledJobFailures = yield* reconcileScheduledJobs({
      extensions: activated.active,
      home: params.home,
      command: params.command,
      env: params.env,
      runtime: params.schedulerRuntime,
    })

    const allFailed = [...(params.failedExtensions ?? []), ...validated.failed, ...activated.failed]
    const resolved = resolveExtensions(
      activated.active,
      allFailed,
      groupScheduledJobFailures(scheduledJobFailures),
    )

    const actorCount = activated.active.filter((ext) => ext.setup.actor !== undefined).length
    yield* Effect.logInfo("extension.reconciliation.summary").pipe(
      Effect.annotateLogs({
        active: activated.active.length,
        failed: allFailed.length,
        withActors: actorCount,
        activeIds: activated.active.map((ext) => ext.manifest.id).join(", "),
        actorIds: activated.active
          .filter((ext) => ext.setup.actor !== undefined)
          .map((ext) => ext.manifest.id)
          .join(", "),
        ...(allFailed.length > 0
          ? {
              failedDetails: allFailed
                .map((f) => `${f.manifest.id}(${f.phase}): ${f.error}`)
                .join("; "),
            }
          : {}),
      }),
    )

    return {
      resolved,
      scheduledJobFailures,
    }
  })
