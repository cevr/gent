/** @jsxImportSource @opentui/solid */
import {
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Schema,
  Stream,
} from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { createEffect, createMemo, createRoot, type JSX, on, Show } from "solid-js"
import { lineCount } from "@gent/core/protocol"
import { runProcess } from "@gent/core/extensions/api"
import {
  clientCommandContribution,
  clientContributions,
  ClientContext,
  defineClientExtension,
  fitWidth,
  keyHint,
  KeyHints,
  PickerFrame,
  plainRow,
  plural,
  SelectList,
  type SelectListRow,
  sessionQuery,
  STATUS_YIELD,
  statusLabelContribution,
  type StatusLabelItem,
  textWidth,
  truncate,
  truncatePath,
  usePickerGeometry,
  useTheme,
  widgetContribution,
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
  pullRequest: STATUS_YIELD.cwd - 0.5,
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

/**
 * The status row's labels for one checkout: the branch, the branch's pull
 * request when there is one, then the change count.
 */
export const checkoutLabels = (
  checkout: Checkout,
  pullRequest: Option.Option<PullRequest> = Option.none(),
): ReadonlyArray<StatusLabelItem> => {
  const labels: Array<StatusLabelItem> = []
  Option.map(branchText(checkout.head), (text) =>
    labels.push({ text, color: "textMuted", short: { text: "", rank: RANK.branch } }),
  )
  Option.map(pullRequest, (pr) => labels.push(pullRequestLabel(pr)))
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

// ── pull request ────────────────────────────────────────────────────────────

/**
 * One check of a pull request as `gh` names it: a check run has a `status`
 * and, once completed, a `conclusion`; a commit status has a `state`.
 */
const PullRequestCheck = Schema.Struct({
  status: Schema.optional(Schema.NullOr(Schema.String)),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
})

/** The fields of `gh pr view --json` the label and the pane read. */
const PullRequest = Schema.Struct({
  number: Schema.Finite,
  title: Schema.String,
  url: Schema.String,
  state: Schema.String,
  isDraft: Schema.Boolean,
  reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
  statusCheckRollup: Schema.optional(Schema.NullOr(Schema.Array(PullRequestCheck))),
})
type PullRequest = typeof PullRequest.Type

const decodePullRequest = Schema.decodeUnknownOption(Schema.fromJsonString(PullRequest))

/** The fields `gh pr view` answers with. */
const PULL_REQUEST_FIELDS = "number,title,url,state,isDraft,reviewDecision,statusCheckRollup"

const FAILED_CHECK = new Set([
  "FAILURE",
  "ERROR",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
])
const PENDING_CHECK = new Set(["PENDING", "EXPECTED"])

/** Where a pull request's checks stand: any failure fails them, then any check still running. */
export const checksVerdict = (
  checks: ReadonlyArray<typeof PullRequestCheck.Type>,
): "none" | "pass" | "fail" | "pending" => {
  if (checks.length === 0) return "none"
  const named = (value: (typeof PullRequestCheck.Type)["status"]): string =>
    Option.getOrElse(Option.fromNullishOr(value), () => "")
  if (checks.some((c) => FAILED_CHECK.has(named(c.conclusion)) || FAILED_CHECK.has(named(c.state))))
    return "fail"
  const running = (c: typeof PullRequestCheck.Type) =>
    (named(c.status).length > 0 && named(c.status) !== "COMPLETED") ||
    PENDING_CHECK.has(named(c.state))
  if (checks.some(running)) return "pending"
  return "pass"
}

/**
 * `#123 ✓` (checks pass), `#123 ✗` (a check failed), `#123 …` (checks
 * running), `#123` (no checks); a draft, a merged and a closed request say
 * so. It gives way first on a narrow row.
 */
const pullRequestLabel = (pr: PullRequest): StatusLabelItem => {
  const short = { text: "", rank: RANK.pullRequest }
  const muted = (word: string): StatusLabelItem => ({
    text: `#${pr.number}${word}`,
    color: "textMuted",
    short,
  })
  if (pr.state === "MERGED") return muted(" merged")
  if (pr.state === "CLOSED") return muted(" closed")
  if (pr.isDraft) return muted(" draft")
  switch (checksVerdict(pr.statusCheckRollup ?? [])) {
    case "fail":
      return { text: `#${pr.number} ✗`, color: "error", short }
    case "pending":
      return { text: `#${pr.number} …`, color: "warning", short }
    case "pass":
      return { text: `#${pr.number} ✓`, color: "success", short }
    case "none":
      return muted("")
  }
}

/**
 * The spawn found no program by the command's name. A directory that is gone
 * fails the spawn too, but at its `FileSystem.access`, so it is not this.
 */
const commandNotFound = (cause: unknown): boolean =>
  PlatformError.isPlatformError(cause) &&
  cause.reason._tag === "NotFound" &&
  "module" in cause.reason &&
  cause.reason.module === "ChildProcess"

/** No `gh` on `PATH`: the pull request is never asked for again. */
class GhMissing extends Schema.TaggedError<GhMissing>()("GhMissing", {}) {}

/** A `gh` read that did not answer; the last value stays and the pane names the reason. */
class GhReadError extends Schema.TaggedError<GhReadError>()("GhReadError", {
  message: Schema.String,
}) {}

/** `gh` asks the network; a read that takes longer fails and the last value stays. */
const GH_TIMEOUT = Duration.seconds(8)

/** `gh` answers that the checkout has no pull request to name: none, not a failure. */
const NO_PULL_REQUEST = [
  "no pull requests found",
  "no git remotes found",
  "none of the git remotes configured for this repository",
]

/**
 * One `gh pr <verb>` in `cwd`, with prompts, the update notice and the
 * spinner off, answered with its output. `GhMissing` when `gh` cannot run;
 * a timeout, or an exit that is not zero, fails with the reason, a sign-in
 * named as such. `absent` says which refusals mean "nothing to name".
 */
const ghPr = (
  cwd: string,
  args: readonly [string, ...Array<string>],
  absent: (said: string) => boolean = () => false,
): Effect.Effect<
  Option.Option<string>,
  GhMissing | GhReadError,
  ChildProcessSpawner.ChildProcessSpawner
> => {
  const name = `gh pr ${args[0]}`
  return runProcess("gh", ["pr", ...args], {
    cwd,
    env: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1" },
    extendEnv: true,
    timeout: GH_TIMEOUT,
  }).pipe(
    Effect.catchTag("ProcessError", (error): Effect.Effect<never, GhMissing | GhReadError> => {
      if (error.timedOut === true)
        return Effect.fail(new GhReadError({ message: `${name} timed out` }))
      if (commandNotFound(error.cause)) return Effect.fail(new GhMissing())
      return Effect.fail(new GhReadError({ message: error.message }))
    }),
    Effect.flatMap((result) => {
      if (result.exitCode === 0) return Effect.succeedSome(result.stdout)
      const said = result.stderr.toLowerCase()
      if (absent(said)) return Effect.succeedNone
      if (said.includes("gh auth login"))
        return Effect.fail(new GhReadError({ message: "gh is not signed in · gh auth login" }))
      return Effect.fail(new GhReadError({ message: `${name}: ${firstLine(result.stderr)}` }))
    }),
  )
}

/**
 * The pull request of the branch checked out in `cwd`, as `gh pr view`
 * names it. None when the branch has none, or the checkout has no GitHub
 * remote. `GhMissing` when `gh` cannot run.
 */
export const readPullRequest = (
  cwd: string,
): Effect.Effect<
  Option.Option<PullRequest>,
  GhMissing | GhReadError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  ghPr(cwd, ["view", "--json", PULL_REQUEST_FIELDS], (said) =>
    NO_PULL_REQUEST.some((phrase) => said.includes(phrase)),
  ).pipe(
    Effect.flatMap((answer) =>
      Option.match(answer, {
        onNone: () => Effect.succeedNone,
        onSome: (stdout) =>
          Option.match(decodePullRequest(stdout), {
            onNone: () =>
              Effect.fail(new GhReadError({ message: "gh pr view: unreadable answer" })),
            onSome: (pr) => Effect.succeedSome(pr),
          }),
      }),
    ),
  )

/**
 * What the pull request read follows: the checkout's root, branch, upstream
 * and ahead/behind counts. A push, a pull, a fetch or a branch move changes
 * it; an edit does not. Empty for no checkout, a detached head and an
 * unborn branch, which have no pull request to ask for.
 */
const pullRequestKey = (checkout: Option.Option<Checkout>): string =>
  Option.match(
    Option.filter(checkout, (value) => Option.isSome(value.head.oid)),
    {
      onNone: () => "",
      onSome: ({ root, head }) =>
        Option.match(head.branch, {
          onNone: () => "",
          onSome: (branch) =>
            [root, branch, Option.getOrElse(head.upstream, () => ""), head.ahead, head.behind].join(
              "\0",
            ),
        }),
    },
  )

// ── review ──────────────────────────────────────────────────────────────────

/**
 * What a review shows: the work tree against `HEAD` in `cwd` (all of it, or
 * the paths `pathspecs` names), or the pull request of the branch checked out
 * in `cwd`.
 */
const ReviewTarget = Schema.TaggedUnion({
  WorkTree: { cwd: Schema.String, pathspecs: Schema.Array(Schema.String) },
  PullRequest: { cwd: Schema.String },
})
type ReviewTarget = typeof ReviewTarget.Type
type WorkTree = Extract<ReviewTarget, { readonly _tag: "WorkTree" }>

/** `/diff` reviews the work tree, `/diff <paths>` those paths of it, `/diff pr` the branch's pull request. */
export const reviewTarget = (args: string, cwd: string): ReviewTarget => {
  const words = args.split(/\s+/).filter((word) => word.length > 0)
  if (words.length === 1 && words[0] === "pr") return ReviewTarget.cases.PullRequest.make({ cwd })
  return ReviewTarget.cases.WorkTree.make({ cwd, pathspecs: words })
}

/**
 * The program that shows the work tree. `hunk diff --watch` follows the
 * agent's edits while it is open. Without hunk, `git --paginate diff` against
 * `base` runs the reader's own pager (`core.pager`, `$PAGER`, `less`).
 */
export const workTreeCommand = (
  target: WorkTree,
  viewer: "hunk" | "pager",
  base: string,
): readonly [string, ReadonlyArray<string>] => {
  let paths: ReadonlyArray<string> = []
  if (target.pathspecs.length > 0) paths = ["--", ...target.pathspecs]
  if (viewer === "hunk") return ["hunk", ["diff", "--watch", ...paths]]
  return ["git", ["--no-optional-locks", "--paginate", "diff", base, ...paths]]
}

/** No program by this name on `PATH`. */
class ProgramMissing extends Schema.TaggedError<ProgramMissing>()("ProgramMissing", {
  program: Schema.String,
}) {}

/** A review that did not run to its end; the status row names the reason. */
class ReviewFailed extends Schema.TaggedError<ReviewFailed>()("ReviewFailed", {
  message: Schema.String,
}) {}

/** A pager exits 141 (SIGPIPE) when the reader quits it before the end: not a failure. */
const QUIT_EARLY = 141

/** The status row's note when `/diff` first finds no hunk. */
const HUNK_MISSING = "hunk not found · using the git pager"

/** Run a program on the terminal a handover gives it, in `cwd`. */
const onTerminal = (
  cwd: string,
  [command, args]: readonly [string, ReadonlyArray<string>],
): Effect.Effect<void, ProgramMissing | ReviewFailed, ChildProcessSpawner.ChildProcessSpawner> =>
  runProcess(command, args, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).pipe(
    Effect.catchTag(
      "ProcessError",
      (error): Effect.Effect<never, ProgramMissing | ReviewFailed> => {
        if (commandNotFound(error.cause))
          return Effect.fail(new ProgramMissing({ program: command }))
        return Effect.fail(new ReviewFailed({ message: `${command}: ${error.message}` }))
      },
    ),
    Effect.flatMap((result) => {
      if (result.exitCode === 0 || result.exitCode === QUIT_EARLY) return Effect.void
      return Effect.fail(new ReviewFailed({ message: `${command} exited with ${result.exitCode}` }))
    }),
  )

// ── pane ────────────────────────────────────────────────────────────────────

const GIT_PANE = "git.pane"

/** `M  apps/tui/src/app.tsx   +12 -3`: the path cut from its start to fit `width`. */
const fileLine = (file: ChangedFile, width: number): string => {
  const counts = Option.match(file.lines, {
    onNone: () => "",
    onSome: (lines) => {
      if (file.status === "?") return `+${lines.added}`
      return lineDelta(lines)
    },
  })
  const name = Option.match(file.from, {
    onNone: () => file.path,
    onSome: (from) => `${from} → ${file.path}`,
  })
  const lead = `${file.status}  `
  const room = Math.max(0, width - textWidth(lead) - textWidth(counts) - 2)
  return `${lead}${fitWidth(truncatePath(name, room), room)}  ${counts}`
}

const CHECK_GLYPH = { pass: "✓", fail: "✗", pending: "…", none: "" }

/** GitHub's `CHANGES_REQUESTED` as `changes requested`. */
const spoken = (word: string): string => word.toLowerCase().replaceAll("_", " ")

/**
 * `#123 Title · open · checks ✓ · review required`. Too wide, the request
 * keeps its number, state and checks glyph, and its title gives way.
 */
const pullRequestLine = (pr: PullRequest, width: number): string => {
  let state = spoken(pr.state)
  if (pr.isDraft && pr.state === "OPEN") state = "draft"
  const glyph = CHECK_GLYPH[checksVerdict(pr.statusCheckRollup ?? [])]
  const checks = Option.match(
    Option.liftPredicate(glyph, (text) => text.length > 0),
    {
      onNone: () => "",
      onSome: (text) => `checks ${text}`,
    },
  )
  const review = spoken(Option.getOrElse(Option.fromNullishOr(pr.reviewDecision), () => ""))
  const said = (parts: ReadonlyArray<string>) => parts.filter((part) => part.length > 0).join(" · ")
  const full = said([state, checks, review])
  const head = `#${pr.number} ${pr.title}`
  if (textWidth(head) + 3 + textWidth(full) <= width) return `${head} · ${full}`
  const compact = said([state, glyph])
  return `${truncate(head, Math.max(0, width - 3 - textWidth(compact)))} · ${compact}`
}

/** `git · main ↑2 → origin/main · 4 files +120 -31`; the upstream goes first on a narrow pane. */
const paneTitle = (checkout: Option.Option<Checkout>, width: number): string =>
  Option.match(checkout, {
    onNone: () => "git",
    onSome: ({ head, files }) => {
      const branch = Option.getOrElse(branchText(head), () => "no branch")
      let changes = "no changes"
      if (files.length > 0)
        changes = `${plural(files.length, "file")} ${lineDelta(changeTotals(files))}`
      const upstream = Option.match(head.upstream, {
        onNone: () => "",
        onSome: (name) => ` → ${name}`,
      })
      const full = `git · ${branch}${upstream} · ${changes}`
      if (textWidth(full) <= width) return full
      return `git · ${branch} · ${changes}`
    },
  })

const reviewKey = (target: ReviewTarget): string =>
  ReviewTarget.match(target, {
    WorkTree: ({ pathspecs }) => `file:${pathspecs.join("\0")}`,
    PullRequest: () => "pull-request",
  })

interface GitPaneProps {
  readonly open: boolean
  readonly checkout: () => Option.Option<Checkout>
  readonly pullRequest: () => Option.Option<PullRequest>
  /** The last read's failure, the checkout's or the pull request's. */
  readonly error: () => Option.Option<string>
  readonly loading: () => boolean
  readonly onReview: (target: ReviewTarget) => void
  readonly onClose: () => void
}

/**
 * The `/git` pane: one row per changed file with its `+/-` lines, then the
 * branch's pull request. Enter hands the terminal to hunk for the row and
 * the pane stays open for the next one; esc or ctrl+c closes it.
 */
function GitPane(props: GitPaneProps) {
  const { theme } = useTheme()
  const { rowWidth } = usePickerGeometry()
  const rows = (): ReadonlyArray<SelectListRow<ReviewTarget>> =>
    Option.match(props.checkout(), {
      onNone: () => [],
      onSome: (checkout) => [
        ...checkout.files.map((file) =>
          plainRow(
            ReviewTarget.cases.WorkTree.make({
              cwd: checkout.root,
              pathspecs: Option.match(file.from, {
                onNone: () => [file.path],
                onSome: (from) => [from, file.path],
              }),
            }),
            () => fileLine(file, rowWidth()),
          ),
        ),
        ...Option.match(props.pullRequest(), {
          onNone: () => [],
          onSome: (pr) => [
            plainRow(ReviewTarget.cases.PullRequest.make({ cwd: checkout.root }), () =>
              pullRequestLine(pr, rowWidth()),
            ),
          ],
        }),
      ],
    })
  const empty = (): Option.Option<JSX.Element> => {
    if (props.loading() && Option.isNone(props.checkout())) return Option.none()
    let text = "No changes against HEAD"
    if (Option.isNone(props.checkout())) text = "Not a git checkout"
    return Option.some(
      <box paddingLeft={1}>
        <text style={{ fg: theme.textMuted }}>{text}</text>
      </box>,
    )
  }
  return (
    <Show when={props.open}>
      <PickerFrame
        title={paneTitle(props.checkout(), rowWidth())}
        keys={[KeyHints.move, keyHint("enter", "review"), KeyHints.close]}
        error={props.error()}
      >
        <SelectList
          id="git"
          open={props.open}
          rows={rows}
          rowKey={reviewKey}
          loading={props.loading}
          empty={empty}
          extraKeys={(event) => {
            // ctrl+c closes the pane as esc does, as over the host's panes.
            if (event.ctrl === true && event.name === "c") {
              props.onClose()
              return true
            }
            return false
          }}
          onSelect={props.onReview}
          onDismiss={props.onClose}
        />
      </PickerFrame>
    </Show>
  )
}

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
    const { transport, workspace, lifecycle, shell } = yield* ClientContext
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

    // The branch's pull request, through `gh`, read again only when the
    // branch, its upstream or its ahead/behind counts move: a push, a pull, a
    // fetch, a checkout. No `gh` on `PATH` hides it for the extension's life.
    // Each answer keeps the key it was asked for, so a branch move never
    // shows the last branch's request while the next read is out.
    let ghMissing = false
    const pullRequest = yield* sessionQuery({
      initial: Option.none<{ readonly key: string; readonly pr: Option.Option<PullRequest> }>(),
      follow: true,
      fetch: () => {
        const key = pullRequestKey(local.value())
        if (ghMissing || key.length === 0) return Effect.succeedNone
        return workspace.sessionCwd.pipe(
          Effect.flatMap(readPullRequest),
          Effect.map((pr) => Option.some({ key, pr })),
          Effect.catchTag("GhMissing", () =>
            Effect.sync(() => {
              ghMissing = true
              return Option.none<{
                readonly key: string
                readonly pr: Option.Option<PullRequest>
              }>()
            }),
          ),
          Effect.provideContext(services),
        )
      },
    })
    lifecycle.addCleanup(
      createRoot((dispose) => {
        // A memo, so a read that changes no branch fact asks nothing.
        const key = createMemo(() => pullRequestKey(local.value()))
        createEffect(on(key, pullRequest.refresh, { defer: true }))
        return dispose
      }),
    )
    const currentPullRequest = (): Option.Option<PullRequest> =>
      pullRequest.value().pipe(
        Option.filter((answer) => answer.key === pullRequestKey(local.value())),
        Option.flatMap((answer) => answer.pr),
      )

    // The review: the terminal goes to hunk, or to the git pager once a run
    // found no hunk on `PATH`, which the status row says once. A note waits
    // for the handover's end: the status row is not drawn while it runs.
    let hunkMissing = false
    const learnHunkMissing = (): Option.Option<string> => {
      if (hunkMissing) return Option.none()
      hunkMissing = true
      return Option.some(HUNK_MISSING)
    }
    // An unborn branch has no `HEAD`: its staged lines are its change.
    const base = () =>
      Option.match(
        Option.filter(local.value(), (checkout) => Option.isNone(checkout.head.oid)),
        { onNone: () => "HEAD", onSome: () => "--cached" },
      )
    const showWorkTree = (target: WorkTree) =>
      shell.handover(
        Effect.gen(function* () {
          if (!hunkMissing) {
            const ran = yield* onTerminal(target.cwd, workTreeCommand(target, "hunk", base())).pipe(
              Effect.as(true),
              Effect.catchTag("ProgramMissing", () => Effect.succeed(false)),
            )
            if (ran) return Option.none<string>()
          }
          const note = learnHunkMissing()
          yield* onTerminal(target.cwd, workTreeCommand(target, "pager", base()))
          return note
        }),
      )
    // `gh pr diff` pages itself without hunk; with it, its patch goes to a
    // file for `hunk patch`, so the reader's `gh` sign-in reads a private one.
    const pagedPullRequest = (cwd: string) =>
      shell.handover(onTerminal(cwd, ["gh", ["pr", "diff"]]))
    const showPullRequest = (cwd: string) =>
      Effect.gen(function* () {
        if (hunkMissing) {
          yield* pagedPullRequest(cwd)
          return Option.none<string>()
        }
        const patch = yield* ghPr(cwd, ["diff"])
        const fs = yield* FileSystem.FileSystem
        const file = yield* fs.makeTempFileScoped({ prefix: "gent-pr-", suffix: ".patch" })
        yield* fs.writeFileString(
          file,
          Option.getOrElse(patch, () => ""),
        )
        const ran = yield* shell.handover(
          onTerminal(cwd, ["hunk", ["patch", file]]).pipe(
            Effect.as(true),
            Effect.catchTag("ProgramMissing", () => Effect.succeed(false)),
          ),
        )
        if (ran) return Option.none<string>()
        const note = learnHunkMissing()
        yield* pagedPullRequest(cwd)
        return note
      }).pipe(Effect.scoped)
    const review = (target: Effect.Effect<ReviewTarget, never, GitServices>) =>
      shell.cast(
        target.pipe(
          Effect.flatMap((value) =>
            ReviewTarget.match(value, {
              WorkTree: showWorkTree,
              PullRequest: ({ cwd }) => showPullRequest(cwd),
            }),
          ),
          Effect.flatMap((note) => Effect.sync(() => Option.map(note, shell.notify))),
          Effect.catchTags({
            ProgramMissing: ({ program }) =>
              Effect.sync(() => shell.notify(`${program} not found`)),
            GhMissing: () => Effect.sync(() => shell.notify("gh not found")),
            GhReadError: ({ message }) => Effect.sync(() => shell.notify(message)),
            ReviewFailed: ({ message }) => Effect.sync(() => shell.notify(message)),
            PlatformError: (error) => Effect.sync(() => shell.notify(error.message)),
          }),
          Effect.provideContext(services),
        ),
      )
    const openPane = () => {
      shell.pane.open(GIT_PANE)
      local.refresh()
      pullRequest.refresh()
    }

    return clientContributions(
      statusLabelContribution({
        priority: 20,
        produce: () =>
          Option.match(local.value(), {
            onNone: () => [],
            onSome: (checkout) => checkoutLabels(checkout, currentPullRequest()),
          }),
      }),
      clientCommandContribution({
        id: "git.view",
        title: "Git",
        description: "Changed files and the branch's pull request; enter reviews one",
        category: "Workflow",
        slash: "git",
        onSelect: openPane,
      }),
      clientCommandContribution({
        id: "git.diff",
        title: "Review changes",
        description: "Review the work tree in hunk or the git pager: /diff [paths | pr]",
        category: "Workflow",
        slash: "diff",
        onSelect: () => review(Effect.map(workspace.sessionCwd, (cwd) => reviewTarget("", cwd))),
        onSlash: (args) =>
          review(Effect.map(workspace.sessionCwd, (cwd) => reviewTarget(args, cwd))),
      }),
      widgetContribution({
        id: GIT_PANE,
        slot: "below-input",
        component: () => (
          <GitPane
            open={shell.pane.isOpen(GIT_PANE)}
            checkout={local.value}
            pullRequest={currentPullRequest}
            error={() => Option.orElse(local.error(), pullRequest.error)}
            loading={local.loading}
            onReview={(target) => review(Effect.succeed(target))}
            onClose={() => shell.pane.close(GIT_PANE)}
          />
        ),
      }),
    )
  }),
})
