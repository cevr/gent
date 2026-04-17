/**
 * Oxlint JS plugin: gent custom rules
 *
 * Rules:
 * - no-direct-env: flags Bun.env["X"] / process.env.X (use Config from effect)
 * - no-positional-log-error: flags Effect.logWarning("msg", error) (use annotateLogs)
 * - no-extension-internal-imports: enforces extension boundary — extensions must import
 *   from @gent/core/extensions/api, not core internals (domain/, runtime/, etc.)
 * - no-projection-writes: enforces ProjectionContribution.query AND
 *                          QueryContribution.handler are read-only
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
 * - no-projection-write-services: type-aware fence on Projection's R channel
 *   for write-tagged services (sharpened replacement for no-projection-writes
 *   string-match — installed alongside, supersedes in C5)
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

const PROJECTION_FACTORY_NAMES = new Set(["projection", "projectionContribution"])
/** Query factory names — `QueryContribution.handler` is also enforced read-only by this rule. */
const QUERY_FACTORY_NAMES = new Set(["query", "queryContribution"])

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

const projectionFactoryName = (node: AstNode): string | undefined => {
  const name = calleeName(node)
  return name !== undefined && PROJECTION_FACTORY_NAMES.has(name) ? name : undefined
}

const queryFactoryName = (node: AstNode): string | undefined => {
  const name = calleeName(node)
  return name !== undefined && QUERY_FACTORY_NAMES.has(name) ? name : undefined
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

const PROJECTION_TYPE_NAMES = new Set(["ProjectionContribution", "AnyProjectionContribution"])
const QUERY_TYPE_NAMES = new Set(["QueryContribution", "AnyQueryContribution"])

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

const isProjectionTypeRef = (typeNode: AstNode | undefined): boolean =>
  isTypeRefIn(typeNode, PROJECTION_TYPE_NAMES)
const isQueryTypeRef = (typeNode: AstNode | undefined): boolean =>
  isTypeRefIn(typeNode, QUERY_TYPE_NAMES)

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

        // Exempt: api.ts is the bridge between internals and the public surface
        if (filename.endsWith("/extensions/api.ts")) return {}

        // Relative imports that escape into core internals
        const INTERNAL_RELATIVE = /^\.\.?\/(\.\.\/)*(?:domain|runtime|storage|server|providers)\//

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
        const KNOWN_BOUNDARY_FILES = [
          // Anthropic SDK fetcher + credential loader (driver flavor=model)
          "packages/extensions/src/anthropic/index.ts",
          "packages/extensions/src/anthropic/oauth.ts",
          // OpenAI SDK token-refresh callback (driver flavor=model)
          "packages/extensions/src/openai/index.ts",
          // ACP codemode JS sandbox tool runner (driver flavor=external)
          "packages/extensions/src/acp-agents/executor.ts",
          // SDK client and supervisor — Promise-returning public API
          "packages/sdk/src/client.ts",
          "packages/sdk/src/local-supervisor.ts",
          "packages/sdk/src/supervisor.ts",
          // TUI session-feed hook — fire-and-forget message refetch (C9 migrates)
          "apps/tui/src/hooks/use-session-feed.ts",
        ]
        if (KNOWN_BOUNDARY_FILES.some((f) => filename.endsWith(f))) return {}

        return {
          CallExpression(node) {
            if (node.callee.type !== "MemberExpression") return
            const obj = node.callee.object
            const prop = node.callee.property
            if (obj.type !== "Identifier" || obj.name !== "Effect") return
            if (prop.type !== "Identifier") return
            if (prop.name !== "runPromise" && prop.name !== "runPromiseWith") return
            context.report({
              message: `\`Effect.${prop.name}\` may only be called inside a \`*-boundary.ts\` file or via \`runSdkBoundary(boundary)\`. Wrap the Effect with \`sdkBoundary("label", effect)\` and call it from a boundary module.`,
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
        // Allow the lint plugin file itself (rule definition references the matched pattern in messages)
        if (/\/lint\/[^/]+\.ts$/.test(filename) && !/\/fixtures\//.test(filename)) return {}
        // Allow the SdkBoundary domain module itself (its docstring describes the migration target)
        if (/\/domain\/sdk-boundary\.ts$/.test(filename)) return {}
        // Allow tests
        if (/\/tests\//.test(filename)) return {}
        if (/\.test\.tsx?$/.test(filename)) return {}
        // Known SDK boundaries pending migration to *-boundary.ts file naming —
        // same allow-list as no-runpromise-outside-boundary. Each entry is removed
        // as the file migrates to the *-boundary.ts pattern.
        const KNOWN_BOUNDARY_FILES = [
          "packages/extensions/src/anthropic/index.ts",
          "packages/extensions/src/anthropic/oauth.ts",
          "packages/extensions/src/openai/index.ts",
          "packages/extensions/src/acp-agents/executor.ts",
          "packages/sdk/src/client.ts",
          "packages/sdk/src/local-supervisor.ts",
          "packages/sdk/src/supervisor.ts",
          "apps/tui/src/hooks/use-session-feed.ts",
        ]
        if (KNOWN_BOUNDARY_FILES.some((f) => filename.endsWith(f))) return {}
        return {
          Program(node) {
            // Comments live on `sourceCode.getAllComments()` in the oxlint plugin
            // surface, not on the Program node directly.
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
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
     * Type-aware fence on `ProjectionContribution`'s `R` channel for
     * write-tagged services. Sharpened replacement for the AST-string-match
     * `no-projection-writes` rule.
     *
     * NOTE: C0 stub. The full check requires the `ReadOnly` brand on service
     * tags (introduced in C5). Until then the rule reports nothing — the
     * existing `no-projection-writes` rule covers the runtime invariant via
     * write-method name matching.
     */
    "no-projection-write-services": {
      create() {
        // Stub — sharpened in C5 once the `ReadOnly` brand exists on service tags.
        return {}
      },
    },

    /**
     * Enforces that `ProjectionContribution.query` AND `QueryContribution.handler`
     * Effects are read-only — both are read surfaces; writes belong in
     * `MutationContribution.handler` or `WorkflowContribution`.
     *
     * Valid:   query:   () => MyService.list().pipe(Effect.map(...))
     *          handler: () => MyService.get(id)
     * Invalid: query:   () => MyService.create({ ... })
     *          handler: () => MyService.update(id, ...)
     *
     * Detection — for each authoring shape (factory call, typed binding, satisfies),
     * the rule walks the `query` body (projection) or `handler` body (query) for
     * member-call expressions whose method name matches a known write capability
     * (set, create, update, delete, write, etc.).
     *
     * Limitations: AST-only, no symbol resolution. False positives possible
     * (e.g. `Set#add`, `Map#set` on local collections). Suppress with
     * `// eslint-disable-next-line gent/no-projection-writes` when the call is
     * provably local. Doesn't follow handlers defined as external function refs.
     */
    "no-projection-writes": {
      create(context) {
        const reportWritesIn = (kind: "Projection" | "Query", fn: AstNode): void => {
          walkAst(fn.body, (inner) => {
            const methodName = writeCallMethod(inner)
            if (methodName === undefined) return
            context.report({
              message: `${kind} ${kind === "Projection" ? "`query`" : "`handler`"} must be read-only — call to \`.${methodName}(\` looks like a write. Use a Mutation or Workflow contribution for state changes.`,
              node: inner,
            })
          })
        }
        return {
          // Projection — factory / typed-binding / satisfies forms (property: query)
          CallExpression(node) {
            if (!isAstNode(node)) return
            if (projectionFactoryName(node) !== undefined) {
              const queryFn = findArrowInFirstArg(node, "query")
              if (queryFn !== undefined) reportWritesIn("Projection", queryFn)
              return
            }
            if (queryFactoryName(node) !== undefined) {
              const handlerFn = findArrowInFirstArg(node, "handler")
              if (handlerFn !== undefined) reportWritesIn("Query", handlerFn)
            }
          },
          VariableDeclarator(node) {
            if (!isAstNode(node)) return
            const id = getNodeField(node, "id")
            if (id === undefined) return
            const typeAnn = getNodeField(id, "typeAnnotation")
            const init = getNodeField(node, "init")
            if (init === undefined) return
            if (isProjectionTypeRef(typeAnn)) {
              const queryFn = findArrowInObject(init, "query")
              if (queryFn !== undefined) reportWritesIn("Projection", queryFn)
              return
            }
            if (isQueryTypeRef(typeAnn)) {
              const handlerFn = findArrowInObject(init, "handler")
              if (handlerFn !== undefined) reportWritesIn("Query", handlerFn)
            }
          },
          TSSatisfiesExpression(node) {
            if (!isAstNode(node)) return
            const typeAnn = getNodeField(node, "typeAnnotation")
            const expr = getNodeField(node, "expression")
            if (expr === undefined) return
            if (isProjectionTypeRef(typeAnn)) {
              const queryFn = findArrowInObject(expr, "query")
              if (queryFn !== undefined) reportWritesIn("Projection", queryFn)
              return
            }
            if (isQueryTypeRef(typeAnn)) {
              const handlerFn = findArrowInObject(expr, "handler")
              if (handlerFn !== undefined) reportWritesIn("Query", handlerFn)
            }
          },
        }
      },
    },
  },
}

export default plugin
