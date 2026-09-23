import {
  Context,
  Effect,
  FileSystem,
  HashMap,
  Layer,
  Option,
  Path,
  Result,
  Schema,
  type Scope,
  TxRef,
} from "effect"
import picomatch from "picomatch"
import { type FileItem, FileFinder as NativeFileFinder } from "@ff-labs/fff-bun"
import {
  defineExtension,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  tool,
} from "@gent/core/extensions/api"

// ── file index ──────────────────────────────────────────────────────────────

/**
 * Indexed file discovery for the grep tool.
 *
 * Native-first (`@ff-labs/fff-bun`, per-cwd cached finders) with a
 * `.gitignore`-aware FileSystem walk as the per-call fallback. The layer
 * always succeeds: a missing native module or a per-call native failure
 * degrades to the walk.
 */

interface IndexedFile {
  readonly path: string
  readonly relativePath: string
  readonly fileName: string
  readonly size: number
  readonly modifiedMs: number
}

export class FileIndexError extends Schema.TaggedError<FileIndexError>()("FileIndexError", {
  message: Schema.String,
  cwd: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

interface FileIndexService {
  /** List all indexed files for a directory. */
  readonly listFiles: (params: {
    readonly cwd: string
  }) => Effect.Effect<ReadonlyArray<IndexedFile>, FileIndexError>
}

export class FileIndex extends Context.Service<FileIndex, FileIndexService>()(
  "@gent/extensions/src/fs-tools/FileIndex",
) {}

// ── Fallback: FileSystem walk with .gitignore filtering ──

type PathMatcher = (path: string) => boolean

type GitignoreCacheRef = TxRef.TxRef<HashMap.HashMap<string, ReadonlyArray<PathMatcher>>>

const parseGitignorePatterns = (content: string): PathMatcher[] => {
  const patterns: PathMatcher[] = []
  for (const raw of content.split("\n")) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith("#")) continue
    if (line.startsWith("!")) continue

    let pattern = line
    const isDir = pattern.endsWith("/")
    if (isDir) pattern = pattern.slice(0, -1)

    const hasSlash = pattern.includes("/")
    if (pattern.startsWith("/")) pattern = pattern.slice(1)

    if (hasSlash) {
      patterns.push(picomatch(pattern, { dot: true }))
      patterns.push(picomatch(`${pattern}/**`, { dot: true }))
    } else {
      patterns.push(picomatch(pattern, { dot: true }))
      patterns.push(picomatch(`**/${pattern}`, { dot: true }))
      patterns.push(picomatch(`${pattern}/**`, { dot: true }))
      patterns.push(picomatch(`**/${pattern}/**`, { dot: true }))
    }
  }
  return patterns
}

const isGitignored = (path: string, patterns: ReadonlyArray<PathMatcher>): boolean =>
  patterns.some((matches) => matches(path))

const makeFallbackService: Effect.Effect<
  FileIndexService,
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cacheRef: GitignoreCacheRef = yield* TxRef.make(
    HashMap.empty<string, ReadonlyArray<PathMatcher>>(),
  )

  const loadGitignore = (cwd: string): Effect.Effect<ReadonlyArray<PathMatcher>> =>
    Effect.gen(function* () {
      const cache = yield* TxRef.get(cacheRef)
      const cached = HashMap.get(cache, cwd)
      if (cached._tag === "Some") return cached.value

      const patterns = yield* fs.readFileString(path.join(cwd, ".gitignore")).pipe(
        Effect.map(parseGitignorePatterns),
        Effect.orElseSucceed((): ReadonlyArray<PathMatcher> => []),
      )
      yield* TxRef.update(cacheRef, (m) => HashMap.set(m, cwd, patterns))
      return patterns
    })

  const scanAllFiles = (cwd: string): Effect.Effect<ReadonlyArray<IndexedFile>, FileIndexError> =>
    Effect.gen(function* () {
      const ignorePatterns = yield* loadGitignore(cwd)

      const files: IndexedFile[] = []
      const scanDir: (
        absoluteDir: string,
        relativeDir: string,
      ) => Effect.Effect<void, FileIndexError> = (absoluteDir, relativeDir) =>
        Effect.gen(function* () {
          const entries = yield* fs
            .readDirectory(absoluteDir)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new FileIndexError({ message: `directory scan failed: ${cause.message}`, cwd }),
              ),
            )

          for (const entry of entries) {
            let relativePath = relativeDir
            if (relativeDir.length === 0) {
              relativePath = entry
            } else {
              relativePath = `${relativeDir}/${entry}`
            }
            if (isGitignored(relativePath, ignorePatterns)) continue

            const absPath = path.join(absoluteDir, entry)
            const info = yield* fs.stat(absPath).pipe(Effect.option)
            if (info._tag === "None") continue

            if (info.value.type === "Directory") {
              yield* scanDir(absPath, relativePath)
              continue
            }

            if (info.value.type !== "File") continue

            files.push({
              path: absPath,
              relativePath,
              fileName: path.basename(relativePath),
              size: Number(info.value.size),
              modifiedMs: Option.match(info.value.mtime, {
                onNone: () => 0,
                onSome: (d) => d.getTime(),
              }),
            })
          }
        })

      yield* scanDir(cwd, "")

      return files
    })

  return {
    listFiles: (params) =>
      scanAllFiles(params.cwd).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new FileIndexError({
              message: `fallback scan failed: ${e}`,
              cwd: params.cwd,
              cause: e,
            }),
          ),
        ),
      ),
  }
})

export const FallbackFileIndexLive: Layer.Layer<
  FileIndex,
  never,
  FileSystem.FileSystem | Path.Path
> = Layer.effect(FileIndex, makeFallbackService)

// ── Native: fff-bun finders, one per cwd ──

interface FinderEntry {
  finder: NativeFileFinder
  scanned: boolean
}

const SCAN_TIMEOUT_MS = 5000

// The fff-bun library exposes a synchronous `waitForScan(timeoutMs)` that
// blocks until the indexer signals completion (or the timeout elapses).
const waitForScan = (finder: NativeFileFinder): Effect.Effect<boolean> =>
  Effect.promise(() => finder.waitForScan(SCAN_TIMEOUT_MS)).pipe(
    Effect.map((result) => result.ok && result.value),
  )

const makeNativeService = (
  dbDir: string,
): Effect.Effect<FileIndexService, never, Path.Path | Scope.Scope> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const finders = new Map<string, FinderEntry>()
    const frecencyDbPath = path.join(dbDir, "frecency.mdb")
    const historyDbPath = path.join(dbDir, "history.mdb")

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const [, entry] of finders) {
          // Cleanup is best effort. The native module can throw during teardown.
          Result.try(() => entry.finder.destroy())
        }
        finders.clear()
      }),
    )

    const toIndexedFile = (basePath: string, item: FileItem): IndexedFile => ({
      path: path.join(basePath, item.relativePath),
      relativePath: item.relativePath,
      fileName: item.fileName,
      size: item.size,
      modifiedMs: item.modified * 1000,
    })

    const getOrCreate = (cwd: string): Option.Option<FinderEntry> => {
      const existing = Option.fromUndefinedOr(finders.get(cwd))
      if (Option.isSome(existing)) return existing

      const result = NativeFileFinder.create({
        basePath: cwd,
        frecencyDbPath,
        historyDbPath,
        aiMode: true,
      })

      if (!result.ok) return Option.none()

      const entry: FinderEntry = { finder: result.value, scanned: false }
      finders.set(cwd, entry)
      return Option.some(entry)
    }

    return {
      listFiles: (params) =>
        Effect.gen(function* () {
          const entry = getOrCreate(params.cwd)
          if (Option.isNone(entry)) {
            return yield* new FileIndexError({
              message: "failed to create finder",
              cwd: params.cwd,
            })
          }
          const finderEntry = entry.value

          if (!finderEntry.scanned) {
            const completed = yield* waitForScan(finderEntry.finder)
            if (!completed) {
              return yield* new FileIndexError({
                message: "scan timed out",
                cwd: params.cwd,
              })
            }
            finderEntry.scanned = true
          }

          const pageSize = 200
          const allFiles: IndexedFile[] = []
          let pageIndex = 0
          let totalFiles = 0

          while (true) {
            const result = finderEntry.finder.fileSearch("", { pageSize, pageIndex })
            if (!result.ok) {
              return yield* new FileIndexError({
                message: `fileSearch failed: ${result.error}`,
                cwd: params.cwd,
              })
            }

            totalFiles = result.value.totalFiles
            for (const item of result.value.items) {
              allFiles.push(toIndexedFile(params.cwd, item))
            }

            if (allFiles.length >= totalFiles || result.value.items.length < pageSize) break
            pageIndex++
          }

          return allFiles
        }),
    }
  })

/** Wrap a primary service with per-method fallback on FileIndexError. */
const withFallback = (primary: FileIndexService, fallback: FileIndexService): FileIndexService => ({
  listFiles: (params) =>
    primary
      .listFiles(params)
      .pipe(Effect.catchTag("FileIndexError", () => fallback.listFiles(params))),
})

/** Native-first with per-call fallback. Finder databases live under `${home}/.gent/fff`. */
export const FileIndexLive = (options: {
  readonly home: string
}): Layer.Layer<FileIndex, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    FileIndex,
    Effect.gen(function* () {
      const fallback = yield* makeFallbackService
      if (!NativeFileFinder.isAvailable()) return fallback

      const path = yield* Path.Path
      const fs = yield* FileSystem.FileSystem
      const dbDir = path.join(options.home, ".gent", "fff")
      yield* fs.makeDirectory(dbDir, { recursive: true }).pipe(Effect.ignore)
      const native = yield* makeNativeService(dbDir)
      return withFallback(native, fallback)
    }),
  )

// ── read ────────────────────────────────────────────────────────────────────

// Read Tool Error

class ReadError extends Schema.TaggedError<ReadError>()("ReadError", {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Read Tool Params

const ReadParams = Schema.Struct({
  path: Schema.String.annotate({
    description: "Absolute path to file to read",
  }),
  offset: Schema.optionalKey(
    Schema.Finite.annotate({
      description: "Line number to start reading from (1-indexed)",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Finite.annotate({
      description: "Maximum number of lines to read",
    }),
  ),
})

// Read Tool Result

const ReadResult = Schema.Struct({
  content: Schema.String,
  path: Schema.String,
  lineCount: Schema.Finite,
  truncated: Schema.Boolean,
  /** The 1-indexed line to pass as `offset` to continue. Absent when the read reached the end. */
  nextOffset: Schema.optional(Schema.Finite),
})

// Read Tool — authored through the typed `tool(...)` factory, which lowers
// directly to a Capability.

export const ReadTool = tool({
  id: "read",
  readonly: true,
  description:
    "Read file contents. Returns numbered lines. Use offset/limit for large files. A truncated result carries nextOffset — pass it back as offset to continue from the next unread line.",
  promptSnippet: "Read file contents with line numbers",
  params: ReadParams,
  output: ReadResult,
  execute: Effect.fn("ReadTool.execute")(function* (params) {
    const ctx = yield* ExtensionContext
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const filePath = path.resolve(ctx.cwd, params.path)

    // Check if path is a directory
    const stat = yield* fs.stat(filePath).pipe(
      Effect.mapError(
        (e) =>
          new ReadError({
            message: `Path does not exist: ${filePath}`,
            path: filePath,
            cause: e,
          }),
      ),
    )

    if (stat.type === "Directory") {
      return yield* new ReadError({
        message: `Cannot read directory. Use bash ls to list directory contents.`,
        path: filePath,
      })
    }

    const content = yield* fs.readFileString(filePath).pipe(
      Effect.mapError(
        (e) =>
          new ReadError({
            message: `Failed to read file: ${e.message}`,
            path: filePath,
            cause: e,
          }),
      ),
    )

    const lines = content.split("\n")
    const totalLines = lines.length
    const offset = params.offset ?? 1
    const limit = params.limit ?? 2000

    const startIndex = Math.max(0, offset - 1)
    const endIndex = Math.min(lines.length, startIndex + limit)
    const selectedLines = lines.slice(startIndex, endIndex)

    // Format with line numbers
    const maxLineNumWidth = String(endIndex).length
    const numberedContent = selectedLines
      .map((line, i) => {
        const lineNum = String(startIndex + i + 1).padStart(maxLineNumWidth)
        return `${lineNum}\t${line}`
      })
      .join("\n")

    const truncated = endIndex < lines.length

    return {
      content: numberedContent,
      path: filePath,
      lineCount: totalLines,
      truncated,
      // A truncated read names the next unread line so the caller continues
      // without a gap; a complete read leaves the key out entirely.
      ...(truncated && { nextOffset: endIndex + 1 }),
    }
  }),
})

// ── atomic write ────────────────────────────────────────────────────────────

/**
 * Replaces `path` with `content` through a staged sibling. The text lands in a
 * temporary file in the target directory, which is then renamed over the
 * path, so a reader never sees a half-written file. A symlink at `path` is
 * replaced as a directory entry; its target is left untouched.
 */
export const writeFileAtomic = Effect.fn("writeFileAtomic")(function* (
  path: string,
  content: string,
) {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  yield* Effect.scoped(
    Effect.gen(function* () {
      const staging = yield* fs.makeTempFileScoped({
        directory: pathService.dirname(path),
        prefix: ".gent-write-",
      })
      yield* fs.writeFileString(staging, content)
      yield* fs.rename(staging, path)
    }),
  )
})

// ── write ───────────────────────────────────────────────────────────────────

// Write Tool Error

class WriteError extends Schema.TaggedError<WriteError>()("WriteError", {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Write Tool Params

const WriteParams = Schema.Struct({
  atomic: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Write a sibling temporary file, then rename it over the path. Use for saved results. Replaces a symlink itself; does not change the symlink target. Creates a new file inode with temporary-file permissions. Default false keeps normal write behavior.",
    }),
  ),
  path: Schema.String.annotate({
    description: "Absolute path to file to write",
  }),
  content: Schema.String.annotate({
    description: "Content to write to file",
  }),
})

// Write Tool Result

const WriteResult = Schema.Struct({
  path: Schema.String,
  bytesWritten: Schema.Finite,
})

// Write Tool

export const WriteTool = tool({
  id: "write",
  destructive: true,
  description: "Write content to file. Creates directories if needed.",
  promptSnippet: "Create or overwrite files",
  promptGuidelines: ["Read before writing", "Prefer edit for partial changes"],
  params: WriteParams,
  output: WriteResult,
  execute: Effect.fn("WriteTool.execute")(function* (params) {
    const ctx = yield* ExtensionContext
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const filePath = path.resolve(ctx.cwd, params.path)
    const write = Effect.gen(function* () {
      if (params.atomic === true) return yield* writeFileAtomic(filePath, params.content)
      return yield* fs.writeFileString(filePath, params.content)
    })

    return yield* ctx.FileLock.withLock(
      filePath,
      Effect.gen(function* () {
        const dir = path.dirname(filePath)

        // Ensure directory exists
        yield* fs.makeDirectory(dir, { recursive: true }).pipe(
          Effect.mapError(
            (e) =>
              new WriteError({
                message: `Failed to create directory: ${e.message}`,
                path: dir,
                cause: e,
              }),
          ),
        )

        yield* write.pipe(
          Effect.mapError(
            (e) =>
              new WriteError({
                message: `Failed to write file: ${e.message}`,
                path: filePath,
                cause: e,
              }),
          ),
        )

        return {
          path: filePath,
          bytesWritten: Buffer.byteLength(params.content, "utf-8"),
        }
      }),
    )
  }),
})

// ── edit ────────────────────────────────────────────────────────────────────

// Edit Tool Error

class EditError extends Schema.TaggedError<EditError>()("EditError", {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Edit Tool Params

export const EditParams = Schema.Struct({
  path: Schema.String.annotate({
    description: "Absolute path to file to edit",
  }),
  oldString: Schema.String.annotate({
    description: "Exact string to replace",
  }),
  newString: Schema.String.annotate({
    description: "Replacement string",
  }),
  replaceAll: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Replace all occurrences (default: false)",
    }),
  ),
})

// Edit Tool Result

const EditResult = Schema.Struct({
  path: Schema.String,
  replacements: Schema.Finite,
})

// Redaction detection

const REDACTION_PATTERNS = [
  /\[REDACTED\]/i,
  /\[\.\.\.omitted.*?\]/i,
  /\[rest of .{1,40} unchanged\]/i,
  /\[remaining .{1,40} unchanged\]/i,
  /\/\/ \.\.\.( rest| remaining)? (of )?(the )?(file|code|content|implementation)( remains?)? (unchanged|the same|as before|omitted)/i,
  /\/\/ \.\.\. existing (code|content|implementation)/i,
  /# \.\.\. existing (code|content|implementation)/i,
]

export function detectRedaction(oldString: string, newString: string): Option.Option<string> {
  for (const pattern of REDACTION_PATTERNS) {
    if (pattern.test(newString) && !pattern.test(oldString)) {
      const match = Option.fromNullishOr(newString.match(pattern))
      const placeholder = Option.match(match, {
        onNone: () => "redacted content",
        onSome: (parts) => parts[0],
      })
      return Option.some(
        `newString contains redaction placeholder "${placeholder}". Provide the full replacement content — do not abbreviate or omit code.`,
      )
    }
  }
  return Option.none()
}

// 3-tier fuzzy matching

export function unescapeStr(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r").replace(/\\\\/g, "\\")
}

export function normalizeWhitespace(s: string): string {
  return (
    s
      // Trailing whitespace per line
      .replace(/[ \t]+$/gm, "")
      // Unicode quotes → ASCII
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      // Em-dash → hyphen
      .replace(/\u2014/g, "-")
      // NBSP → space
      .replace(/\u00A0/g, " ")
  )
}

type MatchStrategy = "exact" | "unescaped" | "normalized"

interface MatchResult {
  strategy: MatchStrategy
  searchStr: string
  index: number
}

const findNormalizedMatch = (content: string, search: string): Option.Option<MatchResult> => {
  const normalizedContent = normalizeWhitespace(content)
  const normalizedSearch = normalizeWhitespace(search)
  if (normalizedSearch === search && normalizedContent === content) return Option.none()
  if (!normalizedContent.includes(normalizedSearch)) return Option.none()

  const lines = content.split("\n")
  const searchLines = normalizedSearch.split("\n")
  for (let index = 0; index < lines.length; index++) {
    const slice = lines.slice(index, index + searchLines.length)
    if (slice.length !== searchLines.length) continue
    const matchString = slice.join("\n")
    if (normalizeWhitespace(matchString) !== normalizedSearch) continue
    const realIndex = content.indexOf(matchString)
    if (realIndex !== -1) {
      return Option.some({ strategy: "normalized", searchStr: matchString, index: realIndex })
    }
  }
  return Option.none()
}

export function findMatch(content: string, oldString: string): Option.Option<MatchResult> {
  // Tier 1: exact
  const exactIdx = content.indexOf(oldString)
  if (exactIdx !== -1) {
    return Option.some({ strategy: "exact", searchStr: oldString, index: exactIdx })
  }

  // Tier 2: unescape literal \n, \t, \\ in oldString
  const unescaped = unescapeStr(oldString)
  if (unescaped !== oldString) {
    const unescIdx = content.indexOf(unescaped)
    if (unescIdx !== -1) {
      return Option.some({ strategy: "unescaped", searchStr: unescaped, index: unescIdx })
    }
  }

  // Tier 3: normalize whitespace + unicode in both
  return findNormalizedMatch(content, unescaped)
}

// Edit Tool

export const EditTool = tool({
  id: "edit",
  destructive: true,
  description:
    "Edit file by replacing exact string matches. Fails if oldString not found or not unique (unless replaceAll).",
  promptSnippet: "Apply targeted edits to existing files",
  promptGuidelines: ["Use for partial changes, not full rewrites", "old_string must match exactly"],
  params: EditParams,
  output: EditResult,
  execute: Effect.fn("EditTool.execute")(function* (params) {
    const ctx = yield* ExtensionContext
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const filePath = path.resolve(ctx.cwd, params.path)

    // Redaction check
    const redaction = detectRedaction(params.oldString, params.newString)
    if (Option.isSome(redaction)) {
      return yield* new EditError({ message: redaction.value, path: filePath })
    }

    return yield* ctx.FileLock.withLock(
      filePath,
      Effect.gen(function* () {
        const content = yield* fs.readFileString(filePath).pipe(
          Effect.mapError(
            (e) =>
              new EditError({
                message: `Failed to read file: ${e.message}`,
                path: filePath,
                cause: e,
              }),
          ),
        )

        const replaceAll = params.replaceAll === true

        // Try fuzzy match strategy
        const match = findMatch(content, params.oldString)

        if (Option.isNone(match)) {
          return yield* new EditError({
            message: "oldString not found in file",
            path: filePath,
          })
        }

        // Use the resolved search string for occurrence counting
        const searchStr = match.value.searchStr
        const occurrences = content.split(searchStr).length - 1

        if (occurrences > 1 && !replaceAll) {
          return yield* new EditError({
            message: `oldString found ${occurrences} times. Use replaceAll to replace all, or provide more context for unique match.`,
            path: filePath,
          })
        }

        let newContent = content.replace(searchStr, params.newString)
        let replacements = 1
        if (replaceAll) {
          newContent = content.split(searchStr).join(params.newString)
          replacements = occurrences
        }

        yield* fs.writeFileString(filePath, newContent).pipe(
          Effect.mapError(
            (e) =>
              new EditError({
                message: `Failed to write file: ${e.message}`,
                path: filePath,
                cause: e,
              }),
          ),
        )

        return {
          path: filePath,
          replacements,
        }
      }),
    )
  }),
})

// ── grep ────────────────────────────────────────────────────────────────────

// Grep Tool Error

class GrepError extends Schema.TaggedError<GrepError>()("GrepError", {
  message: Schema.String,
  pattern: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Grep Tool Params

const GrepParams = Schema.Struct({
  pattern: Schema.String.annotate({
    description: "Regex pattern to search for",
  }),
  path: Schema.optionalKey(
    Schema.String.annotate({
      description: "File or directory to search (default: cwd)",
    }),
  ),
  glob: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Glob pattern to filter files (e.g., *.ts). A pattern without a slash matches file names at any depth",
    }),
  ),
  caseSensitive: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Case sensitive search (default: true)",
    }),
  ),
  context: Schema.optionalKey(
    Schema.Finite.annotate({
      description: "Lines of context around matches",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Finite.annotate({
      description: "Maximum number of matches (default: 100)",
    }),
  ),
})

// Grep Match

const GrepMatch = Schema.Struct({
  file: Schema.String,
  line: Schema.Finite,
  content: Schema.String,
  context: Schema.optional(
    Schema.Struct({
      before: Schema.Array(Schema.String),
      after: Schema.Array(Schema.String),
    }),
  ),
})

// Grep Tool Result

const GrepResult = Schema.Struct({
  matches: Schema.Array(GrepMatch),
  truncated: Schema.Boolean,
})

// Grep Tool

export const GrepTool = tool({
  id: "grep",
  readonly: true,
  description: "Search file contents with regex. Returns matching lines.",
  promptSnippet: "Search file contents with regex",
  params: GrepParams,
  output: GrepResult,
  execute: Effect.fn("GrepTool.execute")(function* (params) {
    const ctx = yield* ExtensionContext
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const target = Option.fromNullishOr(params.path)
    let basePath = ctx.cwd
    if (Option.isSome(target)) {
      basePath = path.resolve(ctx.cwd, target.value)
    }
    const limit = params.limit ?? 100
    const contextLines = params.context ?? 0
    let flags = "g"
    if (params.caseSensitive === false) {
      flags = "gi"
    }

    const regex = yield* Effect.try({
      try: () => new RegExp(params.pattern, flags),
      catch: (e) =>
        new GrepError({
          message: `Invalid regex: ${e}`,
          pattern: params.pattern,
          cause: e,
        }),
    })

    const matches: Array<{
      file: string
      line: number
      content: string
      context?: { before: string[]; after: string[] }
    }> = []

    const searchFile = (filePath: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const contentResult = yield* fs.readFileString(filePath).pipe(Effect.option)
        if (Option.isNone(contentResult)) return

        const content = contentResult.value
        const lines = content.split("\n")

        for (let i = 0; i < lines.length && matches.length < limit; i++) {
          const line = Option.fromNullishOr(lines[i])
          if (Option.isSome(line) && regex.test(line.value)) {
            const match: (typeof matches)[0] = {
              file: filePath,
              line: i + 1,
              content: line.value,
            }

            if (contextLines > 0) {
              match.context = {
                before: lines.slice(Math.max(0, i - contextLines), i),
                after: lines.slice(i + 1, i + 1 + contextLines),
              }
            }

            matches.push(match)
          }
          // Reset regex lastIndex for next test
          regex.lastIndex = 0
        }
      })

    const baseStat = yield* fs.stat(basePath).pipe(Effect.option)
    if (Option.isNone(baseStat)) {
      return yield* new GrepError({
        message: `Path not found: ${basePath}`,
        pattern: params.pattern,
      })
    }

    if (baseStat.value.type === "File") {
      yield* searchFile(basePath)
    } else {
      const index = yield* FileIndex
      const allFiles = yield* index.listFiles({ cwd: basePath }).pipe(
        Effect.mapError(
          (cause) =>
            new GrepError({
              message: `File index failed: ${cause.message}`,
              pattern: params.pattern,
              cause,
            }),
        ),
      )
      const globPattern = params.glob ?? "**/*"
      const matchesGlob = yield* Effect.try({
        // A slash-free glob (`*.ts`) matches the basename at any depth, as ripgrep's `-g` does;
        // a glob with a slash matches the path relative to the search root.
        try: () => picomatch(globPattern, { dot: true, basename: !globPattern.includes("/") }),
        catch: (e) =>
          new GrepError({
            message: `Invalid glob pattern: ${e}`,
            pattern: params.pattern,
            cause: e,
          }),
      })

      for (const file of allFiles) {
        if (matches.length >= limit) break
        if (!matchesGlob(file.relativePath)) continue
        yield* searchFile(file.path)
      }
    }

    return {
      matches,
      truncated: matches.length >= limit,
    }
  }),
})

// ── extension ───────────────────────────────────────────────────────────────

export const FsToolsExtension = defineExtension({
  id: "@gent/fs-tools",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", ReadTool, WriteTool, EditTool, GrepTool)
    yield* host.register(
      "resource",
      defineResource({
        id: "@gent/fs-tools/file-index",
        scope: "process",
        layer: FileIndexLive({ home: host.home }),
      }),
    )
  }),
})
