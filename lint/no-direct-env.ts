/**
 * Oxlint JS plugin: no-direct-env
 *
 * Flags direct reads from `Bun.env` and `process.env`
 * (e.g. `Bun.env["X"]`, `process.env.NODE_ENV`).
 *
 * Use `Config` from `effect` instead for consistent, testable env access.
 * Spreading env to child processes (`{ ...Bun.env }`) is allowed.
 *
 * Valid:   yield* Config.option(Config.string("MY_VAR"))
 * Valid:   { ...Bun.env, TERM: "dumb" }
 * Invalid: Bun.env["MY_VAR"], process.env.NODE_ENV
 */

import type { Plugin } from "#oxlint/plugins"

const plugin: Plugin = {
  meta: {
    name: "gent",
  },
  rules: {
    "no-direct-env": {
      create(context) {
        return {
          MemberExpression(node) {
            // Match X.env["Y"] or X.env.Y — a property access ON the env object
            // This catches reads but not spreads like `{ ...Bun.env }`
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
  },
}

export default plugin
