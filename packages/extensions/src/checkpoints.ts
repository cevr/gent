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
 * and `/end`, each path part the hex of the id, with the readable ids in the
 * commit trailers. One `for-each-ref` reads the whole timeline of a store.
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
  request,
  resolveDataDir,
  SessionId,
  ToolCallVerdict,
  type ToolCallInput,
  type TurnAfterInput,
  writeFileAtomic,
} from "@gent/core/extensions/api"
import { git, type GitOptions, gitFailure, gitRun, parseShortStat } from "./git-plumbing.js"

// ── protocol ────────────────────────────────────────────────────────────────

const CHECKPOINTS_EXTENSION_ID = ExtensionId.make("@gent/checkpoints")

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
})
export type CheckpointList = typeof CheckpointList.Type

/** A turn's change as a git patch; a first `#` line names other sessions that wrote the tree. */
export const TurnPatch = Schema.Struct({
  n: Schema.Int,
  prompt: Schema.String,
  patch: Schema.String,
})
export type TurnPatch = typeof TurnPatch.Type

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

// ── git ─────────────────────────────────────────────────────────────────────

/** The empty tree: as an attribute source it makes every file byte-exact (no eol, no filter). */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

/**
 * Settings of every store command: content byte for byte, objects and refs
 * synced to disk (an unclean stop leaves no empty ref), no monitor daemon,
 * and gent's own identity on its commits.
 */
const STORE_SETTINGS = [
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
  git(place.top, storeArgs(place, args), { ...options, env: { ...CLEAN_ENV, ...options.env } })

/** One store command whatever its exit; its raw output. */
const inStoreRun = (place: Place, args: ReadonlyArray<string>, options: GitOptions = {}) =>
  gitRun(place.top, storeArgs(place, args), {
    ...options,
    env: { ...CLEAN_ENV, ...options.env },
  })

/** A read of the user's repository: it writes nothing there. */
const inRepository = (top: string, args: ReadonlyArray<string>) =>
  gitRun(top, args, { env: CLEAN_ENV })

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
const locate = Effect.fn("Checkpoints.locate")(function* (cwd: string, home: string) {
  const state = yield* Checkpoints
  const key = `${home}\0${cwd}`
  const known = state.places.get(key)
  if (Predicate.isNotUndefined(known)) return known
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
  const place = yield* Option.match(found, {
    onNone: () => Effect.succeedNone,
    onSome: (top) =>
      Effect.gen(function* () {
        const real = yield* fs.realPath(top).pipe(Effect.orElseSucceed(() => top))
        const digest = yield* sha256(real)
        const dataDir = yield* resolveDataDir(home)
        return Option.some({
          top: real,
          store: path.join(dataDir, "checkpoints", digest.slice(0, 16)),
        })
      }),
  })
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
  yield* git(place.top, ["init", "--bare", "-q", place.store], { env: CLEAN_ENV })
  yield* git(place.top, [`--git-dir=${place.store}`, "config", "index.version", "4"], {
    env: CLEAN_ENV,
  })
  yield* git(place.top, [`--git-dir=${place.store}`, "config", "core.untrackedCache", "true"], {
    env: CLEAN_ENV,
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
    const removed = yield* inStoreRun(
      place,
      ["rm", "--cached", "-q", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"],
      { stdin: big.join("\0"), env: { GIT_LITERAL_PATHSPECS: "1" } },
    )
    if (removed.exitCode !== 0) return yield* gitFailure(["rm"], removed)
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
  const at = yield* nextAt(place)
  const message = [
    `gent checkpoint: turn ${kind}`,
    "",
    `Gent-Kind: ${kind}`,
    `Gent-Session: ${ids.sessionId}`,
    `Gent-Branch: ${ids.branchId}`,
    `Gent-Turn: ${ids.messageId}`,
    `Gent-At: ${at}`,
    `Gent-Skipped: ${skipped}`,
  ].join("\n")
  const parents = Option.match(parent, { onNone: () => [], onSome: (commit) => ["-p", commit] })
  const commit = yield* inStore(place, ["commit-tree", tree, ...parents, "-m", message])
  // Create only: the empty old value refuses a ref that exists.
  yield* inStore(place, ["update-ref", checkpointRef(ids, kind), commit, ""])
  return commit
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
  return messages
    .filter(opensTurn)
    .slice(-MAX_TURNS)
    .reverse()
    .map((message, index): Turn => ({ n: index + 1, message, span: spanOf(message) }))
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
  const turns = yield* turnsOf(spansOf(marks))
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
  const list: CheckpointList = Option.match(place, {
    onNone: () => ({ problem: NOT_GIT(ctx.cwd), turns: rows }),
    onSome: () => ({ turns: rows }),
  })
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
  const turn = (yield* turnsOf(spans)).find((found) => found.n === n)
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
})

// ── retention ───────────────────────────────────────────────────────────────

/** Delete refs in one transaction. */
const deleteRefs = (place: Place, refs: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (refs.length === 0) return
    const result = yield* inStoreRun(place, ["update-ref", "--stdin"], {
      stdin: refs.map((ref) => `delete ${ref}\n`).join(""),
    })
    if (result.exitCode !== 0) return yield* gitFailure(["update-ref"], result)
  })

/**
 * One retention pass over a data directory: a store whose work tree is gone
 * goes; in every other store, each mark older than 30 days goes, then git
 * drops what no ref keeps. `--prune=1.day` keeps the objects of a capture
 * that runs at the same time, so the pass takes no lock.
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
    if (old.length === 0) continue
    yield* deleteRefs(
      place,
      old.map((mark) => mark.ref),
    )
    const gc = yield* inStoreRun(place, ["gc", "--quiet", "--prune=1.day"])
    if (gc.exitCode !== 0) return yield* gitFailure(["gc"], gc)
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

const insideWorkTree = (cwd: string) =>
  inRepository(cwd, ["rev-parse", "--is-inside-work-tree"]).pipe(
    Effect.map((result) => result.exitCode === 0 && result.stdout.trim() === "true"),
    Effect.orElseSucceed(() => false),
  )

export const CheckpointsExtension = defineExtension({
  id: CHECKPOINTS_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("resource", CheckpointsResource)
    yield* host.register("request", CheckpointsRpc.List, CheckpointsRpc.Patch)
    // A profile belongs to one cwd. Outside a git work tree it captures
    // nothing, so it registers no capture hook: its tool calls stay unjudged.
    if (yield* insideWorkTree(host.cwd)) {
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
