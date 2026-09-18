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
 * Four seam families are checked, all declared in core and filled from
 * outside it:
 *   - registration domains -- the keys of `RegistrationDomainMap`, reached
 *     as `host.register("<domain>", ...)`
 *   - hook kinds -- the keys of `ExtensionHookSignatures`, reached as
 *     `host.on("<kind>", ...)` or `hook("<kind>", ...)`
 *   - context facets -- the service members of `ExtensionContextService`,
 *     reached as `ctx.<Facet>`
 *   - resource scopes -- the members of `ResourceScope`, reached as
 *     `scope: "<scope>"` on a resource definition
 *
 * Each family is named differently in adapter code, so each contributes its
 * own pattern to `adaptedSeamsIn` rather than sharing one. The `Dynamic`
 * facet (removed in 875b9149) is what the facet check exists to catch.
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

/** Every seam family core declares now lives in one file; each scan is anchored on its own interface name. */
const SEAM_DECLARATION_FILE = "packages/core/src/domain/extension.ts"

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
/**
 * How each seam family is spelled where it is filled. Registrations name the
 * seam in a string argument; a facet is reached as a property on the yielded
 * context; a resource scope is a literal field on the definition.
 */
const ADAPTER_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:register|\.on|hook)\(\s*"([A-Za-z][A-Za-z0-9]*)"/g,
  /\bctx\.([A-Z][A-Za-z0-9]*)/g,
  /\bscope:\s*"([a-z][A-Za-z0-9]*)"/g,
]

export const adaptedSeamsIn = (file: string, text: string): ReadonlySet<string> => {
  if (!isAdapterSource(file)) return new Set()
  const names = new Set<string>()
  for (const pattern of ADAPTER_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      Option.match(Option.fromNullishOr(match[1]), {
        onNone: () => {},
        onSome: (name) => {
          names.add(name)
        },
      })
    }
  }
  return names
}

/**
 * The service facets of `ExtensionContextService`.
 *
 * The interface mixes plain facts (`extensionId`, `cwd`) with the facades an
 * extension actually reaches through, and only the facades are seams. The
 * capitalized name is the distinction the codebase already draws, so it is
 * the one used here rather than a hand-kept list that would drift.
 */
const declaredFacets = (text: string): ReadonlyArray<string> =>
  declaredMembers(text, /export interface ExtensionContextService/).filter((name) =>
    /^[A-Z]/.test(name),
  )

/**
 * The members of the `ResourceScope` union.
 *
 * A string union, not an interface, so this reads the literals rather than
 * `readonly` members.
 *
 * Extensions carry an unrelated load scope on the same field name
 * (`scope: "builtin"`), so a `ResourceScope` sharing one of those names would
 * be credited by a load-scope site and never reported. Those names are
 * excluded rather than left to chance -- a seam this guard cannot actually
 * measure must not read as filled.
 */
const EXTENSION_LOAD_SCOPES: ReadonlySet<string> = new Set(["builtin", "user", "project"])

const declaredResourceScopes = (text: string): ReadonlyArray<string> => {
  const match = Option.fromNullishOr(/export type ResourceScope =([^\n]*)/.exec(text))
  if (Option.isNone(match)) return []
  const body = Option.getOrElse(Option.fromNullishOr(match.value[1]), () => "")
  return [...body.matchAll(/"([a-z][A-Za-z0-9]*)"/g)].flatMap((literal) =>
    Option.match(Option.fromNullishOr(literal[1]), {
      onNone: (): ReadonlyArray<string> => [],
      onSome: (name): ReadonlyArray<string> => {
        if (EXTENSION_LOAD_SCOPES.has(name)) return []
        return [name]
      },
    }),
  )
}

export const findUnadaptedSeams = (
  sources: ReadonlyMap<string, string>,
  adapted: ReadonlySet<string>,
): ReadonlyArray<UnadaptedSeamFinding> => {
  const findings: UnadaptedSeamFinding[] = []

  const report = (
    file: string,
    text: string,
    seams: ReadonlyArray<string>,
    kindLabel: string,
    lineFor: (seam: string) => number,
  ): void => {
    for (const seam of seams) {
      if (adapted.has(seam)) continue
      findings.push({
        file,
        line: lineFor(seam),
        message: `${kindLabel} "${seam}" has no shipped adapter; a seam nothing implements is dead surface. Ship an adapter or remove the seam.`,
      })
    }
  }

  const inFile = (file: string, use: (text: string) => void): void => {
    const text = Option.fromNullishOr(sources.get(file))
    if (Option.isNone(text)) return
    use(text.value)
  }

  const check = (file: string, blockPattern: RegExp, kindLabel: string): void => {
    inFile(file, (text) => {
      report(file, text, declaredMembers(text, blockPattern), kindLabel, (seam) =>
        lineOf(text, seam),
      )
    })
  }

  check(SEAM_DECLARATION_FILE, /interface RegistrationDomainMap/, "registration domain")
  check(SEAM_DECLARATION_FILE, /interface ExtensionHookSignatures/, "hook kind")
  inFile(SEAM_DECLARATION_FILE, (text) => {
    report(SEAM_DECLARATION_FILE, text, declaredFacets(text), "extension context facet", (seam) =>
      lineOf(text, seam),
    )
  })
  inFile(SEAM_DECLARATION_FILE, (text) => {
    const declarationLine =
      text.split("\n").findIndex((line) => line.includes("export type ResourceScope =")) + 1
    report(
      SEAM_DECLARATION_FILE,
      text,
      declaredResourceScopes(text),
      "resource scope",
      () => declarationLine,
    )
  })
  return findings
}
