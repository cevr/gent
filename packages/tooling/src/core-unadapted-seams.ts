/**
 * Guard: every extension seam core declares must have a shipped adapter.
 *
 * Core is the loop plus the extension API. A seam with no implementation
 * behind it is not extensibility -- it is speculative surface that every
 * reader must account for and every refactor must carry. One adapter makes a
 * seam hypothetical; none makes it dead. `scheduledJobs` (removed in
 * 271c523a) and the `toolCall`/`toolResult` hooks were both found this way:
 * live, fully wired core machinery whose only registrants were the tests
 * exercising the mechanism itself.
 *
 * Two seam families are checked, both declared in core and filled from
 * outside it:
 *   - registration domains -- the keys of `RegistrationDomainMap`, reached
 *     as `host.register("<domain>", ...)`
 *   - hook kinds -- the keys of `ExtensionHookSignatures`, reached as
 *     `host.on("<kind>", ...)` or `hook("<kind>", ...)`
 *
 * Only shipped code counts as an adapter. A test registrant proves the
 * mechanism runs, not that anything needs it -- that is exactly the state
 * this guard exists to catch.
 *
 * @module
 */

import { Option } from "effect"

/** A seam core declares that no shipped extension fills. */
export interface UnadaptedSeamFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

const DOMAIN_MAP_FILE = "packages/core/src/domain/extension-host.ts"
const HOOK_SIGNATURES_FILE = "packages/core/src/domain/extension.ts"

/** Files that may fill a seam: shipped extensions and the apps, never tests. */
const isAdapterSource = (file: string): boolean =>
  (file.startsWith("packages/extensions/src/") || file.startsWith("apps/")) &&
  !file.includes("/tests/") &&
  !/\.test\.[cm]?[jt]sx?$/.test(file)

/**
 * Reads the member names of a single interface or object-literal body.
 *
 * Deliberately a brace-depth scan rather than a regex over the whole file: a
 * member name and a string literal elsewhere in the file look identical to a
 * pattern match, and counting a seam that was never declared would fail the
 * build for a name that does not exist.
 */
const declaredMembers = (text: string, blockPattern: RegExp): ReadonlyArray<string> => {
  const start = text.search(blockPattern)
  if (start < 0) return []
  const open = text.indexOf("{", start)
  if (open < 0) return []
  let depth = 0
  let end = open
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (ch === "{") depth++
    if (ch === "}") {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = text.slice(open + 1, end)
  return [...body.matchAll(/^\s*readonly\s+([A-Za-z][A-Za-z0-9]*)\s*:/gm)].flatMap((match) =>
    Option.match(Option.fromNullishOr(match[1]), {
      onNone: (): ReadonlyArray<string> => [],
      onSome: (name) => [name],
    }),
  )
}

/** Line number (1-indexed) of a seam's declaration, for the failure message. */
const lineOf = (text: string, name: string): number => {
  const lines = text.split("\n")
  const index = lines.findIndex((line) => new RegExp(`readonly\\s+${name}\\s*:`).test(line))
  // A seam read out of this very file always matches; the fallback only
  // guards a caller passing a name from somewhere else.
  if (index < 0) return 1
  return index + 1
}

/**
 * Seam names a shipped file registers. Matches across newlines because
 * `host.register(` and its domain argument are routinely formatted apart --
 * a single-line pattern silently reports a filled seam as empty.
 */
export const adaptedSeamsIn = (file: string, text: string): ReadonlySet<string> => {
  if (!isAdapterSource(file)) return new Set()
  return new Set(
    [...text.matchAll(/(?:register|\.on|hook)\(\s*"([A-Za-z][A-Za-z0-9]*)"/g)].flatMap((match) =>
      Option.match(Option.fromNullishOr(match[1]), {
        onNone: (): ReadonlyArray<string> => [],
        onSome: (name) => [name],
      }),
    ),
  )
}

export const findUnadaptedSeams = (
  sources: ReadonlyMap<string, string>,
  adapted: ReadonlySet<string>,
): ReadonlyArray<UnadaptedSeamFinding> => {
  const findings: UnadaptedSeamFinding[] = []

  const check = (file: string, blockPattern: RegExp, kindLabel: string): void => {
    const text = Option.fromNullishOr(sources.get(file))
    if (Option.isNone(text)) return
    for (const seam of declaredMembers(text.value, blockPattern)) {
      if (adapted.has(seam)) continue
      findings.push({
        file,
        line: lineOf(text.value, seam),
        message: `${kindLabel} "${seam}" has no shipped adapter; a seam nothing implements is dead surface. Ship an adapter or remove the seam.`,
      })
    }
  }

  check(DOMAIN_MAP_FILE, /interface RegistrationDomainMap/, "registration domain")
  check(HOOK_SIGNATURES_FILE, /interface ExtensionHookSignatures/, "hook kind")
  return findings
}
