/**
 * Guard: every name on the public extension API must have a consumer.
 *
 * `extensions/api.ts` is the whole vocabulary an extension author has to
 * learn. A name on it that nothing outside core reaches for is not optional
 * detail they can skip -- it is surface they must read past to find what they
 * actually need, and surface every refactor has to carry.
 *
 * `dead-exports` deliberately exempts this directory: re-export lines
 * (`export { X } from "..."`) are an entry point's business, not a module's.
 * That exemption is what let ten unused names accumulate here, so this guard
 * covers exactly the case that one skips.
 *
 * A name is consumed when any shipped package, app, example, or test outside
 * `packages/core/src` names it. Tests count here, unlike in the seam guard:
 * core's own surface-lock suites assert the shape of this API through the
 * public path, which is a real consumer of the export rather than a
 * registrant proving a mechanism runs.
 *
 * Consumption is read from the import itself, not from the name appearing
 * somewhere in the file. A symbol a core test imports over a relative path
 * does not count -- nothing reaches it through `extensions/api`, which is the
 * only question this guard asks. Three import shapes reach this module today
 * and all three are read: named imports (with `as` aliases), namespace
 * imports, and re-exports.
 *
 * Names on a `@ts-expect-error` line never count. The surface-lock suites
 * reach for `PublicExtensionApi.action` and friends precisely to assert they
 * are *absent*; reading those as consumption would pin removed surface in
 * place forever.
 *
 * @module
 */

import { Option } from "effect"

/** A public API name nothing outside core reaches for. */
export interface UnconsumedPublicApiFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

const PUBLIC_API_FILE = "packages/core/src/extensions/api.ts"

/** Files that may consume the public API: anything outside core's own source. */
const isConsumerSource = (file: string): boolean =>
  !file.startsWith("packages/core/src/") && !file.startsWith("packages/core-internal/")

/**
 * The names one `export { ... } from "..."` block exposes, with the line each
 * sits on. Handles `type X`, `X as Y` (the exposed name is `Y`), and blocks
 * broken across lines -- all three shapes appear in this file today.
 */
export const publicApiNames = (
  text: string,
): ReadonlyArray<{
  readonly name: string
  readonly line: number
}> => {
  const found: Array<{ name: string; line: number }> = []
  const lines = text.split("\n")
  let inBlock = false
  for (const [index, line] of lines.entries()) {
    if (!inBlock && /^export\s+(?:type\s+)?\{/.test(line)) inBlock = true
    else if (!inBlock) continue
    for (const match of line.matchAll(/(?:^|[{,])\s*(?:type\s+)?([A-Za-z_][A-Za-z0-9_]*)/g)) {
      Option.match(Option.fromNullishOr(match[1]), {
        onNone: () => {},
        onSome: (name) => {
          if (name !== "export" && name !== "type" && name !== "from") {
            found.push({ name, line: index + 1 })
          }
        },
      })
    }
    if (line.includes("}")) inBlock = false
  }
  return found
}

const API_SPECIFIER = /["']@gent\/core\/extensions\/api(?:\.js)?["']/

/** Lines carrying a `@ts-expect-error`, which assert absence rather than use. */
const expectErrorLines = (lines: ReadonlyArray<string>): ReadonlySet<number> => {
  const marked = new Set<number>()
  for (const [index, line] of lines.entries()) {
    if (!line.includes("@ts-expect-error")) continue
    // The directive sits on its own line, above the line it excuses.
    marked.add(index + 1)
    marked.add(index + 2)
  }
  return marked
}

/**
 * The statement a specifier belongs to, joined back into one string.
 *
 * An import block is routinely broken across lines, so the specifier and the
 * names it brings in are rarely on the same line. Walking back to the opening
 * `import`/`export` keeps them together.
 */
const statementEndingAt = (lines: ReadonlyArray<string>, end: number): string => {
  let start = end
  while (start > 0 && !/^\s*(?:import|export)\b/.test(lines[start] ?? "")) start--
  return lines.slice(start, end + 1).join("\n")
}

/** The one name a `{ ... }` import entry brings in, before any `as` alias. */
const importedName = (entry: string): Option.Option<string> => {
  const cleaned = entry.replace(/\btype\b/g, "").trim()
  if (cleaned.length === 0) return Option.none()
  return Option.flatMap(Option.fromNullishOr(/^([A-Za-z_][A-Za-z0-9_]*)/.exec(cleaned)), (found) =>
    Option.fromNullishOr(found[1]),
  )
}

/** Names one `import { ... } from "<api>"` statement brings in. */
const namedImportsIn = (statement: string): ReadonlyArray<string> => {
  const braces = Option.fromNullishOr(/\{([^}]*)\}/s.exec(statement))
  if (Option.isNone(braces)) return []
  const body = Option.getOrElse(Option.fromNullishOr(braces.value[1]), () => "")
  return body.split(",").flatMap((entry) =>
    Option.match(importedName(entry), {
      onNone: (): ReadonlyArray<string> => [],
      onSome: (name) => [name],
    }),
  )
}

/** Aliases bound by `import * as X from "<api>"`. */
const namespaceAliasesIn = (statement: string): ReadonlyArray<string> =>
  [...statement.matchAll(/\*\s+as\s+([A-Za-z_][A-Za-z0-9_]*)/g)].flatMap((match) =>
    Option.match(Option.fromNullishOr(match[1]), {
      onNone: (): ReadonlyArray<string> => [],
      onSome: (alias) => [alias],
    }),
  )

/** Members read off a namespace alias, skipping lines that assert absence. */
const namespaceMembersIn = (
  lines: ReadonlyArray<string>,
  alias: string,
  skip: ReadonlySet<number>,
): ReadonlyArray<string> => {
  const member = new RegExp(`\\b${alias}\\.([A-Za-z_][A-Za-z0-9_]*)`, "g")
  const found: Array<string> = []
  for (const [index, line] of lines.entries()) {
    if (skip.has(index + 1)) continue
    for (const match of line.matchAll(member)) {
      Option.match(Option.fromNullishOr(match[1]), {
        onNone: () => {},
        onSome: (name) => {
          found.push(name)
        },
      })
    }
  }
  return found
}

/**
 * Names this file reaches for through `@gent/core/extensions/api`.
 *
 * A named import credits the *original* name, not the local alias: `X as Y`
 * means the public API still has to export `X`. A namespace import credits
 * every member the file reads off it.
 */
export const consumedNamesIn = (file: string, text: string): ReadonlySet<string> => {
  if (!isConsumerSource(file)) return new Set()
  const lines = text.split("\n")
  const skip = expectErrorLines(lines)
  const names = new Set<string>()
  const aliases = new Set<string>()

  for (const [index, line] of lines.entries()) {
    if (!API_SPECIFIER.test(line)) continue
    const statement = statementEndingAt(lines, index)
    for (const alias of namespaceAliasesIn(statement)) aliases.add(alias)
    for (const name of namedImportsIn(statement)) names.add(name)
  }

  for (const alias of aliases) {
    for (const name of namespaceMembersIn(lines, alias, skip)) names.add(name)
  }

  return names
}

export const findUnconsumedPublicApi = (
  sources: ReadonlyMap<string, string>,
  consumed: ReadonlySet<string>,
): ReadonlyArray<UnconsumedPublicApiFinding> => {
  const text = Option.fromNullishOr(sources.get(PUBLIC_API_FILE))
  if (Option.isNone(text)) return []
  const findings: UnconsumedPublicApiFinding[] = []
  const reported = new Set<string>()
  for (const entry of publicApiNames(text.value)) {
    if (consumed.has(entry.name)) continue
    if (reported.has(entry.name)) continue
    reported.add(entry.name)
    findings.push({
      file: PUBLIC_API_FILE,
      line: entry.line,
      message: `public extension API name "${entry.name}" has no consumer outside core; it is vocabulary every extension author reads past. Drop it from the public API, or ship something that uses it.`,
    })
  }
  return findings
}
