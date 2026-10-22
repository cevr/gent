/**
 * Places for threads: where a thread works, named at its start. Three kinds:
 *
 * - `Snapshot`: a copy of the caller's working tree. Where the file system is
 *   one rift copies on (APFS, btrfs, XFS) and the origin is a rift workspace,
 *   `rift` makes the copy (`rift rpc`, a process, never its FFI; gent never
 *   runs `rift init` or `rift gc`). Everywhere else, and when rift fails, gent
 *   makes a `git worktree add --detach` with the origin's uncommitted state.
 * - `Rift`: a named rift copy of a source that is not itself a rift copy (by
 *   default the caller's warm source). Rift only: a missing rift, a file
 *   system rift does not copy on, a source that is a copy or a target that is
 *   there already is refused before gent writes anything, and a failed
 *   `postcreate` hook fails the start.
 * - `Path`: an existing directory in a git repository, attached as it is. No
 *   copy, no hook, no collect; gent never removes or owns it.
 *
 * gent runs the `.rift.toml` `postcreate` hooks in a copy. A place is not a
 * sandbox: the thread still reaches every path on the machine.
 *
 * A copy's work comes back at each thread turn end: its committed and
 * uncommitted work, as one commit over the copy's state after its hooks
 * (`base`), on `refs/heads/gent/<name>` of the origin. gent moves that branch
 * only from the commit it last wrote (compare and swap), and never while a
 * worktree has it checked out. Nothing is merged. A worktree copy lives as
 * long as its thread session. gent never removes a rift copy: rift cannot
 * refuse, in one step, to remove a copy that has copies of its own, so a rift
 * copy is kept (`retained`) when its session goes.
 *
 * One record per place under `<data directory>/workspaces/<name>.json`, where
 * `name` is the digest of the start, never a name the caller gave. A copy's
 * record is written before gent makes the copy, and an ownership marker in the
 * copy's git directory after. The marker binds the start, the copy's real
 * path, its backend and its rift id. gent adopts or removes a copy only when
 * the two agree and the copy lies where its backend puts copies; any other
 * directory it keeps.
 */
import {
  Clock,
  Context,
  Crypto,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Match,
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
  omitUndefined,
  RequestId,
  resolveDataDir,
  runProcess,
  SessionId,
  writeFileAtomic,
} from "@gent/core/extensions/api"
import {
  commitTree,
  type GitError,
  type GitOptions,
  git as plumbingGit,
  gitOption,
  parseShortStat,
} from "./git-plumbing.js"

// ── records ─────────────────────────────────────────────────────────────────

export class WorkspaceError extends Schema.TaggedError<
  WorkspaceError,
  { readonly brand: unique symbol }
>()("WorkspaceError", {
  message: Schema.String,
}) {}

/** A `postcreate` hook of a rift workspace failed: the start fails, and gent keeps the copy at `path`. */
export class WorkspaceHookFailed extends Schema.TaggedError<
  WorkspaceHookFailed,
  { readonly brand: unique symbol }
>()("WorkspaceHookFailed", {
  message: Schema.String,
  /** The copy gent keeps: it cannot remove a rift copy yet. */
  path: Schema.String,
}) {}

/**
 * What a start asks for. `Snapshot`: a copy of the caller's working tree,
 * rift where rift copies, else a git worktree. `Rift`: a rift copy named
 * `name` of `from` (default: the caller's warm source), rift only. `Path`: an
 * existing directory, attached as it is.
 */
export const WorkspaceKind = Schema.TaggedUnion({
  Snapshot: {},
  Rift: { name: Schema.String, from: Schema.optionalKey(Schema.String) },
  Path: { path: Schema.String },
})
export type WorkspaceKind = typeof WorkspaceKind.Type

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

/** A place gent made: a copy on disk, and the child session that works in it once one does. */
const CopyRecord = Schema.Struct({
  /** A record written before the kinds has none: it is a snapshot's. */
  kind: Schema.Literals(["snapshot", "rift"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("snapshot" as const)),
  ),
  /** The record's key: the digest of the start, never a name the caller gave. */
  name: Schema.String,
  /** The start that asked for the place: its parent session and branch, and its tool call. */
  parentSessionId: SessionId,
  parentBranchId: BranchId,
  requestId: RequestId,
  /** The origin repository's top level, resolved: the source of the copy. */
  origin: Schema.String,
  /** The origin's rift id, from its `.rift` file, when it is a rift workspace. */
  sourceId: Schema.optionalKey(Schema.String),
  /** The real directory that holds the copy: gent's worktrees directory, or rift's storage. */
  root: Schema.String,
  /** The copy's directory name under `root` when it is not `name`: the name a rift workspace asked for. */
  copyName: Schema.optionalKey(Schema.String),
  /** The copy's root, `<root>/<copy name>`, decided before gent makes it. */
  path: Schema.String,
  /** The child's working directory: the parent's place in the origin, inside the copy. */
  cwd: Schema.String,
  backend: WorkspaceBackend,
  /** A rift copy's id, from its `.rift` file. */
  copyId: Schema.optionalKey(Schema.String),
  /**
   * `creating` until the copy, its marker, its hooks and its base are all in
   * place. `retained`: gent keeps the copy and never adopts or removes it;
   * `retained` says why.
   */
  phase: Schema.Literals(["creating", "ready", "retained"]),
  retained: Schema.optionalKey(Schema.String),
  /** The commit that holds the copy as its hooks left it; the child's work is the diff from it. */
  base: Schema.optionalKey(Schema.String),
  /** What the copy did not do as asked, one line each. */
  notes: Schema.Array(Schema.String),
  createdAt: Schema.Finite,
  sessionId: Schema.optionalKey(SessionId),
  /** The thread that works in the place: its key, its first session's id. */
  thread: Schema.optionalKey(SessionId),
  /** The commit gent last wrote to the branch. */
  tip: Schema.optionalKey(Schema.String),
  /** A commit gent is writing to the branch now; a crash can leave the branch on it. */
  nextTip: Schema.optionalKey(Schema.String),
  /** The last collect and the turn it ran for, so a second collect of one turn reads it. */
  collected: Schema.optionalKey(Schema.Struct({ turn: Schema.String, work: CollectedWorkSchema })),
})
type CopyRecord = typeof CopyRecord.Type

/** A directory a start attached: gent made none of it, and removes, copies or collects nothing there. */
const PathRecord = Schema.Struct({
  kind: Schema.Literal("path"),
  name: Schema.String,
  parentSessionId: SessionId,
  parentBranchId: BranchId,
  requestId: RequestId,
  /** The repository's top level, resolved. */
  origin: Schema.String,
  /** The attached directory, resolved; the child works there. */
  path: Schema.String,
  cwd: Schema.String,
  /** An attached directory is ready at once. */
  phase: Schema.Literal("ready"),
  notes: Schema.Array(Schema.String),
  createdAt: Schema.Finite,
  sessionId: Schema.optionalKey(SessionId),
  thread: Schema.optionalKey(SessionId),
})
type PathRecord = typeof PathRecord.Type

const WorkspaceRecord = Schema.Union([CopyRecord, PathRecord])
type WorkspaceRecord = typeof WorkspaceRecord.Type

const isCopyRecord = (record: WorkspaceRecord): record is CopyRecord => record.kind !== "path"

const recordCodec = Schema.fromJsonString(WorkspaceRecord)
const decodeRecord = Schema.decodeUnknownOption(recordCodec)
const encodeRecord = Schema.encodeSync(recordCodec)

type Work = typeof CollectedWorkSchema.Type

/**
 * A place as a thread start uses it. `Copy`: a copy gent made, whose work
 * returns on `branch`. `Attached`: a directory gent only names. `notes` say,
 * one line each, what the acquire did not do as asked.
 */
export const WorkspacePlace = Schema.TaggedUnion({
  Copy: {
    /** What the start asked for: a snapshot of its working tree, or a named rift workspace. */
    kind: Schema.Literals(["snapshot", "rift"]),
    name: Schema.String,
    path: Schema.String,
    cwd: Schema.String,
    branch: Schema.String,
    backend: WorkspaceBackend,
    notes: Schema.Array(Schema.String),
  },
  Attached: {
    name: Schema.String,
    path: Schema.String,
    cwd: Schema.String,
    notes: Schema.Array(Schema.String),
  },
})
export type WorkspacePlace = typeof WorkspacePlace.Type

/** What a collect found, and the copy it came from. */
export interface CollectedWork extends Schema.Schema.Type<typeof CollectedWorkSchema> {
  readonly path: string
}

/** The branch a place's work lands on in the origin. */
const workspaceBranch = (name: string) => `gent/${name}`

/** The copy's directory name under its root: the name a rift workspace asked for, else the record's key. */
const copyDirectory = (record: CopyRecord) => record.copyName ?? record.name

/** Below this much free space where the copy lands, an acquire is refused. */
const DEFAULT_MINIMUM_FREE_BYTES = 2 * 1024 ** 3

const GIT_TIMEOUT = Duration.minutes(2)
const RIFT_TIMEOUT = Duration.minutes(10)
const HOOK_TIMEOUT = Duration.minutes(10)

/** The ownership marker in a copy's git directory: the digest of the record's identity and place. */
export const WORKSPACE_MARKER_FILE = "gent-workspace"

/** Why gent keeps every rift copy. Manual removal of a rift copy comes with the copy list (W2). */
const RIFT_RETAINED = "rift removal cannot refuse a copy with descendants atomically"

// ── git ─────────────────────────────────────────────────────────────────────

/** The shared plumbing's failure, as a place reports it. */
const workspaceError = (error: GitError) => new WorkspaceError({ message: error.message })

/** One git command in `cwd`; a non-zero exit fails with git's own words. */
const git = (cwd: string, args: ReadonlyArray<string>, options: GitOptions = {}) =>
  plumbingGit(cwd, args, options).pipe(Effect.mapError(workspaceError))

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

/** A working tree as a commit: `HEAD` itself when nothing differs. */
const captureBase = Effect.fn("Workspaces.captureBase")(function* (repo: string, name: string) {
  const head = yield* git(repo, ["rev-parse", "--verify", "HEAD^{commit}"])
  const tree = yield* captureTree(repo)
  const headTree = yield* git(repo, ["rev-parse", "HEAD^{tree}"])
  if (tree === headTree) return head
  return yield* commitTree(repo, tree, head, `gent: the copy ${name} as it started`).pipe(
    Effect.mapError(workspaceError),
  )
})

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

/** A TOML integer as written: decimal, hex, octal or binary, an underscore only between digits. */
const TOML_INTEGER =
  /^(?:[+-]?(?:0|[1-9](?:_?\d)*)|0x[\da-fA-F](?:_?[\da-fA-F])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*)$/
/** A root-table line that sets `version`: the key bare or quoted, its value, a comment. */
const VERSION_LINE = /^\s*(?:version|"version"|'version')\s*=\s*([^#]*?)\s*(?:#.*)?$/

/**
 * The value token of the one line that sets `version` in the root table
 * (before the first table header). None when no line or more than one line
 * sets it: gent does not guess which one a TOML reader takes.
 */
const versionToken = (text: string) => {
  const lines = text.split(/\r?\n/)
  const header = lines.findIndex((line) => /^\s*\[/.test(line))
  let root = lines
  if (header !== -1) root = lines.slice(0, header)
  const tokens = root.flatMap((line) =>
    Option.toArray(
      Option.flatMap(Option.fromNullishOr(VERSION_LINE.exec(line)), (match) =>
        Option.fromUndefinedOr(match[1]),
      ),
    ),
  )
  return Option.liftPredicate(tokens, (found) => found.length === 1).pipe(
    Option.flatMap((found) => Option.fromUndefinedOr(found[0])),
  )
}

/**
 * The `postcreate` commands of a `.rift.toml`, checked as rift checks the
 * file: TOML, `version = 1` as a TOML integer (rift reads a `u32`; a float or
 * a string with the same value is refused), only the four hook lists, each
 * step one non-empty `run`. `Bun.TOML.parse` reads `1.0` as the number 1, so
 * the integer check reads the `version` token as written.
 */
const riftPostcreateHooks = (text: string): Result.Result<ReadonlyArray<string>, string> => {
  // oxlint-disable-next-line effect/noGlobals -- Pure TOML parse with no Effect platform service; gent ships as a Bun binary.
  const parsed = Result.try(() => Bun.TOML.parse(text))
  if (Result.isFailure(parsed)) return Result.fail(`it is not TOML: ${String(parsed.failure)}`)
  const config = decodeRiftConfig(parsed.success, { onExcessProperty: "error" })
  if (Result.isFailure(config)) return Result.fail(config.failure.message)
  if (!Option.exists(versionToken(text), (token) => TOML_INTEGER.test(token))) {
    return Result.fail("version is not written as a TOML integer")
  }
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
    }),
  }),
])
/** rift's own refusal of a request, with its code (`already_exists`, `cow_unavailable`, ...). */
class RiftRefused extends Schema.TaggedError<RiftRefused, { readonly brand: unique symbol }>()(
  "RiftRefused",
  { code: Schema.String, message: Schema.String },
) {}

const decodeRiftAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(RiftAnswer))
const decodePaths = Schema.decodeUnknownOption(Schema.Array(Schema.String))

/** The `rift rpc` requests gent sends. gent never sends `remove`: it keeps every rift copy. */
const RiftRequest = Schema.Union([
  Schema.Struct({ command: Schema.Literal("ancestors"), of: Schema.String }),
  Schema.Struct({
    command: Schema.Literal("create"),
    from: Schema.String,
    name: Schema.String,
    into: Schema.String,
    copyAll: Schema.Boolean,
    /** False: rift runs no hook; gent runs `postcreate` in the copy itself. */
    hooks: Schema.Boolean,
  }),
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

/** A process's trimmed stdout when it exits 0; none when it fails or does not run. */
const processText = (command: string, args: ReadonlyArray<string>) =>
  runProcess(command, args, { timeout: GIT_TIMEOUT }).pipe(
    Effect.map((result) => Option.liftPredicate(result.stdout.trim(), () => result.exitCode === 0)),
    Effect.orElseSucceed(() => Option.none<string>()),
  )

/** The type in a `mount` line `<device> on <mount point> (<type>, <flags>...)`. */
const mountedType = (line: string) => {
  const open = line.lastIndexOf(" (")
  if (open === -1) return Option.none<string>()
  return Option.liftPredicate(
    line
      .slice(open + 2)
      .split(/[,)]/)[0]
      ?.trim() ?? "",
    (type) => type.length > 0,
  )
}

/**
 * The file system type (`btrfs`, `xfs`, `apfs`, ...), or none where the
 * system does not say. GNU `stat -f -c %T` names it; BSD `stat` (macOS) has
 * no such format, so there the device that holds the directory is read
 * (`stat -f %Sd`) and its line in `mount` names the type.
 */
const fileSystemType = Effect.fn("Workspaces.fileSystemType")(function* (directory: string) {
  const gnu = yield* processText("stat", ["-f", "-c", "%T", directory])
  if (Option.isSome(gnu)) return Option.map(gnu, (type) => type.toLowerCase())
  const device = yield* processText("stat", ["-f", "%Sd", directory])
  if (Option.isNone(device)) return Option.none<string>()
  const table = yield* processText("mount", [])
  const line = Option.flatMap(table, (text) =>
    Option.fromUndefinedOr(
      text.split("\n").find((entry) => entry.startsWith(`/dev/${device.value} on `)),
    ),
  )
  return Option.map(Option.flatMap(line, mountedType), (type) => type.toLowerCase())
})

/**
 * The file systems rift copies on: APFS (`clonefile`) on macOS, btrfs
 * (snapshots) and XFS (reflinks) on Linux. rift itself refuses a file system
 * without copy-on-write (`cow_unavailable`); gent refuses the rest before it
 * asks.
 */
const RIFT_FILE_SYSTEMS: ReadonlyArray<string> = ["apfs", "btrfs", "xfs"]

/** Whether rift copies on the file system that holds `directory`; else why not. */
const riftFileSystem = Effect.fn("Workspaces.riftFileSystem")(function* (directory: string) {
  const type = yield* fileSystemType(directory)
  if (Option.exists(type, (found) => RIFT_FILE_SYSTEMS.includes(found))) return Result.void
  return Result.fail(
    `the origin's file system is ${Option.getOrElse(type, () => "unknown")}, which rift does not copy on (${RIFT_FILE_SYSTEMS.join(", ")})`,
  )
})

/** What is at a path, without following a link there: `stat` follows links, `readLink` tells them. */
type EntryKind = "absent" | "link" | "file" | "directory" | "other"

const entryKind = Effect.fn("Workspaces.entryKind")(function* (at: string) {
  const fs = yield* FileSystem.FileSystem
  if (Option.isSome(yield* fs.readLink(at).pipe(Effect.option))) return "link" satisfies EntryKind
  const info = yield* fs.stat(at).pipe(
    Effect.asSome,
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeedNone,
    ),
    Effect.mapError((error) => new WorkspaceError({ message: error.message })),
  )
  if (Option.isNone(info)) return "absent" satisfies EntryKind
  if (info.value.type === "File") return "file" satisfies EntryKind
  if (info.value.type === "Directory") return "directory" satisfies EntryKind
  return "other" satisfies EntryKind
})

/** A small file's text when a regular file (not a link) is at `at`. */
const readRegularFile = Effect.fn("Workspaces.readRegularFile")(function* (at: string) {
  const fs = yield* FileSystem.FileSystem
  if ((yield* entryKind(at)) !== "file") return Option.none<string>()
  return yield* fs.readFileString(at).pipe(
    Effect.map((text) => text.trim()),
    Effect.option,
  )
})

/** A rift workspace's id, from the `.rift` file rift keeps at its root. */
const riftId = Effect.fn("Workspaces.riftId")(function* (directory: string) {
  const path = yield* Path.Path
  return yield* readRegularFile(path.join(directory, ".rift"))
})

/**
 * The real path of `at`, or of the nearest directory above it that exists,
 * with the rest joined on: the real path a directory will have once made.
 */
const canonical: (
  at: string,
) => Effect.Effect<string, WorkspaceError, FileSystem.FileSystem | Path.Path> = Effect.fn(
  "Workspaces.canonical",
)(function* (at: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const real = yield* fs.realPath(at).pipe(
    Effect.asSome,
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeedNone,
    ),
    Effect.mapError((error) => new WorkspaceError({ message: error.message })),
  )
  if (Option.isSome(real)) return real.value
  const parent = path.dirname(at)
  if (parent === at) return at
  return path.join(yield* canonical(parent), path.basename(at))
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

/** Where a start's place comes from, what it asks for, and the name its identity gives it. */
interface WorkspaceStart {
  readonly name: string
  /** The digest of the identity; the copy's marker holds it. */
  readonly digest: string
  readonly parentSessionId: SessionId
  readonly parentBranchId: BranchId
  readonly requestId: RequestId
  /** The source's top level: the tree a copy copies, or the repository an attached directory is in. */
  readonly origin: string
  /** The origin's rift id, when it is a rift workspace. */
  readonly sourceId: Option.Option<string>
  /** The child's place, relative to the origin: the parent's cwd, or the attached directory. */
  readonly relative: string
  readonly ask: WorkspaceKind
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
  const worktreesDirectory = inDirectory("worktrees")

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

  const sha256 = Effect.fn("Workspaces.sha256")(function* (text: string) {
    const crypto = yield* Crypto.Crypto
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(text)).pipe(asError)
    return Hex.encode(digest)
  })

  /** The digest of a start's identity: its parent session and branch, its tool call, its origin. */
  const digestOf = (identity: {
    readonly parentSessionId: string
    readonly parentBranchId: string
    readonly requestId: string
    readonly origin: string
  }) =>
    sha256(
      [identity.parentSessionId, identity.parentBranchId, identity.requestId, identity.origin].join(
        "\n",
      ),
    )
  const nameOfDigest = (digest: string) => `child-${digest.slice(0, 12)}`

  const placeOf = (record: WorkspaceRecord): WorkspacePlace => {
    if (record.kind === "path") {
      return WorkspacePlace.cases.Attached.make({
        name: record.name,
        path: record.path,
        cwd: record.cwd,
        notes: record.notes,
      })
    }
    return WorkspacePlace.cases.Copy.make({
      kind: record.kind,
      name: record.name,
      path: record.path,
      cwd: record.cwd,
      branch: workspaceBranch(record.name),
      backend: record.backend,
      notes: record.notes,
    })
  }

  /** Refuses a copy where the file system holding `at` is nearly full, or says nothing of its space. */
  const requireSpace = Effect.fn("Workspaces.requireSpace")(function* (at: string) {
    const free = yield* freeBytes(at)
    if (Option.isNone(free)) {
      return yield* new WorkspaceError({
        message: `gent cannot tell how much space is free where the copy would go (${at}), so it makes no copy. Start the thread without a snapshot workspace.`,
      })
    }
    yield* Effect.logDebug("workspaces.free-space").pipe(
      Effect.annotateLogs({ directory: at, freeBytes: free.value }),
    )
    if (free.value >= minimumFree) return
    return yield* new WorkspaceError({
      message: `Only ${gib(free.value)} GB is free where the copy would go (${at}); a snapshot thread needs ${gib(minimumFree)} GB. Free some space, or start the thread without a snapshot workspace.`,
    })
  })

  // ── ownership ──

  /** Why gent may not touch the record's path, by the record alone, if it may not. */
  const unsafePath = Effect.fn("Workspaces.unsafePath")(function* (record: CopyRecord) {
    const path = yield* Path.Path
    const copy = record.path
    if (!path.isAbsolute(copy) || copy === record.origin) return Option.some("it is the origin")
    if (inside(path, record.origin, copy) || inside(path, copy, record.origin)) {
      return Option.some("it overlaps the origin")
    }
    const named = copyDirectory(record)
    if (path.basename(copy) !== named) return Option.some("its name is not the record's")
    if (copy !== path.join(record.root, named)) {
      return Option.some("it is not in the directory its record names")
    }
    if (inside(path, record.origin, record.root) || inside(path, record.root, record.origin)) {
      return Option.some("its directory overlaps the origin")
    }
    if (
      record.backend === "worktree" &&
      record.root !== (yield* canonical(yield* worktreesDirectory))
    ) {
      return Option.some("it is not in gent's worktrees directory")
    }
    if ((yield* canonical(record.root)) !== record.root) {
      return Option.some("its directory is not a real path")
    }
    return Option.none<string>()
  })

  /**
   * The copy's own git directory, proven without following a link: the copy
   * is a real directory at its recorded path; a rift copy's `.git` is a
   * directory in it; a worktree's `.git` is a file whose `gitdir` resolves
   * to an entry of the origin's `.git/worktrees/`. git must agree on both.
   * Else why not.
   */
  const copyGitDirectory = Effect.fn("Workspaces.copyGitDirectory")(function* (record: CopyRecord) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const real = yield* fs.realPath(record.path).pipe(Effect.option)
    if (!Option.contains(real, record.path)) return Result.fail("its real path is not the record's")
    const dotGit = path.join(record.path, ".git")
    const kind = yield* entryKind(dotGit)
    let gitDir = dotGit
    if (record.backend === "rift") {
      if (kind !== "directory") return Result.fail(`its .git is a ${kind}, not a directory`)
    } else {
      if (kind !== "file") return Result.fail(`its .git is a ${kind}, not a worktree's file`)
      const text = yield* readRegularFile(dotGit)
      const named = Option.flatMap(text, (found) =>
        Option.fromNullishOr(/^gitdir: (.+)$/m.exec(found)?.[1]),
      )
      if (Option.isNone(named)) return Result.fail("its .git names no git directory")
      const resolved = yield* fs
        .realPath(path.resolve(record.path, named.value.trim()))
        .pipe(Effect.option)
      const common = yield* gitOption(record.origin, ["rev-parse", "--git-common-dir"])
      if (Option.isNone(resolved) || Option.isNone(common)) {
        return Result.fail("its git directory cannot be found")
      }
      const worktrees = path.join(
        yield* canonical(path.resolve(record.origin, common.value)),
        "worktrees",
      )
      if (path.dirname(resolved.value) !== worktrees) {
        return Result.fail("its git directory is not one of the origin's worktrees")
      }
      gitDir = resolved.value
    }
    const told = yield* gitOption(record.path, [
      "rev-parse",
      "--show-toplevel",
      "--absolute-git-dir",
    ])
    const [top, absolute] = Option.getOrElse(
      Option.map(told, (text) => text.split("\n")),
      () => [],
    )
    const gitReal = yield* Option.match(Option.fromUndefinedOr(absolute), {
      onNone: () => Effect.succeedNone,
      onSome: (found) => fs.realPath(found).pipe(Effect.option),
    })
    if (top !== record.path || !Option.contains(gitReal, gitDir)) {
      return Result.fail("git does not name it as its own repository")
    }
    return Result.succeed(gitDir)
  })

  /** What the marker holds: the start, the copy's real path, its backend and its rift id. */
  const markerDigest = Effect.fn("Workspaces.markerDigest")(function* (record: CopyRecord) {
    return yield* sha256(
      [yield* digestOf(record), record.path, record.backend, record.copyId ?? ""].join("\n"),
    )
  })

  /**
   * Whether the record's copy is gent's: `absent` when nothing is at its
   * path, `owned` when the copy lies where its record says, in the directory
   * its backend owns, is its own repository, carries the record's rift id,
   * and its marker holds the record's digest. Any other path or directory is
   * kept, and the call fails with why.
   */
  const ownership = Effect.fn("Workspaces.ownership")(function* (record: CopyRecord) {
    const path = yield* Path.Path
    const kept = (why: string) =>
      new WorkspaceError({ message: `gent keeps ${record.path} (${record.name}): ${why}` })
    if (nameOfDigest(yield* digestOf(record)) !== record.name) {
      return yield* kept("the record's identity changed")
    }
    const unsafe = yield* unsafePath(record)
    if (Option.isSome(unsafe)) return yield* kept(unsafe.value)
    const kind = yield* entryKind(record.path)
    if (kind === "absent") return "absent" as const
    if (kind !== "directory") return yield* kept(`it is a ${kind}`)
    const gitDir = yield* copyGitDirectory(record)
    if (Result.isFailure(gitDir)) return yield* kept(gitDir.failure)
    if (record.backend === "rift") {
      const id = yield* riftId(record.path)
      if (Predicate.isUndefined(record.copyId) || !Option.contains(id, record.copyId)) {
        return yield* kept("its rift id is not the record's")
      }
    }
    const marker = yield* readRegularFile(path.join(gitDir.success, WORKSPACE_MARKER_FILE))
    if (!Option.contains(marker, yield* markerDigest(record))) {
      return yield* kept("it holds no marker of this start")
    }
    return "owned" as const
  })

  /**
   * Writes the ownership marker into the new copy's git directory. The
   * marker's place must be empty or a regular file: a link there (one a copy
   * of the origin brought along) is refused, never written through. The text
   * goes to a new file beside it, then a rename puts it in place: a rename
   * replaces a directory entry, never the file a link names.
   */
  const writeMarker = Effect.fn("Workspaces.writeMarker")(function* (record: CopyRecord) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const crypto = yield* Crypto.Crypto
    const gitDir = yield* copyGitDirectory(record)
    if (Result.isFailure(gitDir)) {
      return yield* new WorkspaceError({
        message: `gent keeps ${record.path} (${record.name}): ${gitDir.failure}`,
      })
    }
    const marker = path.join(gitDir.success, WORKSPACE_MARKER_FILE)
    const kind = yield* entryKind(marker)
    if (kind !== "absent" && kind !== "file") {
      return yield* new WorkspaceError({
        message: `gent keeps ${record.path} (${record.name}): its marker's place ${marker} is a ${kind}`,
      })
    }
    const digest = yield* markerDigest(record)
    const staged = path.join(
      gitDir.success,
      `${WORKSPACE_MARKER_FILE}.${yield* crypto.randomULID.pipe(asError)}`,
    )
    yield* fs.writeFileString(staged, `${digest}\n`, { flag: "wx" }).pipe(
      Effect.andThen(fs.rename(staged, marker)),
      Effect.tapError(() => fs.remove(staged, { force: true }).pipe(Effect.ignore)),
      asError,
      Effect.uninterruptible,
    )
  })

  /**
   * Keeps a copy for good: the record stays, as `retained` with why, and the
   * session index goes. gent never adopts, collects or removes a retained
   * copy; the owner removes it.
   */
  const retain = Effect.fn("Workspaces.retain")(function* (record: CopyRecord, why: string) {
    const fs = yield* FileSystem.FileSystem
    yield* publish({ ...record, phase: "retained", retained: why })
    if (Predicate.isNotUndefined(record.sessionId)) {
      yield* fs.remove(yield* linkFile(record.sessionId), { force: true }).pipe(asError)
    }
    yield* Effect.logInfo("workspaces.retained").pipe(
      Effect.annotateLogs({ name: record.name, path: record.path, why }),
    )
  })

  // ── making a copy ──

  /** Where rift puts the copies of the rift workspace `root`: `.rifts/<name>` beside it. */
  const riftStorageOf = (path: Path.Path, root: string) =>
    path.join(path.dirname(root), ".rifts", path.basename(root))

  /**
   * Where rift would put a snapshot's copy, when rift is the backend: the
   * origin is a rift workspace on a file system rift copies on. Else the one
   * line that says why the copy is a worktree.
   */
  const riftStorage = Effect.fn("Workspaces.riftStorage")(function* (origin: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const supported = yield* riftFileSystem(origin)
    if (Result.isFailure(supported)) return Result.fail(supported.failure)
    if (!(yield* fs.exists(path.join(origin, ".rift")).pipe(Effect.orElseSucceed(() => false)))) {
      return Result.fail("the origin is not a rift workspace")
    }
    const ancestors = yield* riftPaths(riftProgram, { command: "ancestors", of: origin }).pipe(
      Effect.result,
    )
    if (Result.isFailure(ancestors)) return Result.fail(ancestors.failure.message)
    return Result.succeed(riftStorageOf(path, ancestors.success.at(-1) ?? origin))
  })

  /** A rift copy at `record.path`, without rift's hooks. rift's own refusal fails as `RiftRefused`, with its code. */
  const riftCopy = Effect.fn("Workspaces.riftCopy")(function* (record: CopyRecord) {
    const answer = yield* riftCall(riftProgram, {
      command: "create",
      from: record.origin,
      name: copyDirectory(record),
      into: record.root,
      copyAll: true,
      hooks: false,
    })
    if (answer.status === "error") {
      return yield* new RiftRefused({
        code: answer.error.code,
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
  const addWorktree = Effect.fn("Workspaces.addWorktree")(function* (record: CopyRecord) {
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
  const fillWorktree = Effect.fn("Workspaces.fillWorktree")(function* (record: CopyRecord) {
    const tree = yield* captureTree(record.origin)
    yield* git(record.path, ["read-tree", "-u", "--reset", tree])
    yield* git(record.path, ["reset", "-q"])
  })

  /**
   * The base commit stays reachable while the copy lives: a private ref,
   * `refs/gent/base/<name>`, in the repository that holds it (the origin for
   * a worktree, the copy for rift).
   */
  const baseRef = (record: CopyRecord) => {
    const ref = `refs/gent/base/${record.name}`
    if (record.backend === "worktree") return { repo: record.origin, ref }
    return { repo: record.path, ref }
  }

  /**
   * The rest of a copy that exists: its marker, its files (a worktree), its
   * hooks, its base and the base ref, then `ready`. The base is in the record
   * before the ref is made, so a crash leaves a ref gent can prove its own.
   * The base ref is made only where none is (compare and swap): one that is
   * there already is someone else's, and gent keeps the copy and says so. A
   * snapshot's failed hook is a note; a rift workspace's retains the copy and
   * fails the start.
   */
  const finish = Effect.fn("Workspaces.finish")(function* (
    record: CopyRecord,
    notes: ReadonlyArray<string>,
  ) {
    // The marker goes in first, so a failure or a crash after it leaves a copy gent can prove.
    yield* writeMarker(record)
    if (record.backend === "worktree") yield* fillWorktree(record)
    const ids: HookIds = {
      id: record.copyId ?? record.name,
      parentId: record.sourceId ?? "",
    }
    const hookNote = yield* runPostcreate(record.origin, record.path, ids)
    if (record.kind === "rift" && Option.isSome(hookNote)) {
      yield* retain(record, hookNote.value)
      return yield* new WorkspaceHookFailed({
        message: `The rift workspace's setup failed: ${hookNote.value}. gent keeps the copy at ${record.path}, as it is; it cannot remove a rift copy.`,
        path: record.path,
      })
    }
    const based: CopyRecord = { ...record, base: yield* captureBase(record.path, record.name) }
    yield* publish(based)
    const held = baseRef(based)
    const made = yield* git(held.repo, ["update-ref", held.ref, based.base ?? "", ""]).pipe(
      Effect.result,
    )
    if (Result.isFailure(made)) {
      const why = `${held.ref} in ${held.repo} could not be made where none was (${made.failure.message}); gent left it`
      yield* retain(based, why)
      return yield* new WorkspaceError({ message: `gent keeps the copy ${record.path}: ${why}` })
    }
    const ready: CopyRecord = {
      ...based,
      phase: "ready",
      notes: [...notes, ...Option.toArray(hookNote)],
    }
    yield* publish(ready)
    return ready
  })

  /**
   * The rest of a rift copy rift has just made: its id, then `finish`. The
   * copy is gent's to keep from here on: a step after it that fails retains
   * it.
   */
  const finishRift = Effect.fn("Workspaces.finishRift")(function* (
    record: CopyRecord,
    notes: ReadonlyArray<string>,
  ) {
    const kept = (latest: CopyRecord, why: string) =>
      retain(latest, why).pipe(
        Effect.andThen(
          Effect.fail(
            new WorkspaceError({ message: `gent keeps the copy ${record.path}: ${why}` }),
          ),
        ),
      )
    const copyId = yield* riftId(record.path)
    if (Option.isNone(copyId)) return yield* kept(record, "it has no rift id")
    const identified: CopyRecord = { ...record, copyId: copyId.value }
    yield* publish(identified)
    return yield* finish(identified, notes).pipe(
      Effect.catchTag("WorkspaceError", (error) =>
        Effect.gen(function* () {
          // A step that already retained the copy said why; any other is why now.
          const latest = Option.getOrElse(
            Option.filter(yield* readRecord(record.name), isCopyRecord),
            () => identified,
          )
          if (latest.phase === "retained") return yield* error
          return yield* kept(latest, error.message)
        }),
      ),
    )
  })

  /** A copy's record, written as `creating` before gent makes anything. */
  const copyRecord = Effect.fn("Workspaces.copyRecord")(function* (
    start: WorkspaceStart,
    copy: {
      readonly kind: CopyRecord["kind"]
      readonly backend: CopyRecord["backend"]
      readonly root: string
      readonly copyName?: string
    },
  ) {
    const path = yield* Path.Path
    const directoryName = copy.copyName ?? start.name
    const record: CopyRecord = {
      kind: copy.kind,
      name: start.name,
      parentSessionId: start.parentSessionId,
      parentBranchId: start.parentBranchId,
      requestId: start.requestId,
      origin: start.origin,
      root: copy.root,
      path: path.join(copy.root, directoryName),
      cwd: path.join(copy.root, directoryName, start.relative),
      backend: copy.backend,
      phase: "creating",
      notes: [],
      createdAt: yield* Clock.currentTimeMillis,
      ...omitUndefined({
        copyName: copy.copyName,
        sourceId: Option.getOrUndefined(start.sourceId),
      }),
    }
    return record
  })

  /**
   * Makes the copy for a snapshot start: the record is written as `creating`
   * first, so a crash at any later step leaves a record that names the path.
   * Rift where rift copies; else, or when rift fails with nothing left, a
   * git worktree, and a note says why.
   */
  const createSnapshot = Effect.fn("Workspaces.createSnapshot")(function* (start: WorkspaceStart) {
    const fs = yield* FileSystem.FileSystem
    const storage = yield* riftStorage(start.origin)
    let notes: ReadonlyArray<string> = []
    if (Result.isSuccess(storage)) {
      yield* requireSpace(start.origin)
      const record = yield* copyRecord(start, {
        kind: "snapshot",
        backend: "rift",
        root: yield* canonical(storage.success),
      })
      yield* publish(record)
      const made = yield* riftCopy(record).pipe(Effect.result)
      if (Result.isSuccess(made)) return yield* finishRift(record, notes)
      const why = made.failure.message
      // A failed rift that still left something there: gent keeps it.
      if ((yield* entryKind(record.path)) !== "absent") {
        yield* retain(record, why)
        return yield* new WorkspaceError({ message: why })
      }
      notes = [`a git worktree, because ${why}`]
    } else {
      notes = [`a git worktree, because ${storage.failure}`]
    }
    const worktrees = yield* worktreesDirectory
    yield* fs.makeDirectory(worktrees, { recursive: true }).pipe(asError)
    yield* requireSpace(worktrees)
    const record = yield* copyRecord(start, {
      kind: "snapshot",
      backend: "worktree",
      root: yield* canonical(worktrees),
    })
    yield* publish(record)
    yield* addWorktree(record)
    return yield* finish(record, notes)
  })

  /**
   * Makes a rift workspace: rift only, never a worktree. A file system rift
   * does not copy on, or a target that is there already, is refused before
   * gent writes anything: a target is never adopted, whoever made it. When
   * rift fails, a target it says was there already stays as it is, and only
   * the record goes.
   */
  const createRift = Effect.fn("Workspaces.createRift")(function* (
    start: WorkspaceStart,
    copyName: string,
  ) {
    const path = yield* Path.Path
    const supported = yield* riftFileSystem(start.origin)
    if (Result.isFailure(supported)) {
      return yield* new WorkspaceError({
        message: `A rift workspace needs a file system rift copies on, and ${supported.failure}. gent makes no copy and no worktree.`,
      })
    }
    const root = yield* canonical(riftStorageOf(path, start.origin))
    const target = path.join(root, copyName)
    const there = yield* entryKind(target)
    if (there !== "absent") {
      return yield* new WorkspaceError({
        message: `A ${there} is at ${target} already; gent does not adopt it. Name another rift workspace.`,
      })
    }
    yield* requireSpace(start.origin)
    const record = yield* copyRecord(start, { kind: "rift", backend: "rift", root, copyName })
    yield* publish(record)
    const made = yield* riftCopy(record).pipe(Effect.result)
    if (Result.isSuccess(made)) return yield* finishRift(record, [])
    const why = made.failure.message
    // rift refuses a destination that is there already and leaves it: it is not gent's.
    const theirs = made.failure._tag === "RiftRefused" && made.failure.code === "already_exists"
    if (!theirs && (yield* entryKind(record.path)) !== "absent") {
      yield* retain(record, why)
      return yield* new WorkspaceError({ message: `gent keeps the copy ${record.path}: ${why}` })
    }
    yield* forget(record)
    return yield* new WorkspaceError({
      message: `rift made no workspace at ${record.path}: ${why}. gent makes no worktree in its place.`,
    })
  })

  /** A directory a start attaches, as its record: ready at once, nothing made. */
  const attach = Effect.fn("Workspaces.attach")(function* (start: WorkspaceStart) {
    const path = yield* Path.Path
    const directory = path.join(start.origin, start.relative)
    const record: PathRecord = {
      kind: "path",
      name: start.name,
      parentSessionId: start.parentSessionId,
      parentBranchId: start.parentBranchId,
      requestId: start.requestId,
      origin: start.origin,
      path: directory,
      cwd: directory,
      phase: "ready",
      notes: [],
      createdAt: yield* Clock.currentTimeMillis,
    }
    yield* publish(record)
    return record
  })

  /** Makes the place a start asks for. */
  const create = Effect.fn("Workspaces.create")(function* (start: WorkspaceStart) {
    return yield* Match.value(start.ask).pipe(
      Match.tagsExhaustive({
        Snapshot: () => createSnapshot(start),
        Rift: (ask) => createRift(start, ask.name),
        Path: () => attach(start),
      }),
    )
  })

  // ── removing a copy ──

  /** Removes an owned worktree copy. A failure keeps the copy: gent never deletes what git would not. */
  const removeWorktree = Effect.fn("Workspaces.removeWorktree")(function* (record: CopyRecord) {
    yield* git(record.origin, ["worktree", "remove", "--force", "--force", record.path]).pipe(
      Effect.mapError(
        (error) =>
          new WorkspaceError({ message: `gent keeps the copy ${record.path}: ${error.message}` }),
      ),
    )
  })

  /** A worktree's base ref, where it is now. */
  const currentBase = (record: CopyRecord) => {
    const held = baseRef(record)
    return gitOption(held.repo, ["rev-parse", "--verify", "-q", held.ref])
  }

  /** Drops what gent keeps for a place that is gone or was only attached: the session index, the record. */
  const forget = Effect.fn("Workspaces.forget")(function* (record: WorkspaceRecord) {
    const fs = yield* FileSystem.FileSystem
    if (Predicate.isNotUndefined(record.sessionId)) {
      yield* fs.remove(yield* linkFile(record.sessionId), { force: true }).pipe(asError)
    }
    yield* fs.remove(yield* recordFile(record.name), { force: true }).pipe(asError)
  }, Effect.uninterruptible)

  /**
   * Ends a copy gent owns, or forgets one that is gone. A rift copy is kept
   * and retained. A worktree goes only while its base ref is where gent put
   * it (or gone); the ref goes after the copy, and only from gent's commit.
   * Anything gent cannot prove stays, and the call fails with why.
   */
  const discard = Effect.fn("Workspaces.discard")(function* (
    record: CopyRecord,
    state: "absent" | "owned",
  ) {
    if (record.backend === "rift") {
      if (state === "owned") return yield* retain(record, RIFT_RETAINED)
      return yield* forget(record)
    }
    const held = baseRef(record)
    const base = Option.fromUndefinedOr(record.base)
    let current = Option.none<string>()
    if (Option.isSome(base)) current = yield* currentBase(record)
    const moved = Option.isSome(current) && !Option.contains(base, current.value)
    if (moved) {
      return yield* new WorkspaceError({
        message: `gent keeps the copy ${record.path}: ${held.ref} was moved since gent made it`,
      })
    }
    if (state === "owned") yield* removeWorktree(record)
    if (Option.isSome(current)) {
      yield* git(held.repo, ["update-ref", "-d", held.ref, current.value]).pipe(
        Effect.catchTag("WorkspaceError", (error) =>
          Effect.logWarning("workspaces.base-ref.kept").pipe(
            Effect.annotateLogs({ ref: held.ref, error: error.message }),
          ),
        ),
      )
    }
    yield* forget(record)
  })

  // ── acquire and bind ──

  /** The resolved top level of the repository that holds `at`; refused, naming `what`, when there is none. */
  const repositoryTop = Effect.fn("Workspaces.repositoryTop")(function* (at: string, what: string) {
    const fs = yield* FileSystem.FileSystem
    const top = yield* git(at, ["rev-parse", "--show-toplevel"]).pipe(
      Effect.mapError(
        () =>
          new WorkspaceError({
            message: `${what} needs a git repository, and ${at} is not in one.`,
          }),
      ),
    )
    return yield* fs.realPath(top).pipe(asError)
  })

  /** Refuses, naming `what`, a repository with no commit yet. */
  const requireCommit = (top: string, what: string) =>
    git(top, ["rev-parse", "--verify", "HEAD^{commit}"]).pipe(
      Effect.mapError(
        () =>
          new WorkspaceError({
            message: `${what} needs a commit in ${top}; the repository has none yet.`,
          }),
      ),
    )

  /** The rift workspaces `at` is a copy of, nearest first; none for a source. A missing rift is refused here. */
  const riftAncestors = (at: string) =>
    riftPaths(riftProgram, { command: "ancestors", of: at }).pipe(
      Effect.mapError(
        (error) =>
          new WorkspaceError({
            message: `A rift workspace needs rift, and gent cannot ask it about ${at}: ${error.message}`,
          }),
      ),
    )

  /** A rift workspace's name: one path segment that does not start with `.`, as rift takes it. */
  const RIFT_NAME = /^[^./\\\0][^/\\\0]*$/

  /**
   * The source a rift workspace copies, resolved and verified: `from` (its
   * repository's top level), or by default the warm source of the caller's
   * repository: the rift workspace the caller's is a copy of, or the caller's
   * own when it is no copy. The source must be a rift workspace with a commit
   * and no copy itself (a copy's copies would block its removal later).
   */
  const riftSource = Effect.fn("Workspaces.riftSource")(function* (
    cwd: string,
    from: Option.Option<string>,
  ) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const what = "A rift workspace"
    let source: string
    if (Option.isSome(from)) {
      source = yield* repositoryTop(path.resolve(cwd, from.value), `${what}'s source`)
    } else {
      const top = yield* repositoryTop(cwd, what)
      if (Option.isNone(yield* riftId(top))) {
        return yield* new WorkspaceError({
          message: `${what} copies a rift workspace, and ${top} is not one (it has no .rift file). Run \`rift init\` there, or name a source with \`from\`.`,
        })
      }
      const chain = yield* riftAncestors(top)
      source = yield* fs.realPath(chain.at(-1) ?? top).pipe(asError)
    }
    const sourceId = yield* riftId(source)
    if (Option.isNone(sourceId)) {
      return yield* new WorkspaceError({
        message: `${what} copies a rift workspace, and ${source} is not one (it has no .rift file). Run \`rift init\` there.`,
      })
    }
    const chain = yield* riftAncestors(source)
    if (chain.length > 0) {
      return yield* new WorkspaceError({
        message: `${source} is a rift copy of ${chain[0] ?? "another workspace"}; a rift workspace copies a source that is no copy, such as ${chain.at(-1) ?? "its warm source"}.`,
      })
    }
    yield* requireCommit(source, what)
    return { source, sourceId }
  })

  /** The directory a path workspace attaches, resolved: it must exist, be a directory, and lie in a git repository. */
  const attachedDirectory = Effect.fn("Workspaces.attachedDirectory")(function* (
    cwd: string,
    asked: string,
  ) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const target = path.resolve(cwd, asked)
    const real = yield* fs.realPath(target).pipe(
      Effect.mapError(
        () =>
          new WorkspaceError({
            message: `A path workspace needs ${target} to exist; it does not.`,
          }),
      ),
    )
    const info = yield* fs.stat(real).pipe(asError)
    if (info.type !== "Directory") {
      return yield* new WorkspaceError({
        message: `A path workspace attaches a directory, and ${target} is not one.`,
      })
    }
    return { directory: real, top: yield* repositoryTop(real, "A path workspace") }
  })

  /**
   * Where the place for the start `key` from `cwd` comes from, what it asks
   * for, and its record's name. The parent is the caller's session and
   * branch. Every refusal here comes before gent writes anything.
   */
  const locate = Effect.fn("Workspaces.locate")(function* (input: {
    readonly key: RequestId
    readonly cwd: string
    readonly workspace: WorkspaceKind
  }) {
    const ctx = yield* ExtensionContext
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const ask = input.workspace
    let origin: string
    let relative: string
    let sourceId: Option.Option<string>
    switch (ask._tag) {
      case "Snapshot": {
        const what = "A snapshot workspace"
        origin = yield* repositoryTop(input.cwd, what)
        yield* requireCommit(origin, what)
        relative = path.relative(origin, yield* fs.realPath(input.cwd).pipe(asError))
        sourceId = yield* riftId(origin)
        break
      }
      case "Rift": {
        if (!RIFT_NAME.test(ask.name)) {
          return yield* new WorkspaceError({
            message: `A rift workspace's name is one path segment that does not start with ".", and "${ask.name}" is not.`,
          })
        }
        const found = yield* riftSource(input.cwd, Option.fromUndefinedOr(ask.from))
        origin = found.source
        sourceId = found.sourceId
        // The caller's place in its own repository, where the source has that directory too.
        const top = yield* gitOption(input.cwd, ["rev-parse", "--show-toplevel"])
        const real = yield* fs.realPath(input.cwd).pipe(Effect.option)
        relative = ""
        if (Option.isSome(top) && Option.isSome(real)) {
          const candidate = path.relative(yield* canonical(top.value), real.value)
          if ((yield* entryKind(path.join(origin, candidate))) === "directory") relative = candidate
        }
        break
      }
      case "Path": {
        const attached = yield* attachedDirectory(input.cwd, ask.path)
        origin = attached.top
        relative = path.relative(origin, attached.directory)
        sourceId = Option.none()
        break
      }
    }
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
      sourceId,
      relative,
      ask,
    }
    return start
  })

  /** Whether a record is the place `start` asks for: its kind, and the copy name or directory it named. */
  const sameAsk = (path: Path.Path, record: WorkspaceRecord, start: WorkspaceStart) =>
    Match.value(start.ask).pipe(
      Match.tagsExhaustive({
        Snapshot: () => record.kind === "snapshot",
        Rift: (ask) => record.kind === "rift" && record.copyName === ask.name,
        Path: () =>
          record.kind === "path" && record.path === path.join(start.origin, start.relative),
      }),
    )

  /**
   * The place for a start. The same start (parent session, parent branch,
   * tool call, origin) adopts the place it made before, so a repeated start
   * gets one place; a record of the same start that asked for another place
   * is refused. An attached directory is only named again. A copy's record
   * left by a crash recovers by its phase: a `creating` record with nothing
   * at its path is made again; a worktree whose copy holds the marker is
   * removed and made again; a rift copy is retained and the start fails; any
   * other directory is kept and the start fails. A retained copy is never
   * adopted.
   */
  const acquire = Effect.fn("Workspaces.acquire")(function* (start: WorkspaceStart) {
    return yield* locked(
      start.name,
      Effect.gen(function* () {
        const path = yield* Path.Path
        const existing = yield* readRecord(start.name)
        if (Option.isNone(existing)) return placeOf(yield* create(start))
        const record = existing.value
        if ((yield* digestOf(record)) !== start.digest) {
          return yield* new WorkspaceError({
            message: `Workspace ${start.name} belongs to another start; gent keeps it`,
          })
        }
        if (!sameAsk(path, record, start)) {
          return yield* new WorkspaceError({
            message: `Workspace ${start.name} of this start is another kind of place (${record.kind}) than it asks for now; gent keeps it`,
          })
        }
        if (!isCopyRecord(record)) return placeOf(record)
        if (record.phase === "retained") {
          return yield* new WorkspaceError({
            message: `gent keeps the copy ${record.path} (retained: ${record.retained ?? "no reason recorded"}); it makes no other for this start`,
          })
        }
        const state = yield* ownership(record)
        if (record.phase === "ready" && state === "owned") return placeOf(record)
        if (record.phase === "ready" && Predicate.isNotUndefined(record.sessionId)) {
          return yield* new WorkspaceError({
            message: `the copy at ${record.path} of this start is gone`,
          })
        }
        yield* discard(record, state)
        if (record.backend === "rift" && state === "owned") {
          return yield* new WorkspaceError({
            message: `gent keeps the copy ${record.path}, which a start that did not finish made: ${RIFT_RETAINED}`,
          })
        }
        return placeOf(yield* create(start))
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

  /**
   * Names the child session that works in the place, so its turns collect
   * and its delete releases it, and the thread that owns it (its key). A
   * place bound to another session stays its, and a session whose index
   * names another place stays with that one.
   */
  const bind = Effect.fn("Workspaces.bind")(function* (
    name: string,
    sessionId: SessionId,
    thread?: SessionId,
  ) {
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
        const linked = yield* linkedName(sessionId)
        if (Option.isSome(linked) && linked.value !== name) {
          return yield* new WorkspaceError({
            message: `Session ${sessionId} works in the copy ${linked.value}; gent does not bind it to ${name}`,
          })
        }
        // The record is the binding; the session index after it only finds it faster.
        if (Option.isNone(owner)) {
          yield* publish({ ...record.value, sessionId, ...omitUndefined({ thread }) })
        }
        yield* fs.makeDirectory(yield* inDirectory("sessions"), { recursive: true }).pipe(asError)
        yield* writeFileAtomic(yield* linkFile(sessionId), name).pipe(
          asError,
          Effect.uninterruptible,
        )
      }),
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
    return Option.map(record, placeOf)
  })

  // ── collect ──

  /**
   * The child's work as one commit over `base`, on `refs/heads/gent/<name>`
   * in the origin. The branch moves only from the commit gent last wrote: a
   * branch someone else moved, or one a worktree has checked out, stays as it
   * is, and the work stays in the copy. A rift copy is a repository of its
   * own, so its commit's objects are fetched first, by id, into no ref. A
   * copy that matches `base` holds no work: gent's branch goes.
   */
  const collectRecord = Effect.fn("Workspaces.collectRecord")(function* (input: CopyRecord) {
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
      commit = yield* commitTree(
        record.path,
        tree,
        base,
        `gent: work of child ${record.name}`,
      ).pipe(Effect.mapError(workspaceError))
      record = { ...record, nextTip: commit }
      yield* publish(record)
      const expected = Option.getOrElse(current, () => "")
      if (record.backend === "rift") {
        // The commit's objects only: a fetch by id into no ref, and no FETCH_HEAD.
        yield* git(record.origin, [
          "-c",
          "uploadpack.allowAnySHA1InWant=true",
          "fetch",
          "--no-tags",
          "--quiet",
          "--no-write-fetch-head",
          record.path,
          commit,
        ])
        yield* git(record.origin, ["cat-file", "-e", `${commit}^{commit}`])
      }
      yield* git(record.origin, ["update-ref", ref, commit, expected])
    }
    const { nextTip: _next, ...settled } = record
    record = { ...settled, tip: commit }
    const stat = yield* git(record.origin, ["diff", "--shortstat", base, commit])
    const work: Work = { branch, ...parseShortStat(stat) }
    return { work, record }
  })

  /**
   * The work of the place a session works in; none when the session has no
   * place. With `turn`, a second collect for the same turn (the round's end
   * after this extension's turn end) reads the first.
   */
  const collect = Effect.fn("Workspaces.collect")(function* (sessionId: SessionId, turn?: string) {
    const name = yield* linkedName(sessionId)
    if (Option.isNone(name)) return Option.none<CollectedWork>()
    return yield* locked(
      name.value,
      Effect.gen(function* () {
        // An attached directory is not a copy: nothing comes back from it.
        const found = Option.filter(yield* boundRecord(name.value, sessionId), isCopyRecord)
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
   * Ends a place: a worktree is removed with what gent keeps for it, a rift
   * copy is retained, an attached directory is only forgotten (gent deletes
   * nothing there). A bound copy's last work is collected first, under the
   * same lock; a collect that fails, or that leaves the work in the copy,
   * keeps everything.
   */
  const retire = Effect.fn("Workspaces.retire")(function* (record: WorkspaceRecord) {
    if (!isCopyRecord(record)) return yield* forget(record)
    const state = yield* ownership(record)
    let current = record
    if (
      state === "owned" &&
      record.phase === "ready" &&
      Predicate.isNotUndefined(record.sessionId)
    ) {
      const { work, record: collected } = yield* collectRecord(record)
      if (collected !== record) yield* publish(collected)
      current = collected
      if (Predicate.isNotUndefined(work.problem)) {
        return yield* new WorkspaceError({
          message: `gent keeps the copy ${record.path}: ${work.problem}`,
        })
      }
    }
    yield* discard(current, state)
  })

  /**
   * Ends the place of a start whose session was never bound to it (the
   * session create failed). A bound place stays: its session owns it. A
   * retained place stays as it is.
   */
  const release = Effect.fn("Workspaces.release")(function* (name: string) {
    yield* locked(
      name,
      Effect.gen(function* () {
        const record = yield* readRecord(name)
        if (Option.isNone(record) || Predicate.isNotUndefined(record.value.sessionId)) return
        if (record.value.phase === "retained") return
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
 * The places service. Threads read it with `Effect.serviceOption`, so
 * snapshot threads exist only where `@gent/workspaces` is active.
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

/** Places for snapshot threads. `options` name the rift program and the free-space floor. */
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
