/**
 * @gent/checkpoints: the work tree at the start and at the end of each turn,
 * so a user can review what a turn changed (`/diff turn`) and take it back
 * (`/revert`).
 *
 * The start capture runs at the first tool call of a turn that declares a
 * side effect, before that call runs (the `toolCall` hook, which always
 * allows). A turn that reads only, or calls no tool, captures nothing. The
 * end capture runs at the turn end (`turnAfter`), only for a turn with a
 * start. A capture catches every writer the same way: the file tools, bash,
 * the cell, MCP tools.
 *
 * Storage: one private bare git repository per work tree, under
 * `<data dir>/checkpoints/<first 16 hex of sha256(the work tree's top)>/`.
 * gent writes no ref, object or index entry into the user's repository. The
 * refs are the only record: `refs/checkpoints/<session>/<branch>/<turn>/start`
 * and `/end`, and a revert's `refs/reverts/<session>/<branch>/<request>/`
 * `before`, `target` and `done`, each path part the hex of the id, with the
 * readable ids in the commit trailers. One `for-each-ref` reads the whole
 * timeline of a store.
 *
 * Zero model tokens: no tool, no prompt section, no notice.
 *
 * @module
 */
import {
  Cause,
  Clock,
  Context,
  Crypto,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Schema,
  type Scope,
} from "effect"
import { Hex } from "effect/encoding"
import {
  BranchId,
  defineExtension,
  defineRequests,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  isRuntimeUserMessage,
  isSpawnedSession,
  type Message,
  MessageId,
  messagePartsDisplayText,
  pathWithin,
  request,
  RequestId,
  resolveDataDir,
  runProcess,
  SessionId,
  ToolCallVerdict,
  type ToolCallInput,
  type TurnAfterInput,
  writeFileAtomic,
} from "@gent/core/extensions/api"
import { git, type GitOptions, gitFailure, gitRun, parseShortStat } from "./git-plumbing.js"
import { WORKSPACE_MARKER_FILE } from "./workspaces.js"

// ── protocol ────────────────────────────────────────────────────────────────

export const CHECKPOINTS_EXTENSION_ID = ExtensionId.make("@gent/checkpoints")

/** A checkpoint request that cannot answer; `message` says why, in the user's words. */
class CheckpointsError extends Schema.TaggedError<CheckpointsError>()("CheckpointsError", {
  message: Schema.String,
}) {}

/**
 * One turn of the branch in view, newest first: `n` is 1 for the newest.
 * `captured` has a start and an end; `open` has a start only (the turn
 * runs, or its end capture failed); `none` has no checkpoint (it changed
 * nothing through a tool, or it ran outside a git work tree).
 */
const TurnRow = Schema.Struct({
  n: Schema.Int,
  messageId: MessageId,
  prompt: Schema.String,
  createdAt: Schema.Finite,
  state: Schema.Literals(["captured", "open", "none"]),
  files: Schema.Int,
  insertions: Schema.Int,
  deletions: Schema.Int,
})
type TurnRow = typeof TurnRow.Type

export const CheckpointList = Schema.Struct({
  /** Why the branch has no checkpoints at all, such as a cwd outside git. */
  problem: Schema.optional(Schema.String),
  turns: Schema.Array(TurnRow),
  /** The newest revert this branch made or landed on, done: undo writes back the files it wrote. */
  undo: Schema.optional(Schema.Struct({ requestId: Schema.String, files: Schema.Int })),
  /** The newest revert, when a stop cut it short after its target: finish it or undo it. */
  unfinished: Schema.optional(Schema.Struct({ requestId: Schema.String })),
})
export type CheckpointList = typeof CheckpointList.Type

/** A turn's change as a git patch; a first `#` line names other sessions that wrote the tree. */
export const TurnPatch = Schema.Struct({
  n: Schema.Int,
  prompt: Schema.String,
  patch: Schema.String,
})
export type TurnPatch = typeof TurnPatch.Type

/**
 * What a revert does. `Turn` takes the work tree back to before turn `#n`,
 * and with `conversation` the conversation too, on a new branch. `Undo`
 * reverts the newest revert; `Finish` writes a revert a stop cut short.
 */
export const RevertAction = Schema.TaggedUnion({
  Turn: { n: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)), conversation: Schema.Boolean },
  Undo: {},
  Finish: {},
})
export type RevertAction = typeof RevertAction.Type

export const RevertInput = Schema.Struct({
  /** One revert: a repeat with the same id does the revert once. */
  requestId: RequestId,
  action: RevertAction,
  /** Write the paths that others changed too; the revert's `before` keeps what it overwrites. */
  overwrite: Schema.optional(Schema.Boolean),
})
type RevertInput = typeof RevertInput.Type

/**
 * The paths a revert wrote, and the branch a conversation revert made; or why
 * it wrote nothing. `kept` names the paths whose bytes changed after the
 * revert recorded them: the revert wrote them too, and undo returns those
 * bytes.
 */
export const RevertOutcome = Schema.TaggedUnion({
  Reverted: {
    files: Schema.Array(Schema.String),
    branchId: Schema.optional(BranchId),
    kept: Schema.optional(Schema.Array(Schema.String)),
  },
  Refused: { reason: Schema.String, conflicts: Schema.Array(Schema.String) },
})
export type RevertOutcome = typeof RevertOutcome.Type

// ── limits ──────────────────────────────────────────────────────────────────

/** Untracked files over this size are not captured (opencode's limit). */
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024
/** A turn patch stops at this size (t3code's cap). */
const MAX_PATCH_BYTES = 10 * 1024 * 1024
/** The turns a list reads, newest first. */
const MAX_TURNS = 50
/** Checkpoints older than this go at the retention pass (Claude Code's default). */
const RETENTION = Duration.days(30)
const RETENTION_FIRST_PASS = Duration.minutes(1)
const RETENTION_INTERVAL = Duration.days(1)
/** A retention pass collects a store's garbage when the last collection is this old. */
const GC_INTERVAL = Duration.days(1)

// ── git ─────────────────────────────────────────────────────────────────────

/** The empty tree: as an attribute source it makes every file byte-exact (no eol, no filter). */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

/**
 * Settings of every store command: content byte for byte (no attribute file,
 * no line-end conversion), objects and refs synced to disk (an unclean stop
 * leaves no empty ref), no monitor daemon, and gent's own identity on its
 * commits.
 */
const STORE_SETTINGS = [
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.eol=lf",
  "-c",
  "core.safecrlf=false",
  "-c",
  "core.symlinks=true",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.fsync=objects,reference",
  "-c",
  "core.fsyncMethod=fsync",
  "-c",
  "advice.addEmbeddedRepo=false",
  "-c",
  "user.name=gent",
  "-c",
  "user.email=gent@localhost",
  `--attr-source=${EMPTY_TREE}`,
]

/**
 * gent's own environment without the variables that would point git at
 * another repository or index, and with no optional lock: a read of the
 * user's repository never rewrites its index.
 */
// oxlint-disable-next-line effect/noNullish -- Child-process environments use undefined to remove inherited variables.
const unset = undefined
const CLEAN_ENV = {
  GIT_DIR: unset,
  GIT_WORK_TREE: unset,
  GIT_INDEX_FILE: unset,
  GIT_OBJECT_DIRECTORY: unset,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: unset,
  GIT_COMMON_DIR: unset,
  GIT_OPTIONAL_LOCKS: "0",
}

/**
 * The environment of a store command: no user or system git config, no
 * system attributes file and no template directory, so no filter,
 * attribute, hook or alias of the user's runs and no setting of theirs
 * changes a checkpoint's bytes.
 */
const STORE_ENV = {
  ...CLEAN_ENV,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_PARAMETERS: unset,
  GIT_CONFIG_COUNT: unset,
  GIT_ATTR_NOSYSTEM: "1",
  GIT_TEMPLATE_DIR: unset,
}

/** A work tree and the store that keeps its checkpoints. */
interface Place {
  readonly top: string
  readonly store: string
}

const storeArgs = (place: Place, args: ReadonlyArray<string>) => [
  `--git-dir=${place.store}`,
  `--work-tree=${place.top}`,
  ...STORE_SETTINGS,
  ...args,
]

/** One store command; its trimmed stdout. */
const inStore = (place: Place, args: ReadonlyArray<string>, options: GitOptions = {}) =>
  git(place.top, storeArgs(place, args), { ...options, env: { ...STORE_ENV, ...options.env } })

/** One store command whatever its exit; its raw output. */
const inStoreRun = (place: Place, args: ReadonlyArray<string>, options: GitOptions = {}) =>
  gitRun(place.top, storeArgs(place, args), {
    ...options,
    env: { ...STORE_ENV, ...options.env },
  })

/**
 * A read of the user's repository: it writes nothing there and runs no
 * monitor program. The user's own config stays: its excludes file decides
 * what git ignores.
 */
const inRepository = (top: string, args: ReadonlyArray<string>) =>
  gitRun(top, ["-c", "core.fsmonitor=false", ...args], { env: CLEAN_ENV })

/** Paths, NUL-separated as git prints them with `-z`. */
const nulList = (text: string) => text.split("\0").filter((entry) => entry.length > 0)

const utf8Hex = (text: string) => Hex.encode(new TextEncoder().encode(text))

const sha256 = Effect.fn("Checkpoints.sha256")(function* (text: string) {
  const crypto = yield* Crypto.Crypto
  return Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(text)))
})

// ── state ───────────────────────────────────────────────────────────────────

/** A turn's start capture: running, or done with its commit (none when nothing was captured). */
type StartCapture = Deferred.Deferred<Option.Option<string>>

interface CheckpointsState {
  /** The process scope: captures and the retention pass run here, past the call that began them. */
  readonly scope: Scope.Scope
  /** Each open turn's start capture, keyed by session, branch and opening message. */
  readonly starts: Map<string, StartCapture>
  /** The place of each cwd: none outside git. */
  readonly places: Map<string, Option.Option<Place>>
  /** Whether a session is spawned; it never changes. */
  readonly spawned: Map<SessionId, boolean>
  /** The newest `Gent-At` each store wrote; each capture writes a later one. */
  readonly lastAt: Map<string, number>
  /** The data directories whose retention pass runs. */
  readonly retention: Set<string>
}

class Checkpoints extends Context.Service<Checkpoints, CheckpointsState>()(
  "@gent/extensions/src/checkpoints",
) {}

const CheckpointsResource = defineResource({
  id: "@gent/checkpoints/state",
  scope: "process",
  layer: Layer.effect(
    Checkpoints,
    Effect.gen(function* () {
      return Checkpoints.of({
        scope: yield* Effect.scope,
        starts: new Map(),
        places: new Map(),
        spawned: new Map(),
        lastAt: new Map(),
        retention: new Set(),
      })
    }),
  ),
})

const turnKey = (ids: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly messageId: MessageId
}) => `${ids.sessionId}\0${ids.branchId}\0${ids.messageId}`

// ── store ───────────────────────────────────────────────────────────────────

const NOT_GIT = (cwd: string) => `checkpoints need a git work tree; ${cwd} is not in one`

/** The work tree's top and its store, for a cwd inside a git work tree. */
const placeOf = Effect.fn("Checkpoints.placeOf")(function* (cwd: string, home: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const found = yield* inRepository(cwd, ["rev-parse", "--show-toplevel"]).pipe(
    Effect.map((result) => {
      const top = result.stdout.trim()
      if (result.exitCode !== 0 || top.length === 0) return Option.none<string>()
      return Option.some(top)
    }),
    Effect.catchTag("GitError", () => Effect.succeedNone),
  )
  return yield* Option.match(found, {
    onNone: () => Effect.succeedNone,
    onSome: (top) =>
      Effect.gen(function* () {
        const real = yield* fs.realPath(top).pipe(Effect.orElseSucceed(() => top))
        const digest = yield* sha256(real)
        const dataDir = yield* resolveDataDir(home)
        const place: Place = {
          top: real,
          store: path.join(dataDir, "checkpoints", digest.slice(0, 16)),
        }
        return Option.some(place)
      }),
  })
})

/** `placeOf`, read once per cwd. */
const locate = Effect.fn("Checkpoints.locate")(function* (cwd: string, home: string) {
  const state = yield* Checkpoints
  const key = `${home}\0${cwd}`
  const known = state.places.get(key)
  if (Predicate.isNotUndefined(known)) return known
  const place = yield* placeOf(cwd, home)
  state.places.set(key, place)
  return place
})

const storeExists = (place: Place) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.exists(`${place.store}/HEAD`)
  })

/**
 * Every store write holds the store's lock. One gent server owns a data
 * directory, so the lock covers every writer of the store.
 */
const underStoreLock =
  (place: Place) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      return yield* ctx.FileLock.withLock(`${place.store}/index`, effect)
    })

/** Make the store when it does not exist; under the store lock. */
const ensureStore = Effect.fn("Checkpoints.ensureStore")(function* (place: Place) {
  if (yield* storeExists(place)) return
  const fs = yield* FileSystem.FileSystem
  const startedAt = yield* Clock.currentTimeMillis
  yield* fs.makeDirectory(place.store, { recursive: true })
  // The work tree's path first: the retention pass removes a store whose
  // work tree is gone, and skips one that names none yet.
  yield* writeFileAtomic(`${place.store}/worktree`, `${place.top}\n`)
  // An empty template: nothing from a template directory (a hook, a config,
  // `info/attributes`) reaches the store.
  yield* Effect.gen(function* () {
    const template = yield* fs.makeTempDirectoryScoped({ prefix: "gent-template-" })
    yield* git(place.top, ["init", "--bare", "-q", `--template=${template}`, place.store], {
      env: STORE_ENV,
    })
  }).pipe(Effect.scoped)
  yield* git(place.top, [`--git-dir=${place.store}`, "config", "index.version", "4"], {
    env: STORE_ENV,
  })
  yield* git(place.top, [`--git-dir=${place.store}`, "config", "core.untrackedCache", "true"], {
    env: STORE_ENV,
  })
  yield* Effect.logInfo("checkpoints.store.created").pipe(
    Effect.annotateLogs({
      top: place.top,
      store: place.store,
      ms: (yield* Clock.currentTimeMillis) - startedAt,
    }),
  )
})

/** A gitignore pattern that names exactly one path from the top. */
const exactPattern = (file: string) => `/${file.replace(/[\\*?[\]]/g, "\\$&").replace(/ $/, "\\ ")}`

/**
 * The store's excludes: the user's `info/exclude`, then each untracked file
 * over 2 MiB. A big file the store's index still holds from when it was
 * small leaves the index, so no capture keeps a stale copy of it. The
 * count of skipped files.
 */
const syncExcludes = Effect.fn("Checkpoints.syncExcludes")(function* (place: Place) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const userExclude = yield* inRepository(place.top, [
    "rev-parse",
    "--git-path",
    "info/exclude",
  ]).pipe(
    Effect.map((result) => result.stdout.trim()),
    Effect.flatMap((file) =>
      fs.readFileString(path.resolve(place.top, file)).pipe(Effect.orElseSucceed(() => "")),
    ),
    Effect.catchTag("GitError", () => Effect.succeed("")),
  )
  const untracked = yield* inRepository(place.top, [
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
  ])
  if (untracked.exitCode !== 0) return yield* gitFailure(["ls-files"], untracked)
  const big = (yield* Effect.forEach(
    nulList(untracked.stdout).filter((file) => !file.includes("\n")),
    (file) =>
      fs.stat(path.join(place.top, file)).pipe(
        Effect.map((info) => [file].filter(() => Number(info.size) > MAX_UNTRACKED_BYTES)),
        Effect.orElseSucceed(() => []),
      ),
    { concurrency: 16 },
  )).flat()
  const lines = big.map(exactPattern)
  const next = `${userExclude.trimEnd()}\n# gent: untracked files over 2 MiB\n${lines.join("\n")}\n`
  const excludeFile = `${place.store}/info/exclude`
  const current = yield* fs.readFileString(excludeFile).pipe(Effect.orElseSucceed(() => ""))
  if (current !== next) {
    yield* fs.makeDirectory(`${place.store}/info`, { recursive: true })
    yield* writeFileAtomic(excludeFile, next)
  }
  if (big.length > 0) {
    // Plumbing, not `rm --cached`: that refuses an entry whose content differs
    // from both the file and HEAD, and a store has no HEAD.
    const removed = yield* inStoreRun(place, ["update-index", "--force-remove", "-z", "--stdin"], {
      stdin: big.map((file) => `${file}\0`).join(""),
    })
    if (removed.exitCode !== 0) return yield* gitFailure(["update-index"], removed)
  }
  return big.length
})

// ── timeline ────────────────────────────────────────────────────────────────

const MarkKind = Schema.Literals(["start", "end", "before", "target", "done"])
type MarkKind = typeof MarkKind.Type

/** One ref of a store, read from its commit's trailers. */
interface Mark {
  readonly ref: string
  readonly commit: string
  readonly kind: MarkKind
  readonly sessionId: SessionId
  readonly branchId: BranchId
  /** The turn's opening message: on a checkpoint. */
  readonly turn: Option.Option<MessageId>
  /** The revert request: on a revert's mark. */
  readonly requestId: Option.Option<string>
  /** The branch a conversation revert made: on its `target`. */
  readonly resultBranch: Option.Option<BranchId>
  readonly at: number
}

const isMarkKind = Schema.is(MarkKind)

const parseMark = (record: string): Option.Option<Mark> => {
  const [ref = "", commit = "", trailerText = ""] = record.split("\0")
  const trailers = new Map<string, string>()
  for (const line of trailerText.split("\n")) {
    const match = /^([A-Za-z-]+):\s*(.*)$/.exec(line)
    if (Predicate.isNotNull(match)) trailers.set(match[1] ?? "", match[2] ?? "")
  }
  const kind = trailers.get("Gent-Kind")
  const session = trailers.get("Gent-Session")
  const branch = trailers.get("Gent-Branch")
  const at = Number(trailers.get("Gent-At"))
  if (!isMarkKind(kind) || Predicate.isUndefined(session) || Predicate.isUndefined(branch))
    return Option.none()
  if (!Number.isFinite(at)) return Option.none()
  return Option.some({
    ref,
    commit,
    kind,
    sessionId: SessionId.make(session),
    branchId: BranchId.make(branch),
    turn: Option.map(Option.fromUndefinedOr(trailers.get("Gent-Turn")), (id) => MessageId.make(id)),
    requestId: Option.fromUndefinedOr(trailers.get("Gent-Request")),
    resultBranch: Option.map(Option.fromUndefinedOr(trailers.get("Gent-Result-Branch")), (id) =>
      BranchId.make(id),
    ),
    at,
  })
}

/** Every mark of a store, oldest first. */
const readTimeline = Effect.fn("Checkpoints.readTimeline")(function* (place: Place) {
  const result = yield* inStoreRun(place, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(contents:trailers:only,unfold)%01",
    "refs/checkpoints",
    "refs/reverts",
  ])
  if (result.exitCode !== 0) return yield* gitFailure(["for-each-ref"], result)
  return result.stdout
    .split("\x01")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.length > 0)
    .flatMap((record) => Option.toArray(parseMark(record)))
    .sort((left, right) => left.at - right.at)
})

/** A turn's checkpoints. */
interface Span {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly turn: MessageId
  readonly start: Option.Option<Mark>
  readonly end: Option.Option<Mark>
}

const spansOf = (marks: ReadonlyArray<Mark>) => {
  const spans = new Map<string, Span>()
  for (const mark of marks) {
    if (Option.isNone(mark.turn)) continue
    if (mark.kind !== "start" && mark.kind !== "end") continue
    const key = turnKey({
      sessionId: mark.sessionId,
      branchId: mark.branchId,
      messageId: mark.turn.value,
    })
    const span = spans.get(key) ?? {
      sessionId: mark.sessionId,
      branchId: mark.branchId,
      turn: mark.turn.value,
      start: Option.none(),
      end: Option.none(),
    }
    spans.set(key, { ...span, [mark.kind]: Option.some(mark) })
  }
  return spans
}

/**
 * The time a span covers: from its start to its end. A span with no end
 * covers until its branch's next start, or until now.
 */
const spanInterval = (span: Span, spans: ReadonlyArray<Span>) => {
  const from = Option.match(span.start, { onNone: () => 0, onSome: (mark) => mark.at })
  const to = Option.match(span.end, {
    onSome: (mark) => mark.at,
    onNone: () =>
      Math.min(
        Number.POSITIVE_INFINITY,
        ...spans.flatMap((other) =>
          Option.toArray(other.start)
            .filter(
              (mark) =>
                other.sessionId === span.sessionId &&
                other.branchId === span.branchId &&
                mark.at > from,
            )
            .map((mark) => mark.at),
        ),
      ),
  })
  return { from, to }
}

/** This session and every session below it by parent link. */
const lineageOf = Effect.fn("Checkpoints.lineage")(function* (sessionId: SessionId) {
  const ctx = yield* ExtensionContext
  const sessions = yield* ctx.Session.listSessions({ thread: sessionId })
  const lineage = new Set<SessionId>([sessionId])
  let grew = true
  while (grew) {
    grew = false
    for (const session of sessions) {
      const parent = session.parentSessionId
      if (Predicate.isUndefined(parent) || lineage.has(session.id) || !lineage.has(parent)) continue
      lineage.add(session.id)
      grew = true
    }
  }
  return lineage
})

// ── capture ─────────────────────────────────────────────────────────────────

/** A later `Gent-At` than any the store holds. */
const nextAt = Effect.fn("Checkpoints.nextAt")(function* (place: Place) {
  const state = yield* Checkpoints
  let last = state.lastAt.get(place.store)
  if (Predicate.isUndefined(last))
    last = Math.max(0, ...(yield* readTimeline(place)).map((mark) => mark.at))
  const at = Math.max(yield* Clock.currentTimeMillis, last + 1)
  state.lastAt.set(place.store, at)
  return at
})

const checkpointRef = (
  ids: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly messageId: MessageId
  },
  kind: "start" | "end",
) =>
  `refs/checkpoints/${utf8Hex(ids.sessionId)}/${utf8Hex(ids.branchId)}/${utf8Hex(ids.messageId)}/${kind}`

/** The commit a ref names, when it exists. */
const resolveRef = (place: Place, ref: string) =>
  inStoreRun(place, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).pipe(
    Effect.map((result) => {
      const commit = result.stdout.trim()
      if (result.exitCode !== 0 || commit.length === 0) return Option.none<string>()
      return Option.some(commit)
    }),
  )

/**
 * The work tree as a commit in the store: tracked and untracked files that
 * git does not ignore, files the user's repository tracks though an ignore
 * rule names them, and no untracked file over 2 MiB. Under the store lock.
 */
const captureTree = Effect.fn("Checkpoints.captureTree")(function* (place: Place) {
  const fs = yield* FileSystem.FileSystem
  // A lock file under the held lock is gent's own leftover from a crash.
  yield* fs.remove(`${place.store}/index.lock`, { force: true })
  const skipped = yield* syncExcludes(place)
  const forced = yield* inRepository(place.top, [
    "ls-files",
    "-z",
    "--cached",
    "--ignored",
    "--exclude-standard",
  ])
  if (forced.exitCode !== 0) return yield* gitFailure(["ls-files"], forced)
  if (nulList(forced.stdout).length > 0) {
    const added = yield* inStoreRun(
      place,
      ["add", "-f", "--ignore-errors", "--pathspec-from-file=-", "--pathspec-file-nul"],
      { stdin: forced.stdout, env: { GIT_LITERAL_PATHSPECS: "1" } },
    )
    if (added.exitCode > 1) return yield* gitFailure(["add"], added)
  }
  // One unreadable file must not stop the capture: `--ignore-errors` adds the rest and exits 1.
  const added = yield* inStoreRun(place, ["add", "-A", "--ignore-errors"])
  if (added.exitCode > 1) return yield* gitFailure(["add"], added)
  const tree = yield* inStore(place, ["write-tree"])
  return { tree, skipped }
})

/**
 * One mark: a commit of `tree` with its trailers and a fresh `Gent-At`, and
 * its ref, created only once. Under the store lock.
 */
const markCommit = Effect.fn("Checkpoints.markCommit")(function* (
  place: Place,
  mark: {
    readonly ref: string
    readonly tree: string
    readonly parent: Option.Option<string>
    readonly trailers: ReadonlyArray<readonly [string, string]>
  },
) {
  const at = yield* nextAt(place)
  const kind = mark.trailers.find(([key]) => key === "Gent-Kind")?.[1] ?? "mark"
  const message = [
    `gent checkpoint: ${kind}`,
    "",
    ...mark.trailers.map(([key, value]) => `${key}: ${value}`),
    `Gent-At: ${at}`,
  ].join("\n")
  const parents = Option.match(mark.parent, {
    onNone: () => [],
    onSome: (commit) => ["-p", commit],
  })
  const commit = yield* inStore(place, ["commit-tree", mark.tree, ...parents, "-m", message])
  // Create only: the empty old value refuses a ref that exists.
  yield* inStore(place, ["update-ref", mark.ref, commit, ""])
  return commit
})

/** Capture the work tree as the turn's `kind` checkpoint. Under the store lock. */
const capture = Effect.fn("Checkpoints.capture")(function* (
  place: Place,
  ids: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly messageId: MessageId
  },
  kind: "start" | "end",
  parent: Option.Option<string>,
) {
  const { tree, skipped } = yield* captureTree(place)
  return yield* markCommit(place, {
    ref: checkpointRef(ids, kind),
    tree,
    parent,
    trailers: [
      ["Gent-Kind", kind],
      ["Gent-Session", ids.sessionId],
      ["Gent-Branch", ids.branchId],
      ["Gent-Turn", ids.messageId],
      ["Gent-Skipped", String(skipped)],
    ],
  })
})

/** Whether this session captures in `place`: a spawned one only where a store exists. */
const capturesHere = Effect.fn("Checkpoints.capturesHere")(function* (place: Place) {
  const ctx = yield* ExtensionContext
  const state = yield* Checkpoints
  let spawned = state.spawned.get(ctx.sessionId)
  if (Predicate.isUndefined(spawned)) {
    const session = yield* ctx.Session.getSession()
    spawned = Predicate.isNotUndefined(session) && isSpawnedSession(session)
    state.spawned.set(ctx.sessionId, spawned)
  }
  if (!spawned) return true
  return yield* storeExists(place)
})

/** The turn's start: the one a restart left, or a new capture. */
const startOf = Effect.fn("Checkpoints.startOf")(function* (call: ToolCallInput) {
  const ctx = yield* ExtensionContext
  const place = yield* locate(ctx.cwd, ctx.home)
  if (Option.isNone(place) || !(yield* capturesHere(place.value))) return Option.none<string>()
  const ids = { sessionId: call.sessionId, branchId: call.branchId, messageId: call.messageId }
  return yield* Effect.gen(function* () {
    yield* ensureStore(place.value)
    const kept = yield* resolveRef(place.value, checkpointRef(ids, "start"))
    if (Option.isSome(kept)) return kept
    return Option.some(yield* capture(place.value, ids, "start", Option.none()))
  }).pipe(underStoreLock(place.value))
})

/**
 * Before a call with a side effect: the turn's start capture, once per turn.
 * Calls of one step wait for the same capture. The capture runs in the
 * process scope, so a caller that stops only stops waiting.
 */
const beforeCall = Effect.fn("Checkpoints.beforeCall")(function* (call: ToolCallInput) {
  const state = yield* Checkpoints
  const key = turnKey(call)
  const running = state.starts.get(key)
  if (Predicate.isNotUndefined(running)) return yield* Deferred.await(running)
  const started: StartCapture = Deferred.makeUnsafe()
  state.starts.set(key, started)
  yield* startOf(call).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("checkpoints.start.failed").pipe(
        Effect.annotateLogs({ cause: Cause.pretty(cause) }),
        Effect.as(Option.none<string>()),
      ),
    ),
    Effect.flatMap((commit) => Deferred.succeed(started, commit)),
    Effect.onInterrupt(() => Deferred.succeed(started, Option.none())),
    Effect.forkIn(state.scope),
  )
  return yield* Deferred.await(started)
})

/** At the turn end: the end capture, for a turn with a start. */
const afterTurn = Effect.fn("Checkpoints.afterTurn")(function* (input: TurnAfterInput) {
  const ctx = yield* ExtensionContext
  const state = yield* Checkpoints
  const key = turnKey(input)
  const running = state.starts.get(key)
  state.starts.delete(key)
  const place = yield* locate(ctx.cwd, ctx.home)
  if (Option.isNone(place)) return
  // A turn that started in this process has its start here; a turn a restart
  // recovered may have one in the store.
  let start = Option.none<string>()
  if (Predicate.isNotUndefined(running)) start = yield* Deferred.await(running)
  else if (yield* storeExists(place.value))
    start = yield* resolveRef(place.value, checkpointRef(input, "start"))
  if (Option.isNone(start)) return
  const begun = start.value
  yield* Effect.gen(function* () {
    if (Option.isSome(yield* resolveRef(place.value, checkpointRef(input, "end")))) return
    yield* capture(place.value, input, "end", Option.some(begun))
  }).pipe(underStoreLock(place.value))
})

// ── turns ───────────────────────────────────────────────────────────────────

/** A message that opens a turn: one a user or an extension sent, not one the runtime wrote. */
const opensTurn = (message: Message) => message.role === "user" && !isRuntimeUserMessage(message)

const promptOf = (message: Message) => {
  const text = message.metadata?.userText ?? messagePartsDisplayText(message.parts)
  const line = text.trim().split("\n")[0] ?? ""
  if (line.length <= 120) return line
  return `${line.slice(0, 119)}…`
}

/** One turn of the branch in view with its span, when it has one. */
interface Turn {
  readonly n: number
  readonly message: Message
  readonly span: Option.Option<Span>
}

/**
 * The branch's turns, newest first, each with its span. A turn a fork copied
 * has a new id; its span is the one of the message it copies, found by its
 * `createdAt` up the branch's parents.
 */
const turnsOf = Effect.fn("Checkpoints.turnsOf")(function* (spans: Map<string, Span>) {
  const ctx = yield* ExtensionContext
  const detail = yield* ctx.Session.getDetail(ctx.sessionId)
  const branches = new Map(detail.branches.map((entry) => [entry.branch.id, entry]))
  // A branch's parents are older than it: the walk ends at the root, and
  // never takes more steps than there are branches.
  const spanIn = (
    branchId: BranchId,
    messageId: MessageId,
    createdAt: number,
    steps: number,
  ): Option.Option<Span> => {
    const found = spans.get(turnKey({ sessionId: ctx.sessionId, branchId, messageId }))
    if (Predicate.isNotUndefined(found)) return Option.some(found)
    if (steps <= 0) return Option.none()
    const parentId = Option.fromUndefinedOr(branches.get(branchId)?.branch.parentBranchId)
    return Option.flatMap(parentId, (parent) =>
      Option.flatMap(
        Option.fromUndefinedOr(
          branches
            .get(parent)
            ?.messages.find(
              (candidate) => opensTurn(candidate) && candidate.createdAt.getTime() === createdAt,
            ),
        ),
        (copied) => spanIn(parent, copied.id, createdAt, steps - 1),
      ),
    )
  }
  const spanOf = (message: Message) =>
    spanIn(message.branchId, message.id, message.createdAt.getTime(), branches.size)
  const messages = branches.get(ctx.branchId)?.messages ?? []
  const turns = messages
    .filter(opensTurn)
    .slice(-MAX_TURNS)
    .reverse()
    .map((message, index): Turn => ({ n: index + 1, message, span: spanOf(message) }))
  return { turns, messages }
})

/** `diff --shortstat` of each end against its start, in one command. */
const shortStats = Effect.fn("Checkpoints.shortStats")(function* (
  place: Place,
  ends: ReadonlyArray<string>,
) {
  const stats = new Map<string, ReturnType<typeof parseShortStat>>()
  if (ends.length === 0) return stats
  const result = yield* inStoreRun(place, [
    "log",
    "--no-walk=unsorted",
    "--no-ext-diff",
    "--format=%x01%H",
    "--shortstat",
    ...ends,
  ])
  if (result.exitCode !== 0) return yield* gitFailure(["log"], result)
  for (const chunk of result.stdout.split("\x01")) {
    const [commit = "", ...rest] = chunk.trim().split("\n")
    if (commit.length > 0) stats.set(commit, parseShortStat(rest.join("\n")))
  }
  return stats
})

const rowState = (span: Option.Option<Span>) => {
  if (Option.isNone(span) || Option.isNone(span.value.start)) return "none" as const
  if (Option.isNone(span.value.end)) return "open" as const
  return "captured" as const
}

/** The branch's place, or why it has none. */
const placeOrProblem = Effect.gen(function* () {
  const ctx = yield* ExtensionContext
  const place = yield* locate(ctx.cwd, ctx.home)
  if (Option.isNone(place)) return yield* new CheckpointsError({ message: NOT_GIT(ctx.cwd) })
  return place.value
})

const asCheckpointsError = (cause: { readonly message: string }) =>
  new CheckpointsError({ message: cause.message })

const listTurns = Effect.gen(function* () {
  const ctx = yield* ExtensionContext
  const place = yield* locate(ctx.cwd, ctx.home)
  const marks = yield* Option.match(place, {
    onNone: () => Effect.succeed([]),
    onSome: (found) =>
      Effect.gen(function* () {
        if (!(yield* storeExists(found))) return []
        return yield* readTimeline(found)
      }),
  })
  const { turns } = yield* turnsOf(spansOf(marks))
  const ends = turns.flatMap((turn) =>
    Option.toArray(Option.flatMap(turn.span, (span) => span.end)).map((mark) => mark.commit),
  )
  const stats = yield* Option.match(place, {
    onNone: () => Effect.succeed(new Map<string, ReturnType<typeof parseShortStat>>()),
    onSome: (found) => shortStats(found, ends),
  })
  const rows = turns.map((turn): TurnRow => {
    const end = Option.flatMap(turn.span, (span) => span.end)
    const stat = Option.flatMap(end, (mark) => Option.fromUndefinedOr(stats.get(mark.commit)))
    const counts = Option.getOrElse(stat, () => ({ files: 0, insertions: 0, deletions: 0 }))
    return {
      n: turn.n,
      messageId: turn.message.id,
      prompt: promptOf(turn.message),
      createdAt: turn.message.createdAt.getTime(),
      state: rowState(turn.span),
      ...counts,
    }
  })
  const newest = newestRevert(marks, ctx.sessionId, ctx.branchId)
  const undo = yield* Option.match(Option.all({ place, revert: newest }), {
    onNone: () => Effect.succeedNone,
    onSome: ({ place: found, revert }) =>
      Effect.gen(function* () {
        if (Option.isNone(revert.done)) return Option.none()
        const files = yield* revertFiles(found, revert)
        return Option.some({ requestId: revert.requestId, files: files.length })
      }),
  })
  const unfinished = Option.filter(
    newest,
    (revert) => Option.isSome(revert.target) && Option.isNone(revert.done),
  )
  const list: CheckpointList = {
    ...Option.match(place, {
      onNone: () => ({ problem: NOT_GIT(ctx.cwd) }),
      onSome: () => ({}),
    }),
    turns: rows,
    ...Option.match(undo, { onNone: () => ({}), onSome: (value) => ({ undo: value }) }),
    ...Option.match(unfinished, {
      onNone: () => ({}),
      onSome: (revert) => ({ unfinished: { requestId: revert.requestId } }),
    }),
  }
  return list
})

/** The sessions outside this one's lineage whose turns overlap `[from, to]`, by name. */
const otherWriters = Effect.fn("Checkpoints.otherWriters")(function* (
  spans: ReadonlyArray<Span>,
  window: { readonly from: number; readonly to: number },
) {
  const ctx = yield* ExtensionContext
  const others = spans.filter((span) => span.sessionId !== ctx.sessionId)
  if (others.length === 0) return []
  const lineage = yield* lineageOf(ctx.sessionId)
  const writers = new Set<SessionId>()
  for (const span of others) {
    if (lineage.has(span.sessionId)) continue
    const interval = spanInterval(span, spans)
    if (interval.from <= window.to && interval.to >= window.from) writers.add(span.sessionId)
  }
  return yield* Effect.forEach([...writers], (sessionId) =>
    ctx.Session.getSession(sessionId).pipe(
      Effect.map((session) => session?.name ?? sessionId),
      Effect.orElseSucceed(() => sessionId),
    ),
  )
})

/** Cut a patch at the last file before the cap; one line says so. */
const capPatch = (patch: string) => {
  const bytes = new TextEncoder().encode(patch)
  if (bytes.length <= MAX_PATCH_BYTES) return patch
  const head = new TextDecoder().decode(bytes.slice(0, MAX_PATCH_BYTES))
  const lastFile = head.lastIndexOf("\ndiff --git ")
  const kept = head.slice(0, Math.max(0, lastFile + 1))
  return `${kept}# the patch stops here: it is over ${MAX_PATCH_BYTES / 1024 / 1024} MB\n`
}

const turnPatch = Effect.fn("Checkpoints.turnPatch")(function* (n: number) {
  const place = yield* placeOrProblem
  let marks: ReadonlyArray<Mark> = []
  if (yield* storeExists(place)) marks = yield* readTimeline(place)
  const spans = spansOf(marks)
  const turn = (yield* turnsOf(spans)).turns.find((found) => found.n === n)
  if (Predicate.isUndefined(turn))
    return yield* new CheckpointsError({ message: `the branch has no turn #${n}` })
  const start = Option.flatMap(turn.span, (span) => span.start)
  const end = Option.flatMap(turn.span, (span) => span.end)
  if (Option.isNone(start))
    return yield* new CheckpointsError({
      message: `turn #${n} has no checkpoint: no tool with a side effect ran in it`,
    })
  if (Option.isNone(end))
    return yield* new CheckpointsError({
      message: `turn #${n} has no end checkpoint yet: it runs, or its end capture failed`,
    })
  const diff = yield* inStoreRun(place, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "--no-color",
    start.value.commit,
    end.value.commit,
  ])
  if (diff.exitCode !== 0) return yield* gitFailure(["diff"], diff)
  const writers = yield* otherWriters([...spans.values()], {
    from: start.value.at,
    to: end.value.at,
  })
  const note = writers
    .slice(0, 1)
    .map(
      () => `# other sessions also wrote this work tree during this turn: ${writers.join(", ")}\n`,
    )
    .join("")
  const patch: TurnPatch = {
    n,
    prompt: promptOf(turn.message),
    patch: capPatch(`${note}${diff.stdout}`),
  }
  return patch
})

// ── revert ──────────────────────────────────────────────────────────────────

/** One revert's marks: `before` (the tree it replaced), `target` (the tree it writes), `done`. */
interface Revert {
  readonly requestId: string
  readonly sessionId: SessionId
  /** The branch the revert ran from. */
  readonly branchId: BranchId
  readonly before: Option.Option<Mark>
  readonly target: Option.Option<Mark>
  readonly done: Option.Option<Mark>
  /** The branch a conversation revert made. */
  readonly resultBranch: Option.Option<BranchId>
}

const revertRef = (requestId: string, kind: "before" | "target" | "done") =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    return `refs/reverts/${utf8Hex(ctx.sessionId)}/${utf8Hex(ctx.branchId)}/${utf8Hex(requestId)}/${kind}`
  })

const revertsOf = (marks: ReadonlyArray<Mark>) => {
  const reverts = new Map<string, Revert>()
  for (const mark of marks) {
    if (Option.isNone(mark.requestId)) continue
    if (mark.kind !== "before" && mark.kind !== "target" && mark.kind !== "done") continue
    const requestId = mark.requestId.value
    const known = reverts.get(requestId) ?? {
      requestId,
      sessionId: mark.sessionId,
      branchId: mark.branchId,
      before: Option.none(),
      target: Option.none(),
      done: Option.none(),
      resultBranch: Option.none(),
    }
    reverts.set(requestId, {
      ...known,
      [mark.kind]: Option.some(mark),
      resultBranch: Option.orElse(mark.resultBranch, () => known.resultBranch),
    })
  }
  return reverts
}

/** When a revert's first and last marks were written. */
const revertInterval = (revert: Revert) => {
  const marks = [revert.before, revert.target, revert.done].flatMap(Option.toArray)
  const times = marks.map((mark) => mark.at)
  return { from: Math.min(...times), to: Math.max(...times) }
}

/**
 * The newest revert the branch made, or the one that made the branch: one
 * with its target recorded. A revert with a `before` alone wrote nothing.
 */
const newestRevert = (marks: ReadonlyArray<Mark>, sessionId: SessionId, branchId: BranchId) =>
  Option.fromUndefinedOr(
    [...revertsOf(marks).values()]
      .filter(
        (revert) =>
          revert.sessionId === sessionId &&
          Option.isSome(revert.before) &&
          Option.isSome(revert.target) &&
          (revert.branchId === branchId ||
            Option.exists(revert.resultBranch, (made) => made === branchId)),
      )
      .sort((left, right) => revertInterval(left).from - revertInterval(right).from)
      .at(-1),
  )

/** The paths two commits differ in. */
const changedPaths = Effect.fn("Checkpoints.changedPaths")(function* (
  place: Place,
  from: string,
  to: string,
) {
  if (from === to) return new Set<string>()
  const result = yield* inStoreRun(place, [
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    from,
    to,
  ])
  if (result.exitCode !== 0) return yield* gitFailure(["diff"], result)
  return new Set(nulList(result.stdout))
})

/** Every file path of a tree. */
const treePaths = Effect.fn("Checkpoints.treePaths")(function* (place: Place, tree: string) {
  const result = yield* inStoreRun(place, ["ls-tree", "-r", "-z", "--name-only", tree])
  if (result.exitCode !== 0) return yield* gitFailure(["ls-tree"], result)
  return new Set(nulList(result.stdout))
})

const treeOf = (place: Place, commit: string) => inStore(place, ["rev-parse", `${commit}^{tree}`])

/** Delete refs in one transaction. */
const deleteRefs = (place: Place, refs: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (refs.length === 0) return
    const result = yield* inStoreRun(place, ["update-ref", "--stdin"], {
      stdin: refs.map((ref) => `delete ${ref}\n`).join(""),
    })
    if (result.exitCode !== 0) return yield* gitFailure(["update-ref"], result)
  })

/** The paths a revert writes: where its target differs from its before. */
const revertFiles = Effect.fn("Checkpoints.revertFiles")(function* (place: Place, revert: Revert) {
  if (Option.isNone(revert.before) || Option.isNone(revert.target)) return []
  return [
    ...(yield* changedPaths(place, revert.before.value.commit, revert.target.value.commit)),
  ].sort()
})

/** Every other loop that works in this work tree, by name. */
const blockers = Effect.fn("Checkpoints.blockers")(function* (place: Place) {
  const ctx = yield* ExtensionContext
  const path = yield* Path.Path
  const loops = yield* ctx.Session.listActiveLoops
  const names: Array<string> = []
  for (const loop of loops) {
    if (loop.sessionId === ctx.sessionId && loop.branchId === ctx.branchId) continue
    if (!Option.exists(loop.status, (status) => status !== "Idle")) continue
    const session = yield* ctx.Session.getSession(loop.sessionId)
    const other = yield* locate(session?.cwd ?? ctx.cwd, ctx.home)
    if (Option.isNone(other)) continue
    const top = other.value.top
    if (!pathWithin(path, place.top, top) && !pathWithin(path, top, place.top)) continue
    const status = Option.getOrElse(loop.status, () => "working")
    names.push(`${session?.name ?? "a session"} (${loop.sessionId}, ${status})`)
  }
  return names
})

interface Plan {
  /** The paths to write, each from the target or removed when the target has no such file. */
  readonly paths: ReadonlyArray<string>
  /** The paths to write that someone else also changed, or that are on disk but not captured. */
  readonly conflicts: ReadonlyArray<string>
}

/** A path on disk the `current` capture does not hold: ignored, or untracked over 2 MiB. */
const uncaptured = Effect.fn("Checkpoints.uncaptured")(function* (
  place: Place,
  current: string,
  paths: ReadonlyArray<string>,
) {
  const held = yield* treePaths(place, current)
  const kinds = workTreeKinds(place)
  // As git sees the work tree: a directory, or a path under a link or a file, holds no file.
  return yield* Effect.filter(
    paths.filter((file) => !held.has(file)),
    (file) =>
      kinds.seen(file).pipe(Effect.map((kind) => kind !== "absent" && kind !== "directory")),
  )
})

/**
 * Back to before a turn: the paths this session and the sessions below it
 * changed since the turn began, each to its content at the turn's start.
 * The store's marks since that start cut the time into intervals; one a
 * lineage span covers is the lineage's, one no lineage span covers (the
 * user, another session, a job left running) is someone else's, and one both
 * cover is both. A path someone else changed is kept, and is a conflict when
 * the lineage changed it too. Each interval counts on its own: a change and
 * its reversal in two intervals are both seen, though the ends agree.
 */
const turnPlan = Effect.fn("Checkpoints.turnPlan")(function* (
  place: Place,
  marks: ReadonlyArray<Mark>,
  start: Mark,
  current: { readonly commit: string; readonly at: number },
) {
  const ctx = yield* ExtensionContext
  const lineage = yield* lineageOf(ctx.sessionId)
  const spans = [...spansOf(marks).values()]
  const intervals = [
    ...spans.map((span) => ({ ours: lineage.has(span.sessionId), ...spanInterval(span, spans) })),
    ...[...revertsOf(marks).values()].map((revert) => ({
      ours: lineage.has(revert.sessionId),
      ...revertInterval(revert),
    })),
  ]
  const points = [
    ...marks.flatMap(({ at, commit }) => [{ at, commit }].filter(() => at >= start.at)),
    current,
  ]
  const covered = (ours: boolean, from: number, to: number) =>
    intervals.some(
      (interval) => interval.ours === ours && interval.from <= from && interval.to >= to,
    )
  const lineagePaths = new Set<string>()
  const otherPaths = new Set<string>()
  for (const [index, point] of points.entries()) {
    const next = points[index + 1]
    if (Predicate.isUndefined(next)) break
    const ours = covered(true, point.at, next.at)
    const theirs = !ours || covered(false, point.at, next.at)
    for (const file of yield* changedPaths(place, point.commit, next.commit)) {
      if (ours) lineagePaths.add(file)
      if (theirs) otherPaths.add(file)
    }
  }
  const sinceStart = yield* changedPaths(place, start.commit, current.commit)
  const paths = [...sinceStart].filter((file) => lineagePaths.has(file)).sort()
  const missing = new Set(yield* uncaptured(place, current.commit, paths))
  const plan: Plan = {
    paths,
    conflicts: paths.filter((file) => otherPaths.has(file) || missing.has(file)),
  }
  return plan
})

/**
 * Undo a revert: the paths it wrote, back to its `before`. A path that
 * changed since the revert's target is a conflict: someone wrote it after
 * the revert, or after a stop cut the revert short.
 */
const undoPlan = Effect.fn("Checkpoints.undoPlan")(function* (
  place: Place,
  undone: Revert,
  current: string,
) {
  const written = yield* revertFiles(place, undone)
  const before = Option.getOrThrow(undone.before).commit
  const sinceBefore = yield* changedPaths(place, before, current)
  const paths = written.filter((file) => sinceBefore.has(file))
  const sinceWrite = yield* changedPaths(place, Option.getOrThrow(undone.target).commit, current)
  const missing = new Set(yield* uncaptured(place, current, paths))
  const plan: Plan = {
    paths,
    conflicts: paths.filter((file) => sinceWrite.has(file) || missing.has(file)),
  }
  return plan
})

// ── work tree writes ────────────────────────────────────────────────────────

/** What stands at a path: a link is not followed. */
type EntryKind = "absent" | "file" | "link" | "directory" | "other"

/** What stands at `at`; a failure other than absence fails. */
const entryKind = Effect.fn("Checkpoints.entryKind")(function* (at: string) {
  const fs = yield* FileSystem.FileSystem
  if (Option.isSome(yield* fs.readLink(at).pipe(Effect.option))) return "link" satisfies EntryKind
  const info = yield* fs.stat(at).pipe(
    Effect.asSome,
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeedNone,
    ),
  )
  if (Option.isNone(info)) return "absent" satisfies EntryKind
  if (info.value.type === "File") return "file" satisfies EntryKind
  if (info.value.type === "Directory") return "directory" satisfies EntryKind
  return "other" satisfies EntryKind
})

/**
 * What stands at each path of the work tree, read once per write. `own` is
 * the entry itself; `seen` is what git sees, for which a path under a link
 * or a file is absent.
 */
const workTreeKinds = (place: Place) => {
  const kinds = new Map<string, EntryKind>()
  const own = (file: string) =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const known = kinds.get(file)
      if (Predicate.isNotUndefined(known)) return known
      const kind = yield* entryKind(path.join(place.top, file))
      kinds.set(file, kind)
      return kind
    })
  const seen = (file: string) =>
    Effect.gen(function* () {
      const parts = file.split("/")
      for (let depth = 1; depth < parts.length; depth++)
        if ((yield* own(parts.slice(0, depth).join("/"))) !== "directory")
          return "absent" satisfies EntryKind
      return yield* own(file)
    })
  return { own, seen }
}

/** An entry no tree holds: what a special file (a socket, a pipe) is compared as. */
const SPECIAL = "special"

/** Each of `paths` in `tree`, as `<mode> <object>`; a path the tree lacks has none. */
const treeEntries = Effect.fn("Checkpoints.treeEntries")(function* (
  place: Place,
  tree: string,
  paths: ReadonlyArray<string>,
) {
  const listing = yield* inStoreRun(place, ["ls-tree", "-r", "-z", "--full-tree", tree])
  if (listing.exitCode !== 0) return yield* gitFailure(["ls-tree"], listing)
  const wanted = new Set(paths)
  const entries = new Map<string, string>()
  for (const line of nulList(listing.stdout)) {
    const tab = line.indexOf("\t")
    const file = line.slice(tab + 1)
    if (!wanted.has(file)) continue
    const [mode = "", , object = ""] = line.slice(0, tab).split(" ")
    entries.set(file, `${mode} ${object}`)
  }
  return entries
})

/** The bytes of the file names one `hash-object` call takes as arguments. */
const HASH_ARGUMENT_BYTES = 64 * 1024

/**
 * Each of `paths` on disk now, as `<mode> <object>`, hashed byte for byte
 * (no filter, no line-end change), whatever the capture excludes; with
 * `keep`, the objects go into the store, so a tree can hold them. A
 * directory is no entry, as git sees it. The names go to git as arguments
 * after `--`: `--stdin-paths` would read a name in quotes as a C string.
 */
const diskEntries = Effect.fn("Checkpoints.diskEntries")(function* (
  place: Place,
  paths: ReadonlyArray<string>,
  keep: boolean,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const write = ["-w"].filter(() => keep)
  const entries = new Map<string, string>()
  const files: Array<{ readonly file: string; readonly mode: string }> = []
  const kinds = workTreeKinds(place)
  for (const file of paths) {
    const at = path.join(place.top, file)
    const kind = yield* kinds.seen(file)
    if (kind === "link") {
      const object = yield* inStore(place, ["hash-object", ...write, "--no-filters", "--stdin"], {
        stdin: yield* fs.readLink(at),
      })
      entries.set(file, `120000 ${object}`)
    }
    if (kind === "other") entries.set(file, SPECIAL)
    if (kind !== "file") continue
    // git keeps one executable bit: the owner's.
    let mode = "100644"
    if (((yield* fs.stat(at)).mode & 0o100) !== 0) mode = "100755"
    files.push({ file, mode })
  }
  const batches: Array<Array<string>> = []
  let size = HASH_ARGUMENT_BYTES
  for (const { file } of files) {
    const bytes = new TextEncoder().encode(file).length + 1
    if (size + bytes > HASH_ARGUMENT_BYTES) {
      batches.push([])
      size = 0
    }
    batches.at(-1)?.push(file)
    size += bytes
  }
  const objects: Array<string> = []
  for (const batch of batches) {
    const hashed = yield* inStore(place, ["hash-object", ...write, "--no-filters", "--", ...batch])
    objects.push(...hashed.split("\n"))
  }
  for (const [index, { file, mode }] of files.entries())
    entries.set(file, `${mode} ${objects[index] ?? ""}`)
  return entries
})

/** A scratch index in the store, removed with the scope. */
const scratchIndex = (place: Place) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const index = `${place.store}/gent-revert.index`
    yield* fs.remove(index, { force: true })
    yield* Effect.addFinalizer(() => fs.remove(index, { force: true }).pipe(Effect.ignore))
    return { GIT_INDEX_FILE: index }
  })

/** `base` with each of `paths` set to its entry, or removed where `entries` has none. */
const overlaidTree = Effect.fn("Checkpoints.overlaidTree")(function* (
  place: Place,
  base: string,
  paths: ReadonlyArray<string>,
  entries: ReadonlyMap<string, string>,
) {
  // Removals first: a file can then take the place of a directory the same
  // write empties. No `--replace`: an entry in the way fails the write.
  const removals = paths.flatMap((file) =>
    [`0 ${"0".repeat(40)}\t${file}`].filter(() => !entries.has(file)),
  )
  const additions = paths.flatMap((file) =>
    Option.toArray(Option.fromUndefinedOr(entries.get(file))).map((entry) => `${entry}\t${file}`),
  )
  return yield* Effect.gen(function* () {
    const env = yield* scratchIndex(place)
    yield* inStore(place, ["read-tree", base], { env })
    const update = yield* inStoreRun(place, ["update-index", "--add", "-z", "--index-info"], {
      env,
      stdin: [...removals, ...additions].map((line) => `${line}\0`).join(""),
    })
    if (update.exitCode !== 0) return yield* gitFailure(["update-index"], update)
    return yield* inStore(place, ["write-tree"], { env })
  }).pipe(Effect.scoped)
})

/**
 * What stands where a write of `paths` goes: an ancestor that is a link or a
 * file, where the write needs a directory; a directory where it writes a
 * file; a special file. An entry the write removes first (one of `removed`)
 * is not in the way. git would replace each of these, so a write never
 * starts over one.
 */
const obstructions = Effect.fn("Checkpoints.obstructions")(function* (
  place: Place,
  paths: ReadonlyArray<string>,
  removed: ReadonlySet<string>,
) {
  const kinds = workTreeKinds(place)
  const found = new Set<string>()
  for (const file of paths) {
    const parts = file.split("/")
    let clear = true
    for (let depth = 1; depth < parts.length && clear; depth++) {
      const ancestor = parts.slice(0, depth).join("/")
      const kind = yield* kinds.own(ancestor)
      if (kind === "directory") continue
      clear = false
      if (kind !== "absent" && !removed.has(ancestor)) found.add(ancestor)
    }
    if (!clear) continue
    const kind = yield* kinds.own(file)
    if (kind === "other") found.add(file)
    const emptied = paths.some((inner) => inner.startsWith(`${file}/`) && removed.has(inner))
    if (kind === "directory" && !emptied) found.add(file)
  }
  return [...found].sort()
})

const OBSTRUCTED =
  "something stands where the revert writes: a link or a file where it needs a directory, or a directory where it writes a file; move it, then revert"

const unfinishedError = (what: string) =>
  new CheckpointsError({ message: `${what}; the revert stays unfinished: finish it or undo it` })

/** Each directory from `directory` up to the top, while it is empty. */
const removeEmptyDirectories = Effect.fn("Checkpoints.removeEmptyDirectories")(function* (
  place: Place,
  directory: string,
) {
  const path = yield* Path.Path
  let parent = directory
  while (parent !== "." && parent !== "") {
    // `rmdir` removes only an empty directory, in one step: a file another
    // writer puts there first keeps it.
    const removed = yield* runProcess("rmdir", [path.join(place.top, parent)]).pipe(Effect.option)
    if (!Option.exists(removed, (result) => result.exitCode === 0)) return
    parent = path.dirname(parent)
  }
})

/** A revert as its write needs it. */
interface Recorded {
  /** The revert's own request: it names the revert's asides. */
  readonly requestId: string
  readonly beforeRef: string
  /** The tree the revert writes. */
  readonly target: string
  readonly paths: ReadonlyArray<string>
}

/**
 * Where a path moves aside: its own directory (a rename there is atomic and
 * stays on one file system), under a name fixed by the revert and the path,
 * so a later run finds what a stop left.
 */
const asideOf = Effect.fn("Checkpoints.asideOf")(function* (requestId: string, file: string) {
  const path = yield* Path.Path
  const name = `.gent-aside-${(yield* sha256(requestId)).slice(0, 16)}-${(yield* sha256(file)).slice(0, 16)}`
  return path.join(path.dirname(file), name)
})

/**
 * Where git writes a revert's target entries before each goes to its path:
 * a directory at the top, named by the revert. It holds copies of store
 * content only, so a run removes what a stop left there.
 */
const stageOf = Effect.fn("Checkpoints.stageOf")(function* (place: Place, requestId: string) {
  const path = yield* Path.Path
  const name = `.gent-write-${(yield* sha256(requestId)).slice(0, 16)}`
  return { name, at: path.join(place.top, name) }
})

/**
 * Keep the bytes of moved-aside entries, then remove the asides. Each aside
 * whose entry differs from what the revert's `before` holds for its path
 * goes into `before`: the ref moves, old value checked, to a commit of the
 * amended tree with the same message, so a stop leaves the old record or
 * the new one. Only then does an aside go. The paths it kept.
 */
const keepAsides = Effect.fn("Checkpoints.keepAsides")(function* (
  place: Place,
  revert: Recorded,
  asides: ReadonlyMap<string, string>,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (asides.size === 0) return []
  const files = [...asides.keys()]
  const moved = yield* diskEntries(place, [...asides.values()], true)
  const entries = new Map(
    files.flatMap((file) =>
      Option.toArray(Option.fromUndefinedOr(moved.get(asides.get(file) ?? ""))).map(
        (entry) => [file, entry] as const,
      ),
    ),
  )
  const old = yield* inStore(place, ["rev-parse", "--verify", `${revert.beforeRef}^{commit}`])
  const base = yield* treeOf(place, old)
  const was = yield* treeEntries(place, base, files)
  const kept = files.filter((file) => entries.get(file) !== was.get(file))
  if (kept.length > 0) {
    const tree = yield* overlaidTree(place, base, kept, entries)
    const raw = yield* inStore(place, ["cat-file", "commit", old])
    const message = raw.slice(raw.indexOf("\n\n") + 2)
    const commit = yield* inStore(place, ["commit-tree", tree, "-p", old, "-m", message])
    yield* inStore(place, ["update-ref", revert.beforeRef, commit, old])
  }
  for (const [file, aside] of asides)
    yield* fs
      .remove(path.join(place.top, aside))
      .pipe(
        Effect.mapError((error) =>
          unfinishedError(`the revert could not remove the aside of ${file}: ${error.message}`),
        ),
      )
  return kept
})

/**
 * Swap each of `pending` to its `goal` entry. The order keeps every byte
 * the revert takes away in the store before it goes:
 *
 * 1. each file or link at a path moves aside (a rename in its directory, so
 *    the bytes the revert takes are the bytes it holds);
 * 2. `keepAsides` hashes what moved into the store, moves `before` to hold
 *    bytes it lacks, and only then removes the asides;
 * 3. each directory a removal empties goes (`rmdir`: only an empty one);
 * 4. git writes each goal entry from the store into the stage; each goes to
 *    its path by link (or symlink), which never replaces an entry: a writer
 *    that put something at the path since step 1 keeps it, and the write
 *    fails. (A rename would replace it.)
 *
 * A stop in 1 or 2 leaves each aside or, after the ref moved, its bytes in
 * `before`; a stop in 4 leaves the stage, which holds store copies only.
 * Finish and undo take both up first (`takeUpAsides`). A writer that holds
 * a file open and writes after step 1 writes to the aside, out of reach.
 * The paths kept for undo.
 */
const swap = Effect.fn("Checkpoints.swap")(function* (
  place: Place,
  revert: Recorded,
  pending: ReadonlyArray<string>,
  goal: ReadonlyMap<string, string>,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const fail = (file: string, why: string) =>
    unfinishedError(`the revert could not write ${file}: ${why}`)
  const kinds = workTreeKinds(place)
  const asides = new Map<string, string>()
  for (const file of pending) {
    const kind = yield* kinds.seen(file)
    if (kind !== "file" && kind !== "link") continue
    const aside = yield* asideOf(revert.requestId, file)
    const directory = path.dirname(path.join(place.top, file))
    const real = yield* fs
      .realPath(directory)
      .pipe(Effect.mapError((error) => fail(file, error.message)))
    if (real !== directory)
      return yield* fail(file, "its directory is no longer one of the work tree")
    yield* fs
      .rename(path.join(place.top, file), path.join(place.top, aside))
      .pipe(Effect.mapError((error) => fail(file, error.message)))
    asides.set(file, aside)
  }
  const kept = yield* keepAsides(place, revert, asides)
  for (const file of pending.filter((entry) => !goal.has(entry)))
    yield* removeEmptyDirectories(place, path.dirname(file))
  const writes = pending.filter((entry) => goal.has(entry))
  if (writes.length === 0) return kept
  const stage = yield* stageOf(place, revert.requestId)
  yield* Effect.gen(function* () {
    const env = yield* scratchIndex(place)
    yield* inStore(place, ["read-tree", revert.target], { env })
    yield* Effect.addFinalizer(() =>
      fs.remove(stage.at, { recursive: true, force: true }).pipe(Effect.ignore),
    )
    const staged = yield* inStoreRun(
      place,
      ["checkout-index", `--prefix=${stage.name}/`, "-z", "--stdin"],
      { env, stdin: writes.map((file) => `${file}\0`).join("") },
    )
    if (staged.exitCode !== 0) return yield* gitFailure(["checkout-index"], staged)
    for (const file of writes) {
      const at = path.join(place.top, file)
      const directory = path.dirname(at)
      const from = path.join(stage.at, file)
      const real = yield* fs.makeDirectory(directory, { recursive: true }).pipe(
        Effect.andThen(fs.realPath(directory)),
        Effect.mapError((error) => fail(file, error.message)),
      )
      if (real !== directory)
        return yield* fail(file, "its directory is no longer one of the work tree")
      const link = yield* fs.readLink(from).pipe(Effect.option)
      const put = Option.match(link, {
        onNone: () => fs.link(from, at),
        onSome: (text) => fs.symlink(text, at),
      })
      yield* put.pipe(Effect.mapError((error) => fail(file, error.message)))
    }
  }).pipe(Effect.scoped)
  return kept
})

/**
 * Recovery after a stop: the asides a stopped run of `revert` left, by their
 * fixed names, go into its `before` (`keepAsides`), and its stage goes. The
 * paths it kept.
 */
const takeUpAsides = Effect.fn("Checkpoints.takeUpAsides")(function* (
  place: Place,
  revert: Recorded,
) {
  const kinds = workTreeKinds(place)
  const left = new Map<string, string>()
  for (const file of revert.paths) {
    const aside = yield* asideOf(revert.requestId, file)
    const kind = yield* kinds.seen(aside)
    if (kind === "file" || kind === "link") left.set(file, aside)
  }
  const fs = yield* FileSystem.FileSystem
  const stage = yield* stageOf(place, revert.requestId)
  yield* fs.remove(stage.at, { recursive: true, force: true }).pipe(Effect.ignore)
  return yield* keepAsides(place, revert, left)
})

/**
 * Write a recorded revert's target over the work tree. First, asides a stop
 * left go into `before` (`keepAsides`). Then each path must hold its
 * `before` (to write), its target (written), or nothing while `before`
 * holds its bytes (a stop moved it aside); any other content is an edit
 * since the revert recorded the path. Without `overwrite` the write refuses
 * and names those paths; with it they are written too, and `swap` keeps
 * their bytes for undo. Only the paths not at their target are examined for
 * what stands in the way. After the write, each path must hold its target.
 */
const writeTarget = Effect.fn("Checkpoints.writeTarget")(function* (
  place: Place,
  revert: Recorded,
  /** Why a refusal over later edits refuses, in the user's words; none writes over them. */
  refuseEdits: Option.Option<(count: number) => string>,
) {
  const recovered = yield* takeUpAsides(place, revert)
  const goal = yield* treeEntries(place, revert.target, revert.paths)
  const before = yield* treeOf(place, yield* inStore(place, ["rev-parse", revert.beforeRef]))
  const was = yield* treeEntries(place, before, revert.paths)
  const now = yield* diskEntries(place, revert.paths, false)
  const holds = (entries: ReadonlyMap<string, string>, file: string) =>
    now.get(file) === entries.get(file)
  const changed = revert.paths.filter(
    (file) => !holds(was, file) && !holds(goal, file) && (now.has(file) || !was.has(file)),
  )
  const refusal = (outcome: RevertOutcome) => ({ refusal: Option.some(outcome), kept: [] })
  const refuse = Option.filter(refuseEdits, () => changed.length > 0)
  if (Option.isSome(refuse)) return refusal(refused(refuse.value(changed.length), changed))
  const pending = revert.paths.filter((file) => !holds(goal, file))
  const blocked = yield* obstructions(
    place,
    pending,
    new Set(pending.filter((file) => !goal.has(file))),
  )
  if (blocked.length > 0) return refusal(refused(OBSTRUCTED, blocked))
  const kept = yield* swap(place, revert, pending, goal)
  const after = yield* diskEntries(place, revert.paths, false)
  const unwritten = revert.paths.filter((file) => after.get(file) !== goal.get(file))
  if (unwritten.length > 0)
    return yield* unfinishedError(
      `the work tree does not hold what the revert wrote: ${unwritten.join(", ")}`,
    )
  return {
    refusal: Option.none<RevertOutcome>(),
    kept: [...new Set([...recovered, ...kept])].sort(),
  }
})

const revertTrailers = (requestId: string, kind: "before" | "target" | "done") =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const trailers: ReadonlyArray<readonly [string, string]> = [
      ["Gent-Kind", kind],
      ["Gent-Session", ctx.sessionId],
      ["Gent-Branch", ctx.branchId],
      ["Gent-Request", requestId],
    ]
    return trailers
  })

const refused = (reason: string, conflicts: ReadonlyArray<string> = []): RevertOutcome =>
  RevertOutcome.cases.Refused.make({ reason, conflicts: [...conflicts] })

const reverted = (
  files: ReadonlyArray<string>,
  branch: Option.Option<BranchId>,
  kept: ReadonlyArray<string> = [],
): RevertOutcome =>
  RevertOutcome.cases.Reverted.make({
    files: [...files],
    ...Option.match(branch, { onNone: () => ({}), onSome: (branchId) => ({ branchId }) }),
    ...Option.match(
      Option.liftPredicate(kept, (paths) => paths.length > 0),
      { onNone: () => ({}), onSome: (paths) => ({ kept: [...paths] }) },
    ),
  })

/**
 * Write a plan: record the tree it replaces (`before`), fork the
 * conversation when asked, record the tree it writes (`target`), write the
 * work tree, then `done`. Each ref is created once, so a repeat converges.
 * The `before` holds each path to write as its bytes on disk, whatever the
 * capture excludes (an ignored file, an untracked file over 2 MiB): undo
 * returns all it overwrote.
 */
const applyPlan = Effect.fn("Checkpoints.applyPlan")(function* (
  place: Place,
  params: {
    readonly requestId: string
    readonly current: string
    readonly source: string
    readonly plan: Plan
    readonly fork: Option.Option<{ readonly atMessageId: MessageId; readonly name: string }>
    /** The branch an earlier run made, when this run finishes it. */
    readonly made: Option.Option<BranchId>
  },
) {
  const ctx = yield* ExtensionContext
  const paths = params.plan.paths
  const sourceEntries = yield* treeEntries(place, params.source, paths)
  const now = yield* diskEntries(place, paths, true)
  const pending = paths.filter((file) => now.get(file) !== sourceEntries.get(file))
  const blocked = yield* obstructions(
    place,
    pending,
    new Set(pending.filter((file) => !sourceEntries.has(file))),
  )
  if (blocked.length > 0) return refused(OBSTRUCTED, blocked)
  const beforeTree = yield* overlaidTree(place, yield* treeOf(place, params.current), paths, now)
  const beforeRef = yield* revertRef(params.requestId, "before")
  const before = yield* markCommit(place, {
    ref: beforeRef,
    tree: beforeTree,
    parent: Option.none(),
    trailers: yield* revertTrailers(params.requestId, "before"),
  })
  const made = yield* Option.match(params.fork, {
    onNone: () => Effect.succeed(params.made),
    onSome: (fork) =>
      ctx.Session.forkBranch({
        atMessageId: fork.atMessageId,
        name: fork.name,
        requestId: RequestId.make(params.requestId),
      }).pipe(Effect.map(({ branchId }) => Option.some(branchId))),
  })
  const tree = yield* overlaidTree(place, beforeTree, paths, sourceEntries)
  const target = yield* markCommit(place, {
    ref: yield* revertRef(params.requestId, "target"),
    tree,
    parent: Option.some(before),
    trailers: [
      ...(yield* revertTrailers(params.requestId, "target")),
      ...Option.toArray(made).map((branchId) => ["Gent-Result-Branch", branchId] as const),
    ],
  })
  // The plan decided these paths: bytes a writer puts there from now on are
  // written over too, and kept for undo.
  const written = yield* writeTarget(
    place,
    { requestId: params.requestId, beforeRef, target: tree, paths },
    Option.none(),
  )
  if (Option.isSome(written.refusal)) return written.refusal.value
  yield* markCommit(place, {
    ref: yield* revertRef(params.requestId, "done"),
    tree,
    parent: Option.some(target),
    trailers: yield* revertTrailers(params.requestId, "done"),
  })
  return reverted(pending, made, written.kept)
})

/**
 * Finish a recorded revert: write its target and mark it done, once; a done
 * revert only answers again (the work tree may have moved on since). A path
 * someone changed after the stop refuses the finish; with overwrite it is
 * written too, and the revert's `before` keeps its bytes for undo.
 */
const finishRevert = Effect.fn("Checkpoints.finishRevert")(function* (
  place: Place,
  revert: Revert,
  input: RevertInput,
) {
  if (Option.isSome(revert.done))
    return reverted(yield* revertFiles(place, revert), revert.resultBranch)
  const target = Option.getOrThrow(revert.target)
  const tree = yield* treeOf(place, target.commit)
  const recorded: Recorded = {
    requestId: revert.requestId,
    beforeRef: Option.getOrThrow(revert.before).ref,
    target: tree,
    paths: yield* revertFiles(place, revert),
  }
  const written = yield* writeTarget(
    place,
    recorded,
    Option.liftPredicate(
      (count: number) =>
        `${count} of the files to write changed since this revert stopped; finish with overwrite to write them (undo returns them)`,
      () => input.overwrite !== true,
    ),
  )
  if (Option.isSome(written.refusal)) return written.refusal.value
  // The `done` names the revert's own refs, whichever request finishes it.
  yield* markCommit(place, {
    ref: target.ref.replace(/\/target$/, "/done"),
    tree,
    parent: Option.some(target.commit),
    trailers: [
      ["Gent-Kind", "done"],
      ["Gent-Session", revert.sessionId],
      ["Gent-Branch", revert.branchId],
      ["Gent-Request", revert.requestId],
    ],
  })
  return reverted(recorded.paths, revert.resultBranch, written.kept)
})

/** Back to before turn `#n`. */
const revertTurn = Effect.fn("Checkpoints.revertTurn")(function* (
  place: Place,
  marks: ReadonlyArray<Mark>,
  input: RevertInput,
  action: { readonly n: number; readonly conversation: boolean },
) {
  const { turns, messages } = yield* turnsOf(spansOf(marks))
  const turn = turns.find((found) => found.n === action.n)
  if (Predicate.isUndefined(turn)) return refused(`the branch has no turn #${action.n}`)
  const start = Option.flatMap(turn.span, (span) => span.start)
  if (Option.isNone(start))
    return refused(`turn #${action.n} has no checkpoint: no tool with a side effect ran in it`)
  const opener = messages.findIndex((message) => message.id === turn.message.id)
  const previous = Option.fromUndefinedOr(messages[opener - 1])
  if (action.conversation && Option.isNone(previous))
    return refused("this is the first turn: revert files only, or start a new session")
  const current = yield* currentCommit(place)
  const plan = yield* turnPlan(place, marks, start.value, current)
  if (plan.conflicts.length > 0 && input.overwrite !== true)
    return refused(
      `others also changed ${plan.conflicts.length} of the files to revert; revert with overwrite to write them (undo returns them)`,
      plan.conflicts,
    )
  return yield* applyPlan(place, {
    requestId: input.requestId,
    current: current.commit,
    source: start.value.commit,
    plan,
    fork: Option.filter(
      Option.map(previous, (message) => ({
        atMessageId: message.id,
        name: `before: ${promptOf(turn.message)}`,
      })),
      () => action.conversation,
    ),
    made: Option.none(),
  })
})

/** The work tree now, as a commit in the store, with a time later than every mark. */
const currentCommit = Effect.fn("Checkpoints.currentCommit")(function* (place: Place) {
  const { tree } = yield* captureTree(place)
  const commit = yield* inStore(place, ["commit-tree", tree, "-m", "gent checkpoint: now"])
  const state = yield* Checkpoints
  const at = Math.max(yield* Clock.currentTimeMillis, (state.lastAt.get(place.store) ?? 0) + 1)
  return { commit, at }
})

/** Revert the newest revert of the branch. */
const revertRevert = Effect.fn("Checkpoints.revertRevert")(function* (
  place: Place,
  marks: ReadonlyArray<Mark>,
  input: RevertInput,
) {
  const ctx = yield* ExtensionContext
  const undone = newestRevert(marks, ctx.sessionId, ctx.branchId)
  if (Option.isNone(undone)) return refused("there is no revert to undo")
  const recorded = Option.getOrThrow(undone.value.before)
  // A stop may have left asides; their bytes go into `before`, which the
  // undo writes back.
  if (Option.isNone(undone.value.done))
    yield* takeUpAsides(place, {
      requestId: undone.value.requestId,
      beforeRef: recorded.ref,
      target: yield* treeOf(place, Option.getOrThrow(undone.value.target).commit),
      paths: yield* revertFiles(place, undone.value),
    })
  const before = { ...recorded, commit: yield* inStore(place, ["rev-parse", recorded.ref]) }
  const current = yield* currentCommit(place)
  const plan = yield* undoPlan(
    place,
    { ...undone.value, before: Option.some(before) },
    current.commit,
  )
  if (plan.conflicts.length > 0 && input.overwrite !== true)
    return refused(
      `${plan.conflicts.length} of the files the revert wrote changed since; undo with overwrite to write them`,
      plan.conflicts,
    )
  return yield* applyPlan(place, {
    requestId: input.requestId,
    current: current.commit,
    source: before.commit,
    plan,
    fork: Option.none(),
    made: Option.none(),
  })
})

/** The refusal while another loop works in this work tree, or none. */
const busy = Effect.fn("Checkpoints.busy")(function* (place: Place) {
  const working = yield* blockers(place)
  if (working.length === 0) return Option.none<RevertOutcome>()
  return Option.some(
    refused(
      `another loop works in this work tree: ${working.join(", ")}; wait for it or stop it, then revert`,
    ),
  )
})

const revert = Effect.fn("Checkpoints.revert")(function* (input: RevertInput) {
  const ctx = yield* ExtensionContext
  const place = yield* placeOrProblem
  if (!(yield* storeExists(place))) return refused("this work tree has no checkpoints yet")
  // A fast answer; the check that decides runs again under the store lock,
  // since a loop that starts in between takes the lock for its start capture.
  const early = yield* busy(place)
  if (Option.isSome(early)) return early.value
  return yield* Effect.gen(function* () {
    const late = yield* busy(place)
    if (Option.isSome(late)) return late.value
    const timeline = yield* readTimeline(place)
    // A repeat converges: a recorded revert finishes or answers again. One
    // with a `before` alone stopped before it wrote anything: its record goes,
    // and the revert runs again from the work tree as it is now.
    const repeat = Option.fromUndefinedOr(revertsOf(timeline).get(input.requestId))
    if (Option.exists(repeat, (known) => Option.isSome(known.target)))
      return yield* finishRevert(place, Option.getOrThrow(repeat), input)
    const stale = Option.toArray(Option.flatMap(repeat, (known) => known.before))
    yield* deleteRefs(
      place,
      stale.map((mark) => mark.ref),
    )
    const marks = timeline.filter((mark) => !stale.includes(mark))
    return yield* RevertAction.match(input.action, {
      Turn: (action) => revertTurn(place, marks, input, action),
      Undo: () => revertRevert(place, marks, input),
      Finish: () =>
        Effect.gen(function* () {
          const unfinished = Option.filter(
            newestRevert(marks, ctx.sessionId, ctx.branchId),
            (known) => Option.isNone(known.done),
          )
          if (Option.isNone(unfinished)) return refused("there is no unfinished revert")
          return yield* finishRevert(place, unfinished.value, input)
        }),
    })
  }).pipe(underStoreLock(place))
})

// ── requests ────────────────────────────────────────────────────────────────

export const CheckpointsRpc = defineRequests(CHECKPOINTS_EXTENSION_ID, {
  List: request({
    id: "checkpoints.list",
    description: "The turns of the current branch, newest first, with what each changed",
    answersDuringTurn: true,
    resources: [CheckpointsResource],
    input: Schema.Struct({}),
    output: CheckpointList,
    execute: () => listTurns.pipe(Effect.mapError(asCheckpointsError)),
  }),
  Patch: request({
    id: "checkpoints.patch",
    description: "What turn #n of the current branch changed, as a git patch",
    answersDuringTurn: true,
    resources: [CheckpointsResource],
    input: Schema.Struct({ n: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
    output: TurnPatch,
    execute: ({ n }) => turnPatch(n).pipe(Effect.mapError(asCheckpointsError)),
  }),
  // No `answersDuringTurn`: a revert waits for the branch's turn and holds
  // its side-mutation permit while it writes, so no turn of the branch starts
  // on a tree half written.
  Revert: request({
    id: "checkpoints.revert",
    description:
      "Take the work tree, and on request the conversation, back to before turn #n; undo the newest revert; or finish one a stop cut short",
    resources: [CheckpointsResource],
    input: RevertInput,
    output: RevertOutcome,
    execute: (input) => revert(input).pipe(Effect.mapError(asCheckpointsError)),
  }),
})

// ── retention ───────────────────────────────────────────────────────────────

/** The file in a store that holds when git last collected its garbage, in epoch ms. */
const GC_FILE = "gent-gc"

/**
 * git drops what no ref keeps. Its default grace (two weeks) keeps the new
 * objects of a capture that runs at the same time, so a collection takes no
 * lock. The store records when.
 */
const collectGarbage = Effect.fn("Checkpoints.collectGarbage")(function* (
  place: Place,
  nowMs: number,
) {
  const gc = yield* inStoreRun(place, ["gc", "--quiet"])
  if (gc.exitCode !== 0) return yield* gitFailure(["gc"], gc)
  yield* writeFileAtomic(`${place.store}/${GC_FILE}`, `${nowMs}\n`)
})

/**
 * One retention pass over a data directory: a store whose work tree is gone
 * goes; in every other store, each mark older than 30 days goes, then git
 * collects the garbage when the pass removed a mark or the last collection
 * is a day old. A deleted session's refs go at once, so a collection must
 * not wait for an aged mark.
 */
export const pruneCheckpoints = Effect.fn("Checkpoints.prune")(function* (
  dataDir: string,
  nowMs: number,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.join(dataDir, "checkpoints")
  if (!(yield* fs.exists(root))) return
  for (const entry of yield* fs.readDirectory(root)) {
    const store = path.join(root, entry)
    const named = yield* fs.readFileString(path.join(store, "worktree")).pipe(
      Effect.map((text) => text.trim()),
      Effect.option,
    )
    if (Option.isNone(named) || named.value.length === 0) continue
    if (!(yield* fs.exists(named.value))) {
      yield* fs.remove(store, { recursive: true, force: true })
      continue
    }
    const place = { top: named.value, store }
    const cutoff = nowMs - Duration.toMillis(RETENTION)
    const old = (yield* readTimeline(place)).filter((mark) => mark.at < cutoff)
    yield* deleteRefs(
      place,
      old.map((mark) => mark.ref),
    )
    const collected = yield* fs.readFileString(path.join(store, GC_FILE)).pipe(
      Effect.map((text) => Number(text.trim())),
      Effect.option,
    )
    const recent = Option.exists(
      collected,
      (at) => Number.isFinite(at) && nowMs - at < Duration.toMillis(GC_INTERVAL),
    )
    if (old.length > 0 || !recent) yield* collectGarbage(place, nowMs)
  }
})

/** The daily pass over the data directory, started once per process. */
const startRetention = Effect.fn("Checkpoints.startRetention")(function* () {
  const ctx = yield* ExtensionContext
  const state = yield* Checkpoints
  const dataDir = yield* resolveDataDir(ctx.home)
  if (state.retention.has(dataDir)) return
  state.retention.add(dataDir)
  const pass = Effect.gen(function* () {
    yield* pruneCheckpoints(dataDir, yield* Clock.currentTimeMillis)
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("checkpoints.retention.failed").pipe(
        Effect.annotateLogs({ cause: Cause.pretty(cause) }),
      ),
    ),
  )
  yield* Effect.sleep(RETENTION_FIRST_PASS).pipe(
    Effect.andThen(Effect.forever(pass.pipe(Effect.andThen(Effect.sleep(RETENTION_INTERVAL))))),
    Effect.forkIn(state.scope),
  )
})

/** A deleted session's refs go from the store of its work tree. */
const forgetSession = Effect.fn("Checkpoints.forgetSession")(function* (sessionId: SessionId) {
  const ctx = yield* ExtensionContext
  const place = yield* locate(ctx.cwd, ctx.home)
  if (Option.isNone(place) || !(yield* storeExists(place.value))) return
  yield* Effect.gen(function* () {
    const marks = yield* readTimeline(place.value)
    yield* deleteRefs(
      place.value,
      marks.filter((mark) => mark.sessionId === sessionId).map((mark) => mark.ref),
    )
  }).pipe(underStoreLock(place.value))
  // What only the session's refs kept goes at git's next collection: now,
  // past the call, in the process scope.
  const state = yield* Checkpoints
  yield* collectGarbage(place.value, yield* Clock.currentTimeMillis).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("checkpoints.gc.failed").pipe(
        Effect.annotateLogs({ cause: Cause.pretty(cause) }),
      ),
    ),
    Effect.forkIn(state.scope),
  )
})

// ── extension ───────────────────────────────────────────────────────────────

const logged =
  (label: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning(label).pipe(Effect.annotateLogs({ cause: Cause.pretty(cause) })),
      ),
    )

const ALLOW = ToolCallVerdict.cases.Allow.make({})

/**
 * Whether a profile in `cwd` captures: inside a git work tree, and not in a
 * gent workspace copy whose store does not exist. Only spawned sessions work
 * in a copy, and a spawned session captures only where a store exists.
 */
const capturesIn = Effect.fn("Checkpoints.capturesIn")(function* (cwd: string, home: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const place = yield* placeOf(cwd, home)
  if (Option.isNone(place)) return false
  const gitDir = yield* inRepository(cwd, ["rev-parse", "--absolute-git-dir"])
  if (gitDir.exitCode !== 0) return false
  const copy = yield* fs.exists(path.join(gitDir.stdout.trim(), WORKSPACE_MARKER_FILE))
  return !copy || (yield* storeExists(place.value))
})

export const CheckpointsExtension = defineExtension({
  id: CHECKPOINTS_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("resource", CheckpointsResource)
    yield* host.register(
      "request",
      CheckpointsRpc.List,
      CheckpointsRpc.Patch,
      CheckpointsRpc.Revert,
    )
    // A profile belongs to one cwd. One that captures nothing there (outside
    // git, or in a workspace copy with no store) registers no capture hook:
    // its tool calls stay unjudged.
    const captures = yield* capturesIn(host.cwd, host.home).pipe(Effect.orElseSucceed(() => false))
    if (captures) {
      // The hook only captures: it always allows, and a failed capture is
      // logged, never an ask (a failed hook would answer `Ask`).
      yield* host.on("toolCall", (call) => {
        if (call.readonly) return Effect.succeed(ALLOW)
        return beforeCall(call).pipe(logged("checkpoints.start.failed"), Effect.as(ALLOW))
      })
      yield* host.on("turnAfter", (input) =>
        afterTurn(input).pipe(logged("checkpoints.end.failed")),
      )
    }
    yield* host.on("loopOpen", () => startRetention().pipe(logged("checkpoints.retention.failed")))
    yield* host.on("sessionDeleted", (input) =>
      forgetSession(input.sessionId).pipe(logged("checkpoints.session-deleted.failed")),
    )
  }),
})
