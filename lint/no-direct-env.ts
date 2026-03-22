/**
 * Oxlint JS plugin: no-direct-env
 *
 * Flags direct access to `Bun.env` and `process.env`.
 * Use `Config` from `effect` instead for consistent, testable env access.
 *
 * Valid:   Config.option(Config.string("MY_VAR"))
 * Invalid: Bun.env["MY_VAR"], Bun.env.MY_VAR, process.env.MY_VAR
 *
 * Note: `process.env` is also caught by the built-in `node/no-process-env` rule.
 * This plugin adds coverage for `Bun.env` which has no built-in rule.
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
            // Match Bun.env or process.env
            if (
              node.object.type === "Identifier" &&
              (node.object.name === "Bun" || node.object.name === "process") &&
              ((node.property.type === "Identifier" && node.property.name === "env") ||
                (node.property.type === "StringLiteral" && node.property.value === "env"))
            ) {
              context.report({
                message: `Use \`Config\` from \`effect\` instead of \`${node.object.name}.env\`. See: Config.option(Config.string("VAR_NAME"))`,
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
