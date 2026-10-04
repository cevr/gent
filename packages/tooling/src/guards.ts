import { Option, Predicate, Schema } from "effect"
import picomatch from "picomatch"
import {
  type ArrowFunctionExpression,
  type CallExpression,
  type Class,
  type Expression,
  type Function,
  type MemberExpression,
  type ModuleExportName,
  type ParamPattern,
  type ParseResult,
  parseSync,
  type Program,
  type PropertyKey,
  type Super,
  type TSImportTypeQualifier,
  type TSInterfaceDeclaration,
  type TSType,
  Visitor,
} from "oxc-parser"
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

// ── source text, read by the parser ─────────────────────────────────────────

/** A comment's trimmed body, and the line it starts on. */
interface CommentBody {
  readonly line: number
  readonly body: string
}

/**
 * The forms of a source text the guards read. oxc parses the text, the
 * parser oxlint lints it with, so a comment, a string, a template's text, a
 * regex and JSX text are what the language says they are. Each text form has
 * the source's length and line breaks: an index or a line in one is the same
 * place in every other and in the source.
 */
interface SourceForms {
  /** What oxc could not parse, with the line of each error; past an error the forms may miss code. */
  readonly errors: ReadonlyArray<CommentBody>
  /** Each comment, its body trimmed, and the line its body starts on. */
  readonly comments: ReadonlyArray<CommentBody>
  /** Process-shaped identifiers and test titles, rather than product strings. */
  readonly names: ReadonlyArray<CommentBody>
  /** Comments blanked. */
  readonly code: string
  /**
   * Comments, the text of strings and templates, and JSX text blanked: only
   * code is left. A doc comment naming a class, a `_tag` string and fixture
   * text in a template name nothing the code reads.
   */
  readonly codeOnly: string
  /**
   * The module syntax the parse records: what the file exports, and what it
   * reads from which module. Fixture text holding `import { X } from "./x"`
   * in a template is no import.
   */
  readonly module: ModuleSyntax
  /** The seam guard's facts, read only for the files it reads (`readsSeams`); empty for the rest. */
  readonly seams: SeamSyntax
  /**
   * `codeOnly` with regex bodies blanked too, and the line breaks inside
   * blanked text: every bracket left is structure, and a line end left is a
   * line end of code.
   */
  readonly structure: string
}

/** What a stretch of source is when it is not code. */
type SpanKind = "comment" | "string" | "template" | "jsx-text" | "regex"

interface Span {
  readonly kind: SpanKind
  readonly start: number
  readonly end: number
}

/** The 1-based line of a character index. */
const lineAt = (code: string, index: number): number => code.slice(0, index).split("\n").length

/**
 * A `.tsx` or `.jsx` file also reads JSX, and a `.d.ts` file holds
 * declarations, which need no body or initializer; any other source file is
 * TypeScript.
 */
const parseLanguage = (file: string): "ts" | "tsx" | "dts" => {
  if (/\.[cm]?[jt]sx$/.test(file)) return "tsx"
  if (/\.d\.[cm]?ts$/.test(file)) return "dts"
  return "ts"
}

/** A JSON or JSONC file is read as the expression it is, inside parentheses. */
const isJsonFile = (file: string): boolean => /\.jsonc?$/.test(file)

/** One name a file exports, as the parse's module record lists it. */
interface ExportEntry {
  readonly name: string
  readonly line: number
  /** `export type`, `export interface`, `export { type X }`: a type, not a value. */
  readonly isType: boolean
  /**
   * The name comes from another module: `export { X } from "./x"`, or a bare
   * `export { X }` of an imported `X`. The file exposes it at its own path,
   * and the module it names keeps its own declaration.
   */
  readonly passthrough: boolean
}

/** The names one statement or expression reads from `specifier`, and the line it opens on. */
interface ModuleRead {
  readonly specifier: string
  readonly line: number
  /** Names read by name: an entry's original name (`X` of `X as Y`), a member, a destructured key. */
  readonly names: ReadonlyArray<string>
  /** Local names bound to the whole module (`import * as NS`, `const M = await import("./m")`). */
  readonly namespaces: ReadonlyArray<string>
}

/** A file's module syntax: what it exports, what it reads, and its star re-exports. */
interface ModuleSyntax {
  /** In source order. */
  readonly exports: ReadonlyArray<ExportEntry>
  /** Imports, re-exports, and literal dynamic imports. */
  readonly reads: ReadonlyArray<ModuleRead>
  /** Actual static value imports, including side-effect imports. */
  readonly valueImports: ReadonlyArray<string>
  /** Module paths named by syntax, even without an export/member read. */
  readonly specifiers: ReadonlyArray<string>
  /** Lines of `export * from` and `export * as NS from`. */
  readonly starExportLines: ReadonlyArray<number>
}

/** What oxc reads of a text: its errors, each comment, each stretch that is not code, in source order, and its module syntax. */
interface ParsedText {
  readonly errors: ReadonlyArray<CommentBody>
  readonly comments: ReadonlyArray<CommentBody>
  readonly names: ReadonlyArray<CommentBody>
  readonly spans: ReadonlyArray<Span>
  readonly module: ModuleSyntax
  readonly seams: SeamSyntax
}

/** Whether an import entry is `import * as NS`; oxc types the kinds as a const enum, which the runtime does not carry. */
const isNamespaceImport = (kind: string): boolean => kind === "NamespaceObject"

/** The specifier of `import("<literal>")`, through parentheses and `await`. */
const literalImportOf = (node: Expression | Super): Option.Option<string> => {
  if (node.type === "ParenthesizedExpression") return literalImportOf(node.expression)
  if (node.type === "AwaitExpression") return literalImportOf(node.argument)
  if (node.type !== "ImportExpression" || node.source.type !== "Literal") return Option.none()
  return Option.liftPredicate(node.source.value, Predicate.isString)
}

/** The first name of `import("./m").A.B` as a type: `A`. */
const firstQualifier = (qualifier: TSImportTypeQualifier): string => {
  if (qualifier.type === "Identifier") return qualifier.name
  return firstQualifier(qualifier.left)
}

/** The literal path of the existing require/mock.module call forms. */
const literalModuleCallOf = (node: CallExpression): ReadonlyArray<string> => {
  const callee = node.callee
  const moduleCall =
    (callee.type === "Identifier" && callee.name === "require") ||
    (callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.object.type === "Identifier" &&
      callee.object.name === "mock" &&
      callee.property.type === "Identifier" &&
      callee.property.name === "module")
  const modulePath = node.arguments[0]
  if (moduleCall && modulePath?.type === "Literal" && Predicate.isString(modulePath.value))
    return [modulePath.value]
  return []
}

/**
 * The module syntax of one parse. Static imports and exports come from the
 * module record. A literal dynamic import, which the record lists without
 * what is read off it, comes from the tree: a member read off the import, a
 * destructured key, a binding whose members are read, or a type's qualifier.
 */
const moduleSyntaxOf = (
  result: ParseResult,
  lineOf: (index: number) => number,
  dynamicReads: ReadonlyArray<ModuleRead>,
  literalSpecifiers: ReadonlyArray<string>,
): ModuleSyntax => {
  const exports: Array<{ readonly at: number; readonly entry: ExportEntry }> = []
  const reads: Array<ModuleRead> = []
  const starExportLines: Array<number> = []
  for (const statement of result.module.staticImports) {
    const names: Array<string> = []
    const namespaces: Array<string> = []
    for (const entry of statement.entries) {
      const imported = Option.fromNullishOr(entry.importName.name)
      if (Option.isSome(imported)) names.push(imported.value)
      else if (isNamespaceImport(entry.importName.kind)) namespaces.push(entry.localName.value)
    }
    reads.push({
      specifier: statement.moduleRequest.value,
      line: lineOf(statement.start),
      names,
      namespaces,
    })
  }
  for (const statement of result.module.staticExports) {
    for (const entry of statement.entries) {
      const request = Option.fromNullishOr(entry.moduleRequest)
      const imported = Option.fromNullishOr(entry.importName.name)
      if (Option.isSome(request) && Option.isNone(imported)) {
        starExportLines.push(lineOf(entry.start))
        continue
      }
      if (Option.isSome(request)) {
        reads.push({
          specifier: request.value.value,
          line: lineOf(entry.start),
          names: Option.toArray(imported),
          namespaces: [],
        })
      }
      const name = Option.fromNullishOr(entry.exportName.name)
      if (Option.isNone(name)) continue
      const at = Option.getOrElse(Option.fromNullishOr(entry.exportName.start), () => entry.start)
      exports.push({
        at,
        entry: {
          name: name.value,
          line: lineOf(at),
          isType: entry.isType,
          passthrough: Option.isSome(request),
        },
      })
    }
  }
  return {
    exports: exports.sort((a, b) => a.at - b.at).map(({ entry }) => entry),
    reads: [...reads, ...dynamicReads],
    valueImports: result.program.body.flatMap((statement) => {
      if (statement.type !== "ImportDeclaration" || statement.importKind === "type") return []
      if (
        statement.specifiers.length > 0 &&
        statement.specifiers.every(
          (entry) => entry.type === "ImportSpecifier" && entry.importKind === "type",
        )
      )
        return []
      return [statement.source.value]
    }),
    specifiers: [
      ...result.module.staticImports.map((statement) => statement.moduleRequest.value),
      ...literalSpecifiers,
      ...result.comments.flatMap((comment) => {
        if (comment.type !== "Line") return []
        // oxc's body of a triple-slash directive begins with the third slash.
        return matchedGroups(comment.value, TYPES_REFERENCE)
      }),
    ],
    starExportLines,
  }
}

const parsedText = (file: string, text: string): ParsedText => {
  let source = text
  let shift = 0
  if (isJsonFile(file)) {
    source = `(${text}\n)`
    shift = 1
  }
  const result = parseSync(file, source, { lang: parseLanguage(file) })
  const lineOf = (index: number) => lineAt(text, index - shift)
  const spans: Array<Span> = []
  const comments = result.comments.map((comment) => {
    spans.push({ kind: "comment", start: comment.start, end: comment.end })
    const lead = comment.value.length - comment.value.trimStart().length
    return { line: lineAt(text, comment.start - shift + 2 + lead), body: comment.value.trim() }
  })
  const dynamicReads: Array<ModuleRead> = []
  const literalSpecifiers: Array<string> = []
  const names: Array<CommentBody> = []
  const isTestCallee = (node: Expression | Super): boolean => {
    if (node.type === "Identifier") return ["test", "it", "describe"].includes(node.name)
    if (node.type === "MemberExpression") return isTestCallee(node.object)
    if (node.type === "CallExpression") return isTestCallee(node.callee)
    return false
  }
  const dynamicRead = (specifier: string, start: number, read: Partial<ModuleRead>) => {
    dynamicReads.push({ specifier, line: lineOf(start), names: [], namespaces: [], ...read })
  }
  new Visitor({
    Identifier: (node) => {
      if (!PROCESS_NAME.test(node.name)) return
      names.push({ line: lineOf(node.start), body: node.name })
    },
    CallExpression: (node) => {
      literalSpecifiers.push(...literalModuleCallOf(node))
      if (!isTestCallee(node.callee)) return
      const title = node.arguments[0]
      if (
        title?.type === "Literal" &&
        Predicate.isString(title.value) &&
        PROCESS_NAME.test(title.value)
      ) {
        names.push({ line: lineOf(title.start), body: title.value })
      }
      if (title?.type === "TemplateLiteral") {
        for (const part of title.quasis) {
          if (!PROCESS_NAME.test(part.value.raw)) continue
          names.push({ line: lineOf(part.start), body: part.value.raw })
        }
      }
    },
    MemberExpression: (node) => {
      if (node.computed || node.property.type !== "Identifier") return
      const name = node.property.name
      for (const specifier of Option.toArray(literalImportOf(node.object))) {
        dynamicRead(specifier, node.start, { names: [name] })
      }
    },
    VariableDeclarator: (node) => {
      const { id } = node
      const specifiers = Option.toArray(
        Option.flatMap(Option.fromNullishOr(node.init), literalImportOf),
      )
      for (const specifier of specifiers) {
        if (id.type === "Identifier") dynamicRead(specifier, node.start, { namespaces: [id.name] })
        if (id.type !== "ObjectPattern") continue
        const names = id.properties.flatMap((property) => {
          if (property.type !== "Property" || property.computed) return []
          if (property.key.type !== "Identifier") return []
          return [property.key.name]
        })
        dynamicRead(specifier, node.start, { names })
      }
    },
    TSImportType: (node) => {
      literalSpecifiers.push(node.source.value)
      for (const qualifier of Option.toArray(Option.fromNullishOr(node.qualifier))) {
        dynamicRead(node.source.value, node.start, { names: [firstQualifier(qualifier)] })
      }
    },
    ImportExpression: (node) => {
      if (node.source.type === "Literal" && Predicate.isString(node.source.value))
        literalSpecifiers.push(node.source.value)
    },
    ExportNamedDeclaration: (node) => {
      if (node.source) literalSpecifiers.push(node.source.value)
    },
    ExportAllDeclaration: (node) => {
      literalSpecifiers.push(node.source.value)
    },
    TSExternalModuleReference: (node) => {
      literalSpecifiers.push(node.expression.value)
    },
    Literal: (node) => {
      const opener = source[node.start]
      if (opener === '"' || opener === "'") {
        spans.push({ kind: "string", start: node.start + 1, end: node.end - 1 })
      } else if ("regex" in node) {
        spans.push({ kind: "regex", start: node.start + 1, end: source.lastIndexOf("/", node.end) })
      }
    },
    TemplateElement: (node) => {
      const start = node.start + 1
      spans.push({ kind: "template", start, end: start + node.value.raw.length })
    },
    JSXText: (node) => {
      spans.push({ kind: "jsx-text", start: node.start, end: node.end })
    },
  }).visit(result.program)
  const errors = result.errors.map((error) => ({
    line: lineAt(text, (error.labels[0]?.start ?? shift) - shift),
    body: error.message,
  }))
  let seams = NO_SEAMS
  if (readsSeams(file)) seams = seamSyntaxOf(result.program, lineOf)
  return {
    errors,
    comments,
    names,
    spans: spans
      .map((span) => ({ ...span, start: span.start - shift, end: span.end - shift }))
      .sort((a, b) => a.start - b.start),
    module: moduleSyntaxOf(result, lineOf, dynamicReads, literalSpecifiers),
    seams,
  }
}

/** `text` with the spans of `kinds` blanked to spaces; `lineBreaks` blanks their line breaks too. */
const blankedSpans = (
  text: string,
  spans: ReadonlyArray<Span>,
  kinds: ReadonlyArray<SpanKind>,
  lineBreaks: boolean,
): string => {
  const out: Array<string> = []
  let at = 0
  for (const span of spans) {
    if (!kinds.includes(span.kind) || span.start < at) continue
    out.push(text.slice(at, span.start))
    const chunk = text.slice(span.start, span.end)
    if (lineBreaks) out.push(" ".repeat(chunk.length))
    else out.push(chunk.replace(/[^\n]/g, " "))
    at = span.end
  }
  out.push(text.slice(at))
  return out.join("")
}

/**
 * Each source's forms, keyed by how it is read and by its text: a guards run
 * reads one file's text in several scans, and parses it once. How a file is
 * read is its language and whether the seam guard reads its seam facts.
 */
const sourceFormsCache = new Map<string, Map<string, SourceForms>>()

/** The forms of `text`, read as `file` is read. */
const sourceForms = (file: string, text: string): SourceForms => {
  let reading: string = parseLanguage(file)
  if (isJsonFile(file)) reading = "json"
  if (readsSeams(file)) reading += "+seams"
  const cache = Option.getOrElse(Option.fromNullishOr(sourceFormsCache.get(reading)), () => {
    const created = new Map<string, SourceForms>()
    sourceFormsCache.set(reading, created)
    return created
  })
  return Option.getOrElse(Option.fromNullishOr(cache.get(text)), () => {
    const { errors, comments, names, spans, module, seams } = parsedText(file, text)
    const forms: SourceForms = {
      errors,
      comments,
      names,
      code: blankedSpans(text, spans, ["comment"], false),
      codeOnly: blankedSpans(text, spans, ["comment", "string", "template", "jsx-text"], false),
      module,
      seams,
      structure: blankedSpans(
        text,
        spans,
        ["comment", "string", "template", "jsx-text", "regex"],
        true,
      ),
    }
    cache.set(text, forms)
    return forms
  })
}

/** The text with comments blanked, line count preserved. */
const withoutComments = (file: string, text: string): string => sourceForms(file, text).code

const OPENERS = "([{"
const CLOSERS = ")]}"

/**
 * The first index at or after `start` in a `structure` form where `stopsAt`
 * holds for the character at bracket depth zero, or where a closer takes the
 * depth below zero: it closes a bracket opened before `start`. Strings,
 * templates, comments, regex literals and JSX text are blank in that form, so
 * every bracket it holds is code. `structure.length` when neither comes.
 * Every bracket walk in this file is this one.
 */
const topLevelStop = (
  structure: string,
  start: number,
  stopsAt: (char: string) => boolean = () => false,
): number => {
  let depth = 0
  for (let at = start; at < structure.length; at += 1) {
    const char = structure[at] ?? ""
    if (depth === 0 && stopsAt(char)) return at
    if (OPENERS.includes(char)) depth += 1
    else if (CLOSERS.includes(char)) {
      if (depth === 0) return at
      depth -= 1
    }
  }
  return structure.length
}

/** One past the bracket that closes the one at `open`, or the text's end. */
const bracketEnd = (forms: SourceForms, open: number): number =>
  Math.min(topLevelStop(forms.structure, open + 1) + 1, forms.structure.length)

// ── a lint directive names its rules ────────────────────────────────────────

/**
 * oxlint reads a directive from a comment's body, trimmed: the text after
 * `//`, or between `/*` and `*\/` across any number of lines. It honors both
 * spellings, `eslint-disable` and `oxlint-disable`, so each pattern matches
 * both. A blanket directive names no rule; a file-wide directive, written as
 * a block or a line comment, disables its rules to the end of the file or the
 * next enable.
 *
 * `effect/requireSuppressionReason` reports a blanket `-next-line` directive,
 * but not a blanket `-line` or file-wide one: that directive disables every
 * rule on its own line, the upstream rule with them. So the guards read them.
 */
const blanketDisableDirective = /^(?:es|ox)lint-disable(?:-next-line|-line)?\s*(?:--|$)/

const fileWideDisableDirective = /^(?:es|ox)lint-disable(?:\s|$)/

/**
 * Guard: every source the guards read parses. Past a parse error oxc may
 * read no more comments or strings, so each guard would read the rest of
 * the file blind; oxlint lints none of it either. The first error is the
 * finding.
 */
export const findUnparsedSources = (file: string, text: string): ReadonlyArray<Finding> =>
  sourceForms(file, text)
    .errors.slice(0, 1)
    .map(({ line, body }) => ({
      file,
      line,
      message: `oxc cannot parse this source (${body}): oxlint lints none of it, and the guards may misread it past the error`,
    }))

/** A file inside a fixture directory; a basename such as `pty-fixture.ts` is not one. */
const fixtureFilePattern = /(?:^|\/)(?:fixtures?|__fixtures__)\//

const isExplicitFixtureFile = (file: string): boolean => fixtureFilePattern.test(file)

const DISABLE_MESSAGE =
  "blanket and file-wide lint-disable comments (eslint- or oxlint- spelling) are banned; use line-local suppressions with exact rules"

/** Every comment of a source file whose body is a directive `directive` matches. */
const directiveLines = (file: string, text: string, directive: RegExp): ReadonlyArray<Finding> =>
  sourceForms(file, text).comments.flatMap(({ line, body }) => {
    if (!directive.test(body)) return []
    return [{ file, line, message: DISABLE_MESSAGE }]
  })

export const findBlanketEslintDisables = (file: string, text: string): ReadonlyArray<Finding> =>
  directiveLines(file, text, blanketDisableDirective)

export const findBannedEslintDisableBlocks = (
  file: string,
  text: string,
): ReadonlyArray<Finding> => {
  if (isExplicitFixtureFile(file)) return []
  return directiveLines(file, text, fileWideDisableDirective)
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
 * This guard holds the rule for a feature's data: a feature's tables belong to
 * the extension that owns them, so core must not name one.
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

/*
 * No network host is a feature's. The guard once kept models.dev out of core;
 * the owner's direction (Pass 30) moved the model catalog into core: "models.dev
 * is integral to discovery of models via providers so we don't really need to
 * hardcode anything, only limiting factor is classes of api's we support", and
 * "snapshotting will be good so we don't constantly ping … we can put that in
 * our sqlite db". Core stores the snapshot (`ModelCatalogSource`) and hands each
 * driver a read-only view, so the host list and its check are gone.
 */

const CORE_SRC_PREFIX = "packages/core/src/"

/** A feature-owned table named as a SQL identifier, not merely as a substring. */
const TABLE_PATTERN = (prefix: string) => new RegExp(`\\b${prefix}[a-z_]+\\b`)

/** Find every line in a core file that names a feature's table. */
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
 *     `host.on("<kind>", ...)`
 *   - context facets -- the service members of `ExtensionContextService`,
 *     reached as `ctx.<Facet>`
 *   - resource scopes -- the members of `ResourceScope`, reached as
 *     `scope: "<scope>"` on a resource definition
 *
 * Each family keeps its own identity. The shared parse reads declarations
 * and actual uses; lexical bindings decide which context a use reaches.
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

/** The files whose seam facts the guard reads; the shared parse skips the walk for the rest. */
const readsSeams = (file: string): boolean =>
  file === SEAM_DECLARATION_FILE || isAdapterSource(file)

const SeamFamily = Schema.Literals(["registration", "hook", "facet", "resource"])
type SeamFamily = typeof SeamFamily.Type
export type SeamKey = `${SeamFamily}:${string}`
const seamKey = (family: SeamFamily, name: string): SeamKey => `${family}:${name}`
const SEAM_LABELS: Readonly<Record<SeamFamily, string>> = {
  registration: "registration domain",
  hook: "hook kind",
  facet: "extension context facet",
  resource: "resource scope",
}
interface DeclaredSeam {
  readonly family: SeamFamily
  readonly name: string
  readonly line: number
}
interface SeamSyntax {
  readonly declarations: ReadonlyArray<DeclaredSeam>
  readonly uses: ReadonlySet<SeamKey>
}

/** The seam facts of a file the guard does not read. */
const NO_SEAMS: SeamSyntax = { declarations: [], uses: new Set() }

const staticNameOf = (node: PropertyKey): Option.Option<string> => {
  if (node.type === "Identifier") return Option.some(node.name)
  if (node.type === "Literal" && Predicate.isString(node.value)) return Option.some(node.value)
  return Option.none()
}

const literalTypeNames = (node: TSType): ReadonlyArray<string> => {
  if (node.type === "TSParenthesizedType") return literalTypeNames(node.typeAnnotation)
  if (node.type === "TSUnionType") return node.types.flatMap(literalTypeNames)
  if (
    node.type === "TSLiteralType" &&
    node.literal.type === "Literal" &&
    Predicate.isString(node.literal.value)
  )
    return [node.literal.value]
  return []
}

const interfaceSeamsOf = (
  declaration: TSInterfaceDeclaration,
  lineOf: (index: number) => number,
): ReadonlyArray<DeclaredSeam> => {
  const families = new Map<string, SeamFamily>([
    ["RegistrationDomainMap", "registration"],
    ["ExtensionHookSignatures", "hook"],
    ["ExtensionContextService", "facet"],
  ])
  const family = families.get(declaration.id.name)
  if (!family) return []
  return declaration.body.body.flatMap((member): ReadonlyArray<DeclaredSeam> => {
    if (member.type !== "TSPropertySignature" || member.computed) return []
    return Option.toArray(staticNameOf(member.key))
      .filter((name) => family !== "facet" || /^[A-Z]/.test(name))
      .map((name) => ({ family, name, line: lineOf(member.start) }))
  })
}

const declaredSeamsOf = (
  program: Program,
  lineOf: (index: number) => number,
): ReadonlyArray<DeclaredSeam> => {
  const declarations: Array<DeclaredSeam> = []
  for (const statement of program.body) {
    let declaration = statement
    if (declaration.type === "ExportNamedDeclaration") {
      if (!declaration.declaration) continue
      declaration = declaration.declaration
    }
    if (declaration.type === "TSTypeAliasDeclaration" && declaration.id.name === "ResourceScope") {
      for (const name of literalTypeNames(declaration.typeAnnotation)) {
        if (!EXTENSION_LOAD_SCOPES.has(name))
          declarations.push({ family: "resource", name, line: lineOf(declaration.start) })
      }
    }
    if (declaration.type === "TSInterfaceDeclaration")
      declarations.push(...interfaceSeamsOf(declaration, lineOf))
  }
  return declarations
}

const SeamAuthorityKind = Schema.Literals([
  "api",
  "host-tag",
  "context-tag",
  "host",
  "context",
  "register",
  "on",
  "resource",
  "facet",
])
type SeamAuthorityKind = typeof SeamAuthorityKind.Type
interface SeamAuthority {
  readonly kind: SeamAuthorityKind
  readonly member?: string
}
interface SeamScope {
  readonly parent?: SeamScope
  readonly functionScope: boolean
  readonly bindings: Map<string, SeamBinding>
}
interface SeamBinding {
  readonly scope: SeamScope
  readonly authority?: SeamAuthority
  readonly initializer?: Expression
  readonly member?: string
}

const namedSeamAuthority = (name: string): Option.Option<SeamAuthority> => {
  switch (name) {
    case "ExtensionHost":
      return Option.some({ kind: "host-tag" })
    case "ExtensionContext":
      return Option.some({ kind: "context-tag" })
    case "defineResource":
      return Option.some({ kind: "resource" })
    default:
      return Option.none()
  }
}

/** Parentheses and TypeScript assertions change no runtime value. */
const runtimeExpression = (node: Expression): Expression => {
  switch (node.type) {
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSTypeAssertion":
    case "TSNonNullExpression":
      return runtimeExpression(node.expression)
    default:
      return node
  }
}

const moduleNameOf = (node: ModuleExportName): string => {
  if (node.type === "Identifier") return node.name
  return node.value
}

const findSeamBinding = (name: string, scope: SeamScope): Option.Option<SeamBinding> => {
  const binding = scope.bindings.get(name)
  if (binding) return Option.some(binding)
  if (scope.parent) return findSeamBinding(name, scope.parent)
  return Option.none()
}

const memberSeamAuthority = (
  authority: SeamAuthority,
  name: string,
): Option.Option<SeamAuthority> => {
  if (authority.kind === "api") return namedSeamAuthority(name)
  if (authority.kind === "host" && (name === "register" || name === "on"))
    return Option.some({ kind: name })
  if (authority.kind === "context" && /^[A-Z]/.test(name))
    return Option.some({ kind: "facet", member: name })
  return Option.none()
}

const memberNameOf = (node: MemberExpression): Option.Option<string> => {
  if (!node.computed && node.property.type === "Identifier") return Option.some(node.property.name)
  if (node.computed && node.property.type === "Literal" && Predicate.isString(node.property.value))
    return Option.some(node.property.value)
  return Option.none()
}

const seamAuthorityOf = (
  input: Expression,
  scope: SeamScope,
  seen: ReadonlySet<SeamBinding> = new Set(),
): Option.Option<SeamAuthority> => {
  const node = runtimeExpression(input)
  if (node.type === "Identifier") {
    return findSeamBinding(node.name, scope).pipe(
      Option.flatMap((binding) => {
        if (seen.has(binding)) return Option.none()
        if (binding.authority) return Option.some(binding.authority)
        if (!binding.initializer) return Option.none()
        const next = seamAuthorityOf(
          binding.initializer,
          binding.scope,
          new Set([...seen, binding]),
        )
        const member = binding.member
        if (!member) return next
        return next.pipe(Option.flatMap((authority) => memberSeamAuthority(authority, member)))
      }),
    )
  }
  if (node.type === "YieldExpression" && node.delegate && node.argument) {
    return seamAuthorityOf(node.argument, scope, seen).pipe(
      Option.flatMap((authority) => {
        if (authority.kind === "host-tag") return Option.some({ kind: "host" })
        if (authority.kind === "context-tag") return Option.some({ kind: "context" })
        return Option.none()
      }),
    )
  }
  if (node.type === "MemberExpression") {
    return seamAuthorityOf(node.object, scope, seen).pipe(
      Option.flatMap((authority) =>
        memberNameOf(node).pipe(Option.flatMap((name) => memberSeamAuthority(authority, name))),
      ),
    )
  }
  return Option.none()
}

const bindSeamPattern = (
  pattern: ParamPattern,
  scope: SeamScope,
  initializer?: Expression,
  member?: string,
): void => {
  switch (pattern.type) {
    case "Identifier":
      scope.bindings.set(pattern.name, { scope, initializer, member })
      return
    case "AssignmentPattern":
      bindSeamPattern(pattern.left, scope)
      return
    case "RestElement":
      bindSeamPattern(pattern.argument, scope)
      return
    case "TSParameterProperty":
      bindSeamPattern(pattern.parameter, scope)
      return
    case "ArrayPattern":
      for (const element of pattern.elements) if (element) bindSeamPattern(element, scope)
      return
    case "ObjectPattern":
      for (const property of pattern.properties) {
        if (property.type === "RestElement") {
          bindSeamPattern(property.argument, scope)
          continue
        }
        const key = Option.toArray(staticNameOf(property.key))[0]
        if (!property.computed && property.value.type === "Identifier") {
          bindSeamPattern(property.value, scope, initializer, key)
        } else bindSeamPattern(property.value, scope)
      }
  }
}

const seamObjectOf = (
  input: Expression,
  scope: SeamScope,
  seen: ReadonlySet<SeamBinding> = new Set(),
): Option.Option<Expression> => {
  const node = runtimeExpression(input)
  if (node.type === "ObjectExpression") return Option.some(node)
  if (node.type !== "Identifier") return Option.none()
  return findSeamBinding(node.name, scope).pipe(
    Option.flatMap((binding) => {
      if (seen.has(binding) || !binding.initializer || binding.member) return Option.none()
      return seamObjectOf(binding.initializer, binding.scope, new Set([...seen, binding]))
    }),
  )
}

const resourceScopeOf = (input: Expression, scope: SeamScope): Option.Option<string> =>
  seamObjectOf(input, scope).pipe(
    Option.flatMap((object) => {
      if (object.type !== "ObjectExpression") return Option.none()
      let resourceScope = Option.none<string>()
      for (const property of object.properties) {
        if (property.type === "SpreadElement") {
          resourceScope = Option.none()
          continue
        }
        if (property.computed) {
          resourceScope = Option.none()
          continue
        }
        if (!Option.contains(staticNameOf(property.key), "scope")) continue
        const value = runtimeExpression(property.value)
        resourceScope = Option.none()
        if (value.type === "Literal" && Predicate.isString(value.value))
          resourceScope = Option.some(value.value)
      }
      return resourceScope
    }),
  )

const callSeamUses = (node: CallExpression, scope: SeamScope): ReadonlyArray<SeamKey> => {
  const input = node.arguments[0]
  if (!input || input.type === "SpreadElement") return []
  return seamAuthorityOf(node.callee, scope).pipe(
    Option.match({
      onNone: () => [],
      onSome: (authority) => {
        if (authority.kind === "resource")
          return Option.toArray(resourceScopeOf(input, scope)).map((name) =>
            seamKey("resource", name),
          )
        const name = runtimeExpression(input)
        if (name.type !== "Literal" || !Predicate.isString(name.value)) return []
        if (authority.kind === "register") return [seamKey("registration", name.value)]
        if (authority.kind === "on") return [seamKey("hook", name.value)]
        return []
      },
    }),
  )
}

/** Resolve deferred reads after every lexical declaration has been collected. */
const seamSyntaxOf = (program: Program, lineOf: (index: number) => number): SeamSyntax => {
  const root: SeamScope = { functionScope: true, bindings: new Map() }
  let scope = root
  const reads: Array<() => ReadonlyArray<SeamKey>> = []
  const kinds: Array<string> = []
  const push = (functionScope = false): void => {
    scope = { parent: scope, functionScope, bindings: new Map() }
  }
  const pop = (): void => {
    scope = scope.parent ?? root
  }
  const enterFunction = (node: Function | ArrowFunctionExpression): void => {
    if (node.type === "FunctionDeclaration" && node.id) bindSeamPattern(node.id, scope)
    push(true)
    if (node.type === "FunctionExpression" && node.id) bindSeamPattern(node.id, scope)
    for (const param of node.params) bindSeamPattern(param, scope)
  }
  const enterClass = (node: Class): void => {
    if (node.type === "ClassDeclaration" && node.id) bindSeamPattern(node.id, scope)
    push()
    if (node.id) bindSeamPattern(node.id, scope)
  }
  const variableScope = (): SeamScope => {
    let owner = scope
    if (kinds.at(-1) !== "var") return owner
    while (!owner.functionScope && owner.parent) owner = owner.parent
    return owner
  }
  new Visitor({
    ImportDeclaration: (node) => {
      for (const entry of node.specifiers) {
        const binding: SeamBinding = { scope }
        scope.bindings.set(entry.local.name, binding)
        if (node.importKind === "type" || node.source.value !== "@gent/core/extensions/api")
          continue
        if (entry.type === "ImportNamespaceSpecifier") {
          scope.bindings.set(entry.local.name, { scope, authority: { kind: "api" } })
        }
        if (entry.type !== "ImportSpecifier" || entry.importKind === "type") continue
        for (const authority of Option.toArray(namedSeamAuthority(moduleNameOf(entry.imported)))) {
          scope.bindings.set(entry.local.name, { scope, authority })
        }
      }
    },
    FunctionDeclaration: enterFunction,
    "FunctionDeclaration:exit": pop,
    FunctionExpression: enterFunction,
    "FunctionExpression:exit": pop,
    ArrowFunctionExpression: enterFunction,
    "ArrowFunctionExpression:exit": pop,
    TSDeclareFunction: enterFunction,
    "TSDeclareFunction:exit": pop,
    TSEmptyBodyFunctionExpression: enterFunction,
    "TSEmptyBodyFunctionExpression:exit": pop,
    ClassDeclaration: enterClass,
    "ClassDeclaration:exit": pop,
    ClassExpression: enterClass,
    "ClassExpression:exit": pop,
    BlockStatement: () => push(),
    "BlockStatement:exit": pop,
    ForStatement: () => push(),
    "ForStatement:exit": pop,
    ForInStatement: () => push(),
    "ForInStatement:exit": pop,
    ForOfStatement: () => push(),
    "ForOfStatement:exit": pop,
    SwitchStatement: () => push(),
    "SwitchStatement:exit": pop,
    StaticBlock: () => push(true),
    "StaticBlock:exit": pop,
    CatchClause: (node) => {
      push()
      if (node.param) bindSeamPattern(node.param, scope)
    },
    "CatchClause:exit": pop,
    TSEnumDeclaration: (node) => bindSeamPattern(node.id, scope),
    VariableDeclaration: (node) => {
      kinds.push(node.kind)
    },
    "VariableDeclaration:exit": () => {
      kinds.pop()
    },
    VariableDeclarator: (node) => {
      const current = scope
      let initializer = Option.none<Expression>()
      if (kinds.at(-1) === "const") initializer = Option.fromNullishOr(node.init)
      bindSeamPattern(node.id, variableScope(), Option.getOrUndefined(initializer))
      if (node.id.type !== "ObjectPattern" || !node.init) return
      const pattern = node.id
      const input = node.init
      reads.push(() =>
        seamAuthorityOf(input, current).pipe(
          Option.match({
            onNone: () => [],
            onSome: (authority) => {
              if (authority.kind !== "context") return []
              return pattern.properties.flatMap((property) => {
                if (property.type !== "Property" || property.computed) return []
                return Option.toArray(staticNameOf(property.key))
                  .filter((name) => /^[A-Z]/.test(name))
                  .map((name) => seamKey("facet", name))
              })
            },
          }),
        ),
      )
    },
    MemberExpression: (node) => {
      const current = scope
      reads.push(() =>
        seamAuthorityOf(node, current).pipe(
          Option.match({
            onNone: () => [],
            onSome: (authority) => {
              if (authority.kind !== "facet" || !authority.member) return []
              return [seamKey("facet", authority.member)]
            },
          }),
        ),
      )
    },
    CallExpression: (node) => {
      const current = scope
      reads.push(() => callSeamUses(node, current))
    },
  }).visit(program)
  return {
    declarations: declaredSeamsOf(program, lineOf),
    uses: new Set(reads.flatMap((read) => read())),
  }
}

/**
 * Only a shipped extension fills a facet. The seam-declaration file copies
 * every facet in `extensionServicesFromHostContext` (`Facet: ctx.Facet`), and
 * crediting that plumbing would make every facet permanently adapted, which
 * is the dead-facet check this guard exists for.
 */
export const adaptedSeamsIn = (file: string, text: string): ReadonlySet<SeamKey> => {
  if (!isAdapterSource(file)) return new Set()
  return sourceForms(file, text).seams.uses
}

/**
 * The members of the `ResourceScope` union.
 *
 * A string union, not an interface, so this reads the literals rather than
 * `readonly` members.
 *
 * Extensions carry an unrelated load scope on the same field name
 * (`scope: "builtin"`), so a `ResourceScope` sharing one of those names would
 * be credited by a load-scope site and never reported. Keep those names
 * excluded from this resource-only contract.
 */
const EXTENSION_LOAD_SCOPES: ReadonlySet<string> = new Set(["builtin", "user", "project"])

export const findUnadaptedSeams = (
  sources: ReadonlyMap<string, string>,
  adapted: ReadonlySet<SeamKey>,
): ReadonlyArray<Finding> => {
  const text = sources.get(SEAM_DECLARATION_FILE)
  if (!text) return []
  return sourceForms(SEAM_DECLARATION_FILE, text)
    .seams.declarations.filter(({ family, name }) => !adapted.has(seamKey(family, name)))
    .map(({ family, name, line }) => ({
      file: SEAM_DECLARATION_FILE,
      line,
      message: `${SEAM_LABELS[family]} "${name}" has no shipped adapter; a seam nothing implements is dead surface. Ship an adapter or remove the seam.`,
    }))
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
 * the shape core would use to call `ModelResolver.resolve`. The providers are
 * the shipped model drivers (`anthropic`, `openai`, `opencode`, `opencode-go`,
 * `typesafe`) and the other catalog vendors.
 */
const VENDOR_MODEL_PATTERN =
  /["'`](?:anthropic|openai|opencode|opencode-go|typesafe|google|mistral|xai|groq|deepseek)\/[a-z0-9][a-z0-9.-]*["'`]/i

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

// ── names describe the product, not the process ─────────────────────────────

/**
 * Guard: source and tests name product behavior, not the process that made
 * them (AGENTS.md "Process-shaped names"). A ledger id or a pass name (wave,
 * batch or pass with its number) in a comment, a test name or an identifier
 * is history, and it outlives the ledger that explains it. `PROCESS_NAME`
 * spells the id forms: a work-item id; a row id keyed by its pass (up to four
 * capitals, the two-digit pass, a dash and a number); and a row id of one of
 * the ledger's unnumbered classes (its prefix, a dash and a number).
 * Seven commits since 2026-09-15 removed such ids by hand. Only the id form
 * is read; history told in prose stays a review item. `plans/` and the dated
 * receipts are outside the source roots, so they keep their ids.
 */
const PROCESS_NAME_ROOT = /^(?:packages|apps|examples|testbeds)\//

const PROCESS_NAME =
  /\bW\d{2}-C\d|\b[A-Z]{1,4}\d{2}-[\w-]*\d\b|\b(?:AN|AV|CE|CM|DL|EX|FS|GD|GR|GX|LV|MX|NT|PV|SK|SS|TL|WK)-\d+\b|\bwave\d+|\bbatch\d+|\bpass-\d+/

export const findProcessNames = (file: string, text: string): ReadonlyArray<Finding> => {
  if (!PROCESS_NAME_ROOT.test(file)) return []
  const forms = sourceForms(file, text)
  return [...forms.comments, ...forms.names].flatMap(({ body, line }) =>
    body.split("\n").flatMap((part, index) =>
      Option.match(Option.fromNullishOr(PROCESS_NAME.exec(part)?.[0]), {
        onNone: () => [],
        onSome: (token) => [
          {
            file,
            line: line + index,
            message: `\`${token}\` names the process that made this code, not what it does; name the behavior, and leave the id to the ledger`,
          },
        ],
      }),
    ),
  )
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

/** The two subprocess fixture entry paths. */
const FIXTURE_MODULE = /^\.\.\/src\/(?:server-process-fixture|pty-fixture)(?:\.js)?$/

export const findE2eFixtureImportFindings = (
  file: string,
  text: string,
): ReadonlyArray<Finding> => {
  if (!E2E_TEST_FILE.test(file)) return []
  if (sourceForms(file, text).module.valueImports.some((path) => FIXTURE_MODULE.test(path)))
    return []
  return [
    {
      file,
      line: 1,
      message:
        "e2e test files must import ../src/server-process-fixture or ../src/pty-fixture; an in-process test belongs in the owning package's tests/",
    },
  ]
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
 * - A rule defined in `gent-rules.ts` that no block of the lint config turns on: a rule
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

// ── (b) A plugin rule the lint config never enables ─────────────────────────

/** The line a rule's `"<name>":` key sits on in the plugin text, for a finding that points at it. */
const lineOfRule = (pluginText: string, rule: string): number =>
  Math.max(1, pluginText.split("\n").findIndex((line) => line.includes(`"${rule}":`)) + 1)

const OffLevel = Schema.Literals(["off", "allow", 0])

/** A rule setting that turns the rule off: `"off"`, `"allow"`, `0`, or one of them first in an options array. */
const isOffSetting = Schema.is(
  Schema.Union([OffLevel, Schema.TupleWithRest(Schema.Tuple([OffLevel]), [Schema.Unknown])]),
)

/**
 * The rules some block of the config turns on: the root block, or an
 * override that scopes the rule to the files that need it.
 */
export const enabledLintRules = (config: OxlintConfig): ReadonlySet<string> =>
  new Set(
    [config.rules ?? {}, ...(config.overrides ?? []).map((override) => override.rules ?? {})]
      .flatMap((rules) => Object.entries(rules))
      .values()
      .filter(([, setting]) => !isOffSetting(setting))
      .map(([rule]) => rule),
  )

/**
 * `ruleNames` is `Object.keys(plugin.rules)` of the loaded plugin, so the set
 * does not depend on how the plugin text is formatted; the text only places
 * the finding.
 */
export const findUnenabledPluginRules = (
  pluginFile: string,
  pluginText: string,
  ruleNames: ReadonlyArray<string>,
  enabledRules: ReadonlySet<string>,
): ReadonlyArray<Finding> =>
  ruleNames
    .values()
    .filter((rule) => !enabledRules.has(`gent/${rule}`))
    .map((rule) => ({
      file: pluginFile,
      line: lineOfRule(pluginText, rule),
      message: `lint rule \`gent/${rule}\` is defined but the lint config never enables it; enable it, or delete the rule and its fixtures`,
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
  ["GENT_COMPILE_TARGET", "the release build names the Bun runtime each platform embeds"],
  [
    "GENT_RELEASES_URL",
    "an operator points install.sh and `gent upgrade` at a mirror of the releases",
  ],
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
 * The names a source's code sets, by the record shape -- including the
 * record a test hands `ConfigProvider.fromEnvRecord` -- and the assignment
 * shape.
 */
const namesWritten = (forms: SourceForms): ReadonlyArray<NameAt> => [
  ...[...forms.code.matchAll(ENV_RECORD_OPEN)].flatMap((match) => {
    const open = match.index + match[0].length - 1
    const record = forms.code.slice(open, bracketEnd(forms, open))
    return namesMatchingAt(record, ENV_RECORD_KEY, open)
  }),
  ...namesMatchingAt(forms.code, ENV_ASSIGNMENT),
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
    const forms = sourceForms(file, text)
    const code = forms.code
    mention(code)
    for (const [index, line] of code.split("\n").entries()) {
      for (const name of [...quotedReads(line), ...namesMatching(line, DIRECT_READ)]) {
        record(readers, name, { file, line: index + 1, testSupport })
      }
    }
    for (const write of namesWritten(forms)) {
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

/** A `define:` record handed to `Bun.build`: the compiled build's constants. */
const DEFINE_RECORD_OPEN = /\bdefine\s*:\s*\{/g
const DEFINE_KEY = /(?:^|[{,\s])["']?(__GENT_[A-Z0-9_]+__)["']?\s*:/g
/** The reader of a define: an ambient `declare const` the bundler replaces. */
const DEFINE_READER = /\bdeclare\s+const\s+(__GENT_[A-Z0-9_]+__)\b/g

/** A define key or its reader, and where it is. */
interface VariableSite {
  readonly name: string
  readonly file: string
  readonly line: number
}

/**
 * Guard: a build define and its reader come in pairs.
 *
 * The build script hands `Bun.build` a `define` record of `__GENT_*__`
 * constants, and the source reads each through a `declare const`. A
 * misspelled or deleted define leaves its reader undefined, so the compiled
 * binary behaves as a source run, and no test sees it: the tests run the
 * source. A define with no reader sets nothing. So each define key needs a
 * reader, and each reader a define, outside test support.
 */
export const findUnpairedBuildDefines = (
  sourceTexts: ReadonlyMap<string, string>,
): ReadonlyArray<Finding> => {
  const defines: Array<VariableSite> = []
  const readers: Array<VariableSite> = []
  for (const [file, text] of sourceTexts) {
    if (file === GUARDS_FILE || file === GUARDS_TEST_FILE || isTestSupport(file)) continue
    if (!text.includes("__GENT_")) continue
    const forms = sourceForms(file, text)
    const code = forms.code
    for (const match of code.matchAll(DEFINE_RECORD_OPEN)) {
      const open = match.index + match[0].length - 1
      const keys = namesMatchingAt(code.slice(open, bracketEnd(forms, open)), DEFINE_KEY, open)
      defines.push(...keys.map((key) => ({ name: key.name, line: lineAt(code, key.at), file })))
    }
    // A reader is code: `declare const` spelled in a string declares nothing.
    const declarations = forms.codeOnly
    for (const reader of namesMatchingAt(declarations, DEFINE_READER)) {
      readers.push({ name: reader.name, line: lineAt(declarations, reader.at), file })
    }
  }
  const defined = new Set(defines.map((define) => define.name))
  const read = new Set(readers.map((reader) => reader.name))
  return [
    ...defines
      .values()
      .filter((define) => !read.has(define.name))
      .map((define) => ({
        file: define.file,
        line: define.line,
        message: `build define \`${define.name}\` has no \`declare const\` reader, so it sets nothing; delete it, or read it`,
      })),
    ...readers
      .values()
      .filter((reader) => !defined.has(reader.name))
      .map((reader) => ({
        file: reader.file,
        line: reader.line,
        message: `\`${reader.name}\` is read but no build \`define\` sets it, so the compiled binary reads it undefined, as a source run does; add the define, or delete the reader`,
      })),
  ]
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
 * Retired `Bun.*` members (`Bun.Glob`, and `Bun.randomUUIDv7` outside the
 * platform impl) are banned by the lint instead, because only the AST sees a
 * member access: the built-in bans of `effect/noGlobals` hold both members in
 * every spelling (`Bun.Glob`, `globalThis.Bun.Glob`, `globalThis["Bun"].Glob`,
 * `Bun["Glob"]`, an alias of `globalThis` or of `Bun`), the `bun` module ban
 * of `effect/noNodeBuiltinImport` holds an import of either member, and
 * `effect/noReflectGet` holds `Reflect.get`. The plain Bun scripts keep
 * `effect/noGlobals` on with `builtins: false` and only those two members.
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
 * The root `AGENTS.md`, `CLAUDE.md` and `ARCHITECTURE.md`, the root
 * `NORTH_STAR.md` and `PRIOR_ARTS.md` the architecture loop reads, a package's
 * own `AGENTS.md` or `CLAUDE.md`, `docs/` but its dated research, a testbed's
 * `README.md` (the root `CLAUDE.md` sends agents to the gamut one), the
 * dependency patch notes in `patches/README.md`, and the skills gent ships to its own model under
 * `packages/extensions/src/skills/bundled/`. The path claims, the Markdown
 * links, the retired-surface rows and the code-block compile all read exactly
 * this set.
 */
const STEERING_PROSE =
  /^(?:(?:AGENTS|CLAUDE|ARCHITECTURE|NORTH_STAR|PRIOR_ARTS)\.md|(?:apps|packages)\/[^/]+\/(?:AGENTS|CLAUDE)\.md|docs\/(?!research\/).+\.md|testbeds\/[^/]+\/README\.md|patches\/README\.md|packages\/extensions\/src\/skills\/bundled\/.+\.md)$/

export const isSteeringFile = (file: string): boolean => STEERING_PROSE.test(file)

/** The eight roots under which a backticked path is a claim about the tree. */
const SOURCE_ROOT = /^(?:packages|apps|plans|testbeds|examples|docs|patches|\.claude)\//

/** Text between backticks, which is what marks a reference as a path. */
const BACKTICKED = /`([^`\n]+)`/g

/**
 * A fence: three or more backticks or tildes, at any indent (a list item
 * indents its fences), then the info string.
 */
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/

/** A closing fence: the fence alone on its line. */
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/

/** One fenced block of a Markdown text, by line index. */
export interface FencedBlock {
  /** The opening fence's line. */
  readonly open: number
  /** The closing fence's line, or the line count when the text ends first. */
  readonly close: number
  /** The opener's indent, which each code line carries too. */
  readonly indent: string
  /** The opener's info string, trimmed: the language, then any attributes. */
  readonly info: string
}

/**
 * The fenced blocks of `text`, the one fence reader of the tooling: the
 * guards skip their lines, and the guide check compiles their code. A block
 * closes on a bare fence of its own character at least as long as the
 * opener, so a ```` block can show a ``` line, and a ~~~ block closes only
 * on tildes; one the text never closes runs to its end.
 */
export const fencedBlocks = (text: string): ReadonlyArray<FencedBlock> => {
  const lines = text.split("\n")
  const blocks: Array<FencedBlock> = []
  const closes = (line: string, fence: string): boolean =>
    (FENCE_CLOSE.exec(line)?.[1] ?? "").startsWith(fence)
  let index = 0
  while (index < lines.length) {
    const opener = Option.fromNullishOr(FENCE.exec(lines[index] ?? ""))
    if (Option.isSome(opener)) {
      const [, indent = "", fence = "", info = ""] = opener.value
      const open = index
      index += 1
      while (index < lines.length && !closes(lines[index] ?? "", fence)) index += 1
      blocks.push({ open, close: index, indent, info: info.trim() })
    }
    index += 1
  }
  return blocks
}

/** Whether each line of `text` is fenced: a fence line, or a line inside a block. */
const fencedLines = (text: string): ReadonlyArray<boolean> => {
  const fenced = text.split("\n").map(() => false)
  for (const block of fencedBlocks(text)) {
    for (let line = block.open; line <= Math.min(block.close, fenced.length - 1); line += 1) {
      fenced[line] = true
    }
  }
  return fenced
}

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
  const fenced = fencedLines(text)
  for (const [index, line] of text.split("\n").entries()) {
    if (fenced[index] === true) continue
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

/**
 * A receipt in steering prose: one or more backticked names, then `in`, then
 * a backticked code path, across line breaks. `a`, `b` and `c` in `x.ts`
 * names three; a call `f()` names `f`.
 */
const RECEIPT =
  /((?:`[A-Za-z_$][\w$.]*(?:\(\))?`(?:,\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+))*`[A-Za-z_$][\w$.]*(?:\(\))?`)\s+in\s+`([^`\s]+\.[cm]?[jt]sx?)`/g

/** One backticked name of a receipt; a dotted name is read by its last segment. */
const RECEIPT_NAME = /`(?:[\w$]+\.)*([A-Za-z_$][\w$]*)(?:\(\))?`/g

/** A whole receipt pair, then the comma that continues a list after it. */
const LISTED_PAIR = new RegExp(`${RECEIPT.source},\\s*$`)

/** A sentence end, or a blank line that ends a paragraph. */
const SENTENCE_END = /[.!?]\s|\n[ \t]*\n/g

/**
 * Whether the pair at `at` is stated as a receipt: it opens a parenthesis
 * (`(`name` in `path`)`), it continues a list after a stated pair in the
 * same parentheses (`(`a` in `x.ts`, `b` in `y.ts`)`), or its sentence runs
 * from a `Receipt:` or `Receipts:` label. Any other pair is prose, such as
 * "avoid `x` in `y.ts`", which asserts nothing about where `x` lives.
 */
const isStatedReceipt: (prose: string, at: number) => boolean = (prose, at) => {
  const before = prose.slice(Math.max(0, at - 600), at)
  if (/\(\s*$/.test(before)) return true
  return Option.match(Option.fromNullishOr(LISTED_PAIR.exec(before)), {
    onSome: (listed) => isStatedReceipt(prose, at - before.length + listed.index),
    onNone: () => isLabelled(before),
  })
}

/** Whether the sentence that ends at the end of `before` runs from a receipt label. */
const isLabelled = (before: string): boolean => {
  const sentenceStart = Option.match(
    Option.fromUndefinedOr(before.matchAll(SENTENCE_END).toArray().at(-1)),
    {
      onNone: () => 0,
      onSome: (end) => end.index + end[0].length,
    },
  )
  return /\bReceipts?:/.test(before.slice(sentenceStart))
}

/** The text with each fenced block's lines blank, so offsets keep their lines. */
const withoutFences = (text: string): string => {
  const fenced = fencedLines(text)
  return text
    .split("\n")
    .map((line, index) => {
      if (fenced[index] === true) return ""
      return line
    })
    .join("\n")
}

/**
 * Guard: a "`name` in `path`" receipt in steering prose names a word the
 * file holds. A pair is a receipt only where the prose states one
 * (`isStatedReceipt`): in parentheses, or after a `Receipt:` label.
 *
 * The path check proves the file exists, not that the name still lives in
 * it: a renamed or deleted function leaves the receipt pointing at a file
 * that no longer holds it. A path resolves to the tracked file it names, or,
 * when it is short (`runtime/turn.ts`), to every tracked file outside a
 * fixture directory whose path ends with it; one of them must hold the name
 * as a word. A short path that resolves to no file is reported; a full path
 * that resolves to none is the path check's report.
 */
export const findStaleSteeringReceipts = (
  texts: ReadonlyMap<string, string>,
  trackedFiles: ReadonlyArray<string>,
): ReadonlyArray<Finding> => {
  const tracked = new Set(trackedFiles)
  const resolve = (path: string): ReadonlyArray<string> => {
    if (tracked.has(path)) return [path]
    return trackedFiles.filter((file) => file.endsWith(`/${path}`) && !isExplicitFixtureFile(file))
  }
  /** The messages for one receipt: its path ends no file, or a name its files do not hold. */
  const receiptMessages = (names: string, path: string): ReadonlyArray<string> => {
    const candidates = resolve(path)
    if (candidates.length === 0) {
      if (isPathClaim(path)) return []
      return [
        `steering receipt names \`${path}\`, which ends no staged or committed file -- point it at the path that exists`,
      ]
    }
    const candidateTexts = candidates.flatMap((candidate) =>
      Option.toArray(Option.fromUndefinedOr(texts.get(candidate))),
    )
    if (candidateTexts.length === 0) return []
    return names
      .matchAll(RECEIPT_NAME)
      .map((nameMatch) => nameMatch[1] ?? "")
      .filter((name) => {
        const word = new RegExp(`(?<![\\w$])${name.replaceAll("$", "\\$")}(?![\\w$])`)
        return !candidateTexts.some((candidate) => word.test(candidate))
      })
      .map(
        (name) =>
          `steering receipt names \`${name}\` in \`${path}\`, which that file does not hold -- point the receipt at the name that does the work today, or drop it`,
      )
      .toArray()
  }
  return [...texts].flatMap(([file, text]) => {
    if (!isSteeringFile(file)) return []
    const prose = withoutFences(text)
    return prose
      .matchAll(RECEIPT)
      .filter((match) => isStatedReceipt(prose, match.index))
      .flatMap((match) =>
        receiptMessages(match[1] ?? "", match[2] ?? "").map((message) => ({
          file,
          line: lineAt(prose, match.index),
          message,
        })),
      )
      .toArray()
  })
}

/** The part of a package's `turbo.json` the guide input check reads. */
export const TurboTypecheckInputsSchema = Schema.Struct({
  tasks: Schema.Struct({
    typecheck: Schema.Struct({ inputs: Schema.Array(Schema.String) }),
  }),
})

export const TurboTaskInputsSchema = Schema.Struct({
  tasks: Schema.optionalKey(
    Schema.NullOr(
      Schema.Record(
        Schema.String,
        Schema.Struct({
          // Turbo owns validation of deferred input objects; this guard reads only paths.
          inputs: Schema.optionalKey(
            Schema.NullOr(Schema.Array(Schema.Union([Schema.String, Schema.Struct({})]))),
          ),
        }),
      ),
    ),
  ),
})

/** Wax accepts a one-member brace group; Picomatch needs a comma to treat it as a group. */
const turboBraceGroups = (glob: string): string => {
  const groups: Array<{ start: number; comma: boolean }> = []
  let out = ""
  let escaped = false
  let inClass = false
  for (const char of glob) {
    if (escaped) {
      out += char
      escaped = false
      continue
    }
    if (char === "\\") escaped = true
    else if (char === "[") inClass = true
    else if (char === "]") inClass = false
    else if (!inClass && char === "{") groups.push({ start: out.length, comma: false })
    else if (!inClass && char === ",") {
      const group = groups.at(-1)
      if (group) group.comma = true
    } else if (!inClass && char === "}") {
      const group = groups.pop()
      if (group && !group.comma) out += `,${out.slice(group.start + 1)}`
    }
    out += char
  }
  return out
}

/** Package task inputs resolve relative to that package; inherited/default inputs are Turbo tokens. */
export const findDeadTurboInputs = (
  file: string,
  tasks: typeof TurboTaskInputsSchema.Type.tasks,
  trackedFiles: ReadonlyArray<string>,
): ReadonlyArray<Finding> => {
  const directory = file.slice(0, file.lastIndexOf("/") + 1)
  const patternOf = (input: string) => {
    const root = "$TURBO_ROOT$/"
    let path = directory + input
    if (input.startsWith(root)) path = input.slice(root.length)
    const parts: Array<string> = []
    for (const part of path.split("/")) {
      if (part === "..") parts.pop()
      else if (part !== "." && part !== "") parts.push(part)
    }
    const glob = turboBraceGroups(parts.join("/"))
    // Turbo accepts directory inputs and includes dotfiles in explicit inputs.
    return picomatch([glob, `${glob}/**`], { dot: true, noext: true })
  }
  return Object.entries(tasks ?? {}).flatMap(([task, config]) =>
    (config.inputs ?? [])
      .filter(Predicate.isString)
      .filter(
        (input) =>
          !input.startsWith("!") && input !== "$TURBO_DEFAULT$" && input !== "$TURBO_EXTENDS$",
      )
      .filter((input) => {
        const matches = patternOf(input)
        return !trackedFiles.some((path) => matches(path))
      })
      .map((input) => ({
        file,
        line: 1,
        message: `the ${task} input \`${input}\` matches no tracked file; delete it`,
      })),
  )
}

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
 * `../x` and `$TURBO_ROOT$/x` name the repo path `x`, `$TURBO_DEFAULT$`
 * names every file of the package, and a `!` input subtracts.
 */
export const findUnhashedSteeringFiles = (
  file: string,
  inputs: ReadonlyArray<string>,
  trackedFiles: ReadonlyArray<string>,
): ReadonlyArray<Finding> => {
  const packageDirectory = file.slice(0, file.lastIndexOf("/") + 1)
  const repoGlob = (input: string): RegExp => {
    if (input === "$TURBO_DEFAULT$") return globMatcher(`${packageDirectory}**`)
    if (input.startsWith("$TURBO_ROOT$/")) return globMatcher(input.slice("$TURBO_ROOT$/".length))
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
  const unhashed = trackedFiles
    .values()
    .filter((path) => path.endsWith(".md") && hashed(path) !== isSteeringFile(path))
    .map((path) => ({ file, line: 1, message: message(path) }))
    .toArray()
  // An input that matches nothing hashes nothing: it is dead, like an
  // override glob that matches no file.
  const dead = findDeadTurboInputs(file, { typecheck: { inputs } }, trackedFiles)
  return [...unhashed, ...dead]
}

// ── the approved diagnostics suppressions ───────────────────────────────────

/**
 * The one suppression the linters cannot police: `@effect-diagnostics` comments.
 * Every other kind (`@ts-ignore`, `as any`, block eslint-disables) is banned by
 * oxlint or by `findBlanketEslintDisables`, so this inventory is the approved list
 * of diagnostics suppressions and nothing else.
 *
 * The inventory is checked in both directions: a suppression comment with no
 * approved entry fails the guard, and an approved entry with no matching
 * comment anywhere in the tree fails it too, so the table cannot drift. An
 * entry states how many identical comments its file holds (`count`, one when
 * absent), and the guard fails when the file holds more or fewer: a new site
 * of a reviewed comment is a new suppression and needs its own review. An
 * entry listed twice fails as well.
 *
 * The language service honors a directive anywhere in a file's text, a string
 * literal too, with the `rule:severity` flag after other words on the line
 * (`HONORED_DIRECTIVE` states the grammar). So the scan reads each line for
 * that form, not only the comment tokens. A directive without `-next-line`
 * suppresses its rules from there to the end
 * of the file; like a file-wide lint disable, it is banned outright.
 */

interface ApprovedSuppressionEntry {
  readonly file: string
  /** Everything after `// @effect-diagnostics-next-line `: rule flags and the reason. */
  readonly text: string
  /**
   * How many identical comments the file holds; absent means one. The guard
   * fails when the file holds more or fewer, so a new site asks for review.
   */
  readonly count?: number
}

const directiveMarker = "@effect-diagnostics"

/** A literal word in any letter case, as a regex source. */
const anyCase = (word: string): string =>
  word.replace(/[a-z]/g, (char) => `[${char}${char.toUpperCase()}]`)

/**
 * The form the compiler honors; the capture is `-next-line`, or empty for the
 * file scope. The compiler's own pattern is
 * `@effect-diagnostics(-next-line)?\s+([\w:\-*]+(?:\s+[\w:\-*]+)*)`, in Go,
 * where `\s` is a space, a tab or a form feed on one line. Inside those words
 * it reads `<rule or *>:<severity>`, the rule and the severity in any case,
 * where no word character, alone or after one `-`, follows the severity.
 * `warn` is `warning`. `tests/guards.test.ts` holds this grammar to `tsc` on
 * a matrix of spellings, so a compiler change fails a test.
 */
const DIRECTIVE_SPACE = "[ \\t\\f]"

const HONORED_DIRECTIVE = new RegExp(
  `@effect-diagnostics(-next-line)?${DIRECTIVE_SPACE}+(?:[\\w:*-]|${DIRECTIVE_SPACE})*?(?:\\w+|\\*):(?:${[
    "off",
    "warning",
    "warn",
    "error",
    "message",
    "suggestion",
    "skip-file",
  ]
    .map(anyCase)
    .join("|")})(?!-?\\w)`,
)

const approvedComment = (entry: ApprovedSuppressionEntry): string =>
  `// ${directiveMarker}-next-line ${entry.text}`

/** Matching ignores line churn: an entry is keyed by file and exact comment text. */
const approvedSuppressionEntries: ReadonlyArray<ApprovedSuppressionEntry> = [
  {
    file: "packages/sdk/src/discovery.ts",
    text: "strictEffectProvide:off -- the public entry point provides the local platform it resolves on.",
  },
  {
    file: "packages/sdk/src/discovery.ts",
    text: "strictEffectProvide:off -- self-contained probe, no scope lifetime",
  },
  {
    file: "packages/core/src/domain/extension.ts",
    text: "anyUnknownInErrorContext:off -- extension setup is untyped until this membrane maps its failures to ExtensionLoadError.",
  },
  {
    file: "packages/tooling/src/check-guide-code.ts",
    text: "strictEffectProvide:off -- the script's process entry provides the platform once.",
  },
  {
    file: "packages/core/src/runtime/tools.ts",
    text: "anyUnknownInErrorContext:off -- an extension tool fails with unknown until normalizeToolExecutionError maps it.",
  },
  {
    file: "packages/core/src/domain/capability.ts",
    text: "anyUnknownInErrorContext:off -- the erased handler crosses the runtime membrane; the public overloads keep authors typed.",
  },
  {
    file: "packages/core/src/runtime/extension-host.ts",
    text: "anyUnknownInErrorContext:off -- the extension membrane erases the author effect channels and seals them here.",
    count: 8,
  },
  {
    file: "packages/core/src/runtime/extension-host.ts",
    text: "anyUnknownInErrorContext:off -- heterogeneous Resource layer enters the explicit eraseResourceLayer membrane.",
  },
  {
    file: "packages/extensions/src/openai.ts",
    text: "strictEffectProvide:off -- OAuth token endpoint at extension boundary",
    count: 2,
  },
  {
    file: "packages/extensions/src/openai.ts",
    text: "strictEffectProvide:off -- device endpoints at extension boundary",
  },
  {
    file: "packages/core/src/server/rpc.ts",
    text: "schemaStructWithTag:off -- the RPC client builds the payload with make, and a defaulted tag would read { scope: {} } as Launch.",
    count: 2,
  },
  {
    file: "packages/extensions/src/anthropic.ts",
    text: "strictEffectProvide:off -- the credential read owns its HTTP client at the extension boundary; it outlives no scope.",
  },
]

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
  const seenByComment = new Map<string, number>()
  for (const [index, line] of text.split("\n").entries()) {
    const directive = Option.fromNullishOr(HONORED_DIRECTIVE.exec(line))
    if (Option.isNone(directive)) continue
    if (Predicate.isUndefined(directive.value[1])) {
      findings.push({
        file,
        line: index + 1,
        message: `a file-scope ${directiveMarker} directive suppresses its rules to the end of the file and is banned, like a file-wide lint disable; use ${directiveMarker}-next-line on the one line, with an approved entry`,
      })
      continue
    }
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
 *   `packages/extensions/src/client.ts`) exposes names, mostly with
 *   `export { X } from "..."`, and a few it declares itself; each is
 *   measured the same way. Consumption is read from the import
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
  /** True for a type this file declares (`export type`, `export interface`, `export type { Local }`). */
  readonly typeOnly: boolean
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/g

/** Every identifier-shaped word in a text, for a cheap "is this name mentioned" test. */
const identifiersIn = (text: string): ReadonlySet<string> => new Set(text.match(IDENTIFIER) ?? [])

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
 * reads `X` too: it is the chain an entry point is. A namespace import, or a
 * binding of a literal dynamic import, credits every member the file's code
 * reads off it. A read on a `@ts-expect-error` line asserts absence and reads
 * nothing.
 */
const specifierReadsIn = (file: string, text: string): ReadonlyArray<SpecifierRead> => {
  const forms = sourceForms(file, text)
  const skip = expectErrorLines(text.split("\n"))
  const codeLines = forms.codeOnly.split("\n")
  return forms.module.reads
    .filter((read) => !skip.has(read.line))
    .map((read) => ({
      specifier: read.specifier,
      names: [
        ...read.names,
        ...read.namespaces.flatMap((alias) => namespaceMembersIn(codeLines, alias, skip)),
      ],
    }))
}

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

/**
 * `(name, line)` for every name a surface file exports, each name once.
 *
 * Every export shape reaches the same place. `export const Foo` and a bare
 * `export { Foo }` of a local name expose this file's own declaration. A
 * `from` block, or a bare block that passes on an imported name, puts a
 * second consumable name at this module path, so a dead one is dead here even
 * though the declaring module keeps its own alive. A type this file declares
 * is `typeOnly`; a type it passes on is not, since its own use reads the
 * import, not the export.
 */
const declarationsIn = (
  surface: ScannedSurface,
  file: string,
  text: string,
): ReadonlyArray<Declaration> => {
  // A value and a type may share a name, each on its own line; any other
  // repeat (a bare block or a re-export of a declared name) is counted once.
  const names = new Set<string>()
  const declared = new Set<string>()
  return sourceForms(file, text).module.exports.flatMap((entry) => {
    const key = `${entry.name}:${String(entry.isType)}`
    if (entry.passthrough && names.has(entry.name)) return []
    if (!entry.passthrough && declared.has(key)) return []
    names.add(entry.name)
    declared.add(key)
    const typeOnly = entry.isType && !entry.passthrough
    return [{ name: entry.name, line: entry.line, typeOnly, surface }]
  })
}

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
    onSome: (found) => declarationsIn(found, file, text),
  })
  const identifiersByLine = Option.match(
    Option.filter(surface, (found) => found.ownFileCounts),
    {
      onNone: (): ReadonlyArray<ReadonlySet<string>> => [],
      onSome: () => sourceForms(file, text).codeOnly.split("\n").map(identifiersIn),
    },
  )
  const reads = specifierReadsIn(file, text)
  const starExportLines = Option.match(surface, {
    onNone: (): ReadonlyArray<number> => [],
    onSome: () => sourceForms(file, text).module.starExportLines,
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
 * surface. The e2e harness, the tooling and the examples are leaves: nothing
 * imports them, so they expose nothing.
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

/** A triple-slash types reference in a parsed line-comment body. */
const TYPES_REFERENCE = /^\/\s*<reference\s+types=["']([^"'\s]+)["']/g
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
 * The module specifiers a source file loads or names, read from syntax so
 * source-looking prose keeps nothing alive. A manifest names its own
 * dependencies as keys; only its scripts count, as commands.
 */
const specifiersIn = (file: string, text: string): ReadonlyArray<string> => {
  if (/\.[cm]?[jt]sx?$/.test(file)) {
    return sourceForms(file, text).module.specifiers
  }
  if (/(?:^|\/)package\.json$/.test(file)) return []
  if (/\.jsonc?$/.test(file)) return matchedGroups(withoutComments(file, text), CONFIG_STRING)
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
