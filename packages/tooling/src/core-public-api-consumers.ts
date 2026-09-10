/**
 * Guard: every name on the public extension API must have a consumer.
 *
 * `extensions/api.ts` is the whole vocabulary an extension author has to
 * learn. A name on it that nothing outside core reaches for is not optional
 * detail they can skip -- it is surface they must read past to find what they
 * actually need, and surface every refactor has to carry.
 *
 * `core-dead-exports` deliberately exempts this directory: re-export lines
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
 * Known limit: matching is by name, so a symbol a core test imports over a
 * relative path reads as consumed even though nothing reaches it through
 * `extensions/api`. That makes this a ratchet against new dead names rather
 * than a proof the current surface is minimal -- it catches a name nothing
 * anywhere reaches for, which is the case that actually accumulates. Tracing
 * real import paths would catch the rest and is the upgrade if this proves
 * too loose.
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

/** Names a consumer file mentions. Word-bounded, so a substring never counts. */
export const consumedNamesIn = (file: string, text: string): ReadonlySet<string> => {
  if (!isConsumerSource(file)) return new Set()
  return new Set(
    [...text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)].flatMap((match) =>
      Option.match(Option.fromNullishOr(match[1]), {
        onNone: (): ReadonlyArray<string> => [],
        onSome: (name) => [name],
      }),
    ),
  )
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
