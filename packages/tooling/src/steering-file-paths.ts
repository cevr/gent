/**
 * Guard: a repo path named in a steering file must exist.
 *
 * The steering files are what an agent reads before it touches the code, and
 * a path in one of them is read as a fact about the tree. When a file is
 * renamed or deleted the prose keeps pointing at the old name, and nothing
 * fails: the reference is documentation, so no compiler, linter or test ever
 * resolves it. An agent sent to `apps/tui/tests/render-harness.tsx` finds
 * nothing and either invents the file or picks a neighbour.
 *
 * Scope is the four files an agent is told to read: `CLAUDE.md` and
 * `AGENTS.md` at the root, `apps/tui/AGENTS.md`, and `ARCHITECTURE.md`. The
 * root pair are two copies of the same document rather than one file behind a
 * symlink, so both are read and a stale path in either is reported.
 *
 * What is read: text in backticks that starts with one of the five source
 * roots — `packages/`, `apps/`, `plans/`, `testbeds/`, `examples/`. Backticks
 * are what makes the reference a claim about a path; prose naming a file
 * without them is left alone. A path is satisfied when `git ls-files` lists
 * it, or lists anything under it, which lets a directory reference such as
 * `packages/core/src/` stand on the files it contains.
 *
 * Four shapes are skipped, each because it never named one path to begin with:
 *
 * - A glob or a brace expansion — `packages/core/src/domain/{tool,request}.ts`
 *   and anything containing `*` — stands for a set, and the set has no single
 *   entry to look up.
 * - A placeholder in angle brackets, such as `plans/<name>.md`, is a form for
 *   the reader to fill in.
 * - A path inside a fenced code block. Those fences hold shell commands and
 *   the package-structure sketch, where `packages/core/src/` appears beside
 *   trailing comments and tree-drawing characters. Reading them as paths
 *   would report the sketch rather than the prose.
 * - A path carrying a shell or URL character (a space, `$`, `:` or `#`),
 *   which marks it as a fragment of a command line rather than a filename.
 *
 * The symlinked package source is the case the lookup has to get right.
 * `packages/core-internal/src` is a symlink to `../core/src`, so git tracks it
 * as one blob at that exact path and lists nothing beneath it. A reference
 * spelled `packages/core-internal/src/` therefore matches no prefix, and the
 * lookup falls back to the path with its trailing slash removed.
 *
 * @module
 */

import { Option } from "effect"

/** A steering-file reference to a path that `git ls-files` does not list. */
export interface SteeringFilePathFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

/** The files an agent is told to read before it changes the code. */
const STEERING_FILES = new Set(["CLAUDE.md", "AGENTS.md", "apps/tui/AGENTS.md", "ARCHITECTURE.md"])

export const isSteeringFile = (file: string): boolean => STEERING_FILES.has(file)

/** The five roots under which a backticked path is a claim about the tree. */
const SOURCE_ROOT = /^(?:packages|apps|plans|testbeds|examples)\//

/** Text between backticks, which is what marks a reference as a path. */
const BACKTICKED = /`([^`\n]+)`/g

/** A fence opens or closes a block whose contents are commands, not prose. */
const FENCE = /^\s*```/

/** Stands for a set of paths: a glob, or a brace expansion over filenames. */
const MULTI_PATH = /[*{}]/

/** A form for the reader to fill in, not a path that exists. */
const PLACEHOLDER = /[<>]/

/** Marks the text as a fragment of a command line or a URL, not a filename. */
const COMMAND_TEXT = /[\s$:#]/

const isPathClaim = (text: string): boolean =>
  SOURCE_ROOT.test(text) &&
  !MULTI_PATH.test(text) &&
  !PLACEHOLDER.test(text) &&
  !COMMAND_TEXT.test(text)

/**
 * Whether the tree holds this path.
 *
 * A file matches its own entry. A directory matches on the entries beneath it.
 * A trailing slash is dropped for the retry so a tracked symlink, which git
 * lists as a blob at the bare path, answers a reference written as a directory.
 */
const existsInTree = (
  path: string,
  tracked: ReadonlySet<string>,
  prefixes: ReadonlySet<string>,
) => {
  if (tracked.has(path)) return true
  if (prefixes.has(path)) return true
  const bare = path.replace(/\/+$/, "")
  return tracked.has(bare) || prefixes.has(bare)
}

/**
 * Every directory that holds a tracked file, so a reference to a directory
 * resolves without a scan per lookup.
 */
const directoryPrefixesOf = (tracked: Iterable<string>): ReadonlySet<string> => {
  const prefixes = new Set<string>()
  for (const file of tracked) {
    let cut = file.indexOf("/")
    while (cut !== -1) {
      prefixes.add(file.slice(0, cut))
      prefixes.add(file.slice(0, cut + 1))
      cut = file.indexOf("/", cut + 1)
    }
  }
  return prefixes
}

export const findSteeringFilePaths = (
  file: string,
  text: string,
  trackedFiles: ReadonlyArray<string>,
): ReadonlyArray<SteeringFilePathFinding> => {
  if (!isSteeringFile(file)) return []

  const tracked = new Set(trackedFiles)
  const prefixes = directoryPrefixesOf(trackedFiles)
  const findings: SteeringFilePathFinding[] = []
  let inFence = false
  for (const [index, line] of text.split("\n").entries()) {
    if (FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    for (const match of line.matchAll(BACKTICKED)) {
      const claimed = Option.getOrElse(Option.fromNullishOr(match[1]), () => "")
      if (!isPathClaim(claimed)) continue
      if (existsInTree(claimed, tracked, prefixes)) continue
      findings.push({
        file,
        line: index + 1,
        message: `steering file names \`${claimed}\`, which no tracked file matches -- point it at the path that exists, or drop the reference`,
      })
    }
  }
  return findings
}
