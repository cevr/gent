import { Effect, FileSystem, Option, Path, Predicate, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { GentPlatform } from "../gent-platform.js"
import type { ExtensionScope, GentExtension, LoadedExtension } from "../../domain/extension.js"
import { ExtensionLoadError } from "../../domain/extension.js"
import { ExtensionSetupContext, publicSetupContext } from "../../domain/extension-setup-context.js"
import { ExtensionId } from "../../domain/ids.js"
import type { ExtensionContributions } from "../../domain/contribution.js"
import { sealRuntimeLoadedEffect } from "../../domain/extension-load-boundary.js"
import { validateExtensionPackage } from "../../domain/extension-package-shape.js"
import type { PromptSection } from "../../domain/prompt.js"
import { getToolMetadata } from "../../domain/capability/tool.js"
import { makeExtensionHostPlatform } from "./host-platform.js"
import { isProjectExtensionDirectoryTrusted } from "./project-trust.js"

/** Static prompt sections live on capability leaf `prompt` (folded by the
 *  `tool()` smart constructor or declared directly). Surface them here for
 *  scope collision detection across typed buckets. */
const collectCapabilityPrompts = (cs: ExtensionContributions): ReadonlyArray<PromptSection> =>
  (() => {
    const prompts: Array<Option.Option<PromptSection>> = []
    for (const tool of Option.getOrElse(Option.fromUndefinedOr(cs.tools), () => [])) {
      prompts.push(Option.fromUndefinedOr(getToolMetadata(tool).prompt))
    }
    for (const rpc of Option.getOrElse(Option.fromUndefinedOr(cs.requests), () => [])) {
      prompts.push(Option.fromUndefinedOr(rpc.prompt))
    }
    return prompts.flatMap((prompt) =>
      Option.match(prompt, {
        onNone: () => [],
        onSome: (value) => [value],
      }),
    )
  })()

type ExtensionSetupServices = FileSystem.FileSystem | Path.Path | ChildProcessSpawner | GentPlatform
type LoadedUserExtension = GentExtension<ExtensionSetupServices>

interface LoadSuccess {
  readonly _tag: "Success"
  readonly extension: LoadedUserExtension
}

interface LoadFailure {
  readonly _tag: "Failure"
  readonly error: string
}

// Discovery — scan directories for extension files

const EXTENSION_GLOBS = ["*.ts", "*.js", "*.mjs"]

/** TUI extension files — co-located *.client.{tsx,ts,js,mjs} or client.{tsx,ts,js,mjs} in subdirs */
export const isClientFile = (entry: string): boolean =>
  /\.client\.(?:[tj]sx?|mjs)$/.test(entry) || /^client\.(?:[tj]sx?|mjs)$/.test(entry)

const isExtensionFile = (entry: string): boolean =>
  !isClientFile(entry) &&
  EXTENSION_GLOBS.some((glob) => {
    const ext = glob.slice(1) // ".ts", ".js", ".mjs"
    return entry.endsWith(ext)
  })

/** Discover extension files from a directory. Returns file paths sorted by name. */
const discoverDir = Effect.fn("ExtensionLoader.discoverDir")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const exists = yield* fs.exists(dir)
  if (!exists) return []

  const entries = yield* fs.readDirectory(dir)
  const paths: string[] = []

  for (const entry of entries) {
    // Skip test directories, hidden files, and TUI extension files
    if (entry.startsWith(".") || entry.startsWith("_") || entry === "__tests__") continue
    if (isClientFile(entry)) continue

    const filePath = path.join(dir, entry)
    const stat = yield* fs.stat(filePath)

    if (stat.type === "File" && isExtensionFile(entry)) {
      paths.push(filePath)
    } else if (stat.type === "Directory") {
      // Check for index.ts/index.js in subdirectory
      for (const indexName of ["index.ts", "index.js", "index.mjs"]) {
        const indexPath = path.join(filePath, indexName)
        const indexExists = yield* fs.exists(indexPath)
        if (indexExists) {
          paths.push(indexPath)
          break
        }
      }
    }
  }

  return paths.sort()
})

// Loading — import extension files via Bun native import()

// gent/no-dynamic-imports: allow extension modules are discovered from user/project files at runtime
const importExtensionModule = (filePath: string) => import(filePath)

/** Load a single extension from a file path. */
const loadExtensionFile = Effect.fn("ExtensionLoader.loadExtensionFile")(function* (
  filePath: string,
) {
  const mod = yield* Effect.tryPromise({
    try: () => importExtensionModule(filePath),
    catch: (err) =>
      new ExtensionLoadError({
        extensionId: ExtensionId.make("unknown"),
        message: `Failed to import ${filePath}: ${String(err)}`,
        cause: err,
      }),
  })

  // Find the extension — check default export, then named exports
  const candidates: LoadedUserExtension[] = []
  const seen = new Set<unknown>()

  if (!Predicate.isUndefined(mod["default"])) {
    const resolved = resolveToGentExtension(mod["default"])
    if (Option.isSome(resolved) && !seen.has(resolved.value)) {
      seen.add(resolved.value)
      candidates.push(resolved.value)
    }
  }

  for (const [, value] of Object.entries(mod)) {
    const resolved = resolveToGentExtension(value)
    if (Option.isSome(resolved) && !seen.has(resolved.value)) {
      seen.add(resolved.value)
      candidates.push(resolved.value)
    }
  }

  if (candidates.length === 0) {
    return yield* new ExtensionLoadError({
      extensionId: ExtensionId.make("unknown"),
      message: `No GentExtension found in ${filePath}. Export a defineExtension() result as default or named export.`,
    })
  }

  if (candidates.length > 1) {
    return yield* new ExtensionLoadError({
      extensionId: ExtensionId.make("unknown"),
      message: `Multiple GentExtension exports found in ${filePath}. Export exactly one.`,
    })
  }

  // candidates.length === 1 guaranteed by checks above
  const result = candidates[0]
  if (Predicate.isUndefined(result)) {
    return yield* new ExtensionLoadError({
      extensionId: ExtensionId.make("unknown"),
      message: `No extension in ${filePath}`,
    })
  }
  // Filesystem extensions are not trusted to name their own loaded artifact.
  // A package manifest can stay unchanged while the imported module changes,
  // and Bun can return a cached module after the file changes. Only a build
  // boundary may attach an artifact identity to a trusted builtin.
  const { artifactIdentity: _artifactIdentity, ...untrusted } = result
  return untrusted
})

const GentExtensionContract = Schema.Struct({
  manifest: Schema.Struct({ id: Schema.String }),
  setup: Schema.Unknown,
})
const decodeGentExtensionContract = Schema.decodeUnknownOption(GentExtensionContract)

/** Type guard for GentExtension shape */
// oxlint-disable-next-line effect/noUnknownParameters -- Runtime module exports enter as untyped values.
const isGentExtension = (value: unknown): value is LoadedUserExtension => {
  const decoded = decodeGentExtensionContract(value)
  return Option.isSome(decoded) && Effect.isEffect(decoded.value.setup)
}

/** Extract GentExtension from a module export. Paired-package wrapping is gone;
 *  only raw `GentExtension` values are valid now. */
// oxlint-disable-next-line effect/noUnknownParameters -- Runtime module exports enter as untyped values.
const resolveToGentExtension = (value: unknown): Option.Option<LoadedUserExtension> => {
  if (isGentExtension(value)) return Option.some(value)
  return Option.none()
}

// Full discovery + loading pipeline

export interface DiscoveredExtension {
  readonly extension: LoadedUserExtension
  readonly scope: Exclude<ExtensionScope, "builtin">
  readonly sourcePath: string
}

export interface DiscoveredBuiltinExtension {
  readonly extension: LoadedUserExtension
  readonly scope: "builtin"
  readonly sourcePath: string
}

export interface SkippedExtension {
  readonly path: string
  readonly scope: ExtensionScope
  readonly error: string
}

export interface DiscoveryResult {
  readonly loaded: ReadonlyArray<DiscoveredExtension>
  readonly skipped: ReadonlyArray<SkippedExtension>
}

/** Discover and load extensions from all configured directories. Per-file isolation — one broken file does not suppress siblings. */
export const discoverExtensions = Effect.fn("ExtensionLoader.discoverExtensions")(function* (opts: {
  readonly userDir: string // ~/.gent/extensions
  readonly projectDir: string // .gent/extensions
}) {
  const userPaths = yield* discoverDir(opts.userDir)
  const projectPaths = yield* discoverDir(opts.projectDir)
  const projectTrusted = yield* isProjectExtensionDirectoryTrusted(opts)

  const loaded: DiscoveredExtension[] = []
  const skipped: SkippedExtension[] = []

  for (const filePath of userPaths) {
    const result = yield* loadExtensionFile(filePath).pipe(
      Effect.map((extension) => ({ _tag: "Success", extension }) satisfies LoadSuccess),
      Effect.catchEager((error) =>
        Effect.succeed({ _tag: "Failure", error: error.message } satisfies LoadFailure),
      ),
    )
    if (result._tag === "Success") {
      loaded.push({ extension: result.extension, scope: "user", sourcePath: filePath })
    } else {
      skipped.push({ path: filePath, scope: "user", error: result.error })
      yield* Effect.logWarning("extension.load.skipped").pipe(
        Effect.annotateLogs({ path: filePath, scope: "user", error: result.error }),
      )
    }
  }

  for (const filePath of projectPaths) {
    if (!projectTrusted) {
      const error =
        "Project code is not trusted. Add its canonical root to trustedProjects in the user config."
      skipped.push({ path: filePath, scope: "project", error })
      yield* Effect.logWarning("extension.load.untrusted").pipe(
        Effect.annotateLogs({ path: filePath, error }),
      )
      continue
    }
    const result = yield* loadExtensionFile(filePath).pipe(
      Effect.map((extension) => ({ _tag: "Success", extension }) satisfies LoadSuccess),
      Effect.catchEager((error) =>
        Effect.succeed({ _tag: "Failure", error: error.message } satisfies LoadFailure),
      ),
    )
    if (result._tag === "Success") {
      loaded.push({ extension: result.extension, scope: "project", sourcePath: filePath })
    } else {
      skipped.push({ path: filePath, scope: "project", error: result.error })
      yield* Effect.logWarning("extension.load.skipped").pipe(
        Effect.annotateLogs({ path: filePath, scope: "project", error: result.error }),
      )
    }
  }

  return { loaded, skipped }
})

/** Run extension setup and produce LoadedExtension. Catches defects from malformed setup functions. */
export const setupExtension = Effect.fn("ExtensionLoader.setupExtension")(function* (
  discovered: DiscoveredExtension | DiscoveredBuiltinExtension,
  cwd: string,
  home: string,
) {
  const host = yield* makeExtensionHostPlatform
  const publicCtx = publicSetupContext({
    cwd,
    source: discovered.sourcePath,
    home,
    host,
  })
  const setupEffect = discovered.extension.setup.pipe(
    Effect.provideService(ExtensionSetupContext, publicCtx),
  )
  const contributions: ExtensionContributions = yield* sealRuntimeLoadedEffect({
    extensionId: discovered.extension.manifest.id,
    effect: () => setupEffect,
    failureMessage: (cause) => `Extension setup failed: ${String(cause)}`,
    defectMessage: (cause) => `Extension setup defect: ${String(cause)}`,
  })

  // Defensive re-run of cross-bucket validation. `defineExtension`-wrapped
  // setups already run this; raw `{ manifest, setup }` objects (e.g. tests,
  // hand-rolled extensions) bypass it. Running here closes the install
  // boundary — malformed contributions fail activation, not mid-dispatch.
  yield* validateExtensionPackage(discovered.extension.manifest, contributions)

  let loaded: LoadedExtension = {
    manifest: discovered.extension.manifest,
    scope: discovered.scope,
    sourcePath: discovered.sourcePath,
    contributions,
  }
  if (!Predicate.isUndefined(discovered.extension.artifactIdentity)) {
    loaded = { ...loaded, artifactIdentity: discovered.extension.artifactIdentity }
  }
  return loaded
})

/** Check same-scope collision for a keyed bucket. */
const checkScopedCollision = <T>(
  extensions: ReadonlyArray<LoadedExtension>,
  pickItems: (contribs: ExtensionContributions) => ReadonlyArray<T>,
  getKey: (item: T) => string,
  label: string,
): Option.Option<ExtensionLoadError> => {
  const byScope = new Map<string, Map<string, string>>()
  for (const ext of extensions) {
    const items = pickItems(ext.contributions)
    const scope = ext.scope
    const scopeMap = byScope.get(scope) ?? new Map<string, string>()
    for (const item of items) {
      const key = getKey(item)
      const existing = scopeMap.get(key)
      if (!Predicate.isUndefined(existing) && existing !== ext.manifest.id) {
        return Option.some(
          new ExtensionLoadError({
            extensionId: ext.manifest.id,
            message: `Ambiguous ${label} "${key}" — provided by both "${existing}" and "${ext.manifest.id}" in scope "${scope}"`,
          }),
        )
      }
      scopeMap.set(key, ext.manifest.id)
    }
    byScope.set(scope, scopeMap)
  }
  return Option.none()
}

/** Validate a set of loaded extensions for conflicts. */
export const validateExtensions = Effect.fn("ExtensionLoader.validateExtensions")(function* (
  extensions: ReadonlyArray<LoadedExtension>,
) {
  // Check duplicate manifest ids within same scope
  const idsByScope = new Map<string, Set<string>>()
  for (const ext of extensions) {
    const ids = idsByScope.get(ext.scope) ?? new Set()
    if (ids.has(ext.manifest.id)) {
      return yield* new ExtensionLoadError({
        extensionId: ext.manifest.id,
        message: `Duplicate extension id "${ext.manifest.id}" in scope "${ext.scope}"`,
      })
    }
    ids.add(ext.manifest.id)
    idsByScope.set(ext.scope, ids)
  }

  // Check keyed contributions — same key in same scope from different extensions is ambiguous.
  // Tool collisions are caught by
  // `collectScopedCollisions(extractModelToolIdentities, …)` in `activation.ts`.
  const checks = [
    checkScopedCollision(
      extensions,
      (cs) => Option.getOrElse(Option.fromUndefinedOr(cs.agents), () => []),
      (a) => a.name,
      "agent",
    ),
    checkScopedCollision(
      extensions,
      (cs) => Option.getOrElse(Option.fromUndefinedOr(cs.modelDrivers), () => []),
      (d) => d.id,
      "model driver",
    ),
    checkScopedCollision(
      extensions,
      (cs) => Option.getOrElse(Option.fromUndefinedOr(cs.externalDrivers), () => []),
      (d) => d.id,
      "external driver",
    ),
    checkScopedCollision(extensions, collectCapabilityPrompts, (p) => p.id, "prompt section"),
  ]
  for (const error of checks) {
    if (Option.isSome(error)) return yield* error.value
  }
})
