import {
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Result,
  Schema,
  type Scope,
  Stream,
} from "effect"
import picomatch from "picomatch"
import {
  defineExtension,
  defineRequests,
  ExtensionContext,
  ExtensionId,
  ExtensionHost,
  request,
  runProcess,
  splitLines,
  tool,
  writeFileAtomic,
} from "@gent/core/extensions/api"
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process"

// ── file listing ─────────────────────────────────────────────────────────────

/**
 * File discovery for the grep tool.
 *
 * Git decides which files are listed inside a work tree, and a
 * `.gitignore`-aware FileSystem walk decides outside one.
 */

interface ListedFile {
  readonly path: string
  /** Path relative to the listed `cwd`. */
  readonly relativePath: string
}

interface Listing {
  readonly files: ReadonlyArray<ListedFile>
  /** Names grep cannot open: git listed them, but they are not valid UTF-8. */
  readonly unreadable: number
}

class FileListingError extends Schema.TaggedError<FileListingError>()("FileListingError", {
  message: Schema.String,
  cwd: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// ── Fallback: FileSystem walk with .gitignore filtering ──

type PathMatcher = (path: string) => boolean

/** The walk stops with an error past this many files; the caller narrows `path`. */
const FALLBACK_MAX_FILES = 100_000

const tooManyFiles = (cwd: string) =>
  new FileListingError({
    message: `more than ${FALLBACK_MAX_FILES} files under ${cwd}; search a narrower path`,
    cwd,
  })

/**
 * A relative path that climbs out of its base. `..cache` is a name inside the
 * base; only `..` itself or a `../` step leaves it.
 */
const leavesBase = (path: Path.Path, relative: string): boolean =>
  relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)

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

const neverMatches: PathMatcher = () => false

/**
 * Git's wildmatch compares bytes, so `?` matches one byte of a multibyte
 * character. Patterns and paths are matched as one latin1 character per
 * UTF-8 byte.
 */
const utf8Bytes = (text: string): string => Buffer.from(text, "utf8").toString("latin1")

/**
 * The end of the bracket class that opens at `start`, by wildmatch's rules:
 * a `]` right after `[` or `[!` is a member, `\x` escapes, and `[:alpha:]`
 * is one member. `None` when the class never closes.
 */
const classEnd = (pattern: string, start: number): Option.Option<number> => {
  let index = start + 1
  if (pattern[index] === "!" || pattern[index] === "^") index++
  if (pattern[index] === "]") index++
  while (index < pattern.length) {
    const char = pattern[index]
    if (char === "]") return Option.some(index)
    if (char === "\\") index += 2
    else if (pattern.startsWith("[:", index)) {
      const close = pattern.indexOf(":]", index + 2)
      if (close === -1) return Option.none()
      index = close + 2
    } else index++
  }
  return Option.none()
}

/**
 * Rewrite one wildmatch pattern as picomatch source, or `None` when git can
 * never match it: a pattern that ends in a lone backslash, one with a `.` or
 * `..` segment (a listed path has none), a class that never closes, and a
 * class whose only member is `/`. A class never matches `/`; a negated
 * class is written `[^...]`; an escaped `\[!` stays literal; parentheses
 * are literal.
 */
const toPicomatchSource = (pattern: string): Option.Option<string> => {
  if (/(?:^|[^\\])(?:\\\\)*\\$/.test(pattern)) return Option.none()
  if (pattern.split("/").some((segment) => segment === "." || segment === "..")) {
    return Option.none()
  }
  let source = ""
  let index = 0
  while (index < pattern.length) {
    const char = pattern.charAt(index)
    if (char === "\\") {
      source += pattern.slice(index, index + 2)
      index += 2
      continue
    }
    if (char === "(" || char === ")") {
      source += `\\${char}`
      index++
      continue
    }
    if (char !== "[") {
      source += char
      index++
      continue
    }
    const end = classEnd(pattern, index)
    if (Option.isNone(end)) return Option.none()
    let body = pattern.slice(index + 1, end.value)
    const negated = body.startsWith("!") || body.startsWith("^")
    if (negated) body = body.slice(1)
    body = body.replaceAll(/\\?\//g, "")
    if (body.length === 0 && !negated) return Option.none()
    if (negated) source += `[^${body}/]`
    else source += `[${body}]`
    index = end.value + 1
  }
  return Option.some(source)
}

const compileGitGlob = (pattern: string): PathMatcher => {
  const rewritten = toPicomatchSource(pattern)
  if (Option.isNone(rewritten)) return neverMatches
  const source = utf8Bytes(rewritten.value)
  // A trailing `/**` matches everything inside, never the directory itself.
  if (!source.endsWith("/**")) {
    const matches = picomatch(source, GIT_GLOB_OPTIONS)
    return (path) => matches(utf8Bytes(path))
  }
  const parent = picomatch(source.slice(0, -3), GIT_GLOB_OPTIONS)
  return (path) => {
    const parts = utf8Bytes(path).split("/")
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
 * What a listing does with one path. A symbolic link is never listed or
 * walked, as ripgrep, git grep and the native index treat it: a directory
 * link cannot loop, and each file is read once, under its real path.
 */
const entryKind = (
  absolutePath: string,
): Effect.Effect<"file" | "directory" | "skip", never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const link = yield* fs.readLink(absolutePath).pipe(Effect.option)
    if (Option.isSome(link)) return "skip"
    const info = yield* fs.stat(absolutePath).pipe(Effect.option)
    if (Option.isNone(info)) return "skip"
    if (info.value.type === "File") return "file"
    if (info.value.type === "Directory") return "directory"
    return "skip"
  })

/**
 * Outside a git work tree, and for an explicitly named ignored target, the
 * walk matches `.gitignore` lines itself. It reads every `.gitignore` from
 * `root` down, as git does: the ones on the way from `root` to `cwd` and the
 * ones inside the walked tree. A `cwd` inside an ignored directory is listed
 * from its own root, as ripgrep searches a named path: the rules inside it
 * still apply.
 */
const walkFiles = (params: {
  readonly root: string
  readonly cwd: string
}): Effect.Effect<Listing, FileListingError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    // Read on every listing: small files, and an edit applies at once.
    const loadRules = (directory: string, base: string): Effect.Effect<Array<IgnoreRule>> =>
      fs.readFileString(path.join(directory, ".gitignore")).pipe(
        Effect.map((content) => parseGitignore(content, base)),
        Effect.orElseSucceed((): Array<IgnoreRule> => []),
      )

    const { cwd } = params
    let root = params.root
    let fromRoot = path.relative(root, cwd)
    if (leavesBase(path, fromRoot)) {
      root = cwd
      fromRoot = ""
    }
    let rules = yield* loadRules(root, "")
    let base = ""
    for (const part of fromRoot.split(path.sep).filter((segment) => segment.length > 0)) {
      base = joinRelative(base, part)
      if (isGitignored(base, true, rules)) {
        fromRoot = ""
        rules = yield* loadRules(cwd, "")
        break
      }
      rules = [...rules, ...(yield* loadRules(path.join(root, base), base))]
    }

    const files: ListedFile[] = []
    const scanDir: (
      absoluteDir: string,
      relativeDir: string,
      inherited: ReadonlyArray<IgnoreRule>,
    ) => Effect.Effect<void, FileListingError> = (absoluteDir, relativeDir, inherited) =>
      Effect.gen(function* () {
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
                new FileListingError({ message: `directory scan failed: ${cause.message}`, cwd }),
            ),
          )

        for (const entry of entries) {
          if (entry === ".git") continue
          const relativePath = joinRelative(relativeDir, entry)
          const absPath = path.join(absoluteDir, entry)
          const kind = yield* entryKind(absPath).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
          )
          if (kind === "skip") continue
          const isDirectory = kind === "directory"
          if (isGitignored(joinRelative(fromRoot, relativePath), isDirectory, dirRules)) continue

          if (isDirectory) {
            yield* scanDir(absPath, relativePath, dirRules)
            continue
          }

          if (files.length >= FALLBACK_MAX_FILES) {
            return yield* tooManyFiles(cwd)
          }
          files.push({ path: absPath, relativePath })
        }
      })

    yield* scanDir(cwd, "", rules)

    // A directory entry is a decoded string: the walk never holds an unreadable name.
    return { files, unreadable: 0 }
  })

// ── Inside a git work tree: git decides the listing ──

/**
 * A hook or `rebase -x` exports `GIT_DIR` and its kin for its own repository;
 * the listing asks the repository that holds `cwd`.
 */
// oxlint-disable-next-line effect/noNullish -- Child-process environments use undefined to remove inherited variables.
const unset = undefined
const GIT_ENV = {
  GIT_DIR: unset,
  GIT_WORK_TREE: unset,
  GIT_INDEX_FILE: unset,
  GIT_COMMON_DIR: unset,
}

/** A git that does not answer within this long fails the listing. */
const GIT_TIMEOUT = Duration.seconds(10)

interface GitNames {
  readonly names: ReadonlyArray<string>
  readonly unreadable: number
}

/** The tag `ls-files -t` gives a sparse checkout's skip-worktree entry: in the index, not on disk. */
const SKIP_WORKTREE_TAG = "S".charCodeAt(0)

/**
 * `git ls-files -z -t` under `cwd`, the names git lists below it. A
 * skip-worktree entry of a sparse checkout is not on disk and is dropped
 * before the bound: the output is read as a stream, and past
 * `FALLBACK_MAX_FILES` names on disk the process is stopped and the listing
 * fails, so a huge tree never lands in memory whole. A name that is not
 * valid UTF-8 cannot be opened through a string path; it is counted. `None`
 * when git fails; a git that does not answer in time fails the listing.
 */
const gitLsFiles = (
  cwd: string,
): Effect.Effect<
  Option.Option<GitNames>,
  FileListingError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make(
      "git",
      ["-C", cwd, "ls-files", "-z", "-t", "--cached", "--others", "--exclude-standard"],
      { env: GIT_ENV, extendEnv: true, stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    )
    const chunks: Array<Uint8Array> = []
    let onDisk = 0
    let entryStart = true
    let skipWorktree = false
    yield* Stream.runForEachWhile(handle.stdout, (chunk) =>
      Effect.sync(() => {
        chunks.push(chunk)
        for (const byte of chunk) {
          if (entryStart) skipWorktree = byte === SKIP_WORKTREE_TAG
          entryStart = byte === 0
          if (entryStart && !skipWorktree) onDisk++
        }
        return onDisk <= FALLBACK_MAX_FILES
      }),
    )
    if (onDisk > FALLBACK_MAX_FILES) {
      return yield* tooManyFiles(cwd)
    }
    if ((yield* handle.exitCode) !== 0) return Option.none<GitNames>()
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const names = new Set<string>()
    let unreadable = 0
    const output = Buffer.concat(chunks)
    let start = 0
    for (let end = output.indexOf(0); end !== -1; end = output.indexOf(0, start)) {
      const entry = output.subarray(start, end)
      start = end + 1
      // `-t` prefixes each name with its tag and a space.
      if (entry.length < 3 || entry[0] === SKIP_WORKTREE_TAG) continue
      const name = Result.try(() => decoder.decode(entry.subarray(2)))
      if (Result.isSuccess(name)) names.add(name.success)
      else unreadable++
    }
    return Option.some<GitNames>({ names: [...names], unreadable })
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", () => Effect.succeedNone),
    Effect.timeoutOption(GIT_TIMEOUT),
    Effect.flatMap(
      Option.match({
        // A git that does not answer is a huge tree more often than a broken
        // one, and the .gitignore walk misses info/exclude and the global
        // excludes there.
        onNone: () =>
          Effect.fail(
            new FileListingError({
              message: `git did not list ${cwd} within ${Duration.format(GIT_TIMEOUT)}; search a narrower path`,
              cwd,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  )

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
  Option.Option<Listing>,
  FileListingError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> = Effect.fn("FsTools.listGitFiles")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const listed = yield* gitLsFiles(cwd)
  if (Option.isNone(listed)) return Option.none()
  let unreadable = listed.value.unreadable
  // Git lists index paths: a tracked `sub/a.ts` stays listed after `sub`
  // becomes a symbolic link, and a read would follow it out of the tree.
  // Each directory is checked once.
  const linkedDirectories = new Map<string, boolean>()
  const underLink: (relativeDirectory: string) => Effect.Effect<boolean> = (relativeDirectory) =>
    Effect.gen(function* () {
      if (relativeDirectory === "." || relativeDirectory.length === 0) return false
      const known = Option.fromUndefinedOr(linkedDirectories.get(relativeDirectory))
      if (Option.isSome(known)) return known.value
      const linked =
        (yield* underLink(path.dirname(relativeDirectory))) ||
        Option.isSome(yield* fs.readLink(path.join(cwd, relativeDirectory)).pipe(Effect.option))
      linkedDirectories.set(relativeDirectory, linked)
      return linked
    })
  // A deleted tracked file and a symbolic link are listed too; a directory
  // is a nested repository (`vendor/lib/`) or a submodule's gitlink.
  const nested = yield* Effect.forEach(
    listed.value.names,
    Effect.fnUntraced(function* (entry) {
      const relativePath = entry.replace(/\/$/, "")
      const absolutePath = path.join(cwd, relativePath)
      if (yield* underLink(path.dirname(relativePath))) return []
      const kind = yield* entryKind(absolutePath)
      if (kind === "skip") return []
      if (kind === "file") return [{ path: absolutePath, relativePath }]
      // An uninitialized submodule has no `.git` and nothing to list.
      const isRepository = yield* fs
        .exists(path.join(absolutePath, ".git"))
        .pipe(Effect.orElseSucceed(() => false))
      if (!isRepository) return []
      const inner = yield* listGitFiles(absolutePath)
      if (Option.isNone(inner)) return []
      unreadable += inner.value.unreadable
      return inner.value.files.map((file) => ({
        path: file.path,
        relativePath: `${relativePath}/${file.relativePath}`,
      }))
    }),
    { concurrency: 32 },
  )
  const files = nested.flat()
  if (files.length > FALLBACK_MAX_FILES) {
    return yield* tooManyFiles(cwd)
  }
  return Option.some({ files, unreadable })
})

/**
 * Git's answer for whether `cwd` itself is ignored, from its own exclude
 * sources and without the index: a directory that holds tracked files is
 * still ignored for its untracked ones. `None` outside a work tree.
 */
const gitIgnoresDirectory = (
  cwd: string,
): Effect.Effect<Option.Option<boolean>, never, ChildProcessSpawner.ChildProcessSpawner> =>
  runProcess("git", ["-C", cwd, "check-ignore", "-q", "--no-index", "--", "."], {
    env: GIT_ENV,
    extendEnv: true,
    timeout: GIT_TIMEOUT,
  }).pipe(
    Effect.map((result) => {
      if (result.exitCode === 0) return Option.some(true)
      if (result.exitCode === 1) return Option.some(false)
      return Option.none()
    }),
    Effect.orElseSucceed(() => Option.none<boolean>()),
  )

/**
 * One listing rule: an ignore authority decides which files grep may read.
 * Inside a git work tree the authority is git's own listing; outside one it
 * is the `.gitignore` matcher walk. An ignored `cwd` (an explicit `dist/`, or
 * a session started in one) is walked from its own root, as ripgrep searches
 * a named path: git would list none of its untracked files.
 */
const listFiles: (params: {
  readonly root: string
  readonly cwd: string
}) => Effect.Effect<
  Listing,
  FileListingError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> = Effect.fn("FsTools.listFiles")(function* (params) {
  const ignored = yield* gitIgnoresDirectory(params.cwd)
  if (Option.getOrElse(ignored, () => false)) {
    return yield* walkFiles({ root: params.cwd, cwd: params.cwd })
  }
  const gitFiles = yield* listGitFiles(params.cwd)
  if (Option.isSome(gitFiles)) return gitFiles.value
  return yield* walkFiles(params)
})

// ── file text ───────────────────────────────────────────────────────────────

/** How a text file spells its text: UTF-8, or the byte order mark it starts with. */
type TextEncoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be"

/** A text file's text and the encoding it was read in, so an edit writes it back the same way. */
interface FileText {
  readonly text: string
  readonly encoding: TextEncoding
  /**
   * The bytes are not valid in `encoding`: an invalid UTF-8 sequence, an odd
   * trailing byte or an unpaired surrogate in UTF-16. The decoder put U+FFFD in
   * their place, so writing `text` back would not give the same bytes.
   */
  readonly lossy: boolean
}

/** ripgrep's rule: a NUL byte in a file's first 8 KB marks it binary. */
const BINARY_PROBE_BYTES = 8192

const UTF8_BOM = [0xef, 0xbb, 0xbf]
const UTF16LE_BOM = [0xff, 0xfe]
const UTF16BE_BOM = [0xfe, 0xff]

const startsWith = (bytes: Uint8Array, mark: ReadonlyArray<number>) =>
  mark.every((byte, index) => bytes[index] === byte)

/** Decode the bytes after a byte order mark; the mark is not part of the text. */
const decodeAfter = (label: string, bytes: Uint8Array, mark: ReadonlyArray<number>) =>
  new TextDecoder(label, { ignoreBOM: true }).decode(bytes.subarray(mark.length))

/**
 * The text of a file, or `None` for a binary one. read, write, edit and grep
 * all read through `decodeText`; grep skips the lossy check. A UTF-16 file starts with a byte order mark and
 * holds NUL bytes, so it is decoded before the NUL probe, as ripgrep
 * transcodes it. The decoder replaces a bad sequence silently; encoding the
 * text again is the one check that the bytes and the text hold the same file.
 */
const decodeFileText = (bytes: Uint8Array): Option.Option<FileText> =>
  Option.map(decodeText(bytes), (decoded) => ({
    ...decoded,
    lossy: !Buffer.from(encodeFileText(decoded)).equals(bytes),
  }))

const decodeText = (bytes: Uint8Array): Option.Option<Omit<FileText, "lossy">> => {
  if (startsWith(bytes, UTF16LE_BOM)) {
    return Option.some({ encoding: "utf-16le", text: decodeAfter("utf-16le", bytes, UTF16LE_BOM) })
  }
  if (startsWith(bytes, UTF16BE_BOM)) {
    return Option.some({ encoding: "utf-16be", text: decodeAfter("utf-16be", bytes, UTF16BE_BOM) })
  }
  if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return Option.none()
  if (startsWith(bytes, UTF8_BOM)) {
    return Option.some({ encoding: "utf-8-bom", text: decodeAfter("utf-8", bytes, UTF8_BOM) })
  }
  return Option.some({ encoding: "utf-8", text: decodeAfter("utf-8", bytes, []) })
}

/** Why a file that does not decode exactly is not rewritten. */
const lossyWriteMessage = (verb: string, file: FileText) =>
  `Cannot ${verb} this file: it holds bytes that are not valid ${file.encoding}, and writing the text back would replace them with U+FFFD. Convert the file to valid ${file.encoding} first.`

/** Why text with half a UTF-16 pair is not written: no encoding stores it as text. */
const loneSurrogateMessage = (verb: string) =>
  `Cannot ${verb} this file: the new text holds a lone surrogate (half of a UTF-16 pair), which UTF-8 cannot store and a UTF-16 file cannot read back. Send whole characters.`

/** UTF-16 code units in the given byte order, after the byte order mark. */
const encodeUtf16 = (text: string, littleEndian: boolean): Uint8Array => {
  const bytes = new Uint8Array(2 + text.length * 2)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, 0xfeff, littleEndian)
  for (let index = 0; index < text.length; index++) {
    view.setUint16(2 + index * 2, text.charCodeAt(index), littleEndian)
  }
  return bytes
}

/** The bytes of `file.text` in the encoding the file was read in, with its byte order mark. */
const encodeFileText = (file: Omit<FileText, "lossy">): Uint8Array => {
  switch (file.encoding) {
    case "utf-8":
      return new TextEncoder().encode(file.text)
    case "utf-8-bom": {
      const body = new TextEncoder().encode(file.text)
      const bytes = new Uint8Array(UTF8_BOM.length + body.length)
      bytes.set(UTF8_BOM)
      bytes.set(body, UTF8_BOM.length)
      return bytes
    }
    case "utf-16le":
      return encodeUtf16(file.text, true)
    case "utf-16be":
      return encodeUtf16(file.text, false)
  }
}

// ── read ────────────────────────────────────────────────────────────────────

// Read Tool Error

class ReadError extends Schema.TaggedError<ReadError>()("ReadError", {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Read Tool Params

/** A line number or a count of at least one: 0, a negative or a fraction is refused. */
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

const ReadParams = Schema.Struct({
  path: Schema.String.annotate({
    description: "Absolute path to file to read",
  }),
  offset: Schema.optionalKey(
    PositiveInt.annotate({
      description: "Line number to start reading from (1-indexed)",
    }),
  ),
  limit: Schema.optionalKey(
    PositiveInt.annotate({
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
  /** Present when the file holds invalid bytes, shown as U+FFFD; edit and write refuse such a file. */
  lossy: Schema.optional(Schema.Literal(true)),
})

/** `1 line`, `3 lines`: the counted noun of a one-line tool summary. */
export const countOf = (count: number, noun: string, plural = `${noun}s`): string => {
  if (count === 1) return `1 ${noun}`
  return `${count} ${plural}`
}

// Read Tool

export const ReadTool = tool({
  id: "read",
  readonly: true,
  description:
    "Read file contents. Returns numbered lines. Use offset/limit for large files. A truncated result carries nextOffset — pass it back as offset to continue from the next unread line. A file with bytes that are not valid text shows them as U+FFFD and reports lossy; edit and write refuse that file.",
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

    const bytes = yield* fs.readFile(filePath).pipe(
      Effect.mapError(
        (e) =>
          new ReadError({
            message: `Failed to read file: ${e.message}`,
            path: filePath,
            cause: e,
          }),
      ),
    )
    const decoded = decodeFileText(bytes)
    if (Option.isNone(decoded)) {
      return yield* new ReadError({ message: "Cannot read a binary file.", path: filePath })
    }

    const lines = splitLines(decoded.value.text)
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
      ...(decoded.value.lossy && { lossy: true }),
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
    if (!params.content.isWellFormed()) {
      return yield* new WriteError({ message: loneSurrogateMessage("write"), path: filePath })
    }
    const write = (bytes: Uint8Array) =>
      Effect.gen(function* () {
        if (params.atomic === true) return yield* writeFileAtomic(filePath, bytes)
        return yield* fs.writeFile(filePath, bytes)
      })

    return yield* ctx.FileLock.withLock(
      filePath,
      Effect.gen(function* () {
        const dir = path.dirname(filePath)

        // A file that does not decode exactly was shown with U+FFFD in place
        // of its bad bytes; content built from that read would destroy them.
        const existing = yield* fs.readFile(filePath).pipe(Effect.option)
        const existingText = Option.flatMap(existing, decodeFileText)
        if (Option.isSome(existingText) && existingText.value.lossy) {
          return yield* new WriteError({
            message: lossyWriteMessage("overwrite", existingText.value),
            path: filePath,
          })
        }

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

        // An overwrite keeps the encoding and byte order mark the file was in; a new file is UTF-8.
        const bytes = encodeFileText({
          text: params.content,
          encoding: Option.match(existingText, {
            onNone: (): TextEncoding => "utf-8",
            onSome: (file) => file.encoding,
          }),
        })
        yield* write(bytes).pipe(
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
          bytesWritten: bytes.length,
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

const unescapeChar = (char: string): string => {
  if (char === "n") return "\n"
  if (char === "t") return "\t"
  if (char === "r") return "\r"
  return char
}

/** One left-to-right pass, so `\\n` reads as a backslash and an n. */
function unescapeStr(s: string): string {
  return s.replace(/\\([ntr\\])/g, (_escape, char: string) => unescapeChar(char))
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

interface MatchRange {
  readonly start: number
  readonly end: number
}

/** Every non-overlapping match, in file order; empty when the search misses. */
type MatchRanges = ReadonlyArray<MatchRange>

/** An offset between a CR and its LF, where no match may start or end. */
const splitsLineBreak = (content: string, index: number): boolean =>
  content.charAt(index - 1) === "\r" && content.charAt(index) === "\n"

const literalRanges = (content: string, search: string): MatchRange[] => {
  const ranges: MatchRange[] = []
  if (search.length === 0) return ranges
  let from = content.indexOf(search)
  while (from !== -1) {
    const end = from + search.length
    if (splitsLineBreak(content, from) || splitsLineBreak(content, end)) {
      from = content.indexOf(search, from + 1)
      continue
    }
    ranges.push({ start: from, end })
    from = content.indexOf(search, end)
  }
  return ranges
}

const findNormalizedMatch = (content: string, search: string): MatchRanges => {
  const normalized = normalizeWithOffsets(content)
  const normalizedSearch = normalizeWhitespace(search)
  // A whitespace-only search normalizes to blank lines, which every blank line matches.
  if (normalizedSearch.trim() === "") return []
  if (normalizedSearch === search && normalized.text === content) return []
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
  return found.map((range) => ({
    start: sourceStart(range.start),
    end: sourceEnd(range.end),
  }))
}

/**
 * A file's text with each CRLF read as LF, so a search typed with LF matches
 * across CRLF lines. `toSource` maps a view offset back to the file: the LF of
 * a CRLF maps to its CR, so a range that ends before a line break stops before
 * both characters.
 */
interface LineFeedView {
  readonly text: string
  readonly toSource: (index: number) => number
}

const lineFeedView = (content: string): LineFeedView => {
  if (!content.includes("\r\n")) return { text: content, toSource: (index) => index }
  const offsets: Array<number> = []
  for (let index = 0; index < content.length; index++) {
    offsets.push(index)
    if (content.charAt(index) === "\r" && content.charAt(index + 1) === "\n") index++
  }
  return {
    text: content.replaceAll("\r\n", "\n"),
    toSource: (index) => offsets[index] ?? content.length,
  }
}

/** The break at `at`: CRLF, a bare CR or LF. */
const breakAt = (content: string, at: number): string => {
  if (content.charAt(at) === "\n") return "\n"
  if (content.charAt(at + 1) === "\n") return "\r\n"
  return "\r"
}

/**
 * The line break the line at `index` ends with (CRLF, a bare CR or LF); the
 * last line takes the one before it, and a file with none takes LF.
 */
const lineEndingAt = (content: string, index: number): string => {
  const next = content.slice(index).search(/[\r\n]/)
  if (next !== -1) return breakAt(content, index + next)
  const before = Math.max(
    content.lastIndexOf("\n", index - 1),
    content.lastIndexOf("\r", index - 1),
  )
  if (before === -1) return "\n"
  if (content.charAt(before) === "\n" && content.charAt(before - 1) === "\r") return "\r\n"
  return breakAt(content, before)
}

/**
 * Where a search matched, and whether it matched only once unescaped (`\\n`
 * read as a line break). Such a match says nothing about how `newString` was
 * written, so the edit refuses it instead of guessing.
 */
interface EditMatch {
  readonly ranges: MatchRanges
  readonly unescaped: boolean
}

/**
 * A search that names a CR is matched on the file as written first, so it
 * touches only the lines that have that ending. Every other search, and one
 * the file misses, is matched on the LF view, where line endings never decide
 * a match and every CRLF site counts. A search the view misses too (typed with
 * a bare CR) goes through the looser tiers on the file. No match starts or
 * ends between a CR and its LF.
 */
const findEditMatch = (content: string, oldString: string): EditMatch => {
  if (oldString.includes("\r")) {
    const exact = literalRanges(content, oldString)
    if (exact.length > 0) return { ranges: exact, unescaped: false }
  }
  const view = lineFeedView(content)
  const viewed = findMatch(view.text, oldString.replaceAll("\r\n", "\n"))
  const ranges = viewed.ranges.map((range) => ({
    start: view.toSource(range.start),
    end: view.toSource(range.end),
  }))
  if (ranges.length > 0 || view.text === content) return { ...viewed, ranges }
  return findMatch(content, oldString)
}

function findMatch(content: string, oldString: string): EditMatch {
  // Tier 1: exact
  const exact = literalRanges(content, oldString)
  if (exact.length > 0) return { ranges: exact, unescaped: false }

  // Tier 2: normalize whitespace + unicode in both
  const normalized = findNormalizedMatch(content, oldString)
  if (normalized.length > 0) return { ranges: normalized, unescaped: false }

  // Tier 3: the search read with \n, \t, \r, \\ unescaped. It never edits: a
  // match here only tells the edit to refuse with a reason clearer than "not found".
  const unescaped = unescapeStr(oldString)
  if (unescaped === oldString) return { ranges: [], unescaped: false }
  const unescapedExact = literalRanges(content, unescaped)
  if (unescapedExact.length > 0) return { ranges: unescapedExact, unescaped: true }
  return { ranges: findNormalizedMatch(content, unescaped), unescaped: true }
}

/**
 * Splice `replacement` over each range. The replacement is literal text, and
 * its line breaks take the ending of the line each range starts on, so a
 * CRLF file stays CRLF and the lines outside the ranges keep their bytes.
 */
const spliceRanges = (
  content: string,
  ranges: ReadonlyArray<MatchRange>,
  replacement: string,
): string => {
  const lines = replacement.replaceAll("\r\n", "\n")
  let result = ""
  let cursor = 0
  for (const range of ranges) {
    const ending = lineEndingAt(content, range.start)
    result += content.slice(cursor, range.start) + lines.replaceAll("\n", ending)
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
        const bytes = yield* fs.readFile(filePath).pipe(
          Effect.mapError(
            (e) =>
              new EditError({
                message: `Failed to read file: ${e.message}`,
                path: filePath,
                cause: e,
              }),
          ),
        )
        const decoded = decodeFileText(bytes)
        if (Option.isNone(decoded)) {
          return yield* new EditError({ message: "Cannot edit a binary file.", path: filePath })
        }
        if (decoded.value.lossy) {
          return yield* new EditError({
            message: lossyWriteMessage("edit", decoded.value),
            path: filePath,
          })
        }
        const content = decoded.value.text

        const replaceAll = params.replaceAll === true

        const { ranges, unescaped } = findEditMatch(content, params.oldString)

        if (ranges.length === 0) {
          return yield* new EditError({
            message: "oldString not found in file",
            path: filePath,
          })
        }

        if (unescaped) {
          return yield* new EditError({
            message:
              "oldString matched only after unescaping (\\n, \\t, \\r, \\\\). Resend oldString and newString as the literal file text, without escapes.",
            path: filePath,
          })
        }

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
        if (!newContent.isWellFormed()) {
          return yield* new EditError({ message: loneSurrogateMessage("edit"), path: filePath })
        }
        const replacements = replaced.length

        // The file keeps the encoding and byte order mark it was read in.
        const written = encodeFileText({ ...decoded.value, text: newContent })
        yield* fs.writeFile(filePath, written).pipe(
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
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "Lines of context around matches",
    }),
  ),
  limit: Schema.optionalKey(
    PositiveInt.annotate({
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
  /** Files grep could not open: git listed them, but their names are not valid UTF-8. */
  unreadable: Schema.optional(Schema.Finite),
  /** Files grep skipped because they are larger than the size cap. */
  oversized: Schema.optional(Schema.Finite),
  /**
   * Lines the regex engine gave up on: the pattern backtracks too much to
   * decide them, so one of them may match. Simplify the pattern.
   */
  undecided: Schema.optional(Schema.Finite),
})

/** A file larger than this is skipped and counted: it is a log or a bundle, not source. */
const MAX_SEARCH_FILE_BYTES = 10 * 1024 * 1024

/** Files read at once. Results keep the listing order. */
const SEARCH_CONCURRENCY = 16

/** Files started per round: a search stops within one round of reaching its limit. */
const SEARCH_ROUND = 64

type GrepMatch = typeof GrepMatch.Type

/** A match or context line longer than this is cut to this many characters. */
const MAX_LINE_LENGTH = 500

/** True when a cut at `index` falls between the two halves of a surrogate pair. */
const splitsSurrogatePair = (text: string, index: number): boolean => {
  const before = text.charCodeAt(index - 1)
  const after = text.charCodeAt(index)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

/**
 * Cut a long line to `MAX_LINE_LENGTH` characters from shortly before `at`,
 * with a marker that counts what each side lost. One minified line would
 * otherwise use the model's whole tool-result budget.
 */
const clipLine = (line: string, at: number): string => {
  if (line.length <= MAX_LINE_LENGTH) return line
  const from = Math.max(0, Math.min(at - MAX_LINE_LENGTH / 5, line.length - MAX_LINE_LENGTH))
  // Both ends move inward off a surrogate pair: a lone half is not valid text,
  // and the API refuses a request that holds one.
  const start = from + Number(splitsSurrogatePair(line, from))
  const end = from + MAX_LINE_LENGTH - Number(splitsSurrogatePair(line, from + MAX_LINE_LENGTH))
  let clipped = line.slice(start, end)
  if (start > 0) clipped = `[${start} chars cut] ${clipped}`
  if (end < line.length) clipped = `${clipped} [${line.length - end} chars cut]`
  return clipped
}

// ── Line matcher: the regex runs on its own thread ──

/**
 * A line whose search runs longer than this and finds nothing is undecided.
 * JavaScriptCore stops a search that backtracks too far and reports no match,
 * with no other signal, so a slow miss may hide a match. The limit counts
 * backtracking steps, so a give-up takes a steady time: 320 ms for the
 * fastest pattern measured, 450 ms to 1 s for most. Load only makes it
 * slower. A slow real miss counted here costs one number in the result, so
 * the bound sits far below the fastest give-up.
 */
const UNDECIDED_LINE_MS = 50

/** A grep that runs longer than this fails: its pattern backtracks too much. */
const GREP_TIME_LIMIT = Duration.seconds(30)

/** One file's answer from the matcher thread. */
const MatcherReply = Schema.Struct({
  id: Schema.Int,
  /** Each matching line's index and the offset of its match, at most `limit + 1`. */
  hits: Schema.Array(Schema.Tuple([Schema.Int, Schema.Int])),
  undecided: Schema.Int,
})
type MatcherReply = typeof MatcherReply.Type

/**
 * The matcher thread's source. It is plain JavaScript with no imports, so it
 * runs from a Blob URL in the compiled binary as well as from source. Each
 * request carries the pattern; the thread builds its regex once.
 */
const MATCHER_SOURCE = [
  "let regex",
  "onmessage = (event) => {",
  "  const { id, source, flags, text, limit } = event.data",
  "  regex ??= new RegExp(source, flags)",
  "  const lines = text.split('\\n')",
  "  const hits = []",
  "  let undecided = 0",
  "  for (let index = 0; index < lines.length && hits.length <= limit; index++) {",
  "    const started = performance.now()",
  "    const hit = regex.exec(lines[index])",
  "    if (hit !== null) hits.push([index, hit.index])",
  `    else if (performance.now() - started > ${UNDECIDED_LINE_MS}) undecided++`,
  "  }",
  "  postMessage({ id, hits, undecided })",
  "}",
].join("\n")

/** Searches one file's text on the matcher thread. */
interface LineMatcher {
  readonly search: (text: string, limit: number) => Effect.Effect<MatcherReply, GrepError>
}

/**
 * A matcher thread for one grep. The regex runs off the server thread, so a
 * pattern that backtracks for minutes stalls nothing else, and closing the
 * scope ends the thread: a timeout or an interrupt stops the search at once.
 */
const makeLineMatcher = (regex: RegExp): Effect.Effect<LineMatcher, GrepError, Scope.Scope> =>
  Effect.gen(function* () {
    const pending = new Map<number, (reply: Effect.Effect<MatcherReply, GrepError>) => void>()
    const failAll = (message: string) => {
      for (const resume of pending.values()) {
        resume(Effect.fail(new GrepError({ message, pattern: regex.source })))
      }
      pending.clear()
    }
    // The URL is released on its own, so it is revoked even when the Worker
    // constructor throws.
    const url = yield* Effect.acquireRelease(
      Effect.sync(() => URL.createObjectURL(new Blob([MATCHER_SOURCE]))),
      (created) => Effect.sync(() => URL.revokeObjectURL(created)),
    )
    const thread = yield* Effect.acquireRelease(
      Effect.try({
        // oxlint-disable-next-line effect/noGlobals -- the regex must run on an OS thread the server can end, and an Effect Worker needs a bundled entry module; this one is a Blob of plain JavaScript.
        try: () => new Worker(url),
        catch: (cause) =>
          new GrepError({
            message: `grep could not start its matcher: ${String(cause)}`,
            pattern: regex.source,
          }),
      }),
      (started) =>
        Effect.sync(() => {
          started.terminate()
          failAll("grep ended")
        }),
    )
    thread.onmessage = (event: MessageEvent) => {
      const reply = Schema.decodeUnknownOption(MatcherReply)(event.data)
      if (Option.isNone(reply)) return failAll("grep's matcher sent a reply it cannot read")
      const resume = pending.get(reply.value.id)
      pending.delete(reply.value.id)
      resume?.(Effect.succeed(reply.value))
    }
    thread.onerror = (event: ErrorEvent) => failAll(`grep's matcher failed: ${event.message}`)
    let nextId = 0
    return {
      search: (text, limit) =>
        Effect.callback<MatcherReply, GrepError>((resume) => {
          const id = nextId++
          pending.set(id, resume)
          thread.postMessage({ id, source: regex.source, flags: regex.flags, text, limit })
          return Effect.sync(() => {
            pending.delete(id)
          })
        }),
    }
  })

/** What one grep looks for. */
interface Search {
  readonly matcher: LineMatcher
  readonly limit: number
  readonly contextLines: number
}

interface FileSearch {
  readonly matches: ReadonlyArray<GrepMatch>
  readonly oversized: boolean
  readonly undecided: number
}

/**
 * One file's matches in line order, at most `limit + 1` of them: one past the
 * limit is enough to know the search was cut.
 */
const searchFile = (
  filePath: string,
  search: Search,
): Effect.Effect<FileSearch, GrepError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const none: FileSearch = { matches: [], oversized: false, undecided: 0 }
    const info = yield* fs.stat(filePath).pipe(Effect.option)
    if (Option.isNone(info)) return none
    if (info.value.size > BigInt(MAX_SEARCH_FILE_BYTES)) return { ...none, oversized: true }
    const bytes = yield* fs.readFile(filePath).pipe(Effect.option)
    // grep only reads: it skips the lossy check that guards a rewrite.
    const decoded = Option.flatMap(bytes, decodeText)
    if (Option.isNone(decoded)) return none

    const text = decoded.value.text
    const reply = yield* search.matcher.search(text, search.limit)
    const lines = text.split("\n")
    const contextOf = (from: number, to: number) =>
      lines.slice(from, to).map((line) => clipLine(line, 0))
    const matches = reply.hits.map(([index, at]): GrepMatch => {
      const match: GrepMatch = {
        file: filePath,
        line: index + 1,
        content: clipLine(lines[index] ?? "", at),
      }
      if (search.contextLines === 0) return match
      return {
        ...match,
        context: {
          before: contextOf(Math.max(0, index - search.contextLines), index),
          after: contextOf(index + 1, index + 1 + search.contextLines),
        },
      }
    })
    return { matches, oversized: false, undecided: reply.undecided }
  })

/**
 * Search `files` in order, `SEARCH_CONCURRENCY` at a time, a round of
 * `SEARCH_ROUND` files after another, until the limit is passed.
 */
const searchFiles = (
  files: ReadonlyArray<string>,
  search: Search,
): Effect.Effect<
  {
    readonly matches: ReadonlyArray<GrepMatch>
    readonly truncated: boolean
    readonly oversized: number
    readonly undecided: number
  },
  GrepError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const matches: Array<GrepMatch> = []
    let oversized = 0
    let undecided = 0
    for (let from = 0; from < files.length; from += SEARCH_ROUND) {
      const results = yield* Effect.forEach(
        files.slice(from, from + SEARCH_ROUND),
        (file) => searchFile(file, search),
        { concurrency: SEARCH_CONCURRENCY },
      )
      for (const result of results) {
        if (result.oversized) oversized++
        undecided += result.undecided
        matches.push(...result.matches)
        if (matches.length > search.limit) {
          return {
            matches: matches.slice(0, search.limit),
            truncated: true,
            oversized,
            undecided,
          }
        }
      }
    }
    return { matches, truncated: false, oversized, undecided }
  })

// Grep Tool

export const GrepTool = tool({
  id: "grep",
  readonly: true,
  description:
    "Search file contents with regex. Returns matching lines in path order. Skips binary files and files over 10 MB; a line over 500 characters is cut around the match. A pattern that backtracks too much leaves lines undecided (counted in undecided) and fails past 30 seconds.",
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

    const baseStat = yield* fs.stat(basePath).pipe(Effect.option)
    if (Option.isNone(baseStat)) {
      return yield* new GrepError({
        message: `Path not found: ${basePath}`,
        pattern: params.pattern,
      })
    }

    let files: ReadonlyArray<string> = [basePath]
    let unreadable = 0
    if (baseStat.value.type !== "File") {
      // A target inside the session cwd reads the session's ignore rules from its root.
      const fromCwd = path.relative(ctx.cwd, basePath)
      let root = basePath
      if (!leavesBase(path, fromCwd)) root = ctx.cwd
      const listing = yield* listFiles({ root, cwd: basePath }).pipe(
        Effect.mapError(
          (cause) =>
            new GrepError({
              message: `File listing failed: ${cause.message}`,
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
      unreadable = listing.unreadable
      // Sorted by path, so the same search gives the same matches in the same order.
      files = listing.files
        .filter((file) => matchesGlob(file.relativePath))
        .map((file) => file.path)
        .toSorted()
    }

    const { matches, truncated, oversized, undecided } = yield* Effect.scoped(
      Effect.gen(function* () {
        const matcher = yield* makeLineMatcher(regex)
        return yield* searchFiles(files, { matcher, limit, contextLines })
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: GREP_TIME_LIMIT,
        orElse: () =>
          Effect.fail(
            new GrepError({
              message: `grep ran past ${Duration.format(GREP_TIME_LIMIT)}: the pattern backtracks too much. Simplify it or search a narrower path.`,
              pattern: params.pattern,
            }),
          ),
      }),
    )
    let result: typeof GrepResult.Type = { matches, truncated }
    if (unreadable > 0) result = { ...result, unreadable }
    if (oversized > 0) result = { ...result, oversized }
    if (undecided > 0) result = { ...result, undecided }
    return result
  }),
})

// ── protocol ────────────────────────────────────────────────────────────────

const FS_TOOLS_EXTENSION_ID = ExtensionId.make("@gent/fs-tools")

/**
 * The client's file picker reads the same listing grep reads, so the files a
 * user can name with `@` are the files the model can search: git's listing
 * inside a work tree, the `.gitignore` walk outside one.
 */
export const FilesRpc = defineRequests(FS_TOOLS_EXTENSION_ID, {
  List: request({
    id: "files-list",
    description: "List the session's files, relative to its cwd, sorted",
    answersDuringTurn: true,
    input: Schema.Struct({}),
    output: Schema.Array(Schema.String),
    execute: Effect.fn("FilesRpc.List")(function* () {
      const ctx = yield* ExtensionContext
      const listing = yield* listFiles({ root: ctx.cwd, cwd: ctx.cwd })
      return listing.files.map((file) => file.relativePath).toSorted()
    }),
  }),
})

// ── extension ───────────────────────────────────────────────────────────────

export const FsToolsExtension = defineExtension({
  id: FS_TOOLS_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", ReadTool, WriteTool, EditTool, GrepTool)
    yield* host.register("request", FilesRpc.List)
  }),
})
