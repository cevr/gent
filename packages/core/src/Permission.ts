import { Context, Effect, Layer, Schema } from "effect"

// Permission Rule

export class PermissionRule extends Schema.Class<PermissionRule>(
  "PermissionRule"
)({
  tool: Schema.String,
  pattern: Schema.optional(Schema.String),
  action: Schema.Literal("allow", "deny", "ask"),
}) {}

// Permission Check Result

export const PermissionResult = Schema.Literal("allowed", "denied", "ask")
export type PermissionResult = typeof PermissionResult.Type

// Permission Service

export interface PermissionService {
  readonly check: (
    tool: string,
    args: unknown
  ) => Effect.Effect<PermissionResult>
  readonly addRule: (rule: PermissionRule) => Effect.Effect<void>
  readonly getRules: () => Effect.Effect<ReadonlyArray<PermissionRule>>
}

export class Permission extends Context.Tag("Permission")<
  Permission,
  PermissionService
>() {
  static Live = (
    initialRules: ReadonlyArray<PermissionRule> = []
  ): Layer.Layer<Permission> =>
    Layer.sync(Permission, () => {
      let rules = [...initialRules]
      return {
        check: (tool, args) =>
          Effect.sync(() => {
            const argsStr = JSON.stringify(args)
            for (const rule of rules) {
              if (rule.tool !== tool && rule.tool !== "*") continue
              if (rule.pattern) {
                const regex = new RegExp(rule.pattern)
                if (!regex.test(argsStr)) continue
              }
              // Map rule action to result
              if (rule.action === "allow") return "allowed" as const
              if (rule.action === "deny") return "denied" as const
              return "ask" as const
            }
            return "allowed" as const
          }),
        addRule: (rule) =>
          Effect.sync(() => {
            rules.push(rule)
          }),
        getRules: () => Effect.succeed(rules),
      }
    })

  static Test = (): Layer.Layer<Permission> =>
    Layer.succeed(Permission, {
      check: () => Effect.succeed("allowed" as const),
      addRule: () => Effect.void,
      getRules: () => Effect.succeed([]),
    })
}
