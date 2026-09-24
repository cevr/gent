/**
 * Oxlint JS plugin: gent custom rules
 *
 * Rules:
 * - no-positional-log-error: flags Effect.logWarning("msg", error) (use annotateLogs)
 * - declared-workspace-imports: a workspace package imports only the
 *   workspace packages its manifest declares, and no relative path leaves it.
 * - core-entry-boundary: extensions read only the authoring entries of
 *   @gent/core (plus protocol for TUI client extensions), product code
 *   never reads @gent/core/test-utils, and the TUI host never reads
 *   @gent/extensions.
 * - no-promise-control-flow-in-tests: bans `.then`/`.catch`/`.finally`
 *   chains and `runPromise` in test files; `effect/*` rules already ban
 *   `async`, `await`, `try/finally` and the Promise constructor and statics.
 *
 * Six-primitive substrate rules:
 * - no-runpromise-outside-boundary: Effect.runPromise/runPromiseWith only allowed
 *   in *-boundary.ts files
 * - no-define-extension-throw: definePackage/defineExtension factories may not
 *   throw — must return Effect with typed error channel
 * - no-dynamic-imports: bans dynamic `import(...)`, `require(...)`, and
 *   createRequire bridges unless the exact expression opts in with an
 *   architectural allow comment. Compiled-binary safety.
 * - no-die-in-test-helpers: bans `Effect.die`/`dieMessage` in test code when the
 *   message describes a *timeout*. A timeout is an expected outcome, so dying
 *   on it escapes as "Unhandled error between tests" attributed to no test.
 *   Dying on a genuine impossible state (missing fixture, out-of-range index)
 *   stays allowed — that really is a defect.
 * - no-hand-rolled-tagged-union: bans inline `{ _tag: "X"; ... } | { _tag: "Y"; ... }`
 *   type literals; require `Schema.TaggedUnion` / `Schema.TaggedStruct` /
 *   `Schema.TaggedErrorClass` instead.
 * - no-sleep: bans `.sleep(...)` calls in test files. Opt out per-site with
 *   `// gent/no-sleep: allow <reason>` (retries, debounce probes, real-clock
 *   timing tests, deliberate fiber-pacing pauses in PTY/server fixtures).
 * - no-with-wrapper-call: bans `withX(otherCall(...))`,
 *   `withX(...)(otherCall(...))`, and `withX(callback)` wrapper-call style, and
 *   `withX` helpers that take an Effect or a callback (the last two outside
 *   `tests/`); pipe the inner Effect/value through the adapter instead.
 * - no-inert-it: bans a bare `it(...)` call where `it` came from
 *   `effect-bun-test`. That `it` is an object, not a function, so the call
 *   throws during module load and the file registers no tests at all.
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Context, Plugin, Range } from "@oxlint/plugins"

const LOG_METHODS = new Set([
  "logInfo",
  "logWarning",
  "logError",
  "logDebug",
  "logTrace",
  "logFatal",
])

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

const walkAst = (node: unknown, visit: (n: AstNode) => void): void => {
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, visit)
    return
  }
  if (!isAstNode(node)) return
  visit(node)
  for (const key in node) {
    if (key === "type" || key === "loc" || key === "range" || key === "parent") continue
    walkAst(fieldOf(node, key), visit)
  }
}

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

const getLocLine = (node: AstNode, edge: "start" | "end"): number | undefined => {
  const loc = fieldOf(node, "loc")
  if (!isRecord(loc)) return undefined
  const point = loc[edge]
  if (!isRecord(point)) return undefined
  const line = point["line"]
  return typeof line === "number" ? line : undefined
}

/**
 * Whether a `// gent/<rule>: allow <reason>` comment sits on the line above
 * `node`, or, when `sameLine` holds, trails it on its own line. The reason
 * must be non-empty, so the carve-out says why this one site is intentional.
 */
const hasAllowComment = (
  context: Context,
  node: AstNode,
  rule: string,
  sameLine: boolean,
): boolean => {
  const startLine = getLocLine(node, "start")
  if (startLine === undefined) return false
  const allow = new RegExp(`\\bgent/${rule}:\\s*allow\\s+\\S`)
  return context.sourceCode
    .getAllComments()
    .filter(isAstNode)
    .some((comment) => {
      const endLine = getLocLine(comment, "end")
      const placed = endLine === startLine - 1 || (sameLine && endLine === startLine)
      const value = getStringField(comment, "value")
      return placed && value !== undefined && allow.test(value)
    })
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

/** A file in a `tests/` tree, judged repo-relative. */
const inTestsTree = (context: Context): boolean => /(?:^|\/)tests\//.test(ruleSubject(context))

/** A `-boundary` file holds a module's Promise edges; in a test tree it is a test's. */
const isBoundaryFilename = (filename: string): boolean => /-boundary\.tsx?$/.test(filename)

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

const PROMISE_CHAIN_METHODS = new Set(["then", "catch", "finally"])

/** An Effect module: `effect`, its subpaths, and the `@effect/*` packages. */
const EFFECT_MODULE = /^(?:effect(?:\/.*)?|@effect\/.+)$/

/**
 * The local names an Effect-module import binds, by name or as a namespace:
 * `import { Stream } from "effect"`, `import * as Layer from "effect/Layer"`.
 * Such a receiver's `catch` is a combinator, not a Promise chain; any other
 * receiver, capitalised or not, may hold a Promise.
 */
const effectModuleBindings = (node: AstNode): ReadonlyArray<string> => {
  if (!EFFECT_MODULE.test(importSourceOf(node) ?? "")) return []
  return (getNodeArrayField(node, "specifiers") ?? [])
    .filter(
      (specifier) =>
        specifier.type === "ImportSpecifier" || specifier.type === "ImportNamespaceSpecifier",
    )
    .map(specifierLocalName)
}

const promiseChainMethodName = (
  node: AstNode,
  effectBindings: ReadonlySet<string>,
): string | undefined => {
  if (node.type !== "CallExpression") return undefined
  const callee = getNodeField(node, "callee")
  if (callee?.type !== "MemberExpression") return undefined
  const object = getNodeField(callee, "object")
  if (object?.type === "Identifier" && effectBindings.has(getStringField(object, "name") ?? "")) {
    return undefined
  }
  const prop = getNodeField(callee, "property")
  if (prop?.type !== "Identifier") return undefined
  const name = getStringField(prop, "name")
  return name !== undefined && PROMISE_CHAIN_METHODS.has(name) ? name : undefined
}

const RUN_PROMISE_METHODS = new Set(["runPromise", "runPromiseWith", "runPromiseExit"])

const runPromiseMethodName = (node: AstNode): string | undefined => {
  if (node.type !== "MemberExpression") return undefined
  const prop = getNodeField(node, "property")
  if (prop?.type !== "Identifier") return undefined
  const name = getStringField(prop, "name")
  return name !== undefined && RUN_PROMISE_METHODS.has(name) ? name : undefined
}

/**
 * The files that may touch `Bun.*` and host facts directly. Fixtures sit under
 * `packages/tooling/fixtures/` and run through the rule, so only the canonical
 * platform file and adapter names exempt one there.
 */
const platformBoundaryFilename = (filename: string): boolean => {
  if (/\/runtime\/gent-platform-bun\.ts$/.test(filename)) return true
  if (/-adapter\.tsx?$/.test(filename)) return true
  if (LINT_FIXTURE.test(filename)) return false
  return /\/packages\/tooling\//.test(filename) || isTestCode(filename)
}

const HOST_PROCESS_MEMBERS = new Set(["execPath", "kill", "platform", "pid"])
const HOST_OS_MEMBERS = new Set(["hostname", "homedir", "release"])

/**
 * Core and shipped-extension source, outside the test harness: the code that
 * also takes its working directory and host modules through Effect services.
 * The TUI, the SDK and the server launcher are process hosts; they read their
 * own working directory.
 */
const protectedHostFactFilename = (filename: string): boolean =>
  /\/packages\/(?:core|extensions)\/src\//.test(filename) && !/\/test-utils\//.test(filename)

/** Host modules protected source reaches only through a service, and which one. */
const HOST_MODULE_MESSAGES: ReadonlyMap<string, string> = new Map([
  ["os", "Host OS facts come from `GentPlatform` (`osInfo`, `homeDirectory`)."],
  ["bun", "Direct `bun` imports are adapter-only; use Effect platform services."],
  [
    "crypto",
    "Random bytes and ids come from Effect `Crypto`; digests come from `GentPlatform.hash`.",
  ],
  ["url", "Turn a file URL into a path with Effect `Path.fromFileUrl`."],
])

/** Host functions protected source calls bare only after importing them from a host module. */
const HOST_FUNCTION_MESSAGES: ReadonlyMap<string, string> = new Map([
  ["createHash", "Digests come from `GentPlatform.hash`."],
  ["randomBytes", "Random bytes come from Effect `Crypto`."],
  ["fileURLToPath", "Turn a file URL into a path with Effect `Path.fromFileUrl`."],
])

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

/** A bare call to a host function: `createHash(...)`, not `platform.createHash(...)`. */
const hostFunctionMessage = (node: AstNode): string | undefined => {
  const callee = getNodeField(node, "callee")
  if (callee?.type !== "Identifier") return undefined
  const name = getStringField(callee, "name")
  if (name === undefined) return undefined
  const message = HOST_FUNCTION_MESSAGES.get(name)
  return message === undefined ? undefined : `\`${name}()\` is not allowed here. ${message}`
}

const hostModuleMessage = (source: string): string | undefined => {
  const message = HOST_MODULE_MESSAGES.get(source.replace(/^node:/, ""))
  return message === undefined ? undefined : `\`${source}\` is not allowed here. ${message}`
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

/**
 * The name a member expression's object resolves to: `process` for both
 * `process` and `globalThis.process`.
 */
const hostObjectName = (object: AstNode | undefined): string | undefined => {
  if (object?.type === "Identifier") return getStringField(object, "name")
  if (object?.type !== "MemberExpression") return undefined
  const root = getNodeField(object, "object")
  const prop = getNodeField(object, "property")
  if (root?.type !== "Identifier" || getStringField(root, "name") !== "globalThis") return undefined
  return prop?.type === "Identifier" ? getStringField(prop, "name") : undefined
}

/** `object.property` for an identifier-rooted (or `globalThis`-rooted) member expression. */
const hostMember = (
  node: AstNode,
): { readonly object: string; readonly property: string | undefined } | undefined => {
  const objectName = hostObjectName(getNodeField(node, "object"))
  if (objectName === undefined) return undefined
  const prop = getNodeField(node, "property")
  let property: string | undefined
  if (prop?.type === "Identifier") property = getStringField(prop, "name")
  else if (prop?.type === "StringLiteral") property = getStringField(prop, "value")
  return { object: objectName, property }
}

const retiredBunMessage = (
  member: { readonly object: string; readonly property: string | undefined },
  platformImpl: boolean,
): string | undefined => {
  if (member.object !== "Bun") return undefined
  if (member.property === "Glob") {
    return "`Bun.Glob` is retired; list files through Effect `FileSystem`."
  }
  if (member.property === "randomUUIDv7" && !platformImpl) {
    return "`Bun.randomUUIDv7` is adapter-only; use `GentPlatform.randomId`."
  }
  return undefined
}

const hostMemberMessage = (member: {
  readonly object: string
  readonly property: string | undefined
}): string | undefined => {
  const suffix = member.property !== undefined ? `.${member.property}` : ""
  if (member.object === "Bun") {
    return `\`Bun${suffix}\` is not allowed here. Route platform I/O through an Effect service (e.g., \`GentPlatform\`, \`FileSystem\`, \`ChildProcess\`, \`KeyValueStore\`, \`Config\`). Bun APIs are allowed only in adapter, tooling, and test harness boundaries.`
  }
  const hostFact =
    (member.object === "process" && HOST_PROCESS_MEMBERS.has(member.property ?? "")) ||
    (member.object === "os" && HOST_OS_MEMBERS.has(member.property ?? ""))
  if (!hostFact) return undefined
  return `\`${member.object}${suffix}\` is not allowed here. Route host process and OS facts through \`GentPlatform\` or an adapter-local Effect service.`
}

const isRunPromiseReference = (node: AstNode): boolean => runPromiseMethodName(node) !== undefined

const wrapperFunctionName = (node: AstNode | undefined): string | undefined => {
  if (node === undefined) return undefined
  if (node.type === "Identifier") {
    const name = getStringField(node, "name")
    return name !== undefined && /^with[A-Z]/.test(name) ? name : undefined
  }
  if (node.type === "MemberExpression") {
    const prop = getNodeField(node, "property")
    if (prop?.type !== "Identifier") return undefined
    const name = getStringField(prop, "name")
    return name !== undefined && /^with[A-Z]/.test(name) ? name : undefined
  }
  return undefined
}

const callExpressionArgs = (node: AstNode): ReadonlyArray<AstNode> => {
  const args = fieldOf(node, "arguments")
  if (!Array.isArray(args)) return []
  return args.filter(isAstNode)
}

const unaryCallExpressionArg = (node: AstNode): AstNode | undefined => {
  const args = callExpressionArgs(node)
  if (args.length !== 1) return undefined
  const [arg] = args
  return arg?.type === "CallExpression" ? arg : undefined
}

const isFunctionNode = (node: AstNode | undefined): boolean =>
  node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression"

/** True when `node` is a direct argument of a `.pipe(...)` call: an adapter factory, not a wrapper. */
const isPipeArgument = (node: AstNode): boolean => {
  const parent = getNodeField(node, "parent")
  if (parent?.type !== "CallExpression") return false
  const callee = getNodeField(parent, "callee")
  if (callee?.type !== "MemberExpression") return false
  const prop = getNodeField(callee, "property")
  return prop?.type === "Identifier" && getStringField(prop, "name") === "pipe"
}

type WrapperCallKind = "invocation" | "callback"

/**
 * The wrapper kind of a `withX` call: `withX(innerCall(), ...)` and
 * `withX(...)(innerCall())` wrap an invocation; `withX(..., callback)` wraps a
 * callback. `withWideEvent(boundary(...))` and any `withX(...)` passed straight
 * to `.pipe(...)` are adapter factories, not wrappers.
 */
const withWrapperCall = (
  node: AstNode,
): { readonly name: string; readonly kind: WrapperCallKind } | undefined => {
  if (node.type !== "CallExpression" || isPipeArgument(node)) return undefined
  const callee = getNodeField(node, "callee")
  const args = callExpressionArgs(node)
  const directName = wrapperFunctionName(callee)
  if (directName !== undefined && directName !== "withWideEvent") {
    if (args[0]?.type === "CallExpression") return { name: directName, kind: "invocation" }
    if (callee?.type === "Identifier" && args.some(isFunctionNode)) {
      return { name: directName, kind: "callback" }
    }
  }
  if (callee?.type !== "CallExpression") return undefined
  const higherOrderName = wrapperFunctionName(getNodeField(callee, "callee"))
  if (higherOrderName !== undefined && unaryCallExpressionArg(node)) {
    return { name: higherOrderName, kind: "invocation" }
  }
  return undefined
}

const isEffectTypeAnnotation = (annotation: AstNode | undefined): boolean => {
  const type = annotation === undefined ? undefined : getNodeField(annotation, "typeAnnotation")
  if (type?.type !== "TSTypeReference") return false
  const typeName = getNodeField(type, "typeName")
  if (typeName?.type !== "TSQualifiedName") return false
  const left = getNodeField(typeName, "left")
  const right = getNodeField(typeName, "right")
  return (
    getStringField(left ?? typeName, "name") === "Effect" &&
    getStringField(right ?? typeName, "name") === "Effect"
  )
}

const isCallbackTypeAnnotation = (annotation: AstNode | undefined): boolean => {
  const type = annotation === undefined ? undefined : getNodeField(annotation, "typeAnnotation")
  return type?.type === "TSFunctionType"
}

/** The parameters of a function and of every function its body returns directly (curried form). */
const curriedParams = (fn: AstNode | undefined): ReadonlyArray<ReadonlyArray<AstNode>> => {
  const levels: Array<ReadonlyArray<AstNode>> = []
  let current = fn
  while (current !== undefined && isFunctionNode(current)) {
    levels.push(getNodeArrayField(current, "params") ?? [])
    current = getNodeField(current, "body")
  }
  return levels
}

const EFFECT_FN_NAMES = new Set(["fn", "fnUntraced"])

const isEffectFnCallee = (callee: AstNode | undefined): boolean => {
  if (callee?.type !== "MemberExpression") return false
  const object = getNodeField(callee, "object")
  const property = getNodeField(callee, "property")
  return (
    object?.type === "Identifier" &&
    getStringField(object, "name") === "Effect" &&
    EFFECT_FN_NAMES.has(getStringField(property ?? callee, "name") ?? "")
  )
}

/**
 * The function a definition runs. `Effect.fn(body)`, `Effect.fn("name")(body)`,
 * and the `fnUntraced` forms yield their generator body; anything else yields itself.
 */
const definitionFunction = (init: AstNode | undefined): AstNode | undefined => {
  if (init?.type !== "CallExpression") return init
  const callee = getNodeField(init, "callee")
  const traced =
    isEffectFnCallee(callee) ||
    (callee?.type === "CallExpression" && isEffectFnCallee(getNodeField(callee, "callee")))
  if (!traced) return init
  return callExpressionArgs(init).find(isFunctionNode)
}

/** Why a `withX` definition is a wrapper helper, or undefined when it is not one. */
const withWrapperDefinitionKind = (fn: AstNode | undefined): "effect" | "callback" | undefined => {
  const levels = curriedParams(definitionFunction(fn))
  const annotations = (params: ReadonlyArray<AstNode>) =>
    params.map((param) => getNodeField(param, "typeAnnotation"))
  if (levels.some((params) => annotations(params).some(isEffectTypeAnnotation))) return "effect"
  if (annotations(levels[0] ?? []).some(isCallbackTypeAnnotation)) return "callback"
  return undefined
}

/** Locate a named property's arrow-function value inside an object literal. */
const findArrowInObject = (objExpr: AstNode, propName: string): AstNode | undefined => {
  if (objExpr.type !== "ObjectExpression") return undefined
  const properties = fieldOf(objExpr, "properties")
  if (!Array.isArray(properties)) return undefined
  for (const propRaw of properties) {
    if (!isAstNode(propRaw) || propRaw.type !== "Property") continue
    const key = getNodeField(propRaw, "key")
    if (key === undefined) continue
    const matches =
      (key.type === "Identifier" && getStringField(key, "name") === propName) ||
      (key.type === "StringLiteral" && getStringField(key, "value") === propName)
    if (!matches) continue
    const value = getNodeField(propRaw, "value")
    if (value === undefined) continue
    if (value.type === "ArrowFunctionExpression" || value.type === "FunctionExpression") {
      return value
    }
  }
  return undefined
}

/** Locate a named property's arrow value in the first object-literal arg of a CallExpression. */
const findArrowInFirstArg = (node: AstNode, propName: string): AstNode | undefined => {
  const args = fieldOf(node, "arguments")
  if (!Array.isArray(args) || args.length === 0) return undefined
  const arg = args[0]
  if (!isAstNode(arg)) return undefined
  return findArrowInObject(arg, propName)
}

/** Classification for a CallExpression that smells like dynamic loading. */
type DynamicLoadKind = "require" | "moduleRequire" | "createRequire"

const DYNAMIC_LOAD_MESSAGES: Readonly<Record<DynamicLoadKind, string>> = {
  require:
    "`require(...)` is forbidden — use a top-level static `import` statement. CommonJS dynamic loading defeats static analysis, leaks into the compiled binary unpredictably, and is the wrong primitive in an ESM Bun project. If this exact site is a documented architectural exception, add `// gent/no-dynamic-imports: allow <reason>` immediately above it.",
  moduleRequire:
    "`module.require(...)` is forbidden — use a top-level static `import` statement. Same rationale as bare `require`: it bypasses static analysis. If this exact site is a documented architectural exception, add `// gent/no-dynamic-imports: allow <reason>` immediately above it.",
  createRequire:
    "`createRequire(...)` / createRequire aliases are forbidden — use a top-level static `import` statement. The createRequire bridge from `node:module` is the canonical way to smuggle CommonJS into ESM and is exactly what this rule is meant to catch. If this exact site is a documented architectural exception, add `// gent/no-dynamic-imports: allow <reason>` immediately above it.",
}

/** Return the dynamic-load kind for a CallExpression's callee, or undefined. */
const classifyDynamicLoadCall = (
  callee: AstNode | undefined,
  createRequireAliases: ReadonlySet<string>,
): DynamicLoadKind | undefined => {
  if (callee === undefined) return undefined
  // Bare `require(...)`
  if (callee.type === "Identifier" && getStringField(callee, "name") === "require") {
    return "require"
  }
  if (callee.type === "Identifier") {
    const name = getStringField(callee, "name")
    if (name !== undefined && createRequireAliases.has(name)) return "createRequire"
  }
  // `module.require(...)`
  if (callee.type === "MemberExpression") {
    const obj = getNodeField(callee, "object")
    const prop = getNodeField(callee, "property")
    if (
      obj?.type === "Identifier" &&
      getStringField(obj, "name") === "module" &&
      prop?.type === "Identifier" &&
      getStringField(prop, "name") === "require"
    ) {
      return "moduleRequire"
    }
  }
  // `createRequire(import.meta.url)("x")` — outer call's callee is a
  // CallExpression whose callee is `Identifier{name:"createRequire"}`.
  if (callee.type === "CallExpression") {
    const inner = getNodeField(callee, "callee")
    if (inner?.type === "Identifier" && getStringField(inner, "name") === "createRequire") {
      return "createRequire"
    }
  }
  return undefined
}

const createRequireAliasName = (node: AstNode): string | undefined => {
  if (node.type !== "VariableDeclarator") return undefined
  const id = getNodeField(node, "id")
  const init = getNodeField(node, "init")
  if (id?.type !== "Identifier" || init?.type !== "CallExpression") return undefined
  const callee = getNodeField(init, "callee")
  if (callee?.type !== "Identifier" || getStringField(callee, "name") !== "createRequire") {
    return undefined
  }
  return getStringField(id, "name")
}

/** The local name an import specifier binds. */
const specifierLocalName = (specifier: AstNode): string => {
  const local = getNodeField(specifier, "local")
  return (local === undefined ? undefined : getStringField(local, "name")) ?? ""
}

/** The exported name an `import { x as y }` specifier reads: `x`, identifier or string. */
const specifierImportedName = (specifier: AstNode): string | undefined => {
  const imported = getNodeField(specifier, "imported")
  if (imported === undefined) return undefined
  return imported.type === "Identifier"
    ? getStringField(imported, "name")
    : getStringField(imported, "value")
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
     * Flags Effect.logWarning("msg", error) — the second positional arg
     * is treated as a Cause, not a structured annotation.
     *
     * Valid:   Effect.logWarning("msg").pipe(Effect.annotateLogs({ error: String(e) }))
     * Invalid: Effect.logWarning("msg", someError)
     */
    "no-positional-log-error": {
      create(context) {
        return {
          CallExpression(node) {
            if (node.callee.type !== "MemberExpression") return
            if (node.callee.object.type !== "Identifier" || node.callee.object.name !== "Effect")
              return
            if (node.callee.property.type !== "Identifier") return
            if (!LOG_METHODS.has(node.callee.property.name)) return
            if (node.arguments.length < 2) return

            context.report({
              message: `Don't pass error as second arg to \`Effect.${node.callee.property.name}\`. Use \`.pipe(Effect.annotateLogs({ error: String(e) }))\` instead.`,
              node,
            })
          },
        }
      },
    },

    /**
     * Flags `withX` wrapper style, in calls and in definitions.
     *
     * - `withX(otherCall(...))`, `withX(otherCall(...), arg)`, and
     *   `withX(...)(otherCall(...))` hide the value being transformed behind
     *   the adapter. Prefer `otherCall(...).pipe(withX)` so the transformation
     *   order reads left-to-right.
     * - `withX(callback)` and `withX(arg, callback)` invert control. Expose an
     *   Effect value or provider and continue with `.pipe(...)`.
     * - A `withX` definition that takes an `Effect.Effect` parameter (at any
     *   curried level, and inside `Effect.fn` or `Effect.fnUntraced`) or a
     *   callback parameter is the helper those calls need.
     *
     * The callback and definition checks skip `tests/`, where a local `withX`
     * fixture helper is allowed.
     *
     * A `withX(...)` passed straight to `.pipe(...)` is an adapter factory,
     * and `withWideEvent(boundary)` is the wide-event library's adapter.
     */
    "no-with-wrapper-call": {
      create(context) {
        // Callback calls and helper definitions are product-code rules; a test
        // may keep a local `withX` fixture helper.
        const inTests = inTestsTree(context)
        const reportDefinition = (
          name: string | undefined,
          fn: AstNode | undefined,
          node: AstNode,
        ) => {
          if (inTests || name === undefined || !/^with[A-Z]/.test(name)) return
          const kind = withWrapperDefinitionKind(fn)
          if (kind === "effect") {
            context.report({
              message: `\`${name}(effect, ...)\` wrapper helpers are banned; expose a pipeable provider and call it from \`.pipe(...)\`.`,
              node,
            })
          }
          if (kind === "callback") {
            context.report({
              message: `\`${name}(callback)\` wrapper helpers are banned; expose an Effect value or provider and continue with \`.pipe(...)\`.`,
              node,
            })
          }
        }
        return {
          CallExpression(node) {
            const call = withWrapperCall(node)
            if (call === undefined) return
            if (call.kind === "invocation") {
              context.report({
                message: `Avoid \`${call.name}(...innerCall)\` wrapper style. Pipe the inner call through \`${call.name}\` instead.`,
                node,
              })
              return
            }
            if (inTests) return
            context.report({
              message: `Avoid \`${call.name}(callback)\` wrapper style. Expose an Effect value or provider and continue with \`.pipe(...)\`.`,
              node,
            })
          },
          VariableDeclarator(node) {
            const id = getNodeField(node, "id")
            const name = id?.type === "Identifier" ? getStringField(id, "name") : undefined
            reportDefinition(name, getNodeField(node, "init"), node)
          },
          FunctionDeclaration(node) {
            const id = getNodeField(node, "id")
            const name = id === undefined ? undefined : getStringField(id, "name")
            reportDefinition(name, { ...node, type: "FunctionExpression" }, node)
          },
        }
      },
    },

    /**
     * Flags `Effect.runPromise(...)` and `Effect.runPromiseWith(...)` outside
     * sanctioned SDK-boundary files.
     *
     * Sanctioned call sites:
     *   - File path matches `*-boundary.ts`
     *   - File path under `tests/**`, `**\/*.test.ts`, `**\/*.test.tsx`
     *
     * Anywhere else: error. SDK edges must be explicit.
     */
    "no-runpromise-outside-boundary": {
      create(context) {
        const filename = context.filename

        // Allow inside any *-boundary.ts file (the convention for SDK edges)
        if (/-boundary\.ts$/.test(filename)) return {}
        // Allow tests
        if (inTestsTree(context)) return {}
        if (/\.test\.tsx?$/.test(filename)) return {}

        // `RUN_PROMISE_METHODS` are the Promise edges, as `Effect` statics and
        // as `ManagedRuntime` / `Runtime` instance methods alike.
        // `runSync`/`runFork`/`runForkWith` are NOT in the set: they're
        // Effect-internal (no Promise edge) and used heavily by Solid signal
        // lanes, PubSub.unbounded eager-build, etc.

        return {
          CallExpression(node) {
            if (node.callee.type !== "MemberExpression") return
            const obj = node.callee.object
            const prop = node.callee.property
            if (prop.type !== "Identifier") return

            // Static `Effect.runPromise(...)` / `runPromiseWith` / `runPromiseExit`.
            if (obj.type === "Identifier" && obj.name === "Effect") {
              if (!RUN_PROMISE_METHODS.has(prop.name)) return
              context.report({
                message: `\`Effect.${prop.name}\` may only be called inside a \`*-boundary.ts\` file. Move the Promise edge into a boundary module.`,
                node,
              })
              return
            }

            // Instance-method `<obj>.runPromise(...)` / `runPromiseWith(...)`
            // calls. Flags when the object identifier (or, for nested chains,
            // the immediate object's rightmost identifier) names a runtime —
            // `runtime`, `clientRuntime`, `serverRuntime`, or ends in
            // `Runtime`. Catches both `runtime.runPromise(...)` and
            // `extensionUI.clientRuntime.runPromise(...)`.
            if (!RUN_PROMISE_METHODS.has(prop.name)) return
            // Resolve the rightmost identifier of the object expression — this
            // handles both `runtime.runPromise(...)` (Identifier object) and
            // `extensionUI.clientRuntime.runPromise(...)` (nested member chain).
            let runtimeName: string | undefined
            if (obj.type === "Identifier") {
              runtimeName = obj.name
            } else if (obj.type === "MemberExpression" && obj.property.type === "Identifier") {
              runtimeName = obj.property.name
            }
            if (runtimeName === undefined) return
            const isRuntimeName =
              runtimeName === "runtime" ||
              runtimeName === "clientRuntime" ||
              runtimeName === "serverRuntime" ||
              /Runtime$/.test(runtimeName)
            if (!isRuntimeName) return
            context.report({
              message: `\`${runtimeName}.${prop.name}\` is a runtime-instance Promise edge — it may only be called inside a \`*-boundary.ts\` file. Move the call into a boundary module.`,
              node,
            })
          },
        }
      },
    },

    /**
     * Flags `throw` statements inside the body of a function passed as a
     * `setup` property to `definePackage(...)` / `defineExtension(...)`.
     *
     * The factory's `setup` callback is called by the loader during extension
     * load; a synchronous `throw` becomes a defect at the load site instead
     * of a typed `ExtensionLoadError` on the Effect channel. The  fix
     * (wrapping the call in `Effect.try`) routes the defect, but the lint
     * rule prevents authors from writing the bug in the first place.
     *
     * Valid:   definePackage({ id, setup: () => Effect.fail(new ExtensionLoadError(...)) })
     * Valid:   definePackage({ id, setup: () => Effect.gen(function* () { ... }) })
     * Invalid: definePackage({ id, setup: () => { throw new Error("missing config") } })
     *
     * Detection: walks the first object-literal argument for a `setup` property
     * whose value is an arrow/function expression, then reports any
     * `ThrowStatement` directly inside that callback's body (not inside a
     * further-nested function — those are deferred runtime calls).
     *
     * NOTE:  ships the rule;  introduces `definePackage` whose setup is
     * Effect-typed, at which point this rule's bite is exact.
     */
    "no-define-extension-throw": {
      create(context) {
        const FACTORIES = new Set(["definePackage", "defineExtension"])
        const FUNCTION_BOUNDARY_TYPES = new Set([
          "ArrowFunctionExpression",
          "FunctionExpression",
          "FunctionDeclaration",
        ])
        const findThrowsInBody = (fn: AstNode, report: (n: AstNode) => void): void => {
          const visit = (n: unknown): void => {
            if (Array.isArray(n)) {
              for (const c of n) visit(c)
              return
            }
            if (!isAstNode(n)) return
            // Stop at any nested function — those are deferred callbacks.
            if (FUNCTION_BOUNDARY_TYPES.has(n.type)) return
            if (n.type === "ThrowStatement") {
              report(n)
              return
            }
            for (const key in n) {
              if (key === "type" || key === "loc" || key === "range" || key === "parent") continue
              visit(fieldOf(n, key))
            }
          }
          // Don't apply the function-boundary stop to the immediate setup body
          // (it IS the function), only to its descendants.
          visit(fieldOf(fn, "body"))
        }
        return {
          CallExpression(node) {
            if (node.callee.type !== "Identifier") return
            if (!FACTORIES.has(node.callee.name)) return
            const factoryName = node.callee.name
            const setupFn = findArrowInFirstArg(node, "setup")
            if (setupFn === undefined) return
            findThrowsInBody(setupFn, (n) => {
              context.report({
                message: `${factoryName}'s \`setup\` callback must surface failures via the Effect channel, not throw synchronously. Use \`Effect.fail(new ExtensionLoadError({ ... }))\` so the loader can route the error.`,
                node: n,
              })
            })
          },
        }
      },
    },

    /**
     * Bans dynamic `import("...")` expressions and `require(...)` calls
     * across the codebase.
     *
     * Why: dynamic imports defeat static analysis (typecheck, bundler graph,
     * dead-code elimination) and hide test/runtime coupling. The repo's
     * compiled-binary deployment (`Bun.build` for the TUI) requires every
     * module to be reachable through static imports — dynamic `import(...)`
     * results in load failures at runtime in the binary.
     *
     * Allowed: expression-level opt-in only. Put
     * `// gent/no-dynamic-imports: allow <reason>` immediately above the exact
     * dynamic load. This keeps the unusual boundary visible at the call site
     * and prevents whole-file exceptions from hiding new dynamic loads.
     *
     * Valid:   import { foo } from "./foo.js"
     * Invalid: const foo = await import("./foo.js")
     * Invalid: const fs = require("node:fs")
     *
     * The allow comment must include a non-empty reason.
     */
    "no-dynamic-imports": {
      create(context) {
        const createRequireAliases = new Set<string>()

        const reportUnlessAllowed = (node: AstNode, message: string): void => {
          if (hasAllowComment(context, node, "no-dynamic-imports", false)) return
          context.report({ message, node })
        }

        return {
          Program(node) {
            walkAst(node, (child) => {
              const alias = createRequireAliasName(child)
              if (alias !== undefined) createRequireAliases.add(alias)
            })
          },
          VariableDeclarator(node) {
            if (!isAstNode(node)) return
            const alias = createRequireAliasName(node)
            if (alias === undefined) return
            reportUnlessAllowed(node, DYNAMIC_LOAD_MESSAGES.createRequire)
          },
          ImportExpression(node) {
            reportUnlessAllowed(
              node,
              `Dynamic \`import(...)\` is forbidden — use a top-level static import. Dynamic imports defeat static analysis and break the compiled-binary build (Bun.build cannot resolve runtime-determined module paths). If this exact site is a documented architectural exception, add \`// gent/no-dynamic-imports: allow <reason>\` immediately above it.`,
            )
          },
          CallExpression(node) {
            const callee: unknown = node.callee
            if (!isAstNode(callee)) return
            const kind = classifyDynamicLoadCall(callee, createRequireAliases)
            if (kind === undefined) return
            reportUnlessAllowed(node, DYNAMIC_LOAD_MESSAGES[kind])
          },
        }
      },
    },

    /**
     * Bans Promise-chain control flow and `runPromise` in test files.
     *
     * A test returns an Effect from `it.live` / `it.scopedLive`, so cleanup
     * runs through finalizers and composes with `Effect.scoped`. A `.then`,
     * `.catch` or `.finally` chain, or a `runPromise` edge, steps outside that
     * graph. `async`, `await`, `try/finally`, `new Promise` and the Promise
     * statics are the `effect/*` rules' to report, everywhere, tests included.
     */
    "no-promise-control-flow-in-tests": {
      create(context) {
        const filename = context.filename
        if (!isTest(ruleSubject(context))) return {}
        if (isBoundaryFilename(filename)) return {}

        // Filled as the import declarations are visited, before any call.
        const effectBindings = new Set<string>()
        return {
          ImportDeclaration(node) {
            if (!isAstNode(node)) return
            for (const name of effectModuleBindings(node)) effectBindings.add(name)
          },
          CallExpression(node) {
            if (!isAstNode(node)) return
            const callee = getNodeField(node, "callee")
            if (callee !== undefined && isRunPromiseReference(callee)) {
              const method = runPromiseMethodName(callee)
              context.report({
                message: `Do not use \`${method}\` in tests. Import \`it\` from \`effect-bun-test\` and return an Effect directly from \`it.live(...)\` / \`it.scopedLive(...)\`; keep runtime Promise boundaries out of tests.`,
                node,
              })
              return
            }
            const args = getNodeArrayField(node, "arguments") ?? []
            const runPromiseArg = args.find(isRunPromiseReference)
            if (runPromiseArg !== undefined) {
              const method = runPromiseMethodName(runPromiseArg)
              context.report({
                message: `Do not pipe tests to \`${method}\`. Import \`it\` from \`effect-bun-test\` and return the Effect directly from \`it.live(...)\` / \`it.scopedLive(...)\`.`,
                node: runPromiseArg,
              })
              return
            }
            const method = promiseChainMethodName(node, effectBindings)
            if (method === undefined) return
            context.report({
              message: `Do not use Promise-chain \`.${method}(...)\` control flow in tests. Import \`it\` from \`effect-bun-test\`; use \`yield*\` in \`Effect.gen\`, \`Effect.all([...])\` for concurrency, and \`Effect.scoped\` / \`it.scopedLive\` for cleanup.`,
              node,
            })
          },
        }
      },
    },

    /**
     * Bans `Bun.*` references and host process and OS facts everywhere except
     * platform adapter, tooling, and test harness boundaries. The TUI build
     * script is exempt by its `.oxlintrc.json` override.
     * The `Bun` global is a platform-specific runtime API, and `process.pid`,
     * `process.platform`, `os.hostname()` and the rest are host facts; product
     * code routes both through Effect platform services (`GentPlatform`,
     * `FileSystem`, `ChildProcess`, `KeyValueStore`, `Config`) so the runtime
     * is portable and the I/O boundary is explicit.
     *
     * Exempt by filename:
     *   - `runtime/gent-platform-bun.ts` (the GentPlatform live impl)
     *   - `*-adapter.ts` / `*-adapter.tsx` files (platform-specific adapters)
     *   - `**\/packages/tooling/**` (CI helpers)
     *   - `**\/packages/e2e/**` (test infrastructure spawning real processes)
     *   - `*.test.ts` and files under `tests/`
     *
     * Two retired APIs are banned even inside those exemptions, outside
     * `tests/`: `Bun.Glob` (files are listed through Effect `FileSystem`) and
     * `Bun.randomUUIDv7` (only `runtime/gent-platform-bun.ts` may call it;
     * everyone else uses `GentPlatform.randomId`).
     *
     * Core and shipped-extension source (outside `test-utils/`) is held to
     * three more host facts: `process.cwd()` (the working directory comes
     * from `RuntimeEnvironment` or the extension context), imports of the
     * `os`, `bun`, `crypto` and `url` modules, and a file path hand-rolled as
     * `new URL(import.meta.url).pathname`. This rule is the one owner of the
     * host-fact bans; a site that is a deliberate exception carries a
     * line-local suppression with its reason.
     */
    "no-bun-outside-adapter": {
      create(context) {
        const filename = context.filename
        const platformImpl = /\/runtime\/gent-platform-bun\.ts$/.test(filename)
        const inTests = inTestsTree(context)
        const protectedFile =
          protectedHostFactFilename(filename) && !platformBoundaryFilename(filename)
        const reportHostModule = (node: AstNode) => {
          if (!protectedFile) return
          const source = importSourceOf(node)
          if (source === undefined) return
          const message = hostModuleMessage(source)
          if (message !== undefined) context.report({ message, node })
        }
        return {
          ImportDeclaration: reportHostModule,
          ImportExpression: reportHostModule,
          CallExpression(node) {
            if (!protectedFile || !isAstNode(node)) return
            const source = requireSourceOf(node)
            const message =
              source === undefined ? hostFunctionMessage(node) : hostModuleMessage(source)
            if (message !== undefined) context.report({ message, node })
          },
          MemberExpression(node) {
            if (!isAstNode(node)) return
            if (protectedFile && isImportMetaUrlConstruction(getNodeField(node, "object"))) {
              context.report({
                message:
                  "`new URL(import.meta.url)` read as a path is hand-rolled; use Effect `Path.fromFileUrl`.",
                node,
              })
              return
            }
            const member = hostMember(node)
            if (member === undefined) return
            const retired = retiredBunMessage(member, platformImpl)
            if (retired !== undefined && !inTests) {
              context.report({ message: retired, node })
              return
            }
            if (protectedFile && member.object === "process" && member.property === "cwd") {
              context.report({
                message:
                  "`process.cwd` is not allowed here. The working directory comes from `RuntimeEnvironment` or the extension context's `cwd`.",
                node,
              })
              return
            }
            if (platformBoundaryFilename(filename)) return
            const message = hostMemberMessage(member)
            if (message !== undefined) context.report({ message, node })
          },
        }
      },
    },

    /**
     * Flags hand-rolled `_tag` discriminated unions written as type
     * literals — a union of two-or-more `{ _tag: "X"; ... }` shapes.
     *
     * Use `Schema.TaggedUnion`, `Schema.TaggedStruct`, or
     * `Schema.TaggedErrorClass` instead. Those give per-variant
     * `.cases.<Name>.make({...})` constructors, structural `_tag`
     * discrimination, and Schema-encode/decode for free.
     *
     * Detected: any `TSUnionType` with ≥2 `TSTypeLiteral` members each
     * having a `_tag: "Pascal"` property.
     *
     * Limitations: AST-only. Does not flag types defined via interface
     * heritage or hand-rolled union of named type aliases — only the
     * inline-type-literal form. Construction-site form
     * (`{ _tag: "X" } satisfies SomeUnion`) is not covered here; it's
     * already vanishingly rare in this codebase.
     */
    "no-hand-rolled-tagged-union": {
      create(context) {
        const isReportableTagLiteral = (member: AstNode): boolean => {
          if (member.type !== "TSPropertySignature") return false
          const key = getNodeField(member, "key")
          if (key === undefined) return false
          let keyName: string | undefined
          if (key.type === "Identifier") keyName = getStringField(key, "name")
          else if (key.type === "StringLiteral" || key.type === "Literal")
            keyName = getStringField(key, "value")
          if (keyName !== "_tag") return false
          const annotation = getNodeField(member, "typeAnnotation")
          if (annotation === undefined) return false
          const inner = getNodeField(annotation, "typeAnnotation")
          if (inner === undefined || inner.type !== "TSLiteralType") return false
          const literal = getNodeField(inner, "literal")
          if (literal === undefined) return false
          if (literal.type !== "StringLiteral" && literal.type !== "Literal") return false
          const value = getStringField(literal, "value")
          if (value === undefined || value.length === 0) return false
          // Pascal-case heuristic — keeps the rule from chasing
          // schema-internal lowercase wire tags like "regular" /
          // "interjection" that legitimately appear inside Schema
          // metadata. `Schema.TaggedUnion` member names are PascalCase
          // by convention.
          const first = value.charAt(0)
          return first === first.toUpperCase() && first !== first.toLowerCase()
        }

        const literalHasTag = (literal: AstNode): boolean => {
          if (literal.type !== "TSTypeLiteral") return false
          const members = getNodeArrayField(literal, "members")
          if (members === undefined) return false
          return members.some(isReportableTagLiteral)
        }

        return {
          TSUnionType(node) {
            if (!isAstNode(node)) return
            const types = getNodeArrayField(node, "types")
            if (types === undefined || types.length < 2) return
            let tagged = 0
            for (const t of types) {
              if (literalHasTag(t)) tagged += 1
              if (tagged >= 2) break
            }
            if (tagged < 2) return
            context.report({
              message:
                "Hand-rolled `_tag` discriminated union — use `Schema.TaggedUnion` (preferred) or `Schema.TaggedStruct` / `Schema.TaggedErrorClass`. Construct via `.cases.<Name>.make({...})`. See packages/core/CLAUDE.md.",
              node,
            })
          },
        }
      },
    },

    /**
     * Bans `Effect.die` / `Effect.dieMessage` in test code when the message
     * describes a timeout.
     *
     * A timeout is an expected outcome. Dying on it escapes the failing
     * assertion as "Unhandled error between tests", attributed to no test.
     * Dying on a genuine impossible state (a missing fixture, an out-of-range
     * index) stays allowed: that really is a defect.
     *
     * Opt out per site with `// gent/no-die-in-test-helpers: allow <reason>`
     * on the line above the call or trailing it.
     */
    "no-die-in-test-helpers": {
      create(context) {
        // Match on the message text the call carries. A structural test is not
        // available here — whether a die is a timeout is a statement about
        // intent, and the message is where that intent is written down.
        const TIMEOUT_TEXT = /tim(?:ed|e)\s*out|timeout|waiting for|gave up/i
        const mentionsTimeout = (node: AstNode): boolean => {
          let found = false
          walkAst(node, (inner) => {
            if (found) return
            if (inner.type === "Literal") {
              const raw = getStringField(inner, "raw")
              if (raw !== undefined && TIMEOUT_TEXT.test(raw)) found = true
              return
            }
            if (inner.type === "TemplateElement") {
              // The text sits under `value: { cooked, raw }` — a bare record
              // with no `type`, so it is not reachable via `getNodeField`.
              const value = fieldOf(inner, "value")
              if (!isRecord(value)) return
              const cooked = value["cooked"]
              const raw = value["raw"]
              const text = typeof cooked === "string" ? cooked : raw
              if (typeof text === "string" && TIMEOUT_TEXT.test(text)) found = true
            }
          })
          return found
        }

        if (!isTestCode(ruleSubject(context))) return {}

        return {
          CallExpression(node) {
            if (!isAstNode(node)) return
            const callee = getNodeField(node, "callee")
            if (callee?.type !== "MemberExpression") return
            const prop = getNodeField(callee, "property")
            if (prop?.type !== "Identifier") return
            const method = getStringField(prop, "name")
            if (method !== "die" && method !== "dieMessage") return
            const obj = getNodeField(callee, "object")
            if (obj?.type !== "Identifier") return
            if (getStringField(obj, "name") !== "Effect") return
            // Only *timeouts* are the bug. `Effect.die` for an impossible state
            // — a lookup that must succeed, an out-of-range index — is correct:
            // that really is a defect, and dying names it as one. A timeout is
            // an expected outcome, so dying on it drops the diagnostic and
            // detaches the failure from the test that caused it.
            if (!mentionsTimeout(node)) return
            if (hasAllowComment(context, node, "no-die-in-test-helpers", true)) return
            context.report({
              message: `\`Effect.${method}(...)\` in test code — a defect escapes the failing assertion and surfaces as "Unhandled error between tests", attributed to no test in particular. Fail with a typed error instead (\`Schema.TaggedError\`, then \`yield* new MyError({...})\`) so the timeout or precondition failure lands on the test that caused it. If this site genuinely models an unrecoverable defect, add \`// gent/no-die-in-test-helpers: allow <reason>\` on the line directly above the call.`,
              node,
            })
          },
        }
      },
    },
    /**
     * Bans `.sleep(...)` calls in test files.
     *
     * Why: `Effect.sleep("0 millis")` / `Effect.sleep("10 millis")` is the
     * canonical "wait for the next tick" anti-pattern in this codebase —
     * tests that need to wait for a state transition should use `Deferred`,
     * `controls.waitForCall`, or `waitFor` polling helpers, not a fixed
     * delay. Non-zero sleeps in tests usually indicate a missing
     * synchronisation primitive and produce flaky timing-coupled assertions.
     *
     * Legitimate uses do exist:
     *   - real-clock timing assertions (idle-timeout eviction in
     *     server-lifecycle, headless CLI exit timeout fallback)
     *   - deliberate fiber-pacing in PTY / subprocess fixtures, where the
     *     OS-level scheduler needs to be exercised
     *   - retry / backoff sleeps when the retry helper is itself the
     *     subject under test
     *
     * Opt out per-site by placing
     * `// gent/no-sleep: allow <reason>` on the line directly above the
     * call. The reason must be non-empty so the carveout encodes why this
     * specific sleep is intentional.
     *
     * Matches both `Effect.sleep(...)` and `Bun.sleep(...)`. Scoped to test
     * code (`isTestCode`): the tests, their `tests/` and `integration/`
     * trees, and the harness (`packages/e2e`, core's `test-utils`). The rule
     * does NOT apply to product code — production retries/timeouts/debounces
     * are unaffected.
     */
    "no-sleep": {
      create(context) {
        // A lint fixture is judged as the file at its mirrored path, and it
        // keeps the allow-comment carveout, so the fixture tests count the
        // diagnostics on the invalid fixture and none on the valid one.
        if (!isTestCode(ruleSubject(context))) return {}

        return {
          CallExpression(node) {
            if (!isAstNode(node)) return
            const callee = getNodeField(node, "callee")
            if (callee?.type !== "MemberExpression") return
            const prop = getNodeField(callee, "property")
            if (prop?.type !== "Identifier") return
            if (getStringField(prop, "name") !== "sleep") return
            // Restrict to recognized sleep call shapes — `Effect.sleep(...)`
            // and `Bun.sleep(...)`. Other `.sleep(...)` on unrelated
            // objects (e.g., a domain object exposing a `sleep` action)
            // would be false positives and aren't worth catching here.
            const obj = getNodeField(callee, "object")
            if (obj?.type !== "Identifier") return
            const objectName = getStringField(obj, "name")
            if (objectName !== "Effect" && objectName !== "Bun") return
            if (hasAllowComment(context, node, "no-sleep", true)) return
            context.report({
              message: `\`${objectName}.sleep(...)\` in test code — replace fixed delays with deterministic synchronisation: \`Deferred\` for coordination, \`controls.waitForCall(...)\` / \`controls.waitForStreamStart()\` for sequence-provider gating, or \`waitFor\` polling helpers for projection convergence. If this site is a real-clock timing assertion, OS-level fiber pacing, or a retry/backoff test, add \`// gent/no-sleep: allow <reason>\` on the line directly above the call.`,
              node,
            })
          },
        }
      },
    },

    /**
     * Flags a bare `it(...)` call in a file that imports `it` from
     * `effect-bun-test`.
     *
     * That `it` is a plain object holding the four runners — `it.live`,
     * `it.scopedLive`, `it.effect`, `it.scoped` — and has no call signature.
     * Calling it throws a `TypeError` while the module body is still
     * evaluating, so Bun registers nothing from the file: every test the file
     * declares, not just the bare one, disappears. The run reports the loss as
     * "Unhandled error between tests" with `0 fail`, attributed to no test, so
     * the assertions inside look like they passed.
     *
     * A synchronous test belongs on `test(...)` from `bun:test`. A test that
     * returns an Effect belongs on one of the four runners.
     *
     * What is reported: a `CallExpression` whose callee is the identifier
     * bound by an `effect-bun-test` import, under whatever local name that
     * import gives it, or `ns.it` through a namespace import of the package.
     * A member call such as `it.live(...)` is the correct
     * form and is untouched, and so is a file that never imports `it` from
     * `effect-bun-test` — the `it` from `bun:test` is callable.
     */
    "no-inert-it": {
      create(context) {
        // The local name `it` is bound to, which `import { it as spec }`
        // makes something other than "it". Empty until an import binds it,
        // so a file that never imports from effect-bun-test reports nothing.
        const inertNames = new Set<string>()
        // `import * as ebt from "effect-bun-test"` makes `ebt.it(...)` the same call.
        const namespaces = new Set<string>()
        const inertCallee = (callee: AstNode | undefined): string | undefined => {
          if (callee?.type === "Identifier") {
            const name = getStringField(callee, "name")
            return name !== undefined && inertNames.has(name) ? name : undefined
          }
          if (callee?.type !== "MemberExpression") return undefined
          const object = getNodeField(callee, "object")
          const property = getNodeField(callee, "property")
          const namespace =
            object?.type === "Identifier" ? getStringField(object, "name") : undefined
          if (namespace === undefined || !namespaces.has(namespace)) return undefined
          if (property?.type !== "Identifier" || getStringField(property, "name") !== "it") {
            return undefined
          }
          return `${namespace}.it`
        }
        return {
          ImportDeclaration(node) {
            if (!isAstNode(node) || importSourceOf(node) !== "effect-bun-test") return
            for (const specifier of getNodeArrayField(node, "specifiers") ?? []) {
              const local = specifierLocalName(specifier)
              if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(local)
              if (
                specifier.type === "ImportSpecifier" &&
                specifierImportedName(specifier) === "it"
              ) {
                inertNames.add(local)
              }
            }
          },
          CallExpression(node) {
            if (!isAstNode(node)) return
            const name = inertCallee(getNodeField(node, "callee"))
            if (name === undefined) return
            context.report({
              message: `\`${name}(...)\` from "effect-bun-test" is not callable — it is the object holding \`${name}.live\`, \`${name}.scopedLive\`, \`${name}.effect\` and \`${name}.scoped\`. Calling it throws while the module loads, so Bun registers none of this file's tests and reports the loss as an error attributed to no test. Use \`test(...)\` from "bun:test" for a synchronous body, or \`${name}.live\` / \`${name}.scopedLive\` for one that returns an Effect.`,
              node,
            })
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
     * writer, and a writer that skips the admission (the compaction handoff
     * once did) nests sessions without bound.
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
  },
}

export default plugin
