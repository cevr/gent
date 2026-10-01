import { Option, Predicate, Schema } from "effect"
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

const blankKeepingLines = (text: string): string =>
  text
    .split("\n")
    .map((line) => " ".repeat(line.length))
    .join("\n")

// ── the lexer ───────────────────────────────────────────────────────────────

/**
 * How a file's text is lexed: `tsx` also reads JSX, whose tags and text are
 * not TypeScript. A `.tsx` or `.jsx` file is `tsx`.
 */
type Syntax = "ts" | "tsx"

const syntaxOf = (file: string): Syntax => {
  if (/\.[cm]?[jt]sx$/.test(file)) return "tsx"
  return "ts"
}

/**
 * A scanner frame. A count of 0 or more is code, with that many braces open
 * in the stretch (an interpolation or a JSX expression closes at 0). The
 * negative values are the stretches that are not code.
 */
const IN_TEMPLATE = -1
/** Inside a JSX tag, among its attributes. */
const IN_TAG = -2
/** Inside a JSX element, among its children. */
const IN_CHILDREN = -3

/** What one scanner step read. */
type TokenKind = "code" | "comment" | "string" | "template" | "regex" | "jsx-text"

interface Token {
  readonly kind: TokenKind
  readonly end: number
}

/** The end of a quoted string that starts at `start`: its closing quote, or the line end. */
const quotedEnd = (text: string, start: number): number => {
  const quote = text[start]
  let at = start + 1
  while (at < text.length && text[at] !== quote && text[at] !== "\n") {
    at += 1 + Number(text[at] === "\\")
  }
  return Math.min(at + 1, text.length)
}

/** The end of a JSX attribute string: its closing quote, across lines, with no escapes. */
const attributeEnd = (text: string, start: number): number => {
  const close = text.indexOf(text[start] ?? "", start + 1)
  if (close === -1) return text.length
  return close + 1
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

/** Characters after which a `/` opens a regex literal, and a `<` a JSX tag, rather than an operator. */
const OPERAND_PRECEDERS = "(,=:[!&|?{};+-*%<>~^"
const OPERAND_KEYWORD_BEFORE =
  /(?:^|[^\w$])(?:return|typeof|case|void|delete|in|of|new|throw|yield|await|else|do)$/

/** A statement head whose `(...)` ends in no value: `if (ok) /re/` starts an operand. */
const CONTROL_HEAD = /(?:^|[^\w$.])(?:if|while|for(?:\s+await)?|with)\s*$/

/**
 * Where the `//` comment on the line from `lineStart` opens, if it opens
 * before `end`. The line is lexed from its start, so a `//` in a string or a
 * regex on it is text.
 */
const lineCommentStart = (text: string, lineStart: number, end: number): Option.Option<number> => {
  if (!text.slice(lineStart, end).includes("//")) return Option.none()
  const frames = [0]
  let at = lineStart
  while (at < end) {
    const token = lexStep(text, at, frames, "ts")
    if (token.kind === "comment" && text.startsWith("//", at)) return Option.some(at)
    at = token.end
  }
  return Option.none()
}

/** The end of the last significant text before `at`: whitespace and comments skipped. */
const significantEnd = (text: string, at: number): number => {
  let end = at
  for (;;) {
    while (end > 0 && /\s/.test(text[end - 1] ?? "")) end -= 1
    if (text.startsWith("*/", end - 2)) {
      const blockOpen = text.lastIndexOf("/*", end - 3)
      if (blockOpen === -1) return end
      end = blockOpen
      continue
    }
    const lineComment = lineCommentStart(text, text.lastIndexOf("\n", end - 1) + 1, end)
    if (Option.isNone(lineComment)) return end
    end = lineComment.value
  }
}

/** Whether the `)` at `close` ends a control-flow head: `if (...)`, `while (...)`, `for (...)`. */
const closesControlHead = (text: string, close: number): boolean => {
  let depth = 0
  for (let at = close; at >= 0; at -= 1) {
    if (text[at] === ")") depth += 1
    if (text[at] === "(") depth -= 1
    if (depth === 0) return CONTROL_HEAD.test(text.slice(Math.max(0, at - 16), at))
  }
  return false
}

/**
 * Whether an operand starts at `at`: the token before it, past whitespace
 * and comments, cannot end a value. A `)` ends one unless it closes a
 * control-flow head.
 */
const startsOperand = (text: string, at: number): boolean => {
  const end = significantEnd(text, at)
  if (end === 0) return true
  const last = text[end - 1] ?? ""
  if (OPERAND_PRECEDERS.includes(last)) return true
  if (last === ")") return closesControlHead(text, end - 1)
  return OPERAND_KEYWORD_BEFORE.test(text.slice(Math.max(0, end - 8), end))
}

/** The end of a regex literal that opens at `start`: past its flags, or at the line end. */
const regexEnd = (text: string, start: number): number => {
  let at = start + 1
  let inClass = false
  while (at < text.length && text[at] !== "\n") {
    const char = text[at]
    if (char === "\\") at += 2
    else if (char === "/" && !inClass) {
      at += 1
      while (/[a-z]/i.test(text[at] ?? "")) at += 1
      return at
    } else {
      if (char === "[") inClass = true
      if (char === "]") inClass = false
      at += 1
    }
  }
  return at
}

/**
 * A tag name after `<`, and what follows it. A `,`, an `extends` or a `=`
 * after the name, or a one-letter capital name, makes the `<` a type
 * parameter list: `.tsx` spells a generic arrow `<A,>(a: A) => a`, with a
 * constraint `<A extends B,>` or a default `<A = B,>`. No JSX tag name is
 * followed by `=`.
 */
const JSX_OPENER = /^<(?:>|([A-Za-z_$][\w$.:-]*)(\s*(?:,|=|extends\b))?)/

/** Whether the `<` at `at` opens a JSX element. */
const opensJsx = (text: string, at: number): boolean => {
  if (!startsOperand(text, at)) return false
  const opener = Option.fromNullishOr(JSX_OPENER.exec(text.slice(at, at + 64)))
  if (Option.isNone(opener)) return false
  const [, name = "", typeParameter] = opener.value
  return Predicate.isUndefined(typeParameter) && !/^[A-Z]$/.test(name)
}

/** A lookup of the character codes in `chars`, for a scan that stops on any of them. */
const charTable = (chars: string): Uint8Array => {
  const table = new Uint8Array(128)
  for (const char of chars) table[char.charCodeAt(0)] = 1
  return table
}

/** The characters each frame's step reads; any other run is copied whole. */
const SPECIAL = {
  ts: charTable("/\"'`{}"),
  tsx: charTable("/\"'`{}<"),
  template: charTable("$\\`"),
  tag: charTable("/\"'{>"),
  children: charTable("{<"),
}

/** The end of the run from `at` that holds none of `table`'s characters. */
const plainRunEnd = (text: string, at: number, table: Uint8Array): number => {
  let end = at
  while (end < text.length) {
    const code = text.charCodeAt(end)
    if (code < 128 && table[code] === 1) return end
    end += 1
  }
  return end
}

/** A `}` in code: close a brace, or the interpolation or JSX expression it ends. */
const closeBrace = (frames: Array<number>): void => {
  const top = frames.length - 1
  const depth = frames[top] ?? 0
  if (depth === 0 && top > 0) frames.pop()
  else frames[top] = Math.max(depth - 1, 0)
}

/** One step in code. */
const codeStep = (text: string, at: number, frames: Array<number>, syntax: Syntax): Token => {
  const char = text[at] ?? ""
  const next = text[at + 1] ?? ""
  if (char === "/" && (next === "/" || next === "*")) {
    return { kind: "comment", end: commentEnd(text, at, `/${next}`) }
  }
  if (char === "/" && startsOperand(text, at)) return { kind: "regex", end: regexEnd(text, at) }
  if (char === '"' || char === "'") return { kind: "string", end: quotedEnd(text, at) }
  if (char === "`") frames.push(IN_TEMPLATE)
  if (char === "<" && syntax === "tsx" && opensJsx(text, at)) frames.push(IN_TAG)
  if (char === "{") frames[frames.length - 1] = (frames.at(-1) ?? 0) + 1
  if (char === "}") closeBrace(frames)
  return { kind: "code", end: at + 1 }
}

/** One step in a template's text. The `${` and the closing backtick are code: structure. */
const templateStep = (text: string, at: number, frames: Array<number>): Token => {
  if (text.startsWith("${", at)) {
    frames.push(0)
    return { kind: "code", end: at + 2 }
  }
  if (text[at] === "\\") return { kind: "template", end: at + 2 }
  if (text[at] === "`") {
    frames.pop()
    return { kind: "code", end: at + 1 }
  }
  return { kind: "template", end: at + 1 }
}

/** One step among a JSX tag's attributes. `>` opens the children; `/>` ends the element. */
const tagStep = (text: string, at: number, frames: Array<number>): Token => {
  const char = text[at] ?? ""
  const next = text[at + 1] ?? ""
  if (char === "/" && (next === "/" || next === "*")) {
    return { kind: "comment", end: commentEnd(text, at, `/${next}`) }
  }
  if (char === '"' || char === "'") return { kind: "string", end: attributeEnd(text, at) }
  if (char === "{") frames.push(0)
  if (char === ">") frames[frames.length - 1] = IN_CHILDREN
  if (char === "/" && next === ">") {
    frames.pop()
    return { kind: "code", end: at + 2 }
  }
  return { kind: "code", end: at + 1 }
}

/** One step among a JSX element's children. A closing tag ends the element. */
const childrenStep = (text: string, at: number, frames: Array<number>): Token => {
  if (text[at] === "{") frames.push(0)
  if (text[at] !== "<") return { kind: "code", end: at + 1 }
  if (text[at + 1] !== "/") {
    frames.push(IN_TAG)
    return { kind: "code", end: at + 1 }
  }
  frames.pop()
  const close = text.indexOf(">", at)
  if (close === -1) return { kind: "code", end: text.length }
  return { kind: "code", end: close + 1 }
}

/**
 * One step of the lexer from `at`, in the frame on top of `frames`: a run
 * no step reads, or one token. A step that opens or closes a template, a JSX
 * tag or element, an interpolation or a JSX expression pushes or pops its frame.
 */
const lexStep = (text: string, at: number, frames: Array<number>, syntax: Syntax): Token => {
  const frame = frames.at(-1) ?? 0
  if (frame === IN_TEMPLATE) {
    const runEnd = plainRunEnd(text, at, SPECIAL.template)
    if (runEnd > at) return { kind: "template", end: runEnd }
    return templateStep(text, at, frames)
  }
  if (frame === IN_TAG) {
    const runEnd = plainRunEnd(text, at, SPECIAL.tag)
    if (runEnd > at) return { kind: "code", end: runEnd }
    return tagStep(text, at, frames)
  }
  if (frame === IN_CHILDREN) {
    const runEnd = plainRunEnd(text, at, SPECIAL.children)
    if (runEnd > at) return { kind: "jsx-text", end: runEnd }
    return childrenStep(text, at, frames)
  }
  const runEnd = plainRunEnd(text, at, SPECIAL[syntax])
  if (runEnd > at) return { kind: "code", end: runEnd }
  return codeStep(text, at, frames, syntax)
}

/**
 * Where the token that opens at `at` ends when its text is not code -- a
 * string, a template, a comment, a regex literal or a JSX element -- or `at`
 * when none opens there. A bracket inside one is text, not structure.
 */
const lexicalEnd = (text: string, at: number, syntax: Syntax): number => {
  const frames = [0]
  const first = lexStep(text, at, frames, syntax)
  if (frames.length === 1) {
    if (first.kind === "code") return at
    return first.end
  }
  let end = first.end
  while (frames.length > 1 && end < text.length) end = lexStep(text, end, frames, syntax).end
  return end
}

const OPENERS = "([{"
const CLOSERS = ")]}"

/**
 * The first index at or after `start` where `stopsAt` holds at bracket depth
 * zero, or where a closer takes the depth below zero: it closes a bracket
 * opened before `start`. A string, a template, a comment, a regex literal or
 * a JSX element is skipped whole. `text.length` when neither comes. Every
 * bracket walk in this file is this one.
 */
const topLevelStop = (
  text: string,
  start: number,
  syntax: Syntax,
  stopsAt: (at: number) => boolean = () => false,
): number => {
  let depth = 0
  let at = start
  while (at < text.length) {
    const char = text[at] ?? ""
    if (depth === 0 && stopsAt(at)) return at
    const skipped = lexicalEnd(text, at, syntax)
    if (skipped > at) {
      at = skipped
      continue
    }
    if (OPENERS.includes(char)) depth += 1
    else if (CLOSERS.includes(char)) {
      if (depth === 0) return at
      depth -= 1
    }
    at += 1
  }
  return text.length
}

/** The text from the bracket at `open` through the one that closes it, or to the end. */
const bracketedAt = (text: string, open: number, syntax: Syntax): string =>
  text.slice(open, topLevelStop(text, open + 1, syntax) + 1)

/** What `blankComments` blanks beside the comments. */
interface Blanking {
  /** Each quoted string becomes `""`, and JSX text becomes spaces. */
  readonly quoted: boolean
  /** A template's own text becomes spaces; its `${}` interpolations stay code. */
  readonly templateText: boolean
}

/** A string blanked to `""`, keeping the line breaks a JSX attribute string may hold. */
const blankedString = (chunk: string): string => `""${"\n".repeat(chunk.split("\n").length - 1)}`

/** One token's text as `blanking` leaves it. A comment is always blanked. */
const blankedToken = (kind: TokenKind, chunk: string, blanking: Blanking): string => {
  if (kind === "comment") return blankKeepingLines(chunk)
  if (kind === "string" && blanking.quoted) return blankedString(chunk)
  if (kind === "jsx-text" && blanking.quoted) return blankKeepingLines(chunk)
  if (kind === "template" && blanking.templateText) return blankKeepingLines(chunk)
  return chunk
}

/**
 * Blank the comments in `text`, line count preserved, read left to right by
 * the lexer, so a `//` inside a string or a regex literal stays text.
 * Template literals and JSX are followed into their `${}` interpolations and
 * `{}` expressions, so a comment there is blanked too, and each of those is
 * kept whatever else `blanking` blanks, because it reads code.
 */
const blankComments = (text: string, blanking: Blanking, syntax: Syntax): string => {
  const out: Array<string> = []
  const frames = [0]
  let at = 0
  while (at < text.length) {
    const token = lexStep(text, at, frames, syntax)
    out.push(blankedToken(token.kind, text.slice(at, token.end), blanking))
    at = token.end
  }
  return out.join("")
}

/**
 * Each text's blanked forms, keyed by the text: a guards run blanks one
 * file's text for several scans, and the scan is the run's largest cost.
 */
const blankCaches = () => ({
  code: new Map<string, string>(),
  codeOnly: new Map<string, string>(),
  statements: new Map<string, string>(),
})

const blankedTexts = { ts: blankCaches(), tsx: blankCaches() }

type BlankForm = keyof ReturnType<typeof blankCaches>

const blankedOnce = (form: BlankForm, text: string, blanking: Blanking, syntax: Syntax): string => {
  const cache = blankedTexts[syntax][form]
  return Option.getOrElse(Option.fromNullishOr(cache.get(text)), () => {
    const blanked = blankComments(text, blanking, syntax)
    cache.set(text, blanked)
    return blanked
  })
}

/** The text with comments blanked, line count preserved. */
const withoutComments = (text: string, syntax: Syntax): string =>
  blankedOnce("code", text, { quoted: false, templateText: false }, syntax)

// ── a lint directive names its rules ────────────────────────────────────────

/**
 * oxlint honors both spellings, `eslint-disable` and `oxlint-disable`, so each
 * pattern matches both. A blanket directive names no rule; a file-wide
 * directive, written as a block or a line comment, disables its rules to the
 * end of the file or the next enable.
 *
 * `effect/requireSuppressionReason` reports a blanket `-next-line` directive,
 * but not a blanket `-line` or file-wide one: that directive disables every
 * rule on its own line, the upstream rule with them. So the guards read them.
 */
const blanketDisableDirective =
  /(?:\/\*\s*(?:es|ox)lint-disable(?:-next-line|-line)?\s*(?:\*\/|--|$))|(?:\/\/\s*(?:es|ox)lint-disable(?:-next-line|-line)?\s*(?:--|$))/

const blockDisableDirective = /(?:\/\*|\/\/)\s*(?:es|ox)lint-disable(?:\s|$)/

/** A file inside a fixture directory; a basename such as `pty-fixture.ts` is not one. */
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

// ── every core seam has a shipped adapter ───────────────────────────────────

/**
 * Guard: every extension seam core declares must have a shipped adapter.
 *
 * Core is the loop plus the extension API. A seam with no implementation
 * behind it is not extensibility -- it is speculative surface that every
 * reader must account for and every refactor must carry. One adapter makes a
 * seam hypothetical; none makes it dead: live, fully wired core machinery
 * whose only registrants are the tests exercising the mechanism itself.
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
 * own pattern to `adaptedSeamsIn` rather than sharing one.
 *
 * Only shipped code counts as an adapter. A test registrant proves the
 * mechanism runs, not that anything needs it -- that is exactly the state
 * this guard exists to catch.
 *
 * @module
 */

/** The file that declares every seam family core has; each scan is anchored on its own interface name. */
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
  const body = text.slice(open + 1, topLevelStop(text, open + 1, "ts"))
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
 * How each seam family is spelled where it is filled. Registrations name the
 * seam in a string argument; a facet is reached as a property on the yielded
 * context; a resource scope is a literal field on the definition. The
 * registration pattern matches across newlines because `host.register(` and
 * its domain argument are often formatted apart, and a single-line pattern
 * would report a filled seam as empty.
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
  const body = match.value[1] ?? ""
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
 * `temp`). A `directory:` literal is relative when it starts with none of `/`,
 * `$` or `~`. A `join(`/`resolve(` literal must also start a path segment (a
 * word character or `.`), so `.join("")`, `.join("\n")` and `.join(", ")` on
 * an array are no path.
 */
const REPO_PATH =
  /\bimport\.meta\.dir(?:name)?\b|\b__dirname\b|\bprocess\.cwd\(\)|\b(?:join|resolve)\(\s*["'`](?=[\w.])|\bdirectory:\s*["'`](?![/$~])/
/** A node `mkdtemp` whose prefix is a relative literal: the directory lands in the working directory. */
const RELATIVE_MKDTEMP = /^mkdtemp(?:Sync)?\s*\(\s*["'`](?![/$~])/
const BINDING = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=(.*)$/
const TEMP_CALL = /\b(?:mkdtempSync|mkdtemp|makeTempDirectoryScoped|makeTempDirectory)\s*\(/g
const TMP_SEGMENT = /["'`](?:[^"'`]*\/)?\.?(?:tmp|temp)(?:[-_.][^"'`/]*)?(?:\/[^"'`]*)?["'`]/i

const TEMP_IN_REPO_MESSAGE =
  "a test temp directory under the repo is linted when a killed test leaves it behind; use `makeTempDirectoryScoped` without `directory` (the loaders bind `effect` and the public entries, so no node_modules is needed above it)"

export const findRepoTempDirectories = (file: string, text: string): ReadonlyArray<Finding> => {
  // The guard's own tests spell the reported shapes as probe text.
  if (!isTestCode(file) || file.startsWith("packages/tooling/")) return []
  const syntax = syntaxOf(file)
  const code = withoutComments(text, syntax)
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
    const argumentText = bracketedAt(code, open, syntax)
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
 * Guard: a test's home, data directory and working directory are its own.
 *
 * A fixed path under the shared temp root (`/tmp`, `/var/tmp`,
 * `/private/tmp`, `/dev/shm`, or `tmpdir()` itself) given as a test's home,
 * data directory, working directory or extension directory is shared by every
 * run and every parallel gate: what one test writes there (prompt history,
 * goal and wake files, a skills cache, `<cwd>/.gent/prompts`), the next one
 * reads (`<cwd>/.gent/extensions`, `<cwd>/AGENTS.md`), so a result depends on
 * run order. Reported in test code, and in the test layers of product and example
 * source (`GentPlatform.Test`; see `sharedHomeScanCode`), all outside the tooling
 * package, at a `home`, `HOME`, `homeDir`, `homeDirectory`, `dataDir`,
 * `GENT_DATA_DIR`, `cwd` (or a `…Cwd` name such as `sessionCwd`), `userDir`
 * or `projectDir` name given a value with `:` or
 * `=`. The value is read as an expression, not as the rest of the line: it
 * may start on the next line, and it ends at a `,`, `;`, closing bracket or
 * line end outside its own brackets, strings and template interpolations, so
 * a sibling property's `/tmp` is not its value. The value is shared when it
 * names such a path in a string or template (`"/tmp/case"`,
 * `path.join("/tmp", "case")`) or calls `tmpdir()` (`` `${tmpdir()}/case` ``,
 * `Path.join(tmpdir(), "case")`), unless it makes a unique directory
 * (`mkdtemp*`, `makeTempDirectory*`). That reads a property, a JSX attribute,
 * a binding, a parameter default (`home: string = "/tmp"`), a fallback
 * (`home: overrides ?? "/tmp"`) and a wrapped value
 * (`homeDirectory: Effect.succeed("/tmp")`) alike. A test that writes there
 * takes `makeTempDirectoryScoped`; a test that only names a directory (a
 * workspace label, a profile key) takes a path no test can create, such as
 * `/nonexistent/<name>`.
 */
const SHARED_HOME_KEY =
  /\b(?:home|HOME|homeDir|homeDirectory|dataDir|GENT_DATA_DIR|cwd|[a-z]\w*Cwd|userDir|projectDir)\b\s*(?::|=(?![=>]))/g

const SHARED_TEMP_ROOT = /["'`](?:(?:\/private)?(?:\/var)?\/tmp|\/dev\/shm)(?=[/"'`$])/

const TEMP_ROOT_CALL = /\btmpdir\(\)/

const UNIQUE_TEMP_CALL = /\b(?:mkdtemp|makeTempDirectory)/

const SHARED_TEMP_HOME_MESSAGE =
  "a test home, data directory or working directory under the shared temp root is shared by every run and parallel gate; use `makeTempDirectoryScoped` (or the harness default cwd) when the test reads or writes there, or a `/nonexistent/<name>` path when it only names one"

/**
 * Where the value expression that starts at `start` ends: a `,`, `;`, closing
 * bracket or line end outside the value's own brackets and strings.
 */
const valueEnd = (text: string, start: number, syntax: Syntax): number =>
  topLevelStop(text, start, syntax, (at) => ",;\n".includes(text[at] ?? ""))

/** Whether a home's value expression is a path under the shared temp root. */
const isSharedTempValue = (value: string): boolean =>
  (SHARED_TEMP_ROOT.test(value) || TEMP_ROOT_CALL.test(value)) && !UNIQUE_TEMP_CALL.test(value)

/**
 * A test-layer declaration in product source: a `static` or `static readonly`
 * member, a binding, or an object key (`Test:`) whose name is a test layer's.
 * A test layer's name is `Test`, a PascalCase name ending in `Test`,
 * `TestLayer` or `TestActor` (`LinkOpenerTest`, `AgentLoopTestActor`), or any
 * name ending in `TestLayer` (`makeTestLayer`). A name with a `Test` word part
 * that names no layer (`runTestTool`, `isTestMode`, `TestModeLabel`) is
 * product code: its body is not read.
 */
const TEST_LAYER_DECLARATION =
  /^\s*(?:(?:static\s+(?:readonly\s+)?|(?:export\s+)?(?:const|let|function)\s+)(?:(?:[A-Z]\w*)?Test(?:Layers?|Actor)?|\w*TestLayers?)\b|(?:readonly\s+)?(?:[A-Z]\w*)?Test(?:Layers?|Actor)?\s*:)/

/**
 * `code` with every line blanked but the test layers', so line numbers hold.
 * A test layer is its declaration line and the lines after it that are blank,
 * indented deeper, or close a bracket at its own indent; the formatter keeps
 * that shape. The product code around it (a `Live` layer, an operator
 * default) is not a test home and is not read.
 */
const testLayerLines = (code: string): string => {
  const lines = code.split("\n")
  const kept = lines.map(() => "")
  for (const [index, line] of lines.entries()) {
    if (!TEST_LAYER_DECLARATION.test(line)) continue
    const indent = line.length - line.trimStart().length
    kept[index] = line
    for (let next = index + 1; next < lines.length; next += 1) {
      const body = lines[next] ?? ""
      const bodyIndent = body.length - body.trimStart().length
      const inside =
        body.trim().length === 0 ||
        bodyIndent > indent ||
        (bodyIndent === indent && /^[)\]}]/.test(body.trimStart()))
      if (!inside) break
      kept[next] = body
    }
  }
  return kept.join("\n")
}

/** An example extension's source: code an author copies, so its test layers are read too. */
const isExampleSource = (file: string): boolean =>
  /^examples\/.+\.[cm]?[jt]sx?$/.test(file) && !isTestSupport(file)

/**
 * The code the shared-home scan reads: all of a test file, and the test
 * layers of a product or example file (`GentPlatform.Test`). The guard's own
 * tests spell the reported shapes as probe text, so the tooling package is out.
 */
const sharedHomeScanCode = (file: string, text: string): Option.Option<string> => {
  if (file.startsWith("packages/tooling/")) return Option.none()
  if (isTestCode(file)) return Option.some(withoutComments(text, syntaxOf(file)))
  if (isShippedSource(file) || isExampleSource(file)) {
    return Option.some(testLayerLines(withoutComments(text, syntaxOf(file))))
  }
  return Option.none()
}

export const findSharedTestHomes = (file: string, text: string): ReadonlyArray<Finding> => {
  const scanned = sharedHomeScanCode(file, text)
  if (Option.isNone(scanned)) return []
  const code = scanned.value
  const reported = new Set<number>()
  for (const key of code.matchAll(SHARED_HOME_KEY)) {
    const afterKey = key.index + key[0].length
    // The value may start on the next line: `home:` then `"/tmp"`.
    const start = afterKey + (/^\s*/.exec(code.slice(afterKey))?.[0].length ?? 0)
    if (isSharedTempValue(code.slice(start, valueEnd(code, start, syntaxOf(file))))) {
      reported.add(code.slice(0, key.index).split("\n").length)
    }
  }
  return [...reported]
    .sort((a, b) => a - b)
    .map((line) => ({ file, line, message: SHARED_TEMP_HOME_MESSAGE }))
}

// ── the pre-commit hook: the guards, and staged files only ─────────────────

/**
 * Guard: the pre-commit hook runs the guards, and only its fast commands.
 *
 * The hook's other jobs lint and format the staged files. None of them reads
 * what the guards read, so a hook without a `bun run guards` job commits a
 * guard violation that only the gate would catch later.
 *
 * The hook finishes in under 10 s. Typecheck, build, the whole-tree lint and
 * format, and the tests take minutes; they are `bun run gate`'s, and CI runs
 * the gate. A slow step has many spellings (`bun gate`, `turbo run test`,
 * `env NO_COLOR=1 bun run gate`), so the rule names the fast commands instead:
 * every step of a `pre-commit` job's `run:` is the guards script, or oxlint
 * or oxfmt with flags on `{staged_files}` alone, after optional `env`
 * settings. Anything else is a finding on its line.
 *
 * A job is found by the command it runs, not by its name.
 *
 * @module
 */

export const HOOK_FILE = "lefthook.yml"

const GUARD_COMMAND = "bun run guards"

/**
 * oxlint or oxfmt through `bunx`, after optional `env` settings, with flags
 * and the staged files as its only operand.
 */
const STAGED_FILES_COMMAND =
  /^(?:env(?: -u \S+| [A-Za-z_][A-Za-z0-9_]*=\S*)* )?bunx (?:oxlint|oxfmt)(?: --?[A-Za-z][\w-]*(?:=\S+)?)* \{staged_files\}$/

/** The commands the hook may run: each one finishes in seconds. */
const isFastCommand = (command: string): boolean =>
  command === GUARD_COMMAND || STAGED_FILES_COMMAND.test(command)

/** The `pre-commit` hook's own key, at the top level of the file. */
const PRE_COMMIT = /^pre-commit:/

/** Any other top-level key closes the `pre-commit` block. */
const TOP_LEVEL_KEY = /^\S/

/** One line of the hook file: its 1-based number and its text. */
interface HookLine {
  readonly line: number
  readonly text: string
}

/** The lines under `pre-commit:`, up to the next top-level key. */
const preCommitLines = (text: string): ReadonlyArray<HookLine> => {
  const lines = text.split("\n")
  const start = lines.findIndex((line) => PRE_COMMIT.test(line))
  if (start === -1) return []
  const rest = lines
    .slice(start + 1)
    .map((line, index) => ({ line: start + 2 + index, text: line }))
  const end = rest.findIndex((line) => TOP_LEVEL_KEY.test(line.text))
  if (end === -1) return rest
  return rest.slice(0, end)
}

/** A job's `run:` entry; a comment line never matches. */
const RUN_ENTRY = /^\s*(?:-\s+)?run:\s*(.*)$/

/**
 * The commands a `run:` value executes, with its trailing comment and quotes
 * removed and each run of whitespace read as one space.
 */
const runCommands = (value: string): ReadonlyArray<string> =>
  value
    .replace(/\s+#.*$/, "")
    .replace(/^(["'])(.*)\1$/, "$2")
    .split(/&&|\|\||;/)
    .map((command) => command.trim().replace(/\s+/g, " "))

/** Each `run:` entry of the `pre-commit` hook: its line and the commands it executes. */
const preCommitSteps = (text: string) =>
  preCommitLines(text).flatMap(({ line, text: lineText }) =>
    Option.match(Option.fromNullishOr(RUN_ENTRY.exec(lineText)?.[1]), {
      onNone: () => [],
      onSome: (value) => [{ line, commands: runCommands(value) }],
    }),
  )

export const findPreCommitHookFindings = (file: string, text: string): ReadonlyArray<Finding> => {
  if (file !== HOOK_FILE) return []
  const steps = preCommitSteps(text)
  const findings: Array<Finding> = steps.flatMap(({ line, commands }) =>
    commands
      .filter((command) => !isFastCommand(command))
      .map((command) => ({
        file,
        line,
        message: `\`${command}\` is not one of the hook's fast commands (\`${GUARD_COMMAND}\`, or \`bunx oxlint\` or \`bunx oxfmt\` on \`{staged_files}\`); the hook finishes in under 10 s -- leave whole-tree steps to \`bun run gate\` and CI`,
      })),
  )
  if (steps.some(({ commands }) => commands.includes(GUARD_COMMAND))) return findings
  return [
    {
      file,
      line: 1,
      message: `the pre-commit hook runs no \`${GUARD_COMMAND}\` job -- the guards then reach a commit only through the gate`,
    },
    ...findings,
  ]
}

// ── every test lane sets the shared test defaults ───────────────────────────

/**
 * The bun timeout a plain lane passes. The preload's `setDefaultTimeout`
 * holds for each file of a `--parallel` run, which evaluates the preload once
 * per file, and for a one-file run. A plain multi-file run evaluates it once
 * and applies it to its first file only; the files after it keep bun's 5 s
 * default. The command line applies to every file, so a plain lane passes the
 * preload's value there.
 */
const TEST_TIMEOUT_FLAG = "--timeout=30000"

/** The preload every lane loads: logs off, a temp home, the 30 s bun timeout. */
const TEST_PRELOAD = /--preload\s+\S*\/src\/test-preload\.ts(?:\s|$)/

/** The gamut fixture is a user's project that gamut opens; its `bun test` is not a gent lane. */
const GAMUT_FIXTURE = /^testbeds\/gamut\/fixture\//

/**
 * Guard: every package script that runs `bun test` loads the test preload,
 * and one that runs without `--parallel` also passes the preload's timeout.
 */
export const findTestLaneDefaults = (file: string, text: string): ReadonlyArray<Finding> => {
  if (!isManifest(file) || GAMUT_FIXTURE.test(file)) return []
  const scripts = Option.match(decodeManifestScripts(text), {
    onNone: () => [],
    onSome: (manifest) => Object.entries(manifest.scripts ?? {}),
  })
  return scripts.flatMap(([name, script]) => {
    if (!/\bbun test\b/.test(script)) return []
    const line = lineAt(text, text.indexOf(`"${name}":`))
    const words = script.split(/\s+/)
    const findings: Array<Finding> = []
    if (!TEST_PRELOAD.test(script)) {
      findings.push({
        file,
        line,
        message: `script \`${name}\` runs \`bun test\` without the test preload -- its tests then log, and write into the real home`,
      })
    }
    if (!words.includes("--parallel") && !words.includes(TEST_TIMEOUT_FLAG)) {
      findings.push({
        file,
        line,
        message: `script \`${name}\` runs \`bun test\` without \`--parallel\` or \`${TEST_TIMEOUT_FLAG}\` -- a plain multi-file run keeps bun's 5 s default past its first file`,
      })
    }
    return findings
  })
}

// ── lint config names nothing that is gone ──────────────────────────────────

/**
 * Guards: the lint config and the environment must not name things that are gone.
 *
 * Four findings, all of the same shape -- a declaration whose subject left the
 * tree, which stays green because nothing ever reads it again:
 *
 * - An `.oxlintrc.json` override whose `files` glob matches no tracked file:
 *   it turns a rule off for nothing. The same holds for an `.oxlintignore` row
 *   and for an `include` glob of an Effect language-service override in the
 *   root tsconfig.
 * - A rule defined in `gent-rules.ts` that the root config never names: a rule
 *   nobody decided on, which may not even pass on shipped code.
 * - A `GENT_*` environment variable read in the source with nothing to set it:
 *   a branch nothing can take that looks like working code.
 * - A `GENT_*` environment variable set, in production or a test, that
 *   nothing reads: a setter that configures nothing.
 *
 * Each list of exceptions is a claim with a reason beside it, not a switch.
 *
 * @module
 */

// ── (a) An override whose files glob matches nothing ────────────────────────

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
        message: `oxlint override \`files: "${glob}"\` matches no staged or committed file; delete the override, or fix the glob`,
      })
    }
  }
  return findings
}

/**
 * An `.oxlintignore` row that matches no file oxlint would walk in a clean
 * clone. oxlint also honors `.gitignore`, so `trackedFiles` is the git index
 * (`indexFileNames`): a row that only an untracked local file matches is
 * reported here, as CI would report it. A row follows gitignore form: a trailing `/`
 * names a directory, a row with no inner `/` matches at any depth, a leading
 * `/` anchors at the root. Comment, blank and `!` rows are skipped.
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
        message: `ignore row \`${row}\` matches no staged or committed file oxlint would lint (git-ignored files are skipped already); delete the row, or fix it`,
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
          message: `tsconfig plugin override \`include: "${glob}"\` matches no staged or committed file; delete it, or fix the glob`,
        },
      ]
    })

// ── (b) A plugin rule the root config never enables ─────────────────────────

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
    .values()
    .filter((rule) => !rootRules.has(`gent/${rule}`))
    .map((rule) => ({
      file: pluginFile,
      line: lineOfRule(pluginText, rule),
      message: `lint rule \`gent/${rule}\` is defined but the root config never enables it; enable it, or delete the rule and its fixtures`,
    }))
    .toArray()

// ── (c) A GENT_* variable with a reader but nothing to set it ───────────────

/**
 * Variables a person or an external launcher supplies, so production holds no
 * writer for them by design. Each entry says who sets it. The table is checked
 * too: an entry nothing reads, or one production sets after all, is reported.
 */
const EXTERNALLY_SET: ReadonlyMap<string, string> = new Map([
  ["GENT_LOG_LEVEL", "a developer sets this by hand to raise log verbosity"],
  ["GENT_AUTH_DIRECTORY", "the operator names the auth directory"],
])

/**
 * A quoted name is a read wherever it sits -- `Config.String("GENT_X")`, the
 * last argument of `Config.Literals([...], "GENT_X")` on its own line,
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
 *   `const childEnv = { GENT_X: v }`, the shape a spawned process receives;
 *   a record merged into the environment, `Object.assign(process.env, { GENT_X: v })`;
 *   and a record a config provider serves, `ConfigProvider.fromEnvRecord({ GENT_X: v })`
 *   or `ConfigProvider.fromUnknown({ GENT_X: v })`. A record bound to any other
 *   name is not read as a writer, so its reader is reported: the guard fails
 *   loud there, never open;
 * - an assignment: `process.env.GENT_X = v`, `Bun.env["GENT_X"] = v`;
 * - a shell prefix in a package script: `"dev": "GENT_X=1 bun run ..."`.
 */
const ENV_RECORD_OPEN =
  /\b(?:(?:env|[a-z]\w*Env)\s*[:=]|from(?:EnvRecord|Unknown)\(|Object\.assign\(\s*(?:process|Bun)\.env\s*,)\s*\{/g
const ENV_RECORD_KEY = /(?:^|[{,\s])["']?(GENT_[A-Z0-9_]+)["']?\s*:/g
const ENV_ASSIGNMENT =
  /\b(?:process|Bun)\.env(?:\.(GENT_[A-Z0-9_]+)|\[["'](GENT_[A-Z0-9_]+)["']\])\s*=(?!=)/g
const SCRIPT_PREFIX = /(?:^|[\s"'&;|(])(GENT_[A-Z0-9_]+)=\S/g

/** A name one match captured, and where in the text the match starts. */
interface NameAt {
  readonly name: string
  readonly at: number
}

/** The name each match of `pattern` in `text` captured, offset by `base`. */
const namesMatchingAt = (text: string, pattern: RegExp, base = 0): ReadonlyArray<NameAt> =>
  [...text.matchAll(pattern)].flatMap((match) =>
    captured(match).map((name) => ({ name, at: base + match.index })),
  )

/**
 * The names source `text` (comments blanked) sets, by the record shape --
 * including the record a test hands `ConfigProvider.fromEnvRecord` -- and the
 * assignment shape.
 */
const namesWritten = (text: string, syntax: Syntax): ReadonlyArray<NameAt> => [
  ...[...text.matchAll(ENV_RECORD_OPEN)].flatMap((match) => {
    const open = match.index + match[0].length - 1
    return namesMatchingAt(bracketedAt(text, open, syntax), ENV_RECORD_KEY, open)
  }),
  ...namesMatchingAt(text, ENV_ASSIGNMENT),
]

/** A manifest: its `scripts` can set a `GENT_*` variable, the way an operator's shell does. */
export const isManifest = (file: string): boolean => /(?:^|\/)package\.json$/.test(file)

/** The one manifest field that runs a shell: every other field is data. */
const decodeManifestScripts = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
  ),
)

/** A manifest's script bodies: the only field that runs a shell. */
const manifestScripts = (text: string): ReadonlyArray<string> =>
  Option.match(decodeManifestScripts(text), {
    onNone: () => [],
    onSome: (manifest) => Object.values(manifest.scripts ?? {}),
  })

/** Every `GENT_*` token: a shell's `$GENT_X`, a config string's `${GENT_X}`, a key, a read. */
const GENT_NAME = /\bGENT_[A-Z0-9_]+\b/g

interface VariableUse {
  readonly file: string
  readonly line: number
  /** A test, a fixture or the test harness: it proves a variable works, not that production uses it. */
  readonly testSupport: boolean
}

/** The name each match captured, in whichever alternative captured it. */
const namesMatching = (line: string, pattern: RegExp): ReadonlyArray<string> =>
  [...line.matchAll(pattern)].flatMap(captured)

/** The name one match captured: the first alternative that captured one. */
const captured = (match: RegExpMatchArray): ReadonlyArray<string> =>
  Option.toArray(Option.firstSomeOf(match.slice(1).map((name) => Option.fromNullishOr(name))))

/** The guard's own test names variables in its fixtures; those are not call sites either. */
const GUARDS_TEST_FILE = "packages/tooling/tests/guards.test.ts"

interface GentVariableUses {
  readonly readers: ReadonlyMap<string, ReadonlyArray<VariableUse>>
  readonly writers: ReadonlyMap<string, ReadonlyArray<VariableUse>>
  readonly mentions: ReadonlyMap<string, number>
}

/** Both variable finders read one scan of one tree: the scan runs once per map. */
const gentVariableUses = new WeakMap<ReadonlyMap<string, string>, GentVariableUses>()

/**
 * Where each `GENT_*` variable is read and where it is set, in production and
 * in tests, and how many times code or a package script names it at all.
 */
const collectGentVariableUses = (sourceTexts: ReadonlyMap<string, string>): GentVariableUses => {
  const cached = Option.fromNullishOr(gentVariableUses.get(sourceTexts))
  if (Option.isSome(cached)) return cached.value
  const readers = new Map<string, Array<VariableUse>>()
  const writers = new Map<string, Array<VariableUse>>()
  const mentions = new Map<string, number>()
  const record = (uses: Map<string, Array<VariableUse>>, name: string, use: VariableUse) => {
    const found = uses.get(name) ?? []
    found.push(use)
    uses.set(name, found)
  }
  const mention = (text: string) => {
    for (const [name] of text.matchAll(GENT_NAME)) mentions.set(name, (mentions.get(name) ?? 0) + 1)
  }
  for (const [file, text] of sourceTexts) {
    // The finder and its test name variables to describe themselves; they are not call sites.
    if (file === GUARDS_FILE || file === GUARDS_TEST_FILE) continue
    const testSupport = isTestSupport(file)
    // A manifest's scripts set a variable by a shell prefix and read one by `$GENT_X`.
    if (isManifest(file)) {
      for (const script of manifestScripts(text)) {
        mention(script)
        for (const name of namesMatching(script, SCRIPT_PREFIX)) {
          const line = lineAt(text, text.indexOf(`${name}=`))
          record(writers, name, { file, line, testSupport })
        }
      }
      continue
    }
    // A comment that shows `GENT_X=1` documents a variable; it sets nothing.
    const syntax = syntaxOf(file)
    const code = withoutComments(text, syntax)
    mention(code)
    for (const [index, line] of code.split("\n").entries()) {
      for (const name of [...quotedReads(line), ...namesMatching(line, DIRECT_READ)]) {
        record(readers, name, { file, line: index + 1, testSupport })
      }
    }
    for (const write of namesWritten(code, syntax)) {
      record(writers, write.name, { file, line: lineAt(code, write.at), testSupport })
    }
  }
  const uses = { readers, writers, mentions }
  gentVariableUses.set(sourceTexts, uses)
  return uses
}

/** The uses in `uses` outside test support, for each name that has one. */
const inProduction = (uses: ReadonlyMap<string, ReadonlyArray<VariableUse>>) =>
  new Map(
    [...uses].flatMap(([name, found]) => {
      const production = found.filter((use) => !use.testSupport)
      if (production.length === 0) return []
      return [[name, production] as const]
    }),
  )

/** The line of an `EXTERNALLY_SET` entry in this file, for a finding that points at it. */
const externallySetLine = (sourceTexts: ReadonlyMap<string, string>, name: string): number =>
  (sourceTexts.get(GUARDS_FILE) ?? "")
    .split("\n")
    .findIndex((line) => line.includes(`["${name}",`)) + 1

export const findReadersWithoutWriters = (
  sourceTexts: ReadonlyMap<string, string>,
  externallySet: ReadonlyMap<string, string> = EXTERNALLY_SET,
): ReadonlyArray<Finding> => {
  // A test, the e2e fixtures or the harness setting a variable proves the
  // reader works, not that anything in production supplies it.
  const uses = collectGentVariableUses(sourceTexts)
  const readers = inProduction(uses.readers)
  const writers = inProduction(uses.writers)
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

/**
 * A variable set, in production or in a test, that nothing but its setters
 * names: the setter configures nothing, and a test that sets it tests a knob
 * that is gone.
 *
 * A read is not always visible as one. A child shell reads `$GENT_X` from the
 * environment it inherits, and code may read `Bun.env[key]` with the key taken
 * from data such as a config string's `${GENT_X}`. So the guard does not ask
 * for a read it can recognise; it asks whether code or a package script names
 * the variable anywhere other than where it is set, in production or in tests.
 * Only then can no read exist, save one that builds the name from parts
 * (`"GENT_" + suffix`), which this guard cannot see and the tree should not
 * write. The finding says so.
 */
export const findWritersWithoutReaders = (
  sourceTexts: ReadonlyMap<string, string>,
): ReadonlyArray<Finding> => {
  const { writers, mentions } = collectGentVariableUses(sourceTexts)
  return [...writers]
    .filter(([name, sites]) => (mentions.get(name) ?? 0) <= sites.length)
    .flatMap(([name, sites]) =>
      sites.map((site) => ({
        file: site.file,
        line: site.line,
        message: `\`${name}\` is set but nothing in the tree names it apart from its setters, so nothing reads it (a read by a name built from parts is invisible here; spell the name out); delete the setter`,
      })),
    )
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
  {
    file: "packages/extensions/src/mcp.ts",
    layer: "BunHttpServer.layerServer",
    reason:
      "the OAuth redirect listener of `/mcp login` binds a free loopback port for one sign-in; no root provides an HTTP server, and a user extension may start its own listener",
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
        local: parts[2] ?? imported,
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
  [names]
    .values()
    .filter((list) => list.length > 0)
    .map((list) => list.map(escapeRegExp).join("|"))
    .toArray()

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
    listedNames(match[1] ?? "", IMPORT_SPECIFIER).some((name) => bound.has(name.imported)),
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
 *
 * Goes when gent consumes oxlint-plugin-effect 0.19.0, whose AST rule for a
 * provided platform layer replaces this text scan.
 */
export const findPlatformDuplicationViolations = (
  file: string,
  text: string,
): ReadonlyArray<Finding> => {
  if (!isShippedSource(file) || platformProviderRoots.has(file)) return []
  const allowed = new Set(
    platformLayerAllowances
      .values()
      .filter((entry) => entry.file === file)
      .map((entry) => entry.layer),
  )
  const code = withoutComments(text, syntaxOf(file))
  const bindings = platformBunBindings(code)
  const spans = bindingSpans(code)
  const inBindingSpan = (index: number): boolean =>
    spans.some((span) => index >= span.start && index < span.end)
  const provisions = [
    ...code.matchAll(GENT_PLATFORM_LAYER),
    ...code
      .matchAll(platformBunLayerPattern(bindings))
      .filter((match) => !inBindingSpan(match.index)),
  ]
    .values()
    .map((match) => ({ index: match.index, name: collapsedText(match[0]) }))
    .filter((provision) => !allowed.has(provision.name))
    .map((provision) => ({
      index: provision.index,
      message: `\`${provision.name}\` provides a Bun platform layer outside the platform roots; yield the service the root provides, or record why no root can provide it in platformLayerAllowances`,
    }))
    .toArray()
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
 * adapter) are banned by the built-in bans of `effect/noGlobals` instead,
 * because only the AST sees a member access.
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
    message:
      "Hand-written launch decoders are deleted; `gent server start` reads its launch values as flags",
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
    on: "line",
    match: /\ball-errors-are-tagged\b/,
    scope: "shipped-and-tests",
    message:
      "the all-errors-are-tagged lint rule is removed; the Effect language service's extendsNativeError diagnostic, an error in tsconfig.json, rejects a native Error subclass",
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

/** A Markdown link's target: `(target)` after `[text]`, with an optional `"title"`, `'title'` or `(title)`. */
const MARKDOWN_LINK = /\[[^\]\n]*\]\(([^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g

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
  line
    .replace(BACKTICKED, "")
    .matchAll(MARKDOWN_LINK)
    .map((match) => match[1] ?? "")
    .filter((target) => !NOT_REPO_TARGET.test(target))
    .filter((target) =>
      Option.match(resolveRelative(directory, target.replace(/#.*$/, "")), {
        onNone: () => true,
        onSome: (resolved) => !existsInTree(resolved, tracked, prefixes),
      }),
    )
    .toArray()

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
      const claimed = match[1] ?? ""
      if (!isPathClaim(claimed)) continue
      if (existsInTree(claimed, tracked, prefixes)) continue
      findings.push({
        file,
        line: index + 1,
        message: `steering file names \`${claimed}\`, which no staged or committed file matches -- point it at the path that exists, or drop the reference`,
      })
    }
    for (const target of danglingLinkTargets(line, directory, tracked, prefixes)) {
      findings.push({
        file,
        line: index + 1,
        message: `steering file links \`${target}\`, which resolves to no staged or committed file from \`${file}\` -- point the link at the file that exists, or drop it`,
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
 * `BUNDLED_SKILLS_MODULE`, comments blanked. Reported: a Markdown file with no import (at the
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
  // A commented-out import or row ships nothing, so neither is read.
  const code = withoutComments(moduleText, syntaxOf(BUNDLED_SKILLS_MODULE))
  const imported = new Map<string, { readonly path: string; readonly line: number }>()
  for (const [index, line] of code.split("\n").entries()) {
    const match = Option.fromNullishOr(BUNDLED_IMPORT.exec(line.trimStart()))
    if (Option.isSome(match))
      imported.set(match.value[1] ?? "", { path: match.value[2] ?? "", line: index + 1 })
  }
  const rows = new Map<string, string>()
  for (const match of code.matchAll(BUNDLED_ROW)) rows.set(match[2] ?? "", match[1] ?? "")
  const importedPaths = new Set([...imported.values()].map((entry) => entry.path))
  const findings: Array<Finding> = trackedFiles
    .values()
    .filter((file) => file.startsWith(BUNDLED_SKILLS_DIRECTORY) && file.endsWith(".md"))
    .filter((file) => !importedPaths.has(file.slice(BUNDLED_SKILLS_DIRECTORY.length)))
    .map((file) => ({
      file,
      line: 1,
      message: `a bundled skill file that \`${BUNDLED_SKILLS_MODULE}\` does not import never ships; import it as text and list it in \`bundledSkillFiles\`, or delete it`,
    }))
    .toArray()
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

/** The part of a package's `turbo.json` the guide input check reads. */
export const TurboTypecheckInputsSchema = Schema.Struct({
  tasks: Schema.Struct({
    typecheck: Schema.Struct({ inputs: Schema.Array(Schema.String) }),
  }),
})

/**
 * Guard: the guide check's cache key reads exactly the steering prose.
 *
 * `check-guide-code.ts` runs as the examples package's typecheck, and turbo
 * replays a cached result while the task's `inputs` hash the same. An input
 * list that misses a steering file (`../docs/*.md` against
 * `docs/topic/guide.md`) replays a pass after that file alone changes; one
 * that reads a Markdown file outside the set reruns the check for nothing. So
 * over the git index, the `.md` files the inputs match must be the
 * files `isSteeringFile` accepts. Turbo globs are relative to the package, so
 * `../x` names the repo path `x`, and a `!` input subtracts.
 */
export const findUnhashedSteeringFiles = (
  file: string,
  inputs: ReadonlyArray<string>,
  trackedFiles: ReadonlyArray<string>,
): ReadonlyArray<Finding> => {
  const packageDirectory = file.slice(0, file.lastIndexOf("/") + 1)
  const repoGlob = (input: string): RegExp => {
    if (input.startsWith("../")) return globMatcher(input.slice(3))
    return globMatcher(packageDirectory + input)
  }
  const included = inputs
    .values()
    .filter((input) => !input.startsWith("!"))
    .map((input) => repoGlob(input))
    .toArray()
  const excluded = inputs
    .values()
    .filter((input) => input.startsWith("!"))
    .map((input) => repoGlob(input.slice(1)))
    .toArray()
  const hashed = (path: string): boolean =>
    included.some((glob) => glob.test(path)) && !excluded.some((glob) => glob.test(path))
  const message = (path: string): string => {
    if (isSteeringFile(path)) {
      return `the typecheck inputs miss steering file \`${path}\`, so a change to it alone replays a cached guide check; make the inputs match \`isSteeringFile\``
    }
    return `the typecheck inputs read \`${path}\`, which is not steering prose, so a change to it reruns the guide check for nothing; make the inputs match \`isSteeringFile\``
  }
  return trackedFiles
    .values()
    .filter((path) => path.endsWith(".md") && hashed(path) !== isSteeringFile(path))
    .map((path) => ({ file, line: 1, message: message(path) }))
    .toArray()
}

// ── an effect tracks no whole session record ────────────────────────────────

/**
 * Guard: a reactive effect must not track the whole session record.
 *
 * `transitionSessionState` rebuilds the `Session` object for `UpdateName` and
 * `UpdateSettings`, so a rename or a `/model` change hands every reader a new
 * object carrying the same ids. An effect that tracks the record restarts for
 * a change it does not care about: a fiber it owns is interrupted, the rows it
 * projected are dropped and fetched again, and a list it loads is empty while
 * the RPC runs.
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

/** The index of the first record read in the reactive scope the opener on line `index` starts. */
const scopeRecordRead = (lines: ReadonlyArray<string>, index: number): Option.Option<number> => {
  const opener = lines[index] ?? ""
  const openerIndent = opener.length - opener.trimStart().length
  const limit = Math.min(index + 1 + SCOPE_LINES, lines.length)
  for (let cursor = index; cursor < limit; cursor += 1) {
    const candidate = lines[cursor] ?? ""
    // The scope closes when the nesting returns to the opener's column.
    if (cursor > index && candidate.trim().length > 0) {
      const indent = candidate.length - candidate.trimStart().length
      if (indent <= openerIndent && !TRACKING_OPENER.test(candidate)) return Option.none()
    }
    if (RECORD_READ.test(candidate)) return Option.some(cursor)
  }
  return Option.none()
}

export const findTuiSessionIdentityReads = (file: string, text: string): ReadonlyArray<Finding> => {
  if (!TUI_SOURCE.test(file)) return []

  const lines = text.split("\n")
  const reported = new Set<number>()
  const findings: Finding[] = []
  for (const [index, line] of lines.entries()) {
    if (!TRACKING_OPENER.test(line)) continue
    const read = scopeRecordRead(lines, index)
    if (Option.isNone(read) || reported.has(read.value)) continue
    reported.add(read.value)
    findings.push({
      file,
      line: read.value + 1,
      message:
        "this reactive scope reads the whole session record, so a rename or a model change re-runs it -- read `sessionIdentity()` or `activeSessionId()`, which move only when the session or the branch does",
    })
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
    text: "nodeBuiltinImport:off -- synchronous shutdown logging runs after the Effect runtime closes.",
  },
  {
    file: "apps/tui/tests/extensions/loader-boundary.test.ts",
    scope: "next-line",
    text: "nodeBuiltinImport:off -- synchronous filesystem fixture setup is a test boundary.",
  },
  {
    file: "apps/tui/tests/extensions/loader-boundary.test.ts",
    scope: "next-line",
    text: "nodeBuiltinImport:off -- synchronous path fixture setup is a test boundary.",
  },
  {
    file: "packages/core/src/server/workspace-rpc.ts",
    scope: "file",
    text: "nodeBuiltinImport:off -- the workspace id is a wire constant, see workspaceIdForCwd",
  },
  {
    file: "packages/core/src/server/workspace-rpc.ts",
    scope: "file",
    text: "nodeBuiltinImport:off -- the workspace id canonicalizes its cwd before hashing",
  },
  {
    file: "packages/sdk/src/server.ts",
    scope: "file",
    text: "nodeBuiltinImport:off -- server primitive owns filesystem path resolution for gent's data directory",
  },
  {
    file: "packages/sdk/src/server.ts",
    scope: "next-line",
    text: "strictEffectProvide:off -- the public entry point provides the local platform it resolves on.",
  },
  {
    file: "packages/sdk/src/server.ts",
    scope: "next-line",
    text: "strictEffectProvide:off -- self-contained probe, no scope lifetime",
  },
  {
    file: "packages/core/src/domain/extension.ts",
    scope: "next-line",
    text: "anyUnknownInErrorContext:off -- extension setup is untyped until this membrane maps its failures to ExtensionLoadError.",
  },
  {
    file: "packages/tooling/src/check-guide-code.ts",
    scope: "next-line",
    text: "strictEffectProvide:off -- the script's process entry provides the platform once.",
  },
  {
    file: "packages/core/src/test-utils/language-model.ts",
    scope: "file",
    text: "nodeBuiltinImport:off -- test fixture lifecycle comes from bun:test",
  },
  {
    file: "packages/tooling/src/test-preload.ts",
    scope: "file",
    text: "nodeBuiltinImport:off -- the test preload runs in bun's test host before any Effect runtime",
  },
  {
    file: "packages/core/src/test-utils/language-model.ts",
    scope: "next-line",
    text: "strictEffectProvide:off -- test entry point: the probe owns its fake fetch layer.",
  },
  {
    file: "packages/core/src/runtime/tools.ts",
    scope: "next-line",
    text: "anyUnknownInErrorContext:off -- an extension tool fails with unknown until normalizeToolExecutionError maps it.",
  },
  {
    file: "packages/core/src/domain/capability.ts",
    scope: "next-line",
    text: "anyUnknownInErrorContext:off -- the erased handler crosses the runtime membrane; the public overloads keep authors typed.",
  },
  {
    file: "packages/core/src/runtime/extension-host.ts",
    scope: "next-line",
    text: "anyUnknownInErrorContext:off -- the extension membrane erases the author effect channels and seals them here.",
    count: 8,
  },
  {
    file: "packages/core/src/runtime/extension-host.ts",
    scope: "next-line",
    text: "anyUnknownInErrorContext:off -- heterogeneous Resource layer enters the explicit eraseResourceLayer membrane.",
  },
  {
    file: "packages/extensions/src/openai.ts",
    scope: "next-line",
    text: "strictEffectProvide:off -- OAuth token endpoint at extension boundary",
    count: 2,
  },
  {
    file: "packages/extensions/src/openai.ts",
    scope: "next-line",
    text: "strictEffectProvide:off -- device endpoints at extension boundary",
  },
  {
    file: "packages/extensions/src/anthropic.ts",
    scope: "next-line",
    text: "strictEffectProvide:off -- the credential read owns its HTTP client at the extension boundary; it outlives no scope.",
  },
  {
    file: "packages/extensions/src/providers.ts",
    scope: "next-line",
    text: "strictEffectProvide:off -- The catalog owns its own HTTP client at the driver boundary; it outlives no scope.",
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
  const entryLines = (sources.get(GUARDS_FILE) ?? "").split("\n")
  const listed = new Map<string, number>()
  return entries.flatMap((entry) => {
    const comment = approvedComment(entry)
    const key = `${entry.file}\n${comment}`
    const nth = (listed.get(key) ?? 0) + 1
    listed.set(key, nth)
    const at = (): number => {
      const lines = entryLines
        .entries()
        .filter(
          ([index, text]) =>
            text.includes(`file: "${entry.file}"`) &&
            entryLines
              .slice(index, index + 4)
              .some((next) => next.includes(`text: "${entry.text}"`)),
        )
        .map(([index]) => index + 1)
        .toArray()
      return lines.at(nth - 1) ?? 1
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
 *   once another file reads it at the module's path: imports it by name,
 *   re-exports it with `export { X } from`, or reads it off a namespace import
 *   of the module. The path is the repo module the specifier resolves to: a
 *   relative one against the importer's directory, a package one through its
 *   manifest's `exports`. A scanned file may not `export * from` or
 *   `export * as NS from`: the scan cannot see which forwarded name has a
 *   reader, so such a statement is itself a finding. A string, a test title, a
 *   `@ts-expect-error` line or a binding of the reader's own that spells the name is no read. Core
 *   and the SDK are held to the strict reading: a name only its own module
 *   uses should drop the `export` keyword, and so are the extensions package
 *   and the apps. The tooling and e2e packages and
 *   `packages/core/src/test-utils/`, its own surface, are read with the
 *   own-file rule: a guard's finding type, a fixture's context type and a test
 *   layer's config sit beside the function that returns them, so a reference
 *   in the declaring file's code counts -- except the declaration's own lines,
 *   and a string, template text or comment naming it.
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
  /**
   * Whether a reference inside the declaring file, off the declaration lines,
   * keeps a type alive: a builder's config or handle type sits beside the
   * builder that returns it. A value is always read from another file.
   */
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
  /** True for an `export type` or `export interface`: a type, not a value. */
  readonly typeOnly?: boolean
  /**
   * True when the name reaches this file through `export { X } from "..."`.
   * Such a file both exposes the name and names the upstream declaration, so
   * it stays a consumer of that declaration while being measured itself.
   */
  readonly passthrough?: boolean
}

const DECLARATION =
  /^export\s+(?:declare\s+)?(const|class|function|interface|type|enum)\s+([A-Za-z_$][\w$]*)/

/**
 * `(name, line)` for every export a module surface file declares.
 *
 * Three shapes reach the same place. `export const Foo` names the value on the
 * spot. A bare `export { Foo, Bar }` with no `from` clause exposes names this
 * file owns, so it is a surface too. And `export { Foo } from "./x.js"` puts a
 * second consumable name at this module path, so a dead one is dead here even
 * though `./x.js` keeps its own alive.
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
  readonly typeOnly?: boolean
  readonly passthrough?: boolean
}> => {
  const found: Array<{ name: string; line: number; typeOnly: boolean }> = []
  for (const [index, line] of text.split("\n").entries()) {
    const match = DECLARATION.exec(line)
    const name = match?.[2] ?? ""
    if (name === "") continue
    const keyword = match?.[1] ?? ""
    found.push({ name, line: index + 1, typeOnly: keyword === "type" || keyword === "interface" })
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
    const inner = match[1] ?? ""
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

const EXPORT_ENTRY =
  /(?:^|[{,])\s*(?:type\s+)?([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/g

/** The names an export block's text exposes: `type X` is `X`, `X as Y` is `Y`. */
const exposedNamesIn = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(EXPORT_ENTRY)]
    .flatMap((match) =>
      Option.toArray(
        Option.orElse(Option.fromNullishOr(match[2]), () => Option.fromNullishOr(match[1])),
      ),
    )
    .filter((name) => name !== "export" && name !== "type" && name !== "from")

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
    for (const name of exposedNamesIn(open.text)) found.push({ name, line: open.start + 1 })
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
    for (const name of exposedNamesIn(line)) found.push({ name, line: index + 1 })
    if (line.includes("}")) inBlock = false
  }
  return found
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/g

/** Every identifier-shaped word in a text, for a cheap "is this name mentioned" test. */
const identifiersIn = (text: string): ReadonlySet<string> => new Set(text.match(IDENTIFIER) ?? [])

/**
 * The text with comments, quoted strings and template text blanked, line count
 * preserved: only code is left.
 *
 * A doc comment naming a class, the `_tag` string a `Schema.TaggedError`
 * carries and fixture text in a template are not consumption; blanking them is
 * what lets an own-file reference be read as one.
 */
const codeOnly = (text: string, syntax: Syntax): string =>
  blankedOnce("codeOnly", text, { quoted: true, templateText: true }, syntax)

/**
 * The text with comments and template text blanked, quoted strings kept, line
 * count preserved: an import statement and its specifier survive, and fixture
 * text holding `import { X } from "./x"` inside a template does not.
 */
const statementsOnly = (text: string, syntax: Syntax): string =>
  blankedOnce("statements", text, { quoted: false, templateText: true }, syntax)

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

/** One `import … from "x"` or `export … from "x"` statement in code. */
interface ModuleStatement {
  readonly keyword: "import" | "export"
  readonly specifier: string
  /** The 1-based line the statement opens on. */
  readonly line: number
  /** The clause between the keyword and `from`: `{ a, b as c }`, `* as NS`, `D, { a }`. */
  readonly clause: string
}

/**
 * A statement opens a line of code and names what it brings in before `from`.
 * The clause shapes are spelled out, so an `export const` followed some lines
 * later by an import never reads as one statement.
 */
const MODULE_STATEMENT =
  /^[ \t]*(import|export)[ \t]+(?:type[ \t]+)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\}|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?)\s*from\s*["']([^"']+)["']/gm

/**
 * Every import and re-export statement in a file's code.
 *
 * Read from the text with comments and template text blanked, so a statement
 * inside fixture text is no statement; quoted strings are kept for the
 * specifier. A statement broken across lines is read whole.
 */
const moduleStatementsIn = (text: string, syntax: Syntax): ReadonlyArray<ModuleStatement> => {
  const code = statementsOnly(text, syntax)
  const statements: Array<ModuleStatement> = []
  for (const match of code.matchAll(MODULE_STATEMENT)) {
    let keyword: ModuleStatement["keyword"] = "import"
    if (match[1] === "export") keyword = "export"
    const opening = match.index + (match[0].length - match[0].trimStart().length)
    statements.push({
      keyword,
      clause: match[2] ?? "",
      specifier: match[3] ?? "",
      line: code.slice(0, opening).split("\n").length,
    })
  }
  return statements
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
  const body = braces.value[1] ?? ""
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
  for (const match of kept.matchAll(destructure)) found.push(...destructuredKeys(match[1] ?? ""))
  return found
}

/** The keys a `{ beta, gamma: g }` destructure reads, before any rename. */
const destructuredKeys = (inner: string): ReadonlyArray<string> =>
  inner.split(",").flatMap((part) =>
    Option.match(Option.fromNullishOr(/^\s*([A-Za-z_$][\w$]*)/.exec(part)?.[1]), {
      onNone: (): ReadonlyArray<string> => [],
      onSome: (key) => [key],
    }),
  )

/** The names a file reads through one specifier. */
interface SpecifierRead {
  readonly specifier: string
  readonly names: ReadonlyArray<string>
}

/**
 * Every name a file reads, by the specifier it reads it through.
 *
 * A named entry credits the *original* name, not the local alias: `X as Y`
 * means the module still has to export `X`. A re-export `export { X } from`
 * reads `X` too: it is the chain an entry point is. A namespace import credits
 * every member the file's code reads off it. A statement or a member read on a
 * `@ts-expect-error` line asserts absence and reads nothing.
 */
const specifierReadsIn = (text: string, syntax: Syntax): ReadonlyArray<SpecifierRead> => {
  const skip = expectErrorLines(text.split("\n"))
  const codeLines = codeOnly(text, syntax).split("\n")
  const statementReads = moduleStatementsIn(text, syntax)
    .filter((statement) => !skip.has(statement.line))
    .map((statement) => {
      const named = namedImportsIn(statement.clause)
      if (statement.keyword === "export") return { specifier: statement.specifier, names: named }
      const members = namespaceAliasesIn(statement.clause).flatMap((alias) =>
        namespaceMembersIn(codeLines, alias, skip),
      )
      return { specifier: statement.specifier, names: [...named, ...members] }
    })
  return [...statementReads, ...dynamicImportReadsIn(text, syntax, codeLines, skip)]
}

/** `import("<literal>")`, optionally awaited: a load a static read can follow. */
const LITERAL_DYNAMIC_IMPORT = String.raw`(?:await\s+)?import\s*\(\s*["']([^"'\s]+)["']\s*\)`

/** `import("./m").x`, `(await import("./m")).x`, `typeof import("./m").X`. */
const DYNAMIC_IMPORT_MEMBER = new RegExp(
  String.raw`${LITERAL_DYNAMIC_IMPORT}\s*\)?\s*\??\.\s*([A-Za-z_$][\w$]*)`,
  "g",
)
/** `const { x, y: z } = await import("./m")`. */
const DYNAMIC_IMPORT_DESTRUCTURE = new RegExp(
  String.raw`\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*${LITERAL_DYNAMIC_IMPORT}`,
  "g",
)
/** `const M = await import("./m")`: a namespace its members are read off. */
const DYNAMIC_IMPORT_NAMESPACE = new RegExp(
  String.raw`\b(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=\s*${LITERAL_DYNAMIC_IMPORT}`,
  "g",
)

/**
 * The names a file reads through a literal dynamic import (allowed where an
 * `effect/noDynamicImports` suppression says why): a member read off the
 * import, a destructured key, or a member read off the binding it is
 * stored in. A read on a `@ts-expect-error` line reads nothing.
 */
const dynamicImportReadsIn = (
  text: string,
  syntax: Syntax,
  codeLines: ReadonlyArray<string>,
  skip: ReadonlySet<number>,
): ReadonlyArray<SpecifierRead> => {
  const code = withoutComments(text, syntax)
  if (!code.includes("import")) return []
  const lineOf = (index: number) => code.slice(0, index).split("\n").length
  const found: Array<SpecifierRead> = []
  for (const match of code.matchAll(DYNAMIC_IMPORT_MEMBER)) {
    if (skip.has(lineOf(match.index))) continue
    found.push({ specifier: match[1] ?? "", names: [match[2] ?? ""] })
  }
  for (const match of code.matchAll(DYNAMIC_IMPORT_DESTRUCTURE)) {
    if (skip.has(lineOf(match.index))) continue
    found.push({ specifier: match[2] ?? "", names: destructuredKeys(match[1] ?? "") })
  }
  for (const match of code.matchAll(DYNAMIC_IMPORT_NAMESPACE)) {
    found.push({
      specifier: match[2] ?? "",
      names: namespaceMembersIn(codeLines, match[1] ?? "", skip),
    })
  }
  return found
}

/** `*` or `* as NS`: the clause of a star import or re-export. */
const isStarClause = (clause: string): boolean => clause.trim().startsWith("*")

/**
 * A star re-export forwards names this scan cannot see: neither the barrel nor
 * the module behind it can tell which forwarded name has a reader.
 */
const STAR_EXPORT_MESSAGE =
  "`export *` hides the names it forwards from the dead-export scan; list them as `export { … } from`"

/** Names a file reads through one entry point's specifier, with or without `.js`. */
const importedThrough = (
  specifier: string,
  reads: ReadonlyArray<SpecifierRead>,
): ReadonlySet<string> =>
  new Set(
    reads
      .filter((read) => read.specifier === specifier || read.specifier === `${specifier}.js`)
      .flatMap((read) => read.names),
  )

/** A module's repo path without its extension: `packages/core/src/domain/event`. */
const moduleKeyOf = (path: string): string =>
  path.replace(/\.[cm]?[jt]sx?$/, "").replace(/\/+$/, "")

/** `directory` joined with a relative path; `.` and `..` segments fold away. */
const joinedPath = (directory: string, relative: string): string => {
  const parts: Array<string> = []
  for (const segment of `${directory}/${relative}`.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts.join("/")
}

const directoryOf = (file: string): string => file.slice(0, Math.max(file.lastIndexOf("/"), 0))

/**
 * The module a specifier names, as a key. A relative specifier resolves
 * against the importing file's directory to a repo path; a package specifier
 * stays as written, without `.js`, until the manifests resolve it.
 */
const specifierKey = (file: string, specifier: string): string => {
  if (!specifier.startsWith(".")) return moduleKeyOf(specifier)
  return moduleKeyOf(joinedPath(directoryOf(file), specifier))
}

/**
 * The keys a file answers to as an import target: its repo path, plus, for a
 * directory index, that directory. `import { X } from "../theme"` reaches
 * `theme/index.ts`, and no other module named `theme`.
 */
const importTargetsOf = (file: string): ReadonlyArray<string> => {
  const key = moduleKeyOf(file)
  if (!key.endsWith("/index") && key !== "index") return [key]
  return [key, directoryOf(key)]
}

/**
 * Names this file reads from a module, keyed by the module's key.
 *
 * This is the only read a module surface counts. Whether the tree mentions `X`
 * in a string, a test title or a binding of its own says nothing: a file
 * reads a module's `X` only by importing it, re-exporting it, or reading it
 * off a namespace import of that module.
 */
const importsByTarget = (
  file: string,
  reads: ReadonlyArray<SpecifierRead>,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const byTarget = new Map<string, Set<string>>()
  for (const read of reads) {
    const key = specifierKey(file, read.specifier)
    const names = Option.getOrElse(Option.fromNullishOr(byTarget.get(key)), () => {
      const created = new Set<string>()
      byTarget.set(key, created)
      return created
    })
    for (const name of read.names) names.add(name)
  }
  return byTarget
}

/** What one file contributes to the whole-tree answer. */
export interface ExportFacts {
  readonly declarations: ReadonlyArray<Declaration>
  /** Names read from a module, keyed by the module's key (a package specifier until resolved). */
  readonly importsByTarget: ReadonlyMap<string, ReadonlySet<string>>
  /** Lines of `export * from` and `export * as NS from` statements on a scanned surface. */
  readonly starExportLines: ReadonlyArray<number>
  /** Identifiers per line with only code left; empty unless the file's surface reads its own references. */
  readonly identifiersByLine: ReadonlyArray<ReadonlySet<string>>
  /** Names read through each entry-point specifier. */
  readonly imported: ReadonlyMap<string, ReadonlySet<string>>
}

const declarationsIn = (surface: ScannedSurface, text: string): ReadonlyArray<Declaration> =>
  Option.match(surface.specifier, {
    onNone: () => declaredNames(text),
    onSome: () => reExportedNames(text),
  }).map((entry) => ({ ...entry, surface }))

const importsIn = (
  file: string,
  reads: ReadonlyArray<SpecifierRead>,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const imported = new Map<string, ReadonlySet<string>>()
  for (const surface of SCANNED_SURFACES) {
    if (Option.isNone(surface.specifier)) continue
    if (surface.outsideOf.some((prefix) => file.startsWith(prefix))) continue
    imported.set(surface.specifier.value, importedThrough(surface.specifier.value, reads))
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
      onSome: () => codeOnly(text, syntaxOf(file)).split("\n").map(identifiersIn),
    },
  )
  const reads = specifierReadsIn(text, syntaxOf(file))
  const starExportLines = Option.match(surface, {
    onNone: (): ReadonlyArray<number> => [],
    onSome: () =>
      moduleStatementsIn(text, syntaxOf(file))
        .filter((statement) => statement.keyword === "export" && isStarClause(statement.clause))
        .map((statement) => statement.line),
  })
  return {
    declarations,
    identifiersByLine,
    importsByTarget: importsByTarget(file, reads),
    starExportLines,
    imported: importsIn(file, reads),
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

/**
 * Whether this file reads `name` from the declaring module.
 *
 * A module surface is read at its own path: through one of `targets`, the
 * names that path answers to as an import target. An entry point is read
 * through its specifier. Either way the read is an import, a re-export or a
 * namespace member; a mention in a string, a test title or a binding of the
 * file's own is not.
 */
const reads = (
  facts: ExportFacts,
  byModule: ReadonlyMap<string, ReadonlySet<string>>,
  declaration: Declaration,
  targets: ReadonlyArray<string>,
): boolean =>
  Option.match(declaration.surface.specifier, {
    onNone: () =>
      targets.some((target) =>
        Option.exists(Option.fromNullishOr(byModule.get(target)), (names) =>
          names.has(declaration.name),
        ),
      ),
    onSome: (specifier) =>
      Option.exists(Option.fromNullishOr(facts.imported.get(specifier)), (names) =>
        names.has(declaration.name),
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
      if (declaration.surface.ownFileCounts && declaration.typeOnly === true) {
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
 * The module key each package specifier names, from the manifests' `exports`:
 * `@gent/extensions` is `packages/extensions/src/index`. A specifier no
 * manifest exports keeps its own text, so it names no repo module.
 */
const moduleResolver = (manifests: ReadonlyMap<string, string>): ((key: string) => string) => {
  const byPackageSpecifier = new Map<string, string>()
  const decode = Schema.decodeUnknownOption(Schema.fromJsonString(PackageJsonSchema))
  for (const [manifest, text] of manifests) {
    const json = decode(text)
    if (Option.isNone(json)) continue
    const { name, exports } = json.value
    if (Predicate.isUndefined(name) || Predicate.isUndefined(exports)) continue
    for (const [subpath, target] of Object.entries(exports)) {
      let specifier = name
      if (subpath !== ".") specifier = `${name}/${subpath.replace(/^\.\//, "")}`
      byPackageSpecifier.set(
        moduleKeyOf(specifier),
        moduleKeyOf(joinedPath(directoryOf(manifest), target)),
      )
    }
  }
  return (key) => byPackageSpecifier.get(key) ?? key
}

/** One file's reads, re-keyed so a package specifier names the module it resolves to. */
const resolvedReads = (
  byTarget: ReadonlyMap<string, ReadonlySet<string>>,
  resolve: (key: string) => string,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const resolved = new Map<string, Set<string>>()
  for (const [key, names] of byTarget) {
    const module = resolve(key)
    const merged = Option.getOrElse(Option.fromNullishOr(resolved.get(module)), () => {
      const created = new Set<string>()
      resolved.set(module, created)
      return created
    })
    for (const name of names) merged.add(name)
  }
  return resolved
}

/**
 * Report declared exports no file that may consume them reads.
 *
 * `factsByFile` is the whole tree's reads, so this is one pass over
 * declarations rather than a search per name. A file that declares the same
 * name reads nothing by declaring it: two modules exporting `sameName` need a
 * third file importing one of them to keep it alive. Entry points chain the
 * same way: `@gent/sdk` re-exports names from `@gent/core/protocol`, and the
 * re-export is the read that keeps the protocol name alive.
 */
export const findUnconsumedExports = (
  factsByFile: ReadonlyMap<string, ExportFacts>,
  manifests: ReadonlyMap<string, string> = new Map(),
): ReadonlyArray<Finding> => {
  const resolve = moduleResolver(manifests)
  const byModuleOf = new Map<string, ReadonlyMap<string, ReadonlySet<string>>>()
  for (const [file, facts] of factsByFile) {
    byModuleOf.set(file, resolvedReads(facts.importsByTarget, resolve))
  }
  const isConsumed = (file: string, declaration: Declaration): boolean => {
    const targets = importTargetsOf(file)
    for (const [candidate, facts] of factsByFile) {
      if (!mayConsume(candidate, declaration.surface)) continue
      if (!withinLeaf(candidate, declaration.surface)) continue
      // The file being measured never vouches for its own export; whether its
      // own references count at all is the `ownFileCounts` rule below.
      if (candidate === file && Option.isNone(declaration.surface.specifier)) continue
      const byModule = Option.getOrElse(Option.fromNullishOr(byModuleOf.get(candidate)), () => {
        const none: ReadonlyMap<string, ReadonlySet<string>> = new Map()
        return none
      })
      if (reads(facts, byModule, declaration, targets)) return true
    }
    if (!declaration.surface.ownFileCounts || declaration.typeOnly !== true) return false
    return Option.exists(Option.fromNullishOr(factsByFile.get(file)), (facts) =>
      referencedInOwnFile(facts, declaration.name),
    )
  }

  const findings: Array<Finding> = []
  for (const [file, facts] of factsByFile) {
    for (const line of facts.starExportLines) {
      findings.push({ file, line, message: STAR_EXPORT_MESSAGE })
    }
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

// ── Package entry points ────────────────────────────────────────────────────

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
      message: `name: the package is ${packageJson.name ?? "unnamed"}, its package-surface row names ${surface.alias}; make them agree`,
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
  const exported = Object.keys(packageJson.exports ?? {})
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
  const unlisted = packageJsons
    .keys()
    .filter((file) => !rows.has(file))
    .map((file) => ({
      file,
      line: 1,
      message: `a workspace package with no package-surface row in guards.ts; add one naming its entry points (none for a leaf)`,
    }))
    .toArray()
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

// ── Declared dependencies ───────────────────────────────────────────────────

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

/**
 * The package a module specifier resolves into. A relative path names none,
 * unless it reaches into `node_modules/<package>/…` (a config `extends` path).
 */
const packageOfSpecifier = (specifier: string): Option.Option<string> => {
  const installed = /(?:^|\/)node_modules\/(.+)$/.exec(specifier)?.[1]
  if (Predicate.isNotUndefined(installed)) return packageOfSpecifier(installed)
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
      ...matchedGroups(withoutComments(text, syntaxOf(file)), SOURCE_SPECIFIER),
      ...matchedGroups(text, TYPES_REFERENCE),
    ]
  }
  if (/(?:^|\/)package\.json$/.test(file)) return []
  if (/\.jsonc?$/.test(file)) return matchedGroups(withoutComments(text, "ts"), CONFIG_STRING)
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
      .values()
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
 * and audits forever, and nothing else notices it. A dependency is used when a file
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
      DEPENDENCY_FIELDS.values()
        .flatMap((field) => Object.entries(manifest[field] ?? {}))
        .filter(([, version]) => version.startsWith("catalog:"))
        .map(([name]) => name)
        .toArray(),
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
    .values()
    .filter((pin) => isEffectPackage(pin.name) && pin.pinned !== version)
    .map((pin) => ({
      file: root.manifest,
      line: lineInBlock(root.text, pin.block, pin.needle),
      message: `${pin.block}["${pin.name}"] pins ${pin.pinned}, but catalog["effect"] is ${version}; the Effect packages release together, so pin every one at ${version}`,
    }))
    .toArray()
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
