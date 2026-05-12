/**
 * Permission service tests
 */

import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { Permission, PermissionRule } from "@gent/core-internal/domain/permission"

describe("Permission", () => {
  describe("check", () => {
    it.live("returns 'allowed' when no rules match and default is allow", () =>
      Permission.use((p) => p.check("TestTool", {})).pipe(
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("allowed"))),
        Effect.provide(Permission.Live([], "allow")),
      ),
    )

    it.live("returns 'denied' when no rules match and default is deny", () =>
      Permission.use((p) => p.check("TestTool", {})).pipe(
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("denied"))),
        Effect.provide(Permission.Live([], "deny")),
      ),
    )

    it.live("returns 'allowed' when tool matches allow rule", () => {
      const rules = [new PermissionRule({ tool: "ReadFile", action: "allow" })]
      const layer = Permission.Live(rules, "deny")
      return Permission.use((p) => p.check("ReadFile", { path: "/tmp/test" })).pipe(
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("allowed"))),
        Effect.provide(layer),
      )
    })

    it.live("returns 'denied' when tool matches deny rule", () => {
      const rules = [new PermissionRule({ tool: "Bash", action: "deny" })]
      const layer = Permission.Live(rules, "allow")
      return Permission.use((p) => p.check("Bash", { command: "rm -rf /" })).pipe(
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("denied"))),
        Effect.provide(layer),
      )
    })

    it.live("matches wildcard tool rule", () => {
      const rules = [new PermissionRule({ tool: "*", action: "deny" })]
      const layer = Permission.Live(rules, "allow")
      return Permission.use((p) => p.check("AnyTool", {})).pipe(
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("denied"))),
        Effect.provide(layer),
      )
    })

    it.live("matches pattern against args", () => {
      const rules = [new PermissionRule({ tool: "Bash", pattern: "rm.*-rf", action: "deny" })]
      const layer = Permission.Live(rules, "allow")
      return Effect.gen(function* () {
        // Should match pattern
        const result1 = yield* Permission.use((p) => p.check("Bash", { command: "rm -rf /tmp" }))
        expect(result1).toBe("denied")

        // Should not match pattern
        const result2 = yield* Permission.use((p) => p.check("Bash", { command: "ls -la" }))
        expect(result2).toBe("allowed")
      }).pipe(Effect.provide(layer))
    })

    it.live("uses first matching rule", () => {
      const rules = [
        new PermissionRule({ tool: "Bash", pattern: "git", action: "allow" }),
        new PermissionRule({ tool: "Bash", action: "deny" }),
      ]
      const layer = Permission.Live(rules, "allow")
      return Effect.gen(function* () {
        // First rule matches
        const result1 = yield* Permission.use((p) => p.check("Bash", { command: "git status" }))
        expect(result1).toBe("allowed")

        // Second rule matches
        const result2 = yield* Permission.use((p) => p.check("Bash", { command: "rm -rf /" }))
        expect(result2).toBe("denied")
      }).pipe(Effect.provide(layer))
    })

    it.live("deny rule blocks matching bash pattern (builtin-style)", () => {
      const rules = [
        new PermissionRule({
          tool: "bash",
          pattern: "git\\s+(add\\s+[-.]|push\\s+--force|reset\\s+--hard|clean\\s+-f)",
          action: "deny",
        }),
      ]
      const layer = Permission.Live(rules, "allow")
      return Effect.gen(function* () {
        const denied = yield* Permission.use((p) =>
          p.check("bash", { command: "git push --force origin main" }),
        )
        expect(denied).toBe("denied")

        const allowed = yield* Permission.use((p) => p.check("bash", { command: "git status" }))
        expect(allowed).toBe("allowed")
      }).pipe(Effect.provide(layer))
    })

    it.live("explicit allow rule overrides default deny", () => {
      const rules = [new PermissionRule({ tool: "ReadFile", action: "allow" })]
      const layer = Permission.Live(rules, "deny")
      return Effect.gen(function* () {
        // Explicit allow overrides default deny
        const result = yield* Permission.use((p) => p.check("ReadFile", { path: "/tmp/x" }))
        expect(result).toBe("allowed")

        // Unknown tool still falls through to default deny
        const other = yield* Permission.use((p) => p.check("UnknownTool", {}))
        expect(other).toBe("denied")
      }).pipe(Effect.provide(layer))
    })
  })
})
