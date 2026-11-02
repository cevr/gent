// The repeat-test check: a process entry the orchestrate machines ship as a
// definition file (`workflows.ts` embeds this text) and run in a run state
// between an implementor round and its review, as
// `{{bun}} "{{files.repeat-tests.ts}}" "{{input.dir}}"` in the unit's checkout.
// It runs from a temp directory with no packages, so it imports only Node and
// Bun built-ins, and it is a plain script, not an Effect program.
//
// A Blocker or Major of the last findings that says "repeat of rN <id>" needs a
// line in the newest request:
//
//   Repeat test: rN <id> <test file>... -- <command> :: <test name>
//
// rN <id> is the finding the repeat names, the test files are paths from the
// repository root, the command runs at the root and ends at the first " :: ",
// and the test name is the rest of the line. In a clean detached worktree of
// each commit, with its packages installed, the command must be red at the head
// the last review saw, with the test files taken from the new head: an exit
// from 1 to 125 whose output names the test. It must be green at the new head:
// exit 0, its output naming the test, as proof the test ran.
//
// A finding is read as the machines engine reads it: a list item under a
// severity heading whose first word is an id (`M2`, `**B1**:`), or a line
// that names its severity and number (`Major 2: ...`) anywhere but under
// another heading. Its id's letter is its severity: `B` and `M` block, `m`
// is a Minor. Its text runs to the next finding or heading.
//
// Exit 0: PASS, or SKIP when the last findings name no repeat. Exit 1: FAIL,
// the test evidence is wrong. Exit 2: ERROR, the check itself could not run
// (git failed, an install failed, the runner could not start at the head, the
// script crashed). Each run writes round-N-repeat-check.md in the unit dir, N
// the newest request's round (at least one more than the last findings'),
// whose Head line is the head the next review sees and so the next check's
// base. The worktrees live under <unit dir>/repeat-check/, which every run
// clears first, so a killed run leaves nothing past the next one. It prints
// its verdict and record, then the repeats it checked (`Repeats: r1 M1`): on a
// PASS, the engine confirms the findings those keys name.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"

/** The exit each verdict ends with. */
const EXIT_CODES = { PASS: 0, SKIP: 0, FAIL: 1, ERROR: 2 } as const
type Verdict = keyof typeof EXIT_CODES

const cwd = process.cwd()
const dir = resolve(cwd, process.argv[2] ?? "")
const checkouts = join(dir, "repeat-check")

/**
 * The children's environment. `BUN_BE_BUN` made this process Bun and would
 * make a compiled gent a test runs Bun too; `CLAUDECODE`, `AGENT` and
 * `REPL_ID` make `bun test` print only failures, which hides a passing
 * test's name.
 */
const childEnv: Record<string, string> = {}
for (const [key, value] of Object.entries(process.env)) {
  if (value === undefined || ["BUN_BE_BUN", "CLAUDECODE", "AGENT", "REPL_ID"].includes(key))
    continue
  childEnv[key] = value
}

interface Ran {
  /** The exit code; null when a signal ended the process. */
  readonly code: number | null
  readonly out: string
}

const run = (command: ReadonlyArray<string>, at: string, env = childEnv): Ran => {
  const result = Bun.spawnSync([...command], { cwd: at, env, stdout: "pipe", stderr: "pipe" })
  return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
}

const git = (args: ReadonlyArray<string>, at = cwd) => run(["git", ...args], at)

const read = (name: string): string => {
  const path = join(dir, name)
  if (!existsSync(path)) return ""
  return readFileSync(path, "utf8")
}

/** The highest N of a round-N-<kind>.md in the unit dir; 0 when there is none. */
const newest = (kind: string): number => {
  let found = 0
  for (const name of readdirSync(dir)) {
    const match = /^round-(\d+)-([a-z-]+)\.md$/.exec(name)
    if (match !== null && match[2] === kind) found = Math.max(found, Number(match[1]))
  }
  return found
}

/** A finding key, "r1 M2": the round and the id, without the punctuation around them. */
const keyOf = (round: string, id: string) =>
  round.toLowerCase() + " " + id.replace(/^[(`*_[]+|[.,;:)`*_\]]+$/g, "")

/** A heading's text: an ATX heading, a whole-line bold label, or a bare severity label. */
const headingOf = (line: string): string | undefined => {
  const atx = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
  if (atx !== null) return atx[1] ?? ""
  const bold = /^\s*(\*\*|__)(.+?)\1\s*:?\s*$/.exec(line)
  if (bold !== null) return bold[2] ?? ""
  const bare =
    /^\s*((blockers?|majors?|minors?|optional|rejected|test strength)\s*(\(.*\))?)\s*:?\s*$/i.exec(
      line,
    )
  if (bare !== null) return bare[1] ?? ""
  return undefined
}

/** A heading that opens a severity's list; under any other, a severity line starts no finding. */
const SEVERITY_HEADING = /^(blockers?|majors?|minors?|optional|test strength)\b/i
/** A line that starts a finding by its severity and number: `Major 2: ...`, `- **Blocker 1.** ...`. */
const SEVERITY_LINE =
  /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:#{1,6}\s+)?(?:\*\*|__)?(blocker|major|minor|optional|test[- ]strength)s?\s+\d+(?:\*\*|__)?\s*[:.)\u2014\u2013-]/i
const REPEAT_OF = /repeat of (r\d+) (\S+)/gi
/** A list item at any indentation, and its first word. */
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(\S+)/
/** A finding's id: its severity's letter (`b`, `o`, `t` read as uppercase; `m` is a Minor), then its number. */
const FINDING_ID = /^([BMmOTbot])\d+$/

/** The letter of the id a list item's first word is, without the punctuation around it. */
const idLetterOf = (word: string): string | undefined =>
  FINDING_ID.exec(word.replace(/^[(`*_[]+|[.,;:)`*_\]]+$/g, ""))?.[1]

/**
 * Where a line is: before any heading, under a severity heading, or under
 * another one; and whether it is in a Blocker's or a Major's text.
 */
interface Place {
  readonly section: "start" | "severity" | "other"
  readonly blocking: boolean
}

/** The place of `line`, after the line before it was at `place`. */
const placeOf = (place: Place, line: string): Place => {
  const named = SEVERITY_LINE.exec(line)
  if (named !== null && place.section !== "other")
    return { section: place.section, blocking: /^(blocker|major)$/i.test(named[1] ?? "") }
  const heading = headingOf(line)
  if (heading !== undefined) {
    if (SEVERITY_HEADING.test(heading.trim())) return { section: "severity", blocking: false }
    return { section: "other", blocking: false }
  }
  const letter = idLetterOf(LIST_ITEM.exec(line)?.[1] ?? "")
  if (place.section === "severity" && letter !== undefined)
    return { section: place.section, blocking: /^[BbM]$/.test(letter) }
  return place
}

/** The earlier findings a findings file's Blockers and Majors repeat. */
const repeatsIn = (findings: string): ReadonlyArray<string> => {
  const keys: Array<string> = []
  let place: Place = { section: "start", blocking: false }
  for (const line of findings.split(/\r?\n/)) {
    place = placeOf(place, line)
    if (!place.blocking) continue
    for (const match of line.matchAll(REPEAT_OF)) {
      const key = keyOf(match[1] ?? "", match[2] ?? "")
      if (!keys.includes(key)) keys.push(key)
    }
  }
  return keys
}

interface RepeatTest {
  readonly key: string
  readonly files: ReadonlyArray<string>
  readonly command: string
  readonly name: string
}

const TEST_LINE = /^repeat test:\s*(r\d+)\s+(\S+)\s+(.+?)\s+--\s+(.+?)\s+::\s+(.+)$/i

/** The request's "Repeat test:" lines, and each such line that breaks the grammar. */
const testsIn = (request: string) => {
  const tests: Array<RepeatTest> = []
  const malformed: Array<string> = []
  for (const raw of request.split("\n")) {
    const line = raw
      .trim()
      .replace(/^[-*>\s]+/, "")
      .replace(/^`+|`+$/g, "")
      .trim()
    if (!/^repeat test:/i.test(line)) continue
    const match = TEST_LINE.exec(line)
    if (match === null) {
      malformed.push(line)
      continue
    }
    tests.push({
      key: keyOf(match[1] ?? "", match[2] ?? ""),
      files: (match[3] ?? "").split(/\s+/).filter((file) => file.length > 0),
      command: match[4] ?? "",
      name: (match[5] ?? "").trim(),
    })
  }
  return { tests, malformed }
}

/** The commit a "Head: <sha>" line names; empty when there is none. */
const headLine = (text: string): string => /^Head:\s*([0-9a-f]{7,40})\b/m.exec(text)?.[1] ?? ""

/** The commit `ref` names in the unit's checkout; empty when git cannot resolve it. */
const commitOf = (ref: string): string => {
  if (ref === "") return ""
  const resolved = git(["rev-parse", "--verify", "--quiet", ref + "^{commit}"])
  if (resolved.code !== 0) return ""
  return resolved.out.trim()
}

const realOr = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** The worktrees git has registered under the check's directory, however git spells the path. */
const registeredCheckouts = (): ReadonlyArray<string> => {
  const roots = [checkouts, join(realOr(dir), "repeat-check")]
  const listed = git(["worktree", "list", "--porcelain"])
  return listed.out
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter((path) => roots.some((root) => path === root || path.startsWith(root + "/")))
}

/**
 * Removes every worktree under the check's directory, a killed run's too,
 * then the directory. The reason it could not, or empty.
 */
const clearCheckouts = (): string => {
  for (const path of registeredCheckouts()) git(["worktree", "remove", "--force", "--force", path])
  rmSync(checkouts, { recursive: true, force: true })
  git(["worktree", "prune"])
  const left = registeredCheckouts()
  if (left.length === 0) return ""
  return "git still lists worktrees under " + checkouts + ": " + left.join(", ")
}

/** The install each lock file asks for; Bun's runs on this process's own runtime. */
const INSTALLS: ReadonlyArray<readonly [string, ReadonlyArray<string>, boolean]> = [
  ["bun.lock", [process.execPath, "install", "--frozen-lockfile"], true],
  ["bun.lockb", [process.execPath, "install", "--frozen-lockfile"], true],
  ["pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"], false],
  ["yarn.lock", ["yarn", "install", "--frozen-lockfile"], false],
  ["package-lock.json", ["npm", "ci"], false],
]

const failures: Array<string> = []
const errors: Array<string> = []
const results: Array<string> = []
interface Summary {
  head: string
  findings: number
  round: number
  repeats: ReadonlyArray<string>
  reviewed: string
}
const summary: Summary = { head: "", findings: 0, round: 0, repeats: [], reviewed: "" }

/** Writes a run's output under the round's evidence directory and returns its path. */
const logged = (name: string, out: string): string => {
  const evidence = join(dir, "repeat-check-" + summary.round + "-evidence")
  mkdirSync(evidence, { recursive: true })
  const path = join(evidence, name)
  writeFileSync(path, out)
  return path
}

/**
 * A clean checkout of `commit` at `path`, with `files` taken from the head
 * and its packages installed. A git or install failure is an error; test
 * files missing at the head are a failure of the request.
 */
const checkout = (side: string, path: string, commit: string, files: ReadonlyArray<string>) => {
  const added = git(["worktree", "add", "--detach", path, commit])
  if (added.code !== 0) {
    errors.push("git worktree add at the " + side + " " + commit + " failed: " + added.out.trim())
    return false
  }
  if (files.length > 0) {
    const taken = git(["checkout", summary.head, "--", ...files], path)
    if (taken.code !== 0) {
      failures.push(
        "the test files are not all at the head " + summary.head + ": " + taken.out.trim(),
      )
      return false
    }
  }
  const install = INSTALLS.find(([lock]) => existsSync(join(path, lock)))
  if (install === undefined) return true
  const [, command, ownRuntime] = install
  let env = childEnv
  if (ownRuntime) env = { ...childEnv, BUN_BE_BUN: "1" }
  const installed = run(command, path, env)
  const log = logged("install-" + side + ".log", installed.out)
  if (installed.code === 0) return true
  errors.push(
    command.join(" ") + " at the " + side + " failed with exit " + installed.code + ", see " + log,
  )
  return false
}

/** The base run is red: it exits 1 to 125 (126 and up: bash could not run it, or a signal ended it) and names the test. */
const checkBase = (test: RepeatTest, shown: string, ran: Ran, log: string) => {
  const at = "at the base " + summary.reviewed + ", the head review " + summary.findings + " saw"
  if (ran.code === 0) {
    failures.push(shown + " passes " + at + ": the test must fail on the unfixed code, see " + log)
  } else if (ran.code === null || ran.code > 125) {
    failures.push(
      shown +
        " did not run " +
        at +
        " (exit " +
        ran.code +
        "): a launch failure or a signal is no proof the test fails, see " +
        log,
    )
  } else if (!ran.out.includes(test.name)) {
    failures.push(
      shown +
        " fails " +
        at +
        " with exit " +
        ran.code +
        ", and its output does not name the test: a collection or import failure is no proof the test ran, see " +
        log,
    )
  }
}

/** The head run is green: exit 0, naming the test. Exit 126 or 127 is a runner that could not start. */
const checkHead = (test: RepeatTest, shown: string, ran: Ran, log: string) => {
  const at = "at the head " + summary.head
  if (ran.code === 126 || ran.code === 127) {
    errors.push(shown + " could not start " + at + " (exit " + ran.code + "), see " + log)
  } else if (ran.code !== 0) {
    failures.push(shown + " fails " + at + " with exit " + ran.code + ", see " + log)
  } else if (!ran.out.includes(test.name)) {
    failures.push(
      shown +
        " passes " +
        at +
        ", and its output does not name the test: no proof the test ran (use a reporter that lists passing tests), see " +
        log,
    )
  }
}

/** Runs each named test at both sides, in two clean checkouts the end removes. */
const runTests = (tests: ReadonlyArray<RepeatTest>) => {
  const basePath = join(checkouts, "base")
  const headPath = join(checkouts, "head")
  const files = [...new Set(tests.flatMap((test) => test.files))]
  try {
    const baseReady = checkout("base", basePath, summary.reviewed, files)
    const headReady = checkout("head", headPath, summary.head, [])
    tests.forEach((test, index) => {
      const shown = test.key + " `" + test.name + "` (" + test.command + ")"
      if (baseReady) {
        const ran = run(["bash", "-c", test.command], basePath)
        const log = logged(index + 1 + "-base.log", ran.out)
        results.push("- " + shown + ": base exit " + ran.code + ", log " + log)
        checkBase(test, shown, ran, log)
      }
      if (headReady) {
        const ran = run(["bash", "-c", test.command], headPath)
        const log = logged(index + 1 + "-head.log", ran.out)
        results.push("- " + shown + ": head exit " + ran.code + ", log " + log)
        checkHead(test, shown, ran, log)
      }
    })
  } finally {
    const left = clearCheckouts()
    if (left !== "") errors.push(left)
  }
}

/** The check, to its verdict; each problem it met is in `failures` or `errors`. */
const check = (): Verdict => {
  if (!existsSync(dir)) {
    errors.push("the unit dir " + dir + " does not exist")
    return "ERROR"
  }
  const cleared = clearCheckouts()
  if (cleared !== "") errors.push(cleared)
  summary.head = commitOf("HEAD")
  summary.findings = newest("findings")
  const requestRound = newest("request")
  summary.round = Math.max(requestRound, summary.findings + 1)
  summary.repeats = repeatsIn(read("round-" + summary.findings + "-findings.md"))
  if (errors.length > 0) return "ERROR"
  // With no repeat there is nothing to run; a check that needs this Head later reports its absence.
  if (summary.repeats.length === 0) return "SKIP"
  if (summary.head === "") {
    errors.push("the checkout " + cwd + " has no HEAD commit")
    return "ERROR"
  }
  const findings = "round-" + summary.findings + "-findings.md"
  if (requestRound <= summary.findings) {
    failures.push(findings + " names repeats, and no newer round-N-request.md answers them")
    return "FAIL"
  }
  const request = "round-" + requestRound + "-request.md"
  const { tests, malformed } = testsIn(read(request))
  for (const line of malformed) {
    failures.push(
      request +
        " has a line that breaks the grammar Repeat test: rN <id> <test file>... -- <command> :: <test name>: " +
        line,
    )
  }
  const named = tests.filter((test) => summary.repeats.includes(test.key))
  for (const key of summary.repeats) {
    if (named.some((test) => test.key === key)) continue
    failures.push(
      key +
        " is a repeat in " +
        findings +
        ", and " +
        request +
        " names no test for it: add the line Repeat test: " +
        key +
        " <test file>... -- <command> :: <test name>",
    )
  }
  const record = "round-" + summary.findings + "-repeat-check.md"
  summary.reviewed = commitOf(headLine(read(record)))
  if (summary.reviewed === "") {
    errors.push(
      record +
        " names no commit of this checkout, so the head review " +
        summary.findings +
        " saw is unknown",
    )
  }
  if (failures.length > 0 || errors.length > 0) return verdictOf()
  runTests(named)
  return verdictOf()
}

/** A wrong test is a failed round even when another part of the check could not run. */
const verdictOf = (): Verdict => {
  if (failures.length > 0) return "FAIL"
  if (errors.length > 0) return "ERROR"
  return "PASS"
}

const finish = (verdict: Verdict) => {
  const lines = [
    "Verdict: " + verdict,
    "Head: " + (summary.head || "none"),
    "Findings: " + (summary.findings === 0 ? "none" : "round-" + summary.findings + "-findings.md"),
    "Repeats: " + (summary.repeats.length === 0 ? "none" : summary.repeats.join(", ")),
  ]
  if (summary.reviewed !== "") lines.push("Reviewed head: " + summary.reviewed)
  if (results.length > 0) lines.push("", "Tests:", ...results)
  if (failures.length > 0) lines.push("", "Failures:", ...failures.map((failure) => "- " + failure))
  if (errors.length > 0) lines.push("", "Errors:", ...errors.map((error) => "- " + error))
  const record = join(dir, "round-" + summary.round + "-repeat-check.md")
  if (existsSync(dir)) writeFileSync(record, lines.join("\n") + "\n")
  console.log("Repeat-test check " + verdict + ", " + record)
  console.log("Repeats: " + (summary.repeats.length === 0 ? "none" : summary.repeats.join(", ")))
  for (const line of [...failures, ...errors]) console.log("- " + line)
  process.exit(EXIT_CODES[verdict])
}

/** The check's verdict; a crash is an error, beside what it found before. */
const verdictOrCrash = (): Verdict => {
  try {
    return check()
  } catch (error) {
    errors.push(
      "the check crashed: " +
        (error instanceof Error ? (error.stack ?? error.message) : String(error)),
    )
    return verdictOf()
  }
}

try {
  finish(verdictOrCrash())
} catch (error) {
  console.log("Repeat-test check ERROR: the record could not be written: " + String(error))
  process.exit(EXIT_CODES.ERROR)
}
