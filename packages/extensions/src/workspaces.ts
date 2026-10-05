/**
 * Private places for child agents: a copy of a session's working tree that a
 * child edits, whose work comes back to the origin repository as one branch.
 *
 * The delegate asks for a place when a start names `isolation: "snapshot"`
 * and creates the child session with its `cwd` inside the copy, so the child's
 * profile, tools, shell and cell all run there. The copy comes from `rift`
 * when the origin's file system can copy on write (`rift rpc`, a process,
 * never its FFI; gent never runs `rift init` or `rift gc`), else from
 * `git worktree add --detach` with the origin's uncommitted state and the
 * `.rift.toml` `postcreate` hooks. A copy is not a sandbox: the child still
 * reaches every path on the machine.
 *
 * Work comes back at each child turn end: the copy's committed and
 * uncommitted work, as one commit over the origin's working tree at the
 * copy's start (`base`), fetched into the origin as `refs/heads/gent/<name>`.
 * Nothing is merged. A place lives as long as its child session; a place
 * whose child had no turn for two days is removed, and its branch stays.
 *
 * One record per place under `<data directory>/workspaces/<name>.json`.
 */
import {
  Clock,
  Context,
  Crypto,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Schema,
  Stream,
} from "effect"
import { Hex } from "effect/encoding"
import {
  defineExtension,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  RequestId,
  resolveDataDir,
  runProcess,
  SessionId,
  writeFileAtomic,
} from "@gent/core/extensions/api"

// ── records ─────────────────────────────────────────────────────────────────

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  message: Schema.String,
}) {}

const WorkspaceBackend = Schema.Literals(["rift", "worktree"])

/** One place on disk, and the child session that works in it once one does. */
export const WorkspaceRecord = Schema.Struct({
  name: Schema.String,
  /** The start that asked for the place; the same key adopts the same place. */
  requestId: RequestId,
  /** The origin repository's top level. */
  origin: Schema.String,
  /** The copy's root. */
  path: Schema.String,
  /** The child's working directory: the parent's place in the origin, inside the copy. */
  cwd: Schema.String,
  backend: WorkspaceBackend,
  /** The commit that holds the origin's working tree as the copy started. */
  base: Schema.String,
  createdAt: Schema.Finite,
  /** The last acquire or collect: a place idle past the prune age is removed. */
  touchedAt: Schema.Finite,
  sessionId: Schema.optionalKey(SessionId),
})
export type WorkspaceRecord = typeof WorkspaceRecord.Type

const recordCodec = Schema.fromJsonString(WorkspaceRecord)
const decodeRecord = Schema.decodeUnknownOption(recordCodec)
const encodeRecord = Schema.encodeSync(recordCodec)

/** A place as the delegate uses it. `notes` say, one line each, what the acquire did not do as asked. */
interface WorkspacePlace {
  readonly name: string
  readonly path: string
  readonly cwd: string
  readonly branch: string
  readonly backend: typeof WorkspaceBackend.Type
  readonly notes: ReadonlyArray<string>
}

/** What a collect found: the branch that holds the work, or none for a copy with no change. */
export interface CollectedWork {
  readonly path: string
  readonly branch: Option.Option<string>
  readonly files: number
  readonly insertions: number
  readonly deletions: number
}

/** The branch a place's work lands on in the origin. */
export const workspaceBranch = (name: string) => `gent/${name}`

/** A place nobody used for this long is removed; its branch stays. */
const PRUNE_AFTER = Duration.days(2)

/** Below this much free space where the copy lands, an acquire is refused. */
const DEFAULT_MINIMUM_FREE_BYTES = 2 * 1024 ** 3

const GIT_TIMEOUT = Duration.minutes(2)
const RIFT_TIMEOUT = Duration.minutes(10)
const HOOK_TIMEOUT = Duration.minutes(10)

// ── git ─────────────────────────────────────────────────────────────────────

interface GitOptions {
  /** Variables added to gent's own environment for this command. */
  readonly env: Record<string, string>
}

/** One git command in `cwd`; a non-zero exit fails with git's own words. */
const git = (cwd: string, args: ReadonlyArray<string>, options: GitOptions = { env: {} }) =>
  runProcess("git", ["-C", cwd, ...args], {
    env: options.env,
    extendEnv: true,
    timeout: GIT_TIMEOUT,
  }).pipe(
    Effect.mapError((error) => new WorkspaceError({ message: error.message })),
    Effect.flatMap((result) => {
      if (result.exitCode === 0) return Effect.succeed(result.stdout.trim())
      const reason = Option.fromUndefinedOr(result.stderr.trim().split("\n").at(-1)).pipe(
        Option.filter((line) => line.length > 0),
        Option.getOrElse(() => `exit ${result.exitCode}`),
      )
      return Effect.fail(
        new WorkspaceError({ message: `git ${args.slice(0, 1).join("")} failed: ${reason}` }),
      )
    }),
  )

/** A git read that may find nothing: none on any failure. */
const gitOption = (cwd: string, args: ReadonlyArray<string>) =>
  git(cwd, args).pipe(
    Effect.asSome,
    Effect.catchTag("WorkspaceError", () => Effect.succeedNone),
  )

/**
 * A repository with no identity still gets its commit, named for gent; one
 * with an identity keeps it.
 */
const identityArgs = Effect.fn("Workspaces.identityArgs")(function* (repo: string) {
  const name = yield* gitOption(repo, ["config", "user.name"])
  const email = yield* gitOption(repo, ["config", "user.email"])
  if (Option.isSome(name) && Option.isSome(email)) return []
  return ["-c", "user.name=gent", "-c", "user.email=gent@localhost"]
})

/**
 * The tree of a working tree as it is now: tracked changes and untracked
 * files git does not ignore. It runs on a private index (a copy of the live
 * one, so unchanged files are not hashed again), so the repository's own
 * index, `HEAD` and files stay untouched.
 */
const captureTree = Effect.fn("Workspaces.captureTree")(function* (repo: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs
    .makeTempDirectoryScoped({ prefix: "gent-index-" })
    .pipe(Effect.mapError((error) => new WorkspaceError({ message: error.message })))
  const index = path.join(directory, "index")
  const env = { GIT_INDEX_FILE: index }
  const live = path.resolve(repo, yield* git(repo, ["rev-parse", "--git-path", "index"]))
  const copied = yield* fs.copyFile(live, index).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )
  if (!copied) yield* git(repo, ["read-tree", "HEAD"], { env })
  yield* git(repo, ["add", "-A"], { env })
  return yield* git(repo, ["write-tree"], { env })
}, Effect.scoped)

/** One commit of `tree` over `parent`, made in `repo`. */
const commitTree = Effect.fn("Workspaces.commitTree")(function* (
  repo: string,
  tree: string,
  parent: string,
  message: string,
) {
  const identity = yield* identityArgs(repo)
  return yield* git(repo, [...identity, "commit-tree", tree, "-p", parent, "-m", message])
})

/** The origin's working tree as a commit: `HEAD` itself when nothing differs. */
const captureBase = Effect.fn("Workspaces.captureBase")(function* (origin: string, name: string) {
  const head = yield* git(origin, ["rev-parse", "--verify", "HEAD^{commit}"]).pipe(
    Effect.mapError(
      () =>
        new WorkspaceError({
          message: `Snapshot isolation needs a commit in ${origin}; the repository has none yet.`,
        }),
    ),
  )
  const tree = yield* captureTree(origin)
  const headTree = yield* git(origin, ["rev-parse", "HEAD^{tree}"])
  if (tree === headTree) return head
  return yield* commitTree(origin, tree, head, `gent: working tree of the parent of ${name}`)
})

/** `K files changed, N insertions(+), M deletions(-)`, as numbers. */
const parseShortStat = (text: string) => {
  const count = (pattern: RegExp) => Number(pattern.exec(text)?.[1] ?? 0)
  return {
    files: count(/(\d+) files? changed/),
    insertions: count(/(\d+) insertions?\(\+\)/),
    deletions: count(/(\d+) deletions?\(-\)/),
  }
}

// ── setup hooks ─────────────────────────────────────────────────────────────

const HOOK_TABLE = /^\[\[\s*hooks\.(precreate|postcreate|preremove|postremove)\s*\]\]\s*(#.*)?$/
const VERSION_LINE = /^version\s*=\s*(\d+)\s*(#.*)?$/
const RUN_LINE = /^run\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(#.*)?$/
const decodeBasicString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))

/** The first group of `pattern` in `line`, when the line matches. */
const captured = (pattern: RegExp, line: string) =>
  Option.fromNullishOr(pattern.exec(line)).pipe(
    Option.flatMap((match) => Option.fromUndefinedOr(match[1])),
  )

/** A TOML string's value: a literal string as written, a basic string read as JSON reads it. */
const tomlString = (quoted: string) =>
  Option.liftPredicate(quoted, (text) => text.startsWith("'")).pipe(
    Option.map((text) => text.slice(1, -1)),
    Option.orElse(() => decodeBasicString(quoted)),
  )

/**
 * The `postcreate` commands of a `.rift.toml`, read by hand: gent reads the
 * shape rift documents (`version = 1`, then `[[hooks.<name>]]` tables with one
 * `run` string each) and refuses any other line, as rift refuses unknown keys.
 */
export const riftPostcreateHooks = (
  text: string,
): Effect.Effect<ReadonlyArray<string>, WorkspaceError> =>
  Effect.gen(function* () {
    const hooks: Array<string> = []
    let table = Option.none<string>()
    let version = Option.none<number>()
    for (const [index, raw] of text.split("\n").entries()) {
      const line = raw.trim()
      if (line.length === 0 || line.startsWith("#")) continue
      const header = captured(HOOK_TABLE, line)
      if (Option.isSome(header)) {
        table = header
        continue
      }
      const versionValue = captured(VERSION_LINE, line)
      if (Option.isSome(versionValue) && Option.isNone(table)) {
        version = Option.map(versionValue, Number)
        continue
      }
      const run = captured(RUN_LINE, line)
      if (Option.isSome(run) && Option.isSome(table)) {
        const command = tomlString(run.value).pipe(
          Option.map((value) => value.trim()),
          Option.filter((value) => value.length > 0),
        )
        if (Option.isNone(command)) {
          return yield* new WorkspaceError({
            message: `.rift.toml line ${index + 1} has no command gent reads, so no postcreate hook ran`,
          })
        }
        if (table.value === "postcreate") hooks.push(command.value)
        continue
      }
      return yield* new WorkspaceError({
        message: `.rift.toml line ${index + 1} is not a form gent reads, so no postcreate hook ran`,
      })
    }
    if (!Option.contains(version, 1)) {
      return yield* new WorkspaceError({
        message: ".rift.toml does not say version = 1, so no postcreate hook ran",
      })
    }
    return hooks
  })

/**
 * Runs the copy's `postcreate` hooks as rift runs them: in the copy, with
 * `RIFT_SOURCE`, `RIFT_DESTINATION`, `RIFT_ID` and `RIFT_PARENT_ID`, in order,
 * stopping at the first that fails. A failure keeps the copy and is a note.
 */
const runPostcreate = Effect.fn("Workspaces.runPostcreate")(function* (
  origin: string,
  copy: string,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(copy, ".rift.toml")
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))))
    return Option.none<string>()
  const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
  const hooks = yield* riftPostcreateHooks(text).pipe(Effect.result)
  if (hooks._tag === "Failure") return Option.some(hooks.failure.message)
  for (const run of hooks.success) {
    const result = yield* runProcess("sh", ["-c", run], {
      cwd: copy,
      env: {
        RIFT_SOURCE: origin,
        RIFT_DESTINATION: copy,
        RIFT_ID: name,
        RIFT_PARENT_ID: "",
      },
      extendEnv: true,
      timeout: HOOK_TIMEOUT,
    }).pipe(Effect.result)
    if (result._tag === "Failure") {
      return Option.some(`postcreate hook "${run}" did not run: ${result.failure.message}`)
    }
    if (result.success.exitCode !== 0) {
      return Option.some(`postcreate hook "${run}" exited ${result.success.exitCode}`)
    }
  }
  return Option.none<string>()
})

// ── rift ────────────────────────────────────────────────────────────────────

/**
 * `rift rpc`'s answer. Only these keys are read: the command is hidden and
 * may change, and an answer that does not decode falls back to a worktree.
 */
const RiftAnswer = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ok"), value: Schema.Unknown }),
  Schema.Struct({
    status: Schema.Literal("error"),
    error: Schema.Struct({
      code: Schema.String,
      message: Schema.String,
      path: Schema.optionalKey(Schema.String),
      hook: Schema.optionalKey(Schema.String),
      committed: Schema.optionalKey(Schema.Boolean),
    }),
  }),
])
const decodeRiftAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(RiftAnswer))
/** The two `rift rpc` requests gent sends. */
const RiftRequest = Schema.Union([
  Schema.Struct({
    command: Schema.Literal("create"),
    from: Schema.String,
    name: Schema.String,
    copyAll: Schema.Boolean,
  }),
  Schema.Struct({ command: Schema.Literal("remove"), at: Schema.String }),
])
type RiftRequest = typeof RiftRequest.Type
const encodeRiftRequest = Schema.encodeSync(Schema.fromJsonString(RiftRequest))

/** One `rift rpc` call; a program that does not start or answers nothing readable fails. */
const riftCall = Effect.fn("Workspaces.riftCall")(function* (
  program: string,
  request: RiftRequest,
) {
  const result = yield* runProcess(program, ["rpc"], {
    stdin: Stream.make(new TextEncoder().encode(encodeRiftRequest(request))),
    timeout: RIFT_TIMEOUT,
  }).pipe(
    Effect.mapError(
      (error) => new WorkspaceError({ message: `rift did not run: ${error.message}` }),
    ),
  )
  return yield* Effect.fromOption(decodeRiftAnswer(result.stdout)).pipe(
    Effect.mapError(
      () =>
        new WorkspaceError({
          message: `rift gave no answer gent reads (exit ${result.exitCode})`,
        }),
    ),
  )
})

/** The file system type (`btrfs`, `xfs`, ...), or none where `stat -f` does not say. */
const fileSystemType = (directory: string) =>
  runProcess("stat", ["-f", "-c", "%T", directory], { timeout: GIT_TIMEOUT }).pipe(
    Effect.map((result) => Option.liftPredicate(result.stdout.trim(), () => result.exitCode === 0)),
    Effect.orElseSucceed(() => Option.none<string>()),
  )

/**
 * A rift copy of the origin: the whole tree (`copyAll`) on btrfs, where the
 * copy is one snapshot and the child starts with the dependencies and the
 * build; a filtered copy elsewhere, where rift reflinks file by file and the
 * `postcreate` hooks install. Fails with the one line that says why when
 * rift cannot copy; the caller then makes a worktree.
 */
const riftCopy = Effect.fn("Workspaces.riftCopy")(function* (
  program: string,
  origin: string,
  name: string,
) {
  const copyAll = Option.contains(yield* fileSystemType(origin), "btrfs")
  const answer = yield* riftCall(program, { command: "create", from: origin, name, copyAll })
  const noNotes: ReadonlyArray<string> = []
  if (answer.status === "ok") {
    if (Predicate.isString(answer.value)) return { path: answer.value, notes: noNotes }
    return yield* new WorkspaceError({ message: "rift answered no path" })
  }
  const { error } = answer
  const madePath = Option.fromUndefinedOr(error.path)
  // A failed `postcreate` leaves the copy registered: it is the child's, with a note.
  if (error.committed === true && error.hook === "postcreate" && Option.isSome(madePath)) {
    return { path: madePath.value, notes: [`postcreate hook failed: ${error.message}`] }
  }
  // A copy under this name is the one an earlier attempt of this start made.
  if (error.code === "already_exists" && Option.isSome(madePath)) {
    return { path: madePath.value, notes: noNotes }
  }
  return yield* new WorkspaceError({
    message: `rift could not copy (${error.code}): ${error.message}`,
  })
})

// ── worktree ────────────────────────────────────────────────────────────────

/**
 * A detached worktree of the origin's `HEAD` that holds the origin's working
 * tree as `base` holds it: tracked changes and untracked files arrive as
 * unstaged, the index is `HEAD`'s. No repository hook runs for these steps;
 * the `.rift.toml` hooks run after.
 */
const worktreeCopy = Effect.fn("Workspaces.worktreeCopy")(function* (
  origin: string,
  copy: string,
  base: string,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs
    .makeDirectory(path.dirname(copy), { recursive: true })
    .pipe(Effect.mapError((error) => new WorkspaceError({ message: error.message })))
  // A directory an interrupted attempt left holds no child's work yet.
  if (yield* fs.exists(copy).pipe(Effect.orElseSucceed(() => false))) {
    yield* removeWorktree(origin, copy)
  }
  yield* git(origin, [
    "-c",
    "core.hooksPath=/dev/null",
    "worktree",
    "add",
    "--detach",
    "--no-checkout",
    copy,
    "HEAD",
  ])
  yield* git(copy, ["read-tree", "-u", "--reset", `${base}^{tree}`])
  yield* git(copy, ["reset", "-q"])
  return Option.toArray(yield* runPostcreate(origin, copy, name))
})

const removeWorktree = Effect.fn("Workspaces.removeWorktree")(function* (
  origin: string,
  copy: string,
) {
  const fs = yield* FileSystem.FileSystem
  const removed = yield* git(origin, ["worktree", "remove", "--force", "--force", copy]).pipe(
    Effect.as(true),
    Effect.catchTag("WorkspaceError", () => Effect.succeed(false)),
  )
  if (removed) return
  yield* fs
    .remove(copy, { recursive: true, force: true })
    .pipe(Effect.mapError((error) => new WorkspaceError({ message: error.message })))
  yield* git(origin, ["worktree", "prune"]).pipe(Effect.ignore)
})

// ── places ──────────────────────────────────────────────────────────────────

export interface WorkspacesOptions {
  /** The rift program; `rift` on `PATH` by default. */
  readonly rift?: string
  /** Free bytes the copy's file system must keep; 2 GiB by default. */
  readonly minimumFreeBytes?: number
}

/** Free bytes on the file system that holds `directory`, from `df`; none when it does not say. */
const freeBytes = (directory: string) =>
  runProcess("df", ["-Pk", directory], { timeout: GIT_TIMEOUT }).pipe(
    Effect.map((result) => {
      const available = Number(result.stdout.trim().split("\n").at(-1)?.split(/\s+/)[3])
      return Option.liftPredicate(available * 1024, () => Number.isFinite(available))
    }),
    Effect.orElseSucceed(() => Option.none<number>()),
  )

const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1)

const makeWorkspaces = (options: WorkspacesOptions) => {
  const riftProgram = options.rift ?? "rift"
  const minimumFree = options.minimumFreeBytes ?? DEFAULT_MINIMUM_FREE_BYTES

  const directory = Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const path = yield* Path.Path
    return path.resolve(yield* resolveDataDir(ctx.home), "workspaces")
  })
  const recordFile = (name: string) =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      return path.join(yield* directory, `${name}.json`)
    })

  const readRecord = Effect.fn("Workspaces.readRecord")(function* (name: string) {
    const fs = yield* FileSystem.FileSystem
    const file = yield* recordFile(name)
    const text = yield* fs.readFileString(file).pipe(Effect.option)
    return Option.flatMap(text, decodeRecord)
  })

  const writeRecord = Effect.fn("Workspaces.writeRecord")(
    function* (record: WorkspaceRecord) {
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(yield* directory, { recursive: true })
      yield* writeFileAtomic(yield* recordFile(record.name), encodeRecord(record))
    },
    Effect.mapError((error) => new WorkspaceError({ message: error.message })),
  )

  const removeRecord = Effect.fn("Workspaces.removeRecord")(function* (name: string) {
    const fs = yield* FileSystem.FileSystem
    yield* fs
      .remove(yield* recordFile(name), { force: true })
      .pipe(Effect.mapError((error) => new WorkspaceError({ message: error.message })))
  })

  /** Every record on disk; a file that does not decode is not a place. */
  const records = Effect.fn("Workspaces.records")(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* directory
    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []))
    const found = yield* Effect.forEach(
      names.filter((file) => file.endsWith(".json")),
      (file) => readRecord(file.slice(0, -".json".length)),
    )
    return found.flatMap(Option.toArray)
  })

  /** Each place's operations hold its record's lock, so a collect never races a release. */
  const locked = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      return yield* ctx.FileLock.withLock(yield* recordFile(name), effect)
    })

  const nameOf = Effect.fn("Workspaces.nameOf")(function* (key: RequestId) {
    const crypto = yield* Crypto.Crypto
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(key))
    return `child-${Hex.encode(digest).slice(0, 12)}`
  })

  const placeOf = (record: WorkspaceRecord, notes: ReadonlyArray<string>): WorkspacePlace => ({
    name: record.name,
    path: record.path,
    cwd: record.cwd,
    branch: workspaceBranch(record.name),
    backend: record.backend,
    notes,
  })

  /** Refuses a copy where the file system holding `directory` is nearly full. */
  const requireSpace = Effect.fn("Workspaces.requireSpace")(function* (directory: string) {
    const free = yield* freeBytes(directory)
    if (Option.isNone(free)) return
    yield* Effect.logDebug("workspaces.free-space").pipe(
      Effect.annotateLogs({ directory, freeBytes: free.value }),
    )
    if (free.value >= minimumFree) return
    return yield* new WorkspaceError({
      message: `Only ${gib(free.value)} GB is free where the copy would go (${directory}); a snapshot child needs ${gib(minimumFree)} GB. Free some space, or start the child with isolation "shared".`,
    })
  })

  /** A copy of the origin by rift, else by worktree; the notes say why it is not rift's. */
  const makeCopy = Effect.fn("Workspaces.makeCopy")(function* (
    origin: string,
    name: string,
    base: string,
  ) {
    const path = yield* Path.Path
    yield* requireSpace(origin)
    const rift = yield* riftCopy(riftProgram, origin, name).pipe(Effect.result)
    if (rift._tag === "Success") {
      return { backend: "rift" as const, path: rift.success.path, notes: rift.success.notes }
    }
    const worktrees = path.join(yield* directory, "worktrees")
    const fs = yield* FileSystem.FileSystem
    yield* fs
      .makeDirectory(worktrees, { recursive: true })
      .pipe(Effect.mapError((error) => new WorkspaceError({ message: error.message })))
    yield* requireSpace(worktrees)
    const copy = path.join(worktrees, name)
    const hookNotes = yield* worktreeCopy(origin, copy, base, name)
    return {
      backend: "worktree" as const,
      path: copy,
      notes: [`a git worktree, because ${rift.failure.message}`, ...hookNotes],
    }
  })

  /**
   * A place for the start `key`, copied from the git repository that holds
   * `cwd`. The same key adopts the place it made before, so a repeated start
   * gets one copy.
   */
  const acquire = Effect.fn("Workspaces.acquire")(function* (input: {
    readonly key: RequestId
    readonly cwd: string
  }) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const origin = yield* git(input.cwd, ["rev-parse", "--show-toplevel"]).pipe(
      Effect.mapError(
        () =>
          new WorkspaceError({
            message: `Snapshot isolation needs a git repository, and ${input.cwd} is not in one.`,
          }),
      ),
    )
    const real = yield* fs
      .realPath(input.cwd)
      .pipe(Effect.mapError((error) => new WorkspaceError({ message: error.message })))
    const relative = path.relative(origin, real)
    const name = yield* nameOf(input.key)
    return yield* locked(
      name,
      Effect.gen(function* () {
        const existing = yield* readRecord(name)
        if (Option.isSome(existing)) {
          if (existing.value.requestId !== input.key) {
            return yield* new WorkspaceError({
              message: `Workspace ${name} belongs to another start`,
            })
          }
          if (yield* fs.exists(existing.value.path).pipe(Effect.orElseSucceed(() => false))) {
            return placeOf(existing.value, [])
          }
        }
        const base = yield* captureBase(origin, name)
        const copy = yield* makeCopy(origin, name, base)
        const now = yield* Clock.currentTimeMillis
        const record: WorkspaceRecord = {
          name,
          requestId: input.key,
          origin,
          path: copy.path,
          cwd: path.join(copy.path, relative),
          backend: copy.backend,
          base,
          createdAt: now,
          touchedAt: now,
        }
        yield* writeRecord(record)
        return placeOf(record, copy.notes)
      }),
    )
  })

  /** Names the child session that works in the place, so its delete releases it. */
  const bind = Effect.fn("Workspaces.bind")(function* (name: string, sessionId: SessionId) {
    yield* locked(
      name,
      Effect.gen(function* () {
        const record = yield* readRecord(name)
        if (Option.isNone(record)) {
          return yield* new WorkspaceError({ message: `Workspace ${name} has no record` })
        }
        yield* writeRecord({ ...record.value, sessionId })
      }),
    )
  })

  /** The place a session works in, if any. */
  const find = Effect.fn("Workspaces.find")(function* (sessionId: SessionId) {
    const all = yield* records()
    return Option.fromUndefinedOr(all.find((record) => record.sessionId === sessionId))
  })

  /**
   * The child's work as one commit over `base`, on `refs/heads/gent/<name>`
   * in the origin. A rift copy is a repository of its own, so the commit is
   * fetched; a worktree shares the origin's objects, so only the ref moves. A
   * work tree that matches `base` holds no work: the branch goes.
   */
  const collectRecord = Effect.fn("Workspaces.collectRecord")(function* (record: WorkspaceRecord) {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(record.path).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* new WorkspaceError({ message: `the copy at ${record.path} is gone` })
    }
    const branch = workspaceBranch(record.name)
    const ref = `refs/heads/${branch}`
    const tree = yield* captureTree(record.path)
    const baseTree = yield* git(record.origin, ["rev-parse", `${record.base}^{tree}`])
    yield* writeRecord({ ...record, touchedAt: yield* Clock.currentTimeMillis })
    if (tree === baseTree) {
      yield* git(record.origin, ["update-ref", "-d", ref]).pipe(Effect.ignore)
      return {
        path: record.path,
        branch: Option.none(),
        files: 0,
        insertions: 0,
        deletions: 0,
      } satisfies CollectedWork
    }
    const current = yield* gitOption(record.origin, [
      "rev-parse",
      "--verify",
      "-q",
      `${ref}^{commit}`,
    ])
    const reusable = yield* Option.match(current, {
      onNone: () => Effect.succeed(Option.none<string>()),
      onSome: (commit) =>
        gitOption(record.origin, ["rev-parse", `${commit}^{tree}`, `${commit}^`]).pipe(
          Effect.map((found) =>
            Option.flatMap(found, (lines) => {
              const [currentTree, parent] = lines.split("\n")
              return Option.liftPredicate(
                commit,
                () => currentTree === tree && parent === record.base,
              )
            }),
          ),
        ),
    })
    const commit = yield* Option.match(reusable, {
      onSome: Effect.succeed,
      onNone: () =>
        Effect.gen(function* () {
          const made = yield* commitTree(
            record.path,
            tree,
            record.base,
            `gent: work of child ${record.name}`,
          )
          if (record.backend === "worktree") {
            yield* git(record.origin, ["update-ref", ref, made])
            return made
          }
          yield* git(record.path, ["update-ref", "refs/gent/collected", made])
          yield* git(record.origin, [
            "fetch",
            "--no-tags",
            "--quiet",
            "--no-write-fetch-head",
            record.path,
            `+refs/gent/collected:${ref}`,
          ])
          return made
        }),
    })
    const stat = yield* git(record.origin, ["diff", "--shortstat", record.base, commit])
    return {
      path: record.path,
      branch: Option.some(branch),
      ...parseShortStat(stat),
    } satisfies CollectedWork
  })

  /** The work of the place a session works in; none when the session has no place. */
  const collect = Effect.fn("Workspaces.collect")(function* (sessionId: SessionId) {
    const found = yield* find(sessionId)
    if (Option.isNone(found)) return Option.none<CollectedWork>()
    return yield* locked(
      found.value.name,
      Effect.gen(function* () {
        const record = yield* readRecord(found.value.name)
        if (Option.isNone(record)) return Option.none<CollectedWork>()
        return Option.some(yield* collectRecord(record.value))
      }),
    )
  })

  /** Removes the copy and its record. Rift moves the copy to its trash; the branch stays. */
  const release = Effect.fn("Workspaces.release")(function* (name: string) {
    yield* locked(
      name,
      Effect.gen(function* () {
        const record = yield* readRecord(name)
        if (Option.isNone(record)) return
        const { origin, path: copy } = record.value
        if (record.value.backend === "worktree") {
          yield* removeWorktree(origin, copy)
        } else {
          const answer = yield* riftCall(riftProgram, { command: "remove", at: copy })
          if (
            answer.status === "error" &&
            !(answer.error.committed === true && answer.error.hook === "postremove")
          ) {
            return yield* new WorkspaceError({
              message: `rift could not remove ${copy} (${answer.error.code}): ${answer.error.message}`,
            })
          }
        }
        yield* removeRecord(name)
      }),
    )
  })

  /** A session's place goes with it, its last work collected first. */
  const releaseSession = Effect.fn("Workspaces.releaseSession")(function* (sessionId: SessionId) {
    const found = yield* find(sessionId)
    if (Option.isNone(found)) return
    yield* collect(sessionId).pipe(
      Effect.catchTag("WorkspaceError", (error) =>
        Effect.logWarning("workspaces.collect.failed").pipe(
          Effect.annotateLogs({ name: found.value.name, error: error.message }),
        ),
      ),
    )
    yield* release(found.value.name)
  })

  /**
   * Removes each place idle past `PRUNE_AFTER` whose child is not running: its
   * work is on its branch, collected at its last turn end and once more here.
   * Ignored files (dependencies, build output) go with the copy.
   */
  const prune = Effect.fn("Workspaces.prune")(function* () {
    const ctx = yield* ExtensionContext
    const now = yield* Clock.currentTimeMillis
    const idle = (yield* records()).filter(
      (record) => now - record.touchedAt > Duration.toMillis(PRUNE_AFTER),
    )
    if (idle.length === 0) return
    const running = new Set(
      (yield* ctx.Session.listActiveLoops.pipe(Effect.orElseSucceed(() => [])))
        .filter((loop) => Option.isSome(loop.runningSince))
        .map((loop) => loop.sessionId),
    )
    yield* Effect.forEach(
      idle,
      (record) => {
        const owner = Option.fromUndefinedOr(record.sessionId)
        if (Option.exists(owner, (sessionId) => running.has(sessionId))) return Effect.void
        const remove = Option.match(owner, {
          onNone: () => release(record.name),
          onSome: releaseSession,
        })
        return remove.pipe(
          Effect.catchTag("WorkspaceError", (error) =>
            Effect.logWarning("workspaces.prune.failed").pipe(
              Effect.annotateLogs({ name: record.name, error: error.message }),
            ),
          ),
        )
      },
      { discard: true },
    )
  })

  return { acquire, bind, find, collect, release, releaseSession, prune }
}

type WorkspacesApi = ReturnType<typeof makeWorkspaces>

/**
 * The places service. The delegate reads it with `Effect.serviceOption`, so
 * snapshot children exist only where `@gent/workspaces` is active.
 *
 * Its methods run in their caller's leaf or hook: the caller's
 * `ExtensionContext` names the data directory's home and holds the file lock,
 * and a process resource builds before any leaf runs.
 *
 * @effect-expect-leaking ExtensionContext | FileSystem | Path | ChildProcessSpawner | Crypto
 */
export class Workspaces extends Context.Service<Workspaces, WorkspacesApi>()(
  "@gent/extensions/src/workspaces",
) {}

/** Test seam: the service as the extension builds it, for tests that drive the backends. */
export const workspacesService = (options: WorkspacesOptions = {}): WorkspacesApi =>
  makeWorkspaces(options)

// ── extension ───────────────────────────────────────────────────────────────

export const WORKSPACES_EXTENSION_ID = ExtensionId.make("@gent/workspaces")

/** A hook step that fails logs and ends: a place left behind is pruned later. */
const logged =
  (event: string) =>
  <R>(step: Effect.Effect<void, WorkspaceError, R>) =>
    step.pipe(
      Effect.catchTag("WorkspaceError", (error) =>
        Effect.logWarning(event).pipe(Effect.annotateLogs({ error: error.message })),
      ),
    )

/** Places for snapshot children. `options` name the rift program and the free-space floor. */
export const makeWorkspacesExtension = (options: WorkspacesOptions = {}) =>
  defineExtension({
    id: WORKSPACES_EXTENSION_ID,
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      yield* host.register(
        "resource",
        defineResource({
          id: "@gent/workspaces/places",
          scope: "process",
          layer: Layer.succeed(Workspaces, Workspaces.of(makeWorkspaces(options))),
        }),
      )
      // Each turn end of a child brings its work back, so the branch follows a later turn too.
      yield* host.on("turnAfter", ({ sessionId }) =>
        Effect.flatMap(Workspaces, (places) =>
          places.collect(sessionId).pipe(Effect.asVoid, logged("workspaces.collect.failed")),
        ),
      )
      yield* host.on("sessionDeleted", ({ sessionId }) =>
        Effect.flatMap(Workspaces, (places) =>
          places.releaseSession(sessionId).pipe(logged("workspaces.release.failed")),
        ),
      )
      yield* host.on("loopOpen", () =>
        Effect.flatMap(Workspaces, (places) =>
          places.prune().pipe(logged("workspaces.prune.failed")),
        ),
      )
    }),
  })

export const WorkspacesExtension = makeWorkspacesExtension()
