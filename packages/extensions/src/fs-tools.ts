import {
  Array as Arr,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Schema,
  type Scope,
} from "effect"
import picomatch from "picomatch"
import { FileFinder as NativeFileFinder } from "@ff-labs/fff-bun"
import {
  defineExtension,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  runProcess,
  tool,
  writeFileAtomic,
} from "@gent/core/extensions/api"
import type { ChildProcessSpawner } from "effect/unstable/process"

// ── file index ──────────────────────────────────────────────────────────────

/**
 * Indexed file discovery for the grep tool.
 *
 * Inside a git work tree git decides which files are listed, and the native
 * index (`@ff-labs/fff-bun`, one cached finder per search root) only orders
 * them. Outside a work tree the native index lists, with a `.gitignore`-aware
 * FileSystem walk as the per-call fallback. The layer always succeeds: a
 * missing native module or a per-call native failure degrades to the walk.
 */

interface IndexedFile {
  readonly path: string
  /** Path relative to the listed `cwd`. */
  readonly relativePath: string
}

class FileIndexError extends Schema.TaggedError<FileIndexError>()("FileIndexError", {
  message: Schema.String,
  cwd: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

interface FileIndexService {
  /**
   * List the files under `cwd`. `root` is the search root that owns the
   * cached index (the session cwd, or `cwd` itself); it is `cwd` or an
   * ancestor of it, so every listing under one root shares one index.
   */
  readonly listFiles: (params: {
    readonly root: string
    readonly cwd: string
  }) => Effect.Effect<ReadonlyArray<IndexedFile>, FileIndexError>
}

class FileIndex extends Context.Service<FileIndex, FileIndexService>()(
  "@gent/extensions/src/fs-tools/FileIndex",
) {}

// ── Fallback: FileSystem walk with .gitignore filtering ──

type PathMatcher = (path: string) => boolean

/** The walk stops with an error past this many files; the caller narrows `path`. */
const FALLBACK_MAX_FILES = 100_000

/** One `.gitignore` line. */
interface IgnoreRule {
  /** Directory of the `.gitignore`, relative to the search root ("" for the root). */
  readonly base: string
  readonly matches: PathMatcher
  /** `!pattern` re-includes what an earlier rule ignored. */
  readonly negated: boolean
  /** `pattern/` matches directories only. */
  readonly directoryOnly: boolean
  /** A pattern with a slash matches the path from `base`; one without matches the name at any depth. */
  readonly anchored: boolean
}

/**
 * picomatch with git's wildmatch rules: no brace, extglob or `!` negation
 * syntax, `[!a]` negates a class, and parentheses are literal.
 */
const GIT_GLOB_OPTIONS = { dot: true, nobrace: true, noextglob: true, nonegate: true }

const compileGitGlob = (pattern: string): PathMatcher => {
  const source = pattern.replaceAll("[!", "[^").replaceAll(/(?<!\\)[()]/g, (paren) => `\\${paren}`)
  // A trailing `/**` matches everything inside, never the directory itself.
  if (!source.endsWith("/**")) return picomatch(source, GIT_GLOB_OPTIONS)
  const parent = picomatch(source.slice(0, -3), GIT_GLOB_OPTIONS)
  return (path) => {
    const parts = path.split("/")
    for (let depth = 1; depth < parts.length; depth++) {
      if (parent(parts.slice(0, depth).join("/"))) return true
    }
    return false
  }
}

/**
 * One `.gitignore` file, read by git's rules (gitignore(5)): trailing spaces
 * are trimmed unless escaped, leading spaces are kept, `\#` and `\!` are
 * literal, and a slash anywhere but the end anchors the pattern.
 */
const parseGitignore = (content: string, base: string): Array<IgnoreRule> => {
  const rules: Array<IgnoreRule> = []
  for (const raw of content.split("\n")) {
    let pattern = raw.replace(/\r$/, "").replace(/(?<!\\) +$/, "")
    if (pattern.length === 0 || pattern.startsWith("#")) continue
    const negated = pattern.startsWith("!")
    if (negated) pattern = pattern.slice(1)
    const directoryOnly = pattern.endsWith("/")
    if (directoryOnly) pattern = pattern.slice(0, -1)
    const anchored = pattern.includes("/")
    if (pattern.startsWith("/")) pattern = pattern.slice(1)
    if (pattern.length === 0) continue
    rules.push({ base, matches: compileGitGlob(pattern), negated, directoryOnly, anchored })
  }
  return rules
}

/** Git's rule: the last matching line decides, so a later `!pattern` re-includes. */
const isGitignored = (
  pathFromRoot: string,
  isDirectory: boolean,
  rules: ReadonlyArray<IgnoreRule>,
): boolean => {
  let ignored = false
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) continue
    let relative = pathFromRoot
    if (rule.base.length > 0) {
      if (!pathFromRoot.startsWith(`${rule.base}/`)) continue
      relative = pathFromRoot.slice(rule.base.length + 1)
    }
    let subject = relative
    if (!rule.anchored) subject = relative.slice(relative.lastIndexOf("/") + 1)
    if (rule.matches(subject)) ignored = !rule.negated
  }
  return ignored
}

const joinRelative = (directory: string, entry: string) => {
  if (directory.length === 0) return entry
  return `${directory}/${entry}`
}

/**
 * Outside a git work tree, and for an explicitly named ignored target, the
 * walk matches `.gitignore` lines itself. It reads every `.gitignore` from
 * `root` down, as git does: the ones
 * on the way from `root` to `cwd` and the ones inside the walked tree. A
 * `cwd` inside an ignored directory lists nothing, as the native index does;
 * `listIgnoredTargets` then lists it from its own root.
 */
const makeMatcherWalk: Effect.Effect<FileIndexService, never, FileSystem.FileSystem | Path.Path> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    // Read on every listing: small files, and an edit applies at once.
    const loadRules = (directory: string, base: string): Effect.Effect<Array<IgnoreRule>> =>
      fs.readFileString(path.join(directory, ".gitignore")).pipe(
        Effect.map((content) => parseGitignore(content, base)),
        Effect.orElseSucceed((): Array<IgnoreRule> => []),
      )

    const scanAllFiles = (params: {
      readonly root: string
      readonly cwd: string
    }): Effect.Effect<ReadonlyArray<IndexedFile>, FileIndexError> =>
      Effect.gen(function* () {
        const { cwd } = params
        let root = params.root
        let fromRoot = path.relative(root, cwd)
        if (fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) {
          root = cwd
          fromRoot = ""
        }
        let rules = yield* loadRules(root, "")
        let base = ""
        for (const part of fromRoot.split(path.sep).filter((segment) => segment.length > 0)) {
          base = joinRelative(base, part)
          if (isGitignored(base, true, rules)) return []
          rules = [...rules, ...(yield* loadRules(path.join(root, base), base))]
        }

        const files: IndexedFile[] = []
        // Real paths of the directories already walked: a directory link back
        // into the tree is skipped instead of walked forever.
        const visited = new Set<string>()
        const scanDir: (
          absoluteDir: string,
          relativeDir: string,
          inherited: ReadonlyArray<IgnoreRule>,
        ) => Effect.Effect<void, FileIndexError> = (absoluteDir, relativeDir, inherited) =>
          Effect.gen(function* () {
            const realDir = yield* fs.realPath(absoluteDir).pipe(Effect.option)
            if (Option.isNone(realDir) || visited.has(realDir.value)) return
            visited.add(realDir.value)

            let dirRules = inherited
            if (relativeDir.length > 0) {
              const dirBase = joinRelative(fromRoot, relativeDir)
              dirRules = [...inherited, ...(yield* loadRules(absoluteDir, dirBase))]
            }

            const entries = yield* fs
              .readDirectory(absoluteDir)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new FileIndexError({ message: `directory scan failed: ${cause.message}`, cwd }),
                ),
              )

            for (const entry of entries) {
              if (entry === ".git") continue
              const relativePath = joinRelative(relativeDir, entry)
              const absPath = path.join(absoluteDir, entry)
              const info = yield* fs.stat(absPath).pipe(Effect.option)
              if (Option.isNone(info)) continue
              const isDirectory = info.value.type === "Directory"
              if (isGitignored(joinRelative(fromRoot, relativePath), isDirectory, dirRules))
                continue

              if (isDirectory) {
                yield* scanDir(absPath, relativePath, dirRules)
                continue
              }

              if (info.value.type !== "File") continue

              if (files.length >= FALLBACK_MAX_FILES) {
                return yield* new FileIndexError({
                  message: `more than ${FALLBACK_MAX_FILES} files under ${cwd}; search a narrower path`,
                  cwd,
                })
              }
              files.push({ path: absPath, relativePath })
            }
          })

        yield* scanDir(cwd, "", rules)

        return files
      })

    return {
      listFiles: (params) =>
        scanAllFiles(params).pipe(
          Effect.catchEager((e) =>
            Effect.fail(
              new FileIndexError({
                message: `fallback scan failed: ${e.message}`,
                cwd: params.cwd,
                cause: e,
              }),
            ),
          ),
        ),
    }
  })

// ── Native: fff-bun finders, one per search root ──

interface FinderEntry {
  finder: NativeFileFinder
  scanned: boolean
  /** Listings that hold the finder; an evicted finder is destroyed at zero. */
  users: number
  evicted: boolean
}

const SCAN_TIMEOUT_MS = 5000

/**
 * Each finder holds a watcher; past this many roots the least recently used
 * finder is destroyed.
 */
const MAX_FINDERS = 4

// fff-bun's `waitForScan(timeoutMs)` resolves once the indexer signals
// completion, or with false when the timeout elapses.
const waitForScan = (finder: NativeFileFinder): Effect.Effect<boolean> =>
  Effect.promise(() => finder.waitForScan(SCAN_TIMEOUT_MS)).pipe(
    Effect.map((result) => result.ok && result.value),
  )

const makeNativeService = (
  dbDir: string,
): Effect.Effect<FileIndexService, never, Path.Path | Scope.Scope> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    // Insertion order is recency order: a hit is re-inserted at the end.
    const finders = new Map<string, FinderEntry>()
    const frecencyDbPath = path.join(dbDir, "frecency.mdb")
    const historyDbPath = path.join(dbDir, "history.mdb")

    // Cleanup is best effort. The native module can throw during teardown.
    const destroy = (entry: FinderEntry) => Result.try(() => entry.finder.destroy())

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const [, entry] of finders) evict(entry)
        finders.clear()
      }),
    )

    const evict = (entry: FinderEntry) => {
      entry.evicted = true
      if (entry.users === 0) destroy(entry)
    }

    const getOrCreate = (root: string): Option.Option<FinderEntry> => {
      const existing = Option.fromUndefinedOr(finders.get(root))
      if (Option.isSome(existing)) {
        finders.delete(root)
        finders.set(root, existing.value)
        return existing
      }

      const result = NativeFileFinder.create({
        basePath: root,
        frecencyDbPath,
        historyDbPath,
        aiMode: true,
        // The index only lists paths; grep reads the contents itself.
        disableContentIndexing: true,
        disableMmapCache: true,
      })

      if (!result.ok) return Option.none()

      const entry: FinderEntry = { finder: result.value, scanned: false, users: 0, evicted: false }
      finders.set(root, entry)
      for (const [key, oldest] of finders) {
        if (finders.size <= MAX_FINDERS) break
        finders.delete(key)
        evict(oldest)
      }
      return Option.some(entry)
    }

    /** Hold a root's finder for one listing; eviction waits for the release. */
    const acquireFinder = (params: { readonly root: string; readonly cwd: string }) =>
      Effect.acquireRelease(
        Effect.suspend(() =>
          Option.match(getOrCreate(params.root), {
            onNone: () =>
              Effect.fail(
                new FileIndexError({ message: "failed to create finder", cwd: params.cwd }),
              ),
            onSome: (entry) =>
              Effect.sync(() => {
                entry.users++
                return entry
              }),
          }),
        ),
        (entry) =>
          Effect.sync(() => {
            entry.users--
            if (entry.evicted && entry.users === 0) destroy(entry)
          }),
      )

    const listUnder = (params: {
      readonly root: string
      readonly cwd: string
    }): Effect.Effect<ReadonlyArray<IndexedFile>, FileIndexError> =>
      Effect.gen(function* () {
        const finderEntry = yield* acquireFinder(params)

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

        // Items are relative to the root; keep those under `cwd` and
        // rebase them onto it.
        const subtree = path.relative(params.root, params.cwd)
        let prefix = ""
        if (subtree.length > 0) prefix = `${subtree}/`
        const pageSize = 200
        const allFiles: IndexedFile[] = []
        let pageIndex = 0
        let seen = 0

        while (true) {
          const result = finderEntry.finder.fileSearch("", { pageSize, pageIndex })
          if (!result.ok) {
            return yield* new FileIndexError({
              message: `fileSearch failed: ${result.error}`,
              cwd: params.cwd,
            })
          }

          for (const item of result.value.items) {
            if (!item.relativePath.startsWith(prefix)) continue
            const relativePath = item.relativePath.slice(prefix.length)
            allFiles.push({ path: path.join(params.cwd, relativePath), relativePath })
          }
          seen += result.value.items.length

          if (seen >= result.value.totalFiles || result.value.items.length < pageSize) break
          pageIndex++
        }

        return allFiles
      }).pipe(Effect.scoped)

    return { listFiles: listUnder }
  })

// ── Inside a git work tree: git decides the listing ──

/**
 * Git lists the files itself, so every exclude source applies as git applies
 * it: the `.gitignore` files above the search root, `.git/info/exclude` and
 * `core.excludesFile`. Tracked files are listed even when a pattern matches
 * them, as git treats them. A nested repository or a submodule is listed by
 * its own git, with its own rules. `None` outside a work tree or without git.
 */
const listGitFiles: (
  cwd: string,
) => Effect.Effect<
  Option.Option<ReadonlyArray<IndexedFile>>,
  FileIndexError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> = Effect.fn("FileIndex.listGitFiles")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const listed = yield* runProcess("git", [
    "-C",
    cwd,
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]).pipe(Effect.option)
  if (Option.isNone(listed) || listed.value.exitCode !== 0) return Option.none()
  const relativePaths = [...new Set(listed.value.stdout.split("\0"))].filter(
    (entry) => entry.length > 0,
  )
  // A deleted tracked file is listed too; a directory is a nested repository
  // (`vendor/lib/`) or a submodule's gitlink.
  const nested = yield* Effect.forEach(
    relativePaths,
    Effect.fnUntraced(function* (entry) {
      const relativePath = entry.replace(/\/$/, "")
      const absolutePath = path.join(cwd, relativePath)
      const info = yield* fs.stat(absolutePath).pipe(Effect.option)
      if (Option.isNone(info)) return []
      if (info.value.type === "File") return [{ path: absolutePath, relativePath }]
      if (info.value.type !== "Directory") return []
      // An uninitialized submodule has no `.git` and nothing to list.
      const isRepository = yield* fs
        .exists(path.join(absolutePath, ".git"))
        .pipe(Effect.orElseSucceed(() => false))
      if (!isRepository) return []
      const inner = yield* listGitFiles(absolutePath)
      return Option.getOrElse(inner, (): ReadonlyArray<IndexedFile> => []).map((file) => ({
        path: file.path,
        relativePath: `${relativePath}/${file.relativePath}`,
      }))
    }),
    { concurrency: 32 },
  )
  const files = nested.flat()
  if (files.length > FALLBACK_MAX_FILES) {
    return yield* new FileIndexError({
      message: `more than ${FALLBACK_MAX_FILES} files under ${cwd}; search a narrower path`,
      cwd,
    })
  }
  return Option.some(files)
})

/**
 * Git's answer for whether `cwd` itself is ignored, from its own exclude
 * sources and without the index: a directory that holds tracked files is
 * still ignored for its untracked ones. `None` outside a work tree.
 */
const gitIgnoresDirectory = (
  cwd: string,
): Effect.Effect<Option.Option<boolean>, never, ChildProcessSpawner.ChildProcessSpawner> =>
  runProcess("git", ["-C", cwd, "check-ignore", "-q", "--no-index", "--", "."]).pipe(
    Effect.map((result) => {
      if (result.exitCode === 0) return Option.some(true)
      if (result.exitCode === 1) return Option.some(false)
      return Option.none()
    }),
    Effect.orElseSucceed(() => Option.none<boolean>()),
  )

/** Git's files, in the native index's order; files the index has not seen yet go last. */
const inIndexOrder = (
  files: ReadonlyArray<IndexedFile>,
  ordered: ReadonlyArray<IndexedFile>,
): ReadonlyArray<IndexedFile> => {
  const unordered = new Map(files.map((file) => [file.path, file]))
  const result: Array<IndexedFile> = []
  for (const file of ordered) {
    const listed = Option.fromUndefinedOr(unordered.get(file.path))
    if (Option.isNone(listed)) continue
    result.push(listed.value)
    unordered.delete(file.path)
  }
  return [...result, ...unordered.values()]
}

/**
 * One listing rule for both paths. Inside a git work tree, git's listing
 * decides which files grep may read; the native index, when present, only
 * orders them. An ignored `cwd` (an explicit `dist/`, or a session started in
 * one) is walked from its own root, as ripgrep searches a named path: git
 * would list none of its untracked files. Outside a work tree the native
 * index lists, with the walk as its per-call fallback, and an explicit target
 * the root's index skips is walked from its own root. The walk has a bound
 * and holds no watcher, so listing ignored targets never evicts a finder.
 */
const makeFileIndex = (
  native: Option.Option<FileIndexService>,
): Effect.Effect<
  FileIndexService,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const walk = yield* makeMatcherWalk
    const platform = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >()
    const walkTarget = (cwd: string) => walk.listFiles({ root: cwd, cwd })
    const outsideWorkTree = Option.match(native, {
      onNone: () => walk,
      onSome: (index) => withFallback(index, walk),
    })

    const listFiles = Effect.fn("FileIndex.listFiles")(function* (params: {
      readonly root: string
      readonly cwd: string
    }) {
      const ignored = yield* gitIgnoresDirectory(params.cwd)
      if (Option.getOrElse(ignored, () => false)) return yield* walkTarget(params.cwd)

      const gitFiles = yield* listGitFiles(params.cwd)
      if (Option.isSome(gitFiles)) {
        if (Option.isNone(native)) return gitFiles.value
        const ordered = yield* native.value
          .listFiles(params)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<IndexedFile> => []))
        return inIndexOrder(gitFiles.value, ordered)
      }

      const files = yield* outsideWorkTree.listFiles(params)
      if (files.length > 0 || params.root === params.cwd) return files
      return yield* walkTarget(params.cwd)
    })

    return {
      listFiles: (params) => listFiles(params).pipe(Effect.provideContext(platform)),
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
}): Layer.Layer<
  FileIndex,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Layer.effect(
    FileIndex,
    Effect.gen(function* () {
      if (!NativeFileFinder.isAvailable()) return yield* makeFileIndex(Option.none())
      const path = yield* Path.Path
      const fs = yield* FileSystem.FileSystem
      const dbDir = path.join(options.home, ".gent", "fff")
      yield* fs.makeDirectory(dbDir, { recursive: true }).pipe(Effect.ignore)
      return yield* makeFileIndex(Option.some(yield* makeNativeService(dbDir)))
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

/** The lines of a text. A trailing newline ends the last line; it does not start one. */
const splitLines = (text: string): Array<string> => {
  if (text.length === 0) return []
  return text.replace(/\n$/, "").split("\n")
}

/** How many lines a text holds, by the `splitLines` rule. */
export const lineCount = (text: string): number => splitLines(text).length

/** `1 line`, `3 lines`: the counted noun of a one-line tool summary. */
export const countOf = (count: number, noun: string, plural = `${noun}s`): string => {
  if (count === 1) return `1 ${noun}`
  return `${count} ${plural}`
}

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
  summary: (_input, output) => {
    const read = `${output.path} · ${countOf(output.lineCount, "line")}`
    if (output.truncated) return `${read} (truncated)`
    return read
  },
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

    const lines = splitLines(content)
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
        "Write a temporary file beside the target, then rename it over the target. Use for saved results. Follows a symlink like a normal write: the file it names is replaced and the link stays. Keeps the file's permissions. Default false keeps normal write behavior.",
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
  summary: (_input, output) => `${output.path} · ${countOf(output.bytesWritten, "byte")}`,
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

const EditParams = Schema.Struct({
  path: Schema.String.annotate({
    description: "Absolute path to file to edit",
  }),
  oldString: Schema.String.check(Schema.isMinLength(1)).annotate({
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

function detectRedaction(oldString: string, newString: string): Option.Option<string> {
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

function unescapeStr(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r").replace(/\\\\/g, "\\")
}

/** Look-alike characters the normalized match reads as ASCII. */
const NORMALIZED_CHARACTERS = new Map([
  ["\u201C", '"'],
  ["\u201D", '"'],
  ["\u2018", "'"],
  ["\u2019", "'"],
  ["\u2014", "-"],
  ["\u00A0", " "],
])

interface NormalizedText {
  readonly text: string
  readonly offsets: ReadonlyArray<number>
}

/**
 * Drop trailing whitespace per line and map look-alike characters to ASCII.
 * `offsets[i]` is the source offset of the normalized character at `i`, so a
 * match in the normalized text maps back to the source.
 */
const normalizeWithOffsets = (s: string, keepLastLineEnd = false): NormalizedText => {
  let text = ""
  const offsets: Array<number> = []
  let lineStart = 0
  const lines = s.split("\n")
  for (const [lineIndex, line] of lines.entries()) {
    let kept = line.replace(/[ \t]+$/, "")
    if (keepLastLineEnd && lineIndex === lines.length - 1) kept = line
    for (let index = 0; index < kept.length; index++) {
      const char = kept.charAt(index)
      text += NORMALIZED_CHARACTERS.get(char) ?? char
      offsets.push(lineStart + index)
    }
    lineStart += line.length + 1
    if (lineStart <= s.length) {
      text += "\n"
      offsets.push(lineStart - 1)
    }
  }
  return { text, offsets }
}

function normalizeWhitespace(s: string): string {
  return normalizeWithOffsets(s).text
}

type MatchStrategy = "exact" | "unescaped" | "normalized"

interface MatchRange {
  readonly start: number
  readonly end: number
}

interface MatchResult {
  strategy: MatchStrategy
  /** Offset of the first match. */
  index: number
  /** Every non-overlapping match, in file order. */
  ranges: ReadonlyArray<MatchRange>
}

const literalRanges = (content: string, search: string): MatchRange[] => {
  const ranges: MatchRange[] = []
  if (search.length === 0) return ranges
  let from = content.indexOf(search)
  while (from !== -1) {
    ranges.push({ start: from, end: from + search.length })
    from = content.indexOf(search, from + search.length)
  }
  return ranges
}

const findNormalizedMatch = (content: string, search: string): Option.Option<MatchResult> => {
  const normalized = normalizeWithOffsets(content)
  const normalizedSearch = normalizeWhitespace(search)
  // A whitespace-only search normalizes to blank lines, which every blank line matches.
  if (normalizedSearch.trim() === "") return Option.none()
  if (normalizedSearch === search && normalized.text === content) return Option.none()
  // Spaces that end the search are text to replace when the line goes on
  // (`"hi"  x`); a match at a line end drops them, as the file has none there.
  const withSearchedSpaces = normalizeWithOffsets(search, true).text
  let found = literalRanges(normalized.text, withSearchedSpaces)
  if (found.length === 0) found = literalRanges(normalized.text, normalizedSearch)

  const sourceStart = (index: number) => normalized.offsets[index] ?? content.length
  // A match that ends a line also takes the trailing whitespace the
  // normalization dropped there, so the edit leaves no stray blanks.
  const sourceEnd = (index: number) => {
    const end = sourceStart(index - 1) + 1
    if (index < normalized.text.length && normalized.text.charAt(index) !== "\n") return end
    const lineEnd = content.indexOf("\n", end)
    if (lineEnd === -1) return content.length
    return lineEnd
  }
  const ranges = found.map((range) => ({
    start: sourceStart(range.start),
    end: sourceEnd(range.end),
  }))
  const strategy: MatchStrategy = "normalized"
  return Option.map(Arr.head(ranges), (first) => ({ strategy, index: first.start, ranges }))
}

const literalMatch = (
  strategy: MatchStrategy,
  content: string,
  search: string,
): Option.Option<MatchResult> => {
  const ranges = literalRanges(content, search)
  return Option.map(Arr.head(ranges), (first) => ({ strategy, index: first.start, ranges }))
}

function findMatch(content: string, oldString: string): Option.Option<MatchResult> {
  // Tier 1: exact
  const exact = literalMatch("exact", content, oldString)
  if (Option.isSome(exact)) return exact

  // Tier 2: unescape literal \n, \t, \\ in oldString
  const unescaped = unescapeStr(oldString)
  if (unescaped !== oldString) {
    const unescapedMatch = literalMatch("unescaped", content, unescaped)
    if (Option.isSome(unescapedMatch)) return unescapedMatch
  }

  // Tier 3: normalize whitespace + unicode in both
  return findNormalizedMatch(content, unescaped)
}

/** Splice `replacement` over each range. The replacement is literal text. */
const spliceRanges = (
  content: string,
  ranges: ReadonlyArray<MatchRange>,
  replacement: string,
): string => {
  let result = ""
  let cursor = 0
  for (const range of ranges) {
    result += content.slice(cursor, range.start) + replacement
    cursor = range.end
  }
  return result + content.slice(cursor)
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
  summary: (_input, output) => `${output.path} · ${countOf(output.replacements, "replacement")}`,
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

        const ranges = match.value.ranges
        const occurrences = ranges.length

        if (occurrences > 1 && !replaceAll) {
          return yield* new EditError({
            message: `oldString found ${occurrences} times. Use replaceAll to replace all, or provide more context for unique match.`,
            path: filePath,
          })
        }

        let replaced: ReadonlyArray<MatchRange> = ranges.slice(0, 1)
        if (replaceAll) replaced = ranges
        const newContent = spliceRanges(content, replaced, params.newString)
        const replacements = replaced.length

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

/** ripgrep's rule: a NUL byte in a file's first 8 KB marks it binary, and grep skips it. */
const BINARY_PROBE_BYTES = 8192

/** A match or context line longer than this is cut to this many characters. */
const MAX_LINE_LENGTH = 500

/**
 * Cut a long line to `MAX_LINE_LENGTH` characters from shortly before `at`,
 * with a marker that counts what each side lost. One minified line would
 * otherwise use the model's whole tool-result budget.
 */
const clipLine = (line: string, at: number): string => {
  if (line.length <= MAX_LINE_LENGTH) return line
  const start = Math.max(0, Math.min(at - MAX_LINE_LENGTH / 5, line.length - MAX_LINE_LENGTH))
  const end = start + MAX_LINE_LENGTH
  let clipped = line.slice(start, end)
  if (start > 0) clipped = `[${start} chars cut] ${clipped}`
  if (end < line.length) clipped = `${clipped} [${line.length - end} chars cut]`
  return clipped
}

// Grep Tool

export const GrepTool = tool({
  id: "grep",
  readonly: true,
  description:
    "Search file contents with regex. Returns matching lines. Skips binary files; a line over 500 characters is cut around the match.",
  promptSnippet: "Search file contents with regex",
  params: GrepParams,
  output: GrepResult,
  summary: (input, output) => {
    const found = `${countOf(output.matches.length, "match", "matches")} for ${input.pattern}`
    if (output.truncated) return `${found} (truncated)`
    return found
  },
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
    let flags = ""
    if (params.caseSensitive === false) flags = "i"

    const regex = yield* Effect.try({
      try: () => new RegExp(params.pattern, flags),
      catch: (e) =>
        new GrepError({
          message: `Invalid regex: ${e}`,
          pattern: params.pattern,
          cause: e,
        }),
    })

    let truncated = false
    const matches: Array<{
      file: string
      line: number
      content: string
      context?: { before: string[]; after: string[] }
    }> = []

    const searchFile = (filePath: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const bytes = yield* fs.readFile(filePath).pipe(Effect.option)
        if (Option.isNone(bytes)) return
        if (bytes.value.subarray(0, BINARY_PROBE_BYTES).includes(0)) return

        const lines = new TextDecoder().decode(bytes.value).split("\n")
        const contextOf = (from: number, to: number) =>
          lines.slice(from, to).map((line) => clipLine(line, 0))

        for (const [i, line] of lines.entries()) {
          if (truncated) break
          const found = Option.fromNullishOr(regex.exec(line))
          if (Option.isNone(found)) continue
          if (matches.length >= limit) {
            truncated = true
            break
          }
          const match: (typeof matches)[0] = {
            file: filePath,
            line: i + 1,
            content: clipLine(line, found.value.index),
          }

          if (contextLines > 0) {
            match.context = {
              before: contextOf(Math.max(0, i - contextLines), i),
              after: contextOf(i + 1, i + 1 + contextLines),
            }
          }

          matches.push(match)
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
      // A target inside the session cwd shares the session's index.
      const fromCwd = path.relative(ctx.cwd, basePath)
      let root = basePath
      if (!fromCwd.startsWith("..") && !path.isAbsolute(fromCwd)) root = ctx.cwd
      const allFiles = yield* index.listFiles({ root, cwd: basePath }).pipe(
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
        if (truncated) break
        if (!matchesGlob(file.relativePath)) continue
        yield* searchFile(file.path)
      }
    }

    return {
      matches,
      truncated,
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
