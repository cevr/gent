import type { PlatformError } from "effect"
import { Effect, FileSystem, Path } from "effect"
import type {
  ExtensionKind,
  ExtensionSetup,
  GentExtension,
  LoadedExtension,
} from "../../domain/extension.js"
import { ExtensionLoadError } from "../../domain/extension.js"

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
        new ExtensionLoadError("unknown", `Failed to import ${filePath}: ${String(err)}`, err),
    })

    // Find the extension — check default export, then named exports
    const candidates: GentExtension[] = []
    const seen = new Set<unknown>()

    if (mod.default !== undefined && isGentExtension(mod.default) && !seen.has(mod.default)) {
      seen.add(mod.default)
      candidates.push(mod.default)
    }

    for (const [, value] of Object.entries(mod)) {
      if (isGentExtension(value) && !seen.has(value)) {
        seen.add(value)
        candidates.push(value as GentExtension)
      }
    }

    if (candidates.length === 0) {
      return yield* Effect.fail(
        new ExtensionLoadError(
          "unknown",
          `No GentExtension found in ${filePath}. Export a defineExtension() result as default or named export.`,
        ),
      )
    }

    if (candidates.length > 1) {
      return yield* Effect.fail(
        new ExtensionLoadError(
          "unknown",
          `Multiple GentExtension exports found in ${filePath}. Export exactly one.`,
        ),
      )
    }

    // candidates.length === 1 guaranteed by checks above
    const result = candidates[0]
    if (result === undefined) {
      return yield* Effect.fail(new ExtensionLoadError("unknown", `No extension in ${filePath}`))
    }
    return result
  }).pipe(Effect.withSpan("ExtensionLoader.loadExtensionFile"))

/** Type guard for GentExtension shape */
const isGentExtension = (value: unknown): value is GentExtension => {
  if (typeof value !== "object" || value === null) return false
  const obj = value as Record<string, unknown>
  if (!("manifest" in obj) || typeof obj["manifest"] !== "object" || obj["manifest"] === null)
    return false
  const manifest = obj["manifest"] as Record<string, unknown>
  if (!("id" in manifest) || typeof manifest["id"] !== "string") return false
  if (!("setup" in obj) || typeof obj["setup"] !== "function") return false
  return true
}

// Full discovery + loading pipeline

export interface DiscoveredExtension {
  readonly extension: GentExtension
  readonly kind: ExtensionKind
  readonly sourcePath: string
}

/** Discover and load extensions from all configured directories. */
export const discoverExtensions = (opts: {
  readonly userDir: string // ~/.gent/extensions
  readonly projectDir: string // .gent/extensions
}): Effect.Effect<
  ReadonlyArray<DiscoveredExtension>,
  ExtensionLoadError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const userPaths = yield* discoverDir(opts.userDir)
    const projectPaths = yield* discoverDir(opts.projectDir)

    const results: DiscoveredExtension[] = []

    for (const filePath of userPaths) {
      const ext = yield* loadExtensionFile(filePath)
      results.push({ extension: ext, kind: "user", sourcePath: filePath })
    }

    for (const filePath of projectPaths) {
      const ext = yield* loadExtensionFile(filePath)
      results.push({ extension: ext, kind: "project", sourcePath: filePath })
    }

    return results
  }).pipe(Effect.withSpan("ExtensionLoader.discoverExtensions"))

/** Run extension setup and produce LoadedExtension. Catches defects from malformed setup functions. */
export const setupExtension = (
  discovered: DiscoveredExtension,
  cwd: string,
): Effect.Effect<LoadedExtension, ExtensionLoadError> =>
  Effect.gen(function* () {
    const { extension, kind, sourcePath } = discovered
    const setup: ExtensionSetup = yield* extension
      .setup({
        cwd,
        config: undefined as never, // TODO: config resolution
        source: sourcePath,
      })
      .pipe(
        Effect.catchDefect((defect) =>
          Effect.fail(
            new ExtensionLoadError(
              extension.manifest.id,
              `Extension setup threw: ${String(defect)}`,
              defect,
            ),
          ),
        ),
      )

    return {
      manifest: extension.manifest,
      kind,
      sourcePath,
      setup,
    }
  }).pipe(Effect.withSpan("ExtensionLoader.setupExtension"))

/** Validate a set of loaded extensions for conflicts. */
export const validateExtensions = (
  extensions: ReadonlyArray<LoadedExtension>,
): Effect.Effect<void, ExtensionLoadError> =>
  Effect.gen(function* () {
    // Check duplicate manifest ids within same scope
    const idsByScope = new Map<string, Set<string>>()
    for (const ext of extensions) {
      const key = ext.kind
      const ids = idsByScope.get(key) ?? new Set()
      if (ids.has(ext.manifest.id)) {
        return yield* Effect.fail(
          new ExtensionLoadError(
            ext.manifest.id,
            `Duplicate extension id "${ext.manifest.id}" in scope "${ext.kind}"`,
          ),
        )
      }
      ids.add(ext.manifest.id)
      idsByScope.set(key, ids)
    }

    // Check same-name tool contributions within same scope
    const toolsByScope = new Map<string, Map<string, string>>() // scope -> toolName -> extId
    for (const ext of extensions) {
      const tools = ext.setup.tools ?? []
      const key = ext.kind
      const scopeTools = toolsByScope.get(key) ?? new Map()
      for (const tool of tools) {
        const existing = scopeTools.get(tool.name)
        if (existing !== undefined && existing !== ext.manifest.id) {
          return yield* Effect.fail(
            new ExtensionLoadError(
              ext.manifest.id,
              `Ambiguous tool "${tool.name}" — provided by both "${existing}" and "${ext.manifest.id}" in scope "${ext.kind}"`,
            ),
          )
        }
        scopeTools.set(tool.name, ext.manifest.id)
      }
      toolsByScope.set(key, scopeTools)
    }

    // Check same-name agent contributions within same scope
    const agentsByScope = new Map<string, Map<string, string>>()
    for (const ext of extensions) {
      const agents = ext.setup.agents ?? []
      const key = ext.kind
      const scopeAgents = agentsByScope.get(key) ?? new Map()
      for (const agent of agents) {
        const existing = scopeAgents.get(agent.name)
        if (existing !== undefined && existing !== ext.manifest.id) {
          return yield* Effect.fail(
            new ExtensionLoadError(
              ext.manifest.id,
              `Ambiguous agent "${agent.name}" — provided by both "${existing}" and "${ext.manifest.id}" in scope "${ext.kind}"`,
            ),
          )
        }
        scopeAgents.set(agent.name, ext.manifest.id)
      }
      agentsByScope.set(key, scopeAgents)
    }
  }).pipe(Effect.withSpan("ExtensionLoader.validateExtensions"))
