import { Cause, Effect, Option, Predicate } from "effect"
import type {
  FailedExtension,
  FailedExtensionPhase,
  LoadedExtension,
  GentExtension,
  ExtensionSetupServices,
  ExtensionLoaderServices,
} from "../../domain/extension.js"
import {
  type ExtensionContributions,
  modelCapabilities,
  rpcCapabilities,
} from "../../domain/contribution.js"
import { getToolMetadata, isToolCapability } from "../../domain/capability/tool.js"
import { hasMessage } from "../../domain/guards.js"
import type { PromptSection } from "../../domain/prompt.js"

const modelToolCount = (contribs: ExtensionContributions): number =>
  modelCapabilities(contribs).length
import type { DiscoveredBuiltinExtension, DiscoveredExtension } from "./loader.js"
import { setupExtension } from "./loader.js"

export interface ExtensionActivationResult {
  readonly active: ReadonlyArray<LoadedExtension>
  readonly failed: ReadonlyArray<FailedExtension>
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

const formatFailure = (error: Parameters<typeof hasMessage>[0]): string => {
  if (hasMessage(error)) return error.message
  return String(error)
}

export const setupBuiltinExtensions = (params: {
  readonly extensions: ReadonlyArray<GentExtension<ExtensionSetupServices>>
  readonly cwd: string
  readonly home: string
  readonly disabled: ReadonlySet<string>
}): Effect.Effect<ExtensionActivationResult, never, ExtensionLoaderServices> =>
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
        scope: "builtin",
        sourcePath: "builtin",
      } satisfies DiscoveredBuiltinExtension

      const exit = yield* setupExtension(discovered, params.cwd, params.home).pipe(Effect.exit)
      if (exit._tag === "Success") {
        active.push(exit.value)
        yield* Effect.logDebug("extension.setup.ok").pipe(
          Effect.annotateLogs({
            extensionId: extension.manifest.id,
            scope: "builtin",
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
}): Effect.Effect<ExtensionActivationResult, never, ExtensionLoaderServices> =>
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

export const extensionKey = (ext: Pick<LoadedExtension, "scope" | "manifest" | "sourcePath">) =>
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

const collectDuplicateExtensionIds = (
  extensions: ReadonlyArray<LoadedExtension>,
  addFailure: (extension: LoadedExtension, error: string) => void,
): void => {
  const idsByScope = new Map<LoadedExtension["scope"], Map<string, LoadedExtension[]>>()
  for (const extension of extensions) {
    const scopeMap = idsByScope.get(extension.scope) ?? new Map<string, LoadedExtension[]>()
    const sameId = scopeMap.get(extension.manifest.id) ?? []
    sameId.push(extension)
    scopeMap.set(extension.manifest.id, sameId)
    idsByScope.set(extension.scope, scopeMap)
  }
  for (const [scope, scopeMap] of idsByScope) {
    for (const [id, sameId] of scopeMap) {
      if (sameId.length <= 1) continue
      const error = `Duplicate extension id "${id}" in scope "${scope}"`
      for (const extension of sameId) addFailure(extension, error)
    }
  }
}

export const collectValidationFailures = (
  extensions: ReadonlyArray<LoadedExtension>,
): ReadonlyMap<string, { ext: LoadedExtension; errors: ReadonlyArray<string> }> => {
  const failures = new Map<string, { ext: LoadedExtension; errors: string[] }>()

  const addFailure = (ext: LoadedExtension, error: string) => {
    const key = extensionKey(ext)
    const current = failures.get(key)
    if (Predicate.isUndefined(current)) {
      failures.set(key, { ext, errors: [error] })
      return
    }
    if (!current.errors.includes(error)) current.errors.push(error)
  }

  collectDuplicateExtensionIds(extensions, addFailure)

  const collectScopedCollisions = <T>(
    pickItems: (contribs: ExtensionContributions) => ReadonlyArray<T>,
    getKey: (item: T) => Option.Option<string>,
    label: string,
  ) => {
    const byScope = new Map<LoadedExtension["scope"], Map<string, LoadedExtension[]>>()
    for (const ext of extensions) {
      const scopeMap = byScope.get(ext.scope) ?? new Map<string, LoadedExtension[]>()
      const seen = new Set<string>()
      for (const item of pickItems(ext.contributions)) {
        const key = getKey(item)
        if (Option.isNone(key)) continue
        if (seen.has(key.value)) continue
        seen.add(key.value)
        const existing = scopeMap.get(key.value) ?? []
        existing.push(ext)
        scopeMap.set(key.value, existing)
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

  // Tool collisions: same-scope same-id model-callable tool leaves.
  collectScopedCollisions(
    (cs) => modelCapabilities(cs),
    (cap) => {
      if (isToolCapability(cap)) {
        return Option.some(getToolMetadata(cap).id)
      }
      return Option.none()
    },
    "tool",
  )
  collectScopedCollisions(
    (cs) => rpcCapabilities(cs),
    (cap) => Option.some(cap.id),
    "rpc",
  )
  collectScopedCollisions(
    (cs) => cs.agents ?? [],
    (agent) => Option.some(agent.name),
    "agent",
  )
  collectScopedCollisions(
    (cs) => cs.modelDrivers ?? [],
    (driver) => Option.some(driver.id),
    "model driver",
  )
  collectScopedCollisions(
    (cs) => cs.externalDrivers ?? [],
    (driver) => Option.some(driver.id),
    "external driver",
  )
  // Static prompt sections live on capability leaf `prompt`. Collision check
  // uses prompt-section id dedup.
  collectScopedCollisions(
    (cs) => {
      const sections: PromptSection[] = []
      for (const tool of cs.tools ?? []) {
        if (!isToolCapability(tool)) continue
        const prompt = Option.fromUndefinedOr(getToolMetadata(tool).prompt)
        if (Option.isSome(prompt)) sections.push(prompt.value)
      }
      for (const rpc of cs.requests ?? []) {
        const prompt = Option.fromUndefinedOr(rpc.prompt)
        if (Option.isSome(prompt)) sections.push(prompt.value)
      }
      return sections
    },
    (section) => Option.some(section.id),
    "prompt section",
  )

  // Model tools MUST declare a non-empty description — the
  // string is sent to the LLM as part of the tool schema, so empty/missing
  // becomes "why is the model dumb?" rot later.
  for (const ext of extensions) {
    for (const cap of modelCapabilities(ext.contributions)) {
      if (!isToolCapability(cap)) {
        addFailure(ext, "Tool must be created with `tool({...})` so Gent metadata is attached.")
        continue
      }
      const metadata = getToolMetadata(cap)
      const trimmed = (cap.description ?? "").trim()
      if (trimmed.length === 0) {
        addFailure(
          ext,
          `Tool "${metadata.id}" is missing a non-empty description (the LLM tool schema requires one).`,
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
      if (Predicate.isUndefined(failure)) {
        active.push(ext)
        continue
      }
      failed.push(toFailedExtension(ext, "validation", failure.errors.join("; ")))
    }
    return { active, failed }
  })
