/**
 * Oxlint JS plugin: gent's own rules, one line each. Each rule's doc comment
 * below states it in full. A generic Effect rule lives in oxlint-plugin-effect;
 * a rule here is gent's own, or holds a line upstream does not hold yet and
 * names the upstream change that retires it.
 *
 * - core-entry-boundary: extensions read only the authoring entries of `@gent/core`.
 * - declared-workspace-imports: a package imports only the workspace packages it declares.
 * - child-session-writer-admits: a core child-session writer admits the nesting depth first.
 * - no-identity-encode: a whole-object JSON encode decides no identity.
 * - no-tracked-session-record: a TUI reactive scope tracks the session identity, not the record.
 * - no-code-unit-padding: terminal columns use display width, with ASCII-only exemptions.
 * - no-code-unit-text-edit: TUI text is edited, cut and counted by grapheme.
 * - one-reply-writer: a late TUI reply writes through `repliesInView`, not a counter.
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Context, ESTree, Plugin, Range, Variable } from "@oxlint/plugins"

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
  if (/^packages\/core\/src\/extensions\/(?:api|branch-tools)\.ts$/.test(filename)) return false
  if (filename === "apps/tui/src/extensions/loader-boundary.ts") return false
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

const callExpressionArgs = (node: AstNode): ReadonlyArray<AstNode> => {
  const args = fieldOf(node, "arguments")
  if (!Array.isArray(args)) return []
  return args.filter(isAstNode)
}

/** The nearest lexical binding of an identifier, including import aliases. */
const lexicalBinding = (context: Context, node: AstNode | undefined): Variable | undefined => {
  const identifier = (value: AstNode): value is ESTree.IdentifierReference =>
    value.type === "Identifier"
  if (node === undefined || !identifier(node)) return undefined
  let scope: ReturnType<typeof context.sourceCode.getScope> | null =
    context.sourceCode.getScope(node)
  while (scope !== null) {
    const binding = scope.set.get(node.name)
    if (binding !== undefined) return binding
    scope = scope.upper
  }
  return undefined
}

/** The original named import and its module, never a shadowing local name. */
const importedSymbol = (context: Context, node: AstNode | undefined) => {
  const binding = lexicalBinding(context, node)
  for (const definition of binding?.defs ?? []) {
    if (definition.type !== "ImportBinding" || definition.node.type !== "ImportSpecifier") continue
    const imported = getNodeField(definition.node, "imported")
    const name =
      imported === undefined
        ? undefined
        : (getStringField(imported, "name") ?? getStringField(imported, "value"))
    const source = definition.parent === null ? undefined : importSourceOf(definition.parent)
    if (name !== undefined && source !== undefined) {
      return { name, source: resolvedRelativeSource(context.filename, source) ?? source }
    }
  }
  return undefined
}

/** Function-name definitions, distinct from parameters with the same spelling. */
const declaredFunctionBindings = (context: Context, node: AstNode): ReadonlyArray<Variable> => {
  const fn = (value: AstNode): value is ESTree.Function =>
    value.type === "FunctionDeclaration" || value.type === "FunctionExpression"
  if (!fn(node)) return []
  return context.sourceCode
    .getDeclaredVariables(node)
    .filter((binding) =>
      binding.defs.some(
        (definition) => definition.type === "FunctionName" && definition.node === node,
      ),
    )
}

/** An ordinary or statically computed string property name. */
const staticPropertyName = (node: AstNode): string | undefined => {
  const property = getNodeField(node, node.type === "MemberExpression" ? "property" : "key")
  if (property === undefined) return undefined
  if (fieldOf(node, "computed") !== true && property.type === "Identifier")
    return getStringField(property, "name")
  return getStringField(property, "value")
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

/** `effect/Schema` exports whose encoded JSON has no keys of its own to order. */
const STABLE_LEAF_SCHEMAS = new Set([
  "String",
  "NonEmptyString",
  "Number",
  "Finite",
  "Int",
  "Boolean",
  "BigInt",
  "Null",
  "Undefined",
])

/** `effect/Schema` exports that write their one argument's encoding, or an array of it. */
const STABLE_WRAPPER_SCHEMAS = new Set([
  "optional",
  "optionalKey",
  "NullOr",
  "UndefinedOr",
  "NullishOr",
  "Array",
  "NonEmptyArray",
])

/** `effect/Schema` exports that take an array of member schemas. */
const STABLE_LIST_SCHEMAS = new Set(["Tuple", "Union"])

/**
 * The `effect/Schema` export a name or member reaches through its import:
 * `Schema.x` or `S.x` for `Schema` imported from `effect` under any name,
 * `NS.x` for a namespace import of `effect/Schema`, and `x` for a named
 * import from it. A local that only shares the spelling reaches none.
 */
const schemaExport = (context: Context, node: AstNode | undefined): string | undefined => {
  if (node === undefined) return undefined
  if (node.type === "Identifier") {
    const imported = importedSymbol(context, node)
    return imported?.source === "effect/Schema" ? imported.name : undefined
  }
  if (node.type !== "MemberExpression") return undefined
  const object = getNodeField(node, "object")
  const imported = importedSymbol(context, object)
  const namespace = lexicalBinding(context, object)?.defs.some(
    (definition) =>
      definition.type === "ImportBinding" &&
      definition.node.type === "ImportNamespaceSpecifier" &&
      definition.parent !== null &&
      importSourceOf(definition.parent) === "effect/Schema",
  )
  if (namespace === true || (imported?.source === "effect" && imported.name === "Schema"))
    return staticPropertyName(node)
  return undefined
}

/**
 * Whether the schema written at `node` encodes every key in its own order:
 * a primitive, a literal, or an in-place struct, tuple, union, array or
 * optional of such schemas. A named schema, `Schema.Unknown`, a record or
 * a struct with a spread or a computed key is open: its keys come in the
 * value's order.
 */
const encodesStably = (context: Context, node: AstNode | undefined): boolean => {
  if (node === undefined) return false
  if (node.type !== "CallExpression")
    return STABLE_LEAF_SCHEMAS.has(schemaExport(context, node) ?? "")
  const callee = schemaExport(context, getNodeField(node, "callee")) ?? ""
  const args = callExpressionArgs(node)
  const stable = (member: AstNode | undefined) => encodesStably(context, member)
  if (callee === "Literal" || callee === "Literals") return true
  if (STABLE_WRAPPER_SCHEMAS.has(callee)) return args.length === 1 && stable(args[0])
  const [members] = args
  if (STABLE_LIST_SCHEMAS.has(callee)) {
    return (
      members?.type === "ArrayExpression" &&
      (getNodeArrayField(members, "elements") ?? []).every(stable)
    )
  }
  if (callee !== "Struct" || members?.type !== "ObjectExpression") return false
  return (getNodeArrayField(members, "properties") ?? []).every(
    (property) =>
      property.type === "Property" &&
      fieldOf(property, "computed") !== true &&
      stable(getNodeField(property, "value")),
  )
}

/**
 * `Schema.encodeSync(Schema.fromJsonString(schema))`, under any import of
 * `effect/Schema`: an encoder of a whole value to JSON. A schema written in
 * place whose every key encodes in the schema's own order, whatever the
 * value's key order, is not one.
 */
const isJsonEncoder = (context: Context, node: AstNode | undefined): boolean => {
  if (node?.type !== "CallExpression") return false
  if (schemaExport(context, getNodeField(node, "callee")) !== "encodeSync") return false
  const [json] = callExpressionArgs(node)
  if (json?.type !== "CallExpression") return false
  if (schemaExport(context, getNodeField(json, "callee")) !== "fromJsonString") return false
  const [schema] = callExpressionArgs(json)
  return !encodesStably(context, schema)
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
    "no-code-unit-padding": {
      meta: { type: "problem", schema: [] },
      create(context) {
        const printableAscii = (node: AstNode | undefined): boolean => {
          const value = node === undefined ? undefined : getStringField(node, "value")
          return value !== undefined && /^[\x20-\x7e]*$/.test(value)
        }
        const globalName = (node: AstNode, name: string): boolean => {
          const identifier = (value: AstNode): value is ESTree.IdentifierReference =>
            value.type === "Identifier"
          if (!identifier(node) || node.name !== name) return false
          let scope: ReturnType<typeof context.sourceCode.getScope> | null =
            context.sourceCode.getScope(node)
          while (scope !== null) {
            const variable = scope.set.get(name)
            if (variable !== undefined && variable.defs.length > 0) return false
            scope = scope.upper
          }
          return true
        }
        const numeric = (node: AstNode | undefined): boolean => {
          if (node === undefined) return false
          if (node.type === "ParenthesizedExpression")
            return numeric(getNodeField(node, "expression"))
          if (node.type === "Literal") return typeof fieldOf(node, "value") === "number"
          if (node.type === "BinaryExpression") {
            const operator = getStringField(node, "operator") ?? ""
            if (["-", "*", "/", "%", "**", "&", "|", "^", "<<", ">>", ">>>"].includes(operator))
              return true
            return (
              operator === "+" &&
              numeric(getNodeField(node, "left")) &&
              numeric(getNodeField(node, "right"))
            )
          }
          if (node.type === "UnaryExpression")
            return ["+", "-", "~"].includes(getStringField(node, "operator") ?? "")
          if (node.type !== "CallExpression") return false
          const callee = getNodeField(node, "callee")
          if (callee === undefined) return false
          if (globalName(callee, "Number")) return true
          if (callee.type !== "MemberExpression" || fieldOf(callee, "computed") === true)
            return false
          const object = getNodeField(callee, "object")
          const property = getNodeField(callee, "property")
          return (
            object !== undefined &&
            property !== undefined &&
            globalName(object, "Math") &&
            ["abs", "ceil", "floor", "max", "min", "round", "trunc"].includes(
              getStringField(property, "name") ?? "",
            )
          )
        }
        const asciiRendering = (node: AstNode | undefined): boolean => {
          if (node === undefined) return false
          if (printableAscii(node)) return true
          if (node.type === "ParenthesizedExpression")
            return asciiRendering(getNodeField(node, "expression"))
          if (node.type !== "CallExpression") return false
          const callee = getNodeField(node, "callee")
          if (callee === undefined) return false
          if (globalName(callee, "String")) {
            const [value] = callExpressionArgs(node)
            return numeric(value) || printableAscii(value)
          }
          if (callee.type !== "MemberExpression" || fieldOf(callee, "computed") === true)
            return false
          const property = getNodeField(callee, "property")
          return (
            property !== undefined &&
            ["toString", "toFixed", "toPrecision", "toExponential"].includes(
              getStringField(property, "name") ?? "",
            ) &&
            numeric(getNodeField(callee, "object"))
          )
        }
        return {
          MemberExpression(node) {
            if (!isAstNode(node)) return
            const property = getNodeField(node, "property")
            if (property === undefined) return
            const name = getStringField(
              property,
              fieldOf(node, "computed") === true ? "value" : "name",
            )
            if (name !== "padStart" && name !== "padEnd") return
            const call = getNodeField(node, "parent")
            const args =
              call?.type === "CallExpression" && getNodeField(call, "callee") === node
                ? callExpressionArgs(call)
                : []
            if (
              call?.type === "CallExpression" &&
              asciiRendering(getNodeField(node, "object")) &&
              (args.length === 1 || (args.length === 2 && printableAscii(args[1])))
            )
              return
            context.report({
              node,
              message: `${name} counts UTF-16 code units, not terminal columns; pad by display width. Only proven ASCII text with printable ASCII padding is safe.`,
            })
          },
        }
      },
    },
    /**
     * TUI text is edited, cut and counted by grapheme, the character a reader
     * sees, never by UTF-16 code unit or code point: either splits a toned
     * emoji, a flag or a ZWJ family, and Backspace leaves half of one behind.
     * The owners are `apps/tui/src/utils.ts` (`dropLastGrapheme`,
     * `headGraphemes`, `truncateStart`, `graphemeCount`) and `textWidth`
     * (`apps/tui/src/bun-adapter.ts`).
     *
     * What is reported, in `apps/tui/src/`, three shapes that are text by
     * syntax alone (the plugin has no types):
     *
     * - a code-point cut: `.slice` of `[...text]` or `Array.from(text)` with
     *   one element, directly or through a `const`, joined back with
     *   `.join("")`. A spread of `graphemes.segment(...)` holds graphemes, and
     *   a cut that is not joined to text may be any list; neither is reported.
     * - a code-unit backspace: `p.slice(0, -1)`, or `p.slice` / `p.substring`
     *   to `p.length - 1`, where `p` is a parameter of the function around it
     *   (an edit such as `(current) => current.slice(0, -1)`). A parameter
     *   annotated with a type other than `string` is not reported; a local
     *   array, a member and a call result are not either, since nothing here
     *   tells them from a string.
     * - a glyph per code unit: `"*".repeat(text.length)`, a string literal
     *   repeated exactly `<x>.length` times.
     *
     * Not reported: a fixed-count cut such as `value.slice(0, 500) + "…"`.
     * Its shape is the same for an ASCII id (`formatToolCallIdentity`) as for
     * typed text, so the owner helpers and the tests hold it.
     */
    "no-code-unit-text-edit": {
      meta: { type: "problem", schema: [] },
      create(context) {
        const subject = ruleSubject(context)
        if (!subject.startsWith("apps/tui/src/")) return {}
        const isGlobal = (node: AstNode | undefined, name: string): boolean =>
          node?.type === "Identifier" &&
          getStringField(node, "name") === name &&
          (lexicalBinding(context, node)?.defs.length ?? 0) === 0
        const segments = (node: AstNode | undefined): boolean =>
          node?.type === "CallExpression" && methodName(getNodeField(node, "callee")) === "segment"
        /** `[...text]` or `Array.from(text)`: the code points of one value. */
        const codePoints = (node: AstNode | undefined): boolean => {
          if (node?.type === "ArrayExpression") {
            const elements = getNodeArrayField(node, "elements") ?? []
            const [only] = elements
            return (
              elements.length === 1 &&
              only?.type === "SpreadElement" &&
              !segments(getNodeField(only, "argument"))
            )
          }
          if (node?.type !== "CallExpression") return false
          const callee = getNodeField(node, "callee")
          const args = callExpressionArgs(node)
          return (
            callee?.type === "MemberExpression" &&
            isGlobal(getNodeField(callee, "object"), "Array") &&
            staticPropertyName(callee) === "from" &&
            args.length === 1 &&
            !segments(args[0])
          )
        }
        /** The value a `const` name was built from, or the node itself. */
        const constInit = (node: AstNode | undefined): AstNode | undefined => {
          const definition = lexicalBinding(context, node)?.defs.find(
            (def) =>
              def.type === "Variable" &&
              def.parent !== null &&
              getStringField(def.parent, "kind") === "const",
          )
          return definition === undefined ? node : getNodeField(definition.node, "init")
        }
        /** A parameter of the function around it, typed `string` or not typed. */
        const textParameter = (node: AstNode | undefined): boolean => {
          if (node?.type !== "Identifier") return false
          return (
            lexicalBinding(context, node)?.defs.some((def) => {
              if (def.type !== "Parameter") return false
              const annotation = getNodeField(def.name, "typeAnnotation")
              const type =
                annotation === undefined ? undefined : getNodeField(annotation, "typeAnnotation")
              return type === undefined || type.type === "TSStringKeyword"
            }) === true
          )
        }
        const isNumber = (node: AstNode | undefined, value: number): boolean => {
          if (node?.type === "Literal") return fieldOf(node, "value") === value
          return (
            node?.type === "UnaryExpression" &&
            getStringField(node, "operator") === "-" &&
            isNumber(getNodeField(node, "argument"), -value)
          )
        }
        /** `0, -1`, or `0, p.length - 1` for the receiver `p`. */
        const dropsLast = (receiver: AstNode, args: ReadonlyArray<AstNode>): boolean => {
          const [start, end] = args
          if (args.length !== 2 || !isNumber(start, 0)) return false
          if (isNumber(end, -1)) return true
          const length = end === undefined ? undefined : getNodeField(end, "left")
          return (
            end?.type === "BinaryExpression" &&
            getStringField(end, "operator") === "-" &&
            isNumber(getNodeField(end, "right"), 1) &&
            length?.type === "MemberExpression" &&
            staticPropertyName(length) === "length" &&
            dottedName(getNodeField(length, "object")) === dottedName(receiver)
          )
        }
        /** The cut is joined back to text: `cut.join("")`. */
        const joinedToText = (call: AstNode): boolean => {
          const member = getNodeField(call, "parent")
          const join = member === undefined ? undefined : getNodeField(member, "parent")
          if (member?.type !== "MemberExpression" || join?.type !== "CallExpression") return false
          const [separator] = callExpressionArgs(join)
          return (
            staticPropertyName(member) === "join" &&
            getNodeField(join, "callee") === member &&
            separator?.type === "Literal" &&
            fieldOf(separator, "value") === ""
          )
        }
        /** `"*".repeat(text.length)`: a literal glyph once per code unit. */
        const glyphPerUnit = (receiver: AstNode, count: AstNode | undefined): boolean =>
          (receiver.type === "Literal" || receiver.type === "TemplateLiteral") &&
          count?.type === "MemberExpression" &&
          fieldOf(count, "computed") !== true &&
          staticPropertyName(count) === "length"
        const misreads = (call: AstNode, receiver: AstNode, method: string | undefined) => {
          const args = callExpressionArgs(call)
          if (method === "repeat" && glyphPerUnit(receiver, args[0]))
            return "repeats a glyph once per UTF-16 code unit; count the characters a reader sees with `graphemeCount` or the columns with `textWidth`"
          if (method === "slice" && codePoints(constInit(receiver)) && joinedToText(call))
            return "cuts text by code point, which splits a toned emoji, a flag or a ZWJ family; use `dropLastGrapheme`, `headGraphemes` or `truncateStart`"
          if (
            (method === "slice" || method === "substring") &&
            textParameter(receiver) &&
            dropsLast(receiver, args)
          )
            return "drops the last UTF-16 code unit, which leaves half a character behind; use `dropLastGrapheme` (or `eraseText`)"
          return undefined
        }
        return {
          CallExpression(node) {
            if (!isAstNode(node)) return
            const callee = getNodeField(node, "callee")
            if (callee?.type !== "MemberExpression" || fieldOf(callee, "computed") === true) return
            const receiver = getNodeField(callee, "object")
            if (receiver === undefined) return
            const message = misreads(node, receiver, staticPropertyName(callee))
            if (message !== undefined) context.report({ node, message })
          },
        }
      },
    },
    /**
     * A late reply in the TUI writes through the one reply writer,
     * `repliesInView` in `apps/tui/src/utils.ts`, never through a counter of
     * its own.
     *
     * A hand-rolled reply generation is a `let` counter that each read
     * increments and that a later callback compares with the number it
     * captured (`const own = ++navigation`, then `own !== navigation`). Each
     * copy answers "is this reply still in view" on its own, and about 22
     * fixes found a copy that missed a case the others had: a key the server
     * moved, a read that did not take a number. `repliesInView` answers it once,
     * for the newest read and the key in view.
     *
     * What is reported, in `apps/tui/src/` outside `utils.ts`: a `let` that is
     * incremented (`++x`, `x++`, `x += …`, `x = x + …`) and compared with
     * `===` or `!==` inside a function nested in the one that declares it.
     * A loop counter compared where it is declared is not reported.
     */
    "one-reply-writer": {
      meta: { type: "problem", schema: [] },
      create(context) {
        const subject = ruleSubject(context)
        if (!subject.startsWith("apps/tui/src/") || subject === "apps/tui/src/utils.ts") return {}
        const FUNCTION_TYPES = new Set([
          "FunctionDeclaration",
          "FunctionExpression",
          "ArrowFunctionExpression",
        ])
        const innermostFunction = (node: AstNode): AstNode | undefined => {
          let at = getNodeField(node, "parent")
          while (at !== undefined && !FUNCTION_TYPES.has(at.type)) at = getNodeField(at, "parent")
          return at
        }
        /** The binding of a `let` the identifier names. */
        const letBinding = (node: AstNode | undefined): Variable | undefined => {
          const binding = lexicalBinding(context, node)
          const isLet = binding?.defs.some(
            (def) =>
              def.type === "Variable" &&
              def.parent !== null &&
              getStringField(def.parent, "kind") === "let",
          )
          return isLet === true ? binding : undefined
        }
        const incremented = new Set<Variable>()
        const comparedLater = new Set<Variable>()
        const declaration = (binding: Variable): AstNode | undefined => binding.defs[0]?.node
        const compare = (node: AstNode, side: AstNode | undefined) => {
          const binding = letBinding(side)
          const declared = binding === undefined ? undefined : declaration(binding)
          if (binding === undefined || declared === undefined) return
          if (innermostFunction(node) !== innermostFunction(declared)) comparedLater.add(binding)
        }
        return {
          UpdateExpression(node) {
            if (!isAstNode(node) || getStringField(node, "operator") !== "++") return
            const binding = letBinding(getNodeField(node, "argument"))
            if (binding !== undefined) incremented.add(binding)
          },
          AssignmentExpression(node) {
            if (!isAstNode(node)) return
            const target = getNodeField(node, "left")
            const binding = letBinding(target)
            if (binding === undefined) return
            const operator = getStringField(node, "operator")
            const value = getNodeField(node, "right")
            const selfPlus =
              operator === "=" &&
              value?.type === "BinaryExpression" &&
              getStringField(value, "operator") === "+" &&
              lexicalBinding(context, getNodeField(value, "left")) === binding
            if (operator === "+=" || selfPlus) incremented.add(binding)
          },
          BinaryExpression(node) {
            if (!isAstNode(node)) return
            const operator = getStringField(node, "operator")
            if (operator !== "===" && operator !== "!==") return
            compare(node, getNodeField(node, "left"))
            compare(node, getNodeField(node, "right"))
          },
          "Program:exit"() {
            for (const binding of incremented) {
              const declared = declaration(binding)
              if (!comparedLater.has(binding) || declared === undefined) continue
              context.report({
                message: `\`${binding.name}\` is a hand-rolled reply generation: a later callback compares it with the number a read captured. Take a \`ReplyWriter\` from \`repliesInView\` (apps/tui/src/utils.ts), which drops a reply the view moved past`,
                node: declared,
              })
            }
          },
        }
      },
    },
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
        const extensionFile = isExtensionFilename(ruleSubject(context))
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
     * Every child-session writer in core admits the nesting depth.
     *
     * `DEFAULT_MAX_AGENT_RUN_DEPTH` is enforced in one place,
     * `admitChildSessionDepth` (`packages/core/src/runtime/session.ts`). A
     * `new Session({ ... parentSessionId ... })` row from the owning domain
     * module (including a renamed import or static string key) is a child-session
     * writer, and a writer that skips the admission nests sessions without
     * bound.
     *
     * What is required: before the write, the writer's innermost enclosing
     * function -- a declaration, a function expression, an arrow, or a method
     * -- calls `admitChildSessionDepth`, or calls a same-file function whose
     * own body does (`admitParent` in `server.ts` checks the parent, then
     * admits). Imported and same-file helpers are resolved by lexical binding;
     * a shadowing local name grants no admission. An admission in an outer
     * function does not cover a writer in a
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
         * A function's private name and the outer variable its wrapping calls
         * initialise (`const admitParent = Effect.fn("x")(function* ...)`).
         */
        const functionBindings = (fn: AstNode): ReadonlyArray<Variable> => {
          const bindings = [...declaredFunctionBindings(context, fn)]
          let at = getNodeField(fn, "parent")
          while (at?.type === "CallExpression") at = getNodeField(at, "parent")
          if (at?.type === "VariableDeclarator") {
            const outer = lexicalBinding(context, getNodeField(at, "id"))
            if (outer !== undefined && !bindings.includes(outer)) bindings.push(outer)
          }
          return bindings
        }
        const namesParent = (literal: AstNode | undefined): boolean =>
          literal?.type === "ObjectExpression" &&
          (getNodeArrayField(literal, "properties") ?? []).some(
            (property) =>
              property.type === "Property" && staticPropertyName(property) === "parentSessionId",
          )

        const calls: Array<{ readonly node: AstNode; readonly binding: Variable }> = []
        const admitting = new Set<Variable>()
        const writers: Array<AstNode> = []
        return {
          CallExpression(node) {
            if (!isAstNode(node)) return
            const callee = getNodeField(node, "callee")
            if (callee?.type !== "Identifier") return
            const binding = lexicalBinding(context, callee)
            if (binding === undefined) return
            calls.push({ node, binding })
            const imported = importedSymbol(context, callee)
            if (
              imported?.name === "admitChildSessionDepth" &&
              /\/packages\/core\/src\/runtime\/session(?:\.[cm]?[jt]s)?$/.test(imported.source)
            )
              admitting.add(binding)
          },
          NewExpression(node) {
            if (!isAstNode(node)) return
            const callee = getNodeField(node, "callee")
            const imported = importedSymbol(context, callee)
            if (
              imported?.name !== "Session" ||
              !/\/packages\/core\/src\/domain\/message(?:\.[cm]?[jt]s)?$/.test(imported.source)
            )
              return
            if (namesParent(callExpressionArgs(node)[0])) writers.push(node)
          },
          "Program:exit"() {
            let grew = true
            while (grew) {
              grew = false
              for (const call of calls) {
                if (!admitting.has(call.binding)) continue
                for (const binding of functionBindings(innermostFunction(call.node))) {
                  if (admitting.has(binding)) continue
                  admitting.add(binding)
                  grew = true
                }
              }
            }
            for (const writer of writers) {
              const scope = innermostFunction(writer)
              const admitted = calls.some(
                (call) =>
                  admitting.has(call.binding) &&
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
     * `Schema.encodeSync(Schema.fromJsonString(...))` (`Schema` from `effect` under
     * any name, or `effect/Schema` by namespace or named import), through a bound
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
        const encoders = new Set<Variable>()
        const calls: Array<AstNode> = []
        return {
          VariableDeclarator(node) {
            if (!isAstNode(node) || !isJsonEncoder(context, getNodeField(node, "init"))) return
            const binding = lexicalBinding(context, getNodeField(node, "id"))
            if (binding !== undefined) encoders.add(binding)
          },
          CallExpression(node) {
            if (isAstNode(node)) calls.push(node)
          },
          "Program:exit"() {
            for (const call of calls) {
              const callee = getNodeField(call, "callee")
              const name = dottedName(callee)
              const binding = lexicalBinding(context, callee)
              const encodes =
                isJsonEncoder(context, callee) || (binding !== undefined && encoders.has(binding))
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

    /**
     * A reactive scope in the TUI tracks the session identity, not the record.
     *
     * `transitionSessionState` rebuilds the `Session` object for `UpdateName`
     * and `UpdateSettings`, so a rename or a `/model` change hands every reader
     * a new object carrying the same ids. A scope that tracks the record
     * re-runs for a change it does not care about: a fiber it owns is
     * interrupted, the rows it projected are dropped and fetched again, and a
     * list it loads is empty while the RPC runs. The client answers "which
     * session" once, with `sessionIdentity()` and `activeSessionId()`, memos
     * with an equivalence on the ids.
     *
     * What is reported, in `apps/tui/src/`: a `.session()` call in a function
     * Solid tracks. Imported aliases and namespace calls resolve to their
     * original Solid primitive; unrelated local names confer no tracking.
     * Same-file functions and accessor aliases retain their lexical binding.
     * Solid tracks one position of each primitive
     * (`TRACKED_POSITIONS`): the body of `createEffect`, `createMemo`,
     * `createRenderEffect` and `createComputed`; the source of
     * `createResource(source, fetcher)`, not the fetcher, and nothing of
     * `createResource(fetcher)`. Immutable local options aliases resolve to
     * the untracked `createResource(fetcher, options)` overload; dynamic
     * values remain unknown. The deps of `on(deps, fn)`, one function or
     * each of an array, are tracked, not `fn`. A member call such as `emitter.on(` is a
     * listener, not Solid's `on`. The scope also runs a function called where
     * it is built, a callback an array method or `batch` runs at once
     * (`SYNC_CALLERS`), and a same-file function it names or calls. Any other
     * function it hands on -- to `untrack`, a listener, a scheduler, an
     * object's `onSelect`, a return -- runs later or untracked, and is not
     * followed. A name bound to a `.session` accessor (`const read =
     * client.session`) and called there is the same read. A read in a JSX
     * expression, an event handler or a plain accessor is untouched: those
     * want the record, and the name and the model live on it.
     * `transport.currentSession()` already answers with the identity alone.
     */
    "no-tracked-session-record": {
      create(context) {
        if (!/^apps\/tui\/src\//.test(ruleSubject(context))) return {}
        /** Solid's original primitive name, through a named or namespace import. */
        const solidPrimitive = (callee: AstNode | undefined): string | undefined => {
          const imported = importedSymbol(context, callee)
          if (imported?.source === "solid-js") return imported.name
          if (callee?.type !== "MemberExpression") return undefined
          const binding = lexicalBinding(context, getNodeField(callee, "object"))
          if (
            binding?.defs.some(
              (definition) =>
                definition.type === "ImportBinding" &&
                definition.node.type === "ImportNamespaceSpecifier" &&
                definition.parent !== null &&
                importSourceOf(definition.parent) === "solid-js",
            )
          )
            return staticPropertyName(callee)
          return undefined
        }
        /** Follow immutable local options aliases; dynamic values remain unknown. */
        const initializedValue = (node: AstNode | undefined): AstNode | undefined => {
          let at = node
          const seen = new Set<Variable>()
          while (at !== undefined) {
            if (
              [
                "TSAsExpression",
                "TSSatisfiesExpression",
                "TSNonNullExpression",
                "ParenthesizedExpression",
              ].includes(at.type)
            ) {
              at = getNodeField(at, "expression")
              continue
            }
            const binding = lexicalBinding(context, at)
            if (binding === undefined || seen.has(binding)) return at
            const definition = binding.defs.find(
              (definition) =>
                definition.type === "Variable" &&
                definition.node.type === "VariableDeclarator" &&
                getNodeField(definition.node, "id")?.type === "Identifier" &&
                definition.parent !== null &&
                getStringField(definition.parent, "kind") === "const",
            )
            if (definition === undefined) return at
            seen.add(binding)
            at = getNodeField(definition.node, "init")
          }
          return undefined
        }
        /** The arguments of a Solid primitive that Solid runs while it tracks. */
        const TRACKED_POSITIONS: ReadonlyMap<
          string,
          (args: ReadonlyArray<AstNode>) => ReadonlyArray<AstNode | undefined>
        > = new Map([
          ["createEffect", (args: ReadonlyArray<AstNode>) => [args[0]]],
          ["createMemo", (args: ReadonlyArray<AstNode>) => [args[0]]],
          ["createRenderEffect", (args: ReadonlyArray<AstNode>) => [args[0]]],
          ["createComputed", (args: ReadonlyArray<AstNode>) => [args[0]]],
          [
            "createResource",
            (args: ReadonlyArray<AstNode>) => {
              const fetcher = initializedValue(args[1])
              if (fetcher === undefined || fetcher.type === "ObjectExpression") return []
              if (
                fetcher.type === "Identifier" &&
                getStringField(fetcher, "name") === "undefined" &&
                (lexicalBinding(context, fetcher)?.defs.length ?? 0) === 0
              )
                return []
              return [args[0]]
            },
          ],
          [
            "on",
            (args: ReadonlyArray<AstNode>) => {
              const deps = args[0]
              if (deps?.type !== "ArrayExpression") return [deps]
              return getNodeArrayField(deps, "elements") ?? []
            },
          ],
        ])
        /** Calls that run a function argument at once, inside the caller's scope. */
        const SYNC_CALLERS = new Set([
          "every",
          "filter",
          "find",
          "findIndex",
          "findLast",
          "findLastIndex",
          "flatMap",
          "forEach",
          "from",
          "map",
          "reduce",
          "reduceRight",
          "some",
          "sort",
          "toSorted",
        ])
        const FUNCTION_TYPES = new Set([
          "FunctionDeclaration",
          "FunctionExpression",
          "ArrowFunctionExpression",
        ])
        /** Same-file functions and accessors, keyed by their lexical binding. */
        const named = new Map<Variable, AstNode>()
        const accessors = new Set<Variable>()
        /** Functions Solid tracks directly, and names handed to a tracker. */
        const tracked = new Set<AstNode>()
        const trackedNames: Array<Variable> = []
        /** Every call by name, for the functions a tracked one reaches. */
        const namedCalls: Array<{ readonly node: AstNode; readonly binding: Variable }> = []
        const reads: Array<AstNode> = []

        const isSessionMember = (node: AstNode | undefined): boolean => {
          if (node?.type !== "MemberExpression" || fieldOf(node, "computed") === true) return false
          const property = getNodeField(node, "property")
          return /^session$/i.test(
            property === undefined ? "" : (getStringField(property, "name") ?? ""),
          )
        }
        /** The name a call goes by: `f(` or the member of `x.f(`. */
        const calleeName = (call: AstNode): string | undefined => {
          const callee = getNodeField(call, "callee")
          if (callee?.type === "Identifier") return getStringField(callee, "name")
          if (callee?.type !== "MemberExpression" || fieldOf(callee, "computed") === true)
            return undefined
          const property = getNodeField(callee, "property")
          return property === undefined ? undefined : getStringField(property, "name")
        }
        /** Whether the enclosing call runs `fn` at once: `fn` is its callee, or a sync callback. */
        const runsAtOnce = (fn: AstNode): boolean => {
          const holder = getNodeField(fn, "parent")
          if (holder?.type !== "CallExpression") return false
          if (getNodeField(holder, "callee") === fn) return true
          if (solidPrimitive(getNodeField(holder, "callee")) === "batch") return true
          return SYNC_CALLERS.has(calleeName(holder) ?? "")
        }
        /**
         * The functions a node runs inside while its innermost one runs: up
         * through each function its caller runs at once, and no further than
         * the first function that runs later.
         */
        const runningFunctions = (node: AstNode): ReadonlyArray<AstNode> => {
          const found: Array<AstNode> = []
          let at = getNodeField(node, "parent")
          while (at !== undefined) {
            if (FUNCTION_TYPES.has(at.type)) {
              found.push(at)
              if (!runsAtOnce(at)) break
            }
            at = getNodeField(at, "parent")
          }
          return found
        }
        const bind = (id: AstNode | undefined, init: AstNode | undefined) => {
          const binding = lexicalBinding(context, id)
          if (binding === undefined || init === undefined) return
          if (FUNCTION_TYPES.has(init.type)) {
            named.set(binding, init)
            for (const inner of declaredFunctionBindings(context, init)) named.set(inner, init)
          }
          if (isSessionMember(init)) accessors.add(binding)
        }

        return {
          FunctionDeclaration(node) {
            for (const binding of declaredFunctionBindings(context, node)) named.set(binding, node)
          },
          VariableDeclarator(node) {
            if (!isAstNode(node)) return
            const id = getNodeField(node, "id")
            if (id?.type === "Identifier") bind(id, getNodeField(node, "init"))
          },
          CallExpression(node) {
            if (!isAstNode(node)) return
            const callee = getNodeField(node, "callee")
            if (isSessionMember(callee)) reads.push(node)
            const binding = lexicalBinding(context, callee)
            if (binding !== undefined) namedCalls.push({ node, binding })
            const positions = TRACKED_POSITIONS.get(solidPrimitive(callee) ?? "")
            if (positions === undefined) return
            for (const argument of positions(callExpressionArgs(node))) {
              if (argument === undefined) continue
              if (FUNCTION_TYPES.has(argument.type)) tracked.add(argument)
              const binding = lexicalBinding(context, argument)
              if (binding !== undefined) trackedNames.push(binding)
            }
          },
          "Program:exit"() {
            for (const binding of trackedNames) {
              const fn = named.get(binding)
              if (fn !== undefined) tracked.add(fn)
            }
            const isTracked = (node: AstNode) =>
              runningFunctions(node).some((fn) => tracked.has(fn))
            let grew = true
            while (grew) {
              grew = false
              for (const call of namedCalls) {
                const fn = named.get(call.binding)
                if (fn === undefined || tracked.has(fn) || !isTracked(call.node)) continue
                tracked.add(fn)
                grew = true
              }
            }
            const aliasReads = namedCalls.flatMap((call) =>
              accessors.has(call.binding) ? [call.node] : [],
            )
            for (const read of [...reads, ...aliasReads]) {
              if (!isTracked(read)) continue
              context.report({
                message:
                  "this reactive scope reads the whole session record, so a rename or a model change re-runs it -- read `sessionIdentity()` or `activeSessionId()`, which move only when the session or the branch does",
                node: read,
              })
            }
          },
        }
      },
    },
  },
}

export default plugin
