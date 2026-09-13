/**
 * Guard: core must not export names nothing consumes.
 *
 * The interface is everything a caller must know, so an export with no caller
 * is not free -- it is vocabulary a reader has to account for and an author
 * has to keep working. Core is the loop and the extension API; anything it
 * exposes should be something outside the module actually reaches for.
 *
 * This runs over `packages/core/src` only, and only for names declared with
 * `export const|class|function|interface|type|enum`. Re-export lines
 * (`export { X } from "..."`) are the public entry points' business and are
 * checked by `core-public-exports` instead.
 *
 * @module
 */

import { Option } from "effect"

/** A core export no file outside its own module names. */
export interface DeadExportFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

const CORE_SRC_PREFIX = "packages/core/src/"

/**
 * Files whose exports are consumed by name from outside the repo's own
 * source: the public entry points, and the test/debug helpers that exist to
 * be imported by test files.
 */
const EXEMPT_PREFIXES: ReadonlyArray<string> = [
  "packages/core/src/extensions/",
  "packages/core/src/protocol.ts",
  "packages/core/src/test-utils/",
]

const DECLARATION =
  /^export\s+(?:declare\s+)?(?:const|class|function|interface|type|enum)\s+([A-Za-z_$][\w$]*)/

/** Collect `(name, line)` for every declared export in one core source file. */
export const declaredCoreExports = (
  file: string,
  text: string,
): ReadonlyArray<{ readonly name: string; readonly line: number }> => {
  if (!file.startsWith(CORE_SRC_PREFIX)) return []
  if (EXEMPT_PREFIXES.some((prefix) => file.startsWith(prefix))) return []

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

interface CoreDeclaration {
  readonly file: string
  readonly name: string
  readonly line: number
}

/**
 * Report declared core exports that no other file names.
 *
 * `identifiersByFile` is the whole tree's word sets, so this is one pass over
 * declarations rather than a search per name. A name is live once some file
 * that does not itself declare it mentions the name.
 */
export const findCoreDeadExports = (
  declarations: ReadonlyArray<CoreDeclaration>,
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
    .map(({ file, name, line }) => ({
      file,
      line,
      message: `\`${name}\` is exported but no file outside ${file} names it; drop the \`export\` keyword, or delete it if nothing uses it at all`,
    }))
}
