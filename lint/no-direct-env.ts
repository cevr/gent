/**
 * Oxlint JS plugin: gent custom rules
 *
 * Rules:
 * - no-direct-env: flags Bun.env["X"] / process.env.X (use Config from effect)
 * - no-positional-log-error: flags Effect.logWarning("msg", error) (use annotateLogs)
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
