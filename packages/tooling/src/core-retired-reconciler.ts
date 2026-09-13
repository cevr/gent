/**
 * Guard: the resource reconciler stays removed.
 *
 * A profile builds once per cwd into a scope that closes with the server
 * (`runtime/session-profile.ts`). The graph host that reconciled resource
 * plans, leases, generations and revisions behind a refresh entry point had
 * no shipped caller and was deleted in `282cf346` and `5a89367e`. A file that
 * names one of its surfaces again is that machinery growing back.
 *
 * @module
 */

import { Option } from "effect"

/** A shipped source file that names a retired reconciler surface. */
export interface RetiredReconcilerFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

/** Identifiers the reconciler owned. None has a live definition. */
export const RETIRED_IDENTIFIERS: ReadonlyArray<string> = [
  "ResourceGraphHost",
  "ResourceGraphPublication",
  "ResourceLeases",
  "ResourceGenerationId",
  "ResourceDescriptor",
  "ResourceRevision",
  "planResourceGraph",
  "diffResourceGraph",
  "LiveAgentLoopTurnProfile",
  "runAgentLoopTurnProfileOrLegacy",
]

/** Module basenames the reconciler lived in. */
export const RETIRED_MODULES: ReadonlyArray<string> = [
  "resource-graph",
  "resource-graph-host",
  "resource-leases",
  "resource-lifecycle",
  "live-profile",
]

const SHIPPED_SOURCE = /^(?:packages\/(?:core|extensions|sdk)\/src|apps\/[^/]+\/src)\//

const IMPORT_PATTERN = /^\s*(?:import|export)\b[^"']*from\s*["']([^"']+)["']/

const identifierPattern = (name: string) => new RegExp(`\\b${name}\\b`)

const retiredModuleIn = (specifier: string): Option.Option<string> =>
  Option.flatMap(Option.fromNullishOr(specifier.split("/").at(-1)), (last) => {
    const basename = last.replace(/\.[cm]?[jt]sx?$/, "")
    return Option.fromNullishOr(RETIRED_MODULES.find((module) => module === basename))
  })

/**
 * Find every line in a shipped source file that names a retired reconciler
 * identifier or imports a retired module. Tests and docs are not scanned: a
 * test may quote history, and this guard is a lock on shipped code.
 */
export const findRetiredReconcilerFindings = (
  file: string,
  text: string,
): ReadonlyArray<RetiredReconcilerFinding> => {
  if (!SHIPPED_SOURCE.test(file)) return []
  if (file === "packages/tooling/src/core-retired-reconciler.ts") return []
  const findings: Array<RetiredReconcilerFinding> = []
  for (const [index, line] of text.split("\n").entries()) {
    const module = Option.flatMap(
      Option.flatMap(Option.fromNullishOr(IMPORT_PATTERN.exec(line)), (match) =>
        Option.fromNullishOr(match[1]),
      ),
      retiredModuleIn,
    )
    if (Option.isSome(module)) {
      findings.push({
        file,
        line: index + 1,
        message: `imports the retired "${module.value}" module; a profile builds its resources once per cwd in runtime/session-profile.ts, so put new resource behavior inside that scoped build`,
      })
      continue
    }
    const name = Option.fromNullishOr(
      RETIRED_IDENTIFIERS.find((candidate) => identifierPattern(candidate).test(line)),
    )
    if (Option.isNone(name)) continue
    findings.push({
      file,
      line: index + 1,
      message: `names "${name.value}", a surface of the removed resource reconciler; a profile builds its resources once per cwd in runtime/session-profile.ts, so put new resource behavior inside that scoped build`,
    })
  }
  return findings
}
