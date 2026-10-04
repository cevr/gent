/** @jsxImportSource @opentui/solid */
import { Duration, Effect, Fiber, FileSystem, Option, Path, Schema, Stream } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { lineCount } from "@gent/core/protocol"
import { runProcess } from "@gent/core/extensions/api"
import {
  ClientContext,
  defineClientExtension,
  plural,
  sessionQuery,
  STATUS_YIELD,
  statusLabelContribution,
  type StatusLabelItem,
} from "@gent/tui/extensions"

/**
 * `@gent/git` — the checkout of the session in view, on the composer's status
 * row: the branch with ahead/behind, and the files changed against `HEAD`
 * with their `+/-` line counts.
 *
 * Client-only: it reads git in the session's directory and sends nothing to
 * the model, stores nothing and asks the server nothing. Every git read
 * passes `--no-optional-locks`, so a read never takes `index.lock` from the
 * agent's own `git commit`, and every diff passes `--no-ext-diff
 * --no-textconv`, so repository config chooses no program to run.
 *
 * A read runs on a session or branch move, on a write git makes in the
 * checkout's git directory (`HEAD`, `index`, `MERGE_HEAD`, `ORIG_HEAD`,
 * `FETCH_HEAD`), 1 s after the last tool call of a burst ends (any tool can
 * write files), at a turn's end and on a message (a `!git commit` arrives as
 * one). One read runs at a time (`sessionQuery`); triggers during a read fold
 * into one more. No work-tree watch and no poll: an edit made in another
 * program shows at the next trigger.
 *
 * @module
 */

const GIT_EXTENSION_ID = "@gent/git"

// ── checkout model ──────────────────────────────────────────────────────────

/** Where the checkout's branch stands. */
interface GitHead {
  /** The branch; none when HEAD is detached. */
  readonly branch: Option.Option<string>
  /** The commit HEAD names; none on an unborn branch. */
  readonly oid: Option.Option<string>
  /** The branch's upstream (`origin/main`); none when it tracks nothing. */
  readonly upstream: Option.Option<string>
  readonly ahead: number
  readonly behind: number
}

/** Added and deleted lines of one file. */
interface LineCounts {
  readonly added: number
  readonly deleted: number
}

/**
 * One changed path, relative to the checkout's top directory. `status` is one
 * letter: `M` modified, `A` added, `D` deleted, `R` renamed, `C` copied, `T`
 * type changed, `U` unmerged, `?` untracked.
 */
interface ChangedFile {
  readonly path: string
  /** The path a rename or copy came from. */
  readonly from: Option.Option<string>
  readonly status: string
  /** None for a binary file, and for an untracked file too large or past the read bound. */
  readonly lines: Option.Option<LineCounts>
}

/** One read of a checkout: its head and every path that differs from `HEAD`. */
export interface Checkout {
  /** The checkout's top directory. */
  readonly root: string
  /** The directory that holds this checkout's `HEAD` and `index` (a worktree has its own). */
  readonly gitDir: string
  readonly head: GitHead
  readonly files: ReadonlyArray<ChangedFile>
}

// ── parsers ─────────────────────────────────────────────────────────────────

/** A changed path as `git status` names it, before its line counts. */
type StatusEntry = Omit<ChangedFile, "lines">

/** The first `count - 1` space-separated fields, then the rest whole: a path may hold spaces. */
const fields = (record: string, count: number): ReadonlyArray<string> => {
  const out: Array<string> = []
  let rest = record
  while (out.length < count - 1) {
    const space = rest.indexOf(" ")
    if (space < 0) break
    out.push(rest.slice(0, space))
    rest = rest.slice(space + 1)
  }
  out.push(rest)
  return out
}

/** The one letter a changed path shows, from its index and work-tree states (`XY`). */
const statusLetter = (xy: string): string =>
  Option.getOrElse(
    Option.fromUndefinedOr(["D", "A", "R", "C", "T"].find((letter) => xy.includes(letter))),
    () => "M",
  )

const optionalName = (value: string, absent: string): Option.Option<string> =>
  Option.liftPredicate(value, (name) => name.length > 0 && name !== absent)

/** One `# branch.*` header folded into the head read so far. */
const withHeader = (head: GitHead, header: string): GitHead => {
  if (header.startsWith("# branch.oid "))
    return { ...head, oid: optionalName(header.slice(13), "(initial)") }
  if (header.startsWith("# branch.head "))
    return { ...head, branch: optionalName(header.slice(14), "(detached)") }
  if (header.startsWith("# branch.upstream "))
    return { ...head, upstream: optionalName(header.slice(18), "") }
  if (header.startsWith("# branch.ab ")) {
    const [plus = "0", minus = "0"] = header.slice(12).split(" ")
    return {
      ...head,
      ahead: Math.abs(Number.parseInt(plus, 10)) || 0,
      behind: Math.abs(Number.parseInt(minus, 10)) || 0,
    }
  }
  return head
}

/** One changed-path record; `next` is the record after it, a rename's source path. */
const statusEntry = (record: string, next: string): Option.Option<StatusEntry> => {
  if (record.startsWith("1 ")) {
    const parts = fields(record, 9)
    return Option.some({
      path: parts[8] ?? "",
      from: Option.none(),
      status: statusLetter(parts[1] ?? ""),
    })
  }
  if (record.startsWith("2 ")) {
    const parts = fields(record, 10)
    return Option.some({
      path: parts[9] ?? "",
      from: Option.some(next),
      status: statusLetter(parts[1] ?? ""),
    })
  }
  if (record.startsWith("u "))
    return Option.some({ path: fields(record, 11)[10] ?? "", from: Option.none(), status: "U" })
  if (record.startsWith("? "))
    return Option.some({ path: record.slice(2), from: Option.none(), status: "?" })
  return Option.none()
}

/** A checkout's head and changed paths, as `git status` names them. */
interface ParsedStatus {
  readonly head: GitHead
  readonly entries: ReadonlyArray<StatusEntry>
}

/**
 * `git status --porcelain=v2 --branch -z`: the branch headers, then one
 * record per changed path. With `-z` a path is never quoted and a rename's
 * source path is the next record.
 */
export const parseStatus = (output: string): ParsedStatus => {
  const records = output.split("\0")
  let head: GitHead = {
    branch: Option.none(),
    oid: Option.none(),
    upstream: Option.none(),
    ahead: 0,
    behind: 0,
  }
  const entries: Array<StatusEntry> = []
  let index = 0
  while (index < records.length) {
    const record = records[index] ?? ""
    index += 1
    if (record.startsWith("# ")) {
      head = withHeader(head, record)
      continue
    }
    const entry = statusEntry(record, records[index] ?? "")
    if (Option.isNone(entry)) continue
    entries.push(entry.value)
    // A rename's source path was the next record.
    if (Option.isSome(entry.value.from)) index += 1
  }
  return { head, entries }
}

/**
 * `git diff --numstat -z`: added and deleted lines per path, keyed by the
 * path a rename lands on. A binary file reads `-` for both and has none.
 */
export const parseNumstat = (output: string): ReadonlyMap<string, Option.Option<LineCounts>> => {
  const records = output.split("\0")
  const counts = new Map<string, Option.Option<LineCounts>>()
  let index = 0
  while (index < records.length) {
    const record = records[index] ?? ""
    index += 1
    if (record.length === 0) continue
    const [added = "-", deleted = "-", ...rest] = record.split("\t")
    let path = rest.join("\t")
    if (path.length === 0) {
      // A rename: the source and the destination are the next two records.
      path = records[index + 1] ?? ""
      index += 2
    }
    const lines = Option.liftPredicate(
      { added: Number.parseInt(added, 10), deleted: Number.parseInt(deleted, 10) },
      (value) => Number.isFinite(value.added) && Number.isFinite(value.deleted),
    )
    counts.set(path, lines)
  }
  return counts
}

// ── labels ──────────────────────────────────────────────────────────────────

/**
 * When each label gives way on a narrow row, between the host's labels: the
 * change count (to its `+/-` form) after the cwd and before the model, the
 * branch after the model shortens and before the idle phase word.
 */
const RANK = {
  changes: STATUS_YIELD.cwd + 0.5,
  branch: STATUS_YIELD.model + 0.5,
}

/** `main ↑2 ↓1`; `detached @1a2b3c4`; an unborn branch by its name; none with no commit and no branch. */
export const branchText = (head: GitHead): Option.Option<string> =>
  Option.match(head.branch, {
    onNone: () => Option.map(head.oid, (oid) => `detached @${oid.slice(0, 7)}`),
    onSome: (name) => {
      let text = name
      if (head.ahead > 0) text += ` ↑${head.ahead}`
      if (head.behind > 0) text += ` ↓${head.behind}`
      return Option.some(text)
    },
  })

/** Every changed file's lines, summed; a file with no counts adds none. */
const changeTotals = (files: ReadonlyArray<ChangedFile>): LineCounts =>
  files.reduce(
    (sum, file) =>
      Option.match(file.lines, {
        onNone: () => sum,
        onSome: (lines) => ({
          added: sum.added + lines.added,
          deleted: sum.deleted + lines.deleted,
        }),
      }),
    { added: 0, deleted: 0 },
  )

/** `+120 -31` */
const lineDelta = (lines: LineCounts): string => `+${lines.added} -${lines.deleted}`

/** The status row's labels for one checkout: the branch, then the change count. */
export const checkoutLabels = (checkout: Checkout): ReadonlyArray<StatusLabelItem> => {
  const labels: Array<StatusLabelItem> = []
  Option.map(branchText(checkout.head), (text) =>
    labels.push({ text, color: "textMuted", short: { text: "", rank: RANK.branch } }),
  )
  if (checkout.files.length > 0) {
    const delta = lineDelta(changeTotals(checkout.files))
    labels.push({
      text: `${plural(checkout.files.length, "file")} ${delta}`,
      color: "textMuted",
      short: { text: delta, rank: RANK.changes },
    })
  }
  return labels
}

// ── reads ───────────────────────────────────────────────────────────────────

/** A git read that did not answer; the last value stays and the reason shows. */
class GitReadError extends Schema.TaggedError<GitReadError>()("GitReadError", {
  message: Schema.String,
}) {}

type GitServices = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner

/** A local read that takes longer fails, and the last value stays. */
const LOCAL_TIMEOUT = Duration.seconds(5)
/** An untracked file larger than this counts as a file with no lines. */
const UNTRACKED_READ_BYTES = 512 * 1024
/** At most this many untracked files are read for lines; the rest count as files. */
const UNTRACKED_READ_FILES = 200

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? ""

/**
 * One git command in `cwd`, answered with its output. `None`: git cannot run
 * there (no git on `PATH`, or the directory is gone), which reads as no
 * checkout. A git that times out or exits non-zero fails with its first line.
 */
const git = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<Option.Option<string>, GitReadError, ChildProcessSpawner.ChildProcessSpawner> =>
  runProcess("git", ["--no-optional-locks", ...args], {
    cwd,
    env: { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    extendEnv: true,
    timeout: LOCAL_TIMEOUT,
  }).pipe(
    Effect.flatMap((result) => {
      if (result.exitCode === 0) return Effect.succeedSome(result.stdout)
      if (result.stderr.includes("not a git repository")) return Effect.succeedNone
      return Effect.fail(
        new GitReadError({ message: `git ${args[0] ?? ""}: ${firstLine(result.stderr)}` }),
      )
    }),
    Effect.catchTag("ProcessError", (error) => {
      if (error.timedOut === true)
        return Effect.fail(new GitReadError({ message: `git ${args[0] ?? ""} timed out` }))
      return Effect.succeedNone
    }),
  )

/** Lines of an untracked file: none when it is binary, too large, or unreadable. */
const untrackedLines = (
  file: string,
): Effect.Effect<Option.Option<LineCounts>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs.stat(file)
    if (info.type !== "File" || Number(info.size) > UNTRACKED_READ_BYTES) return Option.none()
    const text = yield* fs.readFileString(file)
    if (text.includes("\0")) return Option.none()
    return Option.some({ added: lineCount(text), deleted: 0 })
  }).pipe(Effect.orElseSucceed(() => Option.none<LineCounts>()))

/** The checkout's top directory and git directory, by the cwd it was asked from. */
interface Location {
  readonly root: string
  readonly gitDir: string
}

/**
 * The checkout that holds `cwd`. A checkout's top directory and git
 * directory do not move while its cwd stays, so a found one is kept; a cwd
 * outside a checkout is asked again on each read.
 */
const locate = (
  cwd: string,
  locations: Map<string, Location>,
): Effect.Effect<Option.Option<Location>, GitReadError, ChildProcessSpawner.ChildProcessSpawner> =>
  Option.match(Option.fromUndefinedOr(locations.get(cwd)), {
    onSome: (value) => Effect.succeedSome(value),
    onNone: () =>
      git(cwd, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]).pipe(
        Effect.map(
          Option.flatMap((output) => {
            const [root = "", gitDir = ""] = output.trim().split("\n")
            return Option.liftPredicate(
              { root, gitDir },
              (value) => value.root.length > 0 && value.gitDir.length > 0,
            )
          }),
        ),
        Effect.tap((found) =>
          Effect.sync(() => Option.map(found, (value) => locations.set(cwd, value))),
        ),
      ),
  })

/**
 * Read the checkout at `cwd`: where it is, then its status, then its line
 * counts against `HEAD` (the index on an unborn branch, which has no
 * `HEAD`), then the lines of its untracked files. `None` outside a checkout.
 *
 * `located` hears where the checkout is before its status is read, so a
 * watch on its git directory starts before the read and misses no write
 * that lands after it.
 */
export const readCheckout = (
  cwd: string,
  locations: Map<string, Location>,
  located: (gitDir: Option.Option<string>) => void = () => {},
): Effect.Effect<Option.Option<Checkout>, GitReadError, GitServices> =>
  Effect.gen(function* () {
    const location = yield* locate(cwd, locations)
    located(Option.map(location, (value) => value.gitDir))
    if (Option.isNone(location)) return Option.none()
    const status = yield* git(cwd, [
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      // Every untracked file, not its directory: a directory the agent made
      // counts its files and their lines. The read bound caps the cost.
      "--untracked-files=all",
    ])
    if (Option.isNone(status)) return Option.none()
    const { head, entries } = parseStatus(status.value)
    let counts: ReadonlyMap<string, Option.Option<LineCounts>> = new Map()
    if (entries.some((entry) => entry.status !== "?")) {
      const base = Option.match(head.oid, { onNone: () => "--cached", onSome: () => "HEAD" })
      const numstat = yield* git(cwd, [
        "diff",
        "--numstat",
        "-z",
        "--no-ext-diff",
        "--no-textconv",
        "--no-relative",
        base,
      ])
      counts = parseNumstat(Option.getOrElse(numstat, () => ""))
    }
    const path = yield* Path.Path
    let untrackedRead = 0
    const files = yield* Effect.forEach(
      entries,
      (entry) => {
        if (entry.status !== "?") {
          const lines = Option.flatten(Option.fromUndefinedOr(counts.get(entry.path)))
          return Effect.succeed({ ...entry, lines })
        }
        untrackedRead += 1
        if (untrackedRead > UNTRACKED_READ_FILES)
          return Effect.succeed({ ...entry, lines: Option.none<LineCounts>() })
        return untrackedLines(path.join(location.value.root, entry.path)).pipe(
          Effect.map((lines): ChangedFile => ({ ...entry, lines })),
        )
      },
      { concurrency: 8 },
    )
    return Option.some({ ...location.value, head, files })
  })

// ── refresh ─────────────────────────────────────────────────────────────────

/** The files git writes when the checkout's branch, index, merge or upstream moves. */
const GIT_STATE_FILES = new Set(["HEAD", "index", "MERGE_HEAD", "ORIG_HEAD", "FETCH_HEAD"])

/** A tool burst settles this long after its last call before the checkout is read again. */
const TOOL_SETTLE = Duration.seconds(1)

/**
 * A tick each time git writes one of `GIT_STATE_FILES` in `gitDir`,
 * debounced. A watch that cannot start ticks never: the other triggers still
 * read the checkout.
 */
const gitStateChanges = (gitDir: string): Stream.Stream<void, never, FileSystem.FileSystem> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return fs.watch(gitDir).pipe(
        Stream.filter((event) => GIT_STATE_FILES.has(event.path.split("/").pop() ?? "")),
        Stream.debounce("200 millis"),
        Stream.map((): void => {}),
      )
    }),
  ).pipe(
    Stream.catchCause((cause) =>
      Stream.fromEffect(
        Effect.logDebug("git.watch.failed").pipe(Effect.annotateLogs({ error: String(cause) })),
      ).pipe(Stream.drain),
    ),
  )

// ── extension ───────────────────────────────────────────────────────────────

export default defineClientExtension(GIT_EXTENSION_ID, {
  setup: Effect.gen(function* () {
    const { transport, workspace, lifecycle } = yield* ClientContext
    // Reads, the watch and the settle timer run outside the setup, from sync
    // callbacks, so the setup keeps the platform services they need.
    const services = yield* Effect.context<GitServices>()
    const fork = Effect.runForkWith(services)
    const interrupt = (fiber: Option.Option<Fiber.Fiber<unknown>>) =>
      Option.map(fiber, (running) => fork(Fiber.interrupt(running)))
    const locations = new Map<string, Location>()

    // The git directory watched now, and the fiber that watches it.
    let watched = Option.none<{ readonly gitDir: string; readonly fiber: Fiber.Fiber<void> }>()
    const watch = (gitDir: Option.Option<string>, onChange: () => void) => {
      if (
        Option.getOrUndefined(Option.map(watched, (w) => w.gitDir)) ===
        Option.getOrUndefined(gitDir)
      )
        return
      interrupt(Option.map(watched, (w) => w.fiber))
      watched = Option.map(gitDir, (dir) => ({
        gitDir: dir,
        fiber: fork(gitStateChanges(dir).pipe(Stream.runForEach(() => Effect.sync(onChange)))),
      }))
    }

    const local = yield* sessionQuery({
      initial: Option.none<Checkout>(),
      follow: true,
      fetch: () =>
        workspace.sessionCwd.pipe(
          Effect.flatMap((cwd) =>
            readCheckout(cwd, locations, (gitDir) => watch(gitDir, () => local.refresh())),
          ),
          Effect.provideContext(services),
        ),
    })

    // Any tool can write files; a burst of calls reads once, after it settles.
    let settling = Option.none<Fiber.Fiber<void>>()
    const afterTool = () => {
      interrupt(settling)
      settling = Option.some(
        fork(Effect.sleep(TOOL_SETTLE).pipe(Effect.andThen(Effect.sync(local.refresh)))),
      )
    }
    lifecycle.addCleanup(
      transport.onSessionEvent((envelope) => {
        const tag = envelope.event._tag
        if (tag === "ToolCallSucceeded" || tag === "ToolCallFailed") afterTool()
        else if (tag === "TurnCompleted" || tag === "MessageReceived") local.refresh()
      }),
    )
    lifecycle.addCleanup(() => {
      interrupt(settling)
      watch(Option.none(), () => {})
    })

    return statusLabelContribution({
      priority: 20,
      produce: () => Option.match(local.value(), { onNone: () => [], onSome: checkoutLabels }),
    })
  }),
})
