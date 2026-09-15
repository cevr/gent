/**
 * Guard: an alternative layer static must be a real alternative implementation.
 *
 * CLAUDE.md: "add a `Test` layer only when there is a real alternative
 * implementation worth a Tag." An alternative that returns `Live` is the same
 * layer under a second name -- it adds a seam with nothing behind it, and a
 * reader has to open the file to learn that the two are identical.
 *
 * The check reads the member's initializer rather than matching one line. Two
 * things follow from that. The alias may be spelled across as many lines as
 * the formatter likes, and the member name is a table (`ALTERNATIVE_NAMES`)
 * instead of a literal baked into a pattern -- a `Fake` or a `Stub` that
 * aliases `Live` is the same hole as a `Test` that does.
 *
 * Only an outright alias is reported. `ExtensionRegistry.Test` is the
 * near-miss the body reading has to get right: its initializer is a single
 * delegating call, `ExtensionRegistry.fromResolved(resolveExtensions([]))`,
 * which is a real alternative because the sibling it reaches for is not
 * `Live`.
 *
 * @module
 */

import { Option } from "effect"

/** An alternative layer static that is an alias of the same service's `Live`. */
export interface AliasTestLayerFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

const SRC_PREFIX = "packages/"

/**
 * Member names that claim to be an alternative implementation.
 *
 * `Live` is absent on purpose: it is the implementation, not an alternative
 * to it. A name added here starts being held to the same rule.
 */
const ALTERNATIVE_NAMES: ReadonlyArray<string> = ["Test", "Fake", "Stub", "Mock"]

const MEMBER_PATTERN = new RegExp(
  `^\\s*static\\s+(${ALTERNATIVE_NAMES.join("|")})\\s*(?::[^=]*)?=\\s*(.*)$`,
)

/** An alias body: nothing but an optional arrow head, then `<Service>.Live`. */
const ALIAS_BODY = /^(?:\([^)]*\)(?::[^=]*)?=>)?\s*([A-Za-z_$][\w$]*)\.Live$/

/**
 * The member's initializer, from the `=` to the end of the declaration.
 *
 * A brace-, paren-, and bracket-depth walk rather than a line pattern: the
 * whole point is to see an initializer the formatter has broken across lines.
 * The declaration ends at the first depth-zero boundary -- the closing brace
 * of the enclosing class, or the next member -- so a multi-line
 * `Layer.succeed(...)` is read whole and never mistaken for an alias.
 */
const initializerFrom = (lines: ReadonlyArray<string>, start: number, head: string): string => {
  const collected: Array<string> = []
  let depth = 0
  let text = head
  let index = start
  for (;;) {
    for (const ch of text) {
      if (ch === "(" || ch === "{" || ch === "[") depth++
      if (ch === ")" || ch === "}" || ch === "]") depth--
      if (depth < 0) return collected.join(" ")
    }
    collected.push(text)
    index++
    const next = Option.fromNullishOr(lines[index])
    if (Option.isNone(next)) return collected.join(" ")
    if (depth === 0 && MEMBER_PATTERN.test(next.value)) return collected.join(" ")
    text = next.value
  }
}

/**
 * The initializer with comments blanked and whitespace flattened.
 *
 * A doc comment inside the initializer would otherwise defeat the alias test,
 * and a trailing semicolon or comma is punctuation, not body.
 */
const normalized = (initializer: string): string =>
  initializer
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[;,]+$/, "")

/** Report alternative layer statics whose whole body returns `Live`. */
export const findAliasTestLayers = (
  file: string,
  text: string,
): ReadonlyArray<AliasTestLayerFinding> => {
  if (!file.startsWith(SRC_PREFIX)) return []
  if (!/\/src\//.test(file)) return []

  const findings: AliasTestLayerFinding[] = []
  const lines = text.split("\n")
  for (const [index, line] of lines.entries()) {
    const member = Option.fromNullishOr(MEMBER_PATTERN.exec(line))
    if (Option.isNone(member)) continue
    const name = Option.getOrElse(Option.fromNullishOr(member.value[1]), () => "")
    const head = Option.getOrElse(Option.fromNullishOr(member.value[2]), () => "")
    const alias = Option.fromNullishOr(
      ALIAS_BODY.exec(normalized(initializerFrom(lines, index, head))),
    )
    if (Option.isNone(alias)) continue
    const service = Option.getOrElse(Option.fromNullishOr(alias.value[1]), () => "")
    findings.push({
      file,
      line: index + 1,
      message: `\`static ${name}\` returns \`${service}.Live\` unchanged; an alternative layer earns a Tag only when it is a real alternative implementation -- delete it and let callers use \`Live\``,
    })
  }
  return findings
}
