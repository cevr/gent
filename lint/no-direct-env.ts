/**
 * Oxlint JS plugin: gent custom rules
 *
 * Rules:
 * - no-direct-env: flags Bun.env["X"] / process.env.X (use Config from effect)
 * - no-positional-log-error: flags Effect.logWarning("msg", error) (use annotateLogs)
 * - no-extension-internal-imports: enforces extension boundary — extensions must import
 *   from @gent/core/extensions/api, not core internals (domain/, runtime/, etc.)
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
        const ALLOWED_PACKAGE = /^@gent\/core\/extensions\/api/

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
  },
}

export default plugin
