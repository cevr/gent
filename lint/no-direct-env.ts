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
