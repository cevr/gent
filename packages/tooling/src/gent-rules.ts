/**
 * Oxlint JS plugin: gent's own rules, one line each. Each rule's doc comment
 * below states it in full. A generic Effect rule lives in oxlint-plugin-effect;
 * a rule here is gent's own, or holds a line upstream does not hold yet and
 * names the upstream change that retires it.
 *
 * - core-entry-boundary: extensions read only the authoring entries of `@gent/core`.
 * - declared-workspace-imports: a package imports only the workspace packages it declares.
 * - no-hand-rolled-module-path: no file path read off `new URL(import.meta.url)` in core.
 * - no-retired-bun-member: no `Bun.Glob` or `Bun.randomUUIDv7` where `effect/noGlobals` is off.
 * - child-session-writer-admits: a core child-session writer admits the nesting depth first.
 * - no-identity-encode: a whole-object JSON encode decides no identity.
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Context, Plugin, Range } from "@oxlint/plugins"

/**
 * The view a structural walk takes of any ESTree node: a `type` tag and the
 * source range a report points at, with every other field read by name
 * through the helpers below. Typed ESTree nodes from `@oxlint/plugins` are
 * assignable to it.
 */
interface AstNode {
  readonly type: string
  readonly range: Range
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null

/** Read one field of a node without claiming its shape. */
const fieldOf = (node: AstNode, field: string): unknown => Reflect.get(node, field)

const isAstNode = (value: unknown): value is AstNode =>
  isRecord(value) && typeof value["type"] === "string" && Array.isArray(value["range"])

const getStringField = (n: AstNode, field: string): string | undefined => {
  const v = fieldOf(n, field)
  return typeof v === "string" ? v : undefined
}

const getNodeField = (n: AstNode, field: string): AstNode | undefined => {
  const v = fieldOf(n, field)
  return isAstNode(v) ? v : undefined
}

const getNodeArrayField = (n: AstNode, field: string): AstNode[] | undefined => {
  const v = fieldOf(n, field)
  if (!Array.isArray(v)) return undefined
  return v.filter(isAstNode)
}

/** A lint fixture: a file the rule tests run through the rules. */
const LINT_FIXTURE = /(?:^|\/)packages\/tooling\/fixtures\//

// ── what is a test ──────────────────────────────────────────────────────────
//
// One vocabulary for every rule here and every guard in `guards.ts`. Each
// predicate takes a repo-relative or an absolute path.

/**
 * A test: a `*.test.*` file, or any file in a `tests/` or `integration/` tree
 * (the helpers and fixtures a test file imports sit beside it there).
 */
export const isTest = (file: string): boolean =>
  /\.test\.[cm]?[jt]sx?$/.test(file) || /(?:^|\/)(?:tests|integration)\//.test(file)

/**
 * The test harness: source that exists only for tests but ships as a package
 * or package entry -- `@gent/e2e` and `@gent/core/test-utils`.
 */
export const isTestHarness = (file: string): boolean =>
  /(?:^|\/)packages\/(?:e2e|core\/src\/test-utils)\//.test(file)

/** Test code: a test or the harness. The test-code rules read this. */
export const isTestCode = (file: string): boolean => isTest(file) || isTestHarness(file)

/**
 * Test support: files that exist to test gent, not to ship it -- test code,
 * the testbeds, and the lint fixtures. The `core-entry-boundary` rule calls
 * everything else product code, and the guards never count a caller or an env
 * write here as proof of production use.
 */
export const isTestSupport = (file: string): boolean =>
  isTestCode(file) || LINT_FIXTURE.test(file) || /(?:^|\/)testbeds\//.test(file)

/**
 * Shipped source: a module under `packages/` or `apps/` that is not test
 * support and not build output. The tooling package lints the product; it is
 * not part of it. Every guard that asks "is this product code" reads this.
 */
export const isShippedSource = (file: string): boolean =>
  /^(?:packages|apps)\/(?!tooling\/)[^/]+\/.+\.[cm]?[jt]sx?$/.test(file) &&
  !file.includes("/dist/") &&
  !isTestSupport(file)

/**
 * A lint fixture mirrors the repo layout, so a rule judges it as the file at
 * the same path under the repo root; any other file is its own subject.
 */
const fixtureSubject = (filename: string): string => {
  const match = LINT_FIXTURE.exec(filename)
  return match === null ? filename : filename.slice(match.index + match[0].length)
}

/**
 * The path a rule's test-scope checks judge: relative to the lint root, so a
 * checkout under a directory named `tests` or `integration` does not turn
 * every file into a test, and for a lint fixture the file it mirrors.
 */
export const ruleSubject = (context: Pick<Context, "filename" | "cwd">): string => {
  const filename = context.filename.replaceAll("\\", "/")
  const root = `${context.cwd.replaceAll("\\", "/").replace(/\/$/, "")}/`
  return fixtureSubject(filename.startsWith(root) ? filename.slice(root.length) : filename)
}

const isExtensionFilename = (filename: string): boolean => {
  if (/\/extensions\/(?:api|branch-tools)\.ts$/.test(filename)) return false
  if (filename.endsWith("apps/tui/src/extensions/loader-boundary.ts")) return false
  return /(?:packages\/core\/src\/extensions|packages\/extensions\/src|apps\/tui\/src\/extensions|examples\/extensions)\//.test(
    filename,
  )
}

/** Core source, and the harness inside it, as seen in a resolved absolute path. */
const CORE_SOURCE_PATH = /\/packages\/core\/src\//
const TEST_UTILS_PATH = /\/packages\/core\/src\/test-utils\//
const AUTHORING_ENTRY = /^@gent\/core\/extensions\/(?:api|branch-tools)$/
const PROTOCOL_ENTRY = /^@gent\/core\/protocol$/
const TEST_UTILS_ENTRY = /^@gent\/core\/test-utils(?:\/|$)/
const EXTENSIONS_PACKAGE = /^@gent\/extensions(?:\/|$)/
/**
 * A TUI client extension: a shipped `*.client.*` module or the builtin roster
 * that lists them. Both author against `@gent/tui/extensions`, as a user
 * extension does.
 */
const TUI_CLIENT_EXTENSION_FILE = /\/apps\/tui\/src\/extensions\/(?:[^/]+\.client|builtins)\.tsx?$/
/** The builtin roster, the one client module that names its siblings. */
const TUI_CLIENT_ROSTER_FILE = /\/apps\/tui\/src\/extensions\/builtins\.tsx?$/
/** The one relative target the roster may name: a sibling client extension. */
const TUI_CLIENT_EXTENSION_MODULE = /\/apps\/tui\/src\/extensions\/[^/]+\.client(?:\.tsx?|\.js)?$/

/** The module specifier of an import, re-export, or dynamic import. */
const importSourceOf = (node: AstNode): string | undefined => {
  const source = getNodeField(node, "source")
  if (source === undefined) return undefined
  return getStringField(source, "value")
}

/** The absolute path a relative specifier names, or undefined for a package specifier. */
const resolvedRelativeSource = (filename: string, source: string): string | undefined => {
  if (!source.startsWith("./") && !source.startsWith("../")) return undefined
  const segments = filename.replaceAll("\\", "/").split("/").slice(0, -1)
  for (const part of source.split("/")) {
    if (part === "..") segments.pop()
    if (part !== ".." && part !== "." && part !== "") segments.push(part)
  }
  return segments.join("/")
}

/** The package an `@gent/...` specifier names: `@gent/core/protocol` → `@gent/core`. */
const WORKSPACE_PACKAGE = /^(@gent\/[a-z0-9-]+)(?:\/.*)?$/

/** A workspace package: its directory and every package name its manifest declares. */
interface Workspace {
  readonly dir: string
  readonly declared: ReadonlySet<string>
}

const MANIFEST_FIELDS = ["dependencies", "devDependencies", "peerDependencies"]

/**
 * The workspace a manifest describes, or undefined for the repository root: a
 * manifest with `workspaces` owns no source of its own.
 */
const workspaceOf = (dir: string, manifest: unknown): Workspace | undefined => {
  if (!isRecord(manifest) || "workspaces" in manifest) return undefined
  const declared = new Set<string>()
  if (typeof manifest["name"] === "string") declared.add(manifest["name"])
  for (const field of MANIFEST_FIELDS) {
    const entries = manifest[field]
    if (isRecord(entries)) for (const name of Object.keys(entries)) declared.add(name)
  }
  return { dir, declared }
}

/** Nearest manifest per directory, shared by every file one lint run reads. */
const workspaceByDir = new Map<string, Workspace | undefined>()

/** The workspace package that owns `dir`: the nearest `package.json` above it. */
const owningWorkspace = (dir: string): Workspace | undefined => {
  if (workspaceByDir.has(dir)) return workspaceByDir.get(dir)
  const manifestPath = join(dir, "package.json")
  const parent = dirname(dir)
  let owner: Workspace | undefined
  if (existsSync(manifestPath)) {
    // oxlint-disable-next-line effect/noGlobals -- the lint plugin runs in oxlint's Node host and reads a manifest it does not own
    owner = workspaceOf(dir, JSON.parse(readFileSync(manifestPath, "utf8")))
  } else if (parent !== dir) {
    owner = owningWorkspace(parent)
  }
  workspaceByDir.set(dir, owner)
  return owner
}

/** The module a `typeof import("x")` type names. */
const importTypeSourceOf = (node: AstNode): string | undefined => {
  const direct = importSourceOf(node)
  if (direct !== undefined) return direct
  const argument = getNodeField(node, "argument")
  const literal = argument === undefined ? undefined : getNodeField(argument, "literal")
  return literal === undefined ? undefined : getStringField(literal, "value")
}

/**
 * Core and shipped-extension source, outside the test harness: the code that
 * also takes its working directory and host modules through Effect services.
 * The TUI, the SDK and the server launcher are process hosts; they read their
 * own working directory.
 */
const protectedHostFactFilename = (subject: string): boolean =>
  /^packages\/(?:core|extensions)\/src\//.test(subject) && !/\/test-utils\//.test(subject)

/** The module a `require("x")` or `module.require("x")` call names. */
const requireSourceOf = (node: AstNode): string | undefined => {
  let callee = getNodeField(node, "callee")
  if (callee?.type === "MemberExpression") callee = getNodeField(callee, "property")
  if (callee?.type !== "Identifier" || getStringField(callee, "name") !== "require")
    return undefined
  const [arg] = getNodeArrayField(node, "arguments") ?? []
  if (arg === undefined) return undefined
  return getStringField(arg, "value")
}

/** `new URL(import.meta.url)`: the operand a hand-rolled file path reads `.pathname` from. */
const isImportMetaUrlConstruction = (node: AstNode | undefined): boolean => {
  if (node?.type !== "NewExpression") return false
  const callee = getNodeField(node, "callee")
  if (callee?.type !== "Identifier" || getStringField(callee, "name") !== "URL") return false
  const [arg] = getNodeArrayField(node, "arguments") ?? []
  if (arg?.type !== "MemberExpression") return false
  const meta = getNodeField(arg, "object")
  const property = getNodeField(arg, "property")
  return (
    meta?.type === "MetaProperty" &&
    property !== undefined &&
    getStringField(property, "name") === "url"
  )
}

/** The name a member expression reads when it is static: `b` for `a.b` and for `a["b"]`. */
const staticMemberName = (node: AstNode): string | undefined => {
  const property = getNodeField(node, "property")
  if (property === undefined) return undefined
  if (fieldOf(node, "computed") !== true) return getStringField(property, "name")
  const value = fieldOf(property, "value")
  return typeof value === "string" ? value : undefined
}

/** `Bun`, `globalThis.Bun` or `globalThis["Bun"]`. */
const isBunValue = (node: AstNode | undefined): boolean => {
  if (node?.type === "Identifier") return getStringField(node, "name") === "Bun"
  if (node?.type !== "MemberExpression" || staticMemberName(node) !== "Bun") return false
  const object = getNodeField(node, "object")
  return object?.type === "Identifier" && getStringField(object, "name") === "globalThis"
}

/** The `Bun` members retired everywhere, and their replacements. */
const RETIRED_BUN_MEMBERS: ReadonlyMap<string, string> = new Map([
  ["Glob", "`Bun.Glob` is retired; list files through Effect `FileSystem`."],
  ["randomUUIDv7", "`Bun.randomUUIDv7` is adapter-only; use `GentPlatform.randomId`."],
])

const callExpressionArgs = (node: AstNode): ReadonlyArray<AstNode> => {
  const args = fieldOf(node, "arguments")
  if (!Array.isArray(args)) return []
  return args.filter(isAstNode)
}

/**
 * The dotted text of a name: `Option.none` for a member expression,
 * `Schema.Schema.Type` for a qualified type name. Anything else, a computed
 * member included, has none.
 */
const dottedName = (node: AstNode | undefined): string | undefined => {
  if (node === undefined) return undefined
  if (node.type === "Identifier") return getStringField(node, "name")
  const joined = (left: AstNode | undefined, right: AstNode | undefined) => {
    const head = dottedName(left)
    const tail = right === undefined ? undefined : getStringField(right, "name")
    return head === undefined || tail === undefined ? undefined : `${head}.${tail}`
  }
  if (node.type === "TSQualifiedName") {
    return joined(getNodeField(node, "left"), getNodeField(node, "right"))
  }
  if (node.type === "MemberExpression" && fieldOf(node, "computed") !== true) {
    return joined(getNodeField(node, "object"), getNodeField(node, "property"))
  }
  return undefined
}

// ── a whole-object encode decides no identity ───────────────────────────────

/**
 * Name segments that say a value answers "is this the same thing?". A name is
 * split at camelCase and `_` boundaries, so `messageIdentity`, `dedupeKey`
 * and `cache_key` all count.
 */
const IDENTITY_WORDS: ReadonlySet<string> = new Set([
  "fingerprint",
  "identity",
  "signature",
  "dedupe",
  "dedup",
  "key",
])

const namesIdentity = (name: string): boolean =>
  name.split(/(?=[A-Z])|_/).some((segment) => IDENTITY_WORDS.has(segment.toLowerCase()))

/** Schemas whose encoded JSON has no keys of its own to order. */
const STABLE_LEAF_SCHEMAS = new Set([
  "Schema.String",
  "Schema.NonEmptyString",
  "Schema.Number",
  "Schema.Finite",
  "Schema.Int",
  "Schema.Boolean",
  "Schema.BigInt",
  "Schema.Null",
  "Schema.Undefined",
])

/** Schemas that write their one argument's encoding, or an array of it. */
const STABLE_WRAPPER_SCHEMAS = new Set([
  "Schema.optional",
  "Schema.optionalKey",
  "Schema.NullOr",
  "Schema.UndefinedOr",
  "Schema.NullishOr",
  "Schema.Array",
  "Schema.NonEmptyArray",
])

/** Schemas that take an array of member schemas. */
const STABLE_LIST_SCHEMAS = new Set(["Schema.Tuple", "Schema.Union"])

/**
 * Whether the schema written at `node` encodes every key in its own order:
 * a primitive, a literal, or an in-place struct, tuple, union, array or
 * optional of such schemas. A named schema, `Schema.Unknown`, a record or
 * a struct with a spread or a computed key is open: its keys come in the
 * value's order.
 */
const encodesStably = (node: AstNode | undefined): boolean => {
  if (node === undefined) return false
  if (node.type !== "CallExpression") return STABLE_LEAF_SCHEMAS.has(dottedName(node) ?? "")
  const callee = dottedName(getNodeField(node, "callee")) ?? ""
  const args = callExpressionArgs(node)
  if (callee === "Schema.Literal" || callee === "Schema.Literals") return true
  if (STABLE_WRAPPER_SCHEMAS.has(callee)) return args.length === 1 && encodesStably(args[0])
  const [members] = args
  if (STABLE_LIST_SCHEMAS.has(callee)) {
    return (
      members?.type === "ArrayExpression" &&
      (getNodeArrayField(members, "elements") ?? []).every(encodesStably)
    )
  }
  if (callee !== "Schema.Struct" || members?.type !== "ObjectExpression") return false
  return (getNodeArrayField(members, "properties") ?? []).every(
    (property) =>
      property.type === "Property" &&
      fieldOf(property, "computed") !== true &&
      encodesStably(getNodeField(property, "value")),
  )
}

/**
 * `Schema.encodeSync(Schema.fromJsonString(schema))`: an encoder of a whole
 * value to JSON. A schema written in place whose every key encodes in the
 * schema's own order, whatever the value's key order, is not one.
 */
const isJsonEncoder = (node: AstNode | undefined): boolean => {
  if (node?.type !== "CallExpression") return false
  if (dottedName(getNodeField(node, "callee")) !== "Schema.encodeSync") return false
  const [json] = callExpressionArgs(node)
  if (json?.type !== "CallExpression") return false
  if (dottedName(getNodeField(json, "callee")) !== "Schema.fromJsonString") return false
  const [schema] = callExpressionArgs(json)
  return !encodesStably(schema)
}

/** A `…Fingerprint(...)` call, which returns its fields in a fixed order. */
const isFingerprintCall = (node: AstNode): boolean =>
  node.type === "CallExpression" &&
  /^[a-z][\w$]*Fingerprint$/.test(dottedName(getNodeField(node, "callee")) ?? "")

/** A field access such as `call.id` or `call?.id`, rooted at a name. */
const isFieldAccess = (node: AstNode): boolean => {
  const access = node.type === "ChainExpression" ? getNodeField(node, "expression") : node
  return access?.type === "MemberExpression" && dottedName(access) !== undefined
}

/** A literal, a negative number, or `undefined`. */
const isPrimitive = (node: AstNode): boolean => {
  if (node.type === "Literal") return true
  if (node.type === "Identifier") return getStringField(node, "name") === "undefined"
  return (
    node.type === "UnaryExpression" &&
    getStringField(node, "operator") === "-" &&
    getNodeField(node, "argument")?.type === "Literal"
  )
}

/**
 * Whether an encoded value already names its fields in a fixed order: a
 * fingerprint call, or an array literal of field accesses, primitives and
 * fingerprint calls. `[item]` still carries a whole object.
 */
const isFixedOrder = (node: AstNode | undefined): boolean => {
  if (node === undefined) return false
  if (isFingerprintCall(node)) return true
  if (node.type !== "ArrayExpression") return false
  const elements = getNodeArrayField(node, "elements") ?? []
  return (
    elements.length > 0 &&
    elements.every(
      (element) => isFieldAccess(element) || isPrimitive(element) || isFingerprintCall(element),
    )
  )
}

const COMPARISON_OPERATORS = new Set(["===", "!==", "==", "!="])
const COLLECTION_LOOKUPS = new Set(["has", "get", "add"])

/** The method a call names: `add` for `seen.add(x)`. */
const methodName = (callee: AstNode | undefined): string | undefined => {
  if (callee?.type !== "MemberExpression") return undefined
  const property = getNodeField(callee, "property")
  return property === undefined ? undefined : getStringField(property, "name")
}

/** The name a binding, a property or an assignment gives the value under it. */
const bindingName = (node: AstNode): string | undefined => {
  if (node.type === "VariableDeclarator") return dottedName(getNodeField(node, "id"))
  if (node.type === "Property" || node.type === "PropertyDefinition") {
    return dottedName(getNodeField(node, "key"))
  }
  if (node.type !== "AssignmentExpression") return undefined
  const target = getNodeField(node, "left")
  if (target?.type === "MemberExpression") return methodName(target)
  return dottedName(target)
}

/**
 * Whether the value the encode `call` produces decides identity: it is
 * compared, looked up or collected where it is produced, or a binding it
 * sits under in its statement has a name that says identity.
 */
const decidesIdentity = (call: AstNode): boolean => {
  const parent = getNodeField(call, "parent")
  if (
    parent?.type === "BinaryExpression" &&
    COMPARISON_OPERATORS.has(getStringField(parent, "operator") ?? "")
  ) {
    return true
  }
  if (
    parent?.type === "CallExpression" &&
    callExpressionArgs(parent).includes(call) &&
    COLLECTION_LOOKUPS.has(methodName(getNodeField(parent, "callee")) ?? "")
  ) {
    return true
  }
  let node = parent
  while (node !== undefined && !/(?:Statement|Program)$/.test(node.type)) {
    if (namesIdentity(bindingName(node) ?? "")) return true
    node = getNodeField(node, "parent")
  }
  return false
}

const plugin: Plugin = {
  meta: {
    name: "gent",
  },
  rules: {
    /**
     * States who may read which `@gent/core` entry point.
     *
     * Core exposes one entry per audience: `extensions/api` and
     * `extensions/branch-tools` for extensions, `protocol` for clients,
     * `host` for the processes that compose a server, and `test-utils` for
     * tests. Two boundaries follow:
     *
     * - An extension (`packages/extensions/src/`, `packages/core/src/extensions/`,
     *   `examples/extensions/`, and the TUI's `apps/tui/src/extensions/`) reads
     *   only the two authoring entries; a TUI client extension also reads
     *   `protocol`. A shipped extension is never more privileged than a user
     *   extension, so `host`, `test-utils`, any other `@gent/core` path, and a
     *   relative path that resolves into `packages/core/src/` are all rejected.
     * - Product code (anything that is not a test file, `packages/e2e/`, or the
     *   harness in `packages/core/src/test-utils/`) never reads `test-utils`,
     *   by package specifier or by a relative path that resolves into it.
     * - Nothing outside `packages/core/`, tests included, reads core source by
     *   a relative path; it goes through the entry that publishes the name.
     * - The TUI host (`apps/tui/src/` outside `extensions/`) never reads
     *   `@gent/extensions`. One extension's view belongs in its client
     *   extension, which reaches the TUI only through `@gent/tui/extensions`,
     *   as a user extension does: a TUI client extension (`*.client.*`)
     *   names no TUI module by relative path, and the `builtins.tsx` roster
     *   names only its sibling client extensions.
     *
     * Every module form counts: `import`, `export ... from`, `import(...)`
     * and `typeof import(...)`.
     *
     * Exempt: the two authoring entries themselves, which assemble the public
     * API from core internals, and the TUI's client extension loader, which is
     * host code that reads the user's disabled list and trust settings.
     */
    "core-entry-boundary": {
      create(context) {
        const filename = context.filename
        const extensionFile = isExtensionFilename(filename)
        const productFile = !isTestSupport(ruleSubject(context))
        const outsideCore = !/\/packages\/core\//.test(filename)
        if (!extensionFile && !productFile && !outsideCore) return {}
        const tuiExtension = filename.includes("apps/tui/src/extensions/")
        const tuiHost = !tuiExtension && productFile && filename.includes("/apps/tui/src/")
        const tuiClientExtension = TUI_CLIENT_EXTENSION_FILE.test(filename)
        const tuiClientRoster = TUI_CLIENT_ROSTER_FILE.test(filename)

        const extensionMessage = (
          source: string,
          resolved: string | undefined,
        ): string | undefined => {
          if (resolved !== undefined && CORE_SOURCE_PATH.test(resolved)) {
            return `Extensions must import from "@gent/core/extensions/api", not core source by relative path. Forbidden: "${source}"`
          }
          if (!source.startsWith("@gent/core/")) return undefined
          if (AUTHORING_ENTRY.test(source)) return undefined
          if (tuiExtension && PROTOCOL_ENTRY.test(source)) return undefined
          return `Extensions must import from "@gent/core/extensions/api" or "@gent/core/extensions/branch-tools". Forbidden: "${source}"`
        }

        /** A client extension names no TUI module by path; the roster names only its siblings. */
        const clientExtensionMessage = (
          source: string,
          resolved: string | undefined,
        ): string | undefined => {
          if (!tuiClientExtension || resolved === undefined) return undefined
          if (tuiClientRoster && TUI_CLIENT_EXTENSION_MODULE.test(resolved)) return undefined
          return `A client extension reaches the TUI through "@gent/tui/extensions", as a user extension does; only the builtin roster names a sibling client extension by relative path. Forbidden: "${source}"`
        }

        const report = (node: AstNode, source: string | undefined) => {
          if (source === undefined) return
          const resolved = resolvedRelativeSource(filename, source)
          const readsTestUtils =
            TEST_UTILS_ENTRY.test(source) ||
            (resolved !== undefined && TEST_UTILS_PATH.test(resolved))
          let message: string | undefined
          if (extensionFile) message = extensionMessage(source, resolved)
          if (message === undefined && productFile && readsTestUtils) {
            message = `Product code must not import the test entry. Forbidden: "${source}"`
          }
          if (
            message === undefined &&
            outsideCore &&
            resolved !== undefined &&
            CORE_SOURCE_PATH.test(resolved)
          ) {
            message = `Code outside core reads it through "@gent/core/<entry>", not its source. Forbidden: "${source}"`
          }
          if (message === undefined) message = clientExtensionMessage(source, resolved)
          if (message === undefined && tuiHost && EXTENSIONS_PACKAGE.test(source)) {
            message = `The TUI host reads no extension module; move the view into a client extension under apps/tui/src/extensions/. Forbidden: "${source}"`
          }
          if (message !== undefined) context.report({ message, node })
        }
        const reportSource = (node: AstNode) => report(node, importSourceOf(node))

        return {
          ImportDeclaration: reportSource,
          ExportNamedDeclaration: reportSource,
          ExportAllDeclaration: reportSource,
          ImportExpression: reportSource,
          TSImportType: (node) => report(node, importTypeSourceOf(node)),
        }
      },
    },

    /**
     * A workspace package imports only the workspace packages its manifest
     * declares, and never reaches across its own root with a relative path.
     *
     * Turbo orders and caches tasks by the declared graph, so an undeclared
     * edge lets a cached typecheck replay green after the imported package
     * broke it. Core's test harness once called `@gent/sdk`, which depends on
     * core: a cycle no manifest showed. A relative path into another
     * workspace is the same edge without a name.
     *
     * The owner is the nearest `package.json` above the file. A file whose
     * nearest manifest is the repository root (it carries `workspaces`) is in
     * no workspace and is not read. Every module form counts: `import`,
     * `export ... from`, `import(...)`, `typeof import(...)` and `require(...)`.
     */
    "declared-workspace-imports": {
      create(context) {
        const filename = context.filename.replaceAll("\\", "/")
        const workspace = owningWorkspace(dirname(filename))
        if (workspace === undefined) return {}
        const report = (node: AstNode, source: string | undefined) => {
          if (source === undefined) return
          const resolved = resolvedRelativeSource(filename, source)
          if (resolved !== undefined) {
            if (resolved.startsWith(`${workspace.dir}/`)) return
            context.report({
              message: `reaches \`${source}\` across its workspace root; import a declared package entry instead`,
              node,
            })
            return
          }
          const imported = WORKSPACE_PACKAGE.exec(source)?.[1]
          if (imported === undefined || workspace.declared.has(imported)) return
          context.report({
            message: `imports \`${imported}\`, which its package.json does not declare; declare it without a cycle, or move the code to a package that does`,
            node,
          })
        }
        const reportSource = (node: AstNode) => report(node, importSourceOf(node))
        return {
          ImportDeclaration: reportSource,
          ExportNamedDeclaration: reportSource,
          ExportAllDeclaration: reportSource,
          ImportExpression: reportSource,
          TSImportType: (node) => report(node, importTypeSourceOf(node)),
          CallExpression: (node) => report(node, requireSourceOf(node)),
        }
      },
    },

    /**
     * No module path hand-rolled off its own URL.
     *
     * In core and shipped-extension source outside `test-utils/`, a member
     * read off `new URL(import.meta.url)`, as `.pathname`, builds a file path
     * by hand; Effect `Path.fromFileUrl` reads it. The TUI, the SDK and the
     * server launcher are process hosts and read their own paths.
     * `effect/noGlobals` holds the host globals themselves, through
     * `globalThis` and computed members too.
     */
    "no-hand-rolled-module-path": {
      create(context) {
        if (!protectedHostFactFilename(ruleSubject(context))) return {}
        return {
          MemberExpression(node) {
            if (!isAstNode(node) || !isImportMetaUrlConstruction(getNodeField(node, "object"))) {
              return
            }
            context.report({
              message:
                "`new URL(import.meta.url)` read as a path is hand-rolled; use Effect `Path.fromFileUrl`.",
              node,
            })
          },
        }
      },
    },

    /**
     * No retired `Bun` member in a file that turns `effect/noGlobals` off.
     *
     * The built-in bans of `effect/noGlobals` hold `Bun.Glob` and
     * `Bun.randomUUIDv7` in every spelling, but a plain Bun script (the gamut
     * driver, the capture preload) turns that rule off, and its `members`
     * option only adds bans to the built-in list. `.oxlintrc.json` enables
     * this rule in those overrides: `Bun.Glob`, `Bun["Glob"]`,
     * `globalThis.Bun.Glob` and `globalThis["Bun"].Glob` are reported, as is
     * each spelling of `randomUUIDv7`.
     */
    "no-retired-bun-member": {
      create(context) {
        return {
          MemberExpression(node) {
            if (!isAstNode(node)) return
            const member = staticMemberName(node)
            if (member === undefined || !RETIRED_BUN_MEMBERS.has(member)) return
            if (!isBunValue(getNodeField(node, "object"))) return
            context.report({ message: RETIRED_BUN_MEMBERS.get(member) ?? member, node })
          },
        }
      },
    },

    /**
     * Every child-session writer in core admits the nesting depth.
     *
     * `DEFAULT_MAX_AGENT_RUN_DEPTH` is enforced in one place,
     * `admitChildSessionDepth` (`packages/core/src/runtime/session.ts`). A
     * `new Session({ ... parentSessionId ... })` row is a child-session
     * writer, and a writer that skips the admission nests sessions without
     * bound.
     *
     * What is required: before the write, the writer's innermost enclosing
     * function -- a declaration, a function expression, an arrow, or a method
     * -- calls `admitChildSessionDepth`, or calls a same-file function whose
     * own body does (`admitParent` in `server.ts` checks the parent, then
     * admits). An admission in an outer function does not cover a writer in a
     * nested one: the nested function can run where the outer one never
     * admitted.
     *
     * Storage (rows rebuilt from the database) and the test harness (seeded
     * chains) are outside the rule; so is everything outside core.
     */
    "child-session-writer-admits": {
      create(context) {
        const subject = ruleSubject(context)
        if (!subject.startsWith("packages/core/src/")) return {}
        if (/^packages\/core\/src\/(?:storage|test-utils)\//.test(subject)) return {}

        const FUNCTION_TYPES = new Set([
          "FunctionDeclaration",
          "FunctionExpression",
          "ArrowFunctionExpression",
        ])
        /** The innermost function around `node`, or the program. */
        const innermostFunction = (node: AstNode): AstNode => {
          let at = getNodeField(node, "parent")
          let last = node
          while (at !== undefined) {
            if (FUNCTION_TYPES.has(at.type)) return at
            last = at
            at = getNodeField(at, "parent")
          }
          return last
        }
        /**
         * The name a function is bound to: its own name, or the variable its
         * wrapping calls initialise (`const admitParent = Effect.fn("x")(function* ...)`).
         */
        const boundName = (fn: AstNode): string | undefined => {
          const id = getNodeField(fn, "id")
          if (id?.type === "Identifier") return getStringField(id, "name")
          let at = getNodeField(fn, "parent")
          while (at?.type === "CallExpression") at = getNodeField(at, "parent")
          if (at?.type !== "VariableDeclarator") return undefined
          const variable = getNodeField(at, "id")
          return variable?.type === "Identifier" ? getStringField(variable, "name") : undefined
        }
        const namesParent = (literal: AstNode | undefined): boolean =>
          literal?.type === "ObjectExpression" &&
          (getNodeArrayField(literal, "properties") ?? []).some((property) => {
            const key = getNodeField(property, "key")
            return (
              property.type === "Property" &&
              key?.type === "Identifier" &&
              getStringField(key, "name") === "parentSessionId"
            )
          })

        const calls: Array<{ readonly node: AstNode; readonly name: string }> = []
        const writers: Array<AstNode> = []
        return {
          CallExpression(node) {
            if (!isAstNode(node)) return
            const callee = getNodeField(node, "callee")
            if (callee?.type !== "Identifier") return
            const name = getStringField(callee, "name")
            if (name !== undefined) calls.push({ node, name })
          },
          NewExpression(node) {
            if (!isAstNode(node)) return
            const callee = getNodeField(node, "callee")
            if (callee?.type !== "Identifier" || getStringField(callee, "name") !== "Session")
              return
            if (namesParent(callExpressionArgs(node)[0])) writers.push(node)
          },
          "Program:exit"() {
            const admitting = new Set(["admitChildSessionDepth"])
            let grew = true
            while (grew) {
              grew = false
              for (const call of calls) {
                if (!admitting.has(call.name)) continue
                const name = boundName(innermostFunction(call.node))
                if (name === undefined || admitting.has(name)) continue
                admitting.add(name)
                grew = true
              }
            }
            for (const writer of writers) {
              const scope = innermostFunction(writer)
              const admitted = calls.some(
                (call) =>
                  admitting.has(call.name) &&
                  call.node.range[0] < writer.range[0] &&
                  innermostFunction(call.node) === scope,
              )
              if (admitted) continue
              context.report({
                message:
                  "A child-session writer must admit the nesting depth: call `admitChildSessionDepth` (or a same-file function that does) in the writer's own function, before the write. An admission in an outer function does not cover a nested one.",
                node: writer,
              })
            }
          },
        }
      },
    },

    /**
     * A whole-object JSON encode decides no identity.
     *
     * JSON carries key order, so two spellings of one value encode to two
     * strings: a message built `_tag` first by a streaming placeholder and
     * `_tag` last by a rebuild reads as two messages. So a value encoded by
     * `Schema.encodeSync(Schema.fromJsonString(...))`, through a bound
     * encoder or one called where it is built, and of any schema but a
     * `Schema.Struct` written in place, is reported when it is
     * compared (`===`, `!==`), looked up or collected (`.has`, `.get`,
     * `.add`) where it is produced, or bound under a name that says identity
     * (`fingerprint`, `identity`, `signature`, `dedupe`, `key`). Encode the
     * compared fields in a fixed order instead: a `…Fingerprint(...)` call,
     * or an array of field accesses, primitives and fingerprint calls. An
     * encode for a log line, a file or a display string decides nothing.
     *
     * Shipped source only: a test may compare whole encodes.
     */
    "no-identity-encode": {
      create(context) {
        if (!isShippedSource(ruleSubject(context))) return {}
        const encoders = new Set<string>()
        const calls: Array<AstNode> = []
        return {
          VariableDeclarator(node) {
            if (!isAstNode(node) || !isJsonEncoder(getNodeField(node, "init"))) return
            const name = dottedName(getNodeField(node, "id"))
            if (name !== undefined) encoders.add(name)
          },
          CallExpression(node) {
            if (isAstNode(node)) calls.push(node)
          },
          "Program:exit"() {
            for (const call of calls) {
              const callee = getNodeField(call, "callee")
              const name = dottedName(callee)
              const encodes = isJsonEncoder(callee) || (name !== undefined && encoders.has(name))
              if (!encodes) continue
              const [value] = callExpressionArgs(call)
              if (isFixedOrder(value) || !decidesIdentity(call)) continue
              context.report({
                message: `\`${name ?? "Schema.encodeSync(Schema.fromJsonString(...))"}\` encodes a whole object and the result decides identity here; JSON carries key order, so two spellings of one value compare unequal -- name the compared fields in a fixed order instead`,
                node: call,
              })
            }
          },
        }
      },
    },
  },
}

export default plugin
