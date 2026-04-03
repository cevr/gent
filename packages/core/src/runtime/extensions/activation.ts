import { Cause, Effect } from "effect"
import type { Scope } from "effect"
import type {
  FailedExtension,
  FailedExtensionPhase,
  GentExtension,
  LoadedExtension,
} from "../../domain/extension.js"
import { setupExtension } from "./loader.js"

export interface ExtensionActivationResult {
  readonly active: ReadonlyArray<LoadedExtension>
  readonly failed: ReadonlyArray<FailedExtension>
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
  readonly extensions: ReadonlyArray<GentExtension>
  readonly cwd: string
  readonly home: string
  readonly disabled: ReadonlySet<string>
}): Effect.Effect<ExtensionActivationResult> =>
  Effect.gen(function* () {
    const active: LoadedExtension[] = []
    const failed: FailedExtension[] = []

    for (const extension of params.extensions) {
      if (params.disabled.has(extension.manifest.id)) continue

      const discovered = {
        extension,
        kind: "builtin" as const,
        sourcePath: "builtin",
      }

      const exit = yield* setupExtension(discovered, params.cwd, params.home).pipe(Effect.exit)
      if (exit._tag === "Success") {
        active.push(exit.value)
      } else {
        failed.push(
          toFailedExtension(
            { manifest: extension.manifest, kind: "builtin", sourcePath: "builtin" },
            "setup",
            formatFailure(Cause.squash(exit.cause)),
          ),
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
    (setup) => setup.interactionHandlers,
    (handler) => handler.type,
    "interaction handler",
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
