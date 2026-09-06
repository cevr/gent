import { Predicate, Context, Effect, Layer, Result, Schema } from "effect"

// Valid Regex Pattern - validates regex at decode time
const ValidRegexPattern = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>(
      (s) => {
        const validation = Result.try({
          try: () => new RegExp(s),
          catch: (error) => error,
        })
        if (Result.isSuccess(validation)) return
        const error = validation.failure
        if (error instanceof Error) return `Invalid regex pattern: ${error.message}`
        return `Invalid regex pattern: ${String(error)}`
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

const toStoredRule = (rule: PermissionRule): StoredRule => {
  const stored: StoredRule = { rule }
  if (!Predicate.isUndefined(rule.pattern)) stored.regex = new RegExp(rule.pattern)
  return stored
}

export const compilePermissionRules = (
  rules: ReadonlyArray<PermissionRule>,
): ReadonlyArray<StoredRule> => rules.map(toStoredRule)

export const evaluatePermissionRules = (
  rules: ReadonlyArray<StoredRule>,
  tool: string,
  args: Schema.Schema.Type<typeof Schema.Unknown>,
  defaultAction: PermissionRule["action"] = "allow",
): PermissionResult => {
  const argsStr = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(args)
  for (const entry of rules) {
    const rule = entry.rule
    if (rule.tool !== tool && rule.tool !== "*") continue
    if (!Predicate.isUndefined(entry.regex) && !entry.regex.test(argsStr)) continue
    if (rule.action === "allow") return "allowed"
    if (rule.action === "deny") return "denied"
  }
  if (defaultAction === "deny") return "denied"
  return "allowed"
}

// Permission Service

export interface PermissionService {
  readonly check: (
    tool: string,
    args: Schema.Schema.Type<typeof Schema.Unknown>,
  ) => Effect.Effect<PermissionResult>
}

export class Permission extends Context.Service<Permission, PermissionService>()(
  "@gent/core/src/domain/permission",
) {
  static Live = (
    initialRules: ReadonlyArray<PermissionRule> = [],
    defaultAction: PermissionRule["action"] = "allow",
  ): Layer.Layer<Permission> =>
    Layer.sync(Permission, () => {
      const rules = compilePermissionRules(initialRules)
      return Permission.of({
        check: (tool, args) =>
          Effect.succeed(evaluatePermissionRules(rules, tool, args, defaultAction)),
      })
    })

  static Test = (): Layer.Layer<Permission> =>
    Layer.succeed(
      Permission,
      Permission.of({
        check: () => Effect.succeed("allowed"),
      }),
    )
}
