/**
 * The git commands gent runs for its own plumbing: `@gent/workspaces` (a
 * child's copy and the branch its work comes back on) and
 * `@gent/checkpoints` (the work tree at each turn's start and end). One
 * module the two share, so every command runs with the same quiet settings
 * and fails with git's own words.
 *
 * @module
 */
import { Duration, Effect, Option, Schema, Stream } from "effect"
import { runProcess } from "@gent/core/extensions/api"

/** A git command that did not run, or that git refused; `message` is git's last line. */
export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  message: Schema.String,
}) {}

const GIT_TIMEOUT = Duration.minutes(2)

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

export interface GitOptions {
  /**
   * Variables set over gent's own environment for this command; `undefined`
   * removes an inherited one.
   */
  // oxlint-disable-next-line effect/noNullish -- Child-process environments use undefined to remove inherited variables.
  readonly env?: Record<string, string | undefined>
  /** Text written to git's stdin, which closes after it. */
  readonly stdin?: string
  readonly timeout?: Duration.Duration
}

/** The word a failure names: the subcommand, after the global options and their values. */
const subcommand = (args: ReadonlyArray<string>): string => {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ""
    if (arg === "-c") index++
    else if (!arg.startsWith("-")) return arg
  }
  return "command"
}

/** One git command in `cwd`, whatever its exit: its code and its output, untrimmed. */
const gitRun = (cwd: string, args: ReadonlyArray<string>, options: GitOptions = {}) =>
  runProcess("git", ["-C", cwd, ...QUIET_GIT, ...args], {
    env: options.env ?? {},
    extendEnv: true,
    timeout: options.timeout ?? GIT_TIMEOUT,
    ...Option.match(Option.fromUndefinedOr(options.stdin), {
      onNone: () => ({}),
      onSome: (text) => ({ stdin: Stream.make(new TextEncoder().encode(text)) }),
    }),
  }).pipe(Effect.mapError((error) => new GitError({ message: error.message })))

/** The failure of a command that exited with `exitCode`, in git's last words. */
const gitFailure = (
  args: ReadonlyArray<string>,
  result: { readonly exitCode: number; readonly stderr: string },
) => {
  const reason = Option.fromUndefinedOr(result.stderr.trim().split("\n").at(-1)).pipe(
    Option.filter((line) => line.length > 0),
    Option.getOrElse(() => `exit ${result.exitCode}`),
  )
  return new GitError({ message: `git ${subcommand(args)} failed: ${reason}` })
}

/** One git command in `cwd`; its trimmed stdout, or a failure in git's own words. */
export const git = (cwd: string, args: ReadonlyArray<string>, options: GitOptions = {}) =>
  gitRun(cwd, args, options).pipe(
    Effect.flatMap((result) => {
      if (result.exitCode === 0) return Effect.succeed(result.stdout.trim())
      return Effect.fail(gitFailure(args, result))
    }),
  )

/** A git read that may find nothing: none on any failure. */
export const gitOption = (cwd: string, args: ReadonlyArray<string>, options: GitOptions = {}) =>
  git(cwd, args, options).pipe(
    Effect.asSome,
    Effect.catchTag("GitError", () => Effect.succeedNone),
  )

/**
 * A repository with no identity still gets its commit, named for gent; one
 * with an identity keeps it.
 */
const identityArgs = Effect.fn("GitPlumbing.identityArgs")(function* (repo: string) {
  const name = yield* gitOption(repo, ["config", "user.name"])
  const email = yield* gitOption(repo, ["config", "user.email"])
  if (Option.isSome(name) && Option.isSome(email)) return []
  return ["-c", "user.name=gent", "-c", "user.email=gent@localhost"]
})

/** One commit of `tree` over `parent`, made in `repo`. */
export const commitTree = Effect.fn("GitPlumbing.commitTree")(function* (
  repo: string,
  tree: string,
  parent: string,
  message: string,
) {
  const identity = yield* identityArgs(repo)
  return yield* git(repo, [...identity, "commit-tree", tree, "-p", parent, "-m", message])
})

/** `K files changed, N insertions(+), M deletions(-)`, as numbers. */
export const parseShortStat = (text: string) => {
  const count = (pattern: RegExp) => Number(pattern.exec(text)?.[1] ?? 0)
  return {
    files: count(/(\d+) files? changed/),
    insertions: count(/(\d+) insertions?\(\+\)/),
    deletions: count(/(\d+) deletions?\(-\)/),
  }
}
