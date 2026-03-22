import { ServiceMap, Effect, Layer, Ref, Schema } from "effect"

// Valid Regex Pattern - validates regex at decode time
const ValidRegexPattern = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>(
      (s) => {
        try {
          new RegExp(s) // eslint-disable-line no-new
          return undefined
        } catch (e) {
          return `Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`
        }
      },
      { expected: "a valid regex pattern" },
    ),
  ),
)

// Permission Rule

export class PermissionRule extends Schema.Class<PermissionRule>("PermissionRule")({
  tool: Schema.String,
  pattern: Schema.optional(ValidRegexPattern),
  action: Schema.Literals(["allow", "deny", "ask"]),
}) {}

// Permission Check Result

export const PermissionResult = Schema.Literals(["allowed", "denied", "ask"])
export type PermissionResult = typeof PermissionResult.Type

// Permission Decision (user response)

export const PermissionDecision = Schema.Literals(["allow", "deny"])
export type PermissionDecision = typeof PermissionDecision.Type

// Permission Service

export interface PermissionService {
  readonly check: (tool: string, args: unknown) => Effect.Effect<PermissionResult>
  readonly addRule: (rule: PermissionRule) => Effect.Effect<void>
  readonly removeRule: (tool: string, pattern?: string) => Effect.Effect<void>
  readonly getRules: () => Effect.Effect<ReadonlyArray<PermissionRule>>
}

export class Permission extends ServiceMap.Service<Permission, PermissionService>()(
  "@gent/core/src/permission",
) {
  static Live = (
    initialRules: ReadonlyArray<PermissionRule> = [],
    defaultAction: PermissionRule["action"] = "allow",
  ): Layer.Layer<Permission> =>
    Layer.effect(
      Permission,
      Effect.gen(function* () {
        type StoredRule = { rule: PermissionRule; regex?: RegExp }
        const toStored = (rule: PermissionRule): StoredRule => ({
          rule,
          regex: rule.pattern !== undefined ? new RegExp(rule.pattern) : undefined,
        })
        const rulesRef = yield* Ref.make<StoredRule[]>([...initialRules.map(toStored)])
        const defaultResult =
          defaultAction === "allow"
            ? ("allowed" as const)
            : defaultAction === "deny"
              ? ("denied" as const)
              : ("ask" as const)
        return Permission.of({
          check: (tool, args) =>
            Ref.get(rulesRef).pipe(
              Effect.map((rules) => {
                const argsStr = JSON.stringify(args)
                for (const entry of rules) {
                  const rule = entry.rule
                  if (rule.tool !== tool && rule.tool !== "*") continue
                  if (entry.regex !== undefined && !entry.regex.test(argsStr)) continue
                  if (rule.action === "allow") return "allowed" as const
                  if (rule.action === "deny") return "denied" as const
                  return "ask" as const
                }
                return defaultResult
              }),
            ),
          addRule: (rule) => Ref.update(rulesRef, (rules) => [...rules, toStored(rule)]),
          removeRule: (tool, pattern) =>
            Ref.update(rulesRef, (rules) =>
              rules.filter(
                (entry) => !(entry.rule.tool === tool && entry.rule.pattern === pattern),
              ),
            ),
          getRules: () =>
            Ref.get(rulesRef).pipe(Effect.map((rules) => rules.map((entry) => entry.rule))),
        })
      }),
    )

  static Test = (): Layer.Layer<Permission> =>
    Layer.succeed(Permission, {
      check: () => Effect.succeed("allowed" as const),
      addRule: () => Effect.void,
      removeRule: () => Effect.void,
      getRules: () => Effect.succeed([]),
    })
}
