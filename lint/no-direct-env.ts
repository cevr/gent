/**
 * Oxlint JS plugin: gent custom rules
 *
 * Rules:
 * - no-positional-log-error: flags Effect.logWarning("msg", error) (use annotateLogs)
 * - no-extension-internal-imports: keeps extension code on the public
 *   @gent/core/extensions/api surface and off @gent/core internals, with
 *   narrow builtin platform exceptions.
 * - no-promise-control-flow-in-tests: bans new `try/finally`, `async`,
 *   `await`, and Promise chains in test files.
 *   Test resources should live in Effect scopes (`Effect.scoped`,
 *   `FileSystem.makeTempDirectoryScoped`, `Effect.acquireRelease`, etc.).
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
 * - no-with-wrapper-call: bans `withX(otherCall(...))` and
 *   `withX(...)(otherCall(...))` wrapper-call style; pipe the inner Effect/value
 *   through the adapter instead.
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null

const getLocLine = (node: AstNode, edge: "start" | "end"): number | undefined => {
  const loc = node.loc
  if (!isRecord(loc)) return undefined
  const point = loc[edge]
  if (!isRecord(point)) return undefined
  const line = point.line
  return typeof line === "number" ? line : undefined
}

const isTestFilename = (filename: string): boolean =>
  /\.test\.tsx?$/.test(filename) || /\/tests\/.*\.[cm]?tsx?$/.test(filename)

const isTestBoundaryFilename = (filename: string): boolean => /-boundary\.tsx?$/.test(filename)

const PROMISE_CHAIN_METHODS = new Set(["then", "catch", "finally"])
const PROMISE_STATIC_METHODS = new Set(["all", "allSettled", "any", "race", "resolve", "reject"])

const promiseChainMethodName = (node: AstNode): string | undefined => {
  if (node.type !== "CallExpression") return undefined
  const callee = getNodeField(node, "callee")
  if (callee?.type !== "MemberExpression") return undefined
  const object = getNodeField(callee, "object")
  if (object?.type === "Identifier" && getStringField(object, "name") === "Effect") {
    return undefined
  }
  const prop = getNodeField(callee, "property")
  if (prop?.type !== "Identifier") return undefined
  const name = getStringField(prop, "name")
  return name !== undefined && PROMISE_CHAIN_METHODS.has(name) ? name : undefined
}

const promiseStaticMethodName = (node: AstNode): string | undefined => {
  if (node.type !== "CallExpression") return undefined
  const callee = getNodeField(node, "callee")
  if (callee?.type !== "MemberExpression") return undefined
  const object = getNodeField(callee, "object")
  if (object?.type !== "Identifier" || getStringField(object, "name") !== "Promise") {
    return undefined
  }
  const prop = getNodeField(callee, "property")
  if (prop?.type !== "Identifier") return undefined
  const name = getStringField(prop, "name")
  return name !== undefined && PROMISE_STATIC_METHODS.has(name) ? name : undefined
}

const RUN_PROMISE_METHODS = new Set(["runPromise", "runPromiseWith", "runPromiseExit"])

const runPromiseMethodName = (node: AstNode): string | undefined => {
  if (node.type !== "MemberExpression") return undefined
  const prop = getNodeField(node, "property")
  if (prop?.type !== "Identifier") return undefined
  const name = getStringField(prop, "name")
  return name !== undefined && RUN_PROMISE_METHODS.has(name) ? name : undefined
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
  const args = node.arguments
  if (!Array.isArray(args)) return []
  return args.filter(isAstNode)
}

const unaryCallExpressionArg = (node: AstNode): AstNode | undefined => {
  const args = callExpressionArgs(node)
  if (args.length !== 1) return undefined
  const [arg] = args
  return arg?.type === "CallExpression" ? arg : undefined
}

const withWrapperCallName = (node: AstNode): string | undefined => {
  if (node.type !== "CallExpression") return undefined
  const callee = getNodeField(node, "callee")
  const directName = wrapperFunctionName(callee)
  // `withWideEvent(boundaryFactory(...))` is an adapter factory used inside
  // `.pipe(...)`, not a wrapper around the Effect being transformed.
  if (directName !== undefined && directName !== "withWideEvent" && unaryCallExpressionArg(node)) {
    return directName
  }

  if (callee?.type !== "CallExpression") return undefined
  const higherOrderName = wrapperFunctionName(getNodeField(callee, "callee"))
  if (higherOrderName !== undefined && unaryCallExpressionArg(node)) return higherOrderName
  return undefined
}

const isPromiseConstructor = (node: AstNode): boolean => {
  if (node.type !== "NewExpression") return false
  const callee = getNodeField(node, "callee")
  return callee?.type === "Identifier" && getStringField(callee, "name") === "Promise"
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

const plugin: Plugin = {
  meta: {
    name: "gent",
  },
  rules: {
    /**
     * Enforces the extension boundary contract.
     *
     * Public extension-facing code may import from:
     *   - `./api.js` or `../api.js` (relative to extension file in core)
     *   - `@gent/core/extensions/api` (package path, for extracted extensions)
     *   - `effect-machine`, `effect`, `@effect/*` (peer deps)
     *   - Sibling extension files (relative `./` or `../` within extensions/src/)
     *
     * Public-looking @gent/core internals are always forbidden:
     *   - `@gent/core/domain/*`, `@gent/core/runtime/*`, `@gent/core/storage/*`,
     *     `@gent/core/server/*`, `@gent/core/providers/*`
     *   - Relative paths that escape into domain/, runtime/, storage/, etc.
     *
     * `@gent/core-internal/*` is forbidden for public extension implementations,
     * except the narrow builtin platform boundary imports. Builtins are just the
     * starting extension set, not a privileged API lane for domain/runtime
     * services.
     *
     * Applies to: packages/core/src/extensions/**, packages/extensions/src/**,
     * and apps/tui/src/extensions/**
     * Exempt: extensions/api.ts (the builder implementation)
     */
    "no-extension-internal-imports": {
      create(context) {
        const filename = context.filename

        // Scope: only extension implementation files
        const inCoreExtensions = filename.includes("packages/core/src/extensions/")
        const inExtensionsPackage = filename.includes("packages/extensions/src/")
        const inTuiExtensions = filename.includes("apps/tui/src/extensions/")
        if (!inCoreExtensions && !inExtensionsPackage && !inTuiExtensions) return {}

        // Exempt: the public bridge implementations. They live inside
        // `packages/core/src/extensions/` but ARE the re-export surfaces other
        // extensions consume, so they need to reach into core internals to
        // assemble the public API. `api.ts` serves extensions that use the
        // loop; `branch-tools.ts` serves the feature that implements a loop
        // seam.
        if (
          filename.endsWith("/extensions/api.ts") ||
          filename.endsWith("/extensions/branch-tools.ts")
        ) {
          return {}
        }

        // Relative imports that escape into core internals
        const INTERNAL_RELATIVE =
          /^\.\.?\/(\.\.\/)*(?:domain|runtime|storage|server|providers|core\/src)\//

        // Allowed @gent/core subpaths (everything else is forbidden).
        // Two authoring entry points: `api` for extensions that use the loop,
        // `branch-tools` for the rarer feature that implements a loop seam.
        const ALLOWED_PACKAGE = /^@gent\/core\/extensions\/(?:api|branch-tools)(?:\.js)?$/
        const ALLOWED_CLIENT_PROTOCOL = /^@gent\/core\/protocol(?:\.js)?$/
        const ALLOWED_BUILTIN_INTERNAL_PACKAGE =
          /^@gent\/core-internal\/runtime\/gent-platform(?:-bun)?(?:\.js)?$/

        const reportForbiddenSource = (node: AstNode, source: string) => {
          if (INTERNAL_RELATIVE.test(source)) {
            context.report({
              message: `Extensions must import from the public API (./api.js), not core internals. Forbidden: "${source}"`,
              node,
            })
            return
          }

          if (
            source.startsWith("@gent/core-internal") &&
            (inCoreExtensions || inExtensionsPackage) &&
            !(inExtensionsPackage && ALLOWED_BUILTIN_INTERNAL_PACKAGE.test(source))
          ) {
            context.report({
              message: `Extensions must import from "@gent/core/extensions/api", not @gent/core-internal. Forbidden: "${source}"`,
              node,
            })
            return
          }

          if (
            source.startsWith("@gent/core/") &&
            !ALLOWED_PACKAGE.test(source) &&
            !(inTuiExtensions && ALLOWED_CLIENT_PROTOCOL.test(source))
          ) {
            context.report({
              message: `Extensions must import from "@gent/core/extensions/api", not internal paths. Forbidden: "${source}"`,
              node,
            })
          }
        }

        const sourceValue = (node: AstNode): string | undefined => {
          const source = getNodeField(node, "source")
          if (source === undefined) return undefined
          return getStringField(source, "value")
        }

        return {
          ImportDeclaration(node) {
            const source = sourceValue(node)
            if (source !== undefined) reportForbiddenSource(node, source)
          },
          ExportNamedDeclaration(node) {
            const source = sourceValue(node)
            if (source !== undefined) reportForbiddenSource(node, source)
          },
          ExportAllDeclaration(node) {
            const source = sourceValue(node)
            if (source !== undefined) reportForbiddenSource(node, source)
          },
          ImportExpression(node) {
            const source = sourceValue(node)
            if (source !== undefined) reportForbiddenSource(node, source)
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
     * Flags `withX(otherCall(...))` and `withX(...)(otherCall(...))`.
     *
     * The wrapper form hides the value/function being transformed behind the
     * adapter. Prefer `otherCall(...).pipe(withX)` or `otherCall(...).pipe(withX(...))`
     * so the transformation order reads left-to-right.
     */
    "no-with-wrapper-call": {
      create(context) {
        return {
          CallExpression(node) {
            const name = withWrapperCallName(node)
            if (name === undefined) return
            context.report({
              message: `Avoid \`${name}(...innerCall)\` wrapper style. Pipe the inner call through \`${name}\` instead.`,
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
        if (/\/tests\//.test(filename)) return {}
        if (/\.test\.tsx?$/.test(filename)) return {}
        // Allow lint plugin file itself (rule definitions reference the API in messages)
        if (/\/lint\/[^/]+\.ts$/.test(filename) && !/\/fixtures\//.test(filename)) return {}

        // Effect static methods that exit the Effect world via Promise/fiber
        // — the boundary contract treats these as edges that must live in
        // `*-boundary.ts`. `runSync`/`runFork`/`runForkWith` are NOT in this
        // set: they're Effect-internal (no Promise edge) and used heavily by
        // Solid signal lanes, PubSub.unbounded eager-build, etc. — adding
        // them would force a much wider boundary refactor.
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

        const getComments = (): ReadonlyArray<AstNode> => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- oxlint plugin context exposes sourceCode outside public types
          const ctx = context as unknown as {
            sourceCode?: { getAllComments?: () => ReadonlyArray<unknown> }
          }
          const getAll = ctx.sourceCode?.getAllComments
          if (typeof getAll !== "function") return []
          return getAll.call(ctx.sourceCode).filter(isAstNode)
        }

        const hasAllowComment = (node: AstNode): boolean => {
          const startLine = getLocLine(node, "start")
          if (startLine === undefined) return false
          return getComments().some((comment) => {
            const endLine = getLocLine(comment, "end")
            if (endLine === undefined || endLine !== startLine - 1) return false
            const value = getStringField(comment, "value")
            return value !== undefined && /\bgent\/no-dynamic-imports:\s*allow\s+\S/.test(value)
          })
        }

        const reportUnlessAllowed = (node: AstNode, message: string): void => {
          if (hasAllowComment(node)) return
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
     * Bans new `try/finally`, `async`, `await`, and Promise-chain control
     * flow in test files.
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
        if (isTestBoundaryFilename(filename)) return {}

        return {
          TryStatement(node) {
            if (node.finalizer == null) return
            context.report({
              message:
                "Do not use `try/finally` cleanup in tests. Import `it` from `effect-bun-test` and put lifetime in the Effect scope: `it.scopedLive(...)`, `FileSystem.makeTempDirectoryScoped()`, or `Effect.acquireRelease(...)`.",
              node,
            })
          },
          FunctionDeclaration(node) {
            if (node.async !== true) return
            context.report({
              message:
                'Do not use `async` test functions. Import `it` from `effect-bun-test` and return an Effect: `it.live("name", () => Effect.gen(function* () { ... }))` or `it.scopedLive` for scoped resources.',
              node,
            })
          },
          FunctionExpression(node) {
            if (node.async !== true) return
            context.report({
              message:
                'Do not use `async` test functions. Import `it` from `effect-bun-test` and return an Effect: `it.live("name", () => Effect.gen(function* () { ... }))` or `it.scopedLive` for scoped resources.',
              node,
            })
          },
          ArrowFunctionExpression(node) {
            if (node.async !== true) return
            context.report({
              message:
                'Do not use `async` test functions. Import `it` from `effect-bun-test` and return an Effect: `it.live("name", () => Effect.gen(function* () { ... }))` or `it.scopedLive` for scoped resources.',
              node,
            })
          },
          AwaitExpression(node) {
            context.report({
              message:
                "Do not use `await` in tests. Import `it` from `effect-bun-test`; use `yield*` inside `Effect.gen`, `Effect.promise` only at real async boundaries, and scoped resources for cleanup.",
              node,
            })
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
            const method = promiseChainMethodName(node)
            if (method !== undefined) {
              context.report({
                message: `Do not use Promise-chain \`.${method}(...)\` control flow in tests. Import \`it\` from \`effect-bun-test\`; use \`yield*\` in \`Effect.gen\`, \`Effect.all([...])\` for concurrency, and \`Effect.scoped\` / \`it.scopedLive\` for cleanup.`,
                node,
              })
              return
            }
            const staticMethod = promiseStaticMethodName(node)
            if (staticMethod === undefined) return
            context.report({
              message: `Do not use \`Promise.${staticMethod}(...)\` in tests. Use \`Effect.all([...], { concurrency: ... })\` for aggregation, \`Effect.succeed\` / \`Effect.fail\` for values, and \`Deferred\` for test coordination.`,
              node,
            })
          },
          NewExpression(node) {
            if (!isAstNode(node) || !isPromiseConstructor(node)) return
            context.report({
              message:
                "Do not construct raw Promises in tests. Import `it` from `effect-bun-test`; use `Deferred` for coordination, `Effect.sleep` for delays, `Effect.async` for callback APIs, or `Effect.promise` only at a real external async boundary.",
              node,
            })
          },
        }
      },
    },

    /**
     * Bans `Bun.*` references everywhere except platform adapter,
     * entrypoint, tooling, and test harness boundaries. The `Bun` global is
     * a platform-specific runtime API; product code must route through
     * Effect platform services (`GentPlatform`, `FileSystem`,
     * `ChildProcess`, `KeyValueStore`, `Config`) so the runtime is
     * portable and the I/O boundary is explicit.
     *
     * Exempt by filename:
     *   - `runtime/gent-platform-bun.ts` (the GentPlatform live impl)
     *   - `*-adapter.ts` / `*-adapter.tsx` files (platform-specific adapters)
     *   - `**\/scripts/**` (build/dev entrypoints)
     *   - `**\/packages/tooling/**` (CI helpers)
     *   - `**\/packages/e2e/**` (test infrastructure spawning real processes)
     *   - `**\/packages/sdk/**` (supervisor primitives talk to Bun.spawn directly)
     *   - `**\/main.ts` (process entrypoints)
     *   - `*.test.ts` and files under `tests/`
     */
    "no-bun-outside-adapter": {
      create(context) {
        const filename = context.filename
        // Fixtures must run through the rule even though they sit under
        // `packages/tooling/fixtures/` — they exist precisely to verify rule
        // behavior. Exclude that subtree from the tooling allowlist below.
        const inFixtures = /\/packages\/tooling\/fixtures\//.test(filename)
        if (!inFixtures) {
          if (/\/runtime\/gent-platform-bun\.ts$/.test(filename)) return {}
          if (/-adapter\.tsx?$/.test(filename)) return {}
          if (/\/scripts\//.test(filename)) return {}
          if (/\/packages\/tooling\//.test(filename)) return {}
          if (/\/packages\/e2e\//.test(filename)) return {}
          if (/\/packages\/sdk\//.test(filename)) return {}
          if (/\/main\.ts$/.test(filename)) return {}
          if (/\/tests\//.test(filename)) return {}
          if (/\.test\.tsx?$/.test(filename)) return {}
        } else {
          // Inside fixtures: only the canonical platform file is exempted,
          // so valid-adapter fixtures must use exact adapter filenames.
          if (/\/runtime\/gent-platform-bun\.ts$/.test(filename)) return {}
          if (/-adapter\.tsx?$/.test(filename)) return {}
        }
        return {
          MemberExpression(node) {
            if (!isAstNode(node)) return
            const object = getNodeField(node, "object")
            if (object?.type !== "Identifier") return
            const prop = getNodeField(node, "property")
            let propName: string | undefined
            if (prop?.type === "Identifier") propName = getStringField(prop, "name")
            else if (prop?.type === "StringLiteral") propName = getStringField(prop, "value")
            const objectName = getStringField(object, "name")
            if (objectName === "process") {
              if (propName !== "execPath" && propName !== "kill" && propName !== "platform") return
              const suffix = propName !== undefined ? `.${propName}` : ""
              context.report({
                message: `\`process${suffix}\` is not allowed here. Route host process and OS access through \`GentPlatform\` or an adapter-local Effect service.`,
                node,
              })
              return
            }
            if (objectName !== "Bun") return
            const suffix = propName !== undefined ? `.${propName}` : ""
            context.report({
              message: `\`Bun${suffix}\` is not allowed here. Route platform I/O through an Effect service (e.g., \`GentPlatform\`, \`FileSystem\`, \`ChildProcess\`, \`KeyValueStore\`, \`Config\`). Bun APIs are allowed only in adapter, entrypoint, tooling, and test harness boundaries.`,
              node,
            })
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
     * files (`*.test.ts`, `*.test.tsx`, `tests/**`) and test-adjacent
     * fixtures (`pty-fixture.ts`, `server-process-fixture.ts`, `helpers.ts`
     * inside `tests/`, `helpers-boundary.ts`). The rule does NOT apply to
     * product code — production retries/timeouts/debounces are unaffected.
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
              const value = inner["value"]
              if (!isRecord(value)) return
              const cooked = value["cooked"]
              const raw = value["raw"]
              const text = typeof cooked === "string" ? cooked : raw
              if (typeof text === "string" && TIMEOUT_TEXT.test(text)) found = true
            }
          })
          return found
        }

        const filename = context.filename
        if (!isTestFilename(filename) && !isTestBoundaryFilename(filename)) {
          const inTestsTree = /\/tests\//.test(filename)
          const inIntegrationTree = /\/integration\//.test(filename)
          const inTestUtils = /\/test-utils\//.test(filename)
          if (!inTestsTree && !inIntegrationTree && !inTestUtils) return {}
        }

        const getComments = (): ReadonlyArray<AstNode> => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- oxlint plugin context exposes sourceCode outside public types
          const ctx = context as unknown as {
            sourceCode?: { getAllComments?: () => ReadonlyArray<unknown> }
          }
          const getAll = ctx.sourceCode?.getAllComments
          if (typeof getAll !== "function") return []
          return getAll.call(ctx.sourceCode).filter(isAstNode)
        }

        const hasAllowComment = (node: AstNode): boolean => {
          const startLine = getLocLine(node, "start")
          if (startLine === undefined) return false
          return getComments().some((comment) => {
            const endLine = getLocLine(comment, "end")
            if (endLine === undefined) return false
            if (endLine !== startLine - 1 && endLine !== startLine) return false
            const value = getStringField(comment, "value")
            return value !== undefined && /\bgent\/no-die-in-test-helpers:\s*allow\s+\S/.test(value)
          })
        }

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
            if (hasAllowComment(node)) return
            context.report({
              message: `\`Effect.${method}(...)\` in test code — a defect escapes the failing assertion and surfaces as "Unhandled error between tests", attributed to no test in particular. Fail with a typed error instead (\`Schema.TaggedError\`, then \`yield* new MyError({...})\`) so the timeout or precondition failure lands on the test that caused it. If this site genuinely models an unrecoverable defect, add \`// gent/no-die-in-test-helpers: allow <reason>\` on the line directly above the call.`,
              node,
            })
          },
        }
      },
    },
    "no-sleep": {
      create(context) {
        const filename = context.filename
        if (!isTestFilename(filename) && !isTestBoundaryFilename(filename)) {
          // Also cover test fixtures and helpers that don't end in
          // `.test.ts` but live alongside tests (`pty-fixture.ts`,
          // `server-process-fixture.ts`, `tests/.../helpers.ts`,
          // `integration/helpers.ts`).
          const inTestsTree = /\/tests\//.test(filename)
          const inIntegrationTree = /\/integration\//.test(filename)
          const isPackageE2eSrc = /\/packages\/e2e\/src\//.test(filename)
          if (!inTestsTree && !inIntegrationTree && !isPackageE2eSrc) return {}
        }
        // Fixtures directory verifies rule behavior — let the fixture
        // files participate normally (including the allow-comment carveout)
        // so the fixtures test can count diagnostics on the invalid fixture
        // and zero diagnostics on the valid fixture.

        const getComments = (): ReadonlyArray<AstNode> => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- oxlint plugin context exposes sourceCode outside public types
          const ctx = context as unknown as {
            sourceCode?: { getAllComments?: () => ReadonlyArray<unknown> }
          }
          const getAll = ctx.sourceCode?.getAllComments
          if (typeof getAll !== "function") return []
          return getAll.call(ctx.sourceCode).filter(isAstNode)
        }

        const hasAllowComment = (node: AstNode): boolean => {
          const startLine = getLocLine(node, "start")
          if (startLine === undefined) return false
          return getComments().some((comment) => {
            const endLine = getLocLine(comment, "end")
            if (endLine === undefined) return false
            // Allow either an immediately-preceding line OR a same-line
            // trailing comment.
            if (endLine !== startLine - 1 && endLine !== startLine) return false
            const value = getStringField(comment, "value")
            return value !== undefined && /\bgent\/no-sleep:\s*allow\s+\S/.test(value)
          })
        }

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
            if (hasAllowComment(node)) return
            context.report({
              message: `\`${objectName}.sleep(...)\` in test code — replace fixed delays with deterministic synchronisation: \`Deferred\` for coordination, \`controls.waitForCall(...)\` / \`controls.waitForStreamStart()\` for sequence-provider gating, or \`waitFor\` polling helpers for projection convergence. If this site is a real-clock timing assertion, OS-level fiber pacing, or a retry/backoff test, add \`// gent/no-sleep: allow <reason>\` on the line directly above the call.`,
              node,
            })
          },
        }
      },
    },
  },
}

export default plugin
