import { Option, Schema } from "effect"
// A write or a caller in test support proves a reader works, not that
// production supplies it; the lint rules read the same definitions.
import { isShippedSource, isTestCode, isTestHarness, isTestSupport } from "./gent-rules"

/** What every guard reports: a place in a file, and what is wrong there. */
export interface Finding {
  readonly file: string
  readonly line: number
  readonly message: string
}

/** This file: the guards name what they look for, so several scans skip it. */
const GUARDS_FILE = "packages/tooling/src/guards.ts"

const blankKeepingLines = (text: string): string => text.replace(/[^\n]/g, " ")

/**
 * A scanner frame: `IN_TEMPLATE` inside a template's text, otherwise the count
 * of braces open in that stretch of code (an interpolation closes at 0).
 */
const IN_TEMPLATE = -1

/** The end of a quoted string that starts at `start`: its closing quote, or the line end. */
const quotedEnd = (text: string, start: number): number => {
  const quote = text[start]
  let at = start + 1
  while (at < text.length && text[at] !== quote && text[at] !== "\n") {
    at += 1 + Number(text[at] === "\\")
  }
  return Math.min(at + 1, text.length)
}

/** The end of the comment that opens at `start` with `opener` (`//` or `/*`). */
const commentEnd = (text: string, start: number, opener: string): number => {
  if (opener === "//") {
    const newline = text.indexOf("\n", start)
    if (newline === -1) return text.length
    return newline
  }
  const close = text.indexOf("*/", start + 2)
  if (close === -1) return text.length
  return close + 2
}

/** One step inside a template's text: the characters it copies, and the frame change. */
const templateStep = (text: string, at: number, frames: Array<number>): string => {
  const pair = text.slice(at, at + 2)
  if (pair === "${") {
    frames.push(0)
    return pair
  }
  if (text[at] === "\\") return pair
  if (text[at] === "`") frames.pop()
  return text[at] ?? ""
}

/** A brace or backtick in code: open or close a frame. */
const trackCodeFrame = (char: string, frames: Array<number>): void => {
  const top = frames.length - 1
  const depth = frames[top] ?? 0
  if (char === "`") frames.push(IN_TEMPLATE)
  if (char === "{") frames[top] = depth + 1
  if (char !== "}") return
  if (depth === 0 && top > 0) frames.pop()
  else frames[top] = Math.max(depth - 1, 0)
}

/**
 * Blank the comments in `text`, line count preserved, read left to right so a
 * `//` inside a string stays a string. Template literals are followed into
 * their `${}` interpolations, so a comment there is blanked too. With
 * `blankStrings`, each quoted string becomes `""`; a template's own text is
 * kept, because an interpolation inside it reads code.
 */
const blankComments = (text: string, blankStrings: boolean): string => {
  const out: Array<string> = []
  const frames: Array<number> = [0]
  let at = 0
  while (at < text.length) {
    const char = text[at] ?? ""
    const pair = text.slice(at, at + 2)
    let chunk = char
    let end = at + 1
    if (frames[frames.length - 1] === IN_TEMPLATE) {
      chunk = templateStep(text, at, frames)
      end = at + chunk.length
    } else if (pair === "//" || pair === "/*") {
      end = commentEnd(text, at, pair)
      chunk = blankKeepingLines(text.slice(at, end))
    } else if (char === '"' || char === "'") {
      end = quotedEnd(text, at)
      chunk = text.slice(at, end)
      if (blankStrings) chunk = '""'
    } else {
      trackCodeFrame(char, frames)
    }
    out.push(chunk)
    at = end
  }
  return out.join("")
}

/** The text with comments blanked, line count preserved. */
const withoutComments = (text: string): string => blankComments(text, false)

// ── a lint directive names its rules ────────────────────────────────────────

/**
 * oxlint honors both spellings, `eslint-disable` and `oxlint-disable`, so each
 * pattern matches both. A blanket directive names no rule; a file-wide
 * directive, written as a block or a line comment, disables its rules to the
 * end of the file or the next enable.
 */
const blanketDisableDirective =
  /(?:\/\*\s*(?:es|ox)lint-disable(?:-next-line|-line)?\s*(?:\*\/|--|$))|(?:\/\/\s*(?:es|ox)lint-disable(?:-next-line|-line)?\s*(?:--|$))/

const blockDisableDirective = /(?:\/\*|\/\/)\s*(?:es|ox)lint-disable(?:\s|$)/

/** A file inside a fixture directory; a basename such as `fixture-runner.ts` is not one. */
const fixtureFilePattern = /(?:^|\/)(?:fixtures?|__fixtures__)\//

const isExplicitFixtureFile = (file: string): boolean => fixtureFilePattern.test(file)

const DISABLE_MESSAGE =
  "blanket and file-wide lint-disable comments (eslint- or oxlint- spelling) are banned; use line-local suppressions with exact rules"

/** Every line of `text` a directive pattern matches. */
const directiveLines = (file: string, text: string, directive: RegExp): ReadonlyArray<Finding> =>
  text.split("\n").flatMap((line, index) => {
    if (!directive.test(line)) return []
    return [{ file, line: index + 1, message: DISABLE_MESSAGE }]
  })

export const findBlanketEslintDisables = (file: string, text: string): ReadonlyArray<Finding> =>
  directiveLines(file, text, blanketDisableDirective)

export const findBannedEslintDisableBlocks = (
  file: string,
  text: string,
): ReadonlyArray<Finding> => {
  if (isExplicitFixtureFile(file)) return []
  return directiveLines(file, text, blockDisableDirective)
}

// ── an alternative layer is a real alternative ──────────────────────────────

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
 * Scope is every shipped source tree, `packages/` and `apps/` alike.
 *
 * @module
 */

// The scope is `isShippedSource`. The rule this guard enforces is a project
// rule, not a core rule: a service in the TUI earns a `Test` layer on the same
// terms as a service in core. The two guards that do pin `packages/core/src/`
// -- feature independence, vendor model pins -- are scoped that way because
// what they forbid is core reaching outward; nothing about an alias is
// core-specific.

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
export const findAliasTestLayers = (file: string, text: string): ReadonlyArray<Finding> => {
  if (!isShippedSource(file)) return []

  const findings: Finding[] = []
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

// ── core names no feature built on it ───────────────────────────────────────

/**
 * Guard: core must not name the features built on top of it.
 *
 * Core is the loop. A feature such as the code cell is an extension of the
 * loop (`packages/extensions/src/cell.ts`), so core carries it through
 * agnostic seams and never imports it. The import side is the
 * `gent/declared-workspace-imports` lint rule: core declares no
 * `@gent/extensions` dependency, and no relative path leaves a workspace. The
 * module side is a `RETIRED_SURFACES` path row: no file or directory under
 * `packages/core/src/` names the cell.
 *
 * This guard holds the rule for a feature's data: a feature's tables and a
 * catalog host belong to the extension that owns them, so core must not name
 * one.
 *
 * @module
 */

/**
 * SQL table-name prefixes owned by a feature.
 *
 * Core's migration chain builds the kernel's tables. A feature contributes the
 * migrations for its own tables at the same seam it contributes its
 * repositories, so a core source file naming one of these is core reaching
 * back into a feature it should not know about.
 */
const FEATURE_TABLE_PREFIXES: ReadonlyArray<string> = ["cell_"]

/**
 * Network hosts owned by a catalog feature, not by the kernel.
 *
 * Core resolves a model through the driver seam. The catalog behind a driver
 * -- where its model list comes from, how it is cached, when it refreshes --
 * belongs to the driver's extension. A core source file that names one of
 * these hosts is core fetching a feature's data itself.
 */
const FEATURE_HOSTS: ReadonlyArray<string> = ["models.dev"]

const CORE_SRC_PREFIX = "packages/core/src/"

/** A feature-owned table named as a SQL identifier, not merely as a substring. */
const TABLE_PATTERN = (prefix: string) => new RegExp(`\\b${prefix}[a-z_]+\\b`)

/** Find every line in a core file that names a feature's table or catalog host. */
export const findCoreFeatureIndependenceFindings = (
  file: string,
  text: string,
): ReadonlyArray<Finding> => {
  if (!file.startsWith(CORE_SRC_PREFIX)) return []

  const findings: Array<Finding> = []
  for (const [index, line] of text.split("\n").entries()) {
    const table = Option.fromNullishOr(
      FEATURE_TABLE_PREFIXES.find((prefix) => TABLE_PATTERN(prefix).test(line)),
    )
    if (Option.isNone(table)) continue
    findings.push({
      file,
      line: index + 1,
      message: `core must not name a "${table.value}" table; the feature that owns it contributes its own migrations through the storage assembler's feature-migrations seam`,
    })
  }

  for (const [index, line] of text.split("\n").entries()) {
    const host = Option.fromNullishOr(FEATURE_HOSTS.find((candidate) => line.includes(candidate)))
    if (Option.isNone(host)) continue
    findings.push({
      file,
      line: index + 1,
      message: `core must not name the catalog host "${host.value}"; the driver that owns that catalog fetches and caches it in its own extension, and core only concatenates every driver's listModels`,
    })
  }
  return findings
}

// ── a whole-object encode decides no identity ───────────────────────────────

/**
 * Guard: a whole-object JSON encode must not decide identity.
 *
 * `JSON.stringify` carries key order, so two spellings of the same value
 * encode to different strings. Native history compared transcript items that
 * way and the feed built one message two ways — `_tag` first from the
 * streaming placeholder, `_tag` last from the rebuild. A rebuilt message read
 * as a different message, the committed prefix broke, and the replay cleared
 * the terminal's saved lines. The fix names the compared fields in a fixed
 * order instead; this guard keeps the next comparison from regressing to an
 * encode of the object.
 *
 * What is reported: a value encoded by `Schema.encodeSync(Schema.fromJsonString(...))`
 * whose result is then compared with `===`, `!==`, `.has(`, `.get(`, or `.add(`
 * on the same line, or stored under a name that says it is an identity. Encoding for
 * a log line, a file, or a display string is untouched — those do not compare.
 *
 * @module
 */

/**
 * Name segments that say the encoded value answers "is this the same thing?".
 * A name is split at camelCase and `_` boundaries, so `messageIdentity`,
 * `dedupeKey` and `cache_key` all count.
 */
const IDENTITY_WORDS: ReadonlySet<string> = new Set([
  "fingerprint",
  "identity",
  "signature",
  "dedupe",
  "dedup",
  "key",
])

/** Whether a name on the line, other than the encoder's own, says identity. */
const namesIdentity = (line: string, encoder: string): boolean =>
  Option.getOrElse(Option.fromNullishOr(line.match(/[A-Za-z_$][\w$]*/g)), () => []).some(
    (name) =>
      name !== encoder &&
      name.split(/(?=[A-Z])|_/).some((segment) => IDENTITY_WORDS.has(segment.toLowerCase())),
  )

/** A `…Fingerprint(...)` projection, which returns its fields in a fixed order. */
const FINGERPRINT_CALL = /^[a-z][\w$]*Fingerprint\([^()]*\)$/

/** One element of a fixed-order projection: a field access, a primitive, or a fingerprint call. */
const PROJECTION_ELEMENT =
  /^(?:[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+|"[^"]*"|'[^']*'|-?\d+(?:\.\d+)?|true|false|null|undefined)$/

const OPENERS = "([{"
const CLOSERS = ")]}"

/**
 * `text` cut at each top-level `separator`, with brackets and quotes respected.
 * A top-level closer ends the scan: it matches an opener before `text`, and
 * `closedAt` holds its index. An unclosed scan keeps the rest as the last part.
 */
interface TopLevelSplit {
  readonly parts: ReadonlyArray<string>
  readonly closedAt: Option.Option<number>
}

const splitTopLevel = (text: string, separator: string): TopLevelSplit => {
  const parts: string[] = []
  let depth = 0
  let quote = Option.none<string>()
  let start = 0
  for (const [index, char] of text.split("").entries()) {
    if (Option.isSome(quote)) {
      if (char === quote.value) quote = Option.none()
      continue
    }
    if (char === '"' || char === "'" || char === "`") quote = Option.some(char)
    else if (OPENERS.includes(char)) depth += 1
    else if (CLOSERS.includes(char)) {
      if (depth === 0) {
        parts.push(text.slice(start, index))
        return { parts, closedAt: Option.some(index) }
      }
      depth -= 1
    } else if (char === separator && depth === 0) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return { parts, closedAt: Option.none() }
}

/**
 * Whether an encoder argument already names its fields in a fixed order: a
 * fingerprint call, or an array literal of field accesses, primitives, and
 * fingerprint calls. That is the fix this guard asks for, so it is not
 * reported. `[item]` still carries a whole object and is reported.
 */
const isFixedOrderArgument = (argument: string): boolean => {
  const trimmed = argument.trim()
  if (FINGERPRINT_CALL.test(trimmed)) return true
  if (!trimmed.startsWith("[")) return false
  const inner = splitTopLevel(trimmed.slice(1), ",")
  if (Option.isNone(inner.closedAt) || inner.closedAt.value !== trimmed.length - 2) return false
  const elements = inner.parts.map((part) => part.trim())
  if (elements.at(-1) === "") elements.pop()
  return (
    elements.length > 0 &&
    elements.every((element) => PROJECTION_ELEMENT.test(element) || FINGERPRINT_CALL.test(element))
  )
}

/** The argument text of the call whose `(` ends just before `from`; unclosed calls return the rest. */
const callArgument = (line: string, from: number): string =>
  splitTopLevel(line.slice(from), ",").parts.join(",")

/** A binding whose initializer is a whole-object JSON encoder. */
const ENCODER_BINDING =
  /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*Schema\.encodeSync\(\s*Schema\.fromJsonString\(/

/** The encoded value being compared, right where it is produced. */
const COMPARED = /(?:===|!==|\.has\(|\.get\(|\.add\()/

export const findIdentityEncodes = (file: string, text: string): ReadonlyArray<Finding> => {
  if (!isShippedSource(file)) return []
  const lines = text.split("\n")
  const encoders: string[] = []
  for (const line of lines) {
    const binding = Option.fromNullishOr(ENCODER_BINDING.exec(line))
    if (Option.isNone(binding)) continue
    const name = Option.getOrElse(Option.fromNullishOr(binding.value[1]), () => "")
    if (name.length > 0) encoders.push(name)
  }
  if (encoders.length === 0) return []

  const findings: Finding[] = []
  const callPattern = new RegExp(`\\b(${encoders.join("|")})\\(`, "g")
  for (const [index, line] of lines.entries()) {
    // The binding itself is a declaration, not a use.
    if (ENCODER_BINDING.test(line)) continue
    // Each call is judged alone: a safe encode on the line does not excuse another.
    const unsafe = Option.fromNullishOr(
      [...line.matchAll(callPattern)].find(
        (call) => !isFixedOrderArgument(callArgument(line, call.index + call[0].length)),
      ),
    )
    if (Option.isNone(unsafe)) continue
    const name = Option.getOrElse(Option.fromNullishOr(unsafe.value[1]), () => "")
    if (!COMPARED.test(line) && !namesIdentity(line, name)) continue
    findings.push({
      file,
      line: index + 1,
      message: `\`${name}\` encodes a whole object and the result decides identity on this line; JSON carries key order, so two spellings of one value compare unequal -- name the compared fields in a fixed order instead`,
    })
  }
  return findings
}

// ── every core seam has a shipped adapter ───────────────────────────────────

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

/** Every seam family core declares now lives in one file; each scan is anchored on its own interface name. */
const SEAM_DECLARATION_FILE = "packages/core/src/domain/extension.ts"

/** Files that may fill a seam: shipped extensions and the apps, never test support. */
const isAdapterSource = (file: string): boolean =>
  isShippedSource(file) && (file.startsWith("packages/extensions/src/") || file.startsWith("apps/"))

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

/**
 * Only a shipped extension fills a facet. The seam-declaration file copies
 * every facet in `extensionServicesFromHostContext` (`Facet: ctx.Facet`), and
 * crediting that plumbing would make every facet permanently adapted, which
 * is the dead-facet check this guard exists for.
 */
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
): ReadonlyArray<Finding> => {
  const findings: Finding[] = []

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

// ── core pins no vendor model ───────────────────────────────────────────────

/**
 * Guard: core must not pin a vendor model SKU.
 *
 * Core is the loop, and the loop does not know which model an install runs.
 * A dated SKU such as `anthropic/claude-haiku-4-5-20251001` compiled into core
 * rots on the vendor's schedule and silently excludes anyone whose only
 * credentials are for another provider.
 *
 * Where core needs a model, it asks the seam that already answers the
 * question -- `resolveAgentModel` for a registered agent -- and falls back to
 * `DEFAULT_MODEL_ID`, the single declared default.
 *
 * @module
 */

/**
 * The one file allowed to name a vendor model: it declares the default that
 * every other core site resolves through.
 */
const DECLARATION_SITE = "packages/core/src/domain/agent.ts"

/**
 * A provider-qualified model id in a string literal, e.g. `"anthropic/claude-…"`.
 * Deliberately narrow: it matches `<provider>/<model>` inside quotes, which is
 * the shape core would use to call `ModelResolver.resolve`.
 */
const VENDOR_MODEL_PATTERN =
  /["'`](?:anthropic|openai|google|mistral|xai|groq|deepseek)\/[a-z0-9][a-z0-9.-]*["'`]/i

/** Report vendor model SKUs pinned in core source. */
export const findCoreVendorModelPins = (file: string, text: string): ReadonlyArray<Finding> => {
  if (!file.startsWith(CORE_SRC_PREFIX)) return []
  if (file === DECLARATION_SITE) return []

  const findings: Finding[] = []
  const lines = text.split("\n")
  for (const [index, line] of lines.entries()) {
    const match = Option.fromNullishOr(VENDOR_MODEL_PATTERN.exec(line))
    if (Option.isNone(match)) continue
    findings.push({
      file,
      line: index + 1,
      message: `core pins the vendor model ${match.value[0]}; resolve the model through \`resolveAgentModel\` and \`DEFAULT_MODEL_ID\` instead`,
    })
  }
  return findings
}

// ── every e2e test drives a subprocess ──────────────────────────────────────

/**
 * Guard: every e2e test file drives a subprocess.
 *
 * `packages/e2e` holds the tests that need process isolation: a PTY-hosted
 * TUI or a spawned `gent` server. A test file there that imports neither
 * fixture runs in-process inside the slow suite, and belongs in the owning
 * package's `tests/` directory instead.
 */
const E2E_TEST_FILE = /^packages\/e2e\/tests\/.*\.test\.ts$/

/** An `import` whose module path is one of the two subprocess fixtures. */
const FIXTURE_IMPORT =
  /^[ \t]*import\b[^"']*["']\.\.\/src\/(?:server-process-fixture|pty-fixture)(?:\.js)?["']/m

export const findE2eFixtureImportFindings = (
  file: string,
  text: string,
): ReadonlyArray<Finding> => {
  if (!E2E_TEST_FILE.test(file)) return []
  if (FIXTURE_IMPORT.test(text)) return []
  return [
    {
      file,
      line: 1,
      message:
        "e2e test files must import ../src/server-process-fixture or ../src/pty-fixture; an in-process test belongs in the owning package's tests/",
    },
  ]
}

// ── a test writes its temp files outside the repo ───────────────────────────

/**
 * Guard: a test's temp directory lives in the system temp directory.
 *
 * A temp directory under the repo that a killed test leaves behind is linted,
 * formatted and scanned by these guards as if it were source. The extension
 * loaders bind `effect` and the public entries, so an extension file resolves
 * them from anywhere; no test needs `node_modules` above its fixture.
 *
 * A repo path is `import.meta.dir`, `import.meta.dirname`, `__dirname`,
 * `process.cwd()` (every `bun test` script runs in its package directory), a
 * `join`/`resolve` whose first argument is a relative path literal, a
 * `directory:` option that is a relative path literal, or a name bound from
 * one of these. Three shapes are reported in test code outside the tooling
 * package, whatever the directory's name or prefix: a temp directory call
 * (`mkdtemp`, `mkdtempSync`, `makeTempDirectory`, `makeTempDirectoryScoped`)
 * whose arguments name a repo path, a node `mkdtemp` whose prefix is a relative
 * literal (`mkdtempSync("case-")` creates the directory in the working directory),
 * and a repo path joined to a `tmp` or `temp` segment (`.tmp`, `tmp-x`,
 * `temp`). A literal is relative when it starts with none of `/`, `$` or `~`.
 */
const REPO_PATH =
  /\bimport\.meta\.dir(?:name)?\b|\b__dirname\b|\bprocess\.cwd\(\)|\b(?:join|resolve)\(\s*["'`](?![/$~])|\bdirectory:\s*["'`](?![/$~])/
/** A node `mkdtemp` whose prefix is a relative literal: the directory lands in the working directory. */
const RELATIVE_MKDTEMP = /^mkdtemp(?:Sync)?\s*\(\s*["'`](?![/$~])/
const BINDING = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=(.*)$/
const TEMP_CALL = /\b(?:mkdtempSync|mkdtemp|makeTempDirectoryScoped|makeTempDirectory)\s*\(/g
const TMP_SEGMENT = /["'`](?:[^"'`]*\/)?\.?(?:tmp|temp)(?:[-_.][^"'`/]*)?(?:\/[^"'`]*)?["'`]/i

const TEMP_IN_REPO_MESSAGE =
  "a test temp directory under the repo is linted when a killed test leaves it behind; use `makeTempDirectoryScoped` without `directory` (the loaders bind `effect` and the public entries, so no node_modules is needed above it)"

/** The text from `open` (an opening paren) to its matching close, or to the end. */
const callArguments = (text: string, open: number): string => {
  let depth = 0
  for (let at = open; at < text.length; at++) {
    if (text[at] === "(") depth++
    if (text[at] === ")") depth--
    if (depth === 0) return text.slice(open, at + 1)
  }
  return text.slice(open)
}

export const findRepoTempDirectories = (file: string, text: string): ReadonlyArray<Finding> => {
  // The guard's own tests spell the reported shapes as probe text.
  if (!isTestCode(file) || file.startsWith("packages/tooling/")) return []
  const code = withoutComments(text)
  const lines = code.split("\n")
  // A name bound from a repo path, or from another such name, is a repo path.
  const bound = new Set<string>()
  const namesBound = (value: string): boolean =>
    value.split(/[^\w$]+/).some((word) => bound.has(word))
  const namesRepo = (value: string): boolean => REPO_PATH.test(value) || namesBound(value)
  for (const line of lines) {
    const binding = Option.fromNullishOr(BINDING.exec(line))
    if (Option.isSome(binding) && namesRepo(binding.value[2] ?? ""))
      bound.add(binding.value[1] ?? "")
  }
  const reported = new Set<number>()
  // A temp directory call: report the first line of its arguments that names a repo path.
  for (const call of code.matchAll(TEMP_CALL)) {
    const open = call.index + call[0].length - 1
    const first = code.slice(0, open).split("\n").length - 1
    const argumentText = callArguments(code, open)
    if (RELATIVE_MKDTEMP.test(call[0] + argumentText.slice(1))) {
      reported.add(first)
      continue
    }
    const hit = argumentText.split("\n").findIndex(namesRepo)
    if (hit !== -1) reported.add(first + hit)
  }
  // A tmp segment joined to a repo path on one line.
  for (const [index, line] of lines.entries()) {
    if (REPO_PATH.test(line) && TMP_SEGMENT.test(line)) reported.add(index)
  }
  return [...reported]
    .sort((a, b) => a - b)
    .map((index) => ({ file, line: index + 1, message: TEMP_IN_REPO_MESSAGE }))
}

/**
 * Guard: a test's home or data directory is its own.
 *
 * A fixed path under the shared temp root (`/tmp`, `/var/tmp`,
 * `/private/tmp`, `/dev/shm`, or `tmpdir()` itself) given as a test's home or
 * data directory is shared by every run and every parallel gate: what one
 * test writes there (prompt history, goal and wake files, a skills cache),
 * the next one reads, so a result depends on run order. Reported in test code
 * outside the tooling package: a `home`, `HOME`, `homeDir`, `homeDirectory`,
 * `dataDir` or `GENT_DATA_DIR` name followed on its line by such a path, with
 * no other string, comma or semicolon between them. That reads a property, a
 * JSX attribute, a binding, a parameter default (`home: string = "/tmp"`), a
 * fallback (`home ?? "/tmp"`) and a wrapped value
 * (`homeDirectory: Effect.succeed("/tmp")`) alike. A test that writes there
 * takes `makeTempDirectoryScoped`; a test that only names a home takes a path
 * no test can create, such as `/nonexistent/<name>`.
 */
const SHARED_TEMP_HOME =
  /\b(?:home|HOME|homeDir|homeDirectory|dataDir|GENT_DATA_DIR)\b(?:[^"'`\n,;]*?["'`](?:(?:\/private)?(?:\/var)?\/tmp|\/dev\/shm)(?:\/[^"'`]*)?["'`]|\s*[:=]\s*\{?\s*(?:os\.)?tmpdir\(\)\s*(?:[,;})]|$))/

const SHARED_TEMP_HOME_MESSAGE =
  "a test home or data directory under the shared temp root is shared by every run and parallel gate; use `makeTempDirectoryScoped` when the test writes there, or a `/nonexistent/<name>` path when it only names one"

export const findSharedTestHomes = (file: string, text: string): ReadonlyArray<Finding> => {
  // The guard's own tests spell the reported shapes as probe text.
  if (!isTestCode(file) || file.startsWith("packages/tooling/")) return []
  const lines = withoutComments(text).split("\n")
  return [...lines.keys()]
    .filter((index) => SHARED_TEMP_HOME.test(lines[index] ?? ""))
    .map((index) => ({ file, line: index + 1, message: SHARED_TEMP_HOME_MESSAGE }))
}

// ── the pre-commit hook runs the guards ─────────────────────────────────────

/**
 * Guard: the pre-commit hook runs the guards.
 *
 * The hook's other jobs are oxlint, the formatter, typecheck, build and tests.
 * None of them reads what the guards read, so a hook without a
 * `bun run guards` job commits a guard violation that only the gate would
 * catch later. The job is found by the command it runs, not by its name.
 *
 * @module
 */

export const HOOK_FILE = "lefthook.yml"

const GUARD_COMMAND = "bun run guards"

/** The `pre-commit` hook's own key, at the top level of the file. */
const PRE_COMMIT = /^pre-commit:/

/** Any other top-level key closes the `pre-commit` block. */
const TOP_LEVEL_KEY = /^\S/

/** The lines under `pre-commit:`, up to the next top-level key. */
const preCommitBlock = (text: string): string => {
  const lines = text.split("\n")
  const start = lines.findIndex((line) => PRE_COMMIT.test(line))
  if (start === -1) return ""
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => TOP_LEVEL_KEY.test(line))
  if (end === -1) return rest.join("\n")
  return rest.slice(0, end).join("\n")
}

/** A job's `run:` entry; a comment line never matches. */
const RUN_ENTRY = /^\s*(?:-\s+)?run:\s*(.*)$/

/** The commands a `run:` value executes, with its trailing comment and quotes removed. */
const runCommands = (value: string): ReadonlyArray<string> =>
  value
    .replace(/\s+#.*$/, "")
    .replace(/^(["'])(.*)\1$/, "$2")
    .split(/&&|\|\||;/)
    .map((command) => command.trim())

/** Whether a `pre-commit` job runs the guards command as one of its steps. */
const runsGuards = (block: string): boolean =>
  block.split("\n").some((line) =>
    Option.match(Option.fromNullishOr(RUN_ENTRY.exec(line)?.[1]), {
      onNone: () => false,
      onSome: (value) => runCommands(value).includes(GUARD_COMMAND),
    }),
  )

export const findHookWithoutGuards = (file: string, text: string): ReadonlyArray<Finding> => {
  if (file !== HOOK_FILE) return []
  if (runsGuards(preCommitBlock(text))) return []
  return [
    {
      file,
      line: 1,
      message: `the pre-commit hook runs no \`${GUARD_COMMAND}\` job -- the guards then reach a commit only through the gate`,
    },
  ]
}

// ── lint config names nothing that is gone ──────────────────────────────────

/**
 * Guards: the lint config and the environment must not name things that are gone.
 *
 * Three findings, all of the same shape -- a declaration whose subject left the
 * tree, which stays green because nothing ever reads it again:
 *
 * - An `.oxlintrc.json` override whose `files` glob matches no tracked file.
 *   The override for `packages/sdk/src/supervisor.ts` outlived that file and
 *   kept turning a rule off for nothing. The same holds for an `.oxlintignore`
 *   row (a dead `.tmp-*` row sat there) and for an `include` glob of an Effect
 *   language-service override in the root tsconfig.
 * - A rule defined in `gent-rules.ts` that the root config never enables. Five such
 *   rules accumulated; one of them (`no-make-unsafe`) could not be enabled at
 *   all, because shipped code would have failed it.
 * - A `GENT_*` environment variable read in the source with nothing to set it.
 *   The subprocess trace variables kept two readers alive after their writer
 *   was deleted, so a branch nothing could take looked like working code.
 *
 * Each list of exceptions is a claim with a reason beside it, not a switch.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// (a) An override whose files glob matches nothing
// ---------------------------------------------------------------------------

/**
 * Turn one oxlint `files` glob into a matcher.
 *
 * The globs in this config are paths, `**` segments and a `*.ext` tail, so the
 * translation stays small on purpose: a glob needing more than this should be
 * simplified rather than matched by a bigger regex here.
 */
const globMatcher = (glob: string): RegExp => {
  const pattern = glob.split("").reduce(
    (acc: { out: string; skip: number }, char, index, chars) => {
      if (acc.skip > 0) return { out: acc.out, skip: acc.skip - 1 }
      if (char === "*" && chars[index + 1] === "*" && chars[index + 2] === "/") {
        return { out: `${acc.out}(?:.*/)?`, skip: 2 }
      }
      if (char === "*" && chars[index + 1] === "*") {
        return { out: `${acc.out}.*`, skip: 1 }
      }
      if (char === "*") return { out: `${acc.out}[^/]*`, skip: 0 }
      if (char === "?") return { out: `${acc.out}[^/]`, skip: 0 }
      if (".+^${}()|[]\\".includes(char)) return { out: `${acc.out}\\${char}`, skip: 0 }
      return { out: acc.out + char, skip: 0 }
    },
    { out: "", skip: 0 },
  ).out
  return new RegExp(`^${pattern}$`)
}

/**
 * The two parts of `.oxlintrc.json` these guards read. Everything else in the
 * file passes through untouched, so the schema names only these.
 */
export const OxlintConfigSchema = Schema.Struct({
  overrides: Schema.optional(
    Schema.Array(
      Schema.Struct({
        files: Schema.optional(Schema.Array(Schema.String)),
        rules: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      }),
    ),
  ),
  /** Rule names only; the severity values are the caller's business. */
  rules: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

type OxlintConfig = typeof OxlintConfigSchema.Type

/** The line an override's glob sits on, for a finding that points at it. */
const lineOfGlob = (configText: string, glob: string): number => {
  const needle = `"${glob}"`
  for (const [index, line] of configText.split("\n").entries()) {
    if (line.includes(needle)) return index + 1
  }
  return 1
}

export const findUnmatchedOverrideGlobs = (
  configFile: string,
  configText: string,
  config: OxlintConfig,
  trackedFiles: ReadonlyArray<string>,
): ReadonlyArray<Finding> => {
  const findings: Array<Finding> = []
  for (const override of config.overrides ?? []) {
    for (const glob of override.files ?? []) {
      const matcher = globMatcher(glob)
      if (trackedFiles.some((file) => matcher.test(file))) continue
      findings.push({
        file: configFile,
        line: lineOfGlob(configText, glob),
        message: `oxlint override \`files: "${glob}"\` matches no tracked file; delete the override, or fix the glob`,
      })
    }
  }
  return findings
}

/**
 * An `.oxlintignore` row that matches no file oxlint would walk. oxlint also
 * honors `.gitignore`, so `trackedFiles` (tracked and untracked, minus what
 * git ignores) is the set a row can still take out. A row follows gitignore
 * form: a trailing `/` names a directory, a row with no inner `/` matches at
 * any depth, a leading `/` anchors at the root. Comment, blank and `!` rows
 * are skipped.
 */
export const findUnmatchedIgnoreRows = (
  ignoreFile: string,
  text: string,
  trackedFiles: ReadonlyArray<string>,
): ReadonlyArray<Finding> =>
  text.split("\n").flatMap((raw, index) => {
    const row = raw.trim()
    if (row.length === 0 || row.startsWith("#") || row.startsWith("!")) return []
    const bare = row.replace(/\/+$/, "").replace(/^\//, "")
    let glob = bare
    if (!row.startsWith("/") && !bare.includes("/")) glob = `**/${bare}`
    const matchers = [globMatcher(glob), globMatcher(`${glob}/**`)]
    if (trackedFiles.some((file) => matchers.some((matcher) => matcher.test(file)))) return []
    return [
      {
        file: ignoreFile,
        line: index + 1,
        message: `ignore row \`${row}\` matches no file oxlint would lint (git-ignored files are skipped already); delete the row, or fix it`,
      },
    ]
  })

/** The root tsconfig's Effect language-service overrides: the part this guard reads. */
export const TsConfigPluginsSchema = Schema.Struct({
  compilerOptions: Schema.optional(
    Schema.Struct({
      plugins: Schema.optional(
        Schema.Array(
          Schema.Struct({
            overrides: Schema.optional(
              Schema.Array(
                Schema.Struct({ include: Schema.optional(Schema.Array(Schema.String)) }),
              ),
            ),
          }),
        ),
      ),
    }),
  ),
})

/** An `include` glob of a tsconfig plugin override that matches no tracked file. */
export const findUnmatchedTsconfigOverrides = (
  configFile: string,
  configText: string,
  config: typeof TsConfigPluginsSchema.Type,
  trackedFiles: ReadonlyArray<string>,
): ReadonlyArray<Finding> =>
  (config.compilerOptions?.plugins ?? [])
    .flatMap((plugin) => plugin.overrides ?? [])
    .flatMap((override) => override.include ?? [])
    .flatMap((glob) => {
      const matcher = globMatcher(glob)
      if (trackedFiles.some((file) => matcher.test(file))) return []
      return [
        {
          file: configFile,
          line: lineOfGlob(configText, glob),
          message: `tsconfig plugin override \`include: "${glob}"\` matches no tracked file; delete it, or fix the glob`,
        },
      ]
    })

// ---------------------------------------------------------------------------
// (a2) An "off" that suppresses nothing
// ---------------------------------------------------------------------------

/** One diagnostic of a lint run: the file it names and its `plugin(rule)` code. */
export interface LintDiagnostic {
  readonly file: string
  readonly code: string
}

/** The code oxlint reports for a configured rule: `effect/noAs` is `effect(noAs)`. */
const diagnosticCode = (rule: string): string => {
  const slash = rule.indexOf("/")
  if (slash === -1) return `eslint(${rule})`
  return `${rule.slice(0, slash)}(${rule.slice(slash + 1)})`
}

const isOff = Schema.is(Schema.Literals(["off", 0]))

const offsIn = (entries: ReadonlyArray<readonly [string, unknown]>): ReadonlyArray<string> =>
  entries.filter(([, severity]) => isOff(severity)).map(([rule]) => rule)

/** Each rule the root `rules` block turns off. */
export const rootOffs = (config: OxlintConfig): ReadonlyArray<string> =>
  offsIn(Object.entries(config.rules ?? {}))

/** Each rule an override turns off, keyed by the override's index. */
export const overrideOffs = (config: OxlintConfig): ReadonlyArray<ReadonlyArray<string>> =>
  (config.overrides ?? []).map((override) => offsIn(Object.entries(override.rules ?? {})))

/** The line of `rule`'s key in the root `rules` block, which precedes the overrides. */
const lineOfRootRule = (configText: string, rule: string): number => {
  const lines = configText.split("\n")
  const start = Math.max(
    lines.findIndex((line) => line.includes('"rules":')),
    0,
  )
  const offset = lines.slice(start).findIndex((line) => line.includes(`"${rule}":`))
  return start + Math.max(offset, 0) + 1
}

/** The line of `rule`'s key inside the override whose first glob is `glob`. */
const lineOfOverrideRule = (configText: string, glob: string, rule: string): number => {
  const lines = configText.split("\n")
  const start = lineOfGlob(configText, glob) - 1
  const offset = lines.slice(start).findIndex((line) => line.includes(`"${rule}":`))
  return start + Math.max(offset, 0) + 1
}

/**
 * An "off" is a suppression: it must hide at least one diagnostic.
 * `diagnostics` come from a run of the same config with every "off" removed,
 * root and override. A diagnostic belongs to an override "off" when the
 * override's globs match its file and no other override turns the same rule
 * off for that file: removing that override alone would bring it back. It
 * belongs to a root "off" when no override sets the rule for its file. An
 * "off" that owns no diagnostic suppresses nothing today, and it would hide
 * the next real hit without review.
 */
export const findUnneededOffs = (
  configFile: string,
  configText: string,
  config: OxlintConfig,
  diagnostics: ReadonlyArray<LintDiagnostic>,
): ReadonlyArray<Finding> => {
  const overrides = (config.overrides ?? []).map((override, index) => ({
    globs: override.files ?? [],
    matchers: (override.files ?? []).map(globMatcher),
    offs: new Set(overrideOffs(config)[index] ?? []),
    named: new Set(Object.keys(override.rules ?? {})),
  }))
  const matches = (matchers: ReadonlyArray<RegExp>, file: string): boolean =>
    matchers.some((matcher) => matcher.test(file))
  const findings: Array<Finding> = []
  for (const [index, override] of overrides.entries()) {
    for (const rule of override.offs) {
      const code = diagnosticCode(rule)
      const owned = diagnostics.some(
        (diagnostic) =>
          diagnostic.code === code &&
          matches(override.matchers, diagnostic.file) &&
          !overrides.some(
            (other, otherIndex) =>
              otherIndex !== index &&
              other.offs.has(rule) &&
              matches(other.matchers, diagnostic.file),
          ),
      )
      if (owned) continue
      const firstGlob = override.globs[0] ?? ""
      findings.push({
        file: configFile,
        line: lineOfOverrideRule(configText, firstGlob, rule),
        message: `oxlint override for "${firstGlob}" turns off \`${rule}\`, which reports nothing in its files; delete the "off"`,
      })
    }
  }
  for (const rule of rootOffs(config)) {
    const code = diagnosticCode(rule)
    const owned = diagnostics.some(
      (diagnostic) =>
        diagnostic.code === code &&
        !overrides.some(
          (override) => override.named.has(rule) && matches(override.matchers, diagnostic.file),
        ),
    )
    if (owned) continue
    findings.push({
      file: configFile,
      line: lineOfRootRule(configText, rule),
      message: `oxlint root config turns off \`${rule}\`, which reports nothing; delete the "off"`,
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// (b) A plugin rule the root config never enables
// ---------------------------------------------------------------------------

/** The line a rule's `"<name>":` key sits on in the plugin text, for a finding that points at it. */
const lineOfRule = (pluginText: string, rule: string): number =>
  Math.max(1, pluginText.split("\n").findIndex((line) => line.includes(`"${rule}":`)) + 1)

/**
 * `ruleNames` is `Object.keys(plugin.rules)` of the loaded plugin, so the set
 * does not depend on how the plugin text is formatted; the text only places
 * the finding.
 */
export const findUnenabledPluginRules = (
  pluginFile: string,
  pluginText: string,
  ruleNames: ReadonlyArray<string>,
  rootRules: ReadonlySet<string>,
): ReadonlyArray<Finding> =>
  ruleNames
    .filter((rule) => !rootRules.has(`gent/${rule}`))
    .map((rule) => ({
      file: pluginFile,
      line: lineOfRule(pluginText, rule),
      message: `lint rule \`gent/${rule}\` is defined but the root config never enables it; enable it, or delete the rule and its fixtures`,
    }))

// ---------------------------------------------------------------------------
// (c) A GENT_* variable with a reader but nothing to set it
// ---------------------------------------------------------------------------

/**
 * Variables a person or an external launcher supplies, so production holds no
 * writer for them by design. Each entry says who sets it. The table is checked
 * too: an entry nothing reads, or one production sets after all, is reported.
 */
const EXTERNALLY_SET: ReadonlyMap<string, string> = new Map([
  ["GENT_LOG_LEVEL", "a developer sets this by hand to raise log verbosity"],
  ["GENT_PORT", "the operator of a standalone server picks its port"],
  ["GENT_AUTH_DIRECTORY", "the operator names the auth directory"],
  ["GENT_PERSISTENCE_MODE", "the launcher picks sqlite or memory"],
  ["GENT_PROVIDER_MODE", "the launcher picks the live or scripted provider"],
])

/**
 * A quoted name is a read wherever it sits -- `Config.string("GENT_X")`, the
 * last argument of `Config.literals([...], "GENT_X")` on its own line,
 * `optionalEnv("GENT_X")`, `process.env["GENT_X"]` or either branch of a
 * ternary -- unless it is a record key or the target of an assignment.
 */
const QUOTED_NAME = /["'](GENT_[A-Z0-9_]+)["']/g

/** A record key opens its line or follows `{` or `,`, and a `:` follows it. */
const RECORD_KEY_BEFORE = /(?:^|[{,])\s*$/
const RECORD_KEY_AFTER = /^\s*:/
/** `env["GENT_X"] = v`. */
const INDEX_ASSIGNMENT_AFTER = /^\]\s*=(?!=)/

/** The quoted names `line` reads: every quoted name that is not a key or an assignment target. */
const quotedReads = (line: string): ReadonlyArray<string> =>
  [...line.matchAll(QUOTED_NAME)].flatMap((match) => {
    const before = line.slice(0, match.index)
    const after = line.slice(match.index + match[0].length)
    if (RECORD_KEY_BEFORE.test(before) && RECORD_KEY_AFTER.test(after)) return []
    if (INDEX_ASSIGNMENT_AFTER.test(after)) return []
    return Option.toArray(Option.fromNullishOr(match[1]))
  })

/** A direct property read, `process.env.GENT_X` or `Bun.env.GENT_X`, that is not an assignment. */
const DIRECT_READ = /\b(?:process|Bun)\.env\.(GENT_[A-Z0-9_]+)\b(?!\s*=(?!=))/g

/**
 * Setting a variable is one of three shapes; any other text that names it,
 * such as a message saying `GENT_X=1`, sets nothing:
 *
 * - a key of an env record: `env: { GENT_X: v }`, `const env = { "GENT_X": v }`,
 *   `const childEnv = { GENT_X: v }`, the shape a spawned process receives. A
 *   record bound to any other name is not read as a writer, so its reader is
 *   reported: the guard fails loud there, never open;
 * - an assignment: `process.env.GENT_X = v`, `Bun.env["GENT_X"] = v`;
 * - a shell prefix in a package script: `"dev": "GENT_X=1 bun run ..."`.
 */
const ENV_RECORD_OPEN = /\b(?:env|[a-z]\w*Env)\s*[:=]\s*\{/g
const ENV_RECORD_KEY = /(?:^|[{,\s])["']?(GENT_[A-Z0-9_]+)["']?\s*:/g
const ENV_ASSIGNMENT =
  /\b(?:process|Bun)\.env(?:\.(GENT_[A-Z0-9_]+)|\[["'](GENT_[A-Z0-9_]+)["']\])\s*=(?!=)/g
const SCRIPT_PREFIX = /(?:^|[\s"'&;|(])(GENT_[A-Z0-9_]+)=\S/g

/** The text of the record whose `{` sits at `open`, through its matching `}`. */
const recordAt = (text: string, open: number): string => {
  let depth = 0
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === "{") depth += 1
    if (text[at] === "}") depth -= 1
    if (depth === 0) return text.slice(open, at + 1)
  }
  return text.slice(open)
}

/** The names source `text` (comments blanked) sets, by the record and assignment shapes. */
const namesWritten = (text: string): ReadonlyArray<string> => {
  const records = [...text.matchAll(ENV_RECORD_OPEN)].map((match) =>
    recordAt(text, match.index + match[0].length - 1),
  )
  return [
    ...records.flatMap((record) => namesMatching(record, ENV_RECORD_KEY)),
    ...namesMatching(text, ENV_ASSIGNMENT),
  ]
}

const isManifest = (file: string): boolean => /(?:^|\/)package\.json$/.test(file)

/** The one manifest field that runs a shell: every other field is data. */
const decodeManifestScripts = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
  ),
)

/** The names a manifest's `scripts` set by a shell prefix; a description that shows one sets nothing. */
const namesScriptsSet = (text: string): ReadonlyArray<string> =>
  Option.match(decodeManifestScripts(text), {
    onNone: () => [],
    onSome: (manifest) =>
      Object.values(manifest.scripts ?? {}).flatMap((script) =>
        namesMatching(script, SCRIPT_PREFIX),
      ),
  })

interface VariableUse {
  readonly file: string
  readonly line: number
}

/** The name each match captured, in whichever alternative captured it. */
const namesMatching = (line: string, pattern: RegExp): ReadonlyArray<string> =>
  [...line.matchAll(pattern)].flatMap((match) =>
    Option.toArray(Option.firstSomeOf(match.slice(1).map((name) => Option.fromNullishOr(name)))),
  )

/** Where each `GENT_*` variable is read in production, and which ones production sets. */
const collectGentVariableUses = (sourceTexts: ReadonlyMap<string, string>) => {
  const readers = new Map<string, Array<VariableUse>>()
  const writers = new Set<string>()
  for (const [file, text] of sourceTexts) {
    // This finder names variables to describe itself; it is not a call site.
    if (file === GUARDS_FILE || isTestSupport(file)) continue
    // A manifest reads nothing; only its scripts write.
    if (isManifest(file)) {
      for (const name of namesScriptsSet(text)) writers.add(name)
      continue
    }
    // A comment that shows `GENT_X=1` documents a variable; it sets nothing.
    const code = withoutComments(text)
    for (const [index, line] of code.split("\n").entries()) {
      for (const name of [...quotedReads(line), ...namesMatching(line, DIRECT_READ)]) {
        const found = readers.get(name) ?? []
        found.push({ file, line: index + 1 })
        readers.set(name, found)
      }
    }
    for (const name of namesWritten(code)) writers.add(name)
  }
  return { readers, writers }
}

/** The line of an `EXTERNALLY_SET` entry in this file, for a finding that points at it. */
const externallySetLine = (sourceTexts: ReadonlyMap<string, string>, name: string): number =>
  Option.getOrElse(Option.fromNullishOr(sourceTexts.get(GUARDS_FILE)), () => "")
    .split("\n")
    .findIndex((line) => line.includes(`["${name}",`)) + 1

export const findReadersWithoutWriters = (
  sourceTexts: ReadonlyMap<string, string>,
  externallySet: ReadonlyMap<string, string> = EXTERNALLY_SET,
): ReadonlyArray<Finding> => {
  const { readers, writers } = collectGentVariableUses(sourceTexts)
  const staleReason = (name: string): Option.Option<string> => {
    if (!readers.has(name)) return Option.some("nothing reads it")
    if (writers.has(name)) return Option.some("the tree sets it")
    return Option.none()
  }
  const findings: Array<Finding> = []
  for (const [name, uses] of readers) {
    if (writers.has(name) || externallySet.has(name)) continue
    for (const use of uses) {
      findings.push({
        file: use.file,
        line: use.line,
        message: `\`${name}\` is read but nothing in the tree sets it; delete the reader, or record who sets it in EXTERNALLY_SET`,
      })
    }
  }
  for (const name of externallySet.keys()) {
    const stale = staleReason(name)
    if (Option.isNone(stale)) continue
    findings.push({
      file: GUARDS_FILE,
      line: externallySetLine(sourceTexts, name),
      message: `\`${name}\` is allowed as operator-set, but ${stale.value}; drop the EXTERNALLY_SET entry`,
    })
  }
  return findings
}

// ── no code duplicates an Effect platform service ───────────────────────────

/** A file that provides Bun platform layers, and why it may. */
const platformProviderRoots: ReadonlyMap<string, string> = new Map([
  ["packages/core/src/runtime/gent-platform.ts", "it defines the platform service"],
  ["packages/core/src/runtime/gent-platform-bun.ts", "it builds the Bun platform layer"],
  ["packages/core/src/host.ts", "the host entry is the door hosts take to the platform roots"],
  ["apps/tui/src/main.tsx", "the TUI process entry provides the platform once"],
  ["packages/sdk/src/server.ts", "the SDK server entry provides the platform and its listener"],
  ["apps/tui/scripts/build.ts", "the build script is its own process entry, outside any host"],
])

/**
 * One layer a file outside the roots may provide. The reason says why no
 * root can provide it; a shipped extension gets no layer a user extension
 * could not provide the same way.
 */
interface PlatformLayerAllowance {
  readonly file: string
  readonly layer: string
  readonly reason: string
}

const platformLayerAllowances: ReadonlyArray<PlatformLayerAllowance> = [
  {
    file: "packages/extensions/src/openai.ts",
    layer: "BunHttpServer.layerServer",
    reason:
      "the OAuth redirect listener binds the fixed port OpenAI registers, for one sign-in; no root provides an HTTP server, and a user extension may start its own listener",
  },
]

/** The gent-owned names of the Bun platform layer. */
const GENT_PLATFORM_LAYER = /\b(?:BunPlatformLive|BunGentPlatformLive)\b/g

/** The package, quoted. */
const PLATFORM_BUN_PACKAGE = String.raw`["']@effect/platform-bun["']`
/** One module under the package, quoted: `"@effect/platform-bun/BunCrypto"`. */
const PLATFORM_BUN_MODULE = String.raw`["']@effect/platform-bun/\w+["']`
const BINDING_NAME = String.raw`[A-Za-z_$][\w$]*`
const DECLARE = String.raw`\b(?:const|let|var)`
/** Whatever may follow a bare alias: `const C = BunCrypto` ends there. */
const ALIAS_END = String.raw`\s*(?=[;,)\n]|$)`

const dynamicImport = (specifier: string): string =>
  String.raw`\bawait\s+import\(\s*${specifier}\s*\)`

const IMPORT_STATEMENT = new RegExp(
  String.raw`\bimport\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+${BINDING_NAME}|${BINDING_NAME})\s*from\s*["'][^"']*["']`,
  "g",
)
const RE_EXPORT_FROM = new RegExp(
  String.raw`\bexport\s+(?:\*(?:\s+as\s+${BINDING_NAME})?|\{[^}]*\})\s*from\s*(?:${PLATFORM_BUN_PACKAGE}|${PLATFORM_BUN_MODULE})`,
  "g",
)
const LOCAL_EXPORT_LIST = /\bexport\s+\{([^}]*)\}(?!\s*from)/g
const IMPORT_SPECIFIER = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/
const DESTRUCTURE_SPECIFIER = /^\s*([\w$]+)(?:\s*:\s*([\w$]+))?\s*$/

/** Where each kind of `@effect/platform-bun` binding comes from. */
const BINDING_SOURCES = {
  /** `import { BunCrypto } from "@effect/platform-bun"`: modules. */
  packageMembers: new RegExp(
    String.raw`\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*${PLATFORM_BUN_PACKAGE}`,
    "g",
  ),
  /** `import { layer } from "@effect/platform-bun/BunCrypto"`: one module's exports. */
  moduleMembers: new RegExp(
    String.raw`\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*${PLATFORM_BUN_MODULE}`,
    "g",
  ),
  /** `import * as PlatformBun from "@effect/platform-bun"`: the package. */
  packageNamespace: new RegExp(
    String.raw`\bimport\s+\*\s+as\s+(${BINDING_NAME})\s+from\s*${PLATFORM_BUN_PACKAGE}`,
    "g",
  ),
  /** `import * as BunPath from "@effect/platform-bun/BunPath"`: a module. */
  moduleNamespace: new RegExp(
    String.raw`\bimport\s+\*\s+as\s+(${BINDING_NAME})\s+from\s*${PLATFORM_BUN_MODULE}`,
    "g",
  ),
  /** `const PlatformBun = await import("@effect/platform-bun")`: the package. */
  dynamicPackage: new RegExp(
    String.raw`${DECLARE}\s+(${BINDING_NAME})\s*=\s*${dynamicImport(PLATFORM_BUN_PACKAGE)}`,
    "g",
  ),
  /** `const BunCrypto = await import("@effect/platform-bun/BunCrypto")`: a module. */
  dynamicModule: new RegExp(
    String.raw`${DECLARE}\s+(${BINDING_NAME})\s*=\s*${dynamicImport(PLATFORM_BUN_MODULE)}`,
    "g",
  ),
  /** `const { BunCrypto } = await import("@effect/platform-bun")`: modules. */
  dynamicPackageMembers: new RegExp(
    String.raw`${DECLARE}\s*\{([^}]*)\}\s*=\s*${dynamicImport(PLATFORM_BUN_PACKAGE)}`,
    "g",
  ),
  /** `const { layer } = await import("@effect/platform-bun/BunCrypto")`: one module's exports. */
  dynamicModuleMembers: new RegExp(
    String.raw`${DECLARE}\s*\{([^}]*)\}\s*=\s*${dynamicImport(PLATFORM_BUN_MODULE)}`,
    "g",
  ),
}

const escapeRegExp = (text: string): string => text.replace(/[$.*+?^()[\]{}|\\]/g, "\\$&")

/** The first capture of each match of `pattern` in `text`. */
const firstCaptures = (text: string, pattern: RegExp): ReadonlyArray<string> =>
  Array.from(text.matchAll(pattern)).flatMap((match) =>
    Option.toArray(Option.fromNullishOr(match[1])),
  )

interface ImportedName {
  readonly imported: string
  readonly local: string
}

/** The names a `{ ... }` list binds, with the local name of each. */
const listedNames = (list: string, specifier: RegExp): ReadonlyArray<ImportedName> =>
  list.split(",").flatMap((entry) =>
    Option.toArray(Option.fromNullishOr(specifier.exec(entry))).flatMap((parts) =>
      Option.toArray(Option.fromNullishOr(parts[1])).map((imported) => ({
        imported,
        local: Option.getOrElse(Option.fromNullishOr(parts[2]), () => imported),
      })),
    ),
  )

/** The local names each `{ ... }` list matched by `pattern` binds. */
const boundNames = (
  code: string,
  pattern: RegExp,
  specifier: RegExp,
  keep: (imported: string) => boolean,
): ReadonlyArray<string> =>
  firstCaptures(code, pattern).flatMap((list) =>
    listedNames(list, specifier)
      .filter((name) => keep(name.imported))
      .map((name) => name.local),
  )

const isLayerExport = (imported: string): boolean => /^layer\w*$/.test(imported)
const anyExport = (): boolean => true

/**
 * The names this file binds from `@effect/platform-bun`. A module's `.layer*`
 * is a layer, a package namespace's `.<Module>.layer*` is one, and a layer
 * binding is one itself. A `const` that aliases a module or the package is
 * followed.
 */
interface PlatformBunBindings {
  readonly modules: ReadonlyArray<string>
  readonly namespaces: ReadonlyArray<string>
  readonly layers: ReadonlyArray<string>
}

/** `A|B` of the escaped names, or nothing when there are none. */
const alternation = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
  [names].filter((list) => list.length > 0).map((list) => list.map(escapeRegExp).join("|"))

/** A member access, plain or optional: `BunCrypto.layer` and `BunCrypto?.layer` read the same member. */
const MEMBER = String.raw`\s*\??\.\s*`

/**
 * One pass of `const X = <module>`, `const X = <namespace>.<Module>` and
 * `const { <Module> } = <namespace>` aliases.
 */
const aliasedModules = (code: string, bindings: PlatformBunBindings): ReadonlyArray<string> => [
  ...[
    ...alternation(bindings.modules),
    ...alternation(bindings.namespaces).map((names) => String.raw`(?:${names})${MEMBER}\w+`),
  ].flatMap((source) =>
    firstCaptures(
      code,
      new RegExp(String.raw`${DECLARE}\s+(${BINDING_NAME})\s*=\s*(?:${source})${ALIAS_END}`, "g"),
    ),
  ),
  ...alternation(bindings.namespaces).flatMap((names) =>
    boundNames(
      code,
      new RegExp(String.raw`${DECLARE}\s*\{([^}]*)\}\s*=\s*(?:${names})${ALIAS_END}`, "g"),
      DESTRUCTURE_SPECIFIER,
      anyExport,
    ),
  ),
]

const platformBunBindings = (code: string): PlatformBunBindings => {
  const imported: PlatformBunBindings = {
    modules: [
      ...boundNames(code, BINDING_SOURCES.packageMembers, IMPORT_SPECIFIER, anyExport),
      ...boundNames(code, BINDING_SOURCES.dynamicPackageMembers, DESTRUCTURE_SPECIFIER, anyExport),
      ...firstCaptures(code, BINDING_SOURCES.moduleNamespace),
      ...firstCaptures(code, BINDING_SOURCES.dynamicModule),
    ],
    namespaces: [
      ...firstCaptures(code, BINDING_SOURCES.packageNamespace),
      ...firstCaptures(code, BINDING_SOURCES.dynamicPackage),
    ],
    layers: [
      ...boundNames(code, BINDING_SOURCES.moduleMembers, IMPORT_SPECIFIER, isLayerExport),
      ...boundNames(
        code,
        BINDING_SOURCES.dynamicModuleMembers,
        DESTRUCTURE_SPECIFIER,
        isLayerExport,
      ),
    ],
  }
  const follow = (bindings: PlatformBunBindings): PlatformBunBindings => {
    const modules = new Set([...bindings.modules, ...aliasedModules(code, bindings)])
    if (modules.size === new Set(bindings.modules).size) return bindings
    return follow({ ...bindings, modules: Array.from(modules) })
  }
  return follow(imported)
}

/**
 * The pattern of a layer provision: a module's `.layer*`, a namespace's
 * `.<Module>.layer*`, a layer binding, `.layer*` on an inline
 * `await import(...)`, or a destructure that takes `layer*` from a module
 * (`const { layer } = BunCrypto`, reported where it takes the layer). Each
 * access may be optional (`?.`), and whitespace may sit around it, so an
 * access split across lines still matches. Constructors such as
 * `BunSocket.makeNet` and runners such as `BunRuntime.runMain` are not
 * provisions.
 */
const platformBunLayerPattern = (bindings: PlatformBunBindings): RegExp => {
  const provisions = [
    ...alternation(bindings.modules).map((names) => String.raw`(?:${names})${MEMBER}layer\w*`),
    ...alternation(bindings.modules).map(
      (names) => String.raw`\{[^}]*(?<![\w$])layer\w*[^}]*\}\s*=\s*(?:${names})${ALIAS_END}`,
    ),
    ...alternation(bindings.namespaces).map(
      (names) => String.raw`(?:${names})${MEMBER}\w+${MEMBER}layer\w*`,
    ),
    ...alternation(bindings.layers),
    String.raw`\(\s*${dynamicImport(PLATFORM_BUN_MODULE)}\s*\)${MEMBER}layer\w*`,
    String.raw`\(\s*${dynamicImport(PLATFORM_BUN_PACKAGE)}\s*\)${MEMBER}\w+${MEMBER}layer\w*`,
  ]
  return new RegExp(String.raw`(?<![\w$.])(?:${provisions.join("|")})(?![\w$])`, "g")
}

/**
 * A statement that hands `@effect/platform-bun` on: a re-export from the
 * package, an `export { ... }` of a name bound from it, or an exported alias.
 */
const platformBunReExports = (
  code: string,
  bindings: PlatformBunBindings,
): ReadonlyArray<RegExpExecArray> => {
  const bound = new Set([...bindings.modules, ...bindings.namespaces, ...bindings.layers])
  const exportedLists = Array.from(code.matchAll(LOCAL_EXPORT_LIST)).filter((match) =>
    listedNames(
      Option.getOrElse(Option.fromNullishOr(match[1]), () => ""),
      IMPORT_SPECIFIER,
    ).some((name) => bound.has(name.imported)),
  )
  const exportedAliases = alternation(Array.from(bound)).flatMap((names) =>
    Array.from(
      code.matchAll(
        new RegExp(
          String.raw`\bexport\s+(?:const|let|var)\s+${BINDING_NAME}\s*=\s*(?:${names})(?:\s*\.\s*\w+)?${ALIAS_END}`,
          "g",
        ),
      ),
    ),
  )
  return [...code.matchAll(RE_EXPORT_FROM), ...exportedLists, ...exportedAliases]
}

/** A `[start, end)` stretch of source. */
interface Span {
  readonly start: number
  readonly end: number
}

/** The spans that bind names rather than use them. */
const bindingSpans = (code: string): ReadonlyArray<Span> =>
  [
    IMPORT_STATEMENT,
    RE_EXPORT_FROM,
    BINDING_SOURCES.dynamicPackageMembers,
    BINDING_SOURCES.dynamicModuleMembers,
  ].flatMap((pattern) =>
    Array.from(code.matchAll(pattern)).map((match) => {
      const start = match.index
      return { start, end: start + match[0].length }
    }),
  )

/** The source text of a match, its whitespace around `.` and parentheses dropped. */
const collapsedText = (text: string): string => text.replace(/\s*([.()])\s*/g, "$1")

const lineAt = (code: string, index: number): number => code.slice(0, index).split("\n").length

/**
 * Every Bun platform layer is provided by a platform root. A file outside
 * the roots yields the service the root provides (`FileSystem`, `Path`,
 * `ChildProcessSpawner`, `Crypto`, ...) instead of providing its own, so a
 * test host's services reach it and a shipped extension is never more
 * privileged than a user extension. The guard reads the names the file binds
 * from `@effect/platform-bun` (static or dynamic imports, and their aliases),
 * so a local `BunWidget.layer` is no provision, and it reports a module that
 * re-exports the package, since that hands the layers to any importer. A
 * layer no root can provide takes a `platformLayerAllowances` entry with its
 * reason. What a launcher or a reference extension may import is its
 * manifest's business: the `gent/declared-workspace-imports` lint rule reads
 * it.
 */
export const findPlatformDuplicationViolations = (
  file: string,
  text: string,
): ReadonlyArray<Finding> => {
  if (!isShippedSource(file) || platformProviderRoots.has(file)) return []
  const allowed = new Set(
    platformLayerAllowances.filter((entry) => entry.file === file).map((entry) => entry.layer),
  )
  const code = withoutComments(text)
  const bindings = platformBunBindings(code)
  const spans = bindingSpans(code)
  const inBindingSpan = (index: number): boolean =>
    spans.some((span) => index >= span.start && index < span.end)
  const provisions = [
    ...code.matchAll(GENT_PLATFORM_LAYER),
    ...Array.from(code.matchAll(platformBunLayerPattern(bindings))).filter(
      (match) => !inBindingSpan(match.index),
    ),
  ]
    .map((match) => ({ index: match.index, name: collapsedText(match[0]) }))
    .filter((provision) => !allowed.has(provision.name))
    .map((provision) => ({
      index: provision.index,
      message: `\`${provision.name}\` provides a Bun platform layer outside the platform roots; yield the service the root provides, or record why no root can provide it in platformLayerAllowances`,
    }))
  const reExports = platformBunReExports(code, bindings).map((match) => ({
    index: match.index,
    message: `\`${collapsedText(match[0].replace(/\s+/g, " "))}\` re-exports @effect/platform-bun outside the platform roots, which hands its layers to any importer; import from the package where it is used, or yield the service the root provides`,
  }))
  return [...provisions, ...reExports]
    .toSorted((left, right) => left.index - right.index)
    .map((finding) => ({ file, line: lineAt(code, finding.index), message: finding.message }))
}

// ── a deleted surface stays deleted ─────────────────────────────────────────

/**
 * Guard: a deleted surface stays deleted.
 *
 * Each row names what was removed and what replaced it. A row matches a source
 * line or the file path itself. A retired module is a `line` row on its quoted
 * specifier, so a one-line import, the closing line of a multi-line one, an
 * `export ... from` and an `import()` all match. The guard source is exempt:
 * the table names every retired surface on purpose.
 *
 * The steering files and the authoring docs are read too, for every `line`
 * row whatever its scope: an agent reads them before the code, and a deleted
 * name there is an instruction to bring it back. `docs/research/` is out; like
 * `plans/`, it holds dated receipts that name what existed at the time.
 *
 * Retired `Bun.*` members (`Bun.Glob`, `Bun.randomUUIDv7` outside the platform
 * adapter) are banned by the `gent/no-bun-outside-adapter` rule in
 * `gent-rules.ts` instead, because only the AST sees a member access.
 *
 * @module
 */

interface RetiredSurface {
  /** `line`: a source line; `path`: the file path. */
  readonly on: "line" | "path"
  readonly match: RegExp
  /**
   * `shipped`: shipped source and the test harness, not the tests. A test may
   * name a retired surface to assert it is gone.
   * `shipped-and-tests`: also the tests, where a test that builds the retired
   * layer again is the same regrowth; the tooling package is out.
   */
  readonly scope: "shipped" | "shipped-and-tests"
  readonly message: string
}

/** Whole identifiers only: `InProcessRunner` does not match `ProcessRunner`. */
const identifiers = (...names: ReadonlyArray<string>): RegExp =>
  new RegExp(`(?<![A-Za-z0-9_$])(?:${names.join("|")})(?![A-Za-z0-9_$])`)

/**
 * A module named as the last segment of a quoted relative specifier, with or
 * without its extension: `"./resource-graph.js"` matches `resource-graph`.
 */
const specifierModules = (...names: ReadonlyArray<string>): RegExp =>
  new RegExp(`(?<=["'][^"'\\n]*/)(?:${names.join("|")})(?=(?:\\.[cm]?[jt]sx?)?["'])`)

const RECONCILER_MESSAGE =
  "the resource reconciler is removed; a profile builds its resources once per cwd in runtime/extension-host.ts, so put new resource behavior inside that scoped build"

export const RETIRED_SURFACES: ReadonlyArray<RetiredSurface> = [
  {
    on: "line",
    match: identifiers(
      "ProcessRunner",
      "ProcessRunnerLive",
      "ProcessRunnerService",
      "makeProcessRunner",
    ),
    scope: "shipped-and-tests",
    message:
      "the process-runner service is removed; call runProcess from runtime/gent-platform.ts and take ChildProcessSpawner in the requirement union",
  },
  {
    on: "line",
    match: new RegExp(
      `${
        identifiers(
          "ExtensionFilesService",
          "ExtensionProcessService",
          "makeFileWriter",
          "testExtensionFiles",
          "testExtensionProcess",
        ).source
      }|\\bctx\\.(?:Files|Process)\\b`,
    ),
    scope: "shipped-and-tests",
    message:
      "the Files and Process facets are removed; yield FileSystem, Path and ChildProcessSpawner, call runProcess, and write atomically with writeFileAtomic from @gent/core/extensions/api",
  },
  {
    on: "line",
    match: identifiers(
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
    ),
    scope: "shipped",
    message: RECONCILER_MESSAGE,
  },
  {
    on: "line",
    match: specifierModules(
      "resource-graph",
      "resource-graph-host",
      "resource-leases",
      "resource-lifecycle",
      "live-profile",
    ),
    scope: "shipped",
    message: RECONCILER_MESSAGE,
  },
  {
    on: "line",
    match: identifiers("ExtensionRuntime"),
    scope: "shipped",
    message: "ExtensionRuntime marker service is deleted; use explicit services",
  },
  {
    on: "line",
    match: identifiers("ExtensionTurnControl"),
    scope: "shipped",
    message: "ExtensionTurnControl mailbox is deleted; use the session runtime protocol",
  },
  {
    on: "line",
    match: identifiers("TurnEvent", "TurnEventUsage"),
    scope: "shipped",
    message: "TurnEvent duplicates Effect AI response parts",
  },
  {
    on: "line",
    match: /\bsubTagLayers\s*\(/,
    scope: "shipped",
    message: "Storage subtag adapter is deleted; use SqliteStorage composition roots",
  },
  {
    on: "line",
    match: /\bctx\.extension\b/,
    scope: "shipped",
    message: "In-process extension RPC is deleted; yield services or use public transport",
  },
  {
    on: "line",
    match: /\btyped RPC helpers\b/,
    scope: "shipped",
    message: "Host contexts no longer expose typed RPC helpers",
  },
  {
    on: "line",
    match: identifiers("GentSpan"),
    scope: "shipped",
    message: "GentSpan tracer is deleted; use @effect/opentelemetry via Tracer service",
  },
  {
    on: "line",
    match: identifiers("resetIncompatibleStorageSchema"),
    scope: "shipped",
    message: "Destructive schema reset is deleted; use SqliteMigrator migrations",
  },
  {
    on: "line",
    match: identifiers("LiveFile"),
    scope: "shipped",
    message: "LiveFile JSON KV pattern is deleted; use KeyValueStore.layerFileSystem",
  },
  {
    on: "line",
    match: /\bEventStore\.Live\s*=\s*EventStore\.Memory\b/,
    scope: "shipped",
    message:
      "EventStore.Live = EventStore.Memory alias is deleted; resolve EventStore explicitly per persistence mode",
  },
  {
    on: "line",
    match: identifiers("loopsRef", "mutationSemaphoresRef", "LoopDriverEvent", "LoopHandle"),
    scope: "shipped",
    message: "Legacy agent-loop dispatch infrastructure is deleted; use AgentLoop actor state",
  },
  {
    on: "line",
    match: identifiers(
      "eraseLayer",
      "restoreErasedLayer",
      "ServerProfile",
      "CwdProfile",
      "EphemeralProfile",
      "ServerProfileService",
      "brandServerScope",
      "brandCwdScope",
      "brandEphemeralScope",
    ),
    scope: "shipped",
    message: "Legacy runtime composer scope brands are deleted; compose layers at the owner",
  },
  {
    on: "line",
    match: identifiers("sdkBoundary", "runSdkBoundary", "SdkBoundary"),
    scope: "shipped",
    message: "The SdkBoundary brand is deleted; keep Promise edges in a *-boundary.ts file",
  },
  {
    on: "line",
    match: identifiers("GENT_TRACE_ID", "GENT_PARENT_SPAN_ID"),
    scope: "shipped",
    message:
      "The subprocess trace handoff is deleted with its supervisor; nothing sets these variables",
  },
  {
    on: "line",
    match: identifiers("positiveIntegerOr", "tcpPortOr", "knownModeOr", "LaunchConfigError"),
    scope: "shipped",
    message: "Hand-written launch decoders are deleted; read the environment through LaunchConfig",
  },
  {
    on: "line",
    match: /\b(?:Any)?(?:Query|Capability)Contribution\b/,
    scope: "shipped",
    message:
      "Query/Capability contribution authoring is deleted; extensions contribute tools and requests",
  },
  {
    on: "line",
    match: /\bProvider\.(?:Sequence|Signal|Debug|Failing)\b/,
    scope: "shipped",
    message: "Provider test statics are deleted; use LanguageModelLayers",
  },
  {
    on: "line",
    match: identifiers("findOpenPort", "WORKER_HOST"),
    scope: "shipped",
    message: "Worker port preallocation is deleted; use server-selected ports",
  },
  {
    on: "line",
    match: identifiers("WorkerLifecycleState"),
    scope: "shipped",
    message: "WorkerLifecycleState is deleted; use the server lifecycle contract",
  },
  {
    on: "line",
    match: /\breactions\s*:/,
    scope: "shipped",
    message: "Extension lifecycle authoring uses hooks; the reactions bucket is deleted",
  },
  {
    on: "path",
    match: /^packages\/core\/src\/server\/rpcs\/actor\.ts$/,
    scope: "shipped",
    message: "Public actor RPC surface is deleted; use product RPCs",
  },
  {
    on: "path",
    match: /^packages\/core\/src\/domain\/auth-(?:storage|store|method)\.ts$/,
    scope: "shipped",
    message: "Legacy auth domain module is deleted; use domain/auth",
  },
  {
    on: "path",
    match: /^packages\/core\/src\/runtime\/(?:composer|scope-brands)\.ts$/,
    scope: "shipped",
    message: "Legacy runtime composer modules are deleted; use owner-local layer composition",
  },
  {
    on: "path",
    match: /^packages\/sdk\/src\/(?:server-registry|worker-http)\.ts$/,
    scope: "shipped",
    message: "SDK worker registry/http split is deleted; use server lock and server entrypoints",
  },
  {
    on: "line",
    match: identifiers("BunCronRuntimeLive"),
    scope: "shipped-and-tests",
    message:
      "the cron runtime layer is removed; scheduling belongs to the kernel, and the cell reaches Bun.cron directly",
  },
  {
    on: "line",
    match: identifiers("SessionInfo", "BranchInfo"),
    scope: "shipped",
    message:
      "the transport session DTOs are removed; the contract carries the domain Session and Branch schemas",
  },
  {
    on: "line",
    match: identifiers("ExtensionStatePublisher", "ExtensionStatePublisherLive"),
    scope: "shipped-and-tests",
    message:
      "ExtensionStatePublisher is removed; the State facet of ExtensionContext publishes through EventStore",
  },
  {
    on: "line",
    match: identifiers("EventPublisher", "EventPublisherLive", "EventPublisherService"),
    // Shipped only: a test asserts the public API does not export the name.
    scope: "shipped",
    message: "the EventPublisher pass-through is removed; runtime code yields EventStore",
  },
  {
    on: "line",
    match: identifiers("ConnectionTracker", "ConnectionTrackerService"),
    scope: "shipped-and-tests",
    message:
      "the connection tracker is removed with shared server mode and idle shutdown; a server lives as long as its owner",
  },
  {
    on: "line",
    match: /["'`]runtime\.status["'`]/,
    scope: "shipped-and-tests",
    message:
      "the runtime.status RPC is removed with shared server mode; the server identity endpoint names the build",
  },
  {
    on: "line",
    match: identifiers("driverList", "driverListReply"),
    scope: "shipped-and-tests",
    message:
      "transport.driverList is removed; /driver sends driver.set and the server rejects an unknown id",
  },
  {
    on: "line",
    match: /\b(?:inbox|LoopInbox)\.(?:claimStart|releaseStart)\b/,
    scope: "shipped-and-tests",
    message:
      "the inbox start reservation is removed; a reserved start runs in the loop scope, so no caller releases it",
  },
  {
    on: "line",
    match: new RegExp(`\\bserver-root\\b|${identifiers("buildServerRoot").source}`),
    scope: "shipped-and-tests",
    message:
      "server-root.ts is folded away; the SDK root and the test harness build the routes and RPC handlers from createDependencies",
  },
  {
    on: "path",
    match: /^packages\/core\/src\/server\/server-root\.ts$/,
    scope: "shipped",
    message:
      "server-root.ts is folded away; the SDK root and the test harness build the routes and RPC handlers from createDependencies",
  },
  {
    // A core file or directory whose name has `cell` as a whole word.
    on: "path",
    match: /^packages\/core\/src\/(?:[^/]+\/)*(?:[^/]*[-_])?cell(?:[-_.][^/]*)?(?:\/|$)/,
    scope: "shipped",
    message:
      "The code cell lives in @gent/extensions (packages/extensions/src/cell.ts); core carries no cell module",
  },
]

/** Source under `packages/` and `apps/` but the tooling package, which names the rows. */
const RETIRED_SOURCE = /^(?:packages|apps)\/(?!tooling\/).+\.[cm]?[jt]sx?$/

const inRetiredScope = (file: string, row: RetiredSurface): boolean => {
  if (isSteeringFile(file)) return row.on === "line"
  if (!RETIRED_SOURCE.test(file) || file.includes("/dist/")) return false
  // The harness ships no product, but it is where a removed test layer grows back.
  if (row.scope === "shipped") return isShippedSource(file) || isTestHarness(file)
  return isShippedSource(file) || isTestCode(file)
}

/** Every line or path in `file` that brings back a retired surface. */
export const findRetiredSurfaces = (file: string, text: string): ReadonlyArray<Finding> => {
  const rows = RETIRED_SURFACES.filter((row) => inRetiredScope(file, row))
  if (rows.length === 0) return []
  const findings: Array<Finding> = []
  for (const row of rows) {
    if (row.on === "path" && row.match.test(file))
      findings.push({ file, line: 1, message: row.message })
  }
  const lineRows = rows.filter((row) => row.on === "line")
  for (const [index, line] of text.split("\n").entries()) {
    for (const row of lineRows) {
      const hit = Option.fromNullishOr(row.match.exec(line))
      if (Option.isNone(hit)) continue
      findings.push({ file, line: index + 1, message: `"${hit.value[0]}": ${row.message}` })
    }
  }
  return findings
}

// ── a steering-file path exists ─────────────────────────────────────────────

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
 * Scope is the steering prose (`STEERING_PROSE`): what an agent is told to
 * read. Today `CLAUDE.md` is a symlink to `AGENTS.md`; the guard runner skips symlinks, so
 * the document is read once, and a `CLAUDE.md` that becomes a file of its own
 * is read as one.
 *
 * What is read: text in backticks that starts with one of the eight tree
 * roots: `packages/`, `apps/`, `plans/`, `testbeds/`, `examples/`, `docs/`,
 * `patches/`, `.claude/`. Backticks are what makes the reference a claim about a path; prose naming a file
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
 * A relative Markdown link, `[text](target)`, is a path claim too: its target
 * resolves against the file's own directory, less any `#anchor`. A target
 * with a scheme (`https:`) or a leading `/` or `#` is not a repo path, and a
 * link inside backticks or a fence is code, not a link.
 *
 * @module
 */

/**
 * Steering prose: what an agent is told to read before it changes the code.
 * The root `AGENTS.md`, `CLAUDE.md` and `ARCHITECTURE.md`, a package's own
 * `AGENTS.md` or `CLAUDE.md`, `docs/` but its dated research, a testbed's
 * `README.md` (the root `CLAUDE.md` sends agents to the gamut one), the
 * dependency patch notes in `patches/README.md`, the project skills under
 * `.claude/skills/`, and the skills gent ships to its own model under
 * `packages/extensions/src/skills/bundled/`. The path claims, the Markdown
 * links, the retired-surface rows and the code-block compile all read exactly
 * this set.
 */
const STEERING_PROSE =
  /^(?:(?:AGENTS|CLAUDE|ARCHITECTURE)\.md|(?:apps|packages)\/[^/]+\/(?:AGENTS|CLAUDE)\.md|docs\/(?!research\/).+\.md|testbeds\/[^/]+\/README\.md|patches\/README\.md|\.claude\/skills\/.+\.md|packages\/extensions\/src\/skills\/bundled\/.+\.md)$/

export const isSteeringFile = (file: string): boolean => STEERING_PROSE.test(file)

/** The eight roots under which a backticked path is a claim about the tree. */
const SOURCE_ROOT = /^(?:packages|apps|plans|testbeds|examples|docs|patches|\.claude)\//

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
 */
const existsInTree = (path: string, tracked: ReadonlySet<string>, prefixes: ReadonlySet<string>) =>
  tracked.has(path) || prefixes.has(path)

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

/** A Markdown link's target: `(target)` after `[text]`, up to a space or the close. */
const MARKDOWN_LINK = /\[[^\]\n]*\]\(([^)\s]+)\)/g

/** A link target that is not a repo path: a URL, a root-relative path, or an anchor. */
const NOT_REPO_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i

/** `target` resolved against `directory`, with `.` and `..` segments folded; none above the root. */
const resolveRelative = (directory: string, target: string): Option.Option<string> => {
  const segments: Array<string> = directory.split("/").filter((segment) => segment.length > 0)
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment !== "..") segments.push(segment)
    else if (segments.length === 0) return Option.none()
    else segments.pop()
  }
  return Option.some(segments.join("/"))
}

/** The relative link targets of a prose line that name no tracked path from `directory`. */
const danglingLinkTargets = (
  line: string,
  directory: string,
  tracked: ReadonlySet<string>,
  prefixes: ReadonlySet<string>,
): ReadonlyArray<string> =>
  [...line.replace(BACKTICKED, "").matchAll(MARKDOWN_LINK)]
    .map((match) => Option.getOrElse(Option.fromNullishOr(match[1]), () => ""))
    .filter((target) => !NOT_REPO_TARGET.test(target))
    .filter((target) =>
      Option.match(resolveRelative(directory, target.replace(/#.*$/, "")), {
        onNone: () => true,
        onSome: (resolved) => !existsInTree(resolved, tracked, prefixes),
      }),
    )

export const findSteeringFilePaths = (
  file: string,
  text: string,
  trackedFiles: ReadonlyArray<string>,
): ReadonlyArray<Finding> => {
  if (!isSteeringFile(file)) return []

  const tracked = new Set(trackedFiles)
  const prefixes = directoryPrefixesOf(trackedFiles)
  const directory = file.slice(0, Math.max(file.lastIndexOf("/"), 0))
  const findings: Finding[] = []
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
    for (const target of danglingLinkTargets(line, directory, tracked, prefixes)) {
      findings.push({
        file,
        line: index + 1,
        message: `steering file links \`${target}\`, which resolves to no tracked file from \`${file}\` -- point the link at the file that exists, or drop it`,
      })
    }
  }
  return findings
}

// ── every bundled skill file ships ──────────────────────────────────────────

/**
 * Guard: every Markdown file under the bundled skills directory ships.
 *
 * The skills module imports each bundled file as text and lists it in
 * `bundledSkillFiles` under its path in the skill tree, which is where the
 * skill's own links find it once installed. A file added to the directory
 * without an import is not shipped, and nothing fails: the build, the
 * typecheck and the skill tests read only what is imported. A listed path
 * that differs from the imported file installs the right text under the wrong
 * name, so a `SKILL.md` link to it dangles.
 *
 * Read: the tracked files under `BUNDLED_SKILLS_DIRECTORY` and the text of
 * `BUNDLED_SKILLS_MODULE`. Reported: a Markdown file with no import (at the
 * file), and an import whose `bundledSkillFiles` row is missing or names
 * another path (at the import).
 */
export const BUNDLED_SKILLS_MODULE = "packages/extensions/src/skills.ts"
const BUNDLED_SKILLS_DIRECTORY = "packages/extensions/src/skills/bundled/"

/** `import name from "./skills/bundled/<path>"`: the binding and the bundled path. */
const BUNDLED_IMPORT = /^import\s+([A-Za-z_$][\w$]*)\s+from\s+["']\.\/skills\/bundled\/([^"']+)["']/

/** A `bundledSkillFiles` row, `["<path>", name]`, across lines or on one. */
const BUNDLED_ROW = /\[\s*["']([^"']+)["']\s*,\s*([A-Za-z_$][\w$]*)\s*,?\s*\]/g

export const findUnshippedSkillFiles = (
  moduleText: string,
  trackedFiles: ReadonlyArray<string>,
): ReadonlyArray<Finding> => {
  const imported = new Map<string, { readonly path: string; readonly line: number }>()
  for (const [index, line] of moduleText.split("\n").entries()) {
    const match = Option.fromNullishOr(BUNDLED_IMPORT.exec(line))
    if (Option.isSome(match))
      imported.set(match.value[1] ?? "", { path: match.value[2] ?? "", line: index + 1 })
  }
  const rows = new Map<string, string>()
  for (const match of moduleText.matchAll(BUNDLED_ROW)) rows.set(match[2] ?? "", match[1] ?? "")
  const importedPaths = new Set([...imported.values()].map((entry) => entry.path))
  const findings: Array<Finding> = trackedFiles
    .filter((file) => file.startsWith(BUNDLED_SKILLS_DIRECTORY) && file.endsWith(".md"))
    .filter((file) => !importedPaths.has(file.slice(BUNDLED_SKILLS_DIRECTORY.length)))
    .map((file) => ({
      file,
      line: 1,
      message: `a bundled skill file that \`${BUNDLED_SKILLS_MODULE}\` does not import never ships; import it as text and list it in \`bundledSkillFiles\`, or delete it`,
    }))
  for (const [name, entry] of imported) {
    const listed = Option.fromNullishOr(rows.get(name))
    if (Option.isSome(listed) && listed.value === entry.path) continue
    findings.push({
      file: BUNDLED_SKILLS_MODULE,
      line: entry.line,
      message: Option.match(listed, {
        onNone: () =>
          `\`${name}\` imports \`${entry.path}\`, but no \`bundledSkillFiles\` row lists it, so it never installs`,
        onSome: (path) =>
          `\`${name}\` imports \`${entry.path}\`, but its \`bundledSkillFiles\` row installs it as \`${path}\`, where the skill's links do not find it`,
      }),
    })
  }
  return findings
}

// ── the steering prose's code compiles ──────────────────────────────────────

/**
 * Guard: every ```ts, ```typescript and ```tsx block of the steering prose
 * (`STEERING_PROSE`) compiles with the repo's compiler options and Effect
 * diagnostics.
 *
 * An agent or an extension author copies these blocks, so a block that no
 * longer compiles, or that the repo's own diagnostics reject, teaches the
 * wrong code. `check-guide-code.ts` writes each block to a scoped temp
 * directory as its own module, runs `tsc` once per compile context, and
 * reports each diagnostic at its line in the file that holds the block.
 *
 * A block compiles in the context of its file: a block under `apps/tui/`
 * with the TUI tsconfig and the TUI's dependencies (Solid JSX from
 * `@opentui/solid`), every other block with the root tsconfig and the
 * examples package's dependencies (`effect`, `@gent/core` and its entries),
 * the way an extension resolves them.
 *
 * A block that cannot compile on its own is marked by the line
 * `<!-- illustrative: <why> -->` directly above its fence and is skipped. The
 * reason is required: a mark without one marks nothing, and the block
 * compiles.
 */

/** Where a block compiles: the tsconfig it extends and the `node_modules` it resolves from. */
export interface GuideCodeContext {
  readonly name: string
  readonly tsconfig: string
  readonly modules: string
}

const EXTENSION_CONTEXT: GuideCodeContext = {
  name: "extension",
  tsconfig: "tsconfig.json",
  modules: "examples/node_modules",
}

const TUI_CONTEXT: GuideCodeContext = {
  name: "tui",
  tsconfig: "apps/tui/tsconfig.json",
  modules: "apps/tui/node_modules",
}

export const guideCodeContextOf = (file: string): GuideCodeContext => {
  if (file.startsWith("apps/tui/")) return TUI_CONTEXT
  return EXTENSION_CONTEXT
}

/** One code block: its file, the file line of its first code line, and its code. */
interface GuideBlock {
  readonly file: string
  readonly line: number
  readonly code: string
  readonly extension: "ts" | "tsx"
}

/** The fence languages that compile, and the module extension each is written with. */
const BLOCK_EXTENSION = new Map<string, GuideBlock["extension"]>([
  ["ts", "ts"],
  ["typescript", "ts"],
  ["tsx", "tsx"],
])
const FENCE_OPEN = /^```\S*\s*$/
const FENCE_CLOSE = /^```\s*$/
const ILLUSTRATIVE_MARK = /^<!--\s*illustrative:\s*\S.*-->\s*$/

/** Whether the line above the fence at `fence` marks its block illustrative. */
const markedIllustrative = (lines: ReadonlyArray<string>, fence: number): boolean =>
  fence > 0 && ILLUSTRATIVE_MARK.test(lines[fence - 1] ?? "")

export const guideCodeBlocks = (file: string, text: string): ReadonlyArray<GuideBlock> => {
  const blocks: Array<GuideBlock> = []
  const lines = text.split("\n")
  let open = Option.none<{ readonly start: number; readonly language: string }>()
  for (const [index, line] of lines.entries()) {
    if (Option.isNone(open)) {
      if (!FENCE_OPEN.test(line)) continue
      open = Option.some({ start: index + 1, language: line.slice(3).trim() })
      continue
    }
    if (!FENCE_CLOSE.test(line)) continue
    const { start, language } = open.value
    open = Option.none()
    const extension = Option.fromNullishOr(BLOCK_EXTENSION.get(language))
    if (Option.isNone(extension) || markedIllustrative(lines, start - 1)) continue
    blocks.push({
      file,
      line: start + 1,
      code: lines.slice(start, index).join("\n"),
      extension: extension.value,
    })
  }
  return blocks
}

/** The module file a block is written to: `b1.ts` for the first, `b2.tsx` for a TSX second. */
export const guideBlockFile = (index: number, block: GuideBlock): string =>
  `b${index + 1}.${block.extension}`

const BLOCK_DIAGNOSTIC = /(?:^|[/\\])b(\d+)\.tsx?\((\d+),(\d+)\)/

/** A `tsc` output line with its block position replaced by the position in the block's file. */
export const guideDiagnosticLine = (line: string, blocks: ReadonlyArray<GuideBlock>): string =>
  Option.fromNullishOr(BLOCK_DIAGNOSTIC.exec(line)).pipe(
    Option.flatMap((match) =>
      Option.fromNullishOr(blocks.at(Number(match[1]) - 1)).pipe(
        Option.map(
          (block) =>
            `${block.file}:${block.line + Number(match[2]) - 1}:${match[3]}${line.slice(match.index + match[0].length)}`,
        ),
      ),
    ),
    Option.getOrElse(() => line),
  )

// ── an effect tracks no whole session record ────────────────────────────────

/**
 * Guard: a reactive effect must not track the whole session record.
 *
 * `transitionSessionState` rebuilds the `Session` object for `UpdateName` and
 * `UpdateSettings`, so a rename or a `/model` change hands every reader a new
 * object carrying the same ids. An effect that tracks the record restarts for
 * a change it does not care about: the child-session tracker lost its fiber and
 * every projected row, the extension resources blanked and round-tripped, and
 * the slash-command list cleared for the duration of an RPC. One reducer
 * produced four defects that way.
 *
 * The client answers "which session" once, with `sessionIdentity()` and
 * `activeSessionId()` — memos with an equivalence on the ids. Anything that
 * reacts to the session rather than displays it reads those.
 *
 * What is reported: a `.session()` read inside a `createEffect`, a
 * `createMemo`, a `createResource` or an `on(...)` source — the places Solid
 * records a dependency and re-runs on it. A read in a JSX expression, in an
 * event handler, or in a plain accessor is untouched: those want the record,
 * and the name and the model live on the record.
 *
 * `transport.currentSession()` is not reported: it already answers with the
 * identity alone, and `extensions/context.tsx` builds it from the client's
 * `sessionIdentity()` memo.
 *
 * @module
 */

const TUI_SOURCE = /^apps\/tui\/src\//

/**
 * Opens a reactive scope: Solid re-runs what follows when its reads change.
 * A member call such as `emitter.on(` is a listener, not Solid's `on`.
 */
const TRACKING_OPENER = /(?<![.\w])(?:createEffect|createMemo|createResource|on)\(/

/** The record accessor. `sessionIdentity`/`activeSessionId` are the narrowed ones. */
const RECORD_READ = /(?<!current)\.session\(\)/i

/**
 * How far a reactive scope is followed. Long enough for the dependency list and
 * the head of the body this codebase writes, short enough that a later callback
 * in the same function is not attributed to the effect.
 */
const SCOPE_LINES = 12

export const findTuiSessionIdentityReads = (file: string, text: string): ReadonlyArray<Finding> => {
  if (!TUI_SOURCE.test(file)) return []

  const lines = text.split("\n")
  const reported = new Set<number>()
  const findings: Finding[] = []
  for (const [index, line] of lines.entries()) {
    if (!TRACKING_OPENER.test(line)) continue
    const openerIndent = line.length - line.trimStart().length
    const limit = Math.min(index + 1 + SCOPE_LINES, lines.length)
    for (let cursor = index; cursor < limit; cursor += 1) {
      const candidate = Option.getOrElse(Option.fromNullishOr(lines[cursor]), () => "")
      const trimmed = candidate.trim()
      // The scope closes when the nesting returns to the opener's column.
      if (cursor > index && trimmed.length > 0) {
        const indent = candidate.length - candidate.trimStart().length
        if (indent <= openerIndent && !TRACKING_OPENER.test(candidate)) break
      }
      if (!RECORD_READ.test(candidate)) continue
      if (reported.has(cursor)) break
      reported.add(cursor)
      findings.push({
        file,
        line: cursor + 1,
        message:
          "this reactive scope reads the whole session record, so a rename or a model change re-runs it -- read `sessionIdentity()` or `activeSessionId()`, which move only when the session or the branch does",
      })
      break
    }
  }
  return findings
}

// ── the approved diagnostics suppressions ───────────────────────────────────

/**
 * The one suppression the linters cannot police: `@effect-diagnostics` comments.
 * Every other kind (`@ts-ignore`, `as any`, block eslint-disables) is banned by
 * oxlint or by `blanket-eslint-disable`, so this inventory is the approved list
 * of diagnostics suppressions and nothing else.
 *
 * The inventory is checked in both directions: a suppression comment with no
 * approved entry fails the guard, and an approved entry with no matching
 * comment anywhere in the tree fails it too, so the table cannot drift. An
 * entry states how many identical comments its file holds (`count`, one when
 * absent), and the guard fails when the file holds more or fewer: a new site
 * of a reviewed comment is a new suppression and needs its own review. An
 * entry listed twice fails as well.
 */

/** `next-line` suppresses the following line; `file` suppresses the whole module. */
type SuppressionScope = "next-line" | "file"

interface ApprovedSuppressionEntry {
  readonly file: string
  readonly scope: SuppressionScope
  /** Everything after the directive: rule flags and the reason. */
  readonly text: string
  /**
   * How many identical comments the file holds; absent means one. The guard
   * fails when the file holds more or fewer, so a new site asks for review.
   */
  readonly count?: number
}

const directiveMarker = ["@effect", "diagnostics"].join("-")

const directivePrefix = {
  "next-line": `// ${directiveMarker}-next-line`,
  file: `// ${directiveMarker}`,
} satisfies Record<SuppressionScope, string>

const approvedComment = (entry: ApprovedSuppressionEntry): string =>
  `${directivePrefix[entry.scope]} ${entry.text}`

/** Matching ignores line churn: an entry is keyed by file and exact comment text. */
const approvedSuppressionEntries: ReadonlyArray<ApprovedSuppressionEntry> = [
  {
    file: "apps/tui/src/main.tsx",
    scope: "next-line",
    text: "globalTimersInEffect:off -- process lifetime handle: OpenTUI render resolves after mount and suspended Effect fibers do not keep Bun alive",
  },
  {
    file: "apps/tui/src/client.tsx",
    scope: "next-line",
    text: "nodeBuiltinImport:off",
  },
  {
    file: "apps/tui/tests/extensions/loader-boundary.test.ts",
    scope: "next-line",
    text: "nodeBuiltinImport:off",
    count: 2,
  },
  {
    file: "packages/core/src/server/workspace-rpc.ts",
    scope: "file",
    text: "nodeBuiltinImport:off — the workspace id is a wire constant, see workspaceIdForCwd",
  },
  {
    file: "packages/core/src/server/workspace-rpc.ts",
    scope: "file",
    text: "nodeBuiltinImport:off — the workspace id canonicalizes its cwd before hashing",
  },
  {
    file: "packages/sdk/src/server.ts",
    scope: "file",
    text: "nodeBuiltinImport:off — server primitive owns filesystem path resolution for gent's data directory",
  },
  {
    file: "packages/sdk/src/server.ts",
    scope: "next-line",
    text: "strictEffectProvide:off",
  },
  {
    file: "packages/sdk/src/server.ts",
    scope: "next-line",
    text: "strictEffectProvide:off self-contained probe, no scope lifetime",
  },
  {
    file: "packages/sdk/tests/server.test.ts",
    scope: "file",
    text: "nodeBuiltinImport:off",
  },
  {
    file: "packages/core/src/domain/extension.ts",
    scope: "next-line",
    text: "anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/test-utils/language-model.ts",
    scope: "file",
    text: "nodeBuiltinImport:off — test fixture lifecycle comes from bun:test",
  },
  {
    file: "packages/tooling/src/test-preload.ts",
    scope: "file",
    text: "nodeBuiltinImport:off — the test preload runs in bun's test host before any Effect runtime",
  },
  {
    file: "packages/core/src/test-utils/language-model.ts",
    scope: "next-line",
    text: "strictEffectProvide:off test entry point",
  },
  {
    file: "packages/core/src/runtime/tools.ts",
    scope: "next-line",
    text: "anyUnknownInErrorContext:off",
  },
  {
    file: "packages/core/src/domain/capability.ts",
    scope: "next-line",
    text: "anyUnknownInErrorContext:off — the erased handler crosses the runtime membrane; the public overloads keep authors typed.",
  },
  {
    file: "packages/core/src/runtime/extension-host.ts",
    scope: "next-line",
    text: "anyUnknownInErrorContext:off",
    count: 8,
  },
  {
    file: "packages/core/src/runtime/extension-host.ts",
    scope: "next-line",
    text: "anyUnknownInErrorContext:off — heterogeneous Resource layer enters the explicit eraseResourceLayer membrane.",
  },
  {
    file: "packages/extensions/src/openai.ts",
    scope: "next-line",
    text: "strictEffectProvide:off OAuth token endpoint at extension boundary",
    count: 2,
  },
  {
    file: "packages/extensions/src/openai.ts",
    scope: "next-line",
    text: "strictEffectProvide:off device endpoints at extension boundary",
  },
  {
    file: "packages/extensions/src/anthropic.ts",
    scope: "next-line",
    text: "strictEffectProvide:off",
  },
  {
    file: "packages/extensions/src/providers.ts",
    scope: "next-line",
    text: "strictEffectProvide:off The catalog owns its own HTTP client at the driver boundary; it outlives no scope.",
  },
]

/**
 * The guards that write the marker out to recognise it. Each spells
 * `@effect-diagnostics` in a pattern, a table entry or a message, so scanning
 * them reports the description of a suppression instead of a suppression.
 */
const DESCRIBES_THE_MARKER = new Set([GUARDS_FILE, "packages/tooling/tests/guards.test.ts"])

const approvedCount = (entry: ApprovedSuppressionEntry): number => entry.count ?? 1

/** How many comments of this exact text the inventory approves in `file`. */
const approvalsFor = (
  entries: ReadonlyArray<ApprovedSuppressionEntry>,
  file: string,
  comment: string,
): number =>
  Option.match(
    Option.fromNullishOr(
      entries.find((entry) => entry.file === file && approvedComment(entry) === comment),
    ),
    { onNone: () => 0, onSome: approvedCount },
  )

/** A comment past its approved count: never approved, or one site more than approved. */
const unreviewedMessage = (approved: number, seen: number): string => {
  if (approved === 0) {
    return `unreviewed ${directiveMarker} suppression; remove it, or approve its exact text in ${GUARDS_FILE}`
  }
  return `${directiveMarker} suppression at a new site: ${GUARDS_FILE} approves ${approved} identical comment(s) here, this is number ${seen}; remove it, or review it and raise the entry's count`
}

export const findSuppressionInventoryFindings = (
  file: string,
  text: string,
  entries: ReadonlyArray<ApprovedSuppressionEntry> = approvedSuppressionEntries,
): ReadonlyArray<Finding> => {
  const findings: Finding[] = []
  if (DESCRIBES_THE_MARKER.has(file)) return findings

  const seenByComment = new Map<string, number>()
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.includes(directiveMarker)) continue
    const comment = line.trim()
    const seen = (seenByComment.get(comment) ?? 0) + 1
    seenByComment.set(comment, seen)
    const approved = approvalsFor(entries, file, comment)
    if (seen <= approved) continue
    findings.push({ file, line: index + 1, message: unreviewedMessage(approved, seen) })
  }
  return findings
}

const countComment = (text: string, comment: string): number =>
  text.split("\n").filter((line) => line.trim() === comment).length

/**
 * Whole-tree check: every approved entry must match a comment in its file.
 * `sources` maps each scanned source path to its text; a file missing from
 * the map counts as having no suppressions. The finding points at the entry.
 */
export const findUnusedSuppressionApprovals = (
  sources: ReadonlyMap<string, string>,
  entries: ReadonlyArray<ApprovedSuppressionEntry> = approvedSuppressionEntries,
): ReadonlyArray<Finding> => {
  const entryLines = Option.getOrElse(
    Option.fromNullishOr(sources.get(GUARDS_FILE)),
    () => "",
  ).split("\n")
  const listed = new Map<string, number>()
  return entries.flatMap((entry) => {
    const comment = approvedComment(entry)
    const key = `${entry.file}\n${comment}`
    const nth = (listed.get(key) ?? 0) + 1
    listed.set(key, nth)
    const at = (): number => {
      const lines = [...entryLines.entries()]
        .filter(
          ([index, text]) =>
            text.includes(`file: "${entry.file}"`) &&
            entryLines
              .slice(index, index + 4)
              .some((next) => next.includes(`text: "${entry.text}"`)),
        )
        .map(([index]) => index + 1)
      return Option.getOrElse(Option.fromNullishOr(lines.at(nth - 1)), () => 1)
    }
    if (nth > 1) {
      return [
        {
          file: GUARDS_FILE,
          line: at(),
          message: `approved suppression for ${entry.file} is listed twice; one entry counts every identical comment in its file, so drop the duplicate and set its count: ${comment}`,
        },
      ]
    }
    const present = Option.match(Option.fromNullishOr(sources.get(entry.file)), {
      onNone: () => 0,
      onSome: (text) => countComment(text, comment),
    })
    const approved = approvedCount(entry)
    if (present >= approved) return []
    if (present === 0) {
      return [
        {
          file: GUARDS_FILE,
          line: at(),
          message: `approved suppression for ${entry.file} has no matching comment there; drop the entry: ${comment}`,
        },
      ]
    }
    return [
      {
        file: GUARDS_FILE,
        line: at(),
        message: `approved suppression for ${entry.file} approves ${approved} identical comments but the file holds ${present}; set the count to ${present}: ${comment}`,
      },
    ]
  })
}

// ── every export has a consumer ─────────────────────────────────────────────

/**
 * Guard: an export must have a consumer.
 *
 * The interface is everything a caller must know, so an export with no
 * caller is not free -- it is vocabulary a reader has to account for and an
 * author has to keep working. One question, "does this name have a
 * consumer", is asked of every scanned surface; `SCANNED_SURFACES` is the
 * table that says, per surface, which files may answer it.
 *
 * Two shapes of surface are scanned:
 *
 * - A module surface (`packages/core/src/`, `packages/sdk/src/`,
 *   `packages/extensions/src/`) declares names with
 *   `export const|class|function|interface|type|enum`, or exposes names it
 *   owns through a bare `export { X }` with no `from` clause. A name is consumed
 *   once some file that does not itself declare it mentions the name. Core
 *   and the SDK are held to the strict reading: a name only its own module
 *   uses should drop the `export` keyword. The extensions package is read
 *   with the Schema-aware rule: a tool's parameter and result schemas sit
 *   beside the tool that reads them, and `Schema.Class` declares a value and
 *   a type under one name, so a reference inside the declaring file counts
 *   -- except the declaration's own self-references (`Schema.Class<X>`, the
 *   `_tag` string, a doc comment), which are not consumption. The tooling and
 *   e2e packages are read the same way, and so is `packages/core/src/test-utils/`,
 *   which is its own surface: a guard's finding type, a fixture's context type
 *   and a test layer's config sit beside the function that returns them.
 *   Support modules -- test helpers, build scripts and a testbed's driver --
 *   are read with the strict rule (`SUPPORT_MODULE`); a test file declares
 *   nothing the scan measures.
 *
 * - An entry-point surface (`packages/core/src/extensions/api.ts`,
 *   `packages/core/src/protocol.ts`, `packages/core/src/host.ts`,
 *   `packages/core/src/test-utils/index.ts`, `packages/sdk/src/index.ts`,
 *   `packages/extensions/src/client.ts`) exposes names with
 *   `export { X } from "..."`. Consumption is read from the import
 *   itself, through the entry point's specifier, by files outside the
 *   declaring package: a symbol a core test imports over a relative path does
 *   not count, and a name on a `@ts-expect-error` line asserts absence rather
 *   than use. Tests count here: the surface-lock suites assert the shape of
 *   this API through the public path, which is a real consumer.
 *
 * `findPackageSurfaceFindings` is the adjacent, smaller question: which
 * entry points a package.json and the workspace tsconfig may expose at all.
 *
 * @module
 */

/** One scanned surface: where its names are declared and who may consume them. */
interface ScannedSurface {
  readonly prefix: string
  /** Files whose mentions never count: the declaring package's own source, for an entry point. */
  readonly outsideOf: ReadonlyArray<string>
  /** Whether a test file's mention keeps a name alive. */
  readonly testsCount: boolean
  /** Whether a reference inside the declaring file, off the declaration lines, keeps a name alive. */
  readonly ownFileCounts: boolean
  /** The import specifier an entry point is consumed through; `None` for a module surface. */
  readonly specifier: Option.Option<string>
  /**
   * A leaf app: nothing outside it imports it, so only a file under this
   * prefix can read its names. A same-named identifier elsewhere is its own.
   */
  readonly leafOf?: string
}

const SCANNED_SURFACES: ReadonlyArray<ScannedSurface> = [
  {
    prefix: "packages/core/src/extensions/api.ts",
    outsideOf: ["packages/core/src/"],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.some("@gent/core/extensions/api"),
  },
  {
    prefix: "packages/core/src/extensions/branch-tools.ts",
    outsideOf: ["packages/core/src/"],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.some("@gent/core/extensions/branch-tools"),
  },
  {
    prefix: "packages/core/src/protocol.ts",
    outsideOf: ["packages/core/src/"],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.some("@gent/core/protocol"),
  },
  {
    // A host export exists for the processes that compose a server; a name
    // only tests read is harness setup and belongs behind a test-utils operation.
    prefix: "packages/core/src/host.ts",
    outsideOf: ["packages/core/src/"],
    testsCount: false,
    ownFileCounts: false,
    specifier: Option.some("@gent/core/host"),
  },
  {
    // The test entry point, listed before the harness directory it re-exports.
    prefix: "packages/core/src/test-utils/index.ts",
    outsideOf: ["packages/core/src/"],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.some("@gent/core/test-utils"),
  },
  {
    // Its own surface, listed before `packages/core/src/` so the prefix scan
    // reaches it first. Read with the Schema-aware rule: a layer's config type
    // and a control handle's type sit beside the builder that returns them.
    prefix: "packages/core/src/test-utils/",
    outsideOf: [],
    testsCount: true,
    ownFileCounts: true,
    specifier: Option.none(),
  },
  {
    prefix: "packages/core/src/",
    outsideOf: [],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.none(),
  },
  {
    prefix: "packages/sdk/src/index.ts",
    outsideOf: ["packages/sdk/"],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.some("@gent/sdk"),
  },
  {
    prefix: "packages/sdk/src/",
    outsideOf: [],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.none(),
  },
  {
    prefix: "packages/extensions/src/client.ts",
    outsideOf: ["packages/extensions/"],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.some("@gent/extensions/client"),
  },
  {
    prefix: "packages/extensions/src/",
    outsideOf: [],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.none(),
  },
  {
    prefix: "packages/tooling/src/",
    outsideOf: [],
    testsCount: true,
    ownFileCounts: true,
    specifier: Option.none(),
  },
  {
    prefix: "packages/e2e/src/",
    outsideOf: [],
    testsCount: true,
    ownFileCounts: true,
    specifier: Option.none(),
  },
  {
    // The TUI's one public entry: client extensions author against it. The
    // shipped ones live in `apps/tui/src/extensions/` and import it by its
    // specifier like a user extension does, so the import is the consumer,
    // wherever it sits. A relative import of the same module never counts.
    prefix: "apps/tui/src/extensions.ts",
    outsideOf: [],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.some("@gent/tui/extensions"),
  },
  {
    // Apart from that entry the TUI is a leaf: nothing imports it, so every
    // export it declares is read from inside `apps/tui` or by its tests, or
    // by nothing at all.
    prefix: "apps/tui/src/",
    outsideOf: [],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.none(),
    leafOf: "apps/tui/",
  },
  {
    // The server app is a launcher and a leaf: it reads the environment and
    // calls `Gent.server`. Nothing imports it, so a name it exports is read by
    // its own tests or by nothing at all.
    prefix: "apps/server/src/",
    outsideOf: [],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.none(),
    leafOf: "apps/server/",
  },
  {
    // An example extension is a leaf too: the loader reads its default
    // export, and its own tests may read a named one. A name nothing else
    // reads drops the `export` keyword.
    prefix: "examples/",
    outsideOf: [],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.none(),
    leafOf: "examples/",
  },
]

/**
 * Support modules: the test helpers under a workspace's `tests/` or
 * `integration/`, its build scripts, and a testbed's driver. They sit outside
 * every shipped tree, so no prefix row reaches them. Each is read strictly: a
 * name only its own file uses drops the `export` keyword.
 */
const SUPPORT_MODULE =
  /^(?:(?:packages|apps)\/[^/]+\/(?:tests|integration|scripts)\/|testbeds\/[^/]+\/(?:tests\/)?[^/]+\.[cm]?[jt]sx?$)/

const SUPPORT_SURFACE: ScannedSurface = {
  prefix: "",
  outsideOf: [],
  testsCount: true,
  ownFileCounts: false,
  specifier: Option.none(),
}

/** A test file declares nothing the scan measures: its exports are fixture text or test-local. */
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/

const surfaceOf = (file: string): Option.Option<ScannedSurface> => {
  if (TEST_FILE.test(file)) return Option.none()
  return Option.orElse(
    Option.fromNullishOr(SCANNED_SURFACES.find((surface) => file.startsWith(surface.prefix))),
    () => Option.liftPredicate(SUPPORT_SURFACE, () => SUPPORT_MODULE.test(file)),
  )
}

/** A declared name, and the surface whose rule decides whether it is consumed. */
interface Declaration {
  readonly name: string
  readonly line: number
  readonly surface: ScannedSurface
  /**
   * True when the name reaches this file through `export { X } from "..."`.
   * Such a file both exposes the name and names the upstream declaration, so
   * it stays a consumer of that declaration while being measured itself.
   */
  readonly passthrough?: boolean
}

const DECLARATION =
  /^export\s+(?:declare\s+)?(?:const|class|function|interface|type|enum)\s+([A-Za-z_$][\w$]*)/

/**
 * `(name, line)` for every export a module surface file declares.
 *
 * Three shapes reach the same place. `export const Foo` names the value on the
 * spot. A bare `export { Foo, Bar }` with no `from` clause exposes names this
 * file owns, so it is a surface too -- 26 dead names hid in one such block in
 * `packages/sdk/src/client.ts` because only the first shape was read. And
 * `export { Foo } from "./x.js"` puts a second consumable name at this module
 * path, so a dead one is dead here even though `./x.js` keeps its own alive --
 * `providers/provider-auth.ts` carried such a line past three review passes.
 *
 * Two kinds of name in a *bare* block are not this file's own, and counting
 * either would hide a real consumer: one it imported, and one it declares
 * elsewhere in the file. A `from` block has no such ambiguity: it names only
 * what it exposes.
 */
const declaredNames = (
  text: string,
): ReadonlyArray<{
  readonly name: string
  readonly line: number
  readonly passthrough?: boolean
}> => {
  const found: Array<{ name: string; line: number }> = []
  for (const [index, line] of text.split("\n").entries()) {
    const name = Option.flatMap(Option.fromNullishOr(DECLARATION.exec(line)), (match) =>
      Option.fromNullishOr(match[1]),
    )
    if (Option.isSome(name)) found.push({ name: name.value, line: index + 1 })
  }
  // A bare block exposes names; only the ones this file also imports are its
  // own surface. A name it imported is another file's declaration being passed
  // through, and counting it here would hide that file's real consumer.
  const declared = new Set(found.map((entry) => entry.name))
  const imported = importedNames(text)
  const bare = bareExportedNames(text).filter(
    (entry) => !declared.has(entry.name) && !imported.has(entry.name),
  )
  // A `from` re-export is this module's own surface entry even when the file
  // also imports the name for its own use: the two are separate consumable
  // paths, and only the re-export is being measured here.
  const exposed = new Set([...declared, ...bare.map((entry) => entry.name)])
  const passed = fromExportedNames(text)
    .filter((entry) => !exposed.has(entry.name))
    .map((entry) => ({ ...entry, passthrough: true }))
  return [...found, ...bare, ...passed]
}

/** Every name this file binds with an `import { ... }` or `import X` statement. */
const importedNames = (text: string): ReadonlySet<string> => {
  const names = new Set<string>()
  for (const match of text.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    const inner = Option.getOrElse(Option.fromNullishOr(match[1]), () => "")
    for (const part of inner.split(",")) {
      const bound = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
      const last = Option.fromNullishOr(bound[bound.length - 1])
      if (Option.exists(last, (name) => /^[A-Za-z_$][\w$]*$/.test(name))) {
        names.add(Option.getOrElse(last, () => ""))
      }
    }
  }
  for (const match of text.matchAll(/^import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s+from/gm)) {
    const bound = Option.fromNullishOr(match[1])
    if (Option.isSome(bound)) names.add(bound.value)
  }
  return names
}

/**
 * The names every `export { ... }` block exposes, kept or dropped by `carries`.
 *
 * The block is collected whole before that test, because a block broken across
 * lines carries its `from` on the closing line.
 */
const blockExportedNames = (
  text: string,
  carries: (block: string) => boolean,
): ReadonlyArray<{ readonly name: string; readonly line: number }> => {
  const found: Array<{ name: string; line: number }> = []
  const lines = text.split("\n")
  let block: Option.Option<{ start: number; text: string }> = Option.none()
  for (const [index, line] of lines.entries()) {
    if (Option.isNone(block)) {
      if (!/^export\s+(?:type\s+)?\{/.test(line)) continue
      block = Option.some({ start: index, text: line })
    } else {
      block = Option.map(block, (open) => ({ ...open, text: `${open.text}\n${line}` }))
    }
    if (!line.includes("}")) continue
    const closed = block
    block = Option.none()
    if (Option.isNone(closed)) continue
    const open = closed.value
    if (!carries(open.text)) continue
    for (const match of open.text.matchAll(
      /(?:^|[{,])\s*(?:type\s+)?([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/g,
    )) {
      const exposed = Option.orElse(Option.fromNullishOr(match[2]), () =>
        Option.fromNullishOr(match[1]),
      )
      Option.match(exposed, {
        onNone: () => {},
        onSome: (name) => {
          if (name !== "export" && name !== "type" && name !== "from") {
            found.push({ name, line: open.start + 1 })
          }
        },
      })
    }
  }
  return found
}

const HAS_FROM = /\}\s*from\s*["']/

/** The names every `export { ... }` block without a `from` clause exposes. */
const bareExportedNames = (text: string) =>
  blockExportedNames(text, (block) => !HAS_FROM.test(block))

/** The names every `export { ... } from "..."` block on a module surface exposes. */
const fromExportedNames = (text: string) =>
  blockExportedNames(text, (block) => HAS_FROM.test(block))

/**
 * The names one `export { ... } from "..."` block exposes, with the line each
 * sits on. Handles `type X`, `X as Y` (the exposed name is `Y`), and blocks
 * broken across lines -- all three shapes appear in the entry point today.
 */
const reExportedNames = (
  text: string,
): ReadonlyArray<{ readonly name: string; readonly line: number }> => {
  const found: Array<{ name: string; line: number }> = []
  let inBlock = false
  for (const [index, line] of text.split("\n").entries()) {
    if (!inBlock && /^export\s+(?:type\s+)?\{/.test(line)) inBlock = true
    else if (!inBlock) continue
    for (const match of line.matchAll(
      /(?:^|[{,])\s*(?:type\s+)?([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/g,
    )) {
      const exposed = Option.orElse(Option.fromNullishOr(match[2]), () =>
        Option.fromNullishOr(match[1]),
      )
      Option.match(exposed, {
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

const IDENTIFIER = /[A-Za-z_$][\w$]*/g

/** Every identifier-shaped word in a text, for a cheap "is this name mentioned" test. */
const identifiersIn = (text: string): ReadonlySet<string> =>
  new Set(Option.getOrElse(Option.fromNullishOr(text.match(IDENTIFIER)), () => []))

/**
 * The text with comments and string literals blanked, line count preserved.
 *
 * A doc comment naming a class and the `_tag` string a `Schema.TaggedError`
 * carries are not consumption; blanking them is what lets an own-file
 * reference be read as one.
 */
const withoutCommentsAndStrings = (text: string): string => blankComments(text, true)

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
  const opensStatement = (index: number): boolean =>
    /^\s*(?:import|export)\b/.test(Option.getOrElse(Option.fromNullishOr(lines[index]), () => ""))
  while (start > 0 && !opensStatement(start)) start--
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

/** Names one `import { ... } from "<specifier>"` statement brings in. */
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

/** Aliases bound by `import * as X from "<specifier>"`. */
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
  // `const { beta, gamma: g } = TU` reads each key off the namespace.
  const kept = lines.filter((_, index) => !skip.has(index + 1)).join("\n")
  const destructure = new RegExp(`\\b(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*${alias}\\b`, "g")
  for (const match of kept.matchAll(destructure)) {
    const inner = Option.getOrElse(Option.fromNullishOr(match[1]), () => "")
    for (const part of inner.split(",")) {
      const key = Option.fromNullishOr(/^\s*([A-Za-z_$][\w$]*)/.exec(part)?.[1])
      if (Option.isSome(key)) found.push(key.value)
    }
  }
  return found
}

const specifierPattern = (specifier: string): RegExp =>
  new RegExp(`["']${specifier.replace(/[/.]/g, "\\$&")}(?:\\.js)?["']`)

/**
 * Names a file reaches for through one entry point's specifier.
 *
 * A named import credits the *original* name, not the local alias: `X as Y`
 * means the entry point still has to export `X`. A namespace import credits
 * every member the file reads off it.
 */
const importedThrough = (specifier: string, lines: ReadonlyArray<string>): ReadonlySet<string> => {
  const pattern = specifierPattern(specifier)
  const skip = expectErrorLines(lines)
  const names = new Set<string>()
  const aliases = new Set<string>()
  for (const [index, line] of lines.entries()) {
    if (!pattern.test(line)) continue
    const statement = statementEndingAt(lines, index)
    for (const alias of namespaceAliasesIn(statement)) aliases.add(alias)
    for (const name of namedImportsIn(statement)) names.add(name)
  }
  for (const alias of aliases) {
    for (const name of namespaceMembersIn(lines, alias, skip)) names.add(name)
  }
  return names
}

/** The last path segment of an import specifier, without its extension. */
const lastSegment = (specifier: string): string => {
  const trimmed = specifier.replace(/\.[cm]?[jt]sx?$/, "").replace(/\/+$/, "")
  const slash = trimmed.lastIndexOf("/")
  if (slash === -1) return trimmed
  return trimmed.slice(slash + 1)
}

/**
 * The names a file answers to as an import target: its own basename, plus, for
 * a directory index, that directory's name. `import { X } from "../theme"`
 * reaches `theme/index.ts`.
 */
const importTargetsOf = (file: string): ReadonlyArray<string> => {
  const base = lastSegment(file)
  if (base !== "index") return [base]
  const withoutFile = file.slice(0, file.lastIndexOf("/"))
  return [base, lastSegment(withoutFile)]
}

/**
 * Names this file imports from a path, keyed by that path's last segment.
 *
 * A `export { X } from "./x.js"` re-export puts `X` at *this* module's path,
 * so only an import naming this path keeps it alive. Whether the tree mentions
 * `X` anywhere says nothing: the file that declared it answers for that.
 */
const importsByTarget = (
  lines: ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const byTarget = new Map<string, Set<string>>()
  for (const [index, line] of lines.entries()) {
    const specifier = Option.flatMap(
      Option.fromNullishOr(/from\s*["']([^"']+)["']/.exec(line)),
      (found) => Option.fromNullishOr(found[1]),
    )
    if (Option.isNone(specifier)) continue
    const statement = statementEndingAt(lines, index)
    if (!/^\s*import\b/.test(statement)) continue
    const key = lastSegment(specifier.value)
    const names = Option.getOrElse(Option.fromNullishOr(byTarget.get(key)), () => {
      const created = new Set<string>()
      byTarget.set(key, created)
      return created
    })
    for (const name of namedImportsIn(statement)) names.add(name)
  }
  return byTarget
}

/** What one file contributes to the whole-tree answer. */
export interface ExportFacts {
  readonly declarations: ReadonlyArray<Declaration>
  /** Every identifier the file mentions outside its comments. */
  readonly identifiers: ReadonlySet<string>
  /** Names imported from a path, keyed by that path's last segment. */
  readonly importsByTarget: ReadonlyMap<string, ReadonlySet<string>>
  /** Identifiers per line with comments and strings blanked; empty unless the file's surface reads its own references. */
  readonly identifiersByLine: ReadonlyArray<ReadonlySet<string>>
  /** Names imported through each entry-point specifier. */
  readonly imported: ReadonlyMap<string, ReadonlySet<string>>
  /**
   * Names this file binds at its own top level, exported or not, collected for
   * every tracked file rather than only for a scanned surface.
   *
   * A file that declares `isClientFile` itself does not vouch for a core export
   * of that name: its mention is its own binding. Without this, a namesake
   * anywhere in the tree — `apps/`, an example, a test helper — fakes coverage
   * for the declaration being measured.
   *
   * A name the file also imports under some spelling is left out: the import is
   * a real read of someone else's declaration, whatever the file binds beside it.
   */
  readonly localNames: ReadonlySet<string>
}

/** A top-level binding, whether or not it is exported. */
const LOCAL_BINDING =
  /^(?:export\s+)?(?:declare\s+)?(?:const|let|var|class|function|interface|type|enum)\s+([A-Za-z_$][\w$]*)/

const localNamesIn = (text: string): ReadonlySet<string> => {
  const imported = importedNames(text)
  const names = new Set<string>()
  for (const line of withoutCommentsAndStrings(text).split("\n")) {
    const name = Option.flatMap(Option.fromNullishOr(LOCAL_BINDING.exec(line)), (match) =>
      Option.fromNullishOr(match[1]),
    )
    if (Option.isSome(name) && !imported.has(name.value)) names.add(name.value)
  }
  return names
}

const declarationsIn = (surface: ScannedSurface, text: string): ReadonlyArray<Declaration> =>
  Option.match(surface.specifier, {
    onNone: () => declaredNames(text),
    onSome: () => reExportedNames(text),
  }).map((entry) => ({ ...entry, surface }))

const importsIn = (
  file: string,
  lines: ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const imported = new Map<string, ReadonlySet<string>>()
  for (const surface of SCANNED_SURFACES) {
    if (Option.isNone(surface.specifier)) continue
    if (surface.outsideOf.some((prefix) => file.startsWith(prefix))) continue
    imported.set(surface.specifier.value, importedThrough(surface.specifier.value, lines))
  }
  return imported
}

/** Read one file's declarations and the names it consumes, in a single pass. */
export const collectExportFacts = (file: string, text: string): ExportFacts => {
  const surface = surfaceOf(file)
  const declarations = Option.match(surface, {
    onNone: (): ReadonlyArray<Declaration> => [],
    onSome: (found) => declarationsIn(found, text),
  })
  const identifiersByLine = Option.match(
    Option.filter(surface, (found) => found.ownFileCounts),
    {
      onNone: (): ReadonlyArray<ReadonlySet<string>> => [],
      onSome: () => withoutCommentsAndStrings(text).split("\n").map(identifiersIn),
    },
  )
  return {
    declarations,
    identifiers: identifiersIn(withoutComments(text)),
    localNames: localNamesIn(text),
    identifiersByLine,
    importsByTarget: importsByTarget(text.split("\n")),
    imported: importsIn(file, text.split("\n")),
  }
}

const linesDeclaring = (facts: ExportFacts, name: string): ReadonlySet<number> =>
  new Set(
    facts.declarations
      .filter((declaration) => declaration.name === name)
      .map((declaration) => declaration.line),
  )

/** Whether the declaring file itself reads the name, off its declaration lines. */
const referencedInOwnFile = (facts: ExportFacts, name: string): boolean => {
  const declared = linesDeclaring(facts, name)
  return facts.identifiersByLine.some(
    (identifiers, index) => !declared.has(index + 1) && identifiers.has(name),
  )
}

const mentions = (facts: ExportFacts, surface: ScannedSurface, name: string): boolean =>
  Option.match(surface.specifier, {
    onNone: () => facts.identifiers.has(name),
    onSome: (specifier) =>
      Option.exists(Option.fromNullishOr(facts.imported.get(specifier)), (names) =>
        names.has(name),
      ),
  })

const mayConsume = (file: string, surface: ScannedSurface): boolean =>
  (surface.testsCount || !isTestSupport(file)) &&
  !surface.outsideOf.some((prefix) => file.startsWith(prefix))

/** Whether the file sits where a leaf app's names can be read: inside the app. */
const withinLeaf = (file: string, surface: ScannedSurface): boolean =>
  Option.match(Option.fromUndefinedOr(surface.leafOf), {
    onNone: () => true,
    onSome: (leaf) => file.startsWith(leaf),
  })

const messageFor = (file: string, declaration: Declaration): string =>
  Option.match(declaration.surface.specifier, {
    onNone: () => {
      if (declaration.surface.ownFileCounts) {
        return `\`${declaration.name}\` is exported but nothing names it, not even ${file} off its own declaration; delete it`
      }
      return `\`${declaration.name}\` is exported but no file outside ${file} names it; drop the \`export\` keyword, or delete it if nothing uses it at all`
    },
    onSome: (specifier) => {
      const where = declaration.surface.outsideOf
      let reach = "no importer"
      if (where.length > 0) reach = `no consumer outside ${where.join(", ")}`
      return `entry-point name "${declaration.name}" has ${reach} through ${specifier}; it is vocabulary every caller reads past. Drop it from the entry point, or ship something that uses it.`
    },
  })

/**
 * Report declared exports nothing that may consume them names.
 *
 * `factsByFile` is the whole tree's word sets, so this is one pass over
 * declarations rather than a search per name. Files that declare the same
 * name themselves never vouch for it: two modules exporting `sameName` need
 * a third file to keep either alive.
 *
 * One exception: entry points chain. `@gent/sdk` re-exports names it gets
 * from `@gent/core/protocol`, so it both declares them and consumes them.
 * A re-export that names the upstream specifier is a real consumer — the
 * blanket skip would otherwise call every chained name dead.
 */
/**
 * Whether this file imports `name` from any of the module's own import targets.
 *
 * A pass-through lives at *this* module's path, so only an import naming that
 * path keeps it alive. Mentioning the name says nothing: the file that declared
 * it answers for that.
 */
const importsFrom = (facts: ExportFacts, targets: ReadonlyArray<string>, name: string): boolean =>
  targets.some((target) =>
    Option.exists(Option.fromNullishOr(facts.importsByTarget.get(target)), (names) =>
      names.has(name),
    ),
  )

/**
 * Which files declare each name, so a peer that merely declares the same name
 * can be told apart from a real consumer. A pass-through site is not a peer
 * declaration: it names the upstream declaration and keeps vouching for it.
 */
const filesDeclaringEachName = (
  factsByFile: ReadonlyMap<string, ExportFacts>,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const declaringFiles = new Map<string, Set<string>>()
  for (const [file, facts] of factsByFile) {
    for (const { name, passthrough } of facts.declarations) {
      if (passthrough === true) continue
      const files = Option.getOrElse(Option.fromNullishOr(declaringFiles.get(name)), () => {
        const created = new Set<string>()
        declaringFiles.set(name, created)
        return created
      })
      files.add(file)
    }
  }
  return declaringFiles
}

/**
 * Whether a mentioning file names its own binding rather than this declaration.
 *
 * Two files can export the same name; neither keeps the other alive. Only
 * an entry point's own specifier makes the mention a real read, and a file
 * outside every scanned surface has no `declarations`, so its top-level
 * bindings answer instead.
 */
const isNamesake = (
  candidate: string,
  facts: ExportFacts,
  declaration: Declaration,
  declaredIn: ReadonlySet<string>,
  targets: ReadonlyArray<string>,
): boolean => {
  if (Option.isSome(declaration.surface.specifier)) return false
  // A file that imports from the declaring module reads it, under an alias or
  // a namespace if not by name, whatever it binds beside the import.
  if (targets.some((target) => facts.importsByTarget.has(target))) return false
  // An entry import names the declaration, whatever local alias it binds; a
  // local namesake beside `import { zeta as _zeta }` does not undo that read.
  if ([...facts.imported.values()].some((names) => names.has(declaration.name))) return false
  return declaredIn.has(candidate) || facts.localNames.has(declaration.name)
}

export const findUnconsumedExports = (
  factsByFile: ReadonlyMap<string, ExportFacts>,
): ReadonlyArray<Finding> => {
  const declaringFiles = filesDeclaringEachName(factsByFile)

  const isConsumed = (file: string, declaration: Declaration): boolean => {
    const declaredIn = Option.getOrElse(
      Option.fromNullishOr(declaringFiles.get(declaration.name)),
      () => new Set<string>(),
    )
    const targets = importTargetsOf(file)
    for (const [candidate, facts] of factsByFile) {
      if (!mayConsume(candidate, declaration.surface)) continue
      if (!withinLeaf(candidate, declaration.surface)) continue
      // The file being measured never vouches for its own export; whether its
      // own references count at all is the `ownFileCounts` rule below.
      if (candidate === file && Option.isNone(declaration.surface.specifier)) continue
      if (declaration.passthrough === true) {
        if (!importsFrom(facts, targets, declaration.name)) continue
        return true
      }
      if (!mentions(facts, declaration.surface, declaration.name)) continue
      if (isNamesake(candidate, facts, declaration, declaredIn, targets)) continue
      return true
    }
    if (!declaration.surface.ownFileCounts) return false
    return Option.exists(Option.fromNullishOr(factsByFile.get(file)), (facts) =>
      referencedInOwnFile(facts, declaration.name),
    )
  }

  const findings: Array<Finding> = []
  for (const [file, facts] of factsByFile) {
    const reported = new Set<string>()
    for (const declaration of facts.declarations) {
      if (isConsumed(file, declaration)) continue
      if (Option.isSome(declaration.surface.specifier)) {
        if (reported.has(declaration.name)) continue
        reported.add(declaration.name)
      }
      findings.push({
        file,
        line: declaration.line,
        message: messageFor(file, declaration),
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// Package entry points
// ---------------------------------------------------------------------------

const DependencyMap = Schema.Record(Schema.String, Schema.String)

/** The workspace manifest fields the package-surface and dependency checks read. */
export const PackageJsonSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  private: Schema.optional(Schema.Boolean),
  exports: Schema.optional(DependencyMap),
  workspaces: Schema.optional(Schema.Array(Schema.String)),
  scripts: Schema.optional(DependencyMap),
  dependencies: Schema.optional(DependencyMap),
  devDependencies: Schema.optional(DependencyMap),
  optionalDependencies: Schema.optional(DependencyMap),
  peerDependencies: Schema.optional(DependencyMap),
  /** The root's shared versions; a manifest takes one with `"catalog:"`. */
  catalog: Schema.optional(DependencyMap),
  /** The root's forced versions for transitive installs. */
  overrides: Schema.optional(DependencyMap),
  /** The root's patches, keyed `name@version`. */
  patchedDependencies: Schema.optional(DependencyMap),
})
export type PackageJson = typeof PackageJsonSchema.Type

/** The tsconfig fields the paths and dependency checks read. */
export const TsConfigSchema = Schema.Struct({
  compilerOptions: Schema.optional(
    Schema.Struct({
      paths: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
      types: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
})
export type TsConfigJson = typeof TsConfigSchema.Type

/** One workspace package, the entry points it exposes, and whether it must stay private. */
interface PackageSurface {
  readonly packageJson: string
  readonly alias: string
  readonly mustBePrivate: boolean
  /** The `exports` keys the package carries, every one of them and no other. */
  readonly entryPoints: ReadonlyArray<string>
}

/**
 * Every workspace package has a row, so an `exports` map added anywhere is
 * checked. Core's public entry points follow their audience. Two authoring
 * surfaces are deliberately split: `extensions/api` for extensions that use
 * the loop, `extensions/branch-tools` for the rarer feature that implements a
 * loop seam. Keeping them apart is what keeps `api` small. `protocol` serves
 * clients, `host` serves the processes that compose a server, and
 * `test-utils` serves tests. `@gent/extensions` is the builtin composition
 * package and exposes only its root and `./client`; `@gent/sdk` exposes the
 * stable root client contract and nothing else. `@gent/tui` is the terminal
 * app; its one entry, `./extensions`, is the client-extension authoring
 * surface. The server app, the e2e harness, the tooling and the examples are
 * leaves: nothing imports them, so they expose nothing.
 */
const PACKAGE_SURFACES: ReadonlyArray<PackageSurface> = [
  {
    packageJson: "packages/core/package.json",
    alias: "@gent/core",
    mustBePrivate: false,
    entryPoints: [
      "./extensions/api",
      "./extensions/branch-tools",
      "./host",
      "./protocol",
      "./test-utils",
    ],
  },
  {
    packageJson: "packages/extensions/package.json",
    alias: "@gent/extensions",
    mustBePrivate: true,
    entryPoints: [".", "./client"],
  },
  {
    packageJson: "packages/sdk/package.json",
    alias: "@gent/sdk",
    mustBePrivate: false,
    entryPoints: ["."],
  },
  {
    packageJson: "apps/tui/package.json",
    alias: "@gent/tui",
    mustBePrivate: false,
    entryPoints: ["./extensions"],
  },
  {
    packageJson: "apps/server/package.json",
    alias: "@gent/server-http",
    mustBePrivate: false,
    entryPoints: [],
  },
  {
    packageJson: "packages/e2e/package.json",
    alias: "@gent/e2e",
    mustBePrivate: true,
    entryPoints: [],
  },
  {
    packageJson: "packages/tooling/package.json",
    alias: "@gent/tooling",
    mustBePrivate: true,
    entryPoints: [],
  },
  {
    packageJson: "examples/package.json",
    alias: "@gent/examples",
    mustBePrivate: true,
    entryPoints: [],
  },
]

/**
 * The manifest of every workspace package: each `workspaces` pattern of the
 * root manifest (a directory, or a directory with one `*` segment) joined to
 * `package.json`, matched against the tracked files.
 */
export const workspaceManifests = (
  workspaces: ReadonlyArray<string>,
  trackedFiles: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const patterns = workspaces.map(
    (workspace) =>
      new RegExp(
        `^${workspace.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]+")}/package\\.json$`,
      ),
  )
  return trackedFiles.filter((file) => patterns.some((pattern) => pattern.test(file)))
}

const packageFindings = (
  surface: PackageSurface,
  packageJson: PackageJson,
): ReadonlyArray<Finding> => {
  const findings: Array<Finding> = []
  if (packageJson.name !== surface.alias) {
    findings.push({
      file: surface.packageJson,
      line: 1,
      message: `name: the package is ${Option.getOrElse(Option.fromNullishOr(packageJson.name), () => "unnamed")}, its package-surface row names ${surface.alias}; make them agree`,
    })
  }
  if (surface.mustBePrivate && packageJson.private !== true) {
    findings.push({
      file: surface.packageJson,
      line: 1,
      message: `private: ${surface.alias} must stay private; it is not a published contract`,
    })
  }
  const allowed = new Set(surface.entryPoints)
  const exported = Object.keys(
    Option.getOrElse(Option.fromNullishOr(packageJson.exports), () => ({})),
  )
  for (const key of exported) {
    if (allowed.has(key)) continue
    const supported = surface.entryPoints.join(", ") || "none"
    findings.push({
      file: surface.packageJson,
      line: 1,
      message: `exports["${key}"]: ${surface.alias} may only expose its supported entry points: ${supported}`,
    })
  }
  for (const entryPoint of surface.entryPoints) {
    if (exported.includes(entryPoint)) continue
    findings.push({
      file: surface.packageJson,
      line: 1,
      message: `exports["${entryPoint}"] is missing: the package-surface row for ${surface.alias} names it; export it, or drop it from the row`,
    })
  }
  return findings
}

/**
 * `@gent/*` resolves one way: through each package's `exports`, which the
 * rows above check. A `paths` alias is a second resolution TypeScript alone
 * reads, so it could publish a module the `exports` check never sees. Every
 * tsconfig counts: a package tsconfig that sets `paths` replaces the root's.
 */
const pathFindings = (tsconfigs: ReadonlyMap<string, TsConfigJson>): ReadonlyArray<Finding> =>
  [...tsconfigs].flatMap(([file, tsconfig]) =>
    Object.keys(tsconfig.compilerOptions?.paths ?? {}).map((key) => ({
      file,
      line: 1,
      message: `compilerOptions.paths["${key}"]: workspace packages resolve through their package.json exports; drop the alias`,
    })),
  )

/**
 * The tsconfigs the paths check reads: every tracked one except the fixtures,
 * which are apps and lint subjects of their own, not workspace resolution.
 */
export const workspaceTsconfigs = (trackedFiles: ReadonlyArray<string>): ReadonlyArray<string> =>
  trackedFiles.filter(
    (file) => /(?:^|\/)tsconfig\.json$/.test(file) && !/(?:^|\/)fixtures?\//.test(file),
  )

/**
 * Check every workspace manifest against its row. `packageJsons` holds every
 * workspace manifest by path: one with no row is reported, and so is a row
 * with no manifest.
 */
export const findPackageSurfaceFindings = (
  packageJsons: ReadonlyMap<string, PackageJson>,
  tsconfigs: ReadonlyMap<string, TsConfigJson>,
): ReadonlyArray<Finding> => {
  const rows = new Set(PACKAGE_SURFACES.map((surface) => surface.packageJson))
  const unlisted = [...packageJsons.keys()]
    .filter((file) => !rows.has(file))
    .map((file) => ({
      file,
      line: 1,
      message: `a workspace package with no package-surface row in guards.ts; add one naming its entry points (none for a leaf)`,
    }))
  const checked = PACKAGE_SURFACES.flatMap((surface) =>
    Option.match(Option.fromNullishOr(packageJsons.get(surface.packageJson)), {
      onNone: (): ReadonlyArray<Finding> => [
        {
          file: "packages/tooling/src/guards.ts",
          line: 1,
          message: `package-surface row ${surface.packageJson} names no workspace package; drop the row`,
        },
      ],
      onSome: (packageJson) => packageFindings(surface, packageJson),
    }),
  )
  return [...unlisted, ...checked, ...pathFindings(tsconfigs)]
}

// ---------------------------------------------------------------------------
// Declared dependencies
// ---------------------------------------------------------------------------

/** The installed manifest fields that say what a dependency offers. */
export const InstalledPackageSchema = Schema.Struct({
  bin: Schema.optional(Schema.Union([Schema.String, DependencyMap])),
  peerDependencies: Schema.optional(DependencyMap),
})
export type InstalledPackage = typeof InstalledPackageSchema.Type

/** What an installed dependency offers: the commands it puts on PATH and the peers it asks for. */
export interface InstalledDependency {
  readonly bins: ReadonlyArray<string>
  readonly peers: ReadonlyArray<string>
}

const isBinPath = Schema.is(Schema.String)

/** Read an installed manifest; a string `bin` is one command named after the package. */
export const installedDependency = (
  name: string,
  installed: InstalledPackage,
): InstalledDependency => {
  const bins = Option.match(Option.fromNullishOr(installed.bin), {
    onNone: (): ReadonlyArray<string> => [],
    onSome: (bin) => {
      if (isBinPath(bin)) return name.split("/").slice(-1)
      return Object.keys(bin)
    },
  })
  return { bins, peers: Object.keys(installed.peerDependencies ?? {}) }
}

/** One manifest the dependency check reads, and what its dependencies serve. */
export interface DependencyScope {
  readonly manifest: string
  readonly manifestText: string
  readonly packageJson: PackageJson
  /**
   * The tracked files the dependencies serve: the workspace directory, or the
   * whole tree for the root manifest, whose dependencies every package reaches.
   */
  readonly files: ReadonlyMap<string, string>
  /** The command lines that can run a dependency: package scripts, hooks, CI steps. */
  readonly commands: ReadonlyArray<string>
  /** Each declared dependency (peers included) whose installed manifest could be read. */
  readonly installed: ReadonlyMap<string, InstalledDependency>
}

/** The package a module specifier resolves into; a relative path names none. */
const packageOfSpecifier = (specifier: string): Option.Option<string> => {
  if (specifier === "bun" || specifier.startsWith("bun:")) return Option.some("bun")
  if (specifier.startsWith("node:")) return Option.some("node")
  if (!/^(?:@[\w.-]+\/)?[\w.-]+(?:\/|$)/.test(specifier)) return Option.none()
  const segments = specifier.split("/")
  if (specifier.startsWith("@")) return Option.some(segments.slice(0, 2).join("/"))
  return Option.some(segments.slice(0, 1).join("/"))
}

/** A module a source file loads: `import`, `export … from`, `import()`, `require()`. */
const SOURCE_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bmock\.module\s*\(\s*)["']([^"'\s]+)["']/g
/** A triple-slash types reference: a comment by syntax, a load by meaning. */
const TYPES_REFERENCE = /^\s*\/\/\/\s*<reference\s+types=["']([^"'\s]+)["']/gm
/** A quoted string in a config file (tsconfig `types`, bunfig `preload`, a lint plugin). */
const CONFIG_STRING = /["']([^"'\s]+)["']/g

/** Blank each `#` comment (YAML, TOML, a shell line) that starts outside a quoted string. */
const withoutHashComments = (text: string): string =>
  text
    .split("\n")
    .map((line) => {
      let quote = ""
      for (const [index, char] of [...line].entries()) {
        if (quote !== "") {
          if (char === quote) quote = ""
          continue
        }
        if (char === '"' || char === "'") quote = char
        if (char === "#" && (index === 0 || /\s/.test(line.charAt(index - 1)))) {
          return line.slice(0, index)
        }
      }
      return line
    })
    .join("\n")

const matchedGroups = (text: string, pattern: RegExp): ReadonlyArray<string> =>
  [...text.matchAll(pattern)].map((match) => match[1] ?? "")

/**
 * The module specifiers a file loads or names, read with its comments blanked
 * so a commented-out import keeps nothing alive. A manifest names its own
 * dependencies as keys; only its scripts count, as commands.
 */
const specifiersIn = (file: string, text: string): ReadonlyArray<string> => {
  if (/\.[cm]?[jt]sx?$/.test(file)) {
    return [
      ...matchedGroups(withoutComments(text), SOURCE_SPECIFIER),
      ...matchedGroups(text, TYPES_REFERENCE),
    ]
  }
  if (/(?:^|\/)package\.json$/.test(file)) return []
  if (/\.jsonc?$/.test(file)) return matchedGroups(withoutComments(text), CONFIG_STRING)
  if (/\.(?:toml|ya?ml)$/.test(file)) return matchedGroups(withoutHashComments(text), CONFIG_STRING)
  return []
}

const commandWords = (command: string): ReadonlyArray<string> =>
  withoutHashComments(command)
    .split(/[\s"'\\;&|()]+/)
    .filter((word) => word.length > 0)

/** Every package the scope's files load or name. */
const namedPackages = (scope: DependencyScope): ReadonlySet<string> => {
  const specifiers = [...scope.files].flatMap(([file, text]) => specifiersIn(file, text))
  // A command word can be a module too: `bun --preload @opentui/solid/preload`.
  return new Set(
    [...specifiers, ...scope.commands.flatMap(commandWords)].flatMap((specifier) =>
      Option.toArray(packageOfSpecifier(specifier)),
    ),
  )
}

/** `@types/x` types `x`; `@types/a__b` types `@a/b`. */
const typedPackage = (dependency: string): Option.Option<string> => {
  if (!dependency.startsWith("@types/")) return Option.none()
  const typed = dependency.slice("@types/".length)
  if (typed.includes("__")) return Option.some(`@${typed.replace("__", "/")}`)
  return Option.some(typed)
}

type DependencyField =
  | "dependencies"
  | "devDependencies"
  | "optionalDependencies"
  | "peerDependencies"
const DEPENDENCY_FIELDS: ReadonlyArray<DependencyField> = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]

interface ScopeUse {
  readonly declared: ReadonlyArray<{ readonly field: DependencyField; readonly name: string }>
  readonly used: ReadonlySet<string>
  /** The peers the scope needs installed: its used peers and every peer its used dependencies ask for. */
  readonly peers: ReadonlySet<string>
}

/** The declared dependencies of one scope, the ones it uses, and the peers it needs. */
const scopeUse = (scope: DependencyScope, providedPeers: ReadonlySet<string>): ScopeUse => {
  const declared = DEPENDENCY_FIELDS.flatMap((field) =>
    Object.keys(scope.packageJson[field] ?? {}).map((name) => ({ field, name })),
  )
  const named = namedPackages(scope)
  const words = new Set(scope.commands.flatMap(commandWords))
  const installed = (name: string) => Option.fromNullishOr(scope.installed.get(name))
  const used = new Set(
    declared
      .map(({ name }) => name)
      .filter(
        (name) =>
          named.has(name) ||
          providedPeers.has(name) ||
          Option.exists(installed(name), ({ bins }) => bins.some((bin) => words.has(bin))) ||
          Option.exists(typedPackage(name), (typed) => named.has(typed)),
      ),
  )
  const peers = new Set(
    Object.keys(scope.packageJson.peerDependencies ?? {}).filter((name) => used.has(name)),
  )
  // A peer of a used dependency is used through it; follow the chain.
  const frontier = [...used]
  while (frontier.length > 0) {
    const asked = Option.match(installed(frontier.pop() ?? ""), {
      onNone: (): ReadonlyArray<string> => [],
      onSome: (dependency) => dependency.peers,
    })
    for (const peer of asked) {
      peers.add(peer)
      if (used.has(peer)) continue
      used.add(peer)
      frontier.push(peer)
    }
  }
  return { declared, used, peers }
}

const unusedFindings = (scope: DependencyScope, use: ScopeUse): ReadonlyArray<Finding> => {
  const lines = scope.manifestText.split("\n")
  return use.declared
    .filter(({ name }) => !use.used.has(name))
    .map(({ field, name }) => ({
      file: scope.manifest,
      line: lines.findIndex((line) => line.includes(`"${name}":`)) + 1 || 1,
      message: `${field}["${name}"]: nothing in this package loads it, runs its command or names it in a config; drop it`,
    }))
}

/**
 * A declared dependency nothing uses is dead weight that installs, resolves
 * and audits forever, and nothing else notices it (pass 3 dropped a set once,
 * pass 14 four more, pass 15 a dead peer). A dependency is used when a file
 * in its scope loads or names it, a command runs one of its binaries, it
 * types a used package (`@types/x`), or it is a peer of a used dependency (a
 * workspace dependency's peers included). Peers are checked the same way: a
 * dead peer would keep the root's copy and its catalog entry alive. The root
 * installs the peers the workspaces need (declared or asked for by a used
 * dependency), and only those.
 */
export const findUnusedDependencies = (input: {
  readonly root: DependencyScope
  readonly workspaces: ReadonlyArray<DependencyScope>
}): ReadonlyArray<Finding> => {
  const workspaceUses = input.workspaces.map((scope) => ({
    scope,
    use: scopeUse(scope, new Set()),
  }))
  const providedPeers = new Set(workspaceUses.flatMap(({ use }) => [...use.peers]))
  return [
    ...unusedFindings(input.root, scopeUse(input.root, providedPeers)),
    ...workspaceUses.flatMap(({ scope, use }) => unusedFindings(scope, use)),
  ]
}

/** A catalog version no manifest takes with `"catalog:"` pins a package nothing installs. */
export const findUnusedCatalogEntries = (
  root: { readonly manifest: string; readonly text: string; readonly packageJson: PackageJson },
  manifests: ReadonlyArray<PackageJson>,
): ReadonlyArray<Finding> => {
  const taken = new Set(
    [root.packageJson, ...manifests].flatMap((manifest) =>
      DEPENDENCY_FIELDS.map((field) => manifest[field])
        .flatMap((versions) => Object.entries(versions ?? {}))
        .filter(([, version]) => version.startsWith("catalog:"))
        .map(([name]) => name),
    ),
  )
  const lines = root.text.split("\n")
  const catalogStart = lines.findIndex((line) => line.includes(`"catalog": {`))
  return Object.keys(root.packageJson.catalog ?? {})
    .filter((name) => !taken.has(name))
    .map((name) => {
      const index = lines.findIndex((line, at) => at > catalogStart && line.includes(`"${name}":`))
      return {
        file: root.manifest,
        line: index + 1 || 1,
        message: `catalog["${name}"]: no manifest takes it with "catalog:"; drop it`,
      }
    })
}

/**
 * The Effect packages release together: `effect` and every `@effect/*` package
 * with the same version. Three root blocks pin them (`catalog`, `overrides`
 * and the `patchedDependencies` keys), and a manifest that names one with a
 * literal version is a fourth. A bump that misses one installs two copies of
 * `effect`, whose Tags and Schema classes do not match, or leaves a patch
 * that no longer applies. Every pin must equal `catalog.effect`, and every
 * manifest takes an Effect package with `"catalog:"`. The packages listed in
 * `EFFECT_OWN_VERSIONS` follow their own release line.
 */
const EFFECT_OWN_VERSIONS: ReadonlySet<string> = new Set([
  "@effect/tsgo",
  "@effect/language-service",
])

const isEffectPackage = (name: string): boolean =>
  (name === "effect" || name.startsWith("@effect/")) && !EFFECT_OWN_VERSIONS.has(name)

/** A patch key's package name and the one version it patches. */
interface PatchKey {
  readonly name: string
  readonly version: string
}

/** A `name@version` patch key as its parts; the name may itself start with `@`. */
const patchKeyParts = (key: string): PatchKey => {
  const at = key.lastIndexOf("@")
  if (at <= 0) return { name: key, version: "" }
  return { name: key.slice(0, at), version: key.slice(at + 1) }
}

/** The line of `needle` inside the block that opens with `"<block>": {`, or 1. */
const lineInBlock = (text: string, block: string, needle: string): number => {
  const lines = text.split("\n")
  const start = lines.findIndex((line) => line.includes(`"${block}": {`))
  return lines.findIndex((line, at) => at > start && line.includes(needle)) + 1 || 1
}

interface ManifestText {
  readonly manifest: string
  readonly text: string
  readonly packageJson: PackageJson
}

/** One exact semver version, with optional prerelease and build parts. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** The root blocks that map a package name to a version. */
const PIN_BLOCKS: ReadonlyArray<"catalog" | "overrides"> = ["catalog", "overrides"]

/** One version pin in a root block, with the text that places its line. */
interface EffectPin {
  readonly block: string
  readonly name: string
  readonly pinned: string
  readonly needle: string
}

export const findEffectVersionDrift = (
  root: ManifestText,
  manifests: ReadonlyArray<ManifestText>,
): ReadonlyArray<Finding> => {
  const expected = Option.fromNullishOr(root.packageJson.catalog?.["effect"])
  if (Option.isNone(expected)) {
    return [
      {
        file: root.manifest,
        line: 1,
        message: `catalog["effect"] is missing; the Effect pins have no version to agree on`,
      },
    ]
  }
  const version = expected.value
  if (!EXACT_VERSION.test(version)) {
    return [
      {
        file: root.manifest,
        line: lineInBlock(root.text, "catalog", '"effect":'),
        message: `catalog["effect"] is "${version}", not an exact version; a range, tag or catalog reference lets the install pick a version the patches and pins do not name`,
      },
    ]
  }
  const pins: ReadonlyArray<EffectPin> = [
    ...PIN_BLOCKS.flatMap((block) =>
      Object.entries(root.packageJson[block] ?? {}).map(([name, pinned]) => ({
        block,
        name,
        pinned,
        needle: `"${name}":`,
      })),
    ),
    ...Object.keys(root.packageJson.patchedDependencies ?? {}).map((key) => {
      const parts = patchKeyParts(key)
      return {
        block: "patchedDependencies",
        name: parts.name,
        pinned: parts.version,
        needle: `"${key}":`,
      }
    }),
  ]
  const drift = pins
    .filter((pin) => isEffectPackage(pin.name) && pin.pinned !== version)
    .map((pin) => ({
      file: root.manifest,
      line: lineInBlock(root.text, pin.block, pin.needle),
      message: `${pin.block}["${pin.name}"] pins ${pin.pinned}, but catalog["effect"] is ${version}; the Effect packages release together, so pin every one at ${version}`,
    }))
  const literals = [root, ...manifests].flatMap((read) =>
    DEPENDENCY_FIELDS.flatMap((field) =>
      Object.entries(read.packageJson[field] ?? {})
        .filter(([name, spec]) => isEffectPackage(name) && !spec.startsWith("catalog:"))
        .map(([name, spec]) => ({
          file: read.manifest,
          line: lineInBlock(read.text, field, `"${name}":`),
          message: `${field}["${name}"] is the literal "${spec}"; take it with "catalog:" so the Effect version has one owner`,
        })),
    ),
  )
  return [...drift, ...literals]
}
