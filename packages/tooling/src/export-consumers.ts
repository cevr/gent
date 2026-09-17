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
 *   `packages/sdk/src/index.ts`, `packages/extensions/src/client.ts`) exposes names with `export { X } from "..."`. Consumption is read from the import
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

import { Option } from "effect"

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
    outsideOf: ["packages/core/src/", "packages/core-internal/"],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.some("@gent/core/extensions/api"),
    enforced: true,
  },
  {
    prefix: "packages/core/src/extensions/branch-tools.ts",
    exempt: [],
    outsideOf: ["packages/core/src/", "packages/core-internal/"],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.some("@gent/core/extensions/branch-tools"),
    enforced: true,
  },
  {
    prefix: "packages/core/src/protocol.ts",
    exempt: [],
    outsideOf: ["packages/core/src/", "packages/core-internal/"],
    testsCount: true,
    ownFileCounts: false,
    specifier: Option.some("@gent/core/protocol"),
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
    ownFileCounts: true,
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

const isTestFile = (file: string): boolean =>
  /\.test\.[cm]?[jt]sx?$/.test(file) || /(?:^|\/)tests\//.test(file)

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
}

const DECLARATION =
  /^export\s+(?:declare\s+)?(?:const|class|function|interface|type|enum)\s+([A-Za-z_$][\w$]*)/

/**
 * `(name, line)` for every export a module surface file declares.
 *
 * Two shapes reach the same place. `export const Foo` names the value on the
 * spot. A bare `export { Foo, Bar }` with no `from` clause exposes names this
 * file owns, so it is a surface too -- 26 dead names hid in one such block in
 * `packages/sdk/src/client.ts` because only the first shape was read.
 *
 * Two kinds of name in such a block are not this file's own, and counting
 * either would hide a real consumer: one it imported, and one it declares
 * elsewhere in the file. A block carrying `from` is a pass-through and belongs
 * to the entry-point path.
 */
const declaredNames = (
  text: string,
): ReadonlyArray<{ readonly name: string; readonly line: number }> => {
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
  return [...found, ...bare]
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
 * The names every `export { ... }` block without a `from` clause exposes.
 *
 * The block is collected whole before the `from` test, because a block broken
 * across lines carries its `from` on the closing line.
 */
const bareExportedNames = (
  text: string,
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
    // `} from "./x.js"` makes the block a pass-through, not a declaration.
    if (/\}\s*from\s*["']/.test(open.text)) continue
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

/** What one file contributes to the whole-tree answer. */
export interface ExportFacts {
  readonly declarations: ReadonlyArray<Declaration>
  /** Every identifier the file mentions anywhere. */
  readonly identifiers: ReadonlySet<string>
  /** Identifiers per line with comments and strings blanked; empty unless the file's surface reads its own references. */
  readonly identifiersByLine: ReadonlyArray<ReadonlySet<string>>
  /** Names imported through each entry-point specifier. */
  readonly imported: ReadonlyMap<string, ReadonlySet<string>>
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
    identifiersByLine,
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
export const findUnconsumedExports = (
  factsByFile: ReadonlyMap<string, ExportFacts>,
): ReadonlyArray<ExportConsumerFinding> => {
  const declaringFiles = new Map<string, Set<string>>()
  for (const [file, facts] of factsByFile) {
    for (const { name } of facts.declarations) {
      const files = Option.getOrElse(Option.fromNullishOr(declaringFiles.get(name)), () => {
        const created = new Set<string>()
        declaringFiles.set(name, created)
        return created
      })
      files.add(file)
    }
  }

  const isConsumed = (file: string, declaration: Declaration): boolean => {
    const declaredIn = Option.getOrElse(
      Option.fromNullishOr(declaringFiles.get(declaration.name)),
      () => new Set<string>(),
    )
    for (const [candidate, facts] of factsByFile) {
      if (!mayConsume(candidate, declaration.surface)) continue
      if (!mentions(facts, declaration.surface, declaration.name)) continue
      // A peer that merely declares the same name does not vouch for it; one
      // that imports it through this entry point's own specifier does.
      if (declaredIn.has(candidate) && Option.isNone(declaration.surface.specifier)) continue
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
  /** `exports` entries that must be present with exactly this target. */
  readonly requiredExports: Readonly<Record<string, string>>
}

/**
 * Core's public entry points are two authoring surfaces, deliberately split:
 * `extensions/api` for extensions that use the loop, `extensions/branch-tools`
 * for the rarer feature that implements a loop seam. Keeping them apart is
 * what keeps `api` small. `@gent/core-internal` mirrors core source through
 * one private wildcard lane; `@gent/extensions` is the builtin composition
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
      "./protocol",
      "./protocol.js",
    ],
    requiredExports: {},
  },
  {
    packageJson: "packages/core-internal/package.json",
    alias: "@gent/core-internal",
    mustBePrivate: true,
    entryPoints: [],
    requiredExports: { "./*.js": "./src/*.ts", "./*": "./src/*.ts" },
  },
  {
    packageJson: "packages/extensions/package.json",
    alias: "@gent/extensions",
    mustBePrivate: true,
    entryPoints: [".", "./index.js", "./client", "./client.js"],
    requiredExports: {},
  },
  {
    packageJson: "packages/sdk/package.json",
    alias: "@gent/sdk",
    mustBePrivate: false,
    entryPoints: ["."],
    requiredExports: {},
  },
]

const allowedKeys = (surface: PackageSurface): ReadonlySet<string> =>
  new Set([...surface.entryPoints, ...Object.keys(surface.requiredExports)])

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
  for (const [key, target] of Object.entries(surface.requiredExports)) {
    if (Option.exists(exportsMap, (map) => map[key] === target)) continue
    findings.push({
      path: `${surface.packageJson} exports["${key}"]`,
      message: `${surface.alias} must map "${key}" to "${target}"`,
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
