/**
 * Guard: the `ProcessRunner` service stays removed.
 *
 * Running a child process is a free function, `runProcess` in
 * `packages/core/src/runtime/gent-platform.ts`, over `ChildProcessSpawner`. The
 * Tag that wrapped it added a second name for the same capability: every
 * requirement union that carried `ProcessRunner` already carried the spawner,
 * and the only real read re-provided the spawner it had just taken out. A file
 * that names `ProcessRunner` again is that wrapper growing back.
 *
 * @module
 */

import { Option } from "effect"

/** A source file that names the removed process-runner service. */
export interface ProcessRunnerFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

/** Every name the removed service owned. */
export const REMOVED_IDENTIFIERS: ReadonlyArray<string> = [
  "ProcessRunner",
  "ProcessRunnerLive",
  "ProcessRunnerService",
  "makeProcessRunner",
]

/**
 * Source and tests under `packages/` and `apps/`, not docs and not plans.
 * `packages/tooling/` is excluded: this guard and its fixtures name the
 * removed surfaces on purpose.
 */
const SCANNED_SOURCE = /^(?:packages|apps)\/(?!tooling\/)[^/]+\/(?:src|tests)\//

/** `InProcessRunner` is a live agent-runner layer and keeps its name. */
const identifierPattern = (name: string) => new RegExp(`(?<![A-Za-z0-9_$])${name}(?![A-Za-z0-9_$])`)

/**
 * Find every line under `packages/` or `apps/` that names a removed
 * process-runner surface. Tests are scanned too: a test that builds the layer
 * again is the same regrowth as shipped code that yields the Tag.
 */
export const findProcessRunnerFindings = (
  file: string,
  text: string,
): ReadonlyArray<ProcessRunnerFinding> => {
  if (!SCANNED_SOURCE.test(file)) return []
  const findings: Array<ProcessRunnerFinding> = []
  for (const [index, line] of text.split("\n").entries()) {
    const name = Option.fromNullishOr(
      REMOVED_IDENTIFIERS.find((candidate) => identifierPattern(candidate).test(line)),
    )
    if (Option.isNone(name)) continue
    findings.push({
      file,
      line: index + 1,
      message: `names "${name.value}", a surface of the removed process-runner service; call runProcess from runtime/gent-platform.ts and take ChildProcessSpawner in the requirement union`,
    })
  }
  return findings
}
