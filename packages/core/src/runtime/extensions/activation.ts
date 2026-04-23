import { Cause, Effect } from "effect"
import type { FileSystem, Path, Scope } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type {
  FailedExtension,
  FailedExtensionPhase,
  GentExtension,
  LoadedExtension,
} from "../../domain/extension.js"
import type { ExtensionContributions } from "../../domain/contribution.js"
import type { PromptSection } from "../../domain/prompt.js"

const hasMachine = (contribs: ExtensionContributions): boolean =>
  (contribs.resources ?? []).some((r) => r.machine !== undefined)

const modelToolCount = (contribs: ExtensionContributions): number =>
  (contribs.capabilities ?? []).filter((c) => c.audiences.includes("model")).length
import { resolveExtensions, type ResolvedExtensions } from "./registry.js"
import type { DiscoveredExtension } from "./loader.js"
import { setupExtension } from "./loader.js"
import {
  reconcileScheduledJobs,
  type ScheduledJobCommand,
  type SchedulerFailure,
} from "./resource-host/schedule-engine.js"

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
    scope: LoadedExtension["scope"]
    sourcePath: string
  },
  phase: FailedExtensionPhase,
  error: string,
): FailedExtension => ({
  manifest: ext.manifest,
  scope: ext.scope,
  sourcePath: ext.sourcePath,
  phase,
  error,
})

const formatFailure = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { readonly message: unknown }).message)
    : String(error)

export const setupBuiltinExtensions = (params: {
  readonly extensions: ReadonlyArray<GentExtension>
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
      const extension = input
      if (params.disabled.has(extension.manifest.id)) {
        yield* Effect.logDebug("extension.setup.skipped.disabled").pipe(
          Effect.annotateLogs({ extensionId: extension.manifest.id, scope: "builtin" }),
        )
        continue
      }

      const discovered = {
        extension,
        scope: "builtin" as const,
        sourcePath: "builtin",
      }

      const exit = yield* setupExtension(discovered, params.cwd, params.home).pipe(Effect.exit)
      if (exit._tag === "Success") {
        active.push(exit.value)
        yield* Effect.logDebug("extension.setup.ok").pipe(
          Effect.annotateLogs({
            extensionId: extension.manifest.id,
            scope: "builtin",
            hasMachine: hasMachine(exit.value.contributions),
            tools: modelToolCount(exit.value.contributions),
          }),
        )
      } else {
        const error = formatFailure(Cause.squash(exit.cause))
        failed.push(
          toFailedExtension(
            { manifest: extension.manifest, scope: "builtin", sourcePath: "builtin" },
            "setup",
            error,
          ),
        )
        yield* Effect.logWarning("extension.setup.failed").pipe(
          Effect.annotateLogs({
            extensionId: extension.manifest.id,
            scope: "builtin",
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
            scope: discovered.scope,
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
            scope: discovered.scope,
            hasMachine: hasMachine(exit.value.contributions),
            tools: modelToolCount(exit.value.contributions),
          }),
        )
      } else {
        const error = formatFailure(Cause.squash(exit.cause))
        failed.push(
          toFailedExtension(
            {
              manifest: discovered.extension.manifest,
              scope: discovered.scope,
              sourcePath: discovered.sourcePath,
            },
            "setup",
            error,
          ),
        )
        yield* Effect.logWarning("extension.setup.failed").pipe(
          Effect.annotateLogs({
            extensionId: discovered.extension.manifest.id,
            scope: discovered.scope,
            sourcePath: discovered.sourcePath,
            error,
          }),
        )
      }
    }

    return { active, failed }
  })

const extensionKey = (ext: Pick<LoadedExtension, "scope" | "manifest" | "sourcePath">) =>
  `${ext.scope}:${ext.manifest.id}:${ext.sourcePath}`

const formatConflicts = (
  label: string,
  scope: LoadedExtension["scope"],
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

  const idsByScope = new Map<LoadedExtension["scope"], Map<string, LoadedExtension[]>>()
  for (const ext of extensions) {
    const scopeMap = idsByScope.get(ext.scope) ?? new Map<string, LoadedExtension[]>()
    const sameId = scopeMap.get(ext.manifest.id) ?? []
    sameId.push(ext)
    scopeMap.set(ext.manifest.id, sameId)
    idsByScope.set(ext.scope, scopeMap)
  }
  for (const [scope, scopeMap] of idsByScope) {
    for (const [id, sameId] of scopeMap) {
      if (sameId.length <= 1) continue
      const error = `Duplicate extension id "${id}" in scope "${scope}"`
      for (const ext of sameId) addFailure(ext, error)
    }
  }

  const collectScopedCollisions = <T>(
    pickItems: (contribs: ExtensionContributions) => ReadonlyArray<T>,
    getKey: (item: T) => string,
    label: string,
  ) => {
    const byScope = new Map<LoadedExtension["scope"], Map<string, LoadedExtension[]>>()
    for (const ext of extensions) {
      const scopeMap = byScope.get(ext.scope) ?? new Map<string, LoadedExtension[]>()
      const seen = new Set<string>()
      for (const item of pickItems(ext.contributions)) {
        const key = getKey(item)
        if (seen.has(key)) continue
        seen.add(key)
        const existing = scopeMap.get(key) ?? []
        existing.push(ext)
        scopeMap.set(key, existing)
      }
      byScope.set(ext.scope, scopeMap)
    }

    for (const [scope, scopeMap] of byScope) {
      for (const [key, sameKey] of scopeMap) {
        if (sameKey.length <= 1) continue
        const error = formatConflicts(label, scope, key, sameKey)
        for (const ext of sameKey) addFailure(ext, error)
      }
    }
  }

  // Tool collisions: same-scope same-id model-audience capabilities.
  collectScopedCollisions(
    (cs) => (cs.capabilities ?? []).filter((cap) => cap.audiences.includes("model")),
    (cap) => cap.id,
    "tool",
  )
  collectScopedCollisions(
    (cs) => cs.agents ?? [],
    (agent) => agent.name,
    "agent",
  )
  collectScopedCollisions(
    (cs) => cs.modelDrivers ?? [],
    (driver) => driver.id,
    "model driver",
  )
  collectScopedCollisions(
    (cs) => cs.externalDrivers ?? [],
    (driver) => driver.id,
    "external driver",
  )
  // Static prompt sections live on `Capability.prompt`. Collision check
  // mirrors the legacy promptSection contribution's id-keyed dedup.
  collectScopedCollisions(
    (cs) =>
      (cs.capabilities ?? [])
        .map((c) => c.prompt)
        .filter((p): p is PromptSection => p !== undefined),
    (section) => section.id,
    "prompt section",
  )

  // Model-audience capabilities MUST declare a non-empty description — the
  // string is sent to the LLM as part of the tool schema, so empty/missing
  // becomes "why is the model dumb?" rot later. Codex ADVISORY on C4.4a.
  for (const ext of extensions) {
    for (const cap of ext.contributions.capabilities ?? []) {
      if (!cap.audiences.includes("model")) continue
      const trimmed = (cap.description ?? "").trim()
      if (trimmed.length === 0) {
        addFailure(
          ext,
          `Capability "${cap.id}" with audiences:["model"] is missing a non-empty description (the LLM tool schema requires one).`,
        )
      }
    }
  }

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
    // Lifecycle is structural: `Resource.start`/`stop` are woven into each
    // Resource's layer by `withLifecycle` in `resource-host/index.ts`, so
    // activation is identity over `validated.active`.
    const activated: ExtensionActivationResult = { active: [...validated.active], failed: [] }
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

    const machineCount = activated.active.filter((ext) => hasMachine(ext.contributions)).length
    yield* Effect.logInfo("extension.reconciliation.summary").pipe(
      Effect.annotateLogs({
        active: activated.active.length,
        failed: allFailed.length,
        withMachines: machineCount,
        activeIds: activated.active.map((ext) => ext.manifest.id).join(", "),
        machineIds: activated.active
          .filter((ext) => hasMachine(ext.contributions))
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
