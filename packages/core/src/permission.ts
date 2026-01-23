import { Context, Effect, Layer, Schema, ParseResult } from "effect"

// Valid Regex Pattern - validates regex at decode time using ParseResult.try
const ValidRegexPattern = Schema.transformOrFail(Schema.String, Schema.String, {
  strict: true,
  decode: (s, _, ast) =>
    ParseResult.try({
      try: () => {
        // Validate regex syntax by attempting construction
        // eslint-disable-next-line no-new -- validation requires construction
        new RegExp(s)
        return s
      },
      catch: (e) =>
        new ParseResult.Type(
          ast,
          s,
          `Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`,
        ),
    }),
  encode: ParseResult.succeed,
})

// Permission Rule

export class PermissionRule extends Schema.Class<PermissionRule>("PermissionRule")({
  tool: Schema.String,
  pattern: Schema.optional(ValidRegexPattern),
  action: Schema.Literal("allow", "deny", "ask"),
}) {}

// Permission Check Result

export const PermissionResult = Schema.Literal("allowed", "denied", "ask")
export type PermissionResult = typeof PermissionResult.Type

// Permission Decision (user response)

export const PermissionDecision = Schema.Literal("allow", "deny")
export type PermissionDecision = typeof PermissionDecision.Type

// Permission Service

export interface PermissionService {
  readonly check: (tool: string, args: unknown) => Effect.Effect<PermissionResult>
  readonly addRule: (rule: PermissionRule) => Effect.Effect<void>
  readonly removeRule: (tool: string, pattern?: string) => Effect.Effect<void>
  readonly getRules: () => Effect.Effect<ReadonlyArray<PermissionRule>>
}

export class Permission extends Context.Tag("Permission")<Permission, PermissionService>() {
  static Live = (
    initialRules: ReadonlyArray<PermissionRule> = [],
    defaultAction: PermissionRule["action"] = "allow",
  ): Layer.Layer<Permission> =>
    Layer.sync(Permission, () => {
      let rules = [...initialRules]
      const defaultResult =
        defaultAction === "allow"
          ? ("allowed" as const)
          : defaultAction === "deny"
            ? ("denied" as const)
            : ("ask" as const)
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
            return defaultResult
          }),
        addRule: (rule) =>
          Effect.sync(() => {
            rules.push(rule)
          }),
        removeRule: (tool, pattern) =>
          Effect.sync(() => {
            const idx = rules.findIndex((r) => r.tool === tool && r.pattern === pattern)
            if (idx !== -1) rules.splice(idx, 1)
          }),
        getRules: () => Effect.succeed(rules),
      }
    })

  static Test = (): Layer.Layer<Permission> =>
    Layer.succeed(Permission, {
      check: () => Effect.succeed("allowed" as const),
      addRule: () => Effect.void,
      removeRule: () => Effect.void,
      getRules: () => Effect.succeed([]),
    })
}
