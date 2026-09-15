/**
 * Guard: a scanned package must not export names nothing consumes.
 *
 * The interface is everything a caller must know, so an export with no caller
 * is not free -- it is vocabulary a reader has to account for and an author
 * has to keep working. Core is the loop and the extension API; the SDK is the
 * client contract every composition root reaches through. Anything either
 * exposes should be something outside the declaring module actually reaches
 * for.
 *
 * Two packages are scanned today, and only for names declared with
 * `export const|class|function|interface|type|enum`. Re-export lines
 * (`export { X } from "..."`) are the public entry points' business and are
 * checked by `core-public-exports` and `core-public-api-consumers` instead.
 *
 * `packages/extensions/src` is deliberately not scanned. Its modules declare
 * a tool's parameter and result schemas beside the tool that reads them, and
 * `Schema.Class` declares a value and a type under one name, so this finder
 * reports well over a hundred names that are neither dead nor removable. A
 * scan of that package needs a different rule, not this one.
 *
 * @module
 */

import { Option } from "effect"

/** An export no file outside its own module names. */
export interface DeadExportFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

/** A package this guard scans, and the directories inside it it skips. */
interface ScannedPackage {
  readonly prefix: string
  readonly exempt: ReadonlyArray<string>
}

/**
 * The scanned packages.
 *
 * Exempt directories hold exports consumed by name from outside the repo's
 * own source: the public entry points, and the test/debug helpers that exist
 * to be imported by test files.
 */
const SCANNED_PACKAGES: ReadonlyArray<ScannedPackage> = [
  {
    prefix: "packages/core/src/",
    exempt: [
      "packages/core/src/extensions/",
      "packages/core/src/protocol.ts",
      "packages/core/src/test-utils/",
    ],
  },
  { prefix: "packages/sdk/src/", exempt: [] },
]

/**
 * Exports kept alive on purpose, each with the reason.
 *
 * An entry here is a claim that the name earns its keep despite having no
 * caller. Prefer deleting the export.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map()

const DECLARATION =
  /^export\s+(?:declare\s+)?(?:const|class|function|interface|type|enum)\s+([A-Za-z_$][\w$]*)/

/** Collect `(name, line)` for every declared export in one scanned source file. */
export const declaredExports = (
  file: string,
  text: string,
): ReadonlyArray<{ readonly name: string; readonly line: number }> => {
  const scanned = Option.fromNullishOr(
    SCANNED_PACKAGES.find((entry) => file.startsWith(entry.prefix)),
  )
  if (Option.isNone(scanned)) return []
  if (scanned.value.exempt.some((prefix) => file.startsWith(prefix))) return []

  const found: Array<{ name: string; line: number }> = []
  for (const [index, line] of text.split("\n").entries()) {
    const match = Option.fromNullishOr(DECLARATION.exec(line))
    if (Option.isNone(match)) continue
    const name = Option.fromNullishOr(match.value[1])
    if (Option.isNone(name)) continue
    found.push({ name: name.value, line: index + 1 })
  }
  return found
}

/** Every identifier-shaped word in a file, for a cheap "is this name mentioned" test. */
export const identifiersIn = (text: string): ReadonlySet<string> =>
  new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? [])

interface Declaration {
  readonly file: string
  readonly name: string
  readonly line: number
}

/**
 * Report declared exports that no other file names.
 *
 * `identifiersByFile` is the whole tree's word sets, so this is one pass over
 * declarations rather than a search per name. A name is live once some file
 * that does not itself declare it mentions the name.
 */
export const findDeadExports = (
  declarations: ReadonlyArray<Declaration>,
  identifiersByFile: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyArray<DeadExportFinding> => {
  const declaringFiles = new Map<string, ReadonlySet<string>>()
  for (const { file, name } of declarations) {
    declaringFiles.set(name, new Set([...(declaringFiles.get(name) ?? []), file]))
  }

  const isNamedElsewhere = (name: string): boolean => {
    const declaredIn = declaringFiles.get(name) ?? new Set<string>()
    for (const [file, identifiers] of identifiersByFile) {
      if (declaredIn.has(file)) continue
      if (identifiers.has(name)) return true
    }
    return false
  }

  return declarations
    .filter(({ name }) => !isNamedElsewhere(name))
    .filter(({ name }) => !ALLOWLIST.has(name))
    .map(({ file, name, line }) => ({
      file,
      line,
      message: `\`${name}\` is exported but no file outside ${file} names it; drop the \`export\` keyword, or delete it if nothing uses it at all`,
    }))
}
