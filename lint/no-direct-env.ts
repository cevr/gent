/**
 * Oxlint JS plugin: gent custom rules
 *
 * Rules:
 * - no-direct-env: flags Bun.env["X"] / process.env.X (use Config from effect)
 * - no-positional-log-error: flags Effect.logWarning("msg", error) (use annotateLogs)
 * - no-extension-internal-imports: enforces extension boundary — extensions must import
 *   from @gent/core/extensions/api, not core internals (domain/, runtime/, etc.)
 * - no-projection-writes: heuristic AST-string-match fence on
 *   `QueryContribution.handler` AND read-intent `CapabilityContribution.effect`
 *   for write-shaped method names. Projection coverage was deleted in B11.4 —
 *   `ProjectionContribution<A, R extends ReadOnlyTag>` enforces it
 *   structurally now.
 * - no-promise-control-flow-in-tests: bans new `try/finally`, `async`, and
 *   `await` control flow in test files.
 *   Test resources should live in Effect scopes (`Effect.scoped`,
 *   `FileSystem.makeTempDirectoryScoped`, `Effect.acquireRelease`, etc.).
 *
 * Six-primitive substrate rules (C0 scaffolds, sharpened in later batches):
 * - no-runpromise-outside-boundary: Effect.runPromise/runPromiseWith only allowed
 *   in *-boundary.ts files OR when consuming an SdkBoundary value via runSdkBoundary
 * - all-errors-are-tagged: classes named *Error/*Failure must extend
 *   Schema.TaggedErrorClass (replaces plain `class X extends Error`)
 * - no-define-extension-throw: definePackage/defineExtension factories may not
 *   throw — must return Effect with typed error channel
 * - no-r-equals-never-comment: flag inline R-channel annotation comments
 *   at provider/SDK edges; require SdkBoundary<E> brand instead
 * - no-dynamic-imports: bans dynamic `import(...)` and `require(...)` outside
 *   a small allow-list of architecturally-justified files (extension plugin
 *   discovery, optional native module fallbacks). Compiled-binary safety.
 * - no-hand-rolled-tagged-union: bans inline `{ _tag: "X"; ... } | { _tag: "Y"; ... }`
 *   type literals; require `TaggedEnumClass` / `Schema.TaggedStruct` /
 *   `Schema.TaggedErrorClass` instead.
 */

import type { Plugin } from "#oxlint/plugins"

const LOG_METHODS = new Set([
  "logInfo",
  "logWarning",
  "logError",
  "logDebug",
  "logTrace",
  "logFatal",
])

// After B11.1c the `projection` / `capability` identity smart constructors are
// gone; only `query` and `mutation` survive as real lowering helpers. After
// B11.4 the projection arm is gone too — `ProjectionContribution<A, R extends
// ReadOnlyTag>` enforces the read-only fence at the type level. The
// CallExpression detection branch below uses these sets for factory-call
// matching; type-annotation and `satisfies` paths still cover direct
// `CapabilityContribution` / `QueryContribution` object literals.
/** Query factory names — `QueryContribution.handler` is enforced read-only by this rule. */
const QUERY_FACTORY_NAMES = new Set(["query"])
/** Capability factory names — `CapabilityContribution.effect` is enforced
 *  read-only by this rule when `intent: "read"`. */
const CAPABILITY_FACTORY_NAMES = new Set<string>()

const PROJECTION_WRITE_METHODS = new Set([
  "create",
  "update",
  "delete",
  "set",
  "write",
  "add",
  "remove",
  "insert",
  "upsert",
  "clear",
  "put",
  "save",
])

interface AstNode {
  readonly type: string
  readonly [k: string]: unknown
}

const isAstNode = (value: unknown): value is AstNode => {
  if (typeof value !== "object" || value === null || !("type" in value)) return false
  const t = (value as Record<string, unknown>).type
  return typeof t === "string"
}

const walkAst = (node: unknown, visit: (n: AstNode) => void): void => {
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, visit)
    return
  }
  if (!isAstNode(node)) return
  visit(node)
  for (const key in node) {
    if (key === "type" || key === "loc" || key === "range" || key === "parent") continue
    walkAst(node[key], visit)
  }
}

const getStringField = (n: AstNode, field: string): string | undefined => {
  const v = n[field]
  return typeof v === "string" ? v : undefined
}

const getNodeField = (n: AstNode, field: string): AstNode | undefined => {
  const v = n[field]
  return isAstNode(v) ? v : undefined
}

const getNodeArrayField = (n: AstNode, field: string): AstNode[] | undefined => {
  const v = n[field]
  if (!Array.isArray(v)) return undefined
  return v.filter(isAstNode)
}

const isTestFilename = (filename: string): boolean =>
  /\/tests\//.test(filename) ||
  /\/batch12-modules\/(?:tests|integration)\//.test(filename) ||
  /\.test\.tsx?$/.test(filename)

/** Return the call's function name (Identifier or MemberExpression property). */
const calleeName = (node: AstNode): string | undefined => {
  const callee = getNodeField(node, "callee")
  if (callee === undefined) return undefined
  if (callee.type === "Identifier") {
    return getStringField(callee, "name")
  }
  if (callee.type === "MemberExpression") {
    const prop = getNodeField(callee, "property")
    if (prop !== undefined && prop.type === "Identifier") {
      return getStringField(prop, "name")
    }
  }
  return undefined
}

const queryFactoryName = (node: AstNode): string | undefined => {
  const name = calleeName(node)
  return name !== undefined && QUERY_FACTORY_NAMES.has(name) ? name : undefined
}

const capabilityFactoryName = (node: AstNode): string | undefined => {
  const name = calleeName(node)
  return name !== undefined && CAPABILITY_FACTORY_NAMES.has(name) ? name : undefined
}

/**
 * Locate the string-valued `intent` property in an object literal — used to
 * decide whether a CapabilityContribution should be enforced read-only. Only
 * `"read"` triggers the read-only fence; `"write"` (or missing/dynamic) opts
 * out, mirroring the type-level intent semantics.
 */
const intentLiteral = (objExpr: AstNode): string | undefined => {
  if (objExpr.type !== "ObjectExpression") return undefined
  const properties = objExpr.properties
  if (!Array.isArray(properties)) return undefined
  for (const propRaw of properties) {
    if (!isAstNode(propRaw) || propRaw.type !== "Property") continue
    const key = getNodeField(propRaw, "key")
    if (key === undefined) continue
    const isIntent =
      (key.type === "Identifier" && getStringField(key, "name") === "intent") ||
      (key.type === "StringLiteral" && getStringField(key, "value") === "intent")
    if (!isIntent) continue
    const value = getNodeField(propRaw, "value")
    if (value === undefined) continue
    if (value.type === "StringLiteral" || value.type === "Literal") {
      return getStringField(value, "value")
    }
  }
  return undefined
}

/** Returns the intent literal of the first object-literal arg, if any. */
const intentLiteralInFirstArg = (node: AstNode): string | undefined => {
  const args = node.arguments
  if (!Array.isArray(args) || args.length === 0) return undefined
  const arg = args[0]
  if (!isAstNode(arg)) return undefined
  return intentLiteral(arg)
}

/** Locate a named property's arrow-function value inside an object literal. */
const findArrowInObject = (objExpr: AstNode, propName: string): AstNode | undefined => {
  if (objExpr.type !== "ObjectExpression") return undefined
  const properties = objExpr.properties
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
  const args = node.arguments
  if (!Array.isArray(args) || args.length === 0) return undefined
  const arg = args[0]
  if (!isAstNode(arg)) return undefined
  return findArrowInObject(arg, propName)
}

const QUERY_TYPE_NAMES = new Set(["QueryContribution", "AnyQueryContribution"])
const CAPABILITY_TYPE_NAMES = new Set(["CapabilityContribution", "AnyCapabilityContribution"])

/** Detect whether a TypeScript type reference matches one of the given names. */
const isTypeRefIn = (typeNode: AstNode | undefined, names: ReadonlySet<string>): boolean => {
  if (typeNode === undefined) return false
  if (typeNode.type === "TSTypeAnnotation") {
    return isTypeRefIn(getNodeField(typeNode, "typeAnnotation"), names)
  }
  if (typeNode.type === "TSTypeReference") {
    const name = getNodeField(typeNode, "typeName")
    if (name === undefined) return false
    if (name.type === "Identifier") {
      const n = getStringField(name, "name")
      return n !== undefined && names.has(n)
    }
    return false
  }
  return false
}

const isQueryTypeRef = (typeNode: AstNode | undefined): boolean =>
  isTypeRefIn(typeNode, QUERY_TYPE_NAMES)
const isCapabilityTypeRef = (typeNode: AstNode | undefined): boolean =>
  isTypeRefIn(typeNode, CAPABILITY_TYPE_NAMES)

/** If `node` is `expr.<method>(...)` and method is a known write, return the method name. */
const writeCallMethod = (node: AstNode): string | undefined => {
  if (node.type !== "CallExpression") return undefined
  const callee = getNodeField(node, "callee")
  if (callee === undefined || callee.type !== "MemberExpression") return undefined
  const methodNode = getNodeField(callee, "property")
  if (methodNode === undefined) return undefined
  let methodName: string | undefined
  if (methodNode.type === "Identifier") {
    methodName = getStringField(methodNode, "name")
  } else if (methodNode.type === "StringLiteral") {
    methodName = getStringField(methodNode, "value")
  }
  if (methodName === undefined || !PROJECTION_WRITE_METHODS.has(methodName)) return undefined
  return methodName
}

/** Classification for a CallExpression that smells like dynamic loading. */
type DynamicLoadKind = "require" | "moduleRequire" | "createRequire"

const DYNAMIC_LOAD_MESSAGES: Readonly<Record<DynamicLoadKind, string>> = {
  require:
    "`require(...)` is forbidden — use a top-level static `import` statement. CommonJS dynamic loading defeats static analysis, leaks into the compiled binary unpredictably, and is the wrong primitive in an ESM Bun project. If your use case is a documented architectural exception, add the file to the allow-list in `lint/no-direct-env.ts` with a justification comment.",
  moduleRequire:
    "`module.require(...)` is forbidden — use a top-level static `import` statement. Same rationale as bare `require`: it bypasses static analysis. Add the file to the allow-list in `lint/no-direct-env.ts` with a justification if this is an architectural exception.",
  createRequire:
    "`createRequire(...)` followed by a require call is forbidden — use a top-level static `import` statement. The createRequire bridge from `node:module` is the canonical way to smuggle CommonJS into ESM and is exactly what this rule is meant to catch. Add the file to the allow-list in `lint/no-direct-env.ts` with a justification if this is an architectural exception.",
}

/** Return the dynamic-load kind for a CallExpression's callee, or undefined. */
const classifyDynamicLoadCall = (callee: AstNode | undefined): DynamicLoadKind | undefined => {
  if (callee === undefined) return undefined
  // Bare `require(...)`
  if (callee.type === "Identifier" && getStringField(callee, "name") === "require") {
    return "require"
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

const plugin: Plugin = {
  meta: {
    name: "gent",
  },
  rules: {
    /**
     * Enforces the extension boundary contract.
     *
     * Extensions may import from:
     *   - `./api.js` or `../api.js` (relative to extension file in core)
     *   - `@gent/core/extensions/api` (package path, for extracted extensions)
     *   - `effect-machine`, `effect`, `@effect/*` (peer deps)
     *   - Sibling extension files (relative `./` or `../` within extensions/)
     *
     * Extensions may NOT import from:
     *   - `@gent/core/domain/*`, `@gent/core/runtime/*`, `@gent/core/storage/*`,
     *     `@gent/core/server/*`, `@gent/core/providers/*`
     *   - Relative paths that escape into domain/, runtime/, storage/, etc.
     *
     * Applies to: packages/core/src/extensions/** and packages/extensions/**
     * Exempt: extensions/api.ts (the builder implementation)
     */
    "no-extension-internal-imports": {
      create(context) {
        const filename = context.filename

        // Scope: only extension implementation files
        const inCoreExtensions = filename.includes("packages/core/src/extensions/")
        const inExtensionsPackage = filename.includes("packages/extensions/")
        if (!inCoreExtensions && !inExtensionsPackage) return {}

        // Exempt: api.ts is the public bridge; internal/builtin.ts is the
        // narrow builtin-only membrane for Gent-owned extensions.
        if (
          filename.endsWith("/extensions/api.ts") ||
          filename.endsWith("/packages/extensions/internal/builtin.ts")
        ) {
          return {}
        }

        // Relative imports that escape into core internals
        const INTERNAL_RELATIVE =
          /^\.\.?\/(\.\.\/)*(?:domain|runtime|storage|server|providers|core\/src)\//

        // Allowed @gent/core subpaths (everything else is forbidden)
        const ALLOWED_PACKAGE = /^@gent\/core\/extensions\/api(?:\.js)?$/

        return {
          ImportDeclaration(node: { source: { value: string }; type: string }) {
            const source = node.source.value

            // Relative imports escaping into core internals
            if (INTERNAL_RELATIVE.test(source)) {
              context.report({
                message: `Extensions must import from the public API (./api.js), not core internals. Forbidden: "${source}"`,
                node,
              })
              return
            }

            // Package imports into core internals (skip allowed paths)
            if (source.startsWith("@gent/core/") && !ALLOWED_PACKAGE.test(source)) {
              context.report({
                message: `Extensions must import from "@gent/core/extensions/api", not internal paths. Forbidden: "${source}"`,
                node,
              })
              return
            }
          },
        }
      },
    },

    /**
     * Flags direct reads from `Bun.env` and `process.env`.
     *
     * Valid:   yield* Config.option(Config.string("MY_VAR"))
     * Valid:   { ...Bun.env, TERM: "dumb" }
     * Invalid: Bun.env["MY_VAR"], process.env.NODE_ENV
     */
    "no-direct-env": {
      create(context) {
        return {
          MemberExpression(node) {
            if (node.object.type !== "MemberExpression") return

            const inner = node.object
            if (
              inner.object.type === "Identifier" &&
              (inner.object.name === "Bun" || inner.object.name === "process") &&
              ((inner.property.type === "Identifier" && inner.property.name === "env") ||
                (inner.property.type === "StringLiteral" && inner.property.value === "env"))
            ) {
              context.report({
                message: `Use \`Config\` from \`effect\` instead of \`${inner.object.name}.env\`. See: yield* Config.option(Config.string("VAR_NAME"))`,
                node,
              })
            }
          },
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
     * Flags `Effect.runPromise(...)` and `Effect.runPromiseWith(...)` outside
     * sanctioned SDK-boundary files.
     *
     * Sanctioned call sites:
     *   - File path matches `*-boundary.ts`
     *   - File path is in {@link KNOWN_BOUNDARY_FILES} (legacy boundaries
     *     pending migration to `*-boundary.ts`; tracked per-batch in the
     *     v2 redesign plan)
     *   - File path under `tests/**`, `**\/*.test.ts`, `**\/*.test.tsx`
     *   - File is the `SdkBoundary` consumer module itself
     *
     * Anywhere else: error. SDK edges must be explicit.
     *
     * Migration plan: each entry in `KNOWN_BOUNDARY_FILES` is removed in the
     * batch that renames the file to `*-boundary.ts` (anthropic/openai in
     * driver work, acp in C3, sdk in transport batches, TUI hook in C9).
     */
    "no-runpromise-outside-boundary": {
      create(context) {
        const filename = context.filename

        // Allow inside any *-boundary.ts file (the convention for SDK edges)
        if (/-boundary\.ts$/.test(filename)) return {}
        // Allow inside the SdkBoundary consumer itself
        if (/\/domain\/sdk-boundary\.ts$/.test(filename)) return {}
        // Allow tests
        if (/\/tests\//.test(filename)) return {}
        if (/\.test\.tsx?$/.test(filename)) return {}
        // Allow lint plugin file itself (rule definitions reference the API in messages)
        if (/\/lint\/[^/]+\.ts$/.test(filename) && !/\/fixtures\//.test(filename)) return {}

        // Known SDK boundaries pending migration to *-boundary.ts file naming.
        // Each entry is a documented Effect→Promise edge that currently uses
        // `Effect.runPromise` with a closed-over `R = never` Effect. Migration
        // tracked in the v2 redesign plan; remove from this list when the file
        // is renamed or split into a `*-boundary.ts`.
        const KNOWN_BOUNDARY_FILES = []
        if (KNOWN_BOUNDARY_FILES.some((f) => filename.endsWith(f))) return {}

        // Effect static methods that exit the Effect world via Promise/fiber
        // — the boundary contract treats these as edges that must live in
        // `*-boundary.ts`. `runSync`/`runFork`/`runForkWith` are NOT in this
        // set: they're Effect-internal (no Promise edge) and used heavily by
        // Solid signal lanes, PubSub.unbounded eager-build, etc. — adding
        // them would force a much wider boundary refactor than this batch.
        const EFFECT_RUN_METHODS = new Set(["runPromise", "runPromiseWith", "runPromiseExit"])
        // Instance methods on a `ManagedRuntime` / `Runtime` that exit via
        // Promise — same boundary semantics as `Effect.runPromise`. Effect's
        // `ManagedRuntime` exposes `runPromise{,With,Exit}`; all three are
        // the Promise edge.
        const RUNTIME_RUN_METHODS = new Set(["runPromise", "runPromiseWith", "runPromiseExit"])

        return {
          CallExpression(node) {
            if (node.callee.type !== "MemberExpression") return
            const obj = node.callee.object
            const prop = node.callee.property
            if (prop.type !== "Identifier") return

            // Static `Effect.runPromise(...)` / `runPromiseWith` / `runPromiseExit`.
            if (obj.type === "Identifier" && obj.name === "Effect") {
              if (!EFFECT_RUN_METHODS.has(prop.name)) return
              context.report({
                message: `\`Effect.${prop.name}\` may only be called inside a \`*-boundary.ts\` file or via \`runSdkBoundary(boundary)\`. Wrap the Effect with \`sdkBoundary("label", effect)\` and call it from a boundary module.`,
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
            if (!RUNTIME_RUN_METHODS.has(prop.name)) return
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
              message: `\`${runtimeName}.${prop.name}\` is a runtime-instance Promise edge — it may only be called inside a \`*-boundary.ts\` file or via \`runSdkBoundary(boundary)\`. Move the call into a boundary module.`,
              node,
            })
          },
        }
      },
    },

    /**
     * Flags plain `class X extends Error` declarations whose name ends in
     * `Error` or `Failure`. The substrate requires every error to extend
     * `Schema.TaggedErrorClass` so it carries a discriminator and a Schema.
     *
     * Valid:   class FooError extends Schema.TaggedErrorClass<FooError>(...)(...)
     * Invalid: class FooError extends Error
     *
     * NOTE: AST-only check; cannot follow re-exports or aliased base classes.
     */
    "all-errors-are-tagged": {
      create(context) {
        return {
          ClassDeclaration(node) {
            const id = node.id
            if (id === null || id === undefined || id.type !== "Identifier") return
            const name = id.name
            if (typeof name !== "string") return
            if (!/(?:Error|Failure)$/.test(name)) return
            const sup = node.superClass
            if (sup === null || sup === undefined) return
            // Plain Error
            if (sup.type === "Identifier" && sup.name === "Error") {
              context.report({
                message: `\`${name}\` must extend \`Schema.TaggedErrorClass\`, not the plain \`Error\` class. Tagged errors carry a discriminator and a Schema; plain Error subclasses cause Effect's typed error channel to lose information.`,
                node,
              })
            }
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
     * of a typed `ExtensionLoadError` on the Effect channel. The B7 fix
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
     * NOTE: C0 ships the rule; C8 introduces `definePackage` whose setup is
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
              visit(n[key])
            }
          }
          // Don't apply the function-boundary stop to the immediate setup body
          // (it IS the function), only to its descendants.
          visit(fn.body)
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
     * Flags `// R = never` and `// R: never` comments at provider/SDK edges.
     * The presence of such a comment is a smell that the file is crossing into
     * Promise-land without using the typed `SdkBoundary<E>` brand.
     *
     * Migration: wrap the Effect with `sdkBoundary("label", effect)` and call
     * `runSdkBoundary(boundary)` (or move the call site into `*-boundary.ts`).
     *
     * NOTE: AST-only inspection of leading comments on the program. Comments
     * deep in function bodies are caught by walking the program's `comments`
     * array if the parser surfaces it.
     */
    "no-r-equals-never-comment": {
      create(context) {
        const filename = context.filename
        // Allow inside any *-boundary.ts file (the convention for SDK edges)
        if (/-boundary\.ts$/.test(filename)) return {}
        // Allow the lint plugin file itself (rule definition references the matched pattern in messages)
        if (/\/lint\/[^/]+\.ts$/.test(filename) && !/\/fixtures\//.test(filename)) return {}
        // Allow the SdkBoundary domain module itself (its docstring describes the migration target)
        if (/\/domain\/sdk-boundary\.ts$/.test(filename)) return {}
        // Allow tests
        if (/\/tests\//.test(filename)) return {}
        if (/\.test\.tsx?$/.test(filename)) return {}
        // The SDK-boundary allow-list previously sat here as well. After B11.2
        // every Promise edge lives behind a `*-boundary.ts` file (caught by
        // the `-boundary.ts$` allow above), so the list is empty. New
        // boundary helpers should follow the same convention rather than
        // re-introduce an allow-list.
        return {
          Program(node) {
            // Comments live on `sourceCode.getAllComments()` in the oxlint plugin
            // surface, not on the Program node directly.
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- oxlint plugin context exposes sourceCode outside public types
            const ctx = context as unknown as {
              sourceCode?: { getAllComments?: () => ReadonlyArray<unknown> }
            }
            const getAll = ctx.sourceCode?.getAllComments
            if (typeof getAll !== "function") return
            const comments = getAll.call(ctx.sourceCode)
            for (const c of comments) {
              if (!isAstNode(c)) continue
              const value = getStringField(c, "value")
              if (typeof value !== "string") continue
              if (/\bR\s*[:=]\s*never\b/.test(value)) {
                context.report({
                  message: `Drop the inline R-channel annotation comment at SDK edges. Wrap the Effect with \`sdkBoundary("label", effect)\` and consume via \`runSdkBoundary(boundary)\` so the boundary is structurally enforced.`,
                  node: c,
                })
              }
            }
            // `node` parameter intentionally unused — comments are global to the file.
            void node
          },
        }
      },
    },

    /**
     * Restrict scope-brand constructors (`brandServerScope`, `brandCwdScope`,
     * `brandEphemeralScope`) to their authorised composition-root files.
     *
     * The brand constructors in `runtime/scope-brands.ts` are plain casts —
     * TypeScript cannot prevent a foreign caller from forging a brand. Lint
     * fences calls to these functions at the file level: only the documented
     * composition root for each scope may call its brander.
     *
     * Authorised callers:
     *   - `brandServerScope`     → `packages/core/src/server/dependencies.ts`
     *   - `brandCwdScope`        → `packages/core/src/runtime/session-profile.ts`
     *   - `brandEphemeralScope`  → `packages/core/src/runtime/composer.ts`
     *     (the only sanctioned ephemeral-profile factory; `agent-runner.ts`
     *     calls it via `RuntimeComposer.ephemeral(...).build()`)
     *
     * The rule also exempts the `scope-brands.ts` module itself (where the
     * functions are defined) and tests.
     */
    "brand-constructor-callers": {
      create(context) {
        const filename = context.filename
        if (/\/runtime\/scope-brands\.ts$/.test(filename)) return {}
        if (/\/tests\//.test(filename)) return {}
        if (/\.test\.tsx?$/.test(filename)) return {}

        const ALLOWED: Record<string, RegExp> = {
          brandServerScope: /\/server\/dependencies\.ts$/,
          brandCwdScope: /\/runtime\/session-profile\.ts$/,
          brandEphemeralScope: /\/runtime\/composer\.ts$/,
        }
        return {
          CallExpression(node) {
            if (node.callee.type !== "Identifier") return
            const name = node.callee.name
            const allowedPattern = ALLOWED[name]
            if (allowedPattern === undefined) return
            if (allowedPattern.test(filename)) return
            context.report({
              message: `\`${name}\` may only be called from its authorised composition-root file (${allowedPattern.source}). Brand constructors are casts; lint enforces what the type system cannot.`,
              node,
            })
          },
        }
      },
    },

    /**
     * Sibling fence to `brand-constructor-callers`: catches the
     * `as ServerProfile|CwdProfile|EphemeralProfile` escape hatch.
     *
     * The brand types are nominal *casts*, so a caller can bypass the
     * brand-constructor lint by writing `someObj as ServerProfile`. The
     * brand-constructor rule only fences direct identifier calls; this rule
     * fences the type-assertion form. Together they close the loop.
     *
     * Same allow-list as the constructor rule, plus the scope-brands module
     * itself (it owns the type definitions).
     */
    "no-scope-brand-cast": {
      create(context) {
        const filename = context.filename
        if (/\/runtime\/scope-brands\.ts$/.test(filename)) return {}
        if (/\/tests\//.test(filename)) return {}
        if (/\.test\.tsx?$/.test(filename)) return {}

        const ALLOWED: Record<string, RegExp> = {
          ServerProfile: /\/server\/dependencies\.ts$/,
          CwdProfile: /\/runtime\/session-profile\.ts$/,
          EphemeralProfile: /\/runtime\/composer\.ts$/,
        }
        const SCOPE_TYPES = new Set([
          "ServerProfile",
          "CwdProfile",
          "EphemeralProfile",
          "ServerScope",
          "CwdScope",
          "EphemeralScope",
        ])

        const checkTypeAnnotation = (typeAnnNode: AstNode | undefined, reportNode: AstNode) => {
          if (typeAnnNode === undefined) return
          // Walk down: `TSAsExpression.typeAnnotation` is a TSType node like TSTypeReference
          if (typeAnnNode.type !== "TSTypeReference") return
          const name = getNodeField(typeAnnNode, "typeName")
          if (name === undefined || name.type !== "Identifier") return
          const typeName = getStringField(name, "name")
          if (typeName === undefined || !SCOPE_TYPES.has(typeName)) return
          const allowedPattern = ALLOWED[typeName]
          if (allowedPattern !== undefined && allowedPattern.test(filename)) return
          context.report({
            message: `Cast to scope-brand type \`${typeName}\` is forbidden — call the authorised brand constructor instead. The brand types are nominal proofs-of-origin; bypassing the constructor defeats the type-system fence \`gent/brand-constructor-callers\` enforces at the function-call level.`,
            node: reportNode,
          })
        }

        return {
          TSAsExpression(node) {
            checkTypeAnnotation(getNodeField(node, "typeAnnotation"), node)
          },
          TSTypeAssertion(node) {
            checkTypeAnnotation(getNodeField(node, "typeAnnotation"), node)
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
     * Allowed: a small allow-list of files where dynamic loading is the
     * documented architectural choice (extension plugin discovery via
     * filesystem scan, optional native-module fallback).
     *
     * Valid:   import { foo } from "./foo.js"
     * Invalid: const foo = await import("./foo.js")
     * Invalid: const fs = require("node:fs")
     *
     * Allow-list entries each carry a justification comment in
     * {@link DYNAMIC_IMPORT_ALLOWED}; new entries require a comment naming
     * the architectural reason.
     */
    "no-dynamic-imports": {
      create(context) {
        const filename = context.filename

        // Allow lint plugin file itself (rule definition references the API in messages)
        if (/\/lint\/[^/]+\.ts$/.test(filename) && !/\/fixtures\//.test(filename)) return {}

        const DYNAMIC_IMPORT_ALLOWED = [
          // Extension plugin loaders: walk the filesystem and dynamically
          // import user/project extensions discovered at runtime. The set of
          // extensions is unknown at build time by design.
          "apps/tui/src/extensions/loader-boundary.ts",
          "packages/core/src/runtime/extensions/loader.ts",
          // Optional native git binding: gracefully degrades when the native
          // module isn't installed. Static import would harden the dependency.
          "packages/extensions/src/librarian/git-reader.ts",
          // Optional native filesystem indexer: same fallback rationale as above.
          "packages/core/src/runtime/file-index/native-adapter.ts",
        ]
        if (DYNAMIC_IMPORT_ALLOWED.some((f) => filename.endsWith(f))) return {}

        return {
          ImportExpression(node) {
            context.report({
              message: `Dynamic \`import(...)\` is forbidden — use a top-level static import. Dynamic imports defeat static analysis and break the compiled-binary build (Bun.build cannot resolve runtime-determined module paths). If your use case is a documented architectural exception, add the file to the allow-list in \`lint/no-direct-env.ts\` with a justification comment.`,
              node,
            })
          },
          CallExpression(node) {
            const callee: unknown = node.callee
            if (!isAstNode(callee)) return
            const kind = classifyDynamicLoadCall(callee)
            if (kind === undefined) return
            context.report({ message: DYNAMIC_LOAD_MESSAGES[kind], node })
          },
        }
      },
    },

    /**
     * Bans new `try/finally`, `async`, and `await` control flow in test files.
     *
     * Tests should model resource lifetime with Effect scopes so cleanup runs
     * through finalizers, composes with `it.live` / `Effect.scoped`, and stays
     * visible in the Effect graph. For temporary directories, prefer
     * `FileSystem.FileSystem.makeTempDirectoryScoped()` with the platform
     * filesystem layer. For custom resources, use `Effect.acquireRelease`.
     *
     * This rule is zero-tolerance: test files must not use Promise control
     * flow for setup, teardown, or assertions.
     */
    "no-promise-control-flow-in-tests": {
      create(context) {
        const filename = context.filename
        if (!isTestFilename(filename)) return {}

        return {
          TryStatement(node) {
            if (node.finalizer == null) return
            context.report({
              message:
                "Do not use `try/finally` cleanup in tests. Put resource lifetime in the Effect scope instead: `Effect.scoped`, `FileSystem.makeTempDirectoryScoped()`, or `Effect.acquireRelease`.",
              node,
            })
          },
          FunctionDeclaration(node) {
            if (node.async !== true) return
            context.report({
              message:
                "Do not use `async` test functions. Return an Effect through `it.live` / `Effect.scoped`, or use Effect runtime helpers at an explicit boundary.",
              node,
            })
          },
          FunctionExpression(node) {
            if (node.async !== true) return
            context.report({
              message:
                "Do not use `async` test functions. Return an Effect through `it.live` / `Effect.scoped`, or use Effect runtime helpers at an explicit boundary.",
              node,
            })
          },
          ArrowFunctionExpression(node) {
            if (node.async !== true) return
            context.report({
              message:
                "Do not use `async` test functions. Return an Effect through `it.live` / `Effect.scoped`, or use Effect runtime helpers at an explicit boundary.",
              node,
            })
          },
          AwaitExpression(node) {
            context.report({
              message:
                "Do not use `await` in tests. Stay in Effect with `yield*`, `it.live`, and scoped resources instead of Promise control flow.",
              node,
            })
          },
        }
      },
    },

    /**
     * Heuristic AST-name-match fence on `QueryContribution.handler` AND
     * read-intent `CapabilityContribution.effect` for write-shaped method
     * calls (`.create(`, `.update(`, `.delete(`, `.set(`, `.write(`, etc.).
     *
     * Projections are NOT covered here — B11.4 replaced the heuristic for
     * projections with a structural type fence: `ProjectionContribution<A,
     * R extends ReadOnlyTag>` makes write-capable Tags fail to compile in
     * the projection R channel. See `domain/read-only.ts` and
     * `domain/projection.ts`.
     *
     * Query/capability coverage stays heuristic until B11.5 introduces the
     * `request({ intent: "read" })` factory whose R channel can be branded
     * the same way.
     *
     * Valid:   handler: () => MyService.get(id)
     * Invalid: handler: () => MyService.update(id, ...)
     *
     * Limitations: AST-only, no symbol resolution. False positives possible
     * (e.g. `Set#add`, `Map#set` on local collections). Suppress with
     * `// eslint-disable-next-line gent/no-projection-writes` when the call is
     * provably local. Doesn't follow handlers defined as external function refs.
     */
    "no-projection-writes": {
      create(context) {
        const reportWritesIn = (kind: "Query" | "Capability", fn: AstNode): void => {
          const bodyNameByKind: Record<"Query" | "Capability", string> = {
            Query: "`handler`",
            Capability: "`effect`",
          }
          const remediationByKind: Record<"Query" | "Capability", string> = {
            Query: "Use a Mutation or Workflow contribution for state changes.",
            Capability: 'Switch `intent` to `"write"` for state changes.',
          }
          walkAst(fn.body, (inner) => {
            const methodName = writeCallMethod(inner)
            if (methodName === undefined) return
            context.report({
              message: `${kind} ${bodyNameByKind[kind]} must be read-only — call to \`.${methodName}(\` looks like a write. ${remediationByKind[kind]}`,
              node: inner,
            })
          })
        }
        // Locate the read-only body of an object literal — `handler` for
        // queries, `effect` for read capabilities. Returns undefined when
        // the literal is not a recognized authoring shape (e.g., a write
        // capability, which is opted out of the fence).
        const findCapabilityReadEffect = (objExpr: AstNode): AstNode | undefined => {
          const intent = intentLiteral(objExpr)
          if (intent !== "read") return undefined
          return findArrowInObject(objExpr, "effect")
        }
        return {
          // Query / read-intent capability — factory call form
          CallExpression(node) {
            if (!isAstNode(node)) return
            if (queryFactoryName(node) !== undefined) {
              const handlerFn = findArrowInFirstArg(node, "handler")
              if (handlerFn !== undefined) reportWritesIn("Query", handlerFn)
              return
            }
            if (capabilityFactoryName(node) !== undefined) {
              if (intentLiteralInFirstArg(node) !== "read") return
              const effectFn = findArrowInFirstArg(node, "effect")
              if (effectFn !== undefined) reportWritesIn("Capability", effectFn)
            }
          },
          VariableDeclarator(node) {
            if (!isAstNode(node)) return
            const id = getNodeField(node, "id")
            if (id === undefined) return
            const typeAnn = getNodeField(id, "typeAnnotation")
            const init = getNodeField(node, "init")
            if (init === undefined) return
            if (isQueryTypeRef(typeAnn)) {
              const handlerFn = findArrowInObject(init, "handler")
              if (handlerFn !== undefined) reportWritesIn("Query", handlerFn)
              return
            }
            if (isCapabilityTypeRef(typeAnn)) {
              const effectFn = findCapabilityReadEffect(init)
              if (effectFn !== undefined) reportWritesIn("Capability", effectFn)
            }
          },
          TSSatisfiesExpression(node) {
            if (!isAstNode(node)) return
            const typeAnn = getNodeField(node, "typeAnnotation")
            const expr = getNodeField(node, "expression")
            if (expr === undefined) return
            if (isQueryTypeRef(typeAnn)) {
              const handlerFn = findArrowInObject(expr, "handler")
              if (handlerFn !== undefined) reportWritesIn("Query", handlerFn)
              return
            }
            if (isCapabilityTypeRef(typeAnn)) {
              const effectFn = findCapabilityReadEffect(expr)
              if (effectFn !== undefined) reportWritesIn("Capability", effectFn)
            }
          },
        }
      },
    },

    /**
     * Flags hand-rolled `_tag` discriminated unions written as type
     * literals — a union of two-or-more `{ _tag: "X"; ... }` shapes.
     *
     * Use `TaggedEnumClass` (`@gent/core/domain/schema-tagged-enum-class`),
     * `Schema.TaggedStruct`, or `Schema.TaggedErrorClass` instead. Those
     * give per-variant `.make({...})` constructors, structural
     * `_tag` discrimination, and Schema-encode/decode for free.
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
          // metadata. TaggedEnumClass member names are PascalCase by
          // convention.
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
                "Hand-rolled `_tag` discriminated union — use `TaggedEnumClass` from `@gent/core/domain/schema-tagged-enum-class` (or `Schema.TaggedStruct` / `Schema.TaggedErrorClass`). Construct via `Variant.make({...})`. See packages/core/CLAUDE.md.",
              node,
            })
          },
        }
      },
    },
  },
}

export default plugin
