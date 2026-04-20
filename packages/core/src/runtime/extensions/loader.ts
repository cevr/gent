import type { PlatformError } from "effect"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { ExtensionKind, GentExtension, LoadedExtension } from "../../domain/extension.js"
import { ExtensionLoadError } from "../../domain/extension.js"
import type { ExtensionContributions } from "../../domain/contribution.js"
import type { PromptSection } from "../../domain/prompt.js"

/** Static prompt sections live on `Capability.prompt` (folded by the
 *  `tool()` smart constructor or declared directly). Surface them here for
 *  scope collision detection — same shape, same precedence rules as the
 *  legacy promptSection contribution. */
const collectCapabilityPrompts = (cs: ExtensionContributions): ReadonlyArray<PromptSection> =>
  (cs.capabilities ?? []).map((c) => c.prompt).filter((p): p is PromptSection => p !== undefined)

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
const discoverDir = (
  dir: string,
): Effect.Effect<
  ReadonlyArray<string>,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
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
  }).pipe(Effect.withSpan("ExtensionLoader.discoverDir"))

// Loading — import extension files via Bun native import()

/** Load a single extension from a file path. */
const loadExtensionFile = (filePath: string): Effect.Effect<GentExtension, ExtensionLoadError> =>
  Effect.gen(function* () {
    const mod = yield* Effect.tryPromise({
      try: () => import(filePath),
      catch: (err) =>
        new ExtensionLoadError({
          extensionId: "unknown",
          message: `Failed to import ${filePath}: ${String(err)}`,
          cause: err,
        }),
    })

    // Find the extension — check default export, then named exports
    const candidates: GentExtension[] = []
    const seen = new Set<unknown>()

    if (mod.default !== undefined) {
      const resolved = resolveToGentExtension(mod.default)
      if (resolved !== undefined && !seen.has(resolved)) {
        seen.add(resolved)
        candidates.push(resolved)
      }
    }

    for (const [, value] of Object.entries(mod)) {
      const resolved = resolveToGentExtension(value)
      if (resolved !== undefined && !seen.has(resolved)) {
        seen.add(resolved)
        candidates.push(resolved)
      }
    }

    if (candidates.length === 0) {
      return yield* new ExtensionLoadError({
        extensionId: "unknown",
        message: `No GentExtension found in ${filePath}. Export a defineExtension() result as default or named export.`,
      })
    }

    if (candidates.length > 1) {
      return yield* new ExtensionLoadError({
        extensionId: "unknown",
        message: `Multiple GentExtension exports found in ${filePath}. Export exactly one.`,
      })
    }

    // candidates.length === 1 guaranteed by checks above
    const result = candidates[0]
    if (result === undefined) {
      return yield* new ExtensionLoadError({
        extensionId: "unknown",
        message: `No extension in ${filePath}`,
      })
    }
    return result
  }).pipe(Effect.withSpan("ExtensionLoader.loadExtensionFile"))

/** Type guard for GentExtension shape */
const isGentExtension = (value: unknown): value is GentExtension => {
  if (typeof value !== "object" || value === null) return false
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const obj = value as Record<string, unknown>
  if (!("manifest" in obj) || typeof obj["manifest"] !== "object" || obj["manifest"] === null)
    return false
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const manifest = obj["manifest"] as Record<string, unknown>
  if (!("id" in manifest) || typeof manifest["id"] !== "string") return false
  if (!("setup" in obj) || typeof obj["setup"] !== "function") return false
  return true
}

/** Extract GentExtension from a module export. Paired-package wrapping
 *  is gone (B11.6); only raw `GentExtension` values are valid now. */
const resolveToGentExtension = (value: unknown): GentExtension | undefined => {
  if (isGentExtension(value)) return value
  return undefined
}

// Full discovery + loading pipeline

export interface DiscoveredExtension {
  readonly extension: GentExtension
  readonly kind: ExtensionKind
  readonly sourcePath: string
}

export interface SkippedExtension {
  readonly path: string
  readonly kind: ExtensionKind
  readonly error: string
}

export interface DiscoveryResult {
  readonly loaded: ReadonlyArray<DiscoveredExtension>
  readonly skipped: ReadonlyArray<SkippedExtension>
}

/** Discover and load extensions from all configured directories. Per-file isolation — one broken file does not suppress siblings. */
export const discoverExtensions = (opts: {
  readonly userDir: string // ~/.gent/extensions
  readonly projectDir: string // .gent/extensions
}): Effect.Effect<
  DiscoveryResult,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const userPaths = yield* discoverDir(opts.userDir)
    const projectPaths = yield* discoverDir(opts.projectDir)

    const loaded: DiscoveredExtension[] = []
    const skipped: SkippedExtension[] = []

    for (const filePath of userPaths) {
      const result = yield* loadExtensionFile(filePath).pipe(
        Effect.map((ext) => ({ ok: true as const, ext })),
        Effect.catchEager((error) => Effect.succeed({ ok: false as const, error: error.message })),
      )
      if (result.ok) {
        loaded.push({ extension: result.ext, kind: "user", sourcePath: filePath })
      } else {
        skipped.push({ path: filePath, kind: "user", error: result.error })
        yield* Effect.logWarning("extension.load.skipped").pipe(
          Effect.annotateLogs({ path: filePath, kind: "user", error: result.error }),
        )
      }
    }

    for (const filePath of projectPaths) {
      const result = yield* loadExtensionFile(filePath).pipe(
        Effect.map((ext) => ({ ok: true as const, ext })),
        Effect.catchEager((error) => Effect.succeed({ ok: false as const, error: error.message })),
      )
      if (result.ok) {
        loaded.push({ extension: result.ext, kind: "project", sourcePath: filePath })
      } else {
        skipped.push({ path: filePath, kind: "project", error: result.error })
        yield* Effect.logWarning("extension.load.skipped").pipe(
          Effect.annotateLogs({ path: filePath, kind: "project", error: result.error }),
        )
      }
    }

    return { loaded, skipped }
  }).pipe(Effect.withSpan("ExtensionLoader.discoverExtensions"))

/** Run extension setup and produce LoadedExtension. Catches defects from malformed setup functions. */
export const setupExtension = (
  discovered: DiscoveredExtension,
  cwd: string,
  home: string,
): Effect.Effect<
  LoadedExtension,
  ExtensionLoadError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const { extension, kind, sourcePath } = discovered
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner
    const contributions: ExtensionContributions = yield* extension
      .setup({
        cwd,
        source: sourcePath,
        home,
        fs,
        path,
        spawner,
      })
      .pipe(
        Effect.catchDefect((defect) =>
          Effect.fail(
            new ExtensionLoadError({
              extensionId: extension.manifest.id,
              message: `Extension setup threw: ${String(defect)}`,
              cause: defect,
            }),
          ),
        ),
      )

    return {
      manifest: extension.manifest,
      kind,
      sourcePath,
      contributions,
    }
  }).pipe(Effect.withSpan("ExtensionLoader.setupExtension"))

/** Check same-scope collision for a keyed bucket. Returns error or undefined. */
const checkScopedCollision = <T>(
  extensions: ReadonlyArray<LoadedExtension>,
  pickItems: (contribs: ExtensionContributions) => ReadonlyArray<T>,
  getKey: (item: T) => string,
  label: string,
): ExtensionLoadError | undefined => {
  const byScope = new Map<string, Map<string, string>>()
  for (const ext of extensions) {
    const items = pickItems(ext.contributions)
    const scope = ext.kind
    const scopeMap = byScope.get(scope) ?? new Map<string, string>()
    for (const item of items) {
      const key = getKey(item)
      const existing = scopeMap.get(key)
      if (existing !== undefined && existing !== ext.manifest.id) {
        return new ExtensionLoadError({
          extensionId: ext.manifest.id,
          message: `Ambiguous ${label} "${key}" — provided by both "${existing}" and "${ext.manifest.id}" in scope "${scope}"`,
        })
      }
      scopeMap.set(key, ext.manifest.id)
    }
    byScope.set(scope, scopeMap)
  }
  return undefined
}

/** Validate a set of loaded extensions for conflicts. */
export const validateExtensions = (
  extensions: ReadonlyArray<LoadedExtension>,
): Effect.Effect<void, ExtensionLoadError> =>
  Effect.gen(function* () {
    // Check duplicate manifest ids within same scope
    const idsByScope = new Map<string, Set<string>>()
    for (const ext of extensions) {
      const ids = idsByScope.get(ext.kind) ?? new Set()
      if (ids.has(ext.manifest.id)) {
        return yield* new ExtensionLoadError({
          extensionId: ext.manifest.id,
          message: `Duplicate extension id "${ext.manifest.id}" in scope "${ext.kind}"`,
        })
      }
      ids.add(ext.manifest.id)
      idsByScope.set(ext.kind, ids)
    }

    // Check keyed contributions — same key in same scope from different extensions is ambiguous.
    // Tool collisions (now `Capability(audiences:["model"])`) are caught by
    // `collectScopedCollisions(extractModelToolIdentities, …)` in `activation.ts`.
    const checks = [
      checkScopedCollision(
        extensions,
        (cs) => cs.agents ?? [],
        (a) => a.name,
        "agent",
      ),
      checkScopedCollision(
        extensions,
        (cs) => cs.modelDrivers ?? [],
        (d) => d.id,
        "model driver",
      ),
      checkScopedCollision(
        extensions,
        (cs) => cs.externalDrivers ?? [],
        (d) => d.id,
        "external driver",
      ),
      checkScopedCollision(extensions, collectCapabilityPrompts, (p) => p.id, "prompt section"),
    ]
    for (const error of checks) {
      if (error !== undefined) return yield* error
    }
  }).pipe(Effect.withSpan("ExtensionLoader.validateExtensions"))
