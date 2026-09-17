/**
 * Guard: the pre-commit hook asks the guards first.
 *
 * The hook's later jobs take minutes -- a turbo typecheck, a build, the whole
 * test run -- while the guards read the tree in about two seconds. Lefthook
 * runs every job regardless of what failed, so the order decides where the
 * verdict lands in the output, not how long the run takes. With the guards
 * first their answer heads the log; anywhere else it is buried under the jobs
 * that ran after it.
 *
 * Position also settles what the guards read. `lint+fmt` rewrites files and
 * stages what it changed, so a guard placed after it reads the formatter's
 * output rather than the text the author wrote.
 *
 * What is reported: a `lefthook.yml` whose first `pre-commit` job is not the
 * one running the guards, or which has no such job at all. The job is found by
 * the command it runs, not by its name, so renaming it is free and dropping
 * `bun run guards` from it is not.
 *
 * @module
 */

import { Option } from "effect"

/** The pre-commit hook does not put the guards first. */
export interface HookGuardOrderFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

export const HOOK_FILE = "lefthook.yml"

/** The script the guards job runs. `package.json` owns the command itself. */
const GUARD_COMMAND = "bun run guards"

/** A job entry opens with `- name:` at the job list's indentation. */
const JOB_ENTRY = /^\s*-\s+name:\s*(\S+)/

/** The `pre-commit` hook's own key, at the top level of the file. */
const PRE_COMMIT = /^pre-commit:/

/** Any other top-level key closes the `pre-commit` block. */
const TOP_LEVEL_KEY = /^\S/

interface Job {
  readonly name: string
  readonly line: number
  readonly body: string
}

/** The `pre-commit` jobs in file order, each with the text it carries. */
const preCommitJobs = (text: string): ReadonlyArray<Job> => {
  const lines = text.split("\n")
  const jobs: Job[] = []
  let inPreCommit = false
  let current: Option.Option<{ name: string; line: number; body: string[] }> = Option.none()
  const close = () => {
    if (Option.isSome(current)) {
      const open = current.value
      jobs.push({ name: open.name, line: open.line, body: open.body.join("\n") })
    }
    current = Option.none()
  }
  for (const [index, line] of lines.entries()) {
    if (PRE_COMMIT.test(line)) {
      inPreCommit = true
      continue
    }
    if (!inPreCommit) continue
    if (TOP_LEVEL_KEY.test(line)) {
      close()
      inPreCommit = false
      continue
    }
    const entry = Option.fromNullishOr(JOB_ENTRY.exec(line))
    if (Option.isNone(entry)) {
      if (Option.isSome(current)) current.value.body.push(line)
      continue
    }
    close()
    current = Option.some({
      name: Option.getOrElse(Option.fromNullishOr(entry.value[1]), () => ""),
      line: index + 1,
      body: [line],
    })
  }
  close()
  return jobs
}

export const findHookGuardOrder = (
  file: string,
  text: string,
): ReadonlyArray<HookGuardOrderFinding> => {
  if (file !== HOOK_FILE) return []

  const jobs = preCommitJobs(text)
  const guardIndex = jobs.findIndex((job) => job.body.includes(GUARD_COMMAND))
  if (guardIndex === 0) return []
  if (guardIndex === -1) {
    return [
      {
        file,
        line: 1,
        message: `the pre-commit hook runs no \`${GUARD_COMMAND}\` job -- the guards then reach a commit only through the gate, which runs minutes later`,
      },
    ]
  }
  const guardJob = jobs[guardIndex]
  return [
    {
      file,
      line: Option.getOrElse(
        Option.map(Option.fromNullishOr(guardJob), (job) => job.line),
        () => 1,
      ),
      message: `the \`${GUARD_COMMAND}\` job runs ${guardIndex} job(s) into the pre-commit hook -- move it first, so its verdict heads the output and it reads the tree before the formatter rewrites it`,
    },
  ]
}
