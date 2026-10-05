/**
 * Private places for child agents: a copy of a session's working tree that a
 * child edits, whose work comes back to the origin repository as one branch.
 *
 * The delegate asks for a place when a start names `isolation: "snapshot"`
 * and creates the child session with its `cwd` inside the copy, so the child's
 * profile, tools, shell and cell all run there. On btrfs, where a whole-tree
 * copy is one snapshot, `rift` makes the copy (`rift rpc`, a process, never
 * its FFI; gent never runs `rift init` or `rift gc`). Everywhere else, and
 * when rift fails, gent makes a `git worktree add --detach` with the origin's
 * uncommitted state. gent runs the `.rift.toml` `postcreate` hooks in the copy
 * for both. A copy is not a sandbox: the child still reaches every path on
 * the machine.
 *
 * Work comes back at each child turn end: the copy's committed and
 * uncommitted work, as one commit over the copy's state after its hooks
 * (`base`), on `refs/heads/gent/<name>` of the origin. gent moves that branch
 * only from the commit it last wrote (compare and swap), and never while a
 * worktree has it checked out. Nothing is merged. A place lives as long as its
 * child session.
 *
 * One record per place under `<data directory>/workspaces/<name>.json`,
 * written before gent makes the copy, and an ownership marker in the copy's
 * git directory written after. gent adopts or removes a copy only when the
 * two agree; any other directory it keeps.
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
  Result,
  Schema,
  Stream,
} from "effect"
import { Hex } from "effect/encoding"
import {
  BranchId,
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

/** What one collect found. `branch` is absent when the copy holds no work. */
const CollectedWorkSchema = Schema.Struct({
  /** The branch that holds the work. */
  branch: Schema.optionalKey(Schema.String),
  files: Schema.Finite,
  insertions: Schema.Finite,
  deletions: Schema.Finite,
  /** Why the work is not on the branch: someone else moved it, or a worktree has it checked out. */
  problem: Schema.optionalKey(Schema.String),
})

/** One place on disk, and the child session that works in it once one does. */
const WorkspaceRecord = Schema.Struct({
  name: Schema.String,
  /** The start that asked for the place: its parent session and branch, and its tool call. */
  parentSessionId: SessionId,
  parentBranchId: BranchId,
  requestId: RequestId,
  /** The origin repository's top level, resolved. */
  origin: Schema.String,
  /** The copy's root, decided before gent makes it. */
  path: Schema.String,
  /** The child's working directory: the parent's place in the origin, inside the copy. */
  cwd: Schema.String,
  backend: WorkspaceBackend,
  /** `creating` until the copy, its marker, its hooks and its base are all in place. */
  phase: Schema.Literals(["creating", "ready"]),
  /** The commit that holds the copy as its hooks left it; the child's work is the diff from it. */
  base: Schema.optionalKey(Schema.String),
  /** What the copy did not do as asked, one line each. */
  notes: Schema.Array(Schema.String),
  createdAt: Schema.Finite,
  sessionId: Schema.optionalKey(SessionId),
  /** The commit gent last wrote to the branch. */
  tip: Schema.optionalKey(Schema.String),
  /** A commit gent is writing to the branch now; a crash can leave the branch on it. */
  nextTip: Schema.optionalKey(Schema.String),
  /** The last collect and the turn it ran for, so a second collect of one turn reads it. */
  collected: Schema.optionalKey(Schema.Struct({ turn: Schema.String, work: CollectedWorkSchema })),
})
type WorkspaceRecord = typeof WorkspaceRecord.Type

const recordCodec = Schema.fromJsonString(WorkspaceRecord)
const decodeRecord = Schema.decodeUnknownOption(recordCodec)
const encodeRecord = Schema.encodeSync(recordCodec)

type Work = typeof CollectedWorkSchema.Type

/** A place as the delegate uses it. `notes` say, one line each, what the acquire did not do as asked. */
interface WorkspacePlace {
  readonly name: string
  readonly path: string
  readonly cwd: string
  readonly branch: string
  readonly backend: typeof WorkspaceBackend.Type
  readonly notes: ReadonlyArray<string>
}

/** What a collect found, and the copy it came from. */
export interface CollectedWork extends Schema.Schema.Type<typeof CollectedWorkSchema> {
  readonly path: string
}

/** The branch a place's work lands on in the origin. */
const workspaceBranch = (name: string) => `gent/${name}`

/** Below this much free space where the copy lands, an acquire is refused. */
const DEFAULT_MINIMUM_FREE_BYTES = 2 * 1024 ** 3

const GIT_TIMEOUT = Duration.minutes(2)
const RIFT_TIMEOUT = Duration.minutes(10)
const HOOK_TIMEOUT = Duration.minutes(10)

/** The ownership marker in a copy's git directory: the digest of the record's identity. */
const MARKER_FILE = "gent-workspace"

// ── git ─────────────────────────────────────────────────────────────────────

/**
 * Settings for every git command gent runs: no repository hook (a hook in the
 * origin must not run for gent's own plumbing) and no automatic maintenance.
 */
const QUIET_GIT = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "maintenance.auto=false",
  "-c",
  "gc.auto=0",
]

interface GitOptions {
  /** Variables added to gent's own environment for this command. */
  readonly env: Record<string, string>
}

/** One git command in `cwd`; a non-zero exit fails with git's own words. */
const git = (cwd: string, args: ReadonlyArray<string>, options: GitOptions = { env: {} }) =>
  runProcess("git", ["-C", cwd, ...QUIET_GIT, ...args], {
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

/** A working tree as a commit: `HEAD` itself when nothing differs. */
const captureBase = Effect.fn("Workspaces.captureBase")(function* (repo: string, name: string) {
  const head = yield* git(repo, ["rev-parse", "--verify", "HEAD^{commit}"])
  const tree = yield* captureTree(repo)
  const headTree = yield* git(repo, ["rev-parse", "HEAD^{tree}"])
  if (tree === headTree) return head
  return yield* commitTree(repo, tree, head, `gent: the copy ${name} as it started`)
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

/** The worktree that has `ref` checked out, if one does. */
const checkedOutAt = Effect.fn("Workspaces.checkedOutAt")(function* (origin: string, ref: string) {
  const listing = yield* git(origin, ["worktree", "list", "--porcelain"])
  let worktree = ""
  for (const line of listing.split("\n")) {
    if (line.startsWith("worktree ")) worktree = line.slice("worktree ".length)
    if (line === `branch ${ref}`) return Option.some(worktree)
  }
  return Option.none<string>()
})

// ── setup hooks ─────────────────────────────────────────────────────────────

/** A `.rift.toml` as rift reads it: unknown keys are refused, and every `run` must say something. */
const RiftHookList = Schema.optionalKey(Schema.Array(Schema.Struct({ run: Schema.String })))
const RiftConfig = Schema.Struct({
  version: Schema.Int,
  hooks: Schema.optionalKey(
    Schema.Struct({
      precreate: RiftHookList,
      postcreate: RiftHookList,
      preremove: RiftHookList,
      postremove: RiftHookList,
    }),
  ),
})
const decodeRiftConfig = Schema.decodeUnknownResult(RiftConfig)

/**
 * The `postcreate` commands of a `.rift.toml`, checked as rift checks the
 * file: TOML, `version = 1`, only the four hook lists, each step one
 * non-empty `run`.
 */
const riftPostcreateHooks = (text: string): Result.Result<ReadonlyArray<string>, string> => {
  // oxlint-disable-next-line effect/noGlobals -- Pure TOML parse with no Effect platform service; gent ships as a Bun binary.
  const parsed = Result.try(() => Bun.TOML.parse(text))
  if (Result.isFailure(parsed)) return Result.fail(`it is not TOML: ${String(parsed.failure)}`)
  const config = decodeRiftConfig(parsed.success, { onExcessProperty: "error" })
  if (Result.isFailure(config)) return Result.fail(config.failure.message)
  if (config.success.version !== 1) {
    return Result.fail(`version ${config.success.version} is not one gent reads`)
  }
  const hooks = config.success.hooks ?? {}
  const steps = [hooks.precreate, hooks.postcreate, hooks.preremove, hooks.postremove]
  if (steps.some((list) => (list ?? []).some((step) => step.run.trim().length === 0))) {
    return Result.fail("a hook's run is empty")
  }
  return Result.succeed((hooks.postcreate ?? []).map((step) => step.run.trim()))
}

/** The variables rift gives its hooks. */
interface HookIds {
  readonly id: string
  readonly parentId: string
}

/**
 * Runs the copy's `postcreate` hooks as rift runs them: in the copy, with
 * `RIFT_SOURCE`, `RIFT_DESTINATION`, `RIFT_ID` and `RIFT_PARENT_ID`, in order,
 * stopping at the first that fails. A failure keeps the copy and is a note.
 */
const runPostcreate = Effect.fn("Workspaces.runPostcreate")(function* (
  origin: string,
  copy: string,
  ids: HookIds,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(copy, ".rift.toml")
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))))
    return Option.none<string>()
  const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
  const hooks = riftPostcreateHooks(text)
  if (Result.isFailure(hooks)) {
    return Option.some(`.rift.toml is not valid (${hooks.failure}), so no postcreate hook ran`)
  }
  for (const run of hooks.success) {
    const result = yield* runProcess("sh", ["-c", run], {
      cwd: copy,
      env: {
        RIFT_SOURCE: origin,
        RIFT_DESTINATION: copy,
        RIFT_ID: ids.id,
        RIFT_PARENT_ID: ids.parentId,
      },
      extendEnv: true,
      timeout: HOOK_TIMEOUT,
    }).pipe(Effect.result)
    if (Result.isFailure(result)) {
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
 * may change, and an answer that does not decode is a failure.
 */
const RiftAnswer = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ok"), value: Schema.Unknown }),
  Schema.Struct({
    status: Schema.Literal("error"),
    error: Schema.Struct({
      code: Schema.String,
      message: Schema.String,
      hook: Schema.optionalKey(Schema.String),
      committed: Schema.optionalKey(Schema.Boolean),
    }),
  }),
])
const decodeRiftAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(RiftAnswer))
const decodePaths = Schema.decodeUnknownOption(Schema.Array(Schema.String))

/** The `rift rpc` requests gent sends. */
const RiftRequest = Schema.Union([
  Schema.Struct({ command: Schema.Literal("ancestors"), of: Schema.String }),
  Schema.Struct({ command: Schema.Literal("descendants"), of: Schema.String }),
  Schema.Struct({
    command: Schema.Literal("create"),
    from: Schema.String,
    name: Schema.String,
    into: Schema.String,
    copyAll: Schema.Boolean,
    /** False: rift runs no hook; gent runs `postcreate` in the copy itself. */
    hooks: Schema.Boolean,
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

/** A `rift rpc` call that answers paths. */
const riftPaths = Effect.fn("Workspaces.riftPaths")(function* (
  program: string,
  request: RiftRequest,
) {
  const answer = yield* riftCall(program, request)
  if (answer.status === "error") {
    return yield* new WorkspaceError({
      message: `rift ${request.command} failed (${answer.error.code}): ${answer.error.message}`,
    })
  }
  return yield* Effect.fromOption(decodePaths(answer.value)).pipe(
    Effect.mapError(
      () => new WorkspaceError({ message: `rift ${request.command} answered no paths` }),
    ),
  )
})

/** The file system type (`btrfs`, `xfs`, ...), or none where `stat -f` does not say. */
const fileSystemType = (directory: string) =>
  runProcess("stat", ["-f", "-c", "%T", directory], { timeout: GIT_TIMEOUT }).pipe(
    Effect.map((result) => Option.liftPredicate(result.stdout.trim(), () => result.exitCode === 0)),
    Effect.orElseSucceed(() => Option.none<string>()),
  )

/** A rift workspace's id, from the marker rift keeps at its root. */
const riftId = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return yield* fs.readFileString(path.join(directory, ".rift")).pipe(
      Effect.map((text) => text.trim()),
      Effect.option,
    )
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
      const available = Number(result.stdout.trim().split("\n").at(-1)?.split(/\s+/)[3] ?? "")
      return Option.liftPredicate(
        available * 1024,
        () => result.exitCode === 0 && Number.isFinite(available),
      )
    }),
    Effect.orElseSucceed(() => Option.none<number>()),
  )

const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1)

/** `inner` lies inside `outer` (and is not `outer` itself). */
const inside = (path: Path.Path, inner: string, outer: string) => {
  const relative = path.relative(outer, inner)
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
}

/** Where a start's copy comes from, and the name its identity gives it. */
interface WorkspaceStart {
  readonly name: string
  /** The digest of the identity; the copy's marker holds it. */
  readonly digest: string
  readonly parentSessionId: SessionId
  readonly parentBranchId: BranchId
  readonly requestId: RequestId
  readonly origin: string
  /** The parent's cwd, relative to the origin. */
  readonly relative: string
}

const makeWorkspaces = (options: WorkspacesOptions) => {
  const riftProgram = options.rift ?? "rift"
  const minimumFree = options.minimumFreeBytes ?? DEFAULT_MINIMUM_FREE_BYTES

  const directory = Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const path = yield* Path.Path
    return path.resolve(yield* resolveDataDir(ctx.home), "workspaces")
  })
  const inDirectory = (...parts: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      return path.join(yield* directory, ...parts)
    })
  const recordFile = (name: string) => inDirectory(`${name}.json`)
  /** The session index: one small file per bound session, so a turn of a session with no copy reads one missing file. */
  const linkFile = (sessionId: SessionId) => inDirectory("sessions", encodeURIComponent(sessionId))
  const worktreePath = (name: string) => inDirectory("worktrees", name)

  const asError = Effect.mapError(
    (error: { readonly message: string }) => new WorkspaceError({ message: error.message }),
  )

  /** The record under `name`: none when there is no file; a file that does not decode is kept and fails. */
  const readRecord = Effect.fn("Workspaces.readRecord")(function* (name: string) {
    const fs = yield* FileSystem.FileSystem
    const file = yield* recordFile(name)
    const text = yield* fs.readFileString(file).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeedNone,
      ),
      asError,
    )
    if (Option.isNone(text)) return Option.none<WorkspaceRecord>()
    const record = decodeRecord(text.value)
    if (Option.isNone(record)) {
      return yield* new WorkspaceError({
        message: `the workspace record ${file} is not one gent reads; gent keeps it and its copy`,
      })
    }
    return record
  })

  /** Writes a record whole. A write is not cut by an interrupt: the record on disk is always one gent wrote. */
  const publish = (record: WorkspaceRecord) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(yield* directory, { recursive: true })
      yield* writeFileAtomic(yield* recordFile(record.name), encodeRecord(record))
    }).pipe(asError, Effect.uninterruptible)

  /** Each place's operations hold its record's lock, so a collect never races a release. */
  const locked = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      return yield* ctx.FileLock.withLock(yield* recordFile(name), effect)
    })

  const digestOf = Effect.fn("Workspaces.digestOf")(function* (identity: {
    readonly parentSessionId: string
    readonly parentBranchId: string
    readonly requestId: string
    readonly origin: string
  }) {
    const crypto = yield* Crypto.Crypto
    const text = [
      identity.parentSessionId,
      identity.parentBranchId,
      identity.requestId,
      identity.origin,
    ].join("\n")
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(text)).pipe(asError)
    return Hex.encode(digest)
  })
  const nameOfDigest = (digest: string) => `child-${digest.slice(0, 12)}`

  const placeOf = (record: WorkspaceRecord, notes: ReadonlyArray<string>): WorkspacePlace => ({
    name: record.name,
    path: record.path,
    cwd: record.cwd,
    branch: workspaceBranch(record.name),
    backend: record.backend,
    notes,
  })

  /** Refuses a copy where the file system holding `at` is nearly full, or says nothing of its space. */
  const requireSpace = Effect.fn("Workspaces.requireSpace")(function* (at: string) {
    const free = yield* freeBytes(at)
    if (Option.isNone(free)) {
      return yield* new WorkspaceError({
        message: `gent cannot tell how much space is free where the copy would go (${at}), so it makes no copy. Start the child with isolation "shared".`,
      })
    }
    yield* Effect.logDebug("workspaces.free-space").pipe(
      Effect.annotateLogs({ directory: at, freeBytes: free.value }),
    )
    if (free.value >= minimumFree) return
    return yield* new WorkspaceError({
      message: `Only ${gib(free.value)} GB is free where the copy would go (${at}); a snapshot child needs ${gib(minimumFree)} GB. Free some space, or start the child with isolation "shared".`,
    })
  })

  // ── ownership ──

  /** Why gent may not touch the record's path, if it may not. */
  const unsafePath = Effect.fn("Workspaces.unsafePath")(function* (record: WorkspaceRecord) {
    const path = yield* Path.Path
    const copy = record.path
    if (!path.isAbsolute(copy) || copy === record.origin) return Option.some("it is the origin")
    if (inside(path, record.origin, copy) || inside(path, copy, record.origin)) {
      return Option.some("it overlaps the origin")
    }
    if (path.basename(copy) !== record.name) return Option.some("its name is not the record's")
    if (record.backend === "worktree" && copy !== (yield* worktreePath(record.name))) {
      return Option.some("it is not in gent's worktrees directory")
    }
    return Option.none<string>()
  })

  /** The copy's git directory, when `copy` is the top level of a repository. */
  const gitDirectory = Effect.fn("Workspaces.gitDirectory")(function* (copy: string) {
    const fs = yield* FileSystem.FileSystem
    const real = yield* fs.realPath(copy).pipe(Effect.option)
    const lines = yield* gitOption(copy, ["rev-parse", "--show-toplevel", "--absolute-git-dir"])
    return Option.flatMap(lines, (text) => {
      const [top, gitDir] = text.split("\n")
      if (Predicate.isUndefined(top) || Predicate.isUndefined(gitDir)) return Option.none<string>()
      return Option.liftPredicate(gitDir, () => Option.contains(real, top))
    })
  })

  const markerFile = Effect.fn("Workspaces.markerFile")(function* (copy: string) {
    const path = yield* Path.Path
    return Option.map(yield* gitDirectory(copy), (gitDir) => path.join(gitDir, MARKER_FILE))
  })

  /**
   * Whether the record's copy is gent's: `absent` when nothing is at its
   * path, `owned` when the copy's marker holds the record's identity. Any
   * other path or directory is kept, and the call fails with why.
   */
  const ownership = Effect.fn("Workspaces.ownership")(function* (record: WorkspaceRecord) {
    const fs = yield* FileSystem.FileSystem
    const kept = (why: string) =>
      new WorkspaceError({ message: `gent keeps ${record.path} (${record.name}): ${why}` })
    const digest = yield* digestOf(record)
    if (nameOfDigest(digest) !== record.name) return yield* kept("the record's identity changed")
    const unsafe = yield* unsafePath(record)
    if (Option.isSome(unsafe)) return yield* kept(unsafe.value)
    if (!(yield* fs.exists(record.path).pipe(asError))) return "absent" as const
    const marker = yield* markerFile(record.path)
    if (Option.isNone(marker)) return yield* kept("it is not a git repository's top level")
    const text = yield* fs.readFileString(marker.value).pipe(Effect.option)
    if (
      !Option.contains(
        Option.map(text, (value) => value.trim()),
        digest,
      )
    ) {
      return yield* kept("it holds no marker of this start")
    }
    return "owned" as const
  })

  /** Writes the ownership marker into the new copy's git directory. */
  const writeMarker = Effect.fn("Workspaces.writeMarker")(function* (record: WorkspaceRecord) {
    const marker = yield* markerFile(record.path)
    if (Option.isNone(marker)) {
      return yield* new WorkspaceError({ message: `${record.path} is not a git repository` })
    }
    yield* writeFileAtomic(marker.value, `${yield* digestOf(record)}\n`).pipe(
      asError,
      Effect.uninterruptible,
    )
  })

  // ── making a copy ──

  /**
   * Where rift would put the copy, when rift is the backend: the origin is a
   * rift workspace on btrfs, where a whole-tree copy is one snapshot. Else
   * the one line that says why the copy is a worktree.
   */
  const riftStorage = Effect.fn("Workspaces.riftStorage")(function* (origin: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const type = yield* fileSystemType(origin)
    if (!Option.contains(type, "btrfs")) {
      return Result.fail(
        `the origin's file system is ${Option.getOrElse(type, () => "unknown")}, not btrfs`,
      )
    }
    if (!(yield* fs.exists(path.join(origin, ".rift")).pipe(Effect.orElseSucceed(() => false)))) {
      return Result.fail("the origin is not a rift workspace")
    }
    const ancestors = yield* riftPaths(riftProgram, { command: "ancestors", of: origin }).pipe(
      Effect.result,
    )
    if (Result.isFailure(ancestors)) return Result.fail(ancestors.failure.message)
    const root = ancestors.success.at(-1) ?? origin
    return Result.succeed(path.join(path.dirname(root), ".rifts", path.basename(root)))
  })

  /** A rift copy at `record.path`, without rift's hooks. */
  const riftCopy = Effect.fn("Workspaces.riftCopy")(function* (record: WorkspaceRecord) {
    const path = yield* Path.Path
    const answer = yield* riftCall(riftProgram, {
      command: "create",
      from: record.origin,
      name: record.name,
      into: path.dirname(record.path),
      copyAll: true,
      hooks: false,
    })
    if (answer.status === "error") {
      return yield* new WorkspaceError({
        message: `rift could not copy (${answer.error.code}): ${answer.error.message}`,
      })
    }
    if (answer.value !== record.path) {
      return yield* new WorkspaceError({
        message: `rift made the copy at ${String(answer.value)}, not at ${record.path}; gent keeps it and does not use it`,
      })
    }
  })

  /** A detached worktree of the origin's `HEAD`, not yet checked out. No repository hook runs. */
  const addWorktree = Effect.fn("Workspaces.addWorktree")(function* (record: WorkspaceRecord) {
    yield* git(record.origin, [
      "worktree",
      "add",
      "--force",
      "--detach",
      "--no-checkout",
      record.path,
      "HEAD",
    ])
  })

  /**
   * Fills a new worktree with the origin's working tree: tracked changes and
   * untracked files arrive as unstaged, the index is `HEAD`'s.
   */
  const fillWorktree = Effect.fn("Workspaces.fillWorktree")(function* (record: WorkspaceRecord) {
    const tree = yield* captureTree(record.origin)
    yield* git(record.path, ["read-tree", "-u", "--reset", tree])
    yield* git(record.path, ["reset", "-q"])
  })

  /** The base commit stays reachable while the copy lives: a private ref in the repository that holds it. */
  const baseRef = (record: WorkspaceRecord) => {
    if (record.backend === "worktree") {
      return { repo: record.origin, ref: `refs/gent/base/${record.name}` }
    }
    return { repo: record.path, ref: "refs/gent/base" }
  }

  /**
   * Makes the copy for a start whose record is `creating`: the record is
   * written first, so a crash at any later step leaves a record that names
   * the path. Then the copy, its marker, its hooks and its base; `ready` last.
   */
  const create = Effect.fn("Workspaces.create")(function* (start: WorkspaceStart) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const now = yield* Clock.currentTimeMillis
    const storage = yield* riftStorage(start.origin)
    const worktrees = yield* inDirectory("worktrees")
    const atPath = (backend: typeof WorkspaceBackend.Type, copy: string): WorkspaceRecord => ({
      name: start.name,
      parentSessionId: start.parentSessionId,
      parentBranchId: start.parentBranchId,
      requestId: start.requestId,
      origin: start.origin,
      path: copy,
      cwd: path.join(copy, start.relative),
      backend,
      phase: "creating",
      notes: [],
      createdAt: now,
    })
    let notes: ReadonlyArray<string> = []
    let record = atPath("worktree", path.join(worktrees, start.name))
    if (Result.isSuccess(storage)) {
      yield* requireSpace(start.origin)
      record = atPath("rift", path.join(storage.success, start.name))
      yield* publish(record)
      const made = yield* riftCopy(record).pipe(Effect.result)
      if (Result.isFailure(made)) {
        // A failed rift that still left a directory there: gent keeps it.
        if (yield* fs.exists(record.path).pipe(asError)) return yield* made.failure
        notes = [`a git worktree, because ${made.failure.message}`]
        record = atPath("worktree", path.join(worktrees, start.name))
      }
    } else {
      notes = [`a git worktree, because ${storage.failure}`]
    }
    if (record.backend === "worktree") {
      yield* fs.makeDirectory(worktrees, { recursive: true }).pipe(asError)
      yield* requireSpace(worktrees)
      yield* publish(record)
      yield* addWorktree(record)
    }
    // The marker goes in first, so a failure or a crash after it leaves a copy gent can remove.
    yield* writeMarker(record)
    if (record.backend === "worktree") yield* fillWorktree(record)
    const ids: HookIds = {
      id: Option.getOrElse(yield* riftId(record.path), () => record.name),
      parentId: Option.getOrElse(yield* riftId(record.origin), () => ""),
    }
    const hookNote = yield* runPostcreate(record.origin, record.path, ids)
    const base = yield* captureBase(record.path, record.name)
    const held = baseRef(record)
    yield* git(held.repo, ["update-ref", held.ref, base])
    const ready: WorkspaceRecord = {
      ...record,
      phase: "ready",
      base,
      notes: [...notes, ...Option.toArray(hookNote)],
    }
    yield* publish(ready)
    return ready
  })

  // ── removing a copy ──

  /** Removes an owned copy. Any failure keeps the copy: gent never deletes a copy git or rift would not. */
  const removeCopy = Effect.fn("Workspaces.removeCopy")(function* (record: WorkspaceRecord) {
    const kept = (why: string) =>
      new WorkspaceError({ message: `gent keeps the copy ${record.path}: ${why}` })
    if (record.backend === "worktree") {
      return yield* git(record.origin, [
        "worktree",
        "remove",
        "--force",
        "--force",
        record.path,
      ]).pipe(
        Effect.asVoid,
        Effect.mapError((error) => kept(error.message)),
      )
    }
    const descendants = yield* riftPaths(riftProgram, {
      command: "descendants",
      of: record.path,
    }).pipe(Effect.mapError((error) => kept(error.message)))
    if (descendants.length > 0) {
      return yield* kept(`rift copies were made from it: ${descendants.join(", ")}`)
    }
    const answer = yield* riftCall(riftProgram, { command: "remove", at: record.path }).pipe(
      Effect.mapError((error) => kept(error.message)),
    )
    if (answer.status === "ok") return
    // A failed `postremove` runs after the copy went to rift's trash.
    if (answer.error.committed === true && answer.error.hook === "postremove") return
    return yield* kept(`rift could not remove it (${answer.error.code}): ${answer.error.message}`)
  })

  /** Drops what gent keeps for a copy that is gone: the base ref, the session index, the record. */
  const forget = Effect.fn("Workspaces.forget")(function* (record: WorkspaceRecord) {
    const fs = yield* FileSystem.FileSystem
    if (record.backend === "worktree" && Predicate.isNotUndefined(record.base)) {
      const held = baseRef(record)
      yield* git(held.repo, ["update-ref", "-d", held.ref, record.base]).pipe(Effect.ignore)
    }
    if (Predicate.isNotUndefined(record.sessionId)) {
      yield* fs.remove(yield* linkFile(record.sessionId), { force: true }).pipe(asError)
    }
    yield* fs.remove(yield* recordFile(record.name), { force: true }).pipe(asError)
  }, Effect.uninterruptible)

  // ── acquire and bind ──

  /** Where the copy for the start `key` from `cwd` comes from, and its name. The parent is the caller's session and branch. */
  const locate = Effect.fn("Workspaces.locate")(function* (input: {
    readonly key: RequestId
    readonly cwd: string
  }) {
    const ctx = yield* ExtensionContext
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const top = yield* git(input.cwd, ["rev-parse", "--show-toplevel"]).pipe(
      Effect.mapError(
        () =>
          new WorkspaceError({
            message: `Snapshot isolation needs a git repository, and ${input.cwd} is not in one.`,
          }),
      ),
    )
    yield* git(top, ["rev-parse", "--verify", "HEAD^{commit}"]).pipe(
      Effect.mapError(
        () =>
          new WorkspaceError({
            message: `Snapshot isolation needs a commit in ${top}; the repository has none yet.`,
          }),
      ),
    )
    const origin = yield* fs.realPath(top).pipe(asError)
    const real = yield* fs.realPath(input.cwd).pipe(asError)
    const identity = {
      parentSessionId: ctx.sessionId,
      parentBranchId: ctx.branchId,
      requestId: input.key,
      origin,
    }
    const digest = yield* digestOf(identity)
    const start: WorkspaceStart = {
      ...identity,
      name: nameOfDigest(digest),
      digest,
      relative: path.relative(origin, real),
    }
    return start
  })

  /**
   * The place for a start. The same start (parent session, parent branch,
   * tool call, origin) adopts the copy it made before, so a repeated start
   * gets one copy. A record left by a crash recovers by its phase: a
   * `creating` record with nothing at its path is made again, one whose copy
   * holds the marker is removed and made again, and any other directory is
   * kept and the start fails.
   */
  const acquire = Effect.fn("Workspaces.acquire")(function* (start: WorkspaceStart) {
    return yield* locked(
      start.name,
      Effect.gen(function* () {
        const existing = yield* readRecord(start.name)
        if (Option.isNone(existing)) {
          const made = yield* create(start)
          return placeOf(made, made.notes)
        }
        const record = existing.value
        if ((yield* digestOf(record)) !== start.digest) {
          return yield* new WorkspaceError({
            message: `Workspace ${start.name} belongs to another start; gent keeps it`,
          })
        }
        const state = yield* ownership(record)
        if (record.phase === "ready" && state === "owned") return placeOf(record, record.notes)
        if (record.phase === "ready" && Predicate.isNotUndefined(record.sessionId)) {
          return yield* new WorkspaceError({
            message: `the copy at ${record.path} of this start is gone`,
          })
        }
        if (state === "owned") yield* removeCopy(record)
        if (record.phase === "ready") yield* forget(record)
        const made = yield* create(start)
        return placeOf(made, made.notes)
      }),
    )
  })

  /**
   * Names the child session that works in the place, so its turns collect
   * and its delete releases it. A place bound to another session stays its.
   */
  const bind = Effect.fn("Workspaces.bind")(function* (name: string, sessionId: SessionId) {
    yield* locked(
      name,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const record = yield* readRecord(name)
        if (Option.isNone(record) || record.value.phase !== "ready") {
          return yield* new WorkspaceError({ message: `Workspace ${name} is not ready` })
        }
        const owner = Option.fromUndefinedOr(record.value.sessionId)
        if (Option.isSome(owner) && owner.value !== sessionId) {
          return yield* new WorkspaceError({
            message: `Workspace ${name} belongs to session ${owner.value}`,
          })
        }
        // The record is the binding; the session index after it only finds it faster.
        if (Option.isNone(owner)) yield* publish({ ...record.value, sessionId })
        yield* fs.makeDirectory(yield* inDirectory("sessions"), { recursive: true }).pipe(asError)
        yield* writeFileAtomic(yield* linkFile(sessionId), name).pipe(
          asError,
          Effect.uninterruptible,
        )
      }),
    )
  })

  /** The name of the place a session is bound to, by the session index: one read. */
  const linkedName = Effect.fn("Workspaces.linkedName")(function* (sessionId: SessionId) {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(yield* linkFile(sessionId)).pipe(
      Effect.map((text) => text.trim()),
      Effect.option,
    )
  })

  /** The record bound to `sessionId`, under `name`'s lock. */
  const boundRecord = Effect.fn("Workspaces.boundRecord")(function* (
    name: string,
    sessionId: SessionId,
  ) {
    const record = yield* readRecord(name)
    return Option.filter(
      record,
      (found) => found.phase === "ready" && found.sessionId === sessionId,
    )
  })

  /** The place a session works in, if any. */
  const find = Effect.fn("Workspaces.find")(function* (sessionId: SessionId) {
    const name = yield* linkedName(sessionId)
    if (Option.isNone(name)) return Option.none<WorkspacePlace>()
    const record = yield* boundRecord(name.value, sessionId)
    return Option.map(record, (found) => placeOf(found, found.notes))
  })

  // ── collect ──

  /**
   * The child's work as one commit over `base`, on `refs/heads/gent/<name>`
   * in the origin. The branch moves only from the commit gent last wrote: a
   * branch someone else moved, or one a worktree has checked out, stays as it
   * is, and the work stays in the copy. A rift copy is a repository of its
   * own, so its commit is fetched to a private ref first. A copy that matches
   * `base` holds no work: gent's branch goes.
   */
  const collectRecord = Effect.fn("Workspaces.collectRecord")(function* (input: WorkspaceRecord) {
    let record = input
    const base = Option.getOrElse(Option.fromUndefinedOr(record.base), () => "")
    if ((yield* ownership(record)) === "absent") {
      return yield* new WorkspaceError({ message: `the copy at ${record.path} is gone` })
    }
    const branch = workspaceBranch(record.name)
    const ref = `refs/heads/${branch}`
    const none: Work = { files: 0, insertions: 0, deletions: 0 }
    const tree = yield* captureTree(record.path)
    const baseTree = yield* git(record.path, ["rev-parse", `${base}^{tree}`])
    const current = yield* gitOption(record.origin, ["rev-parse", "--verify", "-q", ref])
    const ours =
      Option.isNone(current) || current.value === record.tip || current.value === record.nextTip
    const problem = Option.orElse(
      Option.map(
        yield* checkedOutAt(record.origin, ref),
        (at) => `${branch} is checked out in ${at}`,
      ),
      () => Option.liftPredicate(`${branch} was moved since gent last wrote it`, () => !ours),
    )
    if (tree === baseTree) {
      // No work: gent's own branch goes; a branch someone else holds stays.
      if (Option.isSome(current) && Option.isNone(problem)) {
        yield* git(record.origin, ["update-ref", "-d", ref, current.value])
      }
      const { tip: _tip, nextTip: _next, ...rest } = record
      return { work: none, record: rest }
    }
    if (Option.isSome(problem)) {
      const kept: Work = {
        ...none,
        problem: `${problem.value}; gent left it, and the work stays in the copy`,
      }
      return { work: kept, record }
    }
    const reusable = yield* Option.match(current, {
      onNone: () => Effect.succeed(false),
      onSome: (commit) =>
        gitOption(record.origin, ["rev-parse", `${commit}^{tree}`, `${commit}^`]).pipe(
          Effect.map((found) => Option.exists(found, (lines) => lines === `${tree}\n${base}`)),
        ),
    })
    let commit = Option.getOrElse(current, () => "")
    if (!reusable) {
      commit = yield* commitTree(record.path, tree, base, `gent: work of child ${record.name}`)
      record = { ...record, nextTip: commit }
      yield* publish(record)
      const expected = Option.getOrElse(current, () => "")
      if (record.backend === "worktree") {
        yield* git(record.origin, ["update-ref", ref, commit, expected])
      } else {
        const incoming = `refs/gent/incoming/${record.name}`
        yield* git(record.path, ["update-ref", "refs/gent/collected", commit])
        yield* git(record.origin, [
          "fetch",
          "--no-tags",
          "--quiet",
          "--no-write-fetch-head",
          record.path,
          `+refs/gent/collected:${incoming}`,
        ])
        yield* git(record.origin, ["update-ref", ref, commit, expected])
        yield* git(record.origin, ["update-ref", "-d", incoming]).pipe(Effect.ignore)
      }
    }
    const { nextTip: _next, ...settled } = record
    record = { ...settled, tip: commit }
    const stat = yield* git(record.origin, ["diff", "--shortstat", base, commit])
    const work: Work = { branch, ...parseShortStat(stat) }
    return { work, record }
  })

  /**
   * The work of the place a session works in; none when the session has no
   * place. With `turn`, a second collect for the same turn (the delegate's
   * completion after this extension's turn end) reads the first.
   */
  const collect = Effect.fn("Workspaces.collect")(function* (sessionId: SessionId, turn?: string) {
    const name = yield* linkedName(sessionId)
    if (Option.isNone(name)) return Option.none<CollectedWork>()
    return yield* locked(
      name.value,
      Effect.gen(function* () {
        const found = yield* boundRecord(name.value, sessionId)
        if (Option.isNone(found)) return Option.none<CollectedWork>()
        const record = found.value
        const previous = Option.fromUndefinedOr(record.collected)
        if (
          Predicate.isNotUndefined(turn) &&
          Option.exists(previous, (last) => last.turn === turn)
        ) {
          return Option.map(previous, (last) => ({ ...last.work, path: record.path }))
        }
        const result = yield* collectRecord(record)
        let next = result.record
        if (Predicate.isNotUndefined(turn))
          next = { ...next, collected: { turn, work: result.work } }
        if (next !== record) yield* publish(next)
        return Option.some({ ...result.work, path: record.path })
      }),
    )
  })

  // ── release ──

  /**
   * Removes a copy and what gent keeps for it. A bound copy's last work is
   * collected first, under the same lock; a collect that fails, or that
   * leaves the work in the copy, keeps everything.
   */
  const retire = Effect.fn("Workspaces.retire")(function* (record: WorkspaceRecord) {
    const state = yield* ownership(record)
    if (state === "owned") {
      if (record.phase === "ready" && Predicate.isNotUndefined(record.sessionId)) {
        const { work, record: collected } = yield* collectRecord(record)
        if (collected !== record) yield* publish(collected)
        if (Predicate.isNotUndefined(work.problem)) {
          return yield* new WorkspaceError({
            message: `gent keeps the copy ${record.path}: ${work.problem}`,
          })
        }
      }
      yield* removeCopy(record)
    }
    yield* forget(record)
  })

  /**
   * Removes the place of a start whose session was never bound to it (the
   * session create failed). A bound place stays: its session owns it.
   */
  const release = Effect.fn("Workspaces.release")(function* (name: string) {
    yield* locked(
      name,
      Effect.gen(function* () {
        const record = yield* readRecord(name)
        if (Option.isNone(record) || Predicate.isNotUndefined(record.value.sessionId)) return
        yield* retire(record.value)
      }),
    )
  })

  /** Every record name on disk; a session index that was not written yet still finds its record here. */
  const recordNames = Effect.fn("Workspaces.recordNames")(function* () {
    const fs = yield* FileSystem.FileSystem
    const files = yield* fs.readDirectory(yield* directory).pipe(Effect.orElseSucceed(() => []))
    return files.filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5))
  })

  /** A deleted session's place goes with it, its last work collected first. */
  const releaseSession = Effect.fn("Workspaces.releaseSession")(function* (sessionId: SessionId) {
    const linked = yield* linkedName(sessionId)
    if (Option.isSome(linked)) {
      return yield* locked(
        linked.value,
        Effect.flatMap(boundRecord(linked.value, sessionId), (record) =>
          Option.match(record, { onNone: () => Effect.void, onSome: retire }),
        ),
      )
    }
    // A crash between the binding and its index leaves no index: a delete, which is rare, reads every record.
    yield* Effect.forEach(
      yield* recordNames(),
      (name) =>
        locked(
          name,
          Effect.gen(function* () {
            const record = yield* boundRecord(name, sessionId).pipe(
              Effect.orElseSucceed(() => Option.none<WorkspaceRecord>()),
            )
            if (Option.isSome(record)) yield* retire(record.value)
          }),
        ),
      { discard: true },
    )
  })

  return { locate, acquire, bind, find, collect, release, releaseSession }
}

type WorkspacesApi = ReturnType<typeof makeWorkspaces>

/**
 * The places service. The delegate reads it with `Effect.serviceOption`, so
 * snapshot children exist only where `@gent/workspaces` is active.
 *
 * Its methods run in their caller's leaf or hook: the caller's
 * `ExtensionContext` names the data directory's home, the parent session and
 * branch, and holds the file lock, and a process resource builds before any
 * leaf runs.
 *
 * @effect-expect-leaking ExtensionContext | FileSystem | Path | ChildProcessSpawner | Crypto
 */
export class Workspaces extends Context.Service<Workspaces, WorkspacesApi>()(
  "@gent/extensions/src/workspaces",
) {}

// ── extension ───────────────────────────────────────────────────────────────

export const WORKSPACES_EXTENSION_ID = ExtensionId.make("@gent/workspaces")

/** A hook step that fails logs and ends: the copy and its record stay for the next try. */
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
      yield* host.on("turnAfter", ({ sessionId, messageId }) =>
        Effect.flatMap(Workspaces, (places) =>
          places
            .collect(sessionId, messageId)
            .pipe(Effect.asVoid, logged("workspaces.collect.failed")),
        ),
      )
      yield* host.on("sessionDeleted", ({ sessionId }) =>
        Effect.flatMap(Workspaces, (places) =>
          places.releaseSession(sessionId).pipe(logged("workspaces.release.failed")),
        ),
      )
    }),
  })

export const WorkspacesExtension = makeWorkspacesExtension()
