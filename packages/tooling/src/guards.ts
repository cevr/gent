import { Option, Schema } from "effect"

// ── blanket-eslint-disable ──────────────────────────────────────────────────

export interface BlanketDisableFinding {
  readonly file: string
  readonly line: number
}

/**
 * oxlint honors both spellings, `eslint-disable` and `oxlint-disable`, so each
 * pattern matches both. A blanket directive names no rule; a block directive
 * disables its rules to the end of the file or the next enable.
 */
export const blanketDisableDirective =
  /(?:\/\*\s*(?:es|ox)lint-disable(?:-next-line|-line)?\s*(?:\*\/|--|$))|(?:\/\/\s*(?:es|ox)lint-disable(?:-next-line|-line)?\s*(?:--|$))/

export const blockDisableDirective = /\/\*\s*(?:es|ox)lint-disable(?:\s|$)/

const fixtureFilePattern = /(?:^|\/)(?:fixtures?|__fixtures__)(?:\/|\.|\b)/

const isExplicitFixtureFile = (file: string): boolean => fixtureFilePattern.test(file)

export const findBlanketEslintDisables = (
  file: string,
  text: string,
): ReadonlyArray<BlanketDisableFinding> => {
  const findings: BlanketDisableFinding[] = []
  const lines = text.split("\n")
  for (let index = 0; index < lines.length; index++) {
    if (blanketDisableDirective.test(lines[index] ?? "")) {
      findings.push({ file, line: index + 1 })
    }
  }
  return findings
}

export const findBannedEslintDisableBlocks = (
  file: string,
  text: string,
): ReadonlyArray<BlanketDisableFinding> => {
  if (isExplicitFixtureFile(file)) return []
  const findings: BlanketDisableFinding[] = []
  const lines = text.split("\n")
  for (let index = 0; index < lines.length; index++) {
    if (blockDisableDirective.test(lines[index] ?? "")) {
      findings.push({ file, line: index + 1 })
    }
  }
  return findings
}

// ── core-alias-test-layers ──────────────────────────────────────────────────

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

/** An alternative layer static that is an alias of the same service's `Live`. */
export interface AliasTestLayerFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

/**
 * Shipped source, the same reading `core-retired-reconciler` uses.
 *
 * The rule this guard enforces is a project rule, not a core rule: a service
 * in the TUI earns a `Test` layer on the same terms as a service in core. A
 * `packages/`-only prefix left `apps/tui/src/services/` outside the question
 * entirely. The two guards that do pin `packages/core/src/` -- feature
 * independence, vendor model pins -- are scoped that way because what they
 * forbid is core reaching outward; nothing about an alias is core-specific.
 */
const SHIPPED_SOURCE = /^(?:packages|apps)\/[^/]+\/(?:[^/]+\/)*src\//

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
  if (!SHIPPED_SOURCE.test(file)) return []

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

// ── core-child-session-depth ────────────────────────────────────────────────

/**
 * Guard: every child-session writer in core admits the nesting depth.
 *
 * `DEFAULT_MAX_AGENT_RUN_DEPTH` is enforced in one place,
 * `admitChildSessionDepth` (`packages/core/src/runtime/session.ts`).
 * A file that builds a `new Session({ ... parentSessionId: ... })` row is a
 * child-session writer and must call that admission, or a new writer (the
 * compaction handoff once did) nests sessions without bound.
 *
 * Storage readers rebuild rows from the database and test fixtures seed
 * chains on purpose; both are outside the rule.
 *
 * @module
 */

export interface ChildSessionDepthFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

const CORE_SRC = "packages/core/src/"
const EXEMPT_PREFIXES = [`${CORE_SRC}storage/`, `${CORE_SRC}test-utils/`]
const SHARED_CHECK = "admitChildSessionDepth"
const SESSION_LITERAL = /new Session\(\{/g
const SHARED_CHECK_CALL = new RegExp(`\\b${SHARED_CHECK}\\(`)
const TOP_LEVEL_DECLARATION = /(?:^|\n)(?:export\s+)?(?:const|let|function|class)\s/g

/** Offset of the last column-0 declaration head in `text`, or 0. */
const lastDeclarationStart = (text: string): number => {
  let start = 0
  for (const match of text.matchAll(TOP_LEVEL_DECLARATION)) start = match.index
  return start
}

/** Report `new Session({...parentSessionId...})` in a core file that never admits depth. */
export const findUnadmittedChildSessionWriters = (
  file: string,
  text: string,
): ReadonlyArray<ChildSessionDepthFinding> => {
  if (!file.startsWith(CORE_SRC)) return []
  if (EXEMPT_PREFIXES.some((prefix) => file.startsWith(prefix))) return []

  const findings: ChildSessionDepthFinding[] = []
  for (const match of text.matchAll(SESSION_LITERAL)) {
    const start = match.index
    const end = text.indexOf("})", start)
    if (end === -1) continue
    const literal = text.slice(start, end)
    if (!/\bparentSessionId:/.test(literal)) continue
    // The admission must run before the write, in the same top-level
    // declaration. A whole-file escape let one admission anywhere in a
    // 700-line file cover every writer in it.
    const before = text.slice(0, start)
    if (SHARED_CHECK_CALL.test(before.slice(lastDeclarationStart(before)))) continue
    findings.push({
      file,
      line: text.slice(0, start).split("\n").length,
      message: `child-session writer never calls \`${SHARED_CHECK}\`; every \`parentSessionId\` writer admits the nesting cap through \`runtime/session.ts\``,
    })
  }
  return findings
}

// ── core-feature-independence ───────────────────────────────────────────────

/**
 * Guard: core must not name the features built on top of it.
 *
 * Core is the loop. A feature such as the code cell is an extension of the
 * loop, so core carries it through agnostic seams -- `BranchToolFeature`,
 * `ToolCallRecoveryService`, `ModelContextCompactor` -- and never imports it.
 *
 * No site is exempt. Core takes a `BranchToolFeature` as input, and every
 * composition root that names a concrete one -- `apps/server`, the SDK, the
 * test harnesses -- lives outside core.
 *
 * The same rule holds for a feature's data. A model catalog host belongs to
 * the driver that lists those models, so core must not name one.
 *
 * @module
 */

/** A core source file that imports a feature directory it must not know about. */
export interface FeatureIndependenceFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

/** Feature directories under `packages/core/src` that core proper must not import. */
export const FEATURE_DIRECTORIES: ReadonlyArray<string> = ["cell"]

/**
 * SQL table-name prefixes owned by a feature.
 *
 * Core's migration chain builds the kernel's tables. A feature contributes the
 * migrations for its own tables at the same seam it contributes its
 * repositories, so a core source file naming one of these is core reaching
 * back into a feature it should not know about.
 */
export const FEATURE_TABLE_PREFIXES: ReadonlyArray<string> = ["cell_"]

/**
 * Network hosts owned by a catalog feature, not by the kernel.
 *
 * Core resolves a model through the driver seam. The catalog behind a driver
 * -- where its model list comes from, how it is cached, when it refreshes --
 * belongs to the driver's extension. A core source file that names one of
 * these hosts is core fetching a feature's data itself.
 */
export const FEATURE_HOSTS: ReadonlyArray<string> = ["models.dev"]

/**
 * Files allowed to import a feature. Empty, and meant to stay so: a core file
 * that needs a concrete feature should take it as input. Kept as a seam so
 * adding an exemption is a deliberate, reviewed edit rather than a silent one.
 */
export const ASSEMBLY_SITES: ReadonlyArray<string> = []

const CORE_SRC_PREFIX = "packages/core/src/"

const IMPORT_PATTERN = /^\s*(?:import|export)\b[^"']*from\s*["']([^"']+)["']/

/** A feature-owned table named as a SQL identifier, not merely as a substring. */
const TABLE_PATTERN = (prefix: string) => new RegExp(`\\b${prefix}[a-z_]+\\b`)

/**
 * Find every import in `file` that reaches into a feature directory it is not
 * allowed to know about.
 *
 * Returns nothing for files outside core, for a feature's own sources, and for
 * the assembly sites.
 */
export const findCoreFeatureIndependenceFindings = (
  file: string,
  text: string,
): ReadonlyArray<FeatureIndependenceFinding> => {
  if (!file.startsWith(CORE_SRC_PREFIX)) return []
  if (ASSEMBLY_SITES.includes(file)) return []
  const ownSegments = file.slice(CORE_SRC_PREFIX.length).split("/")
  if (FEATURE_DIRECTORIES.some((feature) => ownSegments.includes(feature))) return []

  const findings: Array<FeatureIndependenceFinding> = []
  for (const [index, line] of text.split("\n").entries()) {
    const specifier = Option.flatMap(Option.fromNullishOr(IMPORT_PATTERN.exec(line)), (match) =>
      Option.fromNullishOr(match[1]),
    )
    if (Option.isNone(specifier)) continue
    const segments = specifier.value.split("/")
    const named = Option.fromNullishOr(
      FEATURE_DIRECTORIES.find((feature) => segments.includes(feature)),
    )
    if (Option.isNone(named)) continue
    findings.push({
      file,
      line: index + 1,
      message: `core must not import the "${named.value}" feature (${specifier.value}); carry it through an agnostic seam, or add this file to ASSEMBLY_SITES if it assembles an application`,
    })
  }

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

// ── core-identity-encode ────────────────────────────────────────────────────

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

export interface IdentityEncodeFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

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

export const findIdentityEncodes = (
  file: string,
  text: string,
): ReadonlyArray<IdentityEncodeFinding> => {
  if (!SHIPPED_SOURCE.test(file)) return []
  if (file === "packages/tooling/src/guards.ts") return []

  const lines = text.split("\n")
  const encoders: string[] = []
  for (const line of lines) {
    const binding = Option.fromNullishOr(ENCODER_BINDING.exec(line))
    if (Option.isNone(binding)) continue
    const name = Option.getOrElse(Option.fromNullishOr(binding.value[1]), () => "")
    if (name.length > 0) encoders.push(name)
  }
  if (encoders.length === 0) return []

  const findings: IdentityEncodeFinding[] = []
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

// ── core-unadapted-seams ────────────────────────────────────────────────────

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

// ── core-vendor-model-pins ──────────────────────────────────────────────────

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

/** A core source file that pins a vendor model SKU. */
export interface VendorModelPinFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

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
export const findCoreVendorModelPins = (
  file: string,
  text: string,
): ReadonlyArray<VendorModelPinFinding> => {
  if (!file.startsWith(CORE_SRC_PREFIX)) return []
  if (file === DECLARATION_SITE) return []

  const findings: VendorModelPinFinding[] = []
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

// ── e2e-fixture-imports ─────────────────────────────────────────────────────

/**
 * Guard: every e2e test file drives a subprocess.
 *
 * `packages/e2e` holds the tests that need process isolation: a PTY-hosted
 * TUI or a spawned `gent` server. A test file there that imports neither
 * fixture runs in-process inside the slow suite, and belongs in the owning
 * package's `tests/` directory instead.
 */
export interface E2eFixtureImportFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

const E2E_TEST_FILE = /^packages\/e2e\/tests\/.*\.test\.ts$/

/** An `import` whose module path is one of the two subprocess fixtures. */
const FIXTURE_IMPORT =
  /^[ \t]*import\b[^"']*["']\.\.\/src\/(?:server-process-fixture|pty-fixture)(?:\.js)?["']/m

export const findE2eFixtureImportFindings = (
  file: string,
  text: string,
): ReadonlyArray<E2eFixtureImportFinding> => {
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

// ── hook-runs-guards ────────────────────────────────────────────────────────

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

export interface HookRunsGuardsFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

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

export const findHookWithoutGuards = (
  file: string,
  text: string,
): ReadonlyArray<HookRunsGuardsFinding> => {
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

// ── lint-config-guards ──────────────────────────────────────────────────────

/**
 * Guards: the lint config and the environment must not name things that are gone.
 *
 * Three findings, all of the same shape -- a declaration whose subject left the
 * tree, which stays green because nothing ever reads it again:
 *
 * - An `.oxlintrc.json` override whose `files` glob matches no tracked file.
 *   The override for `packages/sdk/src/supervisor.ts` outlived that file and
 *   kept turning a rule off for nothing.
 * - A `tsconfig.locks.json` include that names no tracked file. Two deleted
 *   test files kept their entries; `tsc` never complained.
 * - A rule defined under `lint/` that the root config never enables. Five such
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

export interface LintConfigFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

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
    Schema.Array(Schema.Struct({ files: Schema.optional(Schema.Array(Schema.String)) })),
  ),
  /** Rule names only; the severity values are the caller's business. */
  rules: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

export type OxlintConfig = typeof OxlintConfigSchema.Type

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
): ReadonlyArray<LintConfigFinding> => {
  const findings: Array<LintConfigFinding> = []
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

/** The `include` list of a `tsconfig.locks.json`; the rest passes through. */
export const LocksTsconfigSchema = Schema.Struct({
  include: Schema.optional(Schema.Array(Schema.String)),
})

export type LocksTsconfig = typeof LocksTsconfigSchema.Type

/** `a/./b/../c/` → `a/c`: the forms a tsconfig include may take, as one path. */
const normalizeIncludePath = (path: string): string => {
  const segments: Array<string> = []
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") segments.pop()
    else segments.push(segment)
  }
  return segments.join("/")
}

/** A glob include matches like an oxlint override; a plain one is a file or a directory. */
const includeMatcher = (path: string): ((file: string) => boolean) => {
  if (/[*?{]/.test(path)) {
    const matcher = globMatcher(path)
    return (file) => matcher.test(file)
  }
  return (file) => file === path || file.startsWith(`${path}/`)
}

/**
 * A lock tsconfig lists the test files whose `@ts-expect-error` lines prove a
 * type surface stays closed. `tsc` ignores an include that names no file, so
 * a deleted test kept its entry for months and the lock it claimed was gone.
 */
export const findMissingLockIncludes = (
  configFile: string,
  configText: string,
  config: LocksTsconfig,
  trackedFiles: ReadonlyArray<string>,
): ReadonlyArray<LintConfigFinding> => {
  const configDir = configFile.slice(0, configFile.lastIndexOf("/") + 1)
  const findings: Array<LintConfigFinding> = []
  for (const include of config.include ?? []) {
    const path = normalizeIncludePath(`${configDir}${include}`)
    const matches = includeMatcher(path)
    if (trackedFiles.some(matches)) continue
    findings.push({
      file: configFile,
      line: lineOfGlob(configText, include),
      message: `lock include \`${include}\` names no tracked file; the lock it claims is gone, delete the entry`,
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// (b) A plugin rule the root config never enables
// ---------------------------------------------------------------------------

/** `"<name>": {` inside the plugin's `rules` object literal. */
const RULE_KEY = /^\s{4}"([a-z0-9-]+)":\s*\{/

/**
 * Rules defined in the plugin but deliberately not enabled at the root, each
 * with the reason. An entry here is a claim; prefer deleting the rule.
 */
const UNENABLED_RULES_WITH_REASON: ReadonlyMap<string, string> = new Map()

export const findUnenabledPluginRules = (
  pluginFile: string,
  pluginText: string,
  rootRules: ReadonlySet<string>,
): ReadonlyArray<LintConfigFinding> => {
  const findings: Array<LintConfigFinding> = []
  for (const [index, line] of pluginText.split("\n").entries()) {
    const name = Option.flatMap(Option.fromNullishOr(RULE_KEY.exec(line)), (match) =>
      Option.fromNullishOr(match[1]),
    )
    if (Option.isNone(name)) continue
    const rule = name.value
    if (rootRules.has(`gent/${rule}`)) continue
    if (UNENABLED_RULES_WITH_REASON.has(rule)) continue
    findings.push({
      file: pluginFile,
      line: index + 1,
      message: `lint rule \`gent/${rule}\` is defined but the root config never enables it; enable it, or delete the rule and its fixtures`,
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// (c) A GENT_* variable with a reader but nothing to set it
// ---------------------------------------------------------------------------

/**
 * Variables a person or an external launcher supplies, so the tree holds no
 * writer for them by design. Each entry says who sets it.
 */
const EXTERNALLY_SET: ReadonlyMap<string, string> = new Map([
  ["GENT_LOG_LEVEL", "a developer sets this by hand to raise log verbosity"],
  ["GENT_PORT", "the operator of a standalone server picks its port"],
  ["GENT_DATA_DIR", "the operator names the directory holding data.db"],
  ["GENT_AUTH_DIRECTORY", "the operator names the auth directory"],
  ["GENT_SERVER_MODE", "the launcher picks standalone or shared"],
  ["GENT_PERSISTENCE_MODE", "the launcher picks sqlite or memory"],
  ["GENT_PROVIDER_MODE", "the launcher picks the live or scripted provider"],
  ["GENT_IDLE_TIMEOUT_MS", "the launcher of a shared server sets its idle window"],
])

/** `Config.string("GENT_NAME")` and friends -- the shapes that read a variable. */
const READER = /Config\.[a-zA-Z]+\(\s*["'](GENT_[A-Z0-9_]+)["']/g

/** Setting a variable: an env record literal, or an assignment into one. */
const WRITER = /["']?(GENT_[A-Z0-9_]+)["']?\s*[:=]\s*[^=]/g

interface VariableUse {
  readonly file: string
  readonly line: number
}

/** Where each `GENT_*` variable is read, and which ones anything sets. */
export interface GentVariableUses {
  readonly readers: ReadonlyMap<string, ReadonlyArray<VariableUse>>
  readonly writers: ReadonlySet<string>
}

const isTestFile = (file: string): boolean =>
  /\.test\.[cm]?[jt]sx?$/.test(file) || /(?:^|\/)tests\//.test(file)

/** The names one line reads through `Config.*("GENT_...")`. */
const readsOn = (line: string): ReadonlyArray<string> =>
  [...line.matchAll(READER)].flatMap((match) => Option.toArray(Option.fromNullishOr(match[1])))

/** The names one line sets, as an env record entry or an assignment. */
const writesOn = (line: string): ReadonlyArray<string> => {
  // The read shape also matches the write shape on a `Config.string(...)` line,
  // so a line that reads is never counted as a line that writes.
  if (line.includes("Config.")) return []
  return [...line.matchAll(WRITER)].flatMap((match) =>
    Option.toArray(Option.fromNullishOr(match[1])),
  )
}

/** Every `GENT_*` read and write in the tree, by variable name. */
export const collectGentVariableUses = (
  sourceTexts: ReadonlyMap<string, string>,
): GentVariableUses => {
  const readers = new Map<string, Array<VariableUse>>()
  const writers = new Set<string>()
  for (const [file, text] of sourceTexts) {
    // This finder and its fixtures name variables to describe the finder
    // itself. Neither file is a call site, so neither is scanned.
    if (file.startsWith("packages/tooling/src/guards")) continue
    if (file.startsWith("packages/tooling/tests/guards")) continue
    // A test may set a variable to drive a reader; that proves the reader
    // works, not that anything in production supplies it.
    const skipWrites = isTestFile(file)
    for (const [index, line] of text.split("\n").entries()) {
      for (const name of readsOn(line)) {
        const found = readers.get(name) ?? []
        found.push({ file, line: index + 1 })
        readers.set(name, found)
      }
      if (skipWrites) continue
      for (const name of writesOn(line)) writers.add(name)
    }
  }
  return { readers, writers }
}

export const findReadersWithoutWriters = (
  sourceTexts: ReadonlyMap<string, string>,
): ReadonlyArray<LintConfigFinding> => {
  const { readers, writers } = collectGentVariableUses(sourceTexts)
  const findings: Array<LintConfigFinding> = []
  for (const [name, uses] of readers) {
    if (writers.has(name)) continue
    if (EXTERNALLY_SET.has(name)) continue
    for (const use of uses) {
      findings.push({
        file: use.file,
        line: use.line,
        message: `\`${name}\` is read but nothing in the tree sets it; delete the reader, or record who sets it in EXTERNALLY_SET`,
      })
    }
  }
  return findings
}

// ── platform-duplication-guards ─────────────────────────────────────────────

export interface PlatformDuplicationFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

interface BannedPattern {
  readonly pattern: RegExp
  readonly message: string
}

const sourceFile = (file: string): boolean =>
  /^(?:packages|apps|examples\/extensions)\//.test(file) &&
  /\.(?:[cm]?[jt]sx?)$/.test(file) &&
  file !== "packages/tooling/src/guards.ts" &&
  !file.includes("/tests/") &&
  !file.includes("/fixtures/") &&
  !file.includes("/dist/")

const activeSourceFile = (file: string): boolean =>
  /^(?:packages|apps)\//.test(file) && sourceFile(file)

const referenceExtensionFile = (file: string): boolean =>
  file.startsWith("examples/extensions/") && sourceFile(file)

const platformLayerPattern: BannedPattern = {
  pattern: /\b(?:BunPlatformLive|BunGentPlatformLive)\b/,
  message: "Bun platform layers may only be provided by platform roots",
}

const bannedReferenceExtensionPatterns: ReadonlyArray<BannedPattern> = [
  {
    pattern: /@gent\/extensions\/src\//,
    message:
      "Reference extensions must stand alone instead of importing shipped extension internals",
  },
  {
    pattern: /(?:^|\s)from\s+["'](?:\.\.\/){2,}/,
    message: "Reference extensions must not reach out of examples/extensions with relative imports",
  },
]

const platformProviderRootFiles = new Set([
  "packages/core/src/runtime/gent-platform.ts",
  "packages/core/src/runtime/gent-platform-bun.ts",
  "packages/core/src/server/server-root.ts",
  // The host entry is the door hosts take to the platform roots.
  "packages/core/src/host.ts",
  // The test entry hands test roots the full Bun platform.
  "packages/core/src/test-utils/index.ts",
  // The in-process test server root provides the platform around `buildServerRoot`.
  "packages/core/src/test-utils/harness.ts",
  "apps/tui/src/main.tsx",
  "packages/sdk/src/server.ts",
])

/**
 * `apps/server/src/main.ts` is a launcher, not a composition root. It reads
 * the environment and calls `Gent.server`. Reaching for core or a platform
 * layer there rebuilds the second root the SDK server primitive replaced.
 */
const bannedLauncherPatterns: ReadonlyArray<BannedPattern> = [
  {
    pattern: /@gent\/core\//,
    message:
      "The server launcher composes nothing; import @gent/sdk and pass the shape through GentServerOptions",
  },
  {
    pattern: /@gent\/extensions/,
    message:
      "The server launcher does not name extensions; Gent.server defaults to the builtin set",
  },
  {
    pattern: /\bbuildServerRoot\b/,
    message: "The server launcher calls Gent.server, never buildServerRoot",
  },
]

const launcherFiles = new Set(["apps/server/src/main.ts"])

const patternsForFile = (file: string): ReadonlyArray<BannedPattern> => {
  const patterns: BannedPattern[] = []
  if (!platformProviderRootFiles.has(file)) patterns.push(platformLayerPattern)
  if (launcherFiles.has(file)) patterns.push(...bannedLauncherPatterns)
  return patterns
}

export const findPlatformDuplicationViolations = (
  file: string,
  text: string,
): ReadonlyArray<PlatformDuplicationFinding> => {
  const findings: PlatformDuplicationFinding[] = []

  if (!sourceFile(file)) return findings

  const patterns: BannedPattern[] = []
  if (activeSourceFile(file)) patterns.push(...patternsForFile(file))
  if (referenceExtensionFile(file)) patterns.push(...bannedReferenceExtensionPatterns)
  const lines = text.split("\n")
  for (let index = 0; index < lines.length; index++) {
    const line = Option.getOrElse(Option.fromNullishOr(lines[index]), () => "")
    for (const { pattern, message } of patterns) {
      if (pattern.test(line)) {
        findings.push({ file, line: index + 1, message })
      }
    }
  }

  return findings
}

// ── retired-surfaces ────────────────────────────────────────────────────────

/**
 * Guard: a deleted surface stays deleted.
 *
 * Each row names what was removed and what replaced it. A row matches a source
 * line, an import specifier's module basename, or the file path itself. The
 * guard source is exempt: the table names every retired surface on purpose.
 *
 * Retired `Bun.*` members (`Bun.Glob`, `Bun.randomUUIDv7` outside the platform
 * adapter) are banned by the `gent/no-bun-outside-adapter` rule in
 * `lint/gent-rules.ts` instead, because only the AST sees a member access.
 *
 * @module
 */

export interface RetiredSurfaceFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

interface RetiredSurface {
  /** `line`: a source line; `import`: an imported module's basename; `path`: the file path. */
  readonly on: "line" | "import" | "path"
  readonly match: RegExp
  /**
   * `shipped`: source under `packages/` and `apps/`, not tests or fixtures.
   * `shipped-and-tests`: also the `tests/` trees, where a test that builds the
   * retired layer again is the same regrowth; the tooling package is out.
   */
  readonly scope: "shipped" | "shipped-and-tests"
  readonly message: string
}

/** Whole identifiers only: `InProcessRunner` does not match `ProcessRunner`. */
const identifiers = (...names: ReadonlyArray<string>): RegExp =>
  new RegExp(`(?<![A-Za-z0-9_$])(?:${names.join("|")})(?![A-Za-z0-9_$])`)

const modules = (...names: ReadonlyArray<string>): RegExp => new RegExp(`^(?:${names.join("|")})$`)

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
      "the Files and Process facets are removed; yield FileSystem, Path and ChildProcessSpawner, call runProcess, and write atomically with writeFileAtomic in packages/extensions/src/fs-tools.ts",
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
    on: "import",
    match: modules(
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
]

const SHIPPED_AND_TESTS = /^(?:packages|apps)\/(?!tooling\/)[^/]+\/(?:src|tests)\//

const inRetiredScope = (file: string, scope: RetiredSurface["scope"]): boolean => {
  if (scope === "shipped") return activeSourceFile(file)
  return SHIPPED_AND_TESTS.test(file) && file !== "packages/tooling/src/guards.ts"
}

const importedModule = (line: string): Option.Option<string> =>
  Option.flatMap(
    Option.flatMap(Option.fromNullishOr(IMPORT_PATTERN.exec(line)), (match) =>
      Option.fromNullishOr(match[1]),
    ),
    (specifier) =>
      Option.map(Option.fromNullishOr(specifier.split("/").at(-1)), (last) =>
        last.replace(/\.[cm]?[jt]sx?$/, ""),
      ),
  )

/** What a row reads on one line: the line itself, its import's module, or nothing. */
const subjectOf = (row: RetiredSurface, line: string): Option.Option<string> => {
  if (row.on === "line") return Option.some(line)
  if (row.on === "import") return importedModule(line)
  return Option.none()
}

/** Every line, import, or path in `file` that brings back a retired surface. */
export const findRetiredSurfaces = (
  file: string,
  text: string,
): ReadonlyArray<RetiredSurfaceFinding> => {
  const rows = RETIRED_SURFACES.filter((row) => inRetiredScope(file, row.scope))
  if (rows.length === 0) return []
  const findings: Array<RetiredSurfaceFinding> = []
  for (const row of rows) {
    if (row.on === "path" && row.match.test(file))
      findings.push({ file, line: 1, message: row.message })
  }
  for (const [index, line] of text.split("\n").entries()) {
    for (const row of rows) {
      const subject = subjectOf(row, line)
      const hit = Option.flatMap(subject, (value) => Option.fromNullishOr(row.match.exec(value)))
      if (Option.isNone(hit)) continue
      findings.push({ file, line: index + 1, message: `"${hit.value[0]}": ${row.message}` })
    }
  }
  return findings
}

// ── steering-file-paths ─────────────────────────────────────────────────────

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
 * Scope is the four files an agent is told to read: `CLAUDE.md` and
 * `AGENTS.md` at the root, `apps/tui/AGENTS.md`, and `ARCHITECTURE.md`. The
 * root pair are two copies of the same document rather than one file behind a
 * symlink, so both are read and a stale path in either is reported.
 *
 * What is read: text in backticks that starts with one of the five source
 * roots — `packages/`, `apps/`, `plans/`, `testbeds/`, `examples/`. Backticks
 * are what makes the reference a claim about a path; prose naming a file
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
 * @module
 */

/** A steering-file reference to a path that `git ls-files` does not list. */
export interface SteeringFilePathFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

/** The files an agent is told to read before it changes the code. */
const STEERING_FILES = new Set(["CLAUDE.md", "AGENTS.md", "apps/tui/AGENTS.md", "ARCHITECTURE.md"])

export const isSteeringFile = (file: string): boolean => STEERING_FILES.has(file)

/** The five roots under which a backticked path is a claim about the tree. */
const SOURCE_ROOT = /^(?:packages|apps|plans|testbeds|examples)\//

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

export const findSteeringFilePaths = (
  file: string,
  text: string,
  trackedFiles: ReadonlyArray<string>,
): ReadonlyArray<SteeringFilePathFinding> => {
  if (!isSteeringFile(file)) return []

  const tracked = new Set(trackedFiles)
  const prefixes = directoryPrefixesOf(trackedFiles)
  const findings: SteeringFilePathFinding[] = []
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
  }
  return findings
}

// ── tui-session-identity ────────────────────────────────────────────────────

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

export interface TuiSessionIdentityFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

const TUI_SOURCE = /^apps\/tui\/src\//

/** Opens a reactive scope: Solid re-runs what follows when its reads change. */
const TRACKING_OPENER = /\b(?:createEffect|createMemo|createResource|on)\(/

/** The record accessor. `sessionIdentity`/`activeSessionId` are the narrowed ones. */
const RECORD_READ = /(?<!current)\.session\(\)/i

/**
 * How far a reactive scope is followed. Long enough for the dependency list and
 * the head of the body this codebase writes, short enough that a later callback
 * in the same function is not attributed to the effect.
 */
const SCOPE_LINES = 12

export const findTuiSessionIdentityReads = (
  file: string,
  text: string,
): ReadonlyArray<TuiSessionIdentityFinding> => {
  if (!TUI_SOURCE.test(file)) return []

  const lines = text.split("\n")
  const reported = new Set<number>()
  const findings: TuiSessionIdentityFinding[] = []
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

// ── suppression-inventory ───────────────────────────────────────────────────

/**
 * The one suppression the linters cannot police: `@effect-diagnostics` comments.
 * Every other kind (`@ts-ignore`, `as any`, block eslint-disables) is banned by
 * oxlint or by `blanket-eslint-disable`, so this inventory is the approved list
 * of diagnostics suppressions and nothing else.
 *
 * The inventory is checked in both directions: a suppression comment with no
 * approved entry fails the guard, and an approved entry with no matching
 * comment anywhere in the tree fails it too, so the table cannot drift.
 */

export type SuppressionFindingKind = "effect-diagnostics"

export interface SuppressionInventoryFinding {
  readonly file: string
  readonly line: number
  readonly kind: SuppressionFindingKind
}

/** An approved entry that no suppression comment in the scanned tree matches. */
export interface UnusedSuppressionApproval {
  readonly file: string
  readonly comment: string
}

/** `next-line` suppresses the following line; `file` suppresses the whole module. */
type SuppressionScope = "next-line" | "file"

interface ApprovedSuppressionEntry {
  readonly file: string
  readonly scope: SuppressionScope
  /** Everything after the directive: rule flags and the reason. */
  readonly text: string
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
    file: "apps/tui/src/workspace.tsx",
    scope: "next-line",
    text: "strictEffectProvide:off solid mount edge — isolated FS effect",
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
  },
  {
    file: "apps/tui/tests/extensions/loader-boundary.test.ts",
    scope: "next-line",
    text: "nodeBuiltinImport:off",
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
  },
  {
    file: "packages/extensions/src/openai.ts",
    scope: "next-line",
    text: "strictEffectProvide:off OAuth authorization owns its crypto layer at the extension boundary",
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
const DESCRIBES_THE_MARKER = new Set([
  "packages/tooling/src/guards.ts",
  "packages/tooling/tests/guards.test.ts",
])

const approvedSuppression = (file: string, text: string): boolean =>
  approvedSuppressionEntries.some(
    (entry) => entry.file === file && approvedComment(entry) === text.trim(),
  )

export const findSuppressionInventoryFindings = (
  file: string,
  text: string,
): ReadonlyArray<SuppressionInventoryFinding> => {
  const findings: SuppressionInventoryFinding[] = []
  if (DESCRIBES_THE_MARKER.has(file)) return findings

  for (const [index, line] of text.split("\n").entries()) {
    if (line.includes(directiveMarker) && !approvedSuppression(file, line)) {
      findings.push({ file, line: index + 1, kind: "effect-diagnostics" })
    }
  }
  return findings
}

const containsComment = (text: string, comment: string): boolean =>
  text.split("\n").some((line) => line.trim() === comment)

/**
 * Whole-tree check: every approved entry must match a comment in its file.
 * `sources` maps each scanned source path to its text; a file missing from
 * the map counts as having no suppressions.
 */
export const findUnusedSuppressionApprovals = (
  sources: ReadonlyMap<string, string>,
): ReadonlyArray<UnusedSuppressionApproval> =>
  approvedSuppressionEntries.flatMap((entry) => {
    const comment = approvedComment(entry)
    const source = Option.fromNullishOr(sources.get(entry.file))
    if (Option.exists(source, (text) => containsComment(text, comment))) return []
    return [{ file: entry.file, comment }]
  })

// ── export-consumers ────────────────────────────────────────────────────────

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

/** A name nothing that may consume it reaches for. */
export interface ExportConsumerFinding {
  readonly file: string
  readonly line: number
  readonly message: string
  /** `false` for a surface still being read for findings; those warn, not fail. */
  readonly enforced: boolean
}

/** One scanned surface: where its names are declared and who may consume them. */
interface ScannedSurface {
  readonly prefix: string
  /** Directories inside the prefix whose exports are another surface's business. */
  readonly exempt: ReadonlyArray<string>
  /** Files whose mentions never count: the declaring package's own source, for an entry point. */
  readonly outsideOf: ReadonlyArray<string>
  /** Whether a test file's mention keeps a name alive. */
  readonly testsCount: boolean
  /** Whether a reference inside the declaring file, off the declaration lines, keeps a name alive. */
  readonly ownFileCounts: boolean
  /** The import specifier an entry point is consumed through; `None` for a module surface. */
  readonly specifier: Option.Option<string>
  /** Whether a finding fails the guardrails or is only reported. */
  readonly enforced: boolean
}

const SCANNED_SURFACES: ReadonlyArray<ScannedSurface> = [
  {
    prefix: "packages/core/src/extensions/api.ts",
    exempt: [],
    outsideOf: ["packages/core/src/"],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.some("@gent/core/extensions/api"),
    enforced: true,
  },
  {
    prefix: "packages/core/src/extensions/branch-tools.ts",
    exempt: [],
    outsideOf: ["packages/core/src/"],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.some("@gent/core/extensions/branch-tools"),
    enforced: true,
  },
  {
    prefix: "packages/core/src/protocol.ts",
    exempt: [],
    outsideOf: ["packages/core/src/"],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.some("@gent/core/protocol"),
    enforced: true,
  },
  {
    // A host export exists for the processes that compose a server; a name
    // only tests read is harness setup and belongs behind a test-utils operation.
    prefix: "packages/core/src/host.ts",
    exempt: [],
    outsideOf: ["packages/core/src/"],
    testsCount: false,
    ownFileCounts: false,
    specifier: Option.some("@gent/core/host"),
    enforced: true,
  },
  {
    // The test entry point, listed before the harness directory it re-exports.
    prefix: "packages/core/src/test-utils/index.ts",
    exempt: [],
    outsideOf: ["packages/core/src/"],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.some("@gent/core/test-utils"),
    enforced: true,
  },
  {
    // Its own surface, listed before `packages/core/src/` so the prefix scan
    // reaches it first. Read with the Schema-aware rule: a layer's config type
    // and a control handle's type sit beside the builder that returns them.
    prefix: "packages/core/src/test-utils/",
    exempt: [],
    outsideOf: [],
    testsCount: true,
    ownFileCounts: true,
    specifier: Option.none(),
    enforced: true,
  },
  {
    prefix: "packages/core/src/",
    exempt: ["packages/core/src/extensions/", "packages/core/src/protocol.ts"],
    outsideOf: [],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.none(),
    enforced: true,
  },
  {
    prefix: "packages/sdk/src/index.ts",
    exempt: [],
    outsideOf: ["packages/sdk/"],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.some("@gent/sdk"),
    enforced: true,
  },
  {
    prefix: "packages/sdk/src/",
    exempt: [],
    outsideOf: [],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.none(),
    enforced: true,
  },
  {
    prefix: "packages/extensions/src/client.ts",
    exempt: [],
    outsideOf: ["packages/extensions/"],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.some("@gent/extensions/client"),
    enforced: true,
  },
  {
    prefix: "packages/extensions/src/",
    exempt: [],
    outsideOf: [],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.none(),
    enforced: true,
  },
  {
    prefix: "packages/tooling/src/",
    exempt: [],
    outsideOf: [],
    testsCount: true,
    ownFileCounts: true,
    specifier: Option.none(),
    enforced: true,
  },
  {
    prefix: "packages/e2e/src/",
    exempt: [],
    outsideOf: [],
    testsCount: true,
    ownFileCounts: true,
    specifier: Option.none(),
    enforced: true,
  },
  {
    // The TUI is a leaf: nothing imports it, so every export it declares is
    // read from inside `apps/tui` or by its tests, or by nothing at all.
    prefix: "apps/tui/src/",
    exempt: [],
    outsideOf: [],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.none(),
    enforced: true,
  },
  {
    // The server app is a launcher and a leaf: it reads the environment and
    // calls `Gent.server`. Nothing imports it, so a name it exports is read by
    // its own tests or by nothing at all.
    prefix: "apps/server/src/",
    exempt: [],
    outsideOf: [],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.none(),
    enforced: true,
  },
]

/**
 * Exports kept alive on purpose, each with the reason.
 *
 * An entry here is a claim that the name earns its keep despite having no
 * consumer. Prefer deleting the export.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map()

const surfaceOf = (file: string): Option.Option<ScannedSurface> =>
  Option.filter(
    Option.fromNullishOr(SCANNED_SURFACES.find((surface) => file.startsWith(surface.prefix))),
    (surface) => !surface.exempt.some((prefix) => file.startsWith(prefix)),
  )

/** A declared name, and the surface whose rule decides whether it is consumed. */
export interface Declaration {
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
const withoutCommentsAndStrings = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/\/\/.*$/gm, "")
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""')

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
  /** Every identifier the file mentions anywhere. */
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
    identifiers: identifiersIn(text),
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
  (surface.testsCount || !isTestFile(file)) &&
  !surface.outsideOf.some((prefix) => file.startsWith(prefix))

const messageFor = (file: string, declaration: Declaration): string =>
  Option.match(declaration.surface.specifier, {
    onNone: () => {
      if (declaration.surface.ownFileCounts) {
        return `\`${declaration.name}\` is exported but nothing names it, not even ${file} off its own declaration; delete it`
      }
      return `\`${declaration.name}\` is exported but no file outside ${file} names it; drop the \`export\` keyword, or delete it if nothing uses it at all`
    },
    onSome: (specifier) =>
      `entry-point name "${declaration.name}" has no consumer outside ${declaration.surface.outsideOf.join(", ")} through ${specifier}; it is vocabulary every caller reads past. Drop it from the entry point, or ship something that uses it.`,
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
): ReadonlyArray<ExportConsumerFinding> => {
  const declaringFiles = filesDeclaringEachName(factsByFile)

  const isConsumed = (file: string, declaration: Declaration): boolean => {
    const declaredIn = Option.getOrElse(
      Option.fromNullishOr(declaringFiles.get(declaration.name)),
      () => new Set<string>(),
    )
    const targets = importTargetsOf(file)
    for (const [candidate, facts] of factsByFile) {
      if (!mayConsume(candidate, declaration.surface)) continue
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

  const findings: Array<ExportConsumerFinding> = []
  for (const [file, facts] of factsByFile) {
    const reported = new Set<string>()
    for (const declaration of facts.declarations) {
      if (ALLOWLIST.has(declaration.name)) continue
      if (isConsumed(file, declaration)) continue
      if (Option.isSome(declaration.surface.specifier)) {
        if (reported.has(declaration.name)) continue
        reported.add(declaration.name)
      }
      findings.push({
        file,
        line: declaration.line,
        message: messageFor(file, declaration),
        enforced: declaration.surface.enforced,
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// Package entry points
// ---------------------------------------------------------------------------

export interface PackageJson {
  readonly private?: boolean
  readonly exports?: Readonly<Record<string, string>>
}

export interface TsConfigJson {
  readonly compilerOptions?: {
    readonly paths?: Readonly<Record<string, ReadonlyArray<string>>>
  }
}

export interface PackageSurfaceFinding {
  readonly path: string
  readonly message: string
}

/** One package, the entry points it may expose, and whether it must stay private. */
interface PackageSurface {
  readonly packageJson: string
  readonly alias: string
  readonly mustBePrivate: boolean
  /** `exports` keys the package may carry; a tsconfig path is allowed when it maps onto one. */
  readonly entryPoints: ReadonlyArray<string>
}

/**
 * Core's public entry points follow their audience. Two authoring surfaces are
 * deliberately split: `extensions/api` for extensions that use the loop,
 * `extensions/branch-tools` for the rarer feature that implements a loop
 * seam. Keeping them apart is what keeps `api` small. `protocol` serves
 * clients, `host` serves the processes that compose a server, and
 * `test-utils` serves tests. `@gent/extensions` is the builtin composition
 * package and exposes only its root and `./client`; `@gent/sdk` exposes the
 * stable root client contract and nothing else.
 */
const PACKAGE_SURFACES: ReadonlyArray<PackageSurface> = [
  {
    packageJson: "packages/core/package.json",
    alias: "@gent/core",
    mustBePrivate: false,
    entryPoints: [
      "./extensions/api",
      "./extensions/api.js",
      "./extensions/branch-tools",
      "./extensions/branch-tools.js",
      "./host",
      "./protocol",
      "./protocol.js",
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
]

const allowedKeys = (surface: PackageSurface): ReadonlySet<string> => new Set(surface.entryPoints)

/** The `exports` key a tsconfig path maps onto, when the path belongs to the alias. */
const entryPointOfPath = (surface: PackageSurface, key: string): Option.Option<string> => {
  if (key === surface.alias) return Option.some(".")
  if (key.startsWith(`${surface.alias}/`)) return Option.some(`.${key.slice(surface.alias.length)}`)
  return Option.none()
}

const packageFindings = (
  surface: PackageSurface,
  packageJson: PackageJson,
): ReadonlyArray<PackageSurfaceFinding> => {
  const findings: Array<PackageSurfaceFinding> = []
  if (surface.mustBePrivate && packageJson.private !== true) {
    findings.push({
      path: `${surface.packageJson} private`,
      message: `${surface.alias} must stay private; it is not a published contract`,
    })
  }
  const allowed = allowedKeys(surface)
  const exportsMap = Option.fromNullishOr(packageJson.exports)
  for (const key of Object.keys(Option.getOrElse(exportsMap, () => ({})))) {
    if (allowed.has(key)) continue
    findings.push({
      path: `${surface.packageJson} exports["${key}"]`,
      message: `${surface.alias} may only expose its supported entry points: ${[...allowed].join(", ")}`,
    })
  }
  return findings
}

const pathFindings = (
  surface: PackageSurface,
  tsconfigJson: TsConfigJson,
): ReadonlyArray<PackageSurfaceFinding> => {
  const allowed = allowedKeys(surface)
  const paths = Option.getOrElse(
    Option.flatMap(Option.fromNullishOr(tsconfigJson.compilerOptions), (options) =>
      Option.fromNullishOr(options.paths),
    ),
    () => ({}),
  )
  const findings: Array<PackageSurfaceFinding> = []
  for (const key of Object.keys(paths)) {
    const entryPoint = entryPointOfPath(surface, key)
    if (Option.isNone(entryPoint)) continue
    if (allowed.has(entryPoint.value)) continue
    findings.push({
      path: `tsconfig.json compilerOptions.paths["${key}"]`,
      message: `Do not give TypeScript a public-looking ${surface.alias} path for an internal module`,
    })
  }
  return findings
}

/**
 * Check every package surface whose package.json was read. A surface absent
 * from `packageJsons` is skipped, so a caller may check one package alone.
 */
export const findPackageSurfaceFindings = (
  packageJsons: ReadonlyMap<string, PackageJson>,
  tsconfigJson: TsConfigJson,
): ReadonlyArray<PackageSurfaceFinding> =>
  PACKAGE_SURFACES.flatMap((surface) =>
    Option.match(Option.fromNullishOr(packageJsons.get(surface.packageJson)), {
      onNone: (): ReadonlyArray<PackageSurfaceFinding> => [],
      onSome: (packageJson) => [
        ...packageFindings(surface, packageJson),
        ...pathFindings(surface, tsconfigJson),
      ],
    }),
  )

// ---------------------------------------------------------------------------
// Workspace imports a package does not declare
// ---------------------------------------------------------------------------

/** The manifest fields that name a workspace package and what it depends on. */
export interface WorkspaceManifest {
  readonly name: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
}

export interface UndeclaredImportFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

/** The package an `@gent/...` specifier names: `@gent/core/protocol` → `@gent/core`. */
const WORKSPACE_PACKAGE = /^(@gent\/[a-z0-9-]+)(?:\/.*)?$/

interface SourceToken {
  readonly kind: "word" | "string" | "punct"
  readonly value: string
  readonly line: number
}

/** After these, a `/` starts a regular expression, not a division. */
const REGEX_AFTER_WORDS = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
])

const WORD_CHAR = /[A-Za-z0-9_$]/

/** A lexer's cursor: the source, the position, and the tokens read so far. */
interface Lexer {
  readonly text: string
  index: number
  line: number
  readonly tokens: Array<SourceToken>
  /** One entry per open template `${`: the brace depth inside that expression. */
  readonly templateDepths: Array<number>
}

const charAt = (lexer: Lexer, offset: number): string => lexer.text.charAt(lexer.index + offset)

const atEnd = (lexer: Lexer): boolean => lexer.index >= lexer.text.length

const CLOSING_PUNCT = new Set([")", "]", "}"])

/** A `/` starts a regular expression unless it follows a value. */
const regexAllowed = (lexer: Lexer): boolean =>
  Option.match(Option.fromNullishOr(lexer.tokens.at(-1)), {
    onNone: () => true,
    onSome: (previous) => {
      if (previous.kind === "string") return false
      if (previous.kind === "word") return REGEX_AFTER_WORDS.has(previous.value)
      return !CLOSING_PUNCT.has(previous.value)
    },
  })

/** Skip template text (just past a backtick or a closing `}`) to its end or a `${`. */
const skipTemplateText = (lexer: Lexer): void => {
  while (!atEnd(lexer)) {
    const char = charAt(lexer, 0)
    if (char === "\\") {
      lexer.index += 2
      continue
    }
    if (char === "\n") lexer.line++
    if (char === "`") {
      lexer.index++
      return
    }
    if (char === "$" && charAt(lexer, 1) === "{") {
      lexer.index += 2
      lexer.templateDepths.push(0)
      return
    }
    lexer.index++
  }
}

const skipWhitespace = (lexer: Lexer): boolean => {
  const char = charAt(lexer, 0)
  if (!/\s/.test(char)) return false
  if (char === "\n") lexer.line++
  lexer.index++
  return true
}

const skipLineComment = (lexer: Lexer): boolean => {
  if (!(charAt(lexer, 0) === "/" && charAt(lexer, 1) === "/")) return false
  while (!atEnd(lexer) && charAt(lexer, 0) !== "\n") lexer.index++
  return true
}

const skipBlockComment = (lexer: Lexer): boolean => {
  if (!(charAt(lexer, 0) === "/" && charAt(lexer, 1) === "*")) return false
  lexer.index += 2
  while (!atEnd(lexer) && !(charAt(lexer, 0) === "*" && charAt(lexer, 1) === "/")) {
    if (charAt(lexer, 0) === "\n") lexer.line++
    lexer.index++
  }
  lexer.index += 2
  return true
}

const skipTemplate = (lexer: Lexer): boolean => {
  if (charAt(lexer, 0) !== "`") return false
  lexer.index++
  skipTemplateText(lexer)
  return true
}

/** A quoted string; it ends at an unescaped newline, so a stray quote spoils one line. */
const readString = (lexer: Lexer): boolean => {
  const quote = charAt(lexer, 0)
  if (quote !== "'" && quote !== '"') return false
  const line = lexer.line
  let value = ""
  lexer.index++
  while (!atEnd(lexer) && charAt(lexer, 0) !== quote && charAt(lexer, 0) !== "\n") {
    if (charAt(lexer, 0) === "\\") {
      value += charAt(lexer, 1)
      lexer.index += 2
      continue
    }
    value += charAt(lexer, 0)
    lexer.index++
  }
  lexer.index++
  lexer.tokens.push({ kind: "string", value, line })
  return true
}

/** A regular expression literal, kept as an empty string token so it names no module. */
const readRegex = (lexer: Lexer): boolean => {
  if (charAt(lexer, 0) !== "/" || !regexAllowed(lexer)) return false
  let inClass = false
  lexer.index++
  while (!atEnd(lexer) && charAt(lexer, 0) !== "\n") {
    const current = charAt(lexer, 0)
    if (current === "\\") {
      lexer.index += 2
      continue
    }
    if (current === "/" && !inClass) break
    if (current === "[") inClass = true
    if (current === "]") inClass = false
    lexer.index++
  }
  lexer.index++
  while (WORD_CHAR.test(charAt(lexer, 0))) lexer.index++
  lexer.tokens.push({ kind: "string", value: "", line: lexer.line })
  return true
}

const readWord = (lexer: Lexer): boolean => {
  if (!WORD_CHAR.test(charAt(lexer, 0))) return false
  let value = ""
  while (!atEnd(lexer) && WORD_CHAR.test(charAt(lexer, 0))) {
    value += charAt(lexer, 0)
    lexer.index++
  }
  lexer.tokens.push({ kind: "word", value, line: lexer.line })
  return true
}

/** A `}` that closes a template `${`: resume the template text after it. */
const closeTemplateExpression = (lexer: Lexer): boolean => {
  if (charAt(lexer, 0) !== "}" || lexer.templateDepths.at(-1) !== 0) return false
  lexer.templateDepths.pop()
  lexer.index++
  skipTemplateText(lexer)
  return true
}

const readPunct = (lexer: Lexer): boolean => {
  const char = charAt(lexer, 0)
  const last = lexer.templateDepths.length - 1
  const depth = lexer.templateDepths[last] ?? 0
  if (char === "{" && last >= 0) lexer.templateDepths[last] = depth + 1
  if (char === "}" && last >= 0) lexer.templateDepths[last] = depth - 1
  lexer.tokens.push({ kind: "punct", value: char, line: lexer.line })
  lexer.index++
  return true
}

/** In order: the first scanner that accepts the current character consumes it. */
const SCANNERS: ReadonlyArray<(lexer: Lexer) => boolean> = [
  skipWhitespace,
  skipLineComment,
  skipBlockComment,
  skipTemplate,
  readString,
  readRegex,
  readWord,
  closeTemplateExpression,
  readPunct,
]

/**
 * Tokens of a TypeScript source, with comments, template text, and regular
 * expressions dropped. Only words, string literals, and punctuation remain,
 * which is all an import scan reads.
 */
const sourceTokens = (text: string): ReadonlyArray<SourceToken> => {
  const lexer: Lexer = { text, index: 0, line: 1, tokens: [], templateDepths: [] }
  while (!atEnd(lexer)) SCANNERS.some((scan) => scan(lexer))
  return lexer.tokens
}

export interface ModuleReference {
  readonly specifier: string
  readonly line: number
}

const isPunct = (token: Option.Option<SourceToken>, value: string): boolean =>
  Option.exists(token, (current) => current.kind === "punct" && current.value === value)

/** The string token that names the module for the keyword at `position`, if any. */
const specifierAt = (
  tokens: ReadonlyArray<SourceToken>,
  position: number,
): Option.Option<SourceToken> => {
  const tokenAt = (offset: number) => Option.fromNullishOr(tokens[position + offset])
  const stringAt = (offset: number) =>
    Option.filter(tokenAt(offset), (token) => token.kind === "string")
  const keyword = tokens[position]
  if (keyword?.kind !== "word") return Option.none()
  // `x.from "…"` and `x.import(…)` are not module syntax; `module.require(…)` is.
  const member = isPunct(tokenAt(-1), ".")
  const called = isPunct(tokenAt(1), "(")
  if (keyword.value === "require" && called) return stringAt(2)
  if (member) return Option.none()
  if (keyword.value === "from") return stringAt(1)
  if (keyword.value !== "import") return Option.none()
  if (called) return stringAt(2)
  return stringAt(1)
}

/**
 * Every module a source names: `import … from`, `export … from`, a bare
 * `import "x"`, `import("x")` (dynamic or in a type), and `require("x")`,
 * including `import type`. Comments and ordinary strings name no module.
 */
export const moduleReferences = (text: string): ReadonlyArray<ModuleReference> => {
  const tokens = sourceTokens(text)
  return tokens.flatMap((_, position) =>
    Option.match(specifierAt(tokens, position), {
      onNone: () => [],
      onSome: (token) => [{ specifier: token.value, line: token.line }],
    }),
  )
}

/** The path a relative specifier names from `file`, or none for a package specifier. */
const relativeTarget = (file: string, specifier: string): Option.Option<string> => {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return Option.none()
  const segments = file.split("/").slice(0, -1)
  for (const part of specifier.split("/")) {
    if (part === "..") segments.pop()
    else if (part !== "." && part !== "") segments.push(part)
  }
  return Option.some(segments.join("/"))
}

const declaredWorkspaceNames = (manifest: WorkspaceManifest): ReadonlySet<string> =>
  new Set([
    manifest.name,
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])

/**
 * A file that imports a workspace package its own manifest does not declare,
 * or reaches across its workspace root with a relative path. Turbo orders and
 * caches tasks by the declared graph, so an undeclared edge lets a cached
 * typecheck replay green after the imported package broke it. Core's test
 * harness once called `@gent/sdk`, which depends on core: a cycle no manifest
 * showed. A relative path into another workspace is the same edge without a
 * name. `manifests` is keyed by package directory (`packages/core`). Fixture
 * trees hold source as data, not imports.
 */
export const findUndeclaredWorkspaceImports = (
  manifests: ReadonlyMap<string, WorkspaceManifest>,
  sourceTexts: ReadonlyMap<string, string>,
): ReadonlyArray<UndeclaredImportFinding> => {
  const findings: Array<UndeclaredImportFinding> = []
  for (const [file, text] of sourceTexts) {
    if (file.includes("/fixtures/")) continue
    const owner = Option.fromNullishOr([...manifests].find(([dir]) => file.startsWith(`${dir}/`)))
    if (Option.isNone(owner)) continue
    const [dir, manifest] = owner.value
    const declared = declaredWorkspaceNames(manifest)
    for (const { specifier, line } of moduleReferences(text)) {
      const target = relativeTarget(file, specifier)
      if (Option.isSome(target)) {
        if (target.value.startsWith(`${dir}/`)) continue
        findings.push({
          file,
          line,
          message: `reaches \`${specifier}\` across the ${dir} workspace root; import a declared package entry instead`,
        })
        continue
      }
      const imported = Option.flatMap(
        Option.fromNullishOr(WORKSPACE_PACKAGE.exec(specifier)),
        (match) => Option.fromNullishOr(match[1]),
      )
      if (Option.isNone(imported) || declared.has(imported.value)) continue
      findings.push({
        file,
        line,
        message: `imports \`${imported.value}\`, which ${dir}/package.json does not declare; declare it without a cycle, or move the code to a package that does`,
      })
    }
  }
  return findings
}
