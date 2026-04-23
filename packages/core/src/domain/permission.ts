import { Context, Effect, Layer, Ref, Schema } from "effect"

// Valid Regex Pattern - validates regex at decode time
const ValidRegexPattern = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>(
      (s) => {
        try {
          new RegExp(s) // eslint-disable-line no-new -- constructor validates user-provided pattern
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
  action: Schema.Literals(["allow", "deny"]),
}) {}

// Permission Check Result

export const PermissionResult = Schema.Literals(["allowed", "denied"])
export type PermissionResult = typeof PermissionResult.Type

type StoredRule = { rule: PermissionRule; regex?: RegExp }

const toStoredRule = (rule: PermissionRule): StoredRule => ({
  rule,
  regex: rule.pattern !== undefined ? new RegExp(rule.pattern) : undefined,
})

export const compilePermissionRules = (
  rules: ReadonlyArray<PermissionRule>,
): ReadonlyArray<StoredRule> => rules.map(toStoredRule)

export const evaluatePermissionRules = (
  rules: ReadonlyArray<StoredRule>,
  tool: string,
  args: unknown,
  defaultAction: PermissionRule["action"] = "allow",
): PermissionResult => {
  const argsStr = JSON.stringify(args)
  for (const entry of rules) {
    const rule = entry.rule
    if (rule.tool !== tool && rule.tool !== "*") continue
    if (entry.regex !== undefined && !entry.regex.test(argsStr)) continue
    if (rule.action === "allow") return "allowed"
    if (rule.action === "deny") return "denied"
  }
  return defaultAction === "deny" ? "denied" : "allowed"
}

// Permission Service

export interface PermissionService {
  readonly check: (tool: string, args: unknown) => Effect.Effect<PermissionResult>
  readonly addRule: (rule: PermissionRule) => Effect.Effect<void>
  readonly removeRule: (tool: string, pattern?: string) => Effect.Effect<void>
  readonly getRules: () => Effect.Effect<ReadonlyArray<PermissionRule>>
}

export class Permission extends Context.Service<Permission, PermissionService>()(
  "@gent/core/src/domain/permission",
) {
  static Live = (
    initialRules: ReadonlyArray<PermissionRule> = [],
    defaultAction: PermissionRule["action"] = "allow",
  ): Layer.Layer<Permission> =>
    Layer.effect(
      Permission,
      Effect.gen(function* () {
        const rulesRef = yield* Ref.make<StoredRule[]>([...compilePermissionRules(initialRules)])
        return Permission.of({
          check: (tool, args) =>
            Ref.get(rulesRef).pipe(
              Effect.map((rules) => evaluatePermissionRules(rules, tool, args, defaultAction)),
            ),
          addRule: (rule) => Ref.update(rulesRef, (rules) => [...rules, toStoredRule(rule)]),
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
